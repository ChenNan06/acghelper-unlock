# WebDAV 云同步（新增功能）—— ACGhelper 2.8.31.16 解锁版

> 一句话：**官方云同步 = 把一份设置 JSON 传到 `acghelper.com/g` 的会员服务器**；本功能把同一个 JSON 传到**你自己的 WebDAV**，页面、协议、payload 形状全部复用官方那套，只换传输层。
>
> 用户入口：**设置页（`html/config.html`，也就是「选项 / Options」页）右下角的「☁ WebDAV 同步」浮动按钮** → 新标签打开 `html/webdav.html`。快捷键 `Alt+Shift+W`。

---

## 0. 交付物清单

| 文件 | 落点（成品树内路径） | 作用 |
| --- | --- | --- |
| `src/addons/webdav/html/webdav.html` | `html/webdav.html` | 同步主页面（配置 / 测试 / 上传 / 下载 / 差异 / 自动同步 / 状态 / 日志） |
| `src/addons/webdav/js/webdav-core.js` | `src/addons/webdav/js/webdav-core.js` | 共享核心库（协议采集、WebDAV 客户端、sha256、历史快照、冲突判定）。页面和 SW 用同一份 |
| `src/addons/webdav/js/webdav.js` | `src/addons/webdav/js/webdav.js` | 页面逻辑 |
| `src/addons/webdav/js/webdav-sw.js` | `src/addons/webdav/js/webdav-sw.js` | SW 侧引导：注册 `chrome.alarms.onAlarm` |
| `src/addons/webdav/inject.js` | `src/addons/webdav/inject.js` | 配置页浮动入口（不碰 React bundle） |
| `tools/feature-webdav.json` | — | 补丁规格（**8 条**：5 copy + 3 既有文件字符串补丁） |
| `tools/feature-webdav-apply.py` | — | 独立应用器（不改 `apply-all-patches.py`） |
| `build/webdav-cdp-test.mjs` | — | headless Chrome + CDP 真机验证 |
| `build/webdav-probe.py` | — | WebDAV 服务端行为探活 |
| `logs/webdav-probe.log` | — | 探活原始请求/响应 |
| `logs/webdav-cdp.log` / `logs/webdav-cdp-result.json` | — | CDP 原始收发 + 22 条断言 |
| `logs/webdav-anchor-check.log` / `logs/webdav-apply.log` | — | 锚点校验 / 应用记录 |
| `logs/webdav-remote-final.log` | — | 远端最终目录结构与回读 sha256 |

补丁条数：**8 条**（38 条上游成品树 → 46 条）。改到的既有文件只有 3 个：`html/config.html`、`manifest.json`、`initBackground.sw.js`（尾部追加）。

---

## 1. 协议侦察结论（官方云同步到底怎么走）

侦察对象：只读基准 `src/extracted/initBackground.sw.js`（839 049 B）+ 成品树字符串锚点。偏移均为**只读基准**里的字符偏移。

### 1.1 传输层：GraphQL，会员服务器

`graphqlController`（偏移 **769 600** 附近）：

```js
create = async (e, t, n) => {
  const i = await (0, Q.$Q)() || null;          // 登录态 uid
  e.url = "https://acghelper.com/g";            // ← 会员服务器唯一端点（770 328）
  e.options.graphql = true;
  e.options.method = "POST";
  o.append("Uid", "ACGHELPER_2.8.31.16 " + i);  // 带扩展版本 + uid
  o.append("Content-Type", "application/json");
  e.options.body = JSON.stringify({ query: e.options.query.replace(/\s{2,}/g," "), variables: e.options.variables });
}
```

上传 mutation（偏移 **968 78** 附近，`uploadSettings2Cloud`）：

```graphql
mutation ($bhVersion: String!, $modelVersion: Int!, $value: String!) {
  bilibiliHelperSetting { setByFragment(bhVersion: $bhVersion, modelVersion: $modelVersion, value: $value) }
}
# variables: { bhVersion: <扩展版本>, modelVersion: 2, value: JSON.stringify(settingsNeedUpload) }
```

下发 query（`downloadSettings`）：

