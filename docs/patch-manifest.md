# 补丁总清单（v2：**67 条** + 1 条可选 —— §0–§6 是 r2 的 53 条原文，r4 的分段计数与 v2 规格变化见 §7）

> 生成方式：`output/_patch-report.json`（构建脚本真实应用记录）逐条导出，未手工誊写。
> 目标样本：ACGhelper **2.8.31.16**（Chrome MV3）。原始包 `acg-helper-2.8.31.16.zip`
> SHA256 `840455e6b71e1e33b381ae98b86cc3b5bb57500f8a66469a3f6a98e4b4d94703`。
> 补丁锚定方式：**纯字符串锚定**（每条应用前断言 `count(old) == 1`），`offset` 只作记录、不作定位依据。
>
> **v2 变更（r2 轮原文，保留）**：38 条既有补丁**一条未改**，在其上追加三路 feature 共 **15 条 + 7 个新增文件**，
> 总数 **53**（`version_name` 改为 `2.8.31.16(Beta) unlock r2`）。feature 明细见 §6。
>
> **上一轮变更（38 条收尾）**：独立验收提出的 X1–X5 已落地为默认阶段 `extra`；
> 原可选 `O02`（B6，PGC `ep_id`）被提级成 X5，`proto-patch-optional.json` 里那条仍在（规格不动），
> 但构建器在 `--with-optional` 时**自动跳过它**（锚点已被 extra 阶段消费），所以可选实际只剩 B5。

## 0. 三路来源与分段应用顺序

| 路线 | 来源规格 | 条数 | 说明 |
|---|---|---|---|
| 授权层 | `tools/static-patchspec.py` 的 `PATCHES` | **10** | 本地会员锁（`mg`/`BN`/`getStatus`/`getBHAccount`/共享锁组件/`onBHAccountChange`） |
| 下载链路 | `tools/proto-patch-spec.json` | **23** | 画质/音频集合、条目禁用与点击门、高级模式与简单模式起跑门、PGC 判定与取流、限速与 DRM |
| 增补 | `tools/extra-patch-spec.json` | **5** | X1/X5 两处 PGC `ep_id`、X2/X3 重试上限 8、X4 `getStatus` 出口一致（来源：独立验收 R-1/R-2/R-4） |
| 下载链路·可选 | `tools/proto-patch-optional.json` | 2（默认**不打**；B6 已并入 X5，实际只剩 B5） | `--with-optional` 才打：请求带 Cookie |
| **合计** | | **38（默认）/ 39（含 B5）** | |

**应用顺序规则**（写进 `_patch-report.json.order_rule`）：

```
第 1 段 pristine   : static(10) → proto(23)      # 锚点在原始文件上
第 2 段 post-proto : extra(5)                    # 锚点在第 1 段输出上，偏移须等于规格记录的
第 3 段 post-extra : optional(B5)                # 锚点在第 2 段输出上；B6 自动跳过
段内同一文件：按“进入本段时偏移降序” → “旧串长度降序”
```

为什么这么排：

1. **两路补丁没有共享锚点**——`initBackground.sw.js` 里静态路线打在 `82911~141845`，协议路线打在 `540438/540621`；
   `js/pages/video.js` 里静态路线只有 1 处（`98008`），协议路线 16 处分布在 `35360~335546`。
   全量预检已确认同文件内**原始区间零重叠**（`apply-all-patches.py` 的「重叠检查」）。
2. **偏移降序是防御性写法**：即使将来某条补丁的 `new` 里包含了另一条的 `old`，先改靠后的位置也不会让靠前锚点漂移。
   本项目里唯一“new 含 old”的是 6 条 `mg()` 恒真补丁（`S01/S02/S04/S05/S06/S07`），它们各自独立、互不重叠。
3. **extra 必须单独成段**（不能塞进第 1 段）：X2/X3 的 `old` 里带 `,!1)throw c.DOWNLOAD_TOO_FREQUENTLY`
   ——这段文本是 B2/B3 **刚写进去**的，原始树里 `count == 0`；X4 的 `old`（`bhAccount:this.bhAccount||{bhid:0,`）
   嵌在 S08 的 `new` 里，同理。所以它的预检必须放在「第 1 段输出的快照」上做，
   并且额外校验「找到的偏移 == `extra-patch-spec.json` 记录的成品树偏移」（对不上直接失败）。
4. 每条补丁应用前都重新计算 `count(old)`，任一时刻 `!= 1` 立即中止且**不落盘**（全部在内存里算完才写文件）。

## 1. 33 条主补丁（按实际应用顺序）

