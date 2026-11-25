# ACGhelper Unlock · ACG助手 会员功能解锁（r4）

> 对 Chrome 扩展 **ACGhelper（ACG助手）2.8.31.16(Beta)** 的本地改造：
> 拆掉插件自己的会员锁，让 **4K / 高码率 / 杜比音轨 / 番剧（PGC）下载** 不再被插件拦；
> 另外加了 **WebDAV 云同步** 与 **选集批量下载** 两个自研功能。
>
> 本仓库只放**补丁规格、注入代码、验证与文档**；不包含原扩展的任何二进制分发物。
> 复现方式：拿你自己的 `acg-helper-2.8.31.16.zip`，跑一条命令即可重建。

---

## 1. 它改了什么

### 1.1 会员锁（本地授权层，10 处）

会员判定是**纯客户端**的：角色白名单硬编码在 webpack 模块 **634**
（`["superAdmin","admin","catForever","catVIP"]`），判定函数在模块 **3078**
（`mg`=isVIP、`BN`=isSuperVIP，后者委托前者），服务端 `https://acghelper.com/g` 的 GraphQL
只下发 `identities[name,from,to,hasDateTimeLimit]`，**不下发 isVIP** —— 布尔值是客户端算完写回对象的。

补丁做法：
- `mg()` 在 6 个 bundle（SW / 配置页 / 播放页 / 直播页 / 弹窗 / 消息页）里恒真；
- 在页面拿账号状态的**唯一消息出口** `getStatus` / `getBHAccount` 伪造合法会员对象；
- 共享 UI 锁组件一处短路，解开 21 个 `needVIP` 区块；
- 基类 `onBHAccountChange` 不再把 `isVIP` 打回 false。

### 1.2 下载链路（23 处）

- VIP 画质/音轨集合清空（`127/126/125/120/116/112`、`30250/30251/30255`）；
- 画质/音轨条目的 `disabled`、点击跳付费门全部去掉；
- 番剧 PGC：SW 侧不再 `return null`，改请求 `/pgc/player/web/v2/playurl` 并带 `ep_id`；
- 限速 429 不再 3 次即放弃（改为硬上限 8 次，避免无限挂起）；
- **0 字节修复**：PGC 的 `durl` 形态实际是 MP4 整文件，原先被当 FLV 送进合并器直接抛
  `FLV_IS_MP4`，一次 `write()` 都没发生 → 现在按 MP4 分段直通，并修掉 `!await writer.closed`
  死锁与 Blob/Uint8Array 类型不匹配；
- **只有音轨的静默降级**：视频段为空时不再悄悄产出 `.mp4`，改为回退到最优视频轨 / 明确报错。

### 1.3 自研功能（不在原版里）

| 功能 | 位置 | 说明 |
|---|---|---|
| **选集 / 多 P 批量下载** | 插件自带悬浮面板底部（`#bilibiliHelper2ContentWrapper`） | 勾集、全选、Shift 连选、画质/音轨选择、串行队列、失败可重试。**只在番剧 >1 集或视频 >1 分 P 时出现**，单集/单 P 完全不注入 DOM |
| **WebDAV 云同步** | 设置页左侧导航「同步」栏 | 自定义服务器/账号/密码/远端目录；同步内容按 8 组勾选；定时同步（5/15/60 分钟，只上传/双向/只下载）；`PUT → GET 回读 sha256` 校验；下载前自动本地快照 |

---

## 2. 目录

```
acghelper-unlock/
├── tools/                 补丁规格 + 构建器 + 各角色验证器
│   ├── apply-all-plus-features.py        ★ 权威构建器（pristine → 67 条补丁 + 8 新文件）
│   ├── static-patchspec.py               授权层 10 条
│   ├── proto-patch-spec.json             下载链路 23 条
│   ├── extra-patch-spec.json             验收增补 5 条
│   ├── feature-pgc-fix.json              PGC 0 字节修复 4 条
│   ├── feature-dash-auth-fix.json        音轨-only / 鉴权可观测性 8 条
│   ├── feature-dash-fallback.json        空视频轨回退 5 条
│   ├── feature-webdav.json               WebDAV 同步 9 条（含 6 个新增文件）
│   ├── feature-batch.json                选集批量下载 3 条（含 2 个新增文件）
│   └── verify-*.{py,mjs}                 8 套验收器
├── src/addons/
│   ├── webdav/           同步核心 / 设置页面板 / SW 引导 / 独立页
│   └── batch/            选集面板（内容脚本）/ offscreen 执行端
└── docs/                 全部分析与验收报告（见下）
```

