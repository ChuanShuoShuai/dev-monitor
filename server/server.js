'use strict';

/**
 * 工程监控服务 —— 零第三方依赖。
 *
 * 同时看多个工程、多种技术栈（Unreal Engine / Node 前端构建 / 任意命令行工程）：
 *   · 每个工程一个适配器实例，互不干扰
 *   · 手机端顶部可切换工程，接口一律带 ?project=<id>
 *   · 监控数据全程只读工程目录；唯一的写操作是用户主动点下的「开始编译」
 *     （Node 类的构建输出只落到 dev-monitor 自己的 runtime/ 目录，不碰工程）
 *
 * 运行：node server/server.js    （或双击 start.bat）
 * 手机：http://<电脑IP>:8787
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CFG = require('../bin/config');
const { createMonitor } = require('./adapters');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');

/* 配置统一走 bin/config.js：只填工程目录、其余路径自动派生。
   环境变量可临时覆盖，便于调试与多工程并存：
     DM_CONFIG      用另一份配置文件
     DM_PORT        覆盖端口
     DM_HOST        覆盖监听地址
     DM_ALLOW_BUILD=false  禁用编译按钮 */

let cfg;
try {
  if (process.env.DM_CONFIG) {
    const alt = path.resolve(process.env.DM_CONFIG);
    const raw = CFG.readJson(alt);
    if (!raw) throw new Error('配置文件无法读取或不是合法 JSON：' + alt);
    cfg = CFG.normalize(raw);
  } else {
    cfg = CFG.load();
  }
} catch (e) {
  console.error('');
  console.error('  工程监控启动失败');
  console.error('  ' + String(e.message).split('\n').join('\n  '));
  console.error('');
  process.exit(2);
}
if (process.env.DM_PORT) cfg.port = Number(process.env.DM_PORT) || cfg.port;
if (process.env.DM_HOST) cfg.host = process.env.DM_HOST;
if (process.env.DM_ALLOW_BUILD === 'false') cfg.allowBuild = false;

/* ---------------- 事件总线 ---------------- */

const store = { startedAt: Date.now(), seq: 0, events: [] };
const clients = new Set();

/** 事件统一带 project 字段，前端按当前选中的工程过滤 */
function emitFor(pid, type, data) {
  store.seq += 1;
  const ev = { seq: store.seq, project: pid, type, data, at: Date.now() };
  store.events.push(ev);
  if (store.events.length > 1200) store.events.splice(0, store.events.length - 1200);
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch (_) { clients.delete(res); }
  }
}

/* ---------------- 采集器装配（每个工程一个） ---------------- */

const monitors = new Map();
const bootErrors = [];

for (const proj of cfg.projects) {
  try {
    monitors.set(proj.id, createMonitor(proj, cfg, emitFor));
  } catch (e) {
    bootErrors.push({ project: proj.name, error: e.message });
  }
}

if (!monitors.size) {
  console.error('');
  console.error('  工程监控启动失败：没有可用的工程适配器');
  for (const b of bootErrors) console.error('  · ' + b.project + '：' + b.error);
  console.error('');
  process.exit(2);
}

for (const m of monitors.values()) m.prime();

/** 默认工程：第一个目录存在的，否则第一个 */
const defaultPid = (() => {
  for (const [id, m] of monitors) {
    const present = m.proj && m.proj.pathsPresent && m.proj.pathsPresent.root;
    if (present) return id;
  }
  return monitors.keys().next().value;
})();

function resolvePid(query) {
  const id = (query && (query.get('project') || query.get('p'))) || '';
  if (id && monitors.has(id)) return id;
  return defaultPid;
}

function allBriefs() {
  return Array.from(monitors.values()).map((m) => m.brief());
}

setInterval(() => {
  for (const m of monitors.values()) {
    try { m.poll(); } catch (_) {}
  }
}, cfg.pollIntervalMs);

/* ---------------- 工具 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function sendJson(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/** 只允许读取各工程白名单目录下的图片，防路径穿越 */
function resolveWhitelisted(p) {
  if (!p) return null;
  const rp = path.resolve(p);
  for (const m of monitors.values()) {
    for (const r of m.imageRoots() || []) {
      if (!r) continue;
      const rr = path.resolve(r);
      if (rp === rr || rp.startsWith(rr + path.sep)) {
        const ext = path.extname(rp).toLowerCase();
        if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') return rp;
      }
    }
  }
  return null;
}

