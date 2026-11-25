# ACGhelper 2.8.31.16 合并成品 — 独立对抗性验收报告

- 验收对象：`output/ACGhelper-2.8.31.16-unlock/`（主）、`output/ACGhelper-2.8.31.16-unlock-sameId/`（变体）
- 只读基准：`src/extracted/`（本轮验收全程未写入，目录指纹与成品 zip 哈希的复核见 §1「只读性自证」）
- 角色：`protect`（独立验收 / 复核）；**不改** `tools/static-patchspec.py`、`tools/proto-patch-spec.json`、`tools/apply-all-patches.py`、`output/` 成品
- 本报告所有结论都由本轮自己复跑得出；已有报告（`_patch-report.json`、`docs/static-vip-gates.md`、`docs/protocol-download-gates.md`）只作为「被验对象的声明」，不作为证据
- 生成时间：2026-11-08（本轮）；工具链 python 3.12.10 / node v24.21.0 / Chrome 156.0.8078.80

---

## 0. 结论

**整体判定：PASS（构建一致性满分，功能链路存在 2 个必须在真机验证前处理的缺口 → 归类 PASS-with-risk）**

| 验收项 | 判定 | 一句话 |
| --- | --- | --- |
| ① 改动面审计 | **PASS** | 8 个差异文件、33 个差异簇、簇外字节完全一致；无格式化/行尾/编码变化；非补丁文件逐字节相同 |
| ② 语法与语义复跑 | **PASS**（1 条声明不符） | 18 个文件 `node --check` 全过；8 组输入下 `mg`/`BN` 全 `true`（pristine 有 5 组 false，证明补丁真的起作用）；`getBHAccount` 两路皆 `true`，`getStatus` 真实非会员分支不强制 `isVIP`（见 R-4） |
| ③ 回归风险审查 | **PASS-with-risk** | V13 有效但有 1 处真实副作用；S1 `this` 安全、枚举键齐全；B1/B1b `await` 合法、返回结构对得上；V1/V2 不是白名单，不会锁死画质；V11/V12/V14/V15 的 `if(!1)` 结构未错位；B4 后果是「下得完但不可播」；B2/B3 变成无限重试（R-2） |
| ④ 缺口核查 | **PASS（原报告第 5 条不成立）** | `config.js` off 254424 是 webpack 模块 7348（错误/画质/接口枚举 + 一个重命名对话框组件），**不含任何下载器逻辑**；全树只有 2 处 `fetchBasicDownloadInfo` 定义 |
| ⑤ 加载复验 | **PASS** | 两个变体都能 `Extensions.loadUnpacked` 加载；SW target 存在；`version_name` 正确；5 秒 0 异常；SW 内 `(0,0)` 求值成功；sameId 的扩展 ID 与商店版一致 |

### 必须修（建议在对外发布前处理）

| 编号 | 问题 | 依据强度 | 位置 |
| --- | --- | --- | --- |
| **R-1** | **S1/S2 把 SW 的 PGC 分支打开了，但请求参数里没有 PGC 的标识（无 `ep_id`、无 `avid`）**，`{bvid,cid}` 大概率换回空 `video_info` → 番剧下载仍失败（只是失败点从 `return null` 挪到 API 层）。`proto-patch-optional.json` 的 B6 只覆盖 `js/pages/background.js` 的 `B()`，**没覆盖 SW 的 `Yt()`**，且默认未打 | 静态强证据（接口语义 + 代码路径），未做真实 API 验证 | `tools/extra-patch-spec.json` → **X1**（+ 打开 B6） |
| **R-2** | **B2/B3 的 `if(...,!1)throw` 删掉了重试上限** → 429/412 时进入「退避 5 分钟 → 立刻重试 → 再 429」的无限环（`onRateLimited` 只设 `pausedUntil`，上限 `ct=3e5ms`；`fetch()` 开头 `await waitIfPaused`）。UI 会一直停在 downloading，不报错，只能手动取消 | 静态强证据（代码路径完整可读） | `tools/extra-patch-spec.json` → **X2 / X3** |

> 这两条都属于「成品能跑，但目标功能/失败反馈不达标」，不是构建错误。构建一致性本身没有发现问题。

---

## 环境自证（headless，无窗口无音频）

本轮全部测试走 **headless Chrome（`--headless=new --mute-audio`）**，不创建可见窗口、不出声，因此不涉及副屏摆放与焦点抢占。三项自证：

1. **无可见窗口**：`tools/verify-independent-load.mjs` 在扩展加载后枚举本次 profile 的所有 chrome 进程 `MainWindowHandle`，全部为 `0`：
   ```
   本次 headless chrome 进程 MainWindowHandle: 73076:0 70140:0 68744:0 64836:0 71200:0 43056:0 74820:0 67500:0 41388:0 78512:0 45592:0 55812:0 69108:0 67640:0 72276:0
   [PASS] 本次 Chrome 所有进程 MainWindowHandle 均为 0（无可见窗口）
   ```
2. **未出声**：`--mute-audio`；全程无 `PyAudio/pycaw` 调用，无任何提示音。
3. **未抢焦点**：跑前 `GetForegroundWindow` hwnd=6228756（标题「影之刃零 — 物品分类与搜索」），跑后 hwnd=13176304（标题是 bilibili 视频页）。**这是用户本人切窗造成的**，不是本次测试：本次 Chrome 全程 headless 且所有进程 `MainWindowHandle=0`（无窗口可激活），测试期间未调用任何 `SetForegroundWindow/SetWindowPos/SetCursorPos/SendInput`。判定：焦点变化与本轮无关，找不到可归因于测试的行为。
4. 进程清理：按 `taskkill /PID <初始pid> /T /F` + 兜底按命令行匹配 profile 路径再次 kill；`logs/*.log` 里可见 `rm <profile> -> exists=false`。跑完 `Get-CimInstance` 统计 `chrome.exe` 且命令行含 `acg-verify-indep` 的进程数 = **0**。

---

## 1. 基线事实（本轮实测，不引用旧报告）

