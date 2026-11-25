# ACGhelper 2.8.31.16 — 自家会员锁（isVIP / isSuperVIP）静态普查

- 样本：`acg-helper-2.8.31.16.zip` → 解包 `src/extracted`（Chrome MV3，webpack 打包 + 半压缩）
- 分析方式：纯文本/模块级静态分析（python 3.12 定位 + node v24 模块级执行验证），**未修改 `src/extracted` 任何文件**
- 补丁产物：`build/acghelper-patched/`（由 `tools/static-patchspec.py --apply` 生成）
- 结论一句话：会员锁是**纯客户端**判定 —— 角色白名单硬编码在 webpack 模块 **634**，判定函数在模块 **3078**，账号状态来自 `acghelper.com` 的 GraphQL `getState`，**服务端不下发任何 isVIP 布尔值**，只在 `identities[]` 里下发角色名与到期时间；因此 10 处字节级替换即可全解，无需伪造服务端回包。

---

## 0. 关键坐标速查

| 角色 | webpack 模块 id | 内容 |
|---|---|---|
| 角色白名单定义 | **634** | `WH=["superAdmin","admin","catForever","catVIP"]`、`wM=["superAdmin","admin","catForever"]`、`y8`=角色→中文称号 |
| 白名单再导出 facade | **4707** | `n.d(t,{WH:()=>i.WH,Xy:()=>o.X,wM:()=>i.wM});var i=n(634)` |
| **会员判定器** | **3078** | `mg`=isVIP（用 `WH`）、`BN`=isSuperVIP（用 `wM`） |
| VIP 数值上限常量 | **1965** | `{FREE_NUMBER:3,FREE_MAX_LENGTH:30,MAX_NUMBER:15,VIP_MAX_LENGTH:500}` |
| 账号控制器 | **2898** | `BilibiliAccountController` / `BilibiliHelperAccountController`（`bilibiliHelperAccountController`） |
| 共享 UI 锁组件 | config.js 内 **8285** 的 `E`（导出名 `wn`） | `needVIP` 区块的「点击开通助手会员后使用」遮罩 |
| 遥测 | 无有效实现（见 §E） | 只有 `target:"umami"` 的发送端，SW 内无监听者 |

模块 3078 原文（initBackground.sw.js @100251，变量名随 bundle 变）：

```js
3078:(e,t,n)=>{"use strict";n.d(t,{BN:()=>s,mg:()=>o});var i=n(4707);n(5093);
const o=(e,t=i.WH)=>{if(!e||!e.identities||0===e.identities.length)return!1;const n=Date.now();
return e.identities.map((({name:e,to:i,hasDateTimeLimit:o})=>!(!t.includes(e)||!(i&&i>n)&&o))).filter(Boolean).length>0},
s=e=>o(e,i.wM)}
```

语义（逐字推导）：

```
isVIP(account, roles=WH):
  account 为空 / 无 identities / identities 为空        -> false
  对每个 identity {name,to,hasDateTimeLimit}：
      命中条件 = name ∈ roles  且  ( (to && to > now) || !hasDateTimeLimit )
  任一命中 -> true
isVIP 用 WH（含 catVIP），isSuperVIP 用 wM（不含 catVIP，只 superAdmin/admin/catForever）
```

**关键盲点**：`mg` 只吃 `identities[]`，而服务端并不返回 `isVIP`——`account.isVIP` 是客户端把 `mg()` 结果**写回对象**产生的（§B 三处赋值）。所以把 `mg()` 打成恒真，等于把所有"派生 isVIP"全部打通；剩下的只有"对象本身为 null"这一层（§D 才需要第二条补丁）。

---

## A. 模块 3078 / 634 / 4707 逐 bundle 定位

扫描命令：

```bash
cd D:/AI-Project/逆向统一/acghelper
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/DevTools/Python312/python.exe tools/static-modules.py 3078 4707 634
```

结果（字符偏移，UTF-8 解码后按字符计；`s[...]` 索引）：

| bundle | 模块 3078 | 模块 634 | 模块 4707 | 文件大小 |
|---|---|---|---|---|
| `initBackground.sw.js` | 100251 | 7193 | 122468 | 839049 |
| `js/pages/config.js` | 111955 | 37974 | 119607 | 342800 |
| `js/pages/video.js` | 97910 | 3336 | 319269 | 526883 |
| `js/pages/live.js` | 19677 | 3261 | 24154 | 104092 |
| `js/pages/popup.js` | 13600 | 3487 | 18039 | 98610 |
| `js/pages/message.js` | 12878 | 3261 | 17214 | 40233 |

未出现的 bundle：`js/pages/global.js`、`js/pages/background.js`（offscreen）、`js/components.bundle.js`、`js/vendors.bundle.js`、`notification.sw.js`、`downloader.sw.js` —— 这些文件里 `identities` / `isVIP` 判定函数一律为 0 次（`background.js` 只有 2 处 `isVIP` **入参解构**，见 §C-10）。

判定函数体内那行（每 bundle **恰好 1 处**，可直接 patch）：

```
initBackground.sw.js  100349
js/pages/config.js    112053
js/pages/video.js      98008
js/pages/live.js       19762
js/pages/popup.js      13685
js/pages/message.js    12963
原文: if(!e||!e.identities||0===e.identities.length)return!1;
```

角色白名单模块 634 原文（config.js @37974，含 `y8` 称号表；其它 bundle 被 tree-shake 掉 `y8`）：

```js
634:(e,t,n)=>{"use strict";n.d(t,{WH:()=>i,wM:()=>r,y8:()=>a});
const a={superAdmin:"猫国设计师",admin:"猫国城管",catForever:"猫国大护法",catVIPSuper:"助手猫培育师",
catVIP:"助手猫观察员",catWatcher:"助手猫瞭望者",catVIPHonor:"猫国荣誉市民",
catAirborneCommander:"空降指挥官",catAirbornePilot:"喵营飞行员"},
i=["superAdmin","admin","catForever","catVIP"],r=["superAdmin","admin","catForever"]}
```