```graphql
query ($bhVersion: String!, $modelVersion: Int!) {
  bilibiliHelperSetting { get(bhVersion: $bhVersion, modelVersion: $modelVersion) { value bhVersion modelVersion lastUpdateTime } }
}
# 拿到后：this.emit("app","setSettingsFromCloud",{settings: JSON.parse(get.value)})
```

**结论**：会员服务器只做三件事——存一个 JSON 字符串、盖 `lastUpdateTime`、按 `bhVersion/modelVersion` 取回。**没有任何服务端加密/水印/不可替代的东西**，所以换成 WebDAV 不损失语义。

### 1.2 消息协议：页面 → SW 用 `sendMessage({target,event})`

入口（偏移 **740 224**）：

```js
const b = (t, n, i) => { ... else if (e) return e.onReceivedMessageByChromeInterface(t, n, i); return !0 };
chrome.runtime.onMessage.addListener(b);
```

分发（偏移 **9 122**）：

```js
onReceivedMessageByChromeInterface = (e, t, n) => {          // e=message t=sender n=sendResponse
  ...
  const { target: i, event: o, ...s } = e;
  return o && this.emit(i, o, s, n, t).catch(e=>{}), !0;     // payload = 去掉 target/event 的其余字段
}
```

- **上传（采集）**：`{target:"app", event:"getSettingsForUpload"}` → 期望 `{[itemName]: {settings, stores}}`
- **下发（应用）**：`{target:"app", event:"setSettingsFromCloud", settings:{...}}` → 返回 `true`

下发的 handler（偏移 **9 122**，可用）：

```js
this.addListener("setSettingsFromCloud", (e,t,n)=>{ const {settings:i}=e; if(!i) return n(!1);
  Promise.all([...loadedItems.values()].map(x => (x.names.item in i && x.setSettingsFromCloud) ? x.setSettingsFromCloud(i[x.names.item]) : null))
    .then(()=>n(!0)) }))
```

### 1.3 ⚠️ 关键实测：**聚合采集通道是坏的**，必须逐控制器发

同一处的聚合采集 handler（偏移 **8 459**）：

```js
this.addListener("getSettingsForUpload", (e,t,n)=>{
  const items = Array.from(o.q.loadedItems.values());
  Promise.all(items.map(async x => {
    const r = await x.getSettingsForUpload(void 0, void 0, (v)=>v);   // ← 回调结果被丢掉
    if (r) return { [x.names.item]: r };
  })).then(list => n(list.reduce(...)))
})
```

而各控制器的实现是 **回调式**（偏移 134 080 / 182 904 / 528 791 …）：

```js
getSettingsForUpload = async (e,t,n) => { n({ settings: this.simplifyConfig(this.settings) }) }   // 返回值 undefined
```

`await x.getSettingsForUpload(...)` 得到 `undefined`（回调 `n` 的实参没有成为返回值），`if (r)` 全部为假 → **最终返回 `{}`**。

实测（`logs/webdav-cdp.log`，断言 `SNAP-3`）：

```
aggregateChannelKeys=0            # {target:'app',event:'getSettingsForUpload'} → 空对象
perItem_bilibiliMessage            → 1 key  {settings:{...}}     ✅
perItem_mainLive / popupMain       → 1 key  {settings:{...}}     ✅
perItem_bilibiliAccountController  → 超时（没实现，base 是空函数）  ⏭
```

所以官方自己的上传路径也是**逐 feature** 发的（偏移 **96 878**）：

```js
uploadSettings2Cloud = async ({featureName}) => {
  this.settingsNeedUpload[featureName] = await new Promise(e => this.emit(featureName, "getSettingsForUpload", null, e))
  // …setTimeout 2s 合并后一次性 mutation
}
```

**本功能的采集实现**（`webdav-core.js#collectViaProtocol`）就按这条路走：从 storage 键名反推控制器名 → 逐个 `sendMessage({target:item, event:'getSettingsForUpload'})`，并发 10、单条 1 s 超时，不实现的记为 `silent` 跳过。实测 **76 个候选，53 个有数据，23 个沉默**。

### 1.4 `simplifyConfig` 与排除名单

