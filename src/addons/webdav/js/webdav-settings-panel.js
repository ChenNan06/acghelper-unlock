/* =============================================================================
 * ACGhelper WebDAV 云同步 —— 设置页内嵌「同步」栏（html/config.html 末尾加载）
 *
 * 目标：不做独立页面、不做浮动入口，把同步设置长在官方设置页里，作为左侧导航的
 *       一个普通栏目：点头部导航里的「同步」，右侧内容区就是同步设置。
 *
 * 实现路线（为什么不改 React bundle）：
 *   设置页是 js/pages/config.js（342 KB，React + styled-components）编译产物。
 *   改它 = 重打包 + 全站回归，风险与收益不成比例。所以走 **DOM 注入**：
 *     ① 导航项：深克隆原生 `.aside-item` 节点（连带 sc-* 类名与 ripple 层），
 *        只换按钮文案 → 字号/颜色/圆角/hover/选中态天然与相邻项逐像素一致；
 *     ② 内容区：自建 DOM + 自己的样式表，但每个数值都来自 getComputedStyle 读出的
 *        原生控件实测值（见 docs/webdav-settings-panel.md §侦察），并在挂载时
 *        再从原生节点读一遍覆盖 CSS 变量 —— 原生主题一变，这里跟着变；
 *     ③ 同步核心完全复用 js/webdav-core.js（MKCOL / PUT / GET 回读 sha256 /
 *        逐控制器采集 / setSettingsFromCloud 回填 / alarm / 历史快照），本文件不重写传输。
 *
 * 与 React 共存的约定：
 *   * 只往 <aside><ul> 里 append 一个自己的导航项，往 <main> 里 append 一个自己的内容块；
 *   * React 若在重渲染时把这两个节点冲掉，MutationObserver 会补回来（状态在 JS 里，不依赖 DOM）；
 *   * 点原生导航项 → 自动退出同步栏（把内容区的 display 还原、把自己的 active 去掉），
 *     不拦原生事件的默认行为，不改任何原生节点属性（除了临时的 display）。
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__ACG_WEBDAV_SETTINGS_PANEL__) return;
  window.__ACG_WEBDAV_SETTINGS_PANEL__ = true;

  var core = self.ACHWebDAV;
  if (!core) {
    // 核心库没载入就当自己不存在：设置页照常工作，绝不因为同步功能报错
    try { console.warn('[webdav] webdav-core.js 未载入，设置页「同步」栏跳过注入'); } catch (e) { /* ignore */ }
    return;
  }

  /* --------------------------------------------------------------- 常量与状态 */

  var NAV_ID = '__acg_sync_nav__';
  var NAV_TEXT = '同步';
  var PANEL_ID = '__acg_sync_panel__';
  var CSS_ID = '__acg_sync_css__';
  var MARK_ATTR = 'data-acg-sync-hidden';

  // 插在哪个原生导航项后面（依次尝试）。找不到就退化为追加到末尾。
  var ANCHOR_TEXTS = ['全局', '消息推送', '下载', '其他'];

  var S = {
    active: false,
    mounted: false,
    cfg: null,
    scope: null,
    desc: null,
    st: null,
    alarm: null,
    history: [],
    log: [],
    busy: false,
    confirmDownloadUntil: 0,
    confirmRestoreUntil: 0,
    lastTest: null,
    lastTestAt: 0,
    diff: null
  };

  /* 构建期的元素查找：buildPanel() 造节点时面板还没挂进文档，
   * 这时 document.getElementById 一律返回 null（监听器会一个都绑不上）。
   * 所以构建期间先在「正在构建的 root」里找，挂载之后才走 document。 */
  var buildingRoot = null;
  function $(id) {
    if (buildingRoot) {
      var scoped = buildingRoot.querySelector ? buildingRoot.querySelector('[id="' + id + '"]') : null;
      if (scoped) return scoped;
    }
    return document.getElementById(id);
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function tstr(d) {
    d = d || new Date();
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }
  function fmtTime(iso) {
    if (!iso) return '-';
    try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return iso; }
  }
  function shortSha(s) { return s ? String(s).slice(0, 16) + '…' : '-'; }

  /* ------------------------------------------------------------------ 样式表 */

  /* 每个数值的来源见 docs/webdav-settings-panel.md §侦察（logs/webdav-settings-recon*.json）。
   * 变量前缀 --acg-* 会在挂载时用原生节点的 getComputedStyle 复写一次。 */
  function cssText() {
    return [
'#__acg_sync_panel__{',
'  display:none; width:100%; box-sizing:border-box; color:#000;',
'  font-family:Cereal,"PingFang SC","Microsoft YaHei",system,-apple-system,".SFNSDisplay-Regular",HelveticaNeue,LucidaGrande,"Hiragino Sans GB","sans-serif";',
'  font-size:12px; line-height:normal;',
'}',
'#__acg_sync_panel__.acg-on{display:block}',
'#__acg_sync_panel__ h2{font-size:var(--acg-h2-size,18px);font-weight:var(--acg-h2-weight,700);margin:0 0 12px;color:#000}',
'#__acg_sync_panel__ .acg-sec{margin:0 0 4px}',
'#__acg_sync_panel__ .acg-sec-hd{font-size:13px;font-weight:400;color:#000;padding:11px 0 7px}',
'#__acg_sync_panel__ .acg-sec-bd{padding:0 12px 8px 0}',

/* 行：左标题 + 右控件，与原生 .header 同构（flex row / align center / 右侧 toolbar） */
'#__acg_sync_panel__ .acg-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:35px;padding:6px 0;border-top:1px solid #f0f0f0}',
'#__acg_sync_panel__ .acg-sec-bd>.acg-row:first-child{border-top:0}',
'#__acg_sync_panel__ .acg-lbl{flex:1 1 auto;min-width:0}',
'#__acg_sync_panel__ .acg-lbl>p{margin:0;font-size:var(--acg-title-size,14px);color:var(--acg-title-color,#000);display:flex;align-items:center;gap:6px}',
'#__acg_sync_panel__ .acg-lbl>p+p,#__acg_sync_panel__ .acg-desc{margin:2px 0 0;font-size:var(--acg-desc-size,12px);color:var(--acg-desc-color,#424242);display:block}',

/* 输入框：原生 input.input —— 32 高 / 1px #ccc / 6 圆角 / 13.3333px */
'#__acg_sync_panel__ .acg-ctl{flex:0 0 auto;display:flex;align-items:center;gap:8px}',
'#__acg_sync_panel__ .acg-input{height:32px;box-sizing:border-box;width:200px;padding:0 12px;font-size:var(--acg-input-size,13.3333px);font-family:inherit;color:#000;background:#fff;border:1px solid var(--acg-input-border,#ccc);border-radius:var(--acg-input-radius,6px);outline:none;transition:border-color .15s linear}',
'#__acg_sync_panel__ .acg-input.acg-wide{width:340px}',
'#__acg_sync_panel__ .acg-input:focus{border-color:#FB7299}',
'#__acg_sync_panel__ .acg-input[type=password]{letter-spacing:.08em}',

/* 下拉：原生 select —— 32 高 / 1px #eee / 6 圆角 / 12px / appearance:none + 自绘箭头 */
'#__acg_sync_panel__ .acg-select{height:32px;box-sizing:border-box;width:180px;padding:0 28px 0 12px;font-size:var(--acg-select-size,12px);font-family:inherit;color:#000;background:#fff;border:1px solid var(--acg-select-border,#eee);border-radius:var(--acg-select-radius,6px);appearance:none;-webkit-appearance:none;outline:none;cursor:pointer;',
'  background-image:url("data:image/svg+xml;charset=utf8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'%3E%3Cpath d=\'M0 0l5 6 5-6z\' fill=\'%23757575\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}',
'#__acg_sync_panel__ .acg-select:focus{border-color:#FB7299}',

/* 开关：原生 40×22 / radius 20 / 关 #bdc1c6 / 开 #FB7299 / knob 18×18 */
'#__acg_sync_panel__ .acg-switch{position:relative;display:inline-block;width:40px;height:22px;border-radius:20px;background:#bdc1c6;cursor:pointer;transition:background-color .08s linear;flex:0 0 auto}',
'#__acg_sync_panel__ .acg-switch.acg-on{background:#FB7299}',
'#__acg_sync_panel__ .acg-switch>.acg-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;box-sizing:border-box;border-radius:20px;background:#fff;border:1px solid transparent;box-shadow:rgba(0,0,0,.4) 0 1px 3px 0;transition:left .08s linear}',
'#__acg_sync_panel__ .acg-switch.acg-on>.acg-knob{left:20px}',
'#__acg_sync_panel__ .acg-switch.acg-disabled{opacity:.45;cursor:default}',

/* 复选：原生 16×16 / 2px #848990 / radius 2 / 勾选 #FB7299 + 白勾 */
'#__acg_sync_panel__ .acg-checkbox{position:relative;display:inline-block;width:16px;height:16px;box-sizing:border-box;border:2px solid #848990;border-radius:2px;background:transparent;cursor:pointer;flex:0 0 auto;transition:background-color .08s linear,border-color .08s linear}',
'#__acg_sync_panel__ .acg-checkbox.acg-on{background:#FB7299;border-color:#FB7299}',
'#__acg_sync_panel__ .acg-checkbox.acg-on:after{content:"";position:absolute;left:2px;top:-1px;width:4px;height:8px;border:2px solid #fff;border-top:0;border-left:0;transform:rotate(42deg)}',
'#__acg_sync_panel__ .acg-checkbox.acg-disabled{opacity:.45;cursor:default}',

/* 按钮：原生 .button-view —— 12px / #757575 / padding 1px 8px / 透明底 */
'#__acg_sync_panel__ .acg-btn{height:26px;padding:1px 8px;font-size:12px;font-family:inherit;color:#757575;background:transparent;border:0;border-radius:4px;cursor:pointer;transition:color .1s linear,background-color .1s linear}',
'#__acg_sync_panel__ .acg-btn:hover:not(:disabled){color:#FB7299;background:rgba(251,114,153,.06)}',
'#__acg_sync_panel__ .acg-btn:disabled{color:#c9c9c9;cursor:default}',
'#__acg_sync_panel__ .acg-btn.acg-primary{color:#FB7299;border:1px solid rgba(251,114,153,.55)}',
'#__acg_sync_panel__ .acg-btn.acg-primary:hover:not(:disabled){background:rgba(251,114,153,.1)}',
'#__acg_sync_panel__ .acg-btn.acg-primary:disabled{color:#c9c9c9;border-color:#ededed}',
'#__acg_sync_panel__ .acg-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 0 3px}',
'#__acg_sync_panel__ .acg-link{font-size:12px;color:#FB7299;text-decoration:none;cursor:pointer}',
'#__acg_sync_panel__ .acg-link:hover{text-decoration:underline}',

/* 分组行 */
'#__acg_sync_panel__ .acg-group{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid #f0f0f0}',
'#__acg_sync_panel__ .acg-group:first-child{border-top:0}',
'#__acg_sync_panel__ .acg-group-txt{flex:1 1 auto;min-width:0}',
'#__acg_sync_panel__ .acg-group-txt>p{margin:0;font-size:13px;color:#000;display:flex;align-items:center;gap:6px}',
'#__acg_sync_panel__ .acg-group-txt>p.acg-desc{margin:2px 0 0;font-size:12px;color:#424242;display:block}',
'#__acg_sync_panel__ .acg-count{font-size:12px;color:#757575}',
'#__acg_sync_panel__ .acg-keys{margin:2px 0 6px 26px;padding:6px 8px;font-size:12px;font-family:Consolas,Menlo,monospace;color:#757575;background:#fafafa;border:1px solid #f0f0f0;border-radius:4px;word-break:break-all;line-height:1.6}',

/* 状态徽标（配色取自页面自带 palette：--paper-green-800 / --paper-red-700 / --paper-orange-800） */
'#__acg_sync_panel__ .acg-pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:#f2f2f2;color:#757575}',
'#__acg_sync_panel__ .acg-pill.acg-ok{background:rgba(76,175,80,.12);color:#2e7d32}',
'#__acg_sync_panel__ .acg-pill.acg-bad{background:rgba(211,47,47,.10);color:#d32f2f}',
'#__acg_sync_panel__ .acg-pill.acg-warn{background:rgba(255,193,7,.18);color:#ef6c00}',
'#__acg_sync_panel__ .acg-val{font-size:12px;color:#424242;font-family:Consolas,Menlo,monospace;word-break:break-all}',

/* 日志 / 差异 / 历史 */
'#__acg_sync_panel__ .acg-log{margin-top:6px;max-height:170px;overflow:auto;padding:8px;font-size:12px;font-family:Consolas,Menlo,monospace;line-height:1.65;color:#424242;background:#fafafa;border:1px solid #eee;border-radius:6px;white-space:pre-wrap}',
'#__acg_sync_panel__ .acg-log:empty{display:none}',
'#__acg_sync_panel__ .acg-log .t{color:#9e9e9e}',
'#__acg_sync_panel__ .acg-log .s{color:#2e7d32}',
'#__acg_sync_panel__ .acg-log .e{color:#d32f2f}',
'#__acg_sync_panel__ .acg-log .w{color:#ef6c00}',
'#__acg_sync_panel__ .acg-diff{margin-top:6px;font-size:12px;color:#424242;line-height:1.7}',
'#__acg_sync_panel__ .acg-diff:empty{display:none}',
'#__acg_sync_panel__ .acg-hist{margin:4px 0 0;padding:0;list-style:none}',
'#__acg_sync_panel__ .acg-hist>li{display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid #f5f5f5;font-size:12px;color:#424242}',
'#__acg_sync_panel__ .acg-hist>li:first-child{border-top:0}',
'#__acg_sync_panel__ .acg-hist .acg-hist-txt{flex:1 1 auto;min-width:0;font-family:Consolas,Menlo,monospace;word-break:break-all}',
'#__acg_sync_panel__ .acg-muted{color:#757575}',
'#__acg_sync_panel__ .acg-scope-line{font-size:12px;color:#424242;padding:2px 0 6px}',
    ].join('\n');
  }

  function injectCSS() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = cssText();
    (document.head || document.documentElement).appendChild(st);
  }

  /* --------------------------------------------------------------- 导航项注入 */

  function navList() {
    var ul = document.querySelector('aside ul');
    if (!ul) return null;
    // 确认它是导航列表（里面得有原生 aside-item）
    return ul.querySelector('.aside-item') ? ul : null;
  }

  function nativeItems() {
    var ul = navList();
    if (!ul) return [];
    return Array.prototype.slice.call(ul.children).filter(function (n) {
      return n.classList && n.classList.contains('aside-item');
    });
  }

  function itemText(node) {
    var b = node && node.querySelector('button');
    return ((b ? b.textContent : node && node.textContent) || '').trim();
  }

  function myNav() {
    return document.getElementById(NAV_ID);
  }

  /** 深克隆原生导航项做模板：类名/结构/ripple 层全部沿用，只换文案 */
  function buildNav() {
    var items = nativeItems();
    if (!items.length) return null;
    var tpl = items.filter(function (n) { return !n.classList.contains('active'); })[0] || items[0];
    var node = tpl.cloneNode(true);
    node.id = NAV_ID;
    node.classList.remove('active');
    node.setAttribute('data-acg-sync', '1');
    var btn = node.querySelector('button');
    if (!btn) {
      btn = el('button', 'button-view', NAV_TEXT);
      node.appendChild(btn);
    }
    btn.textContent = NAV_TEXT;
    btn.setAttribute('type', 'button');
    // 克隆会把原生的事件绑定丢在 React 那边（这里本来就没有内联 handler），
    // 我们自己挂自己的监听，并阻止事件冒泡到 React 的委托层
    var handler = function (ev) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      activate();
    };
    node.addEventListener('click', handler, true);
    node.__acgHandler = handler;
    return node;
  }

  function insertAfterAnchor(ul, node) {
    var items = nativeItems().filter(function (n) { return n.id !== NAV_ID; });
    for (var i = 0; i < ANCHOR_TEXTS.length; i++) {
      var anchor = items.filter(function (n) { return itemText(n) === ANCHOR_TEXTS[i]; })[0];
      if (anchor && anchor.parentNode === ul) {
        if (anchor.nextSibling) ul.insertBefore(node, anchor.nextSibling);
        else ul.appendChild(node);
        return ANCHOR_TEXTS[i];
      }
    }
    ul.appendChild(node);
    return '(tail)';
  }

  function ensureNav() {
    var ul = navList();
    if (!ul) return null;
    var mine = myNav();
    if (mine && mine.parentNode === ul) return mine;
    if (mine && mine.parentNode) mine.parentNode.removeChild(mine);
    var node = buildNav();
    if (!node) return null;
    var where = insertAfterAnchor(ul, node);
    node.setAttribute('data-acg-after', where);
    return node;
  }

  /* --------------------------------------------------------------- 内容区注入 */

  function mainEl() {
    return document.querySelector('main');
  }

  function panelEl() {
    return document.getElementById(PANEL_ID);
  }

  function row(title, desc) {
    var r = el('div', 'acg-row');
    var lbl = el('div', 'acg-lbl');
    lbl.appendChild(el('p', null, title));
    if (desc) lbl.appendChild(el('p', 'acg-desc', desc));
    var ctl = el('div', 'acg-ctl');
    r.appendChild(lbl);
    r.appendChild(ctl);
    return { row: r, ctl: ctl, lbl: lbl };
  }

  function section(head) {
    var sec = el('section', 'acg-sec');
    var hd = el('div', 'acg-sec-hd', head);
    var bd = el('div', 'acg-sec-bd');
    sec.appendChild(hd);
    sec.appendChild(bd);
    return { sec: sec, bd: bd };
  }

  function buildPanel() {
    var root = el('div');
    root.id = PANEL_ID;
    root.appendChild(el('h2', null, '同步'));

    /* ---- ① 服务器 ---- */
    var s1 = section('WebDAV 服务器');
    var rServer = row('服务器地址', '必须以 http(s):// 开头；末尾斜杠自动补全');
    var iServer = el('input', 'acg-input acg-wide');
    iServer.type = 'text'; iServer.id = 'acgSynServer'; iServer.spellcheck = false;
    iServer.placeholder = core.DEFAULTS.server;
    rServer.ctl.appendChild(iServer);
    s1.bd.appendChild(rServer.row);

    var rUser = row('用户名', '服务商给的账号（多数是自己的邮箱或数字 ID）');
    var iUser = el('input', 'acg-input');
    iUser.type = 'text'; iUser.id = 'acgSynUser'; iUser.spellcheck = false;
    rUser.ctl.appendChild(iUser);
    s1.bd.appendChild(rUser.row);

    var rPass = row('密码', '服务商给的「应用密码」；默认已填，不会明文回显在页面上');
    var iPass = el('input', 'acg-input');
    iPass.type = 'password'; iPass.id = 'acgSynPass'; iPass.autocomplete = 'off';
    rPass.ctl.appendChild(iPass);
    s1.bd.appendChild(rPass.row);

    var rDir = row('远端目录', '相对服务器根的路径；所有文件只落在 _acghelper/ 下');
    var iDir = el('input', 'acg-input acg-wide');
    iDir.type = 'text'; iDir.id = 'acgSynDir'; iDir.spellcheck = false;
    iDir.placeholder = core.DEFAULTS.remoteDir;
    rDir.ctl.appendChild(iDir);
    s1.bd.appendChild(rDir.row);

    var rTest = row('连接', '测试会在 _probe 目录写入并立刻删除，不碰你已有的目录');
    var bTest = el('button', 'acg-btn acg-primary', '测试连接');
    bTest.type = 'button'; bTest.id = 'acgSynTest';
    var spTest = el('span', 'acg-pill', '未测试');
    spTest.id = 'acgSynTestPill';
    rTest.ctl.appendChild(bTest);
    rTest.ctl.appendChild(spTest);
    s1.bd.appendChild(rTest.row);

    var rAdv = row('高级', '独立页面提供逐条差异比对、原始日志与手工恢复');
    var aPage = el('a', 'acg-link', '在独立页面打开（高级）');
    aPage.id = 'acgSynOpenPage';
    aPage.href = '#';
    aPage.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      var url = chrome.runtime.getURL('html/webdav.html');
      try { chrome.tabs.create({ url: url, active: true }); } catch (e) { window.open(url, '_blank'); }
    });
    rAdv.ctl.appendChild(aPage);
    s1.bd.appendChild(rAdv.row);

    var act1 = el('div', 'acg-actions');
    var bSave = el('button', 'acg-btn acg-primary', '保存配置');
    bSave.type = 'button'; bSave.id = 'acgSynSave';
    var spSave = el('span', 'acg-muted');
    spSave.id = 'acgSynSaveMsg';
    act1.appendChild(bSave);
    act1.appendChild(spSave);
    s1.bd.appendChild(act1);
    root.appendChild(s1.sec);

    /* ---- ② 同步内容 ---- */
    var s2 = section('同步内容');
    var scopeLine = el('div', 'acg-scope-line', '按分组勾选要同步的设置；关掉的组不会出现在上传内容里，也不会被下载覆盖');
    scopeLine.id = 'acgSynScopeLine';
    s2.bd.appendChild(scopeLine);

    var rAll = row('全部设置', '开着就是「跟以前一样全量同步」；关掉后按下面分组走');
    var swAll = el('span', 'acg-switch acg-on');
    swAll.id = 'acgSynAll';
    swAll.setAttribute('role', 'switch');
    swAll.setAttribute('aria-checked', 'true');
    swAll.tabIndex = 0;
    swAll.appendChild(el('span', 'acg-knob'));
    rAll.ctl.appendChild(swAll);
    s2.bd.appendChild(rAll.row);

    var groupsBox = el('div');
    groupsBox.id = 'acgSynGroups';
    s2.bd.appendChild(groupsBox);
    root.appendChild(s2.sec);

    /* ---- ③ 定时同步 ---- */
    var s3 = section('定时同步');
    var rAuto = row('定时同步', '开着时即使设置页关掉也会按间隔自动同步（由后台 alarm 触发）');
    var swAuto = el('span', 'acg-switch');
    swAuto.id = 'acgSynAuto';
    swAuto.setAttribute('role', 'switch');
    swAuto.setAttribute('aria-checked', 'false');
    swAuto.tabIndex = 0;
    swAuto.appendChild(el('span', 'acg-knob'));
    rAuto.ctl.appendChild(swAuto);
    s3.bd.appendChild(rAuto.row);

    var rInt = row('间隔', '到点后按下面的方向同步一次');
    var selInt = el('select', 'acg-select');
    selInt.id = 'acgSynInterval';
    [['5', '5 分钟'], ['15', '15 分钟'], ['60', '60 分钟']].forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0]; selInt.appendChild(op);
    });
    rInt.ctl.appendChild(selInt);
    s3.bd.appendChild(rInt.row);

    var rMode = row('方向', '只上传＝本地覆盖远端；只下载＝远端覆盖本地；双向＝谁变同步谁，两边都变就停下等你决定');
    var selMode = el('select', 'acg-select');
    selMode.id = 'acgSynMode';
    [['upload', '只上传'], ['bidirectional', '双向'], ['download', '只下载']].forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0]; selMode.appendChild(op);
    });
    rMode.ctl.appendChild(selMode);
    s3.bd.appendChild(rMode.row);

    var rAlarm = row('后台任务', 'alarm 由 Service Worker 持有，关掉定时同步会立刻清除');
    var spAlarm = el('span', 'acg-pill', '未创建');
    spAlarm.id = 'acgSynAlarmPill';
    rAlarm.ctl.appendChild(spAlarm);
    s3.bd.appendChild(rAlarm.row);
    root.appendChild(s3.sec);

    /* ---- ④ 立即同步 ---- */
    var s4 = section('立即同步');
    var act4 = el('div', 'acg-actions');
    var bUp = el('button', 'acg-btn acg-primary', '立即上传');
    bUp.type = 'button'; bUp.id = 'acgSynUpload';
    var bDown = el('button', 'acg-btn', '立即下载');
    bDown.type = 'button'; bDown.id = 'acgSynDownload'; bDown.setAttribute('data-need-confirm', '1');
    var bDiff = el('button', 'acg-btn', '比对差异');
    bDiff.type = 'button'; bDiff.id = 'acgSynDiff';
    var bClear = el('button', 'acg-btn', '清空日志');
    bClear.type = 'button'; bClear.id = 'acgSynClearLog';
    act4.appendChild(bUp); act4.appendChild(bDown); act4.appendChild(bDiff); act4.appendChild(bClear);
    s4.bd.appendChild(act4);

    var diffOut = el('div', 'acg-diff');
    diffOut.id = 'acgSynDiffOut';
    s4.bd.appendChild(diffOut);
    var logBox = el('div', 'acg-log');
    logBox.id = 'acgSynLog';
    s4.bd.appendChild(logBox);
    root.appendChild(s4.sec);

    /* ---- ⑤ 状态 ---- */
    var s5 = section('同步状态');
    var rLast = row('最近同步时间');
    var vLast = el('span', 'acg-val', '-'); vLast.id = 'acgSynLast';
    rLast.ctl.appendChild(vLast);
    s5.bd.appendChild(rLast.row);

    var rRes = row('结果 / HTTP');
    var vRes = el('span', 'acg-val', '-'); vRes.id = 'acgSynResult';
    rRes.ctl.appendChild(vRes);
    s5.bd.appendChild(rRes.row);

    var rSha = row('sha256（本地 / 远端）');
    var vSha = el('span', 'acg-val', '-'); vSha.id = 'acgSynSha';
    rSha.ctl.appendChild(vSha);
    s5.bd.appendChild(rSha.row);

    var rFile = row('远端文件 / 大小');
    var vFile = el('span', 'acg-val', '-'); vFile.id = 'acgSynFile';
    rFile.ctl.appendChild(vFile);
    s5.bd.appendChild(rFile.row);

    var rHist = row('本地快照', '每次上传/下载前自动压一份，保留最近 5 份；点「恢复」回滚');
    rHist.ctl.appendChild(el('span', 'acg-val', ''));
    s5.bd.appendChild(rHist.row);
    var hist = el('ul', 'acg-hist');
    hist.id = 'acgSynHistory';
    s5.bd.appendChild(hist);
    root.appendChild(s5.sec);

    // bind 必须在「还没挂进文档」的阶段就把监听器绑到真实节点上，
    // 所以用 buildingRoot 作用域查找，而不是 document.getElementById
    buildingRoot = root;
    try { bind(root); } finally { buildingRoot = null; }
    return root;
  }

  /* --------------------------------------------------------------- 状态渲染 */

  function renderGroups() {
    var box = $('acgSynGroups');
    if (!box || !S.desc) return;
    clear(box);
    S.desc.groups.forEach(function (g) {
      var wrap = el('div', 'acg-group');
      wrap.setAttribute('data-group', g.id);
      var cb = el('span', 'acg-checkbox' + (g.selected ? ' acg-on' : ''));
      cb.setAttribute('role', 'checkbox');
      cb.setAttribute('aria-checked', g.selected ? 'true' : 'false');
      cb.tabIndex = 0;
      cb.setAttribute('data-group', g.id);
      if (S.scope && S.scope.all !== false) cb.classList.add('acg-disabled');
      cb.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (S.scope && S.scope.all !== false) return;   // 「全部」开着时分组勾选不生效
        toggleGroup(g.id);
      });
      cb.addEventListener('keydown', function (ev) {
        if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); if (!(S.scope && S.scope.all !== false)) toggleGroup(g.id); }
      });

      var txt = el('div', 'acg-group-txt');
      var p1 = el('p');
      p1.appendChild(document.createTextNode(g.title));
      p1.appendChild(el('span', 'acg-count', '(' + g.items.length + ')'));
      txt.appendChild(p1);
      txt.appendChild(el('p', 'acg-desc', g.desc));

      var btn = el('button', 'acg-btn', '查看键');
      btn.type = 'button';
      btn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        var box2 = wrap.nextElementSibling;
        if (box2 && box2.classList.contains('acg-keys')) {
          if (box2.hasAttribute('hidden')) { box2.removeAttribute('hidden'); btn.textContent = '收起'; }
          else { box2.setAttribute('hidden', ''); btn.textContent = '查看键'; }
        }
      });

      wrap.appendChild(cb);
      wrap.appendChild(txt);
      wrap.appendChild(btn);
      box.appendChild(wrap);

      var keys = el('div', 'acg-keys');
      keys.setAttribute('hidden', '');
      keys.textContent = g.items.length ? g.items.join(', ') : '(空)';
      box.appendChild(keys);
    });
    var line = $('acgSynScopeLine');
    if (line) {
      line.textContent = '当前同步范围：' + S.desc.selected + ' / ' + S.desc.total +
        ' 个控制器' + (S.desc.all ? '（全部设置）' : '（按分组勾选）');
    }
    var swAll = $('acgSynAll');
    if (swAll) {
      var on = !(S.scope && S.scope.all === false);
      swAll.classList.toggle('acg-on', on);
      swAll.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  function renderAlarm() {
    var pill = $('acgSynAlarmPill');
    if (!pill) return;
    if (S.alarm) {
      pill.className = 'acg-pill acg-ok';
      pill.textContent = '已创建 · 每 ' + (S.alarm.periodInMinutes || '?') + ' 分钟 · 下次 ' +
        fmtTime(S.alarm.scheduledTime ? new Date(S.alarm.scheduledTime).toISOString() : null);
    } else {
      pill.className = 'acg-pill';
      pill.textContent = 'alarm 未创建（定时同步关闭）';
    }
  }

  function renderState() {
    var st = S.st || {};
    if ($('acgSynLast')) $('acgSynLast').textContent = st.lastSyncAt ? fmtTime(st.lastSyncAt) : '-';
    var pill = $('acgSynResult');
    if (pill) {
      var res = st.lastResult || '-';
      var kind = res === 'ok' ? 'acg-ok' : (res === 'conflict' ? 'acg-warn' : (res === 'fail' ? 'acg-bad' : ''));
      pill.innerHTML = '';
      var p = el('span', 'acg-pill ' + kind, res + (st.lastDirection ? ' · ' + st.lastDirection : ''));
      if (st.lastError) p.title = st.lastError;
      pill.appendChild(p);
      if (st.lastHttp) pill.appendChild(document.createTextNode(' HTTP ' + st.lastHttp));
      if (st.lastError) {
        var e = el('div', 'acg-val', '错误：' + String(st.lastError).slice(0, 260));
        e.style.color = '#d32f2f';
        pill.appendChild(e);
      }
    }
    if ($('acgSynSha')) {
      // 语义要分清：上传看「本地写的 == 远端读回来的」；下载看「刚回填了 N 项」。
      // 下载成功后拿「下载前的快照 sha」去和远端比永远是「不一致」，那是误导。
      var isDown = st.lastDirection === 'download' && st.lastResult === 'ok';
      var eq = st.localSha256 && st.remoteSha256 && st.localSha256 === st.remoteSha256;
      var box = $('acgSynSha');
      box.innerHTML = '';
      var kind = isDown ? 'acg-ok' : (eq ? 'acg-ok' : ((st.localSha256 || st.remoteSha256) ? 'acg-warn' : ''));
      var label = isDown ? ('已回填 ' + (st.appliedKeys || 0) + ' 项') :
        ((st.localSha256 || st.remoteSha256) ? (eq ? '一致' : '不一致') : '-');
      box.appendChild(el('span', 'acg-pill ' + kind, label));
      box.appendChild(document.createTextNode(isDown
        ? (' 远端 ' + shortSha(st.remoteSha256) + ' / 覆盖前快照 ' + shortSha(st.localSha256))
        : (' ' + shortSha(st.localSha256) + ' / ' + shortSha(st.remoteSha256))));
    }
    if ($('acgSynFile')) {
      $('acgSynFile').textContent = (st.remoteFile || core.remoteFilePath(S.cfg || core.DEFAULTS)) +
        ' · ' + core.fmtBytes(st.remoteBytes) +
        (st.appliedKeys ? ' · 上次回填 ' + st.appliedKeys + ' 项' : '');
    }
    renderHistory();
  }

  function renderHistory() {
    var ul = $('acgSynHistory');
    if (!ul) return;
    clear(ul);
    if (!S.history.length) {
      var li0 = el('li');
      li0.appendChild(el('span', 'acg-hist-txt acg-muted', '还没有本地快照（第一次上传/下载后出现）'));
      ul.appendChild(li0);
      return;
    }
    S.history.forEach(function (h, i) {
      var li = el('li');
      var txt = '#' + i + ' ' + fmtTime(h.at) + ' · ' + (h.kind || '?') +
        ' · ' + core.fmtBytes(h.bytes || 0) + (h.truncated ? '（已截断）' : '');
      li.appendChild(el('span', 'acg-hist-txt', txt));
      var b = el('button', 'acg-btn', '恢复');
      b.type = 'button';
      b.setAttribute('data-restore', String(i));
      b.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        restoreAt(i, b);
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  function renderLog() {
    var box = $('acgSynLog');
    if (!box) return;
    box.innerHTML = '';
    S.log.slice(-120).forEach(function (l) {
      var line = el('div');
      var t = el('span', 't', '[' + l.t + '] ');
      var m = el('span', l.cls || '', l.msg);
      line.appendChild(t);
      line.appendChild(m);
      box.appendChild(line);
    });
    box.scrollTop = box.scrollHeight;
  }

  function renderDiff() {
    var box = $('acgSynDiffOut');
    if (!box) return;
    box.innerHTML = '';
    var d = S.diff;
    if (!d) return;
    function line(label, val) {
      var div = el('div');
      var b = el('b', null, label);
      div.appendChild(b);
      div.appendChild(document.createTextNode(val));
      box.appendChild(div);
    }
    line('本地：', core.fmtBytes(d.localBytes) + ' · ' + d.localItems + ' 个模块 · sha256 ' + shortSha(d.localSha256));
    if (!d.exists) {
      line('远端：', '（还没有备份文件 ' + d.remoteFile + '）');
    } else {
      line('远端：', core.fmtBytes(d.remoteBytes) + ' · ' + d.remoteItems + ' 个模块 · sha256 ' + shortSha(d.remoteSha256));
      line('远端导出：', (d.remoteExportedAt || '-') + '（扩展 v' + (d.remoteVersion || '?') + '）');
      line('内容：', d.identical ? '完全相同' : '有差异');
      if (!d.identical) {
        if (d.added.length) line('远端多出：', d.added.join(', '));
        if (d.removed.length) line('远端缺少：', d.removed.join(', '));
        if (d.changed.length) line('内容不同：', d.changed.join(', '));
      }
    }
  }

  function log(msg, cls) {
    S.log.push({ t: tstr(), msg: String(msg), cls: cls || '' });
    if (S.log.length > 400) S.log.splice(0, S.log.length - 400);
    renderLog();
  }

  /* ------------------------------------------------------------------ 数据流 */

  function fillFields() {
    var cfg = S.cfg;
    if (!cfg) return;
    function setv(id, v) {
      var n = $(id);
      if (!n) return;
      // 正在编辑的框不要被后台刷新覆盖；用户改过还没保存的也不要覆盖（否则一刷新就吞掉输入）
      if (document.activeElement === n) return;
      if (n.__acgDirty) return;
      if (n.value !== v) n.value = v;
    }
    setv('acgSynServer', cfg.server);
    setv('acgSynUser', cfg.username);
    setv('acgSynPass', cfg.password);
    setv('acgSynDir', cfg.remoteDir);
    var i = $('acgSynInterval'); if (i) i.value = String(cfg.intervalMinutes || 15);
    var m = $('acgSynMode'); if (m) m.value = cfg.autoMode || 'upload';
    var sw = $('acgSynAuto');
    if (sw) {
      sw.classList.toggle('acg-on', !!cfg.autoSync);
      sw.setAttribute('aria-checked', cfg.autoSync ? 'true' : 'false');
    }
  }

  function readFields() {
    var cfg = Object.assign({}, S.cfg || core.DEFAULTS);
    var g = function (id, d) { var n = $(id); return n ? n.value : d; };
    cfg.server = String(g('acgSynServer', cfg.server)).trim();
    cfg.username = String(g('acgSynUser', cfg.username)).trim();
    cfg.password = String(g('acgSynPass', cfg.password));
    cfg.remoteDir = String(g('acgSynDir', cfg.remoteDir)).trim();
    cfg.intervalMinutes = Number(g('acgSynInterval', cfg.intervalMinutes)) || 15;
    cfg.autoMode = String(g('acgSynMode', cfg.autoMode));
    var sw = $('acgSynAuto');
    if (sw) cfg.autoSync = sw.classList.contains('acg-on');
    return cfg;
  }

  async function reload() {
    S.cfg = await core.loadConfig();
    S.scope = await core.loadScope();
    S.desc = await core.describeScope(S.scope);
    S.st = await core.getState();
    S.alarm = await core.alarmInfo();
    S.history = await core.historyList();
    fillFields();
    renderGroups();
    renderAlarm();
    renderState();
  }

  function setBusy(on, label) {
    S.busy = on;
    ['acgSynSave', 'acgSynTest', 'acgSynUpload', 'acgSynDownload', 'acgSynDiff', 'acgSynAll', 'acgSynAuto']
      .forEach(function (id) {
        var n = $(id);
        if (!n) return;
        if (on) n.setAttribute('disabled', '');
        else n.removeAttribute('disabled');
        if (n.classList) n.classList.toggle('acg-disabled', on);
      });
    if (label) log('▶ ' + label + ' …');
  }

  async function guard(label, fn) {
    if (S.busy) { log('上一次操作还没结束，稍等', 'w'); return; }
    setBusy(true, label);
    try {
      await fn();
    } catch (e) {
      log('✖ ' + label + ' 失败：' + (e && e.message ? e.message : e), 'e');
    } finally {
      setBusy(false, null);
      try { await reload(); } catch (e2) { /* ignore */ }
    }
  }

  async function ensureHostPermission(server) {
    if (!chrome.permissions) return true;
    var origin;
    try { origin = new URL(server).origin + '/*'; } catch (e) { throw new Error('服务器地址不合法：' + server); }
    var has = await new Promise(function (res) {
      chrome.permissions.contains({ origins: [origin] }, function (v) { void chrome.runtime.lastError; res(!!v); });
    });
    if (has) return true;
    var granted = await new Promise(function (res) {
      chrome.permissions.request({ origins: [origin] }, function (v) { void chrome.runtime.lastError; res(!!v); });
    });
    if (!granted) throw new Error('未授予 ' + origin + ' 的访问权限，无法连接该服务器');
    return true;
  }

  async function saveCfg(opts) {
    opts = opts || {};
    var cfg = readFields();
    var saved = await core.saveConfig(cfg);
    S.cfg = saved;
    // 保存成功＝输入已落盘，脏标记清掉，后台刷新可以正常回填
    ['acgSynServer', 'acgSynUser', 'acgSynPass', 'acgSynDir'].forEach(function (id) {
      var n = $(id);
      if (n) n.__acgDirty = false;
    });
    if (!opts.silent) log('配置已保存：' + saved.server + ' → ' + saved.remoteDir, 's');
    var msg = $('acgSynSaveMsg');
    if (msg) { msg.textContent = '已保存 ' + tstr(); }
    await core.scheduleAlarm(saved);
    return saved;
  }

  async function toggleGroup(gid) {
    var cur = await core.loadScope();
    var nextVal = !cur.groups[gid];
    var patch = { groups: {} };
    patch.groups[gid] = nextVal;
    // 取消某一组时自动把「全部」关掉（否则勾选没有意义）
    if (!nextVal) patch.all = false;
    // 全部组都勾回来时，顺手把「全部」恢复
    var allOn = Object.keys(cur.groups).every(function (k) { return k === gid ? nextVal : cur.groups[k]; });
    if (allOn) patch.all = true;
    await core.saveScope(patch);
    S.scope = await core.loadScope();
    S.desc = await core.describeScope(S.scope);
    renderGroups();
    log('同步内容：' + (core.GROUPS.filter(function (g) { return g.id === gid; })[0] || {}).title +
      ' → ' + (nextVal ? '包含' : '排除') + '；当前 ' + S.desc.selected + ' / ' + S.desc.total + ' 个控制器', 'w');
  }

  async function toggleAll() {
    var cur = await core.loadScope();
    var on = !(cur.all !== false);
    await core.saveScope({ all: on });
    S.scope = await core.loadScope();
    S.desc = await core.describeScope(S.scope);
    renderGroups();
    log(on ? '同步内容：恢复全量（全部设置）' : '同步内容：改为按分组勾选', 'w');
  }

  async function toggleAuto() {
    var sw = $('acgSynAuto');
    var on = sw ? !sw.classList.contains('acg-on') : true;
    if (sw) { sw.classList.toggle('acg-on', on); sw.setAttribute('aria-checked', on ? 'true' : 'false'); }
    var saved = await core.saveConfig({ autoSync: on });
    S.cfg = saved;
    var info = await core.scheduleAlarm(saved);
    S.alarm = info;
    renderAlarm();
    log(on ? ('定时同步已开启：每 ' + saved.intervalMinutes + ' 分钟，方向 ' + saved.autoMode + '（alarm ' +
      (info ? '已创建' : '创建失败') + '）') : '定时同步已关闭，alarm 已清除', on ? 's' : 'w');
  }

  async function restoreAt(index, btn) {
    // 两段式确认：第一次点变成「确认恢复」，4 秒内再点才真的恢复（headless 下也不弹原生 confirm）
    var now = Date.now();
    if (S.confirmRestoreUntil < now || btn.getAttribute('data-idx') !== String(index)) {
      S.confirmRestoreUntil = now + 4000;
      btn.setAttribute('data-idx', String(index));
      btn.textContent = '确认恢复';
      btn.classList.add('acg-primary');
      setTimeout(function () {
        if (btn.isConnected) { btn.textContent = '恢复'; btn.classList.remove('acg-primary'); btn.removeAttribute('data-idx'); }
      }, 4000);
      log('再点一次「确认恢复」＝用快照 #' + index + ' 覆盖当前设置（4 秒内有效）', 'w');
      return;
    }
    S.confirmRestoreUntil = 0;
    btn.textContent = '恢复';
    btn.classList.remove('acg-primary');
    btn.removeAttribute('data-idx');
    await guard('恢复快照 #' + index, async function () {
      var r = await core.historyRestore(index);
      log('已恢复快照 #' + index + '：渠道 ' + r.applied + '，写入 ' + r.keys + ' 项', 's');
    });
  }

  /* -------------------------------------------------------------------- 绑定 */

  function bind(root) {
    var bSave = $('acgSynSave');
    if (bSave) bSave.addEventListener('click', function () {
      guard('保存配置', async function () {
        var cfg = await saveCfg({});
        try { await ensureHostPermission(cfg.server); } catch (e) { log('权限：' + (e.message || e), 'w'); }
      });
    });

    var bTest = $('acgSynTest');
    if (bTest) bTest.addEventListener('click', function () {
      // 申请权限必须在用户手势里同步触发，所以先请求再走异步流程
      var server = String(($('acgSynServer') || {}).value || '').trim();
      var permP = null;
      try { permP = ensureHostPermission(server); } catch (e) { permP = Promise.resolve(); }
      guard('测试连接', async function () {
        var cfg = await saveCfg({ silent: true });
        try { await permP; } catch (e) { log('权限：' + (e.message || e), 'w'); }
        var r = await core.testConnection();
        S.lastTest = r;
        S.lastTestAt = Date.now();
        (r.steps || []).forEach(function (s) {
          var head = '· ' + s.step + ' → ' + (s.http !== null && s.http !== undefined ? 'HTTP ' + s.http : 'ERR') +
            (s.sha256Match === true ? ' / sha256 一致' : (s.sha256Match === false ? ' / sha256 不一致' : ''));
          log(head, s.error ? 'e' : '');
          if (s.error) log('  ' + String(s.error).replace(/\s+/g, ' ').slice(0, 200), 'e');
          // 服务端返回片段只在「有异常 / 4xx-5xx」时贴出来；201/200 的正常响应体不用占屏
          if (s.snippet && (s.error || (typeof s.http === 'number' && s.http >= 400))) {
            log('  服务端返回：' + s.snippet, 'e');
          }
        });
        var pill = $('acgSynTestPill');
        if (pill) {
          if (r.ok) { pill.className = 'acg-pill acg-ok'; pill.textContent = '连接正常 · ' + r.elapsedMs + 'ms'; }
          else { pill.className = 'acg-pill acg-bad'; pill.textContent = '失败'; }
        }
        if (r.ok) log('✔ 连接测试通过（' + r.elapsedMs + 'ms）', 's');
        else log('✖ 连接测试失败：' + (r.error || '未知'), 'e');
      });
    });

    var bUp = $('acgSynUpload');
    if (bUp) bUp.addEventListener('click', function () {
      var server = String(($('acgSynServer') || {}).value || '').trim();
      var permP = null;
      try { permP = ensureHostPermission(server); } catch (e) { permP = Promise.resolve(); }
      guard('立即上传', async function () {
        var cfg = await saveCfg({ silent: true });
        try { await permP; } catch (e) { log('权限：' + (e.message || e), 'w'); }
        var r = await core.uploadSettings({ reason: 'panel-manual' });
        log('PUT ' + core.remoteFilePath(cfg) + ' → HTTP ' + r.http + '，' + core.fmtBytes(r.bytes), 's');
        log('本地 sha256 = ' + r.sha256);
        log('远端 sha256 = ' + (r.remoteSha256 || '(未回读)') +
          (r.remoteSha256 && r.remoteSha256 === r.sha256 ? ' ✔ 回读一致' : ' ✖ 回读不一致'), r.remoteSha256 === r.sha256 ? 's' : 'e');
      });
    });

    var bDown = $('acgSynDownload');
    if (bDown) bDown.addEventListener('click', function () {
      var now = Date.now();
      if (S.confirmDownloadUntil < now) {
        S.confirmDownloadUntil = now + 5000;
        bDown.textContent = '确认覆盖本地';
        bDown.classList.add('acg-primary');
        setTimeout(function () {
          if (bDown.isConnected) { bDown.textContent = '立即下载'; bDown.classList.remove('acg-primary'); }
        }, 5000);
        log('下载会用远端内容覆盖本地设置（覆盖前自动存一份本地快照）。5 秒内再点一次确认。', 'w');
        return;
      }
      S.confirmDownloadUntil = 0;
      bDown.textContent = '立即下载';
      bDown.classList.remove('acg-primary');
      var server = String(($('acgSynServer') || {}).value || '').trim();
      var permP = null;
      try { permP = ensureHostPermission(server); } catch (e) { permP = Promise.resolve(); }
      guard('立即下载', async function () {
        var cfg = await saveCfg({ silent: true });
        try { await permP; } catch (e) { log('权限：' + (e.message || e), 'w'); }
        var r = await core.downloadSettings({ reason: 'panel-manual' });
        log('GET ' + core.remoteFilePath(cfg) + ' → HTTP 200，' + core.fmtBytes(r.bytes) + '，sha256=' + r.sha256, 's');
        log('已下发渠道：' + r.applied.applied + '，写入 ' + r.applied.keys + ' 项', 's');
        log('覆盖前的本地快照已存入历史（保留最近 5 份）', 'w');
        S.diff = null; renderDiff();
      });
    });

    var bDiff = $('acgSynDiff');
    if (bDiff) bDiff.addEventListener('click', function () {
      var server = String(($('acgSynServer') || {}).value || '').trim();
      var permP = null;
      try { permP = ensureHostPermission(server); } catch (e) { permP = Promise.resolve(); }
      guard('比对差异', async function () {
        await saveCfg({ silent: true });
        try { await permP; } catch (e) { log('权限：' + (e.message || e), 'w'); }
        var d = await core.diffRemote();
        S.diff = d;
        renderDiff();
        log('差异比对：' + (d.identical ? '完全相同' :
          ('远端多出 ' + d.added.length + ' / 缺少 ' + d.removed.length + ' / 变化 ' + d.changed.length)),
          d.identical ? 's' : 'w');
      });
    });

    var bClear = $('acgSynClearLog');
    if (bClear) bClear.addEventListener('click', function () { S.log = []; renderLog(); });

    var swAll = $('acgSynAll');
    if (swAll) {
      swAll.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); toggleAll(); });
      swAll.addEventListener('keydown', function (ev) {
        if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); toggleAll(); }
      });
    }

    var swAuto = $('acgSynAuto');
    if (swAuto) {
      swAuto.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        guard('更新定时同步', async function () { await toggleAuto(); });
      });
      swAuto.addEventListener('keydown', function (ev) {
        if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); guard('更新定时同步', async function () { await toggleAuto(); }); }
      });
    }

    var selInt = $('acgSynInterval');
    if (selInt) selInt.addEventListener('change', function () {
      guard('更新间隔', async function () {
        var saved = await saveCfg({ silent: true });
        var info = await core.scheduleAlarm(saved);
        S.alarm = info;
        renderAlarm();
        log('间隔改为 ' + saved.intervalMinutes + ' 分钟' + (info ? '，alarm 已重建（下次 ' +
          fmtTime(info.scheduledTime ? new Date(info.scheduledTime).toISOString() : null) + '）' : '，alarm 未启用'), 's');
      });
    });

    var selMode = $('acgSynMode');
    if (selMode) selMode.addEventListener('change', function () {
      guard('更新方向', async function () {
        var saved = await saveCfg({ silent: true });
        log('同步方向改为：' + saved.autoMode, 's');
      });
    });

    // 输入框回车＝保存（和原生设置页的操作习惯一致）
    ['acgSynServer', 'acgSynUser', 'acgSynPass', 'acgSynDir'].forEach(function (id) {
      var n = $(id);
      if (!n) return;
      n.addEventListener('input', function () { n.__acgDirty = true; });
      n.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); var b = $('acgSynSave'); if (b) b.click(); }
      });
      n.addEventListener('click', function (ev) { ev.stopPropagation(); });
    });
  }

  /* ----------------------------------------------------------- 与原生页共存 */

  function hideNative(on) {
    var main = mainEl();
    if (!main) return;
    Array.prototype.slice.call(main.children).forEach(function (ch) {
      if (ch.id === PANEL_ID) return;
      if (on) {
        if (!ch.hasAttribute(MARK_ATTR)) ch.setAttribute(MARK_ATTR, '1');
        ch.style.setProperty('display', 'none', 'important');
      } else if (ch.hasAttribute(MARK_ATTR)) {
        ch.removeAttribute(MARK_ATTR);
        ch.style.removeProperty('display');
      }
    });
  }

  function setActiveNav(on) {
    var mine = myNav();
    if (mine) mine.classList.toggle('active', on);
    if (on) {
      nativeItems().forEach(function (n) { if (n.id !== NAV_ID) n.classList.remove('active'); });
    }
  }

  function activate() {
    var p = panelEl();
    if (!p) { ensurePanel(); p = panelEl(); }
    if (!p) return false;
    var already = S.active && p.classList.contains('acg-on');
    S.active = true;
    p.classList.add('acg-on');
    hideNative(true);
    setActiveNav(true);
    if (!already) {
      log('同步栏已打开 · 服务器 ' + ((S.cfg && S.cfg.server) || '-'));
      reload().catch(function (e) { log('读取配置失败：' + (e.message || e), 'e'); });
    } else {
      reload().catch(function () { /* ignore */ });
    }
    return true;
  }

  function deactivate() {
    if (!S.active) return;
    S.active = false;
    var p = panelEl();
    if (p) p.classList.remove('acg-on');
    hideNative(false);
    setActiveNav(false);
  }

  /** 导航点击委托：点「同步」→ 进同步栏；点任何原生项 → 退出同步栏（不拦原生行为）。
   *  挂在 document 捕获阶段，React 重渲染把我的节点换掉也不会丢功能。 */
  function onAsideClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var mine = t.closest('#' + NAV_ID);
    if (mine) {
      if (ev.type === 'click') activate();
      return;
    }
    var item = t.closest('.aside-item');
    if (!item) return;
    deactivate();
  }

  /* 从原生节点读一遍真实样式，覆盖 CSS 变量 —— 原生主题变了这里跟着变 */
  function syncNativeMetrics() {
    var p = panelEl();
    if (!p) return;
    try {
      var h2 = document.querySelector('main h2');
      if (h2) {
        var c2 = getComputedStyle(h2);
        p.style.setProperty('--acg-h2-size', c2.fontSize);
        p.style.setProperty('--acg-h2-weight', c2.fontWeight);
      }
      // 行标题：原生设置项的名字是 .header 里的 p.title（实测 14px/#000），
      // 不能随便抓页面第一个 <p>（那可能是 12px 的欢迎语，会把整栏字缩一号）
      var rowTitle = document.querySelector('main .header p.title') ||
        document.querySelector('main .title > p') ||
        document.querySelector('main p.title');
      if (rowTitle) {
        var ct = getComputedStyle(rowTitle);
        if (ct.fontSize) p.style.setProperty('--acg-title-size', ct.fontSize);
        if (ct.color) p.style.setProperty('--acg-title-color', ct.color);
      }
      var rowDesc = document.querySelector('main .header p.description') ||
        document.querySelector('main p.description');
      if (rowDesc) {
        var cd = getComputedStyle(rowDesc);
        if (cd.fontSize) p.style.setProperty('--acg-desc-size', cd.fontSize);
        if (cd.color) p.style.setProperty('--acg-desc-color', cd.color);
      }
      var inp = document.querySelector('main input.input, main input[type=text], main input');
      if (inp) {
        var ci = getComputedStyle(inp);
        if (ci.borderTopColor) p.style.setProperty('--acg-input-border', ci.borderTopColor);
        if (ci.borderTopLeftRadius) p.style.setProperty('--acg-input-radius', ci.borderTopLeftRadius);
        if (ci.fontSize) p.style.setProperty('--acg-input-size', ci.fontSize);
      }
      var sel = document.querySelector('main select');
      if (sel) {
        var cs = getComputedStyle(sel);
        if (cs.borderTopColor) p.style.setProperty('--acg-select-border', cs.borderTopColor);
        if (cs.borderTopLeftRadius) p.style.setProperty('--acg-select-radius', cs.borderTopLeftRadius);
        if (cs.fontSize) p.style.setProperty('--acg-select-size', cs.fontSize);
      }
    } catch (e) { /* 读不到就用 CSS 里的实测默认值 */ }
  }

  /* ------------------------------------------------------------------ 挂载 */

  var observer = null;
  var remountScheduled = false;

  /** v1 的浮动入口（右下角 FAB）一律摘掉：v2 的入口是左侧导航里的「同步」。
   *  树里若还留着旧 patch（同时加载了 inject.js），这一步 + 置 __ACG_WEBDAV_INJECTED__
   *  会让它再也 mount 不回来 —— 页面上永远没有浮动按钮。 */
  function removeLegacyFab() {
    try { window.__ACG_WEBDAV_INJECTED__ = true; } catch (e) { /* ignore */ }
    var n = document.getElementById('__acg_webdav_entry__');
    if (n && n.parentNode) {
      n.parentNode.removeChild(n);
      return true;
    }
    return false;
  }

  function remountIfNeeded() {
    if (remountScheduled) return;
    remountScheduled = true;
    (window.requestAnimationFrame || setTimeout)(function () {
      remountScheduled = false;
      removeLegacyFab();
      ensureNav();
      ensurePanel();
      if (S.active) {
        var p = panelEl();
        if (p) p.classList.add('acg-on');
        hideNative(true);
        setActiveNav(true);
      }
    });
  }

  function ensurePanel() {
    var main = mainEl();
    if (!main) return null;
    var p = panelEl();
    if (p) {
      if (p.parentNode !== main) main.appendChild(p);
      // React 重渲染把面板冲掉后重建的节点要跟着「当前是否在同步栏」恢复可见性
      if (S.active) p.classList.add('acg-on');
      return p;
    }
    p = buildPanel();
    if (S.active) p.classList.add('acg-on');
    main.appendChild(p);
    S.mounted = true;
    syncNativeMetrics();
    reload().then(function () {
      log('就绪 · 服务器 ' + S.cfg.server);
      log('远端目录 ' + S.cfg.remoteDir + '（同步到该目录下的 ' + S.cfg.fileName + '）');
      log('同步范围 ' + S.desc.selected + ' / ' + S.desc.total + ' 个控制器' +
        (S.desc.all ? '（全部）' : '（按分组）'));
    }).catch(function (e) { log('初始化失败：' + (e.message || e), 'e'); });
    return p;
  }

  function startObserving() {
    if (observer) return;
    observer = new MutationObserver(function (records) {
      // 只关心「自己的节点被 React 冲掉」这种情况，避免自己改 DOM 引起的死循环
      var need = false;
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.removedNodes && r.removedNodes.length) {
          for (var j = 0; j < r.removedNodes.length; j++) {
            var n = r.removedNodes[j];
            if (n.id === NAV_ID || n.id === PANEL_ID) { need = true; break; }
          }
        }
        if (!need && r.type === 'childList' && r.target && r.target.tagName === 'MAIN' && !panelEl()) need = true;
        if (need) break;
      }
      if (need) remountIfNeeded();
      else {
        removeLegacyFab();
        if (S.active) hideNative(true);
      }
    });
    try {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    var hit = ['webdav-config-v1', 'webdav-sync-state-v1', 'webdav-history-v1', 'webdav-scope-v1'];
    if (!Object.keys(changes || {}).some(function (k) { return hit.indexOf(k) >= 0; })) return;
    // 只在面板可见时刷新，避免后台无关刷新抢焦点
    if (!S.active) return;
    reload().catch(function () { /* ignore */ });
  }

  function onPageHide() {
    try { if (observer) observer.disconnect(); } catch (e) { /* ignore */ }
    observer = null;
    try { document.removeEventListener('click', onAsideClick, true); } catch (e) { /* ignore */ }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) { /* ignore */ }
    try { chrome.alarms.onAlarm.removeListener(onAlarm); } catch (e) { /* ignore */ }
  }

  function onAlarm(a) {
    if (!a || a.name !== core.ALARM) return;
    log('alarm 到点：' + a.name + '（同步由 Service Worker 执行）', 'w');
    setTimeout(function () { if (S.active) reload().catch(function () { /* ignore */ }); }, 1200);
  }

  function boot() {
    injectCSS();
    removeLegacyFab();
    ensureNav();
    ensurePanel();
    startObserving();
    document.addEventListener('click', onAsideClick, true);
    try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (e) { /* ignore */ }
    try { chrome.alarms.onAlarm.addListener(onAlarm); } catch (e) { /* ignore */ }
    window.addEventListener('pagehide', onPageHide, { once: true });
    window.addEventListener('beforeunload', onPageHide, { once: true });

    // 设置页是 React 渲染的，aside/main 可能晚于本脚本出现：轮询几次兜底
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var ok = ensureNav() && ensurePanel();
      if (ok) { clearInterval(timer); startObserving(); }
      if (tries > 60) clearInterval(timer);
    }, 250);
  }

  /* 调试/自动化探针：headless 断言用，不参与 UI 逻辑 */
  window.__acgSync = {
    version: 'r4-settings-panel',
    state: function () { return S; },
    activate: activate,
    preview: async function () {
      var sc = await core.loadScope();
      var d = await core.describeScope(sc);
      var allow = await core.currentAllow(sc);
      return {
        all: d.all, total: d.total, selected: d.selected,
        allow: allow ? allow.length : null,
        groups: d.groups.map(function (g) { return { id: g.id, title: g.title, count: g.items.length, selected: g.selected, items: g.items }; })
      };
    },
    collectCount: async function () {
      var sc = await core.loadScope();
      var allow = await core.currentAllow(sc);
      var cfg = await core.loadConfig();
      var snap = await core.collectSnapshot(cfg.collectMode, { allow: allow });
      return {
        mode: snap.mode, items: Object.keys(snap.settings || {}).length,
        allow: allow ? allow.length : null,
        rawKeys: snap.raw ? Object.keys(snap.raw).length : 0,
        scope: snap.scope || null
      };
    },
    core: core
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
