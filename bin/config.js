'use strict';

/**
 * 统一配置加载 + 路径派生。
 *
 * 便携化的核心：换机器 / 换工程时，用户**只需要给一个工程目录**，
 * 其余路径全部由这里派生出来；config.json 里显式写了的值优先（兼容手改的老配置）。
 *
 * 工程有两种常见形态，本模块都要能认出来：
 *   ① 单工程：   <root>/  xxx.uproject  +  Saved/  +  build_game.bat
 *   ② 工作区：   <root>/  build_game.bat + BuildLogs/ + _shot/ + 子目录里有 .uproject
 *      —— 即「工作区根」与「UE 工程根」不是同一个目录（本机 E:/UE4 就是这种）
 */

const fs = require('fs');
const path = require('path');

const DEV_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(DEV_ROOT, 'config.json');
const DEFAULT_FILE = path.join(DEV_ROOT, 'config.default.json');

const DEFAULT_TOP = {
  host: '0.0.0.0',
  port: 8787,
  pollIntervalMs: 700,
  allowBuild: true
};

const DEFAULT_MATCH = {
  storyCategories: ['LogMouseAdventure'],
  streamCategoryPrefix: 'LogStream'
};

const DEFAULT_LIMITS = { ueLogLines: 400, buildLines: 200, artifacts: 80 };

/* ---------------- 小工具 ---------------- */

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