```
src 文件数=85  prod 文件数=85（两变体都 85）
完全相同文件=77  有差异文件=8
```
| 文件 | pristine 字节 | product 字节 | Δ | 补丁数 |
| --- | ---: | ---: | ---: | ---: |
| `initBackground.sw.js` | 839049 | 839385 | +336 | 6 |
| `js/pages/background.js` | 112049 | 112227 | +178 | 5 |
| `js/pages/config.js` | 342800 | 342789 | -11 | 2 |
| `js/pages/live.js` | 104296 | 104310 | +14 | 1 |
| `js/pages/message.js` | 40233 | 40247 | +14 | 1 |
| `js/pages/popup.js` | 98656 | 98670 | +14 | 1 |
| `js/pages/video.js` | 528087 | 527655 | -432 | 17 |
| `manifest.json` | 7856 | 7864（unlock）/ 8095（sameId） | +8 / +239 | 0（构建器元数据） |

**只读性自证**（本轮没有动任何受保护对象）：
```
src tree fp   = 00c27453332a0e1b42494f45e4efb182f6609eb1dc215f4cc5f5232ec317ac58
build info fp = 00c27453332a0e1b42494f45e4efb182f6609eb1dc215f4cc5f5232ec317ac58  MATCH
ACGhelper-2.8.31.16-unlock        zip sha 5b7ceb0d6b90559d  MATCH
ACGhelper-2.8.31.16-unlock-sameId zip sha 7f7b9b475bb84137  MATCH
```
（`src/extracted` 目录指纹与 `_build-info.json` 一致；两个成品 zip 的 sha256 与构建时一致 → 成品未被本轮改动。本轮新增的只有 `tools/`、`docs/`、`logs/` 下的新文件。）

---

## 2. 第 ① 项：改动面审计 → PASS

命令（可复跑）：
```bash
cd D:/AI-Project/逆向统一/acghelper
"C:/DevTools/Python312/python.exe" tools/verify-independent.py --stage audit --variant unlock
"C:/DevTools/Python312/python.exe" tools/verify-independent.py --stage audit --variant sameId
```

### 2.1 差异文件集合
```
[PASS] 差异文件集合 == 预期集合
  actual=['initBackground.sw.js','js/pages/background.js','js/pages/config.js','js/pages/live.js',
          'js/pages/message.js','js/pages/popup.js','js/pages/video.js','manifest.json']
```
断言成立：差异文件恰好 = `initBackground.sw.js` + `js/pages/{config,video,live,popup,message,background}.js` + `manifest.json`（manifest 只有 version_name / key 变化，两变体都如此）。

### 2.2 差异簇（总数 33，与 33 条补丁一一对应）

**完整性证明方式**（比启发式 diff 更硬）：把 33 条补丁在 pristine 上按「原始偏移降序」重放得到每条补丁的 pristine 区间与成品区间 → 相邻零间隔的合并成一簇 → 断言
```
concat(pristine 在簇外的字节) == concat(product 在簇外的字节)   且   每个簇内 a[p0:p1]==old、b[q0:q1]==new
```
两条同时成立，就证明「簇外没有任何其它差异」。实测 7 个 JS 文件全部 `[PASS] 差异簇外字节完全一致（拼接恒等式）`（14 条断言）。

| 文件 | 簇数/补丁数 | 簇明细（pristine 字节区间 → product 字节区间，补丁 id） |
| --- | --- | --- |
| `initBackground.sw.js` | 6 / 6 | ①82443:82648→82443:82760 **S08**；②82911:82944→83023:83301 **S09**；③100349:100404→100706:100775 **S01**；④141845:141909→142216:142229 **S10**；⑤540438:540471→540758:540794 **P22**；⑥540621:540662→540944:540998 **P23** |
| `js/pages/background.js` | 5 / 5 | ①18584:18647→18584:18651 **P21**；②28022:28153→28026:28130 **P19**；③41477:41608→41454:41558 **P20**；④59365:59470→59315:59534 **P17**；⑤67370:67477→67434:67655 **P18** |
| `js/pages/config.js` | 2 / 2 | ①112053:112108→112053:112122 **S02**；②302924:302961→302938:302950 **S03** |
| `js/pages/live.js` | 1 / 1 | ①19762:19817→19762:19831 **S05** |
| `js/pages/message.js` | 1 / 1 | ①12963:13018→12963:13032 **S07** |
| `js/pages/popup.js` | 1 / 1 | ①13685:13740→13685:13754 **S06** |
| `js/pages/video.js` | 17 / 17 | ①35360:35417→35360:35364 **P01**；②35418:35454→35365:35369 **P02**；③36798:36877→36713:36771 **P03**；④36897:36958→36791:36819 **P04**；⑤37116:37193→36977:37033 **P05**；⑥37213:37277→37053:37084 **P06**；⑦37707:37737→37514:37537 **P07**；⑧37757:37813→37557:37571 **P08**；⑨38040:38102→37798:37828 **P09**；⑩57371:57402→57097:57113 **P14**；⑪57403:57442→57114:57142 **P15**；⑫57582:57656→57282:57309 **P13**；⑬73364:73420→73017:73034 **P10**；⑭75196:75235→74810:74845 **P12**；⑮75493:75550→75103:75144 **P11**；⑯98016:98071→97610:97679 **S04**；⑰336734:336782→336342:336350 **P16** |

每个簇的「前后 60 字符 + old/new」原文在 `logs/verify-independent-audit-unlock.log`（约 200 行），示例（P01/V1 视频 VIP 画质集合）：
```
#01 pristine[35360:35417] (57B) -> product[35360:35364] (4B)  patch=['P01']
     before60 = '….mp4a405,f.video,f.audio,[y.QN_80,y.QN_74,y.QN_64,y.QN_48]),'
     old      = '_=[y.QN_127,y.QN_126,y.QN_125,y.QN_120,y.QN_116,y.QN_112]'
     new      = '_=[]'
     after60  = ',S=[k.QN_30250,k.QN_30251,k.QN_30255],C=(y.QN_80,y.QN_74,y.Q…
```
> **偏移口径差异（本轮实测，比对时别混用）**：
> - `_patch-report.json` 的 `offset_in_file` = **字符偏移**，且是「该条应用时缓冲区里的位置」→ 同文件里先应用的补丁会平移后面的位置（static 阶段先跑：`initBackground.sw.js` 后面几条被 +320，`video.js` 被 +14）。
> - `proto-patch-spec.json` 的 `offset` = pristine 上的**字符偏移**（不含平移）。
> - 本审计用的是 **pristine 字节偏移**。
> - 含多字节字符的文件只有 3 个：`video.js`（1204 字节增量）、`live.js`（204）、`popup.js`（46）；其余 4 个是被改文件里纯 ASCII 的（`initBackground.sw.js`/`config.js`/`message.js`/`background.js` 的 bytes==chars）。
> - 举例：P16 的 `spec_offset=335546`（字符）→ 报告 `offset_in_file=335560`（字符，+14 来自 S04）→ 本审计 `pristine[336734]`（字节，336734−335546=1188 = 该位置前的多字节字节数）。三者都对，只是口径不同。

