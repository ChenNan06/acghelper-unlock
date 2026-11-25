# ACGhelper 2.8.31.16 — 下载链路还原与门锁定位（protocol 角色交付）

> 目标样本：Chrome MV3 扩展 **ACGhelper 2.8.31.16(Beta)**（bilibili 增强）
> 分析方式：**纯静态读码 + 本地复算**（未启动浏览器、未抓包、未改 `src/extracted`）
> 分析范围：**下载与网络链路**（本地授权层 `isVIP`/`bhAccount` 判定器由另一路静态分析负责，本文件只在「它如何被消费」处引用）
> 偏移口径：**UTF-8 字符偏移（code point index，从 0 起）**，与 `tools/proto-locate.py` 输出一致；行号按 `\n` 计。

---

## 0. 结论先行

1. **下载链路是「扩展直连 bilibili + 本地装配」**：`playurl` 由扩展自己请求 `api.bilibili.com`，分片从 `upos-*.bilivideo.com` 直取，落地走 File System Access API（`showSaveFilePicker`）或 streamsaver。**全程没有一处经过 acghelper.com**。
2. **插件会员（`isBHVIP`）的门全部在 UI 层**：`js/pages/video.js` 的三处 `if`/`disabled` 与画质选项构造器 `H()`；真正执行下载的 offscreen 引擎（`js/pages/background.js` 的 `class bt`）**不含任何会员字段**。
3. **4K/HDR/杜比/8K 的可用性由两段决定**：① 插件自己的 `_`/`S` 数组把 120/125/126/127/116/112 与 30250/30251/30255 标成 `need-bhvip/need-blvip` → 禁用 + 点击跳付费；② bilibili 服务端只对**大会员账号**下发这些流。**①纯本地可解，②是站方权益、不由本扩展决定。**
4. **番剧（PGC）的限制在本版已从「抛错误」改成「三处静默拦截」**：SW 直接 `return null` 不取数 → offscreen 拿到 `null` 崩在 `H(null)` → UI 因 `isPGC` 整块不渲染下载控件。`NOT_SUPPORT_PGC_CONTENT` 这个错误码在本版**没有任何抛出点**（只有枚举、文案表与一处「保持引用」的空语句）。
5. **是否需要伪造服务端回包：不需要。** acghelper.com 在本扩展里只承担「账号/会员身份、公告、设置同步、支付」四件事，`/g` GraphQL 没有任何一条返回播放地址或下载数据。`*.crx.plus` 只出现在 `host_permissions`，代码里 0 引用。
6. 交付物：**23 条主 patch（全部 `count==1` 且 `node --check` 通过）+ 2 条条件补丁**，可直接出可加载 zip；另有 9 条门判据的前后语义复算，全部 PASS。

---

## 1. 样本基线

| 文件 | 大小 | SHA256 |
| --- | --- | --- |
| `acg-helper-2.8.31.16.zip`（只读原始包） | 3,695,459 | `840455e6b71e1e33b381ae98b86cc3b5bb57500f8a66469a3f6a98e4b4d94703` |
| `src/extracted/manifest.json` | 7,856 | `50eba00edc6be280b19193be2ac0ee4fa0a0bc924b911c000d25ce5efb0469c6` |
| `src/extracted/initBackground.sw.js`（MV3 SW，839 KB，单行） | 839,049 | `3200a2753a7fcdbb5194d68a71e22f1ee7158c9da1a90a24062d630c4a8f9449` |
| `src/extracted/js/pages/video.js`（7105 行，模块化 bundle） | 528,087 | `5afd2808da8c45346a10c3a04265d6110041f824c4eaf25de384d6c5554296b9` |
| `src/extracted/js/pages/background.js`（offscreen 主页脚本，单行） | 112,049 | `9b4d064c0bbd3587228ea03f1d006f9da138fa885e09ee8d84d811e71acf74bd` |
| `src/extracted/downloader.sw.js`（streamsaver 2.0.5 的 SW） | 4,053 | `0b3a34bbf23371eda16a0c609f933ef14996c7562e666ec101f5a2ef60d06893` |
| `src/extracted/html/background.html`（offscreen 文档） | 585 | `2c63c4bd9a898f441b3bc17bb55cb357b3387121aa7b90771165d52b0d1aecca` |
| `src/extracted/html/mitm.html`（streamsaver mitm iframe） | 611 | `2584d4c033ee2aad3956d8e2bf482e3c44f694536d903b21d11526c5181d93e0` |
| `src/extracted/rules/add_origin_referer.json`（**被 manifest 引用**） | 2,359 | `6c484888a9005f1c4ea68e7ef641ef12fff006786313297e28546629091fa736` |
| `src/extracted/rules/video.json`（**未被 manifest 引用**，见 §2.3） | 597 | `dc649aec4ec9b334869aab238b06dea145ee29f1469316d9c0e593bb0e409286` |

平台：Chrome MV3（`minimum_chrome_version: 116`），无 native 组件，`permissions` 含 `offscreen` / `downloads` / `declarativeNetRequest` / `cookies`（`manifest.json:189-205`）。

---

## 2. A — 完整调用链（逐跳）

### 2.1 链路总图

```
[页面 content script] js/pages/video.js
  ├─ 旧类组件 (line 1194, off 86127)  renderNewDownloader → <Xe isBHVIP isBLVIP/>
  │    └─ initDownloader (off 89447)  sendMessage{to:"offscreen",target:"videoDownload",command:"initDownloader",url}
  │    └─ 画质按钮点击 K (off 57363..)  sendMessage{to:"offscreen",...command:"startDownload"}
  └─ 新 React 组件 Xe (line 1125, off 81228)
       ├─ 简单模式 ke (line 476, off 56287)  → startDownload (off 57813)
       └─ 高级模式 Ue (line 880, off 72571)  → startDownload (off 73603)
                 ↓ chrome.runtime.sendMessage({to:"offscreen", target:"videoDownload", command:"startDownload"})
[offscreen document] html/background.html → js/pages/background.js
  router yi (off 91049)  if("offscreen"!==r)return!0; switch(target){case"videoDownload":St(e,t,i)}
  St (off 68821)  initDownloader → new bt(url,tabId).init() ; startDownload → a.download(n,r,void 0,s)
  class bt (off 58405)  download() → basicDownloadInfo.isFLV ? downloadFLV : downloadDash
       ├─ et({target:"videoParse",event:"parse",url,tabId}) ─────────────┐  (offscreen 反向请求 SW)
       └─ FileSystem/streamsaver 落地                                     │
[service worker] initBackground.sw.js                                    │
  feature "videoDownload" (off 378620) ── videoWatcherCallback (off 380838) 抓页面自身 playurl 回包做缓存
  feature "videoParse"  (off 542937)  ── parseByURL (off 543137) → new Kt(url,tabId,csrf).init()
        Kt.init (off 541461) fetchVideoIdByURL → fetchBasicDownloadInfo = Yt (off 540335)
        Yt: UGC → https://api.bilibili.com/x/player/wbi/playurl?bvid&cid&qn=127&fnver=0&fnval=4048&fourk=1&tabId
            PGC → **if(e)return null;**  ← 番剧死在这里（off 540438）
  落地：chrome.downloads 只用于「截图/弹幕/字幕」；**视频本体不用 chrome.downloads**
        streamsaver: js/pages/background.js `je.createWriteStream`(off 53496) → iframe html/mitm.html
                     → navigator.serviceWorker 注册 /downloader.sw.js → port.postMessage({downloadCommand:'startDownload'})
```