```js
simplifyConfig(e, t = h, n = {}) { … }        // 偏移 35 756
const h = ["description","title","permissions","dependencies","type","kind","name","hide"];   // 偏移 27 6xx
```

规则：这三个元数据键递归剔除；空对象丢弃；数组逐项递归。**这就是"上传什么"的官方口径**，本功能原样沿用（协议通道拿到的就是 `simplifyConfig` 的结果）。

另有两个控制器额外把**运行时对象**塞进 settings（`bilibiliAccount`、`bilibiliHelperAccountLogin`、`hasLogin` 等，见 18 678 / 371 411 的 `onAfterSetSettingsFromCloud`），这些字段属于"易变"，恢复后由控制器自己重建，不影响一致性判定（见 §5.4）。

### 1.5 设置落盘形态（`chrome.storage.local`）

类 `w`（`BaseItem`，偏移 **27 710**）构造时定型四类键：

```js
this.names = { item, config: `${item}-config`, data: `${item}-data`, storeNames: `${item}-store-names` };
getStore = async (e="default") => get([this.names.data, e].join("_"));      // 偏移 34 226：<item>-data_<store>
setStore = async (e="default", v) => set([this.names.data, e].join("_"), v); // 偏移 34 313
```

`BaseCache`（偏移 **19 598**）另建两类**运行时缓存**键：

```js
this.name = `${owner.names.item}-cache`; this.configName = this.name + "-config";
```

实测某个实例的 `chrome.storage.local`：**140 个键**，其中
- `<item>-config` / `<item>-data_*` / `<item>-store-names` → **115 个**（纳入快照）
- `<item>-cache` / `<item>-cache-config` → **21 个**（排除）
- `webdav-*`（本功能自身）→ **4 个**（排除）

### 1.6 复用不了时的退路（已实现，不是纸上方案）

`collectRaw()`：直接枚举 `chrome.storage.local`，按 `-config` / `-data_` / `-store-names` 三类反解析成**和官方同形状**的 `{[item]:{settings,stores}}`，同时保留 `raw` 原始键值用于精确回填。排除规则与依据：

| 排除 | 依据 |
| --- | --- |
| `<item>-cache` | `BaseCache` 运行时缓存（含 `lastAccess`/过期时间），跨机恢复会污染过期判定 |
| `<item>-cache-config` | 同一缓存的限额配置，同上 |
| `webdav-*` | 本功能自身的配置/状态/历史，上传它会造成"同步元数据污染设置"的递归 |

实测断言 `SNAP-2`：`leakedCache=0`、`leakedOwn=0`。

### 1.7 最终采集形态

`collectSnapshot('auto')`（页面里）同时产出两条通道，payload 里都带上：

```json
{
  "schema": 1,
  "exportedAt": "2026-11-08T10:08:39.254Z",
  "extensionVersion": "2.8.31.16",
  "mode": "protocol+raw",
  "settings": { "<item>": { "settings": {...}, "stores": {...} } },   // 官方协议形状 → 走 setSettingsFromCloud
  "raw":      { "<item>-config": {...}, "<item>-data_default": {...} } // 精确回填用
}
```

下发时**先走协议**（`app/setSettingsFromCloud` → 各控制器 `setSetting` + `setStore` + `onAfterSetSettingsFromCloud`，会刷新内存态）；协议不通且 payload 里有 `raw` 才降级写 storage。
SW 内部（`autoTick`）用 `raw` 通道采集——SW 不能给自己发消息，`sendMessage` 不会回到自己。

---

## 2. WebDAV 服务端行为（实测，不是假设）

服务端：Apache + `mod_dav`（`DAV: 1,2`），根 `https://kurio.infini-cloud.net/dav/`。原始记录见 `logs/webdav-probe.log`。

