# 番剧（PGC）下载 0 字节根因报告

- 样本：ACGhelper 2.8.31.16（Chrome MV3）成品树 `output/ACGhelper-2.8.31.16-unlock`（static 10 + proto 23 + extra 5 = **38 条**）
- 只读基准：`src/extracted`（未改动，构建前后指纹一致）
- 本轮新增：`tools/feature-pgc-fix.json`（4 条补丁）、`tools/apply-feature-pgc-fix.py`、`tools/verify-pgc-merge.mjs`、`tools/fixtures/**`
- 结论状态：根因已复现（真实回包 + 真容器字节 + 成品真代码跑通），修复后验证装置 14/14 PASS

---

## 0. 一句话根因

**PGC 的 `playurl` 回包分两种形态：`dash`（正常）与 `durl`（预览/试看）。`durl` 形态的载荷是 MP4 整文件，不是 FLV；但成品只按 `isFLV: durl && !dash` 判形态，把它送进 FLV 合并器 `Ue`，`Ue` 在构造器里就抛 `FLV_IS_MP4(6)`——此时文件已被 `createWritable()` 创建、分段也全部拉完（进度 100%），但**一次 `write()` 都没发生**，于是产物 0 字节。**

UGC 4K/杜比走 `dash` 形态，`isFLV` 为 false，进的是完全不同的 `downloadDash`，所以不受影响。

---

## 1. 现象与既有证据（用户机器）

| 产物 | 大小 | 时间 | ffprobe |
| --- | --- | --- | --- |
| `E:\Downloads\《JOJO的奇妙冒险_石之海》.第1话_石之海.456486205.mp4` | **0 B** | 17:35 | `moov atom not found` / `Invalid data found` |
| `E:\Downloads\【4K限免】你的新设备能顶住吗_影视飓风年度样片.【双杜比】…36085892352.mp4` | 5,384,875 B | 17:34 | `duration=218.559667`，`streams=[aac]`，`format=mov,mp4,m4a` |

补充两条本轮新采的证据（同机、只读）：

1. `ffprobe` 复测成功产物：`format.duration=218.559667`、`streams=1（aac）`、`size=5384875` —— **moov 完整、可解析**，说明 DASH 的「写 head/moov → 逐段写 → close」整条链路是通的（附件：`build/pgc-proto/verify-pgc-merge.json` case5 用同一写入顺序复跑出 `identical=true`）。
2. **两个 mp4 都不在 Chrome 下载库里**：`Default/History` 的 `downloads` 表最新一条是 `id=300 / 2026-11-08 07:58 UTC / 影之刃便利性工具_v1.2.rar`（本地 15:58），17:34/17:35 那两次没有任何 download 记录。
   → 说明产物不是下载管理器（streamsaver / `chrome.downloads`）落的，而是 **File System Access**：`showSaveFilePicker()` → `createWritable()` **在返回的瞬间就把目标文件创建成 0 字节**，之后写不写、写多少全看后续 `write()`。

这条把「0 字节」锁死成一句话：**文件被创建了，内容一次都没写进去。**

---

## 2. 调用链速查（谁在哪个上下文跑）

```
[bilibili 页面] js/pages/video.js
   └─ chrome.runtime.sendMessage{to:"offscreen",target:"videoDownload",command:"startDownload",
        cid, downloadOptionIndex:"<videoIdx>,<audioIdx>", optionDataVersion, segments}
        ↓
[offscreen 文档] html/background.html → js/pages/background.js
   ├─ 路由 yi → St（command 分发）
   ├─ class bt.init()      ← 反向问 SW 要 videoParse 结果；空则用本文件 B() 自取（B1/B1b）
   ├─ bt.download()        ← 唯一分叉点
   │     `this.basicDownloadInfo.isFLV ? this.downloadFLV(e,i,n) : this.downloadDash(e,t,i,n)`
   ├─ downloadFLV → class Be（FLV/durl 缓存）→ writeFile = Ce
   └─ downloadDash → class Ie（DASH 缓存）→ writeFile = ye
```

成品树 `js/pages/background.js` 关键锚点（字符偏移，38 条树）：

| 位置 | 锚点 |
| --- | --- |
| @8032 | `isFLV:r&&!n` |
| @6868 | `R=e=>{const{backupUrl:t,…}`（把 dash 的 `SegmentBase` 归一成 `range:{start,end}`） |
| @10652 / @10917 | `const B=async function(...)` / `.then((t=>e?t?.result?.video_info:t?.data))` |
| @11661 | `H=e=>{const{dash:t,acceptQuality:i`（下载选项构造器） |
| @15078 / @15138 | `if(!n?.durl\|\|0===n?.durl?.length)throw c.ERROR_REQUEST_DATA` / `this.segmentInfo=n.durl.map(`（`q`=Be.initFLVSegments） |
| @32308 | DASH 逐段写入门 |
| @36259 / @52003 | `Ie.getWritable(e=!1)`（DASH）/ `Be.getWritable()`（FLV，`keepExistingData:!0`） |
| @47094 / @47141 | `Ue` 构造器的 `ftyp` / `FLV` 检测 |
| @49094 | `static async mergeArrayBuffers(e)` |
| @49807 | `Ce=async function(e=l.video)`（Be.writeFile） |
| @50281 | FLV 写入门 `…&&!await r.closed` |
| @60120 / @60551 | `segmentInfoGroupProgressUpdate` 监听 / `this.emit("progress",Math.round(i/n*1e4)/100)` |
| @61236 | `complete` → `getWritable()`+`close()` |
| @61566 | `runWriteFile(e,t=l.video)` |
| @62127 | `download()` 分叉 |
| @62803 | `downloadFLV` 的 `showSaveFilePicker` |
| @69629 | `addListenerIfNone("error"` → `downloadError` 出口 |