/** 统一成正斜杠、去尾斜杠，便于比较与展示 */
function norm(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

function join(a, b) {
  return norm(path.join(a, b));
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

/** 目录里第一个 *.uproject 的名字（不含扩展名） */
function findUproject(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  for (const n of names) {
    if (n.toLowerCase().endsWith('.uproject') && isFile(path.join(dir, n))) {
      return { file: path.join(dir, n), name: n.slice(0, -'.uproject'.length) };
    }
  }
  return null;
}

/** 目录里的 *.bat，按"像不像一个编译脚本"排序后取最好的那个 */
const BAT_PREFERENCE = [
  /^build_game\.bat$/i,
  /^build(_|)game(_|)plain\.bat$/i,
  /^build(andrun|project|editor|game)?\.bat$/i,
  /^rebuild\.bat$/i,
  /^compile.*\.bat$/i
];

function findBuildBat(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  const bats = names.filter((n) => n.toLowerCase().endsWith('.bat') && isFile(path.join(dir, n)));
  for (const re of BAT_PREFERENCE) {
    const hit = bats.find((n) => re.test(n));
    if (hit) return path.join(dir, hit);
  }
  // 兜底：文件名里带 build / compile 的
  const fuzzy = bats.find((n) => /build|compile/i.test(n));
  return fuzzy ? path.join(dir, fuzzy) : null;
}

/** Saved/Logs 下最新的主日志（排除 -backup- 轮转件） */
function newestMainLog(savedDir) {
  const dir = path.join(savedDir, 'Logs');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  let best = null;
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.log')) continue;
    if (/-backup-/i.test(n)) continue;
    const p = path.join(dir, n);
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
  }
  return best ? best.p : null;
}

/* ============================================================
   多工程 / 多技术栈
   ============================================================
   config.json 有两种写法，都支持：

   ① 单工程（老写法，全部向后兼容）
      { "ue": { "workspaceRoot": "...", "projectRoot": "..." } }

   ② 多工程
      { "projects": [
          { "id": "game", "name": "CursorAdventure", "kind": "ue",
            "workspaceRoot": "E:/UE4", "projectRoot": "E:/UE4/CursorAdventure" },
          { "id": "resume", "name": "移动简历", "kind": "node",
            "root": "E:/编程/移动简历", "buildCmd": "node build.js" }
      ] }

   无论哪种写法，加载后都归一到 cfg.projects（数组），
   老的 cfg.ue 仍指向「第一个 UE 工程」，供 setup.js / launcher.js 打印。 */

const KIND_LABEL = {
  ue: 'Unreal Engine',
  node: 'Node / 前端构建',
  generic: '通用命令'
};

function readPackageJson(dir) {
  const j = readJson(path.join(dir, 'package.json'));
  return j && typeof j === 'object' ? j : null;
}

/** 猜一个 Node 工程的构建命令（找不到就返回空） */
function detectNodeBuildCmd(dir) {
  if (!dir) return '';
  const pkg = readPackageJson(dir);
  const scripts = (pkg && pkg.scripts) || {};
  // 显式的构建脚本最可信；build.js 是「不用打包器」那类工程的常见写法
  if (isFile(path.join(dir, 'build.js'))) return 'node build.js';
  if (scripts.build) return 'npm run build';
  if (isFile(path.join(dir, 'vite.config.js')) || isFile(path.join(dir, 'vite.config.ts'))) return 'npx vite build';
  if (isFile(path.join(dir, 'next.config.js')) || isFile(path.join(dir, 'next.config.mjs'))) return 'npx next build';
  if (pkg) return 'npm run build';
  return '';
}

/** 猜一个 Node 工程的运行命令（决定「运行」页看谁的日志） */
function detectNodeRunCmd(dir) {
  if (!dir) return '';
  const pkg = readPackageJson(dir);
  const scripts = (pkg && pkg.scripts) || {};
  if (scripts.dev) return 'npm run dev';
  if (scripts.start) return 'npm run start';
  if (scripts.serve) return 'npm run serve';
  // 零依赖的静态预览脚本，优先于带依赖的后端
  if (isFile(path.join(dir, 'tools/serve.mjs'))) return 'node tools/serve.mjs';
  if (isFile(path.join(dir, 'server/server.js'))) return 'node server/server.js';
  if (isFile(path.join(dir, 'index.js'))) return 'node index.js';
  return '';
}

function slugId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** UE 工程：显式路径优先，留空的用派生值补（原有逻辑抽出来复用） */
function normalizeUeBlock(ue) {
  let projectRoot = norm(ue.projectRoot);
  let workspaceRoot = norm(ue.workspaceRoot);
  let projectName = ue.projectName || '';

  if (!projectName && projectRoot) {
    const up = findUproject(projectRoot);
    if (up) projectName = up.name;
  }
  if (!workspaceRoot) {
    // 老配置里 projectRoot 其实指的是工作区根（E:/UE4）时，顺着 Saved 位置反推
    const explicitSaved = norm(ue.savedDir);
    if (explicitSaved && explicitSaved.endsWith('/Saved')) {
      const guessPr = explicitSaved.slice(0, -'/Saved'.length);
      if (isDir(guessPr)) { projectRoot = guessPr; workspaceRoot = projectRoot; }
    }
    if (!workspaceRoot) workspaceRoot = projectRoot;
  }
  if (!projectRoot) projectRoot = workspaceRoot;

  const derived = buildPaths(workspaceRoot, projectRoot, projectName);
  return {
    workspaceRoot,
    projectRoot,
    projectName: projectName || derived.projectName || '',
    savedDir: norm(ue.savedDir) || derived.savedDir,
    crashesDir: norm(ue.crashesDir) || derived.crashesDir,
    ueLog: norm(ue.ueLog) || derived.ueLog,
    buildBat: norm(ue.buildBat) || derived.buildBat,
    buildOutLog: norm(ue.buildOutLog) || derived.buildOutLog,
    buildErrorsLog: norm(ue.buildErrorsLog) || derived.buildErrorsLog,
    buildLogsDir: norm(ue.buildLogsDir) || derived.buildLogsDir,
    shotDir: norm(ue.shotDir) || derived.shotDir,
    suiteOut: norm(ue.suiteOut) || derived.suiteOut
  };
}

/** 把一个原始工程条目归一成带全部派生字段的对象 */
function normalizeProject(raw, idx, usedIds) {
  const kind = String(raw.kind || 'ue').toLowerCase();
  const label = raw.name || raw.projectName || ('工程' + (idx + 1));
  let id = String(raw.id || slugId(label) || ('p' + (idx + 1)));
  while (usedIds.has(id)) id = id + '_' + (idx + 1);
  usedIds.add(id);

  if (kind === 'ue') {
    const ue = normalizeUeBlock(raw);
    return {
      id,
      name: label,
      kind,
      kindLabel: KIND_LABEL.ue,
      root: ue.projectRoot,
      ue,
      // UE 的编译日志由 build_game.bat 双写进文件，采集器尾随它
      buildSource: 'file',
      buildCmd: '',
      runCmd: '',
      distDir: '',
      canBuild: isFile(ue.buildBat),
      canRun: false,
      pathsPresent: {
        root: isDir(ue.projectRoot),
        workspaceRoot: isDir(ue.workspaceRoot),
        savedDir: isDir(ue.savedDir),
        log: isFile(ue.ueLog),
        build: isFile(ue.buildBat),
        buildOutLog: isFile(ue.buildOutLog),
        buildLogsDir: isDir(ue.buildLogsDir),
        shotDir: isDir(ue.shotDir),
        suiteOut: isFile(ue.suiteOut)
      }
    };
  }

  /* node / generic：一个根目录 + 一条构建命令 + 一条运行命令 */
  const root = norm(raw.root || raw.projectRoot || raw.workspaceRoot);
  const buildCmd = String(raw.buildCmd || '').trim() || detectNodeBuildCmd(root);
  // runCmd 留空 ⇒ 自动探测一个（用户点了「启动日志」才会真的跑）；
  // 明确写 false 表示"这个工程不要运行按钮"
  const runCmd = raw.runCmd === false
    ? ''
    : (String(raw.runCmd || '').trim() || detectNodeRunCmd(root));
  const distDir = norm(raw.distDir) || join(root, 'dist');
  return {
    id,
    name: label,
    kind,
    kindLabel: KIND_LABEL[kind] || KIND_LABEL.generic,
    root,
    ue: null,
    // 这类命令把输出打到 stdout，采集器直接吃进程输出（并落盘到 dev-monitor 自己的 runtime）
    buildSource: 'console',
    buildCmd,
    runCmd,
    distDir,
    canBuild: !!buildCmd && isDir(root),
    canRun: !!runCmd && isDir(root),
    pathsPresent: {
      root: isDir(root),
      build: !!buildCmd,
      run: !!runCmd,
      distDir: isDir(distDir)
    }
  };
}

/** 原始配置 → 工程数组（无 projects 时用老的 ue 段合成一个） */
function normalizeProjects(raw) {
  const used = new Set();
  const list = Array.isArray(raw.projects) ? raw.projects.filter((p) => p && typeof p === 'object') : [];
  if (list.length) return list.map((p, i) => normalizeProject(p, i, used));

  // 老配置：只有一个 ue 段
  if (raw.ue && (raw.ue.projectRoot || raw.ue.workspaceRoot || raw.ue.ueLog)) {
    return [normalizeProject(Object.assign({ name: raw.ue.projectName || 'UE 工程', kind: 'ue' }, raw.ue), 0, used)];
  }
  return [];
}

/* ---------------- 探测（给配置向导用） ---------------- */

/**
 * 从 startDir 出发，猜出 (workspaceRoot, projectRoot, projectName)。
 * startDir 默认取 dev-monitor 的上一级 —— 也就是"把 dev-monitor 放在工程里"的常见装法。
 */
function detectLayout(startDir) {
  const start = path.resolve(startDir || path.join(DEV_ROOT, '..'));
  const out = { workspaceRoot: '', projectRoot: '', projectName: '', evidence: [] };

  const here = findUproject(start);
  if (here) {
    // 单工程形态：.uproject 就在 start 里
    out.workspaceRoot = norm(start);
    out.projectRoot = norm(start);
    out.projectName = here.name;
    out.evidence.push('在 ' + norm(start) + ' 找到 ' + here.name + '.uproject');
    return out;
  }

  // 工作区形态：start 的下一级子目录里有 .uproject
  let names = [];
  try { names = fs.readdirSync(start); } catch (_) { names = []; }
  const candidates = [];
  for (const n of names) {
    const d = path.join(start, n);
    if (!isDir(d)) continue;
    const up = findUproject(d);
    if (up) candidates.push({ dir: d, name: up.name, mtime: safeMtime(path.join(d, up.file.split(path.sep).pop())) });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length) {
    out.workspaceRoot = norm(start);
    out.projectRoot = norm(candidates[0].dir);
    out.projectName = candidates[0].name;
    out.evidence.push('在 ' + norm(start) + ' 的子目录里找到工程 ' + candidates[0].name);
    if (candidates.length > 1) {
      out.evidence.push('该目录下还有 ' + (candidates.length - 1) + ' 个其它 .uproject，可在配置向导里改选');
      out.alternatives = candidates.map((c) => ({ projectRoot: norm(c.dir), projectName: c.name }));
    }
    return out;
  }

  // 什么都没找到：把 start 当成工作区根，剩下的交给用户填
  out.workspaceRoot = norm(start);
  out.evidence.push('在 ' + norm(start) + ' 未找到 .uproject，需要手动指定工程目录');
  return out;
}

function safeMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; }
}

