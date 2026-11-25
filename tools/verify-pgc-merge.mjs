#!/usr/bin/env node
/**
 * verify-pgc-merge.mjs —— PGC(durl / FLV 分支) 落盘链路的可复跑验证装置（node 24）
 *
 * 不重写逻辑：**从成品树按字符串锚点抽出真实代码**（错误枚举 + DownloaderError +
 * FLV 解析类 Ae/Pe/Ue + FLV 缓存写盘函数 Ce(=Be.writeFile) + bt.runWriteFile + FLV picker catch），
 * 在最小 mock（writable sink / downloader.emitter）之上跑真实代码。
 *
 * 用例：
 *   1 durl-mp4-preview   durl 段 = 整段 MP4（真实 PGC 预览形态，ftyp 在偏移 4）→ FSA sink
 *   2 durl-mp4-multiseg  同一 MP4 拆成 2 段 → FSA sink
 *   3 durl-flv           2 段真 FLV（各带 FLV header）→ FSA sink，走 Ue.merge
 *   4 durl-flv-writer    同 3，但 sink 换成 streamsaver 风格 WritableStreamDefaultWriter
 *                        （sink 只收 Uint8Array；baseline 还会撞上 `!await r.closed` 死锁）
 *   5 dash               按 downloadDash 的写入顺序（先 head/moov，再 media 载荷）落盘
 *   6 err-normalize      合并器 throw 字符串时 bt.runWriteFile 是否把真实原因带出去
 *   7 picker-error       downloadFLV 的 showSaveFilePicker catch 是否吞掉真实异常
 *   8 dash-invariant     断言 DASH(UGC) 分支关键语句在补丁前后各恰好 1 处（不回归）
 *
 * 用法:
 *   node tools/verify-pgc-merge.mjs
 *   node tools/verify-pgc-merge.mjs --tree output/ACGhelper-2.8.31.16-unlock \
 *        --fixed build/pgc-proto/tree38-fixed --json build/pgc-proto/verify-pgc-merge.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--' + n + '='));
  return eq ? eq.split('=').slice(1).join('=') : d;
};
const TREE_BASE = path.resolve(ROOT, arg('tree', path.join('output', 'ACGhelper-2.8.31.16-unlock')));
const TREE_FIX = path.resolve(ROOT, arg('fixed', path.join('build', 'pgc-proto', 'tree38-fixed')));
const FFPROBE = arg('ffprobe', 'E:\\DevTools\\ffmpeg\\bin\\ffprobe.exe');
const JSON_OUT = arg('json', '');
const BG = 'js/pages/background.js';
const FIX = path.join(HERE, 'fixtures');

const results = [];
let fail = 0;
function check(ok, name, detail) {
  results.push({ ok, name, detail: detail === undefined ? '' : String(detail) });
  if (!ok) fail += 1;
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? '\n        ' + String(detail).split('\n').join('\n        ') : ''));
  return ok;
}
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------- 源码切片（锚点 + 花括号配平）
function sliceBalanced(src, startIdx) {
  const open = src[startIdx];
  const close = open === '{' ? '}' : open === '(' ? ')' : ']';
  let depth = 0;
  for (let i = startIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) break;
        i += 1;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { text: src.slice(startIdx, i + 1), end: i + 1 };
    }
  }
  throw new Error('unbalanced ' + open + ' @' + startIdx);
}
/** 从 anchor 起点开始，一直取到 openAt 处括号配平的终点；返回文本包含 anchor 本身 */
function spanFrom(src, anchor, openAt) {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error('anchor not found: ' + anchor);
  const oi = i + (openAt === undefined ? anchor.length : openAt);
  const { end } = sliceBalanced(src, oi);
  return { text: src.slice(i, end), start: i, end };
}

/** 取一个函数表达式/声明：anchor → 参数括号配平 → 函数体花括号配平 */
function spanFn(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error('fn anchor not found: ' + anchor);
  const p = src.indexOf('(', i);
  if (p < 0) throw new Error('fn params not found: ' + anchor);
  const paramsEnd = sliceBalanced(src, p).end;
  let b = paramsEnd;
  while (b < src.length && /\s/.test(src[b])) b += 1;
  if (src[b] !== '{') throw new Error('fn body not found for ' + anchor + ' @' + b);
  const end = sliceBalanced(src, b).end;
  return { text: src.slice(i, end), start: i, end };
}

