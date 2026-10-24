'use strict';

/* ==================== 状态 ==================== */

const S = {
  pid: '',                 // 当前选中的工程 id
  projects: [],            // [{id,name,kind,kindLabel,status,running,runRunning,canRun,canBuild}]
  build: null,
  buildRunner: { running: false, startedAt: null, exit: null },
  run: { canRun: false, running: false },
  config: null,
  ueLog: [],
  suite: [],
  artifacts: [],
  tab: 'build',
  runFilter: 'all',
  artFilter: 'all',
  conn: false,
  lastAt: 0
};

const $ = (id) => document.getElementById(id);

/* 进程异常退出码 → 人话。
 *
 * Windows 上被系统/运行时杀掉是 NTSTATUS：node 报出来是有符号负数（如 -1073741819），
 * 直接显示会让人以为是「普通的 1」。这里折成无符号 32 位、给出十六进制与常见含义。
 * ⚠ 2026-10-19 真实案例：UBT 进程 9 次构建里有 5 次是这个 0xC0000005，
 *   界面只写「进程退出码 3221225477」时完全看不出「是崩溃而不是编译报错」。
 */
const CRASH_CODES = {
  0xC0000005: '访问越界',
  0xC000001D: '非法指令',
  0xC00000FD: '栈溢出',
  0xC0000135: '找不到 DLL',
  0xC000013A: '被中断（Ctrl+C）',
  0xC0000142: 'DLL 初始化失败',
  0xC0000374: '堆损坏',
  0xC0000409: '安全检查失败（/GS）'
};

function fmtExitCode(code) {
  if (code === null || code === undefined) return '--';
  if (code === 0) return '0';
  const u = code >>> 0;
  if (u >= 0xC0000000) {
    const hex = '0x' + u.toString(16).toUpperCase();
    const why = CRASH_CODES[u];
    return `${hex}${why ? ' ' + why : ''}（进程崩溃，非编译报错）`;
  }
  return String(code);
}

/* ==================== 事件接入 ==================== */

/** 顶部信息文案：多工程时必须写清「你现在看的是哪个工程」，
    否则切完工程只能靠切换条上的高亮去猜，信息状态和界面对不上。
    正在编译 / 运行时把状态顶上来 —— 只显示一个连接时间，等于没告诉用户"它在跑"。 */
function metaText() {
  const cfg = S.config || {};
  const multi = (S.projects || []).length > 1;
  const bits = [];
  if (multi && cfg.name) bits.push(cfg.name);

  if (!S.conn) {
    bits.push('重连中…');
  } else if (isBuildingNow()) {
    const b = S.build || {};
    bits.push(b.total ? `编译中 ${b.step}/${b.total}` : '编译中…');
  } else if (S.run && S.run.running) {
    bits.push('运行中');
  } else {
    bits.push('已连接 ' + clock());
  }
  return bits.join(' · ');
}

function renderMeta() {
  const el = $('meta');
  if (el) el.textContent = metaText();
}

/* ==================== 自定义弹窗 / 轻提示 ====================
   全部自绘，不调用 alert()/confirm()：系统弹窗在 WebView 里样式不可控，
   还会阻塞渲染线程、在手机上容易被当成页面弹的小广告。 */

let toastTimer = null;

/** 底部轻提示（替代 alert） */
function toast(msg, kind) {
  const el = $('toast');
  if (!el) return;
  el.textContent = String(msg == null ? '' : msg);
  el.className = kind === 'bad' ? 'bad' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'hidden'; }, 2800);
}

let askResolve = null;

/** 自绘确认框（替代 confirm），返回 Promise<boolean> */
function ask(title, msg) {
  const el = $('ask');
  if (!el) return Promise.resolve(false);
  $('ask-title').textContent = title || '请确认';
  $('ask-msg').textContent = msg || '';
  el.classList.remove('hidden');
  return new Promise((resolve) => { askResolve = resolve; });
}

function closeAsk(v) {
  $('ask').classList.add('hidden');
  const r = askResolve;
  askResolve = null;
  if (r) r(!!v);
}

/* 编译结束提示。lastDoneKey 防重复：同一轮结果可能经 SSE 和快照各到一次。
   ⚠⚠ buildSeenRunning 是必须的：服务端会把历史事件整段重放给新连接，
   把「上次构建」的 running→done 重演一遍。只按状态跃迁判断的话，一刷新页面
   就会为一个早就结束的构建弹出窗口（还会挡住整个界面）。 */
let lastDoneKey = null;
let buildSeenRunning = false;

function showBuildDone(b) {
  const failed = !!(b.result && /fail|error/i.test(b.result));
  $('bdone-ico').textContent = failed ? '✕' : '✓';
  $('bdone-ico').className = 'modal-ico ' + (failed ? 'bad' : 'ok');
  $('bdone-title').textContent = failed ? '编译失败' : '编译成功';
  $('bdone-sub').textContent = (S.config && S.config.name) || '';

  const cells = [];
  if (b.seconds) cells.push(['耗时', b.seconds.toFixed(2) + ' 秒']);
  cells.push(['错误', String(b.errors || 0)]);
  cells.push(['警告', String(b.warnings || 0)]);
  $('bdone-stats').innerHTML = cells
    .map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
    .join('');

  $('bdone').classList.remove('hidden');
}

/**
 * 统一的「编译状态」入口。
 * @param next 最新 build 状态
 * @param live 这条状态是否来自**实时**事件（历史重放也算走 apply，必须区分开）
 */
function observeBuild(next, live) {
  const prev = S.build;
  const wasRunning = !!prev && prev.status === 'running';
  S.build = next;

  if (!next || next.restored) return;

  if (next.status === 'running') {
    /* 只有"现在真的在跑"才算数：实时事件，或用户刚点了开始（乐观态由点击处置位） */
    if (live) buildSeenRunning = true;
    return;
  }
  if (next.status !== 'done') return;
  if (!wasRunning || !buildSeenRunning) return;

  buildSeenRunning = false;
  const key = (S.pid || '') + '|' + (next.result || '') + '|' + (next.seconds || 0) + '|' + (next.step || 0);
  if (lastDoneKey === key) return;
  lastDoneKey = key;
  showBuildDone(next);
}

function setConn(on) {
  S.conn = on;
  $('conn-dot').classList.toggle('on', on);
  renderMeta();
}

