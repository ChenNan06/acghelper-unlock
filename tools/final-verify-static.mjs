#!/usr/bin/env node
/**
 * final-verify-static.mjs —— 对**成品树**做模块级语义验证（node 24，不启动浏览器）
 *
 * 与 tools/static-verify.mjs 同一套模块抽取/沙箱执行思路，区别是：
 *   * 路径来自命令行（默认 output/ACGhelper-2.8.31.16-unlock），不再写死 build/acghelper-patched
 *   * 6 个 bundle 全部覆盖，逐 bundle 断言 4 类输入 × mg/BN 全 true
 *   * getBHAccount / getStatus 的回包**从成品树里实时抽取表达式**求值（不是照抄常量）
 *   * 额外断言 B1/B1b 插入的 await 位于 async 方法体内
 *
 * 用法: node tools/final-verify-static.mjs [成品目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = String.raw`D:\AI-Project\逆向统一\acghelper`;
const TREE = path.resolve(process.argv[2] || path.join(ROOT, 'output', 'ACGhelper-2.8.31.16-unlock'));

const VIP_BUNDLES = [
  'initBackground.sw.js',
  'js/pages/config.js',
  'js/pages/video.js',
  'js/pages/live.js',
  'js/pages/popup.js',
  'js/pages/message.js',
];

const MOD_RE = /(?<![0-9A-Za-z_$])(\d{1,5}):(?:\(([^)]*)\)|[A-Za-z_$][\w$]*)\s*=>/g;

const read = (p) => fs.readFileSync(p, 'utf8');
const at = (rel) => path.join(TREE, rel.split('/').join(path.sep));

function load(file) {
  const s = read(file);
  const hits = [...s.matchAll(MOD_RE)].map((m) => ({ id: Number(m[1]), off: m.index }));
  hits.sort((a, b) => a.off - b.off);
  const seg = (id) => {
    const i = hits.findIndex((h) => h.id === id);
    if (i < 0) throw new Error(`module ${id} not found in ${file}`);
    const end = i + 1 < hits.length ? hits[i + 1].off : s.length;
    return s.slice(hits[i].off, end);
  };
  return { src: s, seg };
}

function instantiate(segSrc, reqImpl) {
  const head = segSrc.match(/^\d{1,5}:\(([^)]*)\)\s*=>\s*\{/);
  if (!head) throw new Error('bad module header: ' + segSrc.slice(0, 60));
  const [pMod, pExp, pReq] = head[1].split(',').map((x) => x.trim());
  const body = segSrc.slice(segSrc.indexOf('{') + 1, segSrc.lastIndexOf('}'));
  const mod = { exports: {} };
  const req = Object.assign((id) => reqImpl(id), {
    d(exp, spec) {
      for (const k of Object.keys(spec)) {
        Object.defineProperty(exp, k, { get: spec[k], enumerable: true, configurable: true });
      }
    },
    r() {}, n() { return () => {}; }, g: globalThis,
  });
  const fn = new Function(pMod, pExp, pReq, body);
  fn(mod, mod.exports, req);
  return mod.exports;
}

/** 从 openIdx 处的括号开始，返回配对括号包住的那段源码（跳过字符串内的括号） */
function sliceBalanced(s, openIdx) {
  const open = s[openIdx];
  const close = open === '{' ? '}' : ')';
  let depth = 0, q = null, esc = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return s.slice(openIdx, i + 1);
  }
  throw new Error('unbalanced brace at ' + openIdx);
}

let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

console.log(`成品树: ${TREE}`);