| 行为 | 预设（任务书） | **实测** | 对实现的影响 |
| --- | --- | --- | --- |
| `OPTIONS` | — | `200`，`DAV: 1,2 <http://apache.org/dav/propset/fs/1>`，`Allow` 含 MKCOL/PUT/GET/PROPFIND/MOVE/COPY/LOCK | 可用标准 WebDAV |
| `MKCOL` 已存在 | 405 | `405`（新建 `201`） | 405 视为成功，逐级幂等 |
| `PUT` 到**父目录不存在** | 403 | **`403`**（`You don't have permission…`） | **必须先逐级 MKCOL**（已实现 `ensureDirs`） |
| `PUT` 响应 ETag | 不回 | **不回**（`201`/`204` 都没有 ETag） | 写完必须 `GET` 回读 + sha256 |
| `PUT` 新建 / 覆盖 | — | 新建 `201`、覆盖 `204` | 两个都算成功 |
| `GET` | — | `200`，带 `ETag` / `Last-Modified`；**会被 gzip**（ETag 尾巴 `-gzip`） | sha256 必须对**解压后的响应体**算（`fetch` 自动解压，实现里直接对 `arrayBuffer` 算） |
| `If-None-Match: *` | 「被忽略」 | **没被忽略**：已有资源返回 **`412`** | 见下方说明 |
| `If-Match: <正确 ETag>` | 「恒 412」 | **`204`（生效）** | 见下方说明 |
| `LOCK`（空体） | — | `400`（需要合法 lockinfo XML） | 本功能不使用锁 |
| `DELETE` | — | `204` | 探活文件/`_probe` 目录清理正常 |
| 鉴权失败 | — | `401` + `Unauthorized` HTML 片段 | 页面必须把状态码 + 片段打出来 |

> **为什么明明条件请求能用，实现里却一条都不用？**
> ① `PUT` 不回 ETag，要用 `If-Match` 就得先 `GET`/`HEAD` 拿一次 ETag —— 多一次往返，而且中间存在竞态；
> ② 「回读 + sha256 比对」比 ETag 比对**强**（ETag 只证明"资源没变"，sha256 证明"字节一模一样"）；
> ③ 不同服务商行为不一致（有的 `If-Match` 恒 412、有的忽略 `If-None-Match`），不依赖它才可移植。
> 所以：**代码里一个条件请求头都没有**，全靠 `PUT → GET → sha256`；探活日志保留了两条实测结果，供以后真要加乐观锁时参考。

**目录纪律**：只在 `_acghelper/` 下建目录；探活用 `_acghelper/settings/_probe/`（实现里跟随远端目录，默认在 `_acghelper/settings/` 下），用完立刻删除；用户既有目录（`clash-verge-rev-backup/`、`pixpin-config/`、`kazumiSync/`、`komikku/`、`_dshtest*` 等）**只出现在根 PROPFIND 的列表里，从未读写**。

---

## 3. 页面结构（用户点哪里）

```
设置页 html/config.html（选项页）
└─ 右下角固定按钮  ☁ WebDAV 同步        ← inject.js 注入，Alt+Shift+W 同效
   └─ 新标签打开  chrome-extension://<id>/html/webdav.html
      ├─ 服务器配置：服务器地址 / 用户名 / 应用密码 / 远端目录 / 远端文件名
      │               [保存配置] [测试连接]  （状态 pill：未测试 / 连接正常 / 失败）
      ├─ 自动同步：☑ 开启（chrome.alarms） · 间隔 5/15/60 分钟 · 方向 只上传/双向/只下载
      │             状态 pill：已创建 · 每 N 分钟 · 下次时间
      ├─ 操作：[立即上传] [立即下载] [比对差异] [恢复上一份本地快照] [停用自动同步]
      ├─ 状态区：最近同步时间 / 最近结果 / 远端·本地大小·HTTP / sha256 是否一致（前 16 位）
      ├─ 差异详情：本地/远端字节数、模块数、新增/缺失/变化清单
      └─ 运行日志：每条动作的 HTTP 状态、sha256、错误片段；[复制日志][清空]
```

默认值（用户要求「帮我自定义」，密码框 `type=password` 但已填好）：

```
server         https://kurio.infini-cloud.net/dav/
username       2697986947
password       REPLACE_WITH_YOUR_WEBDAV_APP_PASSWORD        ← 16 位应用密码
remoteDir      _acghelper/settings/
fileName       acghelper-settings.json
autoSync       false
intervalMinutes 15                      ← 可选 5 / 15 / 60
autoMode       upload                   ← 最安全：自动只上传
collectMode    auto                     ← protocol+raw 双通道
verifyReadback true
```

