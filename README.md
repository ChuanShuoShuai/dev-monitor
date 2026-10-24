# 工程监控（dev-monitor）

> ⚠️ 本仓库**不含微信小程序端**（`miniprogram/` 目录有意排除，未开源）。
> 开源内容：Web 端、Android（Capacitor）壳、服务端 `server/` 与 `dev-tools/` 工具链。

手机端实时查看工程的**编译进度 / 运行实况 / 自检结果 / 产物清单**。
零第三方依赖，全程只读工程目录（当前配置为 `E:/UE4`），不修改工程内任何文件。

---

## 快速开始

```bash
# 方式一：Windows 双击（推荐）
启动监控.bat        # 缺配置会自动引导配置；没装 Node 会自动下载便携版

# 方式二：命令行
node bin/launcher.js              # 起服务 + 自动打开「连接指引」页
node bin/launcher.js --no-open    # 只起服务
node bin/setup.js                 # 只跑配置向导
```

启动后终端会打印：

```
  工程监控服务已启动（监控只读 + 编译触发）
  ---------------------------------------------------
  本机访问   : http://127.0.0.1:8787
  手机/局域网 : http://192.168.3.225:8787   ← 手机优先用这个
  连接指引   : http://127.0.0.1:8787/guide   （含二维码）
  ---------------------------------------------------
  UE 工程    : E:/UE4/CursorAdventure
  运行日志   : E:/UE4/CursorAdventure/Saved/Logs/CursorAdventure.log
  ...
```

手机浏览器打开**局域网地址**即可（或直接扫连接指引页上的二维码）。
想在外网看，见下方「蒲公英组网接入」。

> 面向使用者的说明见 **`使用说明.md`**；要让 AI 替你操作/改这套工具，
> 把 **`AI提示词.md`** 里的正文整段粘给它。

---

## 零配置：它是怎么找到你的工程的

换台机器、换个工程，需要人填的只有**两个目录**（其余路径全部派生）：

| 字段 | 含义 |
|---|---|
| `ue.workspaceRoot` | 放编译脚本 / `BuildLogs` / `_shot` / `.workbuddy` 的那一层 |
| `ue.projectRoot` | 有 `.uproject` 的那一层（决定 `Saved/Logs/<工程名>.log`） |

`bin/setup.js` 会自动探测，两种常见形态都认：

- **单工程**：`<root>/xxx.uproject` + `Saved/` + `build_game.bat` 都在一层 → 两个根相同
- **工作区**：`<root>/build_game.bat` + `BuildLogs/` + 子目录里才有 `.uproject` → 两个根不同
  （本机的 `E:/UE4` 就是这种：工作区根是 `E:/UE4`，UE 工程根是 `E:/UE4/CursorAdventure`）

探测起点默认是 **dev-monitor 的上一级**，所以"把 dev-monitor 放进工程里"就能零输入。
没有 `.uproject` 时会让你手填；端口被别的程序占用会自动往后顺延
（但如果占用者是另一个正在跑的 dev-monitor，端口保持不变）。

派生规则集中在 `bin/config.js` 的 `buildPaths()`，别在别处散落硬编码路径。

`config.json` 里显式写了的值优先 —— 所以老的、全手写路径的配置文件依然能用。

---

## 多工程 / 多技术栈

一个服务能同时看多个工程，彼此互不干扰；配置了 2 个以上工程时，手机端顶部会多出一条**工程切换栏**
（单工程时整条隐藏，版式和以前一模一样）。

`config.json` 两种写法都支持：

```json
// ① 单工程（老写法，继续有效）
{ "ue": { "workspaceRoot": "E:/UE4", "projectRoot": "E:/UE4/CursorAdventure" } }

// ② 多工程
{ "projects": [
    { "id": "game", "name": "CursorAdventure", "kind": "ue",
      "workspaceRoot": "E:/UE4", "projectRoot": "E:/UE4/CursorAdventure" },
    { "id": "resume", "name": "移动简历", "kind": "node",
      "root": "E:/编程/移动简历", "buildCmd": "node build.js", "runCmd": "node tools/serve.mjs" }
] }
```

| `kind` | 认哪些字段 | 编译怎么跑 | 日志看什么 |
|---|---|---|---|
| `ue` | `workspaceRoot` `projectRoot` `projectName` | `build_game.bat`，输出由脚本双写进 `build_out.log`（原有行为） | `Saved/Logs/<工程名>.log` |
| `node` | `root` `buildCmd` `runCmd` `distDir` | 直接执行命令，捕获 stdout/stderr | 构建输出 + 运行命令输出的合并流 |
| `generic` | 同 `node` | 任意命令行工具（`cargo build`、`cmake --build`、`dotnet build`…） | 同上 |

追加一个 Node / 前端工程不必手改 JSON：

```bash
node bin/setup.js --add-node E:/编程/移动简历 --name 移动简历
# 已存在的目录会自动跳过；--name 不给就用目录名
```

**再加一门技术栈**：写一个 `server/adapters/<kind>.js`（实现 `prime/poll/snapshot/brief/startBuild…`），
在 `server/adapters/index.js` 登记即可，`server.js` 与前端都不用改。

### Node 类工程的采集口径（和 UE 不同，先说清楚）

- **构建输出只写到 `runtime/logs/<工程 id>/`**（dev-monitor 自己的目录），不往你的工程里写任何文件
- 「运行」页是**控制台合并流**，筛选条换成 全部 / 构建 / 运行 / 警告·错误；
  配了 `runCmd` 时还会多一行「启动日志 / 停止日志」，等于远程开关本机预览服务
- **进度是自校准的**：第一次构建只知道「已执行 N 步」（进度条来回滑动），跑完把实际步数记下来，
  下一次就能显示 `[7/16]` —— 这类工程本来就没有「总共几步」的官方口径
- 产物 = `dist/` 里的文件（含 `components/` 一层）+ 工程根下的 `*.zip` / `*.7z`
- 服务重启后会把磁盘上最近一次构建读回「编译」页，并明确标注「上次构建 · 重启前的记录」，
  不会伪装成刚跑完

---

## 连接指引页 `/guide`（含二维码）

服务启动后桌面浏览器会自动打开这一页。它就是给使用者看的说明书：

- **二维码**：直接对着扫，手机浏览器打开即用（不用装任何东西）
- **地址列表**：列出本机所有 IPv4 地址，**虚拟网卡（VMware / Hyper-V / WSL / Docker）自动排到后面**
  并标注「虚拟网卡」；点任一条即可切换二维码编码的地址
- **保存二维码图片**：导出 PNG，方便贴到文档/群里
- **下载安卓 App**：`dist/` 里已有 APK 时自动出现按钮
- **配置体检**：`UE 工程 / 工作区根 / 运行日志 / 编译脚本 / 自检输出 / 截图目录`
  逐项标绿或标黄，一眼看出哪一项还没就绪

二维码是**自研的纯 JS 编码器**（`web/qrcode.js`，byte 模式、版本 1–40、ECC L/M/Q/H），
不依赖任何线上接口 —— 局域网离线也必须能出码。正确性校验见 `dev-tools/qr-selfcheck/`。

---

## 四个监控面板

