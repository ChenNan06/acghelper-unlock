/* =============================================================================
 * ACGhelper WebDAV 云同步 —— Service Worker 侧引导（由 initBackground.sw.js 尾部
 * importScripts 载入，见 tools/feature-webdav.json 的 W1 补丁）
 *
 * 只做两件事：
 *   1) 注册 chrome.alarms.onAlarm 监听（写在 SW 里，页面关掉也能按时自动同步）；
 *   2) SW 启动时按配置兜底重建 / 清除 alarm（alarm 本身跨 SW 回收持久，这里防手滑丢配置）。
 *
 * 任何异常都吞掉：SW 是扩展的心脏，同步功能绝不能把它带崩。
 * ========================================================================== */
(function () {
  'use strict';
  try {
    var core = self.ACHWebDAV;
    if (!core) {
      console.warn('[webdav] core 未载入，跳过 SW 引导');
      return;
    }

    try {
      chrome.alarms.onAlarm.addListener(function (alarm) {
        if (!alarm || alarm.name !== core.ALARM) return;
        console.log('[webdav] alarm 触发：' + new Date().toISOString());
        core.autoTick('alarm').then(function (r) {
          console.log('[webdav] autoTick -> ' + JSON.stringify(r));
        }).catch(function (e) {
          console.warn('[webdav] autoTick 异常: ' + (e && e.message ? e.message : e));
        });
      });
    } catch (e) {
      console.warn('[webdav] 注册 alarm 监听失败: ' + (e && e.message ? e.message : e));
    }

    // 启动兜底：配置开着但 alarm 丢了 → 重建；配置关了但 alarm 还在 → 清掉
    core.loadConfig().then(function (cfg) {
      return core.alarmInfo().then(function (info) {
        if (cfg.autoSync && !info) return core.scheduleAlarm(cfg);
        if (!cfg.autoSync && info) return core.scheduleAlarm(cfg);
        return null;
      });
    }).then(function (info) {
      if (info) console.log('[webdav] autosync alarm = ' + JSON.stringify(info));
    }).catch(function (e) {
      console.warn('[webdav] alarm 兜底失败: ' + (e && e.message ? e.message : e));
    });
  } catch (e) {
    console.warn('[webdav] SW 引导异常: ' + (e && e.message ? e.message : e));
  }
})();
