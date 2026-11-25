# v2 变更日志 —— ACGhelper 2.8.31.16 `unlock r2` → `r3` → **`r4`（67 条 + 8 个新增文件）**

> 本文件只讲**这一轮新增了什么、为什么、影响面多大、还剩什么问题**。
> 每条补丁的偏移与作用见 [`patch-manifest.md`](patch-manifest.md) §6；人工验收见 [`release-checklist.md`](release-checklist.md)。
> 构建：`python tools/apply-all-plus-features.py --archive-legacy`（唯一权威构建器）。
> **§0–§7 是 r2 轮的原文（保留不动）**；r3（DASH 两段）与 r4（两处 UI 改版）的增量、锚点变化与验证结论见文末 **§8**。

---

## 0. 一句话结论

v1 的 38 条补丁**一条未改**；在其上并入三路功能共 **15 条 + 7 个新增文件**，总数 **53**：
**番剧（PGC）下载不再产出 0 字节文件**、**新增 WebDAV 云同步**、**新增选集/多P 批量下载**。
两棵成品树重建、旧成品归档、8 项联合验收全 PASS（`logs/v2-01…v2-10`）。

| 项 | v1 | v2 |
|---|---|---|
| 补丁总数 | 38 | **53**（38 + 4 + 8 + 3） |
| 新增文件 | 0 | **7**（webdav 5 + batch 2） |
| 成品树文件数 | 85 | **92** |
| `version_name` | `2.8.31.16(Beta) unlock` | **`2.8.31.16(Beta) unlock r2`** |
| `unlock.zip` sha256 | `a1f68d95…16d6` | **`cdd13bb5…e2d2`**（3,723,135 B） |
| `unlock-sameId.zip` sha256 | `08b78d5a…a998` | **`f53eb6a7…ec12`**（3,723,346 B） |
| 树指纹（unlock / sameId） | `2bd59f70…e274` / `32f59c24…4e15` | **`0531942b…6444`** / **`a685a8f1…803c`** |

---

## 1. 番剧下载 0 字节修复（4 条 · `F1`–`F4`，全在 `js/pages/background.js`）

### 1.1 现象
番剧（PGC）页点下载，进度条走到 100%，产物却是 **0 字节**（文件被创建出来了，但里面什么都没有）；
UI 上要么没有任何错误，要么只有一句没有信息量的「处理失败 / 下载失败」。

### 1.2 根因（三层叠在一起）
1. **形态判错**：PGC 的 `durl` 回包有**两种形态**——真 FLV，以及**整段 MP4**（实测 `preview=1`、`format=mp4`、
   `url` 形如 `...-1-16.mp4`）。代码只按 `isFLV: durl && !dash` 判形态，不看 `format`、也不看字节。
2. **送错合并器**：MP4 形态被送进 FLV 合并器 `Ue`。`Ue` 先判 `indexOf('ftyp',0,5)`、再判 `indexOf('FLV',0,1)`，
   而真 bilibili MP4 的 `ftyp` 在偏移 **4**（前面是 4 字节 box size）→ 两个判据都不命中 → 抛
   `INVALID_FLV_HEADER`（错误的FLV文件头）；若首段以裸 `ftyp` 开头则抛 `FLV_IS_MP4`。
3. **错误被吞**：抛出后写入器**一次 `write()` 都没发生**，而 `createWritable()` 已经把文件建出来了 →
   0 字节。同时 FLV 分支的 `showSaveFilePicker().catch(e=>{})` 把真实异常吞掉，随后把「没有句柄」改写成
   「下载已取消」；字符串 `throw`（该合并器里有多处）到 offscreen 错误出口后 `message` 变 `undefined`。

