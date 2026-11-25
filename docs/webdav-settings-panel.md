# 设置页内嵌「同步」栏（WebDAV 云同步 v2）

> 改版的一句话：**没有独立页面、没有浮动按钮**。同步设置长在 ACGhelper 自带设置页里，
> 作为左侧导航的一栏「同步」；点它，右侧内容区就是服务器配置 / 同步内容勾选 / 定时同步 / 状态与历史快照。

| 项 | 值 |
| --- | --- |
| 成品树（基准） | `output/ACGhelper-2.8.31.16-unlock`（`version_name=2.8.31.16(Beta) unlock r3`） |
| 测试树（唯一改动副本） | `build/webdav-settings-test/ACGhelper-2.8.31.16-unlock`（`output/` 全程只读：今日写入 0 个文件） |
| 新增文件 | `src/addons/webdav/js/webdav-settings-panel.js`（57995 B，sha256 `c2361502cd33f4d9…`） |
| 改动文件 | `html/config.html`（W1：换掉 v1 的浮动入口脚本）、`src/addons/webdav/js/webdav-core.js`（46574 B，sha256 `e97e24b25338ebf4…`；附加式：同步范围分组 + 401 片段） |
| 补丁规格 | `tools/feature-webdav.json` **v2**，9 条（6 copy + 3 字符串），r3 树上逐条 `count==1` |
| 用户点哪儿 | 设置页左侧导航 → 「同步」（在「全局」与「历史订单与兑换码」之间，第 10 项 / 共 12 项） |
| 真机断言 | **15/15 PASS**（8 项要求断言 + 6 项衍生断言 + 环境自证），日志 `logs/webdav-settings-assert.{log,json}` |

---

## 1. 侦察

全程 headless Chrome（`--headless=new --mute-audio --enable-unsafe-extension-debugging --remote-debugging-port=94xx --user-data-dir=<temp>`）
+ CDP `Extensions.loadUnpacked` 打开 `chrome-extension://<id>/html/config.html`，Dump 侧边导航、内容卡片、
表单控件与 CSS 变量。原始数据：`logs/webdav-settings-recon.json`、`logs/webdav-settings-recon2.json`、
`logs/webdav-settings-recon3.json`，日志 `logs/webdav-settings-recon*.log`，截图 `logs/webdav-settings-recon-config.png`。

### 1.1 页面骨架（实测 DOM）

```
#root
├─ DIV.sc-brPLxw            ← 顶部品牌条，h=75
└─ DIV.sc-bVVIoq.eFFpQS     ← 主体，h=1245，bg #f7f7f7，overflow-y:auto（真正的滚动容器）
   ├─ ASIDE.sc-dPZUQH       w=240（内含 UL → 12 个 .aside-item）
   └─ MAIN.sc-eBHhsj.fOWkBs w=697 + padding 12px 12px 12px 24px，bg #f7f7f7
      └─ SECTION.sc-hwdzOV  ← 内容卡片容器（React 管的，不碰它内部）
```

导航项结构（每个原生项都是这三层，深克隆即可 100% 复刻样式）：

```html
<ul>
  <div class="sc-gsFSXq bboFTr button aside-item [active]">
    <button class="sc-kAyceB btsfvG button-view ">总览</button>
    <div class="sc-iGgWBj eGTmNQ ripple-box"></div>
  </div>
  …
</ul>
```

### 1.2 原生样式实测值（本栏所有数值的来源）