配置存在 `chrome.storage.local` 的 `webdav-config-v1`（明文，本机内）；同步状态 `webdav-sync-state-v1`；历史快照 `webdav-history-v1`。

**为什么没有改 `js/pages/config.js`**：那是 React 打包产物，在里面插东西最容易炸；`inject.js` 用独立 `fixed` 容器 + `MutationObserver`（React 重渲染清掉就补回来），失败也不影响原页面任何逻辑。

**为什么没有加 `web_accessible_resources`**：`html/webdav.html` 是用 `chrome.tabs.create` 从扩展页打开的，`chrome-extension://` 顶层导航不需要 WAR；加 `<all_urls>` 只会让任意网站能 iframe 这个页面，没有收益。

---

## 4. manifest 变更（只有 2 处）

```diff
     "host_permissions": [
         "*://*.akamaized.net/*",
+        "https://*.infini-cloud.net/*"
     ],
+    "optional_host_permissions": [
+        "*://*/*"
+    ],
```

- 默认服务器**必须有 host 权限**：MV3 扩展页的跨域 `fetch` 靠 host_permissions，不是靠服务端 CORS 头。
- 用户换服务商时，页面在「保存/测试」点击（用户手势）里对目标 origin 走 `chrome.permissions.request` 现申请，**不预先扩大常驻权限**。

---

## 5. 同步语义

### 5.1 上传（立即上传 / 自动同步）

```
① 采集快照（protocol+raw）→ ② 序列化（键序递归排序，同一内容必得同一 sha256）
③ 压一份本地历史快照（kind=pre-upload，保留最近 5 份）
④ 逐级 MKCOL 建远端目录（PUT 到不存在的父目录必然 403）
⑤ PUT（Content-Type: application/json; charset=utf-8）
⑥ 回读校验：GET → 对响应体算 sha256 → 与本地 sha256 比
⑦ 写同步状态（lastDirection/upload、lastResult/ok|fail、lastHttp、sha256、字节数、耗时）
```

任一步失败：写 `lastResult=fail` + 明确错误（HTTP 码 + 服务端片段），**不静默**。

### 5.2 下载（立即下载）

```
① GET 远端 → 解析 JSON（非法 JSON 直接报错，附前 120 字）
② 把「当前设置」导出成本地快照（kind=pre-download）—— 覆盖前最后一道保险
③ 下发：先 {target:'app',event:'setSettingsFromCloud',settings}（走官方通道，控制器内存态一起刷新）
        协议不通且 payload 有 raw → 才降级逐键写 chrome.storage.local
④ 写状态（lastDirection=download、appliedVia=protocol|raw、appliedKeys）
```

### 5.3 比对差异

- **一致判定按"设置内容"**：`settingsFingerprint = sha256(canonicalJSON({settings}))`，**不含 `exportedAt`**。
  （如果按整包字节算，每次 `exportedAt` 都不同 → 永远"不一致"，这个坑实测踩到过：`logs/webdav-cdp.log` 里第 2 次运行的 `DIFF-1 changed=22` 就是键序差异造成的假报，修法是 `summarizeSettings` 走 `canonicalJSON` + `__stores` 排序。）
- 逐个模块给 `新增 / 缺失 / 变化` 三张清单。

### 5.4 冲突与回滚

| 场景 | 行为 |
| --- | --- |
| 下载前 | 强制把当前设置存成 `pre-download` 快照（5 份环形） |
| 上传前 | 同样存 `pre-upload` 快照 |
| 手动「恢复上一份本地快照」 | 先给当前状态再存一份 `pre-restore`，然后按快照里的 `mode` 回填（可反复回滚） |
| 自动同步·只上传（默认） | 本地 settings 指纹没变 → 跳过；变了 → 上传 |
| 自动同步·只下载 | 远端指纹没变 → 跳过；变了 → 下载 |
| 自动同步·双向 | 只有**单边**变化才动；**两边都变** → 写 `lastResult=conflict` 并停下，页面提示"手动比对差异"，**不覆盖任何一侧** |
| 变化判定基准 | 上次同步记下的 `lastLocalSettingsSha256` / `lastRemoteSettingsSha256`（内容指纹，不是时间戳） |
| 临时缓存键 | 永不进快照、永不还原（见 §1.6） |

