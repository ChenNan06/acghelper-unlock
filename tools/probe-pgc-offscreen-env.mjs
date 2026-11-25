#!/usr/bin/env node
/**
 * probe-pgc-offscreen-env.mjs —— 在真 Chrome 里探测 offscreen 文档的运行期事实
 *
 * 目的（决定 PGC/FLV 落盘走哪条通道，以及 FLV 写流表达式是否死锁）：
 *   T1 typeof window.showSaveFilePicker      → 决定 useStreamSaver 是否被强制为 true
 *   T2 typeof InstallTrigger（ut=n()）        → 决定代码里 `!ut &&` 这一项
 *   T3 'serviceWorker' in navigator           → Ve/streamsaver 分支
 *   T4 复刻 Ce(=Be.writeFile) 的写入门表达式   → `!await writer.closed` 是否挂死
 *   T5 复刻 streamsaver 落盘 sink 的类型检查   → Blob 是否被拒
 *
 * 纯 headless（--headless=new）：不创建任何窗口，不抢焦点，不发声（--mute-audio）。
 * 用法: node tools/probe-pgc-offscreen-env.mjs [成品目录]
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = String.raw`D:\AI-Project\逆向统一\acghelper`;
const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TREE = path.resolve(process.argv[2] || path.join(ROOT, 'build', 'pgc-proto', 'tree38'));
const OUTDIR = path.join(ROOT, 'build', 'pgc-proto', 'probe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const httpJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(3000) })).json();

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error ' + wsUrl)), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method) events.push(m);
  });
  return {
    opened, events,
    send(method, params = {}, timeoutMs = 15000, sessionId = undefined) {
      const id = ++seq;
      return opened.then(() => new Promise((res, rej) => {
        const timer = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + method)); }, timeoutMs);
        pending.set(id, { res, rej, timer });
        const frame = { id, method, params };
        if (sessionId) frame.sessionId = sessionId;
        ws.send(JSON.stringify(frame));
      }));
    },
    close() { try { ws.close(); } catch {} },
  };
}

function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

const PROBE = `(async()=>{
  const out={};
  out.hasShowSaveFilePicker = typeof window.showSaveFilePicker;
  out.hasShowDirectoryPicker = typeof window.showDirectoryPicker;
  out.notTaInstaller = typeof InstallTrigger;
  out.hasServiceWorkerInNavigator = 'serviceWorker' in navigator;
  out.isSecureContext = window.isSecureContext;
  out.hasFileSystemWritableFileStream = typeof FileSystemWritableFileStream;
  out.hasWritableStream = typeof WritableStream;
  out.hasWritableStreamDefaultWriter = typeof WritableStreamDefaultWriter;
  out.location = location.href;
  out.visibility = document.visibilityState;

  // T5: streamsaver 的 sink 类型检查（js/pages/background.js @54100 起 createWriteStream 内 write()/transform()）
  try{
    const ws=new WritableStream({write(e){ if(!(e instanceof Uint8Array)) throw new TypeError('Can only write Uint8Arrays'); }});
    const w=ws.getWriter();
    await w.write(new Blob([new Uint8Array([1,2,3])]));
    out.blobWriteToStreamSaverSink='accepted';
  }catch(e){ out.blobWriteToStreamSaverSink = e.name+': '+e.message; }

  // T4: 复刻 Be.writeFile 的写入门表达式 r instanceof WritableStreamDefaultWriter && !await r.closed
  try{
    const ws2=new WritableStream({write(){}});
    const w2=ws2.getWriter();
    const guard=()=>w2 instanceof WritableStreamDefaultWriter && !(w2.closed ? false : true);
    // 精确复刻（含 await）
    const real=async()=>{ if(w2 instanceof WritableStreamDefaultWriter && !await w2.closed){ return 'WROTE'; } return 'SKIP'; };
    const raced=await Promise.race([real(), new Promise(r=>setTimeout(()=>r('HANG(800ms unclosed)'),800))]);
    out.flvWriteGuardRace = raced;
  }catch(e){ out.flvWriteGuardRace = e.name+': '+e.message; }

  // 对照：DASH 的写入门表达式 a instanceof WritableStreamDefaultWriter（无 !await closed）
  try{
    const ws3=new WritableStream({write(){}});
    const w3=ws3.getWriter();
    const real3=async()=>{ if(w3 instanceof WritableStreamDefaultWriter){ await w3.write(new Uint8Array([1])); return 'WROTE'; } return 'SKIP'; };
    out.dashWriteGuardRace = await real3();
  }catch(e){ out.dashWriteGuardRace = e.name+': '+e.message; }
  // T6: offscreen 文档里的用户激活状态 + showSaveFilePicker 的真实拒绝原因
  out.userActivation = navigator.userActivation ? {isActive:navigator.userActivation.isActive, hasBeenActive:navigator.userActivation.hasBeenActive} : null;
  try{
    const p = window.showSaveFilePicker({suggestedName:'acg-probe.mp4'});
    out.pickerResult = await Promise.race([
      p.then(h=>'RESOLVED handle='+(h&&h.name), e=>'REJECTED '+e.name+': '+e.message),
      new Promise(r=>setTimeout(()=>r('PENDING(3500ms, 对话框等待中)'),3500)),
    ]);
  }catch(e){ out.pickerResult='SYNC-THROW '+e.name+': '+e.message; }
  return JSON.stringify(out);
})()`;

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-probe-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--disable-background-networking', '--disable-component-update',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--enable-unsafe-extension-debugging',
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d.toString(); });
  const t0 = Date.now();
  let ver;
  for (;;) {
    if (Date.now() - t0 > 25000) throw new Error('chrome 25s 未就绪\n' + err);
    try { ver = await httpJson(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(300); }
  }
  const b = cdp(ver.webSocketDebuggerUrl);
  await b.opened;
  await b.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  const load = await b.send('Extensions.loadUnpacked', { path: TREE }, 20000);
  const id = load.id;
  console.log('browser  :', ver.Browser);
  console.log('extension:', id, TREE);

  // 找 SW target
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    const { targetInfos } = await b.send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url === `chrome-extension://${id}/initBackground.sw.js`) || null;
    if (!sw) await sleep(500);
  }
  if (!sw) throw new Error('未找到扩展 SW target');
  const swSess = await b.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const sid = swSess.sessionId;

  // 让 SW 拉起 offscreen 文档（若已存在则忽略报错）
  await b.send('Runtime.enable', {}, 20000, sid).catch(() => {});
  const created = await b.send('Runtime.evaluate', {
    expression: `(async()=>{try{await chrome.offscreen.createDocument({url:chrome.runtime.getURL('html/background.html'),reasons:['BLOBS','DOM_SCRAPING','IFRAME_SCRIPTING'],justification:'probe'});return 'created';}catch(e){return 'exists/err: '+e.message;}})()`,
    awaitPromise: true, returnByValue: true,
  }, 20000, sid).catch((e) => ({ result: { value: 'ERR ' + e.message } }));
  console.log('offscreen :', created.result?.value);
  await sleep(1500);

  // 找 offscreen target
  let off = null;
  for (let i = 0; i < 30 && !off; i++) {
    const { targetInfos } = await b.send('Target.getTargets');
    off = targetInfos.find((t) => t.url === `chrome-extension://${id}/html/background.html`) || null;
    if (!off) await sleep(500);
  }
  if (!off) throw new Error('未找到 offscreen 文档 target');
  console.log('offscreen target type:', off.type, off.url);
  const offSess = await b.send('Target.attachToTarget', { targetId: off.targetId, flatten: true });
  const osid = offSess.sessionId;
  await b.send('Runtime.enable', {}, 20000, osid).catch(() => {});

  const res = await b.send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true }, 30000, osid);
  const payload = {
    browser: ver.Browser,
    extensionId: id,
    tree: TREE,
    headless: true,
    offscreenTarget: { type: off.type, url: off.url },
    probe: res.result?.value ? JSON.parse(res.result.value) : null,
    exception: res.exceptionDetails || null,
  };
  fs.writeFileSync(path.join(OUTDIR, 'offscreen-env.json'), JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload.probe, null, 2));
  if (payload.exception) console.log('EXCEPTION:', JSON.stringify(payload.exception));

  b.close();
  killTree(proc.pid);
  for (let i = 0; i < 6; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} if (!fs.existsSync(profile)) break; await sleep(300); }
  process.exit(0);
})().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