| # | 路线 | id | 文件 | 旧串节选 | 新串节选 | 效果 |
|---|---|---|---|---|---|---|
| 1 | 授权层 | `S10` | `initBackground.sw.js` | `this.bhAccount?this.isVIP=(0,s.mg)(this.bhAccount):this.isVIP=!1` | `this.isVIP=!0` | 基类 onBHAccountChange：bhAccount 为空时不再把 isVIP 置 false |
| 2 | 授权层 | `S01` | `initBackground.sw.js` | `if(!e\|\|!e.identities\|\|0===e.identities.length)return!1;` | `if(1)return!0;if(!e\|\|!e.identities\|\|0===e.identities.length)…` | 模块3078 mg() 恒真：所有 (0,X.mg)(bhAccount) 运行时判定→true |
| 3 | 授权层 | `S09` | `initBackground.sw.js` | `n(await this.getStore("default"))` | `n({...(await this.getStore("default")\|\|{bhid:0,bhName:"ACG-VIP…` | getBHAccount 回包：恒返回 isVIP/isSuperVIP=true 且带合法 identities[] |
| 4 | 授权层 | `S08` | `initBackground.sw.js` | `return n({hasLogin:this.hasLogin,bilibiliAccount:this.bilibiliAc…` | `return n({hasLogin:!0,bilibiliAccount:this.bilibiliAccount?this.…` | getStatus 回包：hasLogin 恒真 + bhAccount 为 null 时给出合成会员对象 |
| 5 | 授权层 | `S03` | `js/pages/config.js` | `if(x&&"boolean"===typeof O&&!O)return` | `if(!1)return` | 配置页共享锁组件：needVIP 区块不再渲染会员遮罩（登录检查保留） |
| 6 | 授权层 | `S02` | `js/pages/config.js` | `if(!e\|\|!e.identities\|\|0===e.identities.length)return!1;` | `if(1)return!0;if(!e\|\|!e.identities\|\|0===e.identities.length)…` | 模块3078 mg() 恒真（配置页） |
| 7 | 授权层 | `S05` | `js/pages/live.js` | `if(!e\|\|!e.identities\|\|0===e.identities.length)return!1;` | `if(1)return!0;if(!e\|\|!e.identities\|\|0===e.identities.length)…` | 模块3078 mg() 恒真（直播页） |
| 8 | 授权层 | `S07` | `js/pages/message.js` | `if(!e\|\|!e.identities\|\|0===e.identities.length)return!1;` | `if(1)return!0;if(!e\|\|!e.identities\|\|0===e.identities.length)…` | 模块3078 mg() 恒真（消息中心） |
| 9 | 授权层 | `S06` | `js/pages/popup.js` | `if(!e\|\|!e.identities\|\|0===e.identities.length)return!1;` | `if(1)return!0;if(!e\|\|!e.identities\|\|0===e.identities.length)…` | 模块3078 mg() 恒真（弹窗页） |
| 10 | 授权层 | `S04` | `js/pages/video.js` | `if(!e\|\|!e.identities\|\|0===e.identities.length)return!1;` | `if(1)return!0;if(!e\|\|!e.identities\|\|0===e.identities.length)…` | 模块3078 mg() 恒真（播放页注入脚本） |
| 11 | 下载链路 | `P23` | `initBackground.sw.js` | `.then((t=>e?t?.data?.video_info:t?.data))` | `.then((t=>e?(t?.result\|\|t?.data)?.video_info:t?.data))` | S2 SW videoParse：PGC 回包结构取 result.video_info（v2 API） |
| 12 | 下载链路 | `P22` | `initBackground.sw.js` | `if(e)return null;{const e=yt.UGC;` | `{const e=yt[this.isPGC?"PGC":"UGC"];` | S1 SW videoParse：PGC 不再直接 return null，改请求 /pgc/player/web/v2/playurl |
| 13 | 下载链路 | `P18` | `js/pages/background.js` | `});Object.assign(this,e),this.downloadOptionData=H(this.basicDow…` | `});Object.assign(this,e),this.basicDownloadInfo\|\|(this.basicDo…` | B1b 同一问题的刷新路径（refreshBasicDownloadInfo） |
| 14 | 下载链路 | `P17` | `js/pages/background.js` | `return Object.assign(this,e),this.downloadOptionData=H(this.basi…` | `return Object.assign(this,e),this.basicDownloadInfo\|\|(this.bas…` | B1 offscreen 下载器 init：SW 对 PGC 返回 null 时用本文件 PGC-aware 的 fetchBasicDownloadInfo 自取 playurl |
| 15 | 下载链路 | `P20` | `js/pages/background.js` | `…onRateLimited(e.status,e.retryAfterSeconds),this.rateLimitedRetryTimes>Le)throw…` | `…onRateLimited(e.status,e.retryAfterSeconds),!1)throw…` | B3 FLV 分段 fetcher(De)：429/412 超限不再抛（Le=3） |
| 16 | 下载链路 | `P19` | `js/pages/background.js` | `…onRateLimited(e.status,e.retryAfterSeconds),this.rateLimitedRetryTimes>me)throw…` | `…onRateLimited(e.status,e.retryAfterSeconds),!1)throw…` | B2 DASH 分段 fetcher(pe)：429/412 超限不再抛（退避仍生效，me=3） |
| 17 | 下载链路 | `P21` | `js/pages/background.js` | `if(r?.boxs.find((e=>"pssh"===e.type)))throw c.PROTECTED_BY_DRM;` | `if(!1&&r?.boxs.find((e=>"pssh"===e.type)))throw c.PROTECTED_BY_D…` | B4 pssh 检测不再中断（对带 pssh 但实为明文的流有效；真 Widevine 是密文，需 CDM 密钥） |
| 18 | 下载链路 | `P16` | `js/pages/video.js` | `i=()=>!!location.pathname.match("/bangumi/play")` | `i=()=>!1` | V13 PGC 判定器 dZ() 恒 false：番剧页不再进『根据站方要求无法继续提供PGC内容下载』渲染分支 |
| 19 | 下载链路 | `P11` | `js/pages/video.js` | `disabled:W\|\|U\|\|!M&&!L&&(V\|\|Y)\|\|$\|\|p\|\|Boolean(y),onCl…` | `disabled:W\|\|U\|\|$\|\|p\|\|Boolean(y),onClick:Q` | V8 高级模式下载按钮 disabled 去掉 !isBHVIP&&!isFLV&&(videoOnly\|\|audioOnly) |
| 20 | 下载链路 | `P12` | `js/pages/video.js` | `disabled:p\|\|_\|\|!M,status:U?"warning":""` | `disabled:p\|\|_,status:U?"warning":""` | V9 高级模式音频级联框：非 isBHVIP 不再整体禁用（原 disabled 含 !M） |
| 21 | 下载链路 | `P10` | `js/pages/video.js` | `if(!M&&(V\|\|Y&&G.length>0)\|\|t&&!M&&e.length>0)return j();` | `if(!1)return j();` | V7 高级模式下载主按钮起跑门（M=isBHVIP）：不再跳 handleOnClickGotoPayment |
| 22 | 下载链路 | `P13` | `js/pages/video.js` | `if(V\|\|Y\|\|!z&&!N&&($\|\|Q&&j.length>0)\|\|t&&!z&&e.length>0\|…` | `if(V\|\|Y\|\|X&&!N\|\|p)return!1;` | V10 简单模式画质按钮点击门（z=isBHVIP）：去掉仅画面/仅音频/切片下载的会员限制 |
| 23 | 下载链路 | `P15` | `js/pages/video.js` | `else if(_.includes(n))return o.QB.info(` | `else if(!1)return o.QB.info(` | V12 非 b 站大会员不再被『请先开通b站大会员』拦（与 V1 双保险） |
| 24 | 下载链路 | `P14` | `js/pages/video.js` | `if(!z&&_.includes(n))return W()` | `if(!1)return W()` | V11 简单模式点 VIP 画质不再跳付费（z=isBHVIP） |
| 25 | 下载链路 | `P09` | `js/pages/video.js` | `className:A()({"need-blvip":i,"need-bhvip":i}),disabled:!t&&i,` | `className:A()({}),disabled:!1,` | V6 音轨条目禁用条件去掉 !isBLVIP&&needVIP 项 |
| 26 | 下载链路 | `P08` | `js/pages/video.js` | `onClick:d?({isBLVIP:e,isBHVIP:t})=>(e&&!t&&B(),t):()=>!0` | `onClick:()=>!0` | V5b 视频画质条目点击恒允许（V1 已让 d 恒 false，此条双保险） |
| 27 | 下载链路 | `P07` | `js/pages/video.js` | `disabled:p\|\|!t&&d,needBLVIP:d,` | `disabled:p,needBLVIP:d,` | V5 视频画质条目禁用条件去掉 !isBLVIP&&needVIP 项（与 V1 双保险） |
| 28 | 下载链路 | `P06` | `js/pages/video.js` | `onClick:({isBLVIP:e,isBHVIP:t})=>(e&&!t&&B(),t)}),(c\|\|l)&&m.pu…` | `onClick:()=>!0}),(c\|\|l)&&m.push` | V4b dolby 条目点击闭包去掉(!isBHVIP→跳付费)判定 |
| 29 | 下载链路 | `P05` | `js/pages/video.js` | `children:d.audio?G(d.audio):[],className:"need-blvip need-bhvip"…` | `children:d.audio?G(d.audio):[],className:"",disabled:!1,` | V4 dolby(30250 杜比全景声) 条目解锁 |
| 30 | 下载链路 | `P04` | `js/pages/video.js` | `onClick:({isBLVIP:e,isBHVIP:t})=>(e&&!t&&B(),t)}),!l&&d?.type` | `onClick:()=>!0}),!l&&d?.type` | V3b flac(Hi-Res) 条目点击闭包去掉(!isBHVIP→跳付费)判定，恒允许选中 |
| 31 | 下载链路 | `P03` | `js/pages/video.js` | `children:p.audio?G([p.audio]):[],className:"need-blvip need-bhvi…` | `children:p.audio?G([p.audio]):[],className:"",disabled:!1,` | V3 flac(30251 Hi-Res) 条目解锁：disabled:!t → disabled:!1（t=isBLVIP） |
| 32 | 下载链路 | `P02` | `js/pages/video.js` | `S=[k.QN_30250,k.QN_30251,k.QN_30255]` | `S=[]` | V2 音频 VIP 集合清空：杜比全景声/Hi-Res/杜比音效不再需要会员 |
| 33 | 下载链路 | `P01` | `js/pages/video.js` | `_=[y.QN_127,y.QN_126,y.QN_125,y.QN_120,y.QN_116,y.QN_112]` | `_=[]` | V1 视频 VIP 画质集合清空：127/126/125/120/116/112 不再 need-blvip/need-bhvip，不再被禁用、点击不再跳付费 |

