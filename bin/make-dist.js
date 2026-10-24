'use strict';

/**
 * 打包分发包 —— 生成 dist/工程监控-便携版-v<版本>.zip
 *
 * 为什么自己写 ZIP：Node 标准库没有 zip，而 PowerShell 的 Compress-Archive
 * 对中文文件名的编码处理在历史版本上不可靠（解压出来是乱码）。
 * 这里自己写，就能明确给每个条目打上 UTF-8 标志位（通用标志 bit 11），
 * 保证「启动监控.bat」「使用说明.md」这种中文名在任何系统上都正常。
 *
 * ⚠ APK 不进包（用户明确要求）：不是"文件不带"，而是把这条能力整体裁掉 ——
 *   排除 android/ + build_apk.bat + capacitor.config.json，按 >>>APK-ONLY 标记剔除
 *   server.js 的 /apk 路由、guide.html 的下载卡片、两份文档的 APK 章节，
 *   并删掉 package.json 的 @capacitor/core 依赖。本机源码保持完整。
 *
 * 用法：
 *   node bin/make-dist.js              生成 zip
 *   node bin/make-dist.js --list       只列出会打进包的文件，不生成
 *   node bin/make-dist.js --out <路径> 指定输出文件
 *   node bin/make-dist.js --extract <目录>   把裁剪后的包内容写成目录（验证用）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const C = require('./config');
const ROOT = C.DEV_ROOT;

/* ---------------- 收集文件 ---------------- */

// 顶层直接排除（不进包）
const EXCLUDE_TOP = new Set([
  'config.json',            // 本机配置，绝不外发（别人的路径对他没用，还会覆盖向导结果）
  'config.json.oldbak',
  'runtime',                // 自动下载的便携 Node.js，几十 MB
  'node_modules',
  'dist',                   // 输出目录：分发包 zip + APK
  'android',                // ★ APK 能力：整个 Capacitor 原生壳工程
  'build_apk.bat',          // ★ APK 能力：一键打包脚本
  'capacitor.config.json',  // ★ APK 能力：App ID / webDir 配置
  'site',                   // 产品官网（对外发布物，不是工具的一部分；里面还带一份下载用 zip）
  'miniprogram',            // ★ 微信小程序端：另一个客户端，和 android/ 同理，不进便携包
  '_verify',
  '.git',
  '.idea',
  '.vscode',
  'package-lock.json'
]);

// 任意层级的排除规则（相对包根的 posix 路径）
const EXCLUDE_RE = [
  /^android\/\.gradle\//,
  /^android\/build\//,
  /^android\/app\/build\//,
  /^android\/capacitor-cordova-android-plugins\/build\//,
  /^android\/local\.properties$/,   // 里面写着本机 SDK 路径，别人用不了
  /^dev-tools\/qr-selfcheck\/qr_.*\.json$/,   // 自检中间产物，跑一次就有了
  /(^|\/)\.DS_Store$/,
  /\.log$/
];

// 额外挑出来的文件（在 dist/ 里，但不整目录打包）
// ⚠ 目前刻意留空：APK 由作者单独分发，不进分发包。
//   若将来要重新带上某个文件，在这里加 { from, as } 即可。
const EXTRA_FILES = [];

/* ---------------- 发行版裁剪：把 APK 能力整体去掉 ----------------
 *
 * 需求（用户原话）：本机这份要 APK，发出去的版本不要有 APK 相关功能。
 * 所以不是"包里不带 APK 文件"，而是要把这条能力从代码 / 页面 / 文档里整块裁掉。
 *
 * 两种机制：
 *   a) 成对标记 —— 多行片段
 *        .js        // >>>APK-ONLY  ...  // <<<APK-ONLY
 *        .md/.html  <!-- >>>APK-ONLY --> ... <!-- <<<APK-ONLY -->
 *   b) 单行规则 STRIP_LINES —— 目录树行、表格行这类没法插标记的地方
 *
 * 只在本机源码里留标记，本机运行完全不受影响（标记对解释器/渲染器都是普通注释）。
 */

const BEGIN = '>>>APK-ONLY';
const END = '<<<APK-ONLY';

