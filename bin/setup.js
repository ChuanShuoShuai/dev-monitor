'use strict';

/**
 * 配置向导 —— 生成 config.json。
 *
 * 用法：
 *   node bin/setup.js                      # 交互式（推荐，双击『首次配置.bat』）
 *   node bin/setup.js --yes                # 用自动探测结果直接写，不交互
 *   node bin/setup.js --root E:/MyGame     # 指定起点目录再探测
 *   node bin/setup.js --workspace E:/Proj --project E:/Proj/MyGame --name MyGame
 *   node bin/setup.js --port 9000 --force  # 改端口 + 覆盖已有配置
 *   node bin/setup.js --add-node E:/MyWeb --name 我的网页
 *                                          # 往现有配置里追加一个 Node / 前端工程
 *
 * 只写 dev-monitor/config.json 一个文件，不碰工程目录。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const readline = require('readline');

const C = require('./config');

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a._.push(t); continue; }
    const key = t.slice(2);
    if (key === 'yes' || key === 'force' || key === 'help' || key === 'h') { a[key] = true; continue; }
    const val = argv[++i];
    a[key] = val;
  }
  return a;
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.help || ARGS.h) {
  console.log(`
配置向导 —— 生成 dev-monitor/config.json

  node bin/setup.js                       交互式配置（推荐）
  node bin/setup.js --yes                 用自动探测结果直接写盘
  node bin/setup.js --root <目录>         从该目录开始探测
  node bin/setup.js --workspace <目录>    直接指定工作区根（含编译脚本的那一层）
  node bin/setup.js --project <目录>      直接指定 UE 工程根（含 .uproject 的那一层）
  node bin/setup.js --name <工程名>       直接指定 UE 工程名（决定 Saved/Logs/<名>.log）
  node bin/setup.js --port <端口>         指定端口（默认 8787）
  node bin/setup.js --force               已有配置时不再询问，直接覆盖
  node bin/setup.js --add-node <目录> [--name 名字]
                                          追加一个 Node / 前端工程（kind=node）
`);
  process.exit(0);
}

/* ---------------- 追加 Node 工程 ---------------- */

/** --add-node：只往 projects 里加一项，其它工程原样保留。
 *  手工改 JSON 容易改坏，所以给一个不会误伤的入口。 */
function addNodeProject() {
  const dir = C.norm(ARGS['add-node']);
  if (!dir || !C.isDir(dir)) {
    console.error('');
    console.error('  ❌ 目录不存在：' + (dir || '（空）'));
    console.error('');
    process.exit(1);
  }
  const raw = C.readJson(C.CONFIG_FILE);
  if (!raw) {
    console.error('');
    console.error('  ❌ 还没有 config.json，先跑一次配置向导（node bin/setup.js）');
    console.error('');
    process.exit(1);
  }

  let projects = Array.isArray(raw.projects) ? raw.projects.slice() : [];
  if (!projects.length && raw.ue) {
    // 老的单工程配置：先把它转成 projects 里的第一项
    projects = [{
      name: raw.ue.projectName || 'UE 工程',
      kind: 'ue',
      workspaceRoot: raw.ue.workspaceRoot,
      projectRoot: raw.ue.projectRoot,
      projectName: raw.ue.projectName
    }];
  }

  if (projects.some((p) => C.norm(p.root || p.projectRoot) === dir)) {
    console.log('');
    console.log('  这个目录已经在监控列表里了，没有重复添加。');
    console.log('');
    process.exit(0);
  }

  const name = ARGS.name || path.basename(dir);
  const buildCmd = C.detectNodeBuildCmd(dir);
  const runCmd = C.detectNodeRunCmd(dir);
  projects.push({
    id: 'node-' + (projects.length + 1),
    name,
    kind: 'node',
    root: dir,
    buildCmd,
    runCmd
  });

  raw.projects = projects;
  delete raw.ue;                       // 统一到 projects，避免两处配置打架
  if (!raw._说明) raw._说明 = 'projects 数组：一个工程一项。kind=ue 认 workspaceRoot/projectRoot；kind=node 认 root + buildCmd/runCmd。';
  fs.writeFileSync(C.CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('  ✅ 已添加：' + name);
  console.log('     目录 ' + dir);
  console.log('     构建 ' + (buildCmd || '（没探测到，可在 config.json 里填 buildCmd）'));
  console.log('     运行 ' + (runCmd || '（没探测到，可在 config.json 里填 runCmd）'));
  console.log('     共 ' + projects.length + ' 个工程，重启服务后生效。');
  console.log('');
}

/* --add-node 是独立动作：做完就退出，不进后面的交互向导 */
if (ARGS['add-node']) {
  addNodeProject();
  process.exit(0);
}

/* ---------------- 面板输出 ---------------- */
const LINE = '─'.repeat(66);

function head(t) {
  console.log('');
  console.log('  ' + t);
  console.log('  ' + LINE);
}

/** 中英混排的显示宽度（CJK 占 2 列），否则 padEnd 对不齐 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (
      c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
    )) ? 2 : 1;
  }
  return w;
}

function padTo(s, width) {
  const pad = width - dispWidth(s);
  return s + (pad > 0 ? ' '.repeat(pad) : '');
}

function kv(k, v, mark) {
  const flag = mark === true ? '✅' : mark === false ? '⚠️ ' : '  ';
  console.log(`  ${flag} ${padTo(k, 12)} ${v}`);
}

function tip(t) {
  console.log('     · ' + t);
}

/* ---------------- 交互 ---------------- */
const IS_TTY = !!(process.stdin.isTTY && process.stdout.isTTY);
let rl = null;

function ask(question, def) {
  if (!IS_TTY) return Promise.resolve(def);
  rl = rl || readline.createInterface({ input: process.stdin, output: process.stdout });
  const hint = def ? `（回车用 ${def}）` : '';
  return new Promise((resolve) => {
    rl.question('  ' + question + hint + ' › ', (ans) => {
      let v = String(ans == null ? '' : ans).trim();
      // 支持把文件夹直接拖进窗口：去掉包裹的引号与尾部反斜杠
      v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
      if (!v) v = def || '';
      resolve(v);
    });
  });
}

function closeRl() { if (rl) { rl.close(); rl = null; } }

/* ---------------- 端口 ---------------- */

function portFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    try { s.listen(port, host); } catch (_) { resolve(false); }
  });
}