模块 4707（`initBackground.sw.js` @122468）只是再导出，**不含**白名单本体：

```js
4707:(e,t,n)=>{"use strict";n.d(t,{WH:()=>i.WH,Xy:()=>o.X,wM:()=>i.wM});var i=n(634),o=(n(5679),n(1965));n(5998)}
```

### A2. 等价实现排查（是否有绕过 3078 的第二套判定）

| 位置 | 代码 | 性质 |
|---|---|---|
| `js/pages/config.js` @100980 | `C&&m&&(C.isVIP\|\|C.isSuperVIP)&&C.identities.length>0?…C.identities.map((e=>{const t=o.y8[e.name],n=e.to>Date.now()\|\|!e.hasDateTimeLimit;…` | **显示**用途（到期日徽章），不是门控；吃的是对象上的 `isVIP` 字段 |
| `js/dynamicModule/OwnerArea.bundle.js` @9160 | `renderCatIdentities=()=>{const{bhAccount:e}=this.context;return e?e.identities.map((e=>{const t=d.y8[e.name],a=e.to>Date.now()\|\|!e.hasDateTimeLimit;…` | 同上，纯显示 |
| `js/pages/config.js` @302340（模块 8285 `E`/`wn`） | `hasLogin:w,isVIP:O,needVIP:x=!1…if(x&&"boolean"===typeof O&&!O)return …"点击开通助手会员后使用"` | **共享 UI 锁**，所有 `needVIP` 区块的唯一遮罩出口 |
| 其余 | 无 `identities[0].name` 直读、无 `role` 字符串比较、无第二套白名单 | — |

**结论**：全工程只有 3078 一处真判定函数（6 份拷贝），没有 inline 的第二套等价实现；`catVIP` / `catForever` / `superAdmin` 字面量只出现在模块 634。

---

## B. `bhAccount` 完整生命周期

### B1. 存储

```js
// initBackground.sw.js @34226 / @34313（BaseStore）
getStore=async(e="default")=>{const t=[this.names.data,e].join("_");return(0,b.NT)(t)}
setStore=async(e="default",t)=>{const n=[this.names.data,e].join("_");await(0,b.Xy)(n,t);…}
```

- 控制器名：`bilibiliHelperAccountController`（`M=new N.y("bilibiliHelperAccountController")`，@81593 附近）
- 因此 bhAccount 落盘的完整 key = **`bilibiliHelperAccountController-data_default`**（`chrome.storage.local`）
- `setStore("default", this.bhAccount)` 出现在 4 处：@71717（旧迁移键清理）、@86026（getState 成功）、@86340（login 成功）、@87741（initBHAccount 成功）

### B2. 服务端接口（GraphQL，`POST https://acghelper.com/g`）

端点构造在 SW @770328（`graphqlController.create`）：

```js
e.url="https://acghelper.com/g"   // ← 全扩展唯一 GraphQL endpoint
const i=await(0,Q.$Q)()||null;
i&&o.append("Uid","ACGHELPER_2.8.31.16 "+i)   // 自定义 Uid 头
o.append("Content-Type","application/json");
e.options.body=JSON.stringify({query:e.options.query.replace(/\s{2,}/g," "),variables:e.options.variables})
```

另有一份 fetch 兜底实现 @786329（模块 6861）：`fetch("https://acghelper.com/g",{method:"POST",headers:i,body:n})`。

**读状态 query**（`getBHAccountState`，SW @85434 区域原文）：

```graphql
query ($blid: BLID!) {
    bilibiliHelperAccount {
        hasRegister(blid: $blid)
        getState {
            bhid
            boundBlid
            email
            identities { name from to hasDateTimeLimit }
        }
    }
}
```

**登录 mutation**（`login`，SW @86791 区域原文）：

```graphql
mutation ($blid: BLID!, $password: String) {
    bilibiliHelperAccount {
        login(blid: $blid, password: $password) { bhid bhName email identities { name from to hasDateTimeLimit } }
    }
}
```

### B3. `identities[]` 字段语义

| 字段 | 类型 | 语义 |
|---|---|---|
| `name` | string | 角色名，取值见模块 634 的 `y8` 键：`superAdmin` / `admin` / `catForever` / `catVIP` / `catVIPSuper` / `catWatcher` / `catVIPHonor` / `catAirborneCommander` / `catAirbornePilot`。**只有前 4 个（WH）算 isVIP，其中前 3 个（wM）算 isSuperVIP** |
| `from` | number (ms epoch) | 权益开始时间。判定函数**不读** `from`，只读 `to` 与 `hasDateTimeLimit` |
| `to` | number (ms epoch) | **到期时间戳**。UI 徽章用它 `dayjs(to).format("YYYY-MM-DD") 到期`；判定用 `to > Date.now()` |
| `hasDateTimeLimit` | boolean | `true`=有期限（必须 `to > now`）；`false`=永久（`to` 被忽略，徽章逻辑 `e.to>Date.now()||!e.hasDateTimeLimit` 同样放行） |

服务端**不下发** `isVIP` / `isSuperVIP` / `role` 字段 —— 这两个布尔值完全是客户端算完写回对象属性的。

### B4. `hasLogin` 的三个来源

1. `login` 成功 → `this.hasLogin=!0`（SW @87705 附近，原文 `await this.setStore("default",this.bhAccount),this.hasLogin=!0`）
2. `getState` 返回非空账号 → `this.bhAccount&&(this.bhAccount.isVIP=…,this.hasLogin=!0,…)`（SW @86237 附近）
3. `accountChanged` 事件携带的 `hasLogin` 字段（页面侧 `this.hasLogin=i`）

`hasLogin` 语义 = **助手账号（acghelper 账号）已登录**，与 B 站登录态是两个字段：
B 站登录态在 `bilibiliAccount`（`bilibiliAccountController`，`localAccount` / `SESSDATA` cookie，`initLocalBilibiliAccount()`）；改 `hasLogin` 不触碰 B 站 cookie 链路。

