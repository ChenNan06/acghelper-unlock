#!/usr/bin/env node
/**
 * final-smoke-chrome.mjs —— 成品扩展真实加载冒烟（headless Chrome 156 + CDP）
 *
 * 断言：
 *   ① /json/list 出现 type:"service_worker"，url = chrome-extension://<id>/initBackground.sw.js，
 *      且 <id> == Chrome 对该成品目录算出的 unpacked 扩展 ID（SHA256(路径 UTF-16LE)[:16] → a-p 映射）
 *   ② 在该 SW target 上 Runtime.evaluate 读到 chrome.runtime.getManifest().version / version_name
 *   ③ 捕获到的 stderr 不含 Manifest / Service worker registration failed / SyntaxError
 *   ④ （附加）SW 上下文 3s 内无 Runtime.exceptionThrown
 *
 * Chrome 137+ 命令行 `--load-extension` 已被移除（实测 156 上不生效），脚本做三层降级：
 *   A. --load-extension + --disable-extensions-except
 *   B. A + --disable-features=DisableLoadExtensionCommandLineSwitch
 *   C. --enable-unsafe-extension-debugging + CDP Extensions.loadUnpacked   ← 实测有效
 *
 * 用法: node tools/final-smoke-chrome.mjs [成品目录] [--logtag=NAME] [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = String.raw`D:\AI-Project\逆向统一\acghelper`;
const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const argv = process.argv.slice(2);
const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const KEEP = argv.includes('--keep');
const TREE = path.resolve(argv.find((a) => !a.startsWith('--')) || path.join(ROOT, 'output', 'ACGhelper-2.8.31.16-unlock'));
const TAG = flag('logtag') || 'unlock';
const LOGDIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });
const logFile = (n) => path.join(LOGDIR, `smoke-${TAG}-${n}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome 对 unpacked 扩展的 ID：SHA256(路径 bytes as UTF-16LE)[:16] → 十六进制 → a-p */
function unpackedId(dir) {
  const h = crypto.createHash('sha256').update(Buffer.from(dir, 'utf16le')).digest('hex').slice(0, 32);
  return [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

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
    send(method, params = {}, timeoutMs = 12000) {
      const id = ++seq;
      return opened.then(() => new Promise((res, rej) => {
        const timer = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + method)); }, timeoutMs);
        pending.set(id, { res, rej, timer });
        ws.send(JSON.stringify({ id, method, params }));
      }));
    },
    close() { try { ws.close(); } catch {} },
  };
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}

/** Chrome 加载带 declarative_net_request 的 unpacked 扩展时会在扩展目录写 _metadata/，
 *  属于运行时缓存、不属于交付内容 —— 每次冒烟后清掉，保证成品树与 zip 内容一致。 */
function cleanupTree() {
  const meta = path.join(TREE, '_metadata');
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(meta, { recursive: true, force: true }); break; } catch { /* 文件仍被占用，稍后重试 */ }
  }
  if (fs.existsSync(meta)) console.log(`  [warn] 未能删除运行时缓存 ${meta}`);
  else console.log(`  已清理运行时缓存 ${meta}`);
}

function cleanupProfile(profile) {
  if (KEEP) return;
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    if (!fs.existsSync(profile)) return;
    execFileSync(process.platform === 'win32' ? 'powershell' : 'true',
      process.platform === 'win32'
        ? ['-NoProfile', '-Command', `Start-Sleep -Milliseconds 400`]
        : [], { stdio: 'ignore' });
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    if (!fs.existsSync(profile)) return;
  }
}

async function launch(extraArgs) {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-smoke-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--disable-background-networking', '--disable-component-update',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, ...extraArgs,
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 25000) throw new Error('chrome CDP 25s 未就绪\n' + err);
    try { await httpJson(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(300); }
  }
  return { proc, port, profile, args, get out() { return out; }, get err() { return err; } };
}

const isOurSw = (t, id) => t.type === 'service_worker' && t.url === `chrome-extension://${id}/initBackground.sw.js`;

async function waitSw(ctx, id, timeoutMs) {
  const t0 = Date.now();
  let list = [];
  while (Date.now() - t0 < timeoutMs) {
    try {
      list = await httpJson(`http://127.0.0.1:${ctx.port}/json/list`);
      const sw = list.find((t) => isOurSw(t, id));
      if (sw) return { list, sw };
    } catch {}
    await sleep(500);
  }
  return { list, sw: null };
}

const expectId = flag('expect-id') || unpackedId(TREE);
console.log(`成品目录   : ${TREE}`);
console.log(`Chrome     : ${CHROME}`);
console.log(`期望扩展ID : ${expectId}   ${flag('expect-id') ? '(命令行指定：manifest.key 推导)' : '(SHA256(路径 UTF-16LE)[:16] → a-p)'}`);

const attempts = [];
let win = null;

