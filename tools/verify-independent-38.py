#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify-independent-38.py —— 「38 条」版独立对抗性验收（tools/verify-independent.py 的派生尺子）

为什么会有这个文件
==================
`tools/verify-independent.py`（sha256 2bf9163f938ab3ee…）是**独立验收阶段的原始尺子，本轮一个字都没改**。
它把基准写死成 33 条：`items = load_static() + load_proto()`、`总差异簇数 == 33`、
「可选补丁 O02 未被打（锚点仍在 count=1）」，且 `patch_spans()` 只从 static+proto 规格取区间。
成品本轮升到 38 条（static 10 + proto 23 + extra 5）后，它就必然报 FAIL —— 失败的 9 项全部可归因到
「基准过期」，不是成品有问题：
  * 两处 `拼接恒等式` / `簇内 old-new` 失败：extra 的 X1/X5 新增了 2 个差异簇、X2/X3/X4 又改写了
    3 个已有簇的 new 字节，而它只认 33 条声明区间 → 簇坐标对不上；
  * `可选补丁 O02 未被打` 失败：O02 就是 B6，本轮被提为 X5 进了 extra 阶段，锚点当然 count=0；
  * 两处 `独立重放`（×2 变体 = 4 项）失败：它重放 33 条，与成品差正好 +73 / +70 字节 = X1+X4 / X5+X2+X3。

本文件用**同一套方法**（不 import apply-all-patches.py、不读 _patch-report.json 当证据、自己做字节级
重放）把基准扩到 38 条，并保留原来那几条硬断言：
  apply38    分段独立重放（pristine→static+proto→extra）→ 与成品逐字节比对 + 非补丁文件同一性 + manifest 键
  audit38    文件集合、改动面、编码/行尾、第 1 段 33 簇拼接恒等式、extra 5 条的嵌套/新增簇分类、
             最终差异簇数 35、B5 仍在 / B6 已被 X5 消费
  syntax38   node --check（两变体 × 7 个改动文件 + 4 个未改动文件）

用法：
  python tools/verify-independent-38.py --stage all            # unlock + sameId
  python tools/verify-independent-38.py --stage audit --variant sameId
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
KEY_FILE = os.path.join(HERE, "original-public-key.txt")

NODE = r"C:\Program Files\nodejs\node.exe"
VERSION_NAME = "2.8.31.16(Beta) unlock"
EXPECT_TOTAL = 38
EXPECT_STAGE1 = 33
EXPECT_FINAL_CLUSTERS = 35      # 33 个第 1 段簇 + X1 + X5 两个新簇（X2/X3/X4 嵌在已有簇内部）

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


