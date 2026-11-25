# 选集 / 多 P 批量下载面板（acgx-batch）

> 目标：在 **ACGhelper 2.8.31.16 unlock（38 条补丁）** 上新增「勾选整季 / 整个多 P 视频 → 一次排队下载」，
> **不改 React bundle、不改现有下载器**，现有 UI 一行不动。
>
> 状态：**已交付并实测**（headless Chrome 156 + CDP，29/29 断言 PASS，见 §9）

---

## 1. 怎么用（用户视角，3 步）

1. 打开番剧 / 影视页（`www.bilibili.com/bangumi/play/epXXXX` 或 `/ssXXXX`），或多 P 视频页（`www.bilibili.com/video/BVXXXX`）；
2. 右下角出现粉色浮按钮 **「选集下载」** → 点开面板；
3. 面板里勾选集数（`全选` / `反选` / **Shift + 点选做区间连选**）→ 选画质与音轨 → **开始下载**。

- 队列**串行**：一集下完才发下一集，状态行显示 `第 i/n 集 · 标题 · 成功 x / 失败 y · 剩余 z`；
- 失败的那一集**标红**、右侧出 **「重试本集」**，不影响后面的集；
- **暂停** = 当前这一集跑完就停发（再点开始继续）；**取消** = 立刻停发并让 offscreen 停掉在下的那一集；
- 结束给汇总：`队列结束：成功 x / 失败 y / 跳过 z`。

---

## 2. 产物清单

| 类型 | 路径 | 说明 |
|---|---|---|
| 面板（内容脚本） | `src/addons/batch/js/pages/acgx-batch.js` → `js/pages/acgx-batch.js` | 34,772 B `8823b4cc…` |
| 执行端（offscreen） | `src/addons/batch/js/pages/acgx-batch-offscreen.js` → `js/pages/acgx-batch-offscreen.js` | 14,571 B `63d052d8…` |
| 补丁规格 | `tools/feature-batch.json` | 3 条字符串补丁 + 2 条 copy |
| 应用/校验器 | `tools/apply-feature-batch.py` | `--check` / `--out`，任一锚点非 1 即零写入退出 |
| 真机验证 | `tools/batch-cdp-test.mjs` | headless Chrome + CDP，29 条断言 |
| 验证产物 | `build/batch-test/`（跑得起来的整棵树）、`logs/batch-*.log`、`logs/batch-panel-*.png` | |

**没碰**：`src/extracted`、`output/`（38 条成品一字节未改）、`tools/apply-all-patches.py`、
`tools/static-patchspec.py`、`tools/proto-patch-spec.json`、`tools/extra-patch-spec.json`、
`tools/feature-pgc-fix.json`、`tools/feature-webdav.json`。验证一律在 `build/` 下自己的目录里做。

---

## 3. 补丁（3 条，锚点全部在 38 条成品树上 `count==1`）

```bash
cd D:/AI-Project/逆向统一/acghelper
python tools/apply-feature-batch.py --check
```

实测输出（38 条成品树）：

```
  锚点 FB1  manifest.json            count=1  offset=5520
  锚点 FB2  html/background.html     count=1  offset=185
  锚点 FB3  js/pages/background.js   count=1  offset=71563
  [CHECK ONLY] 基准树锚点全部 count==1；未写任何文件。
```

| id | 文件 | 锚点 | 做什么 |
|---|---|---|---|
| **FB1** | `manifest.json` | `"js/pages/contentFilterMain.js"\n ] \n } \n ],`（content_scripts 数组末尾） | 追加一条 content_scripts：`bangumi/play/*`、`video/*`、`list/*`、`medialist/play/*` → `js/pages/acgx-batch.js`（`document_end`，仅顶层 frame） |
| **FB2** | `html/background.html` | `<script … src="../js/pages/background.js">` | 在 background.js **之前**插入 `<script src="../js/pages/acgx-batch-offscreen.js">` |
| **FB3** | `js/pages/background.js` | `_t(r,{command:"setPlayurlInfoByQuality",quality:n,playurlInfo:s})}};let Tt={` | 在 `St` 命令分发链**末尾**加 `acgxAutoDownload` / `acgxAbortAll` 两个分支；分支里只把 `class bt` 传给 `self.__acgxBatchAuto`，**不复制任何下载逻辑** |

**为什么锚点选这几处**：