### 2.3 没有「多余改动」
- 所有 7 个 JS 文件：`[PASS] 编码/行尾未变`（无 BOM、`crlf=0`、`lf_only` 与原文件一致、`ends_with_nl` 一致、`nul=0`、UTF-8 往返无损）。
- 非补丁文件 77 个逐字节相同；本轮又额外单独抽样校验 6 个（`js/vendors.bundle.js`、`js/components.bundle.js`、`downloader.sw.js`、`notification.sw.js`、`html/background.html`、`html/downloader.html`）全部 `[PASS]`。
- 两变体的 `manifest.json`：**只有** 2 处差异（`version_name` 值 + 文件末尾补了一个 `\n`）；sameId 另有 `key` 插入且 `key` 与 `tools/original-public-key.txt` 完全一致，派生扩展 ID = `kpbnombpnpcffllnianjibmpadjolanh`（= 商店版，`[PASS]`）。`permissions` / `host_permissions` / `content_scripts` / `background` 与 pristine **完全相同**（没有偷偷加权限）。
  - `json.dumps(indent=4)` 重写只带来「末尾换行」这一处文本差异，JSON 语义不变；这是**构建器行为**，不是 33 条补丁之一，记录在此以免误判。

### 2.4 独立重放（不调用 `apply-all-patches.py`）
```bash
"C:/DevTools/Python312/python.exe" tools/verify-independent.py --stage apply
```
自己按规格重新应用 33 条 → 与成品 **逐字节比较**：
```
[PASS] initBackground.sw.js == 独立重放结果（逐字节）  sha256 d741776d…f1acb2 (839385B)
[PASS] js/pages/background.js == 独立重放结果（逐字节） sha256 2cbf349f…a92c2e (112227B)
[PASS] js/pages/config.js == 独立重放结果（逐字节）     sha256 3bcbef8d…819a3
[PASS] js/pages/live.js == 独立重放结果（逐字节）       sha256 cad9d8e0…74018
[PASS] js/pages/message.js == 独立重放结果（逐字节）    sha256 b45d6069…069d68
[PASS] js/pages/popup.js == 独立重放结果（逐字节）      sha256 0618c785…ad068c
[PASS] js/pages/video.js == 独立重放结果（逐字节）      sha256 0bc928d1…ffa6c14
[PASS] 非补丁文件全部与 pristine 逐字节相同  —— 被改动: []
```
两变体都 PASS（合计 28 条断言）。这是「没有多余改动」的最强证据。

### 2.5 可选补丁确实没打
```
[PASS] 可选补丁 O01 未被打（锚点仍在 count=1）  —— count=1 file=js/pages/background.js
[PASS] 可选补丁 O02 未被打（锚点仍在 count=1）  —— count=1 file=js/pages/background.js
```
（O01=B5 fetch 带 credentials，O02=B6 PGC 带 ep_id —— 都是 `proto-patch-optional.json` 里的条件补丁。）

---

## 3. 第 ② 项：语法与语义复跑

### 3.1 `node --check`
```bash
"C:/DevTools/Python312/python.exe" tools/verify-independent.py --stage syntax
```
```
[PASS] node --check [unlock] initBackground.sw.js / config.js / video.js / background.js / live.js / message.js / popup.js
[PASS] node --check [sameId] 同上 7 个
[PASS] node --check [unlock] article.js / website.js / downloader.sw.js / notification.sw.js（未改动文件也没被误伤）
检查项=18  失败=0  RESULT: PASS
```

### 3.2 自建沙箱跑模块 3078（`mg` / `BN`）
脚本 `tools/verify-independent-semantics.mjs`：**自己**从成品里按 webpack 模块 id 切出 `3078:(e,t,n)=>{…}` 源码，自带 mini-require（只提供它真正依赖的 `4707` = `{WH:["superAdmin","admin","catForever","catVIP"], wM:["superAdmin","admin","catForever"]}` 与副作用模块 `5093`），在 `new Function` 里求值。**不调用** `static-verify.mjs` / `proto-verify-gates.js`。

8 组输入（按要求）：`null` / `{}` / `identities:[]` / 过期 catVIP / `hasDateTimeLimit:false` 的 catVIP / 普通用户 / 有效 catForever / superAdmin 永久。

```
---- [PRODUCT] module 3078 mg()/BN() ----
   null                                       mg=true   BN=true
   {}                                         mg=true   BN=true
   identities:[]                              mg=true   BN=true
   过期 catVIP (hasDateTimeLimit:true, to=昨天)   mg=true   BN=true
   catVIP hasDateTimeLimit:false (永久)         mg=true   BN=true
   普通用户 user                                  mg=true   BN=true
   有效 catForever                              mg=true   BN=true
   superAdmin 永久                              mg=true   BN=true

---- [PRISTINE] module 3078 mg()/BN() ----
   null=false {} =false identities:[]=false 过期 catVIP=false
   catVIP 永久=true  普通用户=false  catForever=true  superAdmin=true
[PASS] pristine mg 至少有 3 组为 false（否则补丁无意义/自测无效）  —— false 组数=5
```
→ 8×2 = 16 条 `[PASS]`；并且**同一个测试在 pristine 上有 5 组 false**，说明补丁确实改变了语义（不是「原来就 true」的假阳性）。另外 5 个页面 bundle（video/config/live/message/popup）里的 3078 拷贝同样 8 组全 true（`[PASS] ×5`）。

### 3.3 `getStatus` / `getBHAccount` 回包路径
做法：从成品里**原样切出**这两个 listener 的箭头函数源码（`((e,t,n)=>{…})` / `(async(e,t,n)=>{…})`），在外层 `Function` 里求值后 `.call(mockCtx)`（箭头函数词法绑定 `this`，必须这样才等价于真实闭包）。

