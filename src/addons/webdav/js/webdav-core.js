/* =============================================================================
 * ACGhelper WebDAV 云同步 —— 核心库（经典脚本，页面与 Service Worker 共用）
 *
 * 设计要点
 *  1) 复用官方云同步协议：
 *       - 采集：chrome.runtime.sendMessage({target:'app', event:'getSettingsForUpload'})
 *               返回 {[itemName]: {settings, stores}}（与 acghelper.com/g 上传的 value 同构）
 *       - 下发：{target:'app', event:'setSettingsFromCloud', settings: {...}}
 *               走 BaseItem.setSettingsFromCloud → setSetting + setStore + onAfterSetSettingsFromCloud
 *     结论见 docs/webdav-sync.md「协议侦察」。
 *  2) 采集失败/在 SW 内（无法给自己发消息）时降级为原始 storage 快照：
 *       枚举 chrome.storage.local 的 <item>-config / <item>-data_<store> / <item>-store-names，
 *       排除运行时缓存 <item>-cache、<item>-cache-config 与本功能自身 webdav-* 键。
 *  3) WebDAV 服务端（Apache mod_dav）已知行为：
 *       - PUT 不回 ETag → 写完必须 GET 回读 + sha256 校验
 *       - PUT 到不存在的父目录 → 403 → 必须先逐级 MKCOL
 *       - 不使用条件请求（If-Match / If-None-Match），避免被当作前置条件而 412
 *  4) 冲突与回滚：任何一次写入远端之前，先把当前本地设置压一份历史快照
 *     （chrome.storage.local 的 webdav-history-v1，保留最近 5 份）；下载前同样先存本地快照。
 * ========================================================================== */
