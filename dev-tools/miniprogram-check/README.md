# 小程序端自检 / 离线预览

微信开发者工具没法在命令行里跑，所以这里用「假装自己是小程序运行时」的办法做两件事：

| 脚本 | 作用 |
| --- | --- |
| `check.js` | 把 `App` / `Page` / `getApp` / `wx` 全部打桩，真跑一遍每个页面的 js，再灌一份**真实的 `/api/snapshot`**，断言视图模型；同时做静态检查 |
| `preview.js` | 把 WXML 粗翻译成 HTML、WXSS 的 `rpx` 按 375px 屏宽折成 px，生成 `preview/*.html`，用浏览器打开就能看版式 |
| `icons.js` | 用本机 Chrome 渲染 SVG 出页签图标（常态 `#C9D2E2` / 选中 `#0A84FF`，对齐网页 `#tabbar` 的 currentColor），五个页签全量重出 |
| `sdk.js` | 命令行版「构建 npm」：把 `miniprogram_npm/` 按 `package.json` 的 `miniprogram` 字段重建一份 |

```bash
# 服务在跑就直接用它的数据；没跑会退回同目录的 snapshot.json
node bin/launcher.js --no-open          # 另开一个终端
node dev-tools/miniprogram-check/check.js
node dev-tools/miniprogram-check/preview.js
```

## check.js 能抓到什么

1. JSON 语法错、页面四件套缺文件、tabBar 图标丢失、`custom-tab-bar/` 四件套与 `tabBar.custom` 不一致、某个 tab 页漏了 `syncTab`；
2. **`bindtap="xxx"` 指向的函数根本不存在**（写 WXML 最容易犯的错：改名忘了同步）；
3. `render()` 里读了不存在的字段 → 直接抛错；
4. 用了系统弹窗（`wx.showModal` / `showToast` / `showActionSheet`）—— 本项目要求自绘，出现即失败；
5. WXML 标签不配对、WXSS 大括号不配对；
6. **发布体检**：页面目录撞上打包器的目录黑名单（`build` / `dist` / `out` / `tmp` / `temp` / `coverage` /
   `node_modules`，大小写不敏感）、页面缺 `.js/.json/.wxml`、tabBar 指向不存在的页面、自定义页签的
   `url` 指错、打包文件数超 10000 或源码超 25MB。

> 第 6 条是 2026-10-21「一直发布失败」的复盘产物。上传前打 zip 的函数固定跳过上面那些目录名
> （它本来是给网页工程滤构建产物的），而首个页面当时就叫 `pages/build/`——本地、开发者工具、
> 预览全绿，一发布微信只回一句 `app.json: ["pages"][0] could not find the corresponding file`。
> 页面已改名 `pages/compile/`，这 6 条断言就是防止再有人把页面放到叫 `build` 的目录里。

目前基线：**204 项全绿**。加页面/加按钮时先跑它，别等真机。

其中几条是「和网页版逐像素对齐」的守卫，别当摆设删掉：
`build: 计时器单位 s`（右上角是 `67.24 s`，正文标题才是 `· 67.24 秒`）、
`run: 筛选不带计数` / `art: chips 不带计数`（带计数会把胶囊挤成两排）、
`art: 非图片不占缩略图位`（否则行高 41 → 63）、`build: 工程胶囊条`、`art: 图片走 /api/file`。

## 云服务那一半怎么测的

小程序跑不了，云服务网关又**不允许**裸请求（没有 `publishableKey` + `Referer` 的请求会被网关
落到一个「链接已失效」的 HTML 页，拿它当证据会得出完全错误的结论），所以分成两层：

- **真 SDK + 打桩 `wx`**（`check.js` 前半段）：真的 require `utils/cloud.js`，断言 `publicConfig` 的两个值、
  客户端四模块齐全、未登录时 `session()` 为 `null`、未登录写库给中文错误、邮箱格式本地先拦、
  `friendly()` 能把网络错 / RLS 拒绝翻成人话。`/.cloud/**` 的请求在桩里一律 `fail`，
  **自检永远不会真的打到云上**。
- **假 `cloud` 模块**（后半段）：把 `require.cache` 里 `utils/cloud.js` 换掉，验档案页的
  统计 / 成功失败拆分 / 平均耗时 / 三个筛选 chip / 清空与长按删除的确认 / 云端为空时自动补录 / 未登录的空状态。
- **归档上报的三条不变式**：启动首帧只当基线不补历史、同一归档不重复推、未登录不推。

## preview.js 的两个坑（踩过了）

- **`page {}` 选择器**：WXSS 里 `page` 要换成 `body` 才有样式，替换时锚点必须包含「换行 + page」，
  否则 `app.wxss` 开头那段注释之后的选择器匹配不上 ⇒ CSS 变量一个都没定义，整页文字发灰。
- **自闭合标签**：`<image>` 在源码里写成 `<image></image>`，解析时若因「void 标签不入栈」而跳过，
  后面那个 `</image>` 会把**父节点**顶掉，列表会渲染成一排空行。要入栈一个占位标记。

预览只是**版式**参考：`tabBar`、`input` 占位符、`scroll-view` 的滚动惯性这些原生行为它模拟不了，
真机还是要在开发者工具里过一眼。

底部页签是 `custom-tab-bar/` 组件，预览器不解析组件 —— 它会把组件的 WXML 用
`{selected: 当前页序号, tabs: app.json.tabBar.list}` 直接渲染一遍贴到页面底部，图标换成 `file://` 绝对路径。
截图请用**视口截图**（`fullPage: false`）：`position: fixed` 的页签在 fullPage 图里会被画到文档中间，
看起来像压在列表上。
