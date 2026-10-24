'use strict';

const fs = require('fs');
const path = require('path');
const {
  parseBuildLine, buildProgress,
  parseUeLine,
  parseSuite, scanArtifacts
} = require('./parsers');

/**
 * 文件尾随器。
 * - 只读追加的增量字节，绝不整文件重读
 * - size 小于 offset ⇒ 判定为轮转/截断，从头开始
 * - 首次 prime() 只取文件尾部 primeBytes，避免把 400MB 老日志一次性灌进内存
 */
class Tailer {
  constructor(file, onLines, opts = {}) {
    this.file = file;
    this.onLines = onLines;
    this.primeBytes = opts.primeBytes || 65536;
    this.fd = null;
    this.offset = 0;
    this.pending = '';
    this.missing = true;
  }

  prime() {
    let st;
    try { st = fs.statSync(this.file); } catch (_) { this.missing = true; return; }
    this.missing = false;
    this.offset = Math.max(0, st.size - this.primeBytes);
  }

  close() {
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (_) {} this.fd = null; }
  }

  /** 跳到文件当前末尾：新一轮编译开始时用 —— 既有内容属于上一轮，不属于这一轮。
      之后编译脚本截断重写时，poll() 的 size<offset 分支会自动归零、从头读新内容；
      若脚本改成追加，也不会把旧内容重复喂给解析器。 */
  skipToTop() {
    this.pending = '';
    this.close();
    let st;
    try { st = fs.statSync(this.file); } catch (_) { this.missing = true; this.offset = 0; return; }
    this.missing = false;
    this.offset = st.size;
  }

  poll() {
    let st;
    try { st = fs.statSync(this.file); } catch (_) {
      this.missing = true;
      return;
    }
    if (this.missing) {
      // 文件刚出现（或之前不存在）：重新定位到尾部
      this.missing = false;
      this.close();
      this.prime();
      return;
    }
    if (st.size < this.offset) {
      // UE 主日志轮转 / 日志被清空
      this.close();
      this.offset = 0;
      this.pending = '';
    }
    if (st.size <= this.offset) return;
    if (this.fd === null) {
      try { this.fd = fs.openSync(this.file, 'r'); } catch (_) { return; }
    }
    const len = Math.min(st.size - this.offset, 1 << 20);
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    try { read = fs.readSync(this.fd, buf, 0, len, this.offset); }
    catch (_) { this.close(); return; }
    if (read <= 0) return;
    this.offset += read;
    const chunk = this.pending + buf.toString('utf8', 0, read);
    const parts = chunk.split(/\r?\n/);
    this.pending = parts.pop() || '';   // 末行可能不完整，等下一次 poll 拼上
    if (parts.length) this.onLines(parts);
  }
}

/* ==================== 编译采集 ==================== */

class BuildCollector {
  constructor(cfg, limits, emit) {
    this.cfg = cfg;
    this.emit = emit;
    this.maxLines = limits.buildLines;
    this.status = 'idle';            // idle | running | done
    this.result = null;
    this.seconds = null;
    this.errors = 0;
    this.warnings = 0;
    this.lines = [];
    this.archives = [];
    this.seenArchives = new Set();
    this.tail = new Tailer(cfg.buildOutLog, (ls) => this.onLines(ls));
  }

  prime() {
    this.tail.prime();
    this.scanArchives();
  }

  /** 新一轮编译开始：清掉上一轮的状态与输出，尾随位置跳到文件末尾。
      ⚠⚠ 不重置的后果：从点下按钮到新日志第一行到达之间，快照里还是上一轮的
      done / 老耗时 —— 前端会显示「编译成功 · 1.98 秒」（那 1.98 秒是上一次的），
      还会触发编译结束弹窗，而这一轮实际根本没跑完。
      （Node 适配器的 startBuild 一直有这套重置，UE 适配器漏了，这才是差异所在。） */
  beginBuild() {
    this.status = 'running';
    this.result = null;
    this.seconds = null;
    this.errors = 0;
    this.warnings = 0;
    this.lines = [];
    this.tail.skipToTop();
    this.emit('build', this.snapshot());
  }

  /** 进程已退出、但日志里始终没出现 Result 行（被手动停止 / 脚本秒退）⇒ 用退出码收尾。
      重复调用无害：status 已不是 running 就直接返回。
      ⚠ 只能在确认 runner.exit 属于「本轮」之后调用 —— start() 会把 exit 清空，所以
      start 之后 exit 必然是本轮的。 */
  finishIfRunning(code) {
    if (this.status !== 'running') return;
    this.status = 'done';
    this.result = code === 0 ? 'Succeeded' : 'Failed (exit ' + code + ')';
    this.emit('build', this.snapshot());
  }

  onLines(rawLines) {
    let changed = false;
    for (const raw of rawLines) {
      const p = parseBuildLine(raw);
      if (p.kind === 'info') continue;
      this.lines.push(p);
      if (this.lines.length > this.maxLines) this.lines.shift();
      changed = true;
      if (p.kind === 'step') {
        if (this.status !== 'running') {
          this.status = 'running';
          this.result = null;
          this.seconds = null;
        }
      } else if (p.kind === 'result') {
        this.result = p.value;
        this.status = 'done';
      } else if (p.kind === 'time') {
        this.seconds = p.value;
      } else if (p.kind === 'error') this.errors++;
      else if (p.kind === 'warn') this.warnings++;
    }
    if (changed) this.emit('build', this.snapshot());
  }

