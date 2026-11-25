#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify-independent.py —— ACGhelper 2.8.31.16 合并成品「独立对抗性验收」工具（可复跑）

与既有工具的关系：**完全独立实现**，不 import apply-all-patches.py、不调用
static-verify.mjs / proto-verify-gates.js、不读 _patch-report.json 当证据。
补丁规格（static-patchspec.py / proto-patch-spec.json）只作为「被验对象的声明」读入，
本脚本自己重新定位锚点、自己重算 diff、自己重新应用一遍，再与成品逐字节比对。

阶段：
  audit    改动面审计（逐文件二进制 diff + 差异簇坐标 + 前后 60 字符 + 编码/行尾检查）
  apply    独立重放（自己按规格重新应用 33 条 → 与成品逐字节比较）
  syntax   node --check 全部改动文件
  manifest manifest.json 语义比对（仅允许 version_name / key 变化）
  all      audit + apply + syntax + manifest

用法：
  python tools/verify-independent.py --stage all            # 默认验 unlock 变体
  python tools/verify-independent.py --stage audit --variant sameId
  python tools/verify-independent.py --stage all --log logs/verify-independent-audit.log

退出码：0 = 全 PASS；1 = 有 FAIL。
"""
from __future__ import annotations

import argparse
import hashlib
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
PROTO_OPT = os.path.join(HERE, "proto-patch-optional.json")
KEY_FILE = os.path.join(HERE, "original-public-key.txt")

NODE = r"C:\Program Files\nodejs\node.exe"
VERSION_NAME = "2.8.31.16(Beta) unlock"

# ---------------------------------------------------------------- 报表
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


# ---------------------------------------------------------------- 规格加载
def load_static() -> list[dict]:
    """读 static-patchspec.py 的 PATCHES（只读，不改）。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("_vi_static", STATIC_SPEC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    out = []
    for i, (f, old, new, note) in enumerate(mod.PATCHES, 1):
        out.append(dict(id=f"S{i:02d}", phase="static", file=f, old=old, new=new, note=note))
    return out


def load_proto() -> list[dict]:
    with open(PROTO_SPEC, encoding="utf-8") as fh:
        data = json.load(fh)
    return [dict(id=f"P{i:02d}", phase="proto", file=p["file"], old=p["old"], new=p["new"],
                 note=p["effect"], spec_offset=p.get("offset")) for i, p in enumerate(data, 1)]


def load_optional() -> list[dict]:
    with open(PROTO_OPT, encoding="utf-8") as fh:
        data = json.load(fh)
    return [dict(id=f"O{i:02d}", phase="optional", file=p["file"], old=p["old"], new=p["new"],
                 note=p["effect"], spec_offset=p.get("offset")) for i, p in enumerate(data, 1)]


def spec_files(items) -> dict[str, list[dict]]:
    """按文件聚合（保持规格原始顺序，用于计数断言）。"""
    agg: dict[str, list[dict]] = {}
    for it in items:
        agg.setdefault(it["file"], []).append(it)
    return agg


# ---------------------------------------------------------------- 独立 diff
def patch_spans(src_root: str, by_file: dict[str, list[dict]]):
    """在 pristine 上按「原始偏移降序」应用每条补丁，同时记录：

      - pristine 里的原始区间 [p0, p1)
      - 成品里的对应区间 [q0, q1)
    返回 {rel: [span...]}（按 pristine 偏移升序）。字节级操作，偏移即真实文件偏移。
    """
    exp: dict[str, list[dict]] = {}
    for rel, its in by_file.items():
        raw = open(os.path.join(src_root, rel.replace("/", os.sep)), "rb").read()
        ordered = sorted(its, key=lambda it: (-raw.find(it["old"].encode("utf-8")),
                                              -len(it["old"])))
        # 先定位全部原始区间（在 pristine 上互不影响）
        prist = {}
        for it in ordered:
            ob = it["old"].encode("utf-8")
            c = raw.count(ob)
            assert c == 1, f"[{it['id']}] {rel} count(old)={c}"
            prist[it["id"]] = (raw.find(ob), it)
        # 升序累计 delta 得到成品偏移
        spans = []
        delta = 0
        for pid in sorted(prist, key=lambda k: prist[k][0]):
            p0, it = prist[pid]
            ob, nb = it["old"].encode("utf-8"), it["new"].encode("utf-8")
            spans.append(dict(id=pid, p0=p0, p1=p0 + len(ob), q0=p0 + delta,
                              q1=p0 + delta + len(nb), old=ob, new=nb))
            delta += len(nb) - len(ob)
        exp[rel] = spans
    return exp


def merge_adjacent(spans):
    """相邻（成品里零间隔、pristine 里也零间隔）的补丁在二进制 diff 里是同一簇。"""
    out = []
    for s in spans:
        if out and s["p0"] == out[-1]["p1"] and s["q0"] == out[-1]["q1"]:
            prev = out[-1]
            prev["p1"], prev["q1"] = s["p1"], s["q1"]
            prev["old"] += s["old"]
            prev["new"] += s["new"]
            prev["ids"].append(s["id"])
        else:
            out.append(dict(p0=s["p0"], p1=s["p1"], q0=s["q0"], q1=s["q1"],
                            old=s["old"], new=s["new"], ids=[s["id"]]))
    return out


def clusters(a: bytes, b: bytes, spans):
    """差异簇 = 补丁区间（相邻合并后），并用「拼接恒等式」证明完整性：

      concat(a 在簇外的字节) == concat(b 在簇外的字节)   ← 证明簇外无任何差异
    """
    cls = merge_adjacent(spans)
    ai = bi = 0
    ra, rb = bytearray(), bytearray()
    for c in cls:
        ra += a[ai:c["p0"]]
        rb += b[bi:c["q0"]]
        ai, bi = c["p1"], c["q1"]
    tail_a, tail_b = a[ai:], b[bi:]
    outside_equal = bytes(ra) == bytes(rb) and tail_a == tail_b
    inside_ok = all(a[c["p0"]:c["p1"]] == c["old"] and b[c["q0"]:c["q1"]] == c["new"]
                    for c in cls)
    return [(c["p0"], c["p1"], c["q0"], c["q1"], c["ids"]) for c in cls], outside_equal, inside_ok


def ctx(data: bytes, start: int, end: int, radius: int = 60):
    """取 [start-radius, end+radius) 的文本，差异部分用 ⟪⟫ 标出。"""
    lo = max(0, start - radius)
    hi = min(len(data), end + radius)
    pre = data[lo:start].decode("utf-8", "replace")
    mid = data[start:end].decode("utf-8", "replace")
    post = data[end:hi].decode("utf-8", "replace")
    pre = ("…" if lo > 0 else "") + pre.replace("\n", "\\n")
    post = post.replace("\n", "\\n") + ("…" if hi < len(data) else "")
    mid = mid.replace("\n", "\\n")
    return pre, mid, post


def short(s: str, n: int = 240) -> str:
    s = s.replace("\n", "\\n")
    return s if len(s) <= n else s[:n] + f"…(+{len(s)-n})"


# ---------------------------------------------------------------- 编码/行尾
def encoding_report(data: bytes) -> dict:
    return dict(
        bom=data[:3] == b"\xef\xbb\xbf",
        crlf=data.count(b"\r\n"),
        lf_only=data.count(b"\n") - data.count(b"\r\n"),
        ends_with_nl=data.endswith(b"\n"),
        nul=data.count(b"\x00"),
        non_utf8=len(data.decode("utf-8", "replace").encode("utf-8", "replace")) != len(data),
    )


# ---------------------------------------------------------------- 独立重放
def independent_apply(src_root: str, items) -> dict[str, bytes]:
    """自己重新应用一遍补丁（不调用 apply-all-patches.py）。

    顺序：同文件按「原始偏移降序、旧串长度降序」，与声明的 order_rule 一致，
    但定位/替换逻辑是本脚本自己的实现（字节级）；每条要求 count(old)==1。
    """
    by_file = spec_files(items)
    buf: dict[str, bytes] = {}
    for rel, its in by_file.items():
        p = os.path.join(src_root, rel.replace("/", os.sep))
        raw = open(p, "rb").read()
        ordered = sorted(its, key=lambda it: (-raw.find(it["old"].encode("utf-8")),
                                              -len(it["old"])))
        for it in ordered:
            ob, nb = it["old"].encode("utf-8"), it["new"].encode("utf-8")
            c = raw.count(ob)
            if c != 1:
                raise RuntimeError(f"[{it['id']}] {rel} count(old)={c} != 1")
            off = raw.find(ob)
            raw = raw[:off] + nb + raw[off + len(ob):]
        buf[rel] = raw
    return buf


# ---------------------------------------------------------------- audit
def stage_audit(variant: str) -> None:
    prod = VARIANTS[variant]
    print(f"\n########## 阶段 audit  variant={variant}")
    print(f"pristine = {SRC}")
    print(f"product  = {prod}\n")

    src_files = {}
    for dp, dns, fns in os.walk(SRC):
        for fn in fns:
            full = os.path.join(dp, fn)
            src_files[os.path.relpath(full, SRC).replace(os.sep, "/")] = full
    prod_files = {}
    for dp, dns, fns in os.walk(prod):
        for fn in fns:
            full = os.path.join(dp, fn)
            prod_files[os.path.relpath(full, prod).replace(os.sep, "/")] = full

    check("文件集合一致", set(src_files) == set(prod_files),
          f"仅src={sorted(set(src_files)-set(prod_files))} 仅prod={sorted(set(prod_files)-set(src_files))}")
    print(f"  src 文件数={len(src_files)}  prod 文件数={len(prod_files)}")

    changed = []
    identical = 0
    for rel in sorted(src_files):
        if rel not in prod_files:
            continue
        a = open(src_files[rel], "rb").read()
        b = open(prod_files[rel], "rb").read()
        if a == b:
            identical += 1
            continue
        changed.append((rel, a, b))
    print(f"  完全相同文件={identical}  有差异文件={len(changed)}")

    items = load_static() + load_proto()
    by_file = spec_files(items)
    opt = load_optional()

    print("\n---- 差异文件清单 ----")
    for rel, a, b in changed:
        print(f"  {rel:32s} {len(a):>8d} -> {len(b):>8d}  ({len(b)-len(a):+d})  patches={len(by_file.get(rel, []))}")

    expected_set = set(by_file) | ({"manifest.json"} if variant == "sameId" else {"manifest.json"})
    actual_set = {rel for rel, _, _ in changed}
    check("差异文件集合 == 预期集合", actual_set == expected_set,
          f"actual={sorted(actual_set)} expected={sorted(expected_set)}")

    print("\n---- 逐文件差异簇 ----")
    span_map = patch_spans(SRC, by_file)
    total_clusters = 0
    cluster_rows = []
    for rel, a, b in changed:
        spans = span_map.get(rel, [])
        cls, outside_equal, inside_ok = clusters(a, b, spans)
        n_patch = len(by_file.get(rel, []))
        total_clusters += len(cls)
        print(f"\n  ### {rel}   clusters={len(cls)}  patches={n_patch}")
        # 编码/行尾
        ea, eb = encoding_report(a), encoding_report(b)
        same_enc = (ea["bom"] == eb["bom"] and ea["crlf"] == eb["crlf"]
                    and ea["lf_only"] == eb["lf_only"] and ea["ends_with_nl"] == eb["ends_with_nl"]
                    and ea["nul"] == eb["nul"])
        print(f"      编码 pristine={ea}")
        print(f"      编码 product ={eb}  -> {'一致' if same_enc else '不一致!!'}")
        if rel != "manifest.json":
            check(f"{rel} 编码/行尾未变", same_enc, f"{ea} vs {eb}")
            check(f"{rel} 差异簇外字节完全一致（拼接恒等式）", outside_equal)
            check(f"{rel} 每个簇内 old/new 与补丁声明逐字节一致", inside_ok)
        for k, (a1, a2, b1, b2, ids) in enumerate(cls, 1):
            pre_a, mid_a, post_a = ctx(a, a1, a2)
            _, mid_b, _ = ctx(b, b1, b2)
            print(f"      #{k:02d} pristine[{a1}:{a2}] ({a2-a1}B) -> product[{b1}:{b2}] ({b2-b1}B)  patch={ids}")
            print(f"           before60 = {short(pre_a, 120)!r}")
            print(f"           old      = {short(mid_a, 300)!r}")
            print(f"           new      = {short(mid_b, 300)!r}")
            print(f"           after60  = {short(post_a, 120)!r}")
            cluster_rows.append(dict(file=rel, idx=k, a1=a1, a2=a2, b1=b1, b2=b2,
                                     before60=pre_a, old=mid_a, new=mid_b, after60=post_a,
                                     patches=ids))
        if rel != "manifest.json":
            check(f"{rel} 差异簇数==补丁数({n_patch})", len(cls) == n_patch, f"clusters={len(cls)}")
            unattributed = [c for c in cls if not c[4]]
            check(f"{rel} 每个簇都对应一条声明补丁", not unattributed,
                  f"未归属: {[(c[0], c[1]) for c in unattributed]}" if unattributed else "")

    check("总差异簇数 == 33（不含 manifest）",
          sum(1 for r in cluster_rows if r["file"] != "manifest.json") == 33,
          f"合计={sum(1 for r in cluster_rows if r['file'] != 'manifest.json')}")

    # ---- manifest.json 单独分析（不是 33 条补丁之一，属构建器元数据改写）----
    print("\n---- manifest.json 差异簇（构建器元数据，非补丁）----")
    if "manifest.json" in dict((rel, 1) for rel, _, _ in changed):
        a = open(os.path.join(SRC, "manifest.json"), "rb").read()
        b = open(os.path.join(prod, "manifest.json"), "rb").read()
        import difflib
        sm = difflib.SequenceMatcher(None, a.decode("utf-8"), b.decode("utf-8"), autojunk=False)
        n = 0
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                continue
            n += 1
            # manifest 是纯 ASCII：字节偏移 == 字符偏移
            pre_a, _, post_a = ctx(a, i1, i1)
            mid_a = a[i1:i2].decode("utf-8", "replace")
            _, mid_b, _ = ctx(b, j1, j2)
            print(f"      #{n:02d} [{tag}] pristine[{i1}:{i2}] -> product[{j1}:{j2}]")
            print(f"           before60={short(pre_a,120)!r} old={short(mid_a,200)!r} "
                  f"new={short(mid_b,200)!r} after60={short(post_a,120)!r}")
        print(f"      manifest 差异簇数={n}（预期 2：version_name 值 + 文件末尾换行；sameId 另有 key 插入）")

    # 未改动文件必须逐字节相同（抽样全部）
    print("\n---- 未改动文件抽样校验 ----")
    samples = ["js/vendors.bundle.js", "js/components.bundle.js", "downloader.sw.js",
               "notification.sw.js", "html/background.html", "html/downloader.html"]
    for s in samples:
        if s in src_files and s in prod_files:
            same = open(src_files[s], "rb").read() == open(prod_files[s], "rb").read()
            check(f"未改动文件逐字节相同: {s}", same)

    # optional 锚点存在性（默认未打，必须仍以原样存在于成品）
    print("\n---- 可选补丁（默认未打）锚点检查 ----")
    for o in opt:
        p = os.path.join(prod, o["file"].replace("/", os.sep))
        text = open(p, "rb").read().decode("utf-8")
        c = text.count(o["old"])
        check(f"可选补丁 {o['id']} 未被打（锚点仍在 count=1）", c == 1, f"count={c} file={o['file']}")

    return cluster_rows


# ---------------------------------------------------------------- apply
def stage_apply(variant: str) -> None:
    prod = VARIANTS[variant]
    print(f"\n########## 阶段 apply  variant={variant}（独立重放→逐字节比对）")
    items = load_static() + load_proto()
    buf = independent_apply(SRC, items)
    print(f"  独立重放完成：{len(items)} 条 / {len(buf)} 个文件")
    for rel, data in sorted(buf.items()):
        p = os.path.join(prod, rel.replace("/", os.sep))
        if not os.path.exists(p):
            check(f"成品缺少文件 {rel}", False)
            continue
        actual = open(p, "rb").read()
        check(f"{rel} == 独立重放结果（逐字节）", actual == data,
              f"len prod={len(actual)} replay={len(data)} sha prod={sha256(actual)[:16]} replay={sha256(data)[:16]}")
        print(f"      sha256 prod={sha256(actual)}  ({len(actual)}B)")

    # 未改动文件也必须与 pristine 一致（防止悄悄多改）
    changed = set(buf)
    src_files = {}
    for dp, dns, fns in os.walk(SRC):
        for fn in fns:
            full = os.path.join(dp, fn)
            src_files[os.path.relpath(full, SRC).replace(os.sep, "/")] = full
    extra = []
    for rel, sp in src_files.items():
        if rel in changed:
            continue
        if rel == "manifest.json":
            continue
        pp = os.path.join(prod, rel.replace("/", os.sep))
        if not os.path.exists(pp) or open(sp, "rb").read() != open(pp, "rb").read():
            extra.append(rel)
    check("非补丁文件全部与 pristine 逐字节相同", not extra, f"被改动: {extra}")

    # manifest 语义比对
    src_man = json.load(open(os.path.join(SRC, "manifest.json"), encoding="utf-8"))
    prod_man = json.load(open(os.path.join(prod, "manifest.json"), encoding="utf-8"))
    diff_keys = {k for k in set(src_man) | set(prod_man)
                 if src_man.get(k) != prod_man.get(k)}
    print(f"  manifest 变化键: {sorted(diff_keys)}")
    if variant == "sameId":
        check("manifest 仅 version_name/key 变化", diff_keys == {"version_name", "key"}, f"{sorted(diff_keys)}")
        key_b64 = open(KEY_FILE, encoding="utf-8").read().strip()
        check("manifest.key == original-public-key.txt", prod_man.get("key") == key_b64)
        der_sha = hashlib.sha256(__import__("base64").b64decode(prod_man["key"])).hexdigest()[:32]
        ext_id = "".join(chr(ord("a") + int(c, 16)) for c in der_sha)
        check("扩展 ID == kpbnombpnpcffllnianjibmpadjolanh", ext_id == "kpbnombpnpcffllnianjibmpadjolanh", ext_id)
    else:
        check("manifest 仅 version_name 变化", diff_keys == {"version_name"}, f"{sorted(diff_keys)}")
    check("manifest.version_name 正确", prod_man.get("version_name") == VERSION_NAME,
          repr(prod_man.get("version_name")))
    check("manifest.version 未被改动", prod_man.get("version") == src_man.get("version") == "2.8.31.16")
    check("manifest.manifest_version 未变", prod_man.get("manifest_version") == src_man.get("manifest_version"))
    # permissions/host_permissions 未变（关键：不能悄悄加权限）
    for k in ("permissions", "host_permissions", "optional_permissions", "content_scripts",
              "background", "web_accessible_resources", "externally_connectable"):
        ok = src_man.get(k) == prod_man.get(k)
        if not ok:
            check(f"manifest.{k} 未变", False, "被改动")
    check("manifest 关键区块（permissions/content_scripts/background）未变",
          all(src_man.get(k) == prod_man.get(k) for k in
              ("permissions", "host_permissions", "content_scripts", "background")))


# ---------------------------------------------------------------- syntax
def stage_syntax() -> None:
    print("\n########## 阶段 syntax（node --check）")
    files = ["initBackground.sw.js", "js/pages/config.js", "js/pages/video.js",
             "js/pages/background.js", "js/pages/live.js", "js/pages/message.js",
             "js/pages/popup.js"]
    for variant, prod in VARIANTS.items():
        for rel in files:
            p = os.path.join(prod, rel.replace("/", os.sep))
            r = subprocess.run([NODE, "--check", p], capture_output=True, text=True)
            check(f"node --check [{variant}] {rel}", r.returncode == 0,
                  (r.stderr or "").strip()[:400])
    # 未改动的几个也没坏（防止误伤）
    for rel in ("js/pages/article.js", "js/pages/website.js", "downloader.sw.js", "notification.sw.js"):
        p = os.path.join(VARIANTS["unlock"], rel.replace("/", os.sep))
        r = subprocess.run([NODE, "--check", p], capture_output=True, text=True)
        check(f"node --check [unlock] {rel}", r.returncode == 0, (r.stderr or "").strip()[:300])


# ---------------------------------------------------------------- main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all", choices=["audit", "apply", "syntax", "manifest", "all"])
    ap.add_argument("--variant", default="unlock", choices=list(VARIANTS))
    ap.add_argument("--log", default=None)
    args = ap.parse_args(argv)

    t0 = time.time()
    print(f"verify-independent.py  开始 {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"python={sys.version.split()[0]}  node={NODE}")

    if args.stage in ("audit", "all"):
        stage_audit(args.variant)
    if args.stage in ("apply", "manifest", "all"):
        stage_apply(args.variant)
        if args.variant == "unlock":
            stage_apply("sameId")
    if args.stage in ("syntax", "all"):
        stage_syntax()

    print("\n================ 汇总 ================")
    print(f"检查项={len(CHECKS)}  失败={len(FAILS)}  用时={time.time()-t0:.1f}s")
    for f in FAILS:
        print(f"  FAIL: {f}")
    print("RESULT:", "PASS" if not FAILS else f"FAIL ({len(FAILS)})")

    if args.log:
        os.makedirs(os.path.dirname(args.log), exist_ok=True)
        lines = [f"{'PASS' if ok else 'FAIL'} :: {n} :: {d}" for n, ok, d in CHECKS]
        with open(args.log, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
            fh.write(f"\nRESULT: {'PASS' if not FAILS else 'FAIL'}\n")
        print(f"清单已写入 {args.log}")

    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