```
 getStatus:
   bhAccount=null        : hasLogin=true  hasRegister=true  bhAccount={isVIP:true, isSuperVIP:true, identities:1}
   bhAccount=真实非会员  : hasLogin=true  hasRegister=true  bhAccount={isVIP:false,isSuperVIP:false,identities:1}
   bhAccount=真实会员    : hasLogin=true  hasRegister=true  bhAccount={isVIP:true, isSuperVIP:false,identities:1}
   accountDataInitialized=false: null
 getBHAccount:
   store=null            : isVIP=true isSuperVIP=true identities[0].name='catVIP'
   store=真实非会员      : isVIP=true isSuperVIP=true identities[0].name='catVIP'
   store=真实会员        : isVIP=true isSuperVIP=true identities[0].name='catVIP'
```
- `getBHAccount`：`bhAccount=null` 与 `bhAccount=真实` 两路都 `isVIP=true` → `[PASS] ×12`（含 identities 合法、isSuperVIP）。
- `getStatus`：`bhAccount=null` 时 `isVIP=true`（合成对象，且能通过 `mg()/BN()`）；**`bhAccount=真实非会员` 时 `isVIP=false`** → 声明「两种情况都 true」**不成立**，记 **R-4**。
  影响评估（本轮独立追查）：`getStatus` 的消费方在 `initBackground.sw.js` 内共 5 处，全部走 `(0,o.mg)(t)` / `(0,i.mg)(t)` / `this.bhAccount&&(0,s.mg)(this.bhAccount)||this.reset()`，**没有一处直读 `.isVIP`**；配置页/弹窗页的 `context.bhAccount` 来自 `getBHAccount`（已恒 true）。所以目前**没有可见的门控泄漏**，属于「同一状态两条出口说法不一致」的隐患。

语义脚本结果：`检查项=40 失败=1`，那 1 条就是我按「声明要求」写下的断言 `getStatus(真实非会员).isVIP===true` —— 它是**故意写严**的对照断言，失败即代表 R-4 成立，不代表构建坏了。

---

## 4. 第 ③ 项：回归风险对抗审查（逐条给结论）

### 4.1 V13（P16）`dZ()` 恒 false —— **PASS-with-risk**
证据：`dZ` 的唯一定义点 `i=()=>!1` 在模块 5752（`dZ:()=>i`），`(0,X.dZ)` 形式在全树只有它自己 + 3 个消费点（都在 `js/pages/video.js`）：

| 消费点 | 代码 | V13 后的实际效果 |
| --- | --- | --- |
| `@40910` | `…n({...r,...e.data,subtitles:…}),ye((0,N.dZ)())` | `ye` 是 `[be,ye]=useState(!1)`，`be` 以 `isPGC:be` 塞进 context → **这才是 V13 真正的作用点** |
| `@87627` | `canDownload:!(0,Je.dZ)()&&!(0,Je.hZ)()` | 全文件 `canDownload` 只出现 2 次，**两处都是赋值、从未被读取**（死字段）→ 改它对 UI 没有影响 |
| `@23322` | `i().get((0,o.dZ)()?"squirtleAutoChange":"recommend_auto_play")` | 番剧页改读普通视频页的「自动连播」设置键（**真实副作用**） |

渲染侧确认（`isPGC`=O 真的控制 PGC 限制 UI）：
```
s||w||O ? w ? <Ve><p class="not-supported">"\u975e\u5e38\u62b1\u6b49\uff0c\u76ee\u524d\u4e0d\u63d0\u4f9b\u8bfe\u5802\u89c6\u9891\u4e0b\u8f7d"</p></Ve> : <Ve>…{O?null:<Qe 画质区>}…
O && <div class="drm-confirm-tips">"\u771f\u7684\u975e\u5e38\u62b1\u6b49\uff0c\u6839\u636e\u7ad9\u65b9\u8981\u6c42\u6211\u4eec\u65e0\u6cd5\u7ee7\u7eed\u63d0\u4f9bPGC\u5185\u5bb9\u4e0b\u8f7d\u670d\u52a1"
O ? null : <ce.t …>   // isPGC 时隐藏整块下载面板
```
（上面两处中文一律按 unicode 转义原文引用、不展开：第 1 处是课程页 not-supported 文案，第 2 处就是任务里引用的那句「站方要求 → 不提供 PGC 下载」提示。）

逐条回答任务里的三个子问题：
1. **`initDownloader` 的 URL 构造会不会丢 ep？不会。** `initDownloader=e=>{let t=location.href; e?.isEP&&e?.epid? t=\`https://www.bilibili.com/bangumi/play/ep${e?.epid}\` : e?.bvid&&e?.p&&(t=\`https://www.bilibili.com/video/${e.bvid}/?p=${e.p}\`)…}`，`isEP`/`epid` 来自 `chrome.runtime.onMessage` 的 `initNewVideoIds` 回包（`t.isEP`），**与 `dZ()` 无任何依赖**；`dZ` 只影响 `isPGC` 这个 UI 状态。→ `[PASS]`
2. **offscreen 的 `isPGC` 判定仍然正确。** `js/pages/background.js @10323`：`v=!(!l&&Boolean(l.match(new RegExp(/https?:\/\/www\.bilibili\.com\/bangumi\/play\/ep(\d+)/))?.[1]))` —— 直接对页面 HTML/URL 做正则，未被任何补丁触碰，与 `dZ` 无关。→ `[PASS]`
3. **芝士/课程页 `hZ()` 未被误伤，但也未被解锁。** `hZ=()=>!!location.pathname.match("/cheese/play")` 保持原样；课程页仍走 `s||w||O` 的「不提供课堂视频下载」分支。这是覆盖缺口，不是回归。→ 见 OBS-2

**风险定级：低**（副作用 = 番剧页自动连播偏好键漂移；外加 `canDownload` 死字段与注释不符）。若要彻底消除，应把补丁收窄到「渲染条件」而不是让 `dZ()` 全局失真（见 `extra-patch-spec.json` → OBS-1）。

### 4.2 S1（P22）`yt[this.isPGC?"PGC":"UGC"]` —— **PASS**
- 枚举确实有两个键：SW 内 `function(e){e["PGC"]="/pgc/player/web/v2/playurl", e["UGC"]="/x/player/wbi/playurl"}(yt||(yt={}))`；`background.js` 里同样的枚举（变量名 `f`）。两个键都在 → `[PASS]`。
- **`this` 指向 `Kt` 实例，且不可能 undefined**：`class Kt{… fetchBasicDownloadInfo=Yt.bind(this) …}`（`initBackground.sw.js @542964`），递归时 `Yt.call(this,…)` 显式保持。`Yt` 在全树只出现在三处：定义、`.call(this)` 递归、`.bind(this)` —— **没有裸调用**。所以真实运行不会因 `this` 抛错。
- `this.isPGC` 的来源：`Kt.init()` 里 `this.isPGC = s`，`s` 来自 `fetchVideoIdByURL()` 的页面解析（ep 页给 `isPGC:!0`）。
- 附带风险（非 S1 引入，但被 S1 暴露）：`/pgc/player/web/v2/playurl` 的参数仍是 `{bvid,cid,qn,fnver,fnval,fourk,tabId}`，缺 `ep_id`/`avid` → 见 **R-1**。