**历史快照形状**（`webdav-history-v1`，5 份环形，单份 > 4 MB 只存元信息）：

```json
[{ "at":"…","kind":"pre-upload|pre-download|pre-restore","reason":"manual|auto:alarm",
   "sha256":"…","bytes":20644,"mode":"protocol+raw","payload":{…},"truncated":false }]
```

### 5.5 自动同步（chrome.alarms）

- alarm 名固定 `webdav-autosync`，`periodInMinutes = 5/15/60`。
- **监听器写在 Service Worker 里**（`initBackground.sw.js` 尾部 `importScripts` 引导），所以**页面关掉也照常同步**；页面开着时只负责刷新状态显示。
- SW 启动时兜底：配置开着但 alarm 丢了 → 重建；配置关了但 alarm 还在 → 清掉。
- 自动同步在 SW 内用 **raw** 通道（SW 给自己发消息不会回到自己），下发也是 raw 直写；想让控制器内存态立刻刷新，就手动点一次「立即下载」（走协议通道）。**这是有意的取舍，写在这里免得踩坑。**

---

## 6. 真机验证记录

### 6.1 环境

```
Chrome      : 见 logs/webdav-cdp.log「Browser」行（headless=new）
启动参数     : --headless=new --disable-gpu --no-first-run --no-default-browser-check
              --mute-audio --disable-background-networking --disable-component-update
              --enable-unsafe-extension-debugging --user-data-dir=<temp> --remote-debugging-port=944x
加载方式     : CDP Extensions.loadUnpacked（Chrome 137+ 已移除命令行 --load-extension）
被测树       : build/webdav-test/ACGhelper-2.8.31.16-unlock（38 条成品树 + 本 spec 8 条）
扩展 ID      : joekahpglhgccmgkiidnhdhafabalold（= SHA256(路径 UTF-16LE)[:16] → a-p 推导值，一致）
```

### 6.2 断言结果：**22 / 22 PASS**

| # | 断言 | 结果 |
| --- | --- | --- |
| EXT-1 | 加载未打包扩展 | ✅ |
| SW-1 | `initBackground.sw.js` 尾部 `importScripts` 引导生效（`self.ACHWebDAV` 存在，41 个 API） | ✅ |
| SW-2 | manifest 新增 WebDAV host 权限 | ✅ |
| UI-1 | `config.html` 注入的浮动入口按钮存在（`☁ WebDAV 同步`，右下角 140×37） | ✅ |
| PAGE-1 | `webdav.html` 载入核心库并读到默认配置（密码 16 位已填） | ✅ |
| NET-1 | 测试连接：OPTIONS 200 → MKCOL 已存在(405 视为成功) → PUT → GET sha256 一致 → DELETE `_probe` | ✅ |
| SNAP-1 | 逐控制器协议采集成功（`protocol+raw`，77 模块 / 53 走协议 / 76 候选 / 23 沉默） | ✅ |
| SNAP-3 | 实证聚合通道恒返回 `{}`（所以必须逐控制器） | ✅ |
| PUT-1 | PUT 返回 200/201/204（实测 `204`，覆盖写） | ✅ |
| PUT-2 | PUT 后 GET 回读 sha256 **完全相等** | ✅ |
| GET-1 | 远端可独立 GET，sha256 与上传一致，`schema=1` | ✅ |
| DIFF-1 | 本地/远端内容比对 **一致**（`identical:true`，0/0/0） | ✅ |
| ALARM-1 | `chrome.alarms` alarm 已创建（`periodInMinutes=5`） | ✅ |
| ALARM-2 | SW 侧读到同一个 alarm（跨上下文可见） | ✅ |
| STORAGE-1 | `chrome.storage.local` 出现同步记录（`lastResult=ok`、`lastHttp=204`） | ✅ |
| STORAGE-2 | 历史快照落库（`pre-upload`） | ✅ |
| SNAP-2 | 原始快照排除规则生效（`leakedCache=0`、`leakedOwn=0`） | ✅ |
| GET-2 | 下载回填成功，`applied=protocol`，77 项 | ✅ |
| GET-3 | 下载前自动导出本地快照（`pre-download`） | ✅ |
| ALARM-3 | 停用自动同步后 alarm 清理干净 | ✅ |
| ERR-1 | 错误密码 → `401` + 服务端 HTML 片段 | ✅ |
| PERM-1 | 默认域名已在 `host_permissions` 内 | ✅ |