function connect() {
  const es = new EventSource('/api/events');
  /* 服务端会把历史事件整段重放给每个新连接（方便快速补状态），
     所以必须用一个"从何时起算实时"的水位线把重放事件挑出来，
     否则前端会把几天前的构建当成本次刚跑完（一刷新就弹窗）。 */
  let liveFrom = Date.now();
  // 重连（含服务重启）后必须重新拉全量快照校准：
  // 重连只会补发事件，而服务重启后 fresh 重放会叠在旧状态上产生重复/残留
  es.onopen = () => { liveFrom = Date.now(); setConn(true); refreshSnapshot(); };
  es.onerror = () => setConn(false);
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }
    // 多工程共用一个事件流：别的工程的事件直接丢掉，
    // 切换条上的状态点由 /api/projects 轮询更新，不必把整包数据都收下来
    if (ev.project && S.pid && ev.project !== S.pid) return;
    // 留 1.5s 余量：本机时钟一致，正常事件不会晚到这么久
    apply(ev, (ev.at || 0) >= liveFrom - 1500);
    render();
  };
}

async function refreshSnapshot() {
  try {
    const q = S.pid ? '?project=' + encodeURIComponent(S.pid) : '';
    const r = await fetch('/api/snapshot' + q);
    const j = await r.json();
    if (!j.ok) return;
    S.pid = j.project || S.pid;
    S.projects = j.projects || S.projects;
    observeBuild(j.build);
    S.buildRunner = j.buildRunner || S.buildRunner;
    S.run = j.run || { canRun: false, running: false };
    S.config = j.config || null;
    S.ueLog = (j.ueLog && j.ueLog.lines) || [];
    S.suite = (j.suite && j.suite.items) || [];
    S.artifacts = (j.artifacts && j.artifacts.items) || [];
    renderProjectBar();
    renderChips();
    render();
  } catch (_) {}
}

/** 切换条上的状态点：只拉摘要，5 秒一次，很便宜 */
async function refreshProjects() {
  try {
    const r = await fetch('/api/projects');
    const j = await r.json();
    if (!j.ok) return;
    S.projects = j.projects || [];
    const cur = S.projects.find((p) => p.id === S.pid);
    if (cur) {
      const rr = !!cur.runRunning;
      if (rr !== !!(S.run && S.run.running)) {
        S.run = Object.assign({}, S.run, { running: rr });
        renderRunBar();
      }
    }
    renderProjectBar();
  } catch (_) {}
}

function switchProject(pid) {
  if (!pid || pid === S.pid) return;
  S.pid = pid;
  // 先清干净再拉：否则上一个工程的日志/产物会短暂串到新工程上
  S.build = null;
  S.buildRunner = { running: false, startedAt: null, exit: null };
  S.run = { canRun: false, running: false };
  S.config = null;
  S.ueLog = [];
  S.suite = [];
  S.artifacts = [];
  S.runFilter = 'all';
  S.artFilter = 'all';
  render();
  refreshSnapshot();
}

/* ---------- 工程切换条 ---------- */

function renderProjectBar() {
  const bar = $('projbar');
  if (!bar) return;
  const list = S.projects || [];
  if (list.length < 2) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    syncSticky();
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = list.map((p) => {
    const on = p.id === S.pid;
    const running = p.running || p.runRunning;
    const failed = p.status === 'done' && /fail|error/i.test(p.result || '');
    const dot = running ? 'run' : failed ? 'bad' : p.status === 'done' ? 'ok' : '';
    return `<button class="proj${on ? ' on' : ''}" data-pid="${esc(p.id)}" role="tab" aria-selected="${on}">`
      + `<span class="pd ${dot}"></span>${esc(p.name)}`
      + `<span class="kb">${esc(p.kindLabel || p.kind || '')}</span></button>`;
  }).join('');
  syncSticky();
}

/** 顶栏与切换条都是 sticky，切换条的 top 必须按顶栏实测高度算，否则会叠在一起。
 *  单工程时把 inline top 清掉，交回 CSS 的 calc(49px + safe-area-inset-top)——
 *  刘海屏上那段安全区不能被我们算丢。 */
function syncSticky() {
  const tb = $('topbar'), pb = $('projbar');
  if (!tb || !pb) return;
  const h = tb.offsetHeight;
  if (!h || h < 20) return;             // 布局还没算出来：保持 CSS 默认值，别写 0px
  pb.style.top = h + 'px';
  syncTabGlider();
}

/** 底部导航里的玻璃滑块：宽高与位移全按 active 页签实测写，
 *  这样「自检」被摘掉、剩下的页签重新均分时也跟得上（hidden-tab 的 offsetWidth = 0，直接复位）。
 *  位移不走 CSS transition —— 走下面从库里移植的弹簧（过冲回一下，跟 canvas 版手感一致）。 */
function syncTabGlider() {
  const bar = $('tabbar'), g = $('tab-glider');
  if (!bar || !g) return;
  const act = bar.querySelector('.tab.active');
  if (!act || !act.offsetWidth) {
    g.style.width = '0px'; g.style.height = '0px';
    return;
  }
  // 首帧直接落位（否则会从 0 宽"长"出来，像加载动画；归位动画只在切页时需要）
  if (!g.dataset.ready) g.style.transition = 'none';
  g.style.width = act.offsetWidth + 'px';
  g.style.height = act.offsetHeight + 'px';
  g.style.top = act.offsetTop + 'px';
  glideGliderTo(act.offsetLeft, !g.dataset.ready);
  if (!g.dataset.ready) {
    requestAnimationFrame(() => {
      g.style.transition = '';
      g.dataset.ready = '1';
    });
  }
}

/* ============================================================
   液态玻璃交互：弹簧 + 按压（数值原样移植自 liuli-ui.js）
   ------------------------------------------------------------
   库 renderer/spring.ts：SPRING_K=300、阻尼比 ζ=0.5 → 欠阻尼，
   到位前会过冲回一下（这就是 canvas 版滑块/按压的手感来源）。
   库 renderer 的按压效果 = 白色 α=0.1×progress 的整片染色
   （自定义 pressTint 时普通混合，默认加法混合发光）。
   这里把 springStep1D 原样搬过来，只驱动两件事：
   ① 底部导航滑块的位移（切页时弹簧滑过去）
   ② 可点玻璃元素的 --press 变量（CSS 用它画按压白光）
   ============================================================ */
const SPRING_K = 300;
const SPRING_ZETA = 0.5;
const SPRING_OMEGA_N = Math.sqrt(SPRING_K);
const SPRING_OMEGA_D = SPRING_OMEGA_N * Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 库 springStep1D 原样移植：欠阻尼弹簧单步积分，返回新位置/新速度 */
function springStep1D(x, v, target, dt) {
  const x0 = x - target;
  const decay = Math.exp(-SPRING_ZETA * SPRING_OMEGA_N * dt);
  const cosWd = Math.cos(SPRING_OMEGA_D * dt);
  const sinWd = Math.sin(SPRING_OMEGA_D * dt);
  const offset = x0 * decay * cosWd + (v + SPRING_ZETA * SPRING_OMEGA_N * x0) / SPRING_OMEGA_D * decay * sinWd;
  const b0 = (v + SPRING_ZETA * SPRING_OMEGA_N * x0) / SPRING_OMEGA_D;
  const nv = -SPRING_ZETA * SPRING_OMEGA_N * offset + decay * (-x0 * SPRING_OMEGA_D * sinWd + b0 * SPRING_OMEGA_D * cosWd);
  return [offset + target, nv];
}