---

## 3. 逐条回答

### 3.1 PGC `playurl` 走哪条分支？`isFLV` 怎么判？dash 与 durl 同时存在取哪个？

归一化函数 `L()`（成品树 @8030 起，原文）：

```js
// L = e => { ... const {dash:n, durl:r, accept_description:s, accept_format:a, accept_quality:o,
//                  format:d, from:h, support_formats:c, timelength:l, video_codecid:u, quality:f, is_preview:m} = e;
return{acceptDescription:s,acceptFormat:a,acceptQuality:o,format:d,from:h,quality:f,
 supportFormats:c.map(...),timeLength:l,videoCodecid:u,
 isFLV:r&&!n,
 dash:n?{video:t,audio:i,duration:n.duration,minBufferTime:n.minBufferTime,flac:...,dolby:...}:null,
 durl:r&&r.length>0?r.map((({backup_url:e,...t})=>({...t,backupUrl:e}))):void 0}}
```

- `r` = `video_info.durl`（数组），`n` = `video_info.dash`（对象）。
- `isFLV = r && !n` 的真实语义：**只有「有 durl 且没有 dash」才为真**。三种组合：

| 回包形态 | `r` | `n` | `isFLV` | 走的路径 |
| --- | --- | --- | --- | --- |
| dash only（正常番剧/UGC） | undefined | 对象 | falsy | `downloadDash` |
| dash + durl 同时存在 | 数组 | 对象 | **falsy**（`r && !n` = false） | `downloadDash` ← **dash 优先** |
| durl only（预览/试看） | 数组 | undefined | 真（返回的是数组本身，truthy） | `downloadFLV` ← 事故点 |

- PGC 侧取数在 offscreen 自己的 `B()`（@10652）里：
  ```js
  const a=e?f.PGC:f.UGC,            // PGC="/pgc/player/web/v2/playurl"  UGC="/x/player/wbi/playurl"
  o=D("https://api.bilibili.com"+a,{bvid:t,cid:i,qn:n,fnver:0,fnval:4048,fourk:1,tabId:this.tabId,ep_id:this.epid}),
  d=await A(o).then((e=>e.json())).then((t=>e?t?.result?.video_info:t?.data)).then(L)
  ```
  SW 侧 `Yt()` 的 S1/S2 补丁与之同构（`(t?.result||t?.data)?.video_info`）。
- **真实回包采样（本轮实测，非推测）**：对番剧索引前 60 部各首集、qn∈{120,80,16}、`fnval=4048&fourk=1`（与成品完全同参）共 180 次请求：

  ```
  组合统计 (dash,durl) -> 次数: {(True, False): 141, (False, True): 39}
  ```
  39 个 durl-only 样本全部满足 `format="mp4"`、`is_preview=1`（剧场版 / 大会员首集等预览形态）。落盘样本：
  - `tools/fixtures/pgc/pgc-playurl-750015-preview-durlonly.json`（ep=750015《刀剑神域进击篇：无星之夜》，`is_preview=1`，`dash` 缺失，`durl` 1 段）
  - `tools/fixtures/pgc/pgc-playurl-826497-dash.json`（ep=826497《鬼灭之刃 柱训练篇》，`dash` 有、`durl` 缺失）

> 注意：`format` 字段**不能**用来判形态——dash 形态的样本里 `format` 也可能是 `"flv480"`（同上 dash 样本 `format="flv480"` 却只有 dash）。所以正确判据只能是「`dash` 有没有」+「首段字节 magic」。

### 3.2 进度 100% 但 0 字节，钱花在哪：确定的根因

**确定根因（唯一）**：`durl` 分段的载荷是 MP4，FLV 合并器在**任何 write 之前**就抛异常。

证据链（每环都可复跑）：

**(a) durl 载荷首字节不是 FLV** —— 真实抓取，`tools/fixtures/pgc/real-preview-durl-head64.bin`（64 B，sha256 `e68b9833…a0d0`）：

```
000000206674797069736f6d0000020069736f6d69736f32617663316d70343100046e9a6d6f6f76…
       ^^^^^^ ftyp@4                                    …  moov@36
```

**(b) FLV 解析器构造器先查 magic，命中即抛** —— `Ue`（成品树 @47094）：

```js
class Ue{header;firstPreviousTagSize;tags;constructor(e){
  if(e.indexOf("ftyp",0,5)>=0)throw c.FLV_IS_MP4;
  if(e.indexOf("FLV",0,1)<0)throw c.INVALID_FLV_HEADER;
  ...
```