### 2.2 逐跳证据

| # | 位置 | 原文 / 提取 | 说明 |
| --- | --- | --- | --- |
| 1 | `html/background.html:10` | `<script type="text/javascript" src="../js/pages/background.js"></script>` | offscreen 文档入口；`initBackground.sw.js` 那行被注释 |
| 2 | `initBackground.sw.js` off **785639** | `chrome.offscreen.createDocument({url:e,reasons:t,justification:n})`；off **785763** `chrome.runtime.getURL("html/background.html")`；reasons = `CLIPBOARD, LOCAL_STORAGE, IFRAME_SCRIPTING, DOM_SCRAPING, BLOBS` | 谁把 offscreen 拉起来：SW 的 `createOffscreenDocument()`，justification=`"keep service worker running"` |
| 3 | `js/pages/video.js` off **89447**（line 1194） | `initDownloader=e=>{let t=location.href;e?.isEP&&e?.epid?t=\`https://www.bilibili.com/bangumi/play/ep${e?.epid}\`:e?.bvid&&e?.p&&(t=\`https://www.bilibili.com/video/${e.bvid}/?p=${e.p}\`),chrome.runtime.sendMessage({to:"offscreen",target:"videoDownload",command:"initDownloader",url:t})}` | 进入下载面板的第一步 |
| 4 | `js/pages/video.js` off **40282**（line 59，`Ee` 内） | `chrome.runtime.sendMessage({to:"offscreen",target:"videoDownload",command:"startDownload",cid:e,downloadOptionIndex:[t,r].filter(Boolean).map((e=>e.join("-"))).join(","),optionDataVersion:Q.current,segments:o.map(...)})` | 新 UI 的统一下发口（供 `Xe` 下的组件用） |
| 5 | `js/pages/video.js` off **73603**（line 880，`Ue`） | `chrome.runtime.sendMessage({to:"offscreen",target:"videoDownload",command:"startDownload",cid:i?.cid,downloadOptionIndex:[T,R].filter(Boolean).map((e=>e.join("-"))).join(","),optionDataVersion:O.current,segments:r})` | 高级模式（n级联框）下载 |
| 6 | `js/pages/video.js` off **57813**（line 476，`ke`） | `chrome.runtime.sendMessage({to:"offscreen",target:"videoDownload",command:"startDownload",cid:i?.cid,downloadOptionIndex:[l,s].filter(Boolean).map((e=>e.join("-"))).join(","),optionDataVersion:L.current,segments:null})` | 简单模式（画质按钮网格）下载 |
| 7 | `js/pages/background.js` off **91049** | `const yi=(e,t,i)=>{const{command:n,to:r,target:s}=e||{};if("offscreen"!==r)return!0;...switch(s){case"videoDownload":St(e,t,i);break;case"danmu":Bt(e,t,i);break;case"subtitleDownload":Kt(e,t,i);break;case"listenVideo":Zt(...);case"liveRecord":bi(...)}return!0};` 注册：`chrome.runtime.onMessage.addListener(yi)`（off **91707**） | **offscreen target 的 message router** |
| 8 | `js/pages/background.js` off **68821** | `St=async(e,t,i)=>{const{command:n}=e;...if("initDownloader"===n){...s=new bt(i,n||t.tab.id),...await s.init()...}else if("startDownload"===n){...a.download(n,r,void 0,s).then(...)}else if("cancelDownload"===n){...r.stop(n)}else if("videoChange"===n);else if("fetchPlayInfoByQuality"===n){...r.fetchBasicDownloadInfo(r.isPGC,r.bvid,r.cid,n)...}}` | offscreen 内部命令分发 |
| 9 | `js/pages/background.js` off **58405** | `class bt{emitter=...;isFLV=!1;hasPssh=!1;videoURL;filename;isPGC;aid;bvid;cid;epid;pn;bestQuality;basicInfo;basicDownloadInfo=void 0;downloadOptionData={video:[],audio:[]};...rateLimiter=new lt;...}` | 下载器主对象：**字段里没有 isVIP/isBHVIP** |
| 10 | `js/pages/background.js` off **59365** | `async init(){const e=await et({target:"videoParse",event:"parse",url:this.videoURL,tabId:this.tabId});return Object.assign(this,e),this.downloadOptionData=H(this.basicDownloadInfo),this.recordSourceVersion(),...}` | offscreen **反向请求 SW** 拿解析结果 |
| 11 | `initBackground.sw.js` off **542937 / 543137** | `class $t extends o.X{constructor(e){super(e,"videoParse",{dependencies:["bilibiliHelperAccountController","renameDownloadFile"],settings:{on:!0}})}...parseByURL(e,t,n){const{url:i,tabId:o}=e,s=await this.emit("cookieController","get",{url:"https://www.bilibili.com",name:"bili_jct"},...),r=new Kt(i,o||t?.tab?.id,s),a=await r.init();n(a)}` | SW 端解析入口，取 `bili_jct`（为将来 post 用），**不取 SESSDATA** |
| 12 | `initBackground.sw.js` off **541461** | `async init(){const{aid,bvid,cid,epid,pn,isPGC,isPreview,pages,...l}=await this.fetchVideoIdByURL(this.videoURL);...this.basicDownloadInfo=await this.fetchBasicDownloadInfo(this.isPGC,this.bvid,this.cid),this.isFLV=this.basicDownloadInfo?.isFLV,...}` | PGC 判定来自 URL/`__NEXT_DATA__` |
| 13 | `initBackground.sw.js` off **540335**（`Yt`） | `Yt=async function(e,t,n,i,o,s=new Set){...if(e)return null;{const e=yt.UGC;r=(0,F.Rj)("https://api.bilibili.com"+e,{bvid:t,cid:n,qn:i\|\|Wt,fnver:0,fnval:4048,fourk:1,tabId:this.tabId})}...` （`Wt=127`，off 540328） | **UGC 取数；PGC 直接 null（见 §5）** |
| 14 | `js/pages/background.js` off **61845 / 62073 / 63282** | `async download(e,t,i=!1,n){...this.basicDownloadInfo.isFLV?this.downloadFLV(e,i,n):this.downloadDash(e,t,i,n)}` / `async downloadFLV(e,t,i){...u=t?Je.createWriteStream(this.filename,null,null):await window.showSaveFilePicker(...)}` / `async downloadDash(e,t,i,n){...p=o.useStreamSaver?Je.createWriteStream(...):await window.showSaveFilePicker({suggestedName:this.filename\|\|"output",types:[{accept:{["video/mp4"]:[".mp4"]}}]})...}` | 落地分支：`useStreamSaver` 或缺 `showSaveFilePicker` 时走 streamsaver |
| 15 | `js/pages/background.js` off **53496** | `je={createWriteStream:Xe,...,version:{full:"2.0.5",major:2,minor:0,dot:5},mitm:chrome.runtime.getURL("html/mitm.html")}` | streamsaver 2.0.5；`html/mitm.html` 负责注册 SW |
| 16 | `downloader.sw.js:127` | `port.postMessage({downloadCommand: 'startDownload'});`；`self.onfetch` 用 `event.respondWith(new Response(stream,{headers:responseHeaders}))` 把流变成下载 | **本文件就是 streamsaver 2.0.5 上游 SW**（唯一改动：`self.onfetch` 写法） |
| 17 | `js/pages/background.js` off **10652**（`B`） | `const B=async function(e,t,i,n=127,r,s=new Set){...const a=e?f.PGC:f.UGC,o=D("https://api.bilibili.com"+a,{bvid:t,cid:i,qn:n,fnver:0,fnval:4048,fourk:1,tabId:this.tabId}),d=await A(o).then((e=>e.json())).then((t=>e?t?.result?.video_info:t?.data)).then(L)...` | offscreen 自带的取数函数：**PGC/UGC 双支持**（补丁 B1 就用它救 PGC） |
| 18 | `js/pages/background.js` off **18622** | `if(r?.boxs.find((e=>"pssh"===e.type)))throw c.PROTECTED_BY_DRM;` | moov 解析时的 DRM 检测点 |