(function () {
  'use strict';

  var SCHEMA = 1;
  var CFG_KEY = 'webdav-config-v1';
  var STATE_KEY = 'webdav-sync-state-v1';
  var HIST_KEY = 'webdav-history-v1';
  var ALARM_NAME = 'webdav-autosync';
  var HIST_MAX = 5;
  var HIST_ITEM_MAX_BYTES = 4 * 1024 * 1024; // 单份快照上限，超出只存元信息
  var PROTO_TIMEOUT = 5000;

  var DEFAULTS = {
    // 用户要求「帮我自定义」：默认值就是真实可用的服务器与自己那份目录
    server: 'https://kurio.infini-cloud.net/dav/',
    username: '2697986947',
    password: 'REPLACE_WITH_YOUR_WEBDAV_APP_PASSWORD',
    remoteDir: '_acghelper/settings/',
    fileName: 'acghelper-settings.json',
    autoSync: false,
    intervalMinutes: 15,
    autoMode: 'upload', // upload | download | bidirectional
    verifyReadback: true,
    collectMode: 'auto' // auto | protocol | raw
  };

  /* 原始快照排除规则（依据见 docs/webdav-sync.md）
   *   -cache / -cache-config：BaseCache（initBackground.sw.js offset 19598 的
   *     this.name = `${owner.names.item}-cache`）里的运行时缓存与缓存限额配置，
   *     携带 lastAccess/limit 时间戳，跨机恢复会污染过期判定。
   *   webdav-*：本功能自身配置/状态/历史，不能被当成「设置」上传造成递归。 */
  var EXCLUDE_RULES = [
    { re: /^-?webdav-/, why: '本功能自身的配置/状态/历史键' },
    { re: /-cache$/, why: 'BaseCache 运行时缓存（含时间戳），不可跨机迁移' },
    { re: /-cache-config$/, why: 'BaseCache 缓存限额配置，同上' }
  ];

  /* -------------------------------------------------------------- 同步范围 */

  /* 「同步内容」分组：组 → 控制器键 的归类规则。
   *   * 首次命中即归类，顺序有意义（快捷键排在播放页/直播之前，否则 *Shortcuts 会被吃掉）
   *   * 最后一组没有 match，是兜底组：任何新版本冒出来的新控制器都会落到「其它」，
   *     不会出现「有设置但没被任何组覆盖 → 悄悄不同步」的漏键。
   *   * 默认全选；勾选结果存在 SCOPE_KEY，SW 侧定时同步读的是同一份，
   *     所以「设置页取消一组」和「alarm 到点自动上传」的口径永远一致。 */
  var SCOPE_KEY = 'webdav-scope-v1';
  var GROUPS = [
    { id: 'download', title: '下载设置', desc: '下载画质/命名/封面/字幕/稍后再看', match: [/download/i, /^watchLater$/i] },
    { id: 'hotkey', title: '快捷键', desc: '播放页与直播页的键盘快捷键', match: [/shortcuts/i] },
    { id: 'playback', title: '播放页设置', desc: '播放模式/倍速/画质/弹幕/播放页布局', match: [/^video/i, /^listenVideo$/, /^historyWatched$/, /^mainAnime$/, /^mainManga$/] },
    { id: 'live', title: '直播设置', desc: '直播画质/弹幕/表情/录制/截图', match: [/live/i] },
    { id: 'message', title: '消息推送', desc: '私信/动态/特别关注/桌面通知', match: [/message/i, /notif/i, /^specialAttention$/, /^subscriptionDynamic$/] },
    { id: 'filter', title: '白名单与过滤', desc: '评论/弹幕/动态过滤、广告与代理白名单', match: [/filter/i, /^ad$/, /^proxyForWebsite$/] },
    { id: 'ui', title: '导航与弹窗', desc: '弹窗面板/地址栏搜索/主站导航/深色模式/语言', match: [/popup/i, /omnibox/i, /quickSearch/i, /^main/i, /^darkMode$/, /^language$/, /^redirectSSR$/, /^tab/i, /^cvImage/i] },
    { id: 'misc', title: '其它', desc: '账号/权限/网络/存储等剩余控制器', match: [] }
  ];

  function groupIdOfItem(name) {
    for (var i = 0; i < GROUPS.length - 1; i++) {
      var m = GROUPS[i].match;
      for (var j = 0; j < m.length; j++) if (m[j].test(name)) return GROUPS[i].id;
    }
    return GROUPS[GROUPS.length - 1].id;
  }

  function defaultScope() {
    var groups = {};
    GROUPS.forEach(function (g) { groups[g.id] = true; });
    return { all: true, groups: groups, updatedAt: null };
  }

  async function loadScope() {
    var got = await chrome.storage.local.get(SCOPE_KEY);
    var raw = (got && got[SCOPE_KEY]) || null;
    var def = defaultScope();
    if (!raw) return def;
    var groups = Object.assign({}, def.groups);
    Object.keys(raw.groups || {}).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(groups, k)) groups[k] = !!raw.groups[k];
    });
    return { all: typeof raw.all === 'boolean' ? raw.all : true, groups: groups, updatedAt: raw.updatedAt || null };
  }

  async function saveScope(patch) {
    var cur = await loadScope();
    var next = {
      all: patch && typeof patch.all === 'boolean' ? patch.all : cur.all,
      groups: Object.assign({}, cur.groups, (patch && patch.groups) || {}),
      updatedAt: nowISO()
    };
    await chrome.storage.local.set({ [SCOPE_KEY]: next });
    return next;
  }

  function scopeAllows(scope, name) {
    if (!scope || scope.all !== false) return true;
    return !!(scope.groups && scope.groups[groupIdOfItem(name)]);
  }

  /** 按组统计：{groups:[{id,title,desc,items:[...],selected}], total, selected} */
  async function describeScope(scope) {
    scope = scope || (await loadScope());
    var names = await listItemNames();
    var map = {};
    GROUPS.forEach(function (g) { map[g.id] = { id: g.id, title: g.title, desc: g.desc, items: [], selected: !!scope.groups[g.id] }; });
    names.forEach(function (n) { map[groupIdOfItem(n)].items.push(n); });
    var groups = GROUPS.map(function (g) { return map[g.id]; });
    var selected = scope.all === false
      ? groups.filter(function (g) { return g.selected; }).reduce(function (a, g) { return a + g.items.length; }, 0)
      : names.length;
    return { all: scope.all !== false, groups: groups, total: names.length, selected: selected };
  }

  /** 允许名单：null 表示不过滤（「全部」打开）。返回数组时是明确的控制器名白名单。 */
  async function currentAllow(scope) {
    scope = scope || (await loadScope());
    if (scope.all !== false) return null;
    var names = await listItemNames();
    return names.filter(function (n) { return scopeAllows(scope, n); });
  }

  function normalizeAllow(allow) {
    if (!allow || !allow.length) return null;
    var set = Object.create(null);
    for (var i = 0; i < allow.length; i++) set[allow[i]] = true;
    return set;
  }

  function allowedBy(set, name) {
    return !set || !!set[name];
  }

  /** 从 raw 键名里取出控制器名（<item>-config / -data_<store> / -store-names） */
  function itemNameOfKey(key) {
    var m;
    if ((m = /^(.+?)-config$/.exec(key))) return m[1];
    if ((m = /^(.+?)-data_(.+)$/.exec(key))) return m[1];
    if ((m = /^(.+?)-store-names$/.exec(key))) return m[1];
    return null;
  }

  /* ------------------------------------------------------------------ 工具 */

  function isSW() {
    return typeof document === 'undefined';
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function bytesToHex(buf) {
    var b = new Uint8Array(buf);
    var out = '';
    for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out;
  }

  async function sha256Hex(data) {
    var bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    var dig = await crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(dig);
  }

  function utf8ToBytes(str) {
    return new TextEncoder().encode(str);
  }

  /** UTF-8 安全 base64（btoa 只吃 Latin-1） */
  function b64(str) {
    var bytes = utf8ToBytes(str);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function extVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return 'unknown';
    }
  }

  function kvSize(obj) {
    try {
      return new TextEncoder().encode(JSON.stringify(obj || {})).length;
    } catch (e) {
      return 0;
    }
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* --------------------------------------------------------------- 配置存取 */

  async function loadConfig() {
    var got = await chrome.storage.local.get(CFG_KEY);
    var cfg = Object.assign({}, DEFAULTS, got && got[CFG_KEY] ? got[CFG_KEY] : {});
    if (!/^https?:\/\//i.test(cfg.server)) cfg.server = DEFAULTS.server;
    if (!/\/$/.test(cfg.server)) cfg.server += '/';
    return cfg;
  }

  async function saveConfig(patch) {
    var cfg = Object.assign(await loadConfig(), patch || {});
    cfg.intervalMinutes = Number(cfg.intervalMinutes) || 15;
    if ([5, 15, 60].indexOf(cfg.intervalMinutes) < 0) cfg.intervalMinutes = 15;
    if (!/^https?:\/\//i.test(cfg.server)) throw new Error('服务器地址必须以 http(s):// 开头');
    if (!/\/$/.test(cfg.server)) cfg.server += '/';
    if (!/\/$/.test(cfg.remoteDir)) cfg.remoteDir += '/';
    await chrome.storage.local.set({ [CFG_KEY]: cfg });
    return cfg;
  }

  async function getState() {
    var got = await chrome.storage.local.get(STATE_KEY);
    return (got && got[STATE_KEY]) || {};
  }

  async function setState(patch) {
    var s = Object.assign(await getState(), patch || {});
    await chrome.storage.local.set({ [STATE_KEY]: s });
    return s;
  }

  /* ------------------------------------------------------------ WebDAV 客户端 */

  function splitServer(server) {
    var u = new URL(server);
    var basePath = u.pathname.replace(/\/+$/, ''); // '/dav'
    return { origin: u.origin, basePath: basePath };
  }

  /** rel 以 / 结尾视为目录，返回完整 URL */
  function davUrl(cfg, rel) {
    var p = splitServer(cfg.server);
    var isDir = /\/$/.test(rel || '');
    var segs = String(rel || '').split('/').filter(function (s) { return s.length > 0; })
      .map(function (s) { return encodeURIComponent(s); });
    var path = p.basePath + (segs.length ? '/' + segs.join('/') : '/');
    if (isDir && !/\/$/.test(path)) path += '/';
    return p.origin + path;
  }

  function headerGet(headers, name) {
    if (!headers || !headers.get) return null;
    return headers.get(name);
  }

  /**
   * 发一个 WebDAV 请求。
   * @returns {{ok:boolean,status:number,text:string,bytes:Uint8Array,headers:Object,error?:string,url:string}}
   */
  async function davRequest(cfg, method, rel, opts) {
    opts = opts || {};
    var url = davUrl(cfg, rel);
    var headers = {
      Authorization: 'Basic ' + b64(String(cfg.username) + ':' + String(cfg.password))
    };
    if (opts.headers) {
      for (var k in opts.headers) if (Object.prototype.hasOwnProperty.call(opts.headers, k)) headers[k] = opts.headers[k];
    }
    var body = opts.body;
    if (body && typeof body === 'string') body = utf8ToBytes(body);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, opts.timeoutMs || 30000);
    try {
      var resp = await fetch(url, {
        method: method,
        headers: headers,
        body: body,
        signal: ctrl ? ctrl.signal : undefined,
        cache: 'no-store',
        redirect: 'follow',
        credentials: 'omit'
      });
      var buf = new Uint8Array(0);
      if (method !== 'HEAD') {
        var ab = await resp.arrayBuffer();
        buf = new Uint8Array(ab);
      }
      var hobj = {};
      try {
        resp.headers.forEach(function (v, k) { hobj[k] = v; });
      } catch (e) { /* 某些上下文无 forEach */ }
      return {
        ok: resp.ok,
        status: resp.status,
        text: new TextDecoder('utf-8').decode(buf),
        bytes: buf,
        headers: hobj,
        url: url
      };
    } catch (e) {
      return {
        ok: false, status: 0, text: '', bytes: new Uint8Array(0), headers: {},
        error: (e && e.name === 'AbortError') ? ('请求超时（' + (opts.timeoutMs || 30000) + 'ms）') : String(e && e.message ? e.message : e),
        url: url
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 逐级 MKCOL。已存在（405）视为成功。父目录缺失导致的 403/409 会带出来明确报错。 */
  async function ensureDirs(cfg, dirRel) {
    var segs = String(dirRel || '').split('/').filter(function (s) { return s.length > 0; });
    var acc = [];
    var created = [];
    for (var i = 0; i < segs.length; i++) {
      acc.push(segs[i]);
      var path = acc.join('/') + '/';
      var r = await davRequest(cfg, 'MKCOL', path, { timeoutMs: 30000 });
      if (r.status === 201) { created.push(path); continue; }
      if (r.status === 405) continue; // 已存在
      if (r.status === 200 || r.status === 204) continue;
      var err = new Error('MKCOL ' + path + ' 失败：HTTP ' + r.status +
        (r.error ? ' / ' + r.error : '') +
        // 服务端 401/502 回的是 HTML 页，直接塞进 UI 会显示成一坨标签 —— 这里先去标签再截断
        (r.text ? ' / ' + r.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : ''));
      // 把状态码与响应体带出来，UI 才能显示「401 + 服务端片段」而不是一句干巴巴的失败
      err.status = r.status;
      err.text = r.text || '';
      err.davPath = path;
      throw err;
    }
    return created;
  }

  function remoteFilePath(cfg) {
    var dir = String(cfg.remoteDir || '').replace(/^\/+/, '');
    if (!/\/$/.test(dir) && dir.length) dir += '/';
    return dir + String(cfg.fileName || DEFAULTS.fileName);
  }

  /* -------------------------------------------------------------- 设置采集 */

  function isExcludedKey(key) {
    for (var i = 0; i < EXCLUDE_RULES.length; i++) if (EXCLUDE_RULES[i].re.test(key)) return true;
    return false;
  }

  /** 给 SW 发消息（带超时；SW 未就绪时返回 null 而不是挂死） */
  function sendToApp(event, extra, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs || PROTO_TIMEOUT);
      var msg = Object.assign({ target: 'app', event: event }, extra || {});
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          // 读掉 lastError，避免 "Unchecked runtime.lastError"
          void chrome.runtime.lastError;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(resp === undefined ? null : resp);
        });
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /** 给某个控制器发消息（逐 feature 采集用） */
  function sendToItem(itemName, event, extra, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs || 1000);
      try {
        chrome.runtime.sendMessage(Object.assign({ target: itemName, event: event }, extra || {}), function (resp) {
          void chrome.runtime.lastError;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(resp === undefined ? null : resp);
        });
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /** 从 storage 键名反推已实例化的控制器名（<item>-config / <item>-data_<store> / <item>-store-names） */
  async function listItemNames() {
    var all = await chrome.storage.local.get(null);
    var names = Object.create(null);
    Object.keys(all || {}).forEach(function (key) {
      if (isExcludedKey(key)) return;
      var m;
      if ((m = /^(.+?)-config$/.exec(key)) || (m = /^(.+?)-data_(.+)$/.exec(key)) || (m = /^(.+?)-store-names$/.exec(key))) {
        if (m[1] !== 'app') names[m[1]] = true;
      }
    });
    return Object.keys(names).sort();
  }

  /**
   * 复用官方云同步协议采集：**逐控制器**发 getSettingsForUpload。
   *
   * 为什么不是一条 {target:'app', event:'getSettingsForUpload'}：
   *   实测（logs/webdav-cdp.log / docs/webdav-sync.md）那条聚合通道恒返回 `{}`——
   *   聚合 handler 里写的是 `const t = await e.getSettingsForUpload(void 0,void 0,id=>id)`，
   *   而各控制器的 `getSettingsForUpload=async(e,t,n)=>{n({settings:...})}` 返回值是 undefined，
   *   回调结果被丢掉，于是 `if (t)` 全部为假 → 空对象。官方自己的上传路径
   *   （initBackground.sw.js offset 96878）也是逐 feature 发消息的，只有这种能拿到数据。
   *
   * 不实现 getSettingsForUpload 的控制器（base 里是空函数，如 bilibiliAccountController）
   * 永不回调，用 1s 短超时跳过，记入 silent 列表。
   */
  async function collectViaProtocol(allow) {
    var set = normalizeAllow(allow);
    var all = await listItemNames();
    var items = all.filter(function (n) { return allowedBy(set, n); });
    var out = {};
    var silent = [];
    var CONCURRENCY = 10;
    var TIMEOUT = 1000;
    for (var i = 0; i < items.length; i += CONCURRENCY) {
      var batch = items.slice(i, i + CONCURRENCY);
      var resps = await Promise.all(batch.map(function (name) {
        return sendToItem(name, 'getSettingsForUpload', null, TIMEOUT);
      }));
      batch.forEach(function (name, k) {
        var r = resps[k];
        if (r && typeof r === 'object' && (r.settings || r.stores)) out[name] = r;
        else silent.push(name);
      });
    }
    return {
      mode: 'protocol', settings: out, silent: silent, candidates: items.length,
      scopeTotal: all.length, scopeSkipped: all.length - items.length
    };
  }

  /** 原始 storage 采集（排除缓存与本功能自身键 + 按允许名单过滤控制器） */
  async function collectRaw(allow) {
    var set = normalizeAllow(allow);
    var all = await chrome.storage.local.get(null);
    var settings = {};
    var raw = {};
    var skipped = [];
    var scopeSkipped = [];
    Object.keys(all || {}).sort().forEach(function (key) {
      if (isExcludedKey(key)) { skipped.push(key); return; }
      var name = itemNameOfKey(key);
      if (name && !allowedBy(set, name)) { scopeSkipped.push(key); return; }
      raw[key] = all[key];
      var mCfg = /^(.+?)-config$/.exec(key);
      if (mCfg) {
        settings[mCfg[1]] = settings[mCfg[1]] || { settings: {}, stores: {} };
        settings[mCfg[1]].settings = all[key];
        return;
      }
      var mData = /^(.+?)-data_(.+)$/.exec(key);
      if (mData) {
        settings[mData[1]] = settings[mData[1]] || { settings: {}, stores: {} };
        settings[mData[1]].stores = settings[mData[1]].stores || {};
        settings[mData[1]].stores[mData[2]] = all[key];
        return;
      }
      var mNames = /^(.+?)-store-names$/.exec(key);
      if (mNames) {
        settings[mNames[1]] = settings[mNames[1]] || { settings: {}, stores: {} };
        settings[mNames[1]].storeNames = all[key];
      }
    });
    return { mode: 'raw', settings: settings, raw: raw, skipped: skipped, scopeSkipped: scopeSkipped.length };
  }

  /**
   * 采集一份设置快照。
   * mode: 'auto'（官方协议 + 原始快照都拿）/ 'protocol' / 'raw'
   * opts.allow: 控制器名白名单数组；null/省略 = 不过滤（「全部」）
   * 页面里 'auto' 会同时产出：
   *   settings —— 官方协议形状 {[item]:{settings,stores}}，用于走 setSettingsFromCloud 下发
   *   raw      —— 原始键值，用于协议通道失效时精确回填
   */
  async function collectSnapshot(mode, opts) {
    mode = mode || 'auto';
    var allow = opts && Object.prototype.hasOwnProperty.call(opts, 'allow') ? opts.allow : undefined;
    if (allow === undefined) allow = await currentAllow();
    var protocol = null;
    var raw = null;

    if (mode !== 'raw' && !isSW()) {
      // SW 刚被唤醒时 app 控制器可能还没注册监听，重试一轮
      for (var attempt = 0; attempt < 2; attempt++) {
        var p = await collectViaProtocol(allow);
        if (p && Object.keys(p.settings).length > 0) { protocol = p; break; }
        await new Promise(function (r) { setTimeout(r, 700); });
      }
      if (!protocol && mode === 'protocol') {
        throw new Error('官方协议采集无响应（SW 未就绪或控制器未注册 getSettingsForUpload），可切换为原始快照模式');
      }
    }

    if (mode !== 'protocol' || !protocol) raw = await collectRaw(allow);

    var scopeMeta = {
      allow: allow || null,
      allowCount: allow ? allow.length : null,
      scopeSkipped: (raw && raw.scopeSkipped) || (protocol && protocol.scopeSkipped) || 0
    };

    if (protocol && raw) {
      // 协议形状优先补全：raw 里能解析出 settings 的项若协议没给，就以 raw 的为准
      var merged = Object.assign({}, raw.settings, protocol.settings);
      return {
        mode: 'protocol+raw', settings: merged, raw: raw.raw, skipped: raw.skipped,
        silent: protocol.silent || [], candidates: protocol.candidates || 0,
        protocolItems: Object.keys(protocol.settings).length, scope: scopeMeta
      };
    }
    if (protocol) {
      return { mode: 'protocol', settings: protocol.settings, skipped: [],
               silent: protocol.silent || [], candidates: protocol.candidates || 0,
               protocolItems: Object.keys(protocol.settings).length, scope: scopeMeta };
    }
    raw.scope = scopeMeta;
    return raw;
  }

  /* -------------------------------------------------------------- 设置下发 */

  async function applySnapshot(payload, mode) {
    if (!payload || typeof payload !== 'object') throw new Error('远端内容不是合法 JSON 对象');
    mode = mode || payload.mode || 'auto';

    if (mode !== 'raw' && payload.settings) {
      var ok = await sendToApp('setSettingsFromCloud', { settings: payload.settings });
      if (ok === true) return { applied: 'protocol', keys: Object.keys(payload.settings).length };
      if (mode === 'protocol') throw new Error('官方协议下发失败（SW 未响应 setSettingsFromCloud）');
    }
    if (!payload.raw) {
      throw new Error('远端快照缺少 raw 段，且官方协议下发未生效，无法回填');
    }
    var keys = Object.keys(payload.raw);
    var CHUNK = 60;
    for (var i = 0; i < keys.length; i += CHUNK) {
      var part = {};
      keys.slice(i, i + CHUNK).forEach(function (k) { part[k] = payload.raw[k]; });
      await chrome.storage.local.set(part);
    }
    return { applied: 'raw', keys: keys.length };
  }

  /* ---------------------------------------------------------------- 历史快照 */

  async function historyList() {
    var got = await chrome.storage.local.get(HIST_KEY);
    return (got && got[HIST_KEY]) || [];
  }

  async function historyPush(entry) {
    var list = await historyList();
    var bytes = kvSize(entry.payload);
    var rec = {
      at: nowISO(),
      kind: entry.kind,
      reason: entry.reason || '',
      sha256: entry.sha256 || null,
      bytes: bytes,
      mode: entry.mode || (entry.payload && entry.payload.mode) || 'unknown',
      payload: bytes <= HIST_ITEM_MAX_BYTES ? entry.payload : null,
      truncated: bytes > HIST_ITEM_MAX_BYTES
    };
    list.unshift(rec);
    while (list.length > HIST_MAX) list.pop();
    await chrome.storage.local.set({ [HIST_KEY]: list });
    return rec;
  }

  async function historyRestore(index) {
    var list = await historyList();
    var rec = list[index];
    if (!rec || !rec.payload) throw new Error('第 ' + index + ' 份快照不存在或已被截断');
    // 恢复前先存当前状态，保证可再回滚
    var cur = await collectSnapshot('raw');
    await historyPush({ kind: 'pre-restore', reason: '恢复历史快照 #' + index, payload: wrap(cur), mode: cur.mode });
    return await applySnapshot(rec.payload, rec.payload.mode || 'raw');
  }

  /* ------------------------------------------------------------------ 载荷 */

  function wrap(collected) {
    var p = {
      schema: SCHEMA,
      exportedAt: nowISO(),
      extensionVersion: extVersion(),
      mode: collected.mode,
      settings: collected.settings
    };
    if (collected.raw) p.raw = collected.raw;
    // 只在真的做了分组过滤时才写 scope 段：不过滤的载荷与上一版逐字节一致
    if (collected.scope && collected.scope.allow) {
      p.scope = { allowCount: collected.scope.allowCount, allow: collected.scope.allow };
    }
    return p;
  }

  /** 键序归一化：对象的键递归排序，保证「同一内容 → 同一字节串 → 同一 sha256」。
   *  没有这一步，远端读回来的 JSON（已排序）和本地实时对象（插入序）会被误判成「有差异」。 */
  function canonicalReplacer(k, v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      var out = {};
      Object.keys(v).sort().forEach(function (kk) { out[kk] = v[kk]; });
      return out;
    }
    return v;
  }

  function serialize(payload) {
    return JSON.stringify(payload, canonicalReplacer);
  }

  function canonicalJSON(v) {
    return JSON.stringify(v, canonicalReplacer);
  }

  /* -------------------------------------------------------------- 上传/下载 */

  async function uploadSettings(opts) {
    opts = opts || {};
    var cfg = await loadConfig();
    var t0 = Date.now();
    // 允许名单：opts.allow 显式给出时用它（null = 全部）；否则按设置页勾选的「同步内容」分组解析
    var allow = Object.prototype.hasOwnProperty.call(opts, 'allow') ? opts.allow : await currentAllow();
    var collected = await collectSnapshot(cfg.collectMode, { allow: allow });
    var payload = wrap(collected);
    var body = serialize(payload);
    var bytes = utf8ToBytes(body);
    var localSha = await sha256Hex(bytes);
    var localFp = await settingsFingerprint(payload);

    // ① 先把本地当前设置压一份历史快照（避免上传后本地/远端互相覆盖丢数据）
    await historyPush({
      kind: 'pre-upload', reason: opts.reason || 'manual',
      payload: payload, sha256: localSha, mode: collected.mode
    });

    // ② 逐级建目录（服务端 PUT 到不存在的父目录返回 403）
    var created = await ensureDirs(cfg, cfg.remoteDir);

    // ③ PUT
    var fileRel = remoteFilePath(cfg);
    var put = await davRequest(cfg, 'PUT', fileRel, {
      body: bytes,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      timeoutMs: 60000
    });
    if (!(put.status === 200 || put.status === 201 || put.status === 204)) {
      var errMsg = 'PUT 失败：HTTP ' + put.status +
        (put.error ? ' / ' + put.error : '') +
        (put.text ? ' / ' + put.text.replace(/\s+/g, ' ').slice(0, 240) : '');
      await setState({
        lastSyncAt: nowISO(), lastDirection: 'upload', lastResult: 'fail',
        lastHttp: put.status, lastError: errMsg, elapsedMs: Date.now() - t0
      });
      throw new Error(errMsg);
    }

    // ④ GET 回读 + sha256（服务端 PUT 不回 ETag，只能自己验）
    var readBack = { checked: false, match: null, sha256: null, bytes: 0, http: null };
    if (cfg.verifyReadback) {
      var got = await davRequest(cfg, 'GET', fileRel, { timeoutMs: 60000 });
      readBack.http = got.status;
      readBack.bytes = got.bytes.length;
      if (got.status === 200) {
        readBack.checked = true;
        readBack.sha256 = await sha256Hex(got.bytes);
        readBack.match = readBack.sha256 === localSha;
      }
      if (!readBack.checked || !readBack.match) {
        var msg = 'PUT 后回读校验失败：HTTP ' + got.status +
          ' 本地 sha256=' + localSha + ' 远端 sha256=' + (readBack.sha256 || '(读取失败)');
        await setState({
          lastSyncAt: nowISO(), lastDirection: 'upload', lastResult: 'fail',
          lastHttp: put.status, lastError: msg, elapsedMs: Date.now() - t0,
          localSha256: localSha, remoteSha256: readBack.sha256
        });
        throw new Error(msg);
      }
    }

    var state = await setState({
      lastSyncAt: nowISO(), lastDirection: 'upload', lastResult: 'ok',
      lastHttp: put.status, lastError: null,
      localSha256: localSha, remoteSha256: readBack.sha256 || localSha,
      localSettingsSha256: localFp, remoteSettingsSha256: localFp,
      lastLocalSettingsSha256: localFp, lastRemoteSettingsSha256: localFp,
      remoteBytes: readBack.bytes || bytes.length, localBytes: bytes.length,
      remoteFile: fileRel, elapsedMs: Date.now() - t0, conflict: false,
      createdDirs: created
    });
    await chrome.storage.local.set({ 'webdav-last-upload': { at: nowISO(), sha256: localSha, file: fileRel } });
    return { ok: true, http: put.status, sha256: localSha, remoteSha256: readBack.sha256, bytes: bytes.length, state: state, payload: payload };
  }

  async function fetchRemote(cfg) {
    var fileRel = remoteFilePath(cfg);
    var got = await davRequest(cfg, 'GET', fileRel, { timeoutMs: 60000 });
    if (got.status === 404) return { exists: false, http: 404, bytes: 0, file: fileRel };
    if (got.status !== 200) {
      throw new Error('GET ' + fileRel + ' 失败：HTTP ' + got.status +
        (got.error ? ' / ' + got.error : '') +
        (got.text ? ' / ' + got.text.replace(/\s+/g, ' ').slice(0, 240) : ''));
    }
    var sha = await sha256Hex(got.bytes);
    var text = got.text;
    var payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      throw new Error('远端文件不是合法 JSON（' + text.slice(0, 120).replace(/\s+/g, ' ') + '…）');
    }
    return { exists: true, http: 200, bytes: got.bytes.length, sha256: sha, payload: payload, file: fileRel, headers: got.headers };
  }

  async function downloadSettings(opts) {
    opts = opts || {};
    var cfg = await loadConfig();
    var t0 = Date.now();
    var remote = await fetchRemote(cfg);
    if (!remote.exists) throw new Error('远端还没有备份文件：' + remoteFilePath(cfg) + '（先执行一次「立即上传」）');

    // ① 下载前先把当前设置导出成本地快照 —— 覆盖前最后一道保险
    //    这份保险**必须是全量**（不过滤）：分组过滤只决定「往远端传什么」，
    //    不影响「回滚本地时要能恢复一切」。
    var current = await collectSnapshot(cfg.collectMode, { allow: null });
    var curWrap = wrap(current);
    var curBody = serialize(curWrap);
    var curSha = await sha256Hex(curBody);
    var curFp = await settingsFingerprint(curWrap);
    var remoteFp = await settingsFingerprint(remote.payload);
    await historyPush({
      kind: 'pre-download', reason: opts.reason || 'manual',
      payload: curWrap, sha256: curSha, mode: current.mode
    });

    // ② 下发（官方协议优先，失败降级 raw）
    var applied = await applySnapshot(remote.payload, cfg.collectMode === 'raw' ? 'raw' : (remote.payload.mode || 'auto'));

    var state = await setState({
      lastSyncAt: nowISO(), lastDirection: 'download', lastResult: 'ok',
      lastHttp: 200, lastError: null,
      remoteSha256: remote.sha256, localSha256: curSha,
      localSettingsSha256: curFp, remoteSettingsSha256: remoteFp,
      lastLocalSettingsSha256: curFp, lastRemoteSettingsSha256: remoteFp,
      remoteBytes: remote.bytes, localBytes: curBody.length,
      remoteFile: remote.file, elapsedMs: Date.now() - t0, conflict: false,
      exportedAt: remote.payload && remote.payload.exportedAt || null,
      appliedVia: applied.applied, appliedKeys: applied.keys
    });
    return { ok: true, http: 200, sha256: remote.sha256, bytes: remote.bytes, applied: applied, state: state, payload: remote.payload };
  }

  /* ------------------------------------------------------------------ 差异 */

  function summarizeSettings(map) {
    var out = {};
    Object.keys(map || {}).sort().forEach(function (item) {
      var v = map[item] || {};
      var merged = Object.assign({}, v.settings || {});
      if (v.stores && Object.keys(v.stores).length) merged.__stores = Object.keys(v.stores).sort();
      out[item] = canonicalJSON(merged);
    });
    return out;
  }

  /** 设置内容指纹：只算 settings（不含 exportedAt / 扩展版本），用于判断「内容是否一致」 */
  async function settingsFingerprint(payload) {
    return await sha256Hex(serialize({ settings: (payload && payload.settings) || {} }));
  }

  async function diffRemote(opts) {
    opts = opts || {};
    var cfg = await loadConfig();
    var allow = Object.prototype.hasOwnProperty.call(opts, 'allow') ? opts.allow : await currentAllow();
    var remote = await fetchRemote(cfg);
    var current = await collectSnapshot(cfg.collectMode, { allow: allow });
    var localPayload = wrap(current);
    var localBody = serialize(localPayload);
    var localBytes = utf8ToBytes(localBody).length;
    var localSha = await sha256Hex(localBody);
    var localFp = await settingsFingerprint(localPayload);

    if (!remote.exists) {
      return {
        ok: true, exists: false, identical: false,
        localBytes: localBytes, remoteBytes: 0,
        localSha256: localSha, remoteSha256: null,
        localSettingsSha256: localFp, remoteSettingsSha256: null,
        added: [], removed: [], changed: [],
        localItems: Object.keys(current.settings || {}).length,
        remoteItems: 0, remoteFile: remote.file
      };
    }

    var a = summarizeSettings(current.settings);
    var b = summarizeSettings(remote.payload && remote.payload.settings);
    var added = [], removed = [], changed = [];
    Object.keys(b).forEach(function (k) {
      if (!(k in a)) added.push(k);
      else if (a[k] !== b[k]) changed.push(k);
    });
    Object.keys(a).forEach(function (k) { if (!(k in b)) removed.push(k); });
    var remoteFp = await settingsFingerprint(remote.payload);

    return {
      ok: true, exists: true,
      // 「一致」按设置内容算：exportedAt 每次都不同，整包字节比对永远不等，不能当冲突依据
      identical: remoteFp === localFp && added.length === 0 && removed.length === 0 && changed.length === 0,
      localBytes: localBytes, remoteBytes: remote.bytes,
      localSha256: localSha, remoteSha256: remote.sha256,
      localSettingsSha256: localFp, remoteSettingsSha256: remoteFp,
      added: added, removed: removed, changed: changed,
      localItems: Object.keys(a).length, remoteItems: Object.keys(b).length,
      remoteExportedAt: remote.payload && remote.payload.exportedAt || null,
      remoteVersion: remote.payload && remote.payload.extensionVersion || null,
      remoteMode: remote.payload && remote.payload.mode || null,
      remoteFile: remote.file
    };
  }

  /* ------------------------------------------------------------ 连接自检 */

  /** 把服务端响应体压成一行片段，塞进步骤里给 UI 显示（401 的 realm、502 的 nginx 页都靠它） */
  function snippetOf(r) {
    var t = r && r.text ? String(r.text) : '';
    t = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 180) : null;
  }

  async function testConnection() {
    var cfg = await loadConfig();
    var out = { ok: false, steps: [] };
    var t0 = Date.now();

    var opt = await davRequest(cfg, 'OPTIONS', '', { timeoutMs: 20000 });
    out.steps.push({
      step: 'OPTIONS ' + cfg.server, http: opt.status,
      dav: (opt.headers && (opt.headers.dav || opt.headers.DAV)) || null,
      allow: (opt.headers && (opt.headers.allow || opt.headers.Allow)) || null,
      error: opt.error || null,
      snippet: snippetOf(opt)
    });
    if (opt.status === 401) {
      out.error = 'HTTP 401：用户名或应用密码错误（Basic Auth 被拒）';
      out.elapsedMs = Date.now() - t0;
      await setState({ lastTestAt: nowISO(), lastTestResult: 'fail', lastError: out.error });
      return out;
    }
    if (opt.status === 0) {
      out.error = '网络不可达：' + (opt.error || '未知原因');
      out.elapsedMs = Date.now() - t0;
      await setState({ lastTestAt: nowISO(), lastTestResult: 'fail', lastError: out.error });
      return out;
    }

    // MKCOL 逐级建目录（幂等）
    try {
      var created = await ensureDirs(cfg, cfg.remoteDir);
      out.steps.push({ step: 'MKCOL ' + cfg.remoteDir, http: 201, created: created, note: created.length ? '本次新建' : '已存在（405 视为成功）' });
    } catch (e) {
      out.steps.push({
        step: 'MKCOL ' + cfg.remoteDir,
        http: (e && typeof e.status === 'number') ? e.status : null,
        error: String(e.message || e),
        snippet: e && e.text ? snippetOf({ text: e.text }) : null
      });
      out.error = '目录创建失败：' + (e.message || e);
      out.elapsedMs = Date.now() - t0;
      await setState({ lastTestAt: nowISO(), lastTestResult: 'fail', lastError: out.error });
      return out;
    }
    // 探活文件：_probe 目录（只用 _acghelper 下，绝不碰用户既有目录）
    var probeRel = String(cfg.remoteDir).replace(/\/+$/, '') + '/_probe/probe.json';
    try {
      await ensureDirs(cfg, String(cfg.remoteDir).replace(/\/+$/, '') + '/_probe/');
      var body = utf8ToBytes(JSON.stringify({ t: nowISO(), probe: true }));
      var want = await sha256Hex(body);
      var put = await davRequest(cfg, 'PUT', probeRel, { body: body, headers: { 'Content-Type': 'application/json' }, timeoutMs: 30000 });
      out.steps.push({ step: 'PUT ' + probeRel, http: put.status, bytes: body.length, note: 'PUT 响应无 ETag（服务端行为）', snippet: snippetOf(put) });
      if (!(put.status === 200 || put.status === 201 || put.status === 204)) {
        throw new Error('PUT 探活失败：HTTP ' + put.status + (put.text ? ' / ' + put.text.replace(/\s+/g, ' ').slice(0, 160) : ''));
      }
      var get = await davRequest(cfg, 'GET', probeRel, { timeoutMs: 30000 });
      var gotSha = get.status === 200 ? await sha256Hex(get.bytes) : null;
      out.steps.push({ step: 'GET ' + probeRel, http: get.status, bytes: get.bytes.length, sha256Match: gotSha === want, localSha256: want, remoteSha256: gotSha });
      if (gotSha !== want) throw new Error('回读 sha256 不一致：' + want + ' vs ' + gotSha);
      var del = await davRequest(cfg, 'DELETE', probeRel, { timeoutMs: 30000 });
      var delDir = await davRequest(cfg, 'DELETE', String(cfg.remoteDir).replace(/\/+$/, '') + '/_probe/', { timeoutMs: 30000 });
      out.steps.push({ step: 'DELETE _probe', http: del.status, httpDir: delDir.status, note: '探活文件已清理' });
      out.ok = true;
    } catch (e) {
      out.error = '探活失败：' + (e.message || e);
    }
    out.elapsedMs = Date.now() - t0;
    await setState({
      lastTestAt: nowISO(), lastTestResult: out.ok ? 'ok' : 'fail',
      lastError: out.ok ? null : out.error
    });
    return out;
  }

  /* -------------------------------------------------------------- 自动同步 */

  async function scheduleAlarm(cfg) {
    cfg = cfg || (await loadConfig());
    if (!cfg.autoSync) {
      await chrome.alarms.clear(ALARM_NAME);
      return null;
    }
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: cfg.intervalMinutes,
      periodInMinutes: cfg.intervalMinutes
    });
    return await chrome.alarms.get(ALARM_NAME);
  }

  async function alarmInfo() {
    try {
      return await chrome.alarms.get(ALARM_NAME);
    } catch (e) {
      return null;
    }
  }

  /**
   * 自动同步一次。冲突策略：
   *   与上次同步记录比对 —— 只有「单边变化」才自动执行；
   *   两边都变 → 记 conflict，不覆盖任何一侧（页面提示手动比对差异）。
   */
  async function autoTick(reason) {
    var cfg = await loadConfig();
    if (!cfg.autoSync) return { ok: false, skipped: 'auto-off' };
    var st = await getState();
    var local = wrap(await collectSnapshot('raw'));
    var localFp = await settingsFingerprint(local);

    var remote;
    try {
      remote = await fetchRemote(cfg);
    } catch (e) {
      await setState({ lastSyncAt: nowISO(), lastResult: 'fail', lastDirection: 'auto', lastError: String(e.message || e) });
      return { ok: false, error: String(e.message || e) };
    }

    var remoteFp = remote.exists ? await settingsFingerprint(remote.payload) : null;
    var localChanged = st.lastLocalSettingsSha256 ? st.lastLocalSettingsSha256 !== localFp : true;
    var remoteChanged = remote.exists
      ? (st.lastRemoteSettingsSha256 ? st.lastRemoteSettingsSha256 !== remoteFp : true)
      : false;

    if (cfg.autoMode === 'upload') {
      if (!localChanged && remote.exists) return { ok: true, skipped: 'no-local-change', direction: 'upload' };
      var up = await uploadSettings({ reason: 'auto:' + (reason || 'alarm') });
      return { ok: true, direction: 'upload', sha256: up.sha256, bytes: up.bytes };
    }
    if (cfg.autoMode === 'download') {
      if (!remote.exists) return { ok: false, error: '远端无备份文件' };
      if (!remoteChanged) return { ok: true, skipped: 'no-remote-change', direction: 'download' };
      var dn = await downloadSettings({ reason: 'auto:' + (reason || 'alarm') });
      return { ok: true, direction: 'download', sha256: dn.sha256, applied: dn.applied };
    }
    // bidirectional
    if (localChanged && remoteChanged) {
      await setState({ lastSyncAt: nowISO(), lastResult: 'conflict', lastError: '本地与远端都发生了变化，已暂停自动同步，请手动比对差异' });
      return { ok: false, conflict: true };
    }
    if (localChanged) {
      var up2 = await uploadSettings({ reason: 'auto:bi-upload' });
      return { ok: true, direction: 'upload', sha256: up2.sha256 };
    }
    if (remote.exists && remoteChanged) {
      var dn2 = await downloadSettings({ reason: 'auto:bi-download' });
      return { ok: true, direction: 'download', sha256: dn2.sha256 };
    }
    return { ok: true, skipped: 'in-sync' };
  }

  /* -------------------------------------------------------------- 导出 API */

  var API = {
    SCHEMA: SCHEMA,
    CFG_KEY: CFG_KEY,
    STATE_KEY: STATE_KEY,
    HIST_KEY: HIST_KEY,
    SCOPE_KEY: SCOPE_KEY,
    ALARM: ALARM_NAME,
    DEFAULTS: DEFAULTS,
    EXCLUDE_RULES: EXCLUDE_RULES,
    GROUPS: GROUPS,
    isSW: isSW,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    loadScope: loadScope,
    saveScope: saveScope,
    describeScope: describeScope,
    groupIdOfItem: groupIdOfItem,
    scopeAllows: scopeAllows,
    currentAllow: currentAllow,
    getState: getState,
    setState: setState,
    sha256Hex: sha256Hex,
    fmtBytes: fmtBytes,
    davUrl: davUrl,
    davRequest: davRequest,
    ensureDirs: ensureDirs,
    remoteFilePath: remoteFilePath,
    collectSnapshot: collectSnapshot,
    collectRaw: collectRaw,
    collectViaProtocol: collectViaProtocol,
    listItemNames: listItemNames,
    settingsFingerprint: settingsFingerprint,
    sendToItem: sendToItem,
    sendToApp: sendToApp,
    applySnapshot: applySnapshot,
    wrap: wrap,
    serialize: serialize,
    canonicalJSON: canonicalJSON,
    historyList: historyList,
    historyPush: historyPush,
    historyRestore: historyRestore,
    uploadSettings: uploadSettings,
    downloadSettings: downloadSettings,
    fetchRemote: fetchRemote,
    diffRemote: diffRemote,
    testConnection: testConnection,
    scheduleAlarm: scheduleAlarm,
    alarmInfo: alarmInfo,
    autoTick: autoTick,
    isExcludedKey: isExcludedKey
  };

  self.ACHWebDAV = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