### B5. `accountChanged` 派发路径（收发两端）

**发**（SW 模块 2898，`emit("*", …)` 广播给所有注册了该事件的控制器）：

```js
await this.emit("*","accountChanged",{hasLogin:this.hasLogin, bilibiliAccount:this.bilibiliAccount?this.bilibiliAccount.toJSON():null,
  downloadingSettings:this.downloadingSettings, hasRegister:this.hasRegister, bhAccount:this.bhAccount})
```
出现在 login 成功（@87741 附近）、B 站登录态变化（@85434 区域）、login 失败清空（@86791 区域）。

广播机制（BaseStore `emit`，SW @33640）：

```js
emit=async(e,t,n,i,o=this)=>{if("*"===e){const e=Array.from(w.loadedItems.values()).map(...emitter.emit(t,n,o,i)...);return Promise.race(e)} …}
```

**收**（基类 `__itemType="feature"`，SW 模块 2771 @53115）：

```js
this.addListener("accountChanged",((e,t,n)=>{if(!e)return;const{hasLogin:i,bhAccount:s,bilibiliAccount:r}=e;
this.hasLogin=i,this.bhAccount=s,this.isVIP=(0,o.mg)(this.bhAccount),this.isSuperVIP=(0,o.BN)(this.bhAccount),
this.bilibiliAccount=r,this.onBHAccountChange(this.bhAccount),n instanceof Function&&n()}))
```

**拉取式（页面用这个）**：页面不发事件订阅，而是发消息要快照 ——

```js
// config.js @137891 / popup.js @86928 / video.js @93856 / live.js @52802
chrome.runtime.sendMessage({target:"bilibiliHelperAccountController",event:"getBHAccount"},e=>{e&&this.setState({bhAccount:e})})
chrome.runtime.sendMessage({target:"bilibiliHelperAccountController",event:"getStatus"},e=>{const{hasLogin:t,…}=e;/*只取 hasLogin 等*/})
```

SW 端两个 handler（模块 2898 `onBeforeLaunch`）：

```js
this.addListener("getStatus",((e,t,n)=>{ … return n({hasLogin:this.hasLogin, bilibiliAccount:…, downloadingSettings:…,
  hasRegister:this.hasRegister, bhAccount:this.bhAccount}),clearInterval(i),!0; … }))
this.addListener("getBHAccount",(async(e,t,n)=>{n(await this.getStore("default"))}))
```

→ **这两个出口就是所有页面拿 `bhAccount` 的唯一通道**，也是 §D 选择伪造点的原因。

---

## C. `isVIP` / `isSuperVIP` 全消费点清单

扫描命令：

```bash
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/DevTools/Python312/python.exe tools/static-consumers.py initBackground.sw.js
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/DevTools/Python312/python.exe tools/static-scan.py uigate
```

标注约定：**RUN**=运行时直接 `return`/跳过逻辑；**UI**=控件灰掉或遮罩。

### C-1 `initBackground.sw.js`（按 controller 归属，控制器名取自 `super(e,"<name>",{…})`）