### 2.3 两条容易看错的细节

- **`rules/video.json` 是死文件**：`manifest.json:220-232` 的 `declarative_net_request.rule_resources` 只挂了 `bind_bilibili_account.json` 与 `add_origin_referer.json`。真正的 playurl Referer 规则是 SW 在 `onLaunch` 里**动态加的**：`initBackground.sw.js` off **377899** `const Fe=(0,ve.r)("videoDownloadRules"),Ve=[{id:Fe,priority:100,action:{type:...MODIFY_HEADERS,requestHeaders:[{header:"Origin",...,value:"https://www.bilibili.com"},{header:"Referer",...,value:"https://www.bilibili.com/"}]},condition:{domainType:THIRD_PARTY,excludedInitiatorDomains:["bilibili.com"]（off 378349）,requestDomains:["manga.bilibili.com","mcdn.bilivideo.cn","api.bilibili.com","bilivideo.com","akamaized.net"],resourceTypes:[XMLHttpRequest]}}]`，off **379620** `chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[Fe],addRules:Ve})`。
  → 想改 Referer/Origin 行为时，改 `rules/video.json` **不生效**，要改 SW 里这段或 `add_origin_referer.json`。
- **视频本体不走 `chrome.downloads`**：`chrome.downloads` 在 `initBackground.sw.js` 只出现于截图（off 371970）、弹幕 XML/ASS（517586/518044）、字幕（524322/524663/530654）。`js/pages/background.js` 里 `chrome.downloads` **count=0**。视频走 `showSaveFilePicker`（off 62201 起 8 处）或 streamsaver。所以「改下载文件名/并发」的目标文件是 `js/pages/background.js`，不是 SW。

---

## 3. B — 画质/选项构造与 VIP 参与点

### 3.1 qn 编码表（两处各自独立定义，值一致）

`js/pages/background.js`（offscreen，off **4991** 起）：
- 路径枚举：off **5005** `(function(e){e["PGC"]="/pgc/player/web/v2/playurl",e["UGC"]="/x/player/wbi/playurl"})(f||(f={}))`
- codec：off 5100 附近 `avc="avc1", hevc="hev1", av1="av01", dvh="dvh"`；audio `mp4a.40.2 / mp4a.40.5`
- 视频 qn 枚举（off 5618 结束）：`QN_0=0, QN_15=15, QN_16=16, QN_32=32, QN_48=48, QN_64=64, QN_74=74, QN_80=80, QN_112=112, QN_116=116, QN_120=120, QN_125=125, QN_126=126, QN_127=127`
- 音频 qn 枚举 + 中文标签（off **5767** 起）：`30216 电话音质 / 30232 标准音质 / 30280 高清音质 / 30250 杜比全景声 / 30251 Hi-Res / 30255 杜比音效 / 100010 高清音质 / 100009 标准音质 / 100008 低音质`

`js/pages/video.js`（UI，line 59）：
- 视频枚举 `y`：off 34421 段（`QN_127"]=127` 结束）
- 音频枚举 `k`：off 34612 段；标签表 `x`：off **34918** `x={[k.QN_30216]:"电话音质",[k.QN_30232]:"标准音质",[k.QN_30280]:"高清音质",[k.QN_30250]:"杜比全景声",[k.QN_30251]:"Hi-Res",[k.QN_30255]:"杜比音效",...}`
- **三个集合常量（VIP 门的核心）**：
  - off **35267** `,w=(v.avc,v.hevc,v.av1,b.mp4a402,b.mp4a405,f.video,f.audio,[y.QN_80,y.QN_74,y.QN_64,y.QN_48])` → `w=[80,74,64,48]`（**需要登录 B 站**的画质集合）
  - off **35360** `,_=[y.QN_127,y.QN_126,y.QN_125,y.QN_120,y.QN_116,y.QN_112]` → `_=[127,126,125,120,116,112]`（**需要会员**的视频画质集合：8K/HDR/杜比视界/4K/1080P60/1080P+）
  - off **35418** `,S=[k.QN_30250,k.QN_30251,k.QN_30255]` → `S=[30250,30251,30255]`（**需要会员**的音轨集合）
- `fnval=4048` 的含义（bg off 10831 `fnval:4048`、SW off 540438 之后 `fnval=4048`）：`16(dASH)+64(HDR)+128(4K)+256(杜比音频)+512(杜比视界)+1024(8K)+2048(AV1)` —— **请求端已经把全部高阶流都要了**，卡的是本地选项与站方权益。

### 3.2 选项构造器 `H()`（UI 侧，`video.js` off **36410**）

签名 `H=(e,t,r,o)=>{const{dash:n,supportFormats:i,isFLV:l}=r||{},{is_ugc_pay_preview:s}=o||{},{video:c,dolby:d,flac:p,audio:u}=n||{};...return{video:m,audio:h}}`，调用点 off **40532** `const{video:e,audio:t}=H(d,u,G,o);ae(e),le(t)` —— 实参：`d=isBHVIP`、`u=isBLVIP`、`G=basicDownloadInfo`、`o=basicInfo`。

四条构造语句与 VIP 的耦合（原文摘录）：

1. Hi-Res（flac）条目 —— off **36726/36798**：
   `!l&&p?.display&&h.unshift({label:...x[k.QN_30251]...vip-tag),value:k.QN_30251,children:p.audio?G([p.audio]):[],className:"need-blvip need-bhvip",disabled:!t,isBLVIP:t,isBHVIP:e,onClick:({isBLVIP:e,isBHVIP:t})=>(e&&!t&&B(),t)})`
   → `disabled:!t` 里 **t = isBLVIP**（B 站大会员）；`onClick` 里 **e&&!t** 即「有 B 站大会员但没有助手会员」→ 调 `B()`（打开付费页 `html/config.html?showPaymentModal=1`，`B` 定义在 off 36180（`showPaymentModal=1`）），返回值 `t`=isBHVIP 为假时条目选不中。
2. 杜比全景声（30250）—— off **37044/37116/37213**：结构同上，`disabled:!t`、`onClick:({isBLVIP:e,isBHVIP:t})=>(e&&!t&&B(),t)`。
3. 视频画质 —— off **37661–37707**：
   `(c||l)&&m.push(...f.map(((r,o)=>{...const d=_.includes(r),p=!l&&0===i.length;return{label:...,value:r,children:i,className:A()({"need-blvip":d,"need-bhvip":d,"need-login":p}),disabled:p||!t&&d,needBLVIP:d,isBLVIP:t,isBHVIP:e,onClick:d?({isBLVIP:e,isBHVIP:t})=>(e&&!t&&B(),t):()=>!0}})))`
   → `d=_.includes(qn)`：**qn 在 `_` 里才需要会员**；`disabled = 未登录 || (!isBLVIP && d)`；点击时才检查 `isBHVIP`。
