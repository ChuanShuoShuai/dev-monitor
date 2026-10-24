# AI 提示词（直接复制给 AI 用）

把下面 **「提示词正文」** 整段复制给你常用的 AI（Claude / GPT / WorkBuddy 等），
它就能自己启动、读取、排查甚至修改这个工程监控工具，不用你再解释一遍。

> 用法建议：
> - 只想让它**帮你操作**（起服务、看日志、解读面板）→ 复制正文即可。
> - 想让它**改这个工具**（加功能、改样式）→ 在正文末尾再补一句你的具体需求。
> - 如果 AI 有文件读写能力，把「项目根目录」那行改成你机器上的真实路径。

---

## 提示词正文（以下整段复制）

````text
你是一名熟悉 Windows + Node.js + 前端 + Unreal Engine 工程的开发助手。
我将给你一个已经写好的「工程监控」小工具（dev-monitor），你的任务是按我的要求操作或修改它。

# 一、这个工具是什么

手机端实时查看工程的编译进度 / 运行实况 / 自检结果 / 产物清单。
**支持多种技术栈同时被监控**：Unreal Engine 工程（原生支持）+ Node / 前端构建（Babel、Vite、Next…）
+ 任意命令行工程（generic）。一个服务里每个工程一个适配器实例，互不干扰。
设计上的三条硬性原则，任何改动都不能破坏：
1. 零第三方依赖（不需要 npm install，只用 Node 内置模块 + 手写前端）
2. 对工程目录全程只读。唯一"写"的动作是作为子进程触发工程自己的编译脚本
3. 无鉴权，只面向局域网 / 私网，绝不暴露公网

# 二、项目根目录

dev-monitor 的根目录是：<把这里替换成你的真实路径，例如 E:/MyProj/dev-monitor>

目录结构：
  dev-monitor/
  ├── 启动监控.bat            一键启动（缺配置会自动引导）
  ├── 首次配置.bat            只跑配置向导
  ├── 下载运行环境.bat        单独下载便携 Node.js
  ├── 打包分发包.bat          打成可分发 zip
  ├── start.bat               等价于「启动监控.bat」（旧名兼容）
  ├── config.json             实际生效的配置（向导生成）
  ├── config.default.json     配置模板
  ├── 使用说明.md             面向用户的手册
  ├── AI提示词.md             本文件
  ├── bin/
  │   ├── launcher.js         启动器：查配置→起服务→开浏览器到 /guide
  │   ├── setup.js            配置向导（探测工程目录 + 写 config.json）
  │   ├── config.js           统一配置加载 + 路径派生 + 体检
  │   ├── find-node.bat       查 Node.js 运行时
  │   ├── get-node.bat        下载便携 Node.js 到 runtime/node
  │   ├── start-monitor.bat   / run-setup.bat / make-dist.bat
  ├── server/
  │   ├── server.js           HTTP + SSE + 静态 + 白名单接口（多工程路由）
  │   ├── adapters/           技术栈适配器
  │   │   ├── index.js        工厂 + 已支持清单
  │   │   ├── ue.js           UE：build_out.log / Saved/Logs / 自检 / 产物
  │   │   └── node.js         Node 前端构建：捕获 stdout / 合并控制台 / dist 产物
  │   ├── runner.js           通用进程运行器（bat/命令行、GBK 容错、输出落盘）
  │   ├── collectors.js       Tailer（轮转安全）+ 四个采集器
  │   └── parsers.js          编译 / UE 日志 / Node 构建 / 自检四段解析正则
  ├── web/
  │   ├── index.html app.js style.css   监控页（四个面板）
  │   ├── highlight.js                 产物详情的语法高亮（零依赖手写 tokenizer，见第六节）
  │   ├── guide.html                   连接指引页（含二维码、地址列表）
  │   └── qrcode.js                    自研二维码编码器（纯 JS，无依赖）
  ├── runtime/               自动下载的便携 Node.js（可能不存在）
  │   └── logs/<工程 id>/    Node 类工程的构建归档 + run.log（不进分发 zip）
  ├── dev-tools/qr-selfcheck/ 二维码编码器的离线自检脚本（Python，可选）
  └── android/ dist/         安卓壳工程（android/）与输出目录（dist/：分发包 zip + APK）
                               ⚠ dist/ 整个目录不进分发包；APK 由作者单独分发

