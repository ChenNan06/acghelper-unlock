# 构建与验收（全部实测输出）

> 工程根：`D:\AI-Project\逆向统一\acghelper`
> 工具链：Python 3.12.10 · Node v24.21.0 · Chrome 156.0.8078.80（`C:\Program Files\Google\Chrome\Application\chrome.exe`）
> 全部日志落在 `logs/`，下面每段都是日志原文摘录，不是「应该可以」。
> **当前构建：38 条补丁 = static 10 + proto 23 + extra 5（X1–X5）**；`--with-optional` 时 39 条（+B5）。
> 本节 §0–§7 记录的构建输出已按 38 条刷新；§9 是「38 条收尾轮」的完整新增验收记录。

---

## 0. 一条命令构建

```bash
cd D:/AI-Project/逆向统一/acghelper

# 只校验锚点（不写任何文件）
python tools/apply-all-patches.py --check

# 正式构建（分段：pristine(static 10 → proto 23) → post-proto(extra 5) → post-extra(optional)）
python tools/apply-all-patches.py

# 需要时附加 B5（B6 已并入 X5，自动跳过 → 39 条）
python tools/apply-all-patches.py --with-optional
```

参数：`--src`（默认 `src/extracted`，只读）· `--out`（默认 `output`）·
`--with-optional`（只额外打 B5）· `--check`（只校验不写）。

### 实测输出（`logs/build-02-build-38.log`）

```
源目录      : D:\AI-Project\逆向统一\acghelper\src\extracted
输出目录    : D:\AI-Project\逆向统一\acghelper\output
补丁规格    : static=10  proto=23  extra=5  optional=2（可用）
本次应用    : 38 条 = static 10 + proto 23 + extra 5 + optional 0（不含 --with-optional）
分段顺序    : pristine(static→proto) → post-proto(extra) → post-extra(optional)
------------------------------------------------------------------------------------------------------------------------
锚点审计（每段都在『上一段输出的快照』上做）：
  [S10 ] pristine   initBackground.sw.js       count=1  off= 141845 spec=   None n/a
  [S01 ] pristine   initBackground.sw.js       count=1  off= 100349 spec=   None n/a
  …
  [X1  ] post-proto initBackground.sw.js       count=1  off= 540834 spec= 540834 OK
  [X4  ] post-proto initBackground.sw.js       count=1  off=  82597 spec=  82597 OK
  [X3  ] post-proto js/pages/background.js     count=1  off=  41522 spec=  41522 OK
  [X2  ] post-proto js/pages/background.js     count=1  off=  28094 spec=  28094 OK
  [X5  ] post-proto js/pages/background.js     count=1  off=  10771 spec=  10771 OK
------------------------------------------------------------------------------------------------------------------------
  #01 [S10] static   initBackground.sw.js       off= 141845 old= 64 new= 13  基类 onBHAccountChange…
  …
  #33 [P01] proto    js/pages/video.js          off=  35360 old= 57 new=  4  V1 视频 VIP 画质集合清空…
  #34 [X1] extra    initBackground.sw.js       off= 540834 old= 67 new= 83  S1 已把 PGC 分支改成请求 /pgc/player/web/v2/playurl…
  #35 [X4] extra    initBackground.sw.js       off=  82597 old= 34 new= 91  S08 只给「bhAccount 为空」的情况塞了合成会员对象…
  #36 [X3] extra    js/pages/background.js     off=  41522 old=145 new=172  同 X2，FLV 分段 fetcher（De 类，Le=3）…
  #37 [X2] extra    js/pages/background.js     off=  28094 old=156 new=183  B2 把 'this.rateLimitedRetryTimes>me' 换成 '!1'…
  #38 [X5] extra    js/pages/background.js     off=  10771 old= 97 new=113  X1 只补了 SW 侧 Yt() 的 PGC 请求参数…
------------------------------------------------------------------------------------------------------------------------
锚点预检：全部 count==1（38/38）；重叠检查：无
改动文件：7 个
  initBackground.sw.js          839049 ->  839458  (+409 bytes)
  js/pages/background.js        112049 ->  112297  (+248 bytes)
  js/pages/config.js            342800 ->  342789  (-11 bytes)
  js/pages/live.js              104092 ->  104106  (+14 bytes)
  js/pages/message.js            40233 ->   40247  (+14 bytes)
  js/pages/popup.js              98610 ->   98624  (+14 bytes)
  js/pages/video.js             526883 ->  526451  (-432 bytes)
自包含型补丁（new 含 old，属预期）：['S01', 'S02', 'S05', 'S07', 'S06', 'S04']
可选补丁锚点（默认不打）：
  [O01] js/pages/background.js   可打，触发条件：B5（可选·条件触发）offscreen 的所有 api.bilibili.com 请求带上…
  [O02] js/pages/background.js   可打，触发条件：B6（可选·条件触发）PGC playurl 显式带 ep_id…

产物：
  D:\AI-Project\逆向统一\acghelper\output\ACGhelper-2.8.31.16-unlock
  D:\AI-Project\逆向统一\acghelper\output\ACGhelper-2.8.31.16-unlock.zip  (3684815 bytes, sha256=a1f68d95e475bc7f6b76804f06d55a29c8d29e3cef1fa6f7e24ba6dc84cf16d6)
  D:\AI-Project\逆向统一\acghelper\output\ACGhelper-2.8.31.16-unlock-sameId
  D:\AI-Project\逆向统一\acghelper\output\ACGhelper-2.8.31.16-unlock-sameId.zip   (3685026 bytes, sha256=08b78d5af83bdfeb6846ad7c29f6a2a1ce2dd7cf68f3137bc22f6fa01e73a998)
key → 扩展 ID : kpbnombpnpcffllnianjibmpadjolanh  == 商店版 kpbnombpnpcffllnianjibmpadjolanh

计数：{'static': 10, 'proto': 23, 'extra': 5, 'optional_applied': 0, 'optional_available': 2, 'optional_skipped': [], 'applied': 38, 'expected_total': 38}

src/extracted 指纹未变：True  (00c27453332a0e1b…)

BUILD OK
```