### 1.3 四条的修法（各自独立，互不依赖）
| id | 修什么 | 关键点 |
|---|---|---|
| `F1` | 形态回退 | 只在「合并失败 + 首段前 12 字节内出现 `ftyp`」时，把各分段 `ArrayBuffer` **原样顺序拼成 `Blob`**（durl 分段就是同一文件的字节区间）；判据不成立时**原异常照旧抛出**，不掩盖真 FLV 错误 |
| `F2` | 死锁 + 类型 | ① 去掉写入门里的 `!await r.closed`（`WritableStreamDefaultWriter.closed` 在关闭前一直 pending → 写永远不发生、close 也永远不发生；实测同一表达式 race 800ms = HANG，DASH 用的那道门 = WROTE）；② writer 通道把 `Blob` 转 `Uint8Array`（streamsaver 的 sink 只收 Uint8Array，源码内联 `Can only write Uint8Arrays`），FSA 通道仍收 Blob 零拷贝 |
| `F3` | 错误透出 | `runWriteFile` 统一归一化：已是 `DownloaderError` 原样透传；其它（含字符串抛出）包成 `code=ERROR_REQUEST_DATA`、`message` 带 `落盘失败: <原字符串>` |
| `F4` | picker 不吞异常 | FLV 分支与 DASH 分支口径一致：`AbortError` 才当用户取消，其它（如 offscreen 里的 `SecurityError: Must be handling a user gesture`）一律 rethrow |

### 1.4 验证（`tools/verify-pgc-merge.mjs`，14 个 case 修前/修后对照）
`node tools/verify-pgc-merge.mjs --tree build/legacy-intermediate/ACGhelper-2.8.31.16-unlock --fixed output/ACGhelper-2.8.31.16-unlock`
→ **14/14 PASS**。要点：baseline 在 `durl-mp4-preview` / `durl-mp4-multiseg` 上抛错且写出 **0 字节**（复现事故现场）；
fixed 写出 **>0 字节**且 `ffprobe` 能读出 `duration`/`streams`；真 FLV 仍走 `Ue.merge`（输出以 `FLV` 开头）；
`writer-streamsaver` case 修前 800ms 超时判 **HANG**、修后写出 `Uint8Array`；`dash` case 补丁前后字节一致（UGC 4K/杜比路径一行未动）。
证据：`logs/v2-04-pgc-merge.log`。

---

## 2. WebDAV 云同步（8 条 · 5 个新增文件 + 3 处补丁）

### 2.1 做了什么
把「官方会员服务器的设置云同步」换成**用户自己的 WebDAV**。新增文件全落在 `src/addons/webdav/` 下
（成品内：`html/webdav.html`、`src/addons/webdav/{js/webdav-core.js,js/webdav.js,js/webdav-sw.js,inject.js}`），
只对既有文件做 3 处最小插入：

* `html/config.html`：`</body>` 前加一个 `<script>` 引 `inject.js`（右下角浮动入口 + `Alt+Shift+W`）；
  **不碰**配置页原有 4 个 bundle 的加载顺序（在 React 页里改 bundle 最容易炸）。
* `manifest.json`：`host_permissions` 追加 `https://*.infini-cloud.net/*`（MV3 扩展页跨域靠 host 权限，
  不是靠 CORS 响应头）+ 新增 `optional_host_permissions: ["*://*/*"]`（换服务商时按需申请，不预先扩大常驻权限）。
* `initBackground.sw.js`：尾部追加 `importScripts("…webdav-core.js","…webdav-sw.js")`，整段 `try/catch`——
  `chrome.alarms.onAlarm` 必须在 SW 里注册才会被唤醒，但同步功能出问题**不许把 SW 带崩**。

### 2.2 协议要点（实现里踩过的坑）
* 官方**聚合通道** `app/getSettingsForUpload` 实测**恒返回空对象**（handler 缺陷），所以改成**逐控制器**
  走官方协议采集（`protocol`）并以**原始 storage 快照**兜底（`raw`）；实测 77 个键、53 个来自协议通道。
* PUT 后**必须 GET 回读比对 sha256**（服务端不回 ETag、覆盖返回 204），页面与 SW 用同一份 `webdav-core.js`。
* 远端目录固定落 `_acghelper/` 下（默认 `_acghelper/settings/`）；探活用 `_acghelper/settings/_probe/` 并**即时删除**，
  不遍历、不触碰用户已有目录。
* 自动同步用 `chrome.alarms`（5 分钟），关掉开关会 `alarms.clear`，页面关着也不再唤醒。