| 面板 | 数据源 | 说明 |
|---|---|---|
| **编译** | `build_out.log` + `BuildLogs\*.log` | 实时进度 `[7/9] Link...`、`Result: Succeeded`、`Total execution time: 121.58 seconds`、错误/警告计数、历史归档列表 |
| **运行** | `CursorAdventure\Saved\Logs\CursorAdventure.log` | UE 日志实时滚动，剧情行（`LogMouseAdventure`）青色高亮，Warning/Error 自动标色；可按 剧情 / 警告 / 流送 过滤 |
| **自检** | `.workbuddy\tools\_suite_out.txt` | 解析 `===== 名称 =====` + `结果：` 分段，红绿九宫格 |
| **产物** | `Saved\*.json` + `_shot\*` + `Saved\Crashes\` | 按修改时间倒序；**点击任意条目打开详情**（见下） |

> 上表是 **UE 工程**的口径。`kind: node` 的工程：编译输出来自命令的 stdout（归档在 `runtime/logs/`），
> 运行页是构建 + 运行命令的合并控制台，产物取 `dist/` 下的文件。详见上面「多工程 / 多技术栈」。

**界面会按当前工程的能力自我裁剪**（不靠 code 猜，能力字段由各适配器 `describe()` 给出）：

- **「自检」标签**只在有自检数据来源的工程上出现（`hasSuite: true`）。Node / generic 类工程没有这个
  数据源，标签整枚摘掉，而不是留一个永远写着「暂无数据」的空页面；剩下的标签自动均分宽度。
- 若切工程时正停在将被摘掉的页面上，**自动退回「编译」**，不会出现「没有任何一页被选中」的破状态。
- **「开始编译」**在 `allowBuild: false` / `canBuild: false` 时变成「编译不可用」并置灰；
  **「复制输出」「完整日志」**在没有日志文件路径（新工程还没构建过）时置灰。
- **「启动日志」整条**只在配置了运行命令时出现（UE 工程没有）。
- **顶部信息**在多工程时带上当前工程名（`CursorAdventure · 已连接 12:31`），
  否则切完工程只能靠切换条上的高亮去猜自己看的是哪个工程。

**滚动条是自定义的**：`::-webkit-scrollbar` 8px 窄条、半透明圆角、悬停提亮、按压缩放色，
日志框/产物列表/详情正文再收窄到 6px；Firefox 侧同时给 `scrollbar-width: thin` + `scrollbar-color`。
工程切换条是横向滑动，仍用 ID 规则整条隐藏滚动条。

### 液态玻璃界面（对齐「琉璃 UI」组件库）

界面为「液态玻璃」风格，参数**照抄琉璃 UI（liuli-ui）组件库的官方数值**，不凭感觉调：
玻璃容器 `rgba(18,18,18,.42)` + `backdrop-filter: blur(10px) saturate(1.5)`，
顶边一道接近纯白的 1px 高光，1px 描边（上亮下暗渐变，模拟库的边缘折射带），
外投影 `24dp α=.1`；强调色取库的 `#0091FF`，成功/警告/危险取库的 `#30d158 / #ff8d28 / #ff4d4f`。
底部导航栏为「外圈磨砂玻璃胶囊 + 内嵌白色滑块」，选中项图标染强调色——版式与官方演示一致。

**为什么整页 DOM 玻璃只能用 CSS 模拟**：琉璃 UI 本体是 canvas 组件（官方文档明说
「无需额外 CSS」），玻璃画在自己的画布里，DOM UI 无法直接套用；而官方演示页自己的
DOM 按钮（模式切换、文档链接）也是用 CSS 玻璃做的（`rgba(255,255,255,.12~.15)` +
`blur(10px)` + `1px rgba(255,255,255,.2)` 描边），等于官方给「CSS 皮肤」这条路背了书。
旧 WebView 不支持 `backdrop-filter` 时自动退化为不透明深色（`@supports` 兜底），可读性不受影响。

关于安卓原生「液态玻璃库」的取舍：现有库（Kyant0/AndroidLiquidGlass 等）全部基于
Jetpack Compose + Kotlin，完整效果要求 AGSL 着色器（Android 13+）。本项目原生部分
仅两个小页面且为纯 Java 工程，引入 Compose 工具链代价远大于收益，因此原生端用
`Glass.java`（渐变填充 + 渐变高光描边 + 内衬反光）做玻璃拟态近似，Web 端（90% 视觉面积）用 CSS 实现真玻璃。

### 产物详情

点击产物条目弹出全屏玻璃抽屉：

- **截图** → 直接大图；点图片或「放大查看」进入**全屏原图查看器**（双指捏合缩放、
  双击 2.5× 放大、放大后拖拽平移、点空白关闭）
- **代码 / 配置（`.js` `.mjs` `.cjs` `.jsx` `.ts` `.tsx` / `.css` `.scss` `.less` /
  `.html` `.htm` `.xml` `.svg` / `.json`）** → 按扩展名做**语法高亮**，详情头部显示语言徽标：
  - JS：注释、字符串与模板串、关键字、`true/null/undefined`、数字（含 `0xFF`）、函数名、成员属性
  - CSS：注释、字符串、`@rule`、`!important`、十六进制颜色、带单位数值、属性名
  - HTML/XML：注释、DOCTYPE、标签名、属性名、属性值、实体
  - JSON：能解析就先 `JSON.stringify(parse(), null, 2)` 美化再上色（键 / 串 / 数字 / 字面量）
  - **代码视图不折行**（横向滚动）—— 折行会把 token 从中间切断；日志等纯文本仍折行
  - **超 160KB 自动关闭高亮**，回落纯文本并注明原因（上万个 span 会让手机 WebView 卡住）
- **其它文本（`.log` 等）** → 等宽文本预览，控制字符替换为 `·`
- **二进制（`.dmp` 等）** → 不预览内容，只显示路径/大小/修改时间
- 元信息：分组、大小、修改时间、完整路径；底部「复制内容」一键复制
  （http 源下 `navigator.clipboard` 不存在，自动降级 textarea+execCommand，再降级全选正文）；
  内容超 512KB 截断显示
- 高亮只作用于**显示层**：`D.content` 始终是原文，「复制内容」复制的也是原始文件

高亮器是零依赖手写的（`web/highlight.js`，约 200 行），没有引入 Prism/highlight.js 之类，
保持「只用 Node 标准库 + 手写前端」这条线。加一门语言只需往 `RULES` 里补一组规则，
再用 `EXT_LANG` 把扩展名映射过去。

安全：`/api/content` 白名单限 `Saved/`、`Saved/Crashes/`、`_shot/`、`BuildLogs/`、
`build_out.log`、`build_last_errors.log`，路径穿越返回 403；文本限读 512KB，
防止大文件拖垮手机 WebView。

### 编译触发（服务里唯一的"执行"能力）

编译面板顶部有三个按钮：

- **开始编译** → `POST /api/build/start`，服务端 spawn `build_game.bat nopause`
  （**必须 nopause**：bat 结尾会 pause 等按键，不传则进程永不退出）。
  编译期间按钮变红色「停止编译」（点击弹**自绘确认框**，确认后走 `taskkill /T /F` 杀整棵进程树）
- **复制输出** → 拉取 `build_out.log` 全文复制
- **完整日志** → 打开 `build_out.log` 玻璃抽屉；**归档列表的每一条也可点击**，
  看该次编译的完整日志，同样带复制按钮

**「正在编译」这个状态怎么看（改这块前必读）**

真正的实时信号是 `build` 事件里的 `status === 'running'`，**不是** `buildRunner.running`：

- ⚠ 服务端从来没有发过 `runner` 事件（前端那个 `case 'runner'` 是死分支），
  `buildRunner` 只能靠快照刷新 —— 构建跑着一整轮它都还是 `running: false`。
  早期版本只看它来判断按钮文案，结果**编译全程按钮都写着「开始编译」**，
  点下去反而是"再启动一次"。现在一律走 `isBuildingNow()`：两者都认。
- 点完「开始编译」还会**乐观置为编译中**，不等第一个事件回来就切按钮 ——
  快构建否则可能从头到尾看不到"正在跑"这个状态。