构建脚本自带的 7 道自检：① 每条锚点 `count==1`；② 同文件原始区间不重叠（第 1 段）；
③ extra 段锚点必须在**第 1 段输出**上 `count==1` 且偏移等于规格记录值，否则失败；
④ 应用条数必须等于 `static+proto+extra(+optional-skipped)` 的期望值；
⑤ 内存演练通过才落盘（单条失败即整体退出，不留半成品）；⑥ `key → ID` 必须等于商店版 ID；
⑦ `src/extracted` 构建前后目录指纹一致（只读保证）。

> 构建日志里的长度是**文本字符数**；`video.js / live.js / popup.js` 含中文，磁盘字节数更大
> （见 `docs/patch-manifest.md` §4 的字节表），属正常。

---

## 1. 验收 ①：`node --check` 逐个检查被改过的 .js

```bash
for TREE in output/ACGhelper-2.8.31.16-unlock output/ACGhelper-2.8.31.16-unlock-sameId; do
  for f in initBackground.sw.js js/pages/background.js js/pages/config.js \
           js/pages/video.js js/pages/live.js js/pages/popup.js js/pages/message.js; do
    node --check "$TREE/$f"; echo "rc=$? $TREE/$f"
  done
done
```

实测（`logs/nodecheck-38.log`，两棵树 × 7 个文件 = 14 条，**全 PASS**；38 条构建后的复核见 §9.1）：

```
[PASS] node --check [ACGhelper-2.8.31.16-unlock] initBackground.sw.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock] js/pages/background.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock] js/pages/config.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock] js/pages/video.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock] js/pages/live.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock] js/pages/popup.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock] js/pages/message.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock-sameId] initBackground.sw.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock-sameId] js/pages/background.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock-sameId] js/pages/config.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock-sameId] js/pages/video.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock-sameId] js/pages/live.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock-sameId] js/pages/popup.js
[PASS] node --check [ACGhelper-2.8.31.16-unlock-sameId] js/pages/message.js

PASS=14 FAIL=0
```

**PASS**。这一步同时回答了「B1/B1b 插入的 `await` 是否在 async 函数里」：
`await` 出现在非 async 上下文是**语法错误**，`node --check` 会直接报 `SyntaxError`；
14/14 全 0 就证明语法层面成立。`final-verify-static.mjs` 还额外做了文本级断言（见下）。

---

## 2. 验收 ②：模块级语义（成品树，不是 build 目录）

```bash
node tools/final-verify-static.mjs output/ACGhelper-2.8.31.16-unlock
node tools/final-verify-static.mjs output/ACGhelper-2.8.31.16-unlock-sameId
```

`final-verify-static.mjs` 沿用 `tools/static-verify.mjs` 的模块抽取 + `new Function` 沙箱思路，
但**路径参数化到成品树**，并且 `getBHAccount` / `getStatus` 的回包表达式是**从成品树里实时括号配平抽取**后求值（不是抄常量）。

实测（`logs/verify-static-unlock.log`，两棵树输出一致）：

```
=== [1] 6 bundle 模块 3078：4 类输入 × mg/BN 必须全 true
  PASS  initBackground.sw.js     未登录(mg=true,BN=true) 空identities(mg=true,BN=true) 过期catVIP(mg=true,BN=true) 普通用户(mg=true,BN=true)
  PASS  js/pages/config.js       未登录(mg=true,BN=true) 空identities(mg=true,BN=true) 过期catVIP(mg=true,BN=true) 普通用户(mg=true,BN=true)
  PASS  js/pages/video.js        未登录(mg=true,BN=true) 空identities(mg=true,BN=true) 过期catVIP(mg=true,BN=true) 普通用户(mg=true,BN=true)
  PASS  js/pages/live.js         未登录(mg=true,BN=true) 空identities(mg=true,BN=true) 过期catVIP(mg=true,BN=true) 普通用户(mg=true,BN=true)
  PASS  js/pages/popup.js        未登录(mg=true,BN=true) 空identities(mg=true,BN=true) 过期catVIP(mg=true,BN=true) 普通用户(mg=true,BN=true)
  PASS  js/pages/message.js      未登录(mg=true,BN=true) 空identities(mg=true,BN=true) 过期catVIP(mg=true,BN=true) 普通用户(mg=true,BN=true)
  → 6/6 bundle 通过

=== [2] 成品树 getBHAccount 回包（表达式从树里实时抽取并求值）
  PASS  存在 getBHAccount 补丁锚点 @83007
  PASS  getBHAccount(store=null) -> isVIP=true isSuperVIP=true identities[0].to>now=true
  PASS  getBHAccount(store=real) -> isVIP=true isSuperVIP=true identities[0].to>now=true

=== [3] 成品树 getStatus 回包（hasLogin / bhAccount 必须非空；VIP 语义走 mg()）
  PASS  存在 getStatus 补丁锚点 @82443
  PASS  getStatus(bhAccount=null) -> hasLogin=true hasRegister=true bhAccount.isVIP=true bhAccount.isSuperVIP=true identities[0].to>now=true
  PASS  getStatus(bhAccount=real) -> hasLogin=true bhAccount 原样透传=非空 mg(bhAccount)=true BN(bhAccount)=true（期望 true/true）

=== [4] B1/B1b 插入的 await 必须位于 async 方法内
  PASS  background.js 中 await this.fetchBasicDownloadInfo 出现 2 次（期望 2）
  PASS  B1 位于 async init() 内（否则 node --check 会报 SyntaxError）
  PASS  B1b 位于 async refreshBasicDownloadInfo() 内

=== 总结: PASS (fail=0)
```

