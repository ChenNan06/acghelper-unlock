#!/usr/bin/env node
/**
 * batch-cdp-test.mjs —— 选集/多P 批量下载面板的**真机级**验证（headless Chrome + CDP）
 *
 * 做什么：
 *   1. headless Chrome（--headless=new --mute-audio --enable-unsafe-extension-debugging
 *      --remote-debugging-port=9455 --user-data-dir=<temp>）+ CDP Extensions.loadUnpacked
 *      加载 build/batch-test（38 条成品树 + tools/feature-batch.json）
 *   2. 造一个假番剧页：Page.navigate 到 https://www.bilibili.com/bangumi/play/ep123456，
 *      用 Fetch.enable + Fetch.fulfillRequest 把「document」和
 *      「api.bilibili.com/pgc/view/web/season*」都替换成 fixture（真实网络请求一条都不发）
 *   3. 断言：
 *      ① 面板 DOM 出现（shadow root 里 [data-acgx-role=item]）且条数 = fixture 集数
 *      ② 点「全选」后选中数 = N
 *      ③ 点「开始下载」后 offscreen 侧收到 N 条 acgxAutoDownload（读 offscreen 的 console）
 *      ④ 队列串行：第 i 集的 done 一定早于第 i+1 集的 recv
 *   4. Page.captureScreenshot 截图（headless，不碰主屏），读 IHDR 报像素尺寸
 *
 * 环境自证：本次 profile 的 chrome 进程 MainWindowHandle 全 0 / GetForegroundWindow 跑前跑后一致 /
 *          命令行含 --mute-audio；结束按 PID 树 taskkill 并清 profile。
 *
 * 用法: node tools/batch-cdp-test.mjs [--tree=build/batch-test] [--episodes=4] [--keep]
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
const TREE = path.resolve(ROOT, flag('tree') || path.join('build', 'batch-test'));
const N_EP = Number(flag('episodes') || 4);
const PORT = Number(flag('port') || 9455);
const NAV = 'https://www.bilibili.com/bangumi/play/ep123456';
const LOGDIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ---------------------------------------------------------------- 断言台账
const checks = [];
function check(ok, name, detail = '') {
  checks.push({ ok: !!ok, name, detail });
  say(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '\n        ' + String(detail).split('\n').join('\n        ') : ''}`);
  return ok;
}

// ---------------------------------------------------------------- CDP 客户端
function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
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
      events.push(m);
      for (const fn of listeners) { try { fn(m); } catch { /* ignore */ } }
    }
  });
  return {
    opened, events,
    on(fn) { listeners.push(fn); },
    send(method, params = {}, sessionId = null, timeoutMs = 20000) {
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

const FG_PS = "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int pid);'; " +
  "$h=[W.U]::GetForegroundWindow(); $x=0; [void][W.U]::GetWindowThreadProcessId($h,[ref]$x); " +
  "$p=Get-Process -Id $x -ErrorAction SilentlyContinue; \"$($h.ToInt64())|$x|$($p.ProcessName)\"";

/** 前台窗口快照：hwnd | pid | 进程名 */
function fgInfo() {
  const raw = ps(FG_PS);
  const [hwnd, pid, name] = String(raw).split('|');
  return { raw, hwnd, pid: Number(pid) || 0, name: name || '' };
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

// ---------------------------------------------------------------- fixture
function seasonFixture(n) {
  const eps = [];
  for (let i = 1; i <= n; i++) {
    eps.push({
      ep_id: 900000 + i,
      aid: 1000 + i,
      bvid: 'BV1xx411c7m' + i,
      cid: 2000 + i,
      title: String(i),
      long_title: `第${i}话 fixture 标题`,
      share_copy: `第${i}话 fixture 标题`,
      duration: 1440000 + i * 1000,
      cover: 'https://i0.hdslb.com/bfs/fixture.jpg',
      link: `https://www.bilibili.com/bangumi/play/ep${900000 + i}`,
      pub_time: 1700000000,
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
    data: { bvid: 'BV1xx411c7m9', aid: 990099, title: 'ACGN 多 P fixture 视频', videos: n, pages },
  };
}

const PAGE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>ep123456 fixture</title></head><body>
<div id="app"><h1 id="fixture-h1">ACGN 测试番剧 · fixture 页面</h1>
<p>本页面由 CDP Fetch.fulfillRequest 提供，不产生任何真实网络请求。</p></div>
</body></html>`;

// ---------------------------------------------------------------- main
const report = { tree: TREE, nav: NAV, episodes: N_EP, startedAt: new Date().toISOString() };
let chromeProc = null;
let profile = '';
let exitCode = 1;

async function main() {
  say('================ 选集批量下载面板 · headless CDP 验证 ================');
  say(`扩展树   : ${TREE}`);
  say(`Chrome   : ${CHROME}`);
  say(`端口     : ${PORT}`);
  if (!fs.existsSync(path.join(TREE, 'js', 'pages', 'acgx-batch.js'))) {
    say(`[FATAL] ${TREE} 里没有 js/pages/acgx-batch.js —— 先跑 python tools/apply-feature-batch.py --out build/batch-test`);
    return 2;
  }
  if (!(await portFree(PORT))) {
    say(`[FATAL] 端口 ${PORT} 被占用`);
    return 2;
  }

  // ---- 环境自证（跑前） ----
  const fgBefore = fgInfo();
  say(`[env] GetForegroundWindow(跑前) = ${fgBefore.raw}`);

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'acgx-batch-'));
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
    if (Date.now() - t0 > 30000) { say('[FATAL] Chrome CDP 30s 未就绪\n' + stderr.slice(-2000)); return 2; }
    try { version = await httpJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(300); }
  }
  say(`[env] Chrome PID = ${chromeProc.pid}  ${version.Browser}`);

  const b = cdpConnect(version.webSocketDebuggerUrl);
  await b.opened;

  // ---- 加载扩展 ----
  const load = await b.send('Extensions.loadUnpacked', { path: TREE }, null, 30000);
  const extId = load.id;
  say(`[ext] Extensions.loadUnpacked → id=${extId}  name=${load.name || ''}`);
  report.extensionId = extId;

  // ---- 等 SW / offscreen target ----
  let swTarget = null, offTarget = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 30000) {
    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    swTarget = list.find((t) => t.type === 'service_worker' && t.url.includes(`${extId}/initBackground.sw.js`)) || swTarget;
    offTarget = list.find((t) => t.url === `chrome-extension://${extId}/html/background.html`) || offTarget;
    if (swTarget && offTarget) break;
    await sleep(400);
  }
  say(`[ext] service_worker target = ${swTarget ? swTarget.url : '(未出现)'}`);
  say(`[ext] offscreen target      = ${offTarget ? offTarget.url + '  type=' + offTarget.type : '(未出现)'}`);
  check(!!swTarget, '扩展 service worker 起来了');
  check(!!offTarget, 'offscreen 文档（html/background.html）起来了 —— 批量下载命令的接收方');
  if (!offTarget) return 1;

  // ---- offscreen 会话：读 console + 设解析超时 ----
  const offWs = cdpConnect(offTarget.webSocketDebuggerUrl);
  await offWs.opened;
  await offWs.send('Runtime.enable');
  const offLogs = [];
  offWs.on((m) => {
    if (m.method !== 'Runtime.consoleAPICalled') return;
    const text = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
    offLogs.push({ ts: Date.now(), type: m.params.type, text });
  });
  const initT = await offWs.send('Runtime.evaluate', {
    expression: `JSON.stringify({helper: typeof self.__acgxBatchAuto, abort: typeof self.__acgxBatchAbort,
      info: typeof self.__acgxBatchInfo, storage: typeof chrome.storage, runtime: typeof chrome.runtime})`,
    awaitPromise: true, returnByValue: true,
  });
  const initRaw = JSON.stringify(initT);
  const initVal = typeof initT?.result?.value === 'string' ? initT.result.value : initRaw;
  say(`[offscreen] helper 状态: ${initVal.slice(0, 400)}`);
  check(initVal.includes('"helper":"function"') && initVal.includes('"abort":"function"'),
    'offscreen 侧 __acgxBatchAuto / __acgxBatchAbort 已注册（html/background.html 成功加载 batch 执行端）',
    initVal.slice(0, 400));

  // ---- 新建页面 target ----
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const P = (method, params, timeoutMs) => b.send(method, params, sessionId, timeoutMs);

  await P('Page.enable');
  await P('Runtime.enable');
  await P('Emulation.setDeviceMetricsOverride', { width: 914, height: 1415, deviceScaleFactor: 1, mobile: false });

  // ---- Fetch 拦截：document + season API 全部喂 fixture ----
  const fixture = seasonFixture(N_EP);
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
      } else if (request.url.startsWith('https://www.bilibili.com/video/')) {
        await b.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: b64(PAGE_HTML.replace('ep123456 fixture', 'BV1xx411c7m9 fixture')),
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
      } else if (request.url.startsWith('https://api.bilibili.com/pgc/view/web/season')) {
        await b.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json; charset=utf-8' },
            { name: 'Access-Control-Allow-Origin', value: 'https://www.bilibili.com' },
            { name: 'Access-Control-Allow-Credentials', value: 'true' },
          ],
          body: b64(JSON.stringify(fixture)),
        }, sessionId);
      } else {
        await b.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, sessionId);
      }
    } catch (e) { say(`[fetch] 处理 ${request.url} 失败: ${e.message}`); }
  });
  await P('Fetch.enable', {
    patterns: [
      { urlPattern: NAV.replace('ep123456', 'ep123456*'), requestStage: 'Request' },
      { urlPattern: 'https://www.bilibili.com/video/*', requestStage: 'Request' },
      { urlPattern: 'https://api.bilibili.com/pgc/view/web/season*', requestStage: 'Request' },
      { urlPattern: 'https://api.bilibili.com/x/web-interface/view*', requestStage: 'Request' },
    ],
  });

  say(`\n[nav] ${NAV}`);
  await P('Page.navigate', { url: NAV });

  // ---- 等面板 ----
  const evalIn = async (expr) => {
    const r = await P('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('evaluate 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  };
  const probe = `(()=>{const h=document.getElementById('acgx-batch-host');
    const sr=h&&h.shadowRoot; if(!sr) return null;
    const p=sr.getElementById('acgx-batch-panel');
    const g=k=>p?p.getAttribute('data-acgx-'+k):null;
    const rows=[...sr.querySelectorAll('[data-acgx-role="item"]')];
    const fab=sr.getElementById('acgx-batch-fab');
    return {hasFab:!!fab, fabText:fab?fab.textContent:null,
      panelVisible:p?p.style.display:null, rows:rows.length,
      count:Number(g('count')||0), checked:Number(g('checked')||0),
      running:g('running')==='1', index:Number(g('index')||0), total:Number(g('total')||0),
      ok:Number(g('ok')||0), fail:Number(g('fail')||0),
      error:g('error')||'', source:g('source')||'', message:g('message')||'',
      keys:rows.map(r=>r.getAttribute('data-acgx-key')),
      titles:rows.slice(0,4).map(r=>{const n=r.querySelector('.n');return n?n.textContent:''}),
      durs:rows.slice(0,4).map(r=>{const d=r.querySelector('.d');return d?d.textContent:''}),
      states:rows.map(r=>r.getAttribute('data-st')),
      retryBtns:[...sr.querySelectorAll('[data-acgx-role="retry"]')].length,
      statusText:(sr.getElementById('acgx-status')||{}).textContent||''};})()`;

  let snap = null;
  const t2 = Date.now();
  while (Date.now() - t2 < 25000) {
    try { snap = await evalIn(probe); } catch (e) { /* 导航中 */ }
    if (snap) break;
    await sleep(300);
  }
  say(`\n[panel] ${JSON.stringify({ hasFab: snap?.hasFab, fabText: snap?.fabText, rows: snap?.rows, panelVisible: snap?.panelVisible })}`);
  check(!!snap, '内容脚本已注入：shadow host + 浮按钮就绪');
  if (!snap) return 1;
  check(snap.hasFab === true && snap.fabText === '选集下载', '① 右下角浮动按钮「选集下载」存在');

  // 自动化钩子：覆盖解析超时（内容脚本读 <html data-acgx-init-timeout>），默认 90s
  await evalIn(`(()=>{document.documentElement.setAttribute('data-acgx-init-timeout','4000');return 1;})()`);

  // ---- 打开面板 ----
  await evalIn(`(()=>{document.getElementById('acgx-batch-host').shadowRoot.getElementById('acgx-batch-fab').click();return 1;})()`);
  let st = null;
  const t3 = Date.now();
  while (Date.now() - t3 < 20000) {
    const s = await evalIn(probe);
    st = s || st;
    if (st && st.count > 0) break;
    if (st && st.error) break;
    await sleep(300);
  }
  say(`\n[panel] 打开后：count=${st?.count} error=${JSON.stringify(st?.error)} source=${st?.source}`);
  say(`[panel] 前 4 条：${JSON.stringify((st?.titles || []).map((t, i) => [st?.keys?.[i], t, st?.durs?.[i]]))}`);
  const apiHit = reqLog.filter((u) => u.includes('/pgc/view/web/season')).length;
  check(apiHit > 0, '① 面板通过 fetch 打了 season 接口（被 CDP 拦截并喂 fixture）', `命中 ${apiHit} 次: ${reqLog.join(' | ').slice(0, 300)}`);
  check(st && st.count === N_EP, `① 面板列出了 fixture 的 ${N_EP} 集`, `实际 count=${st?.count} error=${st?.error}`);
  check(st && (st.keys || []).length === N_EP && (st.keys || []).every((k, i) => k === 'ep' + (900001 + i)),
    '① 列表内容来自 fixture（data-acgx-key = ep900001…）', (st?.keys || []).join(','));
  check(st && (st.durs || []).every((d) => /^\d+:\d\d$/.test(d)), '① 每行显示时长（mm:ss）', (st?.durs || []).join(','));
  check(st && st.rows === N_EP, `① shadow DOM 里 [data-acgx-role=item] = ${N_EP} 条`, `实际 ${st?.rows}`);
  recordScreenshot(b, P, 'logs/batch-panel-opened.png', '面板打开（未全选）');

  // ---- 全选 ----
  await evalIn(`(()=>{const sr=document.getElementById('acgx-batch-host').shadowRoot;
    const a=sr.getElementById('acgx-all'); a.click(); return a.checked;})()`);
  await sleep(400);
  const afterAll = await evalIn(probe);
  const checkedDom = await evalIn(`(()=>{const sr=document.getElementById('acgx-batch-host').shadowRoot;
    return sr.querySelectorAll('[data-acgx-role="check"]:checked').length;})()`);
  say(`\n[selectall] data-acgx-checked=${afterAll?.checked} DOM 勾选数=${checkedDom}`);
  check(checkedDom === N_EP && afterAll?.checked === N_EP, `② 点「全选」后选中数 = ${N_EP}`, `DOM=${checkedDom} attr=${afterAll?.checked}`);

  // ---- 开始下载 ----
  const t4 = Date.now();
  await evalIn(`(()=>{document.getElementById('acgx-batch-host').shadowRoot.getElementById('acgx-start').click();return 1;})()`);
  say('\n[queue] 已点「开始下载」，等队列跑完…');
  let finSt = null;
  while (Date.now() - t4 < 120000) {
    const s = await evalIn(probe);
    if (s) finSt = s;
    if (finSt && finSt.running === false && finSt.ok + finSt.fail > 0) break;
    await sleep(500);
  }
  const elapsed = ((Date.now() - t4) / 1000).toFixed(1);
  say(`[queue] 用时 ${elapsed}s  最终状态: ok=${finSt?.ok} fail=${finSt?.fail} message=${finSt?.message}`);

  // ---- 读 offscreen console ----
  await sleep(800);
  const recv = offLogs.filter((l) => l.text.includes('[acgx-batch] recv url='));
  const done = offLogs.filter((l) => l.text.includes('[acgx-batch] done url='));
  say('\n[offscreen console 原文]');
  offLogs
    .filter((l) => l.text.includes('[acgx-batch]'))
    .forEach((l) => say('   ' + l.text));
  check(recv.length === N_EP, `③ offscreen 侧收到 ${N_EP} 条 acgxAutoDownload`, `实际 ${recv.length} 条`);
  check(done.length === N_EP, `③ offscreen 侧回执 ${N_EP} 条 itemDone`, `实际 ${done.length} 条`);

  // 串行：每集的 done 早于下一集的 recv
  const seq = offLogs.filter((l) => /\[acgx-batch\] (recv|done) url=/.test(l.text));
  const kinds = seq.map((l) => (l.text.includes(' recv url=') ? 'recv' : 'done'));
  say(`\n[serial] 顺序序列: ${kinds.join(' → ')}`);
  let serialOk = kinds.length === N_EP * 2;
  for (let i = 0; i < kinds.length; i++) {
    const want = i % 2 === 0 ? 'recv' : 'done';
    if (kinds[i] !== want) serialOk = false;
  }
  const recvIdx = seq.map((l, i) => (l.text.includes(' recv url=') ? i : -1)).filter((i) => i >= 0);
  const doneIdx = seq.map((l, i) => (l.text.includes(' done url=') ? i : -1)).filter((i) => i >= 0);
  let ordered = true;
  for (let i = 0; i + 1 < recvIdx.length; i++) if (!(doneIdx[i] < recvIdx[i + 1])) ordered = false;
  check(serialOk && ordered, '④ 队列严格串行（recv1→done1→recv2→done2…，第 i 集 done 早于第 i+1 集 recv）',
    `序列=${kinds.join(',')}`);
  check(finSt && finSt.fail === N_EP && finSt.ok === 0,
    '失败分支：fixture 环境下 4 集全部按预期失败并可继续（不卡队列）',
    `ok=${finSt?.ok} fail=${finSt?.fail}`);
  check(!!finSt && !!finSt.message, '队列结束时给出汇总状态行', finSt?.message);
  check(!!finSt && finSt.states.every((s) => s === 'fail') && finSt.retryBtns === N_EP,
    '失败分支：每行标红 + 都出现「重试本集」按钮', `states=${(finSt?.states || []).join(',')} retry=${finSt?.retryBtns}`);
  check((finSt?.statusText || '').length > 0, '状态行文本非空', finSt?.statusText);

  recordScreenshot(b, P, 'logs/batch-panel-done.png', '队列结束（红行 = 失败，可重试本集）');

  // ---- 追加场景：多 P 视频（/video/BV…）----
  const UGC_NAV = 'https://www.bilibili.com/video/BV1xx411c7m9';
  say(`
[nav] ${UGC_NAV}（多 P 场景）`);
  await P('Page.navigate', { url: UGC_NAV });
  let ugc = null;
  const t5 = Date.now();
  while (Date.now() - t5 < 25000) {
    try { ugc = await evalIn(probe); } catch { /* 导航中 */ }
    if (ugc && ugc.hasFab) break;
    await sleep(300);
  }
  check(!!ugc && ugc.hasFab === true, '多 P 页也注入了浮按钮「选集下载」', JSON.stringify(ugc && { fab: ugc.fabText }));
  await evalIn(`(()=>{document.documentElement.setAttribute('data-acgx-init-timeout','4000');
    document.getElementById('acgx-batch-host').shadowRoot.getElementById('acgx-batch-fab').click();return 1;})()`);
  let ugcSt = null;
  const t6 = Date.now();
  while (Date.now() - t6 < 20000) {
    const s2 = await evalIn(probe);
    if (s2) ugcSt = s2;
    if (ugcSt && (ugcSt.count > 0 || ugcSt.error)) break;
    await sleep(300);
  }
  const ugcApi = reqLog.filter((u) => u.includes('/x/web-interface/view')).length;
  say(`[ugc] count=${ugcSt?.count} source=${ugcSt?.source} error=${JSON.stringify(ugcSt?.error)} keys=${(ugcSt?.keys || []).join(',')}`);
  check(ugcApi > 0, '多 P 场景：面板打了 x/web-interface/view（被 CDP 拦截并喂 fixture）', `命中 ${ugcApi} 次`);
  check(ugcSt && ugcSt.count === 3 && (ugcSt.keys || []).join(',') === 'p1_3001,p2_3002,p3_3003',
    '多 P 场景：列出 fixture 的 3 个分 P', `count=${ugcSt?.count} keys=${(ugcSt?.keys || []).join(',')}`);
  check(ugcSt && (ugcSt.titles || []).every((t) => /^P\d /.test(t)), '多 P 场景：行标题形如「P1 分段1 fixture」', (ugcSt?.titles || []).join(' | '));
  recordScreenshot(b, P, 'logs/batch-panel-ugc.png', '多 P 视频场景（3 个分 P）');

  // ---- 不改坏现有 UI 的自证 ----
  const intact = await evalIn(`(()=>{const h=document.getElementById('acgx-batch-host');
    const cs=h?getComputedStyle(h):null;
    return JSON.stringify({h1: !!document.getElementById('fixture-h1'),
      hostCount: document.querySelectorAll('#acgx-batch-host').length,
      hostPosition: cs?cs.position:null, hostZ: cs?cs.zIndex:null,
      shadowKids: h&&h.shadowRoot?h.shadowRoot.children.length:0,
      bodyChildren: document.body.children.length});})()`);
  say(`
[ui] ${intact}`);
  const iu = JSON.parse(intact);
  check(iu.h1 === true, '页面原有 DOM 未被破坏（#fixture-h1 还在）', intact);
  check(iu.hostCount === 1 && iu.hostPosition === 'fixed', '面板宿主只有 1 个且 position:fixed（不参与页面文档流，不会挤动原布局）', intact);

  // ---- 收尾自证 ----
  const fgAfter = fgInfo();
  say(`\n[env] GetForegroundWindow(跑后) = ${fgAfter.raw}`);
  check(fgBefore.raw === fgAfter.raw, 'GetForegroundWindow 跑前跑后一致（没有抢前台）', `${fgBefore.raw} → ${fgAfter.raw}`);

  const mwh = ps(`$p = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profile}') } | Select-Object -ExpandProperty ProcessId); ` +
    `if ($p.Count -eq 0) { 'NO_PROC' } else { $p | ForEach-Object { $h=(Get-Process -Id $_ -ErrorAction SilentlyContinue).MainWindowHandle; "$_=$h" } }`);
  say(`[env] 本次 profile 的 chrome 进程 MainWindowHandle: ${mwh.replace(/\r?\n/g, ' ')}`);
  check(!/=[1-9]/.test(mwh) && mwh !== 'NO_PROC', '本次 profile 的 chrome 进程 MainWindowHandle 全 0（无可见窗口）', mwh.split(/\r?\n/).join(' '));
  check(args.includes('--mute-audio'), '--mute-audio 在命令行里（进程静音）');

  // 更强的一条：前台窗口不可能是我们这批 headless chrome（它们没有窗口）
  const ourPids = String(mwh).split(/\s+/).map((x) => Number(String(x).split('=')[0])).filter((n) => n > 0);
  check(ourPids.length > 0 && !ourPids.includes(fgAfter.pid) && !ourPids.includes(fgBefore.pid),
    '前台窗口的 pid 不在本次 chrome PID 集合里（headless chrome 全程没有可见窗口）',
    `前台 pid: ${fgBefore.pid}(${fgBefore.name}) / ${fgAfter.pid}(${fgAfter.name})；本次 chrome pid: ${ourPids.join(',')}`);

  report.foregroundBefore = Number(fgBefore);
  report.foregroundAfter = Number(fgAfter);
  report.mainWindowHandles = mwh;
  report.offscreenConsole = offLogs.map((l) => l.text);
  report.requestLog = reqLog;
  report.finalState = finSt;
  return 0;
}