| 元素 | 实测（getComputedStyle / getBoundingClientRect） |
| --- | --- |
| 导航项容器 `.aside-item` | 216×36，`margin 0 12px 2px`，`border-radius 6px`，`display:flex; align-items:center; justify-content:center`，`cursor:pointer`，`transition:all` |
| 导航项（未选中） | `color rgb(117,117,117)` `#757575`，背景透明 |
| 导航项（选中） | `color rgb(251,114,153)` `#FB7299`，`background rgb(250,250,250)` `#FAFAFA`（注意：**内部 button 的文字仍是黑色 `rgb(0,0,0)`**，pink 只在容器层） |
| 导航项内部 `button` | `font-size 14px`、`font-family Arial`（原生 button 不继承 Cereal，实测就是 Arial）、`padding 8px 24px 8px 12px`、`transition color .3s` |
| 内容区 `main` | `width 697`、`padding 12px 12px 12px 24px`、`background #f7f7f7` |
| 分区标题 `h2` | `font-size 18px`、`font-weight 700`、`margin 0 0 12px`、`color #000` |
| 小节标题 `h3` | `font-size 13px`、`font-weight 400`、`color #000` |
| 行标题 `p.title` | `font-size 14px`、`color #000` |
| 行说明 `p.description` | `font-size 12px`、`color rgb(66,66,66)` `#424242` |
| 行容器 `.header` | `display:flex; align-items:center`，两行内容合计 h=35（原生行内无额外上下 padding） |
| 输入框 `input.input` | 32 高、`font-size 13.3333px`、`background #fff`、`border 1px solid #ccc`、`border-radius 6px`、`padding 4px 12px` |
| 下拉 `select` | 32 高、180 宽、`font-size 12px`、`background #fff`、`border 1px solid #eee`、`border-radius 6px`、`padding 8px 28px 8px 12px`、`appearance:none` |
| 开关（自定义） | 40×22、`border-radius 20px`、关 `rgb(189,193,198)` / 开 `#FB7299`、`transition background-color .08s linear`；knob 18×18、白、`border-radius 20px`、`box-shadow rgba(0,0,0,.4) 0 1px 3px 0` |
| 复选（自定义） | 16×16、`border 2px solid rgb(132,137,144)`、`border-radius 2px`；勾选态 边+底 `#FB7299` |
| 文字按钮 `.button-view` | `font-size 12px`、`color #757575`、`padding 1px 8px`、h=26、无边框、透明底；禁用态 `color rgb(244,244,244)` |
| 配色变量 | `document.body` 上有整套 paper/google 调色板变量（`--paper-red-700 #d32f2f`、`--paper-green-800 #2e7d32`、`--paper-orange-800 #ef6c00` …），本栏的状态色直接取自这套 |

样式表清单（3 张）：`https://at.alicdn.com/t/font_1690169_6hxr570d2oh.css`（跨域，`cssRules` 读不到 → `-2`）、
`statics/iconfonts/…/iconfont.css`（70 条）、内联 `<style>`（236 条，styled-components 全在这里）。
`document.documentElement` 上**没有**自定义属性；变量都在 `body` 上。

### 1.3 三个会咬人的实测发现

1. **导航是动态的**：首次 dump 时 9 项，几秒后变成 12 项（后出现「网页内容过滤」）。说明 React 会重渲染这个 `<ul>`，
   注入节点必须能被重渲染冲掉后再补回来 → 用 MutationObserver 兜底（见 §2.3）。
2. **页面自带两个整屏弹层**：`payment-iframe-modal` 与 `edge-announcement-modal` 都是
   `position:fixed; z-index:1000000; pointer-events:auto`，`elementFromPoint(120,447)` 命中的是遮罩而不是导航项。
   → 任何真实鼠标操作前必须先像用户那样点掉它们（「我已知悉」/ × ）；自动化里同理（见 §5.1）。
3. **行标题不能乱抓**：`document.querySelector('main p')` 命中的是 12px 的欢迎语，用它当 `--acg-title-size`
   会让整栏字号小一号（第一版踩到了，截图对比后发现才改）。

---

## 2. 注入策略

### 2.1 为什么不改 React bundle

设置页本体是 `js/pages/config.js`（342 KB，React + styled-components 编译产物）。改它要重打包 + 全站回归，
而本功能只是「多一栏设置」——**DOM 注入的收益/风险比远好于动 bundle**。注入点只有两个，且都不改任何原生节点属性：

| 注入点 | 做法 | 为什么不会炸 |
| --- | --- | --- |
| 左侧导航 | 深克隆一个原生 `.aside-item`（连 `sc-*` 类名 + ripple 层一起克隆），只把按钮文字换成「同步」，插入到「全局」之后 | 类名/结构/尺寸全部是原生的 → 字号、颜色、圆角、hover、选中底纹与相邻项逐像素一致（断言 ① 实测三项全 same） |
| 右侧内容 | 自建 `div#__acg_sync_panel__` 追加到 `<main>` 末尾；激活时把 `main` 的其它子节点 `display:none !important` | 只动 `style.display`，React 不读它；激活/退出都还原 |

### 2.2 样式怎么保证「和原生一致」

两道保险：

1. **静态数值**：`cssText()` 里每个数值都来自 §1.2 的实测（不是猜的），并按 CSS 变量写：
   `font-size: var(--acg-title-size, 14px)`。
2. **运行时复读**：挂载时 `syncNativeMetrics()` 用 `getComputedStyle` 从原生节点读一遍真实值写进 CSS 变量：