## 2. 5 条增补补丁（extra 阶段，默认**已打**）

来源：独立验收报告 [`verify-independent.md`](verify-independent.md) 的「必须修」R-1 / R-2 与隐患 R-4。
规格文件 `tools/extra-patch-spec.json`；`offset` 按**已打 33 条补丁的成品树**字符偏移记录，
构建器第 2 段会逐条断言 `count(old)==1` **且** `找到的偏移 == 记录的 offset`。

| # | 路线 | id | 文件 | 旧串节选 | 新串节选 | 效果 | 来源 |
|---|---|---|---|---|---|---|---|
| 34 | 下载链路/PGC | `X1` | `initBackground.sw.js` | `{bvid:t,cid:n,qn:i\|\|Wt,fnver:0,fnval:4048,fourk:1,tabId:this.tabId}` | 同串 + `,ep_id:this.epid}` | SW 侧 `Yt()` 的 PGC `playurl` 请求带 `ep_id`：番剧在 PGC 侧没有 `bvid`，缺 `ep_id` 会拿到空 `video_info`（S1/S2 白开） | R-1 |
| 35 | 授权层（防御性） | `X4` | `initBackground.sw.js` | `bhAccount:this.bhAccount\|\|{bhid:0,` | `bhAccount:this.bhAccount?Object.assign({},this.bhAccount,{isVIP:!0,isSuperVIP:!0}):{bhid:0,` | `getStatus` 在 `bhAccount` 为真实账号时也强制会员位（原字段透传），与 `getBHAccount` 两条出口口径一致 | R-4 |
| 36 | 下载链路 | `X3` | `js/pages/background.js` | `,!1)throw c.DOWNLOAD_TOO_FREQUENTLY;…errorRequestSegmentIndex.add(this.fetchPosition),this.fetch()` | `,this.rateLimitedRetryTimes>=8)throw c.DOWNLOAD_TOO_FREQUENTLY;…` | FLV 分段 fetcher（`De`，原 `Le=3`）：恢复重试硬上限 8，避免 429 无限重试 | R-2 |
| 37 | 下载链路 | `X2` | `js/pages/background.js` | `,!1)throw c.DOWNLOAD_TOO_FREQUENTLY;…errorRequestSegmentIndex[this.type].add(this.fetchPosition),this.fetch()` | `,this.rateLimitedRetryTimes>=8)throw c.DOWNLOAD_TOO_FREQUENTLY;…` | DASH 分段 fetcher（`pe`，原 `me=3`）：同上 | R-2 |
| 38 | 下载链路/PGC | `X5` | `js/pages/background.js` | `o=D("https://api.bilibili.com"+a,{bvid:t,cid:i,qn:n,fnver:0,fnval:4048,fourk:1,tabId:this.tabId})` | 同串 + `,ep_id:this.epid}` | offscreen 侧 `B()` 的 PGC `playurl` 也带 `ep_id`（X1 只覆盖了 SW 侧；本条 = 原可选 B6 提级）。**与 B5 解绑**，不再需要打开有风险的 `credentials:"include"` | R-1 |