const springAnims = new Set();
let springRaf = 0, springLast = 0;
function springTick(t) {
  const dt = Math.min(Math.max((t - springLast) / 1000, 0), 1 / 30) || 1 / 60;
  springLast = t;
  for (const a of [...springAnims]) {
    let [x, v] = a.get();
    [x, v] = springStep1D(x, v, a.target, dt);
    if (Math.abs(x - a.target) < (a.eps || 0.1) && Math.abs(v) < (a.veps || 0.05)) {
      a.set(a.target, 0);
      springAnims.delete(a);
      a.inSet = false;
      if (a.onDone) a.onDone();
    } else {
      a.set(x, v);
    }
  }
  springRaf = springAnims.size ? requestAnimationFrame(springTick) : 0;
}
function wakeSpring() {
  if (!springRaf && springAnims.size && !REDUCED_MOTION) {
    springLast = performance.now();
    springRaf = requestAnimationFrame(springTick);
  }
}

/* --- ① 滑块弹簧：目标变了只改 target，速度保留（跟库一样，连续切页不断劲） --- */
const gliderAnim = {
  x: 0, v: 0, target: 0, inSet: false, eps: 0.1,
  get() { return [this.x, this.v]; },
  set(x, v) {
    this.x = x; this.v = v;
    const g = $('tab-glider');
    if (g) g.style.transform = 'translateX(' + x.toFixed(2) + 'px)';
  }
};
function glideGliderTo(targetX, immediate) {
  if (immediate || REDUCED_MOTION) {
    springAnims.delete(gliderAnim);
    gliderAnim.inSet = false;
    gliderAnim.set(targetX, 0);
    gliderAnim.target = targetX;
    return;
  }
  // 跨屏大跳（页签增删重排）不弹簧，直接落位——弹簧飞过整个屏幕会晃眼
  if (Math.abs(targetX - gliderAnim.x) > ($('tabbar') || {}).offsetWidth) {
    springAnims.delete(gliderAnim);
    gliderAnim.inSet = false;
    gliderAnim.set(targetX, 0);
  } else if (!gliderAnim.inSet) {
    gliderAnim.target = targetX;
    gliderAnim.inSet = true;
    springAnims.add(gliderAnim);
  }
  gliderAnim.target = targetX;
  wakeSpring();
}

/* --- ② 按压白光：按下起弹簧推到 1，松手弹回 0（松手也带一点回弹感） --- */
const PRESS_SEL = '.tab, .chip, .proj, .b-btn, .d-btn, .detail-close';
const presses = new WeakMap();
let pressedEl = null;
function pressStart(el) {
  let st = presses.get(el);
  if (!st) {
    st = {
      p: 0, v: 0, target: 1, inSet: false, eps: 0.005, veps: 0.02,
      get() { return [this.p, this.v]; },
      set(x, v) {
        this.p = x; this.v = v;
        el.style.setProperty('--press', Math.max(0, Math.min(1, x)).toFixed(3));
      },
      onDone() {
        if (this.target === 0) el.style.removeProperty('--press');
      }
    };
    presses.set(el, st);
  }
  st.target = 1;
  if (!st.inSet) { st.inSet = true; springAnims.add(st); }
  wakeSpring();
}
function pressEnd() {
  if (!pressedEl) return;
  const st = presses.get(pressedEl);
  pressedEl = null;
  if (!st) return;
  st.target = 0;
  if (!st.inSet && !REDUCED_MOTION) { st.inSet = true; springAnims.add(st); }
  wakeSpring();
  if (REDUCED_MOTION) st.set(0, 0);
}
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest && e.target.closest(PRESS_SEL);
  pressedEl = (el && !el.disabled) ? el : null;
  if (pressedEl) {
    if (REDUCED_MOTION) pressedEl.style.setProperty('--press', '1');
    else pressStart(pressedEl);
  }
}, { passive: true });
document.addEventListener('pointerup', pressEnd, { passive: true });
document.addEventListener('pointercancel', pressEnd, { passive: true });

/* 页脚版本号：从服务端取，避免前端手写版本漂移（作者信息本身是静态的） */
async function fillFootVersion() {
  const el = document.getElementById('foot-ver');
  if (!el) return;
  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    if (j && j.version) el.textContent = 'v' + j.version;
  } catch (_) {}
}

function apply(ev, live) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'build':
      observeBuild(d, !!live);
      break;
    case 'runner':
      S.buildRunner = d || {};
      break;
    case 'build-archived':
      if (S.build) S.build.archives = (d.fresh || []).concat(S.build.archives || []).slice(0, 12);
      break;
    case 'ue-log':
      S.ueLog = d.lines || [];
      break;
    case 'suite':
      S.suite = d.items || [];
      break;
    case 'artifacts':
      S.artifacts = d.items || [];
      break;
  }
}

async function boot() {
  await refreshSnapshot();
  connect();
  setInterval(tickClock, 1000);
  setInterval(refreshProjects, 5000);
  window.addEventListener('resize', syncSticky);
}

/* ==================== 渲染 ==================== */

