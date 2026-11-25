#!/usr/bin/env node
/**
 * panel-recon.mjs —— 侦察 ACGhelper 自己那个悬浮下载面板（headless Chrome + CDP）
 *
 * 做什么：
 *   1. headless Chrome（--headless=new --mute-audio --enable-unsafe-extension-debugging
 *      --remote-debugging-port=<port> --user-data-dir=<temp>）+ CDP Extensions.loadUnpacked
 *      加载指定扩展树（默认 build/recon-r3 = r3 成品树副本，绝不碰 output/）
 *   2. Fetch.fulfillRequest 把 document / x/web-interface/view / pgc/view/web/season 全喂 fixture
 *      —— 一条真实网络请求都不发
 *   3. 打开视频页 → 找插件悬浮球 #bilibiliHelper2HandleButtonWrapper → 点它
 *      → dump #bilibiliHelper2ContentWrapper 的 DOM 树 / class / 计算样式 / CSS 变量
 *   4. 截图（Page.captureScreenshot，914×1415）
 *
 * 用法: node tools/panel-recon.mjs [--tree=build/recon-r3] [--port=9471] [--keep]
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
const TREE = path.resolve(ROOT, flag('tree') || path.join('build', 'recon-r3'));
const PORT = Number(flag('port') || 9471);
const LOGDIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

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
/** 端口可能有 TIME_WAIT 残留：重试到 8s，仍不通就换端口 */
async function waitPortFree(port) {
  for (let i = 0; i < 16; i++) {
    if (await portFree(port)) return true;
    await sleep(500);
  }
  return false;
}
function freePortFrom(base) {
  for (let p = base; p < base + 40; p++) {
    // 只做粗筛；真正 bind 由 waitPortFree 复核
    return p;
  }
  return base;
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
const FG_PS = "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int pid);'; " +
  "$h=[W.U]::GetForegroundWindow(); $x=0; [void][W.U]::GetWindowThreadProcessId($h,[ref]$x); " +
  "$p=Get-Process -Id $x -ErrorAction SilentlyContinue; \"$($h.ToInt64())|$x|$($p.ProcessName)\"";
function fgInfo() {
  const raw = ps(FG_PS);
  const [hwnd, pid, name] = String(raw).split('|');
  return { raw, hwnd, pid: Number(pid) || 0, name: name || '' };
}

// ---------------------------------------------------------------- fixture
function viewFixture(n) {
  const pages = [];
  for (let i = 1; i <= n; i++) {
    pages.push({ cid: 3000 + i, page: i, from: 'vupload', part: `分段${i} fixture`, duration: 600 + i, width: 1920, height: 1080 });
  }
  return {
    code: 0, message: '0', ttl: 1,
    data: {
      bvid: 'BV1xx411c7m9', aid: 990099, title: 'ACGN 多 P fixture 视频', videos: n, pages,
      pic: 'https://i0.hdslb.com/bfs/fixture.jpg',
      owner: { mid: 1, name: 'fixture-up' },
      stat: { view: 1000, danmaku: 10, reply: 1, favorite: 2, coin: 3, share: 4, like: 5 },
      duration: 1800, cid: 3001, desc: 'fixture', pubdate: 1700000000,
    },
  };
}
const PAGE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>ACGhelper 面板侦察 fixture</title></head><body>
<div id="app"><h1 id="fixture-h1">ACGhelper 面板侦察 · fixture 页面</h1>
<div id="viewbox_report"><h1>ACGN 多 P fixture 视频</h1></div>
</div></body></html>`;

const DUMP_JS = String.raw`(() => {
  const out = { found: {}, tree: [], raw: {} };
  const HW = document.getElementById('bilibiliHelper2HandleButtonWrapper');
  const HB = document.getElementById('bilibiliHelper2HandleButton');
  const CW = document.getElementById('bilibiliHelper2ContentWrapper');
  out.found = {
    handleWrapper: !!HW, handleButton: !!HB, contentWrapper: !!CW,
    contentClass: CW ? CW.className : null,
    handleWrapperClass: HW ? HW.className : null,
    bodyChildren: [...document.body.children].map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '')),
  };
  const pick = (el, props) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const o = {};
    for (const p of props) o[p] = cs.getPropertyValue(p);
    return o;
  };
  const COMMON = ['display','position','top','left','right','bottom','width','height','min-width','max-width','min-height','max-height',
    'padding','margin','background-color','background-image','color','font-family','font-size','font-weight','line-height',
    'border','border-radius','box-shadow','opacity','visibility','overflow','z-index','gap','align-items','justify-content','transform','text-align'];
  out.styles = {
    html: pick(document.documentElement, COMMON),
    body: pick(document.body, COMMON),
    handleWrapper: pick(HW, COMMON),
    handleButton: pick(HB, COMMON),
    contentWrapper: pick(CW, COMMON),
    footer: CW ? pick(CW.querySelector('footer'), COMMON) : null,
    footerSpans: CW ? [...CW.querySelectorAll('footer span')].map(s => ({ text: s.textContent, cls: s.className, cs: pick(s, COMMON) })) : [],
    newDownloader: CW ? pick(CW.querySelector('.new-downloader'), COMMON) : null,
    title: CW ? pick(CW.querySelector('.new-downloader .title, .bilibili-helper-video-download-title'), COMMON) : null,
    buttons: CW ? [...CW.querySelectorAll('button')].slice(0, 12).map(b => ({
      text: (b.textContent || '').trim().slice(0, 24),
      cls: typeof b.className === 'string' ? b.className : '(obj)',
      html: b.outerHTML.slice(0, 300),
      cs: pick(b, COMMON.concat(['border-color','border-width','border-style'])),
    })) : [],
    inputs: CW ? [...CW.querySelectorAll('input,select')].slice(0, 8).map(i => ({
      tag: i.tagName, type: i.type, cs: pick(i, COMMON.concat(['border-color','appearance'])),
    })) : [],
    // 原生按钮的“可视层”其实是外层 div.button（primary / border / 无变体）
    buttonWrappers: CW ? [...CW.querySelectorAll('div.button')].slice(0, 14).map(d => ({
      text: (d.textContent || '').trim().slice(0, 24),
      cls: typeof d.className === 'string' ? d.className : '(obj)',
      rect: (() => { const r = d.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; })(),
      cs: pick(d, COMMON.concat(['border-color','border-width','border-style','transition'])),
    })) : [],
    // 顶部按钮行容器 / 各区块容器
    sections: CW ? [...CW.children].map(d => ({
      tag: d.tagName.toLowerCase(),
      id: d.id || null,
      cls: typeof d.className === 'string' ? d.className : '(obj)',
      rect: (() => { const r = d.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; })(),
      cs: pick(d, ['display','margin','padding','width','height','background-color','border-radius','border','box-shadow','font-size','color']),
    })) : [],
  };
  // ---------- CSSOM：把插件自己写死的规则抽出来（styleSheets 里 styled-components 注入的）
  const rules = [];
  const grab = (sheet) => {
    let rs;
    try { rs = sheet.cssRules; } catch { return; }
    if (!rs) return;
    for (const r of rs) {
      if (r.type === 1) {
        const sel = r.selectorText || '';
        if (/\.button|handle-content-wrapper|bilibili-helper-video-download-title|footer|primary|border|hover|new-downloader|\.title/.test(sel)) {
          rules.push({ sel, css: r.style.cssText, src: (sheet.href || '(inline styled-components)') });
        }
      } else if (r.type === 4) {
        try { grab(r.styleSheet); } catch { /* ignore */ }
      } else if (r.type === 5) {
        rules.push({ sel: '@font-face', css: r.style.cssText, src: '(font-face)' });
      }
    }
  };
  for (const s of document.styleSheets) grab(s);
  out.cssomRules = rules;
  // 字体：面板实际用的字体是否来自扩展注入的 @font-face
  out.fonts = { contentWrapperFontFamily: CW ? getComputedStyle(CW).fontFamily : null };

  // CSS 变量（在 contentWrapper / html 上解析后的实际值）
  const varsOf = (el) => {
    if (!el) return null;
    const names = ['--bilibili-pink','--bilibili-blue','--bilibili-gray','--bilibili-light-blue',
      '--paper-red-600','--paper-grey-900','--paper-grey-500','--paper-grey-300','--paper-grey-100',
      '--bilibili-brand','--bilibili-video'];
    const cs = getComputedStyle(el);
    const o = {};
    for (const n of names) { const v = cs.getPropertyValue(n).trim(); if (v) o[n] = v; }
    return o;
  };
  out.cssVars = { html: varsOf(document.documentElement), contentWrapper: varsOf(CW) };
  // 面板 DOM 树（限深 6，只要 tag/class/id/文本前 40 字）
  const walk = (el, depth) => {
    if (!el || depth > 7) return;
    if (el.__acgxReconSkip) return;
    out.tree.push('  '.repeat(depth) + el.tagName.toLowerCase()
      + (el.id ? '#' + el.id : '')
      + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '')
      + (el.children.length === 0 ? ' :: ' + (el.textContent || '').trim().slice(0, 40) : ''));
    for (const c of el.children) walk(c, depth + 1);
  };
  if (CW) walk(CW, 0);
  out.raw.contentWrapperOuter = CW ? CW.outerHTML.slice(0, 12000) : null;
  out.raw.contentWrapperLen = CW ? CW.outerHTML.length : 0;
  // 面板里是否已经有我们的东西 / 是否有旧 FAB
  out.acgx = {
    host: !!document.getElementById('acgx-batch-host'),
    shadowHost: !!document.querySelector('#acgx-batch-host'),
    entry: !!document.getElementById('acgx-batch-entry'),
  };
  return out;
})()`;

const report = { tree: TREE, startedAt: new Date().toISOString() };
let chromeProc = null;
let profile = '';
let code = 2;
let fgBefore = { raw: '' };

async function main() {
  say('================ ACGhelper 面板侦察（headless CDP）================');
  say(`扩展树 : ${TREE}`);
  if (!fs.existsSync(path.join(TREE, 'manifest.json'))) { say('[FATAL] 不是扩展树'); return 2; }
  if (!(await waitPortFree(PORT))) { say(`[FATAL] 端口 ${PORT} 8s 内未释放`); return 2; }

  const fgBeforeLocal = fgInfo();
  fgBefore = fgBeforeLocal;
  say(`[env] GetForegroundWindow(跑前) = ${fgBefore.raw}`);

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'acgx-recon-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--disable-background-networking', '--disable-component-update',
    '--enable-unsafe-extension-debugging',
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
  say(`[ext] loadUnpacked → id=${load.id} name=${load.name || ''}`);
  report.extensionId = load.id;

  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const P = (m, p, t) => b.send(m, p, sessionId, t);
  await P('Page.enable'); await P('Runtime.enable');
  await P('Emulation.setDeviceMetricsOverride', { width: 914, height: 1415, deviceScaleFactor: 1, mobile: false });

  const NAV = 'https://www.bilibili.com/video/BV1xx411c7m9';
  const reqLog = [];
  b.on(async (m) => {
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== sessionId) return;
    const { requestId, request } = m.params;
    reqLog.push(request.url);
    try {
      if (request.url === NAV || request.url.startsWith(NAV + '?')) {
        await b.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: b64(PAGE_HTML),
        }, sessionId);
      } else if (request.url.startsWith('https://api.bilibili.com/x/web-interface/view')) {
        await b.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json; charset=utf-8' },
            { name: 'Access-Control-Allow-Origin', value: 'https://www.bilibili.com' },
            { name: 'Access-Control-Allow-Credentials', value: 'true' },
          ],
          body: b64(JSON.stringify(viewFixture(3))),
        }, sessionId);
      } else {
        await b.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, sessionId);
      }
    } catch (e) { /* ignore */ }
  });
  await P('Fetch.enable', {
    patterns: [
      { urlPattern: NAV, requestStage: 'Request' },
      { urlPattern: 'https://api.bilibili.com/x/web-interface/view*', requestStage: 'Request' },
    ],
  });

  const evalIn = async (expr) => {
    const r = await P('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval 异常 ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };

  say(`\n[nav] ${NAV}`);
  await P('Page.navigate', { url: NAV });

  // 等插件悬浮球出现
  let ready = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 30000) {
    try {
      ready = await evalIn(`(()=>{const hw=document.getElementById('bilibiliHelper2HandleButtonWrapper');
        const hb=document.getElementById('bilibiliHelper2HandleButton');
        const cw=document.getElementById('bilibiliHelper2ContentWrapper');
        return JSON.stringify({hw:!!hw,hb:!!hb,cw:!!cw,
          hwCls:hw?hw.className:null, cwCls:cw?cw.className:null,
          hbStyle:hb?hb.getAttribute('class'):null, rs:document.readyState});})()`);
    } catch { /* 导航中 */ }
    if (ready) { const o = JSON.parse(ready); if (o.hw) break; }
    await sleep(300);
  }
  say(`[wait] 悬浮球就绪: ${ready}`);

  const beforeClick = await evalIn(DUMP_JS);
  say(`\n[before-click] ${JSON.stringify(beforeClick.found)}`);
  say(`  contentWrapper class = ${JSON.stringify(beforeClick.found.contentClass)}`);
  say(`  handleButton computed = ${JSON.stringify({
    display: beforeClick.styles.handleButton?.display,
    'background-color': beforeClick.styles.handleButton?.['background-color'],
    'border-radius': beforeClick.styles.handleButton?.['border-radius'],
    'box-shadow': beforeClick.styles.handleButton?.['box-shadow'],
  })}`);
  say(`  contentWrapper computed(点击前) = ${JSON.stringify({
    display: beforeClick.styles.contentWrapper?.['display'],
    visibility: beforeClick.styles.contentWrapper?.['visibility'],
    opacity: beforeClick.styles.contentWrapper?.['opacity'],
    'background-color': beforeClick.styles.contentWrapper?.['background-color'],
  })}`);

  // 点插件悬浮球
  const clicked = await evalIn(`(()=>{const hb=document.getElementById('bilibiliHelper2HandleButton');
    if(!hb) return 'NO_HANDLE_BUTTON';
    hb.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:10,clientY:10}));
    hb.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:10,clientY:10}));
    hb.click(); return 'CLICKED';})()`);
  say(`\n[click] 点悬浮球 → ${clicked}`);
  await sleep(1800);

  const after = await evalIn(DUMP_JS);
  say(`[after-click] ${JSON.stringify(after.found)}`);

  const dumpFile = path.join(LOGDIR, 'panel-recon-dump.json');
  fs.writeFileSync(dumpFile, JSON.stringify(after, null, 2), 'utf8');
  say(`\n[dump] ${dumpFile}  (${JSON.stringify(after).length} B)`);

  say('\n---- 面板 DOM 树 ----');
  after.tree.forEach((l) => say('  ' + l));

  say('\n---- 计算样式：.handle-content-wrapper#bilibiliHelper2ContentWrapper ----');
  say(JSON.stringify(after.styles.contentWrapper, null, 2));
  say('\n---- 计算样式：footer ----');
  say(JSON.stringify(after.styles.footer, null, 2));
  say('\n---- footer 里每个 span ----');
  after.styles.footerSpans.forEach((s) => say(`  «${s.text}» cls=${s.cls}  font-size=${s.cs['font-size']} color=${s.cs.color} cursor=${s.cs.cursor} margin=${s.cs.margin}`));
  say('\n---- 面板里的 button ----');
  say(`共 ${after.styles.buttons.length} 个`);
  after.styles.buttons.forEach((x, i) => say(`  [${i}] «${x.text}» cls=${x.cls}\n      ${JSON.stringify(x.cs)}`));
  say('\n---- 面板里的 input/select ----');
  after.styles.inputs.forEach((x, i) => say(`  [${i}] ${x.tag} type=${x.type} ${JSON.stringify(x.cs)}`));
  say('\n---- CSS 变量 ----');
  say(JSON.stringify(after.cssVars, null, 2));
  say('\n---- .new-downloader ----');
  say(JSON.stringify(after.styles.newDownloader, null, 2));

  say('\n---- 各区块容器（#bilibiliHelper2ContentWrapper 的直接子节点）----');
  (after.styles.sections || []).forEach((s, i) => say(`  [${i}] <${s.tag}${s.id ? '#' + s.id : ''}.${String(s.cls).split(/\s+/).join('.')}> rect=${JSON.stringify(s.rect)} cs=${JSON.stringify(s.cs)}`));

  say('\n---- 原生按钮“可视层” div.button（primary / border / 无变体）----');
  (after.styles.buttonWrappers || []).forEach((x, i) => say(`  [${i}] «${x.text}» cls=${x.cls} size=${x.rect.w}×${x.rect.h}\n      ${JSON.stringify(x.cs)}`));

  say('\n---- CSSOM：插件自己写死的规则（过滤 .button/hover/primary/border/footer/title）----');
  (after.cssomRules || []).forEach((r, i) => say(`  [${i}] ${r.sel}\n      ${r.css}`));
  say('\n---- 字体 ----');
  say(JSON.stringify(after.fonts, null, 2));

  // 截图
  try {
    const shot = await P('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 30000);
    const buf = Buffer.from(shot.data, 'base64');
    const out = path.join(LOGDIR, 'panel-recon.png');
    fs.writeFileSync(out, buf);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    say(`\n[shot] ${out}  ${w}×${h}  ${buf.length} B`);
    report.screenshot = { file: out, width: w, height: h };
  } catch (e) { say('[shot] 失败 ' + e.message); }

  report.beforeClick = beforeClick.found;
  report.afterClick = after.found;
  report.tree = after.tree;
  report.styles = after.styles;
  report.cssVars = after.cssVars;
  report.requestLog = reqLog;
  return 0;
}

try {
  code = await main();
} catch (e) {
  say('[FATAL] ' + (e.stack || e.message));
  code = 2;
} finally {
  const fgAfter = fgInfo();
  say(`\n[env] GetForegroundWindow(跑后) = ${fgAfter.raw}`);
  say(`[env] GetForegroundWindow 跑前跑后一致 = ${fgBefore.raw === fgAfter.raw}（${fgBefore.raw} → ${fgAfter.raw}）`);
  report.foregroundBefore = fgBefore.raw;
  report.foregroundAfter = fgAfter.raw;
  report.foregroundSame = fgBefore.raw === fgAfter.raw;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(LOGDIR, `panel-recon-${Date.now()}.log`), lines.join('\n'), 'utf8');
  if (chromeProc) killTree(chromeProc.pid);
  let left = '?';
  for (let i = 0; i < 8; i++) {
    await sleep(700);
    left = ps(`@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profile}') }).Count`);
    if (String(left).trim() === '0') break;
    ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profile}') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }`);
  }
  say(`[cleanup] 残留 chrome = ${left}`);
  if (!KEEP) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(path.join(TREE, '_metadata'), { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(code);
}