function fetchDashInvariant(src) {
  const grabs = [
    'const y=await g.getWritable(!0);await y.write(g.initBuffer.head),await y.write(g.initBuffer.moov)',
    '(a&&"locked"in a&&!a.locked||a instanceof WritableStreamDefaultWriter)&&(await a.write(w.raw),y.push(_.raw.slice(8)),await a.write(y.raw)',
    '(a&&"locked"in a&&!a.locked||a instanceof WritableStreamDefaultWriter)&&(await a.write(c.raw),await a.write(e.raw))',
    'this.basicDownloadInfo.isFLV?this.downloadFLV(e,i,n):this.downloadDash(e,t,i,n)',
    'this.addListenerIfNone("complete",(async e=>{const t=await e.getWritable();await t.close(),this.stopLogTime()}))',
  ];
  return grabs.map((g) => ({ needle: g, count: src.split(g).length - 1 }));
}

function extract(tree) {
  const file = path.join(tree, BG);
  const src = fs.readFileSync(file, 'utf8');
  const errClass = spanFrom(src, 'class h extends Error', 'class h extends Error'.length).text;
  const enumStart = src.indexOf('(function(e){e[e["NOT_SUPPORTED"]=0]');
  const enumEndMark = '})(r||(r={}))';
  const enumEnd = src.indexOf(enumEndMark, enumStart);
  if (enumStart < 0 || enumEnd < 0) throw new Error('enum not found');
  const enumDecl = 'var r={};\n' + src.slice(enumStart, enumEnd + enumEndMark.length);
  const cMap = spanFrom(src, 'const c={', 'const c={'.length - 1).text;
  const flvStart = src.indexOf('class Ae extends DataView');
  const ueEnd = spanFrom(src, 'class Ue{', 'class Ue{'.length - 1).end;
  if (flvStart < 0 || ueEnd < 0) throw new Error('flv classes not found');
  const flvClasses = src.slice(flvStart, ueEnd);
  const ceFn = spanFn(src, 'Ce=async function').text;
  const rwf = spanFn(src, 'runWriteFile(e,t=l.video){').text;
  const pickerAnchor = 'window.showSaveFilePicker({suggestedName:this.filename||"output",types:[{accept:{["video/x-flv"]:[".flv"]}}]})';
  const pIdx = src.indexOf(pickerAnchor);
  let pickerCatch = null;
  if (pIdx >= 0) {
    const cIdx = src.indexOf('.catch(', pIdx + pickerAnchor.length);
    if (cIdx < 0) throw new Error('FLV picker catch not found');
    const parenIdx = cIdx + '.catch'.length;
    pickerCatch = src.slice(parenIdx, sliceBalanced(src, parenIdx).end);
  }
  return { file, src, errClass, enumDecl, cMap, flvClasses, ceFn, rwf, pickerCatch, dash: fetchDashInvariant(src) };
}

function buildModule(ex) {
  const parts = [
    ex.errClass,
    ex.enumDecl,
    ex.cMap,
    ex.flvClasses,
    'const Me=Ue;',
    'const l={video:"video",audio:"audio"};',
    ex.ceFn + ';',
    'function ' + ex.rwf,
    'return { Ce, Ue, Ae, Pe, c, h, r, runWriteFile };',
  ];
  const joined = parts.join('\n');
  try {
    return new Function('self', joined)({});
  } catch (e) {
    const dump = path.join(ROOT, 'build', 'pgc-proto', 'debug-module.js');
    fs.mkdirSync(path.dirname(dump), { recursive: true });
    fs.writeFileSync(dump, parts.map((s, i) => '/* part ' + i + ' */\n' + s + '\n').join('\n'), 'utf8');
    throw new Error('assembled module 语法错误: ' + e.message + '（已写 ' + dump + '）');
  }
}

// ---------------------------------------------------------------- fixtures
const toBuffer = (part) => {
  if (Buffer.isBuffer(part)) return part;
  if (part instanceof ArrayBuffer) return Buffer.from(part);
  if (part instanceof Uint8Array) return Buffer.from(part);
  throw new Error('unknown chunk type: ' + Object.prototype.toString.call(part));
};
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const blobToBuffer = async (blob) => Buffer.from(await blob.arrayBuffer());

const mp4 = fs.readFileSync(path.join(FIX, 'mp4', 'pgc-preview.mp4'));
const flvA = fs.readFileSync(path.join(FIX, 'flv', 'pgc-seg1.flv'));
const flvB = fs.readFileSync(path.join(FIX, 'flv', 'pgc-seg2.flv'));