### 2.3 验证（`build/webdav-cdp-test.mjs`，headless Chrome + CDP `Extensions.loadUnpacked`）
在**最终成品树**上重跑：**22/22 PASS**（`logs/v2-05-webdav-cdp-run.log`、`logs/webdav-cdp.log`、`logs/webdav-cdp-result.json`）。
关键几条：`NET-1` 测试连接（OPTIONS 200 → MKCOL 201/405 → PUT 201 → GET 200 sha256 一致 → DELETE 204 清理）；
`PUT-2` 上传后回读 sha256 相等（`c1308031…ab37`，20,644 B）；`GET-1` 远端可独立 GET 且 sha256 一致；
`DIFF-1` 本地/远端比对 `identical:true`；`ALARM-1/2` alarm 已创建且跨上下文可见；`ALARM-3` 关掉自动同步后 alarm 清理干净；
`ERR-1` 错误密码返回 401 且带服务端片段；`SW-1` 尾部 `importScripts` 引导生效（`self.ACHWebDAV` 存在）。

---

## 3. 选集 / 多P 批量下载（3 条 + 2 个新增文件）

### 3.1 做了什么
* 新增 `js/pages/acgx-batch.js`（内容脚本，注入面板）与 `js/pages/acgx-batch-offscreen.js`（offscreen 执行端）。
* `manifest.json`：新增一条 `content_scripts`（`bangumi/play`、`video`、`list`、`medialist/play`，`document_end`，仅顶层 frame）。
* `html/background.html`：让 offscreen 执行端**先于** `background.js` 加载。
* `js/pages/background.js`：只在 `St` 命令分发链**末尾**（`fetchPlayInfoByQuality` 之后、`let Tt=` 之前）加
  `acgxAutoDownload` / `acgxAbortAll` 两个分支，把 `class bt` 交给 `self.__acgxBatchAuto`——
  **不复制下载逻辑**，因此与 `F1–F4` 改的那几处（`class Be` 的 `writeFile`、`class bt.runWriteFile`、`downloadFLV` 的 picker）
  完全没有交叠，两路可以共存。

### 3.2 验证（`tools/batch-cdp-test.mjs`，headless Chrome + CDP，请求全部由 `Fetch.fulfillRequest` 喂 fixture）
在**最终成品树**上重跑：**29/29 PASS**（`logs/v2-06-batch-cdp-run.log`）。
要点：面板 DOM 出现（shadow root 内 `[data-acgx-role=item]`）且条目数 = fixture 集数；「全选」后选中数 = N；
点开始后 offscreen 侧**收到 N 条** `acgxAutoDownload`；**队列串行**（第 i 集 done 早于第 i+1 集 recv）；
多 P 页命中 `x/web-interface/view` fixture 并列出 3 个分 P；面板宿主 `position:fixed`、只有 1 个、页面原 DOM 未破坏。
截图 `logs/batch-panel-*.png` 均为 **914×1415**（副屏工作区），走 `Page.captureScreenshot`（headless），不截主屏。

---

## 4. 影响面（谁被改了、谁没被改）

| 文件 | v1 → v2 | 谁改的 |
|---|---|---|
| `js/pages/background.js` | 113,021 B（+8 簇新增） | 38 条既有 + `F1–F4` + `FB3` |
| `initBackground.sw.js` | 839,670 B | 38 条既有 + `W3` |
| `manifest.json` | 8,603 B（权限 +1、optional +1、content_scripts +1） | `W2` + `FB1` |
| `html/config.html` | 717 B（+1 行 `<script>`） | `W1` |
| `html/background.html` | 668 B（+1 行 `<script>`） | `FB2` |
| `js/pages/{config,video,live,popup,message}.js` | 未变（仅 38 条既有补丁） | 既有 |
| 其余 75 个文件 | **与 pristine 逐字节相同** | — |
| 新增 7 个文件 | webdav 5 + batch 2 | — |

**没被改的**：`src/extracted`（全程只读，指纹 `00c27453…ac58` 构建前后一致）、
`tools/apply-all-patches.py`（只被 `import` 取补丁定义）、`tools/verify-independent-38.py`（只复制派生 53 版）、
三份 feature 规格与其独立应用器（`feature-*.json` / `apply-feature-*.py` / `feature-webdav-apply.py`）。

