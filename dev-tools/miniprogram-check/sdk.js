/* 重建 miniprogram_npm（命令行版「构建 npm」）
   ============================================================
   微信开发者工具的「构建 npm」必须在 GUI 里点，CI / 无头环境跑不了；它的实际动作很简单：
   对每个 dependencies，把包里 `miniprogram` 字段指向的目录（没有就用包根）整体拷到
   miniprogram_npm/<包名>/ 下。

   本项目只有 @tencent-ai/workbuddy-cloud-sdk 一个依赖，且它声明了 "miniprogram": "miniprogram_dist"，
   而 miniprogram_dist/miniprogram.js 是**自包含**的（esbuild 已把依赖全打进去，无外部 require），
   所以这里照官方规则拷一份就等价于构建结果。

   什么时候要重跑：
     · 升级 SDK（改 package.json 版本 → npm install → 本脚本）
     · miniprogram_npm/ 被误删
   用法：node dev-tools/miniprogram-check/sdk.js
   ============================================================ */
const fs = require('fs');
const path = require('path');

const MP = path.join(__dirname, '..', '..', 'miniprogram');
const NM = path.join(MP, 'node_modules');
const OUT = path.join(MP, 'miniprogram_npm');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name);
    const b = path.join(to, name);
    const st = fs.statSync(a);
    if (st.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(MP, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies || {});

if (!deps.length) {
  console.log('package.json 里没有 dependencies，没什么要构建的');
  process.exit(0);
}
if (!fs.existsSync(NM)) {
  console.error('先 npm install：' + NM + ' 不存在');
  process.exit(1);
}

let n = 0;
for (const name of deps) {
  const dir = path.join(NM, name);
  if (!fs.existsSync(dir)) {
    console.error('缺依赖：' + name);
    process.exit(1);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  // 和开发者工具同口径：包里的 miniprogram 字段指向源码根，没有就用包根
  const srcRoot = meta.miniprogram ? path.join(dir, meta.miniprogram) : dir;
  if (!fs.existsSync(srcRoot)) {
    console.error(name + ' 的 miniprogram 字段指向不存在的目录：' + srcRoot);
    process.exit(1);
  }
  const target = path.join(OUT, name);
  fs.rmSync(target, { recursive: true, force: true });
  copyDir(srcRoot, target);
  const entry = path.join(target, 'miniprogram.js');
  console.log('✓ ' + name + ' → miniprogram_npm/' + name +
    (fs.existsSync(entry) ? '（含 miniprogram.js，可 require("' + name + '/miniprogram")）' : ''));
  n++;
}

console.log('完成：' + n + ' 个包');