- 状态有三处冗余显示：面板徽标「编译中」、按钮「停止编译」、**顶部信息 `工程名 · 编译中 6/16`**
  （顶部这条在任何标签页都看得到）。第 0 步时进度条用往返滑动而不是定在 0%，避免看起来像卡住。

**⚠ 上一轮的结果会残留到下一轮（已修，改采集器前必读）**

`UE 适配器的 startBuild()` 原来只启动进程、**从不重置采集器**：从点下按钮到新日志第一行到达之间，
快照里还是上一轮的 `done / 上一轮耗时`。前端于是显示「编译成功 · 1.98 秒」——
那 1.98 秒是上一次增量编译的——**归档里明明还是「进行中」、进程也确实在跑**。
而且 `scanArchives()` 在归档文件增长时会把整包 `build` 快照广播出去，把这个假状态推给前端，
正好凑齐「running → done」跃迁，**还会触发编译结束弹窗**。

修法（对齐 Node 适配器一直以来的做法）：

- `BuildCollector.beginBuild()`：清 `status/lines/errors/warnings/result/seconds`，`Tailer.skipToTop()`
  把尾随位置跳到文件末尾（既有内容属于上一轮），并广播一次 running。
- `UeProjectMonitor.startBuild()`：**进程起得来才调 `beginBuild()`** —— 起不来要保留上一轮结果。
- `poll()` 末尾补 `finishIfRunning(退出码)`：进程退出但日志里始终没有 Result 行
  （被手动停止 / 脚本秒退）时用退出码收尾，否则「编译中」会永远挂着。
  放在 `tail.poll()` 之后，保证退出前写的内容先被读到。

**编译结束自动弹窗（自定义，不是系统 alert）**

`running → done` 跃迁时弹出居中卡片：成功绿勾 / 失败红叉、工程名、
耗时·错误·警告三项、以及「查看输出」「知道了」两个按钮。

- ⚠⚠ **判定必须区分「实时事件」和「历史重放」**：服务端会把历史事件整段重放给每个新连接
  （方便快速补齐状态），只按状态跃迁判断的话，**一刷新页面就会为几天前的构建弹窗**，
  而且模态层会挡住整个界面。现在用 `buildSeenRunning` 门槛 —— 必须"亲眼看它跑起来"
  （实时 running 事件，或自己点了开始）才允许弹，重放事件不置位。
- 服务重启后从归档恢复的 `restored` 记录不是"刚跑完"，不弹。
- `lastDoneKey` 防重复：同一轮结果可能经 SSE 和快照各到一次。

⚠ **全站不再使用系统 `alert()` / `confirm()`**：错误提示走底部 toast（2.8 秒自动消失），
需要用户确认的走 `#ask` 卡片，结束提示走 `#bdone` 卡片。系统弹窗在 WebView 里样式完全不可控、
会阻塞渲染，移动端还容易被当成页面弹的小广告。层级：查看器(60) < 弹窗(62) < 轻提示(70)。

重复触发返回 409；`config.json` 里 `allowBuild: false` 可整体禁用。

实测记录：全量编译 376 秒（退出码 0），bat 直出的中文行是 GBK 编码，服务端检测到
U+FFFD 会用 `TextDecoder('gbk')` 重解；增量编译约 6 秒。

---

## 关键技术点（都是踩过的坑）

**1. 三种日志三种读法，不能统一处理**

