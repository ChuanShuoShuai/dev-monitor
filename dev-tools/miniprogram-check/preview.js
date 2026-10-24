/* 小程序页面「离线预览」生成器
   ============================================================
   微信开发者工具没装 / 不方便开的时候，也想看看版式有没有崩。
   这里把 WXML 粗翻译成 HTML、WXSS 的 rpx 按 375px 屏宽折成 px，
   再用真实快照填进去，生成 dev-tools/miniprogram-check/preview/*.html。
   拿浏览器（或 playwright）打开就能看，1:1 还原不了原生组件（tabBar、input 占位符），
   但**间距、换行、字号、对齐**这些最容易翻车的地方是可信的。

   用法：node dev-tools/miniprogram-check/preview.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const http = require('http');

const MP = path.join(__dirname, '..', '..', 'miniprogram');
const OUT = path.join(__dirname, 'preview');

/* ---------------- 运行时打桩（与 check.js 同款，这里只要 data） ---------------- */

const store = {};
let snapshot = null;

function loadSnapshot() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8787/api/snapshot', (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => (store[k] = v),
  request(opt) {
    setImmediate(() => {
      const u = opt.url;
      if (u.indexOf('/.cloud/') >= 0) return opt.fail({ errMsg: 'request:fail 预览不打云服务' });
      if (/\/api\/snapshot/.test(u)) return opt.success({ statusCode: 200, data: snapshot });
      if (/\/api\/health/.test(u)) {
        return opt.success({
          statusCode: 200,
          data: {
            ok: true, name: 'dev-monitor', version: '1.3.0', node: 'v22.22.2',
            projectName: snapshot.config.name, projectRoot: snapshot.config.projectRoot,
            allowBuild: true, uptimeMs: 3972000,
            addresses: [
              { ip: '192.168.3.225', adapter: '以太网', virtual: false, url: 'http://192.168.3.225:8787', recommended: true },
              { ip: '172.16.1.163', adapter: 'OrayBoxVpnEnt', virtual: true, url: 'http://172.16.1.163:8787' }
            ]
          }
        });
      }
      if (/\/api\/projects/.test(u)) return opt.success({ statusCode: 200, data: { ok: true, projects: snapshot.projects } });
      if (/\/api\/content/.test(u)) {
        // 预览用的假文本：够长才看得出滚动/换行/等宽排版对不对
        const demo = JSON.stringify(
          { generatedAt: '2026-10-21 11:31:25', source: 'E:/UE4/CursorAdventure/Content/Audio', total: 6, results: [
            { key: 'bgm_town', file: 'BGM_Town.mp3', seconds: 92.4, loop: true, peakDb: -3.2 },
            { key: 'bgm_battle', file: 'BGM_Battle.mp3', seconds: 128.7, loop: true, peakDb: -2.8 }
          ] }, null, 2);
        return opt.success({ statusCode: 200, data: { ok: true, name: 'BGMImportReport.json', size: 774, mtimeText: '2026-10-21 11:31:25', binary: false, truncated: false, content: demo } });
      }
      return opt.success({ statusCode: 200, data: { ok: true } });
    });
  },
  showLoading() {}, hideLoading() {}, vibrateShort() {}, navigateTo() {},
  setNavigationBarTitle() {}, setClipboardData() {}, previewImage() {},
  /* 图片走 utils/img.js 的 downloadFile：预览里直接把原地址当临时文件返回，
     浏览器就能真的把 /api/file 的图渲染出来（以前这里是个空函数，缩略图永远是空的） */
  downloadFile(opt) {
    setImmediate(() => opt.success({ statusCode: 200, tempFilePath: opt.url }));
  },
  saveImageToPhotosAlbum() {},
  getWindowInfo() {
    return { windowWidth: 375, windowHeight: 812, screenHeight: 812, safeArea: { top: 44, bottom: 778 } };
  },
  /* run.js 的 fitLog() 要量位置：预览里给一个固定值，页面高度就按它算 */
  createSelectorQuery() {
    const q = {
      _r: null,
      select() { return q; },
      selectViewport() { return q; },
      boundingClientRect(cb) { q._cb = cb; return q; },
      scrollOffset(cb) { q._off = cb; return q; },
      exec(cb) {
        cb([
          { top: 218, bottom: 218 + 500, height: 500, left: 0, right: 375, width: 375 },
          { scrollTop: 0 }
        ]);
      }
    };
    return q;
  },
  navigateBack() {},
  getAccountInfoSync() {
    return { miniProgram: { appId: 'wxpreview00000000' } };
  }
};