function splitMp4(buf) {
  const idx = buf.indexOf(Buffer.from('mdat', 'ascii'));
  if (idx < 4) throw new Error('no mdat in fixture');
  const boxStart = idx - 4; // mdat box 的 size 字段起点
  // init = mdat 之前的所有 box（ftyp+moov…）；rest = mdat box 起至末尾（含 box 头，等价于 DASH 每段 flatten 后带 mdat 头的载荷）
  return { init: buf.subarray(0, boxStart), body: buf.subarray(boxStart) };
}

function fsaSink() {
  const parts = [];
  return { kind: 'fsa', locked: false, parts, async write(d) { parts.push(d); }, async close() { this.closed = true; } };
}
function writerSink() {
  const parts = [];
  const ws = new WritableStream({
    write(chunk) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('Can only write Uint8Arrays');
      parts.push(Buffer.from(chunk));
    },
  });
  return { kind: 'writer', writer: ws.getWriter(), parts };
}

function makeCache(segments, sink) {
  return {
    writing: false,
    stopping: false,
    segmentBuffer: segments.slice(),
    segmentInfo: segments.map((_, i) => ({ index: i })),
    writePosition: -1,
    getSegmentInfo() { return this.segmentInfo; },
    getNextWritePosition() { const n = this.writePosition + 1; return n < this.segmentInfo.length ? n : undefined; },
    getSegmentBuffer(i) { return this.segmentBuffer[i]; },
    deleteAllSegmentBuffer() { this.segmentBuffer = []; },
    async getWritable() { return sink.kind === 'writer' ? sink.writer : sink; },
    downloader: { emitter: { emitted: [], emit(name, ...a) { this.emitted.push([name, ...a]); } } },
  };
}

async function collect(sink) {
  if (sink.kind === 'writer') await sink.writer.close().catch(() => {});
  const out = [];
  for (const p of sink.parts) out.push(p instanceof Blob ? await blobToBuffer(p) : toBuffer(p));
  return Buffer.concat(out);
}

async function runCase(mod, segments, sink, timeoutMs = 1800) {
  const cache = makeCache(segments, sink);
  let outcome = 'returned';
  let err = null;
  const p = (async () => mod.Ce.call(cache, 'video'))().then(
    () => { outcome = 'returned'; },
    (e) => { outcome = 'threw'; err = e; },
  );
  const raced = await Promise.race([
    p.then(() => 'done'),
    new Promise((r) => setTimeout(() => r('HANG'), timeoutMs)),
  ]);
  if (raced === 'HANG') return { outcome: 'HANG', err, bytes: Buffer.alloc(0), cache };
  return { outcome, err, bytes: await collect(sink), cache };
}

function ffprobe(buf, tag) {
  const tmp = path.join(os.tmpdir(), 'acg-verify-' + tag + '-' + process.pid + '.bin');
  fs.writeFileSync(tmp, buf);
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,size,format_name',
      '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', tmp],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    const j = JSON.parse(out);
    return { ok: true, raw: j, duration: Number((j.format || {}).duration || 0), streams: (j.streams || []).length, bytes: Number((j.format || {}).size || 0) };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 2).join(' | ') };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- main
