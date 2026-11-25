# DASH 只剩音轨 & PGC 只给试看 —— 实测复盘与修复

- 角色：`dynamic`（运行期实测）
- 装置：`build/dash-auth-test/probe.mjs`（headless Chrome 156 + CDP `Extensions.loadUnpacked` + SW `chrome.webRequest.onBeforeSendHeaders` 头探针 + offscreen 出/入站消息旁听 + 真下载产物 `ffprobe`）
- 成品树（只读基准）：`output/ACGhelper-2.8.31.16-unlock`（38 条）
- 未打补丁对照树：`build/dash-auth-test/before-tree/ACGhelper-2.8.31.16-unlock`（与成品树逐字节相同，SHA256 `cc3c1831…9d2fa2a1` 对应 `js/pages/background.js`）
- 修复树：`build/dash-auth-test/ACGhelper-2.8.31.16-unlock`（成品树 + `tools/feature-dash-auth-fix.json` 共 8 条）
- 规格/应用器：`tools/feature-dash-auth-fix.json`、`tools/apply-feature-dash-auth-fix.py`（`--check` 校验每条 `old` 在目标文件内 `count==1`）
- 原始日志：`logs/dash-auth/*.json`（每次运行含 transcript、断言、环境自证）

---

## 0. 一句话结论

| 问题 | 结论 |
| --- | --- |
| A：4K 视频下成「只有音轨」 | **不是合并器丢了视频轨**。`downloadDash` 的 `downloadOptionIndex` 里 **video 段为空**（形如 `",0-0-0"`）时，`X()` 把 video 解析成 `null` → `track.video=false` → 不取 video init、`initHeadData()` 走单轨分支 → 写出只有 aac 的 mp4，全程 `downloadCompleted`、文件名仍是 `.mp4`。真下载实测：给全索引 = **双流 405,997 B**；给 `",0-0-0"` = **单 aac 流 101,085 B**，与用户那份 `5,384,875 B / streams=[aac]` 同一形态。 |
| B：番剧整集拿不到 | **不是「请求没带 Cookie」**。探针实测扩展发往 `api.bilibili.com` 的 playurl 请求 **带 Cookie**，把 `SESSDATA` 设成 httpOnly 后依然带（`SESSDATA=probe1; buvid3=…`）。PGC 的 `durl-only + is_preview=1 + format=mp4` 在 VIP 集上是**站方权益判定的回包**，用 curl 换 Referer、换请求参数、加假 SESSDATA 三种取样完全一致；扩展侧只是**把这份试看片段当成整集静默落盘**。 |

---

## 1. 现象（用户侧）

1. 「4K 视频能下」，产物：
   `E:\Downloads\【4K限免】你的新设备能顶住吗_影视飓风年度样片.【双杜比】….36085892352.mp4`
   `ffprobe`：`5,384,875 B`、`streams=[{aac, bit_rate=195376, duration=218.559667}]`、**无视频流**。
2. 番剧整集拿不到：PGC `playurl` 采样 39/180 次是 `durl`-only 且全部 `is_preview=1 / format=mp4`（服务端只给试看），用户自称大会员且已登录。

---

## 2. 实测证据

### 2.1 问题 B：Cookie 到底有没有发出去

装置：SW 上下文挂 `chrome.webRequest.onBeforeSendHeaders`，`opt_extraInfoSpec=['requestHeaders','extraHeaders']`（`extraHeaders` 才看得到 `Cookie`），profile 里 `chrome.cookies.set` 一个探针 cookie 后触发真实 `videoParse`。

**未打补丁树（before-tree）**，探针 cookie `acgprobe=probe1`（非 httpOnly）：

```
[PASS] A-UGC playurl 请求命中
  https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1xx411c7mD&cid=62131&qn=127&fnver=0&fnval=4048&fourk=1&tabId=1585482639
  hasCookie=true  cookie="acgprobe=probe1; buvid3=22484776-…infoc; b_nut=1794134512"  referer=null  origin=null
[PASS] B-PGC playurl 请求命中
  https://api.bilibili.com/pgc/player/web/v2/playurl?bvid=BV1rk4y1L7uP&cid=1132332811&qn=127&fnver=0&fnval=4048&fourk=1&tabId=…&ep_id=750015
  hasCookie=true  cookie="acgprobe=probe1; buvid3=…; b_nut=…"
```