# 三、启动 / 停止 / 验证

启动（前台，会一直占着终端）：
  node bin/launcher.js                     # 起服务 + 自动开浏览器到连接指引页
  node bin/launcher.js --no-open           # 只起服务
  node bin/launcher.js --port 8899         # 临时换端口，不改 config.json

同时开第二个实例做对比测试时一定要换端口，否则 EADDRINUSE。

环境变量（优先级高于 config.json，适合调试，不污染配置文件）：
  DM_CONFIG=<另一个 config 文件路径>
  DM_PORT=9000
  DM_HOST=127.0.0.1
  DM_ALLOW_BUILD=false

健康检查（判断服务是否真的起来了，最可靠的判据）：
  curl -s http://127.0.0.1:8787/api/health
  期望返回 JSON 且 "ok":true、"name":"dev-monitor"

重新生成配置（注意：会覆盖 config.json）：
  node bin/setup.js --yes --force
  交互式： node bin/setup.js
  指定目录：node bin/setup.js --root E:/MyProj --port 8787

# 四、HTTP 接口一览

  GET  /api/health                服务状态 + 局域网地址列表 + 各监控路径是否就绪 + 配置体检提示
  GET  /api/projects              工程列表 + 状态摘要（切换栏状态点靠它轮询）
  GET  /api/snapshot              全量快照：config / build / buildRunner / ueLog / suite / artifacts / run
                                  多工程时带 ?project=<id>；省略取默认工程（第一个目录存在的）
  GET  /api/events                SSE 事件流，服务端 700ms 轮询磁盘，有变化才推；每条事件带 project 字段
  POST /api/build/start           触发编译（UE 走 bat 且必须带 nopause；Node 直接跑 buildCmd）
  POST /api/build/stop            taskkill /T /F 杀整棵进程树
  POST /api/run/start|stop        启停 runCmd（只有 Node 类工程有）
  GET  /api/build/output          编译进程的直接输出
  GET  /api/content?p=<绝对路径>  读产物详情，白名单按各工程分别校验（UE 的 Saved/_shot/BuildLogs、
                                  Node 的 runtime/logs/<id>/ 与 dist/）
  GET  /api/file?p=<绝对路径>     读图片，白名单限 _shot/、Saved/Crashes/
  GET  /guide                     连接指引页（含二维码）
  GET  /apk                       下载安卓壳 APK（dist/ 里有才可用）

拿编译状态：
  curl -s http://127.0.0.1:8787/api/snapshot | jq '.build | {status,step,total,label,result,seconds,errors,warnings}'

# 五、配置：只需理解两个字段

config.json 有两种写法，加载后都归一到 cfg.projects 数组：
  ① 单工程（老写法）：ue.workspaceRoot / ue.projectRoot / ue.projectName
  ② 多工程：projects[]，每项带 kind
       kind=ue      认 workspaceRoot / projectRoot / projectName
       kind=node    认 root / buildCmd / runCmd / distDir（buildCmd、runCmd 留空会自动探测）
       kind=generic 同 node，任何命令行工具

UE 工程真正需要人填的只有：
  ue.workspaceRoot   放编译脚本 / BuildLogs / _shot / .workbuddy 的那一层目录
  ue.projectRoot     有 .uproject 的那一层目录（决定 Saved/Logs）
  ue.projectName     UE 工程名（决定 Saved/Logs/<工程名>.log）

注意这两个目录**可能不是同一个**：常见形态是"工作区根"下面再套一个 UE 工程目录。
其余路径（savedDir / ueLog / crashesDir / buildBat / buildOutLog / buildErrorsLog /
buildLogsDir / shotDir / suiteOut）留空时由 bin/config.js 的 buildPaths() 自动派生。
派生规则写在 bin/config.js，改规则就在那里改，不要在别处散落硬编码路径。

# 五之二、新增一门技术栈

1. 写 server/adapters/<kind>.js，实现：prime() / poll() / snapshot() / brief() /
   describe(match, allowBuild) / startBuild() / stopBuild() / imageRoots() / textRoots()
   （有运行命令再加 startRun() / stopRun()）