`Ae`（DataView24）的 `indexOf` 是自定义实现，循环 `for(n=t;n<i;n++)` 只约束**起点**，内层逐字节比较可以读到 `i` 之外；所以 `indexOf("ftyp",0,5)` 在 `ftyp@4` 时返回 `4`（≥0）→ 抛 `FLV_IS_MP4`，错误文案 `"该FLV视频源中混有MP4数据，无法合并为FLV文件，请尝试其他清晰度"`（枚举见 @1554 起的 `const c={...}`）。

**(c) 抛出点在 write 之前** —— `Ce`=Be.writeFile（成品树 @49807）：

```js
Ce=async function(e=l.video){
  if(this.writing||this.stopping)return;
  this.writing=!0;let t=!1;
  try{
    const e=this.getSegmentInfo();if(!e)return;
    const i=this.getNextWritePosition();if(i>e.length)return void(t=!0);
    const n=this.getSegmentBuffer(i);if(!n)return;
    const r=await this.getWritable();if(!r)throw c.WRITABLE_IS_NOT_AVAILABLE;
    if(this.segmentBuffer.filter(Boolean).length!==e.length)return;
    {const t=await Me.mergeArrayBuffers(this.segmentBuffer);   // ← 这里抛
     (r&&"locked"in r&&!r.locked||r instanceof WritableStreamDefaultWriter&&!await r.closed)&&await r.write(t),
     this.writePosition=e.length-1,this.deleteAllSegmentBuffer()}
    t=!0
  }finally{this.writing=!1,t&&this.downloader.emitter.emit("finishWrite",e,this)}}
```

`mergeArrayBuffers`（@49094）内部 `new Ue(new Ae(a))` 解析首段 → 抛；`write()` 那一行永远不执行 → 文件保持 0 字节，`finishWrite` 不发 → `complete` 不发 → 进度停在上一次 `progress` 事件（分段全部拉完 = 100%）。

**(d) 进度 100% 的来源与写盘无关** —— `bt.init()` 里注册的 `segmentInfoGroupProgressUpdate` 监听（@60120，`emit("progress",…)` 在 @60551）：

```js
if(e instanceof Be){const t=e.segmentInfo,i=t.reduce(((e,{progress:t})=>e+t),0),n=t.reduce(((e,{size:t})=>e+t),0),
  this.emit("progress",Math.round(i/n*1e4)/100)}
```

`progress` 累加在 **fetcher 的字节回调**里（`De.fetch` → `this.listeners.forEach((e=>{e(i)}))`），`size` 取 `durl[i].size`。也就是说进度条只反映「拉取」，**从不反映「写入」** —— 这就是「100% 但 0 字节」的结构性原因。

**(e) 装置复现（成品真代码，非等价复刻）**：`node tools/verify-pgc-merge.mjs`

```
[PASS] case1 baseline durl-mp4-preview：合并器按 FLV 解析 → 抛错且写出 0 字节（= 事故现场）
        outcome=threw code=6 message=该FLV视频源中混有MP4数据，无法合并为FLV文件，请尝试其他清晰度 bytes=0
```

#### 排除的其它候选（逐条否掉，不是「可能」）

| 候选 | 否掉依据 |
| --- | --- |
| ① 分段拉完但写流从没 `write()`，异常发生在 `close()` 前 | 方向对但**机制不是 close**：`complete` 监听（@61236）`const t=await e.getWritable();await t.close()` 只有在 `writePosition` 推进后才会触发；异常在 `mergeArrayBuffers` 就抛出，`close()` 根本没到。且 FSA 的 `close()` 失败不会清空已写字节（会留下 >0 字节的半成品），与 0 字节不符。 |
| ② `downloadOptionData` 空 → `H()` 产出 `video:[]/audio:[]` | `H()` 对 isFLV 形态**不是**空：`(a\|\|s)&&u.push(...c.map(...))`，`c = acceptQuality`（预览样本是 `[112,80,64,32,16]`），只把 `children` 置空（`const i=s?[]:k(...)`）。若 `video[]` 真为空，`downloadFLV` 第二行 `this.getOptionDataByVersion(i).video[n].value` 会在**取文件之前**抛 TypeError，进度不会到 100%，也不会创建文件。 |
| ③ `optionDataVersion` 与 offscreen `bt` 实例不匹配 → 落「未找到下载器」被静默吞掉 | `getOptionDataByVersion`（@68235）在版本查不到时 `throw c.DOWNLOAD_OPTION_DATA_OUTDATED`（真实错误，不是静默）；分发器的 `未找到下载器` 分支（`if(!a)return void i({message:"未找到下载器"})`）发生在 `bt.download()` 之前，**不会创建任何文件**。 |
| ④ FLV 的 `durl` 合并（首段带 FLV header）写错 | 反证：真 FLV 输入下 `Ue.merge` 正确 —— 装置 case3 baseline `bytes=19888 magic=FLV`，ffprobe `duration=1.25s streams=2`，且能被成品自己的 `Ue` 重新解析（`reparse=true`）。FLV 形态本身没坏。 |
| 其它：DRM / pssh | 真实预览回包 `is_drm:false`，且 `B4` 已让 pssh 不中断；与本现象无关。 |

### 3.3 「打包失败」这句提示的真实来源，它掩盖了什么

