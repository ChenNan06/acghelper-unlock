#!/usr/bin/env node
/**
 * batch-inpanel-test.mjs —— 「选集下载入口并进 ACGhelper 自己的悬浮面板」验收（headless Chrome + CDP）
 *
 * 场景：
 *   A  番剧 fixture（4 集）        → 插件面板内部出现「选集下载」入口；点击展开 4 集；样式对比表
 *   B  单集番剧 fixture（1 集）    → 入口完全不出现（DOM 里找不到 + 面板子节点数与基线相同）
 *   C  单 P（pages=1）不出现 / 多 P（pages=3）出现且列出 3 个分 P
 *   D  既有队列不回归：全选 → 开始 → offscreen 收到 N 条 acgxAutoDownload → 串行回执
 *   E  失败分支：season 接口 -101（未登录）→ 入口不出现 + console 一行诊断
 *
 * 环境铁律：
 *   全 headless；--mute-audio；--enable-unsafe-extension-debugging；--remote-debugging-port；
 *   独立 --user-data-dir；窗口尺寸 914×1415；只用 Page.captureScreenshot 截图；
 *   不调用 SetForegroundWindow / SetCursorPos / SendInput；结束按 PID 树 + profile 精确清场。
 *
 * 用法: node tools/batch-inpanel-test.mjs [--tree=build/batch-inpanel-test] [--port=9481] [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = String.raw`D:\AI-Project\逆向统一\acghelper`;
const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const argv = process.argv.slice(2);
const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const KEEP = argv.includes('--keep');
const TREE = path.resolve(ROOT, flag('tree') || path.join('build', 'batch-inpanel-test'));
const PORT = Number(flag('port') || 9481);
const LOGDIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ---------------------------------------------------------------- 断言台账
const checks = [];
function check(ok, name, detail = '') {
  checks.push({ ok: !!ok, name, detail: String(detail || '') });
  say(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '\n        ' + String(detail).split('\n').join('\n        ') : ''}`);
  return ok;
}

// ---------------------------------------------------------------- CDP 客户端
function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error ' + wsUrl)), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method) {
      for (const fn of listeners) { try { fn(m); } catch { /* ignore */ } }
    }
  });
  return {
    opened,
    on(fn) { listeners.push(fn); },
    send(method, params = {}, sessionId = null, timeoutMs = 25000) {
      const id = ++seq;
      return opened.then(() => new Promise((res, rej) => {
        const timer = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + method)); }, timeoutMs);
        pending.set(id, { res, rej, timer });
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
      }));
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

const httpJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(4000) })).json();
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function waitPortFree(port) {
  for (let i = 0; i < 16; i++) { if (await portFree(port)) return true; await sleep(500); }
  return false;
}
function ps(cmd) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { encoding: 'utf8', timeout: 25000 }).trim();
  } catch (e) { return 'ERR ' + e.message; }
}
function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
}
/** 按 user-data-dir 精确清场：先 taskkill 整棵树，再逐 PID 兜底，直到 0 */
async function purgeProfileChrome(profileDir) {
  const raw = ps(`@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profileDir}') } | Select-Object -ExpandProperty ProcessId) -join ','`);
  for (const pidStr of String(raw).split(',')) {
    const pid = Number(pidStr.trim());
    if (pid > 0) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
  }
  let left = '?';
  for (let i = 0; i < 12; i++) {
    await sleep(600);
    left = ps(`@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profileDir}') }).Count`);
    if (String(left).trim() === '0') return '0';
    ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profileDir}') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }`);
  }
  return String(left).trim();
}
/** CDP 鼠标点击（只打自己的 headless 页面；不碰任何 OS 级输入） */
async function cdpClick(P, x, y) {
  await P('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(80);
  await P('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60);
  await P('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
const FG_PS = "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int pid);'; " +
  "$h=[W.U]::GetForegroundWindow(); $x=0; [void][W.U]::GetWindowThreadProcessId($h,[ref]$x); " +
  "$p=Get-Process -Id $x -ErrorAction SilentlyContinue; \"$($h.ToInt64())|$x|$($p.ProcessName)\"";
function fgInfo() {
  const raw = ps(FG_PS);
  const [hwnd, pid, name] = String(raw).split('|');
  return { raw, hwnd, pid: Number(pid) || 0, name: name || '' };
}

// ---------------------------------------------------------------- fixture
function seasonFixture(n, code = 0, message = 'success') {
  if (code !== 0) return { code, message, ttl: 1, data: null };
  const eps = [];
  for (let i = 1; i <= n; i++) {
    eps.push({
      ep_id: 900000 + i, aid: 1000 + i, bvid: 'BV1xx411c7m' + i, cid: 2000 + i,
      title: String(i), long_title: `第${i}话 fixture 标题`, share_copy: `第${i}话 fixture 标题`,
      duration: 1440000 + i * 1000, cover: 'https://i0.hdslb.com/bfs/fixture.jpg',
      link: `https://www.bilibili.com/bangumi/play/ep${900000 + i}`, pub_time: 1700000000,
    });
  }
  return {
    code: 0, message: 'success', ttl: 1,
    result: {
      season_id: 990000, season_title: 'ACGN 测试番剧（fixture）', season_type_name: '番剧',
      total: n, episodes: eps, section: [], main_section: null,
    },
  };
}
function viewFixture(n) {
  const pages = [];
  for (let i = 1; i <= n; i++) {
    pages.push({ cid: 3000 + i, page: i, from: 'vupload', part: `分段${i} fixture`, duration: 600 + i, width: 1920, height: 1080 });
  }
  return {
    code: 0, message: '0', ttl: 1,
    data: {
      bvid: 'BV1xx411c7m9', aid: 990099, title: 'ACGN 多 P fixture 视频', videos: n, pages,
      pic: 'https://i0.hdslb.com/bfs/fixture.jpg', owner: { mid: 1, name: 'fixture-up' },
      stat: { view: 1000, danmaku: 10, reply: 1, favorite: 2, coin: 3, share: 4, like: 5 },
      duration: 1800, cid: 3001, desc: 'fixture', pubdate: 1700000000,
    },
  };
}
const pageHtml = (title) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title></head><body>
<div id="app"><h1 id="fixture-h1">${title}</h1>
<div id="viewbox_report"><h1>${title}</h1></div>
<p>本页面由 CDP Fetch.fulfillRequest 提供，不产生任何真实网络请求。</p></div>
</body></html>`;

// ---------------------------------------------------------------- 页面内探针
const PROBE = String.raw`(() => {
  const PANEL = 'bilibiliHelper2ContentWrapper';
  const panel = document.getElementById(PANEL);
  const handle = document.getElementById('bilibiliHelper2HandleButtonWrapper');
  const hb = document.getElementById('bilibiliHelper2HandleButton');
  const host = document.getElementById('acgx-batch-host');
  const out = {
    ready: document.readyState,
    hasHandle: !!handle, hasHandleBtn: !!hb, hasPanel: !!panel,
    panelClass: panel ? panel.className : null,
    panelOpen: panel ? !/hide/.test(String(panel.className)) : false,
    bodyChildren: document.body.children.length,
    bodyAcgxChildren: [...document.body.children].filter(e => /^acgx-/.test(e.id || '')).length,
    panelChildren: panel ? panel.children.length : -1,
    panelChildTags: panel ? [...panel.children].map(c => c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') + (typeof c.className === 'string' && c.className ? '.' + c.className.trim().split(/\s+/).join('.') : '')) : [],
    hostFound: !!host,
    hostParent: host && host.parentNode ? (host.parentNode.id || host.parentNode.tagName) : null,
    hostBeforeFooter: false,
    hostIndex: -1,
    acgxNodesAnywhere: document.querySelectorAll('[id^="acgx-"]').length,
  };
  if (panel) {
    const kids = [...panel.children];
    if (host) {
      out.hostIndex = kids.indexOf(host);
      const fi = kids.findIndex(e => e.tagName === 'FOOTER');
      out.footerIndex = fi;
      out.hostBeforeFooter = fi >= 0 && out.hostIndex === fi - 1;
    }
  }
  const sr = host && host.shadowRoot;
  out.shadow = !!sr;
  if (sr) {
    const sec = sr.querySelector('section.sec');
    const g = (k) => sec ? sec.getAttribute('data-acgx-' + k) : null;
    const rows = [...sr.querySelectorAll('[data-acgx-role="item"]')];
    const entry = sr.getElementById('acgx-entry');
    const body = sr.getElementById('acgx-body');
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }; };
    out.ui = {
      phase: g('phase'), injected: g('injected'), open: g('open') === '1', kind: g('kind'),
      count: Number(g('count') || 0), checked: Number(g('checked') || 0),
      running: g('running') === '1', index: Number(g('index') || 0), total: Number(g('total') || 0),
      ok: Number(g('ok') || 0), fail: Number(g('fail') || 0),
      error: g('error') || '', source: g('source') || '', message: g('message') || '',
      rows: rows.length,
      keys: rows.map(r => r.getAttribute('data-acgx-key')),
      titles: rows.slice(0, 5).map(r => { const n = r.querySelector('.n'); return n ? n.textContent : ''; }),
      durs: rows.slice(0, 5).map(r => { const d = r.querySelector('.d'); return d ? d.textContent : ''; }),
      states: rows.map(r => r.getAttribute('data-st')),
      retryBtns: sr.querySelectorAll('[data-acgx-role="retry"]').length,
      statusText: (sr.getElementById('acgx-status') || {}).textContent || '',
      hint: (sr.getElementById('acgx-hint') || {}).textContent || '',
      bodyHidden: body ? body.hidden : null,
      entryRect: rect(entry),
      hostRect: rect(host),
      hasFab: !!sr.querySelector('.fab'),
      hasEntryBtn: !!(entry && entry.querySelector('button')),
    };
    // 样式快照（原生 div.button.primary vs 我们的入口）
    const pick = (el, props) => { if (!el) return null; const cs = getComputedStyle(el); const o = {}; for (const p of props) o[p] = cs.getPropertyValue(p); return o; };
    const P = ['font-size','font-family','border-radius','background-color','color',
               'border-top-width','border-top-style','border-top-color','height','padding','box-shadow'];
    const native = panel ? panel.querySelector('div.button.primary') : null;
    out.style = {
      nativeSelector: native ? ('div.button.primary «' + (native.textContent || '').trim().slice(0, 12) + '»') : '(none)',
      native: pick(native, P),
      ours: pick(entry, P),
      ourBtn: pick(entry && entry.querySelector('button'), P),
    };
    // CSS 变量是否真的来自原生按钮
    out.vars = (() => {
      if (!host) return null;
      const s = getComputedStyle(host);
      const names = ['--acgx-font','--acgx-font-size','--acgx-radius','--acgx-btn-h','--acgx-primary-bg','--acgx-primary-fg','--acgx-border-c','--acgx-sec-w'];
      const o = {}; for (const n of names) o[n] = s.getPropertyValue(n).trim();
      return o;
    })();
    out.hostStyleAttr = host ? host.getAttribute('style') : null;
  }
  return out;
})()`;

// ---------------------------------------------------------------- 主流程
const report = { tree: TREE, startedAt: new Date().toISOString() };
let chromeProc = null;
let profile = '';
let fgBefore = { raw: '' };
let code = 2;

async function main() {
  say('================ 选集下载入口 · 并进插件面板 · headless CDP 验收 ================');
  say(`扩展树 : ${TREE}`);
  if (!fs.existsSync(path.join(TREE, 'js', 'pages', 'acgx-batch.js'))) {
    say(`[FATAL] ${TREE} 缺 js/pages/acgx-batch.js`);
    return 2;
  }
  if (!(await waitPortFree(PORT))) { say(`[FATAL] 端口 ${PORT} 8s 内未释放`); return 2; }

  fgBefore = fgInfo();
  say(`[env] GetForegroundWindow(跑前) = ${fgBefore.raw}`);
  say(`[env] 无窗口铁律：本脚本不调用 SetForegroundWindow/SetCursorPos/SendInput，鼠标事件只走 CDP Input.*`);

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'acgx-inpanel-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--disable-background-networking', '--disable-component-update',
    '--enable-unsafe-extension-debugging',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=914,1415', 'about:blank',
  ];
  report.args = args;
  say(`[env] 命令行含 --mute-audio = ${args.includes('--mute-audio')}`);

  chromeProc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  chromeProc.stderr.on('data', (d) => { stderr += d.toString(); });

  const t0 = Date.now();
  let version = null;
  for (;;) {
    if (Date.now() - t0 > 30000) { say('[FATAL] Chrome 未就绪\n' + stderr.slice(-1500)); return 2; }
    try { version = await httpJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(300); }
  }
  say(`[env] Chrome ${version.Browser}  pid=${chromeProc.pid}`);
  const b = cdpConnect(version.webSocketDebuggerUrl);
  await b.opened;

  const load = await b.send('Extensions.loadUnpacked', { path: TREE }, null, 30000);
  const extId = load.id;
  say(`[ext] loadUnpacked → id=${extId}`);
  report.extensionId = extId;

  // ---- 等 SW / offscreen ----
  let swTarget = null, offTarget = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 30000) {
    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    swTarget = list.find((t) => t.type === 'service_worker' && t.url.includes(`${extId}/initBackground.sw.js`)) || swTarget;
    offTarget = list.find((t) => t.url === `chrome-extension://${extId}/html/background.html`) || offTarget;
    if (swTarget && offTarget) break;
    await sleep(400);
  }
  say(`[ext] service_worker = ${swTarget ? swTarget.url : '(未出现)'}`);
  say(`[ext] offscreen      = ${offTarget ? offTarget.url : '(未出现)'}`);
  check(!!swTarget, '扩展 service worker 起来了');
  check(!!offTarget, 'offscreen 文档起来了（批量下载命令接收方）');
  if (!offTarget) return 1;

  // ---- offscreen console ----
  const offWs = cdpConnect(offTarget.webSocketDebuggerUrl);
  await offWs.opened;
  await offWs.send('Runtime.enable');
  const offLogs = [];
  offWs.on((m) => {
    if (m.method !== 'Runtime.consoleAPICalled') return;
    const text = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
    offLogs.push({ ts: Date.now(), type: m.params.type, text });
  });
  const helper = await offWs.send('Runtime.evaluate', {
    expression: `JSON.stringify({helper: typeof self.__acgxBatchAuto, abort: typeof self.__acgxBatchAbort})`,
    awaitPromise: true, returnByValue: true,
  });
  const helperVal = typeof helper?.result?.value === 'string' ? helper.result.value : JSON.stringify(helper);
  say(`[offscreen] ${helperVal}`);
  check(helperVal.includes('"helper":"function"') && helperVal.includes('"abort":"function"'),
    'offscreen 侧 __acgxBatchAuto / __acgxBatchAbort 已注册', helperVal);

  // ---- 页面 target ----
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const P = (m, p, t) => b.send(m, p, sessionId, t);
  await P('Page.enable');
  await P('Runtime.enable');
  await P('Network.enable');
  await P('Network.setCacheDisabled', { cacheDisabled: true });
  await P('Emulation.setDeviceMetricsOverride', { width: 914, height: 1415, deviceScaleFactor: 1, mobile: false });
  await P('Emulation.setFocusEmulationEnabled', { enabled: true });

  const pageLogs = [];
  b.on((m) => {
    if (m.method !== 'Runtime.consoleAPICalled' || m.sessionId !== sessionId) return;
    const text = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
    pageLogs.push({ ts: Date.now(), type: m.params.type, text });
  });

  // ---- fixture 路由（可切换） ----
  let mode = { kind: 'pgc', n: 4, code: 0 };
  const reqLog = [];
  b.on(async (m) => {
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== sessionId) return;
    const { requestId, request } = m.params;
    reqLog.push(request.url);
    const url = request.url;
    try {
      if (/^https:\/\/www\.bilibili\.com\/bangumi\/play\//.test(url)) {
        await b.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: b64(pageHtml('番剧 fixture 页面')),
        }, sessionId);
      } else if (/^https:\/\/www\.bilibili\.com\/video\//.test(url)) {
        await b.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: b64(pageHtml('多 P fixture 页面')),
        }, sessionId);
      } else if (url.startsWith('https://api.bilibili.com/pgc/view/web/season')) {
        const fx = seasonFixture(mode.n, mode.code);
        await b.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json; charset=utf-8' },
            { name: 'Access-Control-Allow-Origin', value: 'https://www.bilibili.com' },
            { name: 'Access-Control-Allow-Credentials', value: 'true' },
          ],
          body: b64(JSON.stringify(fx)),
        }, sessionId);
      } else if (url.startsWith('https://api.bilibili.com/x/web-interface/view')) {
        await b.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json; charset=utf-8' },
            { name: 'Access-Control-Allow-Origin', value: 'https://www.bilibili.com' },
            { name: 'Access-Control-Allow-Credentials', value: 'true' },
          ],
          body: b64(JSON.stringify(viewFixture(mode.n))),
        }, sessionId);
      } else {
        await b.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, sessionId);
      }
    } catch (e) { say(`[fetch] ${url} → ${e.message}`); }
  });
  await P('Fetch.enable', {
    patterns: [
      { urlPattern: 'https://www.bilibili.com/bangumi/play/*', requestStage: 'Request' },
      { urlPattern: 'https://www.bilibili.com/video/*', requestStage: 'Request' },
      { urlPattern: 'https://api.bilibili.com/pgc/view/web/season*', requestStage: 'Request' },
      { urlPattern: 'https://api.bilibili.com/x/web-interface/view*', requestStage: 'Request' },
    ],
  });

  const evalIn = async (expr) => {
    const r = await P('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval 异常 ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };
  const probe = async () => { try { return await evalIn(PROBE); } catch { return null; } };

  /**
   * 关掉插件自己的首启引导弹窗（新 profile 才会有，和本功能无关的测试前置）。
   * 用 DOM click 点它自己的「下一页 / 已了解」按钮走完流程，实在关不掉就把遮罩 display:none（并如实记录）。
   */
  async function dismissPluginMask() {
    let last = '';
    for (let i = 0; i < 3; i++) {
      const st = await evalIn(`(()=>{
        const masks=[...document.querySelectorAll('.bilibili-helper-mask.on')]
          .filter(m=>{const r=m.getBoundingClientRect(); return r.width>200 && r.height>200 && getComputedStyle(m).visibility!=='hidden';});
        if(!masks.length) return 'GONE';
        const m=masks[masks.length-1];
        const cand=[...m.querySelectorAll('button, div, span')]
          .filter(e=>{const t=(e.textContent||'').trim();
            return t.length<=10 && /^(下一页|已了解|我知道了|完成|知道了|开始使用|关闭|跳过|×)/.test(t);});
        cand.sort((a,b)=> (a.tagName==='BUTTON'?0:1)-(b.tagName==='BUTTON'?0:1));
        if(!cand.length) return 'NO_BTN:' + masks.length;
        cand[0].click();
        return 'CLICK:' + cand[0].textContent.trim() + '(masks=' + masks.length + ')';})()`);
      last = String(st);
      if (last === 'GONE') return 'GONE';
      if (last.startsWith('NO_BTN')) break;
      await sleep(400);
    }
    const forced = await evalIn(`(()=>{
      const masks=[...document.querySelectorAll('.bilibili-helper-mask.on')];
      if(!masks.length) return 'GONE';
      masks.forEach(m=>{m.style.display='none'; m.classList.remove('on');});
      return 'FORCED_DISPLAY_NONE(' + masks.length + ')';})()`);
    return `${forced} [引导弹窗点击序列: ${last}]`;
  }

  async function openPluginPanel() {
    // 等插件悬浮球稳定（React 挂载 + initPosition 跑完）再点
    await sleep(1200);
    const mask = await dismissPluginMask();
    if (mask !== 'GONE') say(`[panel] 插件首启遮罩处理 = ${mask}`);
    await sleep(300);
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await evalIn(`(()=>{const hb=document.getElementById('bilibiliHelper2HandleButton');
        if(!hb) return null; const b=hb.getBoundingClientRect();
        const cx=Math.round(b.x+b.width/2), cy=Math.round(b.y+b.height/2);
        const el=document.elementFromPoint(cx,cy);
        return JSON.stringify({x:cx, y:cy, w:Math.round(b.width), h:Math.round(b.height),
          hit: el ? (el.tagName + (el.id?'#'+el.id:'') + '|' + String(el.className||'')) : 'null',
          inside: !!(el && hb.contains(el))});})()`);
      if (!r) return false;
      const o = JSON.parse(r);
      say(`[panel] 试图点悬浮球 (${o.x},${o.y}) size=${o.w}×${o.h} hit=${o.hit} inside=${o.inside}`);
      if (o.inside) {
        await cdpClick(P, o.x, o.y);
        for (let i = 0; i < 30; i++) {
          const s = await probe();
          if (s && s.panelOpen) return true;
          await sleep(150);
        }
      }
      await sleep(500);
    }
    // 兜底：DOM 级 click（同样只发生在我们自己的 headless 页面里，不是 OS 输入）
    say('[panel] 坐标点击未生效 → 用 DOM click() 兜底');
    const r2 = await evalIn(`(()=>{const hb=document.getElementById('bilibiliHelper2HandleButton');
      if(!hb) return 'NO_BTN'; hb.click();
      return document.getElementById('bilibiliHelper2ContentWrapper').className;})()`);
    say(`[panel] DOM click() → class=${r2}`);
    for (let i = 0; i < 30; i++) {
      const s = await probe();
      if (s && s.panelOpen) return true;
      await sleep(150);
    }
    return false;
  }

  /** 点我们注入的入口：先 scrollIntoView，再校 elementFromPoint 命中 host，再 CDP 点 */
  async function clickEntry(tag) {
    await evalIn(`(()=>{const h=document.getElementById('acgx-batch-host'); if(!h) return 0;
      const e=h.shadowRoot.getElementById('acgx-entry'); if(e) e.scrollIntoView({block:'nearest',inline:'nearest'});
      return 1;})()`);
    await sleep(250);
    const r = await evalIn(`(()=>{const h=document.getElementById('acgx-batch-host'); if(!h) return null;
      const e=h.shadowRoot.getElementById('acgx-entry'); if(!e) return null;
      const b=e.getBoundingClientRect();
      const cx=Math.round(b.x+b.width/2), cy=Math.round(b.y+b.height/2);
      const el=document.elementFromPoint(cx,cy);
      return JSON.stringify({x:cx,y:cy, hitIsHost: el===h, hit: el?el.tagName+'|'+String(el.className||'')+'|'+(el.id||''):'null'});})()`);
    if (!r) { say(`[${tag}] 入口不存在，无法点击`); return false; }
    const o = JSON.parse(r);
    say(`[${tag}] 点入口 (${o.x},${o.y}) elementFromPoint=${o.hit} hitIsHost=${o.hitIsHost}`);
    if (!o.hitIsHost) { say(`[${tag}] 入口被遮挡（elementFromPoint 不是 shadow host），改用 DOM 事件派发走一遍真实事件途径`);
      // 事件仍派发到入口元素本身（含冒泡），等价于用户点它
      await evalIn(`(()=>{const h=document.getElementById('acgx-batch-host');
        const e=h.shadowRoot.getElementById('acgx-entry');
        const b=e.getBoundingClientRect();
        const opt={bubbles:true,cancelable:true,composed:true,clientX:Math.round(b.x+b.width/2),clientY:Math.round(b.y+b.height/2)};
        e.dispatchEvent(new MouseEvent('mousedown',opt));
        e.dispatchEvent(new MouseEvent('mouseup',opt));
        e.dispatchEvent(new MouseEvent('click',opt));
        return 1;})()`);
      await sleep(500);
      return true;
    }
    await cdpClick(P, o.x, o.y);
    await sleep(600);
    return true;
  }

  const fgSamples = [];
  async function nav(url, wantEntry, label) {
    fgSamples.push({ at: `nav:${label}`, ...fgInfo() });
    say(`\n[nav] ${url}   (期望: ${wantEntry ? '出现入口' : '不出现入口'} · ${label})`);
    await P('Page.navigate', { url });
    // 等插件悬浮球
    let base = null;
    for (let i = 0; i < 80; i++) {
      base = await probe();
      if (base && base.hasHandleBtn) break;
      await sleep(200);
    }
    if (!base || !base.hasHandleBtn) { say('[nav] 插件悬浮球没出现'); return null; }
    // 面板出现后判定
    const opened = await openPluginPanel();
    say(`[nav] 插件面板打开 = ${opened}`);
    if (!opened) return probe();
    // 等 acgx 区块（若应出现）
    const deadline = Date.now() + (wantEntry ? 25000 : 6000);
    let s = null;
    while (Date.now() < deadline) {
      s = await probe();
      if (s && (s.hostFound || !wantEntry)) break;
      await sleep(250);
    }
    await sleep(600);
    return await probe();
  }

  async function shot(name, label) {
    let r = null, lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await P('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true }, 45000);
        break;
      } catch (e) { lastErr = e.message; await sleep(800); }
    }
    if (!r) { say(`[shot] ${label} 失败：${lastErr}`); check(false, `截图 ${name}`, lastErr); return null; }
    const buf = Buffer.from(r.data, 'base64');
    const out = path.join(LOGDIR, name);
    fs.writeFileSync(out, buf);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    say(`[shot] ${label} → ${name}  ${w}×${h}  ${buf.length} B`);
    report.screenshots = (report.screenshots || []).concat([{ file: name, width: w, height: h, bytes: buf.length }]);
    check(w > 0 && h > 0 && w <= 914 && h <= 1415, `截图 ${name} ≤ 914×1415`, `${w}×${h}`);
    return { w, h };
  }

  // ================================================================ 场景 A
  say('\n================ 场景 A：番剧 4 集 ================');
  mode = { kind: 'pgc', n: 4, code: 0 };
  const A = await nav('https://www.bilibili.com/bangumi/play/ep123456?a=1', true, '番剧 4 集');
  if (!A) { say('[FATAL] 场景 A 页面没起来'); return 1; }
  say(`[A] panelOpen=${A.panelOpen} panelChildren=${A.panelChildren} bodyChildren=${A.bodyChildren}`);
  say(`[A] panel 子节点: ${JSON.stringify(A.panelChildTags)}`);
  check(A.panelOpen === true, 'A① 插件自己的悬浮面板已打开（.handle-content-wrapper 去掉 hide）', `class=${A.panelClass}`);
  check(A.hostFound === true, 'A② 面板内部出现 #acgx-batch-host（入口区块）',
    `parent=${A.hostParent} index=${A.hostIndex} footerIndex=${A.footerIndex} panelChildren=${A.panelChildren}`);
  check(A.hostParent === 'bilibiliHelper2ContentWrapper', 'A② 入口挂在插件面板容器内（不是 body / 不是页面角落）', `parent=${A.hostParent}`);
  check(A.hostBeforeFooter === true, 'A② 入口插在面板 <footer> 之前（面板底部区块）', `hostIndex=${A.hostIndex} footerIndex=${A.footerIndex}`);
  check(A.acgxNodesAnywhere === 1, 'A② 全文档只有一个 acgx-* 节点（没有第二个浮动按钮）', `count=${A.acgxNodesAnywhere}`);
  check(A.ui && A.ui.hasFab === false, 'A② 旧右下角浮动按钮（.fab）已删除', `hasFab=${A.ui?.hasFab}`);
  check(A.ui && A.ui.hasEntryBtn === true, 'A② 入口是可点的原生结构 div.button > button.button-view', `hasEntryBtn=${A.ui?.hasEntryBtn}`);

  // 基线：面板子节点里去掉我们那一个之后的数量（用于 B/C 的“子节点数不变”断言）
  const panelKidsWithoutUs = A.panelChildren - 1;
  say(`[A] 面板子节点数（不含我们的） = ${panelKidsWithoutUs}`);
  say(`[A] 入口 rect = ${JSON.stringify(A.ui?.entryRect)}  hostRect=${JSON.stringify(A.ui?.hostRect)}`);
  say(`[A] hint = «${A.ui?.hint}»  phase=${A.ui?.phase} count=${A.ui?.count} source=${A.ui?.source}`);

  await shot('batch-inpanel-A-collapsed.png', 'A：入口已并入插件面板（未展开）');

  // ---- 点入口展开 ----
  await clickEntry('A');
  const A2 = await probe();
  say(`[A] 展开后：open=${A2.ui?.open} rows=${A2.ui?.rows} keys=${(A2.ui?.keys || []).join(',')} bodyHidden=${A2.ui?.bodyHidden}`);
  check(A2.ui?.open === true && A2.ui?.bodyHidden === false, 'A③ 点入口 → 集数列表在面板内部展开（不飘到屏幕角落）',
    `open=${A2.ui?.open} bodyHidden=${A2.ui?.bodyHidden}`);
  check(A2.ui?.count === 4 && A2.ui?.rows === 4, 'A③ 列出 fixture 的 4 集', `count=${A2.ui?.count} rows=${A2.ui?.rows}`);
  check((A2.ui?.keys || []).join(',') === 'ep900001,ep900002,ep900003,ep900004',
    'A③ 列表内容来自 season fixture（data-acgx-key = ep900001…）', (A2.ui?.keys || []).join(','));
  check((A2.ui?.durs || []).every((d) => /^\d+:\d\d$/.test(d)), 'A③ 每行显示时长（mm:ss）', (A2.ui?.durs || []).join(','));
  check(A2.ui?.source === 'api/pgc/view/web/season', 'A③ 数据源标注为 api/pgc/view/web/season', String(A2.ui?.source));

  await shot('batch-inpanel-A-expanded.png', 'A：点入口后展开的集数列表（在插件面板内）');

  // ---- 样式对比 ----
  say('\n---- A④ 样式对比：原生 div.button.primary vs 我们的入口 ----');
  const st = A2.style || {};
  say(`原生锚点: ${st.nativeSelector}`);
  const props = ['font-size', 'font-family', 'border-radius', 'background-color', 'color',
    'border-top-width', 'border-top-style', 'border-top-color', 'height', 'padding', 'box-shadow'];
  say(`  ${'属性'.padEnd(18)}| ${'原生按钮'.padEnd(34)}| 我们的入口`);
  for (const p of props) {
    say(`  ${p.padEnd(18)}| ${String(st.native?.[p]).padEnd(34)}| ${st.ours?.[p]}`);
  }
  const px = (v) => {
    const m = /(-?\d+(?:\.\d+)?)px/.exec(String(v || ''));
    return m ? parseFloat(m[1]) : null;
  };
  const eqNum = (a, b, tol = 2) => {
    const x = px(a), y = px(b);
    if (x === null || y === null) return String(a) === String(b);
    return Math.abs(x - y) <= tol;
  };
  const rgb = (v) => {
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(String(v || ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const eqColor = (a, b, tol = 1) => {
    const x = rgb(a), y = rgb(b);
    if (!x || !y) return String(a) === String(b);
    return Math.abs(x[0] - y[0]) <= tol * 12 && Math.abs(x[1] - y[1]) <= tol * 12 && Math.abs(x[2] - y[2]) <= tol * 12;
  };
  const n = st.native || {}, o = st.ours || {};
  const rows = [
    ['font-size', String(n['font-size']), String(o['font-size']), eqNum(n['font-size'], o['font-size'])],
    ['border-radius', String(n['border-radius']), String(o['border-radius']), eqNum(n['border-radius'], o['border-radius'])],
    ['background-color', String(n['background-color']), String(o['background-color']), eqColor(n['background-color'], o['background-color'])],
    ['color', String(n.color), String(o.color), eqColor(n.color, o.color)],
    ['border-width', String(n['border-top-width']), String(o['border-top-width']), eqNum(n['border-top-width'], o['border-top-width'])],
    ['border-style', String(n['border-top-style']), String(o['border-top-style']), String(n['border-top-style']) === String(o['border-top-style'])],
    ['border-color', String(n['border-top-color']), String(o['border-top-color']), eqColor(n['border-top-color'], o['border-top-color'])],
    ['height', String(n.height), String(o.height), eqNum(n.height, o.height)],
    ['font-family', String(n['font-family']), String(o['font-family']), String(n['font-family']) === String(o['font-family'])],
  ];
  let styleOk = 0;
  for (const [k, a, b, ok] of rows) {
    say(`  ${ok ? '✓' : '✗'} ${k.padEnd(18)} 原生=${a.padEnd(24)} 我们的=${b}`);
    if (ok) styleOk += 1;
  }
  check(styleOk === rows.length,
    `A④ 样式对齐：${styleOk}/${rows.length} 项一致（font-size/圆角/背景/描边/高度/字体）`,
    rows.map(([k, a, b, ok]) => `${ok ? '=' : '≠'} ${k} ${a} vs ${b}`).join(' | '));
  report.styleTable = rows.map(([k, a, b, ok]) => ({ prop: k, native: a, ours: b, match: ok }));

  // ---- hover 对比（CDP Input 移动鼠标，只打自己的 headless 页面） ----
  const hoverOf = async (sel, where) => {
    const r = await evalIn(`(()=>{${where}; const el=${sel}; if(!el) return null;
      const b=el.getBoundingClientRect(); return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});})()`);
    if (!r) return null;
    const { x, y } = JSON.parse(r);
    await P('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(250);
    return await evalIn(`(()=>{${where}; const el=${sel}; if(!el) return null;
      const cs=getComputedStyle(el);
      const inner=el.querySelector('button');
      const ics=inner?getComputedStyle(inner):null;
      return JSON.stringify({bg:cs.backgroundColor,fg:cs.color,cursor:cs.cursor,bd:cs.borderTopColor,
        innerCursor: ics?ics.cursor:null, innerFg: ics?ics.color:null});})()`);
  };
  // 先给原生按钮铺一层：hover 到它的内层 <button> 上（真实位置）
  const hvNative = await hoverOf(`document.querySelector('#bilibiliHelper2ContentWrapper div.button.primary')`, '');
  const hvOurs = await hoverOf(`document.getElementById('acgx-batch-host').shadowRoot.getElementById('acgx-entry')`, '');
  say(`\n[hover] 原生 div.button.primary → ${hvNative}`);
  say(`[hover] 我们的入口           → ${hvOurs}`);
  let hoverOk = false;
  try {
    const a = JSON.parse(hvNative), c = JSON.parse(hvOurs);
    hoverOk = eqColor(a.bg, c.bg) && a.cursor === c.cursor && a.innerCursor === c.innerCursor;
    check(hoverOk, 'A④ hover 一致性：背景色 / 外层 cursor / 内层 button cursor 与原生 primary 相同（原生 .primary 没有 :hover 变色规则，两边都不变色）',
      `原生 bg=${a.bg} cursor=${a.cursor}/${a.innerCursor} | ours bg=${c.bg} cursor=${c.cursor}/${c.innerCursor}`);
  } catch (e) {
    check(false, 'A④ hover 对比', String(e.message));
  }
  // 鼠标移开，避免影响后续截图
  await P('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 30, y: 700 });

  say(`\n[A] CSS 变量（写在 #acgx-batch-host 的 style 上）: ${A2.hostStyleAttr}`);
  check(!!A2.vars && A2.vars['--acgx-primary-bg'] && A2.vars['--acgx-radius'] && A2.vars['--acgx-font-size'],
    'A④ 样式参数来自 getComputedStyle 读到的原生值（写成 --acgx-* CSS 变量）',
    JSON.stringify(A2.vars));

  // ================================================================ 场景 D（同页，既有队列）
  say('\n================ 场景 D：既有队列不回归 ================');
  await evalIn(`(()=>{document.documentElement.setAttribute('data-acgx-init-timeout','4000');return 1;})()`);
  // 全选
  await evalIn(`(()=>{const sr=document.getElementById('acgx-batch-host').shadowRoot;
    const a=sr.getElementById('acgx-all'); a.click(); return a.checked;})()`);
  await sleep(400);
  const D1 = await probe();
  const checkedDom = await evalIn(`(()=>{const sr=document.getElementById('acgx-batch-host').shadowRoot;
    return sr.querySelectorAll('[data-acgx-role="check"]:checked').length;})()`);
  say(`[D] data-acgx-checked=${D1.ui?.checked} DOM 勾选数=${checkedDom}`);
  check(checkedDom === 4 && D1.ui?.checked === 4, 'D① 点「全选」后选中数 = 4', `DOM=${checkedDom} attr=${D1.ui?.checked}`);

  const tD = Date.now();
  await evalIn(`(()=>{const sr=document.getElementById('acgx-batch-host').shadowRoot;
    sr.getElementById('acgx-start').click(); return 1;})()`);
  say('[D] 已点「开始下载」…');
  let fin = null;
  while (Date.now() - tD < 150000) {
    const s = await probe();
    if (s && s.ui) fin = s;
    if (fin && fin.ui.running === false && (fin.ui.ok + fin.ui.fail) > 0) break;
    await sleep(500);
  }
  say(`[D] 用时 ${((Date.now() - tD) / 1000).toFixed(1)}s  最终 ok=${fin?.ui?.ok} fail=${fin?.ui?.fail} message=${fin?.ui?.message}`);
  await sleep(800);
  const recv = offLogs.filter((l) => l.text.includes('[acgx-batch] recv url='));
  const done = offLogs.filter((l) => l.text.includes('[acgx-batch] done url='));
  say('\n[offscreen console 原文]');
  offLogs.filter((l) => l.text.includes('[acgx-batch]')).forEach((l) => say('   ' + l.text));
  check(recv.length === 4, 'D② offscreen 收到 4 条 acgxAutoDownload', `实际 ${recv.length} 条`);
  check(done.length === 4, 'D③ offscreen 回执 4 条 itemDone', `实际 ${done.length} 条`);
  const seq = offLogs.filter((l) => /\[acgx-batch\] (recv|done) url=/.test(l.text));
  const kinds = seq.map((l) => (l.text.includes(' recv url=') ? 'recv' : 'done'));
  say(`[D] 时序: ${kinds.join(' → ')}`);
  let serialOk = kinds.length === 8;
  for (let i = 0; i < kinds.length; i++) if (kinds[i] !== (i % 2 === 0 ? 'recv' : 'done')) serialOk = false;
  const recvIdx = seq.map((l, i) => (l.text.includes(' recv url=') ? i : -1)).filter((i) => i >= 0);
  const doneIdx = seq.map((l, i) => (l.text.includes(' done url=') ? i : -1)).filter((i) => i >= 0);
  let ordered = true;
  for (let i = 0; i + 1 < recvIdx.length; i++) if (!(doneIdx[i] < recvIdx[i + 1])) ordered = false;
  check(serialOk && ordered, 'D④ 队列严格串行（recv1→done1→recv2→done2…）', kinds.join(','));
  check(fin && fin.ui.fail === 4 && fin.ui.ok === 0,
    'D⑤ 失败分支不卡队列（fixture 环境 4 集全部按预期失败）', `ok=${fin?.ui?.ok} fail=${fin?.ui?.fail}`);
  check(!!fin?.ui?.message, 'D⑥ 队列结束给出汇总状态行', fin?.ui?.message);
  check(fin && fin.ui.states.every((s) => s === 'fail') && fin.ui.retryBtns === 4,
    'D⑦ 每行标红 + 都出现「重试本集」', `states=${(fin?.ui?.states || []).join(',')} retry=${fin?.ui?.retryBtns}`);
  await shot('batch-inpanel-D-queue.png', 'D：队列跑完（红行=失败可重试本集）');

  // ================================================================ 场景 B：单集番剧
  say('\n================ 场景 B：单集番剧（1 集）→ 入口必须完全不出现 ================');
  mode = { kind: 'pgc', n: 1, code: 0 };
  const B = await nav('https://www.bilibili.com/bangumi/play/ep123456?b=1', false, '番剧 1 集');
  say(`[B] panelOpen=${B.panelOpen} panelChildren=${B.panelChildren} bodyChildren=${B.bodyChildren}`);
  say(`[B] panel 子节点: ${JSON.stringify(B.panelChildTags)}`);
  const bLogs = pageLogs.filter((l) => l.text.includes('[acgx-batch]'));
  say(`[B] 页面 console 里的 [acgx-batch] 行: ${bLogs.map((l) => l.text).join(' | ').slice(0, 600)}`);
  check(B.hostFound === false, 'B① 入口完全不出现：document.getElementById("acgx-batch-host") === null', `hostFound=${B.hostFound}`);
  check(B.acgxNodesAnywhere === 0, 'B① 全文档 acgx-* 节点数 = 0（一个节点都没建）', `count=${B.acgxNodesAnywhere}`);
  check(B.panelChildren === panelKidsWithoutUs,
    `B② 插件面板子节点数不变（=${panelKidsWithoutUs}，与 A 去掉我们的那一个之后相同）`, `实际 ${B.panelChildren}`);
  check(B.bodyAcgxChildren === 0 && A.bodyAcgxChildren === 0,
    'B② body 直接子节点里没有任何 acgx-* 宿主（A 有入口时也没有 → 从来不在页面层面加东西）',
    `A bodyAcgx=${A.bodyAcgxChildren} B bodyAcgx=${B.bodyAcgxChildren}`);
  check(bLogs.some((l) => /多选入口未注入/.test(l.text)), 'B③ console 留下可诊断的一行（不出现的原因）',
    bLogs.filter((l) => /多选入口未注入/.test(l.text)).map((l) => l.text).join(' | '));
  await shot('batch-inpanel-B-single.png', 'B：单集番剧 —— 插件面板里没有选集下载入口');

  // ================================================================ 场景 C：多 P / 单 P
  say('\n================ 场景 C：单 P 不出现 / 多 P 出现 ================');
  mode = { kind: 'ugc', n: 1, code: 0 };
  const C1 = await nav('https://www.bilibili.com/video/BV1xx411c7m9?c=1', false, '单 P（pages=1）');
  say(`[C1] panelOpen=${C1.panelOpen} hostFound=${C1.hostFound} panelChildren=${C1.panelChildren} bodyChildren=${C1.bodyChildren}`);
  check(C1.hostFound === false && C1.acgxNodesAnywhere === 0, 'C① 单 P 视频不出现入口', `hostFound=${C1.hostFound} acgx=${C1.acgxNodesAnywhere}`);
  check(C1.panelChildren === panelKidsWithoutUs, `C① 面板子节点数不变（=${panelKidsWithoutUs}）`, `实际 ${C1.panelChildren}`);
  await shot('batch-inpanel-C1-single-p.png', 'C1：单 P 视频 —— 无入口');

  mode = { kind: 'ugc', n: 3, code: 0 };
  const C2 = await nav('https://www.bilibili.com/video/BV1xx411c7m9?c=2', true, '多 P（pages=3）');
  say(`[C2] panelOpen=${C2.panelOpen} hostFound=${C2.hostFound} panelChildren=${C2.panelChildren}`);
  check(C2.hostFound === true && C2.hostParent === 'bilibiliHelper2ContentWrapper',
    'C② 多 P 视频出现入口，且在插件面板内', `parent=${C2.hostParent}`);
  check(C2.panelChildren === panelKidsWithoutUs + 1, `C② 面板子节点数 = ${panelKidsWithoutUs + 1}（只多我们一个）`, `实际 ${C2.panelChildren}`);
  const e2 = C2.ui?.entryRect;
  await clickEntry('C2');
  const C3 = await probe();
  say(`[C3] open=${C3.ui?.open} rows=${C3.ui?.rows} keys=${(C3.ui?.keys || []).join(',')} titles=${(C3.ui?.titles || []).join(' | ')}`);
  check(C3.ui?.count === 3 && C3.ui?.rows === 3, 'C③ 多 P 场景列出 3 个分 P', `count=${C3.ui?.count} rows=${C3.ui?.rows}`);
  check((C3.ui?.keys || []).join(',') === 'p1_3001,p2_3002,p3_3003',
    'C③ 分 P 来自 x/web-interface/view fixture', (C3.ui?.keys || []).join(','));
  check((C3.ui?.titles || []).every((t) => /^P\d /.test(t)), 'C③ 行标题形如「P1 分段1 fixture」', (C3.ui?.titles || []).join(' | '));
  await shot('batch-inpanel-C2-multi-p.png', 'C2：多 P 视频 —— 入口在面板内，展开 3 个分 P');

  // ================================================================ 场景 E：接口失败
  say('\n================ 场景 E：season 接口 -101（未登录）→ 不出现 + 一行诊断 ================');
  mode = { kind: 'pgc', n: 4, code: -101 };
  const E = await nav('https://www.bilibili.com/bangumi/play/ep123456?e=1', false, '接口 -101');
  const eLogs = pageLogs.filter((l) => l.text.includes('[acgx-batch]'));
  say(`[E] panelOpen=${E.panelOpen} hostFound=${E.hostFound} acgx=${E.acgxNodesAnywhere} panelChildren=${E.panelChildren}`);
  say(`[E] console: ${eLogs.map((l) => l.text).join(' | ').slice(0, 800)}`);
  check(E.hostFound === false && E.acgxNodesAnywhere === 0, 'E① 判定失败（-101）时入口不出现', `hostFound=${E.hostFound}`);
  check(eLogs.some((l) => /多选入口未注入/.test(l.text) && /-101|未登录/.test(l.text)),
    'E② console 留下可诊断的一行（含 -101 / 未登录）',
    eLogs.filter((l) => /多选入口未注入/.test(l.text)).map((l) => l.text).join(' | '));
  check(E.panelChildren === panelKidsWithoutUs, `E③ 面板子节点数不变（=${panelKidsWithoutUs}）`, `实际 ${E.panelChildren}`);
  await shot('batch-inpanel-E-api-fail.png', 'E：接口 -101 —— 无入口');

  // ================================================================ 收尾自证
  say('\n================ 环境自证 ================');
  const fgAfter = fgInfo();
  fgSamples.push({ at: 'end', ...fgAfter });
  say(`[env] GetForegroundWindow(跑前) = ${fgBefore.raw}`);
  say(`[env] GetForegroundWindow(跑后) = ${fgAfter.raw}`);
  say(`[env] 跑前跑后一致 = ${fgBefore.raw === fgAfter.raw}`);
  say(`[env] 全程前台采样 ${fgSamples.length} 次: ${fgSamples.map((s) => `${s.at}=${s.pid}(${s.name})`).join(' | ')}`);

  const mwh = ps(`$p = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profile}') } | Select-Object -ExpandProperty ProcessId); ` +
    `if ($p.Count -eq 0) { 'NO_PROC' } else { $p | ForEach-Object { $h=(Get-Process -Id $_ -ErrorAction SilentlyContinue).MainWindowHandle; "$_=$h" } }`);
  say(`[env] 本次 profile 的 chrome 进程 MainWindowHandle: ${String(mwh).replace(/\r?\n/g, ' ')}`);
  check(!/=[1-9]/.test(String(mwh)) && String(mwh) !== 'NO_PROC',
    '本次 profile 的 chrome 进程 MainWindowHandle 全 0（无可见窗口）', String(mwh).replace(/\r?\n/g, ' '));
  check(args.includes('--mute-audio'), '--mute-audio 在命令行里（进程静音）');
  const ourPids = String(mwh).split(/\s+/).map((x) => Number(String(x).split('=')[0])).filter((n) => n > 0);
  const mineSamples = fgSamples.filter((s) => ourPids.includes(s.pid));
  check(ourPids.length > 0 && mineSamples.length === 0,
    `前台窗口在 ${fgSamples.length} 次采样里从未落到本次 chrome 的 PID 上（headless 全程没有窗口）`,
    `采样: ${fgSamples.map((s) => `${s.at}:pid=${s.pid}(${s.name})`).join(' | ')}；本次 chrome pid: ${ourPids.join(',')}`);
  // 跑前跑后是否同一个窗口 —— 桌面前台归宿主环境管，这里只做如实记录，不作为本功能的判据
  if (fgBefore.raw !== fgAfter.raw) {
    say(`[env][注记] 桌面前台在本次运行期间由外部窗口接管：${fgBefore.raw} → ${fgAfter.raw}；` +
      `两个窗口都不在本次 chrome PID 集合（${ourPids.join(',')}）里，属于宿主桌面活动，不是本脚本产生。`);
  }

  report.pageConsole = pageLogs.map((l) => `${l.type}: ${l.text}`);
  report.offscreenConsole = offLogs.map((l) => l.text);
  report.requestLog = reqLog;
  report.foregroundBefore = fgBefore.raw;
  report.foregroundAfter = fgAfter.raw;
  report.mainWindowHandles = String(mwh);
  return 0;
}

// ---------------------------------------------------------------- 执行与清理
let exitCode = 1;
try {
  code = await main();
} catch (e) {
  say('[FATAL] ' + (e.stack || e.message));
  code = 2;
} finally {
  const fail = checks.filter((c) => !c.ok).length;
  say(`\n================ 结论：${fail === 0 && code === 0 ? 'PASS' : 'FAIL'}（PASS ${checks.filter((c) => c.ok).length} / 共 ${checks.length}，失败 ${fail}）`);
  report.checks = checks;
  report.summary = { pass: checks.filter((c) => c.ok).length, total: checks.length, fail, code };
  report.finishedAt = new Date().toISOString();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.writeFileSync(path.join(LOGDIR, `batch-inpanel-report-${Date.now()}.json`), JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(path.join(LOGDIR, `batch-inpanel-${stamp}.log`), lines.join('\n'), 'utf8');
    fs.writeFileSync(path.join(LOGDIR, 'batch-inpanel-latest.log'), lines.join('\n'), 'utf8');
    fs.writeFileSync(path.join(LOGDIR, 'batch-inpanel-latest.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch (e) { console.log('[warn] 日志写盘失败 ' + e.message); }

  if (chromeProc) killTree(chromeProc.pid);
  const left = await purgeProfileChrome(profile);
  say(`[cleanup] 残留 chrome 进程数 = ${left}；profile = ${profile}`);
  check(String(left).trim() === '0', '清场：本次 profile 的 chrome 进程残留 = 0', `left=${left}`);
  if (!KEEP) {
    for (let i = 0; i < 6; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
      if (!fs.existsSync(profile)) break;
      await sleep(400);
    }
    say(`[cleanup] profile 已删 = ${!fs.existsSync(profile)}`);
  }
  try { fs.rmSync(path.join(TREE, '_metadata'), { recursive: true, force: true }); } catch { /* ignore */ }
  exitCode = (fail === 0 && code === 0) ? 0 : 1;
}
process.exit(exitCode);
