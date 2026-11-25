#!/usr/bin/env node
/**
 * verify-independent-semantics.mjs —— 独立语义复跑（NO 依赖 static-verify.mjs / proto-verify-gates.js）
 *
 * 做法：
 *  1) 从成品树里按 webpack 模块 id 切出模块 3078（mg/BN 定义），用自建的 mini-require 求值；
 *  2) 从成品树里**原样切出** getStatus / getBHAccount 两个 listener 的箭头函数源码，
 *     用 mock 的 `this` 直接调用，检查回包对象；
 *  3) 同样的 8 组输入同时跑 pristine 版本，证明「补丁确实改变了语义」（而不是原来的代码本来就 true）。
 *
 * 用法: node tools/verify-independent-semantics.mjs [--variant unlock|sameId]
 * 退出码 0=PASS 1=FAIL
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const argVariant = (() => {
  const i = process.argv.indexOf('--variant');
  return i > 0 ? process.argv[i + 1] : 'unlock';
})();
const PROD = path.join(ROOT, 'output', `ACGhelper-2.8.31.16-${argVariant}`);
const PRISTINE = path.join(ROOT, 'src', 'extracted');

let FAILS = 0;
let CHECKS = 0;
function check(name, ok, detail = '') {
  CHECKS++;
  if (!ok) FAILS++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  —— ' + detail : ''}`);
  return ok;
}

// ---------------------------------------------------------------- 工具
/** 从 src 的 startIdx（指向 '(' 或 '{'）开始做括号匹配，返回配对字符的下标 */
function matchBracket(src, startIdx) {
  const open = src[startIdx];
  const close = open === '(' ? ')' : open === '{' ? '}' : null;
  if (!close) throw new Error('bad bracket start: ' + open);
  let depth = 0;
  let inStr = null;
  let inTpl = 0;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inTpl = inTpl ? 0 : 1; continue; }
    if (inTpl) continue;
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced');
}

/** 切出 `id:(e,t,n)=>{...}` 模块源码（含箭头函数本身） */
function extractModule(src, id) {
  const needle = `${id}:(`;
  const at = src.indexOf(needle);
  if (at < 0) throw new Error(`module ${id} not found`);
  const bodyStart = src.indexOf('=>', at);
  const braceStart = src.indexOf('{', bodyStart);
  const end = matchBracket(src, braceStart);
  return src.slice(at + needle.length - 1, end + 1); // 从 '(' 开始
}

/** 切出 addListener("name", <expr>) 里的 <expr> 源码 */
function extractListener(src, name) {
  const at = src.indexOf(`addListener("${name}",`);
  if (at < 0) throw new Error(`listener ${name} not found`);
  const exprStart = src.indexOf('(', at + `addListener("${name}",`.length);
  const end = matchBracket(src, exprStart);
  return src.slice(exprStart, end + 1);
}

/** 用 mini webpack require 求值一个模块，返回 exports */
function loadModule(src, id, stubs) {
  const moduleSrc = extractModule(src, id);
  const fn = new Function('return ' + moduleSrc)();
  const exp = {};
  const req = (dep) => {
    if (!(dep in stubs)) throw new Error(`unexpected require(${dep}) in module ${id}`);
    return stubs[dep];
  };
  req.d = (target, map) => {
    for (const [k, getter] of Object.entries(map)) {
      Object.defineProperty(target, k, { get: getter, enumerable: true, configurable: true });
    }
  };
  fn(exp, exp, req) === undefined; // 模块箭头函数返回 undefined，exports 挂在 exp 上
  return exp;
}

// ---------------------------------------------------------------- 8 组输入
const NOW = Date.now();
const FOREVER = NOW + 31536e7; // 100 年
export const CASES = [
  ['null', null],
  ['{}', {}],
  ['identities:[]', { identities: [] }],
  ['过期 catVIP (hasDateTimeLimit:true, to=昨天)', {
    bhid: 1, identities: [{ name: 'catVIP', from: 0, to: NOW - 86400000, hasDateTimeLimit: true }],
  }],
  ['catVIP hasDateTimeLimit:false (永久)', {
    bhid: 2, identities: [{ name: 'catVIP', from: 0, to: NOW - 86400000, hasDateTimeLimit: false }],
  }],
  ['普通用户 user', {
    bhid: 3, identities: [{ name: 'user', from: 0, to: FOREVER, hasDateTimeLimit: true }],
  }],
  ['有效 catForever', {
    bhid: 4, identities: [{ name: 'catForever', from: 0, to: FOREVER, hasDateTimeLimit: true }],
  }],
  ['superAdmin 永久', {
    bhid: 5, identities: [{ name: 'superAdmin', from: 0, to: 0, hasDateTimeLimit: false }],
  }],
];