function clock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function tickClock() {
  renderMeta();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- 按工程类型定筛选条 ----------
   UE：剧情 / 流送 是引擎日志里的业务分类，别的技术栈没有这两个概念，
   所以 Node 类工程换成「构建 / 运行」两个输出源。 */
function isNodeKind() {
  return !!(S.config && S.config.storyFilters === false);
}

function renderChips() {
  const runDefs = isNodeKind()
    ? [['all', '全部'], ['build', '构建'], ['run', '运行'], ['alert', '警告 / 错误']]
    : [['all', '全部'], ['story', '剧情'], ['alert', '警告 / 错误'], ['stream', '流送']];
  if (!runDefs.some((d) => d[0] === S.runFilter)) S.runFilter = 'all';
  $('run-chips').innerHTML = runDefs.map(([f, t]) =>
    `<button class="chip${f === S.runFilter ? ' active' : ''}" data-f="${f}">${t}</button>`).join('');

  // 产物分组随工程变（UE 是 报告/截图/崩溃，Node 是 产物/打包），按实际数据生成
  const groups = Array.from(new Set((S.artifacts || []).map((i) => i.group)));
  const artDefs = [['all', '全部']].concat(groups.map((g) => [g, g]));
  if (!artDefs.some((d) => d[0] === S.artFilter)) S.artFilter = 'all';
  $('art-chips').innerHTML = artDefs.map(([g, t]) =>
    `<button class="chip${g === S.artFilter ? ' active' : ''}" data-g="${g}">${t}</button>`).join('');
}

/* ---------- 编译 ---------- */

/* 是否正在编译。
   ⚠ 不能只看 S.buildRunner：服务端从来没有发过 runner 事件（前端那个 case 是死分支），
   buildRunner 只能靠快照刷新，构建跑着一整轮它都还是 running:false，按钮就会一直写着「开始编译」。
   真正的实时信号是 build 事件里的 status === 'running'。两个都认，才既有实时性又有兜底。 */
function isBuildingNow() {
  if (S.buildRunner && S.buildRunner.running) return true;
  return !!(S.build && S.build.status === 'running');
}

function renderBuild() {
  /* 编译触发按钮：runner 状态独立于编译日志，可能先到 */
  const run = S.buildRunner || {};
  const runBtn = $('b-run');
  const canBuild = !S.config || S.config.allowBuild !== false;
  const busy = isBuildingNow();
  runBtn.textContent = busy ? '停止编译' : (canBuild ? '开始编译' : '编译不可用');
  runBtn.className = 'b-btn ' + (busy ? 'danger' : 'primary');
  runBtn.disabled = !canBuild && !busy;

  /* 「复制输出 / 完整日志」都依赖服务端给出的日志文件路径。
     新工程还没构建过时那个路径是空的 ⇒ 置灰，别让人点了没反应。 */
  const outLog = (S.config && S.config.buildOutLog) || '';
  ['b-copy', 'b-detail'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !outLog;
  });

  // 归档标题按技术栈说人话：UE 有 BuildLogs 目录，Node 类是每次构建一个日志文件
  const archTitle = $('b-arch-title');
  if (archTitle) archTitle.textContent = isNodeKind() ? '编译归档（每次构建一份）' : '编译归档（BuildLogs）';

  const b = S.build;
  const badge = $('b-status');
  const bar = $('b-bar');
  const step = $('b-step');
  const time = $('b-time');
  const counts = $('b-counts');

  if (!b) { badge.textContent = '等待'; badge.className = 'badge'; step.textContent = '尚未开始编译'; return; }

  const st = b.status || 'idle';
  const failed = b.result && /fail|error/i.test(b.result);
  const restored = !!b.restored && st === 'done';

  badge.className = 'badge ' + (st === 'running' ? 'running' : failed ? 'failed' : st === 'done' ? 'done' : '');
  badge.textContent = st === 'running' ? '编译中'
    : restored ? '上次构建'
      : failed ? '编译失败'
        : st === 'done' ? '编译完成' : '空闲';

  if (restored) {
    // 重启后从磁盘归档恢复的，不能说得像刚刚跑完
    step.textContent = `上次构建${failed ? '失败' : '成功'}${b.seconds ? ` · ${b.seconds.toFixed(2)} 秒` : ''}（服务重启前的记录）`;
  } else if (st === 'running') {
    if (b.label) step.textContent = b.total ? `[${b.step}/${b.total}] ${b.label}` : b.label;
    else step.textContent = b.total ? `${b.step}/${b.total}` : (b.step ? `已执行 ${b.step} 步` : '编译中');
  } else if (failed) {
    step.textContent = `编译失败：${b.result}`;
  } else if (st === 'done') {
    // 完成态优先于"最后一步"：收尾后要说的是结果，不是最后一个文件编译完了
    step.textContent = `编译成功${b.seconds ? ` · ${b.seconds.toFixed(2)} 秒` : ''}`;
  } else {
    step.textContent = '尚未开始编译';
  }

  const pct = b.total ? Math.round((b.step / b.total) * 100) : 0;
  bar.style.width = pct + '%';
  /* 总数未知、或还停在 0 步时给一条往返滑动的进度条：
     定在 0% 会让人以为卡住了（Node 工程的依赖打包阶段本来就要好几秒）。 */
  const indeterminate = st === 'running' && (!b.total || !b.step);
  bar.className = 'bar'
    + (indeterminate ? ' indet' : '')
    + (st === 'running' ? '' : failed ? ' failed' : st === 'done' ? ' done' : '');

  time.textContent = b.seconds ? b.seconds.toFixed(2) + ' s' : (st === 'running' ? '…' : '--');
  let countsText = `错误 ${b.errors || 0} · 警告 ${b.warnings || 0}` + (b.total ? ` · ${pct}%` : '');
  if (run.exit && !run.running) {
    countsText += ` · 进程退出码 ${fmtExitCode(run.exit.code)}` + (run.exit.ms ? ` · ${(run.exit.ms / 1000).toFixed(1)} 秒` : '');
  }
  counts.textContent = countsText;

  // 最近输出
  const box = $('b-log');
  const lines = (b.lines || []).slice(-60);
  box.innerHTML = lines.map((l) => {
    const cls = l.kind === 'error' ? 'err' : l.kind === 'warn' ? 'warn' : l.kind === 'result' ? 'k' : l.kind === 'time' ? 'k' : '';
    return `<div class="l ${cls}">${esc(l.text)}</div>`;
  }).join('') || '<div class="l raw">（暂无输出）</div>';
  box.scrollTop = box.scrollHeight;

  // 归档
  $('b-archives').innerHTML = (b.archives || []).slice(0, 8).map((a) => {
    const ok = a.result && /succe/i.test(a.result);
    const bad = a.result && /fail|error/i.test(a.result);
    const tag = a.result
      ? `<span class="tag ${bad ? '崩溃' : '报告'}">${esc(a.result)}</span>`
      : `<span class="tag">${esc(a.progress && a.progress.step ? a.progress.step + '/' + a.progress.total : '进行中')}</span>`;
    return `<div class="item" data-log="${esc(a.path)}" data-name="${esc(a.name)}">
      <span class="nm">${esc(a.name)}</span>
      ${tag}
      <span class="sz">${fmtSize(a.size)}</span>
      <span class="tm">${esc(fmtTime(a.mtime))}</span>
    </div>`;
  }).join('') || '<div class="item"><span class="nm dim">（暂无归档）</span></div>';
}

/* ---------- 运行 ---------- */

/* 「剧情 / 流送」两类由服务端配置决定（config.json 的 match 段），
   换工程时不用改这里；服务端没给就退回本项目的默认分类。 */
function storyCats() {
  const c = S.config && S.config.storyCategories;
  return Array.isArray(c) && c.length ? c : ['LogMouseAdventure'];
}
function streamPrefix() {
  return (S.config && S.config.streamCategoryPrefix) || 'LogStream';
}
function isStoryCat(cat) {
  return storyCats().indexOf(cat) >= 0;
}

/* Node 类工程没有引擎日志分类，category 只有两个值，显示成中文 */
const CONSOLE_CAT = { build: '构建', run: '运行' };

