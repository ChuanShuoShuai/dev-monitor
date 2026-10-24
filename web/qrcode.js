/*!
 * qrcode.js —— 极简 QR 编码器（byte 模式，版本 1~40，ECC L/M/Q/H）
 *
 * 为什么自己写：本页要在**离线局域网**里给手机扫码，不能依赖任何线上二维码
 * 接口；而整个工程监控是零第三方依赖的，不想为一个二维码引入 npm 包。
 *
 * 实现要点（算法结构参考公开的 QR Code 规范实现思路）：
 *   - 字节模式（UTF-8），4 位模式指示符 + 8/16 位长度 + 数据
 *   - GF(256) 上的 Reed-Solomon 纠错，按 (版本, ECC) 分块交错
 *   - 功能图形（定位/校正/定时/格式/版本信息）与数据区严格分离
 *   - 8 种掩码全部试一遍，按标准 4 条罚分规则选最优
 *
 * 对外接口：
 *   QR.encode(text, {ecc:'M'})      -> { size, version, ecc, mask, modules:[[bool]] }
 *   QR.toSvg(text, {ecc, scale, margin, dark, light}) -> svg 字符串
 *   QR.toCanvas(canvas, text, {ecc, margin, size})    -> 画到 canvas
 *   QR.DEFAULT_ECC = 'M'
 */
