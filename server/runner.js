'use strict';

/**
 * 通用进程运行器 —— 服务里唯一的"执行"能力都在这里。
 *
 * 两种启动形态：
 *   mode: 'bat'  跑一个 .bat（UE 的 build_game.bat；命令行末尾自动补 nopause，
 *                否则脚本结尾的 pause 会把进程钉死，状态永远停在"编译中"）
 *   mode: 'cmd'  跑一条命令行（Node 工程的 `node build.js` / `npm run build` 等）
 *
 * 输出处理：
 *   · 逐行回调 onLine（给采集器解析）
 *   · 环形缓存最近 maxLines 行（给 /api/build/output 回放）
 *   · 可选 logFile：把这轮的完整输出落盘。**只写到 dev-monitor 自己的目录**
 *     （runtime/logs/...），绝不往用户工程里写文件。
 *
 * 编码：cmd/bat 往控制台写中文用的是 GBK（代码页 936），按 UTF-8 解会出 U+FFFD，
 * 这时用 Node 自带 full-icu 的 'gbk' 解码器重解一次。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const noop = () => {};

/** 把命令行拆成 token，支持双引号 / 单引号包裹（路径带空格） */
function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || '')))) {
    out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  }
  return out;
}

/**
 * 按命令行起进程。
 * node 命令直接用当前 Node 可执行文件（避免 PATH 里没有 node），
 * 其它命令在 Windows 上交给 cmd，才能解析 npm / npx 这些 .cmd 垫片。
 */
function spawnCommand(command, cwd) {
  const t = tokenize(command);
  if (!t.length) throw new Error('命令行为空');
  if (/^node(\.exe)?$/i.test(t[0])) {
    return spawn(process.execPath, t.slice(1), { cwd, windowsHide: true });
  }
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', command], {
      cwd, windowsHide: true, windowsVerbatimArguments: true
    });
  }
  return spawn(t[0], t.slice(1), { cwd });
}

class ProcRunner {
  constructor(opts) {
    const o = opts || {};
    this.label = o.label || '进程';
    this.mode = o.mode === 'bat' ? 'bat' : 'cmd';
    this.command = o.command || '';
    this.cwd = o.cwd || process.cwd();
    this.logFile = o.logFile || null;
    this.maxLines = o.maxLines || 300;
    this.onLine = o.onLine || noop;
    this.onExit = o.onExit || noop;

    this.proc = null;
    this.startedAt = 0;
    this.exit = null;
    this.lastError = null;
    this.lines = [];
    this.loggedPath = null;

    this._gbk = new TextDecoder('gbk');
    this._pending = '';
    this._fd = null;
  }

  get running() { return !!this.proc; }

  /** 实际会被执行的命令行（前端 / 日志里展示用） */
  describe() {
    if (this.mode === 'bat') return '"' + this.command + '" nopause';
    return this.command;
  }

  start() {
    if (this.proc) return { ok: false, error: this.label + '已在运行中' };
    if (!this.command) return { ok: false, error: '没有配置' + this.label + '命令' };

    this.lines = [];
    this.exit = null;
    this.lastError = null;
    this._pending = '';
    this.startedAt = Date.now();

    if (this.logFile) {
      try {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
        this._fd = fs.openSync(this.logFile, 'w');
        this.loggedPath = this.logFile;
      } catch (_) { this._fd = null; this.loggedPath = null; }
    }

    let proc;
    try {
      if (this.mode === 'bat') {
        // /s + 原样引号：路径含空格也安全；windowsHide 不弹黑窗
        proc = spawn('cmd.exe', ['/d', '/s', '/c', '"' + this.command + '" nopause'], {
          cwd: this.cwd, windowsHide: true, windowsVerbatimArguments: true
        });
      } else {
        proc = spawnCommand(this.command, this.cwd);
      }
    } catch (e) {
      this._closeLog();
      this.startedAt = 0;
      this.lastError = e.message;
      return { ok: false, error: '启动失败: ' + e.message };
    }

    this.proc = proc;
    proc.stdout.on('data', (b) => this._handle(b));
    proc.stderr.on('data', (b) => this._handle(b));
    proc.on('error', (e) => { this.lastError = e.message; });
    proc.on('close', (code) => this._onClose(code));

    return { ok: true, pid: proc.pid };
  }

  stop() {
    if (!this.proc) return { ok: false, error: '当前没有进程在跑' };
    const pid = this.proc.pid;
    if (process.platform === 'win32') {
      // 杀整棵树：cmd → powershell → dotnet / node
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      k.on('error', noop);
    } else {
      try { this.proc.kill('SIGTERM'); } catch (_) {}
    }
    return { ok: true, stopped: true };
  }

  _handle(buf) {
    let text = buf.toString('utf8');
    if (text.includes('\uFFFD')) {
      try { text = this._gbk.decode(buf); } catch (_) {}
    }
    if (this._fd !== null) {
      try { fs.writeSync(this._fd, text); } catch (_) { this._closeLog(); }
    }
    const chunk = this._pending + text;
    const parts = chunk.split(/\r?\n/);
    this._pending = parts.pop() || '';       // 末行可能不完整，等下一次拼上
    for (const raw of parts) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      this.lines.push(line.slice(0, 400));
      if (this.lines.length > this.maxLines) this.lines.shift();
      try { this.onLine(line); } catch (_) {}
    }
  }

  _onClose(code) {
    if (this._pending.trim()) {
      const line = this._pending;
      this.lines.push(line.slice(0, 400));
      try { this.onLine(line); } catch (_) {}
      this._pending = '';
    }
    const ms = Date.now() - this.startedAt;
    this.exit = { code, ms, at: Date.now() };
    this._closeLog();
    this.proc = null;
    try { this.onExit(code, ms); } catch (_) {}
  }

  _closeLog() {
    if (this._fd !== null) {
      try { fs.closeSync(this._fd); } catch (_) {}
      this._fd = null;
    }
  }

  state() {
    return {
      running: !!this.proc,
      startedAt: this.startedAt || null,
      exit: this.exit,
      lastError: this.lastError,
      label: this.label,
      command: this.describe(),
      logPath: this.loggedPath,
      lines: this.lines.slice(-120)
    };
  }
}

module.exports = { ProcRunner, tokenize, spawnCommand };