function renderRun() {
  const box = $('r-log');
  let rows = S.ueLog;
  const f = S.runFilter;
  const pre = streamPrefix();
  const node = isNodeKind();
  if (f === 'story' && !node) rows = rows.filter((l) => isStoryCat(l.category));
  else if (f === 'stream' && !node) rows = rows.filter((l) => String(l.category || '').slice(0, pre.length) === pre);
  else if (f === 'build' && node) rows = rows.filter((l) => l.category === 'build');
  else if (f === 'run' && node) rows = rows.filter((l) => l.category === 'run');
  else if (f === 'alert') rows = rows.filter((l) => l.verbosity === 'Error' || l.verbosity === 'Fatal' || l.verbosity === 'Warning');

  box.innerHTML = rows.slice(-200).map((l) => {
    const story = isStoryCat(l.category);
    const cls = l.verbosity === 'Error' || l.verbosity === 'Fatal' ? 'err'
      : l.verbosity === 'Warning' ? 'warn'
      : story ? 'story' : '';
    const cat = CONSOLE_CAT[l.category] || l.category;
    const head = l.time
      ? `<span class="t">[${esc(l.time)}]</span> <span class="c">${esc(cat)}:</span> `
      : '';
    return `<div class="l ${cls}">${head}${esc(l.text)}</div>`;
  }).join('') || '<div class="l raw">（暂无日志）</div>';

  // 只在贴底时自动跟随，避免打断用户往上翻
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ---------- 自检 ---------- */

function renderSuite() {
  const items = S.suite || [];
  const pass = items.filter((i) => i.pass === true).length;
  const fail = items.filter((i) => i.pass === false).length;
  const node = isNodeKind();
  $('s-title').textContent = node ? '自检' : '自检套件';
  $('s-sum').textContent = items.length ? `通过 ${pass} / ${items.length}${fail ? ` · 失败 ${fail}` : ''}` : '暂无数据';

  $('s-grid').innerHTML = items.map((i) => {
    const cls = i.pass === true ? 'pass' : i.pass === false ? 'fail' : 'unk';
    return `<div class="tile ${cls}">
      <div class="n">${esc(i.name)}</div>
      <div class="r">${esc(i.result || '（无结果行）')}</div>
    </div>`;
  }).join('') || `<div class="item"><span class="nm dim">${node
    ? '这个工程没有配置自检输出，看构建结果请到「编译」页'
    : '暂无自检数据，运行自检套件后此处自动刷新'}</span></div>`;
}

/* ---------- 产物 ---------- */

function renderArtifacts() {
  let items = S.artifacts || [];
  if (S.artFilter !== 'all') items = items.filter((i) => i.group === S.artFilter);
  $('a-list').innerHTML = items.map((i) => {
    const img = i.group === '截图'
      ? `<img class="thumb" loading="lazy" src="/api/file?p=${encodeURIComponent(i.path)}" alt="">`
      : '';
    const idx = S.artifacts.indexOf(i);
    return `<div class="item" data-idx="${idx}">
      ${img}
      <span class="nm">${esc(i.name)}</span>
      <span class="tag ${esc(i.group)}">${esc(i.group)}</span>
      <span class="sz">${fmtSize(i.size)}</span>
      <span class="tm">${esc(i.mtimeText)}</span>
    </div>`;
  }).join('') || '<div class="item"><span class="nm dim">（无匹配产物）</span></div>';
}

/* ---------- 产物详情 ---------- */

const D = { cur: null, content: null, truncated: false, isImage: false };

function isImagePath(name) {
  return /\.(png|jpe?g)$/i.test(name || '');
}

function openArtifact(idx) {
  const it = S.artifacts[idx];
  if (!it) return;
  D.cur = it;
  D.content = null;
  D.truncated = false;

  /* 按扩展名认语言（不认识就是纯文本）。徽标先挂上，
     这样等正文回来时头部不会跳一下。 */
  const lang = HL.langOf(it.name);
  const badge = HL.isCode(lang)
    ? `<span class="lang-badge">${esc(HL.labelOf(lang))}</span>`
    : '';

  $('d-name').textContent = it.name;
  $('d-meta').innerHTML =
    `<span class="tag ${esc(it.group)}">${esc(it.group)}</span>`
    + `<span>${fmtSize(it.size)}</span>`
    + `<span>${esc(it.mtimeText)}</span>`
    + badge
    + `<span class="mpath" id="d-path">${esc(it.path)}</span>`;

  const body = $('d-body');
  const btnOpen = $('d-open');
  /* 上一份可能是代码（不折行），换成图片/提示前先摘掉版式类 */
  body.classList.remove('code');

  if (it.group === '截图' || isImagePath(it.name)) {
    // 图片：直接大图；点图片 → 全屏原图查看器，点周边空白 → 关抽屉
    D.isImage = true;
    body.innerHTML = `<img src="/api/file?p=${encodeURIComponent(it.path)}" alt="${esc(it.name)}">`;
    btnOpen.style.display = '';
    btnOpen.textContent = '放大查看';
  } else {
    D.isImage = false;
    body.innerHTML = '<div class="d-note">加载中…</div>';
    btnOpen.style.display = 'none';
    fetch('/api/content?p=' + encodeURIComponent(it.path))
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) {
          body.innerHTML = `<div class="d-note">读取失败：${esc(j.error || '未知错误')}</div>`;
          return;
        }
        if (j.binary) {
          body.innerHTML = `<div class="d-note">二进制文件（${esc(it.name.split('.').pop())}），不支持内容预览。\n`
            + `大小 ${fmtSize(j.size)}，可在电脑上直接查看。</div>`;
          return;
        }
        D.content = j.content || '';
        D.truncated = !!j.truncated;
        body.innerHTML = renderArtifactText(body, it, D.content, D.truncated);
        body.scrollTop = 0;
        body.scrollLeft = 0;
      })
      .catch((e) => {
        body.innerHTML = `<div class="d-note">网络错误：${esc(String(e))}</div>`;
      });
  }

  $('art-detail').classList.remove('hidden');
}

function closeArtifact() {
  $('art-detail').classList.add('hidden');
  D.cur = null;
  D.content = null;
}

/* 文本产物渲染
   语言按扩展名判定；JSON 能解析就先美化再高亮；超长则回落纯文本并说明原因。
   ⚠ 高亮只是显示层，D.content 始终保存原文 —— 「复制内容」复制的是原始文件。 */