4. 音轨 —— off **37890–38040**：
   `u&&!l&&h.push(...u.map((r=>{const o=G([r]),n=r.id,i=S.includes(n);return{label:...,vip-tag,value:r.id,children:o,className:A()({"need-blvip":i,"need-bhvip":i}),disabled:!t&&i,isBLVIP:t,isBHVIP:e,onClick:i?(...)=>(e&&!t&&B(),t):()=>!0}})))`
   → `i=S.includes(id)`：30250/30251/30255 需会员。

5. 默认选中（跳过 VIP 项）—— off **35895**：
   `const z=(e,t,r)=>{let o=E.tn.findIndex((e=>e===t)),n=e.find((({value:e})=>e===t));return!n||n.disabled||!r&&_.includes(t)?(t=E.tn[o+1],t?z(e,t,r):-1):Number(n.value)}`
   （off 35600 附近 `t=e&&d` → `isBLVIP && isBHVIP`，所以默认值也受会员影响）

### 3.3 三处「点下载」闸门（isBHVIP 直接参与）

| 位置 | 原文 | 判定 |
| --- | --- | --- |
| `video.js` off **73356**（line 880，高级模式 `Ue`） | `Q=(0,a.useCallback)((async()=>{if(!M&&(V\|\|Y&&G.length>0)\|\|t&&!M&&e.length>0)return j();if(W\|\|U\|\|$\|\|p)return!1;...}）` | `M=isBHVIP`、`V=videoOnly`、`Y=audioOnly`、`G=audioCascaderOptions`、`t=enableSegmentSelector`、`e=sortedSegments`、`j=handleOnClickGotoPayment` → **非助手会员点「仅画面/仅音频/切片下载」直接跳付费** |
| `video.js` off **75485**（line 880，按钮） | `disabled:W\|\|U\|\|!M&&!L&&(V\|\|Y)\|\|$\|\|p\|\|Boolean(y),onClick:Q` | `L=isFLV`：非会员且非 FLV 且（仅画面/仅音频）→ 按钮**置灰**；**FLV 源天然免会员** |
| `video.js` off **75188**（line 880，音频级联框） | `disabled:p\|\|_\|\|!M,status:U?"warning":""` | `_`=notSupported → 非 isBHVIP 时**整个音频选项框不可用** |
| `video.js` off **57574**（line 476，简单模式 `ke`） | `K=(0,a.useCallback)((async(r,n,a={video:!0,audio:!0})=>{if(M){if(B){if(!z&&_.includes(n))return W()}else if(_.includes(n))return o.QB.info("请先开通b站大会员")}else if(w.includes(n))return o.QB.info("请先登录bilibili账号");if(V\|\|Y\|\|!z&&!N&&($\|\|Q&&j.length>0)\|\|t&&!z&&e.length>0\|\|X&&!N\|\|p)return!1;...` | `M=hasLoginBLAccount`、`B=isBLVIP`、`z=isBHVIP`、`W=handleOnClickGotoPayment`、`N=isFLV`、`X=empty`；两条机器：`!z&&_.includes(qn)` 跳付费、`!z&&!N&&(仅画面\|\|仅音频\|\|切片)` 直接 `return!1` |
| `video.js` off **74965** | `M?null:a.createElement("a",{className:"upgrade-vip-link",onClick:j},"开通助手会员")` | 非会员时面板上的「开通助手会员」入口（纯展示） |

### 3.4 `isBHVIP` 的来源（只作引用，判定器本体不在本文范围）

`video.js` off **43411**：`chrome.runtime.sendMessage({target:"bilibiliHelperAccountController",event:"getStatus"},(e=>{e&&e?.hasLogin&&e?.bhAccount&&p(e.hasLogin&&((0,T.mg)(e.bhAccount)||(0,T.BN)(e.bhAccount)))})),chrome.runtime.sendMessage({command:"videoDownloadDOMInitialized"})`
→ `p` = `setIsBHVIP`；`(0,T.mg)`=isVIP、`(0,T.BN)`=isSuperVIP（模块 4707）。旧类组件同源：off **86899** `isVIP:!!e.hasLogin&&(0,T.mg)(e.bhAccount)`。
`bhAccount` 本身来自 SW 的 GraphQL `getState`（`initBackground.sw.js` off **85115**，字段 `bhid/boundBlid/email/identities[{name,from,to,hasDateTimeLimit}]`），SW 侧也算一遍：off **86176** `this.bhAccount.isVIP=(0,b.mg)(this.bhAccount),this.bhAccount.isSuperVIP=(0,b.BN)(this.bhAccount)`。

---

## 4. C — 服务端依赖判定（关键结论）

### 4.1 全部 acghelper.com / crx.plus 触达点

| # | URL / 入口 | 出处（文件 + 偏移） | 请求体 / 参数 | 返回结构 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | `POST https://acghelper.com/g`（GraphQL 网关，`graphqlPathname:"/g"`，`vendors.bundle.js:162137`） | `initBackground.sw.js` **786321** `fetch("https://acghelper.com/g",{method:"POST",headers:{Content-Type:application/json},body:JSON.stringify({query,variables})})`；SW 侧统一走 `requestController.createGraphQL` | `{query,variables}` | `{data,errors}` | **仅登录/会员身份/配置**。见 4.2 操作清单，无一条返回播放地址 |
| 2 | `queryBind ($uid: UID!)` | off **66973** | `{uid}` | `account.hasBound.active` | 绑定状态，与下载无关 |
| 3 | `query ($blid: BLID!) { bilibiliHelperAccount { hasRegister getState } }` | off **85115** | `{blid}` | `bhid/boundBlid/email/identities[{name,from,to,hasDateTimeLimit}]` | **isBHVIP 的唯一数据源**（不含任何播放地址） |
| 4 | `mutation login(blid,password)` | off **86476** | 同上 | 账号态 | 登录 |
| 5 | `mutation resetPassword` | off **88391** | — | — | 找回密码 |
| 6 | `mutation signOut` | off **89477** | — | — | 登出 |
| 7 | `queryTrade / queryTradeByOutTradeNo` | off **94350** | `{outTradeNo}` | 支付单 | 支付对账 |
| 8 | `queryOrderList` | off **95803** | — | `redeemList` | 兑换码列表 |
| 9 | `bilibiliHelperSetting.setByFragment / get` | off **97144 / 98047 / 99143** | `{bhVersion,modelVersion,value}` | 设置片段 | 设置云同步（下载设置也在其中，但只是本地配置的备份） |
| 10 | `message.getLatest(type,id)` | off **717323 / 718164** | `{type,id}` | 公告/消息 | 公告 |
| 11 | `app.get(names,version,messageType,adTags)` | off **719964** | — | 应用元信息 | 版本/广告 |
| 12 | `https://acghelper.com/announcement?id=${n.id}` | off **719581** | id | HTML | 浏览器打开公告页（`actions` 里） |
| 13 | `https://acghelper.com/` + `licence.html` / `privacy.html` | `components.bundle.js:64380/65123/65773`、`config.js:160831/160977/296084/296230`、`popup.js:43024/81698/90209`、`website.js:180` | — | — | **纯外链** |
| 14 | `*://*.crx.plus/*` | **只有** `manifest.json:237` 的 `host_permissions` | — | — | **代码 0 引用（全库 grep 仅 1 处命中）** |
| 15 | `*://*.bilibilihelper.com/*` | `manifest.json:236` + `website.js` | — | — | 官网注入脚本，与下载无关 |