2. 在 server/adapters/index.js 的 createMonitor() 里登记
3. server.js 与 web/ 都不用改（前端只认 config.kindLabel / storyFilters 这几个描述字段）
4. 若新栈的产物里有源码类文件，想要语法高亮只需在 web/highlight.js 的 EXT_LANG 里
   把扩展名映射到已有语言（js/css/html/json）；要支持全新语言才需要往 RULES 补规则。
5. **能力差异一律走 describe() 的字段，前端不许按 kind 硬猜**（已有：`hasSuite` / `canRun` /
   `storyFilters` / `allowBuild` / `buildOutLog`）。
   页面的自我裁剪靠这些字段驱动：没有自检数据源就给 `hasSuite:false`，前端会把「自检」标签
   整枚摘掉并自动退页，而不是留一个永远写着"暂无数据"的空面板。
   ⚠ 新增面板 / 按钮时先问一句「这个栈真的提供这份数据吗」；不提供就把入口收掉，
   光靠文案说明"暂无数据"是偷懒做法。
6. **startBuild() 必须重置采集器状态**（Node 适配器一直有，UE 适配器漏过 ⇒ 修过一次）：
   清 `status/lines/errors/warnings/result/seconds`，并把日志尾随位置跳到文件末尾
   （`Tailer.skipToTop()`，既有内容属于上一轮）。否则从点下按钮到新日志第一行到达之间，
   快照里还是上一轮的 `done / 老耗时` —— 前端会显示「编译成功 · 1.98 秒」
   （那是上一轮的），归档里却明明是「进行中」，还会误触发编译结束弹窗。
   进程起得来才清；起不来要保留上一轮结果。
   另外 `poll()` 里要兜底：进程退出但日志始终没有结果行（被手动停止）⇒ 用退出码收尾，
   否则「编译中」永远挂着。

Node 类工程的口径（别照搬 UE）：
  · 构建日志不进用户工程 —— 只写 <dev-monitor>/runtime/logs/<工程 id>/build-<时间戳>.log
  · 「运行」页 = 构建输出 + runCmd 输出的合并流，category 只有 'build' / 'run'
  · 进度没有官方口径 ⇒ 用「上一次构建的实际步数」当总数（自校准），别硬编码
  · 重启后从最新归档恢复编译页状态，并把 restored 置 true（前端据此标注"重启前的记录"）

# 六、改代码时必须遵守的约束

1. **.bat 文件内容必须是纯 ASCII，且必须 CRLF 换行。**
   原因：cmd.exe 可能按 OEM 代码页解析 bat 文本，中文会乱码；
   LF-only 的 bat 里 goto 标签可能跳错位置。
   所以：中文提示一律由 Node 打印（Node 在 Windows 控制台走 WriteConsoleW，Unicode 安全），
   bat 只做流程编排 + 英文消息。文件本身可以是中文名（文件名没问题）。

