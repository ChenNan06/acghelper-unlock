# ACGhelper 2.8.31.16 · 解锁版成品说明（v2 · `unlock r4`）

> 本目录是**可直接加载的成品**。所有补丁都是从原始包 `acg-helper-2.8.31.16.zip`
> （SHA256 `840455e6b71e1e33b381ae98b86cc3b5bb57500f8a66469a3f6a98e4b4d94703`）
> 解包后按字符串锚点重写的产物，一条命令可完整复跑（见 [构建与验收](../docs/build-and-verify.md)）。
>
> **v2 变更**：在原来 38 条之上并入五路新功能（番剧下载 0 字节修复 / DASH 音轨可见性与 PGC 鉴权 /
> 空视频段自动回退 / WebDAV 云同步 / 选集批量下载），总数 **67 条 + 8 个新增文件**，
> 版本号后缀为 **`2.8.31.16(Beta) unlock r4`**（r2 → r3 加了 DASH 两段，r4 把 WebDAV 与选集两处 UI 改版合进流水线）。
> 逐轮改动、根因、影响面、已知限制见 [`docs/v2-changelog.md`](../docs/v2-changelog.md)。

---

## 0. v2 这一版新增的几块（先看这里；最后两块是 r4 的 UI 改版）

| 块 | 一句话原理 | 用户怎么用 |
|---|---|---|
| **番剧下载修复（4 条 · `F1`–`F4`）** | 番剧的 `durl` 有两种形态：真 FLV，以及**整段 MP4**。原代码只看 `isFLV: durl && !dash` 判形态，把 MP4 也送进 FLV 合并器 → 合并器抛 `INVALID_FLV_HEADER / FLV_IS_MP4` → 一次 `write()` 都没发生，而文件已被 `createWritable()` 建出来 → **产物 0 字节**。修法是：合并失败时若首段 12 字节内出现 `ftyp`（= MP4 的 box 头），就把各分段原样顺序拼成 Blob 落盘；真 FLV 的错照旧抛出，不掩盖 | 番剧页 `bilibili.com/bangumi/play/ep…` → 下载面板选画质 → 点下载。**产物应 > 0 字节且能正常播放**。若 UI 报错，现在会显示真实原因（不再只有「下载失败」四个字） |
| **WebDAV 云同步（9 条 · 6 个新增文件 + 3 处补丁 · r4 改为内嵌设置页）** | 把「官方会员服务器的设置云同步」换成你自己的 WebDAV：沿用官方逐控制器设置协议采集 + 原始 storage 快照降级，PUT 后 GET 回读 sha256 校验；SW 侧用 `chrome.alarms`，页面关着也能按 5 分钟周期自动同步 | **设置页左侧导航里多一栏「同步」**（不再是右下角浮动按钮、不再需要记快捷键）：点进去就是服务器（地址/账号/密码/远端目录）、同步范围分组勾选、定时同步开关、立即上传/下载/比对、状态与历史快照。独立页 `html/webdav.html` 仍保留为高级入口（逐条差异比对 / 原始日志 / 手工恢复）。默认凭据：`https://kurio.infini-cloud.net/dav/`、账号 `2697986947`、远端目录 `_acghelper/settings/`（**建议改成你自己的**） |
| **选集 / 多P 批量下载（3 条 + 2 个新增文件 · r4 改为并入插件面板）** | 内容脚本在番剧 `play`、`video`、`list`、`medialist` 页把入口**注入插件自己的悬浮面板**（`#bilibiliHelper2ContentWrapper` 的 `<footer>` 之前，样式抄原生 `div.button.primary` 的 `getComputedStyle`），勾选后走 offscreen 侧新增的 `acgxAutoDownload` / `acgxAbortAll` 命令，**串行队列**逐集复用原有下载链路（不复制下载逻辑）。**单集番剧 / 单 P 视频不注入任何节点**（判据：番剧集数 ≤ 1 且分 P ≤ 1） | 打开番剧/多P 视频页 → 展开插件面板 → 面板底部出现「选集下载」区块 → 勾选（或全选）→ 开始下载。队列串行，前一条完成才发下一条；面板上有进度与失败回执 |

---

## 1. 成品在哪

