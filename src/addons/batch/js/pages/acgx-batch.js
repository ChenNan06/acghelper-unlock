/*!
 * acgx-batch.js —— ACGhelper 2.8.31.16 「选集 / 多 P 批量下载」（内容脚本，ISOLATED world）
 *
 * 形态（v2）：**不再自建右下角浮动按钮**。
 *   入口作为一块区块注入 ACGhelper 自己的悬浮面板 #bilibiliHelper2ContentWrapper 内部，
 *   插在面板 <footer> 之前；视觉参数在运行期用 getComputedStyle 从面板里的原生按钮
 *   （div.button.primary，即插件 Button 组件 V.$ 的外壳）身上读出来，写进本区块的 CSS 变量，
 *   所以字体 / 圆角 / 描边 / 主色 / 高度 / 间距与插件原生按钮同源。
 *
 * 只在**真的能多选**时才出现：
 *   * 番剧 / 影视（/bangumi/play/ep*、/ss*）：pgc/view/web/season 的 episodes + section 展开后 > 1 集
 *   * 多 P 视频（/video/BV*、av*）：x/web-interface/view 的 pages.length > 1
 *   * 合集 / 收藏夹（/list/*、/medialist/play/*）：能解析出单一 bvid 且其 pages.length > 1
 *   不满足 → 一个 DOM 节点都不建（连壳都没有），只在 console 留一行诊断。
 *   判定失败（未登录 / 接口报错 / 不是这些页）→ 同样不出现，console 一行说明原因。
 *
 * 数据来源（同源 + 自带 cookie）：
 *   PGC : https://api.bilibili.com/pgc/view/web/season?ep_id=<ep> | ?season_id=<ss>
 *   UGC : https://api.bilibili.com/x/web-interface/view?bvid=<BV> | ?aid=<av>
 *   兜底: #__NEXT_DATA__ / 内联 <script> 的 window.__INITIAL_STATE__
 *
 * 执行：页面只负责排队与展示，真正的下载在 offscreen 文档里做。
 *   发：chrome.runtime.sendMessage({to:"offscreen", target:"videoDownload",
 *        command:"acgxAutoDownload", url, qn, audioQn, timeoutMs})
 *   收：chrome.tabs.sendMessage 转发的 {target:"acgxBatch", command:"itemDone", url, ok, error, quality, audio}
 *
 * 队列语义：严格串行，一集 itemDone 之后才发下一集；单集失败标红可「重试本集」，
 *          不阻塞后续；暂停 = 当前集跑完就停发；取消 = 立刻停发并让 offscreen 停掉在跑的下载。
 */