### 4.3 B1 / B1b（P17 / P18）插入的 `await` —— **PASS-with-risk**
- 所在函数都是 `async`：`async init(){…}`（`@59315` 所在函数头 `async init(){const e=await et(...)`）与 `async refreshBasicDownloadInfo(){…}`。→ `await` 语法/语义均合法（`node --check` 也过）。
- `this.fetchBasicDownloadInfo` 在 `bt` 实例上确实存在：`fetchBasicDownloadInfo=B.bind(this)`（`background.js @66813`）。
- 签名匹配：`B=async function(e,t,i,n=127,r,s=new Set){…}` → 调用 `(isPGC,bvid,cid)` 时 `n=127`（默认最高档），`r/s` 缺省，安全。
- 返回结构对得上 `H()`：`B` 内部 `…then(L)`，`L` 把 snake_case 映射成 `{acceptDescription,acceptFormat,acceptQuality,format,from,quality,supportFormats,timeLength,videoCodecid,isFLV:r&&!n,dash:{…}}`；`H=e=>{const{dash:t,acceptQuality:i,acceptDescription:n,supportFormats:r,isFLV:s}=e,…}` → 键名完全吻合（`isFLV`/`dash`/`durl`/`accept_quality` 都有对应）。→ `[PASS]`
- **风险点**：`B()` 取不到 `video_info` 时返回 `null`，随后 `H(null)` 会抛 `TypeError`（`H` 直接解构）。该异常会被 `initDownloader` 调用点的 `.catch` 兜住：`await s.init().catch((e)=>{_t(s,{command:"downloadError",message:new h(e?.code||-1,e.message)})})` → 用户看到的是 `TypeError` 的原始 message（可读性差），而不是 `NOT_SUPPORT_PGC_CONTENT` 这种友好文案。定级：低（有错误通路，只是文案差）。
- 顺带确认：`bt` 的 `isPGC` 来自页面解析（§4.1 第 2 点），所以 `B(this.isPGC,…)` 在番剧 ep 页为 `true`，会走 `f.PGC` 分支 —— 这是 B1 能起作用的前提。

### 4.4 V1 / V2（P01 / P02）清空 `_` / `S` 集合 —— **PASS**
先纠正一个容易踩的坑：`dZ` 所在的模块 5752 里也有 `_` 和 `S`，但那是两个**函数**（`_=(e,t=!0)=>{…}` / `S=(e,t=!0)=>{…}`，导出为 `$O`/`$C`），与画质集合**不是同一个标识符**。真正的集合 `_=[] / S=[]` 在模块 2116（字节 27325–93027）的模块作用域里。两者同名不同作用域，别被 `$O/$C` 误导。

模块 2116 内 `_`/`S` 的**全部**数组式用法（穷举）：
```
_.includes @35918  z=(e,t,r)=>{… return !n||n.disabled||!r&&_.includes(t) ? 跳到下一档 : Number(n.value)}   // 命中即「跳过 VIP 档」
_.includes @37160  d=_.includes(r)  → disabled:p, needBLVIP:d                                        // 仅标记
_.includes @58841  _.includes(r)?<In icon="cat-paw"/>:null                                          // 仅图标
S.includes @37629  i=S.includes(n)  → disabled:!1(已改), className:A()({})                          // 仅标记
S.includes @39316  o=e?0:ie?.findIndex(({value:e})=>!S.includes(+e))                                 // ← 唯一「取反」用法
```
- 结论：**没有任何一处把 `_`/`S` 当作「全部可选画质白名单」**。唯一的取反用法是「找第一档非 VIP 音轨作为默认值」：集合清空后表达式恒 true → 默认选第 0 项（可能是杜比全景声/Hi-Res）。这是**默认音轨漂移**，不会锁死画质，反而是放宽。→ `[PASS]`，副作用见 OBS-4。
- 交叉验证：`_.includes` 命中的语义都是「该档是 VIP 档 → 跳过/打标」，清空后等价于「没有 VIP 档」，方向正确。

### 4.5 V14 / V15 / V11 / V12 的 `if(!1)` —— **PASS（结构未错位）**
pristine 与 product 的完整对照（`js/pages/video.js`，简单模式点击回调）：
```js
// pristine
K=(…,a={video:!0,audio:!0})=>{ if(M){ if(B){ if(!z&&_.includes(n))return W() } else if(_.includes(n))return o.QB.info("请先开通b站大会员") } else if(w.includes(n))return o.QB.info("请先登录bilibili账号");
  if(V||Y||!z&&!N&&($||Q&&j.length>0)||t&&!z&&e.length>0||X&&!N||p)return!1; … }
// product
K=(…,a={video:!0,audio:!0})=>{ if(M){ if(B){ if(!1)return W() } else if(!1)return o.QB.info("请先开通b站大会员") } else if(w.includes(n))return o.QB.info("请先登录bilibili账号");
  if(V||Y||X&&!N||p)return!1; … }
```
- `else if` 仍然正确挂在 `if(B)` 上；外层 `else if(w.includes(n))` 仍然挂在 `if(M)` 上 → **没有 else 归属错位**。
- 被替换掉的都是纯条件（`z`/`_.includes(n)`/`V/Y/$/Q/j` 都是取值判断，无副作用），没有 `clearInterval`、没有状态重置被跳过；`return W()/j()`（跳付费/开始下载）不再触发，正是预期。
- 变量语义（来自同组件 context 解构，避免误读）：`M=hasLoginBLAccount`、`B=isBLVIP`、`z=isBHVIP`、`N=isFLV`、`X=empty`、`V=videoOptionsError`、`Y=audioOptionsError`、`p=downloading`、`w=`模块级基础画质表。
- 残留：`if(V||Y||X&&!N||p)return!1;` 里的 `X&&!N`（empty 且非 FLV）仍会拦一次，属原有逻辑（未选择画质时不允许起跑），未被补丁破坏。→ `[PASS]`

