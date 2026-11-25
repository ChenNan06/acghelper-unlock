#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify-independent-r4.py —— 发布轮 r4 独立对抗性验收（tools/verify-independent-61.py 的派生尺子）
（61 版原文件**一个字都没改**）

为什么会有这个文件
==================
`tools/verify-independent-61.py` 把基准写死成 66 条 = 38 既有 + 28 feature
（pgc-fix 4 + dash-auth-fix 8 + dash-fallback 5 + webdav 8 + batch 3）、`EXPECT_FINAL_CLUSTERS = 60`。
r4 把 webdav 由 v1 升到 v2（8 → 9 条）、batch 换 v2 的注入位置，条数与簇数见下。
r4 这一轮不新增功能段，只把两处 UI 改版合进流水线：

  * webdav 8 → **9**（tools/feature-webdav.json **v2**：6 个新增文件 + 3 处字符串补丁）。
    v2 把「右下角浮动按钮 + 独立页入口」换成「官方设置页左侧导航的一栏『同步』」，
    新增 src/addons/webdav/js/webdav-settings-panel.js（57,995 B），W1 只加载 core + settings-panel，
    W0-inject 改名 W0-inject-legacy 且不再被 config.html 引用，W2/W3 变成幂等状态断言。
    → 66 + 1 = **67** 条 = 38 + 29 feature
  * batch spec v2 仍是 3 条（入口从自建 FAB 改为注入插件面板 footer，3 条补丁的 old/new 与 v1 逐字节相同）

方法完全沿用 61 版：不 import apply-all-plus-features.py、不读 _patch-report.json 当证据、
自己做字节级重放。唯一新增的一层是 **webdav v1 前置态重建（bridge）**：v2 规格的三条 old 里含着
v1 已落地的痕迹（config.html 的 inject.js 两行、manifest 的 infini-cloud 权限、sw 的 importScripts 引导），
而重放起点是 pristine，所以 webdav 段重放前先按「v2 锚点反向推导」的三步把输入补成 v1 态
（与构建器的 webdav_legacy_bridge 同义，但这里是独立实现、直接对 bytes 操作，不 import 构建器）。

  apply61    分段独立重放（pristine → static+proto → extra → feature:pgc-fix → feature:dash-auth-fix
             → feature:dash-fallback → feature:webdav(bridge→9 条) → feature:batch）→ 与成品逐字节比对
             + 新增文件逐字节 + 非补丁文件同一性 + manifest 键
  audit61    声明条数分账、文件集合（含 8 个新增文件）、改动面、行尾/BOM 风格、**逐段簇外字节拼接恒等**、
             **锚点 old/new 逐字节吻合**、feature 落点分类（嵌套/延伸/新簇）、最终差异簇数、
             B5 仍未打 / B6 已被 X5 消费、feature 终态（manifest 权限 / content_scripts / version_name / key /
             config.html 只加载 core + settings-panel 且不再引用 inject.js）
  syntax61   node --check（两变体 × 全部改动/新增 js + src/addons 源）

簇计数口径（与 38/53/61 版一致：用「坐标判定」而不是 difflib）
==========================================================
  67 条声明里 webdav 的 6 条是「新增文件」类条目（写在 webdav spec 的 patches[] 里），
  所以「67 + 新增文件数」会把那 6 个文件重复记账一次。真实差异簇 =
      **61 条字节级补丁**落成的簇（相邻/嵌套合并） + **8 个新增文件**（每个算 1 簇）
  61 条字节补丁的构成与 r3 相同（38 + pgc 4 + dash-auth 8 + dash-fallback 5 + webdav 3 + batch 3），
  簇数仍是 **53**（v2 的 W1 只是把 html/config.html 里同一处簇的内容换掉，不新增簇）；
  新增文件由 7 → 8（+ webdav-settings-panel.js）→ 最终差异簇 = 53 + 8 = **61**。
  逐文件实测见 tools/_r4_cluster_breakdown.py。

用法：
  python tools/verify-independent-r4.py --stage all             # unlock + sameId
  python tools/verify-independent-r4.py --stage audit --variant sameId
  python tools/verify-independent-r4.py --stage syntax
退出码 0 = 全 PASS。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SRC = os.path.join(ROOT, "src", "extracted")
OUT_ROOT = os.path.join(ROOT, "output")
VARIANTS = {
    "unlock": os.path.join(OUT_ROOT, "ACGhelper-2.8.31.16-unlock"),
    "sameId": os.path.join(OUT_ROOT, "ACGhelper-2.8.31.16-unlock-sameId"),
}
STATIC_SPEC = os.path.join(HERE, "static-patchspec.py")
PROTO_SPEC = os.path.join(HERE, "proto-patch-spec.json")
EXTRA_SPEC = os.path.join(HERE, "extra-patch-spec.json")
PROTO_OPT = os.path.join(HERE, "proto-patch-optional.json")
FEATURE_SPECS = {
    "pgc-fix": os.path.join(HERE, "feature-pgc-fix.json"),
    "dash-auth-fix": os.path.join(HERE, "feature-dash-auth-fix.json"),
    "dash-fallback": os.path.join(HERE, "feature-dash-fallback.json"),
    "webdav": os.path.join(HERE, "feature-webdav.json"),
    "batch": os.path.join(HERE, "feature-batch.json"),
}
FEATURE_ORDER = ("pgc-fix", "dash-auth-fix", "dash-fallback", "webdav", "batch")
FEATURE_EXPECT = {"pgc-fix": 4, "dash-auth-fix": 8, "dash-fallback": 5, "webdav": 9, "batch": 3}
KEY_FILE = os.path.join(HERE, "original-public-key.txt")