/** 端口被占用时，判断是不是"本机已经开着的另一个工程监控"
 *  —— 是的话不必换端口，用户自己的服务正在跑而已 */
function probeOwn(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).name === 'dev-monitor'); } catch (_) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * 选端口：
 *   空闲            → 用它
 *   被"自己人"占着  → 也用它（用户的服务正在跑，换端口反而添乱）
 *   被别的东西占着  → 往后顺延
 * 显式 --port 指定的一律尊重，只提示不更换。
 */
async function pickPort(host, want, explicit) {
  if (await portFree(want, host)) return { port: want, shifted: false, ours: false };
  if (explicit) return { port: want, shifted: false, ours: await probeOwn(want), explicit: true };
  if (await probeOwn(want)) return { port: want, shifted: false, ours: true };
  for (let p = want + 1; p < want + 40; p++) {
    if (await portFree(p, host)) return { port: p, shifted: true, ours: false };
  }
  return { port: want, shifted: false, ours: false };
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const existing = C.readJson(C.CONFIG_FILE);

  head('工程监控 · 配置向导');
  console.log('  生成 ' + C.CONFIG_FILE);
  console.log('  只会写这一个文件，不会碰你的工程目录。');

  const startDir = ARGS.root
    || (existing && existing.ue && (existing.ue.workspaceRoot || existing.ue.projectRoot))
    || path.join(C.DEV_ROOT, '..');

  /* ---- 1. 探测 ---- */
  const layout = C.detectLayout(startDir);

  console.log('');
  console.log('  ① 自动探测（起点：' + C.norm(startDir) + '）');
  for (const e of layout.evidence) tip(e);

  let workspaceRoot = C.norm(ARGS.workspace || layout.workspaceRoot);
  let projectRoot = C.norm(ARGS.project || layout.projectRoot);
  let projectName = ARGS.name || layout.projectName || '';

  if (!ARGS.yes && IS_TTY) {
    console.log('');
    if (layout.alternatives && layout.alternatives.length) {
      console.log('  发现多个工程，可选：');
      layout.alternatives.forEach((a, i) => tip(`[${i + 2}] ${a.projectName}  →  ${a.projectRoot}`));
    }
    const ws = await ask('工作区根目录（放编译脚本 / BuildLogs / _shot 的那一层）', workspaceRoot || startDir);
    workspaceRoot = C.norm(ws) || C.norm(startDir);

    const pr = await ask('UE 工程根目录（有 .uproject 的那一层）', projectRoot || workspaceRoot);
    projectRoot = C.norm(pr) || workspaceRoot;

    const up = C.findUproject(projectRoot);
    const nameDef = projectName || (up ? up.name : path.basename(projectRoot));
    const nm = await ask('UE 工程名（决定 Saved/Logs/<工程名>.log）', nameDef);
    projectName = nm || nameDef;
  }

  if (!projectName) {
    const up = C.findUproject(projectRoot);
    projectName = up ? up.name : path.basename(projectRoot || '');
  }

  /* ---- 2. 派生路径 ---- */
  const paths = C.buildPaths(workspaceRoot, projectRoot, projectName);

  console.log('');
  console.log('  ② 派生出的监控路径');
  kv('UE 工程', paths.projectRoot, C.isDir(paths.projectRoot));
  kv('工作区根', paths.workspaceRoot, C.isDir(paths.workspaceRoot));
  kv('运行日志', paths.ueLog, C.isFile(paths.ueLog));
  kv('编译脚本', paths.buildBat, C.isFile(paths.buildBat));
  kv('编译输出', paths.buildOutLog, C.isFile(paths.buildOutLog));
  kv('编译归档', paths.buildLogsDir, C.isDir(paths.buildLogsDir));
  kv('自检输出', paths.suiteOut, C.isFile(paths.suiteOut));
  kv('截图目录', paths.shotDir, C.isDir(paths.shotDir));
  console.log('');
  console.log('  ⚠️  标 ⚠️  的目前还不存在，通常是因为「还没有跑过游戏/编译过/跑过自检」——');
  console.log('     先启动监控也没关系，这些文件一出现就会自动开始显示。');

  /* ---- 3. 端口 ---- */
  const allowBuild = C.isFile(paths.buildBat);
  const wantPort = Number(ARGS.port) || (existing && Number(existing.port)) || C.DEFAULT_TOP.port;
  const pk = await pickPort(C.DEFAULT_TOP.host, wantPort, !!ARGS.port);
  const port = pk.port;
  if (pk.shifted) {
    console.log('');
    console.log(`  ③ 端口 ${wantPort} 已被其它程序占用，自动改用 ${port}`);
  } else if (pk.ours) {
    console.log('');
    console.log(`  ③ 端口 ${port} 上已经有一个工程监控在跑了 —— 保持端口不变，新配置重启后生效`);
  } else if (pk.explicit) {
    console.log('');
    console.log(`  ③ 按你的指定使用端口 ${port}`);
  }

  /* ---- 4. 落盘 ----
     向导只管 UE 这一个工程；配置里已有的其它工程（Node / 前端）原样保留，
     否则重跑一次向导就会把「移动简历」这类工程冲掉。 */
  const prevProjects = (existing && Array.isArray(existing.projects)) ? existing.projects : [];
  const prevUe = prevProjects.find((p) => String(p.kind || 'ue').toLowerCase() === 'ue') || {};
  const others = prevProjects.filter((p) => String(p.kind || 'ue').toLowerCase() !== 'ue');

  const ueEntry = {
    name: prevUe.name || projectName || 'UE 工程',
    kind: 'ue',
    workspaceRoot: paths.workspaceRoot,
    projectRoot: paths.projectRoot,
    projectName: paths.projectName
  };
  if (prevUe.id) ueEntry.id = prevUe.id;

  const cfg = {
    _说明: 'projects 数组：一个工程一项。kind=ue 认 workspaceRoot/projectRoot；kind=node 认 root + buildCmd/runCmd。',
    host: C.DEFAULT_TOP.host,
    port,
    pollIntervalMs: (existing && Number(existing.pollIntervalMs)) || C.DEFAULT_TOP.pollIntervalMs,
    allowBuild,
    projects: [ueEntry].concat(others),
    match: (existing && existing.match) || { storyCategories: ['LogMouseAdventure'], streamCategoryPrefix: 'LogStream' },
    limits: (existing && existing.limits) || { ueLogLines: 400, buildLines: 200, artifacts: 80 }
  };

  if (existing && !ARGS.force && !ARGS.yes && IS_TTY) {
    console.log('');
    const ans = await ask('已存在 config.json，确认覆盖？(y/N)', 'y');
    if (!/^y/i.test(ans)) {
      closeRl();
      console.log('  已取消，原配置保持不变。');
      process.exit(0);
    }
  }

  fs.writeFileSync(C.CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  const saved = C.normalize(cfg);
  const notes = C.healthCheck(saved);

  head('配置完成');
  kv('配置文件', C.CONFIG_FILE);
  kv('访问端口', port);
  kv('编译按钮', allowBuild ? '可用（已找到编译脚本）' : '不可用（没找到编译脚本，其它面板不受影响）');
  for (const n of notes) tip(n.text);
  console.log('');
  console.log('  下一步：双击『启动监控.bat』（或执行 node bin/launcher.js）即可。');
  console.log('');

  closeRl();
}

main().catch((e) => {
  closeRl();
  console.error('');
  console.error('  配置失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
