# 选集 / 多 P 批量下载：并进 ACGhelper 自己的悬浮面板

> 版本：`acgx-batch` v2.0.0
> 基准成品树：`output/ACGhelper-2.8.31.16-unlock`（`version_name = 2.8.31.16(Beta) unlock r4`，`built_at 2026-11-25T18:01:01+0800`，
> `applied = 67`（static 10 / proto 23 / extra 5 / pgc-fix 4 / dash-auth-fix 8 / dash-fallback 5 / webdav 9 / **batch 3**），`added_files = 8`）
> 变更范围：本特性**只改 `js/pages/acgx-batch.js` 一个文件**（3 条补丁的 `old/new` 逐字节未动，offscreen 执行端一行未动）
> 结论：入口并入插件自己的悬浮面板 `#bilibiliHelper2ContentWrapper` 内部；单集 / 单 P 页面**一个 DOM 节点都不建**；
> 样式 9/9 项与插件原生 `div.button.primary` 完全一致；**50/50 断言 PASS**（含既有队列不回归）；
> `build/pre-batch + tools/feature-batch.json` 与成品树**逐字节完全一致（差异 0）**。
>
> 说明：`output/` 里的成品树在本次改造期间被主构建器重建过一次（r3 → r4，webdav 8→9 条）。
> 本文所有数字都是在 **r4** 上重跑得到的；反演/校验/验收三步在 r3 上也跑过一遍，结论相同。

---

## 0. 一句话结论

| 要求 | 落地方式 | 证据 |
| --- | --- | --- |
| 不另起浮动按钮 | 旧右下角 FAB（`.fab` / `#acgx-batch-fab`）**已整段删除**；入口改为注入插件面板内部、`<footer>` 之前的一个区块 | `logs/batch-inpanel-A-collapsed.png`；断言「全文档 acgx-* 节点数 = 1」「body 直接子节点里 acgx-* = 0」「`.fab` 不存在」 |
| 视觉与插件统一 | 运行期 `getComputedStyle` 读面板里原生 `div.button.primary`，把值写成 `--acgx-*` CSS 变量，再套同一套结构 `div.button > button.button-view` | 样式对齐表 9/9 一致（`font-size` / `border-radius` / `background-color` / `color` / `border-*` / `height` / `font-family`） |
| 只在真能多选时出现 | 注入前先判：番剧 `pgc/view/web/season` 的 `episodes + section` 展开后 > 1；多 P `x/web-interface/view` 的 `pages.length > 1` | 场景 A（4 集，出现）/ B（1 集，不出现）/ C1（pages=1，不出现）/ C2（pages=3，出现） |

---

## 1. §侦察：插件自己的下载面板长什么样

侦察脚本：`tools/panel-recon.mjs`（headless Chrome + CDP `Extensions.loadUnpacked`，`Fetch.fulfillRequest` 全喂 fixture，
**一条真实网络请求都不发**）。

```powershell
robocopy "output\ACGhelper-2.8.31.16-unlock" "build\recon-r3" /E   # 只读副本，绝不碰 output/
node tools/panel-recon.mjs                                          # → logs/panel-recon-dump.json
```
原始 dump：`logs/panel-recon-dump.json`（28 KB，含 DOM 树 / 每条计算样式 / CSSOM 规则 / CSS 变量）；运行日志 `logs/panel-recon-run5.txt`。

### 1.1 挂载链（从源码定位到的锚点）

`js/pages/video.js` 的内容脚本把 React 树挂到一个裸 `div`（`g=document.createElement("div");document.body.appendChild(g)`），
面板的**外层容器**是 `js/components.bundle.js` 里的 styled 组件：

```
div#bilibiliHelper2HandleButtonWrapper.handle-wrapper          ← 悬浮球外壳：position:fixed; top:100px; right:24px; 36×36; z-index:99999
 ├─ span#bilibiliHelper2HandleButton.handle-button            ← 悬浮球本体（点它开/合面板）
 └─ div#bilibiliHelper2ContentWrapper.handle-content-wrapper   ← ★ 插件自己的面板（我们注入的地方）
```

用户点插件自己的入口（那颗悬浮球）→ React `setState({showContent:!0})` → `#bilibiliHelper2ContentWrapper` 去掉 `hide` 类
（`.hide{opacity:0;visibility:hidden}`）→ 面板出现在悬浮球左侧。

运行期实测（点击前/后）：

```
点击前 class = "sc-eldPxv hGLEGy handle-content-wrapper hide left"
点击后 class = "sc-eldPxv hGLEGy handle-content-wrapper left"
```

### 1.2 面板内部结构（实测 DOM 树，缩进省略）

