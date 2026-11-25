#!/usr/bin/env node
/**
 * verify-independent-load-r4.mjs —— 独立加载复验（headless Chrome + CDP Extensions.loadUnpacked）
 *
 * r4 版：从 tools/verify-independent-load-53.mjs 复制派生，只把断言里的版本号 r2 → r4，
 * 53 版原文件一个字都没改（改断言串即可复用到后续发布轮）。
 *
 * 与既有 final-smoke-chrome.mjs 无关：本脚本自带一个极简 CDP 客户端。
 * 断言：
 *   1) Extensions.loadUnpacked 成功并返回扩展 id；
 *   2) service worker target 存在（type=service_worker 且 url 以 chrome-extension://<id>/ 开头）；
 *   3) SW 里 chrome.runtime.getManifest().version_name === "2.8.31.16(Beta) unlock r4"；
 *   4) SW 上下文 5 秒内 Runtime.exceptionThrown 计数 === 0；
 *   5) SW 里 Runtime.evaluate('(0,0)') 返回 0（上下文真的可用）。
 *
 * 全程 headless：--headless=new --mute-audio，不创建可见窗口、不出声。
 * 端口 9333（与其它验证脚本错开）、独立临时 profile、跑完 taskkill /T 清进程树 + 删 profile。
 *
 * 用法: node tools/verify-independent-load-53.mjs [--variant sameId] [--port 9333] [--keep]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const getArg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const VARIANT = getArg('--variant', 'sameId');
const PORT = Number(getArg('--port', '9333'));
const KEEP = process.argv.includes('--keep');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROD = path.join(ROOT, 'output',
  VARIANT === 'sameId' ? 'ACGhelper-2.8.31.16-unlock-sameId' : 'ACGhelper-2.8.31.16-unlock');

const raw = [];              // 原始 CDP 帧，最后落盘
let FAILS = 0;
const CHECKS = [];
function check(name, ok, detail = '') {
  CHECKS.push({ name, ok, detail });
  if (!ok) FAILS++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  —— ' + detail : ''}`);
  return ok;
}

// ---------------------------------------------------------------- 极简 CDP 客户端
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      raw.push(msg);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 20000);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('CDP endpoint not ready: ' + url);
}

// ---------------------------------------------------------------- 主流程
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const profile = path.join(os.tmpdir(), `acg-verify-indep-${stamp}`);
const stageDir = path.join(os.tmpdir(), `acg-verify-indep-ext-${stamp}`);

console.log('verify-independent-load-53.mjs');
console.log('chrome   =', CHROME);
console.log('prod     =', PROD);
console.log('variant  =', VARIANT);
console.log('port     =', PORT);
console.log('profile  =', profile);
console.log('mode     = headless (--headless=new --mute-audio)，无可见窗口、无音频');

// 扩展放到纯 ASCII 临时目录，避开中文路径导致 loadUnpacked 失败
fs.mkdirSync(stageDir, { recursive: true });
fs.cpSync(PROD, stageDir, { recursive: true });
fs.mkdirSync(profile, { recursive: true });
console.log('stageDir =', stageDir, '(ASCII 临时副本，源目录只读)');
const manifestOnStage = JSON.parse(fs.readFileSync(path.join(stageDir, 'manifest.json'), 'utf8'));
check('临时副本 manifest 可解析', !!manifestOnStage.version, JSON.stringify(manifestOnStage.version));

const args = [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--mute-audio',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--enable-unsafe-extension-debugging',
  '--enable-logging=stderr',
  '--v=0',
  'about:blank',
];
console.log('spawn:', [CHROME, ...args].join(' '));
const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stderrBuf = '';
child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
const pid = child.pid;
console.log('chrome pid =', pid);

let browser = null;
try {
  const ver = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  console.log('browser:', ver.Browser, '| protocol:', ver['Protocol-Version']);
  check('browser websocket 可用', !!ver.webSocketDebuggerUrl, ver.webSocketDebuggerUrl);
  browser = await CDP.connect(ver.webSocketDebuggerUrl);

  await browser.send('Target.setDiscoverTargets', { discover: true });
  await sleep(300);

  // ---- 1) 加载扩展 ----
  let extId = null;
  try {
    const res = await browser.send('Extensions.loadUnpacked', { path: stageDir });
    extId = res.id;
    console.log('Extensions.loadUnpacked ->', JSON.stringify(res));
    check('Extensions.loadUnpacked 成功返回 id', typeof extId === 'string' && extId.length === 32, extId);
  } catch (e) {
    check('Extensions.loadUnpacked 成功返回 id', false, String(e.message));
  }

  // ---- 2) 等 SW target ----
  let swTarget = null;
  for (let i = 0; i < 60 && !swTarget; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    swTarget = targetInfos.find((t) =>
      (t.type === 'service_worker' || t.type === 'worker') &&
      extId && t.url.startsWith(`chrome-extension://${extId}/`));
    if (!swTarget) await sleep(200);
  }
  if (swTarget) {
    console.log('SW target:', JSON.stringify({ targetId: swTarget.targetId, type: swTarget.type, url: swTarget.url }));
  } else {
    const { targetInfos } = await browser.send('Target.getTargets');
    console.log('targets seen:', JSON.stringify(targetInfos.map((t) => ({ type: t.type, url: t.url })), null, 1));
  }
  check('service worker target 存在', !!swTarget, swTarget ? swTarget.url : 'not found');

  if (swTarget) {
    // ---- 3) attach + Runtime ----
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
    console.log('attached sessionId =', sessionId);
    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Log.enable', {}, sessionId).catch(() => {});

    // 收集 5 秒内的异常
    const t0 = Date.now();
    await sleep(5000);
    const ex = browser.events.filter((e) =>
      e.sessionId === sessionId && (e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')));
    console.log(`5s 内 SW 异常/console.error 事件数 = ${ex.length}`, JSON.stringify(ex).slice(0, 1500));
    check('SW 上下文 5 秒内 Runtime.exceptionThrown === 0',
      ex.filter((e) => e.method === 'Runtime.exceptionThrown').length === 0,
      `${ex.filter((e) => e.method === 'Runtime.exceptionThrown').length} 条`);
    check('SW 上下文 5 秒内 console.error === 0',
      ex.filter((e) => e.method === 'Runtime.consoleAPICalled').length === 0,
      `${ex.filter((e) => e.method === 'Runtime.consoleAPICalled').length} 条`);

    // ---- 4) 无害表达式 ----
    const ev0 = await browser.send('Runtime.evaluate',
      { expression: '(0,0)', returnByValue: true, awaitPromise: false }, sessionId);
    console.log('evaluate (0,0) ->', JSON.stringify(ev0.result));
    check('SW 中 Runtime.evaluate("(0,0)") === 0',
      ev0.result?.value === 0 && !ev0.exceptionDetails, JSON.stringify(ev0.result));

    // ---- 5) version_name ----
    const evv = await browser.send('Runtime.evaluate',
      { expression: 'chrome.runtime.getManifest().version_name', returnByValue: true }, sessionId);
    console.log('evaluate version_name ->', JSON.stringify(evv.result));
    check('SW getManifest().version_name === "2.8.31.16(Beta) unlock r4"',
      evv.result?.value === '2.8.31.16(Beta) unlock r4', JSON.stringify(evv.result?.value));

    // ---- 附加：SW 里验证 mg 补丁与 manifest 其它字段 ----
    const evM = await browser.send('Runtime.evaluate', {
      expression: `(() => {
        const m = chrome.runtime.getManifest();
        return JSON.stringify({version:m.version, mv:m.manifest_version,
          permissions:(m.permissions||[]).length, hasKey:!!m.key});
      })()`, returnByValue: true,
    }, sessionId);
    console.log('evaluate manifest ->', evM.result?.value);
    check('SW 里 chrome.* API 可用（manifest 可读）', typeof evM.result?.value === 'string');

    // ---- 附加：确认 SW 能拿到扩展自身 URL（上下文真实可用，不是空壳） ----
    const evUrl = await browser.send('Runtime.evaluate',
      { expression: 'chrome.runtime.getURL("initBackground.sw.js")', returnByValue: true }, sessionId);
    check('SW 里 getURL 返回 chrome-extension://<id>/initBackground.sw.js',
      typeof evUrl.result?.value === 'string' &&
      evUrl.result.value === `chrome-extension://${extId}/initBackground.sw.js`,
      String(evUrl.result?.value));

    // ---- 附加：headless 自证 —— 本次 Chrome 的所有进程 MainWindowHandle 必须为 0 ----
    const winQuery = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { "$($p.Id):$($p.MainWindowHandle)" } }`;
    const winRes = spawnSync('powershell', ['-NoProfile', '-Command', winQuery], { encoding: 'utf8' });
    const wins = (winRes.stdout || '').split(/\s+/).filter(Boolean);
    console.log('本次 headless chrome 进程 MainWindowHandle:', wins.join(' ') || '(none)');
    check('本次 Chrome 所有进程 MainWindowHandle 均为 0（无可见窗口）',
      wins.length > 0 && wins.every((w) => w.endsWith(':0')), wins.join(' '));
  }
} catch (e) {
  check('加载复验流程无异常', false, String(e && e.stack || e));
  console.log('stderr tail:\n', stderrBuf.slice(-3000));
} finally {
  // ---- 清理：按 PID 树杀进程 + 删临时 profile/stage ----
  console.log('\n---- cleanup ----');
  // Chrome 会把自己 relaunch 成新进程（--user-data-dir 新建时），初始 PID 往往已退出，
  // 所以先按 PID 树杀，再按「命令行里含本次 profile 路径」兜底杀，最后才删目录。
  const kill1 = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
  console.log('taskkill(初始 pid):', (kill1.stdout || '').trim(), (kill1.stderr || '').trim());
  if (browser) browser.close();
  await sleep(500);
  const psQuery = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile}*' -or $_.CommandLine -like '*${stageDir}*' } | ForEach-Object { $_.ProcessId }`;
  const found = spawnSync('powershell', ['-NoProfile', '-Command', psQuery], { encoding: 'utf8' });
  const pids = (found.stdout || '').split(/\s+/).filter((x) => /^\d+$/.test(x));
  console.log('兜底匹配到的残留进程:', pids.join(',') || '(none)');
  for (const p of pids) {
    const k = spawnSync('taskkill', ['/PID', p, '/T', '/F'], { encoding: 'utf8' });
    console.log(`  taskkill /PID ${p} /T /F ->`, (k.stdout || '').trim(), (k.stderr || '').trim());
  }
  await sleep(1200);
  if (!KEEP) {
    for (const d of [profile, stageDir]) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* retry */ }
        if (!fs.existsSync(d)) break;
        await sleep(600);
      }
      console.log(`rm ${d} -> exists=${fs.existsSync(d)}`);
    }
    check('临时 profile 已删除', !fs.existsSync(profile), profile);
    check('ASCII 临时扩展副本已删除', !fs.existsSync(stageDir), stageDir);
  }
  const logPath = path.join(ROOT, 'logs', `verify-independent-cdp-${VARIANT}-${stamp}.json`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify({
    variant: VARIANT, port: PORT, chrome: CHROME, headless: true, muted: true,
    pid, stageDir, profile, startedAt: stamp, checks: CHECKS,
    cdpFrames: raw, chromeStderrTail: stderrBuf.slice(-4000),
  }, null, 1), 'utf8');
  console.log('CDP 原始帧写入:', logPath, `(${raw.length} 帧)`);

  console.log('\n================ 汇总 ================');
  console.log(`检查项=${CHECKS.length}  失败=${FAILS}`);
  console.log('RESULT:', FAILS === 0 ? 'PASS' : `FAIL (${FAILS})`);
  process.exit(FAILS === 0 ? 0 : 1);
}