→ **修前就带 Cookie**。`fetch` 虽然没写 `credentials`（默认 `same-origin`），但扩展 origin 发往 `host_permissions` 命中域时 Chrome 会附上 cookie jar。

**SESSDATA（httpOnly）专项**（`--cookie=SESSDATA --httponly`，修复树上再测一次）：

```
探针 cookie: {"api":{"domain":".bilibili.com","httpOnly":true,"name":"SESSDATA","secure":true,…}}
HEADER UGC playurl 带 Cookie:
  "cookie":"SESSDATA=probe1; buvid3=E79E4B15-…infoc; b_nut=1794136053"  "hasSessData":true
HEADER PGC-vip-ep826498 playurl 带 Cookie: hasCookie=true hasSessData=true
```

→ HttpOnly 不影响发送；`SESSDATA` 会随请求出去。

**请求形态/Referer 是不是原因**（curl 对照，`ep_id` 与 `bvid+cid+ep_id`、有/无 Referer、加假 SESSDATA）：

| 取样 | play_detail | is_preview | type | dash | durl |
| --- | --- | --- | --- | --- | --- |
| 免费集 ep826497 `?ep_id=` | PLAY_WHOLE | 0 | DASH | 有 | 0 |
| 免费集 ep826497 `?bvid+cid+ep_id`（扩展的形态） | PLAY_WHOLE | 0 | DASH | 有 | 0 |
| VIP 集 ep826498 无 Referer | PLAY_PREVIEW | 1 | MP4 | 无 | 1 |
| VIP 集 ep826498 有 Referer | PLAY_PREVIEW | 1 | MP4 | 无 | 1 |
| VIP 集 ep826498 有 Referer + 假 SESSDATA | PLAY_PREVIEW | 1 | MP4 | 无 | 1 |

→ 三类变量都不改变回包形态：**durl+is_preview=1 是「该账号在这一集没有权益」时站方给出的试看片段**，与请求怎么发无关。

**扩展侧复现同一形态**（修复树 `--step=auth`）：

```
PARSE PGC-free-ep826497  isPGC=true  aq=[120,112,80,64,32,16]  dash=true   durl=0   bi.biPreview=false
PARSE PGC-vip-ep826498   isPGC=true  isFLV=true  dash=false  durl=1         bi.biPreview=true
```

**真下一集（VIP 集 ep826498，修复树）**：`downloadCompleted`，产物
`5,921,140 B`、`streams=[video:h264:852x480, audio:aac]`、`duration=180.179` —— 就是 **3 分钟试看片段**，而且修前它会被命名成一个普通整集文件。

### 2.2 问题 A：为什么只剩音轨

**真下载对照**（同一公开 UGC `BV1XjxR6gEh8`，cid 43333848938，11 秒）：

| 树 | `downloadOptionIndex` | 结果 | 字节 | ffprobe |
| --- | --- | --- | --- | --- |
| before | `3-0-0,0-0-0` | downloadCompleted | 405,997 | `streams=[video:hevc:480x640, audio:aac]` `duration=10.222250` |
| after | `3-0-0,0-0-0` | downloadCompleted | 405,997 | `streams=[video:hevc:480x640, audio:aac]` `duration=10.222250` |
| before | `,0-0-0`（video 段为空） | downloadCompleted | 101,085 | `streams=[audio:aac]` `duration=10.031020`　建议文件名 `…43333848938.mp4` |
| after | `,0-0-0` | downloadCompleted | 101,085 | `streams=[audio:aac]` `duration=10.031020`　建议文件名 `…43333848938.m4a` |
| before | `abc,0-0-0`（坏索引） | downloadCompleted | 101,085 | `streams=[audio:aac]`　建议文件名 `….mp4` |
| after | `abc,0-0-0` | `downloadError: invalid option` | 0 | — |

→ **合并/写盘链路是好的**（全索引稳定双流、字节级可复跑）；只要 video 段缺失，产物必然单音轨，而且**一声不响**。

代码锚点（38 条成品树 `js/pages/background.js`）：

1. `X()`（off≈16031）解析 `"<video triple>,<audio triple>"`：
   `const i=3,[n,r]=t.split(",")… let o={video:null,audio:null};if(s?.length===i&&e.video.length>0){…}`
   video 段不是恰好 3 个数字 → `s=[]` → 条件跳过 → `video:null`（**没有抛错**）。
2. `downloadDash`（off≈63900 区）：
   `const o={track:{video:Boolean(s.video),audio:Boolean(s.audio)},…}` → `track.video=false`。