const STRATEGIES = [
  ['A: --load-extension', [`--load-extension=${TREE}`, `--disable-extensions-except=${TREE}`], false, 9000],
  ['B: A + --disable-features=DisableLoadExtensionCommandLineSwitch',
    [`--load-extension=${TREE}`, `--disable-extensions-except=${TREE}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch'], false, 9000],
  ['C: --enable-unsafe-extension-debugging + CDP Extensions.loadUnpacked',
    ['--enable-unsafe-extension-debugging'], true, 25000],
];

for (const [name, extra, useCdp, wait] of STRATEGIES) {
  console.log(`\n=== 尝试 ${name}`);
  const rec = { name, args: extra, ok: false };
  let ctx;
  try {
    ctx = await launch(extra);
    rec.argsFull = ctx.args;
    if (useCdp) {
      const ver = await httpJson(`http://127.0.0.1:${ctx.port}/json/version`);
      rec.browser = ver.Browser;
      const b = cdp(ver.webSocketDebuggerUrl);
      await b.opened;
      try {
        rec.cdpLoad = await b.send('Extensions.loadUnpacked', { path: TREE }, 15000);
        console.log(`  Extensions.loadUnpacked -> ${JSON.stringify(rec.cdpLoad)}`);
      } catch (e) {
        rec.cdpLoad = 'ERR ' + e.message;
        console.log(`  Extensions.loadUnpacked -> ERR ${e.message}`);
      } finally { b.close(); }
    }
    const id = rec.cdpLoad?.id || expectId;
    const { list, sw } = await waitSw(ctx, id, wait);
    rec.targets = list.map((t) => ({ type: t.type, url: t.url }));
    rec.sw = sw;
    if (!sw) {
      console.log(`  → 未出现 chrome-extension://${id}/initBackground.sw.js 的 service_worker target`);
      attempts.push(rec);
      killTree(ctx.proc.pid);
      cleanupProfile(ctx.profile);
      continue;
    }
    console.log(`  → 命中 SW target: ${sw.url}`);

    // ---- 在 SW 上下文里取 manifest ----
    const c = cdp(sw.webSocketDebuggerUrl);
    await c.opened;
    await c.send('Runtime.enable');
    const ev = await c.send('Runtime.evaluate', {
      expression: `JSON.stringify({version:chrome.runtime.getManifest().version,
        version_name:chrome.runtime.getManifest().version_name,
        name:chrome.runtime.getManifest().name,
        manifest_version:chrome.runtime.getManifest().manifest_version,
        id:chrome.runtime.id, locale:chrome.i18n?.getUILanguage?.()||null,
        hasDownloads:typeof chrome.downloads!=="undefined"})`,
      returnByValue: true, awaitPromise: true,
    });
    rec.manifestRaw = ev.result?.value ?? null;
    rec.exceptionDetails = ev.exceptionDetails || null;
    await sleep(3000);
    rec.exceptionThrown = c.events.filter((e) => e.method === 'Runtime.exceptionThrown').length;
    c.close();

    rec.ok = true;
    rec.port = ctx.port;
    rec.profile = ctx.profile;
    rec.stderr = ctx.err;
    rec.stdout = ctx.out;
    // 原始 JSON 留档
    const rawList = await httpJson(`http://127.0.0.1:${ctx.port}/json/list`);
    fs.writeFileSync(logFile('jsonlist.json'), JSON.stringify(rawList, null, 2), 'utf8');
    fs.writeFileSync(logFile('stderr.txt'), ctx.err || '', 'utf8');
    fs.writeFileSync(logFile('stdout.txt'), ctx.out || '', 'utf8');
    fs.writeFileSync(logFile('cdp-result.json'), JSON.stringify({
      strategy: name, args: ctx.args, port: ctx.port, browserVersion: rec.browser,
      cdpLoad: rec.cdpLoad, expectId, swTarget: sw, manifest: rec.manifestRaw,
      exceptionThrown: rec.exceptionThrown,
    }, null, 2), 'utf8');
    win = rec;
    attempts.push(rec);
    killTree(ctx.proc.pid);
    cleanupProfile(ctx.profile);
    cleanupTree();
    break;
  } catch (e) {
    rec.error = String(e.stack || e.message);
    attempts.push(rec);
    if (ctx) { killTree(ctx.proc.pid); cleanupProfile(ctx.profile); cleanupTree(); }
  }
}

// ---------------------------------------------------------------- 判定
let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${msg}`); };

console.log('\n================ 验收判定 ================');
check(!!win, '① 出现 type="service_worker" 且 url 指向成品目录的 initBackground.sw.js' +
  (win ? `\n        url = ${win.sw.url}\n        id  = ${win.cdpLoad?.id || expectId}（== 路径推导 ID ${expectId}：${(win.cdpLoad?.id || expectId) === expectId}）` : ''));

let mf = null;
if (win?.manifestRaw) { try { mf = JSON.parse(win.manifestRaw); } catch {} }
check(!!mf, `② 扩展上下文读到 manifest：${win?.manifestRaw ?? '(未取到)'}`);
if (mf) {
  check(mf.version === '2.8.31.16', `   version = ${mf.version}（数字段保持 2.8.31.16）`);
  check(mf.version_name === '2.8.31.16(Beta) unlock', `   version_name = ${mf.version_name}`);
  check(mf.manifest_version === 3, `   manifest_version = ${mf.manifest_version}`);
  check(mf.id === (win.cdpLoad?.id || expectId), `   chrome.runtime.id = ${mf.id}`);
}

const errText = win?.stderr || '';
const bad = ['Manifest', 'Service worker registration failed', 'SyntaxError'];
const hits = bad.filter((k) => errText.includes(k));
check(!!win && hits.length === 0,
  `③ stderr 无 ${bad.map((k) => `"${k}"`).join(' / ')} 关键词（stderr ${errText.length} 字节${errText.length ? '' : '，空输出即无错误输出'}）` +
  (hits.length ? `\n        命中: ${hits.join(', ')}` : ''));

check(!!win && win.exceptionThrown === 0, `④ SW 上下文 3s 内 Runtime.exceptionThrown = ${win?.exceptionThrown ?? 'n/a'}（期望 0）`);

console.log(`\nSTRATEGY = ${win ? win.name : 'NONE'}`);
console.log(`SW_URL   = ${win?.sw?.url || '-'}`);
console.log(`SUMMARY  : ${(fail === 0 && win) ? 'PASS' : 'FAIL'} (fail=${fail})`);
process.exit((fail === 0 && win) ? 0 : 1);