```
h2                                  → --acg-h2-size / --acg-h2-weight
main .header p.title                → --acg-title-size / --acg-title-color
main .header p.description          → --acg-desc-size  / --acg-desc-color
main input.input                    → --acg-input-border / --acg-input-radius / --acg-input-size
main select                         → --acg-select-border / --acg-select-radius / --acg-select-size
```

原生主题一改，这一栏跟着改；读不到就回落到实测默认值。导航项因为整棵克隆，不需要这套。

### 2.3 与 React 共存的四条约定

1. **只在两个位置 append**：`<aside><ul>` 一个 `.aside-item`、`<main>` 一个 `div`。
2. **冲掉就补回来**：`MutationObserver(document.documentElement, {childList, subtree})` 只认「我的节点被移除」或
   「main 里没有面板了」，重挂时状态在 JS 里（`S`），UI 由 `buildPanel()` 重建 → 不丢数据、不丢日志。
   重建后的面板会按 `S.active` 恢复 `acg-on`（否则会出现「点开了却看不见」）。
3. **点原生项自动退出**：`document` 捕获阶段监听 click，命中 `.aside-item` 且不是我的 → `deactivate()`
   （还原 `display`、去掉我的 `active`），不拦原生行为。点我的项 → `activate()`，两处 listener（节点级 + 文档级委托）
   互为兜底，React 把我的 button 换掉也不会失效。
4. **离开页面清理**：`pagehide` / `beforeunload` 里断开 observer、摘掉三个 listener（click / storage.onChanged / alarms.onAlarm）。

### 2.4 顺手清掉 v1 的浮动按钮

`removeLegacyFab()` 在 boot 与每次 DOM 变更后都跑一次：

- 删掉 `#__acg_webdav_entry__`（v1 右下角 FAB）；
- 置 `window.__ACG_WEBDAV_INJECTED__ = true` → v1 的 `inject.js` 若被加载会直接 return，不再 mount。

同时 W1 补丁已把 `config.html` 里那行 `inject.js` 换成「core + settings-panel」两个脚本，
所以**正常路径下 FAB 代码根本不会被执行**（断言「外①」实测：`document.getElementById('__acg_webdav_entry__') === null`，
且全页 `position:fixed` 且文案含 WebDAV 且 `z-index ≥ 1e6` 的元素 0 个）。

---

## 3. 同步内容分组（组 → 控制器键映射）

「同步内容」不是给用户一堆 storage 键，而是**按设置大类分组**，默认全选，可逐组关闭。
分组规则写在 `webdav-core.js` 的 `GROUPS`（`first-match-wins`，最后一组是兜底），**组 → 键的映射在运行时从
`listItemNames()` 现算**——新版本冒出新的控制器会自动落进「其它」，不会出现「有设置但没被任何组覆盖 → 悄悄不同步」。

共享内存有 **76** 个控制器（实测，`logs/webdav-items-names.json`），归到 8 组：

| 组 | id | 键数 | 包含的控制器键 |
| --- | --- | --- | --- |
| 全部设置 | （开关，非组） | 76 | 打开＝不分组过滤（与 v1 行为逐字节一致） |
| 下载设置 | `download` | 6 | `cvImageDownload`, `downloadController`, `renameDownloadFile`, `videoDownload`, `videoSubtitleDownload`, `watchLater` |
| 快捷键 | `hotkey` | 2 | `liveShortcuts`, `videoShortcuts` |
| 播放页设置 | `playback` | 14 | `historyWatched`, `listenVideo`, `mainAnime`, `mainManga`, `videoAutoPlayMode`, `videoAutoPlaySpeed`, `videoAutoQuality`, `videoDanmu`, `videoGuide`, `videoHideDanmu`, `videoParse`, `videoScreenshot`, `videoWiden`, `videoWidenComment` |
| 直播设置 | `live` | 11 | `bilibiliLiveBroadcast`, `bilibiliLiveController`, `liveAutoQuality`, `liveAutoRewrite`, `liveAutoWiden`, `liveChatMode`, `liveDanmuku`, `liveEmoji`, `liveRecord`, `liveScreenshot`, `mainLive` |
| 消息推送 | `message` | 6 | `bilibiliMessage`, `customWhisperMessage`, `message`, `notificationController`, `specialAttention`, `subscriptionDynamic` |
| 白名单与过滤 | `filter` | 6 | `ad`, `chatFilter`, `commentFilter`, `dynamicFilter`, `proxyForWebsite`, `userFilter` |
| 导航与弹窗 | `ui` | 13 | `darkMode`, `language`, `mainCreator`, `mainFavlist`, `mainHome`, `omnibox`, `popup`, `popupMain`, `popupMenu`, `popupSearcher`, `quickSearch`, `redirectSSR`, `tabController` |
| 其它 | `misc` | 18 | `autoLikeCoinCollect`, `autoMedal`, `autoTakeVipPrivilege`, `bilibiliAccountController`, `bilibiliHelperAccountController`, `cat`, `clockController`, `cookieController`, `database`, `graphqlController`, `incognito`, `networkController`, `permissionController`, `requestController`, `silver2coin`, `states`, `systemDataInit`, `webRequestController` |

