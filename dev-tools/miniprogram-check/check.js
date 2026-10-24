/* 小程序端静态 + 逻辑自检（零依赖，直接 node 跑）
   ============================================================
   微信开发者工具没法在 CI / 命令行里跑，所以这里用「假装自己是小程序运行时」的办法：
   把 App / Page / getApp / wx 全部打桩，把每个页面的 js 真跑一遍，
   再拿一份**真实的 /api/snapshot** 灌进去，看视图模型对不对。

   它能抓到的（都是手写 WXML/JS 最容易漏的）：
     ① JSON 语法错、页面四件套缺文件、tabBar 图标丢了
     ② bindtap 指向的函数根本不存在（拼写错、改名忘了同步）
     ③ render() 里读了不存在的字段 → 运行时报错
     ④ 用了系统弹窗（wx.showModal / showToast / showActionSheet）
        —— 本项目要求自绘，出现了直接判失败
     ⑤ WXML 标签不配对、WXSS 大括号不配对
     ⑥ 发布体检：页面目录撞上打包器的目录黑名单（build / dist / out…）
        —— 本地一切正常，上传时却报「app.json 找不到对应文件」，2026-10-21 就栽在这

   用法：node dev-tools/miniprogram-check/check.js
        （服务没起也能跑：快照会退回同目录的 snapshot.json）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const http = require('http');

const MP = path.join(__dirname, '..', '..', 'miniprogram');
const FIXTURE = path.join(__dirname, 'snapshot.json');

let pass = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) return pass++;
  bad.push(name + (extra ? ' → ' + extra : ''));
}

/* ---------------- 1. 结构检查 ---------------- */

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const appJson = readJson(path.join(MP, 'app.json'));
ok('app.json 有 pages', Array.isArray(appJson.pages) && appJson.pages.length >= 4, JSON.stringify(appJson.pages));

for (const pf of fs.readdirSync(MP).filter((f) => f.endsWith('.json'))) {
  try {
    readJson(path.join(MP, pf));
    ok('JSON 可解析: ' + pf, true);
  } catch (e) {
    ok('JSON 可解析: ' + pf, false, e.message);
  }
}

for (const page of appJson.pages) {
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    const f = path.join(MP, page + ext);
    ok('页面文件存在: ' + page + ext, fs.existsSync(f));
  }
}

for (const t of (appJson.tabBar && appJson.tabBar.list) || []) {
  ok('tabBar 图标存在: ' + t.iconPath, fs.existsSync(path.join(MP, t.iconPath)));
  ok('tabBar 选中图标存在: ' + t.selectedIconPath, fs.existsSync(path.join(MP, t.selectedIconPath)));
  ok('tabBar 页面已注册: ' + t.pagePath, appJson.pages.indexOf(t.pagePath) >= 0);
}

/* ---------------- 1b. 自定义页签组件 ----------------
   底部那枚浮动玻璃胶囊是自绘的：app.json 里必须 custom:true，
   组件四件套必须齐，且每个 tab 页都要在 onShow 里把滑块挪到自己的位置
   （漏一个 ⇒ 切过去时高亮还停在上一个页签）。 */
ok('tabBar 已切换为自定义', appJson.tabBar && appJson.tabBar.custom === true);
for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
  ok('页签组件文件存在: index' + ext, fs.existsSync(path.join(MP, 'custom-tab-bar', 'index' + ext)));
}
{
  const compJs = fs.readFileSync(path.join(MP, 'custom-tab-bar', 'index.js'), 'utf8');
  const compJson = readJson(path.join(MP, 'custom-tab-bar', 'index.json'));
  ok('页签组件声明 component: true', compJson.component === true);
  ok('页签数量与 tabBar.list 一致',
    (compJs.match(/\btext:\s*'/g) || []).length === (appJson.tabBar.list || []).length,
    (compJs.match(/\btext:\s*'/g) || []).length + ' vs ' + (appJson.tabBar.list || []).length);
  ok('页签图标与 tabBar 登记一致',
    (appJson.tabBar.list || []).every((t) => compJs.indexOf('/' + t.iconPath) >= 0 && compJs.indexOf('/' + t.selectedIconPath) >= 0));
  for (const t of appJson.tabBar.list || []) {
    const js = fs.readFileSync(path.join(MP, t.pagePath + '.js'), 'utf8');
    ok('页签选中态回写: ' + t.pagePath, /syncTab\s*\(\s*this\s*,/.test(js));
  }
}

/* ---------------- 2. WXSS 括号 / WXML 标签 ---------------- */

// 只列「小程序里必须自闭合、写了 <x> 也不该等 </x>」的标签。
// ⚠ image 不在里面：本项目写的是 <image ...></image>，列进来会把闭合判错。
const VOID = new Set(['input', 'import', 'include', 'wxs']);

function walk(dir, out) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(MP, []);

for (const f of files.filter((x) => x.endsWith('.wxss'))) {
  const s = fs.readFileSync(f, 'utf8');
  let depth = 0;
  let broke = false;
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) broke = true;
    }
  }
  ok('WXSS 括号配对: ' + path.relative(MP, f), !broke && depth === 0, 'depth=' + depth);
}

function checkWxml(file) {
  const s = fs.readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\{[\s\S]*?\}\}/g, 'X');
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    const [, close, tag, attrs, selfClose] = m;
    if (close) {
      const top = stack.pop();
      if (top !== tag) return '闭合不匹配：</' + tag + '> 遇到 <' + top + '>';
    } else if (!selfClose && !VOID.has(tag)) {
      stack.push(tag);
    }
  }
  return stack.length ? '未闭合：<' + stack.join('> <') + '>' : '';
}