(async () => {
  console.log('baseline tree :', TREE_BASE);
  console.log('fixed tree    :', TREE_FIX);
  console.log('ffprobe       :', FFPROBE);
  for (const [label, dir] of [['baseline', TREE_BASE], ['fixed', TREE_FIX]]) {
    if (!fs.existsSync(path.join(dir, BG))) {
      throw new Error(label + ' 树里找不到 ' + BG + '：' + dir +
        (label === 'fixed' ? '\n        先跑：python tools/apply-feature-pgc-fix.py --out build/pgc-proto/tree38-fixed' : ''));
    }
  }
  if (!fs.existsSync(FFPROBE)) throw new Error('ffprobe 不存在: ' + FFPROBE + '（用 --ffprobe 指定）');
  const exBase = extract(TREE_BASE);
  const exFix = extract(TREE_FIX);
  const modBase = buildModule(exBase);
  const modFix = buildModule(exFix);
  console.log('baseline sha  :', sha256File(exBase.file));
  console.log('fixed    sha  :', sha256File(exFix.file));
  const { init, body } = splitMp4(mp4);
  console.log('fixture mp4   : ' + mp4.length + ' B (init ' + init.length + ' B / body ' + body.length + ' B), ftyp@' + mp4.indexOf('ftyp'));
  console.log('fixture flv   : seg1 ' + flvA.length + ' B, seg2 ' + flvB.length + ' B, magic=' + flvA.subarray(0, 3).toString());
  console.log('');

  // 1 durl-mp4-preview
  {
    const b = await runCase(modBase, [ab(mp4)], fsaSink());
    const f = await runCase(modFix, [ab(mp4)], fsaSink());
    const probe = f.bytes.length ? ffprobe(f.bytes, 'mp4preview') : { ok: false };
    check(b.outcome === 'threw' && b.bytes.length === 0,
      'case1 baseline durl-mp4-preview：合并器按 FLV 解析 → 抛错且写出 0 字节（= 事故现场）',
      'outcome=' + b.outcome + ' code=' + (b.err && b.err.code) + ' message=' + (b.err && b.err.message) + ' bytes=' + b.bytes.length);
    check(f.outcome === 'returned' && f.bytes.length > 0 && probe.ok && probe.duration > 0 && probe.streams > 0,
      'case1 fixed durl-mp4-preview：写出 >0 字节且 ffprobe 可解析 duration/streams',
      'outcome=' + f.outcome + ' bytes=' + f.bytes.length + ' ffprobe=' +
      (probe.ok ? 'duration=' + probe.duration + 's streams=' + probe.streams + ' fmt=' + probe.raw.format.format_name : probe.error));
  }

  // 2 durl-mp4-multiseg
  {
    const p1 = mp4.subarray(0, 4096);
    const p2 = mp4.subarray(4096);
    const b = await runCase(modBase, [ab(p1), ab(p2)], fsaSink());
    const f = await runCase(modFix, [ab(p1), ab(p2)], fsaSink());
    const same = f.bytes.length === mp4.length && f.bytes.equals(mp4);
    const probe = f.bytes.length ? ffprobe(f.bytes, 'mp4multi') : { ok: false };
    check(b.outcome === 'threw' && b.bytes.length === 0,
      'case2 baseline durl-mp4-multiseg：多段 MP4 同样 0 字节',
      'outcome=' + b.outcome + ' code=' + (b.err && b.err.code) + ' message=' + (b.err && b.err.message));
    check(f.outcome === 'returned' && same && probe.ok && probe.duration > 0,
      'case2 fixed durl-mp4-multiseg：顺序拼接后与源 MP4 完全一致且可解析',
      'bytes=' + f.bytes.length + '/' + mp4.length + ' identical=' + same + ' duration=' + (probe.duration || probe.error));
  }

  // 3 durl-flv
  {
    const b = await runCase(modBase, [ab(flvA), ab(flvB)], fsaSink());
    const f = await runCase(modFix, [ab(flvA), ab(flvB)], fsaSink());
    const magicB = b.bytes.subarray(0, 3).toString();
    const magicF = f.bytes.subarray(0, 3).toString();
    let reparse = false;
    try { new modFix.Ue(new modFix.Ae(ab(f.bytes))); reparse = true; } catch { reparse = false; }
    const probe = f.bytes.length ? ffprobe(f.bytes, 'flv') : { ok: false };
    check(b.outcome === 'returned' && magicB === 'FLV' && b.bytes.length > 0,
      'case3 baseline durl-flv：真 FLV 走 Ue.merge 成功（FLV 形态本身没坏）',
      'bytes=' + b.bytes.length + ' magic=' + magicB);
    check(f.outcome === 'returned' && magicF === 'FLV' && f.bytes.length > 0 && reparse,
      'case3 fixed durl-flv：补丁后仍走 FLV 合并（输出以 FLV 开头、可被成品自己的 Ue 重新解析）',
      'bytes=' + f.bytes.length + ' magic=' + magicF + ' reparse=' + reparse + ' ffprobe=' +
      (probe.ok ? 'duration=' + probe.duration + 's streams=' + probe.streams : probe.error));
  }

  // 4 durl-flv-writer
  {
    const b = await runCase(modBase, [ab(flvA), ab(flvB)], writerSink(), 1200);
    const f = await runCase(modFix, [ab(flvA), ab(flvB)], writerSink(), 1200);
    check(b.outcome === 'HANG' && b.bytes.length === 0,
      'case4 baseline durl-flv-writer：写入门 `!await writer.closed` 死锁 → 永不写出（无异常、无完成）',
      'outcome=' + b.outcome + ' bytes=' + b.bytes.length);
    check(f.outcome === 'returned' && f.bytes.length > 0 && f.bytes.subarray(0, 3).toString() === 'FLV',
      'case4 fixed durl-flv-writer：去掉死锁 + Blob→Uint8Array 后写出成功',
      'outcome=' + f.outcome + ' bytes=' + f.bytes.length + ' magic=' + f.bytes.subarray(0, 3).toString());
  }

  // 5 dash
  {
    const out = [];
    const y = { locked: false, async write(d) { out.push(toBuffer(d)); } };
    await y.write(ab(init));
    await y.write(ab(body));
    const merged = Buffer.concat(out);
    const probe = ffprobe(merged, 'dash');
    check(merged.equals(mp4) && probe.ok && probe.duration > 0 && probe.streams > 0,
      'case5 dash：head/moov + media 载荷按 downloadDash 顺序写出后与源文件一致且可解析（UGC 路径不变）',
      'bytes=' + merged.length + '/' + mp4.length + ' identical=' + merged.equals(mp4) +
      ' duration=' + (probe.duration || probe.error) + ' streams=' + probe.streams);
  }

  // 6 err-normalize
  {
    const runRW = async (mod, thrown) => {
      const ctx = {
        emitter: { out: [], emit(name, ...a) { this.out.push([name, ...a]); } },
        emit(name, ...a) { this.emitter.out.push([name, ...a]); },
      };
      mod.runWriteFile.call(ctx, { writeFile() { return Promise.reject(thrown); } }, 'video');
      await new Promise((r) => setTimeout(r, 40));
      return ctx.emitter.out;
    };
    const bOut = await runRW(modBase, 'FLV unexpected end of file');
    const fOut = await runRW(modFix, 'FLV unexpected end of file');
    const bErr = bOut[0] && bOut[0][1];
    const fErr = fOut[0] && fOut[0][1];
    check(!!bErr && !(bErr instanceof modBase.h),
      'case6 baseline err-normalize：字符串抛出原样丢给 UI → message undefined（用户侧只剩无语义文案）',
      'emitted=' + bOut.length + ' type=' + typeof bErr + ' message=' + (bErr && bErr.message));
    check(fErr instanceof modFix.h && /FLV unexpected end of file/.test(String(fErr.message)),
      'case6 fixed err-normalize：归一化成 DownloaderError 且真实原因保留',
      'code=' + (fErr && fErr.code) + ' message=' + (fErr && fErr.message));
  }

  // 7 picker-error
  {
    const secErr = Object.assign(new Error("Failed to execute 'showSaveFilePicker' on 'Window': Must be handling a user gesture to show a file picker."), { name: 'SecurityError' });
    const testCatch = (ex) => {
      if (!ex.pickerCatch) return { found: false };
      const inner = ex.pickerCatch.replace(/^\(/, '').replace(/\)$/, '');
      try {
        const fn = new Function('e', 'return (' + inner + ')(e)');
        fn(secErr);
        return { found: true, swallowed: true };
      } catch (e) {
        return { found: true, swallowed: false, name: e.name };
      }
    };
    const b = testCatch(exBase);
    const f = testCatch(exFix);
    check(b.found && b.swallowed,
      'case7 baseline picker-error：FLV 分支 `.catch((e=>{}))` 把 SecurityError 吞成 CANCEL',
      'swallowed=' + b.swallowed);
    check(f.found && !f.swallowed && f.name === 'SecurityError',
      'case7 fixed picker-error：非 AbortError 一律 rethrow（与 DASH 分支口径一致）',
      'swallowed=' + f.swallowed + ' rethrown=' + f.name);
  }

  // 8 dash-invariant
  {
    const bad = [];
    for (let i = 0; i < exBase.dash.length; i += 1) {
      const a = exBase.dash[i];
      const b = exFix.dash[i];
      if (a.count !== 1 || b.count !== 1) bad.push('#' + i + ' base=' + a.count + ' fix=' + b.count + ' :: ' + a.needle.slice(0, 50));
    }
    check(bad.length === 0,
      'case8 dash-invariant：DASH(UGC) 的 5 处关键语句在补丁前后都恰好各 1 处（未被改动/未被插入破坏）',
      bad.length ? bad.join('\n') : 'all invariants count==1 in both trees');
  }

  console.log('\n================ 汇总 ================');
  for (const r of results) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name);
  console.log('\nSUMMARY: ' + (fail === 0 ? 'PASS' : 'FAIL') + ' (fail=' + fail + '/' + results.length + ')');
  if (JSON_OUT) {
    const p = path.resolve(ROOT, JSON_OUT);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ baseline: TREE_BASE, fixed: TREE_FIX, ffprobe: FFPROBE, results }, null, 2), 'utf8');
    console.log('json -> ' + p);
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('VERIFIER CRASH:', e.stack || e.message);
  process.exit(2);
});