| # | 偏移 | 控制器 / 模块 | 表达式 | 门控的功能 | 类型 |
|---|---|---|---|---|---|
| 1 | 53115/53124 | 基类 feature（2771）字段初始化 | `isVIP=!1;isSuperVIP=!1` | 初值 | RUN |
| 2 | 53341-53400 | 同上 `accountChanged` | `this.isVIP=(0,o.mg)(this.bhAccount)` / `BN` | 登录态变化时重算 | RUN |
| 3 | 53678-53740 | 同上 `getStatus` 拉取回调 | 同上 | 启动时重算 | RUN |
| 4 | 78446 | `bilibiliAccountController.bind` | `if(e&&(0,i.mg)(t)){…e.length<P&&…}` | **多账号绑定上限**（非 VIP 不给绑第二个 B 站号） | RUN |
| 5 | 86191-86250 | `bilibiliHelperAccountController.getBHAccountState` | `this.bhAccount.isVIP=(0,b.mg)(…)`、`isSuperVIP=…`、`this.hasLogin=!0` | isVIP 写回对象 + 置登录 | RUN |
| 6 | 87648-87710 | 同上 `login` 成功 | 同上（写回 store） | 登录时写回 | RUN |
| 7 | 141321 | `popupMain` 字段初始化 | `isVIP=!1` | 初值 | RUN |
| 8 | 141717-141740 | `popupMain.accountChanged` | `this.isVIP=(0,s.mg)(this.bhAccount)` | 顶栏/菜单 VIP 态 | RUN |
| 9 | 141860 | `popupMain.onBHAccountChange` | `this.bhAccount?this.isVIP=(0,s.mg)(this.bhAccount):this.isVIP=!1` | **bhAccount 为空就把 isVIP 打回 false** | RUN |
| 10 | 141896 / 142052 | `popupMain.requireSection` | `this.settings.sectionShow.length>0&&this.isVIP&&…` | **VIP 专属功能分区裁剪**（`insectSection` 增删 section） | RUN |
| 11 | 164844 | `subscriptionDynamic.createVideoDynamicClock` | `periodInMinutes:this.hasLogin&&(0,J.mg)(…)?this.settings.duration:10` | 动态订阅**推送间隔**（非 VIP 固定 10 分钟） | RUN |
| 12 | 168896 | `subscriptionDynamic.sendNotificationByList` | `if(this.hasLogin&&(0,J.mg)(…))` | 动态订阅**黑/白名单过滤**（UID 级） | RUN |
| 13 | 169488 / 169881 | 同上 | `"merge"===i&&…mg(…)` / `"theLatestThree"===i&&…mg(…)` | 动态**合并推送 / 只推最新三条** | RUN |
| 14 | 174460 | `bilibiliLiveBroadcast.createLiveClock` | `periodInMinutes:…mg(…)?duration:10` | 开播提醒**推送间隔** | RUN |
| 15 | 176848 | `bilibiliLiveBroadcast.sendNotification` | `if(!t||"off"===n||!this.hasLogin)return;…(0,s.mg)(…)&&(o?…` | 开播提醒**黑白名单** | RUN |
| 16 | 179189 | `bilibiliMessage.onAfterSetSetting` | `!t.on&&e\|\|!this.isVIP?this.pause():…` | 站内消息提醒开关 | RUN |
| 17 | 180586 / 180716 | `bilibiliMessage.createBilibiliMessageClock` | `(0,s.mg)(…)&&(this.emit("clockController","create"…))` | 消息轮询定时器 | RUN |
| 18 | 182942 | `bilibiliMessage.onAfterSetSettingsFromCloud` | `this.isVIP\|\|(this.settings.on=!1,this.pause())` | **云同步设置回来时非 VIP 直接关掉推送** | RUN |
| 19 | 185552 | `videoShortcuts.onBHAccountChange` | `this.bhAccount&&(0,s.mg)(…)‖this.reset()` | **自定义快捷键**：非 VIP 直接 reset | RUN |
| 20 | 192212 / 193758 / 194410 / 195011 / 196387 / 196799 / 197457 | `incognito` | `this.isVIP?…:pause()` / `addRules:…&&this.isVIP?[rule]:void 0` | **直播无痕模式**（declarativeNetRequest 改 Cookie / Referer 规则） | RUN |
| 21 | 200390 | `liveRecord.onBHAccountChange` | `this.isVIP?…:await this.pause()` | **直播录制**总开关 | RUN |
| 22 | 202949 / 202962 | `liveRecord.getFLVRecording` | `(!this.isVIP&&!this.isSuperVIP&&l.recordTime>=600‖…)` | **直播录制 600 秒上限**（FLV 路径） | RUN |
| 23 | 207422 / 207435 | `liveRecord.writeM4SData` | 同上 | **直播录制 600 秒上限**（M4S/MP4 路径） | RUN |
| 24 | 370506 | `liveShortcuts.onBHAccountChange` | `this.bhAccount&&(0,s.mg)(…)‖this.reset()` | **直播页快捷键自定义** | RUN |
| 25 | 557200 | `customWhisperMessage.getMessages` | `!(!this.isVIP&&t>pn.Xy.FREE_NUMBER)&&e` | **自定义快捷短语条数**（免费 3 条 / VIP 15 条，`1965.FREE_NUMBER=3`、`MAX_NUMBER=15`） | RUN |
| 26 | 557383 | `customWhisperMessage.setMessage` | `o=this.isVIP?o.substring(0,pn.Xy.VIP_MAX_LENGTH):o.substring(0,pn.Xy.FREE_MAX_LENGTH)` | **短语字数**：免费 30 / VIP 500 | RUN |
| 27 | 557642 | 同上 | `this.isVIP\|\|this.messages.length<pn.Xy.FREE_NUMBER` | 新增条数上限判定 | RUN |
| 28 | 564523 | `renameDownloadFile.onBHAccountChange` | `this.bhAccount&&(0,s.mg)(…)‖await this.reset()` | **下载文件重命名规则**（自定义文件名模板） | RUN |

> 注：SW 内 `sendPaymentMessage` 出现 0 次 —— 它只是**页面侧** context 方法（§C-2 #5），SW 从不主动弹付费窗。

### C-2 `js/pages/config.js`（设置页，21 处 `needVIP` 区块 + 16 处 inline 判定）

inline 判定（`!!t && t["isVIP"]` 形态，**bhAccount 为 null 时同样关闭**）：

| # | 偏移 | 原文片段 | 功能 | 类型 |
|---|---|---|---|---|
| 1 | 5607 | `if(5===t&&(!e\|\|!e.isVIP))return this.context.sendPaymentMessage()` | 动态**推送间隔**只能选 1/5/10/20/30（5 分钟需 VIP） | UI |
| 2 | 7063 | `return n?e\|\|t&&t.isVIP?void …:i():a()` | 站内消息提醒开关 | UI |
| 3 | 7462 | `return a?e\|\|n&&n.isVIP?void …:r():i()` | 语音播报开关 | UI |
| 4 | 9964 | `n=!!t&&t["isVIP"];if(!e&&!n)return this.context.sendPaymentMessage()` | 动态**视频黑名单** | UI |
| 5 | 10338 | 同上 | 动态**标题文字黑名单** | UI |
| 6 | 10951 | `n=!!e&&e["isVIP"];if(!n)return this.context.sendPaymentMessage()` | 开播提醒**推送间隔** | UI |
| 7 | 11866 | `if(!e&&!n)return this.context.sendPaymentMessage()` | 开播提醒**黑名单** | UI |
| 8 | 14480 | `K=!!z&&z["isVIP"]` | 消息推送设置整页（`K` 传给每个 `wn` 的 `isVIP`） | UI |
| 9 | 50769 | `k=!!n&&n["isVIP"]` | 动态过滤（`dynamicFilter`） | UI |
| 10 | 54197 | `y=!!n&&n["isVIP"],S=y?200:20` | **用户过滤名单条数**：免费 20 / VIP 200 | UI |
| 11 | 56506 | `h=!!n&&n["isVIP"],g=…(h\|\|!h&&r)&&…` | 评论过滤（`commentFilter`） | UI |
| 12 | 67680 | `if(!t\|\|!t.isVIP)return this.context.sendPaymentMessage()` | **快捷键自定义**（按下输入框前拦截） | UI |
| 13 | 69838 | `if(!e&&!n)return this.context.sendPaymentMessage()` | 默认倍速范围自定义 | UI |
| 14 | 73544 | `I=!!A&&A["isVIP"]` | 主站功能页（`M=` / `I` 下发到各 `wn`） | UI |
| 15 | 87666 | `f=!!t&&t["isVIP"]` | 直播区功能页（无痕/自动画质等） | UI |
| 16 | 276917 | `i=a?.["isVIP"];n&&i&&…` | 弹窗**视频打开方式**自定义 | UI |
| 17 | 278171-278180 | `…\|\|t&&t.isVIP&&t.isSuperVIP?…` | **自定义导航**条数上限必须 VIP+SuperVIP 才能突破 10 条 | UI |
| 18 | 281789 | `P=!!I&&I["isVIP"]` | 应用程序弹窗设置（列数/卡片样式） | UI |
| 19 | 330935 | `…\|\|t&&t.isVIP?…` | 自定义快捷短语条数 | UI |
| 20 | 331474 / 332837 | `r=!!i&&i["isVIP"],o=r?b:f` | 短语**字数上限**（`f` 免费 / `b` VIP） | UI |
| 21 | 334233 | `E=!!h&&h["isVIP"]` | 大会员相关（自动领福利/推送） | UI |
| 22 | 100980 / 101888 / 103089 | `(C.isVIP\|\|C.isSuperVIP)` | 账号卡片徽章 / 「续订会员」按钮文案 / `v` 组件 `isVIP` prop | UI（显示） |

