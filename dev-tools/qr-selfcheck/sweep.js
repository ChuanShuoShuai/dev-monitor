'use strict';

/**
 * 随机载荷批量扫描：生成 169 例（版本覆盖 1..40）供 decode_check.py 解码验收。
 * 固定种子，结果可复现。
 *
 *   node sweep.js
 *   python decode_check.py qr_sweep.json
 */

const fs = require('fs');
const path = require('path');

const QR = require(path.join(__dirname, '..', '..', 'web', 'qrcode.js'));

let seed = 20261017;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#[]@!$&()*+,;=%';
const CJK = '落霞村神树之梦幻影机位工程监控手机扫码打开编译运行自检产物';

const cases = [];
for (let i = 0; i < 160; i++) {
  const len = 1 + Math.floor(rnd() * 420);
  const chinese = rnd() < 0.25;
  let t = '';
  for (let k = 0; k < len; k++) {
    t += chinese ? CJK[Math.floor(rnd() * CJK.length)] : ASCII[Math.floor(rnd() * ASCII.length)];
  }
  cases.push({ text: t, ecc: ['L', 'M', 'Q', 'H'][Math.floor(rnd() * 4)] });
}
// 真实用途：局域网地址
for (const ip of ['192.168.3.225', '10.0.0.7', '172.16.13.4', '192.168.189.1']) {
  for (const p of [8787, 9000]) cases.push({ text: 'http://' + ip + ':' + p, ecc: 'M' });
}
cases.push({ text: 'http://192.168.3.225:8787/guide', ecc: 'M' });

const out = [];
for (const c of cases) {
  const r = QR.encode(c.text, { ecc: c.ecc });
  out.push({
    text: c.text, ecc: c.ecc, version: r.version, mask: r.mask,
    modules: r.modules.map((row) => row.map((v) => (v ? 1 : 0)))
  });
}

const dest = path.join(__dirname, 'qr_sweep.json');
fs.writeFileSync(dest, JSON.stringify(out), 'utf8');
const vers = Array.from(new Set(out.map((o) => o.version))).sort((a, b) => a - b);
console.log('sweep cases: ' + out.length + '  versions: ' + vers.join(','));