| 文件 / 目录 | 说明 | 大小 | SHA256 |
|---|---|---|---|
| `ACGhelper-2.8.31.16-unlock/` | **推荐**。完整扩展树，manifest 内**没有** `key`，Chrome 会算出一个新扩展 ID | 93 文件 · 树指纹 `d6b552bd…8122` | — |
| `ACGhelper-2.8.31.16-unlock.zip` | 上面目录的打包（zip 内无父目录，解压到当前目录即可用） | 3,748,433 B | `df293468eb33cc4dd85885f65fe08bec62af3a54bdb21de6d50a984ec5594baf` |
| `ACGhelper-2.8.31.16-unlock-sameId/` | 与商店版**同 ID** 的变体，manifest 内注入 216 字符 `key` | 93 文件 · 树指纹 `fc082c57…e8ab` | — |
| `ACGhelper-2.8.31.16-unlock-sameId.zip` | 同上打包 | 3,748,644 B | `91aa2e44f389acc8b19c1626a3a2450da96c98ae59337ef483fcd50187339672` |
| `_patch-report.json` | **67 条**补丁的逐条应用记录（`totals` 由规格算出：38 + 4+8+5+9+3；分段计数 static/proto/extra/feature + 每条 feature 补丁 id + 8 个新增文件清单与 sha256 + WebDAV v1 前置态重建 3 步 + 锚点审计） | — | — |
| `_build-info.json` | 构建元信息（源 zip 哈希、源目录指纹、四段计数、两棵树指纹、zip SHA256、构建时间、node/chrome/python 版本） | — | — |
| `README.md` | 本文件 | — | — |

补丁计数：**67 条 = 38（static 10 + proto 23 + extra 5）+ 29 feature（pgc-fix 4 + dash-auth-fix 8 + dash-fallback 5 + webdav 9 + batch 3）**，
另加 **8 个新增文件**（webdav 6 + batch 2）。数字由规格算出、写进 `_patch-report.json.totals`，不是手填。
`--with-optional` 时为 68 条（额外打 B5；B6 已并入 extra 的 X5，构建器会自动跳过，不会重复打）。
权威构建器：`tools/apply-all-plus-features.py`（`--check` 零写入演练 / `--out` / `--with-optional` / `--skip-feature`）。

两个成品树内容**完全一致**，唯一差异是 `manifest.json` 里 `version_name` 与 `key` 两项：

* `version_name`：`2.8.31.16(Beta)` → **`2.8.31.16(Beta) unlock r4`**
* `version`（数字段）：**保持 `2.8.31.16` 不动**（Chrome 只接受 1~4 段数字，改字符会判非法版本）
* 只有 `-sameId` 变体多一个 `"key"` 字段

---

## 2. 两种 ID 怎么选

| | `-unlock`（无 key） | `-unlock-sameId`（带 key） |
|---|---|---|
| 扩展 ID | Chrome 按安装路径现算（例如本机 `output\ACGhelper-2.8.31.16-unlock` → `inonbnppkjgfdodifhklhhcinlghgjmj`） | **`kpbnombpnpcffllnianjibmpadjolanh`**（= 商店版） |
| 与商店版共存 | ✅ 可以同时装 | ❌ 不能，必须先停用商店版 |
| 复用原设置 / 登录态 | ❌ 不共享 `chrome.storage`，需要重新登录一次 | ✅ 直接继承 |
| 适合场景 | 想保留商店版对照、或不想动原来的配置 | 想无缝接管原配置与登录状态 |

> **同 ID 版铁律**：加载前先去 `chrome://extensions` 把商店版**停用**（或移除）。
> 两个扩展 ID 完全相同，Chrome 会直接报 `Extension failed to load` / 安装被拒绝。

---

## 3. 怎么加载（Chrome 156 实测有效）

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选目录：
   * 普通版：`output\ACGhelper-2.8.31.16-unlock`
   * 同 ID 版：`output\ACGhelper-2.8.31.16-unlock-sameId`
4. 卡片上的版本应显示 **`2.8.31.16(Beta) unlock r4`**（这是最快的自证：能看到这个后缀，说明加载的就是改过的这份）
5. 若用 zip：先解压，**解压出来的文件夹里直接就是 `manifest.json`**（zip 内没有多套一层父目录）

加载成功后首次会自动弹出扩展设置页（扩展自身行为）。

---

## 4. 解锁了什么

### 4.1 本地授权层（10 处 · 插件自己的会员锁）

* **会员判定器 `mg()` 恒真**，在 6 个 bundle 里各打一处：后台 SW、配置页、播放页、直播页、弹窗、消息中心
  → 所有 `(0,X.mg)(bhAccount)` 形式的判定，无论账号为空 / 未登录 / 身份过期 / 普通用户，一律 `true`