`sendPaymentMessage` 定义（config.js @134579）：

```js
sendPaymentMessage:()=>{this.state.states&&this.state.states.paymentIframeNew?this.state.handleOnClickShowPaymentModal():
  o.QB.info(l.createElement(I,null,"系统状态异常，请稍后重试或",l.createElement("a",{href:"https://message.bilibili.com/#/whisper/mid1344117169",…},"私信助手猫")))}
```

→ 本质是 `states.paymentIframeNew` 为真时弹付费 iframe。

**共享 UI 锁组件**（模块 8285，`wn`，config.js @302340）—— 21 个 `needVIP` 区块的唯一遮罩出口：

```js
E=e=>{const{handleOnClickShowPaymentModal:t,…}=(0,i.useContext)(h.T),{active:r,title:o,…,helperArea:C,
hasLogin:w,isVIP:O,needVIP:x=!1,canCollapsed:k=!1,…}=e,…
P=(0,i.useCallback)((()=>{if("boolean"===typeof w){if(!w){const e=f?n:a;
    return i.createElement(v,null,i.createElement(u.sL,{onClick:e},x?"会员功能，":"","点击登录后使用"))}
  if(x&&"boolean"===typeof O&&!O)return f?i.createElement(v,null,i.createElement(u.sL,null,"火狐浏览器暂不提供付费功能"))
    :i.createElement(v,null,i.createElement(u.sL,{onClick:t},"点击开通助手会员后使用"))}
  return null}),[w,O,x,t,n,a]);…}
```

### C-3 `js/pages/video.js`

| 偏移 | 表达式 | 功能 | 类型 |
|---|---|---|---|
| 43479 / 43502 | `e?.hasLogin&&e?.bhAccount&&p(e.hasLogin&&((0,T.mg)(e.bhAccount)\|\|(0,T.BN)(e.bhAccount)))` | 播放页是否启用**高级下载器 UI**（`advanced`） | RUN |
| 86924 / 86971 | `this.setState({isVIP:!!e.hasLogin&&(0,T.mg)(e.bhAccount),isSuperVIP:…})` | 播放页 VIP 态注入 | RUN |
| 505702 / 506209 | `(!o\|\|o&&!(0,l.mg)(o))&&(e=.25,r=!0)` | **倍速微调粒度**：非 VIP 强制 0.25 + 默认范围 | RUN |

### C-4 `js/pages/popup.js`

| 偏移 | 表达式 | 功能 | 类型 |
|---|---|---|---|
| 84535 / 84606 | `setVIPState:()=>this.state.states&&(0,c.mg)(this.state.bhAccount)` | 弹窗 VIP 态（供 context 下发） | RUN |
| 85310 | `this.setState({videoOpenMethod:()=>this.state.isVIP&&e?e.videoOpenMethod:"direct",…})` | 打开方式被 `isVIP` 卡住 | RUN |
| 103089 附近（弹出菜单） | `…t&&t.isVIP&&t.isSuperVIP?…` | 自定义导航 10 条上限 | UI |

### C-5 `js/pages/live.js`

| 偏移 | 表达式 | 功能 | 类型 |
|---|---|---|---|
| 52802 | `e&&e.hasLogin&&e.bhAccount&&(A(e.hasLogin),M((0,o.mg)(e.bhAccount)))` | 直播页 VIP 态 | RUN |
| 51111 | `chrome.runtime.sendMessage({to:"offscreen",target:"liveRecord",command:"startRecord",…,isVIP:I})` | **把 isVIP 透传给 offscreen 录制器**（`isSuperVIP` **没有**传） | RUN |
| 74412 | `e&&e.hasLogin&&e.bhAccount&&(g(e.hasLogin),b((0,c.mg)(e.bhAccount)))` | 无痕模式 VIP 态 | RUN |

### C-6 `js/pages/message.js`
本 bundle 只有模块 3078 本体（@12878），无独立消费点；消息中心功能门控全部在 SW 的 `bilibiliMessage`（§C-1 #16-18）。

### C-7 `js/pages/background.js`（offscreen 录制器）
`ui`/`fi`（@88527 / @89932）从消息里解构 `{isVIP:d,isSuperVIP:h}` 并写进模块级 `ti`/`ii`：

```js
(!ti&&!ii&&c.recordTime>=600||c.disconnected&&c.refreshTime>=c.refreshMaxTime)&&(c.stop=!0,…)
```

→ 600 秒上限的**第三处**实现（与 SW 的两处同源）。因为 live.js 只传 `isVIP`、不传 `isSuperVIP`（`ii=undefined`），所以只要 `mg()` 恒真让 `isVIP=true`，这里就整体放行。

---

## D. 最小改动集 patch 规格（10 处，全部字节级唯一）

### D1. 方案选择（对应交付要求 ②）

**选择「在 `getStatus` / `getBHAccount` 出口伪造合法 bhAccount 对象」+「mg() 恒真」**，理由：