**成品树里没有「打包失败」这四个字**：对 `output/…-unlock` 全树（`*.js/*.json/*.html/*.css`，先把 `\uXXXX` 解码）抓 `打包` → **0 命中**。

真实来源是下面这条链，用户看到的文案其实是「合并失败」语义：

```js
// Be.writeFile 抛 h(FLV_IS_MP4, "该FLV视频源中混有MP4数据，无法合并为FLV文件，请尝试其他清晰度")
// → bt.runWriteFile 的 catch（@61566）
runWriteFile(e,t=l.video){const i=e.writeFile(t);i.catch((e=>this.emit("error",e)))}
// → 发起 initDownloader 时注册的 error 监听（@69629）
s.addListenerIfNone("error",(e=>{_t(s,e instanceof h
    ?{command:"downloadError",message:e}
    :{command:"downloadError",message:new h(e?.code||-1,e.message)})}),"offscreen")
// → 页面 video.js：downloadError 分支
else if("downloadError"===e?.command)he(null),h.includes(e.message?.code)?(E(!0),Z(e.message))
    :e.message.code===m.CANCEL?(Z(null),te(!1)):(C(e.message)&&(fe.current=!0),Z(e.message)),a();
// 另一套面板：setDownloadError → n.QB.error(e.error.message) + hasError
```

它掩盖的真实异常分两种：

1. **本次事故**：`h(6, "该FLV视频源中混有MP4数据…")`。文案把用户引向「换个清晰度」，但预览/试看形态的任何清晰度都是同一个 MP4，换也没用；真正的问题是「分类错了 + 载荷本来就不需要合并」。
2. **更糟的一类**：FLV 合并器里还有多处 `throw "字符串"`（`"FLV unexpected end of file"`、`"timestamp < 0"`、`"Usage: FLV.mergeBlobs([blobs])"`）。字符串没有 `.message`，走到 `new h(e?.code||-1, e.message)` 后 `message` 变 `undefined` → UI toast 空内容（用户侧就只能读成「处理/打包失败」这种无语义提示）。装置 case6 复现：`type=string message=undefined`。

**暴露方式**：`F3` 在 `bt` 侧统一归一化（`e instanceof h ? e : new h(r.ERROR_REQUEST_DATA, "落盘失败: "+(e?.message||String(e)))`），`F4` 让 FLV 分支的 picker 异常不再被 `.catch((e=>{}))` 吞成 `CANCEL`；`F1` 把本次事故直接变成成功（不再有异常可掩盖）。装置 case6/case7 验证。

### 3.4 PGC 的 `durl` 字段、range 取法，和 UGC 是不是同一套 fetcher

真实 `durl` 元素（`tools/fixtures/pgc/pgc-playurl-750015-preview-durlonly.json`）：

```json
{"size":31721638,"ahead":"","length":360151,"vhead":"","backup_url":["https://…","https://…"],
 "url":"https://upos-sz-mirrorcoso1.bilivideo.com/upgcxcode/…/…-1-16.mp4?…","order":1,"md5":"…"}
```

| 字段 | 是否带 | 代码怎么用 |
| --- | --- | --- |
| `order` | 1 | `doRefreshSegmentInfo` 里按 `order` 找对应段并比对 `size`，不一致抛 `DOWNLOAD_OPTION_CHANGED_AFTER_REFRESH`；建段时只用下标 |
| `size` | 有 | `q()`：`this.segmentInfo=n.durl.map(((e,t)=>({index:t,info:e,size:e.size,progress:0})))` — 进度分母与限速位率都用它 |
| `length` | 有（毫秒） | **未被使用**，只随 `info` 挂着 |
| `vhead` / `ahead` | 空串 | **未被使用**（FLV 形态里本来是给合并器垫头用的） |
| `backup_url` | 有 | `L()` 改名成 `backupUrl` → `De.syncLinesFromSegmentInfo()` / `switchLine()` 做多线路切换 |
| `url` | 有 | `new De(this,e,i,a.url,null)` 整段下载 |

**取流是两套类，不是同一套**：

| | FLV / durl | DASH |
| --- | --- | --- |
| fetcher 类 | `De`（@38098） | `pe` |
| 建实例 | `new De(this,e,i,a.url,null)` ← range 恒 `null` | 带 `range` 建实例 |
| Range 头 | **不发**（`this.range&&(e.range=\`bytes=…\`)` 不成立） | `bytes=${range.start}-${range.end}` |
| range 来源 | — | `R()`（@方法体）：`[f]=(SegmentBase?.Initialization\|\|segment_base?.initialization)?.split("-")`、`[,m]=(SegmentBase?.indexRange\|\|segment_base?.index_range)?.split("-")` → `range:{start:f,end:m}` |
| 共用 | `A()`（重试/429 退避）、`lt`（rateLimiter）、`c` 错误枚举、`errorRequestSegmentIndex`、`onRateLimited` | 同左 |

→ 结论：**durl 分段不带 range、整段拉取；DASH 用 `Initialization/indexRange` 算 `bytes=start-end` 再靠 sidx 切段**。两者共用重试与限速，但 fetcher 实现分叉。

---

## 4. 修复方案

新文件 `tools/feature-pgc-fix.json`（4 条，`old` 均在 38 条成品树上 `count==1`）：