### 4.2 明确结论

- **解锁 4K/HDR/杜比/8K 下载：纯本地改判据即可，不需要伪造服务端回包。**
  证据链：① `_`/`S` 数组与三处 `if` 都在 `video.js`（§3）；② offscreen 引擎 `bt` 字段无会员（§2 #9）；③ 取数函数 `B`/`Yt` 直接把 `qn=127&fnval=4048&fourk=1` 发给 `api.bilibili.com`，不经过 acghelper（§2 #13/#17）；④ 唯一来自服务端的是 `getState.identities`，它只影响 `isBHVIP` 这个布尔值，而 patch V1/V2/V5b 之后连这个布尔值都不再参与判定。
- **真正卡 4K 上限的是 bilibili 服务端权益**：`data.support_formats` / `accept_quality` 里有没有 120/125/126/127 由站方按账号大会员状态决定。补丁把「已下发的流」全部放出来；没下发的流（账号非大会员）不会有。
- **下载流量不经过任何第三方**：分片 URL 是 `upos-*.bilivideo.com` / `*.mcdn.bilivideo.cn` / `*.akamaized.net`（`manifest.json:240-242`），由 `downloadDash/downloadFLV` 用 `range` 头直取（`js/pages/background.js` off **15271** `$`：`await A(e,{cache:"default",referrerPolicy:"no-referrer-when-downgrade",headers:{range:\`bytes=${t.start}-${t.end}\`,...}})`；线路/编码选择在 off **15795** `selectedLine`、off **15812** `X`）。

---

## 5. D — PGC / 番剧下载

### 5.1 `NOT_SUPPORT_PGC_CONTENT` 的真相：**本版没有抛出点**

全库引用 16 处，逐一定性（`tools/proto-grep.py src/extracted NOT_SUPPORT_PGC_CONTENT` 可复现）：

| 文件 | 偏移 | 性质 |
| --- | --- | --- |
| `js/pages/background.js` | 446 / 476 | 枚举定义 `e[e["NOT_SUPPORT_PGC_CONTENT"]=1]` |
| 同上 | 1675 / 1707 | 文案表 `c={NOT_SUPPORT_PGC_CONTENT:new h(r.NOT_SUPPORT_PGC_CONTENT,"非常抱歉，应站方要求目前无法提供版权视频下载"),...}` |
| 同上 | **4863** | `r.NOT_SUPPORTED,r.NOT_SUPPORT_PGC_CONTENT;` ← **空引用语句**（打包器保留枚举用），不是 throw |
| `video.js` | 29712/29742 | 枚举定义 |
| 同上 | 30926 | 文案表（`new u(m.NOT_SUPPORT_PGC_CONTENT,"非常抱歉，应站方要求目前无法提供版权视频下载")`） |
| 同上 | **33683** | `const h=[m.NOT_SUPPORTED,m.NOT_SUPPORT_PGC_CONTENT];` → 用于 off **42667** `h.includes(e.message?.code)?(E(!0),Z(e.message))`：把 **code 1** 映射成「notSupported」UI |
| `initBackground.sw.js` | 531009/531029/532014 | SW 侧 `VideoError` 枚举 + `jt` 文案表（`gt.NOT_SUPPORTED,gt.NOT_SUPPORT_PGC_CONTENT;` 同样是空引用） |
| `config.js` | 254571…258557 | 配置页里的同一份拷贝（死代码） |

`tools/proto-ctx.py ... 'throw c.NOT_SUPPORT_PGC_CONTENT'` → **0 命中**；`isPGC` 与 `throw` 同现的地方只有 `throw new Error("Wrong video detail")`（bg off 10337 / SW off 538218，与 PGC 无关）。

**结论：这版把「抛错误」换成了「三处静默拦截」，UI 上那句「根据站方要求我们无法继续提供PGC内容下载服务」是一条渲染分支，不是 error code。**

### 5.2 三处真实关卡（按执行顺序）

**关卡① SW 拒绝取数（最致命）**
`initBackground.sw.js` off **540438**：
```js
Yt=async function(e,t,n,i,o,s=new Set){ if(o&&Ut>=o.acceptQuality.length)return Ut=0,o; try{ let r,a=null;
  if(e)return null;                        // ← e = isPGC：番剧直接 return null，连请求都不发
  {const e=yt.UGC; r=(0,F.Rj)("https://api.bilibili.com"+e,{bvid:t,cid:n,qn:i||Wt,fnver:0,fnval:4048,fourk:1,tabId:this.tabId})}
```
`Kt.init()`（off 541461）把它塞进 `this.basicDownloadInfo = null`。

**关卡② offscreen 崩在 `H(null)`**
`js/pages/background.js` off **59365**：`this.downloadOptionData=H(this.basicDownloadInfo)`，而 `H=e=>{const{dash:t,acceptQuality:i,...}=e,...}`（off **11645**）对 `null` 解构 → `TypeError` → `St` 的 `.catch` 把它包成 `downloadError{code:-1}` 回给页面（`St` off 68821 内的 `_t(s,{command:"downloadError",message:new h(e?.code||-1,e.message)})`）。UI 侧因此停在「数据初始化中，请耐心等待一下哦」。

**关卡③ UI 整块不渲染**
`video.js` off **82125**（`Xe`，line 1125）：
```js
s||w||O ? ( w ? <p className="not-supported">非常抱歉，目前不提供课堂视频下载</p>
             : <Ve className={r?.uiMode}>
                 {O?null:<Qe/>}                                        // ← 模式切换器被隐藏
                 {O&&<div className="drm-confirm-tips">真的非常抱歉，根据站方要求我们无法继续提供PGC内容下载服务</div>}
                 {O?null:<ce.t>{...ke / Ue 下载控件...}</ce.t>}          // ← 下载控件整块不渲染
               </Ve> )
        : <p className="initing">数据初始化中，请耐心等待一下哦</p>
```
其中 `s=basicDownloadInfo`、`w=notSupported`（`!!isCheesePage()`，模块 8768 `l=()=>!!/cheese/play/.exec(location.pathname)`，off 513270 附近）、**`O = isPGC`**。（`w` 的来源见 off **513899** `l=()=>!!new RegExp(...(cheese/play)).exec(window.location.pathname)`，`ER` 导出给 `notSupported` 初值 off **38676** `(0,M.ER)()`）
`isPGC` 唯一赋值点：off **41178** `ye((0,N.dZ)())`；`dZ` = `video.js` off **335546** `i=()=>!!location.pathname.match("/bangumi/play")`（模块 5752）。

**附加关卡④ DRM**
off **18622**：`if(r?.boxs.find((e=>"pssh"===e.type)))throw c.PROTECTED_BY_DRM;` + `hasPssh` 字段。若该集返回的是 Widevine 加密 dash（moov 里带 `pssh`），即使前三关全开，落盘的分片也只是密文——解码密钥在 CDM 里，文件本身放不出来。这一条不是「插件限制」，是内容加密。

### 5.3 番剧 playurl 与普通 UGC 的差异