# ---------------------------------------------------------------- 规格
def load_static() -> list[dict]:
    spec = importlib.util.spec_from_file_location("_v38_static", STATIC_SPEC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return [dict(id=f"S{i:02d}", phase="static", file=f, old=old, new=new, note=note)
            for i, (f, old, new, note) in enumerate(mod.PATCHES, 1)]


def load_proto() -> list[dict]:
    with open(PROTO_SPEC, encoding="utf-8") as fh:
        data = json.load(fh)
    return [dict(id=f"P{i:02d}", phase="proto", file=p["file"], old=p["old"], new=p["new"],
                 note=p["effect"], spec_offset=p.get("offset")) for i, p in enumerate(data, 1)]


def load_extra() -> list[dict]:
    with open(EXTRA_SPEC, encoding="utf-8") as fh:
        data = json.load(fh)["patches"]
    return [dict(id=p["id"], phase="extra", file=p["file"], old=p["old"], new=p["new"],
                 note=p.get("why", ""), spec_offset=p.get("offset"),
                 priority=p.get("priority"), route=p.get("route")) for p in data]


def load_optional() -> list[dict]:
    with open(PROTO_OPT, encoding="utf-8") as fh:
        data = json.load(fh)
    return [dict(id=f"O{i:02d}", phase="optional", file=p["file"], old=p["old"], new=p["new"],
                 note=p["effect"], spec_offset=p.get("offset")) for i, p in enumerate(data, 1)]


def by_file(items) -> dict[str, list[dict]]:
    agg: dict[str, list[dict]] = {}
    for it in items:
        agg.setdefault(it["file"], []).append(it)
    return agg


def replay_stage(buf: dict, items, tag: str, strict_spec_offset: bool = False) -> dict:
    """对 buf 就地做字节级替换。返回 {id: 在进入本段时的偏移}。

    规则（与原始尺子一致）：同文件按「进入本段时偏移降序、旧串长度降序」；每条要求 count==1。
    """
    anchors = {}
    for rel, its in by_file(items).items():
        raw = buf[rel]
        order = sorted(its, key=lambda it: (-raw.find(it["old"].encode("utf-8")),
                                            -len(it["old"])))
        for it in order:
            ob, nb = it["old"].encode("utf-8"), it["new"].encode("utf-8")
            c = raw.count(ob)
            if c != 1:
                raise RuntimeError(f"[{tag}] [{it['id']}] {rel} count(old)={c} != 1")
            off = raw.find(ob)
            anchors[it["id"]] = off
            if strict_spec_offset and it.get("spec_offset") is not None and off != it["spec_offset"]:
                raise RuntimeError(f"[{tag}] [{it['id']}] {rel} 偏移 {off} != 规格记录的成品树偏移 "
                                   f"{it['spec_offset']}")
            raw = raw[:off] + nb + raw[off + len(ob):]
        buf[rel] = raw
    return anchors


# ---------------------------------------------------------------- 第 1 段簇（pristine 坐标 + 成品坐标）
def stage1_spans(src_root: str, items) -> dict[str, list[dict]]:
    out = {}
    for rel, its in by_file(items).items():
        raw = open(os.path.join(src_root, rel.replace("/", os.sep)), "rb").read()
        prist = {}
        for it in its:
            ob = it["old"].encode("utf-8")
            c = raw.count(ob)
            if c != 1:
                raise RuntimeError(f"[stage1] [{it['id']}] {rel} count(old)={c}")
            prist[it["id"]] = (raw.find(ob), it)
        spans, delta = [], 0
        for pid in sorted(prist, key=lambda k: prist[k][0]):
            p0, it = prist[pid]
            ob, nb = it["old"].encode("utf-8"), it["new"].encode("utf-8")
            spans.append(dict(id=pid, p0=p0, p1=p0 + len(ob), q0=p0 + delta,
                              q1=p0 + delta + len(nb), old=ob, new=nb))
            delta += len(nb) - len(ob)
        out[rel] = spans
    return out


def merge_adjacent(spans):
    out = []
    for s in sorted(spans, key=lambda x: x["q0"]):
        if out and s["q0"] == out[-1]["q1"]:
            prev = out[-1]
            prev.update(p1=s["p1"], q1=s["q1"], old=prev["old"] + s["old"],
                        new=prev["new"] + s["new"], ids=prev["ids"] + s["ids"])
        else:
            out.append(dict(p0=s["p0"], p1=s["p1"], q0=s["q0"], q1=s["q1"],
                            old=s["old"], new=s["new"], ids=[s["id"]]))
    return out


def encoding_report(data: bytes) -> dict:
    return dict(bom=data[:3] == b"\xef\xbb\xbf", crlf=data.count(b"\r\n"),
                lf_only=data.count(b"\n") - data.count(b"\r\n"),
                ends_with_nl=data.endswith(b"\n"), nul=data.count(b"\x00"))


# ---------------------------------------------------------------- audit38
def stage_audit(variant: str) -> None:
    prod = VARIANTS[variant]
    print(f"\n########## 阶段 audit38  variant={variant}")
    print(f"pristine = {SRC}\nproduct  = {prod}\n")

    stage1_items = load_static() + load_proto()
    extra_items = load_extra()
    items = stage1_items + extra_items
    check(f"规格条数 = {len(items)}（static {len(load_static())} + proto {len(load_proto())}"
          f" + extra {len(extra_items)}）", len(items) == EXPECT_TOTAL)
    check("extra 规格 id 恰为 X1..X5", [i["id"] for i in extra_items] ==
          [f"X{k}" for k in range(1, 6)], str([i["id"] for i in extra_items]))

    src_files = {}
    for dp, _, fns in os.walk(SRC):
        for fn in fns:
            full = os.path.join(dp, fn)
            src_files[os.path.relpath(full, SRC).replace(os.sep, "/")] = full
    prod_files = {}
    for dp, _, fns in os.walk(prod):
        for fn in fns:
            full = os.path.join(dp, fn)
            prod_files[os.path.relpath(full, prod).replace(os.sep, "/")] = full

    check("文件集合一致", set(src_files) == set(prod_files),
          f"仅src={sorted(set(src_files) - set(prod_files))} 仅prod={sorted(set(prod_files) - set(src_files))}")
    print(f"  src 文件数={len(src_files)}  prod 文件数={len(prod_files)}")

    changed, identical = [], 0
    for rel in sorted(src_files):
        if rel not in prod_files:
            continue
        a = open(src_files[rel], "rb").read()
        b = open(prod_files[rel], "rb").read()
        if a == b:
            identical += 1
        else:
            changed.append((rel, a, b))
    print(f"  完全相同文件={identical}  有差异文件={len(changed)}")

    expected = set(by_file(items)) | {"manifest.json"}
    check("差异文件集合 == 预期集合", {r for r, _, _ in changed} == expected,
          f"actual={sorted({r for r, _, _ in changed})}")

    # ---- 第 1 段：33 条在 pristine 上的簇 + 拼接恒等式 ----
    span_map = stage1_spans(SRC, stage1_items)
    s1_buf = {}
    total_s1_clusters = 0
    nested, fresh = [], []
    for rel, a, b in changed:
        if rel == "manifest.json":
            continue
        cls = merge_adjacent(span_map.get(rel, []))
        total_s1_clusters += len(cls)
        # 用簇区间把 pristine 拼成「只打了 33 条」的文本，再与真实重放比对 —— 拼得起来
        # 就说明簇外没有任何其他差异（这就是拼接恒等式）
        s1 = bytearray()
        cur = 0
        inside_ok = True
        for c in cls:
            if a[c["p0"]:c["p1"]] != c["old"]:
                inside_ok = False
            s1 += a[cur:c["p0"]] + c["new"]
            cur = c["p1"]
        s1 += a[cur:]
        s1_buf[rel] = bytes(s1)
        check(f"{rel} 每个簇内 pristine == 声明 old", inside_ok)
        ea, eb = encoding_report(a), encoding_report(b)
        check(f"{rel} 编码/行尾 pristine↔product 一致", ea == eb, f"{ea} vs {eb}")

    check(f"第 1 段差异簇数 = {total_s1_clusters}（33 条补丁 → 期望 {EXPECT_STAGE1}）",
          total_s1_clusters == EXPECT_STAGE1, f"实际 {total_s1_clusters}")

    # 拼接结果必须 == 33 条真实重放结果（更强：逐字节）
    replay1 = {rel: open(os.path.join(SRC, rel.replace("/", os.sep)), "rb").read()
               for rel in s1_buf}
    replay_stage(replay1, stage1_items, "pristine")
    for rel in sorted(s1_buf):
        check(f"{rel} 第 1 段「拼接恒等式」结果 == 33 条重放结果", s1_buf[rel] == replay1[rel],
              f"sha 拼接={sha256(s1_buf[rel])[:16]} 重放={sha256(replay1[rel])[:16]}")

    # ---- 第 2 段：extra 的落点分类（含在已有簇内 / 与已有簇重叠后向外延伸 / 落在空白区）----
    extra_anchors = {}
    union_intervals: dict[str, list[tuple[int, int]]] = {}
    # 先把第 1 段的 33 个簇作为基础区间（所有改动文件，不只 extra 触及的两个）
    for rel in s1_buf:
        union_intervals[rel] = [(c["q0"], c["q1"]) for c in merge_adjacent(span_map[rel])]
    for rel, its in by_file(extra_items).items():
        raw = s1_buf[rel]
        order = sorted(its, key=lambda it: (-raw.find(it["old"].encode("utf-8")), -len(it["old"])))
        spans = merge_adjacent(span_map[rel])
        ivs = union_intervals[rel]
        for it in order:
            ob = it["old"].encode("utf-8")
            c = raw.count(ob)
            if c != 1:
                raise RuntimeError(f"[extra] [{it['id']}] {rel} count={c}")
            off = raw.find(ob)
            extra_anchors[it["id"]] = off
            r0, r1 = off, off + len(ob)
            host = [c_ for c_ in spans if c_["q0"] <= off and r1 <= c_["q1"]]
            touch = [c_ for c_ in spans if not (r1 <= c_["q0"] or r0 >= c_["q1"])]
            if host:
                nested.append(dict(id=it["id"], rel=rel, off=off, kind="嵌套在簇内",
                                   host=host[0]["ids"]))
            elif touch:
                nested.append(dict(id=it["id"], rel=rel, off=off, kind="与簇重叠并向外延伸",
                                   host=[i_ for c_ in touch for i_ in c_["ids"]]))
            else:
                fresh.append(dict(id=it["id"], rel=rel, off=off, kind="落在空白区"))
            ivs.append((r0, r1))
            if it.get("spec_offset") is not None:
                check(f"extra {it['id']} 锚点偏移 == 规格记录的成品树偏移",
                      off == it["spec_offset"], f"{off} vs {it['spec_offset']}")
            raw = raw[:off] + it["new"].encode("utf-8") + raw[off + len(ob):]
        # 区间并集（重叠/相接都算一个差异簇）
        ivs.sort()
        merged = []
        for a0, a1 in ivs:
            if merged and a0 <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], a1)
            else:
                merged.append([a0, a1])
        union_intervals[rel] = [tuple(x) for x in merged]

    print("\n  extra 落点分类：")
    for x in nested:
        print(f"    {x['id']}: {x['kind']}  —— 宿主簇 {x['host']} @ {x['rel']}:{x['off']}（不产生新簇）")
    for x in fresh:
        print(f"    {x['id']}: {x['kind']}  @ {x['rel']}:{x['off']}（产生新簇）")
    check("extra 落点分类符合预期（X4 嵌在 S08 簇内；X2/X3 与 B2/B3 簇重叠延伸；X1/X5 落在空白区）",
          {x["id"] for x in nested} == {"X2", "X3", "X4"} and {x["id"] for x in fresh} == {"X1", "X5"},
          f"nested={sorted(x['id'] for x in nested)} fresh={sorted(x['id'] for x in fresh)}")

    total_final = sum(len(v) for v in union_intervals.values())
    check(f"最终差异簇数 = {total_final}（期望 {EXPECT_FINAL_CLUSTERS} = 33 个第 1 段簇 + X1 + X5）",
          total_final == EXPECT_FINAL_CLUSTERS,
          " / ".join(f"{k}:{len(v)}" for k, v in sorted(union_intervals.items())))

    # ---- 可选/extra 锚点终态 ----
    opt = load_optional()
    prod_bg = open(os.path.join(prod, "js", "pages", "background.js"), "rb").read().decode("utf-8")
    b6 = next(o for o in opt if o["old"] in [e["old"] for e in extra_items])
    others = [o for o in opt if o is not b6]
    check("可选补丁 O01(B5) 仍未打（锚点 count=1）", prod_bg.count(b6 and others[0]["old"]) == 1,
          f"count={prod_bg.count(others[0]['old'])}")
    check("B6 已被 X5 消费（原锚点 count=0）", prod_bg.count(b6["old"]) == 0,
          f"count={prod_bg.count(b6['old'])}")
    check("B5 生效标识不存在（无 credentials:\"include\"）", 'credentials:"include"' not in prod_bg)

    # 未改动文件抽样
    for s in ("js/vendors.bundle.js", "js/components.bundle.js", "downloader.sw.js",
              "notification.sw.js", "html/background.html", "html/downloader.html"):
        if s in src_files and s in prod_files:
            check(f"未改动文件逐字节相同: {s}",
                  open(src_files[s], "rb").read() == open(prod_files[s], "rb").read())