**文档索引**

| 文件 | 内容 |
|---|---|
| `docs/usage.md` | 用户向：怎么加载、解锁清单、验证路径、回滚 |
| `docs/static-vip-gates.md` | 授权层普查（模块 3078/634/4707、bhAccount 生命周期、消费点全清单） |
| `docs/protocol-download-gates.md` | 下载链路还原（调用链、qn 表、门锁位置、服务端依赖判定） |
| `docs/pgc-download-0byte-rootcause.md` | 番剧 0 字节根因（MP4 被当 FLV）与修复 |
| `docs/dash-audio-only-and-pgc-auth.md` | 「4K 下成只有音轨」根因 + Cookie 实测 + 试看语义 |
| `docs/batch-download.md` / `docs/batch-in-plugin-panel.md` | 选集功能：协议、队列语义、并入插件面板与条件显示 |
| `docs/webdav-sync.md` / `docs/webdav-settings-panel.md` | WebDAV：同步协议、服务端行为、设置页集成、分组映射 |
| `docs/patch-manifest.md` | 67 条补丁总表 |
| `docs/verify-independent.md` | 独立对抗性验收（改动面审计 / 回归风险 / 缺口） |
| `docs/release-checklist.md` | 交付前人工实机验证清单 |
| `docs/v2-changelog.md` | 各轮变更与已知限制 |

---

## 3. 构建

需要：Windows + Python 3.12 + Node 24（验证脚本用）+ 你自己的 `acg-helper-2.8.31.16.zip`。

```bash
# 1) 解包原始扩展到你自己的目录（仓库不含它）
unzip acg-helper-2.8.31.16.zip -d src/extracted

# 2) 只校验锚点（零写入）
python tools/apply-all-plus-features.py --check

# 3) 重建（产出两套成品到 output/）
python tools/apply-all-plus-features.py

# 4) 验收
node tools/final-verify-static.mjs output/ACGhelper-2.8.31.16-unlock
node tools/final-verify-gates.js  output/ACGhelper-2.8.31.16-unlock
python tools/verify-independent-r4.py --stage all
```

产物：
- `ACGhelper-2.8.31.16-unlock/` —— 新扩展 ID，可与商店版共存；
- `ACGhelper-2.8.31.16-unlock-sameId/` —— 注入商店版 `key`，**同 ID**，复用原有 `chrome.storage`（加载前须停用商店版）。

加载：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序。卡片版本显示
`2.8.31.16(Beta) unlock r4` 即自证。

---

## 4. WebDAV 默认配置

设置页「同步」栏默认值指向作者自己的 InfiniCloud 账号，**密码已在本仓库脱敏为占位符**
（`REPLACE_WITH_YOUR_WEBDAV_APP_PASSWORD`）。使用时：
- 直接在设置页里填你自己的地址/账号/应用密码即可（推荐）；
- 或在构建前把自己的凭据写进 `src/addons/webdav/js/webdav-core.js` 的 `DEFAULTS`。

服务端行为坑（本仓库 `docs/webdav-sync.md` 有实测）：Apache + mod_dav 下
`PUT` 到不存在的父目录返回 403（必须先逐级 `MKCOL`）、`PUT` 不回 ETag（必须 GET 回读校验）。

---

## 5. 边界（事实）

- 插件侧会员门已全拆；**B 站站方权益**（4K/HDR/杜比是否下发、番剧是否给整集还是试看）不由本项目决定。
- 真 Widevine/CENC 加密流仍是「下得完但不可播」（合并只拼 moov+mdat，不做解密）。
- 课程/芝士页 `/cheese/play/*` 未解锁。
- 番剧无权益时站方回 `is_preview=1`，产物文件名会带 `[试看]` 标记。

---

## 6. 免责

仅供个人学习与研究。改造对象是第三方商业扩展，**请勿分发改造后的成品**；
本仓库只提供补丁规格与自研代码，不包含原扩展任何文件。
