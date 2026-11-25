/* =============================================================================
 * ACGhelper WebDAV 云同步 —— 配置页注入（html/config.html 末尾加载）
 *
 * 只干一件事：在右下角放一个浮动入口，点击新标签打开 html/webdav.html。
 * 刻意不碰 React 的配置页 bundle（js/pages/config.js），
 * 用一个独立 fixed 容器 + MutationObserver 兜底（React 重渲染可能清掉 body 子节点）。
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__ACG_WEBDAV_INJECTED__) return;
  window.__ACG_WEBDAV_INJECTED__ = true;

  var HOST_ID = '__acg_webdav_entry__';
  var OPENED_FLAG = '__acg_webdav_opened__';

  function openWebdavPage(ev) {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    var url = chrome.runtime.getURL('html/webdav.html');
    try {
      chrome.tabs.create({ url: url, active: true });
    } catch (e) {
      window.open(url, '_blank');
    }
  }

  function build() {
    var wrap = document.createElement('div');
    wrap.id = HOST_ID;
    wrap.style.cssText = [
      'position:fixed', 'right:22px', 'bottom:22px', 'z-index:2147483000',
      'display:flex', 'align-items:center', 'gap:8px',
      'font:13px/1.4 "Segoe UI","Microsoft YaHei",system-ui,sans-serif'
    ].join(';');

    var tip = document.createElement('div');
    tip.style.cssText = [
      'background:rgba(15,18,22,.94)', 'color:#cbd5e1', 'border:1px solid #2a323d',
      'border-radius:8px', 'padding:7px 11px', 'font-size:12px', 'display:none',
      'box-shadow:0 6px 24px rgba(0,0,0,.45)', 'max-width:280px'
    ].join(';');
    tip.textContent = 'WebDAV 云同步';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.title = '打开 WebDAV 云同步（替代官方会员服务器）';
    btn.style.cssText = [
      'cursor:pointer', 'border:none', 'border-radius:999px',
      'padding:11px 18px', 'font:600 13px/1 "Segoe UI","Microsoft YaHei",system-ui,sans-serif',
      'color:#04141b', 'background:linear-gradient(135deg,#00a1d6,#00c2ff)',
      'box-shadow:0 6px 22px rgba(0,161,214,.42)', 'display:flex', 'align-items:center', 'gap:7px',
      'transition:transform .12s ease,box-shadow .12s ease'
    ].join(';');

    var icon = document.createElement('span');
    icon.textContent = '☁';
    icon.style.cssText = 'font-size:15px;line-height:1';
    var label = document.createElement('span');
    label.textContent = 'WebDAV 同步';
    btn.appendChild(icon);
    btn.appendChild(label);

    btn.addEventListener('mouseenter', function () {
      btn.style.transform = 'translateY(-1px)';
      btn.style.boxShadow = '0 10px 26px rgba(0,161,214,.55)';
      tip.style.display = 'block';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.transform = 'none';
      btn.style.boxShadow = '0 6px 22px rgba(0,161,214,.42)';
      tip.style.display = 'none';
    });
    btn.addEventListener('click', openWebdavPage, true);

    wrap.appendChild(tip);
    wrap.appendChild(btn);
    return wrap;
  }

  function mount() {
    if (document.getElementById(HOST_ID)) return;
    var wrap = build();
    (document.body || document.documentElement).appendChild(wrap);
  }

  function boot() {
    mount();
    // React 重渲染把容器冲掉时补回来
    var obs = new MutationObserver(function () {
      if (!document.getElementById(HOST_ID)) mount();
    });
    try {
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
    // 页面内快捷键：Alt+Shift+W
    window.addEventListener('keydown', function (e) {
      if (e.altKey && e.shiftKey && (e.key === 'W' || e.key === 'w')) openWebdavPage(e);
    }, true);
    if (!window[OPENED_FLAG]) window[OPENED_FLAG] = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