| id | 目标 | 改动 |
| --- | --- | --- |
| **F1** | 根因 | `mergeArrayBuffers` 抛错时，若首段前 12 字节内出现 `ftyp`，按「MP4 分段原样顺序拼接」回退（`new Blob(this.segmentBuffer)`）；否则原异常照抛（不掩盖真 FLV 错误） |
| **F2** | 同链路两个独立缺陷 | 写入门去掉 `&&!await r.closed`（`WritableStreamDefaultWriter.closed` 在流关闭前恒 pending → 死锁）；writer 通道把 Blob 转 `Uint8Array`（streamsaver sink 只收 Uint8Array）；FSA 通道保持 Blob 零拷贝 |
| **F3** | 错误可见性 | `runWriteFile` 归一化：`h` 实例原样透传，其它（含字符串抛出）包成 `h(ERROR_REQUEST_DATA, "落盘失败: "+… 真实原因)` |
| **F4** | 错误可见性 | FLV 分支 picker 的 `.catch((e=>{}))` → `.catch((e=>{if("AbortError"!==e.name)throw e}))`，与 DASH 分支同口径 |

为什么这样修是安全的：

- 三条改动**全部落在 `isFLV` 为真的分支内部**（`Ce` / `downloadFLV` / `runWriteFile` 的 FLV 调用点），DASH 的 `ye`、`downloadDash` 的 head/moov 写入、`Ie.getWritable` 一行没动；装置 case8 对 DASH 的 5 处关键语句做逐条 `count==1` 断言（补丁前后一致）。
- F1 的回退判据是**字节 magic**（`ftyp` in 前 12 字节），不是 `format` 字符串（`format` 在 dash 形态下也可能是 `flv480`，不可信）。
- 真 FLV 输入不触发回退：`mergeArrayBuffers` 正常返回，路径与修复前完全一致（装置 case3 双向验证）。

应用与校验：

```bat
:: 1) 只校验锚点（不写盘）
python tools\apply-feature-pgc-fix.py --check

:: 2) 打到 38 条成品树，产出独立目录（不动 output/、不动 src/extracted）
python tools\apply-feature-pgc-fix.py --out build\pgc-proto\tree38-fixed

:: 3) 语义验证
node tools\verify-pgc-merge.mjs --json build\pgc-proto\verify-pgc-merge.json
```

**`--check` 真实输出**（在 `output/ACGhelper-2.8.31.16-unlock` 上跑）：

```
[OK] F1  js/pages/background.js   count=1 offset=50197 len(old)=55
[OK] F2  js/pages/background.js   count=1 offset=50252 len(old)=105
[OK] F3  js/pages/background.js   count=1 offset=61566 len(old)=84
[OK] F4  js/pages/background.js   count=1 offset=62803 len(old)=131

应用顺序（偏移降序）:
  F4  js/pages/background.js   off=62803   112297 -> 112329 chars
  F3  js/pages/background.js   off=61566   112329 -> 112409 chars
  F2  js/pages/background.js   off=50252   112409 -> 112490 chars
  F1  js/pages/background.js   off=50197   112490 -> 112805 chars

CHECK 通过：4 条 old 全部 count==1（未写盘）。
```

**应用真实输出**：

```
输出目录: build\pgc-proto\tree38-fixed
  js/pages/background.js   sha256=b02477a7c546efc8735b246c0072a3fe29ccae6ef1068bdd454f65805edee85e
  原始目录指纹未变: 1812e55cdb28a60517a1e5733917a1e9f359676bc9fe61765433f3ab4238354c
完成：4 条补丁已应用。

node --check build/pgc-proto/tree38-fixed/js/pages/background.js  →  SYNTAX OK
node --check build/pgc-proto/tree38/js/pages/background.js        →  SYNTAX OK
```

（`output/ACGhelper-2.8.31.16-unlock/js/pages/background.js` 补丁前后 sha256 都是 `1812e55c…54c`，成品树未被改动。）

修复位原文对照（成品树 → 修复后）：

```js
// F1 前
const t=await Me.mergeArrayBuffers(this.segmentBuffer);
// F1 后
let t;try{t=await Me.mergeArrayBuffers(this.segmentBuffer)}catch(_e){
  const _s=this.segmentBuffer[0],
        _v=_s&&_s.subarray?_s.subarray(0,12):_s?new Uint8Array(_s,0,Math.min(12,_s.byteLength)):null;
  let _f=!1;if(_v)for(let _i=0;_i+4<=_v.length;_i++){if(_v[_i]===102&&_v[_i+1]===116&&_v[_i+2]===121&&_v[_i+3]===112){_f=!0;break}}
  if(!_f)throw _e; t=new Blob(this.segmentBuffer)};

// F2 前
(r&&"locked"in r&&!r.locked||r instanceof WritableStreamDefaultWriter&&!await r.closed)&&await r.write(t)
// F2 后
(r&&"locked"in r&&!r.locked||r instanceof WritableStreamDefaultWriter)&&
  await r.write(t instanceof Blob&&r instanceof WritableStreamDefaultWriter?new Uint8Array(await t.arrayBuffer()):t)

// F3 前
runWriteFile(e,t=l.video){const i=e.writeFile(t);i.catch((e=>this.emit("error",e)))}
// F3 后
runWriteFile(e,t=l.video){const i=e.writeFile(t);i.catch((e=>this.emit("error",
  e instanceof h?e:new h(r.ERROR_REQUEST_DATA,"落盘失败: "+((e&&e.message)||String(e))))))}

// F4 前
await window.showSaveFilePicker({…["video/x-flv"]:[".flv"]…}).catch((e=>{}))
// F4 后
await window.showSaveFilePicker({…["video/x-flv"]:[".flv"]…}).catch((e=>{if("AbortError"!==e.name)throw e}))
```