> X2/X3 与 B2/B3 是**串联**关系：B2/B3 先把 `this.rateLimitedRetryTimes>me` 换成 `!1`（删掉上限），
> X2/X3 再把这段 `!1` 换成 `>=8`（上限 8 次）。所以 `final-verify-gates.js` 里 B2/B3 的
> 「new 出现」是按**重叠拼接终态**判定的（日志里标 `（串联终态：X2 改写其后）`）。

## 3. 1 条可选补丁（默认不打，`--with-optional` 才生效）

| # | 路线 | id | 文件 | 旧串节选 | 新串节选 | 效果 |
|---|---|---|---|---|---|---|
| O1 | 下载链路·可选 | `O01` | `js/pages/background.js` | `s=await fetch(e,t).catch((e=>{throw e}))` | `s=await fetch(e,Object.assign({credentials:"include"},t)).catch(…` | B5：offscreen 所有 `api.bilibili.com` 请求带 Cookie —— 打完 38 条后画质仍锁 480P/720P 时才需要 |
| ~~O2~~ | 下载链路·可选 | ~~`O02`~~ | `js/pages/background.js` | — | — | **已提级为 extra 的 X5**（默认打）。规格仍留在 `proto-patch-optional.json` 里，但 `--with-optional` 时构建器检测到锚点已被 X5 消费 → 自动跳过并写进 `_patch-report.json.counts.optional_skipped` |

B5 的风险（为什么默认必须关）：`credentials:"include"` 是**跨域带凭证**，服务端必须回
`Access-Control-Allow-Credentials: true` 才允许读到响应；不满足时浏览器直接判请求失败
→ 后果不是「变慢」，而是**全部下载请求失败**。所以它只能是「画质被锁时的手动排障开关」。

`O01` 的锚点在原始树里 `count == 1`（构建日志「可选补丁锚点」段每次都会复核），
成品树里已确认**未打**（`final-verify-gates.js` 的 `[B5]` 段两条 PASS + 全文件 `credentials:"include"` 计数 0）。

## 4. 逐条落点（文件 / 长度变化）

磁盘字节数（`os.path.getsize`）对比；构建日志里打印的是**文本字符数**，含中文的
`video.js / live.js / popup.js` 三处字符数会小于字节数（UTF-8 多字节），属正常：