规则（`GROUPS[i].match`，按顺序首个命中即归属）：

```
download  /download/i, /^watchLater$/i
hotkey    /shortcuts/i                                  ← 必须排在 playback/live 前面，否则 *Shortcuts 会被吃掉
playback  /^video/i, /^listenVideo$/, /^historyWatched$/, /^mainAnime$/, /^mainManga$/
live      /live/i
message   /message/i, /notif/i, /^specialAttention$/, /^subscriptionDynamic$/
filter    /filter/i, /^ad$/, /^proxyForWebsite$/
ui        /popup/i, /omnibox/i, /quickSearch/i, /^main/i, /^darkMode$/, /^language$/, /^redirectSSR$/, /^tab/i, /^cvImage/i
misc      （无 match）＝兜底
```

**实现即「采集时按白名单过滤」**（不重写传输逻辑，只在 core 的采集入口加一层 allow）：

```js
// webdav-core.js
SCOPE_KEY = 'webdav-scope-v1'        // {all:boolean, groups:{gid:boolean}, updatedAt}
collectSnapshot(mode, {allow})        // allow=null 不过滤；数组 = 控制器名白名单
collectViaProtocol(allow) / collectRaw(allow)
currentAllow(scope)                   // 解析成允许名单
uploadSettings({allow})               // 省略 allow → 自动按 scope 解析（手点与 alarm 同一口径）
diffRemote({allow})
```

语义边界（重要）：

- 过滤只决定**往远端传什么**，不影响本地；
- `downloadSettings()` 的**覆盖前本地快照永远是全量**（`allow:null`）——回滚要能恢复一切；
- 只有真的过滤了，payload 才多一个 `scope` 段（`{allowCount, allow}`）；不过滤时载荷与 v1 逐字节一致；
- 取消某组会自动把「全部设置」关掉；把组全勾回来会自动恢复「全部」。存储里 `webdav-scope-v1` 是唯一真源，
  SW 侧 alarm 到点走 `uploadSettings()` 时读同一份 → 手点和自动同步的「同步范围」永远一致。

---

## 4. 定时语义

| 控件 | 取值 | 落库 | 生效方式 |
| --- | --- | --- | --- |
| 定时同步开关 | 开 / 关 | `webdav-config-v1.autoSync` | 开 → `chrome.alarms.create('webdav-autosync', {delayInMinutes, periodInMinutes})`；关 → `chrome.alarms.clear()` |
| 间隔 | 5 / 15 / 60 分钟 | `intervalMinutes`（其它值回落 15） | 改完立刻 `scheduleAlarm()` 重建（`periodInMinutes` 随之变化） |
| 方向 | 只上传 / 双向 / 只下载 | `autoMode` = `upload` / `bidirectional` / `download` | 到点后由 SW 的 `autoTick()` 按方向执行 |

`autoTick()` 的冲突策略（沿用 v1 已验证逻辑）：

- **只上传**：本地指纹与上次同步记录相同且远端存在 → `skipped:no-local-change`；否则上传。
- **只下载**：远端不存在 → 报错；远端指纹没变 → `skipped:no-remote-change`；否则下载。
- **双向**：两边都变 → 记 `lastResult=conflict`，**两侧都不覆盖**，等用户在界面上比对差异；
  只有单边变化才同步。

指纹口径：`settingsFingerprint(payload) = sha256(canonicalJSON({settings}))`（键递归排序、不含 `exportedAt`/版本）。
所以「同一内容 → 同一 sha256」，不会因为导出时间不同把两边都判成「变了」。

页面可见时另外挂 `chrome.alarms.onAlarm` 只做界面刷新（日志提示 + 重读状态），**同步本体只在 SW 里跑**，不重复执行。

---

## 5. 验证记录

### 5.1 环境与做法