// mg/BN 依赖的 module 4707 -> 634 的两个白名单
const WH = ['superAdmin', 'admin', 'catForever', 'catVIP'];
const WM = ['superAdmin', 'admin', 'catForever'];
const STUBS = {
  4707: { WH, wM: WM, Xy: {} },
  5093: {},
};

function evalMgBn(file, label) {
  const src = fs.readFileSync(file, 'utf8');
  const m = loadModule(src, 3078, STUBS);
  const rows = CASES.map(([name, input]) => {
    let mg, bn, err = null;
    try { mg = m.mg(input); } catch (e) { err = String(e); mg = 'THROW'; }
    try { bn = m.BN(input); } catch (e) { err = String(e); bn = 'THROW'; }
    return { name, mg, bn, err };
  });
  console.log(`\n---- [${label}] module 3078 mg()/BN() ----`);
  for (const r of rows) {
    console.log(`   ${r.name.padEnd(42)} mg=${String(r.mg).padEnd(6)} BN=${String(r.bn).padEnd(6)}${r.err ? ' ERR=' + r.err : ''}`);
  }
  return rows;
}

// ---------------------------------------------------------------- 主流程
console.log('verify-independent-semantics.mjs');
console.log('variant =', argVariant);
console.log('PROD    =', PROD);
console.log('PRISTINE=', PRISTINE);
console.log('node    =', process.version);

const swProd = path.join(PROD, 'initBackground.sw.js');
const swPris = path.join(PRISTINE, 'initBackground.sw.js');

// === 1) mg / BN 8 组输入 ===
const prodRows = evalMgBn(swProd, 'PRODUCT');
const prisRows = evalMgBn(swPris, 'PRISTINE');

console.log('\n---- 断言：成品 mg/BN 8 组输入全 true ----');
for (const r of prodRows) {
  check(`mg(${r.name}) === true`, r.mg === true, `got ${String(r.mg)}${r.err ? ' err=' + r.err : ''}`);
  check(`BN(${r.name}) === true`, r.bn === true, `got ${String(r.bn)}${r.err ? ' err=' + r.err : ''}`);
}
console.log('\n---- 对照：pristine 应该是部分 false（证明补丁真的改了语义） ----');
const prisFalse = prisRows.filter((r) => r.mg === false).length;
check('pristine mg 至少有 3 组为 false（否则补丁无意义/自测无效）', prisFalse >= 3, `false 组数=${prisFalse}`);
for (const r of prisRows) {
  console.log(`   ${r.name.padEnd(42)} pristine mg=${r.mg} BN=${r.bn}`);
}

// === 2) getStatus / getBHAccount 回包 ===
console.log('\n---- getStatus / getBHAccount 回包路径 ----');
const prodSrc = fs.readFileSync(swProd, 'utf8');
const statusSrc = extractListener(prodSrc, 'getStatus');
const bhSrc = extractListener(prodSrc, 'getBHAccount');
console.log('getStatus  源码:', statusSrc.length, 'bytes');
console.log('getBHAccount 源码:', bhSrc.length, 'bytes');

// 关键：这两个 handler 是**箭头函数**，this 是词法绑定的，
// 必须在外层 Function 里求值并 .call(ctx) 才能把 this 变成「被 mock 的控制器实例」。
const statusFactory = new Function('return ' + statusSrc);
const bhFactory = new Function('return ' + bhSrc);
const makeStatus = (ctx) => statusFactory.call(ctx);
const makeBH = (ctx) => bhFactory.call(ctx);

const REAL_NON_VIP = {
  bhid: 12345, bhName: 'real-user', email: 'real@example.com',
  identities: [{ name: 'user', from: 0, to: FOREVER, hasDateTimeLimit: true }],
  isVIP: false, isSuperVIP: false,
};
const REAL_VIP = {
  bhid: 999, bhName: 'real-vip', email: 'vip@example.com',
  identities: [{ name: 'catVIP', from: 0, to: FOREVER, hasDateTimeLimit: true }],
  isVIP: true, isSuperVIP: false,
};

const getStatus = statusFactory;   // 仅用于占位，实际调用见 makeStatus
const getBHAccount = bhFactory;

function makeCtx(over) {
  return {
    accountDataInitialized: true,
    bilibiliAccount: null,
    downloadingSettings: false,
    bhAccount: null,
    store: null,
    async getStore() { return this.store; },
    ...over,
  };
}

async function callStatus(ctx) {
  const fn = makeStatus(ctx);
  return await new Promise((resolve) => {
    const r = fn({}, {}, (v) => resolve(v));
    if (r !== undefined && r !== true) resolve(r);
  });
}
async function callBH(ctx) {
  const fn = makeBH(ctx);
  return await new Promise((resolve) => {
    fn({}, {}, (v) => resolve(v));
  });
}

const statusNull = await callStatus(makeCtx({ bhAccount: null }));
const statusRealNonVip = await callStatus(makeCtx({ bhAccount: { ...REAL_NON_VIP } }));
const statusRealVip = await callStatus(makeCtx({ bhAccount: { ...REAL_VIP } }));
const statusNotInited = await callStatus(makeCtx({ accountDataInitialized: false }));