```
initBackground.sw.js          839049 ->  839458  (+409 bytes)   8 条（S01/S08/S09/S10 + P22/P23 + X1/X4）
js/pages/background.js        112049 ->  112297  (+248 bytes)   8 条（P17~P21 + X2/X3/X5）
js/pages/config.js            342800 ->  342789  (  -11 bytes)   2 条（S02/S03）
js/pages/live.js              104296 ->  104310  (  +14 bytes)   1 条（S05）
js/pages/message.js            40233 ->   40247  (  +14 bytes)   1 条（S07）
js/pages/popup.js              98656 ->   98670  (  +14 bytes)   1 条（S06）
js/pages/video.js             528087 ->  527655  ( -432 bytes)  17 条（S04 + P01~P16）
manifest.json                   7856 ->    7864  (   +8 bytes)   version_name 改写（同 ID 版 8095，含 key）
```

差异簇数从 **33 → 35**：X1 与 X5 各自新增一个独立差异簇；X2/X3 与 B2/B3 的簇重叠、X4 嵌在 S08 簇内，
都不产生新簇（`tools/verify-independent-38.py` 的 `audit38` 段逐簇验证并打印落点分类）。

`manifest.json` 的改动（两份成品唯一差异来源）：

| 字段 | 原值 | 成品值 |
|---|---|---|
| `version` | `2.8.31.16` | `2.8.31.16`（**不动**，Chrome 只接受数字段） |
| `version_name` | `2.8.31.16(Beta)` | `2.8.31.16(Beta) unlock` |
| `key` | 无 | 仅 `-sameId` 版注入：216 字符，`SHA256(DER)[:16]→a-p` = `kpbnombpnpcffllnianjibmpadjolanh` |

## 5. 规格文件归属与本次动作

| 文件 | 归属 | 本次动作 |
|---|---|---|
| `tools/static-patchspec.py` | 静态/授权路线 | 只 `import` 取 `PATCHES`，不改 |
| `tools/proto-patch-spec.json` | 协议/下载路线 | 只读 JSON，不改 |
| `tools/proto-patch-optional.json` | 协议/下载路线 | 只读 JSON，不改（默认不打；B6 被 X5 替代） |
| `tools/extra-patch-spec.json` | 增补路线 | **改**：补 X5 条目（从 B6 抄）+ `_meta` 更新为「已落地」 |
| `tools/apply-all-patches.py` | 唯一权威构建脚本 | **改**：新增 `extra` 阶段（分段预检 + 偏移断言 + optional 自动跳过） |
| `tools/verify-independent.py` | 独立验收尺子（外部） | **一个字都没改**（sha256 `2bf9163f938ab3ee…`）；38 条版派生尺子另存 `tools/verify-independent-38.py` |
| `src/extracted/**` | 只读样本 | 全程未写（构建前后目录指纹一致 `00c27453…ac58`） |
| `build/legacy-intermediate/patch-2.8.31.16/` + `acghelper-2.8.31.16-patched.zip` | 早期协议角色中间产物 | **从 `output/` 移入 `build/legacy-intermediate/`**（不删除，但不再出现在交付目录里） |

---

## 6. v2 feature 补丁（15 条 + 7 个新增文件 · 阶段 `feature`）

构建器：`tools/apply-all-plus-features.py`（既有的 `apply-all-patches.py` 只被 `import` 取补丁定义，文件本身未改）。
分段：`feature:pgc-fix` → `feature:webdav` → `feature:batch`，每段的锚点都在**上一段输出的快照**上校验
`count(old) == 1`；段内同文件按「进入本段时偏移降序、旧串长度降序」应用。

### 6.1 四段计数（`output/_patch-report.json → counts`）

| 段 | 条数 | 说明 |
|---|---|---|
| `static` | **10** | 本地授权层（`tools/static-patchspec.py`） |
| `proto` | **23** | 下载链路门锁（`tools/proto-patch-spec.json`） |
| `extra` | **5** | X1–X5 增补（`tools/extra-patch-spec.json`） |
| `feature` | **15** | F1–F4（4）+ webdav W*（8，含 5 个新增文件条目）+ FB1–FB3（3） |
| **合计** | **53** | 另有 7 个**新增文件**（不计入 53 条，见 §6.3） |
| `optional`（默认不打） | 0 / 2 可用 | `--with-optional` 时 54 条（只补 B5） |

### 6.2 逐条明细（偏移 = 在**该 feature 段输入**里的偏移；old→new 为字节长度）