### 4.6 V7 / V8 / V9（P10 / P11 / P12）高级模式 —— **PASS-with-risk（文案不一致）**
```js
Q=(0,a.useCallback)((async()=>{ if(!1)return j(); if(W||U||$||p)return!1; … })   // V7：不再跳付费
…disabled:W||U||$||p||Boolean(y),onClick:Q                                     // V8：去掉 !M&&!L&&(V||Y)
…disabled:p||_,status:U?"warning":""                                            // V9：去掉 !M（此处 _=notSupported）
```
- 三者都是纯条件删除，`j()` 无副作用，后续 `if(W||U||$||p)` 逻辑保持；此组件里 `M=isBHVIP`、`N=isBLVIP`、`L=isFLV`、`_=notSupported`。
- **风险**：V8 之后按钮可点，但按钮文案仍按 VIP 分支渲染：`Y?M?"仅下载音频":G.length>0?"仅限助手会员下载音频":"仅下载音频"` / `t&&e.length>0?M?"点击下载切片 (n)":"点击开通助手会员下载切片…"`。非会员会看到「点击开通助手会员」却真的开始下载 → 文案/行为不一致（体验问题，无功能影响）。→ 低风险

### 4.7 B4（P21）pssh 恒不中断 —— **PASS-with-risk（产物不可播）**
```js
if(!1&&r?.boxs.find((e=>"pssh"===e.type)))throw c.PROTECTED_BY_DRM;   // 后面紧接 moov 合并
```
- 位置：DASH 的 moov 合并函数（`const a=r?.mvhd,o=r?.mvex,d=s?.mvex,h=i?.moov?.trak,…`），属于**下载完成后的封装阶段**，不是下载前。
- 全树 `cenc/senc/tenc/widevine/decrypt` 计数 **全为 0**，`hasPssh` 字段只声明不赋值/不读取 → 下载器**没有任何解密能力**，合并只是把盒子与 mdat 原样拼接。
- 判据与后果：**带 pssh 但样本是明文的流** → 正常产出可播文件（B4 的收益）；**真 Widevine/CENC 流** → 样本本身是密文，产物「下载完成但不可播」（黑屏/花屏/无声），取代了原来干净的 `PROTECTED_BY_DRM`（「该视频受DRM保护…」）报错。
- 判据命令：产物 `ffprobe -v error -show_entries stream=codec_name,nb_frames -of json out.mp4`，解不出帧/时长异常即视为密文。
- 另注：`pssh` 检测原代码本身也有隐患——它只看 `r.boxs`（video moov），不看 audio；且 `?` 链让 `r` 为 undefined 时静默放行。B4 把它彻底关掉后，这些细节不再影响行为。

### 4.8 B2 / B3（P19 / P20）限速不再抛错 —— **风险成立（R-2）**
```js
if(e instanceof E&&(429===e.status||412===e.status)){
  if(this.cache.downloader.onRateLimited(e.status,e.retryAfterSeconds),!1)throw c.DOWNLOAD_TOO_FREQUENTLY;
  return this.rateLimitedRetryTimes+=1,this.cache.errorRequestSegmentIndex[…].add(this.fetchPosition),this.fetch()
}
```
- `onRateLimited()` 只做三件事：`penaltyTimes++`（指数退避）、降低 `targetRate`、`pausedUntil = now + s`（`s=min(基准×2^(n-1)×抖动, ct=3e5ms)`，并 `max(s, 1000*retryAfterSeconds)`）。
- `fetch()` 第一行就是 `await rateLimiter.waitIfPaused(this.abortController.signal)` → 重试**有退避**，不会打成紧凑死循环（这点比「裸重试」轻）。
- **但没有上限**：`rateLimitedRetryTimes` 只增不减（成功才归零），`me=3`/`Le=3` 的判定被 `!1` 彻底短路 → 持续性 429 会「每 5 分钟一次、永不放弃」，UI 永远停在 downloading，不报错、只能手动取消。
- 建议见 **X2/X3**（`>=8` 的硬上限）。

### 4.9 V3 / V4 / V5 / V6 / V9（P03–P09）音轨/画质条目 —— **PASS**
- `className:"need-blvip need-bhvip"` → `className:""` / `className:A()({})`：只影响样式类，`need-blvip/need-bhvip` 在 CSS 里只做「金色描边/角标」视觉，不参与逻辑。
- `disabled:!t` → `disabled:!1`、`disabled:p||!t&&d` → `disabled:p`：都是放宽，且 `t`/`d` 都是无副作用的布尔值。
- `onClick:(…)=>(e&&!t&&B(),t)` → `onClick:()=>!0`：去掉了「非大会员→ `B()` 跳付费」的副作用。`B()` 就是付费弹窗；`[PASS]`。

### 4.10 授权层 S01/S02/S03/S04–S10 —— **PASS**
- `mg` 恒真用了自包含写法 `if(1)return!0;<原逻辑>`，原逻辑整段保留（因此每个文件仍残留 1 份原锚点字符串，别把 `grep` 命中当成「还有未打补丁的拷贝」）。全树 `catForever` 只出现在 6 个已打补丁的文件里（SW + config/live/message/popup/video 各 1），**没有第 7 份 VIP 判定实现**。
- `S10` 基类 `onBHAccountChange`：`this.bhAccount?this.isVIP=(0,s.mg)(this.bhAccount):this.isVIP=!1` → `this.isVIP=!0`，后面 `await this.requireSection(!0)` 保留 → 无副作用丢失。
- `S03` 共享锁组件 `if(x&&"boolean"===typeof O&&!O)return` → `if(!1)return`：登录检查（`x`）保留在别处，`needVIP` 遮罩不再渲染；`O` 是纯值，无副作用。
- `S08/S09`：见 §3.3；`S08` 的 `hasRegister:!0`、`S09` 的 `isVIP/isSuperVIP:!0 + identities` 均按声明生效（沙箱实测）。

---

## 5. 第 ④ 项：缺口核查（协议报告 §未解 第 5 条）

**原声明**：「`js/pages/config.js`（342KB）里有第三份下载器拷贝（off 254424 起，`class bt`），配置页内下载需把 B1/B2/B3/B4 在其对应位置再打一遍」。

**核查结论：不成立。**

1. `config.js` 的字节 254424 落在 **webpack 模块 7348** 内（模块起点字节 254335，函数体 16427 字符）。这是「DownloaderError 枚举 + 画质/音质枚举 + 接口路径枚举 + 一个重命名对话框 React 组件」，`export` 出来的是组件 `A`：
   ```
   7348:(e,t,n)=>{"use strict";n.d(t,{A:()=>O});…class r extends Error{name="DownloaderError"…}
   (function(e){e["PGC"]="/pgc/player/web/v2/playurl",e["UGC"]="/x/player/wbi/playurl"})(s||(s={}))…
   ```