- 树：`build/webdav-settings-test/ACGhelper-2.8.31.16-unlock`（`python tools/feature-webdav-apply.py --from output/… --out build/…` 生成）
- 浏览器：`C:\Program Files\Google\Chrome\Application\chrome.exe` 157.0.8103.79，
  `--headless=new --mute-audio --enable-unsafe-extension-debugging --window-size=914,1415 --user-data-dir=<temp> --remote-debugging-port=9455`
- 扩展加载：CDP `Extensions.loadUnpacked` → `extId=amealahbacdnnaianiklibmgebibnfnf`
- 真实鼠标：`Input.dispatchMouseEvent`（mouseMoved/Pressed/Released，**只打 headless 页面，不碰系统光标**）
- 截图：只走 `Page.captureScreenshot`
- 脚本：`build/webdav-settings-test/webdav-settings-assert.mjs`；产物 `logs/webdav-settings-assert.{log,json}`、`logs/webdav-settings-assert-env.json`
- 首次交互前先点掉页面自带的公告/支付弹层（`z-index:1000000`），否则鼠标事件全被遮罩吞掉；运行期间弹层复现则再点掉一次

### 5.2 断言结果（15/15 PASS）

| # | 断言 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| ① | 「同步」导航项在原生导航项之间，位置/字号/颜色与相邻项一致 | PASS | idx=9（前「全局」后「历史订单与兑换码」），顺序：总览｜扩展弹窗｜主站功能｜直播区功能｜特别关注｜下载｜消息推送｜网页内容过滤｜全局｜**同步**｜历史订单与兑换码｜其他；x/w 与相邻项一致=true，项间距一致=true，字号 14/14/14，颜色 `rgb(117,117,117)` 三项相同，圆角 6px，padding `8px 24px 8px 12px`，类名 `sc-gsFSXq bboFTr button aside-item` |
| ①-b | 点开后面板注入 + 原生内容隐藏 + 导航项高亮 | PASS | `panelOn=true`、`panelRect=264,87,619×1722`、`nativeDisplays=['none']`、`navActive=true`、`h2=同步` |
| ② | 四个输入框默认值 = 用户配置，密码框 `type=password` 且已预填 | PASS | `https://kurio.infini-cloud.net/dav/` / `2697986947` / 密码 16 字符已预填 type=password / `_acghelper/settings/`；4 个输入框；控件 340×32、字号 13.3333px、边框 `rgb(204,204,204)`、圆角 6px |
| ③ | 分组勾选可用：取消一组后采集 items 下降 | PASS | 全开 77 项（allow=null）→ 关「全部」76 项（allow=76）→ 取消「下载设置」**70 项**（allow=70，该组 6 键）；页面范围行「当前同步范围：70 / 76 个控制器（按分组勾选）」 |
| ③-b | 复原「全部」并落库一致 | PASS | `all=true, selected=76/76`，存储 `webdav-scope-v1.groups` 全 true |
| ④ | 定时同步开关 → alarm 创建 / 间隔重建 / 清理 | PASS | 初始 null → 打开 `periodInMinutes=15` → 间隔改 5 分钟 `periodInMinutes=5` → 关闭 null |
| ⑤ | 立即上传真实 PUT + GET 回读 sha256 一致 | PASS | `PUT HTTP 204`，`result=ok`，远端 `_acghelper/settings/acghelper-settings.json` 20684 B，本地 sha `f7dcd8b2…98c79` == 回读 sha，采集 77 模块，payload 段 `[exportedAt, extensionVersion, mode, raw, schema, settings]` |
| ⑥ | 立即下载 → `setSettingsFromCloud` 回填 > 0 | PASS | 第一次点击按钮变「确认覆盖本地」；结果 ok / 方向 download / 渠道 `protocol` / **回填 77 项** / 本地快照 2 份 |
| ⑦ | 错误密码 → 401 且页面显示服务端片段 | PASS | 401 出现在 `MKCOL _acghelper/settings/`（该服务器 OPTIONS 不校验凭据，返回 200）；片段：`401 Unauthorized … This server could not verify that you are authorized …`，页面日志行「服务端返回：401 Unauthorized …」，徽标「失败」，`lastTestResult=fail` |
| ⑦-b | 恢复正确密码后连接通过、探活即时清理 | PASS | OPTIONS 200 → MKCOL 201 → PUT probe 201 → GET 200（sha256 一致）→ DELETE `_probe` 204，耗时 7495 ms |
| ⑧ | 4 张 `Page.captureScreenshot`，每张 ≤914×1415 | PASS | `webdav-settings-01-panel-top.png` 898×1320｜`…-02-panel-upload.png` 898×1320｜`…-03-panel-status.png` 898×1320｜`…-04-panel-scope.png` 898×1320 |
| 外① | 页面上没有旧浮动按钮 | PASS | `#__acg_webdav_entry__ === null`；全页 `fixed` + 文案含 WebDAV + `z-index ≥ 1e6` 的元素 0 个；注入脚本只有 `webdav-core.js` + `webdav-settings-panel.js` |
| 外② | 远端 `_probe` 清理干净、用户 `settings.json` 完好 | PASS | `DELETE …/_probe/` 404（已不存在）、`PROPFIND …/_probe/` 404、`GET acghelper-settings.json` 200 / 20684 B |
| 外⓪ | 页面自带公告/支付弹层按用户操作点掉 | PASS | 点掉 `close-payment` + 「我已知悉」，剩余 `.modal.on` 0 个 |
| 环境自证 | headless / MainWindowHandle 全 0 / 全程未抢前台 / `--mute-audio` / 清场干净 | PASS | 焦点采样 122 次，**属主 PID 落在我这套 chrome 上的采样 0 次**；我的 chrome PID 记录到 6 个（证明采样真的覆盖到了）；`MainWindowHandle` 全 0；`--mute-audio` 在参数里；清场后 `NO_CHROME`；`_metadata` 已清 |