| 日志 | 写入方式 | 处理 |
|---|---|---|
| `build_out.log` | 追加 | 尾随增量字节 |
| `CursorAdventure.log` | 追加 + **轮转**（生成 `-backup-*.log`） | 尾随 + `size < offset` 判定轮转并重置 |
| `_suite_out.txt` | **覆盖写** | 靠 mtime 变化触发全量重读 |
| `BuildLogs\` | 每次编译**新文件** | 目录扫描，不能尾随 |

`_suite_out.txt` 用 offset 尾随会永远读不到新内容；`BuildLogs` 尾随会一直盯着上一次的旧日志。

**2. 首次启动只读尾部**

`CursorAdventure.log` 已达数百 KB。`Tailer.prime()` 只从 `size - 64KB` 开始，避免把历史日志一次性灌进内存。

**3. SSE 而非轮询**

`/api/events` 走 Server-Sent Events，服务端 700ms 轮询一次磁盘，有变化才推。断线自动补发 `since` 之后的事件（服务端保留最近 800 条）。

**4. UE 日志的 verbosity 段是可选的（实测踩中）**

引擎自带日志带 verbosity：

```
[2026.10.16-07.21.51:816][604]LogAudio: Display: Audio Device unregistered...
```

但工程自定义日志**省略了 verbosity**，直接跟中文正文：

```
[2026.10.16-07.16.03:582][465]LogMouseAdventure: 自动存档已写入：地图=Cave 等级=10
```

正则若强制要求 `分类: verbosity: 正文`，且用 `\w+` 去匹配中文正文，**整行匹配失败直接落为 Raw —— 剧情行 100% 丢失**。实测修复后 Raw 行从 51/120 降到 2/120。

```js
// verbosity 包在非捕获可选组里
/^\[(\d{4}\.\d{2}\.\d{2}-[\d.:]+)\]\[\s*(\d+)\]([A-Za-z]+):\s*(?:(\w+):\s*)?(.*)$/
```

**5. 自检"通过"不等于文本里有"通过"二字**

`_suite_out.txt` 的真实写法有三种，只认"通过/成功"会把合格项误判成失败：

| 原文 | 判定 |
|---|---|
| `全部通过（仍需真机编译才算数）` | 通过 |
| `0 个文件括号不平（共查 85 个）` | 通过（零问题） |
| `0 组文件级重名（共查 85 个文件、630 个候选名字）` | 通过（零问题） |
| （空结果行，如 `missing_includes` 段） | 未知，黄色 |

判定顺序为**负面词 → 通过词 → 零问题模式**（`^\s*0\s*(个|组|处|条|项|次|类)`）。
另注意冒号有半角 `结果:` 和全角 `结果：` 两种，正则需写成 `[:：]`。

**6. `.bat` 内容必须纯 ASCII、且必须 CRLF**

两条各有各的原因，缺一不可：

- **纯 ASCII**：cmd.exe 可能按 OEM 代码页（简中机器是 GBK）解析 bat 文本，中文会乱码，
  甚至报"字符串缺少终止符"。所以**中文提示一律交给 Node 打印**
  （Node 在 Windows 控制台走 `WriteConsoleW`，任何代码页都正确），
  bat 只做流程编排 + 英文消息。文件**名**用中文没问题，只有文件**内容**受限。
- **CRLF**：LF-only 的 bat 里 `goto :label` 可能跳错位置。本工程大量用标签分段，
  所以统一转 CRLF（`bin/*.bat` 全部如此）。

顺带一个 cmd 的老坑：`%ProgramFiles(x86)%` 展开后含 `)`，
**放进 `( )` 块里会破坏解析** —— `bin/find-node.bat` 因此刻意用一堆平行的一行 `if`，
不用 `for` 循环包住它。

**7. ZIP 里中文文件名必须自己打 UTF-8 标志位**

`Compress-Archive` 对中文文件名在部分环境解压出来是乱码。`bin/make-dist.js` 自带一个
最小 ZIP 写入器，每个条目都把通用标志 bit 11（UTF-8 名字）打上，并用 Python `zipfile`
复核过：CRC 全过、中文名可正确还原。

**8. Node 运行时自愈：四个查找位置 + 国内镜像**

`bin/find-node.bat` 依次找：`runtime\node\node.exe`（随包下载的便携版）→ PATH →
`Program Files\nodejs` / `%LOCALAPPDATA%\Programs\nodejs` → WorkBuddy 受管运行时。
都没有时 `bin/get-node.bat` 会下载便携版：curl（Win10 1803+ 自带）→ PowerShell 兜底，
解压用 `tar.exe` → `Expand-Archive` 兜底，源先国内镜像（npmmirror）再官方站。
**目录里任何东西都不动，只写 `runtime/`。**

**9. 二维码分块交错：合并写法会吞掉一个码字**

`web/qrcode.js` 里踩过：用"跳过短块填充字节"的合并条件
（`i != shortBlockLen - eccLen || j >= numShortBlocks`）时，
当 `numShortBlocks == numBlocks`（例如 v2-L 只有 1 块）该条件对所有块都成立，
直接吞掉第 `shortBlockLen - eccLen` 号字节 —— 矩阵从那里起全部错位，
但图案看起来仍然像二维码，手机就是扫不出来。

正确写法是规范的两段式（先数据后纠错，逐列取各块同序号）。
**识别特征**：码字数组比参考实现少 `numBlocks` 个、且 ECC 段整体左移。
校验方法与历史结论见 `dev-tools/qr-selfcheck/README.md`。

**10. 掩码罚分有两处规范歧义区（不影响可扫性，但会影响选哪个掩码）**

- **规则 3**（1:1:3:1:1 前后 4 格浅色）：zxing / 本编码器把**符号外的静区算浅色**；
  python `qrcode` 库只匹配完全落在符号内的 11 格窗口。
- **规则 4**（黑白比例 5% 台阶）：规范写 `floor`，Nayuki 写 `ceil - 1`，
  只在比值恰为整数时差 10 分。

本实现照规范直扫（不用 `runHistory` 滑窗技巧 —— 那种写法会把 1:1:3:1:1 推广成
`n:n:3n:n:n`，罚分明显偏高）。`dev-tools/qr-selfcheck/verify_mask.py` 里有一个
**独立**按 ISO 重写的打分器做交叉验证，320/320 一致。

> 三个校验脚本的实际结论：矩阵与参考实现 **169/169 逐字节一致**；
> 页面渲染出的二维码截图后能被 OpenCV 读回原始 URL；
> 22 例解码失败**全部**是矩阵与参考实现一致 ⇒ 解码器对高版本长载荷的局限。

---

## HTTP 接口

| 接口 | 说明 |
|---|---|
| `GET /api/health` | 服务状态 + 局域网地址列表（含推荐项/虚拟网卡标记）+ 各监控路径是否就绪 + 体检提示 |
| `GET /api/projects` | 工程列表与状态摘要（切换栏的状态点靠它轮询） |
| `GET /api/snapshot` | 全量快照：`config` / `build` / `buildRunner` / `ueLog` / `suite` / `artifacts` / `run`；`?project=<id>` 指定工程，省略取默认工程 |
| `GET /api/events` | SSE 事件流；每条事件带 `project` 字段；`?since=<seq>` 补发断线期间的事件（服务端保留最近 1200 条） |
| `POST /api/build/start` | 触发编译；重复触发返回 409；`allowBuild:false` 时返回 403 |
| `POST /api/build/stop` | `taskkill /pid <pid> /T /F` 杀整棵进程树 |
| `POST /api/run/start` `POST /api/run/stop` | 启动 / 停止 `runCmd`（只有 Node 类工程有） |
| `GET /api/build/output` | 编译进程的直接输出 |
| `GET /api/content?p=` | 产物详情；白名单按**各工程**分别校验（`Saved/` `Saved/Crashes/` `_shot/` `BuildLogs/` 两个编译日志 / `runtime/logs/<id>/` / `dist/`），越界 403 |
| `GET /api/file?p=` | 图片；白名单限 `_shot/` `Saved/Crashes/` 下的 `.png/.jpg` |
| `GET /guide` | 连接指引页 |
| `GET /apk` | 安卓壳 APK（`dist/` 里有才可用） |

编译 / 运行类接口都接受 `?project=<id>`（省略则作用于默认工程）。

调试用环境变量（优先级高于 `config.json`，不污染配置文件）：

`DM_CONFIG`（换一份配置文件）/ `DM_PORT` / `DM_HOST` / `DM_ALLOW_BUILD=false`

---

## 蒲公英组网接入

服务默认监听 `0.0.0.0:8787`，这正是组网需要的形态：

1. 电脑和手机装蒲公英客户端，**登录同一贝锐账号**
2. 两端自动进入默认智能网络
3. 手机浏览器打开 `http://<电脑蒲公英虚拟IP>:8787`（形如 `172.16.x.x`）

数据全程走私网隧道，不暴露公网、不需要公网 IP、不需要租服务器。

> 若只想在局域网/WiFi 下用，直接用启动时打印的局域网 IP 即可，不需要组网。

---

## 目录结构

```
dev-monitor/
├── 启动监控.bat              # 一键启动（缺配置自动引导；缺 Node 自动下载）
├── 首次配置.bat              # 只跑配置向导
├── 下载运行环境.bat          # 单独下载便携 Node.js
├── 打包分发包.bat            # 打成可分发 zip
├── start.bat                 # 等价于「启动监控.bat」（旧名兼容）
├── config.json               # 实际生效的配置（向导生成，可手改）
├── config.default.json       # 配置模板
├── 使用说明.md               # 面向使用者的手册
├── AI提示词.md               # 给 AI 用的提示词（可整段粘贴）
├── build_apk.bat             # 一键打包 APK
├── capacitor.config.json     # App ID / 名称 / webDir
├── package.json
├── bin/
│   ├── launcher.js           # 启动器：查配置 → 起服务 → 开浏览器到 /guide
│   ├── setup.js              # 配置向导（探测工程 + 写 config.json + 端口探测）
│   ├── config.js             # 统一配置加载 + 路径派生 + 体检（服务端唯一入口）
│   ├── make-dist.js          # 打分发 zip（自带最小 ZIP 写入器，保证中文名不乱码）
│   ├── find-node.bat         # 按 4 个位置找 Node.js（纯 ASCII + CRLF）
│   ├── get-node.bat          # 从国内镜像下载便携 Node.js 并解压
│   └── start-monitor.bat / run-setup.bat / make-dist.bat
├── server/
│   ├── server.js             # HTTP / SSE / 静态 / 白名单接口 / 编译触发（多工程路由）
│   ├── adapters/             # 技术栈适配器：一个工程一个实例
│   │   ├── index.js          #   工厂 + 已支持的技术栈清单
│   │   ├── ue.js             #   UE：build_out.log / Saved/Logs / 自检 / 产物
│   │   └── node.js           #   Node 前端构建：捕获 stdout / 合并控制台 / dist 产物
│   ├── runner.js             # 通用进程运行器（bat / 命令行，GBK 容错，输出落盘）
│   ├── parsers.js            # 编译、UE日志、Node构建、自检四段解析正则
│   └── collectors.js         # Tailer（轮转安全）+ 四个采集器
├── web/                      # 监控页面（手机浏览器直接访问）
│   ├── index.html  app.js  style.css  manifest.webmanifest  icon.svg
│   ├── highlight.js          # 产物详情的语法高亮（零依赖手写 tokenizer）
│   ├── guide.html            # 连接指引页（二维码 / 地址 / 体检）
│   └── qrcode.js             # 自研二维码编码器（零依赖）
├── dev-tools/qr-selfcheck/   # 二维码编码器的离线校验脚本（Python，可选）
├── site/                     # 产品官网（对外发布物，**不进分发 zip**）
│   ├── index.html            # 单文件落地页：内嵌样式与脚本，浅色/深色两套
│   ├── shots/monitor.png     # hero 用的产品截图
│   └── 工程监控-便携版-vX.Y.Z.zip  # 「下载」按钮指向的包（打包时自动同步一份）
├── runtime/                  # 自动下载的便携 Node.js（可能不存在）
│   └── logs/<工程 id>/       # Node 类工程的构建归档 + run.log（不进分发 zip）
├── dist/                     # 分发包 + 打好的 APK
└── android/                  # Capacitor 生成的原生工程
    ├── local.properties      # 指向本机 SDK 路径（不进分发 zip）
    └── app/src/main/java/com/shuaiguo/devmonitor/
        ├── MainActivity.java  # 配置页 + 预检 + WebView 壳 + 诊断日志
        ├── ErrDialog.java     # 可复制的错误弹窗
        └── Glass.java         # 原生侧的玻璃拟态近似
```

改端口或工程目录：双击 `首次配置.bat`（或手改 `config.json`），不用碰代码。

---

## 分发：打一个别人能直接用的包

```bash
打包分发包.bat            # 或 node bin/make-dist.js
node bin/make-dist.js --list      # 只看会打进哪些文件
```

产物：`dist/工程监控-便携版-v<版本>.zip`。

**刻意排除**：`config.json`（你本机的路径对他没用，还会盖掉他向导的结果）、
`runtime/`（便携 Node，几十 MB）、`node_modules`、`package-lock.json`。

<!-- >>>APK-ONLY -->
**APK 相关的一切都不进分发包，而且不是"文件没带、代码还在"**：
`android/`、`build_apk.bat`、`capacitor.config.json` 不进包；
`server.js` 里的 `apkInfo()` 与 `/apk` 路由、`guide.html` 的下载卡片与前端分支、
`package.json` 的 `@capacitor/core` 依赖、两份文档里的 APK 章节 —— 都会被**物理裁掉**。

做法：源码里用成对标记圈出 APK 专属片段
（`.js` 用 `// >>>APK-ONLY` … `// <<<APK-ONLY`，`.md`/`.html` 用 `<!-- >>>APK-ONLY -->` … `<!-- <<<APK-ONLY -->`），
打包时按标记剔除；另有单行规则处理目录树 / 表格行。
**所以本机这份永远是完整的，不需要维护两套代码**；打包结尾还有断言，
发行包里只要还残留 `apk` / `capacitor` 字样就直接报错退出。
<!-- <<<APK-ONLY -->

包内不含任何本机绝对路径，是干净的。对方解压 → 放进自己的工程 → 双击「启动监控.bat」。

> ZIP 是自己写的（`bin/make-dist.js` 里约 60 行）：Node 标准库没有 zip，
> 而 `Compress-Archive` 对中文文件名在历史版本上编码不可靠。
> 自己写就能给每个条目打上 UTF-8 标志位（通用标志 bit 11），
> 「启动监控.bat」「使用说明.md」这类中文名解压后不会变乱码。

---

## 产品官网 `site/`

对外落地页。**按参考站 `yinhu.sgguo.com` 的源码 1:1 复刻设计语言**，内容全部换成工程监控的真实功能。

```
site/
├── index.html                       单文件：内嵌 CSS / JS（约 45 KB，零外部依赖）
├── shots/shot-build.png             Hero 轮播 4 张：编译面板
├── shots/shot-run.png               运行日志
├── shots/shot-viewer.png            大图查看器
├── shots/shot-art.png               产物清单
└── 工程监控-便携版-v1.1.1.zip         「下载」按钮指向的包
```

### 设计 token（与参考站一致，改配色只动 `:root`）

| 项 | 值 |
|---|---|
| 页面背景 / 卡片 / 卡片 hover | `#f5f6f8` / `#ffffff` / `#f3f5f8` |
| 主色 / hover / 亮色 | `#1463c7` / `#0e54ac` / `#187aff` |
| 文字 三级 | `#1f2937` / `#5c6670` / `#9aa3ad` |
| 边框 | `rgba(15,35,55,.10)`，强边框 `.16` |
| 圆角 | `8px`（小元素 `6px`） |
| 阴影 | `0 10px 34px rgba(20,40,70,.08)` |
| 字体 | `"Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", ...` |
| 容器 | 正文 `1080`，**Hero 单独放宽到 `1400`** |
| Hero 两栏 | `1.05fr / 1.9fr`，gap `44px`（1440 视口下轮播盒 `842×632`） |
| 标题 | `clamp(30px, 4.6vw, 42px)` / 字重 `650` / 行高 `1.18` |

### 合作入口：贝锐蒲公英异地组网（Hero 一行 + `#remote` 卡片）

指向 `https://console.sdwan.oray.com/zh/sdwan/smartNetwork`，两处入口共用同一个品牌按钮：

- **Hero（`.hero-partner`）**：跟在三个 CTA 下面单独一行，按钮右边跟一句 12.5px 的灰色说明「出门在外也能看进度」。
  别把它塞进 `.cta` —— 那三个按钮已经占满两行，再加一个会挤成三行，且 `.hero .cta .btn` 的 52px 高度会把它顶成主按钮。
- **`#remote` 卡片**：下载区下面的一条窄卡片，左侧解释「为什么需要它」，右侧同一个按钮。

品牌还原口径：

- **品牌色 `#F31463`**：从品牌图图标纯色区取中位数得到（`rgb(243,20,99)`）；成品截图逐像素比对，最大通道差 **0**。
- **图标手绘、不引外链**：玫红实心圆 + 头部圆腔 + 左下细颈，镂空用 `<mask>` 真正挖空，
  所以露出来的是按钮底色，而不是"画一条白线"蒙混。参数写在 `viewBox 0 0 32 32` 里：
  圆 `cx=16 cy=16 r=16`；圆腔 `cx=12.9 cy=19.1 r=7`；细颈 `M8.2 23.2 → 7.8 27.6`、`stroke-width 3.3` + `round` 端帽。
  这四个数字是拿原图 36×36 做参数搜索挑出来的（圆内平均色差 **0.029**，手调值是 0.059），改之前先重跑一次比对。
- **⚠ 按钮恒为白底，深色主题也不反相**：镂空是透明的，只有压在浅底上才还原成原标识的白缺口；换深底就变成另一个标识了。
- **⚠ 图形只定义一次**：`<mask id="oray-cut">` + `<symbol id="i-oray">` 放在**单独的 `0×0` 常驻 svg** 里，
  两处都用 `<svg class="oray-mark"><use href="#i-oray"/></svg>` 引用。要加第三处，加 `<use>` 就行，**别复制粘贴**那段 SVG。
- **⚠⚠ 不能塞进页面顶部那个 `display:none` 的图标 sprite**：实测 `display:none` 里的 `<mask>` 不参与渲染树，
  Chrome 会**静默忽略**它——图标变成一个纯玫红实心圆（白色缺口没了），删掉 mask 属性后长得一模一样，控制台也不报错。
  换成 `width="0" height="0"` 的常驻 svg 就正常（sprite 里的普通 `<symbol>` 路径图标不受影响，可以继续放那儿）。
- `#remote` 卡片右侧那层 `rgba(243,20,99,.085)` 径向微光是**刻意**的，只压在按钮一侧，别铺满整块。

### 交互（都在 `index.html` 末尾一段原生 JS 里）

- **Hero 四张轮播**：3D "纸交换"进出场（`translateX` + `rotateY` + `scale`），4 秒自动播放、悬停暂停、页面切后台暂停、点圆点任意切换
- **点图放大**：lightbox 支持双指捏合（1–8×）+ 单指拖拽，右上角关闭、点空白关闭、`Esc` 关闭
- **鼠标跟随光效**：按钮与卡片内 `--mbx/--mby` 驱动的径向高光（Fluent 风格）
- **三档主题**：跟随系统 / 浅色 / 深色 —— `prefers-color-scheme` 兜底，`data-theme` 显式覆盖，`localStorage` 记忆
- **移动端**：< 900px 出汉堡菜单，< 560px 单列卡片
- **下载先看更新历史**：点任意下载按钮先弹 `CHANGELOG`（`1.1.1 / 1.1.0 / 1.0.0`），弹窗底部再真正下载
- **滚动显现**：`[data-anim]` 进视口才淡入上移 12px；`prefers-reduced-motion` 下全部关闭

**本地预览**（不要直接双击 `index.html`——`file://` 下相对路径和字体表现会有差异）：

```bash
node -e "const h=require('http'),f=require('fs'),p=require('path');h.createServer((q,s)=>{let u=decodeURIComponent(q.url.split('?')[0]);if(u==='/')u='/index.html';const fp=p.join('site',u);f.readFile(fp,(e,b)=>{if(e){s.writeHead(404);return s.end('')}s.writeHead(200);s.end(b)})}).listen(8910,()=>console.log('http://127.0.0.1:8910'))"
```

**上线**：`site/` 是纯静态目录，整个文件夹丢到任意静态托管即可（Nginx / 对象存储 / GitHub Pages / Vercel）。
下载按钮是相对链接，所以 `index.html` 和那个 zip 必须在同一层。

**同步规则**：

- `site/` **不进分发包**（`bin/make-dist.js` 的 `EXCLUDE_TOP` 里有它），它是发布物不是工具。
- 每次 `node bin/make-dist.js` 打包后，会自动把新 zip 复制到 `site/`，**下载链接不会指到旧版本**。
- 版本号写在四处：hero 元信息、下载按钮、页脚、`CHANGELOG`（弹窗），升版本时一起改，**改完搜一遍 `1.1.1`**。

**换轮播图**：`site/shots/` 里放同名 PNG 即可（建议 1200×900，4:3 正好填满轮播盒）；
换图后同步改 `<img alt>`（lightbox 的说明文字取自 `alt`）。

**改文案**：全在 `index.html` 里，按 `<!-- ===== 区块名 ===== -->` 注释分段（标题栏 / Hero / 功能 / 界面焕新 / 支持环境 / 读写边界 / 技术架构 / 下载 / 异地组网 / 页脚）。

---

## 微信小程序端 `miniprogram/`

和安卓 APK 一样，小程序也只是个**客户端**：数据全部实时从电脑上的服务取，不内置任何内容。
它不复用网页版 —— 小程序的渲染层是 WXML/WXSS，`web/` 那套 DOM 与 SSE 在微信里跑不了，
所以是按同一份 `/api/snapshot` 另写的一层原生界面。

### 它和网页版的三处硬差别

| | 网页版 / APK | 小程序 |
|---|---|---|
| 实时更新 | `EventSource` 订阅 `/api/events` | **没有 SSE** ⇒ 每 2.5s 轮询一次 `/api/snapshot`（约 30KB，只在页面可见时跑） |
| 连接地基 | 局域网 `http://` 随便连 | 正式版**只认 HTTPS + 已备案白名单域名**；开发/调试模式才允许 `http://192.168.x.x` |
| 弹窗 | 自绘（`alert` 一律不用） | 同样自绘：`.mask/.sheet` 确认条 + `.toast` 轻提示，**代码里禁止出现 `wx.showModal/showToast/showActionSheet`**（`check.js` 会判失败） |

### 外观：和网页版是同一套皮肤

不是"风格相近"，是**同一组数值**：`web/style.css` 的每个尺寸 ×2 就是 WXSS 里的 rpx
（750rpx=屏宽，1px=2rpx），颜色、圆角、字号、阴影一字不改地搬过来。

| 网页版 | 小程序 | 说明 |
|---|---|---|
| `.glass`（152° 白渐变 + `rgba(18,18,18,.42)` + 上缘 1.5px 近纯白高光 + 低位长投影） | `.card` 同一份配方 | 卡片是三层的，少一层就变"扁平深色块" |
| `.glass::before` 1px 渐变亮边（mask 挖空） | `.card::before` 1rpx，同一套 `mask-composite` | 不认 mask 的机型会退化成一圈很淡的白边，字仍清楚 |
| `#projbar` 工程胶囊（圆点 + 名称 + 引擎标签） | `.projbar/.proj/.pd/.kb` | 小程序常驻，右侧多了「设置」入口 |
| `#tabbar` 浮动玻璃胶囊 + `#tab-glider` 滑块 | `custom-tab-bar/` 组件 | `app.json` 里 `tabBar.custom: true`；滑块用 `translateX(选中项×100%)` |
| `.badge`（糖玻璃徽标）/ `.tag`（10px 小标签） | `.badge` / `.tag.blue|red|green|teal` | 编译归档的成功/失败走的是 `.tag`，不是 `.badge` |
| `.logbox`（卡内"井"：更暗、内阴影、等宽 11.5px） | `.logbox` 23rpx + `inset` 阴影 | 运行页的 `.logbox.big` 通栏玻璃也是同一个做法 |
| 三个等宽操作按钮 `.b-btn` | `.b-actions .btn` | 开始编译 / 复制输出 / 完整日志 |

#### 逐像素对齐：量过的那些数

拿 `preview.js` 生成的页面和 `http://127.0.0.1:8787/` 在同一视口（375×812）下逐元素量
`getBoundingClientRect()`，判据是**两边相等**，不是"看着差不多"。当前对得上的：

| 元素 | 网页版 | 小程序 |
|---|---|---|
| 底部胶囊 `#tabbar` | 353×66，圆角 34 | 353×66，圆角 34rpx |
| 编译状态卡 `.hero` | 353×180.9 | 353×181.3 |
| 进度条 `.progress` | 高 10 | 高 10 |
| 徽标 `.badge` | 高 26 | 高 26.2 |
| 编译页日志井 `.logbox` | 321×373.5 | 321×373.5 |
| 运行页大日志 `.logbox.big` | 353×602 | 353×604.6 |
| 筛选胶囊 `.chip` | 57×32，padding 7/15 | 57×32.9，同一 padding |
| 自检磁贴 `.tile` | 171.5×79.9 | 171.5×83 |
| 产物行 `.item`（非截图） | 321×41 | 325×41 |
| 日志行（字体/行高/每条高度） | 11.5px / 18.975px / 58.91 | 完全相同 |

差 1～3px 的那几行来自 rpx→px 的取整和行的上下留白，肉眼不可分。

**对齐时踩到的四个坑**（改样式前先看这几条）：

1. **`view` 默认 `content-box`**。`.progress` 写 `height: 20rpx` 再加 1rpx 边框，实际是 12px 而不是 10px；
   `.log` 写 `height: 46vh` 会额外多出 18px 内边距 —— 这两处和 `.btn` 都显式加了 `box-sizing: border-box`。
2. **全局 `line-height: 1.55` 会撑高小号元素**。网页那些 12px 的徽标/计数行是 `normal`，
   照搬过来会各自高 2.6px；`.badge` / `.counts` / `.card-h` / `.chip` 都单独压回 1.35。
3. **胶囊上不能带计数**。网页的 `renderChips` 只出文字；给它补上「全部 120」这种角标后，
   「警告 / 错误」被挤得换行，四枚就不在一排了 —— 现在的写法与网页一字不差。
4. **产物行只有「截图」分组有缩略图**（网页判 `i.group === '截图'`，不是判扩展名）。
   给 JSON 补一个 40px 的扩展名方块会让行高从 41 变成 63，整列密度差一档。

**格式也要抄**：产物行的时间用服务端下发的 `mtimeText`（带秒，`10-21 11:31:25`），
不是 `fmtTime()`（只到分）；体积用网页那套 `13.0 KB` / `1.30 MB`（KB 恒一位、MB 恒两位）——
`13 KB` 和 `13.0 KB` 在列表里就是两种密度。

**唯一的刻意差异**：网页靠 `backdrop-filter` 做透光，小程序只有页签那层加了模糊
（它浮在滚动内容上，不模糊会串字）；卡片下面是静态渐变，模糊看不出效果，省掉这一步更省电。
另外三处是移动端才有的取舍：工程条右侧的「设置」入口、多出来的「档案」tab（网页没有云端档案页）、
以及「长按日志区复制当前筛选」这个手势（网页是按钮，放进来会把四枚胶囊挤成两排）。

底部页签是自绘的，所以每个 tab 页 `onShow` 里必须写
`shell.syncTab(this, shell.TABS.xxx)`，否则切过去时高亮还停在上一个页签（`check.js` 会查这一条）。

### 目录

```
miniprogram/
├── app.js              全局快照 + 轮询 + 订阅（页面不发请求，只读这里）+ 归档变更上报云端
├── app.json            tabBar.custom = true；编译/运行/自检/产物/档案 五个 tab
├── app.wxss            设计令牌 + 玻璃基元（数值来源见上表，改配色只动这里的 :root 段）
├── custom-tab-bar/     浮动玻璃页签（外圈胶囊 + 内嵌滑块，对齐网页 #tabbar）
├── package.json        ⚠ 只为声明云服务 SDK 依赖；改完要「构建 npm」或重跑 dev-tools/…/sdk.js
├── miniprogram_npm/    SDK 的已构建产物（等同开发者工具「构建 npm」的结果，已入库）
├── utils/api.js        wx.request 封装；把「域名校验失败」翻成人话
├── utils/shell.js      页面外壳：工程胶囊条 + 页签选中态（五个 tab 页共用）
├── utils/cloud.js      云服务：邮箱登录 + 配置同步 + 构建档案（唯一初始化 SDK 的地方）
├── utils/buildrec.js   快照里的编译归档 → 云端一行的映射（build_key 必须稳定，见文件头）
├── utils/workbuddy-cloud-diagnostics.js  SDK 请求失败诊断（打 vConsole，官方提供）
├── utils/fmt.js        秒/字节/时间格式化（纯函数）
├── utils/toast.js      自绘轻提示
├── pages/compile       状态卡 + 进度 + 最近输出 + 编译归档（含停止确认）
├── pages/run           通栏玻璃日志 + 分类筛选（UE: 剧情/警告/流送，Node: 构建/运行）
├── pages/suite         自检：汇总卡 + 两列磁贴
├── pages/art           产物清单（分组 + 缩略图，单行「名称 · 分组 · 时间」）
├── pages/archive       云档案：登录后的构建历史 + 统计 + 补录 / 删除
├── pages/login         邮箱验证码登录（不登录也能看实时数据）
├── pages/detail        文本预览 / 图片查看 + 保存到相册
└── pages/setup         服务器地址 + 连接体检 + 工程切换 + 云端同步
```

### 怎么跑起来

1. **电脑上先起服务**：双击 `启动监控.bat`，控制台会打印手机该用的地址（例：`http://192.168.3.225:8787`）。
2. **开发者工具**：导入 `miniprogram/` 目录（AppID 选「测试号」即可）。
   `project.config.json` 里已经预置 `"urlCheck": false`，等价于勾上「不校验合法域名…」——
   否则 `wx.request` 会以「url not in domain list」直接失败。
3. **真机**：预览二维码扫码后，右上角「…」→ **开发调试** 打开，才允许访问 `http://` 局域网地址。
4. 进「设置」页填地址 → 保存并连接 → 会列出这台电脑的所有网卡地址，点一下就能换。

> 想在微信里**长期使用（正式版）**，得给这台电脑套一个已备案的 HTTPS 域名反向代理，再把域名填进去。
> 这是微信平台的规则，不是本工具的取舍 —— 局域网 IP 永远进不了小程序的正式版。

### 云服务：登录 / 云档案 / 配置同步

`miniprogram/` 这一套接了 WorkBuddy 云服务（应用 `wbapp_oOTtyXoIEQ6LKXUbH0t8yr`，环境已开通）。
云服务**不是全站门槛** —— 不登录照样能看实时数据，它只解决两件本机解决不了的事：

| 能力 | 存在哪 | 为什么需要 |
|---|---|---|
| 配置同步 | `dm_connection`（一人一行） | 换手机 / 清缓存后不用重新填电脑地址 |
| 构建档案 | `dm_build`（一次编译一行） | 电脑上的 `BuildLogs` 会被轮转吃掉，云端留一份可回看的记录 |

**登录方式 = 邮箱验证码**（`utils/cloud.js`）。没用微信一键登录，是因为那需要「已授权绑定的小程序账号 +
微信登录开关」，本应用还没绑定，现在接上去点了只会报未打开；邮箱 OTP 是小程序侧的默认通道。

**三条链路**（都在 `app.js`）：

1. 登录成功 → 本机有地址就推上云（`afterSignIn`）；
2. 冷启动发现本机没地址、但已登录 → 从云端拉回来（`restoreFromCloud`）；
3. 轮询里发现**最新归档变了** → 追加一条档案（`_watchArchives`）。

> ⚠ 档案的 `build_key` 只能用「工程 + 归档名」算（`utils/buildrec.js`）。
> 不要退化成「拿当前时间凑一个 key」：实时上报和事后补录会算出两个不同的 key，
> 同一次编译就变成两行。启动后的第一份快照只当基线、不当历史补 —— 历史靠「从电脑补录」。

**怎么验**：开发者工具 → 底部「档案」tab → 登录（发码 → 收码）→ 登录后会自动把电脑上现成的归档补上来，
统计卡和列表应该立刻有数。设置页会多出「云端同步」一块，能看到当前账号、退出登录。

> 正式版要**先发布**：云服务网关域名是发布流程才写进微信的 request 白名单的。
> 开发者工具里能直接用，是因为 `project.config.json` 预置了 `"urlCheck": false`。
> 邮箱通道（Provider）的开关不在代码里；首次「获取验证码」若报错，先看管理面板里的邮件通道状态。

**改云相关代码时**：

- 唯一的 SDK 初始化在 `utils/cloud.js`，`endpoint` / `publishableKey` 只能来自开通时下发的 `publicConfig`，
  **不要**改写成别的域名，也**不要**自己拼 `wx.request` 打 `/.cloud/**`（会绕过签名和会话）。
- 所有读写都靠数据库 RLS 按 `owner_id` 隔离；前端**绝不能**传 `owner_id`，也不要自己判「这行是不是我的」。
- 升级 SDK：改 `miniprogram/package.json` → `npm install` → `node dev-tools/miniprogram-check/sdk.js`
  （等价于开发者工具里点「构建 npm」，但那个只能手点）。

### 改小程序端要注意

- **别在页面里直接 `wx.request`**：数据统一走 `app.js` 的 `subscribe()`，否则轮询会翻倍、状态会打架。
- **日志/列表用签名判断 `setData`**：快照每 2.5s 来一次，200 行日志整包 `setData` 会让滚动卡死；
  `build.js` / `run.js` / `art.js` 都按「条数 + 末行/首条指纹」比对，没变就不下发。
- **列表里的行间距别用空格排版**：WXML 编译期会吃掉标签之间的空白，
  `LogFoo:` 和正文会黏在一起 —— 一律用 `margin-right`。
- **别写 `calc(100vh - 300rpx)`**：`rpx` 混进 `calc` 在部分基础库上算不出来，高度会塌成 0。
- **动态类名要防撞名**：日志行的 `kind` 就叫 `step`，写成 `.l.step` 会直接命中页面里那个
  `.step`（17px 标题）—— 整块日志被撑成 17px，一行只放得下二十几个字符。现在统一加 `k-` 前缀。
- **新加 tab 页要三件套**：`custom-tab-bar/index.js` 的 `TABS`、`app.json` 的 `tabBar.list`、
  页面 `onShow` 里的 `shell.syncTab(this, shell.TABS.xxx)`，缺一处就是「点了没反应 / 高亮不动」。
- **目录名不能叫 `build`/`dist`/`out`/`tmp`/`temp`/`coverage`**：上传前打 zip 的那段代码会跳过这些
  目录（大小写不敏感，就是给网页工程滤构建产物用的），页面撞名就会出现「本地跑得好好的，
  一发布就报 `app.json: ["pages"][0] could not find the corresponding file`」。
  首个页面因此从 `pages/build/` 改名为 `pages/compile/`，`check.js` 里加了 6 条发布体检专门盯这个。
- 改完先跑 `node dev-tools/miniprogram-check/check.js`（204 项基线）再看真机；
  想看版式又懒得开开发者工具，跑 `preview.js` 生成 HTML 截图。
- **云相关改动必须过 `check.js` 的云段落**：它用真 SDK + 打桩 `wx` 验「未登录不写库 / 邮箱先本地校验 /
  RLS 拒绝有中文提示」，并把 `cloud` 换成假的验档案页的统计、筛选、删除确认。
  自检里**不会**真的打云服务网关（`/.cloud/**` 的请求一律 fail），那是刻意拦的。

---

<!-- >>>APK-ONLY 打包分发包时整章剔除（见 bin/make-dist.js） -->

## 打包成安卓 APK

APK 只是个**壳**——监控内容不打包在安装包里，全部实时从电脑端服务取。所以手机和电脑必须在同一局域网，或用蒲公英组网连起来。

### 首次使用

1. **电脑端启动服务**：双击 `start.bat`，记住它打印的局域网地址（如 `192.168.3.225:8787`）
2. **安装 APK**：把 `dist/工程监控.apk` 传到手机点击安装（需允许"安装未知来源应用"）
3. **App 首次打开**：输入电脑地址 → 点「连接」。地址会记住，以后直接进入监控页
4. 地址填错或换网络了，点右上角「设置」改

### 连不上时的自诊断（每一步都有弹窗）

点击「连接」后，App **不会直接开 WebView**，而是用 `HttpURLConnection` 先探一次
`http://<地址>/api/snapshot`（6 秒超时），把「连不上」拆成能直接照做的原因：

| 情况 | 弹窗标题 | 实际含义 |
|---|---|---|
| `UnknownHostException` | 地址无法解析 | 手机系统不认识这个地址（打错字/多空格） |
| `ConnectException` | 端口没有服务在听 | IP 对，但电脑端服务没启动 |
| `SocketTimeoutException` | 连接超时 | 服务没开 / 不在同一网络 / 防火墙拦 8787 |
| HTTP 404 | 路径不对 | 端口上跑的不是 dev-monitor |
| HTTP 200 但响应体不是快照 | 服务存在但接口不对 | 同上，端口被别的服务占了 |
| 其他异常 | 连接失败 | 复制详情给我 |

预检通过才进监控页。之后 WebView 层的失败（`onReceivedError` / `onReceivedHttpError` /
`onReceivedSslError`）也各自弹窗，并把 **WebView 错误码翻译成人话**
（`-6` = 拒绝连接、`-8` = 超时、`-13` = 渲染进程被杀…）。

每个弹窗都有四类按钮：`复制详情` / `重试` / `改地址` / `关闭`。

**复制的格式**（直接粘贴即可）：

```
【工程监控】连接/加载异常
时间: 2026-10-16 17:35:16
设备: Xiaomi 23127PN0CC / Android 15 (API 35)
问题: 端口没有服务在听
原因: 192.168.3.225:8787 能路由到，但该端口没有进程监听。
建议: 说明 IP 大概率是对的，是电脑端服务没开。双击 dev-monitor\start.bat ...
诊断详情:
目标: http://192.168.3.225:8787/api/snapshot
主机: 192.168.3.225
结果: 端口拒绝连接
异常: ConnectException: Connection refused
```

### 诊断日志面板

任意页面点「**诊断**」（监控页右上角）或「**查看诊断日志**」（配置页），
弹出最近 200 条事件，可整份复制。记录内容包括：启动、地址预检、页面加载起止、
WebView 错误、**页面里的 JS 报错**（`onConsoleMessage`，白屏时靠它定位）。

### 重新构建

```bash
build_apk.bat
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`

### 构建环境（本机已配好）

| 组件 | 版本 / 路径 |
|---|---|
| JDK | 21.0.8（系统已装，满足 AGP 8.2.1 的 17+ 要求） |
| Android SDK | `E:/AndroidSDK`（非默认位置，靠 `android/local.properties` 声明） |
| compileSdk | 34（build-tools 34.0.0） |
| Capacitor | 6.x |

### 两个必须记下的坑

**① Gradle 官方源在这台机器上连不通。** `services.gradle.org` 与 `dl.google.org` 的 Maven 端点实测超时（HTTP 000），已改用：

- Gradle 发行版 → `https://mirrors.cloud.tencent.com/gradle/`
- Maven 依赖 → `https://maven.aliyun.com/repository/google` + `/public`

改这两处分别在 `android/gradle/wrapper/gradle-wrapper.properties` 和 `android/build.gradle`。换到能直连的网络时可以把镜像改回去。

**② 源码含中文注释，必须显式指定 UTF-8。** Windows 下 Gradle 默认按平台编码（GBK）读 Java 源，会编译失败。已在 `android/app/build.gradle` 加 `compileOptions.encoding = 'UTF-8'`，`gradle.properties` 加 `-Dfile.encoding=UTF-8`。

<!-- <<<APK-ONLY -->
---

## 边界与安全

- **监控只读 + 编译执行**：监控数据不写工程目录；唯一可写操作是触发 `ue.buildBat`
  （服务以它的子进程身份跑编译，不修改工程内任何文件）。`config.json` 的 `allowBuild: false` 可禁用。
  工具自身只往自己目录里写三样东西：`config.json`（配置向导）、`runtime/`（便携 Node）、`dist/*.zip`（分发包）。
- **无鉴权**：这是局域网/私网工具，任何能访问该端口的人都能**看日志、触发/停止编译**。
  **不要**把它暴露到公网。需要公网访问请用蒲公英组网或加一层反代鉴权。
- **图片接口白名单**：`/api/file` 只允许读取 `_shot/`、`Saved/Crashes/` 下的 `.png/.jpg`，防路径穿越。
- **内容接口白名单**：`/api/content` 限 `Saved/`、`Crashes/`、`_shot/`、`BuildLogs/` 与两个编译日志，穿越返回 403。

---

## 后续可扩展

- **P1**：编译结束推送通知（安卓需 Foreground Service + WebSocket，国内无 FCM）
- **P2**：Token 消耗趋势（读 `workbuddy.db` 的 `session_usage`，只读）
- **P3**：`_shot/` 截图变化时自动刷新大图
- **P4**：打成原生安卓 App（WebView 壳 + 前台服务保活）