let appInst = null;
let lastPage = null;
const timers = [];
global.App = (def) => {
  appInst = def;
  if (def.onLaunch) def.onLaunch.call(def);
};
global.getApp = () => appInst;
global.Page = (def) => (lastPage = def);
global.setInterval = (fn) => {
  const t = { fn, cleared: false };
  timers.push(t);
  return t;
};
global.clearInterval = (t) => t && (t.cleared = true);

/* 云服务模块可以整体替换：「已登录 + 有档案」这个状态在本地造不出来 */
const CLOUD_PATH = require.resolve(path.join(MP, 'utils', 'cloud.js'));
let realCloud = null;

function mockCloud(sess) {
  const rows = [
    {
      id: 7, build_key: 'arc:cursor-adventure:build_20261021_141341.log', project_id: 'cursor-adventure',
      project_name: 'CursorAdventure', result: 'Succeeded', seconds: 67.24, error_count: 0, warn_count: 4,
      summary: 'WriteMetadata CursorAdventureEditor.target [NoUba]', finished_at: '2026-10-21T06:14:49.051Z'
    },
    {
      id: 6, build_key: 'arc:cursor-adventure:build_20261021_113016.log', project_id: 'cursor-adventure',
      project_name: 'CursorAdventure', result: 'Succeeded', seconds: 41.8, error_count: 0, warn_count: 2,
      summary: 'Link CursorAdventureEditor.target', finished_at: '2026-10-21T03:30:41.220Z'
    },
    {
      id: 5, build_key: 'arc:mobile-resume:build_20261020_221008.log', project_id: 'mobile-resume',
      project_name: '移动简历', result: 'Failed', seconds: 9.35, error_count: 2, warn_count: 1,
      summary: 'vite build 失败：找不到模块 marked', finished_at: '2026-10-20T14:10:22.900Z'
    }
  ];
  return {
    PUBLIC_CONFIG: { endpoint: 'https://mp-api.app.workbuddy.host', publishableKey: 'wbpk_preview' },
    session: () => Promise.resolve(sess),
    who: () => 'de***@example.com',
    listBuilds: () => Promise.resolve(rows),
    addBuilds: () => Promise.resolve(0),
    addBuild: () => Promise.resolve(1),
    deleteBuild: () => Promise.resolve(1),
    clearBuilds: () => Promise.resolve(3),
    signOut: () => Promise.resolve(),
    saveConnection: () => Promise.resolve(true),
    loadConnection: () => Promise.resolve(null),
    sendCode: () => Promise.reject(new Error('预览不打云服务')),
    verifyCode: () => Promise.reject(new Error('预览不打云服务')),
    friendly: (e) => (e && e.message) || ''
  };
}

function installCloud(sess) {
  if (!realCloud) realCloud = require.cache[CLOUD_PATH] || null;
  if (!sess) {
    if (realCloud) require.cache[CLOUD_PATH] = realCloud;
    return;
  }
  require.cache[CLOUD_PATH] = {
    id: CLOUD_PATH,
    filename: CLOUD_PATH,
    loaded: true,
    children: [],
    paths: [],
    exports: mockCloud(sess)
  };
}

function makePage(pagePath, query) {
  const file = path.join(MP, pagePath + '.js');
  delete require.cache[require.resolve(file)];
  require(file);
  const def = lastPage;
  const inst = Object.assign({}, def);
  inst.data = JSON.parse(JSON.stringify(def.data || {}));
  inst.setData = function (patch, cb) {
    /* 还原 'rows[3].src' 这种路径写法：直接 assign 只会造出一个同名字段，
       逐行更新的东西（缩略图 src）就永远填不进去 */
    for (const k of Object.keys(patch)) {
      const m = /^([A-Za-z0-9_$]+)\[(\d+)\]\.([A-Za-z0-9_$]+)$/.exec(k);
      if (m && Array.isArray(this.data[m[1]]) && this.data[m[1]][Number(m[2])]) {
        this.data[m[1]][Number(m[2])][m[3]] = patch[k];
      } else {
        this.data[k] = patch[k];
      }
    }
    if (typeof cb === 'function') setImmediate(cb);
  };
  if (inst.onLoad) inst.onLoad.call(inst, query || {});
  if (inst.onShow) inst.onShow.call(inst);
  return inst;
}