进度与失败率的真实情况：前 5 轮跑过 3/7、4/7、11/14、14/14，最后 15/15。中间踩到的坑都是**真 bug 或真环境问题**，
不是断言写歪（处理过程见 §7）。

### 5.3 截图

| 文件（`logs/`） | 内容 |
| --- | --- |
| `webdav-settings-01-panel-top.png` | 设置页 + 左侧「同步」选中态 + 服务器四输入框 + 同步内容分组 + 定时同步 |
| `webdav-settings-02-panel-upload.png` | 上传完成后的日志区（PUT/GET 回读 sha256 一致） |
| `webdav-settings-03-panel-status.png` | 定时同步 + 立即同步 + 状态（结果/HTTP/sha256/远端文件/本地快照可恢复） |
| `webdav-settings-04-panel-scope.png` | 同步内容分组（8 组 + 组内键数 + 「查看键」） |
| `webdav-settings-recon-config.png` | 侦察：原生设置页原样 |
| `webdav-settings-native-tab-download.png` | 对照：原生「下载」tab 的行距/字号 |

尺寸全部 898×1320（视口），远在 914×1415 的上限之内。

---

## 6. 失败分支（界面上会看到什么）

| 场景 | 面板表现 | 底层行为 |
| --- | --- | --- |
| 服务器地址不合法（非 http(s)） | 保存时日志 `✖ 保存配置 失败：服务器地址必须以 http(s):// 开头`；存储不变 | `saveConfig` 抛错，不写 storage |
| 用户名/密码错 | 「测试连接」红字：`· MKCOL … → HTTP 401` + `服务端返回：401 Unauthorized …`；徽标「失败」、`lastTestResult=fail`；上传/下载同样落 `lastResult=fail` 并记 `lastHttp` | 服务端 401；`davRequest` 不重试，把响应体带回来 |
| 网络不可达 | `· OPTIONS … → ERR` + `网络不可达：…` | `status=0`，`AbortError` → 超时文案（默认 30 s，上传/下载 60 s） |
| 父目录不存在 | `MKCOL 目录 失败：HTTP 403/409` | 逐级 MKCOL，遇 405 视为已存在继续 |
| PUT 后回读不一致 | `✖ 立即上传 失败：PUT 后回读校验失败：HTTP 200 本地 sha256=… 远端 sha256=…` | `verifyReadback` 打开时强制校验，失败即抛 |
| 远端还没有备份文件 | `下载 失败：远端还没有备份文件：…（先执行一次「立即上传」）` | `fetchRemote` 404 |
| 远端内容不是 JSON | `远端文件不是合法 JSON（前 120 字符）` | 解析失败即抛，不写本地 |
| 双向同步两边都变 | 状态徽标 `conflict`（橙色）+ `lastError`「本地与远端都发生了变化，已暂停自动同步，请手动比对差异」；弹出提示显示在 `title` | `autoTick` 不覆盖任何一侧 |
| 未授予自定义域名权限 | 日志 `权限：未授予 http(s)://xxx/* 的访问权限，无法连接该服务器` | `chrome.permissions.request`（用户手势内） |
| 核心库没载入 | 整栏静默不注入（`console.warn` 一行） | 设置页照常工作，绝不影响原生功能 |