- FB3 的锚点是路由器（`St`）的最后一条 `else if` 尾巴 + 紧跟的 `let Tt={playResX:560…}`（弹幕配置，与下载/合并毫无关系）；
  下载器本体（`bt.download*` / `Ie` / `Be` / 合并写文件）全部不碰。
- FB1 挂在 `contentFilterMain.js`（内容过滤功能）后面，FB2 挂的是 offscreen 的 script 列表 —— 都不与「下载/合并」重叠。

**与另外两位角色的可合成性（实测）**：把 `feature-pgc-fix.json` 的 4 条（全部在 `bt` 的下载/合并代码里）先打到 38 条成品树上，
FB3 锚点偏移从 71563 → 72071，**`count` 仍为 1**：

```
$ python tools/apply-feature-batch.py --tree build/batch-compose-check --check
  锚点 FB1  manifest.json            count=1  offset=5520
  锚点 FB2  html/background.html     count=1  offset=185
  锚点 FB3  js/pages/background.js   count=1  offset=72071
[CHECK ONLY] 基准树锚点全部 count==1；未写任何文件。
```

`feature-webdav.json` 的 manifest 锚点在 `host_permissions` 尾部（`"*://*.akamaized.net/*"\n ],`），与本规格的
`content_scripts` 尾部锚点**不重叠**；它改的 `html/config.html` / `initBackground.sw.js` 与本规格无交集。
→ 三份规格可以按任意顺序叠加（建议：38 条成品 → pgc-fix → webdav → batch）。

---

## 4. 架构与数据流

```
┌─ 页面（www.bilibili.com/bangumi/play/epXXXX …） ──────────────────────────┐
│  acgx-batch.js（ISOLATED world，Shadow DOM 面板）                          │
│    ① fetch 同源 API 拿集数（自带 cookie）→ 列表/勾选/队列                   │
│    ② 每集串行发 chrome.runtime.sendMessage({to:"offscreen", …})           │
│    ③ onMessage 收 {target:"acgxBatch", command:"itemDone"}                │
└───────────────┬──────────────────────────────────────────────▲───────────┘
                │ runtime.sendMessage                            │ tabs.sendMessage
                ▼                                                │（SW 把 to:"targetTab" 转成 tabs.sendMessage）
┌─ offscreen 文档（html/background.html） ──────────────────────┴───────────┐
│  acgx-batch-offscreen.js   self.__acgxBatchAuto(msg,sender,res,bt)        │
│    new bt(url, tabId) → await bt.init() → 读 bt.downloadOptionData        │
│    → 按 qn/audioQn 选索引 → 拼选项串 → await bt.download(opt,…)           │
│    → 监听 complete / error / completeByManualStop → 回执 itemDone         │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ background.js 的 St 路由（FB3 新增的两个分支）
                ▼
        js/pages/background.js  里原有的 class bt（下载器本体，原样复用）
```

**为什么用「内容脚本 + Shadow DOM」而不是改 React bundle**：bundle 是 webpack 压缩产物，改 UI 要动
`video.js`（527 KB）里的大段 JSX，回归面不可控；Shadow DOM 面板与页面样式完全隔离，
页面侧只多一个 `position:fixed;width:0;height:0` 的宿主节点（不参与文档流）。

---

## 5. 面板结构

宿主：`document.body > div#acgx-batch-host`（`position:fixed; left/top:0; width/height:0; z-index:2147483647`）
→ `host.attachShadow({mode:'open'})` → `<style>` + `.fab` + `.panel`。

```
#acgx-batch-fab          右下角浮按钮「选集下载」（面板打开时隐藏）
#acgx-batch-panel
├─ .hd                   标题 + ×（关闭）
├─ .meta                 页面类型 · 番剧名 · 「共 N 集」 + 数据源（api/… | DOM(…)）
├─ .tools                [全选] [反选] [画质▾] [音轨▾]
├─ #acgx-list            每行：checkbox | 序号 | 标题/副标题 | 时长 | 状态 | [重试本集]
└─ .ft                   [开始下载] [暂停] [取消] + #acgx-status（第 i/n 集 · 成功/失败/剩余）
```

交互：`全选/反选`；**Shift + 点某行 checkbox = 从上次点击行连选到本行**；点行任意空白也切换勾选。

### 状态镜像（给自动化 / 用户脚本）

内容脚本在 isolated world 里，主世界读不到 `window` 上的变量，所以队列状态**摊在面板元素的 `data-*` 上**：