/** 根据两个根目录，把全部监控路径派生出来（只读，不写盘） */
function buildPaths(workspaceRoot, projectRoot, projectName) {
  const ws = norm(workspaceRoot);
  const pr = norm(projectRoot) || ws;
  const name = projectName || '';

  const savedDir = join(pr, 'Saved');
  const crashedir = join(savedDir, 'Crashes');

  const p = {
    workspaceRoot: ws,
    projectRoot: pr,
    projectName: name,
    savedDir,
    crashesDir: crashedir,
    ueLog: name
      ? join(savedDir, 'Logs/' + name + '.log')
      : (norm(newestMainLog(savedDir)) || join(savedDir, 'Logs/Project.log')),
    buildBat: findBuildBat(ws) || join(ws, 'build_game.bat'),
    buildOutLog: join(ws, 'build_out.log'),
    buildErrorsLog: join(ws, 'build_last_errors.log'),
    buildLogsDir: join(ws, 'BuildLogs'),
    shotDir: join(ws, '_shot'),
    suiteOut: join(ws, '.workbuddy/tools/_suite_out.txt')
  };
  p.buildBat = norm(p.buildBat);
  return p;
}

/** 探测结果 → 完整配置对象（v2 结构） */
function detectConfig(startDir, overrides) {
  const layout = detectLayout(startDir);
  const ov = overrides || {};
  const ws = ov.workspaceRoot || layout.workspaceRoot;
  const pr = ov.projectRoot || layout.projectRoot;
  const name = ov.projectName || layout.projectName;
  const paths = buildPaths(ws, pr, name);

  return {
    config: {
      host: DEFAULT_TOP.host,
      port: DEFAULT_TOP.port,
      pollIntervalMs: DEFAULT_TOP.pollIntervalMs,
      allowBuild: isFile(paths.buildBat),
      ue: Object.assign({}, paths, ov.overrides || {}),
      match: Object.assign({}, DEFAULT_MATCH),
      limits: Object.assign({}, DEFAULT_LIMITS)
    },
    layout,
    paths
  };
}