---

## 7. 这轮踩到并修掉的坑（给后来人）

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 点「同步」没反应、面板 0×0、开关点了不动 | `buildPanel()` 在**面板还没挂进文档**时调用 `bind()`，`document.getElementById` 全返回 null → 所有监听器一个都没绑上 | `$()` 增加 `buildingRoot` 作用域查找；`buildPanel` 内 `bind()` 期间设 `buildingRoot=root` |
| 真实鼠标点「同步」完全没反应（几何正常） | 页面自带公告/支付弹层 `position:fixed; z-index:1000000` 整屏遮罩，`elementFromPoint` 命中的是遮罩 | 自动化前先像用户一样点掉弹层；运行中复现则再点一次 |
| React 重渲染把面板冲掉后「点开了却看不见」 | 重建的面板没带 `acg-on` | `ensurePanel()/remountIfNeeded()` 依 `S.active` 恢复 `acg-on` |
| 整栏字号比原生小一号 | `syncNativeMetrics()` 抓了页面第一个 `<p>`（12px 欢迎语）当行标题字号 | 改抓 `main .header p.title`（14px），并给 description 单独取色 |
| 下载成功后状态显示「sha256 不一致」 | 下载记的是**覆盖前快照**的 sha，与远端字节 sha 天生不同，比它没意义 | 下载成功显示「已回填 N 项 + 远端 sha + 覆盖前快照 sha」；只有上传才做字节级一致判定 |
| 正常的 201 响应体被当异常贴进日志 | `snippet` 无条件打印 | 只在 `error` 或 `http ≥ 400` 时贴 |
| 401 的错误行里出现 `<body><h1>Unauthorized</h1>` 原始标签 | `ensureDirs` 把 `r.text`（服务端 HTML 页）原样拼进 Error.message | 拼进 message 前先 `replace(/<[^>]*>/g,' ')` 去标签再截 200 字符；`snippetOf` 本来就去标签，两条路都对 |
| 焦点自证一开始是空断言 | PowerShell 单引号字符串里的 `` `t `` 不是转义，TSV 没分隔符 → 解析出 0 个 PID，「未抢焦点」恒真 | 用 `[string]::Join("`t", …)`；断言里强制要求「采样到的我的 PID 数 > 0 且前台属主集合非空」，解析坏了就直接 FAIL |

---

## 8. 补丁与校验

`tools/feature-webdav.json` v2，9 条（`python tools/feature-webdav-apply.py --check --tree output/ACGhelper-2.8.31.16-unlock`）：

```
W0-html            copy  html/webdav.html                              8649B  c62e6857575a2e6b…
W0-core            copy  src/addons/webdav/js/webdav-core.js          46574B  e97e24b25338ebf4…
W0-panel           copy  src/addons/webdav/js/webdav-settings-panel.js 57995B  c2361502cd33f4d9…   ← 新增
W0-page            copy  src/addons/webdav/js/webdav.js               13649B  ed760ddeeac5c34e…
W0-sw              copy  src/addons/webdav/js/webdav-sw.js             2145B  c6dc46ff94f2ee11…
W0-inject-legacy   copy  src/addons/webdav/inject.js                   4003B  d8deac6b6eee4d38…   ← 保留但不加载
W1-config-html     file  html/config.html          count=1  ← 把 v1 的 inject.js 三行换成 core+panel 两行
W2-manifest-hostperm file manifest.json            count=1  ← v1 已落地，v2 old==new 幂等复核
W3-sw-bootstrap    file  initBackground.sw.js      count=1  ← 同上（防重复 importScripts 导致 double alarm）
合计 9 条：PASS 9 / FAIL 0
```

校验输出：`logs/webdav-settings-anchors-r3.log`；应用输出：`logs/webdav-settings-apply.log`。
`W2/W3` 的 `old == new` 是刻意的：它们的状态在 r3 树里已经成立，`count==1` 用来**证明**状态成立；
真去「再插一次」会让 SW 把 `onAlarm` 注册两遍，一个 alarm 触发两次同步。

`html/config.html` 补丁后的样子（`build/webdav-settings-test/…/html/config.html`）：

```html
<script type="text/javascript" src="../js/pages/config.js"></script>
<script type="text/javascript" src="../js/vendors.bundle.js"></script>
<script type="text/javascript" src="../js/components.bundle.js"></script>
<!--<script type="text/javascript" src="../js/utils.bundle.js"></script>-->
<!-- WebDAV 云同步：设置页内嵌「同步」栏（左侧导航项 + 内容区），已取消浮动入口 -->
<script type="text/javascript" src="../src/addons/webdav/js/webdav-core.js"></script>
<script type="text/javascript" src="../src/addons/webdav/js/webdav-settings-panel.js"></script>
</body>
```

---

## 9. 回滚

### 9.1 回滚代码（三种粒度）

```powershell
# ① 只回退「设置栏」，保留 v1 的浮动入口（最小回退）
#    把 W1 的 new 换回 v1 的两行注释+inject.js，再跑一次应用器
python tools\feature-webdav-apply.py --from output\ACGhelper-2.8.31.16-unlock `
  --out build\webdav-settings-test\ACGhelper-2.8.31.16-unlock
#    （直接把 tools\feature-webdav.json 的 W1 改回 v1 内容即可；W0-panel 可以留着不引用）

# ② 整个 v2 撤回：删除新增文件 + 还原 config.html 三条锚点
Remove-Item build\webdav-settings-test\ACGhelper-2.8.31.16-unlock\src\addons\webdav\js\webdav-settings-panel.js
#    config.html 里删掉 webdav-core.js / webdav-settings-panel.js 两个 script（保留 v1 则换回 inject.js）

# ③ 连 v1 一起退回干净 r3 树：output/ 那份就是干净基准，重新复制即可
Remove-Item build\webdav-settings-test\ACGhelper-2.8.31.16-unlock -Recurse -Force
Copy-Item output\ACGhelper-2.8.31.16-unlock build\webdav-settings-test\ -Recurse
```