```
div#bilibiliHelper2ContentWrapper.handle-content-wrapper.left
  ├─ div.sc-fsvrbR.bBbEnM                                   ← 顶部按钮行（flex，420×26）
  │    ├─ div.button.primary.bilibili-helper-screenshot-btn  ›  «截取画面»
  │    ├─ div.button.primary.bilibili-helper-play-position-link-btn › «复制空降链接»
  │    └─ div.button.border.video-widen-comment-button       ›  «显示网页全屏评论区»
  ├─ div.sc-EgOXT.gRdIBA                                    ← 视频信息块（.bilibili-helper-video-download-title「视频信息 - 点击复制」+ .basic-info 按钮网格）
  ├─ div.sc-dNsVcS.kTvqMY.bilibili-helper-video-download-title ← 「视频下载（4K8K超长视频）」+ 联系客服
  ├─ div.sc-dxcDKg.ezEoax.new-downloader                    ← ★ 下载面板（简单模式/高级模式、画质、音轨、下载按钮；420×41）
  ├─ div.sc-jMakVo.ctvCQo                                   ← 弹幕发送者查询 / 下载块
  └─ footer                                                 ← ACG助手官网 / 设置页面 / 点击反馈 / 当前版本: 2.8.31.16
```

> fixture 页面里没有播放器，`.new-downloader` 只有一行 `p.initing「数据初始化中，请耐心等待一下哦」`；
> 真实页面上它渲染的是 `.title` + `简单模式/高级模式` 切换 + 画质九宫格 + 音轨 + 下载按钮 ——
> 但**所有按钮都是同一个组件**（`components.bundle.js` 模块 724 的 `b` / `V.$`），所以拿顶部按钮行当样式锚点是等价的。

### 1.3 原生按钮的真身（源码 + 计算样式双证）

源码 `js/components.bundle.js` 模块 724（`i.d(t,{$:()=>b})`）：