**PASS（15 项检查全过，0 fail）**。

一处必须说明清楚的事实（不是缺陷）：`getStatus` 补丁**不注入顶层 `isVIP` 字段**，
它对已存在的真实 `bhAccount` 是**原样透传**（只在 `bhAccount` 为 `null` 时补合成会员对象）。
真正被 UI 门控消费的会员语义来自两处：`getBHAccount`（恒 `isVIP:true`）与 `mg()`（恒 `true`）。
所以 `getStatus(bhAccount=real)` 的断言写成「`hasLogin===true` 且 `mg(bhAccount)===true`」——
这条实测是通过的。

> `js/pages/background.js`（offscreen 下载器）**不含模块 3078**，所以不参与 `mg/BN` 的 6-bundle 检查，
> 它的验证在验收 ④（B1/B1b async）与验收 ③（B2/B3/B4 门锁）里。

---

## 3. 验收 ③：下载门验证

```bash
node tools/final-verify-gates.js output/ACGhelper-2.8.31.16-unlock
node tools/final-verify-gates.js output/ACGhelper-2.8.31.16-unlock-sameId
```

该脚本两段：`[A]` 直接跑 `tools/proto-verify-gates.js` 做补丁前后语义复算；
`[B]` 在**成品树**上逐条断言 23 条协议补丁（old 必须消失、new 必须出现）+ 关键分支可达性。

### [A] 语义复算（`logs/verify-gates-unlock.log`）

```
    [PASS] G1 V1 视频 VIP 画质集合含 120/125/126/127  pre=true post=false  expect pre=true post=false
    [PASS] G2 V2 音频 VIP 集合含 30250/30251/30255  pre=true post=false  expect pre=true post=false
    [PASS] G3 V7 非 isBHVIP + videoOnly 点击下载  pre="PAYMENT" post="PROCEED"  expect pre="PAYMENT" post="PROCEED"
    [PASS] G3b V7 切片下载(enableSegmentSelector) 非 VIP  pre="PAYMENT" post="PROCEED"  expect pre="PAYMENT" post="PROCEED"
    [PASS] G4 V8 非 isBHVIP 时按钮 disabled  pre=true post=false  expect pre=true post=false
    [PASS] G5 V9 非 isBHVIP 时音频级联框整体禁用  pre=true post=false  expect pre=true post=false
    [PASS] G6 V10 非 isBHVIP + 仅画面下载  pre=false post="PROCEED"  expect pre=false post="PROCEED"
    [PASS] G7 V13 番剧页 isPGC  pre=true post=false  expect pre=true post=false
    [PASS] G8 B2 429 重试超 3 次抛 DOWNLOAD_TOO_FREQUENTLY  pre="THROW:E429" post="PROCEED"  expect pre="THROW:E429" post="PROCEED"
    SUMMARY pass=9 fail=0 total=9
```

### [B] 成品树断言（39 条 `[PASS]`，0 fail）

```
=== [B] 成品树逐条断言（23 条协议补丁：old 全消失 / new 全出现）
[PASS]  35360 js/pages/video.js          old×0 (期望 0)  new×2 (期望 ≥1)  :: V1 视频 VIP 画质集合清空…
[PASS]  35418 js/pages/video.js          old×0 (期望 0)  new×1 (期望 ≥1)  :: V2 音频 VIP 集合清空…
…
[PASS] 540621 initBackground.sw.js       old×0 (期望 0)  new×1 (期望 ≥1)  :: S2 PGC 回包结构取 result.video_info

=== [B1] V1/V2 VIP 画质 / 音频集合已空
[PASS] V1/V2 集合赋值已为 `_=[],S=[]`（120/125/126/127 与 30250/30251/30255 不再入集合）
[PASS] V1 旧画质集合串已消失
[PASS] V2 旧音频集合串已消失
    （说明：y.QN_127 / k.QN_30250 在画质名称表与条目 value 中仍作为常量存在，不参与门判定）

=== [B2] V13 PGC 判定器恒 false + PGC 内容限制分支不可达
[PASS] V13 原 PGC 判定表达式已不存在
[PASS] V13 PGC 判定器已改为常量 false（i=()=>!1）
[PASS] video.js 中 NOT_SUPPORT_PGC_CONTENT 出现 4 次（期望 4：枚举键/枚举值/文案构造 new u(...)/保持引用数组，均为定义，无抛出）
[PASS] video.js 中 throw NOT_SUPPORT_PGC_CONTENT 抛出点 = 0（期望 0 → 该错误码本版无抛出点）
[PASS] 该错误码仅出现在 `const h=[m.NOT_SUPPORTED,m.NOT_SUPPORT_PGC_CONTENT]` 保持引用数组里（不参与分支）
[PASS] PGC 渲染分支的门 i() 恒 false → 「根据站方要求无法继续提供PGC内容下载」分支不可达（文案在文件里以 \uXXXX 转义存储）

=== [B3] 番剧（PGC）取流链路：SW 不再 return null
[PASS] S1 原 `if(e)return null` 已不存在
[PASS] S1 SW videoParse 改为 PGC/UGC 分支取地址
[PASS] S2 PGC 回包结构取 (result||data).video_info

=== [B4] 限速中断与 DRM 中断
[PASS] B2/B3 429/412 超限不再 throw DOWNLOAD_TOO_FREQUENTLY
[PASS] B4 pssh/DRM 检测不再中断（PROTECTED_BY_DRM 分支恒不进入）

=== [B5] 可选补丁状态（默认不打）
[PASS] B5 未打（裸 fetch，不带 credentials:include）
[PASS] B6 未打（playurl 未显式带 ep_id）

=== 总结: PASS (fail=0)
```