for (const f of files.filter((x) => x.endsWith('.wxml'))) {
  const err = checkWxml(f);
  ok('WXML 标签配对: ' + path.relative(MP, f), !err, err);
}

/* ---------------- 3. 运行时打桩 ---------------- */

const store = {};
const requests = [];
let snapshot = null;
let health = null;

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

const timers = [];
global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => {
    store[k] = v;
  },
  request(opt) {
    requests.push(opt.url);
    setImmediate(() => {
      const u = opt.url;
      // 自检绝不真的打云服务网关：一旦发出去就是一次真请求（还会被网关判成未签名）
      if (u.indexOf('/.cloud/') >= 0) return opt.fail({ errMsg: 'request:fail 自检不打真实云服务' });
      if (/\/api\/snapshot/.test(u)) return opt.success({ statusCode: 200, data: snapshot });
      if (/\/api\/health/.test(u)) return opt.success({ statusCode: 200, data: health });
      if (/\/api\/projects/.test(u)) return opt.success({ statusCode: 200, data: { ok: true, projects: snapshot.projects } });
      if (/\/api\/content/.test(u)) return opt.success({ statusCode: 200, data: { ok: true, name: 'x.log', size: 12, mtimeText: '2026-10-21 15:00:00', binary: false, truncated: false, content: 'line1\nline2' } });
      return opt.success({ statusCode: 200, data: { ok: true } });
    });
  },
  showLoading() {},
  hideLoading() {},
  vibrateShort() {},
  navigateTo() {},
  setNavigationBarTitle() {},
  setClipboardData(o) {
    if (o && o.success) o.success();
  },
  previewImage() {},
  /* utils/img.js 走 downloadFile：这里给一个「成功」的桩，好断言缩略图真的被填了地址 */
  downloadFile(o) {
    setImmediate(() => o.success({ statusCode: 200, tempFilePath: 'wxfile://tmp/preview-' + String(o.url).slice(-12) }));
  },
  saveImageToPhotosAlbum() {},
  getWindowInfo() {
    return { windowWidth: 375, windowHeight: 812, screenHeight: 812, safeArea: { top: 44, bottom: 778 } };
  },
  /* run.js 的 fitLog()：给固定几何，断言算出来的高度合理（>0 且不超出视口） */
  createSelectorQuery() {
    const q = {
      select() { return q; },
      selectViewport() { return q; },
      boundingClientRect() { return q; },
      scrollOffset() { return q; },
      exec(cb) {
        cb([{ top: 210, bottom: 710, height: 500, left: 0, right: 375, width: 375 }, { scrollTop: 0 }]);
      }
    };
    return q;
  },
  navigateBack() {},
  getAccountInfoSync() {
    return { miniProgram: { appId: 'wxcheck0000000000' } };
  }
};

let appInst = null;
let lastPage = null;
global.App = (def) => {
  appInst = def;
  if (def.onLaunch) def.onLaunch.call(def);
};
global.getApp = () => appInst;
global.Page = (def) => {
  lastPage = def;
};
global.setInterval = (fn, ms) => {
  const t = { fn, ms, cleared: false };
  timers.push(t);
  return t;
};
global.clearInterval = (t) => {
  if (t) t.cleared = true;
};

/* ---------------- 4. 逐个页面跑一遍 ---------------- */

/* 真机的 setData 支持 'rows[3].src' 这种路径写法，Object.assign 只会造出一个
   名字叫 "rows[3].src" 的字段 —— 不还原路径语法，逐行的增量更新就测不到 */
