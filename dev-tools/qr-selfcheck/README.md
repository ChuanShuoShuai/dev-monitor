# 二维码编码器自检

`web/qrcode.js` 是手写的、零依赖的二维码编码器。**动它之前先看这个目录。**

扫码扫不出来的问题极难在浏览器里发现（看起来一切正常），所以这里留了一套离线校验。

---

## 为什么需要它

二维码编码有七层容易错的地方：模式指示符 / 字符计数位宽 → 分段补位 → RS 纠错
→ 分块交错 → 功能图形 → 掩码 → 格式位。任何一层错，出来的图**依然像个二维码**，
但手机扫不出来。所以判据只能是"与成熟实现逐格一致"或"能被独立解码器读回来"。

这两条都已经跑过，结论记录在最后一节。

---

## 怎么跑

先装两个 Python 包（只在做自检时需要，工具本身零依赖）：

```bash
pip install qrcode opencv-python-headless numpy
# 国内建议加镜像： -i https://mirrors.aliyun.com/pypi/simple/
```

### 1) 矩阵逐格比对（硬指标）

```bash
node dump_js.js qr_js.json
python verify_matrix.py qr_js.json
```

期望输出：

```
forced (mask 0..7): 320/320 identical
auto (version+mask): .../40 identical
RESULT: PASS (matrix identical)
```

`forced` 是**硬指标**：40 组（10 段文本 × 4 种 ECC）× 8 种掩码 = 320 个矩阵，
必须全部与参考实现逐格一致。

`auto` 允许不一致 —— 见下一节。

### 2) 自动选掩码的差异解释

```bash
python verify_mask.py
```

参考库 `qrcode` 在评测掩码罚分时**把格式信息涂白**，而 zxing / Nayuki 等主流实现
（本编码器也是）用真实格式位评测。这属于规范里没说死的歧义区，
选哪个掩码都是合法二维码，不影响可解性。这个脚本用来说明"差异来自评测约定，
不是我的罚分写错了"。

### 3) 端到端解码（最接近真实）

```bash
node dump_js.js qr_js.json
python decode_check.py qr_js.json
```

把矩阵渲染成 PNG 再让 OpenCV 读回来，要求解出的字符串与原文**逐字节相同**。

> OpenCV 对 **v9 以上 + 300 字符以上**的载荷识别率会下降（实测有 22/169 失败）。
> 遇到失败先用第 1 步复核矩阵：矩阵与参考实现一致 ⇒ 是解码器局限，不是编码器问题。

### 4) 随机载荷批量扫描（可选）

```bash
node sweep.js            # 生成 qr_sweep.json（169 例，版本 1..40 覆盖）
python decode_check.py qr_sweep.json
```

---

## 历史结论（2026-10-17）

| 检查项 | 结果 |
|---|---|
| 矩阵与参考实现逐格比对 | **169/169 全一致**（另 320/320 单例比对全一致） |
| 页面渲染出的二维码 → 独立解码 | **通过**（截图后读回 `http://192.168.3.225:8899`） |
| 随机载荷解码 | 147/169；22 例失败**全部**是矩阵与参考实现一致，属解码器局限 |
| 真实用途（局域网 URL，v1~v3） | **全部解码通过** |

---

## 曾经踩过的坑（别重犯）

**分块交错时"跳过短块填充字节"的合并写法会吞掉一个码字。**
当 `numShortBlocks == numBlocks`（例如 v2-L 只有 1 个块），
`if (i != shortBlockLen - eccLen || j >= numShortBlocks)` 这个条件对所有块都成立，
于是第 `shortBlockLen-eccLen` 号字节被整体跳过 —— 矩阵从那里开始全部错位，
但图案看起来仍然像二维码。

正确写法是规范的两段式：

```
数据段：for i in 0..maxDataLen-1: for 每块 j: i < len(data_j) 才取
纠错段：for i in 0..eccLen-1:      for 每块 j: 取 ecc_j[i]
```

**症状特征**（用来快速识别同类问题）：`codewords` 数组长度比参考少 `numBlocks` 个，
且 ECC 段整体左移。dump_js.js 会把 `codewords` 一并导出，直接比长度最快。