  /**
   * BuildLogs/ 每次编译归档一个新文件 —— 目录监听，不能靠尾随。
   * 关键：编译脚本在编译一开始就创建归档文件（0 字节起步，边编译边写入），
   * 所以已收录条目必须在 size/mtime 变化时刷新并重新解析，
   * 否则 size 永远停在收录时的 0 B，result/进度也全是旧值。
   */
  scanArchives() {
    let names = [];
    try { names = fs.readdirSync(this.cfg.buildLogsDir); } catch (_) { return; }
    const byName = new Map(this.archives.map((a) => [a.name, a]));
    const fresh = [];
    let updated = false;

    for (const n of names) {
      if (!n.toLowerCase().endsWith('.log')) continue;
      const p = path.join(this.cfg.buildLogsDir, n);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }

      const old = byName.get(n);
      if (old) {
        // 已收录：文件仍在增长（size 或 mtime 变化）→ 原地刷新
        if (old.size === st.size && Math.round(old.mtime) === Math.round(st.mtimeMs)) continue;
        Object.assign(old, this.statArchive(n, p, st));
        updated = true;
        continue;
      }
      // 从未见过的新归档；seenArchives 里已有的说明是被裁出 top-40 的旧文件，跳过
      if (this.seenArchives.has(n)) continue;
      this.seenArchives.add(n);
      fresh.push(this.statArchive(n, p, st));
    }

    if (updated) {
      this.archives.sort((a, b) => b.mtime - a.mtime);
      // 先发整包 build（此时还不含 fresh，避免前端 prepend 出重复条目）
      this.emit('build', this.snapshot());
    }
    if (fresh.length) {
      for (const r of fresh) {
        this.archives.unshift(r);
        if (this.archives.length > 40) this.archives.pop();
      }
      this.archives.sort((a, b) => b.mtime - a.mtime);
      this.emit('build-archived', { fresh });
    }
  }

  /** 读一个归档文件，生成条目元数据 + 解析出的进度/结果/错误数 */
  statArchive(n, p, st) {
    const parsed = [];
    try {
      const text = fs.readFileSync(p, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const lp = parseBuildLine(line);
        if (lp.kind !== 'info') parsed.push(lp);
      }
    } catch (_) {}
    return {
      name: n,
      path: p,
      size: st.size,
      mtime: st.mtimeMs,
      mtimeText: new Date(st.mtimeMs).toISOString(),
      progress: buildProgress(parsed),
      result: parsed.filter(x => x.kind === 'result').slice(-1)[0]?.value || null,
      seconds: parsed.filter(x => x.kind === 'time').slice(-1)[0]?.value ?? null,
      errors: parsed.filter(x => x.kind === 'error').length
    };
  }

  snapshot() {
    const prog = buildProgress(this.lines);
    return {
      status: this.status,
      step: prog.step,
      total: prog.total,
      label: prog.label,
      result: this.result,
      seconds: this.seconds,
      errors: this.errors,
      warnings: this.warnings,
      lines: this.lines.slice(-this.maxLines),
      archives: this.archives.slice(0, 12)
    };
  }
}

/* ==================== UE 运行日志采集 ==================== */

class UeLogCollector {
  constructor(cfg, limits, emit) {
    this.cfg = cfg;
    this.emit = emit;
    this.maxLines = limits.ueLogLines;
    this.lines = [];
    this.tail = new Tailer(cfg.ueLog, (ls) => this.onLines(ls), { primeBytes: 32768 });
  }

  prime() { this.tail.prime(); }

  onLines(rawLines) {
    let changed = false;
    for (const raw of rawLines) {
      if (!raw.trim()) continue;
      this.lines.push(parseUeLine(raw));
      if (this.lines.length > this.maxLines) this.lines.shift();
      changed = true;
    }
    if (changed) this.emit('ue-log', { lines: this.lines.slice(-120) });
  }

  snapshot() { return { lines: this.lines.slice(-120) }; }
}

/* ==================== 自检采集（覆盖写，靠 mtime 触发全量重读）==================== */

class SuiteCollector {
  constructor(cfg, emit) {
    this.cfg = cfg;
    this.emit = emit;
    this.items = [];
    this.lastMtime = 0;
  }

  poll() {
    let st;
    try { st = fs.statSync(this.cfg.suiteOut); } catch (_) { return; }
    if (st.mtimeMs === this.lastMtime) return;
    this.lastMtime = st.mtimeMs;
    let text = '';
    try { text = fs.readFileSync(this.cfg.suiteOut, 'utf8'); } catch (_) { return; }
    this.items = parseSuite(text);
    this.emit('suite', { items: this.items, mtime: st.mtimeMs });
  }

  prime() {
    let st;
    try { st = fs.statSync(this.cfg.suiteOut); this.lastMtime = st.mtimeMs; } catch (_) { return; }
    let text = '';
    try { text = fs.readFileSync(this.cfg.suiteOut, 'utf8'); } catch (_) {}
    this.items = parseSuite(text);
  }

  snapshot() { return { items: this.items }; }
}

/* ==================== 产物采集 ==================== */

class ArtifactCollector {
  constructor(cfg, limits, emit) {
    this.cfg = cfg;
    this.emit = emit;
    this.limit = limits.artifacts;
    this.items = [];
    this.signature = '';
    this.scan();
  }

  scan() {
    const items = scanArtifacts(this.cfg, this.limit);
    const sig = items.map(i => i.name + ':' + Math.round(i.mtime)).join('|');
    if (sig !== this.signature) {
      this.signature = sig;
      this.items = items;
      this.emit('artifacts', { items });
    }
  }

  snapshot() { return { items: this.items }; }
}

module.exports = { Tailer, BuildCollector, UeLogCollector, SuiteCollector, ArtifactCollector };