# ---------------------------------------------------------------- apply38
def stage_apply(variant: str) -> None:
    prod = VARIANTS[variant]
    print(f"\n########## 阶段 apply38  variant={variant}（分段独立重放 → 逐字节比对）")
    stage1_items = load_static() + load_proto()
    extra_items = load_extra()
    files = sorted({it["file"] for it in stage1_items + extra_items})
    buf = {rel: open(os.path.join(SRC, rel.replace("/", os.sep)), "rb").read() for rel in files}

    a1 = replay_stage(buf, stage1_items, "pristine")
    print(f"  第 1 段重放完成：{len(stage1_items)} 条 / {len(files)} 文件")
    s1_snapshot = dict(buf)
    a2 = replay_stage(buf, extra_items, "post-proto", strict_spec_offset=True)
    print(f"  第 2 段重放完成：{len(extra_items)} 条（偏移已与规格逐条比对）")
    print(f"  合计 {len(stage1_items) + len(extra_items)} 条")

    for rel, data in sorted(buf.items()):
        p = os.path.join(prod, rel.replace("/", os.sep))
        actual = open(p, "rb").read()
        check(f"{rel} == 38 条独立重放结果（逐字节）", actual == data,
              f"len prod={len(actual)} replay={len(data)} "
              f"sha prod={sha256(actual)[:16]} replay={sha256(data)[:16]}")
        print(f"      sha256 prod={sha256(actual)}  ({len(actual)}B)"
              f"   第1段后={len(s1_snapshot[rel])}B")

    # 未改动文件必须逐字节等于 pristine（不允许悄悄多改）
    changed = set(files)
    src_files = {}
    for dp, _, fns in os.walk(SRC):
        for fn in fns:
            full = os.path.join(dp, fn)
            src_files[os.path.relpath(full, SRC).replace(os.sep, "/")] = full
    extra_changed = []
    for rel, sp in src_files.items():
        if rel in changed or rel == "manifest.json":
            continue
        pp = os.path.join(prod, rel.replace("/", os.sep))
        if not os.path.exists(pp) or open(sp, "rb").read() != open(pp, "rb").read():
            extra_changed.append(rel)
    check("非补丁文件全部与 pristine 逐字节相同", not extra_changed, f"被改动: {extra_changed}")

    src_man = json.load(open(os.path.join(SRC, "manifest.json"), encoding="utf-8"))
    prod_man = json.load(open(os.path.join(prod, "manifest.json"), encoding="utf-8"))
    diff_keys = {k for k in set(src_man) | set(prod_man)
                 if src_man.get(k) != prod_man.get(k)}
    print(f"  manifest 变化键: {sorted(diff_keys)}")
    if variant == "sameId":
        check("manifest 仅 version_name/key 变化", diff_keys == {"version_name", "key"},
              f"{sorted(diff_keys)}")
        key_b64 = open(KEY_FILE, encoding="utf-8").read().strip()
        check("manifest.key == original-public-key.txt", prod_man.get("key") == key_b64)
        der = hashlib.sha256(base64.b64decode(prod_man["key"])).hexdigest()[:32]
        ext_id = "".join(chr(ord("a") + int(c, 16)) for c in der)
        check("扩展 ID == kpbnombpnpcffllnianjibmpadjolanh",
              ext_id == "kpbnombpnpcffllnianjibmpadjolanh", ext_id)
    else:
        check("manifest 仅 version_name 变化", diff_keys == {"version_name"}, f"{sorted(diff_keys)}")
    check("manifest.version_name 正确", prod_man.get("version_name") == VERSION_NAME,
          repr(prod_man.get("version_name")))
    check("manifest.version 未被改动", prod_man.get("version") == src_man.get("version") == "2.8.31.16")
    check("manifest 关键区块（permissions/host_permissions/content_scripts/background）未变",
          all(src_man.get(k) == prod_man.get(k) for k in
              ("permissions", "host_permissions", "content_scripts", "background")))