2. **前端零依赖**：不要引入 npm 包、不要用 CDN、不要用 ES module import。
   web/ 下就是原生 HTML/CSS/JS，直接 <script src> 加载。
   产物详情的语法高亮同理 —— 高亮器是 `web/highlight.js` 里手写的 tokenizer
   （`RULES` 一张表 + 合并成命名分组的正则），**不要换成 Prism / highlight.js**。
   加一门语言 = 往 `RULES` 加一组规则 + 在 `EXT_LANG` 里登记扩展名。
   两条铁律：
   - 正则只跑在**原始文本**上，逐 token 转义后再拼接。在 `esc()` 之后的文本上跑正则，
     会因为 `"` 已变成 `&quot;` 而**永远匹配不到字符串和键**（旧实现就栽在这，JSON 只染了数字）。
   - 规则里的子表达式一律写 `(?:...)`：编译时外层会包 `(?<gN>...)`，内部再有捕获分组会打乱索引。

   **前端交互的两条硬约束：**
   - **禁用 `alert()` / `confirm()` / `prompt()`**。一律用自绘组件：
     轻提示 `toast(msg, 'bad')`、确认框 `await ask(title, msg)`（返回 Promise）、
     结果卡片 `showBuildDone(b)`。系统弹窗在 WebView 里样式完全不可控、阻塞渲染，
     移动端还会被当成页面弹的小广告。层级：查看器 60 < 弹窗 62 < 轻提示 70。
   - **任何「某件事完成了」的通知，判据必须区分「实时事件」和「历史重放」。**
     服务端对新连接会把历史事件整段重放（方便快速补状态），只按状态跃迁判断的后果是
     **一刷新页面就为几天前的构建弹出模态窗，把整个界面挡住**。
     参考 `observeBuild(next, live)`：用 `buildSeenRunning` 当门槛，必须"亲眼看它跑起来"
     （实时 running 事件，或用户自己点了开始）才允许弹。

   **编译进行中的判定别只看 `buildRunner.running`**：服务端从不发 `runner` 事件，
   那个字段只有快照会更新，构建跑一整轮都是 false。实时信号是 `build` 事件里的
   `status === 'running'`，两者都要认（见 `isBuildingNow()`）。

   **第三方品牌标识也不许引外链**（官网那个「贝锐蒲公英异地组网」按钮，Hero 一行 + 下载区卡片两处共用）。
   图标是手写内联 SVG：品牌色从品牌图图标纯色区取中位数（`#F31463`），
   镂空用 `<mask>` 真正挖空、不叠白色色块，这样底下的按钮底色是什么就露出什么。
   ⚠ 按钮必须恒为白底（深色主题也别反相），否则镂空会变成另一种标识；
   ⚠ **图形只定义一次**：`<mask>` + `<symbol id="i-oray">` 放在独立的 `0×0` 常驻 svg 里，
   两处 `<use href="#i-oray">` 引用，加第三处也只加 `<use>`；
   ⚠⚠ **绝不能塞进顶部那个 `display:none` 的图标 sprite** —— 里面的 `<mask>` 会被 Chrome
   **静默忽略**（图标变成纯玫红实心圆，白色缺口凭空消失，控制台零报错，删掉 mask 属性长得一模一样）。
   参数与还原口径见 README「合作入口」一节。

3. **不改工程目录**：不要写日志到工程里，不要加临时文件。需要落盘只能写 dev-monitor 内部。

4. **配置读取只走 bin/config.js**：不要在新代码里直接 JSON.parse config.json，
   否则 env 覆盖、路径派生、向后兼容全部失效。

5. **换工程要能不改代码**：任何新加的路径 / 分类名都进 config.json，
   不要写死 "LogMouseAdventure" 这类工程专有值（已有的走 match 段）。

6. **加接口要点**：
   - 读文件必须走 resolveContentWhitelisted / resolveWhitelisted 的白名单
   - 新增可写动作要在 /api/health 的 endpoints 里列出来，并考虑 allowBuild 那类开关

7. **不要用 rm -rf / del /S 之类的命令**清理目录；本工具的所有删除操作只针对
   dev-monitor 自己和它的 runtime/ 子目录。

8. **`site/` 是产品官网，不进分发包**（`EXCLUDE_TOP` 里有它）。
   它是纯静态目录（`index.html` + `shots/` + 一份下载用 zip），整个文件夹上传到任意静态托管即可上线。
   ⚠ 打包后 `bin/make-dist.js` 会自动把新 zip 复制到 `site/`，别手工往里拷旧包。
   ⚠ 官网里的版本号写在**三处**（hero 元信息、下载按钮、页脚），升版本时一起改，打包器不会代劳。

<!-- >>>APK-ONLY -->
9. **APK 相关的一切都不得进分发包**（这是硬约束，不是"文件不带"就行）。
   做法：源码里用成对标记圈出 APK 专属片段——
   `.js` 用 `// >>>APK-ONLY` … `// <<<APK-ONLY`，
   `.md` / `.html` 用 `<!-- >>>APK-ONLY -->` … `<!-- <<<APK-ONLY -->`；
   `bin/make-dist.js` 打包时按标记剔除，并排除 `android/`、`build_apk.bat`、`capacitor.config.json`，
   再删掉 `package.json` 的 `@capacitor/core` 依赖。
   ⇒ **本机这份永远完整**（`/apk` 下载、`build_apk.bat`、`android/` 都在），发行版里连路由和按钮都不存在。
   ⚠ 新增 APK 相关代码/文档时必须用标记圈起来，否则会漏进发行版；打包末尾有断言会因此报错。
<!-- <<<APK-ONLY -->

# 七、改完必须做的验收

改完任何代码，按这个顺序自检，并把结果告诉我：