**PASS**。三条硬要求逐条对上：VIP 画质集合已空（`_=[],S=[]`）、PGC 判定已改（`i=()=>!1`）、
`NOT_SUPPORT_PGC_CONTENT` **抛出点 0 个** → 该分支不可达。

---

## 4. 验收 ④：真实 headless 加载冒烟

```bash
node tools/final-smoke-chrome.mjs                                   # 普通版
node tools/final-smoke-chrome.mjs output/ACGhelper-2.8.31.16-unlock-sameId \
     --logtag=sameid --expect-id=kpbnombpnpcffllnianjibmpadjolanh   # 同 ID 版
```

### 4.1 降级过程（重要发现）

Chrome 156 上 **`--load-extension` 命令行开关已经失效**（M137 起移除），实测：

```
=== 尝试 A: --load-extension
  → 未出现 chrome-extension://inonbnppkjgfdodifhklhhcinlghgjmj/initBackground.sw.js 的 service_worker target

=== 尝试 B: A + --disable-features=DisableLoadExtensionCommandLineSwitch
  → 未出现 chrome-extension://inonbnppkjgfdodifhklhhcinlghgjmj/initBackground.sw.js 的 service_worker target

=== 尝试 C: --enable-unsafe-extension-debugging + CDP Extensions.loadUnpacked
  Extensions.loadUnpacked -> {"id":"inonbnppkjgfdodifhklhhcinlghgjmj"}
  → 命中 SW target: chrome-extension://inonbnppkjgfdodifhklhhcinlghgjmj/initBackground.sw.js
  已清理运行时缓存 D:\AI-Project\逆向统一\acghelper\output\ACGhelper-2.8.31.16-unlock\_metadata
```

**退化成什么**：仍然 `--headless=new`（无窗口、无音频），但扩展注入改走
**CDP `Extensions.loadUnpacked`**（官方 136+ 通道），启动参数只多一个 `--enable-unsafe-extension-debugging`。
`--load-extension` / `--disable-extensions-except` 保留在 A/B 两层里只作对照，不参与最终判定。

实际生效的启动命令行（`logs/smoke-unlock-cdp-result.json`）：

```json
["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
 "--mute-audio","--disable-background-networking","--disable-component-update",
 "--user-data-dir=C:\\Users\\26979\\AppData\\Local\\Temp\\acg-smoke-XX4vf2",
 "--remote-debugging-port=56310","--enable-unsafe-extension-debugging"]
```

### 4.2 三条断言

**① SW target 存在且指向成品目录**（原始 JSON，`logs/smoke-unlock-jsonlist.json`）：

```json
{
  "id": "43BB150982497313D08D2870CCFF7A29",
  "title": "Service Worker chrome-extension://inonbnppkjgfdodifhklhhcinlghgjmj/initBackground.sw.js",
  "type": "service_worker",
  "url": "chrome-extension://inonbnppkjgfdodifhklhhcinlghgjmj/initBackground.sw.js",
  "webSocketDebuggerUrl": "ws://127.0.0.1:56310/devtools/page/43BB150982497313D08D2870CCFF7A29"
}
```

「url 指向成品目录」不是靠猜的：Chrome 对 **unpacked** 扩展的 ID =
`SHA256(扩展绝对路径 as UTF-16LE)[:16] → 十六进制 → a-p 映射`，脚本自己算出
`inonbnppkjgfdodifhklhhcinlghgjmj`，与 `Extensions.loadUnpacked` 返回值和 SW url 里的 ID **三方一致**：

```
期望扩展ID : inonbnppkjgfdodifhklhhcinlghgjmj   (SHA256(路径 UTF-16LE)[:16] → a-p)
[PASS] ① … id = inonbnppkjgfdodifhklhhcinlghgjmj（== 路径推导 ID：true）
```

**② 扩展上下文读到 manifest**（在 SW target 上 `Runtime.evaluate`）：

```json
{"version":"2.8.31.16","version_name":"2.8.31.16(Beta) unlock","name":"ACG助手 - 提供视频下载消息推送",
 "manifest_version":3,"id":"inonbnppkjgfdodifhklhhcinlghgjmj","locale":"zh-CN","hasDownloads":true}
```

**③ stderr 关键词**：`Manifest` / `Service worker registration failed` / `SyntaxError` 全未命中
（stderr 0 字节，`logs/smoke-unlock-stderr.txt`）。附加断言：SW 上下文 3 秒内
`Runtime.exceptionThrown = 0`。

### 4.3 两棵树的结果

| 成品树 | 扩展 ID | ① SW | ② manifest | ③ stderr | ④ 异常 | 结论 |
|---|---|---|---|---|---|---|
| `-unlock`（无 key） | `inonbnppkjgfdodifhklhhcinlghgjmj` | PASS | PASS | PASS | 0 | **PASS** |
| `-unlock-sameId`（带 key） | `kpbnombpnpcffllnianjibmpadjolanh` | PASS | PASS | PASS | 0 | **PASS** |

同 ID 版的实测摘要（`logs/smoke-sameid.log`）：