```js
p = styled.div`                       /* 外壳：className 里带 "button" */
  display: flex; justify-content: center; align-items: center; position: relative;
  height: 26px; line-height: inherit; border-radius: 6px; font-size: 12px;
  color: ${paper-grey-600}; overflow: hidden; user-select: none; box-sizing: border-box;
  &.disabled { cursor: not-allowed; filter: grayscale(1); }
  &.primary  { background-color: var(--bilibili-blue); color: var(--bilibili-gray); border: 1px solid transparent; }
  &.second   { background-color: var(--bilibili-pink); color: var(--bilibili-gray); border: 1px solid transparent; }
  &.border   { border: 1px solid #ddd; }
`;
d = styled.button`                    /* 内层：className 里带 "button-view" */
  display: block; width: 100%; height: inherit; line-height: inherit; min-width: 50px;
  font-size: inherit; font-weight: inherit; background-color: transparent;
  padding-inline: 8px; color: inherit; cursor: pointer; transition: color .3s;
  border: none; outline: none; z-index: 1;
`;
// 渲染结构：<div class="button primary"><button class="button-view">文案</button><div class="ripple-box"/></div>
```

运行期 `getComputedStyle`（面板里第一个 `.button.primary`「截取画面」，`logs/panel-recon-dump.json → styles.buttonWrappers[0]`）：

| 属性 | 实测值 |
| --- | --- |
| display / position | `flex` / `relative` |
| align-items / justify-content | `center` / `center` |
| height | `26px` |
| border-radius | `6px` |
| font-size | `12px` |
| font-family | `"Noto Sans SC"` |
| background-color（`.primary`） | `rgb(35, 173, 229)`（= `#23ADE5`） |
| color（`.primary`） | `rgb(244, 244, 244)`（= `#F4F4F4`） |
| border（`.primary`） | `1px solid rgba(0, 0, 0, 0)` |
| border（`.border`） | `1px solid rgb(221, 221, 221)`（= `#ddd`），color `rgb(117,117,117)` |
| overflow | `hidden` |
| box-shadow | `none` |
| transition | `all` |
| 内层 button.button-view | `background transparent` / `padding 1px 8px` / `cursor pointer` / `min-width 50px` |

### 1.4 面板容器与 footer

| 元素 | 关键计算样式 |
| --- | --- |
| `#bilibiliHelper2ContentWrapper`（`.handle-content-wrapper`） | `position:absolute; top:0; right:36px; padding:10px; min-width:100px; max-width:550px; width:max-content; background:rgb(255,255,255); color:rgb(34,34,34); border-radius:6px 0 6px 6px; box-shadow:rgba(0,0,0,.14) 0 2px 4px 0; font-family:"Noto Sans SC"; overflow:auto` |
| `footer` | `display:flex; justify-content:space-between; margin:12px -10px -10px; padding:4px 10px; color:rgb(97,97,97); font-size:12px; border-top:1px solid var(--google-grey-100)` |
| 内容列宽 | 面板实测 440px 宽 = `padding 10×2` + 内容 420px（`.new-downloader` 的 `min-width:420px`） |

### 1.5 CSS 变量（在 `#bilibiliHelper2ContentWrapper` 上定义）

| 变量 | 值 |
| --- | --- |
| `--bilibili-pink` | `#FB7299` |
| `--bilibili-blue` | `#23ADE5` |
| `--bilibili-gray` | `#F4F4F4` |
| `--paper-red-600` | `#e53935` |
| `--paper-grey-900` | `#212121` |
| `--paper-grey-500` | `#9e9e9e` |
| `--paper-grey-300` | `#e0e0e0` |
| `--paper-grey-100` | `#f5f5f5` |

### 1.6 hover 行为（重要，别自己发明）

把面板全部 CSSOM 规则过滤一遍（`logs/panel-recon-dump.json → cssomRules`），与按钮相关的只有：

```
.kRUyJz.primary { background-color: var(--bilibili-blue); color: var(--bilibili-gray); border: 1px solid transparent; }
.kRUyJz.border  { border: 1px solid rgb(221, 221, 221); }
.bBbEnM > .button { margin-right: 8px; }
.bBbEnM > .button:last-of-type { margin-right: 0; }
```

**没有 `.primary:hover` 规则** —— 原生主按钮 hover 时背景/文字都不变，只有内层 `button` 的 `cursor:pointer`。
所以我们的入口也**不加任何 hover 变色**（见 §4 对齐表最后一行：两边 hover 后背景同为 `rgb(35, 173, 229)`、内层 cursor 同为 `pointer`）。

---

## 2. 注入策略与选择器

| 项 | 值 |
| --- | --- |
| 注入目标 | `document.getElementById('bilibiliHelper2ContentWrapper')` |
| 插入位置 | `panel.insertBefore(host, panel.querySelector('footer'))` —— 面板底部、footer 之前 |
| 宿主元素 | `<div id="acgx-batch-host" data-acgx-role="section">`，**不改面板宽高**：`display:block; width:var(--acgx-sec-w,420px); max-width:100%` |
| 内部结构 | `attachShadow({mode:'open'})`；`<style>` + `<section class="sec">`（入口行 + 可折叠展开体） |
| 入口 DOM | 与原生同构：`<div class="btn primary" id="acgx-entry"><button id="acgx-entry-btn">选集下载<span class="caret">▾</span></button></div>` |
| 等面板出现 | ① 立刻试一次；② 400 ms 轮询（最多 300 次 = 120 s）；③ 同时 `MutationObserver(document.body, {childList:true})` 兜住 React 晚挂载 |
| 被 React 冲掉后自愈 | 注入成功后 `MutationObserver(panel, {childList:true})` → 每次子节点变动都调 `ensureEntry()`：既补回被移除的宿主，也把位置纠正回「footer 前一个」 |
| 跨页面（软导航） | 每秒比对 `location.pathname`；变了就 `removeEntry()` → 清 `host/root/ui` → 重新 `boot()`（重判多选条件） |
| 只读快照 | 入口 `<section>` 上挂 `data-acgx-{phase,injected,open,kind,count,checked,running,index,total,ok,fail,error,source,message}`；另有 `window.__acgxBatch.state()/open()/close()/selectAll()/start()` |

为什么不用「直接往 `.new-downloader` 里塞」：那个节点的 children 全由 React 管，塞进去会被 reconciliation 挤走；
放在 `footer` 之前这一格，React 只在重排子节点时 `insertBefore/removeChild` 它自己创建的节点，不碰我们的宿主，
万一被挪动，`MutationObserver` 会把它挪回原位。

---

## 3. 条件判定：「只在真能多选时出现」

### 3.1 判定表

| 页面 | 数据源 | 判定 | 不满足时 |
| --- | --- | --- | --- |
| `/bangumi/play/ep<id>` `/bangumi/play/ss<id>` | `https://api.bilibili.com/pgc/view/web/season?ep_id=/season_id=`（失败回退 `#__NEXT_DATA__`） | `episodes.length + Σ section[].episodes.length > 1` | 不注入 |
| `/video/BV…` `/video/av…` | `https://api.bilibili.com/x/web-interface/view?bvid=/aid=`（失败回退 `window.__INITIAL_STATE__`） | `pages.length > 1` | 不注入 |
| `/list/*` `/medialist/play/*` | URL/`bvid` 参数解析出单一 bvid | 其 `pages.length > 1` | 不注入（`LIST_NO_SINGLE_BVID`） |
| 其它页面 | — | `NOT_SUPPORTED_ROUTE` | 不注入 |

判定在 `probe()` 里做，**在造任何 DOM 之前**。`probe()` 返回 `{ok:false, reason}` 时 `boot()` 只做两件事：
`STATE.phase='absent'` + `console.info('[acgx-batch] 多选入口未注入：' + reason)`，`buildShell()` 一次都不会被调用。

### 3.2 「不出现」怎么自证（四条独立断言，场景 B/C1/E 都跑过）

1. `document.getElementById('acgx-batch-host') === null`
2. `document.querySelectorAll('[id^="acgx-"]').length === 0`（全文档一个 acgx 节点都没有）
3. `document.querySelectorAll('body > [id^="acgx-"]').length === 0`（A 场景有入口时这条同样是 0 → 证明从来不在页面层面加东西）
4. `#bilibiliHelper2ContentWrapper.children.length === 6`（= A 场景的 7 减去我们那一个；面板子节点列表逐项对得上）
5. console 里恰好一行 `[acgx-batch] 多选入口未注入：<原因>`

实测 console 原文（`logs/batch-15-inpanel-final.log`）：

```
[acgx-batch] 多选入口未注入：番剧整季只有 1 集/个分P，不构成可多选集合
[acgx-batch] 多选入口未注入：视频只有 1 集/个分P，不构成可多选集合
[acgx-batch] 多选入口未注入：接口返回 -101：未登录（请先登录 B 站账号）
```

---

## 4. 样式对齐表（原生 `div.button.primary` vs 我们的入口）

同一页、同一时刻、`getComputedStyle` 直接取两边的值（场景 A 实测）：

| 属性 | 原生「截取画面」`.button.primary` | 我们的「选集下载」入口 | 差异 | 判定 |
| --- | --- | --- | --- | --- |
| `font-size` | `12px` | `12px` | 0 | ✅ |
| `font-family` | `"Noto Sans SC"` | `"Noto Sans SC"` | 0 | ✅ |
| `border-radius` | `6px` | `6px` | 0 | ✅ |
| `background-color` | `rgb(35, 173, 229)` | `rgb(35, 173, 229)` | 0 色阶 | ✅ |
| `color` | `rgb(244, 244, 244)` | `rgb(244, 244, 244)` | 0 色阶 | ✅ |
| `border-top-width` | `1px` | `1px` | 0 | ✅ |
| `border-top-style` | `solid` | `solid` | — | ✅ |
| `border-top-color` | `rgba(0, 0, 0, 0)` | `rgba(0, 0, 0, 0)` | 0 | ✅ |
| `height` | `26px` | `26px` | 0 | ✅ |
| hover 后 `background-color` | `rgb(35, 173, 229)`（不变） | `rgb(35, 173, 229)`（不变） | 0 | ✅ |
| hover 后外层 / 内层 `cursor` | `auto` / `pointer` | `auto` / `pointer` | — | ✅ |

**9/9 项完全一致（差异 0，远低于「≤2px / ≤1 色阶」的门槛）。**

### 4.1 这些值是怎么进到 CSS 的

`captureNativeStyle(panel)`（`js/pages/acgx-batch.js`）在注入瞬间读原生值，写到宿主元素的 `style` 上：

```
--acgx-font: "Noto Sans SC"      --acgx-font-size: 12px
--acgx-radius: 6px               --acgx-btn-h: 26px
--acgx-border-w: 1px             --acgx-border-s: solid
--acgx-border-c: rgba(0, 0, 0, 0)          ← 主按钮自己的透明描边（照抄 .primary）
--acgx-primary-bg: rgb(35, 173, 229)       ← 照抄 .primary 背景
--acgx-primary-fg: rgb(244, 244, 244)      ← 照抄 .primary 文字
--acgx-line: rgb(221, 221, 221)            ← 照抄 .border 描边（给次级按钮/分隔线）
--acgx-muted: rgb(117, 117, 117)           ← 照抄 .border 文字
--acgx-faint: rgb(97, 97, 97)              ← 照抄面板 footer 文字
--acgx-text: rgb(34, 34, 34)               ← 照抄面板正文色
--acgx-panel-bg: rgb(255, 255, 255)        ← 照抄面板底色
--acgx-soft-bg: rgb(234, 244, 255)         ← 照抄 .basic-info 浅蓝底
--acgx-soft-fg: rgb(0, 161, 214)           ← 照抄 .basic-info 浅蓝字
--acgx-pink: #FB7299                       ← 面板上的 --bilibili-pink
--acgx-sec-w: 420px                        ← .new-downloader 的宽度
```

Shadow DOM 里所有规则都用 `var(--acgx-*, <兜底值>)`，兜底值就是 §1 侦察到的常量，
所以即使某天面板里一个原生按钮都找不到，样式也还是插件那套。

---

## 5. 四个场景的断言与截图

一次性跑完，脚本 `tools/batch-inpanel-test.mjs`：

```powershell
node tools/batch-inpanel-test.mjs --tree=build/batch-inpanel-test
# → logs/batch-inpanel-latest.json / logs/batch-15-inpanel-final.log / logs/batch-inpanel-*.png
```

**结果：PASS 50 / 共 50，失败 0**（`logs/batch-15-inpanel-final.log` 最后一行）。

### 场景 A：番剧 fixture（4 集）

| # | 断言 | 结果 |
| --- | --- | --- |
| A① | 插件面板打开（`.handle-content-wrapper` 去掉 `hide`），class = `... handle-content-wrapper left` | PASS |
| A② | 面板内部出现 `#acgx-batch-host`，`parent = bilibiliHelper2ContentWrapper`，`index = 5`，`footerIndex = 6`（**footer 前一个**） | PASS |
| A② | 全文档 acgx-* 节点数 = 1；body 直接子节点里 acgx-* = 0；`.fab` 不存在；入口是 `div.button > button.button-view` | PASS |
| A③ | 点入口 → `data-acgx-open=1`、`body.hidden=false`，列表在**面板内部**展开 | PASS |
| A③ | 列出 4 集，`data-acgx-key = ep900001,ep900002,ep900003,ep900004`，每行 `mm:ss` | PASS |
| A③ | 数据源标注 `api/pgc/view/web/season` | PASS |
| A④ | 样式对齐 9/9；hover 一致性；`--acgx-*` 变量已写入宿主 `style` | PASS |

面板子节点顺序（实测）：
`[top row][basic-info][download-title][new-downloader][弹幕块][#acgx-batch-host][footer]`

截图：`logs/batch-inpanel-A-collapsed.png`、`logs/batch-inpanel-A-expanded.png`（均为 914×1415）

**入口在截图里的像素位置**（`getBoundingClientRect` 实测，deviceScaleFactor=1 即 CSS px = 像素）：
`x=424 … 501.5`、`y=486 … 512`，宽 77.5 × 高 26，中心 **(463, 499)** ——
即面板右列（面板左边界 x≈424）里那颗蓝色胶囊按钮「选集下载 ▾」，紧跟其后是灰字「共 4 集」，
再下面是展开体（番剧名 / 数据源 / 全选 反选 / 画质 / 音轨 / 4 行集数 / 开始下载 暂停 取消 / 已选 0/4 集），
最后一行才是插件自己的 footer「ACG助手官网 设置页面 点击反馈 当前版本: 2.8.31.16」。

### 场景 B：单集番剧（1 集）

| # | 断言 | 结果 |
| --- | --- | --- |
| B① | `getElementById('acgx-batch-host') === null`；全文档 acgx-* = 0 | PASS |
| B② | 面板子节点数 = 6（与 A 去掉我们那一个之后相同），body 直接子节点里 acgx-* = 0 | PASS |
| B③ | console 有 `[acgx-batch] 多选入口未注入：番剧整季只有 1 集/个分P，不构成可多选集合` | PASS |

截图：`logs/batch-inpanel-B-single.png` —— 面板里 弹幕块 之后直接就是 footer，**没有任何入口**。

### 场景 C：单 P 不出现 / 多 P 出现

| # | 断言 | 结果 |
| --- | --- | --- |
| C① | `/video/BV…`（pages=1）：`hostFound=false`、acgx-* = 0、面板子节点 = 6 | PASS |
| C② | `/video/BV…`（pages=3）：入口出现且在 `bilibiliHelper2ContentWrapper` 内，面板子节点 = 7 | PASS |
| C③ | 点入口 → 列出 3 个分 P：`p1_3001,p2_3002,p3_3003`，标题 `P1 分段1 fixture / P2 分段2 fixture / P3 分段3 fixture` | PASS |

截图：`logs/batch-inpanel-C1-single-p.png`（无入口）、`logs/batch-inpanel-C2-multi-p.png`（入口 + 3 个分 P）。
C2 里入口中心实测 **(487, 463)**，标签为「选集下载 ▾」+「共 3 P」。

### 场景 D：既有队列不回归

| # | 断言 | 结果 |
| --- | --- | --- |
| D① | 点「全选」后选中数 = 4（`data-acgx-checked=4`，DOM `:checked` = 4） | PASS |
| D② | offscreen 侧收到 4 条 `[acgx-batch] recv url=` | PASS |
| D③ | offscreen 侧回执 4 条 `[acgx-batch] done url=` | PASS |
| D④ | 时序 `recv → done → recv → done → recv → done → recv → done`（严格串行） | PASS |
| D⑤ | fixture 环境下 4 集全部按预期失败（`INIT_TIMEOUT`），ok=0 fail=4，不卡队列 | PASS |
| D⑥ | 汇总状态行：`队列结束：成功 0 / 失败 4` | PASS |
| D⑦ | 每行标红 + 4 个「重试本集」按钮 | PASS |

用时 16.1 s（4 集 × 4 s `data-acgx-init-timeout=4000`）。截图 `logs/batch-inpanel-D-queue.png`。

### 场景 E（附加）：接口失败分支

season 接口返回 `code:-101`（未登录）→ 入口不出现、面板子节点 = 6、console 一行
`[acgx-batch] 多选入口未注入：接口返回 -101：未登录（请先登录 B 站账号）`。
截图 `logs/batch-inpanel-E-api-fail.png`。

### 环境自证（三项）

| 项 | 实测 |
| --- | --- |
| 本次 profile 的 chrome 进程 `MainWindowHandle` | 11 个 PID 全 `=0`（`68532=0 75368=0 …`） |
| `GetForegroundWindow` | 跑前 `2558864\|75968\|douyin` → 跑后 `2558864\|75968\|douyin`（**一致**）；另外全程 6 次采样（每次导航 + 收尾）里前台窗口从未落到本次 chrome 的 PID 集合 |
| `--mute-audio` + 清场 | 命令行含 `--mute-audio`；按 `--user-data-dir` 精确清场，残留 chrome 进程数 `=0`，profile 已删 |

> 环境注记：有一次运行期间桌面前台被外部窗口接管（`QQ → DeepSeek Harness`），两个窗口都不在本次 chrome PID 集合内 ——
> 那是宿主桌面活动。脚本因此把「前台 pid 不属于本次 chrome」作为**硬断言**（6 次采样全过），
> 「跑前跑后完全一致」只作如实记录。

---

## 6. 补丁规格

`tools/feature-batch.json` 仍是 **3 条补丁 + 2 个新增文件**，`old/new` 与 v1.0.0 **逐字节相同**
（它们只碰 `manifest.json` / `html/background.html` / `js/pages/background.js`，与 `acgx-batch.js` 的内容无关）：

| id | 文件 | 作用 |
| --- | --- | --- |
| FB1 | `manifest.json` | 新增一条 content_scripts（`/bangumi/play/*`、`/video/*`、`/list/*`、`/medialist/play/*`，`run_at=document_end`，`all_frames=false`，只加载 `js/pages/acgx-batch.js`） |
| FB2 | `html/background.html` | 在 `background.js` **之前**加载 `acgx-batch-offscreen.js` |
| FB3 | `js/pages/background.js` | 在 `St` 命令分发链末尾（`setPlayurlInfoByQuality` 之后、`let Tt=` 之前）加 `acgxAutoDownload` / `acgxAbortAll` 两个分支，只转调 `self.__acgxBatchAuto` / `self.__acgxBatchAbort` |

新增文件（`additions[].copy`）：`js/pages/acgx-batch.js`、`js/pages/acgx-batch-offscreen.js`。**没有新的样式文件**（样式全部内联在 `acgx-batch.js` 的 shadow `<style>` 里）。

### 6.1 锚点基准：为什么不是「成品树上 count==1」

构建器 `tools/apply-all-plus-features.py` 的段序是
`static 10 → proto 23 → extra 5 → feature:pgc-fix 4 → dash-auth-fix 8 → dash-fallback 5 → webdav 8/9 → **batch 3（最后一段）**`，
也就是成品树 = `src/extracted` + N 条 + batch 3 条。所以 `feature-batch.json` 的 `old` 锚点必须满足
**「batch 被应用的那一刻」count==1**，那棵树 = 成品树把这 3 条补丁反向撤掉后的 `build/pre-batch`。

> 直接 `--skip-feature batch` 重跑构建器不可靠（构建器对每个 feature 的 patch 条数做硬校验，
> 例如 `[FAIL] [feature:webdav] 规格 patches[] = 9 != 预期 8` 这种版本漂移时就会卡住；构建器和别人的规格都不许改）。

所以改用**可验证反演**：`tools/batch-prebatch-reverse.py`（拷成品树 → 对每条 patch 断言 `count(new)==1` → `new→old` → 删 2 个新增文件）：

```
规格     : tools\feature-batch.json
成品树   : output\ACGhelper-2.8.31.16-unlock
反演输出 : build\pre-batch
------------------------------------------------------------------------------------------------
  反演 FB3  js/pages/background.js   count(new)=1   off=  73552    284 ->    76 B   已还原
  反演 FB2  html/background.html     count(new)=1   off=    185    155 ->    72 B   已还原
  反演 FB1  manifest.json            count(new)=1   off=   5520    483 ->    78 B   已还原
  删除新增 js/pages/acgx-batch.js           (原 sha256=93e1a6c78c7dd657…)
  删除新增 js/pages/acgx-batch-offscreen.js (原 sha256=63d052d8fa0fc3f1…)
结果：PASS（失败 0）
```

### 6.2 `old` 在基准树上的 count 校验（python 输出原文）

```powershell
python tools/apply-feature-batch.py --tree build/pre-batch --check
```

```
规格        : tools/feature-batch.json
基准树      : build/pre-batch
补丁        : 3 条  + 新增文件 2 个
------------------------------------------------------------------------------------------------------------
  锚点 FB1  manifest.json            count=1  offset=5520
  锚点 FB2  html/background.html     count=1  offset=185
  锚点 FB3  js/pages/background.js   count=1  offset=73552
  拷贝 src/addons/batch/js/pages/acgx-batch.js          -> js/pages/acgx-batch.js
  拷贝 src/addons/batch/js/pages/acgx-batch-offscreen.js -> js/pages/acgx-batch-offscreen.js
------------------------------------------------------------------------------------------------------------
[CHECK ONLY] 基准树锚点全部 count==1；未写任何文件。
```

三个 offset 与反演时 `count(new)` 的 offset 完全相同（5520 / 185 / 73552）—— 正演反演都对得上。

### 6.3 正演回环：`pre-batch + feature-batch.json` 必须与成品树逐字节一致

```powershell
python tools/apply-feature-batch.py --tree build/pre-batch --out build/batch-inpanel-test
python tools/tree-diff.py "output\ACGhelper-2.8.31.16-unlock" "build/batch-inpanel-test"
```

```
  锚点 FB1  manifest.json            count=1  offset=5520
  锚点 FB2  html/background.html     count=1  offset=185
  锚点 FB3  js/pages/background.js   count=1  offset=73552
  + 新增 js/pages/acgx-batch.js               49447 B  sha256=93e1a6c78c7dd657…
  + 新增 js/pages/acgx-batch-offscreen.js     14571 B  sha256=63d052d8fa0fc3f1…
  * FB1 manifest.json            off=   5520   78 ->  483 B
  * FB2 html/background.html     off=    185   72 ->  155 B
  * FB3 js/pages/background.js   off=  73552   76 ->  284 B
  manifest.json 合法 JSON；content_scripts 条目数 = 11；命中 batch 条目 = 1
  html/background.html: batch 脚本 off=224 / background.js off=299 → 顺序正确 = True
  background.js 含 "acgxAutoDownload"===n × 1 / "acgxAbortAll"===n × 1 / await A(e,t,i,bt) × 1
  background.js / acgx-batch.js / acgx-batch-offscreen.js node 语法解析：OK
结果：PASS（失败项 0）
```

```
A = output\ACGhelper-2.8.31.16-unlock   (93 files)
B = build\batch-inpanel-test            (93 files)
只在 A : 0
只在 B : 0
内容不同: 0
------------------------------------------------------------------------------------------
合计差异 = 0 项 —— 完全一致
```

**差异 0** 说明三件事：
① 反演出来的 pre-batch 是准的（否则正演回不到成品树）；
② `feature-batch.json` 精确、完备地描述了 batch 这一段的全部改动（3 条补丁 + 2 个新增文件，既不多也不少）；
③ 成品树里 `js/pages/acgx-batch.js` 的 sha256 就是 `93e1a6c78c7dd657…` —— 和 `src/addons/batch/js/pages/acgx-batch.js` 一模一样，
   也就是 **r4 成品树已经包含了本次 v2.0.0 的改造**（主构建器在 18:01 那次重建时直接从 `src/addons/batch/` 拷进去了）。

（`output/` 全程只读：`tree-diff` 只读文件哈希；`apply-feature-batch.py` 的 `--out` 只指向 `build/`；
`output/ACGhelper-2.8.31.16-unlock/manifest.json` 的 sha256 在整轮验收前后都是 `C4C05F5CA06E9A14…`，未变。）

---

## 7. 失败分支与处置

| 现象 | 代码里的行为 | 怎么判断 / 怎么处置 |
| --- | --- | --- |
| 插件面板一直不出现（`#bilibiliHelper2ContentWrapper` 120 s 内没挂上） | 入口不注入；console `[acgx-batch] 等待插件面板超时（120s）：#bilibiliHelper2ContentWrapper 一直没出现，入口未注入` | 抓 `[acgx-batch]` 前缀日志；先确认插件本身在这页是否工作（悬浮球在不在） |
| season / view 接口失败（未登录 `-101`、地区限制 `-10403`、不存在 `-404`、网络错） | 不注入；console 一行 `多选入口未注入：<具体原因>` | 原因串里带 code 与中文解释，直接看得出该登录还是该换区 |
| 单集 / 单 P 被误显示 | **不会**：`probe()` 的 `n <= 1` 分支直接返回 `ok:false`，`buildShell()` 一次都不调用 | 复验方式见 §3.2 的四条断言 |
| 面板被 React 重挂 / 我们被挤掉 | `MutationObserver(panel)` 每次子节点变动都 `ensureEntry()`：补回宿主、纠正到 footer 之前 | 若入口跑到 footer 之后，说明 footer 被 React 重插了 —— `ensureEntry()` 下一拍会挪回去 |
| 软导航到别的视频 | 每秒比对 `location.pathname`，变了就 `removeEntry()` → 重判 → 满足才重新注入 | 不满足的页面上不会残留任何节点 |
| 入口点了没反应 | 只有 `phase==='ready'` 才响应点击（`toggleOpen()` 先判 phase） | 看 `data-acgx-phase` |
| 队列卡住 | 每集 30 min 硬超时 + 解析阶段 90 s（`<html data-acgx-init-timeout>` 可覆盖）兜底 | 行会标红并出现「重试本集」 |

---

## 8. 停用方式

| 层级 | 做法 | 效果 |
| --- | --- | --- |
| 构建期（彻底） | 重打包时 `python tools/apply-all-plus-features.py --skip-feature batch` | manifest 里那条 content_scripts 不再写入 → 任何页面都不注入 |
| 规格级（只关注入，保留 offscreen 能力） | 把 `tools/feature-batch.json` 里 **FB1** 整个删掉（只留 FB2/FB3） | 页面侧零代码，`acgxAutoDownload` 命令仍在（可被别的东西调用） |
| 已装包、不改包 | chrome://extensions → 停用整个扩展；或把 `js/pages/acgx-batch.js` 换成单行 `void 0;` 后点「重新加载」 | 内容脚本变成空操作，零注入 |
| 单页临时 | 换到非 `/bangumi/play/*`、`/video/*`、`/list/*`、`/medialist/play/*` 的页面 | 内容脚本根本没被注入 |
| 只关入口（保留队列） | 改 `probe()` 让它永远返回 `ok:false` | 队列逻辑还在，但没有任何 UI |

---

## 9. 复现清单

```powershell
cd D:\AI-Project\逆向统一\acghelper

# 0) 侦察插件面板（可选，拿 DOM/样式基线）
robocopy "output\ACGhelper-2.8.31.16-unlock" "build\recon-r3" /E
node tools/panel-recon.mjs

# 1) 反演出 batch 之前的基准树
python tools/batch-prebatch-reverse.py --out build/pre-batch

# 2) 校验锚点（必须全部 count==1）
python tools/apply-feature-batch.py --tree build/pre-batch --check

# 3) 打补丁到测试树（不碰 output/）
python tools/apply-feature-batch.py --tree build/pre-batch --out build/batch-inpanel-test

# 4) 与 r3 的差异：必须只有 js/pages/acgx-batch.js
python tools/tree-diff.py "output\ACGhelper-2.8.31.16-unlock" "build\batch-inpanel-test"

# 5) headless 五场景验收（A/B/C/D/E，50 条断言）
node tools/batch-inpanel-test.mjs --tree=build/batch-inpanel-test
```

产物：
- 源码：`src/addons/batch/js/pages/acgx-batch.js`（v2.0.0）
- 规格：`tools/feature-batch.json`（v2.0.0）
- 工具：`tools/panel-recon.mjs`、`tools/batch-prebatch-reverse.py`、`tools/tree-diff.py`、`tools/batch-inpanel-test.mjs`
- 日志：`logs/panel-recon-dump.json`、`logs/batch-11…15-*.log`、`logs/batch-inpanel-latest.json`
- 截图：`logs/batch-inpanel-{A-collapsed,A-expanded,B-single,C1-single-p,C2-multi-p,D-queue,E-api-fail}.png`（均 914×1415）

---

## 10. 没动的东西（可核对）

| 文件 | 状态 |
| --- | --- |
| `src/extracted/`（只读基准） | 未改（`_build-info.json` 里 `unchanged_before_after: true` 仍成立；本次构建根本没跑主构建器） |
| `output/ACGhelper-2.8.31.16-unlock/`（r3 成品树） | 未改（`tree-diff` 只读比对；`Extensions.loadUnpacked` 只在 `build/` 副本上跑） |
| `tools/apply-all-plus-features.py` | 未改 |
| `tools/feature-webdav.json` / `feature-pgc-fix.json` / `feature-dash-auth-fix.json` / `feature-dash-fallback.json` | 未改 |
| `src/addons/batch/js/pages/acgx-batch-offscreen.js` | 未改（下载/选流/串行/回执逻辑一行没动，sha256 `63d052d8fa0fc3f1…`） |
| `tools/apply-feature-batch.py` | 未改（直接复用，`--tree / --out / --check` 三个开关够用） |