/* ---------------- WXML → HTML ---------------- */

const VOID = new Set(['input', 'image', 'img', 'br']);
const TAG_MAP = {
  view: 'div',
  text: 'span',
  'scroll-view': 'div',
  'rich-text': 'div',
  image: 'img',
  button: 'button',
  block: null,
  input: 'input'
};

function parseWxml(src) {
  const s = src.replace(/<!--[\s\S]*?-->/g, '');
  const root = { type: 'root', children: [] };
  const stack = [root];
  // ⚠ 属性值里会出现 '>'（比如 wx:if="{{projects.length > 1}}"），
  //   不能用 [^>]* 粗暴截断，否则整个 card 会被切碎、尾巴变成可见文本。
  const re = /<\/?[A-Za-z][\w-]*(?:(?:"[^"]*")|(?:'[^']*')|[^>"'])*(?:\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) {
      const text = s.slice(last, m.index);
      if (text.trim()) stack[stack.length - 1].children.push({ type: 'text', text });
    }
    const raw = m[0];
    const close = raw[1] === '/';
    const selfClose = /\/>$/.test(raw);
    const name = (raw.match(/^<\/?([A-Za-z][\w-]*)/) || [])[1];
    if (close) {
      if (stack.length > 1) {
        const top = stack.pop();
        if (top.type === 'voidmark' && top.name !== name) stack.push(top);
      }
    } else {
      const attrs = {};
      const are = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)/g;
      let a;
      const inner = raw.slice(name.length + 1, raw.length - (selfClose ? 2 : 1));
      while ((a = are.exec(inner))) {
        if (a[1]) attrs[a[1]] = a[2];
        else if (a[3] && !/\/$/.test(a[3])) attrs[a[3]] = 'true';
      }
      const node = { type: 'tag', name, attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      // ⚠ 自闭合标签（image / input）在源码里也可能写成 <image></image>。
      //   如果干脆不入栈，那个 </image> 就会把它的**父节点**顶掉 ——
      //   结果整个 item-main 被挤到卡片外面，列表看上去是一排空行。
      //   所以入栈一个占位标记，让闭合标签仍然能配对回来。
      if (!selfClose) stack.push(VOID.has(name) ? { type: 'voidmark', name } : node);
    }
    last = m.index + raw.length;
  }
  return root;
}

function evalExpr(expr, data) {
  try {
    // eslint-disable-next-line no-new-func
    return new Function('__d', 'with (__d) { return (' + expr + '); }')(data);
  } catch (e) {
    return '';
  }
}

function interp(str, data) {
  if (str.indexOf('{{') < 0) return str;
  return str.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => {
    const v = evalExpr(e, data);
    return v == null || v === false ? '' : String(v);
  });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderNodes(nodes, data) {
  let out = '';
  let lastIf = null;   // 上一个 if 链是否命中

  for (const n of nodes) {
    if (n.type === 'text') {
      out += esc(interp(n.text, data));
      continue;
    }
    const a = n.attrs;

    if (a['wx:if'] !== undefined) {
      lastIf = !!evalExpr(a['wx:if'].replace(/^\{\{|\}\}$/g, ''), data);
      if (!lastIf) continue;
      renderNode(n, data) && (out += renderNode(n, data));
      continue;
    }
    if (a['wx:elif'] !== undefined) {
      if (lastIf) continue;
      const v = !!evalExpr(a['wx:elif'].replace(/^\{\{|\}\}$/g, ''), data);
      lastIf = v;
      if (v) out += renderNode(n, data);
      continue;
    }
    if (a['wx:else'] !== undefined) {
      if (lastIf) continue;
      lastIf = true;
      out += renderNode(n, data);
      continue;
    }
    lastIf = null;

    if (a['wx:for'] !== undefined) {
      const list = evalExpr(a['wx:for'].replace(/^\{\{|\}\}$/g, ''), data) || [];
      list.forEach((item, index) => {
        out += renderNode(n, Object.assign({}, data, { item, index }));
      });
      continue;
    }
    out += renderNode(n, data);
  }
  return out;
}

