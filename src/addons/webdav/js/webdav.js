/* =============================================================================
 * ACGhelper WebDAV 云同步 —— 页面逻辑（html/webdav.html）
 * 依赖：../src/addons/webdav/js/webdav-core.js（暴露 self.ACHWebDAV）
 * ========================================================================== */
(function () {
  'use strict';

  var core = self.ACHWebDAV;
  if (!core) {
    document.body.insertAdjacentHTML('afterbegin',
      '<pre style="color:#f85149;padding:20px">核心库 webdav-core.js 未载入，页面无法工作。</pre>');
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var logBox = $('log');

  function tstr() {
    var d = new Date();
    return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function log(msg, cls) {
    var line = document.createElement('div');
    line.innerHTML = '<span class="t">[' + tstr() + ']</span> <span class="' + (cls || '') + '">' +
      String(msg).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>';
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function err2str(e) {
    if (!e) return '未知错误';
    return String(e.message || e);
  }

  function setPill(el, text, kind) {
    el.textContent = text;
    el.className = 'pill ' + kind;
  }

  /* ------------------------------------------------------------ 表单 <-> 配置 */

  async function fillForm() {
    var cfg = await core.loadConfig();
    $('server').value = cfg.server;
    $('username').value = cfg.username;
    $('password').value = cfg.password;
    $('remoteDir').value = cfg.remoteDir;
    $('fileName').value = cfg.fileName;
    $('autoSync').checked = !!cfg.autoSync;
    $('intervalMinutes').value = String(cfg.intervalMinutes);
    $('autoMode').value = cfg.autoMode;
    try {
      $('verText').textContent = '扩展 v' + chrome.runtime.getManifest().version;
    } catch (e) { /* ignore */ }
    await refreshAlarm();
    await refreshStats();
  }

  function readForm() {
    return {
      server: $('server').value.trim(),
      username: $('username').value.trim(),
      password: $('password').value,
      remoteDir: $('remoteDir').value.trim() || core.DEFAULTS.remoteDir,
      fileName: $('fileName').value.trim() || core.DEFAULTS.fileName,
      autoSync: $('autoSync').checked,
      intervalMinutes: Number($('intervalMinutes').value) || 15,
      autoMode: $('autoMode').value
    };
  }

  /** 自定义服务器要现申请 host 权限（必须在用户手势里调用） */
  async function ensureHostPermission(server) {
    if (!chrome.permissions) return true;
    var origin;
    try {
      origin = new URL(server).origin + '/*';
    } catch (e) {
      throw new Error('服务器地址不合法：' + server);
    }
    var has = await new Promise(function (res) {
      chrome.permissions.contains({ origins: [origin] }, function (v) {
        void chrome.runtime.lastError;
        res(!!v);
      });
    });
    if (has) return true;
    var granted = await new Promise(function (res) {
      chrome.permissions.request({ origins: [origin] }, function (v) {
        void chrome.runtime.lastError;
        res(!!v);
      });
    });
    if (!granted) throw new Error('未授予 ' + origin + ' 的访问权限，无法连接该服务器');
    return true;
  }

  async function save() {
    var cfg = await core.saveConfig(readForm());
    log('配置已保存：' + cfg.server + ' → ' + cfg.remoteDir + cfg.fileName, 's');
    await refreshAlarm();
    await refreshStats();
    return cfg;
  }

  /* ----------------------------------------------------------------- 状态刷新 */

  async function refreshAlarm() {
    var info = await core.alarmInfo();
    if (info) {
      var next = info.scheduledTime ? new Date(info.scheduledTime).toLocaleString('zh-CN', { hour12: false }) : '-';
      setPill($('alarmState'), '已创建 · 每 ' + (info.periodInMinutes || '?') + ' 分钟 · 下次 ' + next, 'ok');
    } else {
      setPill($('alarmState'), 'alarm 未创建（自动同步关闭）', 'idle');
    }
    return info;
  }

  async function refreshStats() {
    var st = await core.getState();
    $('stLast').textContent = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString('zh-CN', { hour12: false }) : '-';
    var res = st.lastResult || '-';
    var kind = res === 'ok' ? 'ok' : (res === 'conflict' ? 'warn' : (res === 'fail' ? 'bad' : 'idle'));
    if (res === 'ok' || res === 'fail' || res === 'conflict') {
      setPill($('stResult'), res + (st.lastDirection ? ' · ' + st.lastDirection : ''), kind);
    } else {
      setPill($('stResult'), '-', 'idle');
    }
    if (st.lastError) {
      $('stResult').title = st.lastError;
    }
    $('stSize').textContent = core.fmtBytes(st.remoteBytes) + ' / ' + core.fmtBytes(st.localBytes) +
      (st.lastHttp ? ' · HTTP ' + st.lastHttp : '');
    if (st.localSha256 || st.remoteSha256) {
      var eq = st.localSha256 && st.remoteSha256 && st.localSha256 === st.remoteSha256;
      $('stSha').innerHTML = '<span class="pill ' + (eq ? 'ok' : 'warn') + '">' + (eq ? '一致' : '不一致') + '</span><br>' +
        String(st.localSha256 || '-').slice(0, 16) + '… / ' + String(st.remoteSha256 || '-').slice(0, 16) + '…';
    } else {
      $('stSha').textContent = '-';
    }
    return st;
  }

  /* ------------------------------------------------------------------- 动作 */

  var busy = false;

  async function guard(fn, label) {
    if (busy) { log('上一次操作还在进行中，请稍候', 'w'); return; }
    busy = true;
    var btns = ['btnSave', 'btnTest', 'btnUpload', 'btnDownload', 'btnDiff', 'btnRestore', 'btnClearAlarm'];
    btns.forEach(function (b) { var e = $(b); if (e) e.disabled = true; });
    log('▶ ' + label + ' …');
    try {
      await fn();
    } catch (e) {
      log('✖ ' + label + ' 失败：' + err2str(e), 'e');
      if (e && e.message) log('  ' + e.message, 'e');
    } finally {
      busy = false;
      btns.forEach(function (b) { var e = $(b); if (e) e.disabled = false; });
      await refreshStats();
      await refreshAlarm();
    }
  }

  function bind() {
    $('btnSave').addEventListener('click', function () {
      guard(async function () {
        var cfg = await save();
        try { await ensureHostPermission(cfg.server); } catch (e) { log('权限：' + err2str(e), 'w'); }
      }, '保存配置');
    });

    $('btnTest').addEventListener('click', function () {
      guard(async function () {
        var cfg = await save();
        await ensureHostPermission(cfg.server);
        var r = await core.testConnection();
        r.steps.forEach(function (s) {
          log('· ' + s.step + ' → ' + (s.http !== null && s.http !== undefined ? 'HTTP ' + s.http : 'ERR') +
            (s.sha256Match === true ? ' / sha256 一致' : (s.sha256Match === false ? ' / sha256 不一致' : '')) +
            (s.error ? ' / ' + s.error : ''), s.error ? 'e' : '');
        });
        if (r.ok) {
          setPill($('testState'), '连接正常 · ' + r.elapsedMs + 'ms', 'ok');
          log('✔ 连接测试通过（耗时 ' + r.elapsedMs + 'ms）', 's');
        } else {
          setPill($('testState'), '失败', 'bad');
          log('✖ 连接测试失败：' + (r.error || '未知'), 'e');
        }
      }, '测试连接');
    });

    $('btnUpload').addEventListener('click', function () {
      guard(async function () {
        var cfg = await save();
        await ensureHostPermission(cfg.server);
        var r = await core.uploadSettings({ reason: 'manual' });
        log('PUT ' + core.remoteFilePath(cfg) + ' → HTTP ' + r.http + '，' + core.fmtBytes(r.bytes), 's');
        log('本地 sha256 = ' + r.sha256);
        log('远端 sha256 = ' + (r.remoteSha256 || '(未回读)') +
          (r.remoteSha256 && r.remoteSha256 === r.sha256 ? ' ✔ 回读一致' : ''), 's');
      }, '立即上传');
    });

    $('btnDownload').addEventListener('click', function () {
      guard(async function () {
        var cfg = await save();
        await ensureHostPermission(cfg.server);
        var ok = window.confirm('下载会覆盖本地设置（覆盖前已自动存一份本地快照，可用「恢复上一份本地快照」回滚）。继续？');
        if (!ok) { log('已取消下载'); return; }
        var r = await core.downloadSettings({ reason: 'manual' });
        log('GET ' + core.remoteFilePath(cfg) + ' → HTTP 200，' + core.fmtBytes(r.bytes) + '，sha256=' + r.sha256, 's');
        log('已下发渠道：' + r.applied.applied + '，写入 ' + r.applied.keys + ' 项', 's');
        log('本次覆盖前的本地快照已存入历史（webdav-history-v1，保留最近 ' + 5 + ' 份）', 'w');
      }, '立即下载');
    });

    $('btnDiff').addEventListener('click', function () {
      guard(async function () {
        var cfg = await save();
        await ensureHostPermission(cfg.server);
        var d = await core.diffRemote();
        var out = $('diffOut');
        var html = [];
        html.push('<div>本地：<b>' + core.fmtBytes(d.localBytes) + '</b> · ' + d.localItems + ' 个模块 · sha256 ' + String(d.localSha256 || '').slice(0, 16) + '…</div>');
        if (!d.exists) {
          html.push('<div>远端：<b>（还没有备份文件 ' + d.remoteFile + '）</b></div>');
          out.innerHTML = html.join('');
          log('远端还没有备份文件，先「立即上传」', 'w');
          return;
        }
        html.push('<div>远端：<b>' + core.fmtBytes(d.remoteBytes) + '</b> · ' + d.remoteItems + ' 个模块 · sha256 ' + String(d.remoteSha256 || '').slice(0, 16) + '…</div>');
        html.push('<div>远端导出于 ' + (d.remoteExportedAt || '-') + '（扩展 v' + (d.remoteVersion || '?') + '）</div>');
        html.push('<div>内容：<b>' + (d.identical ? '完全相同' : '有差异') + '</b></div>');
        if (!d.identical) {
          if (d.added.length) html.push('<div>远端多出：' + d.added.join(', ') + '</div>');
          if (d.removed.length) html.push('<div>远端缺少：' + d.removed.join(', ') + '</div>');
          if (d.changed.length) html.push('<div>内容不同：' + d.changed.join(', ') + '</div>');
        }
        out.innerHTML = html.join('');
        log('差异比对完成：' + (d.identical ? '完全相同' : ('新增 ' + d.added.length + ' / 缺失 ' + d.removed.length + ' / 变化 ' + d.changed.length)), d.identical ? 's' : 'w');
      }, '比对差异');
    });

    $('btnRestore').addEventListener('click', function () {
      guard(async function () {
        var list = await core.historyList();
        if (!list.length) { log('还没有任何本地快照', 'w'); return; }
        var menu = list.map(function (r, i) {
          return '[' + i + '] ' + new Date(r.at).toLocaleString('zh-CN', { hour12: false }) + ' · ' + r.kind +
            ' · ' + core.fmtBytes(r.bytes) + (r.truncated ? '（已截断）' : '');
        }).join('\n');
        var pick = window.prompt('选择要恢复的快照序号（0 为最新）：\n\n' + menu, '0');
        if (pick === null) return;
        var idx = parseInt(pick, 10);
        if (isNaN(idx)) { log('序号不合法', 'e'); return; }
        var r = await core.historyRestore(idx);
        log('已恢复快照 #' + idx + '：渠道 ' + r.applied + '，写入 ' + r.keys + ' 项', 's');
      }, '恢复本地快照');
    });

    $('btnClearAlarm').addEventListener('click', function () {
      guard(async function () {
        await core.saveConfig({ autoSync: false });
        $('autoSync').checked = false;
        await core.scheduleAlarm();
        log('自动同步已停用，alarm 已清除', 'w');
      }, '停用自动同步');
    });

    ['autoSync', 'intervalMinutes', 'autoMode'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        guard(async function () {
          await save();
          var info = await core.alarmInfo();
          log(info ? ('自动同步已开启：每 ' + info.periodInMinutes + ' 分钟，方向 ' + $('autoMode').value) : '自动同步已关闭', 's');
        }, '更新自动同步设置');
      });
    });

    $('btnCopyLog').addEventListener('click', function () {
      navigator.clipboard.writeText(logBox.innerText).then(function () {
        log('日志已复制到剪贴板');
      }, function () { log('复制失败（浏览器拒绝剪贴板写入）', 'e'); });
    });
    $('btnClearLog').addEventListener('click', function () { logBox.innerHTML = ''; });

    // 页面开着时也响应 alarm（SW 已注册主监听，这里只做界面刷新，不重复执行同步）
    try {
      chrome.alarms.onAlarm.addListener(function (a) {
        if (a && a.name === core.ALARM) {
          log('alarm 到点：' + a.name + '（同步由 Service Worker 执行）', 'w');
          setTimeout(function () { refreshStats(); refreshAlarm(); }, 1500);
        }
      });
    } catch (e) { /* ignore */ }
  }

  // CDP/控制台调试入口
  window.__webdav = core;
  window.__webdavLog = log;

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    fillForm().then(function () {
      log('就绪。服务器：' + $('server').value, 's');
      log('远端目录：' + $('remoteDir').value + $('fileName').value);
      log('提示：官方云同步走 acghelper.com/g（会员服务器）；本页把同一份设置 JSON 搬到你的 WebDAV。');
    }).catch(function (e) {
      log('初始化失败：' + err2str(e), 'e');
    });
  });
})();