* **`BN()`（超级会员）自动跟随** —— 它委托 `mg()`，不需要单独打
* **配置页共享锁组件**：`needVIP` 区块不再渲染「点击开通助手会员后使用」遮罩（登录检查保留）
* **`getStatus` 回包**：`hasLogin` / `hasRegister` 恒 `true`；`bhAccount` 为空时补一个合成会员账号；
  **`bhAccount` 非空（真实账号）时也强制 `isVIP:true` / `isSuperVIP:true`**（原字段全部透传）——
  两条出口（`getStatus` 与 `getBHAccount`）现在口径一致，不会出现「一个说非会员、一个说会员」
* **`getBHAccount` 回包**：恒返回 `isVIP:true` / `isSuperVIP:true` + 合法 `identities`（`catVIP`，有效期 10 年）—— UI 徽章与门控真正吃这个出口
* **基类 `onBHAccountChange`**：账号为空时不再把 `isVIP` 打回 `false`

### 4.2 下载链路（23 处 · 门锁与限速）

* **VIP 画质集合清空**：`120/125/126/127`（4K/8K 系）与 `116`（HDR）、`112`（8K）不再被标 `need-blvip/need-bhvip`
* **VIP 音频集合清空**：杜比全景声 `30250`、Hi-Res `30251`、杜比音效 `30255`
* **Hi-Res / 杜比条目**：不再 `disabled`，点击不再跳付费
* **画质 / 音轨条目**：禁用条件里的 `!isBLVIP && needVIP` 项去掉
* **高级模式**：下载主按钮不再跳支付页；下载按钮 `disabled` 去掉会员项；音频级联框不再整体禁用
* **简单模式**：点 VIP 画质不再跳付费；不再被「请先开通 b 站大会员」拦；仅画面 / 仅音频 / 切片下载的会员限制去掉
* **番剧（PGC）**：判定器恒 `false`，不再进「根据站方要求无法继续提供 PGC 内容下载」分支；
  后台 SW 对 PGC 真正请求 `/pgc/player/web/v2/playurl`（不再 `return null`），回包取 `result.video_info`
* **番剧 PGC 请求带 `ep_id`**（X1 + X5）：**后台 SW 的 `Yt()` 与 offscreen 的 `B()` 两处** PGC `playurl`
  请求参数都补上 `ep_id:this.epid`（原来只有 `bvid/cid`，而番剧在 PGC 侧根本没有 `bvid`）。
  少了这一步，S1/S2 打开的 PGC 分支会拿到空 `video_info`，等于白开
* **限速重试上限 8 次（不再无限挂起）**（X2 + X3）：429/412 的「重试次数超限」判定从 `!1`（永不放弃）
  改成 `this.rateLimitedRetryTimes>=8`。退避逻辑保留（指数退避，上限 5 分钟），但第 8 次仍被限速时会
  正常抛 `DOWNLOAD_TOO_FREQUENTLY` 并在 UI 上报错，而不是永远停在 downloading 只能手动取消。
  DASH 与 FLV 两个分段 fetcher 都改了
* **DRM**：`pssh` 检测不再中断（只对「带 pssh 但实际是明文」的流有效；真 Widevine 加密流是密文，需要 CDM 密钥，本补丁不解）

> 说明（事实，不是劝退）：**插件侧**的会员门已经全拆。但 bilibili **服务端**对 `1080P+/4K/HDR/杜比` 到底给不给流，
> 取决于你 B 站账号的站方权益——扩展只能请求，不能凭空造出服务端不给的清晰度。

### 4.3 增补补丁：默认**已打** 5 条（X1–X5），可选只剩 1 条（B5）

独立验收（[`docs/verify-independent.md`](../docs/verify-independent.md)）提出并已闭环的 5 条增补，
现在是**默认构建的一部分**（`tools/extra-patch-spec.json`，阶段 `extra`，源 = 独立验收 R-1 / R-2 / R-4）：

