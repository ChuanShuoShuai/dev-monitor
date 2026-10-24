'use strict';

/**
 * Node / 前端工程适配器（移动简历这类：Babel / Vite / Next 构建的 Web 应用）
 *
 * 与 UE 的关键差异：
 *   · 没有 build_game.bat 双写的日志文件 —— 构建输出直接打在 stdout/stderr，
 *     所以由 ProcRunner 捕获，并**只落到 dev-monitor 自己的 runtime/logs/<工程>/ 里**，
 *     绝不往用户工程目录写文件。
 *   · 没有 Saved/Logs 那种运行日志。所以「运行」页显示的是**控制台合并流**：
 *     构建输出 + 运行命令（如本地预览服务）输出，按时间顺序排。
 *   · 进度没有官方口径。做法是**自校准**：以「上一次构建一共产生多少步」为总数，
 *     第一次构建时总数未知就只显示已执行步数，结束后把实际步数记下来给下一次用。
 */

const fs = require('fs');
const path = require('path');
const { DEV_ROOT } = require('../../bin/config');
const { parseNodeLine, scanTreeArtifacts, formatTime } = require('../parsers');
const { ProcRunner } = require('../runner');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function hhmmss(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class NodeProjectMonitor {
  constructor(proj, limits, match, emit) {
    this.proj = proj;
    this.id = proj.id;
    this.name = proj.name;
    this.kind = 'node';
    this.root = proj.root;
    this.buildCmd = proj.buildCmd;
    this.runCmd = proj.runCmd;
    this.distDir = proj.distDir;
    this.emit = emit;
    this.maxBuildLines = limits.buildLines || 200;
    this.maxLogLines = limits.ueLogLines || 400;
    this.artLimit = limits.artifacts || 80;

    this.logDir = path.join(DEV_ROOT, 'runtime', 'logs', this.id);

    this.status = 'idle';
    this.result = null;
    this.seconds = null;
    this.errors = 0;
    this.warnings = 0;
    this.stepCount = 0;
    this.expectedSteps = 0;
    this.buildLines = [];

    this.console = [];
    this.archives = [];
    this.artifacts = [];
    this.artSig = '';

    this.buildRunner = new ProcRunner({
      label: '构建',
      mode: 'cmd',
      command: this.buildCmd,
      cwd: this.root,
      maxLines: 200,
      onLine: (l) => this.onBuildLine(l),
      onExit: (code, ms) => this.onBuildExit(code, ms)
    });

    this.runRunner = new ProcRunner({
      label: '运行',
      mode: 'cmd',
      command: this.runCmd,
      cwd: this.root,
      maxLines: 200,
      logFile: path.join(this.logDir, 'run.log'),
      onLine: (l) => this.pushConsole(l, 'run', parseNodeLine(l))
    });

    // 启动即从归档里学一次「一次构建大概几步」，并恢复历史列表
    this.scanArchives();
  }

  prime() {
    this.scanArtifacts();
    this.restoreFromArchive();
  }

  poll() {
    this.scanArchives();
    this.scanArtifacts();
  }

  /**
   * 服务重启后内存状态是空的，但磁盘上还留着上一次构建的归档。
   * 把它读回来填进「编译」页，避免看起来像「什么都没编译过」。
   * 用 restored 标记区分：前端会写明这是重启前的记录，不冒充刚刚完成的构建。
   */
  restoreFromArchive() {
    if (this.buildRunner.running || this.buildLines.length) return;
    const a = (this.archives || []).find((x) => x.result);
    if (!a) return;

    this.status = 'done';
    this.result = a.result;
    this.seconds = a.seconds;
    this.stepCount = a.progress ? a.progress.step : 0;
    this.expectedSteps = (a.progress && a.progress.total) || this.stepCount;
    this.restored = true;

    try {
      const text = fs.readFileSync(a.path, 'utf8');
      const parsed = text.split(/\r?\n/).filter((l) => l.trim()).map(parseNodeLine);
      let idx = 0;
      for (const l of parsed) {
        if (l.kind === 'step') { idx += 1; l.index = idx; l.total = this.expectedSteps; }
      }
      this.buildLines = parsed.slice(-this.maxBuildLines);
    } catch (_) {}
  }

  /* ---------------- 构建 ---------------- */

  onBuildLine(line) {
    const p = parseNodeLine(line);
    if (p.kind === 'step') {
      this.stepCount += 1;
      p.index = this.stepCount;
      p.total = this.expectedSteps || 0;
    } else if (p.kind === 'result') {
      this.result = p.value;
    } else if (p.kind === 'error') {
      this.errors += 1;
    } else if (p.kind === 'warn') {
      this.warnings += 1;
    }

    this.buildLines.push(p);
    if (this.buildLines.length > this.maxBuildLines) this.buildLines.shift();
    if (this.status !== 'running') {
      this.status = 'running';
      this.result = null;
      this.seconds = null;
    }
    this.pushConsole(line, 'build', p);
    this.emit('build', this.snapshotBuild());
  }

  onBuildExit(code, ms) {
    this.seconds = ms / 1000;
    const ok = code === 0 && this.errors === 0;
    this.result = ok ? 'Succeeded' : 'Failed';
    this.status = 'done';

    // 自校准：这一轮实际跑了几步，就是下一轮的进度总数
    if (this.stepCount) this.expectedSteps = this.stepCount;
    for (const l of this.buildLines) {
      if (l.kind === 'step') l.total = this.expectedSteps;
    }

    this.buildLines.push({ kind: 'result', text: `Result: ${this.result}`, value: this.result });
    this.buildLines.push({
      kind: 'time', text: `Total execution time: ${(ms / 1000).toFixed(2)}`, value: ms / 1000
    });
    while (this.buildLines.length > this.maxBuildLines) this.buildLines.shift();

    // 结果行补写进归档文件，归档自己看也完整
    const f = this.buildRunner.loggedPath;
    if (f) {
      try {
        fs.appendFileSync(f, `\nResult: ${this.result}\nTotal execution time: ${(ms / 1000).toFixed(2)}\nExit code: ${code}\n`);
      } catch (_) {}
    }

    this.pushConsole(`[进程退出 ${code}] ${this.result}`, 'build',
      { kind: ok ? 'result' : 'error', text: '' });
    this.emit('build', this.snapshotBuild());
    this.scanArchives();
  }

  startBuild() {
    if (!this.buildCmd) return { ok: false, error: '这个工程没有配置构建命令（buildCmd）', status: 400 };
    this.buildLines = [];
    this.errors = 0;
    this.warnings = 0;
    this.stepCount = 0;
    this.status = 'running';
    this.result = null;
    this.seconds = null;
    this.restored = false;
    this.buildRunner.logFile = path.join(this.logDir, 'build-' + stamp() + '.log');
    const r = this.buildRunner.start();
    if (!r.ok) this.status = 'idle';
    this.emit('build', this.snapshotBuild());
    return r;
  }

  stopBuild() {
    const r = this.buildRunner.stop();
    return r;
  }

  /* ---------------- 运行（本地服务 / dev server） ---------------- */

  startRun() {
    if (!this.runCmd) return { ok: false, error: '这个工程没有配置运行命令（runCmd）', status: 400 };
    return this.runRunner.start();
  }

  stopRun() { return this.runRunner.stop(); }

  /* ---------------- 控制台合并流（运行页） ---------------- */

  pushConsole(text, category, parsed) {
    const kind = (parsed && parsed.kind) || 'info';
    const verbosity = kind === 'error' ? 'Error' : kind === 'warn' ? 'Warning' : '';
    this.console.push({
      time: hhmmss(),
      category,
      verbosity,
      text: String(text == null ? '' : text).slice(0, 400)
    });
    if (this.console.length > this.maxLogLines) this.console.shift();
    this.emit('ue-log', { lines: this.console.slice(-120) });
  }

  /* ---------------- 归档（runtime/logs/<id>/build-*.log） ---------------- */

  scanArchives() {
    let names = [];
    try { names = fs.readdirSync(this.logDir); } catch (_) { return; }
    const files = names.filter((n) => /^build-.*\.log$/i.test(n));

    if (!files.length) {
      if (this.archives.length) { this.archives = []; this.emit('build', this.snapshotBuild()); }
      return;
    }

    const byName = new Map(this.archives.map((a) => [a.name, a]));
    let changed = false;
    for (const n of files) {
      const p = path.join(this.logDir, n);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      const old = byName.get(n);
      if (old && old.size === st.size && Math.round(old.mtime) === Math.round(st.mtimeMs)) continue;
      const entry = this.statArchive(n, p, st);
      if (old) Object.assign(old, entry); else this.archives.push(entry);
      changed = true;
    }
    if (!changed) return;

    this.archives.sort((a, b) => b.mtime - a.mtime);
    if (this.archives.length > 40) this.archives.length = 40;

    // 用最近一次完成的构建校准进度总数
    const last = this.archives.find((a) => a.progress && a.progress.total > 0);
    if (last && !this.buildRunner.running) this.expectedSteps = last.progress.total;

    this.emit('build', this.snapshotBuild());
  }

  statArchive(n, p, st) {
    const parsed = [];
    let step = 0;
    try {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const lp = parseNodeLine(line);
        if (lp.kind === 'step') step += 1;
        parsed.push(lp);
      }
    } catch (_) {}
    const result = parsed.filter((x) => x.kind === 'result').slice(-1)[0];
    const time = parsed.filter((x) => x.kind === 'time').slice(-1)[0];
    // 归档里没有「跑完」标记就说明这次构建没正常收尾（被中止 / 崩溃）
    const finished = !!result;
    return {
      name: n,
      path: p,
      size: st.size,
      mtime: st.mtimeMs,
      mtimeText: new Date(st.mtimeMs).toISOString(),
      progress: { step: finished ? step : 0, total: step, label: '' },
      result: result ? result.value : null,
      seconds: time ? time.value : null,
      errors: parsed.filter((x) => x.kind === 'error').length
    };
  }

  /* ---------------- 产物（dist/） ---------------- */

  scanArtifacts() {
    const items = scanTreeArtifacts([{ dir: this.distDir, group: '产物', depth: 1 }], this.artLimit);
    // 工程根下的打包件（dist.zip / *.7z）也算产物
    let names = [];
    try { names = fs.readdirSync(this.root); } catch (_) {}
    for (const n of names) {
      if (!/\.(zip|7z)$/i.test(n)) continue;
      const p = path.join(this.root, n);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (!st.isFile()) continue;
      items.push({
        name: n, path: p, group: '打包', size: st.size,
        mtime: st.mtimeMs, mtimeText: formatTime(st.mtimeMs)
      });
    }
    items.sort((a, b) => b.mtime - a.mtime);
    const sliced = items.slice(0, this.artLimit);
    const sig = sliced.map((i) => i.name + ':' + Math.round(i.mtime)).join('|');
    if (sig !== this.artSig) {
      this.artSig = sig;
      this.artifacts = sliced;
      this.emit('artifacts', { items: sliced });
    }
  }

  /* ---------------- 快照 / 描述 ---------------- */

  snapshotBuild() {
    const total = this.expectedSteps || 0;
    const step = Math.min(this.stepCount, total || this.stepCount);
    return {
      status: this.status,
      step,
      total,
      label: this.buildLines.filter((l) => l.kind === 'step').slice(-1)[0]?.label || '',
      result: this.result,
      seconds: this.seconds,
      errors: this.errors,
      warnings: this.warnings,
      restored: !!this.restored,
      lines: this.buildLines.slice(-this.maxBuildLines),
      archives: this.archives.slice(0, 12)
    };
  }

  snapshot() {
    return {
      build: this.snapshotBuild(),
      buildRunner: this.buildRunner.state(),
      ueLog: { lines: this.console.slice(-120) },
      suite: { items: [] },
      artifacts: { items: this.artifacts },
      run: Object.assign(this.runRunner.state(), { canRun: !!this.runCmd })
    };
  }

  describe(match, allowBuild) {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      kindLabel: this.proj.kindLabel,
      projectRoot: this.root,
      projectName: this.name,
      workspaceRoot: this.root,
      buildOutLog: this.latestBuildLog(),
      buildBat: this.buildCmd,
      allowBuild: allowBuild !== false && !!this.buildCmd,
      storyCategories: match.storyCategories,
      streamCategoryPrefix: match.streamCategoryPrefix,
      pathsPresent: this.proj.pathsPresent,
      canRun: !!this.runCmd,
      runCmd: this.runCmd || '',
      buildCmd: this.buildCmd || '',
      storyFilters: false,
      /* Node 类工程没有自检套件的数据来源 ⇒ 前端隐藏「自检」标签，别给一个永远空着的页面 */
      hasSuite: false
    };
  }

  latestBuildLog() {
    return (this.archives[0] && this.archives[0].path) || '';
  }

  imageRoots() { return []; }

  textRoots() {
    return [this.logDir, this.distDir, path.join(this.root, 'package.json')];
  }

  brief() {
    return {
      id: this.id, name: this.name, kind: this.kind, kindLabel: this.proj.kindLabel,
      status: this.status, result: this.result,
      running: this.buildRunner.running || this.status === 'running',
      runRunning: this.runRunner.running,
      canRun: !!this.runCmd, canBuild: !!this.buildCmd
    };
  }
}

module.exports = { NodeProjectMonitor };