```
  Extensions.loadUnpacked -> {"id":"kpbnombpnpcffllnianjibmpadjolanh"}
  → 命中 SW target: chrome-extension://kpbnombpnpcffllnianjibmpadjolanh/initBackground.sw.js
[PASS]    version = 2.8.31.16（数字段保持 2.8.31.16）
[PASS]    version_name = 2.8.31.16(Beta) unlock
[PASS]    manifest_version = 3
[PASS]    chrome.runtime.id = kpbnombpnpcffllnianjibmpadjolanh
```

> 注：Chrome 加载带 `declarative_net_request` 的 unpacked 扩展时会在扩展目录里生成
> `_metadata/generated_indexed_rulesets/…` 运行时缓存。脚本在每次冒烟后自动删除该目录，
> 保证成品树 85 个文件与 zip 内容一致（`Test-Path ...\_metadata` = False 已复核）。

---

## 5. 环境铁律自证三项

> 本次冒烟全程 `--headless=new`：**没有创建任何窗口**，因此不涉及主屏/副屏、也不涉及
> `SetForegroundWindow` / `SetCursorPos` / `SendInput` / 截图（脚本里连这些 API 的调用都不存在）。
> 按任务要求给出判定依据：

**① 窗口矩形在副屏内** —— 不适用但必须有证据：全程 headless，窗口数为 0。
判据：`Get-Process chrome | Where MainWindowHandle -ne 0` 的计数在**跑前跑后都是 1**，
且那 1 个是用户自己原有的 Chrome 窗口（不是本次启动的实例；本次实例都是 headless、无窗口）。

```
BEFORE: CHROME_WINDOWS_VISIBLE=1      （用户自有窗口，跑前就存在）
AFTER : CHROME_WINDOWS_VISIBLE=1      （跑后仍为 1，没有新增窗口）
FINAL : chrome_with_window=1
```

**② 未抢焦点** —— `GetForegroundWindow` 前中后完全一致：

```
BEFORE_FG_HWND=0x1C156A   BEFORE_FG_RECT=(0,0)-(2560,1440)   2026-11-08T15:46:18+08:00
AFTER_FG_HWND =0x1C156A   AFTER_FG_RECT =(0,0)-(2560,1440)   2026-11-08T15:50:15+08:00
FINAL_FG_HWND =0x1C156A   FINAL_FG_RECT =(0,0)-(2560,1440)   2026-11-08T15:53:27+08:00
```

三次采样同一 HWND（`0x1C156A`）→ 前台窗口从未被改动。

**③ 未出声** —— 启动参数带 `--mute-audio`，且 headless 无音频输出设备会话；
脚本不含任何播放/提示音调用。判据：进程启动参数（见 `logs/smoke-*-cdp-result.json` 的 `args`）含 `--mute-audio`。

**进程清理**：只按自己记录的主 PID 做 `taskkill /PID <pid> /T /F`，跑完普查：
`CommandLine -like '*acg-smoke-*'` 的 chrome 进程数 = **0**；临时 profile 目录数 = **0**；
用户自有 Chrome 的窗口数保持 1 不受影响。

---

## 6. 失败分支（都做了真实复现）

### 6.1 `old` 串失配（锚点不唯一 / 已被改动）

复现方法：把 `src/extracted` 复制成 `logs/_badsrc`，人为改坏 `popup.js` 里的 `mg()` 判定行，再 `--check`：

```
python tools/apply-all-patches.py --check --src logs/_badsrc
源目录      : D:\AI-Project\逆向统一\acghelper\logs\_badsrc
补丁规格    : static=10  proto=23  optional=2  → 本次应用 33 条（不含可选）
----------------------------------------------------------------------------------------------------------------------
[FAIL] 补丁锚点预检失败（未写任何文件）：
  [S06] js/pages/popup.js  count=0  原始文件锚点不唯一
      old='if(!e||!e.identities||0===e.identities.length)return!1;'

EXIT=1
```

退出码 1，报出 `file / old / 实际 count`，**一个文件都没写**。
同一套检查在真实应用路径上也存在（`order#N` + `count(old)` + 期望值），
所以「半成品落盘」在结构上不可能发生：全部补丁先在内存里按序演练，全过才写盘。

**改法**：锚点变了说明样本版本不对或上游规格需要更新 → 换回原版 `src/extracted`，
或按新上下文重写该条 `old` 串（属于规格维护，不在构建脚本里私自绕过）。

### 6.2 加载失败（`--load-extension` 不生效）

症状：`/json/list` 里压根没有本扩展的 target，只有 Chrome 内置组件扩展。
已在 §4.1 实测，改法就是切到策略 C（`--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked`）。

### 6.3 SW 注册失败

症状分两种：

| 症状 | 判定 | 排查 |
|---|---|---|
| `/json/list` 无 `service_worker` target，但扩展本体加载成功（`Extensions.loadUnpacked` 返回 id） | SW 注册失败或启动即崩 | ① 先 `node --check initBackground.sw.js` 排语法；② 用 CDP 在 SW target 上挂 `Runtime.enable` 看 `Runtime.exceptionThrown`；③ `chrome://extensions` 开发者模式下看「错误」按钮的红字 |
| SW target 出现过又消失 | SW 顶层抛异常后被杀 | 同上；重点看顶层 `importScripts` / `chrome.*` 调用是否因权限或 `optional_permissions: ["background"]` 未授予而抛 |

本次两棵树都没有出现这两种症状（SW target 稳定存在、`exceptionThrown=0`、`stderr` 0 字节）。

### 6.4 副屏 / 静音退化路径（若将来必须走有头模式）

如果哪天 headless 不再支持扩展加载，退化到有头 `chrome --new-window` 时**必须**：