const bhStoreNull = await callBH(makeCtx({ store: null }));
const bhStoreRealNonVip = await callBH(makeCtx({ store: { ...REAL_NON_VIP } }));
const bhStoreRealVip = await callBH(makeCtx({ store: { ...REAL_VIP } }));

const show = (label, o) => {
  if (o === null || o === undefined) return console.log(`   ${label}: ${o}`);
  console.log(`   ${label}: hasLogin=${o.hasLogin} hasRegister=${o.hasRegister} ` +
    `bhAccount=${o.bhAccount ? `{isVIP:${o.bhAccount.isVIP},isSuperVIP:${o.bhAccount.isSuperVIP},identities:${o.bhAccount.identities?.length ?? 'none'}}` : o.bhAccount}`);
};
console.log('\n getStatus:');
show('bhAccount=null        ', statusNull);
show('bhAccount=真实非会员  ', statusRealNonVip);
show('bhAccount=真实会员    ', statusRealVip);
show('accountDataInitialized=false', statusNotInited);
console.log('\n getBHAccount:');
show('store=null            ', bhStoreNull);
show('store=真实非会员      ', bhStoreRealNonVip);
show('store=真实会员        ', bhStoreRealVip);

console.log('\n---- 断言 getStatus ----');
check('getStatus(bhAccount=null) 回包非 null', statusNull !== null);
check('getStatus(bhAccount=null).bhAccount.isVIP === true', statusNull?.bhAccount?.isVIP === true);
check('getStatus(bhAccount=null).hasLogin === true', statusNull?.hasLogin === true);
check('getStatus(bhAccount=null).bhAccount.identities 非空', (statusNull?.bhAccount?.identities?.length ?? 0) > 0);
check('getStatus(bhAccount=null) 的合成对象能通过 mg()', (() => {
  const m = loadModule(prodSrc, 3078, STUBS);
  return m.mg(statusNull.bhAccount) === true && m.BN(statusNull.bhAccount) === true;
})());
// 关键：真实非会员账号时 getStatus 不强制 isVIP
const statusForcesVipOnReal = statusRealNonVip?.bhAccount?.isVIP === true;
check('getStatus(bhAccount=真实非会员).bhAccount.isVIP === true（声明要求）', statusForcesVipOnReal,
  statusForcesVipOnReal ? '' : '实际为 false —— 见报告中「风险 R-STATUS」');

console.log('\n---- 断言 getBHAccount ----');
for (const [label, o] of [['store=null', bhStoreNull], ['store=真实非会员', bhStoreRealNonVip], ['store=真实会员', bhStoreRealVip]]) {
  check(`getBHAccount(${label}).isVIP === true`, o?.isVIP === true);
  check(`getBHAccount(${label}).isSuperVIP === true`, o?.isSuperVIP === true);
  check(`getBHAccount(${label}).identities 非空`, (o?.identities?.length ?? 0) > 0);
  check(`getBHAccount(${label}).identities[0].name === 'catVIP'`, o?.identities?.[0]?.name === 'catVIP');
}

// === 3) 其他页面的 mg 拷贝也必须是恒真 ===
console.log('\n---- 其他 bundle 的模块 3078 拷贝（mg 恒真） ----');
const OTHER = ['js/pages/video.js', 'js/pages/config.js', 'js/pages/live.js', 'js/pages/message.js', 'js/pages/popup.js'];
for (const rel of OTHER) {
  const f = path.join(PROD, rel);
  const src = fs.readFileSync(f, 'utf8');
  let rows = null, err = null;
  try { rows = evalMgBnShort(src); } catch (e) { err = String(e); }
  if (err) { check(`${rel} 模块 3078 可求值`, false, err); continue; }
  const allTrue = rows.every((r) => r.mg === true && r.bn === true);
  check(`${rel} 模块 3078 mg/BN 8 组输入全 true`, allTrue,
    allTrue ? '' : JSON.stringify(rows.filter((r) => r.mg !== true || r.bn !== true)));
  function evalMgBnShort(s) {
    // 每个 bundle 的 3078 依赖模块 id 不同，这里只给 4707/5093 两个最常见依赖；找不到就试 634
    const stubs = { 4707: { WH, wM: WM, Xy: {} }, 5093: {}, 634: { WH, wM: WM }, 1965: {} };
    const m = loadModule(s, 3078, stubs);
    return CASES.map(([name, input]) => ({ name, mg: m.mg(input), bn: m.BN(input) }));
  }
}

console.log('\n================ 汇总 ================');
console.log(`检查项=${CHECKS}  失败=${FAILS}`);
console.log('RESULT:', FAILS === 0 ? 'PASS' : `FAIL (${FAILS})`);
process.exit(FAILS === 0 ? 0 : 1);