async function recordScreenshot(b, P, rel, label) {
  try {
    const shot = await P('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 30000);
    const buf = Buffer.from(shot.data, 'base64');
    const out = path.join(ROOT, rel);
    fs.writeFileSync(out, buf);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    say(`[shot] ${label} → ${rel}  ${w}×${h}  ${buf.length} B`);
    report.screenshots = (report.screenshots || []).concat([{ file: rel, width: w, height: h, bytes: buf.length }]);
    checks.push({ ok: w > 0 && h > 0, name: `截图 ${rel}`, detail: `${w}×${h} ${buf.length}B` });
  } catch (e) {
    say(`[shot] 截图失败: ${e.message}`);
  }
}

// ---------------------------------------------------------------- 执行与清理
let code = 2;
try {
  code = await main();
} catch (e) {
  say(`[FATAL] ${e.stack || e.message}`);
  code = 2;
} finally {
  const fail = checks.filter((c) => !c.ok).length;
  say(`\n================ 结论：${fail === 0 && code === 0 ? 'PASS' : 'FAIL'}（PASS ${checks.filter((c) => c.ok).length} / 共 ${checks.length}，失败 ${fail}）`);
  report.checks = checks;
  report.summary = { pass: checks.filter((c) => c.ok).length, total: checks.length, fail, code };
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(LOGDIR, `batch-cdp-report-${Date.now()}.json`), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(LOGDIR, `batch-cdp-${new Date().toISOString().replace(/[:.]/g, '-')}.log`), lines.join('\n'), 'utf8');
  if (chromeProc) killTree(chromeProc.pid);
  // 进程树偶有慢退，反复按 profile 精确清理（只清本次 user-data-dir，不碰别人的 chrome）
  let left = '?';
  for (let i = 0; i < 8; i++) {
    await sleep(700);
    left = ps(`@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profile}') }).Count`);
    if (String(left).trim() === '0') break;
    ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profile}') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }`);
  }
  say(`[cleanup] 残留 chrome 进程数 = ${left}；profile = ${profile}`);
  report.residualChrome = left;
  if (!KEEP) {
    for (let i = 0; i < 6; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
      if (!fs.existsSync(profile)) break;
      await sleep(400);
    }
    say(`[cleanup] profile 已删 = ${!fs.existsSync(profile)}`);
  }
  // 扩展目录里 Chrome 会写 _metadata，属于运行时缓存，不属于交付内容
  try { fs.rmSync(path.join(TREE, '_metadata'), { recursive: true, force: true }); } catch { /* ignore */ }
  exitCode = (fail === 0 && code === 0) ? 0 : 1;
}
process.exit(exitCode);