/** 产物详情：文本内容白名单（报告 json / 崩溃日志 / 构建日志 / 产物文件） */
const TEXT_PREVIEW_LIMIT = 512 * 1024; // 512KB，超出截断
const BINARY_EXT = new Set(['.dmp', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.7z', '.exe', '.dll', '.woff', '.woff2', '.ttf', '.ico']);

function resolveContentWhitelisted(p) {
  if (!p) return null;
  const rp = path.resolve(p);
  for (const m of monitors.values()) {
    for (const r of m.textRoots() || []) {
      if (!r) continue;
      const rr = path.resolve(r);
      if (rp === rr || rp.startsWith(rr + path.sep)) return rp;
    }
  }
  return null;
}

function serveArtifactContent(res, fp) {
  let st;
  try { st = fs.statSync(fp); } catch (_) {
    return sendJson(res, { ok: false, error: '文件不存在或已被清理' }, 404);
  }
  if (!st.isFile()) return sendJson(res, { ok: false, error: '不是文件' }, 400);

  const ext = path.extname(fp).toLowerCase();
  const name = path.basename(fp);
  const meta = {
    ok: true,
    name,
    path: fp,
    size: st.size,
    mtime: st.mtimeMs,
    mtimeText: new Date(st.mtimeMs).toLocaleString('zh-CN', { hour12: false })
  };

  // 二进制扩展名（崩溃转储等）只给元信息，不给内容
  if (BINARY_EXT.has(ext)) {
    return sendJson(res, { ...meta, binary: true, content: null });
  }
  // 文本：读取并限长
  fs.readFile(fp, (err, buf) => {
    if (err) return sendJson(res, { ok: false, error: '读取失败: ' + err.code }, 500);
    const truncated = buf.length > TEXT_PREVIEW_LIMIT;
    const slice = truncated ? buf.subarray(0, TEXT_PREVIEW_LIMIT) : buf;
    // 崩溃日志常带 NUL/控制字符，替换掉避免前端渲染异常
    const content = slice.toString('utf8').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '·');
    sendJson(res, { ...meta, binary: false, truncated, content });
  });
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

/* ---------------- 编译 / 运行 控制 ---------------- */

function handleStart(res, pid, kind) {
  if (cfg.allowBuild === false) {
    return sendJson(res, { ok: false, error: '服务端已禁用编译（config.json allowBuild=false）' }, 403);
  }
  const m = monitors.get(pid);
  if (!m) return sendJson(res, { ok: false, error: '没有这个工程：' + pid }, 404);

  const r = kind === 'run'
    ? (typeof m.startRun === 'function' ? m.startRun() : { ok: false, error: '这个工程不支持启动运行命令', status: 400 })
    : m.startBuild();

  if (!r.ok) return sendJson(res, { ok: false, error: r.error }, r.status || 400);
  sendJson(res, { ok: true, running: true, pid: r.pid, project: pid });
}

function handleStop(res, pid, kind) {
  const m = monitors.get(pid);
  if (!m) return sendJson(res, { ok: false, error: '没有这个工程：' + pid }, 404);
  const r = kind === 'run'
    ? (typeof m.stopRun === 'function' ? m.stopRun() : { ok: false, error: '这个工程不支持运行命令', status: 400 })
    : m.stopBuild();
  if (!r.ok) return sendJson(res, { ok: false, error: r.error }, r.status || 400);
  sendJson(res, { ok: true, stopped: true, project: pid });
}

/* ---------------- HTTP ---------------- */

/* 列出可供手机连接的局域网地址。
   一台机器上常有一堆虚拟网卡（Hyper-V 默认交换机、VMware、WSL、Docker…），
   把它们的 IP 排在后面，免得手机扫了个连不通的地址。 */
const VIRTUAL_HINT = /virtual|vmware|hyper-?v|vethernet|loopback|docker|wsl|tailscale|zerotier|bluetooth|vpn|\btap\b|\btun\b/i;

function lanAddresses(port) {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      out.push({
        ip: it.address,
        adapter: name,
        virtual: VIRTUAL_HINT.test(name),
        url: `http://${it.address}:${port}`
      });
    }
  }
  const score = (a) => (a.virtual ? 4 : 0)
    + (/^192\.168\./.test(a.ip) ? 0
      : /^10\./.test(a.ip) ? 1
        : /^172\.(1[6-9]|2\d|3[01])\./.test(a.ip) ? 2
          : /^169\.254\./.test(a.ip) ? 5 : 3);
  out.sort((x, y) => score(x) - score(y) || x.ip.localeCompare(y.ip));
  if (out.length) out[0].recommended = true;
  return out;
}