| id | 文件 | 内容 | 来源 |
|---|---|---|---|
| `X1` | `initBackground.sw.js` | SW 侧 `Yt()` 的 PGC 请求参数补 `ep_id:this.epid` | R-1 |
| `X5` | `js/pages/background.js` | offscreen 侧 `B()` 的 PGC `playurl` 补 `ep_id:this.epid`（= 原可选 B6，提级为默认） | R-1 |
| `X2` | `js/pages/background.js` | DASH 分段 fetcher：重试上限改 `>=8`（原 `!1` = 无限重试） | R-2 |
| `X3` | `js/pages/background.js` | FLV 分段 fetcher：同上 | R-2 |
| `X4` | `initBackground.sw.js` | `getStatus` 在 `bhAccount` 非空时也强制 `isVIP/isSuperVIP=true`（防御性，消除两条出口不一致） | R-4 |

**仍然默认关闭、只能手动打开的只剩 1 条**：

| id | 内容 | 什么时候才试 | 风险 |
|---|---|---|---|
| `O01`（= `B5`） | offscreen 所有 `api.bilibili.com` 请求改用 `fetch(e, {credentials:"include", ...})` | **只有**打完默认 38 条后，画质仍被锁在 480P / 720P（说明裸 `fetch` 没带 Cookie）时才试 | 跨域带凭证要求服务端回 `Access-Control-Allow-Credentials`；不满足时**所有下载请求都会失败**（不是变慢，是直接全挂）。所以默认必须保持关闭 |

手动打开方式：

```bash
python tools/apply-all-plus-features.py --with-optional --archive-legacy   # 68 条 = 67 + B5（B6 已并入 X5，自动跳过）
```

（老入口 `python tools/apply-all-patches.py --with-optional` 仍然可用，但它只产出 38+1 条的 v1 树，
不带 v2 的三块功能；要 v2 请用上面这条。）

验证是否打开成功：`js/pages/background.js` 里应出现 `credentials:"include"`（默认构建里是 **0 处**）。

---

## 5. 怎么验证真的解锁了（点哪里 → 看到什么）

**① 30 秒自证：版本号**
`chrome://extensions` → 找到本扩展 → 版本显示 **`2.8.31.16(Beta) unlock r4`**。
看不到这个后缀 = 加载的不是这份成品。

**② 会员身份：扩展弹窗**
点浏览器工具栏上的扩展图标（ACG助手）→ 弹窗内的会员/账号标识显示为**已开通会员**（`ACG-VIP` / VIP 徽章），
且**未登录 B 站账号时也照样显示会员**（因为 `getBHAccount` 恒返回会员对象）。

**③ 设置页会员区块**
`chrome://extensions` → 本扩展 → 「扩展程序选项」→ 打开设置页（或直接访问 `html/config.html`）：
原先带「开通助手会员后使用」遮罩的功能区块（下载相关配置等）现在**直接可操作**，不再有半透明遮罩与「点击开通会员」按钮。

**④ 播放页画质列表**
打开任意 b 站视频（如 `https://www.bilibili.com/video/BV1xx411c7mD`）→ 页面右下角 ACG助手 下载入口 → 展开画质列表：
* `1080P60 / 4K / HDR / 8K / 杜比全景声 / Hi-Res` 等条目**不再带「会员」标签**、**不再是灰色禁用**
* 点击这些条目**不再弹出「开通会员」/ 支付页**，而是正常被选中
* 音频下拉框（音轨/Audio）不再整体禁用

**⑤ 高级模式下载按钮**
下载面板 → 「高级模式」→ 主下载按钮**可点**（不再跳支付），分段选择器与音频级联框可操作。

**⑥ 番剧页**
打开任意番剧 `https://www.bilibili.com/bangumi/play/ep...` → 下载面板**不再**出现
「根据站方要求无法继续提供PGC内容下载」提示，且会真正去取番剧播放地址（能否真下到取决于站方是否给流）。
DevTools → Network 过滤 `playurl`，应能看到对 `/pgc/player/web/v2/playurl` 的请求**带 `ep_id`**。