# ---------------------------------------------------------------- syntax38
def stage_syntax() -> None:
    print("\n########## 阶段 syntax38（node --check）")
    files = ["initBackground.sw.js", "js/pages/config.js", "js/pages/video.js",
             "js/pages/background.js", "js/pages/live.js", "js/pages/message.js",
             "js/pages/popup.js"]
    for variant, prod in VARIANTS.items():
        for rel in files:
            p = os.path.join(prod, rel.replace("/", os.sep))
            r = subprocess.run([NODE, "--check", p], capture_output=True, text=True)
            check(f"node --check [{variant}] {rel}", r.returncode == 0,
                  (r.stderr or "").strip()[:400])
    for rel in ("js/pages/article.js", "js/pages/website.js", "downloader.sw.js", "notification.sw.js"):
        p = os.path.join(VARIANTS["unlock"], rel.replace("/", os.sep))
        r = subprocess.run([NODE, "--check", p], capture_output=True, text=True)
        check(f"node --check [unlock] {rel}", r.returncode == 0, (r.stderr or "").strip()[:300])


# ---------------------------------------------------------------- main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all", choices=["audit", "apply", "syntax", "all"])
    ap.add_argument("--variant", default="unlock", choices=list(VARIANTS))
    ap.add_argument("--log", default=None)
    args = ap.parse_args(argv)

    t0 = time.time()
    print(f"verify-independent-38.py  开始 {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"python={sys.version.split()[0]}  node={NODE}")
    print(f"基准：{EXPECT_TOTAL} 条 = static 10 + proto 23 + extra 5（X1..X5）")

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