| | UGC | PGC |
| --- | --- | --- |
| 端点 | `https://api.bilibili.com/x/player/wbi/playurl`（`f.UGC`，bg off 5005） | `https://api.bilibili.com/pgc/player/web/v2/playurl`（`f.PGC`，同处） |
| 参数 | `bvid,cid,qn,fnver=0,fnval=4048,fourk=1,tabId` | 同上（可选 `ep_id`） |
| 回包取值 | `t.data` | `t.result.video_info`（`result.video_info`） |
| SW 侧 | `Yt`：`"https://api.bilibili.com"+yt.UGC` | `Yt`：**`if(e)return null`** |
| offscreen 侧 `B` | `e?f.PGC:f.UGC`，`.then(t=>e?t?.result?.video_info:t?.data)` | 同左（**off 10901**，唯一支持 PGC 的本地实现） |
| SW 给 UI 的 durl 版 | `fetchPlayUrl`（off 384875）：`...?cid=&bvid=&avid=&qn=&fourk=1&fnval=4048&fnver=0&tabId=` | 带 `ep_id` 时切 v2：`s&&(a="https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=${s}&qn=...&tabId=")` |
| PGC 页 ID 解析 | `window.__INITIAL_STATE__`（bg off **14301** `G`，正则匹配点 off **14373**） | `__NEXT_DATA__` + `/pgc/view/web/ep/list?ep_id=`（bg off **12270** `z`），页码→`cid` 映射 |

### 5.4 「让番剧走 UGC 下载分支」还是「绕过 throw」

- **绕过 throw 不成立**：没有 throw 可绕（§5.1）。
- **正确改法**：把 PGC 纳入正常下载路径，有两套等效方案，任选其一或都上：
  - **方案甲（推荐，单点）**：改 offscreen `bt.init()`，当 SW 给的 `basicDownloadInfo` 为空时，用**本文件里已经支持 PGC 的 `B()`** 自取 → 补丁 **B1 / B1b**。这一条同时覆盖关卡①②，且不需要动 SW。
  - **方案乙**：改 SW `Yt`，让 PGC 不再 return null 并请求 v2 端点 → 补丁 **S1 / S2**。
  - **UI 必须一起改**：补丁 **V13**（`dZ()` 恒 false），否则关卡③仍然不渲染控件。
  - 番剧 episode 目标页 URL 形如 `https://www.bilibili.com/bangumi/play/ep<id>`，`initDownloader` 会用 `e?.isEP&&e?.epid` 拼这个 URL（`video.js` off 89447），SW `Kt` 用 `__NEXT_DATA__` 解析出 `cid/epid`——这条链本身对 PGC 是通的，唯一致命点就是 `if(e)return null`。

---

## 6. E — 推荐 patch 规格（23 条主补丁 + 2 条条件补丁）

> 全部 `old` 已用 `tools/proto-patch-check.py` 校验 **`count==1` 且偏移一致**；补丁后 3 个文件均通过 `node --check`；9 条门判据做了前后语义复算（`tools/proto-verify-gates.js`，9/9 PASS）。
> 偏移为字符偏移；`video.js` 的行号分别是 59 / 476 / 880 / 1125 / 6336。

### 6.1 主补丁（`tools/proto-patch-spec.json`）

| # | 文件 | 偏移 | old → new | 影响 |
| --- | --- | --- | --- | --- |
| V1 | `js/pages/video.js` | 35360 | `_=[y.QN_127,y.QN_126,y.QN_125,y.QN_120,y.QN_116,y.QN_112]` → `_=[]` | 120/125/126/127/116/112 不再被标 `need-bhvip/need-blvip`：不禁用、不显示会员角标、点击不跳付费（**4K/HDR/杜比/8K 的主门**） |
| V2 | 同上 | 35418 | `S=[k.QN_30250,k.QN_30251,k.QN_30255]` → `S=[]` | 杜比全景声/Hi-Res/杜比音效三条音轨解锁 |
| V3 | 同上 | 36798 | `children:p.audio?G([p.audio]):[],className:"need-blvip need-bhvip",disabled:!t,` → `children:p.audio?G([p.audio]):[],className:"",disabled:!1,` | Hi-Res 条目恒可选 |
| V3b | 同上 | 36897 | `onClick:({isBLVIP:e,isBHVIP:t})=>(e&&!t&&B(),t)}),!l&&d?.type` → `onClick:()=>!0}),!l&&d?.type` | Hi-Res 点击不再走付费弹窗 |
| V4 | 同上 | 37116 | `children:d.audio?G(d.audio):[],className:"need-blvip need-bhvip",disabled:!t,` → `children:d.audio?G(d.audio):[],className:"",disabled:!1,` | 杜比条目恒可选 |
| V4b | 同上 | 37213 | `onClick:({isBLVIP:e,isBHVIP:t})=>(e&&!t&&B(),t)}),(c||l)&&m.push` → `onClick:()=>!0}),(c||l)&&m.push` | 杜比点击不再走付费弹窗 |
| V5 | 同上 | 37707 | `disabled:p||!t&&d,needBLVIP:d,` → `disabled:p,needBLVIP:d,` | 视频画质条目禁用条件只保留「未登录/无线路」 |
| V5b | 同上 | 37757 | `onClick:d?({isBLVIP:e,isBHVIP:t})=>(e&&!t&&B(),t):()=>!0` → `onClick:()=>!0` | 视频画质点击恒允许（双保险） |
| V6 | 同上 | 38040 | `className:A()({"need-blvip":i,"need-bhvip":i}),disabled:!t&&i,` → `className:A()({}),disabled:!1,` | 音轨条目禁用条件清空 |
| V7 | 同上 | 73356 | `if(!M&&(V||Y&&G.length>0)||t&&!M&&e.length>0)return j();` → `if(!1)return j();` | 高级模式「下载」按钮：非 isBHVIP 不再跳付费（含切片下载） |
| V8 | 同上 | 75485 | `disabled:W||U||!M&&!L&&(V||Y)||$||p||Boolean(y),onClick:Q` → `disabled:W||U||$||p||Boolean(y),onClick:Q` | 按钮不再因非会员置灰 |
| V9 | 同上 | 75188 | `disabled:p||_||!M,status:U?"warning":""` → `disabled:p||_,status:U?"warning":""` | 音频选项框非会员不再整体禁用 |
| V10 | 同上 | 57574 | `if(V||Y||!z&&!N&&($||Q&&j.length>0)||t&&!z&&e.length>0||X&&!N||p)return!1;` → `if(V||Y||X&&!N||p)return!1;` | 简单模式：仅画面/仅音频/切片下载不再被 isBHVIP 拦 |
| V11 | 同上 | 57363 | `if(!z&&_.includes(n))return W()` → `if(!1)return W()` | 简单模式点 VIP 画质不跳付费 |
| V12 | 同上 | 57395 | `else if(_.includes(n))return o.QB.info(` → `else if(!1)return o.QB.info(` | 非 B 站大会员不再被「请先开通b站大会员」拦 |
| V13 | 同上 | 335546 | `i=()=>!!location.pathname.match("/bangumi/play")` → `i=()=>!1` | **番剧页 isPGC 恒 false**：关卡③解除，下载控件正常渲染 |
| B1 | `js/pages/background.js` | 59365 | `return Object.assign(this,e),this.downloadOptionData=H(this.basicDownloadInfo),this.recordSourceVersion()` → `return Object.assign(this,e),this.basicDownloadInfo||(this.basicDownloadInfo=await this.fetchBasicDownloadInfo(this.isPGC,this.bvid,this.cid)),this.downloadOptionData=H(this.basicDownloadInfo),this.recordSourceVersion()` | **番剧关卡①②解除**：SW 返回 null 时用 offscreen 自带 PGC-aware 的 `B()` 自取 playurl |
| B1b | 同上 | 67370 | `});Object.assign(this,e),this.downloadOptionData=H(this.basicDownloadInfo)}async doRefreshDownloadOption(e)` → `});Object.assign(this,e),this.basicDownloadInfo||(this.basicDownloadInfo=await this.fetchBasicDownloadInfo(this.isPGC,this.bvid,this.cid)),this.downloadOptionData=H(this.basicDownloadInfo)}async doRefreshDownloadOption(e)` | 刷新路径同样修好（否则下载中断后刷新仍崩） |
| B2 | 同上 | 28022 | `if(this.cache.downloader.onRateLimited(e.status,e.retryAfterSeconds),this.rateLimitedRetryTimes>me)throw c.DOWNLOAD_TOO_FREQUENTLY;` → `if(this.cache.downloader.onRateLimited(e.status,e.retryAfterSeconds),!1)throw c.DOWNLOAD_TOO_FREQUENTLY;` | DASH 分段 429/412 不再抛「下载频率过高，请稍后时间再试」（`me=3`，退避等待逻辑保留） |
| B3 | 同上 | 41477 | `if(this.cache.downloader.onRateLimited(e.status,e.retryAfterSeconds),this.rateLimitedRetryTimes>Le)throw c.DOWNLOAD_TOO_FREQUENTLY;` → `if(this.cache.downloader.onRateLimited(e.status,e.retryAfterSeconds),!1)throw c.DOWNLOAD_TOO_FREQUENTLY;` | FLV 分段同上（`Le=3`） |
| B4 | 同上 | 18584 | `if(r?.boxs.find((e=>"pssh"===e.type)))throw c.PROTECTED_BY_DRM;` → `if(!1&&r?.boxs.find((e=>"pssh"===e.type)))throw c.PROTECTED_BY_DRM;` | 可选：带 `pssh` 但实为明文的流不再中断（真 Widevine 仍是密文，见 §5.2 关卡④） |
| S1 | `initBackground.sw.js` | 540438 | `if(e)return null;{const e=yt.UGC;` → `{const e=yt[this.isPGC?"PGC":"UGC"];` | 方案乙：SW 放行 PGC 并请求 v2 端点（与 B1 等效，可只取其一） |
| S2 | `initBackground.sw.js` | 540621 | `.then((t=>e?t?.data?.video_info:t?.data))` → `.then((t=>e?(t?.result||t?.data)?.video_info:t?.data))` | 方案乙配套：v2 回包结构取 `result.video_info` |