1. 语法与启动
   node --check server/server.js && node --check bin/launcher.js && node --check bin/setup.js && node --check bin/config.js
   node bin/launcher.js --port 8899 --no-open        # 用别的端口起，别影响我正在用的 8787
2. 接口
   curl -s http://127.0.0.1:8899/api/health          # 期望 ok:true
   curl -s http://127.0.0.1:8899/api/snapshot        # 期望有 build/ueLog/suite/artifacts 字段
   curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8899/guide     # 期望 200
3. 页面
   curl -s http://127.0.0.1:8899/ | head -5          # 期望是 HTML
4. 配置向导（会写 config.json，确定要改再跑）
   node bin/setup.js --yes --force
   期望输出里能看到「UE 工程 / 工作区根 / 运行日志 / 编译脚本」四行，且工程目录那行是 ✅
5. 如果动了 web/qrcode.js
   必须跑 dev-tools/qr-selfcheck/ 里的脚本（见该目录 README），
   要求：矩阵与参考实现逐字节一致，且页面截图能被独立解码器读回原始 URL。
   这个编码器已经验证过，动它就是在冒"扫码扫不出来"的风险，别凭感觉改。
6. .bat 改动后
   node -e "const b=require('fs').readFileSync('启动监控.bat');console.log('ascii', [...b].every(x=>x<128), 'crlf', b.includes('\r\n'))"
<!-- >>>APK-ONLY -->
7. 打包逻辑改动后
   node bin/make-dist.js --extract ../_dist_check          # 导出裁剪后的包内容（不写 zip）
   node --check ../_dist_check/server/server.js            # 裁剪后必须仍是合法 JS
   grep -ril "apk\|capacitor" ../_dist_check/server ../_dist_check/web ../_dist_check/*.md
                                                          # 期望无输出：发行版里不该有 APK 痕迹
<!-- <<<APK-ONLY -->

# 八、故障定位顺序（照这个走，不要猜）

服务起不来：
  1) 看终端第一段报错；config 读不出来会明确说"未找到配置文件"或 JSON 不合法
  2) node bin/setup.js --yes --force 重生成配置
  3) 端口被占：换端口，或先杀占用进程 netstat -ano | findstr :8787

面板空白 / 没数据：
  1) curl /api/health 看 pathsPresent 和 notes，缺哪个文件一目了然
  2) UE 日志不上屏：确认 Saved/Logs/<工程名>.log 真的在写（游戏要先跑起来）
  3) 自检面板空：自检脚本输出文件（默认 .workbuddy/tools/_suite_out.txt）还没生成
  4) 剧情行不上高亮：日志分类名和 config.json 的 match.storyCategories 不匹配

手机连不上：
  1) 电脑本机 http://127.0.0.1:8787 能不能开 —— 不能则服务没起
  2) /api/health 里 addresses 的顺序就是推荐顺序，虚拟网卡排在后面
  3) 防火墙是否放行该端口
  4) 手机和电脑是否同一网段

编译按钮点了没反应：
  1) config 的 ue.buildBat 是否存在（/api/health 的 pathsPresent.buildBat）
  2) 脚本是否识别 nopause 参数；不识别会卡在 pause，状态永远"编译中"
  3) allowBuild 是否为 false

# 九、汇报格式

改完请按这个格式汇报：
  完成项：具体改了哪些文件、改了什么
  验证：逐条列出你实际跑过的命令和结果（不要把"应该没问题"当结论）
  风险 / 未覆盖：哪些情况你没验证、哪些是已知限制
  剩余：还需要我做什么
````

---

## 说明（不用复制这段）

这份提示词刻意写死了三类信息，避免 AI 靠猜：

1. **路径与命令都是真的** —— 命令可以直接在这个项目里跑通。
2. **约束都带"为什么"** —— 比如 `.bat` 为什么必须 ASCII + CRLF，
   AI 知道了原因才不会"优化"掉它。
3. **验收步骤可执行** —— 要求 AI 逐条贴命令输出，而不是自吹"已完成"。

想让它只做某一件事时，把第七节整段保留，再在末尾追加需求，例如：

```text
本次任务：把「产物」面板的截图分组改成两列网格，手机上一屏能看到更多。
要求：只改 web/style.css 与 web/app.js，不要引入依赖，改完按第七节自检。
```