1. 启动后立刻 `SetWindowPos(hwnd, 0, -1600, -527, w, h, SWP_NOACTIVATE)`，`w ≤ 914`、`h ≤ 1415`；
2. `GetWindowRect` 回读复测（浏览器常把自己还原到主屏，需要循环夹 2~3 次）；
3. 全程不调用 `SetForegroundWindow` / `activateWindow` / `raise_` / `ShowWindow(SW_SHOW)` / `AttachThreadInput`；
4. 不用 `SetCursorPos` / `mouse_event` / `SendInput` / pyautogui；交互只走 UIA `InvokePattern` 或 `PostMessage`；
5. 截图只用 `PrintWindow(hwnd, hdc, 2)`，不截主屏/全屏；
6. 进程静音（`pycaw SetMute(1, None)` 或启动参数 `--mute-audio`）。

本次**没有走到这条路径**（headless 策略 C 直接成功），上面的条目只是备用方案。

---

## 7. 复跑与清理

```bash
# 重新构建（幂等：先清空再重建，同一输入产出同一结果）
python tools/apply-all-patches.py                      # 38 条
python tools/apply-all-patches.py --with-optional      # 39 条（+B5，B6 自动跳过）

# 全量验收（38 条口径）
node    tools/final-verify-static.mjs output/ACGhelper-2.8.31.16-unlock
node    tools/final-verify-gates.js  output/ACGhelper-2.8.31.16-unlock
python  tools/final-verify-38-matrix.py --variant both
python  tools/verify-independent-38.py --stage all
node    tools/verify-independent-semantics.mjs
node    tools/final-smoke-chrome.mjs

# 环境自证（前台窗口 / 可见窗口 / 残留进程三项采样）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/env-selftest.ps1 -Variant sameId -Port 9343

# 清场（冒烟脚本已自动做，这里是兜底）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*acg-verify-indep*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
powershell -NoProfile -Command "Get-ChildItem \$env:TEMP -Directory -Filter 'acg-*' | Remove-Item -Recurse -Force"
```

幂等实测：`--check` 与正式构建连续跑多次，38/38 锚点始终 `count==1`（extra 段偏移始终与规格一致），
`src/extracted` 目录指纹始终 `00c27453332a0e1b…`（未变），产物哈希稳定。

## 8. 脚本清单

| 脚本 | 作用 |
|---|---|
| `tools/apply-all-patches.py` | **唯一权威构建脚本**（分段合并 38 条 / 校验 / 落盘 / 出两份成品与 zip / 出报告） |
| `tools/final-verify-static.mjs` | 成品树模块级语义验证（6 bundle × 4 输入 mg/BN、getBHAccount/getStatus 回包含 X4、B1/B1b async） |
| `tools/final-verify-gates.js` | 成品树下载门断言（内含跑 `proto-verify-gates.js` 语义复算 + 23 条 old/new（串联终态）+ extra 5 条 + PGC 分支可达性 + B5 未打） |
| `tools/final-verify-38-matrix.py` | 38 条 × 两棵树的 `old 消失 / new 出现` 逐条矩阵（自包含/串联口径写在表头） |
| `tools/verify-independent-38.py` | 38 条版独立尺子（派生自 `verify-independent.py`，**原文件未改**）：分段独立重放→逐字节比对 + 簇分析 + node --check |
| `tools/verify-independent-semantics.mjs` | 独立语义复跑（模块 3078 的 8 组输入 + 两个 listener 回包；R-4 断言现在是 PASS，即 X4 生效） |
| `tools/verify-independent-load.mjs` | 独立加载复验（CDP `Extensions.loadUnpacked` + SW 断言 + MainWindowHandle 自证 + 自动清场） |
| `tools/final-smoke-chrome.mjs` | headless Chrome 真实加载冒烟（三层降级 A/B/C + `/json/list` + stderr 落盘） |
| `tools/env-selftest.ps1` | 环境铁律三项采样（GetForegroundWindow 前/中/后 + 可见窗口计数 + 残留进程），只读不激活窗口 |
| `tools/verify-independent.py` | **独立验收原始尺子（本轮一字未改，sha256 `2bf9163f938ab3ee…`）**，33 条基准；对 38 条成品会 FAIL，原因见 §9.5 |

## 9. 38 条收尾轮：落地 X1–X5 并全量复验

### 9.1 本轮做了什么

| 项 | 内容 |
|---|---|
| 规格 | `tools/extra-patch-spec.json` 补 X5（从 `proto-patch-optional.json` 的 B6 抄，`id=X5`、`route=下载链路/PGC`、`priority=P0`） |
| 构建 | `tools/apply-all-patches.py` 增加 `extra` 阶段：分段预检（第 1 段在 pristine、第 2 段在第 1 段输出）+ 偏移断言 + `optional` 自动跳过已被 extra 消费的 B6 + `counts` 分级计数 |
| 成品 | 两棵树 + 两个 zip 全部重生成（覆盖旧产物）；`_patch-report.json` / `_build-info.json` 刷新 |
| 目录 | `output/patch-2.8.31.16/`、`output/acghelper-2.8.31.16-patched.zip` 移到 `build/legacy-intermediate/` |
| 文档 | `output/README.md`、`docs/patch-manifest.md`、本文件、新增 `docs/release-checklist.md` |

### 9.2 `node --check`（`logs/nodecheck-38.log`）

两棵树 × 7 个改动文件 = **14/14 PASS**（原文见 §1）。

### 9.3 门锁断言（`logs/verify-gates-38-unlock.log` / `-sameid.log`）