```
#acgx-batch-panel[data-acgx-open=0|1]
                  [data-acgx-count]  [data-acgx-checked]
                  [data-acgx-running=0|1] [data-acgx-index] [data-acgx-total]
                  [data-acgx-ok] [data-acgx-fail] [data-acgx-error] [data-acgx-source] [data-acgx-message]
行：             [data-acgx-role=item][data-acgx-index][data-acgx-key][data-st=idle|running|ok|fail]
                 [data-acgx-role=check]  [data-acgx-role=retry]
```

`window.__acgxBatch`（`state()/open()/selectAll()/start()`）也保留着，但**只在内容脚本自己的 world 里可见**，
CDP / 主世界脚本请用上面的 `data-*`。

---

## 6. 数据接口

| 场景 | 请求 | 取什么 |
|---|---|---|
| 番剧（`/bangumi/play/ep*`） | `GET https://api.bilibili.com/pgc/view/web/season?ep_id=<ep>` | `result.episodes[]`（+ `result.section[].episodes[]` 花絮/预告） |
| 番剧（`/bangumi/play/ss*`） | 同上，`?season_id=<ss>` | 同上 |
| 多 P（`/video/BV*`、`/video/av*`） | `GET https://api.bilibili.com/x/web-interface/view?bvid=<BV>`（或 `?aid=`） | `data.pages[]`（`cid/page/part/duration`） |
| `/list/*`、`/medialist/play/*` | URL 里能解析到 BV/av 时走多 P 接口；否则面板直接给明确原因 | — |

- `fetch(url, {credentials:'include', cache:'no-store'})`，在内容脚本里发（扩展有 `*://*.bilibili.com/*` host 权限）。
- **兜底 1**：接口失败 → 读 `document.querySelector('#__NEXT_DATA__')`（番剧页 SSR 数据）。
- **兜底 2**：多 P 失败 → 扫内联 `<script>` 里的 `window.__INITIAL_STATE__=`（`undefined` → `null` 后 JSON.parse）。
- 时长：PGC 的 `duration` 是**毫秒**（`/1000`），UGC 的 `duration` 是**秒**；统一显示 `mm:ss` / `h:mm:ss`。
- 每集下载 URL：番剧 `https://www.bilibili.com/bangumi/play/ep<epid>`；多 P `https://www.bilibili.com/video/<bvid>/?p=<page>`
  （与插件原有 `initDownloader` 的 URL 形态一致，`bt.init()` 与 SW 的 `videoParse` 都认）。

---

## 7. 命令协议

### 7.1 页面 → offscreen

```js
chrome.runtime.sendMessage({
  to: "offscreen",
  target: "videoDownload",
  command: "acgxAutoDownload",
  url: "https://www.bilibili.com/bangumi/play/ep900001",
  qn: 0,                 // 0=最高可用；否则 127/126/125/120/116/112/80/64/32
  audioQn: 0,            // 0=默认最高可用；30250=杜比全景声；30251=Hi-Res
  timeoutMs: 1800000,    // 单集硬超时（默认 30min）
  initTimeoutMs: 90000   // 「解析视频信息」阶段的硬超时（默认 90s）
});
```

`tabId` 不用页面传：offscreen 侧用 `sender.tab.id`（内容脚本发消息时 Chrome 自动带上）。

取消：

```js
chrome.runtime.sendMessage({ to:"offscreen", target:"videoDownload", command:"acgxAbortAll" });
```

### 7.2 offscreen → 页面（回执）

```js
chrome.runtime.sendMessage({
  to: "targetTab", tabId,                       // 必须走 SW 转发，内容脚本收不到裸 runtime.sendMessage
  message: {
    target: "acgxBatch",
    command: "itemDone",
    url, ok: true|false,
    quality: 80, audio: 30280,                  // 成功时带上实际选的 qn / 音轨
    warn: "…",                                  // 软降级说明（例如「杜比全景声不可用，已回退默认音轨」）
    error: "…"                                  // 失败原因
  }
});
```

页面侧 `chrome.runtime.onMessage` 只认 `msg.target === 'acgxBatch'`，且 `url` 必须与当前等待项一致。

### 7.3 `background.js` 里的两个新分支（FB3）

```js
} else if ("acgxAutoDownload" === n) {
    const A = self.__acgxBatchAuto;
    A ? await A(e, t, i, bt) : i && i({ ok: !1, error: "ACGX_BATCH_HELPER_MISSING" });
} else if ("acgxAbortAll" === n) {
    const B = self.__acgxBatchAbort; B && B(); i && i({ ok: !0 });
}
```

