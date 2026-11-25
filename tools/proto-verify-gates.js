#!/usr/bin/env node
/**
 * proto-verify-gates.js — 对 patch 前后的门判据做语义翻转验证（纯本地复算，不启动浏览器）。
 *
 * 做法：从 proto-patch-spec.json 读出 old/new 表达式，在给定环境里求值，
 *       断言「补丁前 = 拦截 / 补丁后 = 放行」。全部 PASS 才算这条门真的被打开了。
 *
 * 运行: node tools/proto-verify-gates.js
 */
const fs = require('fs');
const path = require('path');

const specPath = path.join(__dirname, 'proto-patch-spec.json');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const pick = (off) => spec.find((p) => p.offset === off);

function evalExpr(expr, env) {
  const fn = new Function('env', `with(env){ return (${expr}); }`);
  return fn(env);
}
function evalStmt(stmt, env) {
  // 片段形如 if(...)return j();  求值后若未 return 则视为放行；this 绑定到 env（片段里有 this.cache.*）
  const fn = new Function('env', `with(env){ try { ${stmt} } catch (err) { return "THROW:" + err; } return "PROCEED"; }`);
  return fn.call(env, env);
}

const results = [];
function check(name, expectPre, pre, expectPost, post) {
  const ok = JSON.stringify(pre) === JSON.stringify(expectPre) && JSON.stringify(post) === JSON.stringify(expectPost);
  results.push({ name, ok, pre, post, expectPre, expectPost });
}

/* ---- G1: VIP 画质集合（V1） ---- */
{
  const p = pick(35360);
  const pre = evalExpr(p.old.replace(/^_=/, '(').concat(')'), { y: { QN_127: 127, QN_126: 126, QN_125: 125, QN_120: 120, QN_116: 116, QN_112: 112 } });
  const post = evalExpr(p.new.replace(/^_=/, '(').concat(')'), { y: {} });
  check('G1 V1 视频 VIP 画质集合含 120/125/126/127', true, [120, 125, 126, 127].every((q) => pre.includes(q)),
        false, [120, 125, 126, 127].some((q) => post.includes(q)));
}

/* ---- G2: 音频 VIP 集合（V2） ---- */
{
  const p = pick(35418);
  const pre = evalExpr(p.old.replace(/^S=/, '(').concat(')'), { k: { QN_30250: 30250, QN_30251: 30251, QN_30255: 30255 } });
  const post = evalExpr(p.new.replace(/^S=/, '(').concat(')'), { k: {} });
  check('G2 V2 音频 VIP 集合含 30250/30251/30255', true, pre.includes(30251), false, post.includes(30251));
}

/* ---- G3: 高级模式下载主按钮起跑门（V7，line 880） ---- */
{
  const p = pick(73356);
  const mkEnv = (M) => ({ M, V: true, Y: false, G: [], t: false, e: [], j: () => 'PAYMENT' });
  check('G3 V7 非 isBHVIP + videoOnly 点击下载', 'PAYMENT', evalStmt(p.old, mkEnv(false)),
        'PROCEED', evalStmt(p.new, mkEnv(false)));
  check('G3b V7 切片下载(enableSegmentSelector) 非 VIP', 'PAYMENT', evalStmt(p.old, (() => { const e = mkEnv(false); e.t = true; e.e = [1]; return e; })()),
        'PROCEED', evalStmt(p.new, (() => { const e = mkEnv(false); e.t = true; e.e = [1]; return e; })()));
}

/* ---- G4: 高级模式下载按钮 disabled（V8） ---- */
{
  const p = pick(75485);
  const mkEnv = (M) => ({ W: false, U: false, M, L: false, V: true, Y: false, $: false, p: false, y: null, Q: 1 });
  check('G4 V8 非 isBHVIP 时按钮 disabled', true, evalExpr(p.old.replace(/^disabled:/, '(').replace(/,onClick:Q$/, ')'), mkEnv(false)),
        false, evalExpr(p.new.replace(/^disabled:/, '(').replace(/,onClick:Q$/, ')'), mkEnv(false)));
}

/* ---- G5: 高级模式音频级联框 disabled（V9） ---- */
{
  const p = pick(75188);
  const mkEnv = (M) => ({ p: false, _: false, M, U: true });
  check('G5 V9 非 isBHVIP 时音频级联框整体禁用', true, evalExpr(p.old.replace(/^disabled:/, '(').replace(/,status:.*$/, ')'), mkEnv(false)),
        false, evalExpr(p.new.replace(/^disabled:/, '(').replace(/,status:.*$/, ')'), mkEnv(false)));
}

/* ---- G6: 简单模式画质按钮点击门（V10，line 476） ---- */
{
  const p = pick(57574);
  const mkEnv = (z) => ({ V: false, Y: false, z, N: false, $: true, Q: false, j: [1], t: false, e: [1], X: false, p: false });
  check('G6 V10 非 isBHVIP + 仅画面下载', false, evalStmt(p.old, mkEnv(false)),
        'PROCEED', evalStmt(p.new, mkEnv(false)));
}

/* ---- G7: PGC 判定器（V13） ---- */
{
  const p = pick(335546);
  const env = { location: { pathname: '/bangumi/play/ep123456' } };
  check('G7 V13 番剧页 isPGC', true, evalExpr('!!location.pathname.match("/bangumi/play")', env),
        false, evalExpr('!1', env));
}

/* ---- G8: DOWNLOAD_TOO_FREQUENTLY 触发条件（B2/B3） ---- */
{
  const p = pick(28022);
  const mkEnv = (rt, me) => ({ cache: { downloader: { onRateLimited: () => 0 } }, rateLimitedRetryTimes: rt, me, e: { status: 429, retryAfterSeconds: 0 }, c: { DOWNLOAD_TOO_FREQUENTLY: 'E429' } });
  const pre = evalStmt(p.old, mkEnv(4, 3));   // rt=4 > me=3 → 抛错
  const post = evalStmt(p.new, mkEnv(4, 3));  // rt=4 > !1 → 不再抛
  check('G8 B2 429 重试超 3 次抛 DOWNLOAD_TOO_FREQUENTLY', 'THROW:E429', pre, 'PROCEED', post);
}

let fail = 0;
for (const r of results) {
  if (!r.ok) fail++;
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}  pre=${JSON.stringify(r.pre)} post=${JSON.stringify(r.post)}  expect pre=${JSON.stringify(r.expectPre)} post=${JSON.stringify(r.expectPost)}`);
}
console.log(`SUMMARY pass=${results.length - fail} fail=${fail} total=${results.length}`);
process.exit(fail ? 1 : 0);