function applyPatch(data, patch) {
  for (const k of Object.keys(patch)) {
    const m = /^([A-Za-z0-9_$]+)\[(\d+)\]\.([A-Za-z0-9_$]+)$/.exec(k);
    if (m && Array.isArray(data[m[1]]) && data[m[1]][Number(m[2])]) {
      data[m[1]][Number(m[2])][m[3]] = patch[k];
    } else {
      data[k] = patch[k];
    }
  }
}

function makePage(pagePath, query) {
  const file = path.join(MP, pagePath + '.js');
  delete require.cache[require.resolve(file)];
  require(file);
  const def = lastPage;
  const inst = Object.create(null);
  Object.assign(inst, def);
  inst.data = JSON.parse(JSON.stringify(def.data || {}));
  inst.setData = function (patch, cb) {
    applyPatch(this.data, patch);
    /* 真机的 setData 是异步的，回调在视图更新之后 —— 页面里用回调做的事
       （产物页下载缩略图、运行页重量高度）也必须跑到，否则测不到 */
    if (typeof cb === 'function') setImmediate(cb);
  };
  if (inst.onLoad) inst.onLoad.call(inst, query || {});
  if (inst.onShow) inst.onShow.call(inst);
  return inst;
}

/* bindtap="xxx" 里的函数必须真的存在 —— 手写 WXML 最常见的错就是改名没同步 */
function checkHandlers(pagePath, inst) {
  const wxml = fs.readFileSync(path.join(MP, pagePath + '.wxml'), 'utf8');
  const re = /(?:bind|catch):?([a-z]+)="([A-Za-z_$][\w$]*)"/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(wxml))) {
    const fn = m[2];
    if (seen.has(fn)) continue;
    seen.add(fn);
    ok(path.basename(pagePath) + ' 处理函数存在: ' + fn, typeof inst[fn] === 'function');
  }
}