**⑦ 想自己跑一遍验收（不用手点）**
```bash
# v2 权威构建器（零写入演练；--archive-legacy 才落盘并归档旧成品）
python tools/apply-all-plus-features.py --check

# 原有 38 条语义 / 门锁断言（v2 上必须仍全 PASS = 没回归）
node tools/final-verify-static.mjs output/ACGhelper-2.8.31.16-unlock          # 模块级：mg/BN/回包（含 X4）
node tools/final-verify-gates.js  output/ACGhelper-2.8.31.16-unlock          # 门锁：23+5 条 old 全消失

# v2 新增三项
node tools/verify-pgc-merge.mjs \
  --tree build/legacy-intermediate/ACGhelper-2.8.31.16-unlock \
  --fixed output/ACGhelper-2.8.31.16-unlock                                   # 番剧 0 字节：修前/修后 14 个 case 对照（r4 仍 14/14）
python tools/verify-independent-r4.py --stage all                             # 67 条独立尺子（逐段重放→逐字节 + 簇外拼接恒等 + 61 簇）
node build/webdav-cdp-test.mjs    --tree=output/ACGhelper-2.8.31.16-unlock --direct   # WebDAV 真机：24 条断言（设置页「同步」栏 + PUT/GET sha256 + alarm + 401）
node tools/batch-inpanel-test.mjs --tree=output/ACGhelper-2.8.31.16-unlock    # 选集入口：51 条断言（注入面板底部 / 单集单P 不出现 / 串行队列）
node tools/verify-independent-load-r4.mjs --variant unlock                    # headless 加载：SW target + version_name + 5s 0 异常 + stderr 0 字节
```

还有两条老命令（v2 仍然可用，基准仍是 38 条那套）：
```bash
python tools/final-verify-38-matrix.py --variant both                        # 38 条 × 两棵树 old/new 矩阵
python tools/verify-independent-38.py --stage all                            # 38 条版独立尺子（对 38 条成品树）
```

最后还有一份**人工实机验证清单**（点哪里 → 期望看到什么，含普通视频 4K、杜比音轨、番剧 ep 页、限速场景）：
[`docs/release-checklist.md`](../docs/release-checklist.md)。

---

## 6. 怎么回滚

1. `chrome://extensions` → 找到 `2.8.31.16(Beta) unlock r4` → **停用**（想彻底清掉就「移除」）
2. 如果在用 `-sameId` 版：**先把上面的解锁版停用/移除**，再重新**启用**商店版 ACG助手
   （同 ID 两者不能同时启用）
3. 想彻底复原数据：`-unlock`（无 key）版的 `chrome.storage` 与商店版互不影响，删掉扩展即干净；
   `-sameId` 版复用的是同一个 storage，被改过的设置不会自动回滚，需要时在商店版里手动改回
4. **v2 三块功能的回滚（都只影响功能，不影响加载）**：
   * **WebDAV 自动同步**：`html/webdav.html` → 把「自动同步」关掉（会同时 `chrome.alarms.clear('webdav-autosync')`，
     页面关掉也不再唤醒 SW）；要连远端一起清干净，就删掉远端目录 `_acghelper/settings/`
     （默认在 `kurio.infini-cloud.net` 的 `_acghelper/` 下；探活用的 `_probe/` 每次都会自己删）
   * **选集批量下载**：面板上点「全部取消」即可（`acgxAbortAll` 只停队列，不删已下载文件）；
     如要彻底去掉入口，重建时加 `--skip-feature batch`
   * **番剧下载修复**：重建时加 `--skip-feature pgc-fix` 即回到 38 条行为（0 字节问题会复现，仅用于对照）
5. 原始包与原始解包目录全程未改动：
   * `acg-helper-2.8.31.16.zip`（SHA256 `840455e6…4703`）
   * `src\extracted\`（构建前后目录指纹一致 `00c27453…ac58`，`output\_build-info.json` 里 `unchanged_before_after: true`）
6. 历史成品**没有删**，都在 `build\legacy-intermediate\`：
   * `r3\`：上一版 r3（两棵树 + 两个 zip + `_patch-report.r3.json` / `_build-info.r3.json` / `README.r3.md`）
   * `r2\`：再上一版 r2（同样整份留档）
   * 顶层还有最早那版 38 条成品（目录 + zip 各两份；树指纹 `2bd59f70…e274` / `32f59c24…4e15`）
   要退回任一版，把它拷回 `output\` 重新加载即可。

---

## 7. 这个目录里为什么这么干净

`output\` 只放**真成品 + 说明 + 机器可读报告**。历史中间物（旧的 `patch-2.8.31.16\` 目录、
`acghelper-2.8.31.16-patched.zip`）已整体移到 `build\legacy-intermediate\`，不删除、也不再参与构建，
避免和当前成品混淆（两套目录名字很像，混用会加载到旧产物）。

v2 落盘前，上一版 38 条成品（两棵树 + 两个 zip）也是先整份移进 `build\legacy-intermediate\` 才重建的
（`--archive-legacy`），所以那个目录里现在有两代产物；v1 的树指纹见本文 §6 第 6 条。
