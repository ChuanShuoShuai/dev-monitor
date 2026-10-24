/* 小程序页签图标生成（零依赖，用本机 Chrome 渲染 SVG 后截图）
   ============================================================
   页签只认 png，运行时改不了颜色 —— 所以每个页签两张图：常态 / 选中。
   这里用同一份 24×24 路径渲染两次，保证两张图完全同形。

   配色对齐 web/index.html 的底部导航：
     · 常态 —— 网页是 rgba(255,255,255,.62) 的 currentColor，
       落在浮起来的浅色玻璃胶囊上 ≈ #C9D2E2；早期那版 #7B87A8 是给
       「不透明深色 tabBar」配的，换成玻璃胶囊后明显发闷，已废弃。
     · 选中 —— 网页 .tab.active 的 #0A84FF。

   用法：node dev-tools/miniprogram-check/icons.js
   ============================================================ */
const path = require('path');
const fs = require('fs');

const NM = 'C:/Users/t1948/.workbuddy/binaries/node/workspace/node_modules';
const { chromium } = require(path.join(NM, 'playwright-core'));

const OUT = path.join(__dirname, '..', '..', 'miniprogram', 'images');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const SIZE = 81;
const OFF = '#C9D2E2';
const ON = '#0A84FF';

/* 24×24 坐标系里的实心图形，路径与 web/index.html 的内联 svg 完全一致 */
const ICONS = {
  build: '<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>',
  run: '<path d="M8 5v14l11-7z"/>',
  suite: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>',
  art: '<path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>',
  // 档案：带盖的归档箱（网页没有这个页签，按同一套口径自己画）
  arch:
    '<rect x="4.5" y="3.2" width="15" height="3.4" rx="1.2"/>' +
    '<rect x="5.8" y="8.2" width="12.4" height="12.6" rx="1.9"/>'
};

function html(paths, color) {
  return `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block;width:${SIZE}px;height:${SIZE}px}
</style>
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="${color}">${paths}</svg>`;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  for (const [name, paths] of Object.entries(ICONS)) {
    for (const [suffix, color] of [['', OFF], ['-on', ON]]) {
      await page.setContent(html(paths, color), { waitUntil: 'load' });
      const file = path.join(OUT, 'tab-' + name + suffix + '.png');
      await page.screenshot({ path: file, omitBackground: true });
      console.log('写出', path.relative(path.join(__dirname, '..', '..'), file), fs.statSync(file).size + ' B');
    }
  }
  await browser.close();
})();