- `bt` 是同一模块作用域里的 `class bt`，直接当参数传给执行端，**执行端不依赖 bundle 的内部符号**；
- `html/background.html` 里没加载执行端时（例如用户把文件删了），分支会回 `ACGX_BATCH_HELPER_MISSING`，不会静默挂死。

### 7.4 画质 / 音轨是怎么变成下载参数的（不猜内部状态）

`bt.init()` 之后 `bt.downloadOptionData` 的结构（由 `H()` 产出，两处一致）：

```
{ video: [ { label:"1080P", value: 80,                       // value = qn
             children: [ { label:"avc1", value:"avc1",        // 编码
                           children:[{label:"线路1", value:<url>}, …] },
                         { label:"hev1", value:"hev1", … } ] } ],
  audio: [ { label:"高清音质", value:30280, children:[{label:"mp4a.40.2", value:"mp4a.40.2",
                           children:[{label:"线路1", value:<url>}]}] },
           { label:"杜比全景声", value:30250, … }, { label:"Hi-Res", value:30251, … } ] }
```

`download()` 的选项串格式 = `"视频索引-编码索引-线路索引,音频索引-编码索引-线路索引"`
（与 bundle 里的 `K()` 生成、`X()` 解析的格式完全一致）；FLV 走 `downloadFLV`，只要 `"视频索引"`。

选档规则（`acgx-batch-offscreen.js`）：

- **画质**：`qn>0` 精确匹配 `video[].value`；没有则取「不高于目标的最大档」，再没有取「高于目标的最小档」；`qn=0` 取最大。
- **编码**：优先 `avc1`，否则第一个。
- **音轨**：`30250/30251` 精确匹配；缺失则按 `30280 → 30232 → 30216 → 100010 → 100009 → 100008` 回退并在 `warn` 里说明。
- `downloadOptionIndex` / `optionDataVersion` **一个都不猜**：`download(opt, void 0, void 0, void 0)`，
  `getOptionDataByVersion(undefined)` 返回当前 `downloadOptionData`，与 `startDownload` 分支同一套调用方式。

---

## 8. 队列语义

| 行为 | 实现 |
|---|---|
| 串行 | 页面侧 `await runOne(item)` 后才发下一项；offscreen 侧再加一道闸：`busyUrl` 非空且不是自己时直接回 `BATCH_BUSY` |
| 单集失败不阻塞 | offscreen 任何异常/超时都走 `finish(false,{error})` → 回执 → 页面标红继续下一集 |
| 重试本集 | 只重跑这一项（`total=1`），队列运行中点击会提示等当前集结束 |
| 暂停 | 置 `STATE.paused`，当前集结束后不再发，状态行给「已暂停：成功 x / 失败 y / 剩余 z」 |
| 取消 | 停发 + 发 `acgxAbortAll` → offscreen 对在跑的实例调 `bt.stop(选项串)` → 回执 `CANCELLED` |
| 硬超时 | 单集 `timeoutMs`（默认 30min）；解析阶段 `initTimeoutMs`（默认 90s）；`download()` resolve 后 3 分钟既无 complete 也无 error 也判失败 |
| 重复点击 | `STATE.running` 期间「开始下载」按钮 disabled |

---

## 9. 验证记录（headless Chrome 156 + CDP，真机级）

```bash
cd D:/AI-Project/逆向统一/acghelper
python tools/apply-feature-batch.py --out build/batch-test --report logs/batch-apply-report.json
node tools/batch-cdp-test.mjs          # 端口 9455，结束时按 PID 树清理 + 删 profile
```

测试怎么造现场：

1. `chrome --headless=new --mute-audio --enable-unsafe-extension-debugging --remote-debugging-port=9455 --user-data-dir=<temp>`；
2. CDP `Extensions.loadUnpacked({path:"build/batch-test"})` → 扩展 ID `nanlnpjodcajppmbemogcdoafcgkkopk`；
3. `Target.createTarget` + `Target.attachToTarget(flatten)` 新建标签页，`Emulation.setDeviceMetricsOverride(914×1415)`；
4. **`Fetch.enable` + `Fetch.fulfillRequest`**：把 document 本身和 `api.bilibili.com/pgc/view/web/season*`、
   `api.bilibili.com/x/web-interface/view*` 全部替换成 fixture —— **一个真实网络请求都不发**；
