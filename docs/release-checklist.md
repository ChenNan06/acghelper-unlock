# 交付前人工实机验证清单 · v2（ACGhelper 2.8.31.16 · **67 条**成品 · `unlock r4`）

> 用法：按顺序点，**每条只看一个现象**。左边「点哪里」是操作，右边「期望看到什么」是唯一判据。
> 任何一条不符，按最后一列去查对应补丁（编号见 [`docs/patch-manifest.md`](patch-manifest.md)）。
> 原 10 条（授权层 / 下载门锁 / 限速 / 番剧取流）**一条没删**，只在末尾新增 v2 的 3 条（11–13）。
> 全部 **17** 条通过 = 可以交付（r3 追加 14–15，r4 追加 16–17）。构建/自动化验收见 [`docs/build-and-verify.md`](build-and-verify.md)；
> v2 改了什么见 [`docs/v2-changelog.md`](v2-changelog.md)。
>
> 前置：`chrome://extensions` → 开发者模式 → 加载 `output\ACGhelper-2.8.31.16-unlock`（或 `-sameId`，二选一）；
> 卡片版本必须显示 **`2.8.31.16(Beta) unlock r4`**；建议同时开 DevTools（F12）备用。

## A. 原有 10 条（v2 必须仍然全过 = 没有回归）

| # | 点哪里（操作） | 期望看到什么（判据） | 不符时查 |
|---|---|---|---|
| 1 | `chrome://extensions` → 看本扩展卡片 | 版本显示 **`2.8.31.16(Beta) unlock r4`**；无红色「错误」按钮；Service Worker 状态为「有效」 | 构建/加载（`docs/build-and-verify.md` §9.6） |
| 2 | 点工具栏扩展图标 → 看弹窗里的会员标识 | 显示**已开通会员**（`ACG-VIP` / VIP 徽章）；**未登录 B 站也照样显示会员** | S08 / S09 / X4 |
| 3 | 打开设置页（扩展「扩展程序选项」或 `chrome-extension://<id>/html/config.html`）→ 看原先带遮罩的下载配置区块 | 遮罩与「点击开通助手会员」按钮**消失**，控件可直接操作 | S03 |
| 4 | 打开一个**普通视频** `https://www.bilibili.com/video/BV…` → 页面内 ACG 下载入口 → 展开画质列表 | `4K / HDR / 1080P60 / 1080P+` 等条目**没有「会员」角标**、**不是灰色禁用**；点击任一条目**不弹支付页**，直接被选中 | V1 / V3–V6 / V11 / V12 |
| 5 | 同一面板 → 展开**音频/音轨**下拉 | `杜比全景声 / Hi-Res / 杜比音效` 可选、可点；下拉框**整体不是禁用态** | V2 / V3b / V4b / V9 |
| 6 | 同一面板 → 切「高级模式」→ 看主下载按钮与分段选择器 | 主按钮**可点**且不跳支付；分段选择器、音频级联框可操作 | V7 / V8 / V9 / V10 |
| 7 | 同一面板 → 选一个 4K/1080P+ 画质 → 真的点下载 → 等完成 → 用播放器打开产物 | 产物能正常播放（有画面有声音）。**若黑屏/花屏/无声**：说明这条流是真 Widevine 密文（贴片 `pssh`），本补丁不解 DRM，属已知边界 | B4（+ `ffprobe` 抽检） |
| 8 | 打开**番剧 ep 页** `https://www.bilibili.com/bangumi/play/ep<数字>` → 看下载面板 → 再点下载 | ①面板**不再**出现「根据站方要求无法继续提供PGC内容下载」；②DevTools → Network 过滤 `playurl`，应看到对 `/pgc/player/web/v2/playurl` 的请求**带 `ep_id`**；③不再出现 `TypeError: Cannot destructure…` / `NOT_SUPPORT_PGC_CONTENT` | X1 + X5（+ P22/P23） |
| 9 | **限速场景**：连续下载 2~3 个大文件 / 多个分 P，或在下拉限速很低的网络里下 | ①进度条**会等**（退避，最长约 5 分钟一轮），不是立刻报错；②若持续被限，**第 8 次**后必须**明确报错**（`DOWNLOAD_TOO_FREQUENTLY` 之类），**不允许**永远停在 downloading、不报错、只能手动取消 | X2 + X3 |
| 10 | 画质兜底（可选排障）：若第 4 条里画质仍被锁在 480P/720P | 说明裸 `fetch` 没带 Cookie → 用 `python tools/apply-all-plus-features.py --with-optional --archive-legacy` 重建成 54 条再试。**注意**：这一步会让所有 `api.bilibili.com` 请求带 `credentials:"include"`，服务端不回 `Access-Control-Allow-Credentials` 时**全部下载都会失败**；失败就回退到默认 53 条 | B5（`O01`） |