---

## 5. 验收结论（8 项，全 PASS）

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `node --check` 全量被改/新增 js（含 `src/addons/**`） | PASS（22 个文件 0 失败） | `logs/v2-02-nodecheck.log` |
| 2 | 原有 38 条语义断言（`final-verify-static.mjs` / `final-verify-gates.js`） | PASS（两棵树各 2 份，158 条 PASS / 0 FAIL） | `logs/v2-03-static-gates.log` |
| 3 | `verify-pgc-merge.mjs` 修前/修后对照 | PASS（14/14，修后 >0 字节且 `ffprobe` 可解析） | `logs/v2-04-pgc-merge.log` |
| 4 | 改动面审计升级（`verify-independent-53.py`） | PASS（219 项 / 0 失败；差异簇 49 = 42 字节补丁簇 + 7 新增文件） | `logs/v2-07-independent-53.log` |
| 5 | WebDAV 真机（最终树） | PASS（22/22，PUT/GET sha256 一致，`_probe` 已清） | `logs/v2-05-webdav-cdp-run.log` |
| 6 | Batch 真机（最终树） | PASS（29/29，列举/全选/串行队列/回执） | `logs/v2-06-batch-cdp-run.log` |
| 7 | headless 加载（两棵树） | PASS（SW target 存在、`version_name=…unlock r2`、5s 0 异常、stderr 0 字节） | `logs/v2-08-load-{unlock,sameId}.log` |
| 8 | `src/extracted` 指纹 | 未变（`00c27453…ac58`） | `logs/v2-09-final-state.log` |

环境铁律自证（headless、副屏、不抢焦点、静音、只清自己的进程）集中在 `logs/v2-10-env-selfevidence.log`。

---

## 6. 已知限制（v2 仍然存在的边界）

1. **`F1` 的回退只看首段 12 字节内的 `ftyp`**：既不是真 FLV、也不是带 `ftyp` 的 MP4 的回包（例如纯音频、异常形态）
   仍会抛原始错误——但**错误现在带真实原因**（`F3`），不再是「下载失败」四个字。
2. **真 DRM 流照旧不可播**：`B4` 只是不中断，真 Widevine 密文需要 CDM 密钥。
3. **服务端不给的清晰度拿不到**：插件侧门全拆，但 `1080P+/4K/HDR/杜比` 取决于账号站方权益。
4. **WebDAV 默认是公共测试号**：`kurio.infini-cloud.net` + `_acghelper/settings/`，正式用请换成自己的账号；
   容量/限速/并发由服务商决定；`PROPFIND` 不可用的服务商会退化到「只能整文件比对」。
5. **WebDAV 自动同步是 5 分钟粒度**：`chrome.alarms` 的最小周期限制，不做秒级实时同步；
   SW 被浏览器回收后靠 alarm 唤醒（首次唤醒有几十毫秒延迟）。
6. **选集面板只在 4 类页面上注入**（`bangumi/play`、`video`、`list`、`medialist/play`），
   课程/芝士页 `/cheese/play/*` 仍然没有入口（与 v1 的覆盖缺口一致）。
7. **课程页、番剧「自动连播」设置键串读**（V13 副作用）等 v1 已知问题**本轮未处理**。
8. **53 条里 webdav 的 5 条是新增文件条目**：说「53 + 7 = 60 个差异点」会把那 5 个新人文件重复计一次，
   真实差异簇是 **48 个字节补丁 → 42 簇 + 7 个新增文件 = 49 簇**（`verify-independent-53.py` 逐簇打印）。

---

## 7. 复跑 / 回滚

```bash
# 零写入演练（锚点唯一性 + 全内存构建 + 计数）
python tools/apply-all-plus-features.py --check

# 正式重建（旧成品先归档到 build/legacy-intermediate/）
python tools/apply-all-plus-features.py --archive-legacy

# 只打一部分（例如不要 batch）
python tools/apply-all-plus-features.py --skip-feature batch --archive-legacy
```