1. 页面拿 `bhAccount` 的**唯一通道**就是这两个消息出口（§B5），一处伪造全站生效；inline 的 `!!t&&t["isVIP"]` 有 30+ 处，逐个改 UI 判据既易漏又会被后续分支（`t.isSuperVIP`、`t.identities.length`）打回；
2. `!!t` 的失败根因是 `bhAccount === null`（未登录助手账号），**只改判定函数解决不了**——必须让对象存在；
3. 伪造对象同时满足三件事：`isVIP/isSuperVIP === true`（门控）、`identities[]` 非空且 `to > now`（徽章渲染 `y8[name]` + 到期日、`isVIP||isSuperVIP)&&identities.length>0` 分支）、`bhid/bhName` 有值（账号卡片不显示"尚未登录"）；
4. 顺带把 `hasLogin` 置真（页面侧 `hasLogin` 是助手账号登录态，与 B 站登录态 `bilibiliAccount` 无关），否则 `n?e||t&&t.isVIP?…:a()` 这类三元仍会弹登录框。

**不采用的方案**：逐个改 30+ 处 inline `!!t&&t["isVIP"]` —— 非最小、且 `needVIP` 遮罩由独立组件控制（§C-2 末尾），改判据也盖不住它。

### D2. 补丁表

> 偏移为**原始文件**字符偏移（UTF-8 解码后字符索引，与 `python` `str.find` 一致）。
> 全部 old 串已用 `s.count(old)==1` 校验通过。

| # | 文件 | 偏移 | 原始字符串（old） | 替换字符串（new） | 影响 |
|---|---|---|---|---|---|
| P1 | `initBackground.sw.js` | 100349 | `if(!e||!e.identities||0===e.identities.length)return!1;` | `if(1)return!0;` + 原串 | 模块 3078 `mg()` 恒真 → SW 内全部 `(0,X.mg)(bhAccount)` 与 `BN()`（委托 mg）恒真 |
| P2 | `js/pages/config.js` | 112053 | 同上 | 同上 | 配置页 `mg()/BN()` 恒真（`useContext` 侧 `isVIP` 计算） |
| P3 | `js/pages/video.js` | 98008 | 同上 | 同上 | 播放页注入脚本 `mg()/BN()` 恒真（含倍速粒度逻辑） |
| P4 | `js/pages/live.js` | 19762 | 同上 | 同上 | 直播页 `mg()` 恒真（无痕 / 录制透传） |
| P5 | `js/pages/popup.js` | 13685 | 同上 | 同上 | 弹窗页 `mg()/BN()` 恒真 |
| P6 | `js/pages/message.js` | 12963 | 同上 | 同上 | 消息中心 `mg()/BN()` 恒真 |
| P7 | `js/pages/config.js` | 302938 | `if(x&&"boolean"===typeof O&&!O)return` | `if(!1)return` | 共享锁组件 `wn`：21 个 `needVIP` 区块**不再渲染「点击开通助手会员后使用」遮罩**；登录检查分支（`if(!w)`）保留不动 |
| P8 | `initBackground.sw.js` | 82443 | `return n({hasLogin:this.hasLogin,bilibiliAccount:this.bilibiliAccount?this.bilibiliAccount.toJSON():null,downloadingSettings:this.downloadingSettings,hasRegister:this.hasRegister,bhAccount:this.bhAccount})` | `return n({hasLogin:!0,bilibiliAccount:…同原…,downloadingSettings:…,hasRegister:!0,bhAccount:this.bhAccount\|\|{bhid:0,bhName:"ACG-VIP",email:"",identities:[{name:"catVIP",from:0,to:Date.now()+31536e7,hasDateTimeLimit:!1}],isVIP:!0,isSuperVIP:!0}})` | `getStatus` 回包：`hasLogin` 恒真 + `bhAccount` 为 null 时补合成会员对象 |
| P9 | `initBackground.sw.js` | 83023 | `n(await this.getStore("default"))` | `n({...(await this.getStore("default")\|\|{bhid:0,bhName:"ACG-VIP",email:"",identities:[{name:"catVIP",from:0,to:Date.now()+31536e7,hasDateTimeLimit:!1}],isVIP:!0,isSuperVIP:!0}),isVIP:!0,isSuperVIP:!0,identities:[{name:"catVIP",from:0,to:Date.now()+31536e7,hasDateTimeLimit:!1}]})` | `getBHAccount` 回包：**所有页面**的 `bhAccount` 一定非空且 `isVIP/isSuperVIP=true`，`identities[0].to` 永久有效 |
| P10 | `initBackground.sw.js` | 142216 | `this.bhAccount?this.isVIP=(0,s.mg)(this.bhAccount):this.isVIP=!1` | `this.isVIP=!0` | 基类 `onBHAccountChange`：`bhAccount` 为空时不再把 `isVIP` 打回 false（拦 `popupMain` / `liveRecord` / `incognito` 等继承者的 `pause()`） |

**为什么 P1 的 new 里保留原串**：`if(1)return!0;` 是常量早退，后面原逻辑成为死代码，既不改动原语义结构、也不影响源码映射；old 串 48 字节，6 份拷贝全部唯一。

**byte 唯一性校验命令（交付要求原文）**：

```bash
cd D:/AI-Project/逆向统一/acghelper
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/DevTools/Python312/python.exe tools/static-patchspec.py
```

输出（实测）：