---

## 5. 验证装置（`tools/verify-pgc-merge.mjs`）

做法：**不重写逻辑**，按锚点从成品树里抽出真实代码（`class h extends Error`、错误枚举、`const c={…}`、`Ae`/`Pe`/`Ue`、`Ce`=Be.writeFile、`bt.runWriteFile`、`downloadFLV` 的 picker catch），在最小 mock（writable sink / `downloader.emitter`）上执行；两个树（38 条 baseline / 打过 F1–F4 的 fixed）各跑一遍做差分。

用例与断言（14 条，全部 PASS）：

| # | 用例 | baseline（38 条） | fixed |
| --- | --- | --- | --- |
| 1 | `durl-mp4-preview`：1 段 = 整段 MP4（`ftyp@4`），FSA sink | 抛 `code=6 FLV_IS_MP4`，`bytes=0` | `bytes=13769`，ffprobe `duration=1s streams=2` |
| 2 | `durl-mp4-multiseg`：同一 MP4 拆 2 段 | 抛错，`bytes=0` | `bytes=13769/13769 identical=true`，ffprobe ok |
| 3 | `durl-flv`：2 段真 FLV（各带 header） | `bytes=19888 magic=FLV`（FLV 路径本来能跑） | 同左 + 可被成品自己的 `Ue` 重新解析 |
| 4 | `durl-flv-writer`：sink 换 streamsaver 风格 writer | **HANG**（`!await writer.closed` 死锁，1200ms 无写出） | `bytes=19888 magic=FLV` |
| 5 | `dash`：按 `downloadDash` 顺序写 head/moov + media | —— | `identical=true`，ffprobe `duration=1s streams=2`（UGC 不回归） |
| 6 | `err-normalize`：merge 抛字符串 | `type=string message=undefined`（无语义 toast） | `DownloaderError code=3 message=落盘失败: FLV unexpected end of file` |
| 7 | `picker-error`：picker 抛 SecurityError | `swallowed=true`（被吞成 CANCEL） | `rethrown=SecurityError` |
| 8 | `dash-invariant`：DASH 5 处关键语句 | `count==1` | `count==1`（前后一致，未被改动） |

真实跑出的结尾：

```
PASS  case1 baseline durl-mp4-preview：合并器按 FLV 解析 → 抛错且写出 0 字节（= 事故现场）
PASS  case1 fixed durl-mp4-preview：写出 >0 字节且 ffprobe 可解析 duration/streams
PASS  case2 baseline durl-mp4-multiseg：多段 MP4 同样 0 字节
PASS  case2 fixed durl-mp4-multiseg：顺序拼接后与源 MP4 完全一致且可解析
PASS  case3 baseline durl-flv：真 FLV 走 Ue.merge 成功（FLV 形态本身没坏）
PASS  case3 fixed durl-flv：补丁后仍走 FLV 合并（输出以 FLV 开头、可被成品自己的 Ue 重新解析）
PASS  case4 baseline durl-flv-writer：写入门 `!await writer.closed` 死锁 → 永不写出（无异常、无完成）
PASS  case4 fixed durl-flv-writer：去掉死锁 + Blob→Uint8Array 后写出成功
PASS  case5 dash：head/moov + media 载荷按 downloadDash 顺序写出后与源文件一致且可解析（UGC 路径不变）
PASS  case6 baseline err-normalize：字符串抛出原样丢给 UI → message undefined（用户侧只剩无语义文案）
PASS  case6 fixed err-normalize：归一化成 DownloaderError 且真实原因保留
PASS  case7 baseline picker-error：FLV 分支 `.catch((e=>{}))` 把 SecurityError 吞成 CANCEL
PASS  case7 fixed picker-error：非 AbortError 一律 rethrow（与 DASH 分支口径一致）
PASS  case8 dash-invariant：DASH(UGC) 的 5 处关键语句在补丁前后都恰好各 1 处（未被改动/未被插入破坏）

SUMMARY: PASS (fail=0/14)
json -> build/pgc-proto/verify-pgc-merge.json
```

### 5.1 真 Chrome 运行期探针（`tools/probe-pgc-offscreen-env.mjs`）

纯 `--headless=new`（不创建窗口、`--mute-audio`），用 `--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked` 加载成品树，再挂到 offscreen 文档（CDP 显示为 `background_page`）里执行探针。结果（`build/pgc-proto/probe/offscreen-env.json`）：

