/*!
 * acgx-batch-offscreen.js —— 选集 / 多 P 批量下载的 offscreen 执行端
 *
 * 由 js/pages/background.js 的消息路由（St）在末尾新增的两个分支调用：
 *   command === "acgxAutoDownload"  →  await self.__acgxBatchAuto(msg, sender, sendResponse, bt)
 *   command === "acgxAbortAll"      →  self.__acgxBatchAbort()
 *
 * 设计原则：
 *   * 不自己实现下载器 —— 全部复用 background.js 里的 class bt（new bt(url, tabId) / init() / download()）。
 *   * 不猜 downloadOptionIndex / optionDataVersion —— 直接读 bt.downloadOptionData（H() 产出）
 *     里 video/audio 的 value(=qn / 音轨 id)，按 qn / audioQn 选出索引，拼出 download() 要的选项字符串
 *     （格式 "视频索引-编码索引-线路索引,音频索引-编码索引-线路索引"，与 K()/X() 一致）。
 *   * 严格串行：同时只允许一集在跑，第二集进来直接回 BATCH_BUSY（页面侧本来就是串行发）。
 *   * 回执走 chrome.runtime.sendMessage({to:"targetTab",tabId,message:{target:"acgxBatch",...}})，
 *     由 SW 转发成 chrome.tabs.sendMessage 才能到达内容脚本。
 */