回滚：旧成品（v1 两棵树 + 两个 zip）在 `build/legacy-intermediate/`，拷回 `output/` 重新加载即可；
扩展侧回滚见 `output/README.md` §6（停用/移除、关自动同步、删远端 `_acghelper/settings/`）。

---

## 8. r4（本轮）：两处 UI 改版合进流水线

### 8.1 一句话结论
r3 的 66 条一条未改口径；r4 只把 **WebDAV 入口**与**选集入口**两处 UI 改版合进权威构建器，
webdav 段由 v1 的 8 条升到 **9 条**（新增 `webdav-settings-panel.js` 这个文件条目），batch 段仍是 3 条但换了注入位置。
总数 **67 条 = 38 + 4 + 8 + 5 + 9 + 3**，新增文件 **8 个**（webdav 6 + batch 2），`version_name` → `2.8.31.16(Beta) unlock r4`。

| 项 | r3 | **r4** |
|---|---|---|
| 补丁总数 | 66 | **67**（38 + 4 + 8 + 5 + 9 + 3，`_patch-report.json.totals` 由规格算出） |
| 新增文件 | 7 | **8**（webdav 6 + batch 2） |
| 成品树文件数 | 92 | **93** |
| `version_name` | `2.8.31.16(Beta) unlock r3` | **`2.8.31.16(Beta) unlock r4`** |
| `unlock.zip` | 3,724,810 B | **3,748,433 B** · `df293468eb33cc4dd85885f65fe08bec62af3a54bdb21de6d50a984ec5594baf` |
| `unlock-sameId.zip` | 3,724,021 B | **3,748,644 B** · `91aa2e44f389acc8b19c1626a3a2450da96c98ae59337ef483fcd50187339672` |
| 树指纹（unlock / sameId） | r3 见 `_build-info.r3.json` | **`d6b552bd…8122`** / **`fc082c57…e8ab`** |
| 差异簇（字节补丁 + 新增文件） | 53 + 7 = 60 | **53 + 8 = 61** |

### 8.2 WebDAV：浮动按钮 → 官方设置页「同步」栏（spec v1 → v2，8 条 → 9 条）

**改版要点**：v1 是「`</body>` 前挂 `inject.js`、右下角画一个浮动按钮、点开新标签进 `html/webdav.html`」。
v2 不再有浮动按钮，**同步设置长在官方设置页里**：深克隆原生 `.aside-item` 生成一个导航项「同步」，
在 `main` 里注入内容区（服务器四项 + 同步内容分组勾选 + 定时同步开关/间隔/方向 + 立即上传/下载/比对 + 状态与历史快照），
样式全部取原生控件的 `getComputedStyle` 实测值。独立页 `html/webdav.html` 保留为高级入口。

**锚点变化**（这是本轮唯一需要动构建器结构的地方）：

| 条目 | v1 | v2 |
|---|---|---|
| 新增文件 | 5（含 `inject.js`） | **6**（`W0-panel` 新增 `src/addons/webdav/js/webdav-settings-panel.js`，57,995 B） |
| `W1-config-html` | `</body>` 前插 1 行 `inject.js` | **整段替换**：v1 的两行 → `webdav-core.js` + `webdav-settings-panel.js` 两个 script |
| `W0-inject` | 加载的入口脚本 | 改名 **`W0-inject-legacy`**：文件留在树里可回滚，`config.html` **不再引用** |
| `W2` / `W3` | 插入状态 | **幂等断言**（`old == new`）：证明「已在位」，写回字节不变，防重复 `importScripts` |

**由此带来的构建器升级（`tools/apply-all-plus-features.py`）**：v2 的三条锚点是在 **r3 成品树**上取的
（`W1.old` 里含着 v1 注入的两行、`W2/W3` 是 v1 已落地的断言），而流水线从 pristine 起跑，
所以 webdav 段前面加了一层 **v1 前置态重建（bridge）**：