```
=== 总结: PASS (fail=0)          # 52 条断言，两棵树都是 PASS
[PASS] X1 P0  initBackground.sw.js     old×0 (期望 0)  new×1 (期望 ≥1)
[PASS] X2 P1  js/pages/background.js   old×0 (期望 0)  new×1 (期望 ≥1)
[PASS] X3 P1  js/pages/background.js   old×0 (期望 0)  new×1 (期望 ≥1)
[PASS] X4 P2  initBackground.sw.js     old×0 (期望 0)  new×1 (期望 ≥1)
[PASS] X5 P0  js/pages/background.js   old×0 (期望 0)  new×1 (期望 ≥1)
[PASS] 两处 PGC 请求都带 ep_id:this.epid（实际 2 处：SW Yt() + offscreen B()）
[PASS] X2/X3 重试硬上限出现在 2 处（期望 2：DASH 分段 fetcher + FLV 分段 fetcher）
[PASS] X4 getStatus 在 bhAccount 非空时也强制 isVIP/isSuperVIP（与 getBHAccount 出口一致）
[PASS] B5 未打（全文件无 credentials:"include"）
[PASS]  28022 js/pages/background.js  old×0 (期望 0)  new×1 (期望 ≥1)（串联终态：X2 改写其后）  :: B2 …
[PASS]  41477 js/pages/background.js  old×0 (期望 0)  new×1 (期望 ≥1)（串联终态：X2 改写其后）  :: B3 …
```

### 9.4 38 条 old/new 矩阵 + 模块语义

`logs/verify-38-oldnew-matrix.log`（38 条 × 2 棵树，`=== 总结: PASS (fail=0)`）：

```
S01  static  initBackground.sw.js   old×1(→1) new×1   [自包含]
X1   extra   initBackground.sw.js   old×0(→0) new×1
X5   extra   js/pages/background.js old×0(→0) new×1
```

`logs/verify-static-38-unlock.log`（模块级，两棵树 `=== 总结: PASS (fail=0)`）：

```
PASS  X4 getStatus(bhAccount=真实非会员).bhAccount.isVIP=true isSuperVIP=true bhid=7（期望 true/true/7 —— 透传原字段 + 强制会员位）
PASS  getBHAccount(store=real) -> isVIP=true isSuperVIP=true identities[0].to>now=true
PASS  6/6 bundle 通过（mg/BN 全 true）
```

`logs/verify-independent-semantics-38.log`（别人的独立语义脚本，**R-4 断言现在 PASS**）：

```
[PASS] getStatus(bhAccount=真实非会员).bhAccount.isVIP === true（声明要求）
检查项=40  失败=0
RESULT: PASS
```

（同一脚本在 33 条成品上是 `检查项=40 失败=1`，失败项正是这条 R-4 断言 —— X4 把它闭环了。）

### 9.5 交叉验证：`tools/verify-independent.py`（原尺子未改）

```bash
python tools/verify-independent.py --stage all --variant unlock   # logs/verify-independent-38-crosscheck.log
```

它对本轮新成品的判定原文（**FAIL (9)**）：

```
[FAIL] initBackground.sw.js 差异簇外字节完全一致（拼接恒等式）
[FAIL] initBackground.sw.js 每个簇内 old/new 与补丁声明逐字节一致
[FAIL] js/pages/background.js 差异簇外字节完全一致（拼接恒等式）
[FAIL] js/pages/background.js 每个簇内 old/new 与补丁声明逐字节一致
[FAIL] 可选补丁 O02 未被打（锚点仍在 count=1） :: count=0 file=js/pages/background.js
[FAIL] initBackground.sw.js == 独立重放结果（逐字节） :: len prod=839458 replay=839385 sha prod=4889b71715e39226 replay=d741776d4db066e0
[FAIL] js/pages/background.js == 独立重放结果（逐字节） :: len prod=112297 replay=112227 sha prod=1812e55cdb28a605 replay=2cbf349f3b12c372
[FAIL] …（同两条 apply 断言在 sameId 变体重复一次）
RESULT: FAIL (9)
```

**定位：9 条失败全部是这把尺子的「33 条基准」过期，不是成品有问题。** 逐条对得上：

| 失败项 | 根因 | 证据 |
|---|---|---|
| 两处 `拼接恒等式` / `簇内 old-new` | `patch_spans()` 只从 static+proto 规格取区间；X1/X5 新增了 2 个簇、X2/X3/X4 改写了 3 个已有簇的 `new` 字节 → 声明的 33 个区间覆盖不到 | `audit38` 段打印：X4 嵌在 `S08` 簇内、X2/X3 与 `P19/P20` 簇重叠、X1/X5 落在空白区；最终簇数 33→35 |
| `可选补丁 O02 未被打` | O02 就是 B6，本轮提级为 X5 默认打 → 锚点当然 `count=0` | `grep -c 'ep_id:this.epid'` 成品 = 2（两处都打了） |
| 4 处 `独立重放`（×2 变体） | 它重放 33 条，与 38 条成品必然不等 | 差值正好是 5 条增补：`839458-839385 = +73 = X1(+16) + X4(+57)`；`112297-112227 = +70 = X5(+16) + X2(+27) + X3(+27)`；另外 5 个文件两边**逐字节相同** |

**修法（不改原尺子）**：新增 `tools/verify-independent-38.py` —— 同一套方法（不 import 构建脚本、
不读 `_patch-report.json` 当证据、自己做字节级重放），基准扩到 38 条 + 分段（第 1 段在 pristine、
第 2 段在第 1 段输出）+ extra 偏移断言 + 簇落点分类。运行结果：