| id | feature | 文件 | 段输入偏移 | old→new | 作用 |
|---|---|---|---|---|---|
| `F1` | pgc-fix | `js/pages/background.js` | 50197 | 55 → 370 | **根因修复**：`mergeArrayBuffers` 失败时若首段 12B 内出现 `ftyp`（MP4 形态），改为各分段原样顺序拼 `Blob`；非 MP4 形态照旧抛错 |
| `F2` | pgc-fix | `js/pages/background.js` | 50252 | 105 → 186 | 去死锁 `!await r.closed`（writer 通道永不写）+ `Blob → Uint8Array`（streamsaver 只收 Uint8Array）；FSA 通道仍收 Blob |
| `F3` | pgc-fix | `js/pages/background.js` | 61566 | 84 → 164 | `runWriteFile` 统一归一化错误：字符串抛出包装成 `DownloaderError(ERROR_REQUEST_DATA, "落盘失败: …")`，真实原因透出到 UI |
| `F4` | pgc-fix | `js/pages/background.js` | 62803 | 131 → 163 | FLV 分支 `showSaveFilePicker().catch(e=>{})` 不再吞异常：非 `AbortError` 一律 rethrow（与 DASH 分支口径一致，不再把 SecurityError 改写成「下载已取消」） |
| `W0-html` | webdav | `html/webdav.html`（新增） | — | 0 → 8649 | WebDAV 同步主页面（配置/测试/上传/下载/比对/自动同步/状态/日志） |
| `W0-core` | webdav | `src/addons/webdav/js/webdav-core.js`（新增） | — | 0 → 38291 | 共享核心库：官方逐控制器协议采集 + 原始 storage 快照降级 + WebDAV 客户端（逐级 MKCOL、GET 回读 sha256）+ 历史快照与冲突判定 |
| `W0-page` | webdav | `src/addons/webdav/js/webdav.js`（新增） | — | 0 → 13649 | 页面逻辑：表单 ↔ `chrome.storage.local`、按钮动作、host 权限申请、状态渲染 |
| `W0-sw` | webdav | `src/addons/webdav/js/webdav-sw.js`（新增） | — | 0 → 2145 | SW 侧引导：注册 `chrome.alarms.onAlarm`，页面关掉也能按周期自动同步；异常全吞，不影响原 SW |
| `W0-inject` | webdav | `src/addons/webdav/inject.js`（新增） | — | 0 → 4003 | 配置页浮动入口（右下角按钮 + `Alt+Shift+W`），独立 fixed 容器 + MutationObserver，不碰 React bundle |
| `W1-config-html` | webdav | `html/config.html` | 522 | 7 → 140 | 只在 `</body>` 前加一个 `<script>` 引 `inject.js`（配置页 4 个 bundle 的加载顺序完全不动） |
| `W2-manifest-hostperm` | webdav | `manifest.json` | 7720 | 38 → 138 | `host_permissions` 追加 `https://*.infini-cloud.net/*`（MV3 扩展页跨域靠 host 权限，不是 CORS）+ 新增 `optional_host_permissions: ["*://*/*"]` |
| `W3-sw-bootstrap` | webdav | `initBackground.sw.js` | 839404 | 54 → 266 | 尾部追加 `importScripts("…webdav-core.js","…webdav-sw.js")`，整段 `try/catch`（同步功能出问题不许把 SW 带崩） |
| `FB1` | batch | `manifest.json` | 5520 | 78 → 483 | 新增一条 `content_scripts`：`bilibili.com` 的 `bangumi/play`、`video`、`list`、`medialist/play`（`document_end`、仅顶层 frame）注入 `js/pages/acgx-batch.js` |
| `FB2` | batch | `html/background.html` | 185 | 72 → 155 | offscreen 文档里让 `acgx-batch-offscreen.js` **先于** `background.js` 加载 |
| `FB3` | batch | `js/pages/background.js` | 72071 | 76 → 284 | 在 `St` 命令分发链末尾加 `acgxAutoDownload` / `acgxAbortAll` 两个分支，只把 `class bt` 交给 `self.__acgxBatchAuto`（不复制下载逻辑，避免与 F1–F4 抢同一段代码） |

> `W1-config-html` / `W3-sw-bootstrap` / `FB2` 属**自包含型**（new 里含 old）：应用后 old 仍出现一次，这是设计如此，
> 不是漏打。`--check` 与 `verify-independent-53.py` 都会把这三条单独标出来。

### 6.3 新增文件清单（7 个，全部按二进制拷贝，SHA256 记录在 `_patch-report.json → added_files`）

| # | 文件（成品内路径） | 来源（`src/addons/**`） | 字节 | 归属 |
|---|---|---|---|---|
| 1 | `html/webdav.html` | `src/addons/webdav/html/webdav.html` | 8,649 | webdav（计入 8 条） |
| 2 | `src/addons/webdav/js/webdav-core.js` | 同名 | 38,291 | webdav（计入 8 条） |
| 3 | `src/addons/webdav/js/webdav.js` | 同名 | 13,649 | webdav（计入 8 条） |
| 4 | `src/addons/webdav/js/webdav-sw.js` | 同名 | 2,145 | webdav（计入 8 条） |
| 5 | `src/addons/webdav/inject.js` | 同名 | 4,003 | webdav（计入 8 条） |
| 6 | `js/pages/acgx-batch.js` | `src/addons/batch/js/pages/acgx-batch.js` | 34,772 | batch（`additions[]`，不计入 3 条） |
| 7 | `js/pages/acgx-batch-offscreen.js` | `src/addons/batch/js/pages/acgx-batch-offscreen.js` | 14,571 | batch（`additions[]`，不计入 3 条） |

### 6.4 改动面与差异簇（`tools/verify-independent-53.py` 实测）

* 与 pristine 逐字节相同：**75** 个文件；有差异：**10** 个；新增：**7** 个（合计 92）。
* 有差异的 10 个 = 38 条既有补丁原本就触及的 7 个（`initBackground.sw.js`、`js/pages/{background,config,live,message,popup,video}.js`）
  + feature 新触及的 3 个（`html/config.html`、`html/background.html`、`manifest.json`）→ 合计 10；
  其余 75 个（含 `js/vendors.bundle.js`、`js/components.bundle.js`、`downloader.sw.js`、`notification.sw.js`、
  `html/downloader.html`、`_locales/**`）逐字节未动。