/* ---------------- 加载（服务端使用） ---------------- */

function load() {
  const raw = readJson(CONFIG_FILE);
  if (!raw) {
    const e = new Error(
      '未找到配置文件 ' + CONFIG_FILE + '\n' +
      '请先运行『首次配置.bat』生成配置（或手动复制 config.default.json 为 config.json 并填写 ue 路径）。'
    );
    e.code = 'NO_CONFIG';
    throw e;
  }
  return normalize(raw);
}

function normalize(raw) {
  const projects = normalizeProjects(raw);
  if (!projects.length) {
    const e = new Error('config.json 里没有可监控的工程：请填写 ue.projectRoot 或 projects 数组。');
    e.code = 'NO_PROJECT';
    throw e;
  }

  // 老的 cfg.ue 仍指向第一个 UE 工程（setup.js / launcher.js 打印用）；
  // 纯 Node 工程配置时给一份空壳，避免调用方解引用 undefined。
  const firstUe = projects.find((p) => p.kind === 'ue');
  const ueOut = firstUe ? firstUe.ue : normalizeUeBlock(raw.ue || {});

  const match = Object.assign({}, DEFAULT_MATCH, raw.match || {});
  if (!Array.isArray(match.storyCategories) || !match.storyCategories.length) {
    match.storyCategories = DEFAULT_MATCH.storyCategories.slice();
  }
  if (!match.streamCategoryPrefix) match.streamCategoryPrefix = DEFAULT_MATCH.streamCategoryPrefix;

  const limits = Object.assign({}, DEFAULT_LIMITS, raw.limits || {});

  return {
    host: raw.host || DEFAULT_TOP.host,
    port: Number(raw.port) || DEFAULT_TOP.port,
    pollIntervalMs: Number(raw.pollIntervalMs) || DEFAULT_TOP.pollIntervalMs,
    allowBuild: raw.allowBuild !== false,
    projects,
    // 兼容字段
    ue: ueOut,
    match,
    limits,
    // 供「体检」用：这些路径当前是否存在（第一个工程）
    pathsPresent: (projects[0] || {}).pathsPresent || {}
  };
}