function renderNode(n, data) {
  const a = n.attrs;
  const tag = TAG_MAP[n.name] === undefined ? 'div' : TAG_MAP[n.name];
  const inner = renderNodes(n.children, data);
  if (tag === null) return inner;   // <block> 不产生标签

  const cls = a.class ? interp(a.class, data) : '';
  const style = a.style ? interp(a.style, data) : '';
  const id = a.id ? interp(a.id, data) : '';
  let html = '<' + tag + (cls ? ' class="' + cls + '"' : '') + (style ? ' style="' + style + '"' : '') + (id ? ' id="' + id + '"' : '');

  if (n.name === 'image') {
    return html + ' src="' + interp(a.src || '', data) + '">';
  }
  /* rich-text 的 nodes 是一整段 HTML（语法高亮吐出来的 span），
     必须原样塞进去 —— 走 interp 会把代码里的 {{ 当成模板再解析一遍 */
  if (n.name === 'rich-text') {
    const raw = /^\{\{[\s\S]*\}\}$/.test(a.nodes || '')
      ? String(evalExpr(a.nodes.slice(2, -2), data) || '')
      : interp(a.nodes || '', data);
    return html + '>' + raw + '</div>';
  }
  if (n.name === 'input') {
    return html + ' placeholder="' + esc(a.placeholder || '') + '" value="' + esc(interp(a.value || '', data)) + '">';
  }
  if (n.name === 'scroll-view') {
    // 预览里不滚动：横向的给 nowrap，纵向的给 overflow:hidden
    const extra = a['scroll-x'] !== undefined ? 'overflow-x:auto;' : a['scroll-y'] !== undefined ? 'overflow:auto;' : '';
    return html.replace('/>', '') + (extra ? ' style="' + style + ';' + extra + '"' : '') + '>' + inner + '</' + tag + '>';
  }
  return html + '>' + inner + '</' + tag + '>';
}

/* ---------------- WXSS → CSS ---------------- */

function wxssToCss(src) {
  return src
    // 375px 屏宽下 1rpx = 0.5px
    .replace(/(-?[\d.]+)rpx/g, (_, n) => (Number(n) * 0.5).toFixed(2) + 'px')
    // page 选择器在预览里对应 body
    // ⚠ 必须允许「换行后跟 page {」：app.wxss 的 page 块前面是一整段注释，
    //   只用 ^ 或 } 当锚点会漏掉它 ⇒ 一个 CSS 变量都定义不出来，整页 text 发灰。
    .replace(/(^|[}\n])(\s*)page\s*\{/g, '$1$2body {')
    // 小程序 button 的默认样式清空规则在浏览器里意义不同，保留即可
    .replace(/env\(safe-area-inset-bottom\)/g, '0px');
}

/* ---------------- 生成 ---------------- */

/* 自定义页签是组件，预览器不解析组件 ⇒ 这里自己把 custom-tab-bar 的 WXML 渲染出来贴到页面底部。
   图标换成 file:// 绝对路径，否则 HTML 里的 /images/xxx.png 会解析到盘符根目录。 */
const appJson = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));
const TAB_ICON = (p) => 'file:///' + path.join(MP, p).replace(/\\/g, '/');
const TAB_TABS = (appJson.tabBar.list || []).map((t) => ({
  text: t.text,
  icon: TAB_ICON(t.iconPath),
  iconOn: TAB_ICON(t.selectedIconPath),
  url: '/' + t.pagePath
}));
const TAB_INDEX = {};
(appJson.tabBar.list || []).forEach((t, i) => (TAB_INDEX[t.pagePath] = i));
const compWxml = fs.readFileSync(path.join(MP, 'custom-tab-bar', 'index.wxml'), 'utf8');
const compCss = wxssToCss(fs.readFileSync(path.join(MP, 'custom-tab-bar', 'index.wxss'), 'utf8'));