```
OK  initBackground.sw.js           1  'if(!e||!e.identities||0===e.identities.length)return!1;'  offs=[100349]
OK  js/pages/config.js             1  'if(!e||!e.identities||0===e.identities.length)return!1;'  offs=[112053]
OK  js/pages/config.js             1  'if(x&&"boolean"===typeof O&&!O)return'  offs=[302924]
OK  js/pages/video.js              1  'if(!e||!e.identities||0===e.identities.length)return!1;'  offs=[98008]
OK  js/pages/live.js               1  'if(!e||!e.identities||0===e.identities.length)return!1;'  offs=[19762]
OK  js/pages/popup.js              1  'if(!e||!e.identities||0===e.identities.length)return!1;'  offs=[13685]
OK  js/pages/message.js            1  'if(!e||!e.identities||0===e.identities.length)return!1;'  offs=[12963]
OK  initBackground.sw.js           1  'return n({hasLogin:this.hasLogin,bilibiliAccount:this.bilibi'  offs=[82443]
OK  initBackground.sw.js           1  'n(await this.getStore("default"))'  offs=[82911]
OK  initBackground.sw.js           1  'this.bhAccount?this.isVIP=(0,s.mg)(this.bhAccount):this.isVI'  offs=[141845]
ALL UNIQUE
```

> 说明：P7/P10 的偏移在 `--apply` 报告里会往后挪（302938 / 142216），因为同一文件内先应用的补丁改变了后续偏移；唯一性校验用**原始文件**偏移，应用顺序与报告以 `--apply` 输出为准。

### D3. 应用与验证

```bash
cd D:/AI-Project/逆向统一/acghelper
# 1) 唯一性校验（只读）
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/DevTools/Python312/python.exe tools/static-patchspec.py
# 2) 应用补丁到副本（不碰 src/extracted）
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/DevTools/Python312/python.exe tools/static-patchspec.py --apply
# 3) 模块级执行验证（node 24）
"C:/Program Files/nodejs/node.exe" tools/static-verify.mjs
```

`--apply` 输出：

```
applied 10 patches -> D:\AI-Project\逆向统一\acghelper\build\acghelper-patched
  initBackground.sw.js @100349  模块3078 mg() 恒真 …
  js/pages/config.js @112053    模块3078 mg() 恒真（配置页）
  js/pages/config.js @302938    配置页共享锁组件：needVIP 区块不再渲染会员遮罩（登录检查保留）
  js/pages/video.js @98008 …  live.js @19762 …  popup.js @13685 …  message.js @12963 …
  initBackground.sw.js @82443   getStatus 回包 …
  initBackground.sw.js @83023   getBHAccount 回包 …
  initBackground.sw.js @142216  基类 onBHAccountChange …
```

`static-verify.mjs` 的做法：按 webpack 模块头切出模块 634 / 3078，用 `new Function(形参名…)` 在隔离沙箱里实例化，并实现 `n.d/getter` 语义；对同一个样本的**原始 vs 补丁**各跑 8 个用例。

实测输出：

```
=== ORIGINAL 未补丁
    PASS  mg(null)=false / mg({})=false / mg({identities:[]})=false / mg(catVIP过期)=false
    PASS  mg(普通用户)=false / mg(catVIP有效)=true / BN(null)=false / BN(catForever有效)=true
    => 8 pass / 0 fail                     ← 原逻辑确实在拦
=== PATCHED 已补丁
    PASS  mg(null)=true  mg({})=true  mg({identities:[]})=true  mg(catVIP过期)=true
    PASS  mg(普通用户)=true  mg(catVIP有效)=true  BN(null)=true  BN(catForever有效)=true
    => 8 pass / 0 fail                     ← 恒真
=== getBHAccount / getStatus 回包验证
    PASS  getBHAccount(store=null)  -> isVIP=true isSuperVIP=true identities=[{name:"catVIP",to:…}]
    PASS  getBHAccount(store=real)  -> isVIP=true …
    PASS  getStatus(bhAccount=null) -> hasLogin=true bhAccount=合成对象
    PASS  getStatus(bhAccount=real) -> hasLogin=true bhAccount=真实对象（不覆盖）
=== 总结
  未补丁 mg/BN：8/8 符合原生逻辑
  已补丁 mg/BN：8/8 全部 true
  回包伪造：   4/4 pass
  跨 bundle：  6/6 通过
  RESULT: PASS
```

**成功判据**（按交付要求）：`RESULT: PASS`（mg/BN 补丁后 8/8 true；6 个 bundle 一致；回包 4/4）。

字节级 diff 自检（证明只改了预期位置，无意外偏移）：

```bash
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/DevTools/Python312/python.exe - <<'PY'
import os
A=r"D:\AI-Project\逆向统一\acghelper\src\extracted"
B=r"D:\AI-Project\逆向统一\acghelper\build\acghelper-patched"
for rel in ["initBackground.sw.js","js/pages/config.js","js/pages/video.js","js/pages/live.js","js/pages/popup.js","js/pages/message.js"]:
    a=open(os.path.join(A,rel),"rb").read(); b=open(os.path.join(B,rel),"rb").read()
    i=0
    while i<min(len(a),len(b)) and a[i]==b[i]: i+=1
    print(rel, "delta=", len(b)-len(a), "首差@", i)
PY
```

实测：`initBackground.sw.js delta=+320 首差@82462`、`config.js delta=-11`、`video/live/popup/message delta=+14`。

### D4. 失败分支

| 现象 | 原因 | 改法 |
|---|---|---|
| 页面仍显示"尚未登录"，`bhAccount` 仍为 null | 只打了 P1-P6（mg 恒真），没打 P8/P9 | 补 P8、P9；注意 P9 是**唯一**给页面发 `bhAccount` 的出口 |
| 设置页仍有"点击开通助手会员后使用"遮罩 | 只改判据没改共享锁组件 | 补 P7（`if(!1)return`） |
| 直播录制仍在 600 秒停 | SW 内 `liveRecord` 的 `this.isVIP` 被 `onBHAccountChange` 打回 false | 必须打 P10；`!this.isVIP&&!this.isSuperVIP` 两处（@202949/@207422）都吃这个字段 |
| 打补丁后扩展报 "Service worker registration failed" | old 串跨了引号/转义被改坏，或把 `if(1)return!0;` 插到了字符串里 | 用 `tools/static-patchspec.py` 的 `--apply`，不要手工替换；`s.count(old)` 非 1 时脚本直接 `assert` 失败 |
| 想回滚 | — | 见 D5 |