```json
{
 "hasShowSaveFilePicker": "function",
 "notTaInstaller": "undefined",           // ut=n()=isFirefox → false（Chrome）
 "hasServiceWorkerInNavigator": true,
 "userActivation": {"isActive": false, "hasBeenActive": false},
 "pickerResult": "REJECTED SecurityError: Failed to execute 'showSaveFilePicker' on 'Window': Must be handling a user gesture to show a file picker.",
 "blobWriteToStreamSaverSink": "TypeError: Can only write Uint8Arrays",
 "flvWriteGuardRace": "HANG(800ms unclosed)",
 "dashWriteGuardRace": "WROTE"
}
```

四条硬事实：

1. `ut=false`（`n()` 只判 `InstallTrigger`）→ 代码里 `!ut&&window?.showSaveFilePicker` 这一项成立，**不会**强制 `useStreamSaver`。
2. FLV 写入门表达式在真浏览器里 **HANG**；DASH 写入门 **WROTE** —— 两条门不一样，这就是 F2 的依据。
3. streamsaver sink 对 Blob 抛 `TypeError: Can only write Uint8Arrays`（源码内联检查，sink 与 TransformStream 两处都有）。
4. offscreen 文档在该探针条件下 `hasBeenActive=false`，picker 抛 `SecurityError` —— 这条是「冷启动/无用户激活」路径的行为，见 §8 待真机确认项。

### 5.2 三条独立证据互相印证

| 证据 | 说明 | 支持哪个结论 |
| --- | --- | --- |
| 真实 API 采样 180 次（39 例 durl-only，全部 `preview=1`/`format=mp4`） | 形态判定条件 | `isFLV` 会为真，进 FLV 分支 |
| 真实预览载荷前 64 B（`ftyp@4`、`moov@36`） | 载荷真身 | 合并器必抛 `FLV_IS_MP4` |
| 真 Chrome 探针（写入门 HANG / Blob TypeError / picker SecurityError） | 运行期事实 | F2/F4 的必要性 |
| Chrome 下载库无这两个 mp4 记录 | 落盘通道 | 0 字节文件是 `createWritable()` 创建的 |

---

## 6. fixture 清单（真实 vs 合成，逐字段对应代码）

| 文件 | 来源 | 用途 / 字段契约 |
| --- | --- | --- |
| `tools/fixtures/pgc/pgc-playurl-750015-preview-durlonly.json` | **真实回包**（ep=750015，qn=120，fnval=4048，2026-11-08 抓取） | durl-only 形态。`result.video_info` ← `B()` 的 `.then(t=>e?t?.result?.video_info:t?.data)`（@10917）；`video_info.durl` ← `L()` 解构（@8280）；`isFLV: r&&!n`（@8032）；`durl[i].size` ← `q()`（@15138）；`durl[i].order/size` ← `doRefreshSegmentInfo`；`durl[i].backup_url` → `backupUrl` → `De.syncLinesFromSegmentInfo` |
| `tools/fixtures/pgc/pgc-playurl-826497-dash.json` | **真实回包**（ep=826497，qn=80） | dash 形态。`dash.video[i].SegmentBase.Initialization/indexRange` ← `R()` → `range:{start,end}`；`baseUrl`/`backupUrl` ← 分片地址与多线路 |
| `tools/fixtures/pgc/real-preview-durl-head64.bin` | **真实载荷字节**（Range 0-63） | 证明载荷 `ftyp@4`，`FLV` magic 不存在 |
| `tools/fixtures/mp4/pgc-preview.mp4`（13,769 B，ffmpeg 生成的真容器 h264+aac，faststart） | 合成（真容器） | case1/2/5：整段 MP4 / 多段 MP4 / DASH 写入顺序 |
| `tools/fixtures/flv/pgc-seg1.flv`、`pgc-seg2.flv`（各 10,104 B，flv1+mp3，各带 FLV header + onMetaData） | 合成（真容器） | case3/4：走 `Ue.merge` 的真 FLV 形态 |

（真实回包 JSON 由 `tools/save_pgc_fixture.py` 抓取、`tools/save_real_head.py` 取载荷头；两者都可重跑，URL 里的签名参数会过期，但结构与字段不变。）

sha256：

```
66a6ad79…18ac  mp4/pgc-preview.mp4
7a4a20e7…d4d0  flv/pgc-seg1.flv
9f13bd73…2da0  flv/pgc-seg2.flv
9c5a8a1b…9137  pgc/pgc-playurl-750015-preview-durlonly.json
d04344f7…2ed8  pgc/pgc-playurl-826497-dash.json
e68b9833…a0d0  pgc/real-preview-durl-head64.bin
```

---

## 7. 占位符与参数

| 占位符 | 取值方式 |
| --- | --- |
| `TREE` / `--tree` | 38 条成品树，默认 `output/ACGhelper-2.8.31.16-unlock` |
| `FIXED` / `--fixed` | 打过 F1–F4 的树，默认 `build/pgc-proto/tree38-fixed`（由 `apply-feature-pgc-fix.py` 生成） |
| `FFPROBE` / `--ffprobe` | `E:\DevTools\ffmpeg\bin\ffprobe.exe` |
| `EP` / `QN` / `FNVAL` | 真实抓包参数：`ep_id` / `qn` / `fnval=4048`（与成品同参）、`fourk=1`、`fnver=0` |
| `OUTNAME` | fixture 文件名，`tools/save_pgc_fixture.py` 的第 4 个参数 |
| `APP` / `HOST` | 本例为 manifest host_permissions 内的 `*.bilivideo.com`、`api.bilibili.com` |