* 差异簇：38 条既有补丁落成 **35** 簇（与 `verify-independent-38.py` 的结论一致）→ 叠加 feature 后字节补丁共 **42** 簇
  （F1/F2 相邻合并成 1 簇，F3/F4/FB3/W3/W1/FB2 各 1 簇，W2/FB1 在 manifest 里不计簇）+ **7** 个新增文件 = **49** 簇。
* 声明条数与簇数的分账：53 条里有 **5 条是 webdav 新增文件条目**，所以「53 + 7」会重复记账这 5 个，
  真实口径是 **48 个字节级补丁 + 7 个新增文件**。

### 6.5 manifest 终态

| 字段 | v1（38 条） | v2（53 条） |
|---|---|---|
| `version` | `2.8.31.16` | `2.8.31.16`（不动） |
| `version_name` | `2.8.31.16(Beta) unlock` | **`2.8.31.16(Beta) unlock r2`** |
| `host_permissions` | 8 条（末项 `*://*.akamaized.net/*`） | 9 条（追加 `https://*.infini-cloud.net/*`） |
| `optional_host_permissions` | 无 | `["*://*/*"]` |
| `content_scripts` | 10 条 | 11 条（新增 batch 面板） |
| `key` | 仅 `-sameId` | 仅 `-sameId`（仍是 216 字符，扩展 ID 不变 `kpbnombpnpcffllnianjibmpadjolanh`） |

---

## 7. r4：分段计数与 v2 规格变化（**以本节为准**）

### 7.1 分段计数（`output/_patch-report.json → totals`，全部由规格算出）

| 段 | 规格来源 | 声明条数 | 其中字节补丁 | 其中新增文件条目 | 实落 |
|---|---|---:|---:|---:|---:|
| `static` | `static-patchspec.py`（`PATCHES`） | 10 | 10 | 0 | 10 |
| `proto` | `proto-patch-spec.json` | 23 | 23 | 0 | 23 |
| `extra` | `extra-patch-spec.json`（X1..X5） | 5 | 5 | 0 | 5 |
| `optional` | `proto-patch-optional.json` | 2（默认不打） | — | — | 0（B5 未打；B6 已被 X5 消费） |
| `feature:pgc-fix` | `feature-pgc-fix.json` | 4 | 4 | 0 | 4（`F1`–`F4`） |
| `feature:dash-auth-fix` | `feature-dash-auth-fix.json` | 8 | 8 | 0 | 8（`F1`–`F8`） |
| `feature:dash-fallback` | `feature-dash-fallback.json` | 5 | 5 | 0 | 5（`DF1`–`DF5`） |
| `feature:webdav` | **`feature-webdav.json` v2** | **9** | 3 | **6** | 9（`W1/W2/W3` + `W0-html/core/panel/page/sw/inject-legacy`） |
| `feature:batch` | **`feature-batch.json` v2** | **3** | 3 | 2（`additions[]`，不计入 3） | 3（`FB1`–`FB3`） |
| **合计** | — | **67** | **61** | **6 + 2 = 8** | **67** |

`totals.formula` 原文：`38 + pgc-fix=4 + dash-auth-fix=8 + dash-fallback=5 + webdav=9 + batch=3 = 67`；
`totals.bridge_steps = 3`（WebDAV v1 前置态重建，**不计入补丁条数**）。
真机/静态证据：`logs/r4-00-build.log`（构建计数）、`logs/r4-06-independent.log`（独立重放 236 项 0 失败）。

### 7.2 `feature-webdav.json` v1 → v2 的变化

| 维度 | v1（r2/r3 用的，8 条） | **v2（r4，9 条）** |
|---|---|---|
| 入口形态 | `config.html` 的 `</body>` 前挂 `inject.js` → 右下角浮动按钮（+`Alt+Shift+W`） | 官方设置页左侧导航项「同步」+ `main` 内内容区（**无浮动按钮**） |
| 新增文件 | 5 个 | **6 个**（多 `src/addons/webdav/js/webdav-settings-panel.js`，57,995 B） |
| `W0-inject` | 加载的入口脚本 | **`W0-inject-legacy`**：仍拷进树，`config.html` 不再引用 |
| `W1-config-html` | `old` = `</body>`（插 1 行） | `old` = **v1 的两行 + `</body>`**，`new` = `core` + `settings-panel` 两个 script |
| `W2-manifest-hostperm` | 插入 host 权限 | **`old == new`**：幂等状态断言 |
| `W3-sw-bootstrap` | 追加 importScripts | **`old == new`**：幂等状态断言（防重复注册 alarm） |
| 共享核心 | `webdav-core.js` 38,291 B | **46,574 B**（新增同步范围分组 `SCOPE_KEY/GROUPS/currentAllow`） |
| 构建器适配 | 无 | **v1 前置态重建**：`WBR1` `html/config.html`（7→140 B）/ `WBR2` `manifest.json`（38→138 B）/ `WBR3` `initBackground.sw.js`（54→266 B），old 全部由 v2 锚点反向推导 |