// ---------------------------------------------------------------- [1] mg/BN
console.log(`\n=== [1] 6 bundle 模块 3078：4 类输入 × mg/BN 必须全 true`);
const now = Date.now();
const INPUTS = [
  ['未登录', null],
  ['空identities', { identities: [] }],
  ['过期catVIP', { identities: [{ name: 'catVIP', from: 0, to: now - 1000, hasDateTimeLimit: true }] }],
  ['普通用户', { identities: [{ name: 'user', from: 0, to: now + 1e9, hasDateTimeLimit: true }] }],
];
let bundleOk = 0;
for (const rel of VIP_BUNDLES) {
  try {
    const { seg } = load(at(rel));
    const roles = instantiate(seg(634), () => ({}));
    const vip = instantiate(seg(3078), (id) => (id === 634 || id === 4707 ? roles : {}));
    const rows = INPUTS.map(([name, acc]) => ({ name, a: vip.mg(acc), b: vip.BN(acc) }));
    const ok = rows.every((r) => r.a === true && r.b === true);
    if (ok) bundleOk++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${rel.padEnd(24)} ` +
      rows.map((r) => `${r.name}(mg=${r.a},BN=${r.b})`).join(' '));
  } catch (e) {
    console.log(`  FAIL  ${rel.padEnd(24)} THROW ${e.message}`);
    fail++;
  }
}
console.log(`  → ${bundleOk}/${VIP_BUNDLES.length} bundle 通过`);

// ---------------------------------------------------------------- [2] getBHAccount
console.log(`\n=== [2] 成品树 getBHAccount 回包（表达式从树里实时抽取并求值）`);
const sw = read(at('initBackground.sw.js'));
const anchor = '(async(e,t,n)=>{n({...(await this.getStore("default")';
const ai = sw.indexOf(anchor);
check(ai > 0, `存在 getBHAccount 补丁锚点 @${ai}`);
if (ai > 0) {
  const objLit = sliceBalanced(sw, sw.indexOf('{...(await this.getStore', ai));
  console.log(`  抽取表达式（前 150 字符）: ${objLit.slice(0, 150)}…`);
  const run = (storeVal) => {
    const fn = new Function(`return (async () => (${objLit}))();`);
    return fn.call({ getStore: async () => storeVal });
  };
  for (const [label, v] of [['store=null', null], ['store=real', { bhid: 42, bhName: 'realuser', identities: [] }]]) {
    const r = await run(v);
    check(r?.isVIP === true && r?.isSuperVIP === true && r?.identities?.[0]?.to > Date.now(),
      `getBHAccount(${label}) -> isVIP=${r?.isVIP} isSuperVIP=${r?.isSuperVIP} ` +
      `identities[0].to>now=${r?.identities?.[0]?.to > Date.now()}`);
  }
}

// ---------------------------------------------------------------- [3] getStatus
console.log(`\n=== [3] 成品树 getStatus 回包（hasLogin / bhAccount 必须非空；VIP 语义走 mg()）`);
const gi = sw.indexOf('return n({hasLogin:!0,');
check(gi > 0, `存在 getStatus 补丁锚点 @${gi}`);
if (gi > 0) {
  const objLit = sliceBalanced(sw, sw.indexOf('{', gi + 'return n('.length));
  console.log(`  抽取表达式（前 150 字符）: ${objLit.slice(0, 150)}…`);
  const mk = (bhAccount) => {
    const fn = new Function('bhAccount', `
      const self = { bhAccount, bilibiliAccount: null, downloadingSettings: false };
      return (${objLit.replace(/this\./g, 'self.')});`);
    return fn(bhAccount);
  };
  // VIP 语义断言用同一棵树里的模块 3078（S08 不注入顶层 isVIP，下游门控吃的是 mg(bhAccount)）
  const { seg } = load(at('initBackground.sw.js'));
  const roles = instantiate(seg(634), () => ({}));
  const vip3 = instantiate(seg(3078), (id) => (id === 634 || id === 4707 ? roles : {}));

  const r0 = mk(null);
  check(r0.hasLogin === true && r0.hasRegister === true && !!r0.bhAccount &&
        r0.bhAccount.isVIP === true && r0.bhAccount.isSuperVIP === true &&
        r0.bhAccount.identities?.[0]?.to > Date.now(),
    `getStatus(bhAccount=null) -> hasLogin=${r0.hasLogin} hasRegister=${r0.hasRegister} ` +
    `bhAccount.isVIP=${r0.bhAccount?.isVIP} bhAccount.isSuperVIP=${r0.bhAccount?.isSuperVIP} ` +
    `identities[0].to>now=${r0.bhAccount?.identities?.[0]?.to > Date.now()}`);

  const r1 = mk({ bhid: 7, identities: [] });
  check(r1.hasLogin === true && !!r1.bhAccount && vip3.mg(r1.bhAccount) === true && vip3.BN(r1.bhAccount) === true,
    `getStatus(bhAccount=real) -> hasLogin=${r1.hasLogin} bhAccount 原样透传=非空 ` +
    `mg(bhAccount)=${vip3.mg(r1.bhAccount)} BN(bhAccount)=${vip3.BN(r1.bhAccount)}（期望 true/true）`);
  // X4：真实账号（非会员数据源）也必须回 isVIP/isSuperVIP=true —— 两条出口口径一致
  check(r1.bhAccount.isVIP === true && r1.bhAccount.isSuperVIP === true && r1.bhAccount.bhid === 7,
    `X4 getStatus(bhAccount=真实非会员).bhAccount.isVIP=${r1.bhAccount.isVIP} ` +
    `isSuperVIP=${r1.bhAccount.isSuperVIP} bhid=${r1.bhAccount.bhid}（期望 true/true/7 —— 透传原字段 + 强制会员位）`);
}

// ---------------------------------------------------------------- [4] async 上下文
console.log(`\n=== [4] B1/B1b 插入的 await 必须位于 async 方法内`);
const bg = read(at('js/pages/background.js'));
const nA = (bg.match(/await this\.fetchBasicDownloadInfo\(/g) || []).length;
check(nA === 2, `background.js 中 await this.fetchBasicDownloadInfo 出现 ${nA} 次（期望 2）`);
check(/async init\(\)\{[\s\S]{0,2000}?await this\.fetchBasicDownloadInfo/.test(bg),
  'B1 位于 async init() 内（否则 node --check 会报 SyntaxError）');
check(/async refreshBasicDownloadInfo\(\)\{[\s\S]{0,2000}?await this\.fetchBasicDownloadInfo/.test(bg),
  'B1b 位于 async refreshBasicDownloadInfo() 内');

console.log(`\n=== 总结: ${fail === 0 ? 'PASS' : 'FAIL'} (fail=${fail})`);
process.exit(fail === 0 ? 0 : 1);
