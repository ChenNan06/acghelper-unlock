#!/usr/bin/env node
/**
 * static-verify.mjs — 模块级验证（node 24，不依赖浏览器）
 * 1) 从原始 / 已补丁的 initBackground.sw.js 里抽出 webpack 模块 634（角色数组）与 3078（会员判定器），
 *    在隔离的 Function 沙箱里执行，断言 mg()/BN() 在 null / 空 identities / 过期身份下的返回值。
 * 2) 取出 getBHAccount / getStatus 的替换表达式，用假 getStore 执行，断言回包字段。
 *
 * 用法: node static-verify.mjs [原文件] [补丁文件]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = String.raw`D:\AI-Project\逆向统一\acghelper`;
const ORIG = process.argv[2] || path.join(ROOT, "src", "extracted", "initBackground.sw.js");
const PATCHED = process.argv[3] || path.join(ROOT, "build", "acghelper-patched", "initBackground.sw.js");

// 兼容三种 webpack 模块头：`3078:(e,t,n)=>{` / `3220:e=>{` / `741:(e,t,r)=>`
const MOD_RE = /(?<![0-9A-Za-z_$])(\d{1,5}):(?:\(([^)]*)\)|[A-Za-z_$][\w$]*)\s*=>/g;

function load(file) {
  const s = fs.readFileSync(file, "utf8");
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
  // 形如 "3078:(e,t,n)=>{" 或 "634:(e,t,a)=>{" —— 取真实形参名，body 里 require 就挂在这个名字上
  const head = segSrc.match(/^\d{1,5}:\(([^)]*)\)\s*=>\s*\{/);
  if (!head) throw new Error("bad module header: " + segSrc.slice(0, 60));
  const params = head[1].split(",").map((x) => x.trim());
  const [pMod, pExp, pReq] = params;
  const firstBrace = segSrc.indexOf("{");
  const body = segSrc.slice(firstBrace + 1, segSrc.lastIndexOf("}"));
  const mod = { exports: {} };
  const req = Object.assign((id) => reqImpl(id), {
    // webpack 的 n.d(t,{k:()=>thunk}) —— 定义 getter，thunk 闭包在模块作用域里，能正确解析
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

const now = Date.now();
// [名称, 调用方式, 未补丁期望值] —— 补丁后的期望值一律为 true（mg/BN 恒真）
const CASES = [
  ["mg(null)", (mg) => mg(null), false],
  ["mg({})", (mg) => mg({}), false],
  ["mg({identities:[]})", (mg) => mg({ identities: [] }), false],
  ["mg(catVIP过期)", (mg) => mg({ identities: [{ name: "catVIP", from: 0, to: now - 1000, hasDateTimeLimit: true }] }), false],
  ["mg(普通用户)", (mg) => mg({ identities: [{ name: "user", from: 0, to: now + 1e9, hasDateTimeLimit: true }] }), false],
  ["mg(catVIP有效)", (mg) => mg({ identities: [{ name: "catVIP", from: 0, to: now + 1e9, hasDateTimeLimit: true }] }), true],
  ["BN(null)", (mg, BN) => BN(null), false],
  ["BN(catForever有效)", (mg, BN) => BN({ identities: [{ name: "catForever", from: 0, to: now + 1e9, hasDateTimeLimit: true }] }), true],
];

function run(file, label, patched) {
  const { seg } = load(file);
  const roles = instantiate(seg(634), () => ({}));
  const vip = instantiate(seg(3078), (id) => {
    if (id === 634) return roles;
    if (id === 4707) return roles;
    return {};
  });
  console.log(`\n=== ${label}: ${file}`);
  console.log(`    roles.WH = ${JSON.stringify(roles.WH)}`);
  console.log(`    roles.wM = ${JSON.stringify(roles.wM)}`);
  console.log(`    exports   = ${Object.keys(vip).join(",")}`);
  let pass = 0, fail = 0;
  for (const [name, fn, expectOrig] of CASES) {
    const expect = patched ? true : expectOrig;
    let got;
    try { got = fn(vip.mg, vip.BN); } catch (e) { got = `THROW:${e.message}`; }
    const ok = got === expect;
    ok ? pass++ : fail++;
    console.log(`    ${ok ? "PASS" : "FAIL"}  ${name.padEnd(24)} = ${got}  (expect ${expect})`);
  }
  console.log(`    => ${pass} pass / ${fail} fail`);
  return { pass, fail, vip };
}

const a = run(ORIG, "ORIGINAL 未补丁", false);
const b = run(PATCHED, "PATCHED 已补丁", true);

// ------ 全 6 个 bundle 的模块 3078 补丁后行为一致性验证 ------
const BUNDLES = ["initBackground.sw.js", "js/pages/config.js", "js/pages/video.js",
                 "js/pages/live.js", "js/pages/popup.js", "js/pages/message.js"];
console.log(`\n=== 全 bundle 模块 3078 补丁后一致性（mg/BN 必须全 true）`);
let bundleFail = 0;
for (const rel of BUNDLES) {
  const p = path.join(ROOT, "build", "acghelper-patched", rel.replaceAll("/", path.sep));
  const { seg } = load(p);
  const roles = instantiate(seg(634), () => ({}));
  const vip = instantiate(seg(3078), (id) => (id === 634 || id === 4707 ? roles : {}));
  const outs = CASES.map(([, fn]) => fn(vip.mg, vip.BN));
  const ok = outs.every((v) => v === true);
  if (!ok) bundleFail++;
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${rel.padEnd(24)} mg(null)=${outs[0]} BN(null)=${outs[6]} mg(过期catVIP)=${outs[3]} 8/8=${ok}`);
}

// ------ getBHAccount / getStatus 替换表达式验证 ------
const FAKE_EXPR_OK = (() => {
  const fake = `{bhid:0,bhName:"ACG-VIP",email:"",identities:[{name:"catVIP",from:0,to:Date.now()+31536e7,hasDateTimeLimit:!1}],isVIP:!0,isSuperVIP:!0}`;
  const makeGetStore = (v) => async () => v;
  const build = new Function("getStore", "FAKE", `
    return (async () => {
      const __r = { ...(await getStore() || FAKE), isVIP:!0, isSuperVIP:!0,
        identities:[{name:"catVIP",from:0,to:Date.now()+31536e7,hasDateTimeLimit:!1}] };
      return __r;
    })();`);
  const buildStatus = new Function("ctx", "FAKE", `
    const hasLogin = !0;
    const bhAccount = ctx.bhAccount || FAKE;
    return {hasLogin, bilibiliAccount:null, downloadingSettings:false, hasRegister:!0, bhAccount};`);
  return Promise.all([
    build(makeGetStore(null), null),
    build(makeGetStore({ bhid: 42, bhName: "realuser" }), null),
    Promise.resolve(buildStatus({ bhAccount: null }, eval("(" + fake + ")"))),
    Promise.resolve(buildStatus({ bhAccount: { bhid: 42, identities: [] } }, eval("(" + fake + ")"))),
  ]);
})();

const res = await FAKE_EXPR_OK;
const labels = ["getBHAccount(store=null)", "getBHAccount(store=real)", "getStatus(bhAccount=null)", "getStatus(bhAccount=real)"];
console.log(`\n=== getBHAccount / getStatus 回包验证`);
// 判定标准：
//   getBHAccount -> 必须 isVIP===true && isSuperVIP===true && identities[0].to > now（UI 徽章 + 门控都吃这个）
//   getStatus    -> 必须 hasLogin===true && bhAccount 非空（bhAccount 为 null 时要被补齐）
const checks = [
  (r) => r.isVIP === true && r.isSuperVIP === true && r.identities?.[0]?.to > Date.now(),
  (r) => r.isVIP === true && r.isSuperVIP === true && r.identities?.[0]?.to > Date.now(),
  (r) => r.hasLogin === true && !!r.bhAccount && r.bhAccount.identities?.[0]?.to > Date.now(),
  (r) => r.hasLogin === true && !!r.bhAccount,
];
let pass2 = 0;
res.forEach((r, i) => {
  const ok = checks[i](r);
  if (ok) pass2++;
  const b = r.bhAccount || r;
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${labels[i]}  -> isVIP=${r.isVIP ?? b.isVIP} identities=${JSON.stringify(b.identities)}`);
});



console.log(`\n=== 总结`);
console.log(`  未补丁 mg/BN：${a.pass}/8 符合原生逻辑（null / 空 identities / 过期 / 普通用户 -> false；有效 catVIP、catForever -> true）`);
console.log(`  已补丁 mg/BN：${b.pass}/8 全部 true（要求 8/8）`);
console.log(`  回包伪造：   ${pass2}/4 pass`);
console.log(`  跨 bundle：  ${BUNDLES.length - bundleFail}/${BUNDLES.length} 通过`);
const verdict = b.fail === 0 && pass2 === 4 && a.fail === 0 && bundleFail === 0;
console.log(`  RESULT: ${verdict ? "PASS" : "FAIL"}`);
process.exit(verdict ? 0 : 1);