真实数值（`logs/webdav-cdp.log`）：

```
PUT-2  local=c62d070610bbf7575be55ceed1f8206af00b6afc2c0d1178ed4acf33b95b2ef0
       remote=c62d070610bbf7575be55ceed1f8206af00b6afc2c0d1178ed4acf33b95b2ef0   20644 B / 77 模块
GET-2  applied={"applied":"protocol","keys":77}
ALARM  {"name":"webdav-autosync","periodInMinutes":5,"persistAcrossSessions":true,"scheduledTime":…}
```

### 6.3 远端最终结构（`logs/webdav-remote-final.log`）

```
/dav/_acghelper/                                   collection
/dav/_acghelper/settings/                          collection
/dav/_acghelper/settings/acghelper-settings.json   file  len=20644  application/json
GET → 200  20644B  sha256=c62d0706…b95b2ef0
   schema=1  exportedAt=2026-11-08T10:08:39.254Z  extensionVersion=2.8.31.16  mode=protocol+raw
   settings 77 条 / raw 115 键
残留 _probe ?  False
```

### 6.4 环境铁律三项自证

```
自证①：本次 profile(acg-webdav-VilYS5) 的 chrome 进程数 = 16，其中 MainWindowHandle≠0 = 0
        → 全程 headless，没有任何可见窗口 ✅
自证②：前台窗口 handle=4331958 / 属主 PID=39984 —— 启动前、结束后完全一致；
        且我的进程 MainWindowHandle 全 0 → 从未拥有窗口，不可能抢焦点 ✅
自证③：--mute-audio 在启动参数里 ✅（headless 无音频输出设备，全程无提示音）
清场：按 --user-data-dir=*acg-webdav-* 精确结束本次 profile 的 16 个 chrome 进程，
      临时 profile 已删除，成品树 _metadata 运行时缓存已清理；其它实例/别人的 chrome 一个没动
```

> 早先一轮曾出现"前后前台句柄不一致"，原因是同一时刻机器上还有其它角色的 headless 测试在跑；已把判定依据从"前台句柄不变"改成"**我的进程没有任何窗口句柄**"（`MainWindowHandle` 全 0），这才是"没抢焦点"的硬证据。

---

## 7. 失败分支（页面都会带 HTTP 码 + 服务端片段）

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `401 Unauthorized` | 用户名/应用密码错（不是账号密码！InfiniCLOUD 要"应用密码"） | 重新填应用密码 → 测试连接；错误原文会打在日志里 |
| `403 Forbidden` | ① 父目录不存在（PUT 前没 MKCOL）② 没有该目录写权限 | 实现已内置逐级 MKCOL；仍 403 → 换 `remoteDir` 或检查服务商目录权限 |
| `404` on GET | 远端还没备份文件 | 页面明确提示"先执行一次立即上传"，不是静默失败 |
| `405` on MKCOL | 目录已存在 | 正常，视为成功 |
| `412` | 只有在我们带条件请求时才会出现；**本实现不带**，一旦出现说明中间有代理/网关加了条件头 | 关掉代理或换直连 |
| 网络不可达 / 超时 | 断网、DNS、公司网关 | 30 s 超时后报 `HTTP 0 / 请求超时`；换网络重试 |
| 回读 sha256 不一致 | 上传被中间层改写（压缩/转码/WAF 插入） | 报错并给出两侧 sha256；换服务器或关掉改写层 |
| 远端 JSON 非法 | 有人手改了文件 | 报错并回显前 120 字；用「恢复上一份本地快照」兜底 |
| 协议通道无响应 | SW 未就绪 / 控制器未注册 | 自动降级 raw（`mode` 字段可见）；不影响功能 |
| 服务端 gzip | Apache 对 JSON 自动压缩 | 实现对解压后的响应体算 sha256，不受影响 |