const PAGES = [
  ['pages/compile/compile', 'build', {}],
  ['pages/run/run', 'run', {}],
  ['pages/suite/suite', 'suite', {}],
  ['pages/art/art', 'art', {}],
  // 截图分组带缩略图，是这一页最挤的一行，单独出一张看折行
  ['pages/art/art', 'art-shot', {}, (inst) => inst.pickFilter({ currentTarget: { dataset: { k: '截图' } } })],
  ['pages/archive/archive', 'archive', {}],
  ['pages/archive/archive', 'archive-on', {}, null, { user: { email: 'dev@example.com' } }],
  ['pages/login/login', 'login', {}, (inst) => inst.setData({
    email: 'dev@example.com', sent: true, countdown: 47, ok: true,
    msg: '验证码已发到 dev@example.com，有效期几分钟，收到就填下面'
  })],
  ['pages/detail/detail', 'detail', { type: 'text', name: encodeURIComponent('BGMImportReport.json'), p: encodeURIComponent('E:/UE4/CursorAdventure/Saved/BGMImportReport.json') }],
  ['pages/setup/setup', 'setup', {}],
  ['pages/setup/setup', 'setup-on', {}, null, { user: { email: 'dev@example.com' } }],
  // 编译中 + 停止确认条：静态快照里没有这个状态，手动摆一份出来看版式
  ['pages/compile/compile', 'build-running', {}, (inst) => inst.setData({
    badge: '编译中', bcls: 'run', running: true, secText: '--', percent: 40, indet: false, barCls: '',
    errors: 0, warnings: 2, stepNo: 2, total: 5,
    stepLabel: 'Compile [x64] Module.CursorAdventure.2.cpp [NoUba]',
    ask: { title: '停止编译？', msg: '正在跑的编译进程会被结束，已经写出的中间文件保留。' }
  })]
];

(async () => {
  snapshot = await loadSnapshot();
  if (!snapshot) {
    console.error('拿不到快照：先启动监控服务（node bin/launcher.js --no-open）');
    process.exit(1);
  }
  // 预览是本机跑的，地址就用 127.0.0.1：这样 <img> 能真的把截图取回来
  store.dm_base = 'http://127.0.0.1:8787';
  store.dm_project = snapshot.project;

  require(path.join(MP, 'app.js'));
  appInst.globalData.snap = snapshot;

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const appCss = wxssToCss(fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8'));

  for (const [pagePath, name, query, after, sess] of PAGES) {
    installCloud(sess);
    const inst = makePage(pagePath, query);
    await new Promise((r) => setTimeout(r, 60));
    if (after) after(inst);
    const wxml = fs.readFileSync(path.join(MP, pagePath + '.wxml'), 'utf8');
    const pageCss = fs.existsSync(path.join(MP, pagePath + '.wxss'))
      ? wxssToCss(fs.readFileSync(path.join(MP, pagePath + '.wxss'), 'utf8'))
      : '';
    const body = renderNodes(parseWxml(wxml).children, inst.data);
    // tab 页底部补一条页签（组件在真机上由框架挂载，这里手工渲染）
    const tabIdx = TAB_INDEX[pagePath];
    const isTab = tabIdx !== undefined;
    const tabHtml = isTab ? renderNodes(parseWxml(compWxml).children, { selected: tabIdx, tabs: TAB_TABS }) : '';
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=375, initial-scale=1">
<title>${name}</title>
<style>
html,body{margin:0;padding:0;width:375px;background:#070b18}
${appCss}
${pageCss}
${isTab ? compCss : ''}
/* 预览专用：把 WXSS 里靠 page 生效的东西补回来 */
body{min-height:812px;padding-bottom:${isTab ? '110px' : '60px'}}
${name === 'detail' ? 'body{padding-bottom:0}' : ''}
</style></head><body>${body}${tabHtml}${name === 'run' ? `
<!-- 运行页的日志井高度是真机上由 fitLog() 量出来的（视口 - 上边距 - 页签占位）。
     静态 HTML 里补一段同样的计算，预览看到的才是真机上的高度 -->
<script>
(function () {
  var el = document.querySelector('.log');
  if (!el) return;
  /* 与 run.js 的 fitLog() 同一套算法：页签底距 24rpx + 本体 130rpx + 余量 16rpx = 85px（375 宽）
     ⚠ 不要在这里量 .tb 的高度：脚本执行时页签图标还没解码完，量出来偏矮，
       算出的高度会把日志底边压到页签下面（第一次就是这么错的） */
  var gap = (24 + 130 + 16) * (window.innerWidth / 750);
  var top = el.getBoundingClientRect().top + window.scrollY;
  el.style.height = Math.max(160, Math.round(window.innerHeight - top - gap)) + 'px';
})();
</script>` : ''}</body></html>`;
    fs.writeFileSync(path.join(OUT, name + '.html'), html, 'utf8');
    console.log('生成 preview/' + name + '.html');
  }

  for (const t of timers) clearInterval(t);
  process.exit(0);
})();