### 7.3 `feature-batch.json` v1 → v2 的变化

| 维度 | v1 | **v2（r4）** |
|---|---|---|
| 入口形态 | 页面右下角自建浮动按钮（自带 shadow DOM 面板） | 注入插件自己的悬浮面板 `#bilibiliHelper2ContentWrapper`，**插在 `<footer>` 之前** |
| 注入条件 | 只要识别到剧集/分 P 就画按钮 | **仅在番剧 > 1 集或多 P > 1 分 P 时注入**；单集/单 P **一个节点都不建** |
| 样式来源 | 自带 CSS | 运行期 `getComputedStyle` 读原生 `div.button.primary` → `--acgx-*` 变量（9/9 项一致） |
| 3 条补丁锚点 | `FB1`/`FB2`/`FB3` | **逐字节相同**（只碰 `manifest.json` / `html/background.html` / `js/pages/background.js` 分发器） |
| 新增文件 | `acgx-batch.js` 34,772 B + `acgx-batch-offscreen.js` 14,571 B | **`acgx-batch.js` 49,447 B**（重写：删 FAB、面板注入）+ offscreen 端未改 14,571 B |

### 7.4 8 个新增文件（`_patch-report.json → added_files`，二进制拷贝 + SHA256）

| # | 目标路径 | 来源 | 字节 | sha256（前 16） | 计入条目 |
|---|---|---|---:|---|---|
| 1 | `html/webdav.html` | `src/addons/webdav/html/webdav.html` | 8,649 | `c62e6857575a2e6b` | webdav（计入 9） |
| 2 | `src/addons/webdav/js/webdav-core.js` | 同名 | 46,574 | `e97e24b25338ebf4` | webdav（计入 9） |
| 3 | `src/addons/webdav/js/webdav-settings-panel.js` | 同名（**v2 新增**） | 57,995 | `c2361502cd33f4d9` | webdav（计入 9） |
| 4 | `src/addons/webdav/js/webdav.js` | 同名 | 13,649 | `ed760ddeeac5c34e` | webdav（计入 9） |
| 5 | `src/addons/webdav/js/webdav-sw.js` | 同名 | 2,145 | `c6dc46ff94f2ee11` | webdav（计入 9） |
| 6 | `src/addons/webdav/inject.js` | 同名（v1 遗留，**不加载**） | 4,003 | `d8deac6b6eee4d38` | webdav（计入 9） |
| 7 | `js/pages/acgx-batch.js` | `src/addons/batch/js/pages/acgx-batch.js` | 49,447 | `93e1a6c78c7dd657` | batch（`additions[]`，不计入 3） |
| 8 | `js/pages/acgx-batch-offscreen.js` | `src/addons/batch/js/pages/acgx-batch-offscreen.js` | 14,571 | `63d052d8fa0fc3f1` | batch（`additions[]`，不计入 3） |

### 7.5 差异簇（`tools/verify-independent-r4.py` + `tools/_r4_cluster_breakdown.py`）

* 61 条字节补丁（38 + 4 + 8 + 5 + 3 + 3）→ **53 簇**（相邻/嵌套合并后；`manifest.json` 按历版口径不计簇）：
  `js/pages/background.js 17`、`js/pages/video.js 20`、`initBackground.sw.js 9`、`config.js 2`、
  `html/config.html 1`、`html/background.html 1`、`live.js 1`、`message.js 1`、`popup.js 1`。
* 新增文件 **8** 个 → 8 簇（每个算 1 簇）。
* **最终差异簇 = 53 + 8 = 61**（r3 是 53 + 7 = 60；v2 的 `W1` 只是把 `html/config.html` 同一处簇的内容换掉，不新增簇）。

### 7.6 规格文件归属（r4 谁被改、谁没被改）

| 文件 | r4 动作 |
|---|---|
| `tools/apply-all-plus-features.py` | **改**：webdav 段读 v2（9 条）+ `webdav_legacy_bridge()`；`VERSION_NAME → r4`；`totals`（总条数由规格算出）；报告加 `webdav_bridge` / `base_patch_ids` |
| `tools/feature-webdav.json` | 规格方已升 v2（9 条），**本轮未改** |
| `tools/feature-batch.json` | 规格方已升 v2（3 条 + 2 新增），**本轮未改** |
| `tools/apply-all-patches.py` / `static-patchspec.py` / `proto-patch-spec.json` / `extra-patch-spec.json` / `feature-pgc-fix.json` / `feature-dash-auth-fix.json` / `feature-dash-fallback.json` | **未改**（只被 import 取定义） |
| `tools/feature-webdav-apply.py` | **未改**（构建器只 import 它的 `norm_patches()`） |
| `tools/verify-independent-61.py` | **未改**（r4 用复制派生的 `tools/verify-independent-r4.py`） |
| `tools/verify-independent-load-53.mjs` | **未改**（r4 用复制派生的 `tools/verify-independent-load-r4.mjs`） |
| `tools/_r3_cluster_breakdown.py` | **未改**（r4 用复制派生的 `tools/_r4_cluster_breakdown.py`） |
| `src/extracted/**` | **未改**（目录指纹 `00c27453…ac58` 构建前后一致） |