3. `oe=initSegmentInfo`（off≈22814）：`[i,n]=await Promise.all([e?$(e.url,e.range):void 0, …])` —— `downloadOption.video` 为空 → **video init 根本不取**。
4. `ie=initHeadData`（off≈18065）：`if(i&&n){…双轨 moov…}else{…单轨分支…}` → moov 只有 1 个 trak。
5. `ye=writeFile`（off≈30829）：双轨 `moof+mdat` 复用分支要求两条 track 都有 segment，单轨时自然只写音频。

**option 串为什么会是 `",<audio>"`**（不是靠读码推断，是等价表达式 + UI 语义确认）：

- UI 三处（`js/pages/video.js` off=40038 / 73252 / 56918）都用同一句拼串：
  `downloadOptionIndex:[T,R].filter(Boolean).map((e)=>e.join("-")).join(",")`
  空数组在 JS 里是 **truthy** → `[[],[0,0,0]]` 不在 `filter(Boolean)` 被剔除 → `"".join` 得 `""` → **`",0-0-0"`**。
- `T`（videoSelected）为空的合法来源就是面板的「仅下载音频」：按钮文案在 `video.js` off=75304 处按 `videoOnly/audioOnly` 切换（`\u4ec5\u4e0b\u8f7d\u97f3\u9891`），点它就会走 `K(...,{video:!1})` → `l=[]`、`[l,s]` → `",<audio>"`。
- 另外 `downloadOptionRefreshed`（`video.js` off=42193）也会把服务端回来的索引串直接回填 `[r,o]=split(",")`，一旦该串 video 段为空，面板状态就变成 audioOnly 并**粘住**，下一次点击继续产出音轨文件。

结论：**A 的根因是「video 段缺失的选项串被静默接受」，且产物仍按视频命名**；用户看到的「4K 能下」其实是一次音轨下载。

---

## 3. 修法（`tools/feature-dash-auth-fix.json`，8 条，全部 `old` 在目标文件内 `count==1`）

| id | 文件 | 改动 | 为什么 |
| --- | --- | --- | --- |
| F1 | `js/pages/background.js` | `downloadDash` 里当 `!s.video && s.audio` 时把建议文件名改 `.m4a` | 让产物自证是音频，不再冒称 `.mp4`（实测：`…43333848938.mp4` → `…43333848938.m4a`） |
| F2 | 同上 | picker `accept` 按 `s.video` 选 `video/mp4` 或 `audio/mp4` | 与 F1 同一诉求，保存对话框类型一致 |
| F3 | 同上 `X()` | video 段**非空但解析不出 3 个数字** → `throw new Error("invalid option")` | 关掉「坏索引静默降级成音轨」这个入口；`""`（仅音频）保持原行为，功能不受影响 |
| F4 | 同上 `downloadDash` | `title` 在 `isPreview` 时加 `[试看]` | 拿到试看片段时文件名自证，不再静默当整集 |
| F5 | 同上 `downloadFLV` | 同上（PGC 试看是 durl→FLV 分支，39/180 采样全落这里） | 覆盖问题 B 的主要形态 |
| F6 | 同上 `B()` | `A(o)` → `A(o,{credentials:"include"})` | playurl 鉴权写成显式契约，不再依赖「扩展 origin 默认带 cookie」的隐式行为 |
| F7 | `initBackground.sw.js` `Yt()` | `At(r,a)`（a=null）→ `At(r,{credentials:"include"})` | 同上，SW 首次解析主路径 |
| F8 | `initBackground.sw.js` `Yt()` | 把 `video_info.is_preview` 归一化成 `basicDownloadInfo.isPreview` | PGC 的 `Kt.isPreview` 原本 **undefined**（实测），F4/F5 需要这个字段 |

应用方式：

```bash
python tools/apply-feature-dash-auth-fix.py --check                     # 8/8 count==1
python tools/apply-feature-dash-auth-fix.py \
  --base output/ACGhelper-2.8.31.16-unlock \
  --out  build/dash-auth-test/ACGhelper-2.8.31.16-unlock
node --check build/dash-auth-test/ACGhelper-2.8.31.16-unlock/js/pages/background.js
node --check build/dash-auth-test/ACGhelper-2.8.31.16-unlock/initBackground.sw.js
```

`output/` 未被触碰：`sha256(output/.../background.js) == sha256(before-tree/.../background.js)`，且 `output/` 下无 `_metadata`。