function renderArtifactText(body, it, raw, truncated) {
  const lang = HL.langOf(it.name);
  const code = HL.isCode(lang);
  let text = raw;

  if (lang === 'json') {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) { /* 非法 JSON 按原文显示 */ }
  }

  const tooBig = code && HL.tooLong(text);
  const useHl = code && !tooBig;
  body.classList.toggle('code', useHl);

  let html = useHl ? HL.render(text, lang) : esc(text);
  if (tooBig) {
    /* 报原始文件大小：JSON 美化后会膨胀，拿美化后的长度去说是错的 */
    const kb = Math.max(1, Math.round(raw.length / 1024));
    html += `<div class="d-note">文件约 ${kb} KB，`
      + `超过高亮上限 ${Math.round(HL.MAX_CHARS / 1024)} KB，已按纯文本显示。</div>`;
  }
  if (truncated) {
    html += `<div class="d-note">— 内容过长，已截断显示前 512KB，完整内容请在电脑上查看 —</div>`;
  }
  return html;
}

/* 事件：点产物条目开详情；点遮罩/关闭钮收起 */
$('a-list').addEventListener('click', (e) => {
  const it = e.target.closest('.item');
  if (!it || it.dataset.idx == null) return;
  openArtifact(Number(it.dataset.idx));
});
$('d-close').addEventListener('click', closeArtifact);
$('art-detail').addEventListener('click', (e) => {
  if (e.target === $('art-detail')) { closeArtifact(); return; }
  // 图片模式：点图片 → 全屏原图查看器；点其他空白 → 关抽屉（按钮除外）。
  // 文本模式维持原样（正文要支持长按选择）。
  if (!D.isImage) return;
  if (e.target.closest('.detail-actions') || e.target.closest('.detail-close')) return;
  if (e.target.closest('.detail-body')) {
    openImageViewer(D.cur);
  } else {
    closeArtifact();
  }
});
$('d-copy').addEventListener('click', () => {
  if (!D.cur) return;
  const text = D.content != null
    ? D.content
    : `${D.cur.name}\n路径: ${D.cur.path}\n大小: ${fmtSize(D.cur.size)}\n修改: ${D.cur.mtimeText}`;
  copyTextSmart(text, $('d-copy'), '已复制 ✓');
});
$('d-open').addEventListener('click', () => {
  // 不能用 window.open('_blank')：Android WebView 默认不支持多窗口，
  // 手机上这个按钮会毫无反应。改为应用内全屏查看器。
  if (D.cur) openImageViewer(D.cur);
});

/* ============================================================
   全屏原图查看器
   双指捏合缩放（以捏合中心为锚）· 双击 2.5×↔适配 · 放大后单指拖拽
   · 未放大时单击（图片或空白）关闭 · 滚轮缩放（桌面调试用）
   图片不做 CSS 尺寸约束，位置/缩放全走 transform（origin 0 0）：
   屏幕点 c 处的图像内容点 p = (c - t) / s，缩放时保持 p 不动即可。
   ============================================================ */
const IV = {
  s: 1, tx: 0, ty: 0, sFit: 1, sMin: 1, sMax: 1,
  mode: null,          // 'pinch' | 'pan' | 'tap' | null
  d0: 0, s0: 1, c0: null, t0: null, last: null, moved: 0,
  lastTapT: 0, lastTapX: 0, lastTapY: 0, closeTimer: null, hintTimer: null,
};

function ivRender() {
  $('iv-img').style.transform = 'translate(' + IV.tx + 'px,' + IV.ty + 'px) scale(' + IV.s + ')';
}

/** 平移夹取：图小于视口就居中，大于视口就不许拖出边缘 */
function ivClampPan() {
  const vw = innerWidth, vh = innerHeight;
  const w = $('iv-img').naturalWidth * IV.s, h = $('iv-img').naturalHeight * IV.s;
  IV.tx = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, IV.tx));
  IV.ty = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, IV.ty));
}

/** 适配缩放：完整显示图片（contain） */
function ivFitScale() {
  const img = $('iv-img');
  return Math.min(innerWidth / img.naturalWidth, innerHeight / img.naturalHeight);
}

/** 以屏幕点 (cx,cy) 为锚缩放到 s1 */
function ivZoomTo(s1, cx, cy) {
  const px = (cx - IV.tx) / IV.s, py = (cy - IV.ty) / IV.s;
  IV.s = Math.min(IV.sMax, Math.max(IV.sMin, s1));
  IV.tx = cx - px * IV.s;
  IV.ty = cy - py * IV.s;
  ivClampPan();
  ivRender();
}

function ivHint(text, keep) {
  const h = $('iv-hint');
  clearTimeout(IV.hintTimer);
  h.textContent = text;
  h.classList.add('show');
  if (!keep) IV.hintTimer = setTimeout(() => h.classList.remove('show'), 2600);
}

function openImageViewer(art) {
  if (!art) return;
  IV.el = IV.el || $('img-viewer');
  IV.img = IV.img || $('iv-img');
  IV.el.classList.remove('hidden');
  IV.s = 1; IV.tx = 0; IV.ty = 0; IV.mode = null;
  ivHint('加载中…', true);
  IV.img.onload = () => {
    if (IV.el.classList.contains('hidden')) return;   // 用户已关掉
    IV.sFit = ivFitScale();
    IV.sMin = IV.sFit;
    IV.sMax = Math.min(6, Math.max(1, IV.sFit * 5));  // 别放超过原生分辨率太多
    IV.s = IV.sFit;
    ivClampPan();
    ivRender();
    ivHint('双指缩放 · 双击放大 · ✕ 或点空白关闭');
  };
  IV.img.onerror = () => ivHint('图片加载失败', true);
  IV.img.src = '/api/file?p=' + encodeURIComponent(art.path);
}

function closeImageViewer() {
  $('img-viewer').classList.add('hidden');
  IV.mode = null;
  clearTimeout(IV.closeTimer);
  $('iv-hint').classList.remove('show');
}

function ivDist(t) {
  return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
}
function ivCenter(t) {
  return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
}