`output/ACGhelper-2.8.31.16-unlock` **全程只读**（本轮实测：今日 `output/` 下写入文件数 = 0）。
改动只发生在 `src/addons/webdav/`（新增/修改脚本）与 `build/webdav-settings-test/`（副本）。

### 9.2 清远端（只碰 `_acghelper/`）

```bash
# 目录探测残留（测试连接会自己删，异常退出时手动兜底）
curl -u 2697986947:******** -X DELETE https://kurio.infini-cloud.net/dav/_acghelper/settings/_probe/probe.json
curl -u 2697986947:******** -X DELETE https://kurio.infini-cloud.net/dav/_acghelper/settings/_probe/

# 连同步文件一起清（注意：这会删掉用户自己的远端备份，删前先下载一份到本地）
curl -u 2697986947:******** -X DELETE https://kurio.infini-cloud.net/dav/_acghelper/settings/acghelper-settings.json
curl -u 2697986947:******** -X DELETE https://kurio.infini-cloud.net/dav/_acghelper/settings/
curl -u 2697986947:******** -X DELETE https://kurio.infini-cloud.net/dav/_acghelper/
```

本地侧要一起清的话：

```js
// 扩展页面控制台里执行
chrome.storage.local.remove(['webdav-config-v1','webdav-sync-state-v1','webdav-history-v1','webdav-scope-v1','webdav-last-upload'])
chrome.alarms.clear('webdav-autosync')
```

历史快照里的 `pre-download` / `pre-upload` 每份都带完整 payload，恢复路径：面板「本地快照」行 →「恢复」，
或者独立页 `html/webdav.html` →「恢复上一份本地快照」。

---

## 10. 已知偏差与取舍

1. **行高**：原生单行区块 35 px 且无上下 padding、无分隔线；本栏项目多，用 `padding 6px 0` + `border-top 1px #f0f0f0`
   提高可读性（字号/颜色/控件尺寸全部对齐原生）。这是本栏唯一刻意偏离的视觉项。
2. **禁用态按钮**：原生禁用色是 `#f4f4f4`（白底上几乎看不见）；本栏改用 `#c9c9c9`，编码更清楚。
3. **确认动作不用原生 `confirm()`**：`立即下载` 与「恢复快照」都是**两段式按钮**（第一次点变成「确认覆盖本地/确认恢复」，
   4–5 秒内再点才执行）。原因：`window.confirm` 在无边界的自动化里会卡住流程，而且它是浏览器样式、和设置页不搭。
4. **`main` 子节点被 `display:none`**：进入同步栏时会隐藏原生内容区。React 不会读这个属性，退出时原样还原；
   若某次 React 重渲染把它冲掉，observer 会按 `S.active` 重新隐藏。
5. **`_metadata/`**：headless 加载扩展后 Chrome 会在树里生成 `_metadata/generated_indexed_rulesets`，
   测试脚本每轮结束会清掉（r3 基准树里的那份是更早留下的，未触碰）。