---

## 4. 前后对比（全部为本次真跑输出）

### 4.1 DASH 双流（不回归）

```
# before
[PASS] FFPROBE video-plus-audio.mp4 :: size=405997 streams=[video:hevc:480x640, audio:aac] duration=10.222250
# after
[PASS] FFPROBE video-plus-audio.mp4 :: size=405997 streams=[video:hevc:480x640, audio:aac] duration=10.222250
```

### 4.2 音轨-only：修前是伪装成视频的 mp4，修后是 `.m4a`

```
# before  --index=",0-0-0"
[PASS] DL-2 下载流程结束 :: {"kind":"completed","total":101085}
showSaveFilePicker(stub) called name=…43333848938.mp4
[PASS] FFPROBE :: size=101085 streams=[audio:aac] duration=10.031020
# after   --index=",0-0-0"
[PASS] DL-2 下载流程结束 :: {"kind":"completed","total":101085}
showSaveFilePicker(stub) called name=…43333848938.m4a
[PASS] FFPROBE :: size=101085 streams=[audio:aac] duration=10.031020
```

### 4.3 坏索引：修前静默出音轨，修后明确报错

```
# before  --index="abc,0-0-0"
[PASS] DL-2 :: {"kind":"completed","total":101085}
[PASS] FFPROBE :: size=101085 streams=[audio:aac]
# after   --index="abc,0-0-0"
[FAIL(预期)] DL-2 :: {"kind":"error","err":{"errName":"DownloaderError","errMessage":"invalid option"}}
sink 累计字节 = 0
```

### 4.4 PGC 试看：修后文件名带 `[试看]`

```
# after，VIP 集 ep826498（真下）
showSaveFilePicker(stub) called name=《鬼灭之刃_柱训练篇》[试看].第2话_水柱·富冈义勇的痛苦.1602741611.flv
[PASS] FFPROBE :: size=5921140 streams=[video:h264:852x480, audio:aac] duration=180.179000
```

### 4.5 不回归

```
node tools/verify-pgc-merge.mjs --tree output/ACGhelper-2.8.31.16-unlock \
     --fixed build/dash-auth-test/ACGhelper-2.8.31.16-unlock --json logs/dash-auth/verify-pgc-merge-after.json
PASS case1/2/3/4/6/7 fixed …        （7/7 fixed 用例全 PASS）
PASS case8 dash-invariant：DASH(UGC) 的 5 处关键语句在补丁前后都恰好各 1 处
SUMMARY: FAIL (fail=5/14)   ← 5 条是 baseline 用例（必须复现旧 bug），非回归
```

（该装置把 baseline 复现旧 bug 记作 FAIL 是它原有的口径，见脚本头部用例说明。）

### 4.6 环境自证（每次运行都记录在 `logs/dash-auth/*.json` 的 `env`）

```
ENV-1 本 profile 的 chrome 进程 MainWindowHandle 全 0 :: 20 个进程 / pid=…;hwnd=0 …
ENV-2 GetForegroundWindow 跑前跑后一致 :: handle=2497534;pid=38140 → handle=2497534;pid=38140
ENV-3 --mute-audio 已启用
ENV-4 清场（profile 命令行匹配 /T 杀进程树） :: before=20 after=0
```

全程 `--headless=new`，未调用 `SetForegroundWindow` / `SetCursorPos` / `SendInput` / `pyautogui`；下载走 CDP `Browser.setDownloadBehavior`，落盘 sink 在扩展自己的 offscreen 文档内，没有动桌面。

---

## 5. 失败分支

1. **`showSaveFilePicker` 在 headless 下必然 `SecurityError`（无 user activation）**，直接跑会得到 `下载已取消/CANCEL`；`streamsaver` 分支又会撞 `Can only write Uint8Arrays`（`initBuffer.head` 是 ArrayBuffer，streamsaver 的 `transform` 只收 Uint8Array —— 这是**产品里潜伏的另一个坑**，真机上因走 FSA 而不暴露）。
   装置处理：在 offscreen 文档里把 `window.showSaveFilePicker` 换成一个返回「收集型 sink」的假 handle，只替换最后一公里落盘，选轨/init 解析/moof+mdat 复用/写入顺序全是产品原码；结束后按 4MB 分片 base64 取回写成真实文件再 `ffprobe`。