---

## 8. 怎么停用与清理

1. **停自动同步**：页面「停用自动同步」按钮（= `chrome.storage.local['webdav-config-v1'].autoSync=false` + `chrome.alarms.clear('webdav-autosync')`）。手动清理也可以在 SW 控制台跑：
   ```js
   chrome.alarms.clear('webdav-autosync')
   ```
2. **删远端数据**：
   ```bash
   curl -u '2697986947:REPLACE_WITH_YOUR_WEBDAV_APP_PASSWORD' -X DELETE 'https://kurio.infini-cloud.net/dav/_acghelper/settings/acghelper-settings.json'
   curl -u '2697986947:REPLACE_WITH_YOUR_WEBDAV_APP_PASSWORD' -X DELETE 'https://kurio.infini-cloud.net/dav/_acghelper/settings/'
   curl -u '2697986947:REPLACE_WITH_YOUR_WEBDAV_APP_PASSWORD' -X DELETE 'https://kurio.infini-cloud.net/dav/_acghelper/'
   ```
   （只删 `_acghelper/`，别碰根下其它目录。）
3. **清本地痕迹**（扩展页控制台）：
   ```js
   chrome.storage.local.remove(['webdav-config-v1','webdav-sync-state-v1','webdav-history-v1','webdav-last-upload'])
   ```
4. **彻底移除功能**：从成品树里删掉 `html/webdav.html`、`src/addons/webdav/`，把 `html/config.html` 里那行 `<script src="../src/addons/webdav/inject.js">` 删掉，manifest 去掉 `https://*.infini-cloud.net/*` 与 `optional_host_permissions`，`initBackground.sw.js` 末尾那行 `;(function(){…importScripts…})();` 删掉。或者直接 `tools/feature-webdav-apply.py` 反向重建（从 `output/` 重新 copytree）。
5. **回滚到未打补丁的成品**：`build/webdav-test/` 是我的验证目录；正式树 `output/` 未被改动（`src/extracted` 只读基准也未被触碰）。

---

## 9. 已知限制

1. **自动同步在 SW 内走 raw 通道**：设置值正确落盘，但控制器的内存态要等 SW 重启或手动点一次「立即下载」才刷新（协议通道）。
2. **`intervalMinutes` 只有 5/15/60**：`chrome.alarms` 在打包扩展里最小 1 分钟，选这三档是为了不触发服务端限流（MKCOL/PUT 在本服务端要 1.4–5.9 s，别调太密）。
3. **payload 体积**：本机实测 20 644 B（115 键）。若用户设置里塞了大数组（白名单/消息模板），可能上到几百 KB，仍远低于常见 WebDAV 单文件限制；历史快照单份超 4 MB 只留元信息。
4. **`mode: protocol+raw` 里 `raw` 是完整原始键值**，包含账号 uid / 昵称等（官方云同步也会带这些）。远端目录建议自己确保私有。
5. **官方会员云同步仍然在**：本功能是**并存**（新增独立入口），没有 patch 掉 `acghelper.com/g` 那条链路；两者互不干扰。

---

## 10. 复跑命令

```bash
# 1) 锚点校验（在 38 条成品树上，要求 8 条全部 count==1）
python tools/feature-webdav-apply.py --check --tree output/ACGhelper-2.8.31.16-unlock

# 2) 构建验证树（复制 + 打补丁）
python tools/feature-webdav-apply.py \
       --from output/ACGhelper-2.8.31.16-unlock \
       --out  build/webdav-test/ACGhelper-2.8.31.16-unlock

# 3) WebDAV 服务端行为探活（只动 _acghelper/，结束删 _probe）
python build/webdav-probe.py

# 4) headless Chrome + CDP 真机验证（22 条断言）
node build/webdav-cdp-test.mjs --port=9448
```