### 6.2 条件补丁（`tools/proto-patch-optional.json`，按需）

| # | 文件 | 偏移 | old → new | 何时打 |
| --- | --- | --- | --- | --- |
| B5 | `js/pages/background.js` | 9122 | `s=await fetch(e,t).catch((e=>{throw e}))` → `s=await fetch(e,Object.assign({credentials:"include"},t)).catch((e=>{throw e}))` | patch 后取到的画质仍锁在 360P/480P（说明 offscreen 的裸 `fetch` 没带上 B 站 cookie） |
| B6 | 同上 | 10771 | `o=D("https://api.bilibili.com"+a,{bvid:t,cid:i,qn:n,fnver:0,fnval:4048,fourk:1,tabId:this.tabId})` → 追加 `,ep_id:this.epid` | 番剧 `playurl` 返回 `-404`/`video_info` 为空（v2 端点只认 `ep_id` 时） |

### 6.3 校验命令（原样可跑）

```bash
cd "D:/AI-Project/逆向统一/acghelper"

# 1) old 唯一性 + 偏移一致性（23 条全 PASS 才继续）
python tools/proto-patch-check.py tools/proto-patch-spec.json
# 期望: SUMMARY ok=23 fail=0 total=23

# 2) 单条 count 自证（示例：V1）
python tools/proto-locate.py src/extracted/js/pages/video.js \
  '_=[y.QN_127,y.QN_126,y.QN_125,y.QN_120,y.QN_116,y.QN_112]' --all --count
# 期望: count=1

# 3) 生成补丁副本 + node 语法验收（不动 src/extracted）
python tools/proto-apply-patches.py tools/proto-patch-spec.json \
  --out output/patch-2.8.31.16 --node
# 期望: 3 个文件 node --check: OK

# 4) 门判据前后语义复算（9 条）
node tools/proto-verify-gates.js
# 期望: SUMMARY pass=9 fail=0 total=9

# 5) 出可加载 zip
python tools/proto-repack.py
# 期望: zip -> output/acghelper-2.8.31.16-patched.zip (3688768 bytes)
```

> **与静态角色的补丁合并时**：本文的偏移全部以 `src/extracted` 原件为基准。若先打别人的补丁（例如本地授权层那 10 条），文件长度已变、偏移会失效，此时用
> `python tools/proto-apply-patches.py tools/proto-patch-spec.json --root build/<别人的产物> --out build/merged --no-offset-check`
> ——只校验 `old` 唯一性（`count==1`），仍然安全；顺序反过来（先打本文件 23 条，再打别人的）则双方都不需要额外开关。

### 6.4 产物（已生成，可直接核对）

| 产物 | 大小 | SHA256 |
| --- | --- | --- |
| `output/patch-2.8.31.16/js/pages/video.js` | 534,746 | `16a2dba6b76310759265ab4abdb157c0cdf8ce99f57f90d43557ce00c1332e3b` |
| `output/patch-2.8.31.16/js/pages/background.js` | 112,228 | `603cdc1d853377d97441fa0543f1e50890320a8adaf1ecc0ce4f860cd0f83e4f` |
| `output/patch-2.8.31.16/initBackground.sw.js` | 839,066 | `629965ba42a5a8c12121754b46ff48fb8d2ac4f728a7b2e698f685fec320696f` |
| `output/acghelper-2.8.31.16-patched.zip`（含全量扩展 + 3 个替换文件） | 3,688,768 | `b5f3b0014364156f6c4cca67ad0a05f430a1e495dd1fb2b2c5f0f0bab5756de4` |
| `build/acghelper-patched-2.8.31.16/` | — | 未打包的加载目录 |

---

## 7. 执行与验证（怎么跑、怎么判成功）

### 7.1 安装被测构建

1. `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 `build/acghelper-patched-2.8.31.16`（或把 `output/acghelper-2.8.31.16-patched.zip` 解压后加载）。
2. 关掉所有 `*.bilibili.com` 标签页再重载扩展（**旧 content script 不会自动更新**，这是最常见的「打了补丁没效果」原因）。
3. 登录 B 站账号（要保持插件侧 `getStatus` 有返回，否则走的是「未登录」分支 `w.includes(qn)`，与会员无关但会提示「请先登录bilibili账号」）。

### 7.2 成功判据（逐条可观察）

| 目标 | 判据 |
| --- | --- |
| 4K/HDR/杜比/8K 选项解锁 | UGC 视频打开下载面板 → 高级模式「画面选项」里出现 `4K 超清`/`HDR 真彩`/`杜比视界`/`8K 超高清`，**无「会员」角标**，展开有线路子项；直接点「下载」不再弹付费页 |
| 仅画面/仅音频/切片 | 高级模式把音轨叉号去掉（仅画面），点下载 → 进度条开始走（补丁前是跳付费） |
| 音频高阶轨 | 「音频选项」可用，含 `杜比全景声 / Hi-Res / 杜比音效`，可直接单选下载 |
| 番剧 | 打开 `https://www.bilibili.com/bangumi/play/ep<id>` → 下载面板**出现画质选项**（不再是「数据初始化中」/「根据站方要求…」）→ 点下载产出 `.mp4` |
| 频率限制 | 连续多次下载不再出现「下载频率过高，请稍后时间再试」（仍会看到进度停滞 + 自动退避恢复） |