5. 走真实交互：点浮按钮 → 点全选 → 点开始下载；offscreen 侧用 CDP 订阅 `Runtime.consoleAPICalled` 读 `[acgx-batch]` 日志。

**结果：29/29 PASS**（`logs/batch-10-cdp-final.log`，原始 JSON `logs/batch-cdp-report-*.json`）

| # | 断言 | 实测 |
|---|---|---|
| ① | 面板 DOM 出现且列出 fixture 的 N 集 | `count=4`，`data-acgx-key=ep900001,ep900002,ep900003,ep900004`，DOM 行数 4 |
| ① | 每行显示时长 | `24:01 / 24:02 / 24:03 / 24:04` |
| ① | 数据来自 fetch（被 CDP 拦截） | `https://api.bilibili.com/pgc/view/web/season?ep_id=123456` 命中 1 次 |
| ② | 点「全选」后选中数 = N | `DOM 勾选数=4`，`data-acgx-checked=4` |
| ③ | offscreen 收到 N 条 `acgxAutoDownload` | 4 条 `recv url=…ep90000{1..4}` |
| ③ | offscreen 回执 N 条 `itemDone` | 4 条 `done … ok=false` |
| ④ | 队列严格串行 | 序列 `recv → done → recv → done → recv → done → recv → done`（第 i 集 done 早于第 i+1 集 recv） |
| 附加 | 多 P 场景（`/video/BV…`） | `count=3`，`keys=p1_3001,p2_3002,p3_3003`，标题 `P1/P2/P3 分段n fixture` |
| 附加 | 不改坏现有 UI | `#fixture-h1` 仍在、`#acgx-batch-host` 只有 1 个、`position:fixed`、`z-index:2147483647` |
| 附加 | 失败分支 | 4 行全部 `data-st=fail` + 4 个「重试本集」，状态行 `队列结束：成功 0 / 失败 4` |

截图（`Page.captureScreenshot`，headless，**不截主屏**）：

| 文件 | 内容 | 像素 |
|---|---|---|
| `logs/batch-panel-opened.png` | 面板打开、4 集未勾选 | 914×1415 |
| `logs/batch-panel-done.png` | 队列结束（红行 + 重试本集按钮） | 914×1415 |
| `logs/batch-panel-ugc.png` | 多 P 场景 3 个分 P | 914×1415 |

**环境自证**（每条都在日志里）：

```
[env] 命令行含 --mute-audio = true
[env] GetForegroundWindow(跑前) = 4331958|39984|chrome
[env] GetForegroundWindow(跑后) = 4331958|39984|chrome      → PASS 跑前跑后一致
[env] 本次 profile 的 chrome 进程 MainWindowHandle: 76192=0 65352=0 … （全 0）
[PASS] 前台窗口的 pid 不在本次 chrome PID 集合里（headless chrome 全程没有可见窗口）
[cleanup] 残留 chrome 进程数 = 0；profile 已删 = true
```

全程只用 `taskkill /PID <自己拉起的 chrome> /T /F` 按 PID 树清理；未调用 SetForegroundWindow / activateWindow /
SetCursorPos / mouse_event / SendInput；未截主屏。

### fixture 下为什么 4 集全部 "失败"，这是不是没跑通？

不是。fixture 里只有「集数列表」，没有真实视频；`bt.init()` → SW `videoParse` → 真去抓不存在的那一集，
必然失败。而 SW 的 `videoParse` **失败时不会回 sendResponse**（`emit(...).catch(()=>{})` 吞掉后端口一直挂着），
所以执行端用 `initTimeoutMs` 兜死（测试里把 `<html data-acgx-init-timeout>` 设成 4000ms，16.4s 跑完 4 集）。
这条正是「**单集失败必须可跳过并继续**」的实证：4 集全部失败，队列照样跑完并给出汇总。

---

## 10. 失败分支与降级