---

## 8. 失败分支与回滚

**失败分支**

| 现象 | 原因 | 改法 |
| --- | --- | --- |
| `--check` 报 `count=0/2` | 在 pristine（`src/extracted`）或别的树上跑 | 必须指向 38 条成品树（`output/ACGhelper-2.8.31.16-unlock`） |
| `verify` 报 `VERIFIER CRASH: anchor not found` | 成品树被别的补丁改写了锚点 | 用 `--tree` 指向原始 38 条树；或按新树重算 `feature-pgc-fix.json` 的 `old` |
| case4 在 baseline 上不是 HANG 而是 threw | sink mock 里没有 `WritableStream`（node<18） | 用 node 22/24（本机 v24.21.0） |
| 修后产物仍 0 字节 | 该 ep 的 `durl` 首段不是 MP4 也不是 FLV（极端情况） | 看 `downloadError` 里的新 message（F3 会带出 `String(e)`），必要时把首段 magic 打进日志 |
| 真机仍弹「下载已取消」 | picker 在 offscreen 无用户激活（§5.1 第 4 条） | 用 F4 之后，异常会变成真实 message 而不是 CANCEL；若确认无激活可用，需把 picker 挪到页面侧（下一轮） |

**回滚**：本轮**没有改动**任何既有文件（`output/`、`src/extracted`、`tools/proto-patch-spec.json`、`tools/extra-patch-spec.json`、`tools/static-patchspec.py` 全部原样）。要撤销只需删掉新增产物：

```bat
rmdir /s /q build\pgc-proto\tree38-fixed
del tools\feature-pgc-fix.json tools\apply-feature-pgc-fix.py tools\verify-pgc-merge.mjs
rmdir /s /q tools\fixtures
del docs\pgc-download-0byte-rootcause.md
```

真机验证记录建议另存，不写回成品树（Chrome 加载 unpacked 会在树里生成 `_metadata/`，冒烟后需清理，见 `tools/final-smoke-chrome.mjs` 的 `cleanupTree`）。

---

## 9. 仍需真机确认的点（如实标注）

1. **picker 在真实交互下的可用性**：探针在冷启动 headless profile 里读到 `hasBeenActive=false` → `SecurityError`；但用户机器上确实产生了 FSA 风格的产物（Chrome 下载库无记录 + 0 字节文件已创建），说明真实运行时 picker 成功过一次。二者差异（是否有隐式激活、是否用了另一条 streamsaver 通道）需要开一次带真实点击的会话，在 offscreen 里打 `navigator.userActivation` 与 `Ve/useStreamSaver` 才能定死。**这不影响本次修复**：F1/F2/F3 对两条通道都成立，F4 只让异常更可读。
2. **预览形态的产物语义**：durl-only + `is_preview=1` 时服务端只给试看片段（真实样本 `durl[0].length=360151` ms ≈ 6 分钟，而 `timelength=5819000` ms）。修复后产物是「可播的预览片段」，不是整集。若用户期望整集，需要 VIP 权益或换 ep —— 这属于内容权限，不是落盘链路的 bug。建议下一轮在 UI 上补一条「本集为试看片段」的提示（需要 UI 侧文案键，本轮未做）。
3. **FLV 形态的多段 MP4 拼接**：真实 durl-only 样本都是 1 段（`order=1`）。多段 MP4 的 durl（若出现）按顺序拼接在容器层面等价于原文（case2 已用真容器双段验证 `identical=true`），但 B 站若下发的是「独立 MP4 分片」则拼接仍不可播——需要真机抓一次多段 durl 才能定论。
4. **UGC 4K/杜比回归**：本轮只做静态不变式 + DASH 写入顺序复跑（case5/case8）。真机回归建议按 `docs/build-and-verify.md` 的原流程各下载一次 4K 与杜比音频，比对 `ffprobe` 的 `duration/streams`。

---

## 10. 附录：本轮新增/使用到的工具与产物

| 路径 | 作用 |
| --- | --- |
| `tools/feature-pgc-fix.json` | 4 条修复补丁（F1–F4），每条 `{id,file,old,new,why,verify}` |
| `tools/apply-feature-pgc-fix.py` | 锚点校验（`--check`）+ 应用（`--out`），不改既有规格文件 |
| `tools/verify-pgc-merge.mjs` | 14 条断言的验证装置（抽真实代码 + 差分 + ffprobe） |
| `tools/probe-pgc-offscreen-env.mjs` | headless Chrome + CDP 的 offscreen 运行期探针 |
| `tools/save_pgc_fixture.py` / `tools/save_real_head.py` | 真实 PGC 回包与载荷头抓取（可重跑） |
| `build/pgc-proto/tree38/` | 38 条成品树的只读副本（分析基准） |
| `build/pgc-proto/tree38-fixed/` | 打过 F1–F4 的树（验证对象） |
| `build/pgc-proto/verify-pgc-merge.json` | 装置结果（14/14 PASS） |
| `build/pgc-proto/probe/offscreen-env.json` | 真 Chrome 探针结果 |
| `build/pgc-proto/slices/*.txt` | 各锚点原文切片（证据原文） |