(function () {
    'use strict';
    if (self.__acgxBatchOffscreen__) return;
    self.__acgxBatchOffscreen__ = true;

    var TAG = '[acgx-batch]';
    var VERSION = '1.0.0';

    var active = [];        // 正在下载的实例 [{url, inst, opt, finish}]
    var busyUrl = '';       // 当前占用的 url（串行闸门）

    // 解析阶段硬超时：bt.init() 里 await 的是 SW 的 videoParse，那条链路失败时不回 sendResponse，
    // 会一直挂着 —— 必须由这里兜住，否则一集就把整条队列焊死。
    // 取值优先级：msg.initTimeoutMs > chrome.storage.local.acgxBatchInitTimeoutMs > 默认 90s
    var DEFAULT_INIT_TIMEOUT = 90000;

    // 音轨 id 优先级：高清音质 > 标准 > 电话 > 其他标准档
    var AUDIO_PRIORITY = [30280, 30232, 30216, 100010, 100009, 100008];
    var AUDIO_LABEL = { 30216: '电话音质', 30232: '标准音质', 30280: '高清音质', 30250: '杜比全景声', 30251: 'Hi-Res', 30255: '杜比音效' };

    function log() {
        try {
            var a = [TAG].concat([].slice.call(arguments));
            console.log.apply(console, a);
        } catch (e) { /* ignore */ }
    }

    function reply(tabId, payload) {
        if (!tabId) { log('无 tabId，回执丢弃', JSON.stringify(payload)); return; }
        try {
            var msg = { to: 'targetTab', tabId: tabId, message: payload };
            var p = chrome.runtime.sendMessage(msg);
            if (p && typeof p.catch === 'function') p.catch(function () { /* SW 可能不在，忽略 */ });
        } catch (e) {
            log('回执发送失败', String(e && e.message || e));
        }
    }

    /** 在 video 列表里按 qn 选索引；0 = 最高可用 */    function pickVideo(video, qn) {
        if (!video.length) return { index: -1 };
        if (qn > 0) {
            for (var i = 0; i < video.length; i++) {
                if (Number(video[i].value) === qn) return { index: i, exact: true };
            }
            // 没有精确档位 → 优先「不高于目标的最大档」，否则「高于目标的最小档」
            var lo = -1, loQ = -1, hi = -1, hiQ = Infinity;
            for (var j = 0; j < video.length; j++) {
                var q = Number(video[j].value) || 0;
                if (q <= qn && q > loQ) { loQ = q; lo = j; }
                else if (q > qn && q < hiQ) { hiQ = q; hi = j; }
            }
            var pick = lo >= 0 ? lo : (hi >= 0 ? hi : 0);
            return { index: pick, exact: false, fallbackFrom: qn, fallbackTo: Number(video[pick].value) };
        }
        var best = 0, bestQ = -1;
        for (var k = 0; k < video.length; k++) {
            var v = Number(video[k].value) || 0;
            if (v > bestQ) { bestQ = v; best = k; }
        }
        return { index: best, exact: true };
    }

    /** 编码优先 avc1（兼容性最好），否则取第一个 */
    function pickCodec(entry) {
        var children = (entry && entry.children) || [];
        if (!children.length) return { ci: -1, li: -1, child: null };
        var ci = 0;
        for (var i = 0; i < children.length; i++) {
            if (String(children[i].value) === 'avc1') { ci = i; break; }
        }
        var lines = (children[ci] && children[ci].children) || [];
        return { ci: ci, li: lines.length ? 0 : -1, child: children[ci] };
    }

    function pickAudio(audio, audioQn) {
        if (!audio.length) return { index: -1, warn: '' };
        var find = function (id) {
            for (var i = 0; i < audio.length; i++) if (Number(audio[i].value) === id) return i;
            return -1;
        };
        if (audioQn > 0) {
            var idx = find(audioQn);
            if (idx >= 0) return { index: idx, warn: '' };
            for (var p = 0; p < AUDIO_PRIORITY.length; p++) {
                var d = find(AUDIO_PRIORITY[p]);
                if (d >= 0) return { index: d, warn: (AUDIO_LABEL[audioQn] || String(audioQn)) + ' 不可用，已回退默认音轨' };
            }
            return { index: 0, warn: (AUDIO_LABEL[audioQn] || String(audioQn)) + ' 不可用，已回退第一个音轨' };
        }
        for (var q = 0; q < AUDIO_PRIORITY.length; q++) {
            var hit = find(AUDIO_PRIORITY[q]);
            if (hit >= 0) return { index: hit, warn: '' };
        }
        return { index: audio.length - 1, warn: '未命中标准音轨档位，取列表最后一个' };
    }

    /** 拼 download() 需要的选项字符串（等价于 K() 的输出格式） */
    function buildOption(inst, qn, audioQn) {
        var od = inst.downloadOptionData || { video: [], audio: [] };
        var video = od.video || [], audio = od.audio || [];
        var isFLV = !!(inst.basicDownloadInfo && inst.basicDownloadInfo.isFLV);

        var vs = pickVideo(video, qn);
        if (vs.index < 0) throw new Error('NO_VIDEO_OPTION（该视频没有可选画质，可能未登录/无版权）');
        var v = video[vs.index];
        var vc = pickCodec(v);

        if (isFLV) {
            // downloadFLV 只认 Number(opt.split(",")[0]) → 视频索引
            return {
                opt: String(vs.index),
                videoQn: Number(v.value) || 0,
                audioQn: 0,
                warn: vs.exact ? '' : ('画质 ' + qn + ' 不可用，已回退 ' + (Number(v.value) || 0)),
                codec: '', line: ''
            };
        }
        if (vc.ci < 0) throw new Error('NO_VIDEO_CODEC（画质 ' + (Number(v.value) || 0) + ' 没有可用编码）');

        var as = pickAudio(audio, audioQn);
        var a = as.index >= 0 ? audio[as.index] : null;
        var ac = a ? pickCodec(a) : { ci: -1, li: -1 };

        var vpart = [vs.index, vc.ci, vc.li >= 0 ? vc.li : 0].join('-');
        var apart = a ? [as.index, ac.ci >= 0 ? ac.ci : 0, ac.li >= 0 ? ac.li : 0].join('-') : '';
        var warns = [vs.warn, as.warn].filter(Boolean).join('；');

        return {
            opt: vpart + ',' + apart,
            videoQn: Number(v.value) || 0,
            audioQn: a ? (Number(a.value) || 0) : 0,
            warn: warns,
            codec: (vc.child && vc.child.value) || '',
            line: ''
        };
    }

    /** 给一个 Promise 套硬超时（超时即 reject，让队列继续往下走） */
    function withTimeout(p, ms, label) {
        if (!(ms > 0)) return p;
        var t = null;
        var guard = new Promise(function (_, rej) {
            t = setTimeout(function () {
                rej(new Error(label + '：' + Math.round(ms / 1000) + 's 内没有结果'));
            }, ms);
        });
        return Promise.race([p, guard]).then(function (v) {
            if (t) { clearTimeout(t); t = null; }
            return v;
        }, function (e) {
            if (t) { clearTimeout(t); t = null; }
            throw e;
        });
    }

    /** 解析阶段超时：msg.initTimeoutMs > storage.acgxBatchInitTimeoutMs > 90s */
    async function resolveInitTimeout(msg) {
        var v = Number(msg && msg.initTimeoutMs) || 0;
        if (v > 0) return v;
        try {
            var r = await chrome.storage.local.get('acgxBatchInitTimeoutMs');
            v = Number(r && r.acgxBatchInitTimeoutMs) || 0;
        } catch (e) { /* storage 不可用就用默认 */ }
        return v > 0 ? v : DEFAULT_INIT_TIMEOUT;
    }

    /**
     * acgxAutoDownload 的实际实现。
     * @param {object} msg     {url, qn, audioQn, tabId, timeoutMs, initTimeoutMs}
     * @param {object} sender  MessageSender
     * @param {function} sendResponse
     * @param {function} Bt    background.js 里的 class bt（由路由分支传入，避免本文件依赖 bundle 作用域）
     */
    async function autoDownload(msg, sender, sendResponse, Bt) {
        var url = (msg && msg.url) || '';
        var tabId = (msg && msg.tabId) || (sender && sender.tab && sender.tab.id) || 0;
        var qn = Number(msg && msg.qn) || 0;
        var audioQn = Number(msg && msg.audioQn) || 0;
        var timeoutMs = Number(msg && msg.timeoutMs) || 0;

        var done = false, timer = null, inst = null, opt = null, exitTimer = null;
        var rec = { url: url, inst: null, opt: null, finish: null };

        function finish(ok, extra) {
            if (done) return;
            done = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
            var i = active.indexOf(rec);
            if (i >= 0) active.splice(i, 1);
            if (busyUrl === url) busyUrl = '';
            var payload = { target: 'acgxBatch', command: 'itemDone', url: url, ok: !!ok };
            for (var k in extra || {}) if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] !== undefined) payload[k] = extra[k];
            log('done url=' + url + ' ok=' + ok + ' ' + (payload.error || payload.warn || ''));
            reply(tabId, payload);
            if (sendResponse) { try { sendResponse({ ok: !!ok, url: url }); } catch (e) { /* ignore */ } }
        }
        rec.finish = finish;

        try {
            if (!url) throw new Error('NO_URL');
            if (typeof Bt !== 'function') throw new Error('NO_DOWNLOADER（background.js 未把 bt 传进来）');
            if (busyUrl && busyUrl !== url) {
                log('busy', busyUrl, 'reject', url);
                finish(false, { error: 'BATCH_BUSY：上一集还在下载（' + busyUrl + '）' });
                return;
            }
            busyUrl = url;

            log('recv url=' + url + ' qn=' + qn + ' audioQn=' + audioQn + ' tabId=' + tabId);
            rec.url = url;
            var initMs = await resolveInitTimeout(msg);
            log('init start url=' + url + ' initTimeout=' + initMs + 'ms');
            inst = new Bt(url, tabId);
            rec.inst = inst;
            timer = timeoutMs > 0 ? setTimeout(function () {
                log('timeout url=' + url);
                finish(false, { error: 'TIMEOUT：' + Math.round(timeoutMs / 60000) + ' 分钟未完成' });
            }, timeoutMs) : null;

            var initP = Promise.resolve().then(function () { return inst.init(); });
            initP.catch(function () { /* 超时先返回的情况下，底层再晚到的 reject 不算未处理 */ });
            await withTimeout(initP, initMs, 'INIT_TIMEOUT（视频信息解析）');
            if (done) return;

            var od = inst.downloadOptionData || { video: [], audio: [] };
            log('options url=' + url +
                ' video=[' + (od.video || []).map(function (x) { return x.value; }).join(',') + ']' +
                ' audio=[' + (od.audio || []).map(function (x) { return x.value; }).join(',') + ']' +
                ' flv=' + !!(inst.basicDownloadInfo && inst.basicDownloadInfo.isFLV));

            var sel = buildOption(inst, qn, audioQn);
            opt = sel.opt;
            rec.opt = opt;
            log('select url=' + url + ' opt=' + opt + ' videoQn=' + sel.videoQn + ' audioQn=' + sel.audioQn +
                ' codec=' + sel.codec + (sel.warn ? ' warn=' + sel.warn : ''));
            if (done) return;

            active.push(rec);

            inst.addListenerIfNone('complete', function () {
                finish(true, { quality: sel.videoQn, audio: sel.audioQn, warn: sel.warn || '' });
            }, 'acgxBatch');
            inst.addListenerIfNone('completeByManualStop', function () {
                finish(false, { error: 'CANCELLED：已取消' });
            }, 'acgxBatch');
            inst.addListenerIfNone('error', function (e) {
                finish(false, { error: String((e && e.message) || e || '下载出错') });
            }, 'acgxBatch');

            log('download start url=' + url);
            await inst.download(opt, void 0, void 0, void 0);
            log('download kicked url=' + url + ' (等 complete/error 回执)');

            // download() 只负责起跑；如果它 resolve 后 3 分钟既没有 complete 也没有 error，
            // 说明文件写入那头卡住了 —— 直接结束这一集，别把队尾焊死。
            if (timeoutMs > 0) {
                exitTimer = setTimeout(function () {
                    if (!done && inst && !inst.downloading) {
                        finish(false, { error: 'NO_PROGRESS：3 分钟内没有下载进度' });
                    }
                }, Math.min(timeoutMs, 180000));
            }
        } catch (e) {
            var msgText = String((e && e.message) || e || '未知错误');
            log('error url=' + url + ' ' + msgText);
            finish(false, { error: msgText });
        }
    }

    /** 取消：让正在跑的那一集停下来（走 bt.stop(选项字符串)） */
    function abortAll() {
        var n = 0;
        active.slice().forEach(function (rec) {
            try {
                if (rec.inst && rec.opt) { rec.inst.stop(rec.opt); n += 1; }
            } catch (e) {
                log('abort fail', String(e && e.message || e));
            }
        });
        log('abortAll active=' + active.length);
        return { ok: true, aborted: n };
    }

    self.__acgxBatchAuto = autoDownload;
    self.__acgxBatchAbort = abortAll;
    self.__acgxBatchInfo = function () {
        return { version: VERSION, active: active.length, busyUrl: busyUrl };
    };
    log('offscreen helper ready v' + VERSION);
})();