(function (root) {
  'use strict';

  /* ==================== GF(256) ==================== */

  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;   // 本原多项式 x^8+x^4+x^3+x^2+1
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* ==================== Reed-Solomon ==================== */

  /** 生成 degree 次的生成多项式（首一） */
  function rsDivisor(degree) {
    var result = new Uint8Array(degree);
    result[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  /** data 除以生成多项式的余数 = 纠错码字 */
  function rsRemainder(data, divisor) {
    var result = new Uint8Array(divisor.length);
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ result[0];
      for (var i = 0; i < result.length - 1; i++) result[i] = result[i + 1];
      result[result.length - 1] = 0;
      for (var j = 0; j < result.length; j++) result[j] ^= gfMul(divisor[j], factor);
    }
    return result;
  }

  /* ==================== 参数表 ==================== */
  /* 索引 [ecc][version]，version 1..40（下标 0 留空）
     ECC_CODEWORDS_PER_BLOCK：每个纠错块里的纠错码字数
     NUM_ECC_BLOCKS        ：纠错块数量
     这两张表是 QR 规范附录里的固定数据，靠"先算总码字数再反推每块数据长度"使用 */

  var ECC_PER_BLOCK = {
    L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  };

  var ECC_BLOCKS = {
    L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  };

  /** ECC 等级在校验位里的编码值 */
  var ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  /* ==================== 位缓冲 ==================== */

  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.push = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };
  BitBuffer.prototype.length = function () { return this.bits.length; };

  /* ==================== 编码过程 ==================== */

  /** 版本 version 的数据区可容纳多少个 bit（不含功能图形） */
  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8)
      - ECC_PER_BLOCK[ecl][ver] * ECC_BLOCKS[ecl][ver];
  }

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c > 0xFFFF) i++;                    // 代理对：吃掉低位
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c < 0x10000) {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else {
        out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F),
          0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  /** 字节模式 + 自选最小版本 → 原始码字序列 */
  function encodeToCodewords(bytes, ecl) {
    var version = 0;
    for (var v = 1; v <= 40; v++) {
      var cap = numDataCodewords(v, ecl) * 8;
      var ccBits = v <= 9 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= cap) { version = v; break; }
    }
    if (!version) throw new Error('内容过长（' + bytes.length + ' 字节），超出 QR 容量');

    var bb = new BitBuffer();
    bb.push(0x4, 4);                                  // 字节模式指示符
    bb.push(bytes.length, version <= 9 ? 8 : 16);     // 字符计数
    for (var i = 0; i < bytes.length; i++) bb.push(bytes[i], 8);

    var dataCapacityBits = numDataCodewords(version, ecl) * 8;
    bb.push(0, Math.min(4, dataCapacityBits - bb.length()));   // 终止符
    bb.push(0, (8 - bb.length() % 8) % 8);                     // 补齐到字节边界
    for (var pad = 0xEC; bb.length() < dataCapacityBits; pad ^= 0xEC ^ 0x11) {
      bb.push(pad, 8);
    }

    // 位流 → 码字
    var codewords = [];
    for (var k = 0; k < bb.length(); k += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bb.bits[k + j];
      codewords.push(b);
    }

    /* --- 分块 + RS 纠错 + 交错 ---
       交错严格按规范的两段式来（先数据后纠错，逐列取各块的同一序号）：
         数据段：for i in 0..maxDataLen-1: for 每块 j: i < len(data_j) 才取
         纠错段：for i in 0..eccLen-1:      for 每块 j: 取 ecc_j[i]
       ⚠ 别用"跳过 shorts 块第 (shortBlockLen-eccLen) 个字节"那种合并写法：
         当 numShortBlocks == numBlocks（例如 v2-L 只有 1 块）时，
         那个条件会对所有块都成立，直接吞掉一个码字，矩阵整体错位。 */
    var numBlocks = ECC_BLOCKS[ecl][version];
    var eccLen = ECC_PER_BLOCK[ecl][version];
    var rawCodewords = Math.floor(numRawDataModules(version) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var divisor = rsDivisor(eccLen);

    var blocks = [];
    var maxDcLen = 0;
    var k2 = 0;
    for (var bi = 0; bi < numBlocks; bi++) {
      var dataLen = shortBlockLen - eccLen + (bi < numShortBlocks ? 0 : 1);
      var dat = codewords.slice(k2, k2 + dataLen);
      k2 += dataLen;
      var ecc = rsRemainder(dat, divisor);
      blocks.push({ data: dat, ecc: ecc });
      if (dataLen > maxDcLen) maxDcLen = dataLen;
    }

    var result = [];
    var i2, j2;
    for (i2 = 0; i2 < maxDcLen; i2++) {
      for (j2 = 0; j2 < numBlocks; j2++) {
        if (i2 < blocks[j2].data.length) result.push(blocks[j2].data[i2]);
      }
    }
    for (i2 = 0; i2 < eccLen; i2++) {
      for (j2 = 0; j2 < numBlocks; j2++) {
        if (i2 < blocks[j2].ecc.length) result.push(blocks[j2].ecc[i2]);
      }
    }
    return { version: version, codewords: result };
  }

  /* ==================== 矩阵构造 ==================== */

  function Matrix(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = [];
    this.isFn = [];
    for (var y = 0; y < this.size; y++) {
      var row = [], fn = [];
      for (var x = 0; x < this.size; x++) { row.push(false); fn.push(false); }
      this.modules.push(row);
      this.isFn.push(fn);
    }
  }

  Matrix.prototype.setFn = function (x, y, dark) {
    this.modules[y][x] = !!dark;
    this.isFn[y][x] = true;
  };

  Matrix.prototype.drawFinder = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFn(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  };

  Matrix.prototype.drawAlign = function (x, y) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        this.setFn(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  /** 校正图形中心坐标（规范固定的递推，版本 1 没有） */
  Matrix.prototype.alignPositions = function () {
    if (this.version === 1) return [];
    var numAlign = Math.floor(this.version / 7) + 2;
    var step = this.version === 32 ? 26
      : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = this.size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  };

  Matrix.prototype.drawFunctionPatterns = function () {
    var i, j;
    for (i = 0; i < this.size; i++) {           // 定时图形
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);                     // 三个定位图形
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    var pos = this.alignPositions();
    var n = pos.length;
    for (i = 0; i < n; i++) {                  // 校正图形（跳过与定位图形重叠的三个角）
      for (j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.drawAlign(pos[i], pos[j]);
      }
    }

    this.drawFormatBits(0);                    // 先占位，掩码定了再重画
    this.drawVersion();
  };

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  Matrix.prototype.drawFormatBits = function (mask) {
    var ecl = this._ecl;
    var data = (ECC_FORMAT_BITS[ecl] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    for (var k = 0; k <= 5; k++) this.setFn(8, k, getBit(bits, k));
    this.setFn(8, 7, getBit(bits, 6));
    this.setFn(8, 8, getBit(bits, 7));
    this.setFn(7, 8, getBit(bits, 8));
    for (var m = 9; m < 15; m++) this.setFn(14 - m, 8, getBit(bits, m));

    for (var p = 0; p < 8; p++) this.setFn(this.size - 1 - p, 8, getBit(bits, p));
    for (var q = 8; q < 15; q++) this.setFn(8, this.size - 15 + q, getBit(bits, q));
    this.setFn(8, this.size - 8, true);        // 固定黑点
  };

  Matrix.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (this.version << 12) | rem;
    for (var k = 0; k < 18; k++) {
      var bit = getBit(bits, k);
      var a = this.size - 11 + k % 3;
      var b = Math.floor(k / 3);
      this.setFn(a, b, bit);
      this.setFn(b, a, bit);
    }
  };

  /** 从右下角开始 Z 字走位填数据 */
  Matrix.prototype.drawCodewords = function (codewords) {
    var i = 0;
    var total = codewords.length * 8;
    for (var right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;             // 跳过定时列
      for (var vert = 0; vert < this.size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? this.size - 1 - vert : vert;
          if (!this.isFn[y][x] && i < total) {
            this.modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };

  Matrix.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        if (this.isFn[y][x]) continue;
        var inv;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: inv = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          default: inv = (((x + y) % 2) + (x * y) % 3) % 2 === 0; break;
        }
        if (inv) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  /* ---- 罚分（规范第 8.8.2 节四条规则）----
     刻意写成"照着规范直扫"的形式，不用 runHistory 那类滑窗技巧：
     那种写法把规则 3 的 1:1:3:1:1 推广成了 n:n:3n:n:n（n > 1 也算命中），
     罚分明显偏高，选出来的掩码就和主流实现不一致。
     这里只认模块级 1:1:3:1:1，且符号外的静区按浅色处理。
     正确性由 dev-tools/qr-selfcheck/verify_mask.py 里的独立实现交叉验证。 */

  var N1 = 3, N2 = 3, N3 = 40, N4 = 10;

  Matrix.prototype.penalty = function () {
    var size = this.size;
    var m = this.modules;
    var result = 0;
    var i, j, k, x, y;

    // 行 + 列摊平成一批"线"，规则 1 与规则 3 都在线上扫
    var lines = [];
    for (y = 0; y < size; y++) lines.push(m[y]);
    for (x = 0; x < size; x++) {
      var col = new Array(size);
      for (y = 0; y < size; y++) col[y] = m[y][x];
      lines.push(col);
    }

    // ---- 规则 1：同色连续 >= 5 个，罚 3 + (长度 - 5) ----
    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      var run = 1;
      for (j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) run++;
        else {
          if (run >= 5) result += (run - 2);      // = N1 + (run - 5)
          run = 1;
        }
      }
      if (run >= 5) result += (run - 2);
    }

    // ---- 规则 3：1:1:3:1:1 核心，前后需 4 格浅色（越界 = 静区 = 浅色）----
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i];
      for (j = 0; j + 6 < size; j++) {
        if (!(ln[j] && !ln[j + 1] && ln[j + 2] && ln[j + 3] && ln[j + 4]
          && !ln[j + 5] && ln[j + 6])) continue;
        var beforeLight = true, afterLight = true;
        for (k = j - 4; k < j; k++) {
          if (k >= 0 && ln[k]) { beforeLight = false; break; }
        }
        for (k = j + 7; k < j + 11; k++) {
          if (k < size && ln[k]) { afterLight = false; break; }
        }
        if (beforeLight || afterLight) result += N3;
      }
    }

    // ---- 规则 2：2×2 同色块 ----
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += N2;
      }
    }

    // ---- 规则 4：黑白比例每偏离 50% 一个 5% 台阶 ----
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    var total = size * size;
    // |dark*20 - total*10| / total = 20 * |比例 - 0.5|，每 1 个单位 = 5%
    result += Math.floor(Math.abs(dark * 20 - total * 10) / total) * N4;

    return result;
  };

  /* ==================== 对外 ==================== */

  function encode(text, opts) {
    opts = opts || {};
    var ecl = (opts.ecc || 'M').toUpperCase();
    if (!ECC_PER_BLOCK[ecl]) throw new Error('未知 ECC 等级：' + ecl);

    var bytes = utf8Bytes(String(text));
    var out = encodeToCodewords(bytes, ecl);
    var m = new Matrix(out.version);
    m._ecl = ecl;
    m.drawFunctionPatterns();
    m.drawCodewords(out.codewords);

    var forced = opts.mask;
    var bestMask = 0, bestScore = Infinity;
    if (typeof forced === 'number') {
      m.applyMask(forced);
      m.drawFormatBits(forced);
      bestMask = forced;
    } else {
      // 每种掩码都复制一份试：先按规范选罚分最低的
      var bestModules = null;
      for (var mk = 0; mk < 8; mk++) {
        m.applyMask(mk);
        m.drawFormatBits(mk);
        var score = m.penalty();
        if (score < bestScore) { bestScore = score; bestMask = mk; bestModules = m.modules.map(function (r) { return r.slice(); }); }
        m.applyMask(mk);                    // 异或两次 = 还原
      }
      m.modules = bestModules;
      m.drawFormatBits(bestMask);
    }

    return {
      size: m.size,
      version: out.version,
      ecc: ecl,
      mask: bestMask,
      modules: m.modules,
      // 交错后的最终码字序列（含纠错码字），调试与自检用
      codewords: out.codewords
    };
  }

  function toSvg(text, opts) {
    opts = opts || {};
    var qr = encode(text, opts);
    var scale = opts.scale || 6;
    var margin = opts.margin == null ? 4 : opts.margin;
    var dark = opts.dark || '#000000';
    var light = opts.light || '#ffffff';
    var dim = (qr.size + margin * 2) * scale;

    var path = [];
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (!qr.modules[y][x]) continue;
        path.push('M' + ((x + margin) * scale) + ' ' + ((y + margin) * scale)
          + 'h' + scale + 'v' + scale + 'h-' + scale + 'z');
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim
      + '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">'
      + '<rect width="100%" height="100%" fill="' + light + '"/>'
      + '<path d="' + path.join('') + '" fill="' + dark + '"/></svg>';
  }

  function toCanvas(canvas, text, opts) {
    opts = opts || {};
    var qr = encode(text, opts);
    var margin = opts.margin == null ? 4 : opts.margin;
    var dim = qr.size + margin * 2;
    var cssSize = opts.size || 220;
    var dpr = (root.devicePixelRatio || 1);
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    canvas.style.width = cssSize + 'px';
    canvas.style.height = cssSize + 'px';
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.light || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = opts.dark || '#000000';
    var cell = canvas.width / dim;
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (!qr.modules[y][x]) continue;
        ctx.fillRect(Math.floor((x + margin) * cell), Math.floor((y + margin) * cell),
          Math.ceil(cell), Math.ceil(cell));
      }
    }
    return qr;
  }

  var QR = {
    encode: encode,
    toSvg: toSvg,
    toCanvas: toCanvas,
    /** 给一个已知模块矩阵按标准四条规则打分（自检/调参用） */
    penaltyOf: function (modules) {
      var m = {
        size: modules.length,
        modules: modules.map(function (r) { return r.map(Boolean); })
      };
      return Matrix.prototype.penalty.call(m);
    },
    DEFAULT_ECC: 'M'
  };

  if (typeof module === 'object' && module.exports) module.exports = QR;
  else root.QR = QR;

})(typeof window !== 'undefined' ? window : this);