2. `config.js` 里下载器特征全部为 0：`class bt`=0、`videoParse`=0、`downloadOptionData`=0、`basicDownloadInfo`=0、`isPGC`=0、`fetchBasicDownloadInfo`=0、`onRateLimited`=0。它只是因为**共享枚举**里带 `DOWNLOAD_TOO_FREQUENTLY`/`PROTECTED_BY_DRM`/`/pgc/player/web/v2/playurl` 这些字样，被 `grep` 误判成「下载器拷贝」。
3. 全树 `fetchBasicDownloadInfo` 只有 **2 个定义**：
   - `initBackground.sw.js`：`class Kt` → `fetchBasicDownloadInfo=Yt.bind(this)`（1 定义 + 1 调用）
   - `js/pages/background.js`：`class bt` → `fetchBasicDownloadInfo=B.bind(this)`（1 定义 + 3 调用：`init` / `refreshBasicDownloadInfo` / `fetchPlayInfoByQuality`）
   没有第三处，也就没有「第三处需要 PGC 化」。
4. 谁在加载谁：
   - 真正跑下载器的 offscreen 文档是 **`html/background.html`**（SW 里 `chrome.offscreen.createDocument({url: chrome.runtime.getURL("html/background.html"), reasons:[…]})`），它加载 `js/pages/background.js` → B1/B2/B3/B4 都在这条线上。
   - `html/downloader.html` 引用的 `../js/pages/downloader.js` **在全树不存在**，且全树没有任何地方引用 `downloader.html` → 死文件（顺带：`html/background.html`/`config.html` 引用的 `js/features.bundle.js`、`js/utils.bundle.js` 也不存在，属原始包缺损，与补丁无关）。
   - `html/config.html` 加载 `js/pages/config.js`（设置页），配置页的「下载设置」只通过 `chrome.runtime.sendMessage` 与 offscreen 通信，不本地下载。
5. 因此：**不需要为 `config.js` 新增任何补丁**（`tools/extra-patch-spec.json` 的 `patches` 里刻意没有它）。真正值得补的是 **X1（SW 侧 ep_id）** —— 原报告把注意力放在「第三份拷贝」上，而实际缺口是「第一份拷贝的参数不全」。

---

## 6. 第 ⑤ 项：加载复验（headless Chrome + CDP）

命令（自己写的 CDP 驱动，不调用 `final-smoke-chrome.mjs`；端口与临时 profile 都与既有脚本错开）：
```bash
"C:/Program Files/nodejs/node.exe" tools/verify-independent-load.mjs --variant sameId --port 9333
"C:/Program Files/nodejs/node.exe" tools/verify-independent-load.mjs --variant unlock  --port 9334
```

sameId 关键输出（原始帧见 `logs/verify-independent-cdp-sameId-*.json`，共 39 帧）：
```
spawn: chrome.exe --headless=new --remote-debugging-port=9333 --user-data-dir=<临时> … --mute-audio
      --enable-unsafe-extension-debugging about:blank
browser: Chrome/156.0.8078.80 | protocol: 1.3
Extensions.loadUnpacked -> {"id":"kpbnombpnpcffllnianjibmpadjolanh"}
SW target: {"targetId":"8C470193…","type":"service_worker","url":"chrome-extension://kpbnombpnpcffllnianjibmpadjolanh/initBackground.sw.js"}
5s 内 SW 异常/console.error 事件数 = 0 []
evaluate (0,0) -> {"type":"number","value":0,"description":"0"}
evaluate version_name -> {"type":"string","value":"2.8.31.16(Beta) unlock"}
evaluate manifest -> {"version":"2.8.31.16","mv":3,"permissions":15,"hasKey":true}
[PASS] service worker target 存在
[PASS] SW 上下文 5 秒内 Runtime.exceptionThrown === 0
[PASS] SW 上下文 5 秒内 console.error === 0
[PASS] SW 中 Runtime.evaluate("(0,0)") === 0
[PASS] SW getManifest().version_name === "2.8.31.16(Beta) unlock"
[PASS] SW 里 getURL 返回 chrome-extension://<id>/initBackground.sw.js
检查项=12  失败=0  RESULT: PASS
```
unlock 变体同 12 项全 PASS，扩展 ID = `alijjjokeiiliopfjgfeapglbghkflgo`（新 ID，与 `_build-info.json` 的说明一致）。
- sameId 的扩展 ID 与商店版一致 → 好处：设置/存储沿用；坏处：与商店版**同时启用会互斥/抢占**，这一点在分发说明里必须写清楚（本报告只做验收，不改分发策略）。
- 清理：`taskkill /PID <初始 pid> /T /F` + 按 profile 命令行兜底二次 kill；`rm <profile> -> exists=false`、`rm <stageDir> -> exists=false`；收尾统计残留进程 = 0。

---

## 7. 风险清单（按严重度排序）

| 级别 | 编号 | 风险 | 触发条件 | 后果 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **高** | R-1 | S1/S2 的 PGC playurl 缺 `ep_id`/`avid` | 任意番剧 ep 页发起下载 | PGC `video_info` 大概率为空 → 仍下载失败；S1/S2 的收益被抵消 | 打 X1 + 打开 B6（两侧都带 `ep_id`），用真机 ep 页验证 |
| **中** | R-2 | B2/B3 删掉重试上限 | CDN 持续 429/412 | 无限重试（每 5 分钟一次），UI 永久 downloading 且不报错 | 打 X2/X3（`>=8` 硬上限） |
| **中低** | R-4 | `getStatus` 在 `bhAccount` 真实非会员时不强制 `isVIP` | 真实非会员账号 + 有代码直读 `status.bhAccount.isVIP` | 当前无消费方直读 → 暂无泄漏；属隐患 | 可选打 X4；或后续新增代码统一走 `mg()` |
| **低** | R-5 | B1 取不到 `video_info` 时 `H(null)` 抛 `TypeError` | PGC API 失败 | 用户看到 `TypeError: Cannot destructure…` 而不是友好文案 | 在 `init`/`refreshBasicDownloadInfo` 里加 `||{}` 兜底（需改补丁定义，本轮只记录） |
| **低** | R-3 | V13 副作用：番剧页自动连播设置键由 `squirtleAutoChange` 变 `recommend_auto_play` | 番剧页 + 自动连播 | 偏好漂移；`canDownload` 死字段与注释不符 | 若在意，收窄 V13 到渲染条件（OBS-1） |
| **低** | R-6 | B4 让 DRM 流「下完但不可播」 | 真 Widevine/CENC 内容 | 产物不可播，报错被隐藏 | 合并后抽检 `ffprobe`；或恢复 pssh 检测但只提示不中断 |
| **极低** | R-7 | V2 清空 `S` 导致默认音轨取第 0 项（可能杜比） | 有杜比/Hi-Res 可选的视频 | 默认产物变大 | 可接受；如需保守改成「只清到 30255」 |
| **极低** | R-8 | 高级模式按钮文案仍写「点击开通助手会员」 | 非会员在高级模式 | 文案与行为不一致 | 纯体验问题 |
| 记录 | OBS-2 | 课程/芝士页未被解锁（`hZ` 未动） | `/cheese/play/*` | 仍显示「不提供课堂视频下载」 | 属覆盖缺口，需另开一轮 |

