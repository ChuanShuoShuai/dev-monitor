'use strict';

/**
 * 把 web/qrcode.js 的输出导成 JSON，交给 verify_matrix.py / decode_check.py 校验。
 *
 * 用法：
 *   node dump_js.js <输出文件>        默认 qr_js.json
 */

const fs = require('fs');
const path = require('path');

const QR = require(path.join(__dirname, '..', '..', 'web', 'qrcode.js'));

const TEXTS = [
  'http://192.168.3.225:8787',
  'http://127.0.0.1:8787/guide',
  'HELLO WORLD 12345',
  'a',
  '工程监控 · 手机扫码打开 http://192.168.3.225:8787',
  'https://example.com/some/longer/path?with=query&and=more&params=here&x=1234567890',
  'x'.repeat(200),
  'x'.repeat(400),
  '中文测试：落霞村、神树之梦、幻影机位',
  'http://10.255.255.254:65535/'
];

const out = [];
for (const t of TEXTS) {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    let auto;
    try {
      auto = QR.encode(t, { ecc });
    } catch (e) {
      out.push({ text: t, ecc, error: String(e.message) });
      continue;
    }
    const rec = {
      text: t,
      ecc,
      version: auto.version,
      mask: auto.mask,
      size: auto.size,
      modules: auto.modules.map((r) => r.map((v) => (v ? 1 : 0))),
      codewords: Array.from(auto.codewords),
      penalty: {},
      forced: {}
    };
    for (let m = 0; m < 8; m++) {
      const f = QR.encode(t, { ecc, mask: m });
      if (f.version !== auto.version) { rec.forced[m] = null; continue; }
      const mat = f.modules.map((r) => r.map((v) => (v ? 1 : 0)));
      rec.forced[m] = mat;
      rec.penalty[m] = QR.penaltyOf(mat);
    }
    out.push(rec);
  }
}

const dest = process.argv[2] || path.join(__dirname, 'qr_js.json');
fs.writeFileSync(dest, JSON.stringify(out), 'utf8');
console.log('cases: ' + out.length + '  ->  ' + dest);
