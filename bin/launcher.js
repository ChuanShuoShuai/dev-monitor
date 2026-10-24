'use strict';

/**
 * 启动器 —— 『启动监控.bat』最终会跑这个。
 *
 * 职责（按顺序）：
 *   1. 自检 Node 版本
 *   2. 检查 config.json：没有 / 指向的工程目录不存在 ⇒ 就地跑配置向导
 *   3. 起 server/server.js（同控制台，日志直通）
 *   4. 等服务真的活了，自动打开浏览器到「连接指引」页
 *
 * 参数：
 *   --no-open      不自动开浏览器（服务器/CI 环境用）
 *   --no-setup     缺配置也不引导，直接报错退出
 *   --port <n>     临时改端口（不改 config.json）
 *   --config <p>   用另一份配置文件（调试用）
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const C = require('./config');

const LINE = '─'.repeat(66);

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a._.push(t); continue; }
    const key = t.slice(2);
    if (['no-open', 'no-setup', 'no-build', 'help', 'h'].includes(key)) { a[key] = true; continue; }
    a[key] = argv[++i];
  }
  return a;
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.help || ARGS.h) {
  console.log(`
启动工程监控

  node bin/launcher.js              启动并在浏览器打开连接指引
  node bin/launcher.js --no-open    只启动，不开浏览器
  node bin/launcher.js --port 9000  临时换端口
`);
  process.exit(0);
}

/* ---------------- 0. Node 自检 ---------------- */

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.log('');
    console.log('  ⚠️  当前 Node 版本 ' + process.versions.node + ' 偏低，本项目需要 Node 18 及以上。');
    console.log('     请运行『下载运行环境.bat』装一个便携版，或自行升级 Node.js。');
    console.log('');
    process.exit(1);
  }
}

/* ---------------- 1. 配置 ---------------- */

function needsSetup() {
  if (ARGS.config) return false;
  if (!fs.existsSync(C.CONFIG_FILE)) return true;
  try {
    const cfg = C.load();
    // 只要有一个工程的目录还在，就不必重跑向导（纯 Node 工程配置里 ue.projectRoot 是空的）
    return !(cfg.projects || []).some((p) => C.isDir(p.root));
  } catch (_) { return true; }
}

function runSetup() {
  return new Promise((resolve) => {
    console.log('');
    console.log('  首次使用，先做一次配置……');
    console.log('');
    const p = spawn(process.execPath, [path.join(__dirname, 'setup.js')], { stdio: 'inherit' });
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

/* ---------------- 2. 起服务 ---------------- */

function startServer() {
  const env = Object.assign({}, process.env);
  if (ARGS.port) env.DM_PORT = String(ARGS.port);
  if (ARGS.config) env.DM_CONFIG = path.resolve(ARGS.config);
  if (ARGS['no-build']) env.DM_ALLOW_BUILD = 'false';

  const p = spawn(process.execPath, [path.join(C.DEV_ROOT, 'server', 'server.js')], {
    stdio: 'inherit',
    env,
    cwd: C.DEV_ROOT
  });
  return p;
}

/* ---------------- 3. 读端口 + 开浏览器 ---------------- */

function readPort() {
  if (ARGS.port) return Number(ARGS.port);
  try {
    const p = ARGS.config ? path.resolve(ARGS.config) : C.CONFIG_FILE;
    const raw = C.readJson(p) || {};
    if (raw.port) return Number(raw.port);
  } catch (_) {}
  return C.DEFAULT_TOP.port;
}

function waitAlive(port, tries) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      n++;
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1200 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => (n >= (tries || 40) ? resolve(false) : setTimeout(tick, 250));
    tick();
  });
}

function openBrowser(url) {
  const plat = process.platform;
  let cmd, args;
  if (plat === 'win32') { cmd = 'rundll32.exe'; args = ['url.dll,FileProtocolHandler', url]; }
  else if (plat === 'darwin') { cmd = 'open'; args = [url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch (_) {}
}

/* ---------------- 主流程 ---------------- */

async function main() {
  checkNode();

  console.log('');
  console.log('  工程监控 · 启动中');
  console.log('  ' + LINE);
  console.log('  Node        ' + process.version + '  (' + process.arch + ')');
  console.log('  程序目录    ' + C.DEV_ROOT);
  console.log('  配置文件    ' + (ARGS.config ? path.resolve(ARGS.config) : C.CONFIG_FILE));
  console.log('  ' + LINE);

  if (needsSetup()) {
    if (ARGS['no-setup']) {
      console.log('');
      console.log('  ❌ 还没有可用的 config.json，且指定了 --no-setup。');
      console.log('     请先运行：node bin/setup.js');
      process.exit(2);
    }
    const ok = await runSetup();
    if (!ok || !fs.existsSync(C.CONFIG_FILE)) {
      console.log('');
      console.log('  ❌ 配置未完成，已退出。');
      process.exit(2);
    }
  }

  /* 打印一份"当前在看什么"，配置文件填错了当场就能看出来 */
  try {
    const cfg = C.load();
    const notes = C.healthCheck(cfg);
    console.log('');
    console.log('  当前监控目标（' + cfg.projects.length + ' 个工程）');
    for (const proj of cfg.projects) {
      console.log('    · ' + proj.name + '  [' + proj.kindLabel + ']');
      console.log('      目录      ' + proj.root + (C.isDir(proj.root) ? '' : '   ❌ 目录不存在'));
      if (proj.kind === 'ue') {
        console.log('      运行日志  ' + proj.ue.ueLog + (C.isFile(proj.ue.ueLog) ? '' : '   （还没生成）'));
        console.log('      编译脚本  ' + proj.ue.buildBat + (C.isFile(proj.ue.buildBat) ? '' : '   （没找到，编译按钮不可用）'));
        console.log('      编译输出  ' + proj.ue.buildOutLog);
        console.log('      自检输出  ' + proj.ue.suiteOut);
        console.log('      截图目录  ' + proj.ue.shotDir);
      } else {
        console.log('      构建命令  ' + (proj.buildCmd || '（未配置）'));
        if (proj.runCmd) console.log('      运行命令  ' + proj.runCmd);
      }
    }
    for (const n of notes) {
      if (n.level === 'error') console.log('    ❌ ' + n.text);
    }
    console.log('  ' + LINE);
  } catch (e) {
    console.log('  ❌ 读取配置失败：' + e.message);
    process.exit(2);
  }

  const port = readPort();
  const proc = startServer();

  /* 服务起来后自动开「连接指引」页 —— 那一页就是给用户看的说明书：
     手机该扫哪个码、地址是什么 */
  if (!ARGS['no-open']) {
    waitAlive(port).then((alive) => {
      if (alive) openBrowser(`http://127.0.0.1:${port}/guide`);
    });
  }

  proc.on('close', (code) => process.exit(code == null ? 0 : code));

  const bye = () => { try { proc.kill(); } catch (_) {} };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch((e) => {
  console.error('  启动失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