2. **offscreen 文档没有 `chrome.tabs`**（只有 `chrome.runtime`）。要旁听下载器命令流必须拦 `chrome.runtime.sendMessage`，拦 `chrome.tabs.sendMessage` 会直接抛 `Cannot read properties of undefined`。
3. **选项索引不是「画质值」而是「数组下标」**：`downloadOptionIndex` 的 video 段是 `[画质在 acceptQuality 顺序里的下标, 编码在该画质 children 里的下标, 线路下标]`。拿 `0-0-0` 去打一个 `acceptQuality=[112,80,64,32,16]` 而 `dash.video` 只有 32/16 的视频，等于选中「无 dash 的 112」→ `Y()` 抛 `Cannot read properties of undefined (reading 'value')`（本次实测过，不是音轨问题）。挑索引要按 `acceptQuality` 顺序找真正有 `children` 的那个（本例是 `3-0-0`）。
4. **`dash.video[].url` 在 `basicDownloadInfo` 里不存在**：`R()` 只映射 `baseUrl/backupUrl/range`，`url` 是 `Y()` 在选项构造时才拼出来的。用 `basicDownloadInfo.dash.video[].url` 判空会得到「全部为空」的假结论。
5. **PGC 的 `isPreview` 原本拿不到**：`Kt.isPreview` 只由 UGC 的 `Rt()`（`is_upower_preview`）赋值，PGC 的 `Ct()` 不赋值 → 实测 `parse.isPreview === undefined`。要这个信号必须从 `video_info.is_preview` 归一化（F8）。

---

## 6. 回滚

```bash
# 修复树整棵丢弃即可（成品树没被改动）
rm -rf build/dash-auth-test/ACGhelper-2.8.31.16-unlock

# 不想整棵重来：从成品树重新复制一份干净树，再按需重新打补丁
cp -a output/ACGhelper-2.8.31.16-unlock build/dash-auth-test/ACGhelper-2.8.31.16-unlock
python tools/apply-feature-dash-auth-fix.py --base output/ACGhelper-2.8.31.16-unlock \
  --out build/dash-auth-test/ACGhelper-2.8.31.16-unlock      # 需要补丁时再加回来
```

补丁只改 2 个文件（`js/pages/background.js`、`initBackground.sw.js`），`old` 全部唯一，逐条可 grep 定位；每条 `new` 都能用 `old` 反向定位（`grep -c '<new>'` 应为 1），手工回退不需要工具。
Chrome 侧无残留：profile 在 `%TEMP%\acg-dashauth-*`，每次运行末尾按命令行匹配 `taskkill /T /F`，实测 `after=0`。

---

## 7. 需要真机确认的点

1. **大会员账号能不能拿到整集 DASH**：本装置只能证明「Cookie（含 httpOnly SESSDATA）确实随请求发出」和「无权益时的回包就是 durl+is_preview=1」。要闭环必须在真机（同一浏览器 profile，已登录大会员）里看一次 PGC 回包：
   - 整集：`play_check.play_detail === "PLAY_WHOLE"` 且 `video_info.dash` 非空；
   - 试看：`play_detail === "PLAY_PREVIEW"` / `is_preview === 1` / 只有 `durl`。
   修复后文件名会直接体现（带 `[试看]`），这也是最快的判据。
2. **`acceptQuality` 有值但 `dash.video` 缺档是常态**（未登录/无权益时 `accept_quality` 仍列出 1080P+/4K）：面板里画质项存在但 children 为空，`X()` 对这种选择会抛 TypeError 而不是给可读错误。这是独立缺陷，本轮未改（不在 A/B 范围内），建议下一轮把 `H()` 的空 children 画质项标 `disabled`。
3. **streamsaver + DASH 的 `Can only write Uint8Arrays`**：真机走 FSA 不暴露；但只要 `showSaveFilePicker` 不可用（非 Chromium、或 `ut` 为真）就会 100% 失败。属独立缺陷，建议下一轮按 `feature-pgc-fix` F2 同款思路把 `initBuffer.head/moov` 与 media 载荷统一转 `Uint8Array` 再写入。
4. **用户的 sticky audioOnly 状态**：`downloadOptionRefreshed` 回填空 video 段后面板会「仅下载音频」并保持。本轮用 F1/F2 让产物自证 + F3 拦坏索引；若要做到「不回填空 video 段」需要改 `video.js` 的 `downloadOptionRefreshed` 分支，属 UI 层，下一轮做。