| 现象 | 面板表现 | 代码位置 |
|---|---|---|
| 不是番剧/视频/列表页 | 面板直接写「拿不到选集数据」+ 原因 | `parseRoute()` 返回 null |
| 未登录 | `接口返回 -101：未登录（请先登录 B 站账号）` | `loadPGC` 的 code 分支 |
| 番剧不存在 / 无权限 | `接口返回 -404：…` | 同上 |
| 地区限制 | `接口返回 -10403：当前地区不可看` | 同上 |
| 网络/CORS 失败 | 先尝试 `#__NEXT_DATA__` 兜底；再失败才报 `HTTP xxx` / `fetch` 错误 | `loadPGC` / `loadUGC` 的 `.catch` |
| 收藏夹/合集列表页 | `收藏夹 / 合集列表页没有单一选集数据源：请点进具体视频或番剧页后再用` | `loadData()` |
| 单集下载失败 | 行标红 + 「重试本集」，队列继续 | `onItemDone` |
| offscreen 没响应 | 30min + 60s 页面兜底超时，判失败继续 | `runOne()` 的 `guard` |
| 解析阶段挂死 | `INIT_TIMEOUT（视频信息解析）：Ns 内没有结果` | `withTimeout()` + `resolveInitTimeout()` |
| 扩展上下文失效（重载扩展后未刷新页面） | `扩展上下文不可用（请刷新页面）` | `runOne()` 的 `sent` 判定 |
| 上一集还没结束又来一集 | `BATCH_BUSY：上一集还在下载` | offscreen `busyUrl` |

**无登录态下的降级表现**（实测口径）：

- 番剧接口在无 cookie 时典型返回 `code:-101 / -404`，面板**只显示原因、不显示空列表**，开始下载按钮保持 disabled；
- 普通视频页（多 P）大多数接口不强制登录，`x/web-interface/view` 通常能正常返回 `pages[]`，**无登录也能列出分 P**；
  真正开始下载时由插件的 `playurl` 请求和码率决定成败 —— 失败会走「标红 + 重试本集」；
- 画质/音轨选到账号没有的档位时，执行端**回退到可用档**并在 `itemDone.warn` 里写明（行上不报错，只在日志/状态里提示）。

---

## 11. 怎么停用 / 回滚

| 需求 | 做法 |
|---|---|
| 只想关掉面板 | `chrome://extensions` 里换回 `output/ACGhelper-2.8.31.16-unlock`（38 条成品，无本功能） |
| 只想在某个页面不出现 | 把 `manifest.json` 里 FB1 那条 content_scripts 的 `matches` 删掉对应行，`chrome://extensions` 点刷新 |
| 完全回滚 | 不用 `build/batch-test`，继续用 `output/` 里那两个包；`feature-batch.json` 只写在 `build/` 的副本上，`output/` 一字节未改 |
| 单独禁用执行端 | 删/改名 `js/pages/acgx-batch-offscreen.js` → 面板还在但每条都回 `ACGX_BATCH_HELPER_MISSING`（不会挂死） |

重建/校验：

```bash
python tools/apply-feature-batch.py --check                                   # 只验锚点
python tools/apply-feature-batch.py --out build/batch-test                    # 生成可加载的树
node tools/batch-cdp-test.mjs                                                # 真机级验证 29 条断言
```

在别的树上叠（例：已打 pgc-fix / webdav 的树）：

```bash
python tools/apply-feature-batch.py --tree <那棵树> --check
python tools/apply-feature-batch.py --tree <那棵树> --out <新目录>
```

---

## 12. 已知限制 / 风险

1. **真实下载未在 fixture 里验证到底**：fixture 只验证「面板 → 命令 → 串行队列 → 回执」这条链；
   真正的取流/写文件走的是插件原有 `bt.download()`，本节没有改它，因此清晰度仍取决于账号权益与 `playurl` 回包。
2. **`videoParse` 失败会挂端口**（插件原有行为，非本功能引入）：所以执行端的 `initTimeoutMs` 是必需的，默认 90s；
   真实网络下正常一集解析 1–3s。
3. **offscreen 文档里 `chrome.storage` 取不到**（实测 `typeof chrome.storage === 'undefined'`，Chrome 156 headless），
   所以 `resolveInitTimeout()` 的 storage 回退分支实际不生效 —— 生效的是 `msg.initTimeoutMs`，其次是默认 90s。
   面板侧通过 `<html data-acgx-init-timeout="4000">` 覆盖（调试/自动化用）。
4. **`/list/*` 收藏夹页**只做「能解析到 BV/av 时按多 P 处理」，没有做收藏夹列表接口 —— 属于覆盖缺口，已在面板里给出明确文案。
5. **多 P 只取 `pages[]`**：合集（`/list/ml*` 的 season 结构）没有展开成「合集内所有视频」。
6. **同时只允许一集在跑**：这是刻意的（同一 offscreen 下载器会互相踩）；批量下载期间不要再用插件自带的单集下载按钮下同一个视频。