### 7.3 最小验证命令（本地、不起浏览器）

```bash
node tools/proto-verify-gates.js | tail -3      # 门判据 9/9
python tools/proto-patch-check.py tools/proto-patch-spec.json | tail -1   # ok=23 fail=0
```

### 7.4 「是否纯本地可解」的明确结论

| 能力 | 是否纯本地可解 | 说明 |
| --- | --- | --- |
| 解除「仅画面/仅音频/切片下载」的助手会员限制 | ✅ 是 | 门在 `video.js` 三处 `if/disabled`（V7/V8/V9/V10） |
| 让 4K/HDR/杜比/8K 选项**可见可选可下** | ✅ 是 | V1/V2/V3/V3b/V4/V4b/V5/V5b/V6 |
| 真的拿到 4K/8K **码流** | ⚠️ 取决于 B 站账号大会员 | 站方按权益下发 `support_formats`；扩展只是不再自我阉割。若账号是大会员但取到的仍是低码率，打 B5（带 cookie） |
| 番剧下载 | ✅ 本地可解（非 DRM 集） | V13 + B1/B1b（或 S1/S2） |
| Widevine 加密集 | ➖ 内容加密，非插件限制 | B4 只能放过「带 pssh 但实为明文」的流；真加密需要 CDM 密钥 |
| 绕过 acghelper 服务端 | ❌ 不需要 | 下载链路 0 服务端依赖（§4） |

---

## 8. 失败分支（最常见 3 个 + 改法）

1. **打了补丁还是弹付费页 / 按钮仍灰**
   多半是 `src/extracted` 被加载而不是补丁副本，或旧标签页仍在跑旧脚本。
   处理：`chrome://extensions` 里确认「来源」指向 `build/acghelper-patched-2.8.31.16`；关掉全部 bilibili 标签页 → 重载扩展 → 重新打开页面；`F12 → Elements` 看 `#bilibili-helper-video-download` 里还有没有 `upgrade-vip-link` 节点（有 = 加载的还是旧版）。
2. **4K 选项能选但下载下来是 720P/1080P**
   `support_formats` 里根本没有 120/125/126/127（账号无大会员），或者 offscreen 的 `fetch` 没带 cookie。先看面板列表里是否列出 4K：列出但下不到 → 打 B5；没列出 → 是站方权益，不是补丁问题。
3. **番剧点下载报错 / 一直「数据初始化中」**
   ① 只打了 V13 没打 B1/B1b → 仍停在初始化；② PGC v2 端点只认 `ep_id` → 打 B6；③ 报「该视频受DRM保护」→ 命中关卡④，该集是真 Widevine；④ SW 未更新（`chrome://serviceworker-internals` 里 ACGhelper 的 SW 还是旧版本）→ 移除扩展重新加载。
4. **429 太密集导致下载反复退避**
   B2/B3 已去掉抛错，但 `lt`（off 56582）仍会按 `412→120s / 429→60s ×2^(n-1)` 退避（上限 300s）。要更快就同时调 `st=16777216`（16MB/s 上限）与 `tt=2.4`（码率倍数），但会更快触发站方限速。

---

## 9. 回滚与清理

```bash
cd "D:/AI-Project/逆向统一/acghelper"
# 1) src/extracted 全程只读，未修改；用哈希自证
python - <<'PY'
import hashlib
for f in ['src/extracted/js/pages/video.js','src/extracted/js/pages/background.js','src/extracted/initBackground.sw.js']:
    print(f, hashlib.sha256(open(f,'rb').read()).hexdigest())
PY
# 期望与 §1 基线一致：5afd2808… / 9b4d064c… / 3200a275…

# 2) 删除本轮所有派生产物（不碰原始 zip 与 src/extracted）
# 派生构建与补丁产物（docs/_scratch 是证据切片，建议保留以便复核；要清就一并删）
rm -rf build/acghelper-patched-2.8.31.16 output/patch-2.8.31.16 output/acghelper-2.8.31.16-patched.zip

# 3) 浏览器侧还原
#    chrome://extensions 移除「加载已解压」的副本 → 重新从 acg-helper-2.8.31.16.zip 加载原始版
#    或在扩展详情页点「重新加载」，再关闭所有 bilibili 标签页
```

进程 / 服务清理：本轮**未启动任何浏览器、未起后台进程、未注册任何服务**（纯静态读码 + python/node 一次性脚本），无需额外清理。

---

## 10. 未解 / 待实测的问题

1. **offscreen 的 `fetch` 到底带不带 B 站 cookie**：`js/pages/background.js` 里 `async function A(e,t={},i=6,n=1e3,r=!1){...fetch(e,t)...}`（off **9055**）没有任何 `credentials` 选项，全文件 `credentials` 命中 1 处且是 `<audio crossOrigin>`。MV3 下扩展页面对 `host_permissions` 内主机的裸 `fetch` 是否随带 cookie，需要用真实登录态实测；这决定「B5 是否必须」。判据已在 §7.2/§8.2 给出。
2. **番剧 `v2/playurl` 对 `bvid+cid` 的接受度**：本扩展只用 `bvid+cid`（bg `B`）或 `ep_id`（SW `fetchPlayUrl`）。某些季度/剧集可能必须 `ep_id` → 已备 B6。
3. **PGC 大会员集的 DRM 覆盖面**：`drm_tech_type` / `pssh` 的实际分布未在本轮取样（无登录账号、无抓包环境）。B4 只在「带 pssh 但明文」时有效，需要真实集验证。
4. **`isBHVIP` 判定器本体**（`(0,T.mg)` / `(0,b.mg)` 与 `identities` 时间段逻辑）按分工未展开，由另一路静态分析交付；本文只用到「它是个布尔、来源为 acghelper `getState`」这一层。
5. **`config.js`（342 KB）里同一套下载器代码的第三份拷贝**（off 254424 起）未逐条对齐；如果用户在「配置页」里也用下载功能，需要把 §6.1 里 bg 的 B1/B2/B3/B4 在 `config.js` 对应位置再打一遍。

---

## 附：可复现脚本清单（`tools/`，前缀 `proto-`）

| 脚本 | 作用 |
| --- | --- |
| `proto-locate.py` | 单文件定位：字符偏移 + utf8 字节偏移 + 行/列 + 上下文；`--count` 只出次数 |
| `proto-grep.py` | 跨文件 / 正则定位，输出紧凑一行一条 |
| `proto-ctx.py` | 打印 needle 前后上下文（多命中） |
| `proto-slice.py` | 按字符区间切片并写文件（可 `--wrap` / `--break-on` 便于阅读压缩代码） |
| `proto-patch-check.py` | 校验 patch spec：`count==1` + 偏移一致 + 替换后 new 出现 |
| `proto-apply-patches.py` | 先全量校验再写补丁副本（`--node` 追加 `node --check`） |
| `proto-verify-gates.js` | 门判据前后语义复算（9 条断言） |
| `proto-repack.py` | 补丁覆盖到完整副本并打 zip（可加载） |
| `proto-patch-spec.json` / `proto-patch-optional.json` | 主补丁 / 条件补丁规格 |