/* >>>APK-ONLY 打包分发包时整块剔除（见 bin/make-dist.js） */
/* 安卓壳 APK 是否已经打出来（有的话连接指引页直接给下载链接） */
function apkInfo() {
  const cands = ['工程监控.apk', 'app-debug.apk'].map((n) => path.join(ROOT, 'dist', n));
  for (const f of cands) {
    try {
      const st = fs.statSync(f);
      if (st.isFile()) {
        return { available: true, name: path.basename(f), size: st.size, mtime: st.mtimeMs };
      }
    } catch (_) {}
  }
  return { available: false };
}
/* <<<APK-ONLY */

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  /* ---- 编译 / 运行 触发（POST）---- */
  if (req.method === 'POST') {
    const pid = resolvePid(u.searchParams);
    if (p === '/api/build/start') return handleStart(res, pid, 'build');
    if (p === '/api/build/stop') return handleStop(res, pid, 'build');
    if (p === '/api/run/start') return handleStart(res, pid, 'run');
    if (p === '/api/run/stop') return handleStop(res, pid, 'run');
    res.writeHead(404); res.end('not found');
    return;
  }

  /* ---- 健康检查：启动器的"服务活了没"探测、连接指引页、AI 工具都用它 ---- */
  if (p === '/api/health') {
    let version = '';
    try { version = require('../package.json').version || ''; } catch (_) {}
    const first = monitors.get(defaultPid);
    const d = first.describe(cfg.match, cfg.allowBuild);
    return sendJson(res, {
      ok: true,
      name: 'dev-monitor',
      version,
      pid: process.pid,
      port: cfg.port,
      startedAt: store.startedAt,
      uptimeMs: Date.now() - store.startedAt,
      node: process.version,
      platform: process.platform,
      projectRoot: d.projectRoot,
      projectName: d.projectName,
      workspaceRoot: d.workspaceRoot,
      allowBuild: cfg.allowBuild !== false,
      // 手机该用哪个地址连 —— 连接指引页据此生成二维码
      addresses: lanAddresses(cfg.port),
      /* >>>APK-ONLY */
      apk: apkInfo(),
      /* <<<APK-ONLY */
      projects: allBriefs(),
      // 连接指引页「体检」要按工程逐条列，所以带上各自的存在性标记
      projectDetails: cfg.projects.map((p) => ({
        id: p.id, name: p.name, kind: p.kind, kindLabel: p.kindLabel,
        root: p.root, buildCmd: p.buildCmd || '', runCmd: p.runCmd || '',
        pathsPresent: p.pathsPresent
      })),
      bootErrors,
      pathsPresent: d.pathsPresent,
      notes: CFG.healthCheck(cfg),
      endpoints: {
        guide: '/guide',
        projects: '/api/projects',
        snapshot: '/api/snapshot?project=<id>',
        events: '/api/events',
        buildStart: 'POST /api/build/start?project=<id>',
        buildStop: 'POST /api/build/stop?project=<id>',
        runStart: 'POST /api/run/start?project=<id>',
        runStop: 'POST /api/run/stop?project=<id>',
        content: '/api/content?p=<whitelisted path>',
        file: '/api/file?p=<whitelisted image path>'
      }
    });
  }

  /* ---- 工程列表（切换条上的小徽标靠它更新） ---- */
  if (p === '/api/projects') {
    return sendJson(res, {
      ok: true,
      defaultProject: defaultPid,
      projects: allBriefs(),
      bootErrors
    });
  }

  /* ---- 连接指引页：桌面浏览器打开它，手机扫上面的码 ---- */
  if (p === '/guide' || p === '/guide/') {
    return serveStatic(res, path.join(WEB, 'guide.html'));
  }

  /* >>>APK-ONLY 打包分发包时整块剔除（见 bin/make-dist.js） */
  /* ---- 安卓壳 APK 下载（只在已打包时才可用；从本机 dist/ 直出） ---- */
  if (p === '/apk' || p === '/api/apk') {
    const info = apkInfo();
    if (!info.available) {
      return sendJson(res, { ok: false, error: '还没打包 APK。在电脑上运行 dist\\build_apk.bat 或打包脚本后再来。' }, 404);
    }
    const file = ['工程监控.apk', 'app-debug.apk']
      .map((n) => path.join(ROOT, 'dist', n)).find(CFG.isFile);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': info.size,
      // 文件名用 ASCII：HTTP 头里塞中文名各家浏览器处理不一致
      'Content-Disposition': 'attachment; filename="dev-monitor.apk"'
    });
    return fs.createReadStream(file).pipe(res);
  }
  /* <<<APK-ONLY */

  if (p === '/api/snapshot') {
    const pid = resolvePid(u.searchParams);
    const m = monitors.get(pid);
    const snap = m.snapshot();
    return sendJson(res, {
      ok: true,
      now: Date.now(),
      startedAt: store.startedAt,
      project: pid,
      projects: allBriefs(),
      config: m.describe(cfg.match, cfg.allowBuild),
      build: snap.build,
      buildRunner: snap.buildRunner,
      ueLog: snap.ueLog,
      suite: snap.suite,
      artifacts: snap.artifacts,
      run: snap.run || { canRun: false, running: false }
    });
  }

  if (p === '/api/build/output') {
    const m = monitors.get(resolvePid(u.searchParams));
    const st = m.buildRunner.state();
    return sendJson(res, { ok: true, ...st, procLines: st.lines });
  }

  if (p === '/api/events') {
    const since = Number(u.searchParams.get('since') || 0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    // 补发连接期间漏掉的事件
    for (const ev of store.events) {
      if (ev.seq > since) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (p === '/api/file') {
    const fp = resolveWhitelisted(u.searchParams.get('p'));
    if (!fp) return sendJson(res, { ok: false, error: 'not allowed' }, 403);
    return serveStatic(res, fp);
  }

  if (p === '/api/content') {
    const fp = resolveContentWhitelisted(u.searchParams.get('p'));
    if (!fp) return sendJson(res, { ok: false, error: 'not allowed' }, 403);
    return serveArtifactContent(res, fp);
  }

  // 静态资源
  let rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const fp = path.normalize(path.join(WEB, rel));
  if (!fp.startsWith(WEB)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  return serveStatic(res, fp);
});

/* ---------------- 启动 ---------------- */

server.listen(cfg.port, cfg.host, () => {
  const ips = lanAddresses(cfg.port);
  console.log('');
  console.log('  工程监控服务已启动（监控只读 + 编译触发）');
  console.log('  ---------------------------------------------------');
  console.log(`  本机访问   : http://127.0.0.1:${cfg.port}`);
  for (const a of ips) {
    console.log(`  手机/局域网 : ${a.url}${a.recommended ? '   ← 手机优先用这个' : ''}`);
  }
  console.log(`  连接指引   : http://127.0.0.1:${cfg.port}/guide   （含二维码）`);
  console.log('  ---------------------------------------------------');
  console.log(`  监控工程   : ${cfg.projects.length} 个`);
  for (const proj of cfg.projects) {
    const m = monitors.get(proj.id);
    const mark = m ? '' : '   ❌ 适配器没起来';
    const dirMark = CFG.isDir(proj.root) ? '' : '   ❌ 目录不存在';
    console.log(`    · ${proj.name}  [${proj.kindLabel}]`);
    console.log(`        目录 ${proj.root}${dirMark}${mark}`);
    if (proj.kind === 'ue') {
      console.log(`        日志 ${proj.ue.ueLog}`);
      console.log(`        编译 ${proj.ue.buildBat}${proj.canBuild ? '' : '  （没找到，编译按钮不可用）'}`);
    } else {
      console.log(`        编译 ${proj.buildCmd || '（未配置）'}`);
      if (proj.runCmd) console.log(`        运行 ${proj.runCmd}`);
    }
  }
  for (const b of bootErrors) console.log(`    ❌ ${b.project}：${b.error}`);
  console.log('  ---------------------------------------------------');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});