### D5. 回滚与清理

```bash
# 源码样本永远只读，回滚 = 丢弃副本
rm -rf "D:/AI-Project/逆向统一/acghelper/build/acghelper-patched"
# 重新生成干净副本
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/DevTools/Python312/python.exe tools/static-patchspec.py --apply
```

补丁报告：`build/acghelper-patched/_patch-report.json`（含 file / offset / 旧长 / 新长 / 说明）。

---

## E. 完整性 / 遥测排查

| 项 | 结论 | 证据 |
|---|---|---|
| CRX 自校验 | **无**。无 `crypto.subtle` / `digest` / 文件哈希比对（全 6 个主 bundle 扫描均为 0） | `grep -c "crypto.subtle"` → 0 |
| `chrome.runtime.getManifest()` | 存在 6 处，**都不是完整性校验**：<br>① `initBackground.sw.js @105080`（模块 3432）`let c=()=>chrome.runtime.getManifest?chrome.runtime.getManifest():null` — 只取 version/UA 信息；<br>② `@744364` `const{permissions:e}=chrome.runtime.getManifest(); e.forEach(...)` — 读自身权限做权限面板；<br>③ 各页面 bundle 各 1 处，用于显示版本号 | 见 §D1 之外的第 3 条扫描 |
| 版本比对 | 只有"提示更新"，**不阻断**：`dealWithStateData` 里 `this.shouldUpdate=(0,o.Yo)(this.states.minVersion,o.rE)>0`、`this.needUpdate=(…latestVersion…)>0`（SW @714580 区域），配合 `popup.js @78504` 的"跳过更新"按钮 | GraphQL `app.get(names:[latestVersion,publishState,minVersion,paymentLink,paymentIframeNew])` |
| `update_url`（自动更新） | manifest 里**没有** `update_url` 字段 | `src/extracted/manifest.json` 全文 248 行 |
| GA / googletagmanager | **CSP 放行但代码里零引用**：`manifest.json` `content_security_policy.extension_pages` 含 `script-src-elem 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com`，但 `.js`/`.html` 里 `gtag(` / `googletagmanager` / `google-analytics` 命中 **0**；`html/` 目录也没有 GA `<script>`。SW 里唯一一处 `this.emit("googleAnalytics","send",{…hitType:"event",category:"notification_by_web_api",action:"open_notification"})`（@761689）**没有对应控制器监听**（SW 内 `googleAnalytics` 只出现 1 次 = 这行 emit 本身）→ 死代码 | `tools/static-scan.py telemetry` |
| 实际埋点 = umami（且已失效） | 页面侧共 ~70 处 `chrome.runtime.sendMessage({target:"umami",event:"send"/"sendPage",hitType,category,action,label})`（config 17 / popup 16 / video 9 / live 6 / dynamicModule 各 1-6），**但 SW 里 `"umami"` 出现 0 次**，无 `new X.y("umami")` 控制器 → 消息无接收者，静默丢弃 | `grep -c umami` 结果：SW=0，config.js=17，popup.js=16 |
| 上报内容是否含 isVIP | **不含**。所有 umami 事件的字段只有 `hitType / category / action / label`（label 是菜单名、uid、视频标题等），`sendPage` 只带 `pathname`；没有任何事件把 `isVIP` / `isSuperVIP` / `identities` 放进 payload | 逐条 dump（见 `docs/_raw/*.txt`） |
| 云同步是否上传 VIP 态 | **不上传**。`getSettingsForUpload` 只传 `{settings: this.simplifyConfig(this.settings)}`（+ `stores`），`settings` 里只有功能开关；`isVIP` 是控制器实例字段不参与序列化 | SW @182942 / @197457 / @557200 区域 |
| 服务端能否感知客户端 VIP 篡改 | 从静态代码看**不能**：`isVIP` 不参与任何上行请求；`Uid` 头只带 `ACGHELPER_2.8.31.16 <本地 uid>`；`getState` 是只读 query | §B2 |
| 结论 | **E 项全部无需处理**；补丁不触发任何自校验、不上报 VIP 状态 | — |

---

## F0. 与协议分析角色的合并方式（避免互相踩偏移）

- 本角色产物目录：`build/acghelper-patched/`（`tools/static-patchspec.py --apply` 生成，含 `_patch-report.json`）
- 协议角色产物目录：`output/patch-2.8.31.16/`（`tools/proto-apply-patches.py`）—— 两者互不覆盖
- **合并要点**：本报告的 10 条 patch 在 `static-patchspec.py --apply` 里是**按字符串 `find` 定位**，不是按硬编码偏移；即使协议角色的补丁先插入了字节、导致 config.js / video.js 的偏移整体后移，本补丁仍能正确落点（只要 `s.count(old)==1` 仍成立）。建议合并顺序：先协议链路（下载/PGC），再跑 `static-patchspec.py`（它基于 `src/extracted` 全量复制，若要与协议补丁合并，请把 PATCHES 列表对协议角色产出的目录再 `--apply` 一次，或直接用 `_patch-report.json` 里的 old/new 逐条套用）。
- 若两边都改 `js/pages/config.js`：本角色只动 112053（模块 3078 判定行）与 302924（锁组件 `wn` 分支），协议角色的门控点在下载相关模块，偏移不重叠。

## F. 未解 / 留给其它角色的问题

1. `bilibiliAccountController.bind` 的 `P` 常量（多账号绑定上限）未取值 —— 属 B 站多账号链路，不在本地授权层范围。
2. `paymentIframeNew` / `paymentLink` 的具体值由服务端 `app.get` 下发，静态不可知；P7 之后付费 iframe 入口仍在（`sendPaymentMessage` 未改），只是不再被锁组件触发。
3. 下载链路（`videoDownload` 的 `advanced` 形态、PGC 番剧）与 `pgc` 相关判定在协议分析角色范围内，本报告只覆盖到 `video.js` 的 `isVIP` 消费点。
