#!/usr/bin/env node
/**
 * final-verify-gates.js —— 对**成品树**做下载链路门锁断言（纯文本/语义，不启动浏览器）
 *
 * 三道保险（对应 38 条补丁 = static 10 + proto 23 + extra 5）：
 *   [A] 规格语义复算：直接跑 tools/proto-verify-gates.js（补丁前后门判据翻转）
 *   [B] 成品树断言：23 条协议补丁的 old 必须全部消失、new 必须全部出现；
 *       V1 画质集合必须为空、V13 PGC 判定器必须恒 false、
 *       NOT_SUPPORT_PGC_CONTENT 必须无抛出点 → 「根据站方要求无法继续提供PGC内容下载」分支不可达
 *   [B5/B6] 可选补丁状态（B5 未打）+ extra 阶段 X1..X5 的 old 消失/new 出现，
 *       外加 X1/X5 两处 ep_id、X2/X3 两处 `>=8` 上限、X4 getStatus 出口一致
 *
 * 用法: node tools/final-verify-gates.js [成品目录]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = String.raw`D:\AI-Project\逆向统一\acghelper`;
const TREE = path.resolve(process.argv[2] || path.join(ROOT, 'output', 'ACGhelper-2.8.31.16-unlock'));
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'proto-patch-spec.json'), 'utf8'));
const extraSpec = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'extra-patch-spec.json'), 'utf8')).patches;
const read = (rel) => fs.readFileSync(path.join(TREE, rel.split('/').join(path.sep)), 'utf8');

let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${msg}`); };

// ---------------------------------------------------------------- A. 规格语义复算
console.log('=== [A] 规格语义复算（tools/proto-verify-gates.js）');
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'proto-verify-gates.js')],
    { encoding: 'utf8' });
  process.stdout.write(out.split('\n').map((l) => '    ' + l).join('\n').replace(/\n+$/, '') + '\n');
} catch (e) {
  console.log(String(e.stdout || e.message));
  fail++;
}

// ---------------------------------------------------------------- B. 成品树断言
console.log('\n=== [B] 成品树逐条断言（23 条协议补丁：old 全消失 / new 全出现）');
// 补丁可以**串联**：extra 阶段的 X2/X3 改写的正是 B2/B3 刚写入的尾巴（X2.old 与 B2.new 尾部重叠
// `,!1)throw c.DOWNLOAD_TOO_FREQUENTLY;`）。所以「new 出现」要按**串联终态**判定，否则会误判 FAIL。
function maxOverlapSuffixPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  for (let k = n; k >= 8; k--) if (a.slice(a.length - k) === b.slice(0, k)) return k;
  return 0;   // 重叠 >=8 字符才算「同一条语句被续写」，1~2 个标点的偶合不算
}
function composeOverlap(txt) {
  let cur = txt;
  const used = [];
  for (let guard = 0; guard < 8; guard++) {
    let hit = false;
    for (const p of extraSpec) {
      const k = maxOverlapSuffixPrefix(cur, p.old);
      if (k > 0) { cur = cur.slice(0, cur.length - k) + p.new; used.push(p.id); hit = true; break; }
      if (cur.includes(p.old)) { cur = cur.split(p.old).join(p.new); used.push(p.id); hit = true; break; }
    }
    if (!hit) break;
  }
  return { text: cur, used };
}
const cache = {};
const get = (f) => (cache[f] = cache[f] || read(f));
for (const p of spec) {
  const s = get(p.file);
  const cOld = s.split(p.old).length - 1;
  let { text: finalNew, used } = composeOverlap(p.new);
  let cNew = s.split(finalNew).length - 1;
  if (cNew === 0 && used.length) {         // 组合结果不存在 → 说明没有串联，回退原 new
    finalNew = p.new;
    used = [];
    cNew = s.split(finalNew).length - 1;
  }
  // 同一 new 可能被多条补丁共用（V5b/V7 都是 onClick:()=>!0），new 只要求 >=1
  const ok = cOld === 0 && cNew >= 1;
  if (!ok) fail++;
  const tag = used.length ? `（串联终态：${used.join('+')} 改写其后）` : '';
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${String(p.offset).padStart(6)} ${p.file.padEnd(26)} ` +
    `old×${cOld} (期望 0)  new×${cNew} (期望 ≥1)${tag}  :: ${p.effect.slice(0, 40)}`);
}

// ---------------------------------------------------------------- B1. V1 画质集合已空
console.log('\n=== [B1] V1/V2 VIP 画质 / 音频集合已空');
const vid = get('js/pages/video.js');
// 注意：y.QN_127 / k.QN_30250 这些**常量**在别处（画质名称表 x={...}、条目 value:）仍会出现，
// 真正的门是集合成员判定 —— 所以断言落在赋值本身 `_=[],S=[]` 与旧集合串消失（见 [B] 的 P01/P02）。
check(/,_=\[\],S=\[\]/.test(vid), 'V1/V2 集合赋值已为 `_=[],S=[]`（120/125/126/127 与 30250/30251/30255 不再入集合）');
check(!vid.includes('_=[y.QN_127,y.QN_126,y.QN_125,y.QN_120,y.QN_116,y.QN_112]'), 'V1 旧画质集合串已消失');
check(!vid.includes('S=[k.QN_30250,k.QN_30251,k.QN_30255]'), 'V2 旧音频集合串已消失');
console.log(`    （说明：y.QN_127 / k.QN_30250 在画质名称表与条目 value 中仍作为常量存在，不参与门判定）`);

// ---------------------------------------------------------------- B2. PGC 判定器
console.log('\n=== [B2] V13 PGC 判定器恒 false + PGC 内容限制分支不可达');
check(!vid.includes('location.pathname.match("/bangumi/play")'), 'V13 原 PGC 判定表达式已不存在');
check(/i=\(\)=>!1/.test(vid), 'V13 PGC 判定器已改为常量 false（i=()=>!1）');

const sw = get('initBackground.sw.js');
const count = (s, sub) => s.split(sub).length - 1;
const cntVid = count(vid, 'NOT_SUPPORT_PGC_CONTENT');
const throwSites = (vid.match(/throw[^;]{0,80}NOT_SUPPORT_PGC_CONTENT/g) || []).length;
check(cntVid === 4, `video.js 中 NOT_SUPPORT_PGC_CONTENT 出现 ${cntVid} 次（期望 4：枚举键/枚举值/文案构造 new u(...)/保持引用数组，均为定义，无抛出）`);
check(throwSites === 0, `video.js 中 throw NOT_SUPPORT_PGC_CONTENT 抛出点 = ${throwSites}（期望 0 → 该错误码本版无抛出点）`);
check(/const h=\[m\.NOT_SUPPORTED,m\.NOT_SUPPORT_PGC_CONTENT\]/.test(vid),
  '该错误码仅出现在 `const h=[...]` 保持引用数组里（不参与分支）');
check(/i=\(\)=>!1/.test(vid),
  'PGC 渲染分支的门 i() 恒 false → 「根据站方要求无法继续提供PGC内容下载」分支不可达（文案在文件里以 \\uXXXX 转义存储）');

// ---------------------------------------------------------------- B3. 番剧取流不再 return null
console.log('\n=== [B3] 番剧（PGC）取流链路：SW 不再 return null');
check(!sw.includes('if(e)return null;{const e=yt.UGC;'), 'S1 原 `if(e)return null` 已不存在');
check(sw.includes('const e=yt[this.isPGC?"PGC":"UGC"]'), 'S1 SW videoParse 改为 PGC/UGC 分支取地址');
check(sw.includes('(t?.result||t?.data)?.video_info'), 'S2 PGC 回包结构取 (result||data).video_info');

// ---------------------------------------------------------------- B4. 429/412 不再中断
console.log('\n=== [B4] 限速中断与 DRM 中断');
const bg = get('js/pages/background.js');
check(!/rateLimitedRetryTimes>(me|Le)\)throw/.test(bg), 'B2/B3 429/412 超限不再 throw DOWNLOAD_TOO_FREQUENTLY');
check(bg.includes('!1&&r?.boxs.find'), 'B4 pssh/DRM 检测不再中断（PROTECTED_BY_DRM 分支恒不进入）');

// ---------------------------------------------------------------- B5. 可选补丁未打 / extra 已打
console.log('\n=== [B5] 可选补丁状态（B5 默认不打；B6 已提为 X5 进 extra 阶段）');
// r3 说明：B5 的语义是「可选补丁 B5 本身没打」——判据必须落在 **B5 自己的锚点** 上。
// r2 时的写法是「全文无 credentials:"include"」，r3 起 dash-auth-fix 的 F6/F7 会把
// credentials:"include" 作为**显式鉴权契约**写进 background.js 的 A() 与 initBackground.sw.js 的 At()
// （见 tools/feature-dash-auth-fix.json F6/F7），因此「全文无此串」这条旧判据与 r3 的产品意图冲突；
// 这里换成等价且更严格的锚点判据：B5 锚点仍是裸 fetch + B5 的 new 形态不存在 + 该串只出现在 F6/F7 两处。
check(bg.includes('s=await fetch(e,t).catch'), 'B5 未打（B5 锚点仍是裸 fetch：s=await fetch(e,t).catch）');
check(!bg.includes('s=await fetch(e,Object.assign({credentials:"include"},t))'),
  'B5 未打（B5 的 new 形态 s=await fetch(e,Object.assign({credentials:"include"},t)) 不存在）');
{
  // pristine 基线：initBackground.sw.js 原本就有 3 处（getStatus checkout / requestController create / csrf post），
  // background.js 原本 0 处。r3 只允许各 +1（F7 / F6）。
  const INCLUDE = 'credentials:"include"';
  const cnt = (s) => s.split(INCLUDE).length - 1;
  const SRC = path.join(ROOT, 'src', 'extracted');
  const srcBg = fs.readFileSync(path.join(SRC, 'js', 'pages', 'background.js'), 'utf8');
  const srcSw = fs.readFileSync(path.join(SRC, 'initBackground.sw.js'), 'utf8');
  const bgInc = cnt(bg);
  const swInc = cnt(sw);
  check(bgInc === cnt(srcBg) + 1 && swInc === cnt(srcSw) + 1,
    `${INCLUDE} 相对 pristine 各只 +1（background.js ${cnt(srcBg)}→${bgInc} = F6；`
    + `initBackground.sw.js ${cnt(srcSw)}→${swInc} = F7；pristine 原本就有 3 处站方鉴权调用）`);
  check(bg.includes('d=await A(o,{credentials:"include"}).then(')
    && sw.includes('const l=await At(r,{credentials:"include"}).then('),
  'F6/F7 的显式鉴权契约落在 A()/At() 两个 playurl 入口（不是 B5 的 fetch 站点）');
}

console.log('\n=== [B6] extra 阶段 5 条（X1..X5）：old 全消失 / new 全出现');
const XCACHE = {};
const xget = (f) => (XCACHE[f] = XCACHE[f] || read(f));
for (const p of extraSpec) {
  const s = xget(p.file);
  const cOld = s.split(p.old).length - 1;
  const cNew = s.split(p.new).length - 1;
  const ok = cOld === 0 && cNew >= 1;
  if (!ok) fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${p.id} ${String(p.priority).padEnd(3)} ${p.file.padEnd(24)} ` +
    `old×${cOld} (期望 0)  new×${cNew} (期望 ≥1)  :: ${String(p.route || '').slice(0, 22)}`);
}
check(extraSpec.length === 5, `extra 规格条数 = ${extraSpec.length}（期望 5）`);

// X1+X5：SW 的 Yt() 与 offscreen 的 B() 两处 PGC playurl 都带 ep_id
const epSites = (xget('initBackground.sw.js').split('ep_id:this.epid').length - 1)
  + (xget('js/pages/background.js').split('ep_id:this.epid').length - 1);
check(epSites === 2, `两处 PGC 请求都带 ep_id:this.epid（实际 ${epSites} 处：SW Yt() + offscreen B()）`);
check(xget('initBackground.sw.js').includes(
  '{bvid:t,cid:n,qn:i||Wt,fnver:0,fnval:4048,fourk:1,tabId:this.tabId,ep_id:this.epid}'),
  'X1 SW 侧 PGC 参数串已含 ep_id（bvid/cid 保留，参数只增不改）');
check(!xget('js/pages/background.js').includes('fourk:1,tabId:this.tabId})'), 'X5 offscreen 侧旧参数串已消失');

// X2/X3：重试上限 8（两处 fetcher：DASH pe / FLV De）
const rl8 = xget('js/pages/background.js').split('this.rateLimitedRetryTimes>=8)throw c.DOWNLOAD_TOO_FREQUENTLY').length - 1;
check(rl8 === 2, `X2/X3 重试硬上限出现在 ${rl8} 处（期望 2：DASH 分段 fetcher + FLV 分段 fetcher）`);
check(!bg.includes('!1)throw c.DOWNLOAD_TOO_FREQUENTLY'), 'X2/X3 已消除 …!1)throw c.DOWNLOAD_TOO_FREQUENTLY（不再无条件重试）');

// X4：getStatus 两条出口一致
const swt = xget('initBackground.sw.js');
check(swt.includes('bhAccount:this.bhAccount?Object.assign({},this.bhAccount,{isVIP:!0,isSuperVIP:!0}):{bhid:0,'),
  'X4 getStatus 在 bhAccount 非空时也强制 isVIP/isSuperVIP（与 getBHAccount 出口一致）');
check(!swt.includes('bhAccount:this.bhAccount||{bhid:0,'), 'X4 旧 `bhAccount:this.bhAccount||{bhid:0,` 已消失');

// ---------------------------------------------------------------- 汇总
console.log(`\n=== 总结: ${fail === 0 ? 'PASS' : 'FAIL'} (fail=${fail})`);
process.exit(fail === 0 ? 0 : 1);