// 只有这些文件允许做标记裁剪 —— 白名单而不是"全项目扫"，
// 否则打包器自己的源码（注释里提到标记）会被自己误裁。
const STRIP_TARGETS = new Set([
  'server/server.js',
  'web/guide.html',
  'README.md',
  '使用说明.md',
  'AI提示词.md'
]);

// 逐个文件的单行裁剪规则（re 命中即删掉整行；repl 存在则替换）
const STRIP_LINES = [
  // README 目录树 / 功能列表 / 接口表
  { file: 'README.md', re: /^- \*\*下载安卓 App\*\*/ },
  { file: 'README.md', re: /^\|\s*`GET \/apk`/ },
  { file: 'README.md', re: /^\u251c\u2500\u2500 build_apk\.bat/ },
  { file: 'README.md', re: /^\u251c\u2500\u2500 capacitor\.config\.json/ },
  { file: 'README.md', re: /^\u251c\u2500\u2500 dist\// },
  { file: 'README.md', re: /^\u2514\u2500\u2500 android\// },
  { file: 'README.md', re: /^\s{4}[\u251c\u2514]\u2500\u2500 (local\.properties|app\/)/ },
  { file: 'README.md', re: /^\s{8}[\u251c\u2514]\u2500\u2500 (MainActivity|ErrDialog|Glass)\.java/ },
  // android/ 整块删掉后，runtime/ 成为目录树最后一项 —— 顺手把 ├── 改成 └──
  { file: 'README.md', re: /^\u251c\u2500\u2500 runtime\//, repl: (m) => '└── runtime/' + m.slice(3) },
  // 使用说明的目录表
  { file: '使用说明.md', re: /^\| `android\/` `dist\/` \|/ },
  // AI 提示词的目录树 / 接口清单
  { file: 'AI提示词.md', re: /^\s*\u2514\u2500\u2500 android\/ dist\// },
  { file: 'AI提示词.md', re: /^\s+⚠ dist\/ 整个目录不进分发包；APK/ },
  { file: 'AI提示词.md', re: /^\s*GET\s+\/apk\s/ }
];

// 标记必须出现在**行首**（可带注释前缀），否则正文里举例提到标记名会被误判。
// 例：文档里写「（`// >>>APK-ONLY` … `// <<<APK-ONLY`）」这行是正文，不是标记。
const IS_BEGIN = (t) => /^(?:\/\*+|\/\/+|<!--)?\s*>>>APK-ONLY/.test(t);
const IS_END = (t) => /^(?:\/\*+|\/\/+|<!--)?\s*<<<APK-ONLY/.test(t);

function stripBlocks(text, rel) {
  const out = [];
  let depth = 0;
  let removed = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (IS_BEGIN(t)) { depth++; removed++; continue; }
    if (depth > 0) {
      if (IS_END(t)) depth--;
      removed++;
      continue;
    }
    out.push(line);
  }
  if (depth !== 0) throw new Error(rel + '：APK-ONLY 标记没闭合（缺少 ' + END + '）');
  return { text: out.join('\n'), removed };
}

function stripLines(text, rel) {
  const rules = STRIP_LINES.filter((r) => r.file === rel);
  if (!rules.length) return { text, removed: 0 };
  let removed = 0;
  const out = [];
  for (const line of text.split('\n')) {
    const hit = rules.find((r) => r.re.test(line));
    if (!hit) { out.push(line); continue; }
    removed++;
    if (typeof hit.repl === 'function') out.push(hit.repl(line));
    else if (typeof hit.repl === 'string') out.push(hit.repl);
  }
  return { text: out.join('\n'), removed };
}

/** package.json：发行版不该有 capacitor 依赖 */
function stripPackageJson(text, rel) {
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(rel + ' 不是合法 JSON：' + e.message); }
  let removed = 0;
  for (const k of ['dependencies', '_dependencies_note']) {
    if (k in j) { delete j[k]; removed++; }
  }
  return { text: JSON.stringify(j, null, 2) + '\n', removed };
}

const TEXT_EXT = new Set(['.js', '.html', '.md', '.json', '.css', '.bat', '.txt', '.manifest']);

/** 对收集到的文件施加裁剪，结果写回 entry.buf / entry.size */
function transform(files) {
  const report = [];
  for (const f of files) {
    const ext = path.extname(f.rel).toLowerCase() || (f.rel.endsWith('manifest.webmanifest') ? '.manifest' : '');
    const isText = TEXT_EXT.has(ext) || /\.(md|js|html|css|json|bat)$/i.test(f.rel);
    if (!isText) continue;

    const raw = fs.readFileSync(f.abs, 'utf8');
    let text = raw;
    let removed = 0;

    if (f.rel === 'package.json' && f.rel.indexOf('/') < 0) {
      const r0 = stripPackageJson(text, f.rel);
      text = r0.text; removed += r0.removed;
    }

    const r1 = STRIP_TARGETS.has(f.rel) ? stripBlocks(text, f.rel) : { text, removed: 0 };
    text = r1.text; removed += r1.removed;

    const r2 = stripLines(text, f.rel);
    text = r2.text; removed += r2.removed;

    if (removed) {
      f.buf = Buffer.from(text, 'utf8');
      f.size = f.buf.length;
      report.push({ rel: f.rel, removed });
    }
  }
  return report;
}

/** 兜底断言：发行版里不该再出现 APK 痕迹 */
const APK_LEAK_RE = /\bapk\b|capacitor|build_apk/i;
const LEAK_SCAN_EXT = /\.(js|html|md|json|bat|css)$/i;
const LEAK_SCAN_SKIP = new Set(['bin/make-dist.js']);   // 打包器自己当然要提 APK

function findLeaks(files) {
  const leaks = [];
  for (const f of files) {
    if (LEAK_SCAN_SKIP.has(f.rel)) continue;
    if (!LEAK_SCAN_EXT.test(f.rel)) continue;
    const text = f.buf ? f.buf.toString('utf8') : fs.readFileSync(f.abs, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (APK_LEAK_RE.test(lines[i])) {
        leaks.push(f.rel + ':' + (i + 1) + '  ' + lines[i].trim().slice(0, 90));
      }
    }
  }
  return leaks;
}

function collect() {
  const out = [];

  const walk = (absDir, relDir) => {
    let names;
    try { names = fs.readdirSync(absDir); } catch (_) { return; }
    names.sort();
    for (const n of names) {
      const abs = path.join(absDir, n);
      const rel = relDir ? relDir + '/' + n : n;
      let st;
      try { st = fs.statSync(abs); } catch (_) { continue; }
      if (!relDir && EXCLUDE_TOP.has(n)) continue;
      if (EXCLUDE_RE.some((re) => re.test(rel))) continue;
      if (st.isDirectory()) { walk(abs, rel); continue; }
      if (!st.isFile()) continue;
      out.push({ abs, rel, size: st.size });
    }
  };
  walk(ROOT, '');

  // 额外文件：取第一个存在的
  for (const e of EXTRA_FILES) {
    if (fs.existsSync(e.from)) {
      if (!out.some((f) => f.rel === e.as)) {
        out.push({ abs: e.from, rel: e.as, size: fs.statSync(e.from).size });
      }
      break;
    }
  }
  return out;
}

/* ---------------- 最小 ZIP 写入 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** DOS 时间格式（ZIP 用） */
function dosDateTime(d) {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const { time, date } = dosDateTime(now);

  for (const e of entries) {
    const raw = e.buf || fs.readFileSync(e.abs);
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (raw.length > 64) {                  // 太小的文件压缩反而更大
      const def = zlib.deflateRawSync(raw, { level: 9 });
      if (def.length < raw.length) { method = 8; body = def; }
    }
    const nameBuf = Buffer.from(e.rel, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);            // 需要的版本 2.0
    local.writeUInt16LE(0x0800, 6);        // bit 11 = 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    central.push({ e, crc, method, comp: body.length, uncomp: raw.length, nameBuf, offset });
    offset += local.length + nameBuf.length + body.length;
  }

  const cdStart = offset;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014B50, 0);
    h.writeUInt16LE(20, 4);                // made by
    h.writeUInt16LE(20, 6);                // needed
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(time, 12);
    h.writeUInt16LE(date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.comp, 20);
    h.writeUInt32LE(c.uncomp, 24);
    h.writeUInt16LE(c.nameBuf.length, 28);
    h.writeUInt16LE(0, 30);                // extra
    h.writeUInt16LE(0, 32);                // comment
    h.writeUInt16LE(0, 34);                // disk
    h.writeUInt16LE(0, 36);                // internal attr
    h.writeUInt32LE(0x20, 38);             // external attr: FILE_ATTRIBUTE_ARCHIVE
    h.writeUInt32LE(c.offset, 42);
    chunks.push(h, c.nameBuf);
    offset += h.length + c.nameBuf.length;
  }

  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

/* ---------------- 主流程 ---------------- */

function human(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const outIdx = args.indexOf('--out');
  const extractIdx = args.indexOf('--extract');

  let version = '1.0.0';
  try { version = require('../package.json').version || version; } catch (_) {}

  const files = collect();
  const stripped = transform(files);
  const totalRaw = files.reduce((s, f) => s + f.size, 0);

  console.log('');
  console.log('  打包分发包');
  console.log('  ' + '─'.repeat(58));
  console.log('  版本        v' + version);
  console.log('  文件数      ' + files.length);
  console.log('  原始大小    ' + human(totalRaw));
  if (stripped.length) {
    const sum = stripped.reduce((s, r) => s + r.removed, 0);
    console.log('  已裁剪      ' + stripped.length + ' 个文件的 ' + sum + ' 处 APK 片段');
    for (const r of stripped) console.log('                - ' + r.rel + '（' + r.removed + '）');
  }
  console.log('  ' + '─'.repeat(58));

  if (listOnly) {
    for (const f of files) console.log('  ' + f.rel.padEnd(52) + human(f.size).padStart(9));
    console.log('');
    return;
  }

  /* 兜底断言 1：包里不该有 .apk 文件 */
  const apkFiles = files.filter((f) => /\.apk$/i.test(f.rel));
  /* 兜底断言 2：包里不该有 APK / capacitor 痕迹（docs、前端、后端、配置）*/
  const leaks = findLeaks(files);
  if (apkFiles.length || leaks.length) {
    console.error('');
    console.error('  ✗ 发行版里还有 APK 相关残留，拒绝出包：');
    for (const f of apkFiles) console.error('    [文件] ' + f.rel);
    for (const l of leaks) console.error('    [残留] ' + l);
    console.error('');
    console.error('  修法：把新增的 APK 专属代码/文档用成对标记圈起来');
    console.error('        （// >>>APK-ONLY … // <<<APK-ONLY，md/html 用 <!-- -->）');
    console.error('        或加进 bin/make-dist.js 的 STRIP_LINES / EXCLUDE_TOP。');
    console.error('');
    process.exitCode = 1;
    return;
  }

  /* --extract：把「裁剪后的包内容」原样写到目录里，便于 node --check / 起服务验证 */
  if (extractIdx >= 0) {
    const dir = path.resolve(args[extractIdx + 1]);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const f of files) {
      const dst = path.join(dir, f.rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, f.buf || fs.readFileSync(f.abs));
    }
    console.log('  已导出      ' + dir + '（裁剪后，未压缩）');
    console.log('');
    return;
  }

  const zip = buildZip(files);
  const outFile = outIdx >= 0
    ? path.resolve(args[outIdx + 1])
    : path.join(ROOT, 'dist', '工程监控-便携版-v' + version + '.zip');

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, zip);

  console.log('  输出文件    ' + outFile);
  console.log('  压缩后      ' + human(zip.length));
  console.log('  含 APK      否（发行版不含任何 APK 相关文件与功能）');
  console.log('  ' + '─'.repeat(58));
  // 官网目录里同步一份同名的下载包，避免站点上的下载链接指到旧版本
  const siteDir = path.join(ROOT, 'site');
  if (fs.existsSync(siteDir)) {
    try {
      fs.copyFileSync(outFile, path.join(siteDir, path.basename(outFile)));
      console.log('  官网下载源  site/' + path.basename(outFile));
    } catch (e) {
      console.log('  ⚠ 同步到 site/ 失败：' + e.message);
    }
  }

  console.log('  对方拿到 zip 后：解压 → 放进自己的工程里 → 双击「启动监控.bat」');
  console.log('  包里不含 config.json / runtime/ / dist/ / android/ / site/，是干净的。');
  console.log('');
}

main();
