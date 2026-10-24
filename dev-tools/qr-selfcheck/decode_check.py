#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""端到端解码验收：把 JS 编码器产出的矩阵渲染成图，用独立解码器读回来。

判据：解出来的字符串必须与原文**逐字节相同**。
这比任何"矩阵比对"都更接近真实结果 —— 手机摄像头就是在做这件事。

依赖：
    pip install opencv-python-headless numpy

用法：
    node dump_js.js qr_js.json
    python decode_check.py qr_js.json

注意：OpenCV 对**高版本 + 超长载荷**的识别能力有限（实测 v9 以上、300 字符以上会失败）。
      这类失败请用 verify_matrix.py 复核 —— 如果矩阵与参考实现一致，那就是解码器的局限，
      不是编码器的问题。
"""
import json
import sys

import cv2
import numpy as np

SCALE = 10      # 每模块像素
QUIET = 4       # 静区（规范要求 >= 4 模块）


def render(modules, scale=SCALE, quiet=QUIET):
    n = len(modules)
    dim = (n + quiet * 2) * scale
    img = np.full((dim, dim), 255, dtype=np.uint8)
    for y in range(n):
        row = modules[y]
        for x in range(n):
            if row[x]:
                y0 = (y + quiet) * scale
                x0 = (x + quiet) * scale
                img[y0:y0 + scale, x0:x0 + scale] = 0
    return img


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'qr_js.json'
    cases = json.load(open(path, encoding='utf-8'))
    det = cv2.QRCodeDetector()
    total = ok = 0
    fails = []
    for rec in cases:
        if 'error' in rec:
            continue
        total += 1
        data, _, _ = det.detectAndDecode(render(rec['modules']))
        if data == rec['text']:
            ok += 1
        else:
            fails.append((len(rec['text']), rec['ecc'], rec['version'], rec['mask']))

    print('decoded OK: %d/%d' % (ok, total))
    if fails:
        print('--- failures (len, ecc, version, mask) ---')
        for f in fails[:15]:
            print('  ', f)
        print('提示：先用 verify_matrix.py 复核这些样例的矩阵；若与参考实现一致，则是解码器局限。')
    print('RESULT:', 'PASS' if total and ok == total else 'see failures above')
    sys.exit(0 if total and ok == total else 1)


main()