(function () {
    'use strict';
    if (window.__ACGX_BATCH_JS__) return;
    window.__ACGX_BATCH_JS__ = true;

    var TAG = '[acgx-batch]';
    var HOST_ID = 'acgx-batch-host';
    var PANEL_ID = 'bilibiliHelper2ContentWrapper';      // 插件自己的悬浮面板（handle-content-wrapper）
    var HANDLE_ID = 'bilibiliHelper2HandleButtonWrapper'; // 插件悬浮球
    var DEFAULT_ITEM_TIMEOUT = 1800000; // 30 min：单集下载硬超时（防止队列被一集挂死）

    // 画质：qn 取值来自 background.js 的 g 枚举（QN_80/QN_116/QN_120/QN_127 …）
    var QN_OPTIONS = [
        { label: '最高（自动）', value: 0 },
        { label: '8K', value: 127 },
        { label: '杜比视界', value: 126 },
        { label: 'HDR', value: 125 },
        { label: '4K', value: 120 },
        { label: '1080P60', value: 116 },
        { label: '1080P+', value: 112 },
        { label: '1080P', value: 80 },
        { label: '720P', value: 64 },
        { label: '480P', value: 32 }
    ];
    // 音轨：w 枚举（30280 高清音质 / 30250 杜比全景声 / 30251 Hi-Res）
    var AQ_OPTIONS = [
        { label: '默认（最高可用）', value: 0 },
        { label: '杜比全景声', value: 30250 },
        { label: 'Hi-Res 无损', value: 30251 }
    ];

    // 原生样式的兜底值 —— 全部来自 headless 侦察实测（docs/batch-in-plugin-panel.md §侦察），
    // 运行期优先用 getComputedStyle 读到的真值覆盖。
    var FALLBACK_STYLE = {
        font: '"Noto Sans SC"',
        fontSize: '12px',
        radius: '6px',
        btnHeight: '26px',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'rgba(0, 0, 0, 0)',
        primaryBg: 'rgb(35, 173, 229)',   // --bilibili-blue: #23ADE5
        primaryFg: 'rgb(244, 244, 244)',  // --bilibili-gray: #F4F4F4
        panelBg: 'rgb(255, 255, 255)',
        text: 'rgb(34, 34, 34)',
        muted: 'rgb(117, 117, 117)',
        faint: 'rgb(97, 97, 97)',
        line: 'rgb(224, 224, 224)',
        softBg: 'rgb(234, 244, 255)',
        softFg: 'rgb(0, 161, 214)',
        pink: '#FB7299',
        secWidth: '420px'
    };

    var STATE = {
        phase: 'idle',      // idle | probing | ready | absent | error
        reason: '',         // 未注入原因（诊断用）
        kind: '',           // pgc | ugc | list
        injected: false,    // 入口区块是否已插进插件面板
        open: false,        // 集数列表是否展开
        loading: false,
        error: '',
        route: null,
        title: '',
        subtitle: '',
        source: '',
        items: [],
        lastIndex: -1,
        running: false,
        paused: false,
        cancelled: false,
        qn: 0,
        audioQn: 0,
        index: 0,
        total: 0,
        ok: 0,
        fail: 0,
        current: '',
        message: ''
    };

    // ---------------------------------------------------------------- 工具
    function log() {
        try {
            var a = [TAG].concat([].slice.call(arguments));
            console.log.apply(console, a);
        } catch (e) { /* ignore */ }
    }
    function info() {
        try {
            var a = [TAG].concat([].slice.call(arguments));
            console.info.apply(console, a);
        } catch (e) { /* ignore */ }
    }

    function fmtDur(sec) {
        sec = Number(sec) || 0;
        if (sec <= 0) return '';
        sec = Math.round(sec);
        var h = Math.floor(sec / 3600),
            m = Math.floor((sec % 3600) / 60),
            s = sec % 60;
        var mm = (h ? String(m).padStart(2, '0') : String(m));
        return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
    }

    function sendOffscreen(command, extra) {
        try {
            var msg = { to: 'offscreen', target: 'videoDownload', command: command };
            for (var k in extra || {}) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
            var p = chrome.runtime.sendMessage(msg);
            if (p && typeof p.catch === 'function') p.catch(function () { /* offscreen 未就绪时静默 */ });
            return true;
        } catch (e) {
            log('sendMessage failed', command, String(e && e.message || e));
            return false;
        }
    }

    // ---------------------------------------------------------------- 路由解析
    function parseRoute() {
        var p = location.pathname || '';
        var m = /^\/bangumi\/play\/(ep|ss)(\d+)/i.exec(p);
        if (m) return { kind: 'pgc', idType: m[1].toLowerCase(), id: m[2] };
        m = /^\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(p);
        if (m) {
            var q = new URLSearchParams(location.search);
            return {
                kind: 'ugc',
                bvid: /^BV/i.test(m[1]) ? m[1] : null,
                aid: /^av/i.test(m[1]) ? m[1].slice(2) : null,
                p: Number(q.get('p')) || 1
            };
        }
        if (/^\/(list|medialist\/play)\//.test(p)) {
            var qs = new URLSearchParams(location.search);
            var bv = qs.get('bvid') || (/BV[0-9A-Za-z]+/.exec(p) || [])[0];
            var aid = qs.get('oid') || qs.get('aid');
            return { kind: 'list', bvid: bv || null, aid: aid || null };
        }
        return null;
    }

    // ---------------------------------------------------------------- 数据获取
    function httpGetJson(url) {
        return fetch(url, { credentials: 'include', cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
            return r.json();
        });
    }

    function pickEp(e) {
        return {
            key: 'ep' + e.ep_id,
            epid: e.ep_id,
            aid: e.aid,
            bvid: e.bvid,
            cid: e.cid,
            title: e.title || '',
            sub: e.long_title || e.share_copy || '',
            name: [e.title || '', e.long_title || ''].filter(Boolean).join(' ').trim() || ('ep' + e.ep_id),
            dur: fmtDur((Number(e.duration) || 0) / 1000), // PGC duration 是毫秒
            url: 'https://www.bilibili.com/bangumi/play/ep' + e.ep_id,
            badge: e.badge || ''
        };
    }

    function fromNextData() {
        var el = document.querySelector('#__NEXT_DATA__');
        if (!el) return null;
        try {
            var j = JSON.parse(el.textContent || '');
            var qs = (j.props && j.props.pageProps && j.props.pageProps.dehydratedState &&
                j.props.pageProps.dehydratedState.queries) || [];
            for (var i = 0; i < qs.length; i++) {
                var k = qs[i] && qs[i].queryKey;
                var d = qs[i] && qs[i].state && qs[i].state.data;
                if (d && d.episodes && Array.isArray(d.episodes) &&
                    (!k || String(k[0] || '').indexOf('season') >= 0)) {
                    return {
                        season_id: d.season_id,
                        title: (d.season_title || (d.title) || ''),
                        episodes: d.episodes,
                        section: d.section
                    };
                }
            }
        } catch (e) { log('__NEXT_DATA__ 解析失败', String(e)); }
        return null;
    }

    function fromInitialState() {
        var scripts = document.scripts || [];
        for (var i = 0; i < scripts.length; i++) {
            var t = scripts[i].textContent || '';
            var at = t.indexOf('window.__INITIAL_STATE__=');
            if (at < 0) continue;
            var raw = t.slice(at + 'window.__INITIAL_STATE__='.length);
            var end = raw.indexOf(';(function');
            if (end < 0) end = raw.length;
            raw = raw.slice(0, end).replace(/:undefined/g, ':null').replace(/undefined/g, 'null');
            try { return JSON.parse(raw); } catch (e) { log('__INITIAL_STATE__ 解析失败', String(e)); }
        }
        return null;
    }

    function loadPGC(route) {
        var url = 'https://api.bilibili.com/pgc/view/web/season?' +
            (route.idType === 'ep' ? 'ep_id=' : 'season_id=') + encodeURIComponent(route.id);
        return httpGetJson(url).catch(function (e) {
            // 网络/CORS 失败 → 退回页面内嵌数据
            var nd = fromNextData();
            if (nd) return { code: 0, result: nd, __from: 'dom' };
            throw e;
        }).then(function (j) {
            if (!j || j.code !== 0 || !j.result) {
                var code = j && j.code;
                var why = code === -404 ? '接口返回 -404：该番剧不存在，或当前未登录/无观看权限'
                    : code === -10403 ? '接口返回 -10403：当前地区不可看（番剧地域限制）'
                        : code === -101 ? '接口返回 -101：未登录（请先登录 B 站账号）'
                            : '接口返回 code=' + code + ' ' + ((j && j.message) || '');
                throw new Error(why);
            }
            var r = j.result;
            var eps = (r.episodes || []).slice();
            var main = eps.map(pickEp);
            var extras = [];
            (r.section || []).forEach(function (s) {
                (s.episodes || []).forEach(function (e) {
                    var it = pickEp(e);
                    it.title = (s.title ? '[' + s.title + '] ' : '') + (it.title || '');
                    it.extra = true;
                    extras.push(it);
                });
            });
            return {
                title: r.season_title || r.title || ('season ' + (r.season_id || '')),
                subtitle: (r.season_type_name || '') + (r.total ? ' · 共 ' + r.total + ' 集' : ''),
                items: main.concat(extras),
                source: (j.__from === 'dom' ? 'DOM(__NEXT_DATA__)' : 'api/pgc/view/web/season')
            };
        });
    }

    function loadUGC(route) {
        var q = route.bvid ? 'bvid=' + encodeURIComponent(route.bvid)
            : (route.aid ? 'aid=' + encodeURIComponent(route.aid) : '');
        if (!q) throw new Error('URL 里没有解析到 BV 号 / av 号');
        var url = 'https://api.bilibili.com/x/web-interface/view?' + q;
        return httpGetJson(url).catch(function (e) {
            var st = fromInitialState();
            if (st && (st.videoData || st.pages)) {
                var vd = st.videoData || st;
                return {
                    code: 0,
                    data: { bvid: vd.bvid, aid: vd.aid, title: vd.title, pages: vd.pages || [] },
                    __from: 'dom'
                };
            }
            throw e;
        }).then(function (j) {
            if (!j || j.code !== 0 || !j.data) {
                throw new Error('接口返回 code=' + (j && j.code) + ' ' +
                    ((j && j.message) || '（未登录或视频不存在）'));
            }
            var d = j.data;
            var pages = d.pages || [];
            if (!pages.length) throw new Error('该视频没有分 P 数据（pages 为空）');
            var items = pages.map(function (p) {
                return {
                    key: 'p' + p.page + '_' + p.cid,
                    cid: p.cid,
                    bvid: d.bvid,
                    aid: d.aid,
                    title: 'P' + p.page + (p.part ? ' ' + p.part : ''),
                    name: 'P' + p.page + (p.part ? ' ' + p.part : ''),
                    sub: d.title || '',
                    dur: fmtDur(p.duration),
                    url: 'https://www.bilibili.com/video/' + d.bvid + '/?p=' + p.page
                };
            });
            return {
                title: d.title || d.bvid,
                subtitle: '多 P · 共 ' + pages.length + ' P' + (route.p ? '（当前 P' + route.p + '）' : ''),
                items: items,
                source: (j.__from === 'dom' ? 'DOM(__INITIAL_STATE__)' : 'api/x/web-interface/view')
            };
        });
    }

    // ---------------------------------------------------------------- 多选可用性判定（出现与否的唯一开关）
    /**
     * probe() → Promise<{ok:boolean, reason:string, ...data}>
     * ok 为 true 才允许建立任何 DOM；否则一个节点都不建。
     */
    function probe() {
        var route = STATE.route;
        if (!route) return Promise.reject(new Error('NOT_SUPPORTED_ROUTE：当前页面不是番剧 / 视频 / 合集页'));
        var job;
        try {
            if (route.kind === 'pgc') job = loadPGC(route);
            else if (route.kind === 'ugc') job = loadUGC(route);
            else if (route.bvid || route.aid) job = loadUGC({ bvid: route.bvid, aid: route.aid, p: 0 });
            else return Promise.reject(new Error('LIST_NO_SINGLE_BVID：合集/收藏夹列表页没有单一选集数据源，点进具体视频或番剧页再用'));
        } catch (e) {
            return Promise.reject(e);
        }
        return job.then(function (res) {
            var n = (res.items || []).length;
            res.count = n;
            res.kind = route.kind;
            if (n <= 1) {
                return {
                    ok: false,
                    kind: route.kind,
                    count: n,
                    title: res.title,
                    reason: (route.kind === 'pgc' ? '番剧整季只有 ' : '视频只有 ') + n +
                        ' 集/个分P，不构成可多选集合'
                };
            }
            return { ok: true, kind: route.kind, count: n, data: res };
        });
    }

    // ---------------------------------------------------------------- 原生样式捕获
    function cssVal(el, prop, dflt) {
        if (!el) return dflt;
        try {
            var v = getComputedStyle(el).getPropertyValue(prop);
            return (v && v !== 'none' && v !== 'auto') ? v : dflt;
        } catch (e) { return dflt; }
    }

    /**
     * 从插件面板里读原生按钮的实际样式。
     * 锚点：div.button.primary —— 即插件 Button 组件（components.bundle.js 模块 724 的 V.$）
     * 外壳 <div class="button primary">，内部 <button class="button-view">。
     */
    function captureNativeStyle(panel) {
        var s = {};
        for (var k in FALLBACK_STYLE) if (Object.prototype.hasOwnProperty.call(FALLBACK_STYLE, k)) s[k] = FALLBACK_STYLE[k];
        if (!panel) return s;
        var cs = null;
        try { cs = getComputedStyle(panel); } catch (e) { return s; }
        var primDiv = panel.querySelector('div.button.primary') || panel.querySelector('div.button');
        var borderDiv = panel.querySelector('div.button.border');
        var footer = panel.querySelector('footer');
        var nd = panel.querySelector('.new-downloader');
        var titleEl = panel.querySelector('.bilibili-helper-video-download-title');

        s.font = cssVal(panel, 'font-family', s.font);
        s.panelBg = cssVal(panel, 'background-color', s.panelBg);
        s.text = cssVal(panel, 'color', s.text);
        s.fontSize = cssVal(primDiv, 'font-size', cssVal(titleEl, 'font-size', s.fontSize));
        s.radius = cssVal(primDiv, 'border-radius', s.radius);
        s.btnHeight = cssVal(primDiv, 'height', s.btnHeight);
        s.borderWidth = cssVal(primDiv, 'border-top-width', s.borderWidth);
        s.borderStyle = cssVal(primDiv, 'border-top-style', s.borderStyle);
        // 主按钮自己的描边（插件里 .primary 是 1px solid transparent —— 保留同样的写法）
        s.borderColor = cssVal(primDiv, 'border-top-color', s.borderColor);
        s.primaryBg = cssVal(primDiv, 'background-color', s.primaryBg);
        s.primaryFg = cssVal(primDiv, 'color', s.primaryFg);
        // 面板里 .border 变体的描边色 / 次要文字色（#ddd / #757575），给 .btn.border 与分隔线用
        s.line = cssVal(borderDiv, 'border-top-color', s.line);
        s.muted = cssVal(borderDiv, 'color', s.muted);
        // 面板 footer 的文字色（#616161）—— 最暗的灰，作为小字说明
        s.faint = cssVal(footer, 'color', s.faint);
        s.secWidth = cssVal(nd, 'width', s.secWidth);
        // 面板自己的 CSS 变量（插件在 #bilibiliHelper2ContentWrapper 上定义）
        try {
            var g = function (n, d) {
                var v = cs.getPropertyValue(n);
                return (v && v.trim()) ? v.trim() : d;
            };
            s.pink = g('--bilibili-pink', s.pink);
        } catch (e) { /* ignore */ }
        return s;
    }

    function styleVars(s) {
        return [
            '--acgx-font:' + s.font,
            '--acgx-font-size:' + s.fontSize,
            '--acgx-radius:' + s.radius,
            '--acgx-btn-h:' + s.btnHeight,
            '--acgx-border-w:' + s.borderWidth,
            '--acgx-border-s:' + s.borderStyle,
            '--acgx-border-c:' + s.borderColor,
            '--acgx-primary-bg:' + s.primaryBg,
            '--acgx-primary-fg:' + s.primaryFg,
            '--acgx-panel-bg:' + s.panelBg,
            '--acgx-text:' + s.text,
            '--acgx-muted:' + s.muted,
            '--acgx-faint:' + s.faint,
            '--acgx-line:' + s.line,
            '--acgx-soft-bg:' + s.softBg,
            '--acgx-soft-fg:' + s.softFg,
            '--acgx-pink:' + s.pink,
            '--acgx-sec-w:' + s.secWidth
        ].join(';');
    }

    // ---------------------------------------------------------------- 队列
    var pending = null;

    /** 解析阶段超时（透传给 offscreen）。默认 90s；自动化可用 <html data-acgx-init-timeout="4000"> 覆盖。 */
    function readInitTimeout() {
        var v = 0;
        try {
            v = Number((document.documentElement &&
                document.documentElement.getAttribute('data-acgx-init-timeout')) || 0) || 0;
        } catch (e) { v = 0; }
        return v > 0 ? v : 90000;
    }

    function runOne(item) {
        return new Promise(function (resolve) {
            var timeoutMs = DEFAULT_ITEM_TIMEOUT;
            var guard = setTimeout(function () {
                if (!pending || pending.item !== item) return;
                pending = null;
                item.state = 'fail';
                item.error = '等待 offscreen 回执超时（' + Math.round(timeoutMs / 60000) + 'min）';
                STATE.fail += 1;
                render();
                resolve();
            }, timeoutMs + 60000);
            pending = { item: item, resolve: resolve, guard: guard };
            item.state = 'running';
            item.error = '';
            STATE.current = item.title || item.url;
            render();
            var sent = sendOffscreen('acgxAutoDownload', {
                url: item.url, qn: STATE.qn, audioQn: STATE.audioQn, timeoutMs: timeoutMs,
                initTimeoutMs: readInitTimeout()
            });
            if (!sent) {
                pending = null;
                clearTimeout(guard);
                item.state = 'fail';
                item.error = '扩展上下文不可用（请刷新页面）';
                STATE.fail += 1;
                render();
                resolve();
            }
        });
    }

    function onItemDone(msg) {
        if (!pending) { log('itemDone 无等待项', msg.url); return; }
        if (msg.url && msg.url !== pending.item.url) { log('itemDone url 不匹配', msg.url, pending.item.url); return; }
        var item = pending.item, resolve = pending.resolve, guard = pending.guard;
        pending = null;
        clearTimeout(guard);
        if (msg.ok) {
            item.state = 'ok';
            item.error = '';
            STATE.ok += 1;
            log('item ok', item.url, 'quality=' + (msg.quality || ''), 'audio=' + (msg.audio || ''));
        } else {
            item.state = 'fail';
            item.error = msg.error || '下载失败';
            STATE.fail += 1;
            log('item fail', item.url, item.error);
        }
        render();
        resolve();
    }

    function startQueue() {
        if (STATE.running) return;
        var list = STATE.items.filter(function (i) { return i.checked; });
        if (!list.length) { STATE.message = '先勾选要下载的集数'; render(); return; }
        STATE.running = true;
        STATE.paused = false;
        STATE.cancelled = false;
        STATE.ok = 0;
        STATE.fail = 0;
        STATE.total = list.length;
        STATE.index = 0;
        STATE.message = '队列启动';
        render();
        (function next(i) {
            if (i >= list.length) { finishQueue(); return; }
            if (STATE.cancelled) { finishQueue(); return; }
            if (STATE.paused) { finishQueue(); return; }
            STATE.index = i + 1;
            runOne(list[i]).then(function () { next(i + 1); });
        })(0);
    }

    function finishQueue() {
        STATE.running = false;
        var skipped = STATE.total - STATE.ok - STATE.fail;
        if (STATE.cancelled) STATE.message = '已取消：成功 ' + STATE.ok + ' / 失败 ' + STATE.fail + ' / 未开始 ' + skipped;
        else if (STATE.paused) STATE.message = '已暂停：成功 ' + STATE.ok + ' / 失败 ' + STATE.fail + ' / 剩余 ' + skipped;
        else STATE.message = '队列结束：成功 ' + STATE.ok + ' / 失败 ' + STATE.fail + (skipped > 0 ? ' / 跳过 ' + skipped : '');
        STATE.paused = false;
        render();
        log('queue finished', STATE.message);
    }

    // ---------------------------------------------------------------- 面板内注入
    var host = null, root = null, ui = {};

    function shadowCss() {
        return [
            ':host{all:initial;display:block;box-sizing:border-box',
            ';width:var(--acgx-sec-w,420px);max-width:100%;margin:0;padding:0}',
            '*{box-sizing:border-box;font-family:var(--acgx-font,"Noto Sans SC");font-size:var(--acgx-font-size,12px)}',

            /* ---- 顶部入口行：结构与插件原生 Button 一致（外层 div.button + 内层 button.button-view） ---- */
            '.row{display:flex;align-items:center;margin:0 0 8px}',
            '.btn{display:flex;justify-content:center;align-items:center;position:relative;',
            'height:var(--acgx-btn-h,26px);border-radius:var(--acgx-radius,6px);',
            'font-size:var(--acgx-font-size,12px);overflow:hidden;user-select:none;box-sizing:border-box;',
            'transition:all}',
            '.btn.primary{background-color:var(--acgx-primary-bg,rgb(35,173,229));',
            'color:var(--acgx-primary-fg,rgb(244,244,244));',
            'border:var(--acgx-border-w,1px) var(--acgx-border-s,solid) var(--acgx-border-c,transparent)}',
            '.btn.border{background-color:transparent;color:var(--acgx-muted,rgb(117,117,117));',
            'border:var(--acgx-border-w,1px) var(--acgx-border-s,solid) var(--acgx-line,rgb(221,221,221))}',
            '.btn.flat{background-color:var(--acgx-soft-bg,rgb(234,244,255));',
            'color:var(--acgx-soft-fg,rgb(0,161,214));border:0}',
            '.btn.disabled{filter:grayscale(1);cursor:not-allowed}',
            '.btn>button{display:block;width:100%;height:inherit;line-height:inherit;min-width:50px;',
            'font-size:inherit;font-weight:inherit;font-family:inherit;background-color:transparent;',
            'padding-inline:8px;color:inherit;cursor:pointer;transition:color .3s;border:none;outline:none;z-index:1}',
            '.btn>button:disabled{cursor:not-allowed}',
            '#acgx-entry{margin-right:8px}',
            '#acgx-entry>button{display:flex;align-items:center;gap:4px}',
            '.caret{display:inline-block;font-size:9px;line-height:1;transform:translateY(-1px)}',
            '.hint{color:var(--acgx-muted,rgb(117,117,117));font-size:var(--acgx-font-size,12px);',
            'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

            /* ---- 展开体：与插件面板同底色/同文字色/同圆角 ---- */
            '.body{margin:0;padding:8px 4px 0;border-top:1px solid var(--acgx-line,rgb(224,224,224))}',
            '.body[hidden]{display:none}',
            '.meta{color:var(--acgx-text,rgb(34,34,34));margin:0 0 6px;line-height:1.5}',
            '.meta .src{color:var(--acgx-faint,rgb(97,97,97));font-size:11px}',
            '.tools{display:flex;align-items:center;gap:8px;margin:0 0 6px;flex-wrap:wrap}',
            '.tools .btn{height:22px}',
            '.tools .btn>button{min-width:0;padding-inline:8px}',
            '.chk{display:flex;align-items:center;gap:4px;cursor:pointer;color:var(--acgx-text,rgb(34,34,34))}',
            '.chk input{margin:0;cursor:pointer}',
            '.tools select{height:22px;background:#fff;color:var(--acgx-text,rgb(34,34,34));',
            'border:1px solid var(--acgx-line,rgb(221,221,221));border-radius:var(--acgx-radius,6px);padding:0 4px;',
            'font-size:var(--acgx-font-size,12px);max-width:110px;outline:none}',

            '.list{overflow:auto;max-height:240px;border:1px solid var(--acgx-line,rgb(224,224,224));',
            'border-radius:var(--acgx-radius,6px);background:#fff}',
            '.row-item{display:flex;align-items:flex-start;gap:6px;padding:4px 6px;cursor:pointer;',
            'border-bottom:1px solid var(--acgx-line,rgb(224,224,224));color:var(--acgx-text,rgb(34,34,34))}',
            '.row-item:last-child{border-bottom:0}',
            '.row-item:hover{background:var(--acgx-soft-bg,rgb(234,244,255))}',
            '.row-item.sel{background:var(--acgx-soft-bg,rgb(234,244,255))}',
            '.row-item input{margin:2px 0 0;flex:0 0 auto;cursor:pointer}',
            '.row-item .idx{width:22px;color:var(--acgx-faint,rgb(97,97,97));font-size:11px;flex:0 0 auto;',
            'padding-top:1px;text-align:right}',
            '.row-item .t{flex:1 1 auto;min-width:90px;overflow:hidden}',
            '.row-item .t .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.row-item .t .s{color:var(--acgx-muted,rgb(117,117,117));font-size:11px;',
            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.row-item .d{color:var(--acgx-muted,rgb(117,117,117));font-size:11px;flex:0 0 auto;padding-top:1px}',
            '.row-item .st{flex:0 1 auto;max-width:34%;font-size:11px;padding-top:1px;',
            'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.row-item[data-st="running"] .st{color:#d49c09}',
            '.row-item[data-st="ok"] .st{color:#43a047}',
            '.row-item[data-st="fail"]{background:#fdeaea}',
            '.row-item[data-st="fail"] .st{color:#e53935}',

            '.ft{margin:8px 0 0}',
            '.btns{display:flex;align-items:center;gap:8px}',
            '.btns .btn{flex:0 0 auto}',
            '.status{margin-top:6px;color:var(--acgx-muted,rgb(117,117,117));min-height:16px;word-break:break-all}',
            '.empty{padding:10px 6px;color:var(--acgx-muted,rgb(117,117,117));line-height:1.6}',
            '.empty b{color:var(--acgx-pink,#FB7299);display:block;margin-bottom:4px}',
            '.retry{background:none;border:1px solid var(--acgx-pink,#FB7299);color:var(--acgx-pink,#FB7299);',
            'border-radius:4px;font-size:11px;cursor:pointer;padding:0 4px;margin-left:6px}'
        ].join('');
    }

    function h(tag, attrs, kids) {
        var el = document.createElement(tag);
        for (var k in attrs || {}) {
            if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
            if (k === 'text') el.textContent = attrs[k];
            else if (k === 'html') el.innerHTML = attrs[k];
            else if (k === 'cls') el.className = attrs[k];
            else el.setAttribute(k, attrs[k]);
        }
        (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
        return el;
    }

    /** 造一个与插件原生 Button 同构的按钮：<div class="btn primary"><button>文案</button></div> */
    function nativeBtn(variant, id, label, onClick) {
        var inner = h('button', { type: 'button', text: label });
        if (id) inner.id = id;
        var wrap = h('div', { cls: 'btn ' + variant }, [inner]);
        wrap.addEventListener('click', function (ev) {
            if (wrap.classList.contains('disabled')) return;
            onClick(ev);
        });
        return { wrap: wrap, btn: inner };
    }

    function buildShell(panel) {
        var st = captureNativeStyle(panel);
        host = document.createElement('div');
        host.id = HOST_ID;
        host.setAttribute('data-acgx-role', 'section');
        host.setAttribute('data-acgx-style-source', 'getComputedStyle(#bilibiliHelper2ContentWrapper div.button.primary)');
        host.style.cssText = 'display:block;box-sizing:border-box;' + styleVars(st);
        root = host.attachShadow({ mode: 'open' });

        var style = document.createElement('style');
        style.textContent = shadowCss();
        root.appendChild(style);

        ui.sec = h('section', { cls: 'sec' });

        // ---- 入口行 ----
        ui.row = h('div', { cls: 'row' });
        var entry = nativeBtn('primary', 'acgx-entry-btn', '选集下载', function () { toggleOpen(); });
        ui.entryWrap = entry.wrap;
        ui.entryBtn = entry.btn;
        ui.entryWrap.id = 'acgx-entry';
        ui.entryWrap.setAttribute('role', 'button');
        ui.entryWrap.setAttribute('tabindex', '0');
        ui.entryWrap.setAttribute('data-acgx-role', 'entry');
        ui.caret = h('span', { cls: 'caret', text: '▾' });
        ui.entryBtn.appendChild(ui.caret);
        ui.hint = h('div', { cls: 'hint', id: 'acgx-hint' });
        ui.row.appendChild(ui.entryWrap);
        ui.row.appendChild(ui.hint);
        ui.sec.appendChild(ui.row);

        // ---- 展开体 ----
        ui.body = h('div', { cls: 'body', id: 'acgx-body' });
        ui.body.setAttribute('data-acgx-role', 'body');
        ui.body.hidden = true;

        ui.meta = h('div', { cls: 'meta', id: 'acgx-meta' });
        ui.body.appendChild(ui.meta);

        ui.tools = h('div', { cls: 'tools' });
        ui.all = h('input', { type: 'checkbox', id: 'acgx-all' });
        ui.all.addEventListener('change', function () {
            var v = ui.all.checked;
            STATE.items.forEach(function (it) { it.checked = v; });
            STATE.lastIndex = -1;
            render();
        });
        var labAll = h('label', { cls: 'chk' }, [ui.all, h('span', { text: '全选' })]);
        var inv = nativeBtn('border', 'acgx-inv', '反选', function () {
            STATE.items.forEach(function (it) { it.checked = !it.checked; });
            render();
        });
        ui.inv = inv.btn;
        ui.qn = h('select', { id: 'acgx-qn', title: '画质' });
        QN_OPTIONS.forEach(function (o) { ui.qn.appendChild(h('option', { value: String(o.value), text: o.label })); });
        ui.qn.addEventListener('change', function () { STATE.qn = Number(ui.qn.value) || 0; });
        ui.aq = h('select', { id: 'acgx-aq', title: '音轨' });
        AQ_OPTIONS.forEach(function (o) { ui.aq.appendChild(h('option', { value: String(o.value), text: o.label })); });
        ui.aq.addEventListener('change', function () { STATE.audioQn = Number(ui.aq.value) || 0; });
        ui.tools.appendChild(labAll);
        ui.tools.appendChild(inv.wrap);
        ui.tools.appendChild(ui.qn);
        ui.tools.appendChild(ui.aq);
        ui.body.appendChild(ui.tools);

        ui.list = h('div', { cls: 'list', id: 'acgx-list' });
        ui.body.appendChild(ui.list);

        ui.ft = h('div', { cls: 'ft' });
        var btns = h('div', { cls: 'btns' });
        var s1 = nativeBtn('primary', 'acgx-start', '开始下载', function () { startQueue(); });
        ui.startWrap = s1.wrap; ui.start = s1.btn;
        var s2 = nativeBtn('border', 'acgx-pause', '暂停', function () {
            if (STATE.running) { STATE.paused = true; STATE.message = '将在当前集结束后暂停…'; render(); }
            else { STATE.message = '队列未在运行'; render(); }
        });
        ui.pauseWrap = s2.wrap; ui.pause = s2.btn;
        var s3 = nativeBtn('border', 'acgx-cancel', '取消', function () {
            STATE.cancelled = true;
            STATE.paused = false;
            sendOffscreen('acgxAbortAll', {});
            STATE.message = '已取消（含在下载中的一集）';
            render();
        });
        ui.cancelWrap = s3.wrap; ui.cancel = s3.btn;
        btns.appendChild(s1.wrap);
        btns.appendChild(s2.wrap);
        btns.appendChild(s3.wrap);
        ui.ft.appendChild(btns);
        ui.status = h('div', { cls: 'status', id: 'acgx-status' });
        ui.ft.appendChild(ui.status);
        ui.body.appendChild(ui.ft);

        ui.sec.appendChild(ui.body);
        root.appendChild(ui.sec);

        // 键盘可达（原生按钮是 <button>，外层 div 只是视觉壳）
        ui.entryWrap.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleOpen(); }
        });
    }

    function toggleOpen() {
        if (STATE.phase !== 'ready') return;
        STATE.open = !STATE.open;
        render();
    }

    /** 把 host 放进插件面板：插在 <footer> 之前，且始终保持在 footer 的前一个位置 */
    function ensureEntry() {
        var panel = document.getElementById(PANEL_ID);
        if (!panel) return false;
        if (!root) buildShell(panel);
        var footer = panel.querySelector('footer');
        if (host.parentNode !== panel) {
            if (footer && footer.parentNode === panel) panel.insertBefore(host, footer);
            else panel.appendChild(host);
            STATE.injected = true;
            log('入口已注入插件面板（#bilibiliHelper2ContentWrapper），位置 =',
                footer ? 'footer 之前' : '末尾');
            return true;
        }
        if (footer && footer.parentNode === panel && host.nextSibling !== footer) {
            panel.insertBefore(host, footer);
        }
        STATE.injected = true;
        return true;
    }

    function removeEntry() {
        if (host && host.parentNode) host.parentNode.removeChild(host);
        STATE.injected = false;
        if (watchObs) { try { watchObs.disconnect(); } catch (e) { } }
        if (waitObs) { try { waitObs.disconnect(); } catch (e) { } }
        if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    }

    var waitObs = null, waitTimer = null, watchObs = null;

    function startPanelWatch() {
        if (ensureEntry()) { attachRemovalWatch(); return; }
        var tries = 0;
        if (waitTimer) clearInterval(waitTimer);
        waitTimer = setInterval(function () {
            tries += 1;
            if (ensureEntry()) {
                clearInterval(waitTimer); waitTimer = null;
                if (waitObs) { try { waitObs.disconnect(); } catch (e) { } waitObs = null; }
                attachRemovalWatch();
                render();
                return;
            }
            if (tries >= 300) { // 120s 仍没等到插件面板
                clearInterval(waitTimer); waitTimer = null;
                log('等待插件面板超时（120s）：#bilibiliHelper2ContentWrapper 一直没出现，入口未注入');
            }
        }, 400);
        // 面板是 React 渲染的，出现时机不定：顺带挂一个轻量 observer（只观察 body 的直接子节点）
        if (document.body) {
            waitObs = new MutationObserver(function () {
                if (ensureEntry()) {
                    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
                    if (waitObs) { try { waitObs.disconnect(); } catch (e) { } waitObs = null; }
                    attachRemovalWatch();
                    render();
                }
            });
            waitObs.observe(document.body, { childList: true });
        }
    }

    /** 面板自己会随用户点击插件悬浮球显隐；React 也可能重排子节点 —— 掉了就补回去 */
    function attachRemovalWatch() {
        var panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        if (watchObs) { try { watchObs.disconnect(); } catch (e) { } }
        watchObs = new MutationObserver(function () {
            if (STATE.phase !== 'ready') return;
            ensureEntry();
        });
        watchObs.observe(panel, { childList: true });
    }

    // ---------------------------------------------------------------- 渲染
    function render() {
        if (!root) return;

        var checkedCount = STATE.items.filter(function (i) { return i.checked; }).length;
        ui.sec.setAttribute('data-acgx-open', STATE.open ? '1' : '0');
        ui.sec.setAttribute('data-acgx-injected', STATE.injected ? '1' : '0');
        ui.sec.setAttribute('data-acgx-kind', STATE.kind || '');
        ui.sec.setAttribute('data-acgx-count', String(STATE.items.length));
        ui.sec.setAttribute('data-acgx-checked', String(checkedCount));
        ui.sec.setAttribute('data-acgx-running', STATE.running ? '1' : '0');
        ui.sec.setAttribute('data-acgx-index', String(STATE.index));
        ui.sec.setAttribute('data-acgx-total', String(STATE.total));
        ui.sec.setAttribute('data-acgx-ok', String(STATE.ok));
        ui.sec.setAttribute('data-acgx-fail', String(STATE.fail));
        ui.sec.setAttribute('data-acgx-error', STATE.error || '');
        ui.sec.setAttribute('data-acgx-source', STATE.source || '');
        ui.sec.setAttribute('data-acgx-message', STATE.message || '');
        ui.sec.setAttribute('data-acgx-phase', STATE.phase);

        // ---- 入口行（始终可见）----
        ui.hint.textContent = STATE.items.length
            ? ('共 ' + STATE.items.length + ' ' + (STATE.kind === 'ugc' ? 'P' : '集') +
                (checkedCount ? ' · 已选 ' + checkedCount : ''))
            : '';
        ui.caret.textContent = STATE.open ? '▴' : '▾';
        ui.entryWrap.setAttribute('aria-expanded', STATE.open ? 'true' : 'false');
        ui.entryWrap.classList.toggle('active', STATE.open);

        ui.body.hidden = !STATE.open;
        if (!STATE.open) return;

        // ---- meta ----
        var meta = [];
        if (STATE.kind === 'pgc') meta.push('番剧/影视页');
        else if (STATE.kind === 'ugc') meta.push('多 P 视频页');
        else if (STATE.kind === 'list') meta.push('合集列表页');
        if (STATE.title) meta.push(STATE.title);
        if (STATE.subtitle) meta.push(STATE.subtitle);
        ui.meta.textContent = '';
        ui.meta.appendChild(h('div', { text: meta.join(' · ') }));
        ui.meta.appendChild(h('div', {
            cls: 'src',
            text: STATE.source ? '数据源：' + STATE.source : (STATE.loading ? '数据源：加载中…' : '')
        }));

        // ---- list ----
        ui.list.textContent = '';
        if (STATE.error) {
            ui.list.appendChild(h('div', { cls: 'empty' }, [
                h('b', { text: '拿不到选集数据' }),
                h('div', { text: STATE.error })
            ]));
        } else if (STATE.loading) {
            ui.list.appendChild(h('div', { cls: 'empty', text: '正在读取集数…' }));
        } else if (!STATE.items.length) {
            ui.list.appendChild(h('div', { cls: 'empty', text: '这个页面没有可展开的集数。' }));
        } else {
            STATE.items.forEach(function (it, i) {
                var row = h('div', {
                    cls: 'row-item' + (it.checked ? ' sel' : ''),
                    'data-st': it.state,
                    'data-acgx-role': 'item',
                    'data-acgx-index': String(i),
                    'data-acgx-key': it.key || ''
                });
                var cb = h('input', { type: 'checkbox', 'data-acgx-role': 'check' });
                cb.checked = !!it.checked;
                cb.addEventListener('click', function (ev) {
                    var v = cb.checked;
                    if (ev.shiftKey && STATE.lastIndex >= 0 && STATE.lastIndex !== i) {
                        var a = Math.min(STATE.lastIndex, i), b = Math.max(STATE.lastIndex, i);
                        for (var k = a; k <= b; k++) STATE.items[k].checked = v;
                    } else {
                        it.checked = v;
                    }
                    STATE.lastIndex = i;
                    render();
                });
                row.appendChild(cb);
                row.appendChild(h('div', { cls: 'idx', text: String(i + 1) }));
                var t = h('div', { cls: 't' }, [
                    h('div', { cls: 'n', text: it.name || it.title || it.url }),
                    h('div', { cls: 's', text: it.sub && it.sub !== it.name ? it.sub : '' })
                ]);
                row.appendChild(t);
                if (it.dur) row.appendChild(h('div', { cls: 'd', text: it.dur }));
                var st = h('div', { cls: 'st' });
                var rb = null;
                if (it.state === 'running') st.textContent = '下载中…';
                else if (it.state === 'ok') st.textContent = '✓ 完成';
                else if (it.state === 'fail') {
                    var errTxt = String(it.error || '失败');
                    st.textContent = '✗ ' + (errTxt.length > 22 ? errTxt.slice(0, 18) + '…' : errTxt);
                    st.setAttribute('title', errTxt);
                    rb = h('button', { type: 'button', cls: 'retry', 'data-acgx-role': 'retry', text: '重试本集' });
                    rb.addEventListener('click', function (ev) {
                        ev.stopPropagation();
                        if (STATE.running) { STATE.message = '队列运行中，等当前集结束后再重试'; render(); return; }
                        STATE.running = true;
                        STATE.ok = 0; STATE.fail = 0; STATE.total = 1; STATE.index = 1;
                        STATE.message = '重试：' + (it.name || it.title || it.url);
                        render();
                        runOne(it).then(function () { STATE.running = false; finishQueue(); });
                    });
                }
                row.appendChild(st);
                if (rb) row.appendChild(rb);
                row.addEventListener('click', function (ev) {
                    if (ev.target === cb || ev.target.tagName === 'BUTTON' || ev.target.tagName === 'INPUT') return;
                    it.checked = !it.checked;
                    STATE.lastIndex = i;
                    render();
                });
                ui.list.appendChild(row);
            });
        }

        // ---- footer ----
        var checked = STATE.items.filter(function (i) { return i.checked; }).length;
        ui.all.checked = STATE.items.length > 0 && checked === STATE.items.length;
        var startDisabled = STATE.running || checked === 0;
        ui.start.disabled = startDisabled;
        ui.startWrap.classList.toggle('disabled', startDisabled);
        var s = [];
        if (STATE.running) {
            s.push('第 ' + STATE.index + '/' + STATE.total + ' 集 · ' + STATE.current);
            s.push('成功 ' + STATE.ok + ' · 失败 ' + STATE.fail +
                ' · 剩余 ' + Math.max(0, STATE.total - STATE.index));
        } else if (STATE.items.length) {
            s.push('已选 ' + checked + ' / ' + STATE.items.length + ' 集');
        }
        if (STATE.message) s.push(STATE.message);
        ui.status.textContent = s.join('　');

        // 只读快照（内容脚本在 isolated world，主世界读不到；测试与外部脚本走 DOM 属性）
        window.__acgxBatch = {
            version: '2.0.0',
            state: function () {
                return {
                    phase: STATE.phase, reason: STATE.reason, injected: STATE.injected,
                    open: STATE.open, loading: STATE.loading, error: STATE.error,
                    kind: STATE.kind, route: STATE.route, title: STATE.title, source: STATE.source,
                    count: STATE.items.length,
                    checked: STATE.items.filter(function (i) { return i.checked; }).length,
                    running: STATE.running, index: STATE.index, total: STATE.total,
                    ok: STATE.ok, fail: STATE.fail, message: STATE.message,
                    items: STATE.items.map(function (i) {
                        return {
                            key: i.key, title: i.title, url: i.url, dur: i.dur,
                            checked: !!i.checked, state: i.state, error: i.error
                        };
                    })
                };
            },
            open: function () { if (STATE.phase === 'ready') { STATE.open = true; render(); } },
            close: function () { STATE.open = false; render(); },
            selectAll: function (v) { STATE.items.forEach(function (i) { i.checked = v !== false; }); render(); },
            start: function () { startQueue(); }
        };
    }

    // ---------------------------------------------------------------- 启动
    function boot() {
        STATE.route = parseRoute();
        STATE.kind = STATE.route ? STATE.route.kind : '';
        STATE.phase = 'probing';
        STATE.loading = true;
        probe().then(function (res) {
            STATE.loading = false;
            if (!res.ok) {
                // 一个 DOM 节点都不建
                STATE.phase = 'absent';
                STATE.reason = res.reason || '不可多选';
                info('多选入口未注入：' + STATE.reason);
                return;
            }
            var data = res.data;
            STATE.phase = 'ready';
            STATE.reason = '';
            STATE.kind = res.kind;
            STATE.title = data.title || '';
            STATE.subtitle = data.subtitle || '';
            STATE.source = data.source || '';
            STATE.items = (data.items || []).map(function (it) {
                it.checked = false;
                it.state = 'idle';
                it.error = '';
                return it;
            });
            log('可多选：' + res.count + ' 项，数据源 ' + STATE.source + ' → 准备注入插件面板');
            startPanelWatch();
        }).catch(function (e) {
            STATE.loading = false;
            STATE.phase = 'error';
            STATE.reason = String((e && e.message) || e);
            STATE.error = STATE.reason;
            info('多选入口未注入：' + STATE.reason);
        });
    }

    // 单页内路由变化（B 站部分页面是软导航）：路径变了就重判一次，不满足就撤掉入口
    var lastPath = location.pathname;
    setInterval(function () {
        if (location.pathname === lastPath) return;
        lastPath = location.pathname;
        removeEntry();
        host = null; root = null; ui = {};
        STATE.open = false;
        STATE.items = [];
        STATE.phase = 'idle';
        boot();
    }, 1000);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();

    try {
        chrome.runtime.onMessage.addListener(function (msg) {
            if (!msg || msg.target !== 'acgxBatch') return;
            if (msg.command === 'itemDone') onItemDone(msg);
        });
    } catch (e) { log('onMessage 注册失败', String(e)); }
})();
