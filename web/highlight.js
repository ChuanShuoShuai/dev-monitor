/* ============================================================
   语法高亮（零依赖手写 tokenizer）
   ------------------------------------------------------------
   设计约定（改之前务必先读）：
   1) **输入原始文本，输出已转义的 HTML 片段**。
      绝对不能在转义后的字符串上跑正则 —— esc() 会把 " 变成 &quot;，
      字符串 / 键就再也匹配不到了（旧版 highlightJson 就是栽在这，
      JSON 的键和字符串其实一直没被染色，只有数字和布尔生效）。
   2) 每种语言 = 一串规则，规则按「最左匹配 + 同位置靠前者优先」生效，
      所以书写顺序等于优先级：注释和字符串要排在标点之前。
   3) 规则里的子表达式一律用 (?:...) 非捕获分组 —— 编译时外层会包一层
      命名分组 (?<gN>...)，内部再出现捕获分组会打乱索引。
   4) 不做真正的语法分析，遇到歧义就选不破坏可读性的那种：
      比如 JS 的正则字面量会被当成除法 + 标识符，这是刻意接受的取舍。
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HL = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* 超过这个长度就不高亮：一次生成几万个 span 会把手机卡住，
     而这么长的文件本来也看不过来。调用方负责提示用户。 */
  var MAX_CHARS = 160 * 1024;

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ESC_MAP[c]; });
  }

  /* ---------------- 规则表 ----------------
     c = class 后缀（最终输出 tk-xxx）
     r = 正则（只用非捕获分组）
     e = 可选的自定义输出（拿到原始 token，自己决定怎么切、怎么转义） */

  var RULES = {
    /* JSON：键必须排在字符串前面，否则 "a": 里的整串会先被 tk-str 吃掉 */
    json: [
      { c: 'key', r: /"(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(?=\s*:)/ },
      { c: 'str', r: /"(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"?/ },
      { c: 'num', r: /-?\b\d+(?:\.\d*)?(?:[eE][+-]?\d+)?\b/ },
      { c: 'lit', r: /\b(?:true|false|null)\b/ }
    ],

    /* JavaScript / TypeScript / JSX（Babel 产物基本是 ES5-ES2017，够用） */
    js: [
      { c: 'com', r: /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/ },
      {
        c: 'str',
        r: /`(?:\\[\s\S]|[^`\\])*`?|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?/
      },
      {
        c: 'kw',
        r: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|from|as|delete|void|debugger|static|get|set)\b/
      },
      { c: 'lit', r: /\b(?:true|false|null|undefined|NaN|Infinity)\b/ },
      { c: 'num', r: /\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)\b/ },
      /* 函数调用：标识符紧跟左括号。lookahead 不算捕获，安全。 */
      { c: 'fn', r: /[A-Za-z_$][\w$]*(?=\s*\()/ },
      /* 成员访问：把点单独拆出来当标点，属性名单独上色，比整串一色好看 */
      {
        c: 'prop',
        r: /\.[A-Za-z_$][\w$]*/,
        e: function (tok) {
          return '<span class="tk-punc">.</span><span class="tk-prop">' + esc(tok.slice(1)) + '</span>';
        }
      },
      { c: 'punc', r: /[{}()[\];,.:?!<>=+\-*/%&|^~]+/ }
    ],

    /* CSS：不做选择器/声明块的状态机，按词法定色即可 */
    css: [
      { c: 'com', r: /\/\*[\s\S]*?(?:\*\/|$)/ },
      { c: 'str', r: /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/ },
      { c: 'kw', r: /@[\w-]+/ },
      { c: 'lit', r: /!important\b/i },
      { c: 'num', r: /#[0-9a-fA-F]{3,8}\b|-?\b\d*\.?\d+(?:px|em|rem|ex|ch|vh|vw|vmin|vmax|%|s|ms|deg|rad|turn|fr|pt|pc|cm|mm|in)?\b/ },
      /* 属性名 = 冒号前的标识符；选择器（前面没有冒号的）保持正文色 */
      { c: 'prop', r: /[-a-zA-Z_][\w-]*(?=\s*:)/ },
      { c: 'punc', r: /[{}();,:>~+*]+/ }
    ],

    /* HTML / XML / SVG */
    html: [
      { c: 'com', r: /<!--[\s\S]*?(?:-->|$)/ },
      { c: 'kw', r: /<!DOCTYPE[^>]*>/i },
      /* 标签：把 < 和 / 并入标点，标签名单独上色 */
      {
        c: 'tag',
        r: /<\/?[A-Za-z][\w:.-]*/,
        e: function (tok) {
          var m = /^(<\/?)([A-Za-z][\w:.-]*)$/.exec(tok);
          if (!m) return '<span class="tk-tag">' + esc(tok) + '</span>';
          return '<span class="tk-punc">' + esc(m[1]) + '</span><span class="tk-tag">' + esc(m[2]) + '</span>';
        }
      },
      { c: 'attr', r: /[A-Za-z_:][\w:.-]*(?=\s*=)/ },
      { c: 'str', r: /"[^"\n]*"?|'[^'\n]*'?/ },
      { c: 'ent', r: /&[#\w]+;/ },
      { c: 'punc', r: /[<>/=]+/ }
    ]
  };

  var LABELS = { json: 'JSON', js: 'JavaScript', css: 'CSS', html: 'HTML' };

  var EXT_LANG = {
    json: 'json', jsonc: 'json', json5: 'json', map: 'json',
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html'
  };

  /* 编译结果缓存：同一种语言的合并正则只构造一次 */
  var COMPILED = {};

  function compile(lang) {
    if (COMPILED[lang]) return COMPILED[lang];
    var parts = RULES[lang];
    var src = parts
      .map(function (p, i) { return '(?<g' + i + '>' + p.r.source + ')'; })
      .join('|');
    COMPILED[lang] = { re: new RegExp(src, 'g'), parts: parts };
    return COMPILED[lang];
  }

  /** 按文件名猜语言；认不出就返回 'text'（不高亮） */
  function langOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    if (!m) return 'text';
    return EXT_LANG[m[1].toLowerCase()] || 'text';
  }

  function labelOf(lang) {
    return LABELS[lang] || '';
  }

  /** 是否是「值得高亮」的语言（调用方据此决定加不加 code 版式） */
  function isCode(lang) {
    return lang !== 'text' && !!RULES[lang];
  }

  /** 文本是否需要放弃高亮（太长） */
  function tooLong(text) {
    return String(text == null ? '' : text).length > MAX_CHARS;
  }

  /**
   * 单个语言的扫描：把源码渲染成已转义的 HTML 片段。
   * @param {string} s 原始源码
   * @param {string} lang 'json' | 'js' | 'css'
   */
  function scan(s, lang) {
    /* 注意：这里不要拦 'html'。递归只发生在 render → scanHtml → scan，
       scan 自己不会再回调回去，拦掉反而会把 HTML 规则整个短路。 */
    if (!isCode(lang)) return esc(s);

    var c = compile(lang);
    var re = c.re;
    var parts = c.parts;
    var out = '';
    var last = 0;
    var m;

    re.lastIndex = 0;
    while ((m = re.exec(s)) !== null) {
      var tok = m[0];
      /* 零长匹配防死循环（理论上不会有，兜底） */
      if (tok === '') { re.lastIndex++; continue; }
      if (m.index > last) out += esc(s.slice(last, m.index));

      var i = 0;
      for (; i < parts.length; i++) {
        if (m.groups['g' + i] !== undefined) break;
      }
      var p = parts[i];
      if (!p) {
        out += esc(tok);
      } else if (p.e) {
        out += p.e(tok);
      } else {
        out += '<span class="tk-' + p.c + '">' + esc(tok) + '</span>';
      }
      last = m.index + tok.length;
    }
    if (last < s.length) out += esc(s.slice(last));
    return out;
  }

  /* HTML 里的内联 <style> / <script> 用对应语言再扫一遍。
     不处理嵌套的话，现代前端那种「整份样式表写在 index.html 里」的文件
     会有一大片白色，等于没高亮。注意：必须先切段再分别扫描 ——
     不能对已经生成好 span 的 HTML 再跑标签正则，那会把 span 本身当标签染色。 */
  var NESTED = /<(style|script)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

  function scanHtml(s) {
    var out = '';
    var last = 0;
    var m;
    NESTED.lastIndex = 0;
    while ((m = NESTED.exec(s)) !== null) {
      var tag = m[1].toLowerCase();
      var openEnd = m[0].indexOf('>') + 1;
      var openTag = m[0].slice(0, openEnd);

      out += scan(s.slice(last, m.index), 'html');
      out += scan(openTag, 'html');
      out += tag === 'style' ? scan(m[2], 'css') : scan(m[2], 'js');
      out += scan('</' + m[1] + '>', 'html');
      last = m.index + m[0].length;
    }
    out += scan(s.slice(last), 'html');
    return out;
  }

  /**
   * 把源码渲染成已转义的 HTML 片段。
   * @param {string} text 原始源码
   * @param {string} lang 'json' | 'js' | 'css' | 'html' | 'text'
   */
  function render(text, lang) {
    var s = String(text == null ? '' : text);
    if (!isCode(lang) || tooLong(s)) return esc(s);
    return lang === 'html' ? scanHtml(s) : scan(s, lang);
  }

  return {
    render: render,
    langOf: langOf,
    labelOf: labelOf,
    isCode: isCode,
    tooLong: tooLong,
    MAX_CHARS: MAX_CHARS,
    esc: esc,
    _rules: RULES
  };
});