| bridge | 文件 | 做法 | 是否计入补丁条数 |
|---|---|---|---|
| `WBR1` | `html/config.html` | `</body>` 前补回 v1 的「注释 + inject.js」两行（由 `W1.old` 反推） | 否 |
| `WBR2` | `manifest.json` | `host_permissions` 末项后补回 `infini-cloud` 与 `optional_host_permissions`（由 `W2.old` 反推） | 否 |
| `WBR3` | `initBackground.sw.js` | 尾部补回 `importScripts` 引导块（由 `W3.old` 反推） | 否 |

bridge 的 old **全部由 v2 规格锚点反向推导**，不硬编码 v1 文本；每条同样 `count==1` 才动手，失败即退出码 1 且零写入。
拿已含 v1 的树当 `--src` 时自动跳过（`count(spec_old)==1`）。

### 8.3 选集：自建 FAB → 注入插件自己的面板（batch spec v2，仍是 3 条）

**改版要点**：v1 在页面右下角自建一个浮动按钮（自带 shadow DOM 面板）。v2 **删掉自带 FAB**，改成
往插件自己的悬浮面板 `#bilibiliHelper2ContentWrapper` 里注入入口区块，**插在 `<footer>` 之前**，
按钮结构照抄原生 `div.button > button.button-view`、样式在运行期从 `div.button.primary` 的 `getComputedStyle`
读出后写成 `--acgx-*` CSS 变量（9/9 项样式与 hover 行为与原生一致）。
更关键的一条：**只有番剧 > 1 集、或多 P > 1 分 P 时才注入**，单集番剧 / 单 P 视频连一个节点都不建。

**锚点变化**：`FB1`（manifest 新增一条 content_scripts）、`FB2`（`html/background.html` 里 batch 执行端先于 `background.js`）、
`FB3`（`background.js` 分发器末尾加 `acgxAutoDownload` / `acgxAbortAll` 两个分支）—— **三条的 old/new 与 v1 逐字节相同**，
变的只是 `additions[]` 拷进去的 `js/pages/acgx-batch.js` 内容（由 49,045 B 量级重写为 49,447 B，删除自带 FAB、改为面板注入）。

### 8.4 构建器其它升级
* **总条数由规格算出**：`_patch-report.json.totals` 给出 `formula: "38 + pgc-fix=4 + dash-auth-fix=8 + dash-fallback=5 + webdav=9 + batch=3 = 67"` 与
  `total_applied`，硬断言只比「算出值 == 实落值」，不再在代码里写死成品数。
* 报告新增 `webdav_bridge` 段（3 步，单列且明确「不计入补丁条数」）与 `base_patch_ids`（static/proto/extra 明细 id 列表）。
* `--check` 仍然零写入；锚点预检、同文件区间不重叠、打后 `new` 必现 / `old` 必消失、`src/extracted` 前后指纹一致，全部保留。

### 8.5 验证结论（8 项，全 PASS；日志 `logs/r4-00…r4-11`）