/** 配置体检：返回给人看的提示（配置向导与启动时都用它）。多工程时逐条带工程名。 */
function healthCheck(cfg) {
  const notes = [];
  const projects = (cfg && cfg.projects) || [];
  const multi = projects.length > 1;

  for (const p of projects) {
    const pre = multi ? '[' + p.name + '] ' : '';
    const x = p.pathsPresent || {};
    if (!x.root) {
      notes.push({ level: 'error', text: pre + '工程目录不存在：' + p.root });
      continue;
    }
    if (p.kind === 'ue') {
      if (!x.log) notes.push({ level: 'warn', text: pre + '运行日志还没出现（跑一次游戏就会有）：' + p.ue.ueLog });
      if (!x.build) notes.push({ level: 'warn', text: pre + '未找到编译脚本，编译面板不可用：' + p.ue.buildBat });
      if (!x.suiteOut) notes.push({ level: 'info', text: pre + '未找到自检输出，自检面板会保持空白：' + p.ue.suiteOut });
      if (!x.shotDir) notes.push({ level: 'info', text: pre + '未找到截图目录，产物面板少了截图分组：' + p.ue.shotDir });
    } else {
      if (!x.build) notes.push({ level: 'warn', text: pre + '没有可用的构建命令，编译面板不可用（配 buildCmd）' });
      if (!x.distDir) notes.push({ level: 'info', text: pre + '构建产物目录还不存在（编译一次就有）：' + p.distDir });
    }
  }
  if (!projects.length) notes.push({ level: 'error', text: '配置里没有任何工程' });
  return notes;
}

module.exports = {
  DEV_ROOT,
  CONFIG_FILE,
  DEFAULT_FILE,
  DEFAULT_TOP,
  DEFAULT_MATCH,
  DEFAULT_LIMITS,
  KIND_LABEL,
  load,
  normalize,
  readJson,
  norm,
  isDir,
  isFile,
  findUproject,
  findBuildBat,
  newestMainLog,
  detectLayout,
  detectConfig,
  buildPaths,
  normalizeUeBlock,
  normalizeProject,
  normalizeProjects,
  detectNodeBuildCmd,
  detectNodeRunCmd,
  healthCheck
};