---

## 8. 上线前必须人工验证的 5 条

1. **番剧 ep 页真实下载链路**（R-1）：在 `/bangumi/play/ep<epid>` 上点下载 → 看 offscreen 是否走到 `PG/…/pgc/player/web/v2/playurl` 且返回非空 `video_info`；若报 `NOT_SUPPORT_PGC_CONTENT`/`TypeError`，按 X1 + B6 打补丁后复验。
2. **大会员画质解锁的实际效果**（V1/V2/V5–V12）：非会员账号下，1080P+/杜比/Hi-Res 档是否出现在列表、能否真的选中并开始下载（UI 层），以及产物是否完整可播（`ffprobe` 帧数/时长）。
3. **限速/风控下的行为**（R-2）：连续下载多个分 P 或大文件，观察 429/412 后是否退避、是否会无声挂起；确认是否需要 X2/X3。
4. **DRM 内容边界**（R-6）：任取一个带 `pssh` 的内容，确认产物可播性，决定 B4 去留。
5. **sameId 与商店版共存**：同一 Chrome profile 同时启用商店版与 `-sameId` 是否冲突（ID 相同）；以及 `version_name` 变更是否影响商店/更新检查逻辑。

---

## 9. 复跑指引与产物清单

```bash
cd D:/AI-Project/逆向统一/acghelper

# ① 改动面 + 独立重放 + 语法（46+28+18 条断言）
"C:/DevTools/Python312/python.exe" tools/verify-independent.py --stage all --variant unlock
"C:/DevTools/Python312/python.exe" tools/verify-independent.py --stage audit --variant sameId

# ② 语义（自建沙箱，40 条断言；预期 1 条 FAIL = R-4）
"C:/Program Files/nodejs/node.exe" tools/verify-independent-semantics.mjs

# ③ 加载复验（12 条断言 + CDP 原始帧落盘）
"C:/Program Files/nodejs/node.exe" tools/verify-independent-load.mjs --variant sameId --port 9333
"C:/Program Files/nodejs/node.exe" tools/verify-independent-load.mjs --variant unlock  --port 9334
```
产物：
| 文件 | 内容 |
| --- | --- |
| `tools/verify-independent.py` | 改动面审计（差异簇 + 编码 + 拼接恒等式）+ 独立重放逐字节比对 + `node --check` |
| `tools/verify-independent-semantics.mjs` | 自建 mini-require 沙箱：模块 3078 的 8 组输入 + `getStatus`/`getBHAccount` 回包 |
| `tools/verify-independent-load.mjs` | 自带 CDP 客户端：`Extensions.loadUnpacked` + SW 断言 + headless 自证 + 进程/目录清理 |
| `tools/extra-patch-spec.json` | X1–X4 增补建议（锚点均已验证 `count==1`）+ 缺口核查结论 + OBS 观察 |
| `logs/verify-independent-audit-unlock.log` / `-sameid.log` | 逐文件逐簇的 before60/old/new/after60 原文 |
| `logs/verify-independent-apply.log` | 独立重放的逐文件 sha256 |
| `logs/verify-independent-syntax.log` | 18 条 `node --check` |
| `logs/verify-independent-semantics.log` | 8 组输入 + 回包路径全文 |
| `logs/verify-independent-load-sameid.log` / `-unlock.log` | 加载复验全部断言 |
| `logs/verify-independent-cdp-*.json` | CDP 原始 JSON 帧（含 `Extensions.loadUnpacked` 回包、SW target、evaluate 结果） |
| `logs/verify-independent-extra-anchors.log` | X1–X4 锚点唯一性（count=1）验证 |

---

## 10. 与既有报告的出入（本轮独立发现）

1. **协议报告 §未解 第 5 条「config.js 有第三份下载器拷贝」不成立**（见 §5）——它是共享枚举模块 7348，被 `grep` 误判。
2. **偏移口径必须说清**：`_patch-report.json` 的 `offset_in_file` 是「字符偏移 + 同文件先前已应用补丁的平移」，`proto-patch-spec.json` 的 `offset` 是 pristine 字符偏移，二进制审计用的是 pristine 字节偏移。含多字节字符的 3 个文件（video/live/popup）里三者必然不同（P16：335546 / 335560 / 336734）；做二进制审计时不要直接拿报告数字当文件偏移。
   另：静态补丁（S01–S10）**没有 `spec_offset`**（是 `null`），proto 补丁才有；想对 pristine 定位请用 `spec_offset`，不要用 `offset_in_file`。
3. **V13 的「canDownload」论述是错的目标**：`canDownload` 在本构建里是 write-only 死字段；V13 真正起作用的是 `isPGC` 状态（`ye(dZ())`），并且顺带改了自动连播的设置键（原报告未提）。
4. **B4 的后果表述不够明确**：原注释写「对带 pssh 但实为明文的流有效」是对的，但没说清「真 Widevine → 下完不可播」；本轮用「全树 0 处解密代码 + 合并只拼接」补上了判据。
5. **B2/B3 的「退避仍生效」结论正确但不完整**：退避确实保留（`waitIfPaused`），但 `!1` 同时删掉了终止条件 → 变成无限重试，原报告未提。
6. **`html/downloader.html` 是死文件**（引用不存在的 `js/pages/downloader.js`），offscreen 实际入口是 `html/background.html`；这点原报告没写清，容易让人误以为存在「配置页内下载器」。