function ivBind() {
  const el = $('img-viewer'), img = $('iv-img');

  /* 关闭按钮：必须拦在 viewer 的手势链之前。
     viewer 的 touchstart 会 preventDefault（吃掉合成 click），未放大时的单指点按
     又会走「延迟 260ms 关闭」—— 两者都会干扰按钮，所以在按钮上整体截停冒泡。 */
  const closeBtn = $('iv-close');
  let btnDown = null;
  const releaseBtn = () => { closeBtn.classList.remove('pressed'); btnDown = null; };

  closeBtn.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    const t = e.changedTouches[0];
    btnDown = { x: t.clientX, y: t.clientY };
    closeBtn.classList.add('pressed');      // 按下即反馈（合成 click 可能被抑制）
  }, { passive: true });

  closeBtn.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });

  closeBtn.addEventListener('touchend', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const t = e.changedTouches[0];
    // 按下后手指滑走（位移过大）不关，避免误触
    const ok = !btnDown || Math.hypot(t.clientX - btnDown.x, t.clientY - btnDown.y) < 24;
    releaseBtn();
    if (ok) closeImageViewer();
  }, { passive: false });

  closeBtn.addEventListener('touchcancel', releaseBtn);
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    releaseBtn();
    closeImageViewer();
  });

  el.addEventListener('touchstart', (e) => {
    e.preventDefault();                       // 手势全接管，禁止浏览器默认行为
    if (e.touches.length === 2) {
      IV.mode = 'pinch';
      IV.d0 = ivDist(e.touches) || 1;
      IV.s0 = IV.s;
      IV.c0 = ivCenter(e.touches);
      IV.t0 = { x: IV.tx, y: IV.ty };
    } else if (e.touches.length === 1) {
      IV.mode = IV.s > IV.sFit + 1e-4 ? 'pan' : 'tap';
      IV.last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      IV.moved = 0;
    }
  }, { passive: false });

  el.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (IV.mode === 'pinch' && e.touches.length === 2) {
      const d = ivDist(e.touches), c = ivCenter(e.touches);
      const s1 = Math.min(IV.sMax, Math.max(IV.sMin, IV.s0 * d / IV.d0));
      const px = (IV.c0.x - IV.t0.x) / IV.s0, py = (IV.c0.y - IV.t0.y) / IV.s0;
      IV.s = s1;
      IV.tx = c.x - px * s1;
      IV.ty = c.y - py * s1;
      ivClampPan();
      ivRender();
    } else if (e.touches.length === 1 && IV.last) {
      const dx = e.touches[0].clientX - IV.last.x, dy = e.touches[0].clientY - IV.last.y;
      IV.moved += Math.abs(dx) + Math.abs(dy);
      IV.last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (IV.mode === 'pan') {
        IV.tx += dx;
        IV.ty += dy;
        ivClampPan();
        ivRender();
      }
    }
  }, { passive: false });

  el.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (IV.mode === 'pinch') {
      // 捏合结束若还剩一根手指，无缝转成拖拽
      IV.mode = e.touches.length === 1 ? 'pan' : null;
      IV.last = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
      return;
    }
    if (IV.mode === 'tap' && e.touches.length === 0 && IV.moved < 12) {
      const t = e.changedTouches[0], now = Date.now();
      const dbl = now - IV.lastTapT < 320
        && Math.hypot(t.clientX - IV.lastTapX, t.clientY - IV.lastTapY) < 48;
      if (dbl) {
        clearTimeout(IV.closeTimer);          // 是双击，取消"单击关闭"
        const zoomed = IV.s > IV.sFit * 1.25;
        ivZoomTo(zoomed ? IV.sFit : Math.min(IV.sMax, IV.sFit * 2.5), t.clientX, t.clientY);
        IV.lastTapT = 0;
      } else if (IV.s <= IV.sFit + 1e-4) {
        IV.closeTimer = setTimeout(closeImageViewer, 260);   // 延迟关，给双击留窗口
      }
      IV.lastTapT = now;
      IV.lastTapX = t.clientX;
      IV.lastTapY = t.clientY;
    }
    if (e.touches.length === 0) IV.mode = null;
  }, { passive: false });

  // 桌面调试：滚轮缩放 + 点击关闭（触摸路径的合成 click 已被 preventDefault 抑制）
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    ivZoomTo(IV.s * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
  }, { passive: false });
  el.addEventListener('click', (e) => {
    if (IV.s <= IV.sFit + 1e-4) closeImageViewer();
  });

  // 旋转/分屏时若停在适配倍率，重新适配
  window.addEventListener('resize', () => {
    if (el.classList.contains('hidden') || !img.naturalWidth) return;
    IV.sFit = ivFitScale();
    IV.sMin = IV.sFit;
    if (IV.s <= IV.sFit * 1.02 + 1e-4) {
      IV.s = IV.sFit;
      ivClampPan();
      ivRender();
    }
  });
}
ivBind();

function fmtSize(n) {
  if (n == null) return '--';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function fmtTime(ms) {
  if (!ms) return '--';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 运行日志启停（只有 Node 类工程有） ---------- */

function renderRunBar() {
  const bar = $('runbar');
  if (!bar) return;
  const can = !!(S.config && S.config.canRun);
  if (!can) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const r = S.run || {};
  const btn = $('run-toggle');
  btn.textContent = r.running ? '停止日志' : '启动日志';
  btn.className = 'b-btn ' + (r.running ? 'danger' : 'primary');
  $('run-cmd').textContent = r.command || (S.config && S.config.runCmd) || '';
}

/* ---------- 标签页自我裁剪 ----------
   不同技术栈能提供的面板本来就不一样：Node 类工程没有自检套件的数据来源，
   还留着「自检」标签就是一个永远写着"暂无数据"的空页面。
   能力字段统一由适配器的 describe() 给出（hasSuite），前端不按 kind 硬猜。 */
const TAB_ORDER = ['build', 'run', 'suite', 'art'];

function tabVisible(name) {
  const cfg = S.config || {};
  if (name === 'suite') return cfg.hasSuite !== false;
  return true;
}

/** 切页：同时负责「当前页被裁掉时退回首屏」，不留"没有任何一页被选中"的破状态 */
function setTab(name) {
  if (!name || !tabVisible(name)) name = 'build';
  S.tab = name;
  document.querySelectorAll('#tabbar .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('main .pane').forEach((p) => {
    p.classList.toggle('active', p.id === 'pane-' + name);
  });
  syncTabGlider();
}

function applyTabs() {
  document.querySelectorAll('#tabbar .tab').forEach((b) => {
    b.classList.toggle('hidden-tab', !tabVisible(b.dataset.tab));
  });
  setTab(S.tab);
}

function render() {
  applyTabs();
  renderBuild();
  renderRunBar();
  renderRun();
  renderSuite();
  renderArtifacts();
  renderMeta();
}

/* ==================== 交互 ==================== */

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    setTab(btn.dataset.tab);
    render();
  });
});

/* chips 的内容会随工程 / 产物数据重建，用事件委托，避免每次重渲染都要重新绑定 */
$('run-chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c || c.dataset.f === S.runFilter) return;
  S.runFilter = c.dataset.f;
  renderChips();
  renderRun();
});

$('art-chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c || c.dataset.g === S.artFilter) return;
  S.artFilter = c.dataset.g;
  renderChips();
  renderArtifacts();
});

/* 切换工程 */
$('projbar').addEventListener('click', (e) => {
  const b = e.target.closest('.proj');
  if (b) switchProject(b.dataset.pid);
});

/* 启动 / 停止运行日志（Node 类工程才有这个按钮） */
$('run-toggle').addEventListener('click', async () => {
  const btn = $('run-toggle');
  const running = !!(S.run && S.run.running);
  const q = S.pid ? '?project=' + encodeURIComponent(S.pid) : '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/run/' + (running ? 'stop' : 'start') + q, { method: 'POST' });
    const j = await r.json();
    if (!j.ok) toast(j.error || '操作失败', 'bad');
    else toast(running ? '已请求停止' : '已启动运行命令');
  } catch (e2) {
    toast('网络错误：' + e2, 'bad');
  }
  btn.disabled = false;
  await refreshSnapshot();
});

