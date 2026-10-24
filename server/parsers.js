'use strict';

const fs = require('fs');
const path = require('path');

/* ==================== 编译日志（build_out.log / BuildLogs/*.log）==================== */

const RE_BUILD_STEP   = /^\s*\[(\d+)\s*\/\s*(\d+)\]\s+(.*)$/;
const RE_BUILD_RESULT = /^\s*Result\s*:\s*(\w+)/i;
const RE_BUILD_TIME   = /^\s*Total execution time\s*:\s*([\d.]+)/i;
const RE_BUILD_ERR    = /(?:\berror\b\s+[A-Z]+\d+)/i;
const RE_BUILD_WARN   = /(?:\bwarning\b\s+[A-Z]+\d+)/i;

function parseBuildLine(line) {
  let m;
  if ((m = RE_BUILD_RESULT.exec(line))) return { kind: 'result', text: line.trim(), value: m[1] };
  if ((m = RE_BUILD_TIME.exec(line)))   return { kind: 'time',   text: line.trim(), value: parseFloat(m[1]) };
  if ((m = RE_BUILD_STEP.exec(line)))   return { kind: 'step',   text: line.trim(), index: +m[1], total: +m[2], label: m[3].slice(0, 140) };
  if (RE_BUILD_ERR.test(line))          return { kind: 'error',  text: line.trim().slice(0, 300) };
  if (RE_BUILD_WARN.test(line))         return { kind: 'warn',   text: line.trim().slice(0, 300) };
  return { kind: 'info', text: line.trim().slice(0, 300) };
}

/** 从一段编译行里提取最新进度（取 index 最大的 step） */
function buildProgress(lines) {
  let step = 0, total = 0, label = '';
  for (const l of lines) {
    if (l.kind === 'step' && l.index >= step) {
      step = l.index; total = l.total; label = l.label;
    }
  }
  return { step, total, label };
}

/* ==================== UE 运行日志（CursorAdventure.log）==================== */

/* UE 日志行。
   注意 verbosity 段是可选的：引擎自带日志是
     [2026.10.16-07.21.51:816][604]LogAudio: Display: Audio Device unregistered...
   而工程自定义日志省略了 verbosity，直接跟中文正文：
     [2026.10.16-07.16.03:582][465]LogMouseAdventure: 自动存档已写入：地图=Cave 等级=10
   若强制要求 verbosity，且用 \w+ 去匹配中文正文，整行会落为 Raw —— 剧情行全部丢失。 */
const RE_UE_LOG = /^\[(\d{4}\.\d{2}\.\d{2}-[\d.:]+)\]\[\s*(\d+)\]([A-Za-z]+):\s*(?:(\w+):\s*)?(.*)$/;

function parseUeLine(line) {
  const m = RE_UE_LOG.exec(line);
  if (!m) return { category: 'Raw', verbosity: '', text: line.trim().slice(0, 400) };
  const [, time, frame, category, verbosity, text] = m;
  return { time, frame: +frame, category, verbosity: verbosity || '', text: text.slice(0, 400) };
}

/** 剧情进度行（工程里的业务日志分类） */
function isStoryLine(l) { return l.category === 'LogMouseAdventure'; }

/** 需要被红色/橙色标出的行 */
function isAlertLine(l) {
  return l.verbosity === 'Error' || l.verbosity === 'Fatal' || l.verbosity === 'Warning';
}

/* ==================== Node / 前端构建日志（stdout，无固定格式）====================

   真实输出长这样（移动简历 · node build.js）：
     Compiled: module-editors.jsx -> module-editors.js
     Copied: resume-store.js
     [warn] 未在 index.html 中找到脚本引用: xxx.jsx
     SyntaxError: E:/x/y.jsx: Unexpected token (12:5)
     Build complete! Output in dist/ folder.

   没有 MSVC 的 "error C1234" 格式，所以不能复用 parseBuildLine。 */

const RE_NODE_STEP   = /^\s*(Compiled|Copied|Bundled|Built|Compiling|Building|Writing)\s*[:：]\s*(.+)$/i;
const RE_NODE_DONE   = /^\s*(Build complete|Compiled successfully|Done in|✓ built in|built in|打包完成|构建完成)/i;
const RE_NODE_ERR    = /\b(SyntaxError|TypeError|ReferenceError|RangeError|URIError)\b|^\s*(error|Error)\s*[:：]|Unexpected token|Unexpected end of input|Cannot find module|Module not found|npm ERR!|\bERR_[A-Z_]+\b|✖|ERROR in\b|ENOENT/;
const RE_NODE_WARN   = /\bwarn(ing)?\b|\[warn\]|⚠|deprecat/i;