## B. v2 新增 3 条（上半三块新功能的真机判据）

| # | 点哪里（操作） | 期望看到什么（判据） | 不符时查 |
|---|---|---|---|
| 11 | **番剧真下**：`https://www.bilibili.com/bangumi/play/ep<JOJO 石之海第 1 话的 ep 号>` → ACG 下载面板 → 选一个画质 → 点下载 → 等进度到 100% → 去下载目录看文件 | ①产物**字节数 > 0**（v1 在这里是 0 字节）；②双击能**正常播放**（播放器里 `ffprobe` 能读出 `duration`/`streams` 更好）；③若仍失败，UI 上应出现**具体原因**（如 `落盘失败: …`），而不是只有「下载失败 / 处理失败」；④DevTools Console 里**不应**出现 `FLV_IS_MP4` / `INVALID_FLV_HEADER` | F1（根因）+ F2（写入门）+ F3（错误透出）+ F4（picker 异常不吞） |
| 12 | **WebDAV 上传下载回读**：设置页左侧导航点 **「同步」**（r4 起不再有浮动按钮；独立页 `html/webdav.html` 仍在「在独立页面打开（高级）」里）→ 看预填的服务器/账号/远端目录 → 点「测试连接」→ 点「上传」→ 点「比对」→ 点「下载」 | ①「测试连接」显示 **成功**（内部依次 OPTIONS → 逐级 MKCOL → PUT `_acghelper/settings/_probe/probe.json` → GET 回读 sha256 → DELETE 探活目录，**探活目录会自动清理**）；②「上传」返回 **200/201/204**，紧接着的回读 **sha256 与本地一致**；③「比对」显示 `identical: true`（added/removed/changed 全 0）；④「下载」把远端设置回填成功且**自动先导出本地快照**；⑤远端目录里应能看到 `_acghelper/settings/acghelper-settings.json`；⑥若打开自动同步，状态里出现 `lastResult: ok` 且 `chrome.alarms` 里有 `webdav-autosync`（5 分钟） | W0-html / W0-core / W0-page / W0-sw / W0-inject / W1 / W2 / W3（见 patch-manifest §6.2） |
| 13 | **选集批量下场**：打开番剧 `bilibili.com/bangumi/play/ep…`（或任意多 P 视频 `bilibili.com/video/BV…`）→ 展开插件面板 → 面板**底部**「选集下载」区块 → 点「全选」→ 点「开始下载」→ 看面板上的队列状态 | ①面板列出该番剧/视频的**全部分集**（标题形如「P1 …」「第 1 话 …」，条目数 = 实际集数）；②「全选」后选中数 = 条目数；③点开始后**串行**执行：**第 i 集显示完成之后**，第 i+1 集才开始（不会 N 条同时下）；④每条有回执（成功/失败原因），失败不阻塞后续；⑤点「全部取消」能立刻停掉队列；⑥页面原有 DOM 无异常（面板是 `position:fixed` 的独立宿主，不挤动原布局） | FB1（content_scripts）+ FB2（offscreen 脚本顺序）+ FB3（`acgxAutoDownload`/`acgxAbortAll`）+ 新增文件 `acgx-batch.js` / `acgx-batch-offscreen.js` |

> 第 11 条的「JOJO 石之海第 1 话」只是一个**具体样本**：任何走 `durl`-MP4 形态的番剧集都能复现 v1 的 0 字节；
> 用你手边能播的那一集即可，关键是「产物 > 0 且能播」。
> 第 12 条默认凭据是公共测试号（`kurio.infini-cloud.net` / `_acghelper/settings/`），**建议换成自己的 WebDAV**；
> 换服务商时页面会按需申请 `optional_host_permissions`，不换就一直是那一个域名。

