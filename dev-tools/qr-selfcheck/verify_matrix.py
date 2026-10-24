#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""逐字节比对 web/qrcode.js 与参考实现（pip install qrcode）的矩阵。

为什么这么做：二维码只有"整格矩阵完全一致"才说明编码、RS 纠错、分块交错、
功能图形、掩码、格式位全部正确。逐格比对比"看起来像二维码"强一万倍。

用法：
    node dump_js.js qr_js.json
    python verify_matrix.py qr_js.json

判据：
    forced 320/320 identical  -> 编码链路正确（这是硬指标）
    auto 若不一致，看 verify_mask.py 的解释（掩码选择属规范歧义区）
"""
import json
import sys

import qrcode
from qrcode.constants import (
    ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q, ERROR_CORRECT_H)
from qrcode.util import QRData, MODE_8BIT_BYTE

ECC = {'L': ERROR_CORRECT_L, 'M': ERROR_CORRECT_M, 'Q': ERROR_CORRECT_Q, 'H': ERROR_CORRECT_H}


def make(text, version, ecc, mask):
    qr = qrcode.QRCode(version=version, error_correction=ECC[ecc], box_size=1, border=0,
                       mask_pattern=mask)
    # 必须显式 Byte 模式：不传 mode 时库会挑"最省"的模式，
    # 纯大写/纯数字会变成 ALPHANUMERIC，比出来的差异就全是模式不同造成的了。
    qr.add_data(QRData(text, mode=MODE_8BIT_BYTE))
    qr.make(fit=False)
    return qr


def mat(qr):
    return [[1 if v else 0 for v in row] for row in qr.modules]


def first_diff(a, b, size):
    for y in range(size):
        for x in range(size):
            if a[y][x] != b[y][x]:
                return (x, y, a[y][x], b[y][x])
    return None


def main():
    js = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'qr_js.json', encoding='utf-8'))
    auto_total = auto_ok = forced_total = forced_ok = 0
    failures = []

    for rec in js:
        if 'error' in rec:
            continue
        text, ecc, ver, size = rec['text'], rec['ecc'], rec['version'], rec['size']

        ref = make(text, ver, ecc, None)
        ref_m = mat(ref)
        auto_total += 1
        if len(ref_m) != size:
            failures.append((text[:30], ecc, 'size %d != %d' % (len(ref_m), size)))
        elif first_diff(rec['modules'], ref_m, size) is None:
            auto_ok += 1

        for m in range(8):
            f = rec['forced'].get(str(m))
            if not isinstance(f, list):
                continue
            forced_total += 1
            rm = mat(make(text, ver, ecc, m))
            if first_diff(f, rm, size) is None:
                forced_ok += 1
            else:
                d = first_diff(f, rm, size)
                failures.append((text[:30], ecc, 'mask=%d x=%d y=%d js=%d ref=%d'
                                 % (m, d[0], d[1], d[2], d[3])))

    print('forced (mask 0..7): %d/%d identical' % (forced_ok, forced_total))
    print('auto (version+mask): %d/%d identical' % (auto_ok, auto_total))
    if failures:
        print('--- first failures ---')
        for f in failures[:15]:
            print('  ', f)
    # 硬指标只看 forced：auto 的掩码选择差异用 verify_mask.py 单独解释
    ok = forced_total > 0 and forced_ok == forced_total
    print('RESULT:', 'PASS (matrix identical)' if ok else 'FAIL')
    sys.exit(0 if ok else 1)


main()