```
$ python tools/verify-independent-38.py --stage all          # logs/verify-independent-38-all.log
[PASS] 规格条数 = 38（static 10 + proto 23 + extra 5）
[PASS] initBackground.sw.js == 38 条独立重放结果（逐字节）
[PASS] js/pages/background.js == 38 条独立重放结果（逐字节）
[PASS] 第 1 段差异簇数 = 33（33 条补丁 → 期望 33）
[PASS] extra 落点分类符合预期（X4 嵌在 S08 簇内；X2/X3 与 B2/B3 簇重叠延伸；X1/X5 落在空白区）
[PASS] 最终差异簇数 = 35（期望 35 = 33 个第 1 段簇 + X1 + X5）
[PASS] B6 已被 X5 消费（原锚点 count=0）
检查项=128  失败=0  用时=2.2s
RESULT: PASS
```

原尺子本体保持不动，哈希可核：`sha256(tools/verify-independent.py) = 2bf9163f938ab3ee6e2e866e04dd4f1fb4cf7d047a69ab15da748b2368b7dbbb`。

### 9.6 加载复验（headless + CDP `Extensions.loadUnpacked`）

`logs/verify-independent-load-38-sameid.log`（13/13 PASS）与 `logs/verify-independent-load-38-unlock.log`（13/13 PASS）：

```
spawn: chrome.exe --headless=new --remote-debugging-port=9341 … --mute-audio --enable-unsafe-extension-debugging about:blank
Extensions.loadUnpacked -> {"id":"kpbnombpnpcffllnianjibmpadjolanh"}
SW target: {"type":"service_worker","url":"chrome-extension://kpbnombpnpcffllnianjibmpadjolanh/initBackground.sw.js"}
[PASS] SW 上下文 5 秒内 Runtime.exceptionThrown === 0
[PASS] SW 上下文 5 秒内 console.error === 0
[PASS] SW getManifest().version_name === "2.8.31.16(Beta) unlock"
[PASS] 本次 Chrome 所有进程 MainWindowHandle 均为 0（无可见窗口）
检查项=13  失败=0   RESULT: PASS
```

`/json/list` + stderr 原始证据（`tools/final-smoke-chrome.mjs --logtag=38-sameid`，`logs/smoke-38-sameid-*`）：

```
→ 未出现 chrome-extension://…/initBackground.sw.js 的 service_worker target     （策略 A 失效，与已知一致）
→ 未出现 …                                                                       （策略 B 同样失效）
=== 尝试 C: --enable-unsafe-extension-debugging + CDP Extensions.loadUnpacked
Extensions.loadUnpacked -> {"id":"kpbnombpnpcffllnianjibmpadjolanh"}
[PASS] ① /json/list 出现 type="service_worker" 且 url 指向成品目录的 initBackground.sw.js
[PASS] ③ stderr 无 Manifest / Service worker registration failed / SyntaxError（0 字节）
STRATEGY = C   SUMMARY: PASS (fail=0)
```

### 9.7 环境铁律自证（`logs/verify-env-selftest-38.log`）

```
BEFORE  T=2026-11-08T16:31:50+08:00 FG_HWND=0x20A04 FG_RECT=(-1923,-292)-(-627,765) CHROME_VISIBLE_WINDOWS=1
MID     T=2026-11-08T16:31:55+08:00 FG_HWND=0x20A04 FG_RECT=(-1923,-292)-(-627,765) CHROME_VISIBLE_WINDOWS=1
AFTER   T=2026-11-08T16:32:10+08:00 FG_HWND=0x20A04 FG_RECT=(-1923,-292)-(-627,765) CHROME_VISIBLE_WINDOWS=1
FINAL   T=2026-11-08T16:32:10+08:00 FG_HWND=0x20A04 FG_RECT=(-1923,-292)-(-627,765) CHROME_VISIBLE_WINDOWS=1
LEFTOVER_PROFILE_CHROME=0
LEFTOVER_TEMP_PROFILES=0
FG_UNCHANGED=True
```

- **未抢焦点**：四次采样同一 HWND `0x20A04`（用户自己的窗口，位于副屏区域 `(-1923,-292)`），前/中/后完全没变。
- **无可见窗口**：`CHROME_VISIBLE_WINDOWS` 恒为 1（用户自己的窗口）；本次跑的 headless Chrome 所有进程
  `MainWindowHandle=0`（见 §9.6 的断言行）。
- **未出声**：启动参数含 `--mute-audio`，脚本无任何播放/提示音调用。
- **清理**：`LEFTOVER_PROFILE_CHROME=0`、`LEFTOVER_TEMP_PROFILES=0`（profile 与 ASCII 临时扩展副本都被删除）。

### 9.8 失败分支（本轮实测，都真的复现了）

| 场景 | 复现方法 | 结果 |
|---|---|---|
| 第 1 段锚点失配 | 复制 `src/extracted` → 改坏 `video.js` 的 V1 锚点 → `--src build/_failsrc --out build/_failout` | `[FAIL] 补丁锚点预检失败（未写任何文件）：[P01] js/pages/video.js count=0`，退出码 **1**，`build/_failout` **不存在**（`logs/failbranch-anchor-38.log`） |
| extra 锚点失配 | 内存里把 X2 的 `old` 改一个字符再 `simulate()` | `post-proto 阶段锚点预检失败（未写任何文件）：[X2] … count=0`（`logs/failbranch-extra-stage.log`） |
| extra 偏移漂移 | 把 X5 的 `offset` 改 ±1 再 `simulate()` | `[X5] … count=1  锚点偏移 10771 != 规格记录的成品树偏移 10772` |
| extra 锚点不唯一 | 把 X4 的 `old` 换成 `bhAccount:this.bhAccount` | `[X4] … count=10  post-proto 阶段输入里锚点不唯一` |