| # | 项 | 命令 / 装置 | 结果 | 日志 |
|---|---|---|---|---|
| 1 | 语法 | `node --check` 全部被改/新增 js（两棵树 + `src/addons/**`） | **35/35 PASS** | `logs/r4-01-nodecheck.log` |
| 2 | 38 条语义无回归 | `final-verify-static.mjs`（16 条）+ `final-verify-gates.js`（54 条），两棵树各一遍 | **全 PASS（fail=0）**，共 140 条断言 | `logs/r4-02-static-*.log`、`logs/r4-03-gates-*.log` |
| 3 | 番剧 0 字节不回归 | `verify-pgc-merge.mjs --tree <r3 归档树> --fixed <r4 树>`；再以真·未打树为 baseline 复跑 | 9 个 fixed/invariant 全 PASS，5 个 baseline 用例在 r3/r4 上**已不复现**（= 修复在位）；换未打树为 baseline → **14/14 PASS** | `logs/r4-04-pgc-merge*.log`、`logs/r4-05-pgc-merge-baseline.log` |
| 4 | 独立尺子 | 派生 `tools/verify-independent-r4.py`（从 61 版复制；61 版原文件未改） | **236 项检查 / 0 失败**；总条数 67；差异簇 **61 = 53 + 8**；逐文件簇数 `background.js 17 / video.js 20 / initBackground 9 / config.html 1 …` | `logs/r4-06-independent.log`、`logs/r4-07-clusters.log` |
| 5 | WebDAV 真机 | `build/webdav-cdp-test.mjs --tree=<r4 树> --direct`（真实 InfiniCloud，目录 `_acghelper/settings/`） | **24/24 PASS**：设置页「同步」栏挂载、无浮动入口、OPTIONS 200 / MKCOL / PUT 204 / GET 回读 sha256 一致 / 下载回填 77 项 / alarm 5 分钟 / 401 分支 | `logs/r4-05-webdav-cdp.log`、`logs/r4-05-webdav-cdp-result.json` |
| 6 | 选集真机 | `tools/batch-inpanel-test.mjs --tree=<r4 树>` | **51/51 PASS**：入口在面板 `footer` 之前、单集不出现、单 P 不出现、多 P 列 3 分 P、全选 4 集、offscreen 串行回执、-101 失败分支 | `logs/r4-08-batch-inpanel.log`（截图 `logs/batch-inpanel-*.png`） |
| 7 | headless 加载 | 派生 `tools/verify-independent-load-r4.mjs`（--variant unlock / sameId） | 两棵树均 **13/13 PASS**：SW target 存在、`version_name = 2.8.31.16(Beta) unlock r4`、5 秒 0 异常 / 0 console.error、**chrome stderr 0 字节** | `logs/r4-10-load-*.log`、`logs/r4-10-load-*-cdp.json` |
| 8 | 只读基准 | `src/extracted` 目录指纹 | **`00c27453…ac58` 前后一致**（= r3 同值），`_build-info.json.source_dir.unchanged_before_after = true` | `logs/r4-11-fingerprint.log` |

> 说明 1：WebDAV 真机这一轮第一次跑是 **NET-1 失败（OPTIONS `Failed to fetch`）**，与本机系统代理 `127.0.0.1:7897` 有关
> （同一时刻 `curl -x` 也 `SSL/TLS connection failed`；直连 `curl --ssl-no-revoke` / node fetch 均 200）。
> 换 `--direct`（Chrome `--no-proxy-server`）后全部通过 —— 改的是「怎么出网」，不是断言口径。
> 说明 2：`tools/batch-cdp-test.mjs` 是 v1 的 FAB 版装置，r4 上它在第一条「右下角浮动按钮存在」就停（**预期**，v2 已删该按钮）；
> r4 的选集验收以 `tools/batch-inpanel-test.mjs` 为准，旧装置保留不删以便对照 r2/r3。
> 说明 3：真机跑完会清场 —— 临时 profile 删除、按 PID 树杀 chrome、成品树 `_metadata` 运行时缓存清理；
> 清理后两棵树的目录指纹与构建时记录值**逐字节一致**（见 `logs/r4-11-fingerprint.log`）。

### 8.6 r4 的边界与注意
1. `W2`/`W3` 在 v2 里是**幂等断言**（`old == new`）：它们不制造差异，只证明 v1 那段确实在位。
   因此「67 条」里有 2 条是状态断言，真实字节差异仍由 61 条字节补丁 + 8 个新增文件构成。
2. `inject.js` 仍在树里（`W0-inject-legacy`），但 `config.html` 不加载它 —— 面板脚本自带兜底：
   若发现老浮动入口 `#__acg_webdav_entry__` 还在会主动摘掉，所以页面上永远不会有浮动按钮。
3. 设置页「同步」栏是 **DOM 注入**（克隆原生导航项 + 在 `main` 里插内容区），不碰 React bundle；
   官方设置页若改版（`.aside-item` 结构或 `main` 容器名变化），需要同步改 `webdav-settings-panel.js` 的选择器。
4. 选集入口的注入时机依赖插件面板已挂载（`#bilibiliHelper2ContentWrapper`）；面板未出现时脚本会等，
   超时则不注入并打一行 console 诊断（不会在页面角落兜底画按钮）。
5. 差异簇口径：**61 = 53 + 8**（`tools/_r4_cluster_breakdown.py` 逐簇打印）；`manifest.json` 按历版口径不计入簇数。