---

## D. r4 新增 2 条（两处 UI 改版的真机判据）

| # | 点哪里（操作） | 期望看到什么（判据） | 不符时查 |
|---|---|---|---|
| 16 | **设置页「同步」栏在哪**：`chrome://extensions` → 本扩展「扩展程序选项」打开设置页（或直接 `chrome-extension://<id>/html/config.html`）→ 看**左侧导航**（原生那列：常规 / 下载 / 弹幕 / …）的末尾 | ①导航里多一项 **「同步」**，字号/圆角/选中态与相邻原生项一致（不是外挂的浮层、不盖住别的内容）；②点它 → 右侧内容区换成同步面板：**服务器地址 / 账号 / 密码 / 远端目录** 四个输入框 + 同步内容分组勾选 + 定时同步开关/间隔/方向 + 「立即上传 / 下载 / 比对」+ 状态与历史快照；③页面**右下角没有任何浮动按钮**（v1 的 `☁WebDAV 同步` 已下线）；④点「在独立页面打开（高级）」仍能进 `html/webdav.html` | W1-config-html / W0-panel / W0-inject-legacy（`logs/r4-05-webdav-cdp.log`：UI-1/2/3） |
| 17 | **单集视频不应出现选集入口**：①打开**单集**番剧 `bilibili.com/bangumi/play/ep…`（只有 1 集）→ 展开插件面板；②再打开**单 P** 视频 `bilibili.com/video/BV…`（页面上没有分 P 列表）→ 展开插件面板 | ①面板**底部没有**「选集下载」区块，页面任何位置也没有「选集下载」按钮；②面板子节点数与「没装这一版」时相同（不多一个节点）；③对照：打开**多 P** 视频（3 个分 P）或多集番剧 → 面板底部**才**出现「选集下载」，展开后列出的分 P/集数与页面一致 | FB1（`logs/r4-08-batch-inpanel.log`：B①/C①/E① 与 A②/C②） |

## C. 附加确认（不占清单条目，交付前扫一眼）

1. **two-variant 选择**：`-unlock`（新 ID，可与商店版共存）／`-sameId`（同 ID，必须先停用商店版）。
   加载前确认商店版已停用，否则 Chrome 直接报 `Extension failed to load`。
2. **回滚**：停用/移除本扩展即可；`-sameId` 复用的是商店版同一个 `chrome.storage`，改过的设置不会自动回滚。
   v2 三块功能各自的回滚见 `output/README.md` §6 第 4 条（关自动同步 / 删远端 `_acghelper/settings/` / `--skip-feature`）。
3. **已知边界（不是缺陷）**：
   * 服务端不给的清晰度，扩展请求也拿不到（1080P+/4K/HDR 取决于账号站方权益）；
   * 真 DRM 流「下得完但不可播」（B4 关掉了 `pssh` 中断）；
   * 课程/芝士页 `/cheese/play/*` 未解锁（`hZ()` 未动，属覆盖缺口）；
   * 番剧页「自动连播」设置键会读普通视频页那份（V13 的副作用）；
   * **v2 新增**：`durl`-MP4 形态的修复只对「首段 12 字节内出现 `ftyp`」的形态生效；若某集回包既不是真 FLV、
     也不是带 `ftyp` 的 MP4（例如纯音频或异常形态），仍会抛出原始错误——但**现在错误会带真实原因**（F3）。
   * **v2 新增**：WebDAV 用的是你自己的存储，容量/限速/并发都是服务商说了算；默认公共测试号可能被别人改，
     正式用请改成自己的账号（`html/webdav.html` 里「保存到本机」）。
4. **验证记录怎么留**：第 8 条建议截图 Network 里那一行 `playurl` 请求（含 `ep_id` 查询参数），
   第 9 条建议录一段「报错出现」的屏；第 11 条建议留 `ls -l` 的产物字节数 + 播放器截图；
   第 12 条建议截 webdav.html 上的「sha256 一致」与远端目录列表；第 13 条建议截队列面板的串行状态。
   （自动化证据在 `logs/v2-*.log`：`v2-04-pgc-merge` / `v2-05-webdav-cdp` / `v2-06-batch-cdp` / `v2-07-independent-53`）