function parseNodeLine(line) {
  const t = String(line == null ? '' : line).trim();
  let m;
  if ((m = RE_NODE_DONE.exec(t)))         return { kind: 'result', text: t.slice(0, 300), value: 'Succeeded' };
  if ((m = RE_NODE_STEP.exec(t)))         return { kind: 'step',   text: t.slice(0, 300), label: (m[1] + ': ' + m[2]).slice(0, 140) };
  if (RE_NODE_ERR.test(t))                return { kind: 'error',  text: t.slice(0, 300) };
  if (RE_NODE_WARN.test(t))               return { kind: 'warn',   text: t.slice(0, 300) };
  return { kind: 'info', text: t.slice(0, 300) };
}

/* ==================== 自检输出（_suite_out.txt，覆盖写）==================== */

const RE_SUITE_HEAD   = /^\s*={3,}\s*(.+?)\s*={3,}\s*$/;
const RE_SUITE_RESULT = /^\s*结果\s*[:：]\s*(.*)$/;

/* 结果行的语义判定。
   工程里的真实写法有三种，不能只认"通过"二字：
     "全部通过（仍需真机编译才算数）"  → 通过
     "0 个文件括号不平（共查 85 个）"  → 通过（零问题）
     "0 组文件级重名（共查 85 个文件）" → 通过（零问题）
   负面词优先，避免"全部通过"里混入别的词时误判。 */
const RE_SUITE_FAIL = /失败|不通过|未通过|FAIL|异常|错误|缺失|遗漏|泄漏/i;
const RE_SUITE_PASS = /通过|成功|PASS|^OK|完成|正常/i;
const RE_SUITE_ZERO = /^\s*0\s*(个|组|处|条|项|次|类)/;

function judgeSuiteResult(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();
  if (RE_SUITE_FAIL.test(t)) return false;
  if (RE_SUITE_PASS.test(t)) return true;
  if (RE_SUITE_ZERO.test(t)) return true;   // "0 个文件括号不平" = 零问题 = 通过
  return null;
}

function parseSuite(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    let m;
    if ((m = RE_SUITE_HEAD.exec(raw))) {
      if (cur) out.push(cur);
      cur = { name: m[1], result: '', pass: null };
      continue;
    }
    if (cur && (m = RE_SUITE_RESULT.exec(raw))) {
      cur.result = m[1].trim().slice(0, 200);
      cur.pass = judgeSuiteResult(cur.result);
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 通用目录产物扫描（Node / 前端工程用）。
 * roots: [{ dir, group, depth }] —— depth 是往下钻的层数（0 = 只看这一层）
 */
function scanTreeArtifacts(roots, limit) {
  const out = [];
  const walk = (dir, group, depth, base) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names) {
      if (n === 'node_modules' || n === '.git') continue;
      const p = path.join(dir, n);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isDirectory()) {
        if (depth > 0) walk(p, group, depth - 1, base);
        continue;
      }
      out.push({
        name: path.relative(base, p).replace(/\\/g, '/') || n,
        path: p,
        group,
        size: st.size,
        mtime: st.mtimeMs,
        mtimeText: formatTime(st.mtimeMs)
      });
    }
  };
  for (const r of roots || []) {
    if (!r || !r.dir) continue;
    walk(r.dir, r.group || '产物', r.depth == null ? 1 : r.depth, r.dir);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit || 80);
}

/* ==================== 产物扫描 ==================== */

function scanArtifacts(paths, limit) {
  const out = [];
  const push = (dir, exts, group) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (!st.isFile()) continue;
      if (exts && !exts.some(e => n.toLowerCase().endsWith(e))) continue;
      out.push({
        name: n,
        path: p,
        group,
        size: st.size,
        mtime: st.mtimeMs,
        mtimeText: formatTime(st.mtimeMs)
      });
    }
  };
  push(paths.savedDir,   ['.json'], '报告');
  push(paths.shotDir,    ['.png', '.jpg'], '截图');
  push(paths.crashesDir, null, '崩溃');
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit || 80);
}

function formatTime(ms) {
  const d = new Date(ms);
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = {
  parseBuildLine, buildProgress,
  parseNodeLine,
  parseUeLine, isStoryLine, isAlertLine,
  parseSuite, judgeSuiteResult,
  scanArtifacts, scanTreeArtifacts, formatTime
};