NODE = r"C:\Program Files\nodejs\node.exe"
VERSION_NAME = "2.8.31.16(Beta) unlock r4"
STOREFRONT_ID = "kpbnombpnpcffllnianjibmpadjolanh"
EXPECT_TOTAL = 67               # 38 + 29 feature（= 61 字节补丁 + 6 webdav 新增文件条目）
EXPECT_TOTAL_61_BASELINE = 61   # 53 + dash-auth-fix 8（61 版文件名口径）；r4 = 61 + dash-fallback 5 + webdav +1 = 67
EXPECT_BASE = 38
EXPECT_FEATURE = 29             # 4 + 8 + 5 + 9 + 3
EXPECT_BYTES_PATCHES = 61       # 38 + pgc 4 + dash-auth 8 + dash-fallback 5 + webdav 3 + batch 3
EXPECT_NEW_FILES = 8            # webdav 6 + batch 2
EXPECT_BASE_CLUSTERS = 35       # 38 条在成品树上的簇数（= verify-independent-38.py 的结论）
EXPECT_FINAL_CLUSTERS = 61      # 53（61 条字节补丁合并后）+ 8（新增文件）

FAILS: list[str] = []
CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    CHECKS.append((name, ok, detail))
    if not ok:
        FAILS.append(f"{name} :: {detail}")
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  —— {detail}" if detail else ""))
    return ok


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_bytes(p: str) -> bytes:
    with open(p, "rb") as fh:
        return fh.read()


def tob(x) -> bytes:
    """str/bytes → bytes（规格里的 old/new 是 str）。"""
    return x.encode("utf-8") if isinstance(x, str) else x


def read_key() -> str:
    return read_bytes(KEY_FILE).decode("utf-8").strip()