/* ============================================================
   编译触发 + 编译日志详情
   ============================================================ */

/** 复制并给按钮反馈。http 源下 navigator.clipboard 不存在（非安全上下文），
 *  必须回退 textarea + execCommand，这在 WebView 里仍然有效 */
function copyTextSmart(text, btn, okText) {
  const orig = btn.textContent;
  const done = () => {
    btn.textContent = okText || '已复制 ✓';
    setTimeout(() => { btn.textContent = orig; }, 1400);
  };
  const fail = () => {
    // 尽力兜底：全选详情正文让用户长按复制
    const sheet = btn.closest('.detail-sheet');
    const body = sheet && sheet.querySelector('.detail-body');
    if (body) {
      const r = document.createRange();
      r.selectNodeContents(body);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    btn.textContent = '复制失败，长按正文选择';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  };
  const legacy = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    if (ok) done();
    else fail();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, legacy);
  } else {
    legacy();
  }
}

/* ---- 开始 / 停止编译 ---- */
$('b-run').addEventListener('click', async () => {
  const btn = $('b-run');
  const running = isBuildingNow();

  if (running) {
    const yes = await ask('停止编译', '正在编译的进程会被直接结束，已经写出的文件不会回滚。确定要停吗？');
    if (!yes) return;
  }

  const q = S.pid ? '?project=' + encodeURIComponent(S.pid) : '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/build/' + (running ? 'stop' : 'start') + q, { method: 'POST' });
    const j = await r.json();
    if (!j.ok) {
      toast(j.error || '操作失败', 'bad');
    } else if (!running) {
      /* 乐观置为「编译中」：不等服务端第一个事件回来就把按钮切成「停止编译」。
         否则快构建可能从头到尾都看不到"正在跑"这个状态 —— 这正是之前的问题。 */
      S.build = Object.assign({}, S.build || {}, {
        status: 'running', step: 0, total: 0, result: '', restored: false
      });
      buildSeenRunning = true;   /* 是我们亲手点起来的，完成时该弹窗 */
      toast('已开始编译');
    } else {
      toast('已请求停止');
    }
  } catch (e) {
    toast('网络错误：' + e, 'bad');
  }
  btn.disabled = false;
  render();
});

/* ---- 复制输出（最新完整日志 build_out.log） ---- */
$('b-copy').addEventListener('click', async () => {
  const btn = $('b-copy');
  const orig = btn.textContent;
  btn.textContent = '读取中…';
  let text = '';
  try {
    const p = S.config && S.config.buildOutLog;
    if (p) {
      const r = await fetch('/api/content?p=' + encodeURIComponent(p));
      const j = await r.json();
      if (j.ok && j.content != null) text = j.content;
    }
  } catch (_) {}
  if (!text) text = ((S.build && S.build.lines) || []).map((l) => l.text).join('\n') || '（暂无输出）';
  btn.textContent = orig;
  copyTextSmart(text, btn, '已复制 ✓');
});

/* ---- 编译日志详情抽屉（完整日志 + 归档共用） ---- */
const BD = { path: null, content: null };

async function openBuildDetail(p, title) {
  if (!p) { toast('还没有可用的编译日志，先跑一次编译吧', 'bad'); return; }
  BD.path = p;
  BD.content = null;
  $('build-detail').classList.remove('hidden');
  $('bd-name').textContent = title || String(p).split(/[\\/]/).pop();
  $('bd-meta').innerHTML = `<span class="mpath">${esc(p)}</span>`;
  $('bd-body').textContent = '加载中…';
  try {
    const r = await fetch('/api/content?p=' + encodeURIComponent(p));
    const j = await r.json();
    if (!j.ok) {
      $('bd-body').innerHTML = `<div class="d-note">读取失败：${esc(j.error || '未知错误')}</div>`;
      return;
    }
    BD.content = j.content || '';
    $('bd-meta').innerHTML =
      `<span class="tag">日志</span>`
      + `<span>${fmtSize(j.size)}</span>`
      + `<span>${esc(j.mtimeText)}</span>`
      + `<span class="mpath">${esc(j.path)}</span>`;
    let html = esc(BD.content || '（空文件）');
    if (j.truncated) html += '\n\n<div class="d-note">— 内容过长，仅显示前 512KB，完整内容请在电脑上查看 —</div>';
    $('bd-body').innerHTML = html;
    $('bd-body').scrollTop = 0;
  } catch (e) {
    $('bd-body').innerHTML = `<div class="d-note">网络错误：${esc(String(e))}</div>`;
  }
}

function closeBuildDetail() {
  $('build-detail').classList.add('hidden');
  BD.path = null;
  BD.content = null;
}

$('b-detail').addEventListener('click', () => {
  openBuildDetail(S.config && S.config.buildOutLog, 'build_out.log（最新完整编译日志）');
});
$('bd-close').addEventListener('click', closeBuildDetail);
$('build-detail').addEventListener('click', (e) => {
  if (e.target === $('build-detail')) closeBuildDetail();
});

/* ---- 编译结束弹窗（自绘） ---- */
$('bdone-close').addEventListener('click', () => $('bdone').classList.add('hidden'));
$('bdone-view').addEventListener('click', () => {
  $('bdone').classList.add('hidden');
  setTab('build');
  render();
});
$('bdone').addEventListener('click', (e) => {
  if (e.target === $('bdone')) $('bdone').classList.add('hidden');
});

/* ---- 自绘确认框 ---- */
$('ask-yes').addEventListener('click', () => closeAsk(true));
$('ask-no').addEventListener('click', () => closeAsk(false));
$('ask').addEventListener('click', (e) => {
  if (e.target === $('ask')) closeAsk(false);
});

/* Esc 关掉最上层的自绘弹窗（确认框优先，其次编译结束提示） */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('ask').classList.contains('hidden')) { closeAsk(false); return; }
  if (!$('bdone').classList.contains('hidden')) $('bdone').classList.add('hidden');
});
$('bd-copy').addEventListener('click', () => {
  const text = BD.content != null
    ? BD.content
    : `${BD.path || ''}\n（内容未加载或为二进制）`;
  copyTextSmart(text, $('bd-copy'), '已复制 ✓');
});

/* 归档列表：点任意一条看该次编译的完整日志 */
$('b-archives').addEventListener('click', (e) => {
  const it = e.target.closest('.item');
  if (!it || !it.dataset.log) return;
  openBuildDetail(it.dataset.log, it.dataset.name);
});

boot();
fillFootVersion();