/* 系统弹窗一律禁止（项目要求自绘） */
for (const f of files.filter((x) => x.endsWith('.js') && !x.includes('miniprogram-check'))) {
  // 先摘掉注释再判：注释里写着「替代 wx.showToast」不算违规
  const s = fs
    .readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const m = s.match(/wx\.(showModal|showToast|showActionSheet)\s*\(/);
  if (m) ok('不用系统弹窗: ' + path.relative(MP, f), false, '发现了 wx.' + m[1]);
}

(async () => {
  snapshot = await loadSnapshot();
  if (!snapshot) {
    if (fs.existsSync(FIXTURE)) snapshot = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  }
  ok('拿到快照（服务在跑或本地 fixture）', !!snapshot);
  if (!snapshot) {
    console.log('\n没有快照，先启动监控服务再跑本脚本');
    process.exit(1);
  }

  health = {
    ok: true,
    name: 'dev-monitor',
    version: '1.3.0',
    node: 'v22.22.2',
    projectName: snapshot.config.name,
    projectRoot: snapshot.config.projectRoot,
    allowBuild: true,
    uptimeMs: 3600000,
    addresses: [
      { ip: '192.168.3.225', adapter: '以太网', virtual: false, url: 'http://192.168.3.225:8787', recommended: true }
    ],
    endpoints: {}
  };

  store.dm_base = 'http://192.168.3.225:8787';
  store.dm_project = snapshot.project;

  require(path.join(MP, 'app.js'));
  ok('app.js 载入并 onLaunch', !!appInst);
  ok('onLaunch 读回地址', appInst.globalData.base === 'http://192.168.3.225:8787', appInst.globalData.base);
  appInst.globalData.snap = snapshot;

  /* ---- 编译页 ---- */
  {
    const p = makePage('pages/compile/compile');
    checkHandlers('pages/compile/compile', p);
    const b = snapshot.build;
    ok('build: 徽标', p.data.badge === (/fail/i.test(b.result || '') ? '编译失败' : '编译完成'), p.data.badge);
    ok('build: 日志行数', p.data.lines.length === b.lines.length, p.data.lines.length + ' vs ' + b.lines.length);
    ok('build: 归档条数', p.data.archives.length === b.archives.length, p.data.archives.length + ' vs ' + b.archives.length);
    ok('build: 进度 100%', p.data.percent === 100, String(p.data.percent));
    // 右上角计时器跟网页一样是「67.24 s」——英文 s、两位小数（正文标题才是「· 67.24 秒」）
    ok('build: 计时器单位 s', /^\d+\.\d{2} s$/.test(p.data.secText), p.data.secText);
    // 工程名不再单独存一份：切换条直接从快照的 projects 生成
    ok('build: 工程胶囊条', p.data.projects.length === (snapshot.projects || []).length
      && p.data.projects.filter((x) => x.on).length === 1, JSON.stringify(p.data.projects.map((x) => x.name)));
    ok('build: 归档有体积/时间', !p.data.archives.length || (!!p.data.archives[0].sizeText && !!p.data.archives[0].timeText), JSON.stringify(p.data.archives[0] || {}));
    if (p.onHide) p.onHide();

    // 从 running 变 done 要弹一次横幅，且换工程/首屏不弹
    const q = makePage('pages/compile/compile');
    appInst.globalData.snap = Object.assign({}, snapshot, { build: Object.assign({}, b, { status: 'running', result: null, seconds: null }) });
    q.render(appInst.globalData);
    ok('build: 运行中不弹横幅', !q.data.doneTip);
    // 跑起来还没出数：计时器是省略号（网页 `st === 'running' ? '…' : '--'`）
    ok('build: 运行中计时器 …', q.data.secText === '…', q.data.secText);
    appInst.globalData.snap = snapshot;
    q.render(appInst.globalData);
    ok('build: 结束弹一次横幅', !!q.data.doneTip && q.data.doneTip.ok === true, JSON.stringify(q.data.doneTip));
    q.render(appInst.globalData);
    ok('build: 横幅不重复弹', q.data.doneTip && q.data.doneTip.title === (b.result && /fail/i.test(b.result) ? '编译失败' : '编译成功'));
    if (q.onHide) q.onHide();
    appInst.globalData.snap = snapshot;
  }

  /* ---- 运行页 ---- */
  {
    const p = makePage('pages/run/run');
    checkHandlers('pages/run/run', p);
    ok('run: 四个筛选', p.data.chips.length === 4, JSON.stringify(p.data.chips.map((c) => c.key)));
    // 胶囊上不带计数：网页也没有；带上去会把「警告 / 错误」挤得换行，四枚就不在一排了
    ok('run: 筛选不带计数', p.data.chips.every((c) => !('n' in c)), JSON.stringify(p.data.chips));
    ok('run: 行数 = 全部日志', p.data.rows.length === Math.min(200, snapshot.ueLog.lines.length), String(p.data.rows.length));
    ok('run: 行有分类/文本', !p.data.rows.length || (!!p.data.rows[0].cat && typeof p.data.rows[0].text === 'string'), JSON.stringify(p.data.rows[0] || {}));
    // 切到「警告 / 错误」应只剩告警
    p.pickFilter({ currentTarget: { dataset: { k: 'alert' } } });
    const alertN = snapshot.ueLog.lines.filter((l) => /^(Error|Fatal|Warning)$/.test(l.verbosity || '')).slice(-200).length;
    ok('run: 警告筛选', p.data.rows.length === alertN, p.data.rows.length + ' vs ' + alertN);
    if (p.onHide) p.onHide();
  }

  /* ---- 自检页 ---- */
  {
    const p = makePage('pages/suite/suite');
    checkHandlers('pages/suite/suite', p);
    const items = snapshot.suite.items;
    ok('suite: 条目数', p.data.items.length === items.length, p.data.items.length + ' vs ' + items.length);
    ok('suite: 通过数', p.data.pass === items.filter((i) => i.pass === true).length, String(p.data.pass));
    ok('suite: 未跑不当失败', p.data.unk === items.filter((i) => i.pass == null).length, String(p.data.unk));
    if (p.onHide) p.onHide();
  }

  /* ---- 产物页 ---- */
  {
    const p = makePage('pages/art/art');
    checkHandlers('pages/art/art', p);
    const imgs = snapshot.artifacts.items;
    ok('art: 行数', p.data.rows.length === imgs.length, p.data.rows.length + ' vs ' + imgs.length);
    ok('art: chips = 分组数 + 全部', p.data.chips.length === new Set(imgs.map((i) => i.group)).size + 1, String(p.data.chips.length));
    ok('art: chips 不带计数', p.data.chips.every((c) => !('n' in c)), JSON.stringify(p.data.chips));
    const shot = p.data.rows.find((r) => r.shot);
    // 只有截图占缩略图位；非图片行跟网页一样不占（否则行高 41 → 63，整列密度差一档）
    ok('art: 只有截图分组占缩略图位', p.data.rows.every((r) => r.shot === (r.group === '截图')),
      JSON.stringify(p.data.rows.filter((r) => r.shot !== (r.group === '截图')).slice(0, 2)));
    await new Promise((r) => setTimeout(r, 40));
    // 缩略图不能再把 http 地址直接喂给 <image>：先 downloadFile 成本地文件（见 utils/img.js）
    ok('art: 缩略图下载成本地文件', !!shot && p.data.rows.filter((r) => r.shot).every((r) => /^wxfile:\/\//.test(r.src)),
      JSON.stringify(p.data.rows.filter((r) => r.shot).map((r) => r.src).slice(0, 2)));
    if (p.onHide) p.onHide();
  }

  /* ---- 详情页 ---- */
  {
    const p = makePage('pages/detail/detail', { type: 'text', name: encodeURIComponent('a.log'), p: encodeURIComponent('E:/tmp/a.log') });
    await new Promise((r) => setTimeout(r, 30));
    ok('detail: 文本加载', p.data.text === 'line1\nline2', JSON.stringify(p.data.text));
    ok('detail: 标题去编码', p.data.name === 'a.log', p.data.name);

    const q = makePage('pages/detail/detail', { type: 'img', name: 'a.png', p: encodeURIComponent('E:/tmp/a.png') });
    await new Promise((r) => setTimeout(r, 40));
    ok('detail: 图片地址', /\/api\/file\?p=/.test(q.data.imgUrl), q.data.imgUrl);
    ok('detail: 图片已下载成本地文件', /^wxfile:\/\//.test(q.data.img), q.data.img);
    ok('detail: 图片加载成功后没有报错', !q.data.err, q.data.err);
  }

  /* ---- 设置页 ---- */
  {
    const p = makePage('pages/setup/setup');
    checkHandlers('pages/setup/setup', p);
    await new Promise((r) => setTimeout(r, 60));
    ok('setup: 自动体检', !!p.data.health && p.data.ok === true, p.data.msg);
    ok('setup: 地址列表', p.data.addrs.length === 1 && p.data.addrs[0].current === true, JSON.stringify(p.data.addrs));
    ok('setup: 工程列表', p.data.projects.length === snapshot.projects.length, String(p.data.projects.length));
  }

  /* ---- 云服务：真 SDK（wx 打桩）+ buildrec 映射 ---- */
  {
    const cloudPath = require.resolve(path.join(MP, 'utils', 'cloud.js'));
    const cloudMod = require(cloudPath);

    ok('cloud: endpoint 来自 publicConfig', cloudMod.PUBLIC_CONFIG.endpoint === 'https://mp-api.app.workbuddy.host', cloudMod.PUBLIC_CONFIG.endpoint);
    ok('cloud: publishableKey 是 wbpk_ 前缀', /^wbpk_/.test(cloudMod.PUBLIC_CONFIG.publishableKey));
    ok('cloud: 客户端四模块齐全', !!(cloudMod.cloud && cloudMod.cloud.auth && cloudMod.cloud.database && cloudMod.cloud.storage && cloudMod.cloud.llm));

    const sess = await cloudMod.session();
    ok('cloud: 未登录时 session 为 null', sess === null, String(sess));
    ok('cloud: 未登录写库给可读错误', /登录/.test(await cloudMod.addBuild({ key: 'x' }).then(() => '（没报错）', (e) => e.message)));
    ok('cloud: 邮箱格式本地先拦', (await cloudMod.sendCode('nope').then(() => '', (e) => e.message)) === '邮箱格式不对');
    ok('cloud: 网络错误翻中文', /网络/.test(cloudMod.friendly({ kind: 'network' })), cloudMod.friendly({ kind: 'network' }));
    ok('cloud: RLS 拒绝翻中文', /权限/.test(cloudMod.friendly({ code: '42501' })), cloudMod.friendly({ code: '42501' }));

    const rec = require(path.join(MP, 'utils', 'buildrec.js'));
    const arcN = (snapshot.build.archives || []).length;
    const mapped = rec.fromSnapshot(snapshot);
    ok('buildrec: 一条归档一条记录', mapped.length === arcN, mapped.length + ' vs ' + arcN);
    ok('buildrec: key 只由 工程+归档名 决定', rec.keyOf('p', 'a.log') === 'arc:p:a.log', rec.keyOf('p', 'a.log'));
    ok('buildrec: 同一归档两次映射 key 一致', !mapped.length || mapped[0].key === rec.fromSnapshot(snapshot)[0].key);
    ok('buildrec: 记录带可解析的时间', !mapped.length || !isNaN(Date.parse(mapped[0].finishedAt)), mapped.length ? mapped[0].finishedAt : '');
  }

  /* ---- 云档案页：把 cloud 模块换成假的，验视图模型（真模块上面已经验过）---- */
  {
    const cloudPath = require.resolve(path.join(MP, 'utils', 'cloud.js'));
    const realCloud = require.cache[cloudPath];
    const calls = { backfill: 0, del: 0, clear: 0 };
    let rows = [
      { id: 3, build_key: 'arc:p:a3.log', project_id: 'p', project_name: 'CursorAdventure', result: 'Succeeded', seconds: 60, error_count: 0, warn_count: 4, summary: 'WriteMetadata', finished_at: '2026-10-21T06:14:49.051Z' },
      { id: 2, build_key: 'arc:p:a2.log', project_id: 'p', project_name: 'CursorAdventure', result: 'Failed', seconds: 30, error_count: 2, warn_count: 1, summary: 'Compile', finished_at: '2026-10-20T06:14:49.051Z' }
    ];
    const install = (sess) => {
      require.cache[cloudPath] = {
        id: cloudPath,
        filename: cloudPath,
        loaded: true,
        children: [],
        paths: [],
        exports: {
          session: () => Promise.resolve(sess),
          who: () => 'de***@example.com',
          listBuilds: () => Promise.resolve(rows.slice()),
          addBuilds: () => {
            calls.backfill++;
            return Promise.resolve(0);
          },
          deleteBuild: () => {
            calls.del++;
            return Promise.resolve(1);
          },
          clearBuilds: () => {
            calls.clear++;
            return Promise.resolve(2);
          },
          signOut: () => Promise.resolve()
        }
      };
    };

    install({ user: { email: 'dev@example.com' } });
    const p = makePage('pages/archive/archive');
    checkHandlers('pages/archive/archive', p);
    await new Promise((r) => setTimeout(r, 50));
    ok('archive: 已登录', p.data.signed === true && p.data.whoText.length > 0, p.data.whoText);
    ok('archive: 统计总数', p.data.total === rows.length, String(p.data.total));
    ok('archive: 成功/失败拆分', p.data.okN === 1 && p.data.badN === 1, p.data.okN + '/' + p.data.badN);
    ok('archive: 平均耗时', p.data.avgText === '45.00 秒', p.data.avgText);
    ok('archive: 每行都有时间/工程', p.data.rows.every((r) => r.timeText && r.projectName), JSON.stringify(p.data.rows[0] || {}));
    ok('archive: 三个筛选 chip', p.data.chips.length === 3 && p.data.chips[0].n === 2, JSON.stringify(p.data.chips.map((c) => c.key)));
    p.setFilter({ currentTarget: { dataset: { k: 'bad' } } });
    ok('archive: 只看失败', p.data.rows.length === 1 && p.data.rows[0].ok === false, String(p.data.rows.length));
    p.setFilter({ currentTarget: { dataset: { k: 'ok' } } });
    ok('archive: 只看成功', p.data.rows.length === 1 && p.data.rows[0].ok === true, String(p.data.rows.length));
    p.askClear();
    ok('archive: 清空要确认', !!p.data.ask && p.data.ask.kind === 'all');
    p.confirmAsk();
    await new Promise((r) => setTimeout(r, 40));
    ok('archive: 确认后真的清空', calls.clear === 1, String(calls.clear));
    p.askDelete({ currentTarget: { dataset: { k: p.data.rows[0].key } } });
    p.confirmAsk();
    await new Promise((r) => setTimeout(r, 40));
    ok('archive: 长按删单条', calls.del === 1, String(calls.del));

    // 云端是空的 → 自动把电脑上现成的归档补上来
    rows = [];
    install({ user: { email: 'dev@example.com' } });
    makePage('pages/archive/archive');
    await new Promise((r) => setTimeout(r, 70));
    ok('archive: 云端空 → 自动补录', calls.backfill >= 1, String(calls.backfill));

    // 未登录：给登录入口，不报错
    install(null);
    const u = makePage('pages/archive/archive');
    await new Promise((r) => setTimeout(r, 40));
    ok('archive: 未登录显示登录入口', u.data.signed === false && u.data.rows.length === 0);

    require.cache[cloudPath] = realCloud;
  }

  /* ---- 登录页 ---- */
  {
    const p = makePage('pages/login/login');
    checkHandlers('pages/login/login', p);
    p.onEmail({ detail: { value: 'bad' } });
    p.send();
    ok('login: 邮箱不合法不进网络', p.data.msg === '先填一个正确的邮箱地址', p.data.msg);
    p.submit();
    ok('login: 没发码就提交要拦', /获取验证码/.test(p.data.msg), p.data.msg);

    p.onEmail({ detail: { value: 'dev@example.com' } });
    p.onCode({ detail: { value: '123456' } });
    p.send();
    await new Promise((r) => setTimeout(r, 150));
    ok('login: 发码失败有明确提示（不假装已发送）', p.data.sent === false && !!p.data.msg, p.data.msg);
    if (p.onUnload) p.onUnload();
  }

  /* ---- 归档变更 → 云端上报：基线不推、变化才推、未登录不推 ---- */
  {
    const cloudPath = require.resolve(path.join(MP, 'utils', 'cloud.js'));
    const cloudMod = require(cloudPath);
    const realSession = cloudMod.session;
    const realAdd = cloudMod.addBuild;

    if (!snapshot.build.archives || !snapshot.build.archives.length) {
      snapshot.build.archives = [
        { name: 'build_20260101_000000.log', result: 'Succeeded', seconds: 1, errors: 0, mtime: 1767225600000, mtimeText: '2026-01-01T00:00:00.000Z', progress: { label: 'seed' } }
      ];
    }

    cloudMod.session = () => Promise.resolve({ user: { email: 'a@b.com' } });
    let pushed = 0;
    cloudMod.addBuild = () => {
      pushed++;
      return Promise.resolve(1);
    };

    appInst._archSig = '';
    appInst._watchArchives(snapshot);
    await new Promise((r) => setTimeout(r, 40));
    ok('app: 启动首帧只当基线不补历史', pushed === 0, String(pushed));

    const snap2 = JSON.parse(JSON.stringify(snapshot));
    snap2.build.archives.unshift({
      name: 'build_29990101_000000.log',
      result: 'Succeeded',
      seconds: 12.5,
      errors: 0,
      mtime: 4070908800000,
      mtimeText: '2099-01-01T00:00:00.000Z',
      progress: { label: 'X' }
    });
    appInst._watchArchives(snap2);
    await new Promise((r) => setTimeout(r, 40));
    ok('app: 新归档推一条', pushed === 1, String(pushed));

    appInst._watchArchives(snap2);
    await new Promise((r) => setTimeout(r, 40));
    ok('app: 同一归档不重复推', pushed === 1, String(pushed));

    cloudMod.session = () => Promise.resolve(null);
    snap2.build.archives.unshift(Object.assign({}, snap2.build.archives[0], { name: 'build_29990101_000001.log' }));
    appInst._watchArchives(snap2);
    await new Promise((r) => setTimeout(r, 40));
    ok('app: 未登录不推', pushed === 1, String(pushed));

    cloudMod.session = realSession;
    cloudMod.addBuild = realAdd;
    appInst._archSig = '';
  }

  /* ---------------- 8. 发布体检（模拟打包器的目录黑名单） ---------------- */
  {
    /* 打包器（WorkBuddy 的 createMiniprogramZip）会跳过下面这些目录，大小写不敏感。
       页面目录一旦撞名，app.json 里还写着它、压缩包里却没有 ⇒
       上传时微信只回一句「app.json: ["pages"][0] could not find the corresponding file」。
       2026-10-21 的「一直发布失败」就是这么来的：首个页面原本叫 pages/build/。 */
    const PACK_SKIP = ['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'tmp', 'temp'];
    const pageDirs = appJson.pages.map((p) => p.split('/').slice(0, -1).join('/'));
    const hitDir = pageDirs.filter((d) => d.split('/').some((seg) => PACK_SKIP.indexOf(seg.toLowerCase()) >= 0));
    ok('发布: 页面目录不撞打包黑名单', hitDir.length === 0, hitDir.join(','));

    const missing = [];
    for (const p of appJson.pages) {
      for (const ext of ['.js', '.json', '.wxml']) {
        if (!fs.existsSync(path.join(MP, p + ext))) missing.push(p + ext);
      }
    }
    ok('发布: 每个页面都有 js/json/wxml', missing.length === 0, missing.slice(0, 3).join(','));

    const tabPaths = ((appJson.tabBar && appJson.tabBar.list) || []).map((t) => t.pagePath);
    const notInPages = tabPaths.filter((t) => appJson.pages.indexOf(t) < 0);
    ok('发布: tabBar 页面都在 pages 里', notInPages.length === 0, notInPages.join(','));

    const barSrc = fs.readFileSync(path.join(MP, 'custom-tab-bar', 'index.js'), 'utf8');
    const urls = (barSrc.match(/url:\s*'(\/[^']+)'/g) || []).map((s) => s.replace(/^[^']*'\/?/, '').replace(/'$/, ''));
    const badUrls = urls.filter((u) => appJson.pages.indexOf(u) < 0);
    ok('发布: 自定义页签指向真实页面', urls.length >= 5 && badUrls.length === 0, badUrls.join(','));

    // 打包器另外卡两道闸：文件数 10000 个、源码总量 25MB
    let count = 0;
    let bytes = 0;
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const skip = PACK_SKIP.indexOf(e.name.toLowerCase()) >= 0;
        if (e.isDirectory()) {
          if (!skip && !e.name.startsWith('.')) walk(path.join(dir, e.name));
        } else if (!skip) {
          count++;
          bytes += fs.statSync(path.join(dir, e.name)).size;
        }
      }
    })(MP);
    ok('发布: 文件数在 10000 以内', count <= 10000, String(count));
    ok('发布: 源码体积在 25MB 以内', bytes <= 25 * 1024 * 1024, (bytes / 1024 / 1024).toFixed(1) + 'MB');
  }

  /* ---------------- 9. 手机适配 / 高亮 / 图片 / 切页白闪 ---------------- */
  {
    /* ① 切页白闪：新页面的原生容器先铺 backgroundColorContent，
          前端 WXSS 生效之前那一帧就是它。少一个页面就白一下。 */
    const noBg = appJson.pages.filter((p) => {
      const j = readJson(path.join(MP, p + '.json'));
      return j.backgroundColorContent !== appJson.window.backgroundColor;
    });
    ok('适配: 每页都声明了 backgroundColorContent', noBg.length === 0, noBg.join(','));
    ok('适配: app.json 有 backgroundColorContent', !!appJson.window.backgroundColorContent,
      String(appJson.window.backgroundColorContent));

    /* ② 底部留白必须叠安全区，否则 iPhone 的 home 条会把最后一行压在页签下面 */
    const appCss = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8');
    const padBlock = (appCss.match(/\.pad-b\s*\{[^}]*\}/) || [''])[0];
    ok('适配: .pad-b 含安全区', /env\(safe-area-inset-bottom\)/.test(padBlock),
      padBlock.replace(/\s+/g, ' '));

    /* ③ 运行页日志井：高度是量出来的，不是写死的 vh */
    const runJs = fs.readFileSync(path.join(MP, 'pages/run/run.js'), 'utf8');
    const runWxml = fs.readFileSync(path.join(MP, 'pages/run/run.wxml'), 'utf8');
    ok('适配: 运行页按视口实测日志高度', /fitLog\s*\(/.test(runJs) && /createSelectorQuery/.test(runJs));
    ok('适配: 运行页日志井绑定 logH', /\{\{\s*logH/.test(runWxml));
    ok('适配: 运行页不再用 .pad-b 占位', runWxml.indexOf('pad-b') < 0);
    /* 量的高度是 border-box 的：view 默认 content-box 会多出内边距高度 */
    const runCss = fs.readFileSync(path.join(MP, 'pages/run/run.wxss'), 'utf8');
    const bigLog = (runCss.match(/\.log\.big\s*\{[^}]*\}/) || [''])[0];
    ok('适配: 通栏日志是 border-box', /box-sizing:\s*border-box/.test(bigLog), bigLog.replace(/\s+/g, ' '));

    /* ④ 代码高亮：模块认得语言、输出内联颜色、转义尖括号 */
    const HL = require(path.join(MP, 'utils', 'highlight.js'));
    ok('高亮: 认得出 JSON', HL.langOf('BGMImportReport.json') === 'json');
    ok('高亮: 认得出日志', HL.langOf('build_20261021.log') === 'log');
    ok('高亮: 认得出源码', HL.langOf('AdventureScene.cpp') === 'c' && HL.langOf('X.h') === 'c');
    ok('高亮: 认不出来就纯文本', HL.langOf('shot.png') === 'text');
    const hlJson = HL.render('{"a":1,"b":true}', 'json', {});
    ok('高亮: 输出内联颜色', /<span style="color:#/.test(hlJson));
    ok('高亮: 源码里的尖括号被转义', HL.render('<script>x</script>', 'json', {}).indexOf('<script') < 0);
    ok('高亮: 长度上限存在', HL.MAX_CHARS > 0 && HL.MAX_CHARS <= 64 * 1024, String(HL.MAX_CHARS));

    const detailWxml = fs.readFileSync(path.join(MP, 'pages/detail/detail.wxml'), 'utf8');
    ok('高亮: 详情页用 rich-text 渲染', /<rich-text[^>]*nodes="\{\{rich\}\}"/.test(detailWxml));

    /* ⑤ 图片：不许再把 http 地址直接塞给 <image>（失败是静默的，什么都看不到） */
    const imgUtil = fs.readFileSync(path.join(MP, 'utils', 'img.js'), 'utf8');
    ok('图片: 走 downloadFile 取本地文件', /wx\.downloadFile/.test(imgUtil));
    ok('图片: 失败会抛出可读原因', /reject\(new Error/.test(imgUtil));
    const artJs = fs.readFileSync(path.join(MP, 'pages/art', 'art.js'), 'utf8');
    ok('图片: 产物页用 img.load 取缩略图', /img\s*\.\s*load/.test(artJs));
    ok('图片: 详情页用 img.load', /img\s*\.\s*load/.test(fs.readFileSync(path.join(MP, 'pages/detail/detail.js'), 'utf8')));
  }

  /* ---------------- 收尾 ---------------- */
  for (const t of timers) clearInterval(t);

  console.log('\n小程序自检：' + pass + ' 通过 / ' + bad.length + ' 失败');
  if (bad.length) {
    bad.forEach((x) => console.log('  ✗ ' + x));
    process.exit(1);
  }
  process.exit(0);
})();