# ---------------------------------------------------------------- 规格
def load_static() -> list[dict]:
    spec = importlib.util.spec_from_file_location("_v53_static", STATIC_SPEC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return [dict(id=f"S{i:02d}", phase="static", file=f, old=old, new=new, note=note)
            for i, (f, old, new, note) in enumerate(mod.PATCHES, 1)]


def load_proto() -> list[dict]:
    data = json.load(open(PROTO_SPEC, encoding="utf-8"))
    return [dict(id=f"P{i:02d}", phase="proto", file=p["file"], old=p["old"], new=p["new"],
                 note=p["effect"], spec_offset=p.get("offset")) for i, p in enumerate(data, 1)]


def load_extra() -> list[dict]:
    data = json.load(open(EXTRA_SPEC, encoding="utf-8"))["patches"]
    return [dict(id=p["id"], phase="extra", file=p["file"], old=p["old"], new=p["new"],
                 note=p.get("why", ""), spec_offset=p.get("offset")) for p in data]


def load_optional() -> list[dict]:
    data = json.load(open(PROTO_OPT, encoding="utf-8"))
    return [dict(id=f"O{i:02d}", phase="optional", file=p["file"], old=p["old"], new=p["new"],
                 note=p["effect"], spec_offset=p.get("offset")) for i, p in enumerate(data, 1)]


def _norm_webdav(data: dict) -> list[dict]:
    """本地复刻 webdav spec 的三种写法（copy / kind=copy / file+old+new）—— 不 import 应用器。"""
    out = []
    for i, p in enumerate(data.get("patches", [])):
        pid = p.get("id") or f"P{i}"
        if "copy" in p:
            out.append(dict(id=pid, kind="copy", src=p["copy"]["from"], dst=p["copy"]["to"],
                            why=p.get("why", "")))
        elif p.get("kind") == "copy" or ("from" in p and "to" in p):
            out.append(dict(id=pid, kind="copy", src=p["from"], dst=p["to"], why=p.get("why", "")))
        else:
            out.append(dict(id=pid, kind="bytes", file=p["file"], old=p["old"], new=p["new"],
                            why=p.get("why", "")))
    return out


def load_features() -> dict:
    out = {}
    for name, path in FEATURE_SPECS.items():
        data = json.load(open(path, encoding="utf-8"))
        if name == "webdav":
            items = _norm_webdav(data)
            out[name] = dict(
                bytes=[dict(id=p["id"], feature=name, file=p["file"], old=p["old"], new=p["new"],
                            note=p.get("why", "")) for p in items if p["kind"] == "bytes"],
                copies=[dict(id=p["id"], feature=name, src=p["src"], to=p["dst"], counted=True,
                             note=p.get("why", "")) for p in items if p["kind"] == "copy"],
                declared=len(data.get("patches", [])))
        else:
            out[name] = dict(
                bytes=[dict(id=p["id"], feature=name, file=p["file"], old=p["old"], new=p["new"],
                            note=p.get("why", "")) for p in data.get("patches", [])],
                copies=[dict(id=f"{name}-add{i}", feature=name, src=a["copy"]["from"],
                             to=a["copy"]["to"], counted=False, note="additions[]")
                        for i, a in enumerate(data.get("additions", []), 1)],
                declared=len(data.get("patches", [])))
    return out


def by_file(items) -> dict:
    agg = {}
    for it in items:
        agg.setdefault(it["file"], []).append(it)
    return agg


def all_bytes_ops(feats: dict) -> list[dict]:
    return [it for name in FEATURE_ORDER for it in feats[name]["bytes"]]


def all_copies(feats: dict) -> list[dict]:
    return [it for name in FEATURE_ORDER for it in feats[name]["copies"]]


# ---------------------------------------------------------------- 簇区间（当前坐标）
def merge_regions(regions):
    out = []
    for s, e in sorted(regions):
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def track_edit(regions, off: int, old_len: int, new_len: int):
    """把一次 [off, off+old_len) → new_len 的替换反映到「当前坐标」的差异簇列表里。"""
    delta = new_len - old_len
    out = []
    for s, e in regions:
        if e <= off:
            out.append((s, e))
        elif s >= off + old_len:
            out.append((s + delta, e + delta))
        else:                                    # 与替换区间重叠（嵌套 / 向外延伸）
            out.append((min(s, off), max(e, off + old_len) + delta))
    out.append((off, off + new_len))
    return merge_regions(out)


def classify_region(regions, off: int, old_len: int) -> str:
    for s, e in regions:
        if s <= off and off + old_len <= e:
            return "nested"
    for s, e in regions:
        if not (off + old_len <= s or off >= e):
            return "extend"
    return "fresh"


def replay_stage(buf: dict, items: list[dict], tag: str, regions: dict | None = None,
                 strict_spec_offset: bool = False, tracked: dict | None = None) -> dict:
    """对 buf（bytes）就地做字节级替换；同时把差异簇跟踪进 regions（当前坐标）。

    规则与原始尺子一致：同文件按「进入本段时偏移降序、旧串长度降序」；每条要求 count==1。
    tracked 用来记录「每条补丁写入的 new 落在当前坐标的哪一段」，后续补丁若压到这段，
    就把这条标成 touched（= 它的 new 明文在成品里必然不再完整，不能拿 new 明文做断言）。
    返回 {id: 在进入本段时的偏移}。
    """
    anchors = {}
    for rel, its in by_file(items).items():
        raw = buf[rel]
        order = sorted(its, key=lambda it: (-raw.find(tob(it["old"])), -len(tob(it["old"]))))
        for it in order:
            ob, nb = tob(it["old"]), tob(it["new"])
            c = raw.count(ob)
            if c != 1:
                raise RuntimeError(f"[{tag}] [{it['id']}] {rel} count(old)={c} != 1")
            off = raw.find(ob)
            if strict_spec_offset and it.get("spec_offset") is not None and off != it["spec_offset"]:
                raise RuntimeError(f"[{tag}] [{it['id']}] {rel} 偏移 {off} != 规格记录的成品树偏移 "
                                   f"{it['spec_offset']}")
            anchors[it["id"]] = off
            if regions is not None:
                regions[rel] = track_edit(regions.get(rel, []), off, len(ob), len(nb))
            if tracked is not None:
                lst = tracked.setdefault(rel, [])
                delta = len(nb) - len(ob)
                for span in lst:                      # [id, start, end, touched]
                    s, e = span[1], span[2]
                    if e <= off:
                        pass
                    elif s >= off + len(ob):
                        span[1], span[2] = s + delta, e + delta
                    else:
                        span[1] = min(s, off)
                        span[2] = max(e, off + len(ob)) + delta
                        span[3] = True               # 被后来的补丁压到了
                lst.append([it["id"], off, off + len(nb), False])
            raw = raw[:off] + nb + raw[off + len(ob):]
        buf[rel] = raw
    return anchors


def splice(before: bytes, spans) -> bytes:
    out, cur = bytearray(), 0
    for off, ob, nb in sorted(spans, key=lambda x: x[0]):
        out += before[cur:off] + nb
        cur = off + len(ob)
    out += before[cur:]
    return bytes(out)


def manifest_text(text: str, key_b64: str | None) -> str:
    d = json.loads(text)
    d["version_name"] = VERSION_NAME
    if key_b64:
        d["key"] = key_b64
    return json.dumps(d, ensure_ascii=False, indent=4) + "\n"


def style_report(data: bytes) -> dict:
    return dict(bom=data[:3] == b"\xef\xbb\xbf", crlf_style=data.count(b"\r\n") > 0,
                crlf=data.count(b"\r\n"), nul=data.count(b"\x00"))


# ---------------------------------------------------------------- 期望树（独立重放）
def webdav_v1_bridge(items: list, buf: dict) -> list:
    """webdav v2 规格的 v1 前置态重建（**独立实现**，不 import 构建器）。

    v2 规格的三条 old 含 v1 已落地的痕迹，而重放起点是 pristine。三条 bridge 的 old
    全部由 v2 锚点反向推导：
      WBR1  </body>  ← W1.old 去掉尾部 </body> 后的两行
      WBR2  host_permissions 末项 + '],'  ← W2.old 去掉 infini 行与 optional 段、去掉逗号
      WBR3  W3.old 里 '\n;(function(){try{if(self.importScripts)' 之前的原文
    每条动手前 count(old)==1；已含 v1 的输入（count(spec_old)==1）自动跳过。
    """
    ops = {it["id"]: it for it in items}
    steps = []

    def _apply(sid, it, old: bytes, new: bytes):
        cur = buf[it["file"]]
        if cur.count(tob(it["old"])) == 1:
            steps.append(dict(id=sid, file=it["file"], skipped=True,
                              why="输入已含 v1 前置态"))
            return
        c = cur.count(old)
        if c != 1:
            raise SystemExit(f"[bridge] {sid} 前置态重建失败：{it['file']} count(old)={c}（要求 1）")
        off = cur.find(old)
        buf[it["file"]] = cur[:off] + new + cur[off + len(old):]
        steps.append(dict(id=sid, file=it["file"], skipped=False, off=off,
                          old_len=len(old), new_len=len(new)))

    w1 = ops.get("W1-config-html")
    if w1:
        old = tob(w1["old"])
        tail = b"</body>"
        if not old.endswith(b"\n" + tail):
            raise SystemExit("[bridge] W1.old 尾部不是换行+</body>，无法反推 v1 前置态")
        _apply("WBR1", w1, tail, old[:-len(tail)] + tail)

    w2 = ops.get("W2-manifest-hostperm")
    if w2:
        old = tob(w2["old"])
        lines = old.split(b"\n")
        first, last = lines[0], lines[-1]
        if not (first.rstrip().endswith(b",") and last.strip() == b"],"):
            raise SystemExit("[bridge] W2.old 首尾形态不符合预期，无法反推 v1 前置态")
        _apply("WBR2", w2, first.rstrip()[:-1] + b"\n" + last, old)

    w3 = ops.get("W3-sw-bootstrap")
    if w3:
        old = tob(w3["old"])
        sep = b"\n;(function(){try{if(self.importScripts)"
        i = old.find(sep)
        if i <= 0:
            raise SystemExit("[bridge] W3.old 里找不到引导块分隔点，无法反推 v1 前置态")
        _apply("WBR3", w3, old[:i], old)

    bad = [f"[{it['id']}] {it['file']} count={buf[it['file']].count(tob(it['old']))}"
           for it in items if buf[it["file"]].count(tob(it["old"])) != 1]
    if bad:
        raise SystemExit("[bridge] 前置态重建后锚点仍不唯一：\n" + "\n".join(bad))
    return steps


def expected_tree(key_b64: str | None):
    static, proto, extra = load_static(), load_proto(), load_extra()
    feats = load_features()
    opt = load_optional()
    stage1 = static + proto
    fops = all_bytes_ops(feats)
    copies = all_copies(feats)

    files = sorted({it["file"] for it in stage1 + extra + fops})
    pristine = {rel: read_bytes(os.path.join(SRC, rel.replace("/", os.sep))) for rel in files}
    manifest_seed = manifest_text(
        read_bytes(os.path.join(SRC, "manifest.json")).decode("utf-8"), None).encode("utf-8")

    buf = dict(pristine)
    regions: dict = {}
    tracked: dict = {}
    stages = []           # [{tag, items, before, after}]
    classes: list = []    # feature 落点分类

    def run_stage(tag, items, strict=False, classify=False):
        before = {rel: buf[rel] for rel in {i["file"] for i in items}}
        if classify:
            for it in items:
                ob = tob(it["old"])
                off = before[it["file"]].find(ob)
                cls = classify_region(regions.get(it["file"], []), off, len(ob))
                classes.append(dict(id=it["id"], feature=it["feature"], file=it["file"],
                                    off=off, kind=cls))
        replay_stage(buf, items, tag, regions, strict_spec_offset=strict, tracked=tracked)
        stages.append(dict(tag=tag, items=list(items), before=before,
                           after={rel: buf[rel] for rel in {i["file"] for i in items}}))

    run_stage("pristine(static→proto)", stage1)
    run_stage("post-proto(extra)", extra, strict=True)
    # 38 条既有补丁单独数一次簇（与 verify-independent-38.py 的 35 对齐）
    base_buf = dict(pristine)
    base_regions: dict = {}
    replay_stage(base_buf, stage1, "base1", base_regions)
    replay_stage(base_buf, extra, "base2", base_regions)
    base_per_file = {rel: len(merge_regions(v)) for rel, v in base_regions.items()}
    bridge: list = []
    for name in FEATURE_ORDER:
        items = feats[name]["bytes"]
        for it in items:                     # materialize：feature 才触及的文件取 38 条成品树内容
            rel = it["file"]
            if rel not in buf:
                buf[rel] = manifest_seed if rel == "manifest.json" else pristine[rel]
        if name == "webdav":
            bridge = webdav_v1_bridge(items, buf)
        run_stage(f"feature:{name}", items, classify=True)

    added = {c["to"]: read_bytes(os.path.join(ROOT, c["src"].replace("/", os.sep)))
             for c in copies}
    final_manifest = manifest_text(buf["manifest.json"].decode("utf-8"), key_b64).encode("utf-8")
    expected = {rel: data for rel, data in buf.items() if rel != "manifest.json"}
    expected["manifest.json"] = final_manifest

    ctx = dict(pristine=pristine, feats=feats, copies=copies, stages=stages, classes=classes,
               optional=opt, stage1=stage1, extra=extra, tracked=tracked,
               base_per_file=base_per_file, bridge=bridge)
    return ctx, expected, added, regions


# ---------------------------------------------------------------- audit53
def stage_audit(variant: str) -> None:
    prod = VARIANTS[variant]
    key_b64 = read_key() if variant == "sameId" else None
    print(f"\n########## 阶段 audit53  variant={variant}")
    print(f"pristine = {SRC}\nproduct  = {prod}\n")

    ctx, expected, added, regions = expected_tree(key_b64)
    feats, stages = ctx["feats"], ctx["stages"]
    feature_declared = sum(f["declared"] for f in feats.values())
    bytes_patches = len(ctx["stage1"]) + len(ctx["extra"]) + len(all_bytes_ops(feats))

    check(f"声明条目 = {len(ctx['stage1']) + len(ctx['extra']) + feature_declared}"
          f"（static {len(load_static())} + proto {len(load_proto())} + extra {len(ctx['extra'])}"
          f" + feature {feature_declared}）",
          len(ctx["stage1"]) + len(ctx["extra"]) + feature_declared == EXPECT_TOTAL)
    check(f"feature 声明 = {EXPECT_FEATURE}（pgc-fix 4 / dash-auth-fix 8 / dash-fallback 5 / webdav 9 / batch 3）",
          [feats[k]["declared"] for k in FEATURE_ORDER] == [FEATURE_EXPECT[k] for k in FEATURE_ORDER],
          str({k: feats[k]["declared"] for k in FEATURE_ORDER}))
    check(f"字节级补丁 = {EXPECT_BYTES_PATCHES}（38 既有 + pgc 4 + dash-auth 8 + dash-fallback 5 + webdav 3 + batch 3）",
          bytes_patches == EXPECT_BYTES_PATCHES, str(bytes_patches))
    check(f"条数口径：61 版基线 {EXPECT_TOTAL_61_BASELINE} + dash-fallback 5 + webdav 由 v1 的 8 升到 v2 的 9 = {EXPECT_TOTAL}",
          EXPECT_TOTAL_61_BASELINE + feats["dash-fallback"]["declared"] + (feats["webdav"]["declared"] - 8) == EXPECT_TOTAL,
          f"{EXPECT_TOTAL_61_BASELINE} + {feats['dash-fallback']['declared']} + ({feats['webdav']['declared']} - 8) = {EXPECT_TOTAL}")
    check(f"新增文件 = {EXPECT_NEW_FILES}（webdav 6 + batch 2）", len(added) == EXPECT_NEW_FILES,
          f"{sorted(added)}")

    # ---- 文件集合 ----
    src_files, prod_files = {}, {}
    for root, store in ((SRC, src_files), (prod, prod_files)):
        for dp, _, fns in os.walk(root):
            for fn in fns:
                full = os.path.join(dp, fn)
                store[os.path.relpath(full, root).replace(os.sep, "/")] = full
    expect_set = set(src_files) | set(added)
    check("文件集合 == pristine ∪ 8 个新增文件", set(prod_files) == expect_set,
          f"仅src={sorted(set(prod_files) - expect_set)} 仅prod={sorted(expect_set - set(prod_files))}")
    print(f"  src 文件数={len(src_files)}  prod 文件数={len(prod_files)}  新增={len(added)}")

    changed, identical = [], 0
    for rel in sorted(src_files):
        if read_bytes(src_files[rel]) == read_bytes(prod_files[rel]):
            identical += 1
        else:
            changed.append(rel)
    print(f"  与 pristine 完全相同的文件={identical}  有差异={len(changed)}  新增={len(added)}")
    expect_changed = (set(by_file(ctx["stage1"])) | set(by_file(ctx["extra"]))
                      | set(by_file(all_bytes_ops(feats))) | {"manifest.json"})
    check("差异文件集合 == 预期集合（38 条触及 7 个 + feature 再触及 3 个 + manifest.json）",
          set(changed) == expect_changed,
          f"多={sorted(set(changed) - expect_changed)} 少={sorted(expect_changed - set(changed))}")

    # ---- 1) 逐段「簇外字节拼接恒等」：段输入原文 + 声明的 new 重拼 == 真实段输出 ----
    for st in stages:
        bad, overlap = [], []
        for rel in sorted(st["after"]):
            before, after = st["before"][rel], st["after"][rel]
            spans = []
            for it in st["items"]:
                if it["file"] != rel:
                    continue
                ob, nb = tob(it["old"]), tob(it["new"])
                off = before.find(ob)
                if off < 0:
                    bad.append(f"{it['id']} 锚点不在段输入里")
                    continue
                if before.count(ob) != 1:
                    bad.append(f"{it['id']} 段输入 count(old)={before.count(ob)}")
                spans.append((off, ob, nb))
            spans.sort(key=lambda x: x[0])
            for a, b in zip(spans, spans[1:]):
                if a[0] + len(a[1]) > b[0]:
                    overlap.append(f"{rel}@{b[0]}")
            if splice(before, spans) != after:
                bad.append(f"{rel} 拼接结果 != 段输出")
            # 段内每条 new 必须真的落进段输出
            for it in st["items"]:
                if it["file"] == rel and tob(it["new"]) not in after:
                    bad.append(f"{it['id']} new 未落进段输出")
        check(f"逐段簇外字节拼接恒等 [{st['tag']}]（{len(st['items'])} 条 / "
              f"{len(st['after'])} 文件）", not bad and not overlap,
              "; ".join((bad + [f"区间重叠 {overlap}"])[:5]))

    # ---- 2) 逐文件：行尾/BOM 风格 + 与独立重放逐字节 ----
    total_clusters, per_file = 0, {}
    for rel in sorted(changed):
        a = read_bytes(src_files[rel])
        b = read_bytes(prod_files[rel])
        sa, sb = style_report(a), style_report(b)
        check(f"{rel} 行尾/BOM 风格保持（BOM/NUL/CRLF 体系不变）",
              (sa["bom"], sa["nul"], sa["crlf_style"]) == (sb["bom"], sb["nul"], sb["crlf_style"]),
              f"{sa} vs {sb}")
        check(f"{rel} == 67 条独立重放结果（逐字节）", b == expected[rel],
              f"len prod={len(b)} replay={len(expected[rel])} "
              f"sha prod={sha256(b)[:16]} replay={sha256(expected[rel])[:16]}"
              if b != expected[rel] else f"sha256={sha256(b)}")
        if rel == "manifest.json":
            continue
        cls = merge_regions(regions.get(rel, []))
        per_file[rel] = len(cls)
        total_clusters += len(cls)
        ineff = [f"{s}-{e}" for s, e in cls if b[s:e] == a[s:e]]
        check(f"{rel} 每个簇内确实有字节变化（{len(cls)} 簇 / "
              f"{sum(e - s for s, e in cls)} B 落在簇内）", not ineff, f"无变化簇={ineff[:5]}")
        # 簇外内容必须原样来自 pristine（顺序一致）——独立于规格的「没被偷偷改」证据
        pos, moved = 0, True
        cur = 0
        for s, e in cls:
            gap = b[cur:s]
            idx = pos if b[cur:s] and a.startswith(gap, pos) else a.find(gap, pos)
            if gap and (idx < 0):
                moved = False
                break
            pos = (idx + len(gap)) if gap else pos
            cur = e
        tail = b[cur:]
        if tail and a.find(tail, pos) < 0:
            moved = False
        check(f"{rel} 簇外字节全部原样来自 pristine（顺序一致）", moved)

    # ---- 3) feature 落点分类 ----
    print("\n  feature 落点分类（在上一段输出的坐标上判）：")
    for c in sorted(ctx["classes"], key=lambda x: (x["feature"], x["off"])):
        kind = {"nested": "嵌套在已有簇内（不产生新簇）", "extend": "与已有簇重叠并向外延伸",
                "fresh": "落在空白区（产生新簇）"}[c["kind"]]
        print(f"    {c['id']:18s} {c['file']:26s} @{c['off']:<8d} {kind}")
    fresh = [c["id"] for c in ctx["classes"] if c["kind"] == "fresh"]
    nested = [c["id"] for c in ctx["classes"] if c["kind"] == "nested"]
    extend = [c["id"] for c in ctx["classes"] if c["kind"] == "extend"]
    check("feature 落点分类全部落在可解释的三类里（嵌套/延伸/新簇）",
          len(fresh) + len(nested) + len(extend) == len(ctx["classes"]),
          f"new={fresh} nested={nested} extend={extend}")

    # ---- 4) 簇数与分账 ----
    base_clusters = sum(ctx["base_per_file"].values())
    print(f"\n  簇分账：")
    print(f"    66 条声明 = 38 既有字节补丁 + 4 pgc + 8 dash-auth + 5 dash-fallback"
          f" + (3 webdav 字节 + 5 webdav 新增文件) + 3 batch 字节")
    print(f"    字节级 {bytes_patches} 条 → {total_clusters} 个差异簇"
          f"（相邻/嵌套合并后；嵌套 {len(nested)} 条、向外延伸 {len(extend)} 条不产生新簇）")
    print(f"    新增文件 {len(added)} 个 → {len(added)} 个差异簇")
    print(f"    合计 {total_clusters + len(added)} 个差异簇 = {total_clusters} + {len(added)}")
    print(f"    （注意：「66 + 新增文件数」会重复计 webdav 那 5 个已算在 61 条字节补丁里的新增文件，"
          f"真实口径见上）")
    check(f"最终差异簇数 = {total_clusters + len(added)}"
          f"（{total_clusters} 个字节补丁簇 + {len(added)} 个新增文件）",
          total_clusters + len(added) == EXPECT_FINAL_CLUSTERS,
          " / ".join(f"{k}:{v}" for k, v in sorted(per_file.items())))
    check(f"其中 38 条既有补丁的簇数 = {base_clusters}（与 verify-independent-38.py 报的 "
          f"{EXPECT_BASE_CLUSTERS} 一致 → 坐标跟踪与上一版尺子对齐）",
          base_clusters == EXPECT_BASE_CLUSTERS, f"{base_clusters}")

    # ---- 5) 锚点 old/new 逐字节吻合 ----
    anchor_ok, anchor_bad = 0, []
    for st in stages:
        for it in st["items"]:
            before, after = st["before"][it["file"]], st["after"][it["file"]]
            ob, nb = tob(it["old"]), tob(it["new"])
            if before.count(ob) != 1:
                anchor_bad.append(f"[{it['id']}] 段输入 count(old)={before.count(ob)}")
                continue
            if nb not in after:
                anchor_bad.append(f"[{it['id']}] 段输出里找不到声明 new")
                continue
            if ob not in nb and ob in after:
                anchor_bad.append(f"[{it['id']}] 非自包含型补丁，段输出里仍能搜到 old")
                continue
            anchor_ok += 1
    total_items = sum(len(st["items"]) for st in stages)
    check(f"锚点 old/new 逐字节吻合（{anchor_ok}/{total_items} 条：段输入 count(old)==1、"
          f"new 落位、非自包含型 old 消失）", not anchor_bad, "; ".join(anchor_bad[:6]))

    # 基础 38 条在成品里复核：old 消失 / new 出现（被后续补丁压到的那几条豁免 new 明文比对）
    touched = {}
    for rel, lst in ctx["tracked"].items():
        for pid, s, e, t in lst:
            touched[pid] = t
    hosts = sorted([pid for pid in touched if touched[pid]
                    and any(pid == it["id"] for it in ctx["stage1"] + ctx["extra"])])
    base_bad = []
    for it in ctx["stage1"] + ctx["extra"]:
        prod_b = read_bytes(os.path.join(prod, it["file"].replace("/", os.sep)))
        ob, nb = tob(it["old"]), tob(it["new"])
        if nb not in prod_b and not touched.get(it["id"]):
            base_bad.append(f"[{it['id']}] 成品里找不到 new")
        if ob in nb:
            continue
        src_c = read_bytes(os.path.join(SRC, it["file"].replace("/", os.sep))).count(ob)
        if ob in prod_b and src_c == 1:
            base_bad.append(f"[{it['id']}] 成品里仍能搜到 old")
    check(f"基础 {len(ctx['stage1']) + len(ctx['extra'])} 条在成品里逐条吻合"
          f"（{len(hosts)} 条被后续补丁压到、豁免 new 明文比对：{hosts}）",
          not base_bad, "; ".join(base_bad[:6]))

    # ---- 6) 可选 / extra 终态 ----
    opt = ctx["optional"]
    prod_bg = read_bytes(os.path.join(prod, "js", "pages", "background.js")).decode("utf-8")
    extra = ctx["extra"]
    b6 = next(o for o in opt if o["old"] in [e["old"] for e in extra])
    b5 = next(o for o in opt if o is not b6)
    check("可选补丁 O01(B5) 仍未打（锚点 count=1）", prod_bg.count(b5["old"]) == 1,
          f"count={prod_bg.count(b5['old'])}")
    check("B6 已被 X5 消费（原锚点 count=0）", prod_bg.count(b6["old"]) == 0,
          f"count={prod_bg.count(b6['old'])}")
    # r3：dash-auth-fix 的 F6/F7 把 credentials:"include" 写进 A()/At() 两个 playurl 入口（显式鉴权契约），
    # 所以旧判据「全文无此串」换成锚点判据：B5 的 new 形态不存在 + 相对 pristine 各只 +1（F6/F7 各一处）。
    INCLUDE = 'credentials:"include"'
    src_bg = read_bytes(os.path.join(SRC, "js", "pages", "background.js")).decode("utf-8")
    src_sw = read_bytes(os.path.join(SRC, "initBackground.sw.js")).decode("utf-8")
    prod_sw = read_bytes(os.path.join(prod, "initBackground.sw.js")).decode("utf-8")
    check("B5 的 new 形态不存在（s=await fetch(e,Object.assign({credentials:\"include\"},t))）",
          's=await fetch(e,Object.assign({credentials:"include"},t))' not in prod_bg)
    check(f'{INCLUDE} 相对 pristine 各只 +1（background.js = F6、initBackground.sw.js = F7；'
          f'pristine 本身已有 3 处站方鉴权调用）',
          prod_bg.count(INCLUDE) == src_bg.count(INCLUDE) + 1
          and prod_sw.count(INCLUDE) == src_sw.count(INCLUDE) + 1,
          f'bg {src_bg.count(INCLUDE)}→{prod_bg.count(INCLUDE)} / sw {src_sw.count(INCLUDE)}→{prod_sw.count(INCLUDE)}')

    # ---- 7) feature 终态 ----
    man = json.loads(read_bytes(os.path.join(prod, "manifest.json")).decode("utf-8"))
    check("manifest.version_name 正确", man.get("version_name") == VERSION_NAME,
          repr(man.get("version_name")))
    check("manifest.version 未被改动", man.get("version") == "2.8.31.16", repr(man.get("version")))
    check("manifest 新增 WebDAV host 权限", any("infini-cloud.net" in h
                                                for h in man.get("host_permissions", [])),
          str(man.get("host_permissions", []))[-60:])
    check("manifest 新增 optional_host_permissions = ['*://*/*']",
          man.get("optional_host_permissions") == ["*://*/*"],
          str(man.get("optional_host_permissions")))
    cs = [e for e in man.get("content_scripts", [])
          if "js/pages/acgx-batch.js" in (e.get("js") or [])]
    check("manifest 命中 1 条 batch content_scripts（document_end / all_frames=false / 4 条 matches）",
          len(cs) == 1 and cs[0].get("run_at") == "document_end"
          and cs[0].get("all_frames") is False and len(cs[0].get("matches") or []) == 4,
          json.dumps(cs, ensure_ascii=False)[:180] if cs else "not found")
    bg_html = read_bytes(os.path.join(prod, "html", "background.html")).decode("utf-8")
    check("html/background.html 里 batch 脚本在 background.js 之前",
          0 <= bg_html.find("acgx-batch-offscreen.js") < bg_html.find("js/pages/background.js"))
    cfg_html = read_bytes(os.path.join(prod, "html", "config.html")).decode("utf-8")
    check("html/config.html 只剩 1 处 </body>（v2 的 W1 是整段替换，不是二次 append）",
          cfg_html.count("</body>") == 1, f"count={cfg_html.count('</body>')}")
    check("html/config.html 只加载 webdav-core.js + webdav-settings-panel.js（v2『同步』栏）",
          "src/addons/webdav/js/webdav-core.js" in cfg_html
          and "src/addons/webdav/js/webdav-settings-panel.js" in cfg_html
          and cfg_html.find("webdav-core.js") < cfg_html.find("webdav-settings-panel.js"),
          "core 在前、panel 在后")
    check("html/config.html 不再引用 v1 的 inject.js（浮动按钮已下线，文件仅留作回滚）",
          "src/addons/webdav/inject.js" not in cfg_html
          and os.path.isfile(os.path.join(prod, "src", "addons", "webdav", "inject.js")))
    swap = read_bytes(os.path.join(prod, "initBackground.sw.js")).decode("utf-8")
    check("initBackground.sw.js 尾部 importScripts 引导存在",
          "src/addons/webdav/js/webdav-core.js" in swap
          and "src/addons/webdav/js/webdav-sw.js" in swap)
    if variant == "sameId":
        key = man.get("key") or ""
        check("manifest.key == original-public-key.txt（216 字符）",
              key == read_key() and len(key) == 216, f"len={len(key)}")
        der = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
        ext_id = "".join(chr(ord("a") + int(c, 16)) for c in der)
        check(f"扩展 ID == {STOREFRONT_ID}", ext_id == STOREFRONT_ID, ext_id)
    else:
        check("plain 变体不含 key", "key" not in man)

    # ---- 8) 未改动文件抽样 ----
    for s in ("js/vendors.bundle.js", "js/components.bundle.js", "downloader.sw.js",
              "notification.sw.js", "html/downloader.html", "_locales/zh_CN/messages.json"):
        if s in src_files and s in prod_files:
            check(f"未改动文件逐字节相同: {s}",
                  read_bytes(src_files[s]) == read_bytes(prod_files[s]))


# ---------------------------------------------------------------- apply53
def stage_apply(variant: str) -> None:
    prod = VARIANTS[variant]
    key_b64 = read_key() if variant == "sameId" else None
    print(f"\n########## 阶段 apply53  variant={variant}（分段独立重放 → 逐字节比对）")
    ctx, expected, added, regions = expected_tree(key_b64)
    for st in ctx["stages"]:
        print(f"  段 {st['tag']:24s} {len(st['items']):>2d} 条  "
              f"文件 {sorted(st['after'])}")
    print(f"  合计 {EXPECT_TOTAL} 条；新增文件 {len(added)} 个（webdav v1 前置态重建 {len(ctx['bridge'])} 步）")

    for rel in sorted(expected):
        p = os.path.join(prod, rel.replace("/", os.sep))
        actual = read_bytes(p) if os.path.isfile(p) else b""
        check(f"{rel} == 67 条独立重放结果（逐字节）", actual == expected[rel],
              f"len prod={len(actual)} replay={len(expected[rel])} "
              f"sha prod={sha256(actual)[:16]} replay={sha256(expected[rel])[:16]}")
        print(f"      sha256={sha256(actual)}  ({len(actual)}B)")
    for rel, data in sorted(added.items()):
        actual = read_bytes(os.path.join(prod, rel.replace("/", os.sep)))
        check(f"新增文件 {rel} == 源文件（逐字节）", actual == data,
              f"sha prod={sha256(actual)[:16]} src={sha256(data)[:16]}")

    changed = set(expected) | set(added)
    src_files = {}
    for dp, _, fns in os.walk(SRC):
        for fn in fns:
            full = os.path.join(dp, fn)
            src_files[os.path.relpath(full, SRC).replace(os.sep, "/")] = full
    extra_changed = []
    for rel, sp in src_files.items():
        if rel in changed:
            continue
        pp = os.path.join(prod, rel.replace("/", os.sep))
        if not os.path.exists(pp) or read_bytes(sp) != read_bytes(pp):
            extra_changed.append(rel)
    check("非补丁文件全部与 pristine 逐字节相同（没有凭空改动）", not extra_changed,
          f"被改动: {extra_changed}")

    src_man = json.loads(read_bytes(os.path.join(SRC, "manifest.json")).decode("utf-8"))
    prod_man = json.loads(read_bytes(os.path.join(prod, "manifest.json")).decode("utf-8"))
    diff_keys = {k for k in set(src_man) | set(prod_man) if src_man.get(k) != prod_man.get(k)}
    expect_keys = {"version_name", "host_permissions", "optional_host_permissions",
                   "content_scripts"} | ({"key"} if variant == "sameId" else set())
    print(f"  manifest 变化键: {sorted(diff_keys)}")
    check("manifest 变化键 == version_name + WebDAV 权限 + batch content_scripts"
          + (" + key" if variant == "sameId" else ""), diff_keys == expect_keys,
          f"{sorted(diff_keys)}")
    check("manifest.version 未被改动", prod_man.get("version") == src_man.get("version") == "2.8.31.16")
    check("manifest 未被改动的区块（permissions/background/name/manifest_version/omnibox）保持原样",
          all(src_man.get(k) == prod_man.get(k) for k in
              ("permissions", "background", "name", "manifest_version", "omnibox")))


# ---------------------------------------------------------------- syntax53
def stage_syntax() -> None:
    print("\n########## 阶段 syntax53（node --check）")
    feats = load_features()
    added_js = sorted({c["to"] for c in all_copies(feats) if c["to"].endswith(".js")})
    files = sorted({"initBackground.sw.js", "js/pages/config.js", "js/pages/video.js",
                    "js/pages/live.js", "js/pages/message.js", "js/pages/popup.js",
                    "js/pages/background.js"} | set(added_js))

    def run(rel, root, tag):
        p = os.path.join(root, rel.replace("/", os.sep))
        if not os.path.isfile(p):
            check(f"{tag} node --check {rel}", False, "文件不存在")
            return
        r = subprocess.run([NODE, "--check", p], capture_output=True, text=True)
        check(f"{tag} node --check {rel}", r.returncode == 0, (r.stderr or "").strip()[:300])

    for variant, root in VARIANTS.items():
        for rel in files:
            run(rel, root, f"[{variant}]")
    for c in all_copies(feats):               # 源目录里的新增文件也各查一次（按 spec 的 from 路径）
        if c["src"].endswith(".js"):
            run(c["src"], ROOT, "[src/addons]")


# ---------------------------------------------------------------- main
def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all", choices=["audit", "apply", "syntax", "all"])
    ap.add_argument("--variant", default="unlock", choices=list(VARIANTS))
    ap.add_argument("--log", default=None)
    args = ap.parse_args(argv)

    t0 = time.time()
    print(f"verify-independent-r4.py  开始 {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"python={sys.version.split()[0]}  node={NODE}")
    print(f"基准：{EXPECT_TOTAL} 条 = 38（static 10 + proto 23 + extra 5）"
          f" + 29 feature（pgc-fix 4 + dash-auth 8 + dash-fallback 5 + webdav 9 + batch 3）；新增文件 {EXPECT_NEW_FILES}")

    if args.stage in ("audit", "all"):
        stage_audit(args.variant)
        if args.variant == "unlock":
            stage_audit("sameId")
    if args.stage in ("apply", "all"):
        stage_apply(args.variant)
        if args.variant == "unlock":
            stage_apply("sameId")
    if args.stage in ("syntax", "all"):
        stage_syntax()

    print("\n================ 汇总 ================")
    print(f"检查项={len(CHECKS)}  失败={len(FAILS)}  用时={time.time() - t0:.1f}s")
    for f in FAILS:
        print(f"  FAIL: {f}")
    print("RESULT:", "PASS" if not FAILS else f"FAIL ({len(FAILS)})")

    if args.log:
        os.makedirs(os.path.dirname(args.log), exist_ok=True)
        with open(args.log, "w", encoding="utf-8") as fh:
            fh.write("\n".join(f"{'PASS' if ok else 'FAIL'} :: {n} :: {d}" for n, ok, d in CHECKS))
            fh.write(f"\n\nRESULT: {'PASS' if not FAILS else 'FAIL'}\n")
        print(f"清单已写入 {args.log}")
    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
