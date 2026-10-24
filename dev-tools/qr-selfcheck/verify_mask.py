#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""校验掩码罚分实现 + 解释与参考库的差异。

这个脚本里**独立**按 ISO/IEC 18004 的四条罚分规则重写了一遍打分器，
不依赖 web/qrcode.js，也不依赖 qrcode 库的 lost_point —— 用来交叉验证。

三条容易分歧的地方，这里都显式处理并分别报告：

  1) 规则 3（1:1:3:1:1 前后要有 4 模块宽浅色带）
     zxing / Nayuki / 本编码器：符号外的静区**算浅色**
     qrcode 库：只匹配完全落在符号内的 11 格窗口
     → 同一矩阵上两者的分数会差很多，这是规范歧义区，两种都能扫。

  2) 规则 4（黑白比例偏离 50% 的 5% 台阶）
     规范写法：k = floor(|比例-50| / 5)
     Nayuki 写法：k = ceil(x) - 1（x 同上面那个比值）
     → 只在 x 恰为整数时差 10 分。这里两种都算，命中任一即通过。

  3) 参考库评测掩码时会做 test 模式（格式位涂白），所以自动选出的掩码可能不同。
     → 只报告，不作为失败判据。

用法：
    node dump_js.js qr_js.json
    python verify_mask.py qr_js.json
"""
import json
import math
import sys

import qrcode
from qrcode.constants import (
    ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q, ERROR_CORRECT_H)
from qrcode.util import QRData, MODE_8BIT_BYTE

ECC = {'L': ERROR_CORRECT_L, 'M': ERROR_CORRECT_M, 'Q': ERROR_CORRECT_Q, 'H': ERROR_CORRECT_H}


def lines_of(m):
    n = len(m)
    rows = [[1 if v else 0 for v in row] for row in m]
    cols = [[1 if m[y][x] else 0 for y in range(n)] for x in range(n)]
    return rows + cols


def iso_penalty(m):
    """返回 (规则1+2+3, 规则4按 floor, 规则4按 Nayuki)"""
    n = len(m)

    # ---- 规则 1：同色连续 >= 5 ----
    r1 = 0
    for line in lines_of(m):
        run = 1
        for i in range(1, n):
            if line[i] == line[i - 1]:
                run += 1
            else:
                if run >= 5:
                    r1 += 3 + (run - 5)
                run = 1
        if run >= 5:
            r1 += 3 + (run - 5)

    # ---- 规则 2：2x2 同色块 ----
    r2 = 0
    for y in range(n - 1):
        for x in range(n - 1):
            c = m[y][x]
            if c == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                r2 += 3

    # ---- 规则 3：7 格核心 1011101，前后需 4 格浅色（符号外算浅色）----
    def all_light(line, a, b):
        for i in range(a, b):
            if 0 <= i < n and line[i]:
                return False
        return True

    r3 = 0
    for line in lines_of(m):
        for x in range(n - 6):
            if (line[x] and not line[x + 1] and line[x + 2] and line[x + 3]
                    and line[x + 4] and not line[x + 5] and line[x + 6]):
                if all_light(line, x - 4, x) or all_light(line, x + 7, x + 11):
                    r3 += 40

    # ---- 规则 4 ----
    dark = sum(1 for row in m for v in row if v)
    total = n * n
    x = abs(dark * 20 - total * 10) / total          # = 20 * |比例 - 0.5|
    r4_floor = int(math.floor(x)) * 10
    r4_nayuki = max(0, int(math.ceil(x)) - 1) * 10
    return r1 + r2 + r3, r4_floor, r4_nayuki


def build(text, version, ecc, mask, test=False):
    qr = qrcode.QRCode(version=version, error_correction=ECC[ecc], box_size=1, border=0,
                       mask_pattern=mask)
    qr.add_data(QRData(text, mode=MODE_8BIT_BYTE))
    qr.makeImpl(test, mask)
    return qr


def ref_auto_mask(text, version, ecc):
    qr = qrcode.QRCode(version=version, error_correction=ECC[ecc], box_size=1, border=0)
    qr.add_data(QRData(text, mode=MODE_8BIT_BYTE))
    qr.make(fit=False)
    return qr.mask_pattern


def main():
    js = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'qr_js.json', encoding='utf-8'))

    compared = matched = 0
    hits = {'formula': 0, 'floor': 0, 'nayuki': 0}
    by_floor = 0
    auto_total = auto_same = 0
    pairs = []

    for rec in js:
        if 'error' in rec:
            continue
        text, ecc, ver = rec['text'], rec['ecc'], rec['version']

        for m in range(8):
            mat = rec['forced'].get(str(m))
            if not isinstance(mat, list):
                continue
            compared += 1
            base, r4f, r4n = iso_penalty(mat)
            mine = rec['penalty'][str(m)]
            if mine == base + r4n:
                hits['nayuki'] += 1
                matched += 1
            elif mine == base + r4f:
                hits['floor'] += 1
                matched += 1
            else:
                pairs.append((text[:22], ecc, m, mine, base + r4f, base + r4n))

        auto_total += 1
        if ref_auto_mask(text, ver, ecc) == rec['mask']:
            auto_same += 1

    print('A) penalty vs independent ISO scorer : %d/%d matched' % (matched, compared))
    print('   (rule-4 rounding: nayuki-style %d, floor-style %d)'
          % (hits['nayuki'], hits['floor']))
    print('B) auto mask identical to qrcode lib   : %d/%d  <- 差异属规范歧义，不影响可扫性'
          % (auto_same, auto_total))
    if pairs:
        print('--- not matched (text, ecc, mask, mine, floor, nayuki) ---')
        for p in pairs[:10]:
            print('  ', p)
    ok = compared > 0 and matched == compared
    print('RESULT:', 'PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)


main()
