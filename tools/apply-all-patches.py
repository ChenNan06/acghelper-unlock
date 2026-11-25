#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply-all-patches.py —— ACGhelper 2.8.31.16 唯一权威构建脚本

把四路补丁合并成一条可复跑流水线：
  ① 授权层（static-patchspec.py 的 PATCHES，10 条，字符串锚定）
  ② 下载链路（proto-patch-spec.json，23 条，字符串锚定；offset 仅作记录）
  ③ 增补（extra-patch-spec.json，5 条：X1..X5，独立验收 R-1/R-2 闭环；默认开）
  ④ 可选（proto-patch-optional.json，2 条，默认不打，--with-optional 才打）
     —— B6 已被提为 X5 进 ③，若 ③ 已打则 ④ 自动跳过 B6，只补 B5（credentials:include）

  目标计数：默认 static 10 + proto 23 + extra 5 = 38 条；--with-optional 时 39 条（+B5）。

规则：
  * **分段应用**（不是一把梭）：static+proto → extra → optional。每段的锚点预检都在
    「上一段输出」的快照上做 —— 因为 X2/X3 的 old（`,!1)throw c.DOWNLOAD_TOO_FREQUENTLY…`）
    only exists after B2/B3，X4 的 old 嵌在 S08 的 new 里，pristine 里 count 都是 0。
  * 每条补丁应用前 assert 当前缓冲中 s.count(old) == 1；不满足立刻报 file / old / 实际 count
    并退出码非零，**不落任何半成品**（全部在内存里算完才写盘）。
  * extra 段额外做两项硬校验：① 锚点偏移必须等于 extra-patch-spec.json 里记录的
    「33 条成品树」偏移（对不上说明流水线前置文本与验收时的树不一致，直接失败）；
    ② 同文件内各锚点区间不得重叠。
  * 段内顺序：static→proto 内部按「原始偏移降序、旧串长度降序」；extra/optional 段按
    「当前缓冲偏移降序、旧串长度降序」，使任何后续插入都不会影响尚未应用的锚点。
  * 目标目录**先清空再重建**：全新 copytree(req src) 后只覆盖被改动的文件。
  * src/extracted 只读：构建前后各算一次目录指纹，必须一致。

产出（默认输出到 output/）：
  ACGhelper-2.8.31.16-unlock/           完整扩展树（无 key，新扩展 ID）
  ACGhelper-2.8.31.16-unlock.zip        同目录内容打包（zip 内无父目录）
  ACGhelper-2.8.31.16-unlock-sameId/    注入 "key"，扩展 ID 与商店版一致
  ACGhelper-2.8.31.16-unlock-sameId.zip
  _patch-report.json / _build-info.json

用法：
  python tools/apply-all-patches.py --check           # 只校验锚点唯一性 + 内存演练，不写盘
  python tools/apply-all-patches.py                   # 完整构建（38 条）
  python tools/apply-all-patches.py --with-optional   # 额外打 B5（39 条；B6 自动跳过）
  python tools/apply-all-patches.py --src ... --out ...
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

DEF_SRC = os.path.join(ROOT, "src", "extracted")
DEF_OUT = os.path.join(ROOT, "output")

STATIC_SPEC = os.path.join(HERE, "static-patchspec.py")
PROTO_SPEC = os.path.join(HERE, "proto-patch-spec.json")
EXTRA_SPEC = os.path.join(HERE, "extra-patch-spec.json")
PROTO_OPT = os.path.join(HERE, "proto-patch-optional.json")
KEY_FILE = os.path.join(HERE, "original-public-key.txt")

SRC_ZIP = os.path.join(ROOT, "acg-helper-2.8.31.16.zip")
STOREFRONT_ID = "kpbnombpnpcffllnianjibmpadjolanh"

PROD_PLAIN = "ACGhelper-2.8.31.16-unlock"
PROD_SAMEID = "ACGhelper-2.8.31.16-unlock-sameId"
VERSION_NAME = "2.8.31.16(Beta) unlock"

PHASE_ORDER = {"static": 0, "proto": 1, "extra": 2, "optional": 3}
ROUTE = {"static": "授权层", "proto": "下载链路",
         "extra": "增补（独立验收 R-1/R-2）", "optional": "下载链路·可选"}
# 分段：第 1 段在 pristine 上预检；第 2/3 段在上一段输出的快照上预检
STAGE_1 = ("static", "proto")
STAGE_2 = ("extra",)
STAGE_3 = ("optional",)


# ---------------------------------------------------------------- 基础工具
def read_text(path: str) -> str:
    with open(path, "rb") as fh:
        return fh.read().decode("utf-8", "replace")


def write_text(path: str, text: str) -> None:
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(text.encode("utf-8"))


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_fingerprint(root: str) -> str:
    """目录指纹：按相对路径排序，把 (relpath, size, sha256) 串起来再哈希。"""
    h = hashlib.sha256()
    for dp, dns, fns in os.walk(root):
        dns.sort()
        for fn in sorted(fns):
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            h.update(rel.encode("utf-8"))
            h.update(b"\x00")
            h.update(str(os.path.getsize(full)).encode("ascii"))
            h.update(b"\x00")
            h.update(sha256_file(full).encode("ascii"))
            h.update(b"\n")
    return h.hexdigest()


# ---------------------------------------------------------------- 读规格
def load_static_patches():
    """从 tools/static-patchspec.py 里 import PATCHES —— 唯一真源，不复制、不改写。"""
    spec = importlib.util.spec_from_file_location("_acg_static_patchspec", STATIC_SPEC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # 模块里只有常量与函数定义，__main__ 守卫挡住副作用
    return list(mod.PATCHES)


def load_json(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_extra():
    """extra-patch-spec.json 的 patches 数组（X1..X5）。"""
    data = load_json(EXTRA_SPEC)
    return list(data["patches"])


def collect(static, proto, extra, optional, with_optional: bool):
    items, skipped = [], []
    for i, (f, old, new, note) in enumerate(static, 1):
        items.append(dict(id=f"S{i:02d}", phase="static", route=ROUTE["static"],
                          file=f, old=old, new=new, note=note, priority="P0"))
    for i, p in enumerate(proto, 1):
        items.append(dict(id=f"P{i:02d}", phase="proto", route=ROUTE["proto"],
                          file=p["file"], old=p["old"], new=p["new"], note=p["effect"],
                          spec_offset=p.get("offset"), priority="P0"))
    for p in extra:
        items.append(dict(id=p["id"], phase="extra",
                          route=p.get("route") or ROUTE["extra"],
                          file=p["file"], old=p["old"], new=p["new"],
                          note=p.get("why") or p.get("new", "")[:60],
                          effect=p.get("why"), spec_offset=p.get("offset"),
                          priority=p.get("priority", "P1")))
    if with_optional:
        extra_olds = {it["old"] for it in items if it["phase"] == "extra"}
        for i, p in enumerate(optional, 1):
            oid = f"O{i:02d}"
            if p["old"] in extra_olds:
                skipped.append(dict(id=oid, file=p["file"],
                                    reason="锚点与 extra 阶段已应用的补丁相同（B6 → X5），跳过以免锚点失配",
                                    effect=p.get("effect")))
                continue
            items.append(dict(id=oid, phase="optional", route=ROUTE["optional"],
                              file=p["file"], old=p["old"], new=p["new"],
                              note=p["effect"], spec_offset=p.get("offset"), priority="P2"))
    return items, skipped


def order_items(items, snapshot):
    """排序：阶段 static→proto→extra→optional → 同文件『快照内偏移』降序 → 旧串长度降序。"""
    def key(it):
        s = snapshot[it["file"]]
        off = s.find(it["old"])
        return (PHASE_ORDER[it["phase"]], it["file"], -off, -len(it["old"]))
    return sorted(items, key=key)


# ---------------------------------------------------------------- 内存演练
class PatchError(RuntimeError):
    pass


def apply_stage(buf: dict, stage_items, tag: str, assert_spec_offset: bool,
                report: list, order_base: int) -> int:
    """在 buf（就地修改）上应用一段补丁。

    * 预检：以**进入本段时**的 buf 快照为准，逐条要求 count(old)==1；
      assert_spec_offset 时还要求找到的偏移 == spec_offset。
    * 同文件区间重叠检查。
    * 应用顺序：按该快照里的偏移降序、旧串长度降序。
    """
    if not stage_items:
        return order_base
    snapshot = {f: buf[f] for f in {it["file"] for it in stage_items}}
    problems, anchors = [], []
    for it in stage_items:
        s = snapshot[it["file"]]
        c = s.count(it["old"])
        off = s.find(it["old"])
        anchors.append(dict(id=it["id"], file=it["file"], stage=tag,
                            count_in_stage_input=c, offset_in_stage_input=off,
                            spec_offset=it.get("spec_offset"),
                            offset_matches_spec=(off == it.get("spec_offset")
                                                 if it.get("spec_offset") is not None else None)))
        if c != 1:
            problems.append((it, c, f"{tag} 阶段输入里锚点不唯一"))
        elif assert_spec_offset and it.get("spec_offset") is not None and off != it["spec_offset"]:
            problems.append((it, c, f"锚点偏移 {off} != 规格记录的成品树偏移 {it['spec_offset']}"))
    by_file = {}
    for it in stage_items:
        off = snapshot[it["file"]].find(it["old"])
        if off >= 0:
            by_file.setdefault(it["file"], []).append((off, off + len(it["old"]), it["id"]))
    for f, spans in by_file.items():
        spans.sort()
        for a, b in zip(spans, spans[1:]):
            if a[1] > b[0]:
                it = next(x for x in stage_items if x["id"] == b[2])
                problems.append((it, 1, f"{tag} 阶段：与 {a[2]} 在 {f} 内区间重叠"))
    if problems:
        lines = [f"{tag} 阶段锚点预检失败（未写任何文件）："]
        for it, c, why in problems:
            lines.append(f"  [{it['id']}] {it['file']}  count={c}  {why}\n"
                         f"      old={it['old'][:140]!r}")
        raise PatchError("\n".join(lines))

    ordered = order_items(stage_items, snapshot)
    for it in ordered:
        s = buf[it["file"]]
        c = s.count(it["old"])
        if c != 1:
            raise PatchError(
                f"{tag} 阶段锚点失配（未写任何文件）：\n"
                f"  [{it['id']}] {it['file']}\n"
                f"  count(old) = {c}  (要求 1)\n"
                f"  old = {it['old'][:200]!r}")
        off = s.find(it["old"])
        buf[it["file"]] = s[:off] + it["new"] + s[off + len(it["old"]):]
        report.append(dict(order=len(report) + 1, id=it["id"], phase=it["phase"],
                           stage=tag, route=it["route"], priority=it.get("priority"),
                           file=it["file"], offset_in_file=off,
                           offset_in_stage_input=next(a["offset_in_stage_input"] for a in anchors
                                                      if a["id"] == it["id"]),
                           spec_offset=it.get("spec_offset"),
                           old_len=len(it["old"]), new_len=len(it["new"]),
                           note=(it.get("note") or "")[:300],
                           old_head=it["old"][:80], new_head=it["new"][:80]))
    for a in anchors:
        report_match = next(r for r in report if r["id"] == a["id"] and r["stage"] == tag)
        report_match["anchor_audit"] = a
    return len(report)


def simulate(src_root: str, items):
    """分段在内存里应用全部补丁；任何一条不满足即抛 PatchError（不写盘）。"""
    files = sorted({it["file"] for it in items})
    pristine = {f: read_text(os.path.join(src_root, f.replace("/", os.sep))) for f in files}
    by_phase = {}
    for it in items:
        by_phase.setdefault(it["phase"], []).append(it)

    # ---- 预检 0（仅第 1 段）：pristine 上锚点唯一 + 区间不重叠 ----
    stage1 = [it for ph in STAGE_1 for it in by_phase.get(ph, [])]
    problems = []
    for it in stage1:
        c = pristine[it["file"]].count(it["old"])
        if c != 1:
            problems.append((it, c, "原始文件锚点不唯一"))
    by_file = {}
    for it in stage1:
        off = pristine[it["file"]].find(it["old"])
        if off >= 0:
            by_file.setdefault(it["file"], []).append((off, off + len(it["old"]), it["id"]))
    for f, spans in by_file.items():
        spans.sort()
        for a, b in zip(spans, spans[1:]):
            if a[1] > b[0]:
                it = next(x for x in stage1 if x["id"] == b[2])
                problems.append((it, pristine[f].count(it["old"]), f"与 {a[2]} 原始区间重叠"))
    if problems:
        lines = ["补丁锚点预检失败（未写任何文件）："]
        for it, c, why in problems:
            lines.append(f"  [{it['id']}] {it['file']}  count={c}  {why}\n"
                         f"      old={it['old'][:120]!r}")
        raise PatchError("\n".join(lines))

    buf = dict(pristine)
    report: list = []
    # ---- 第 1 段：static + proto（锚点在 pristine 上）----
    n = apply_stage(buf, stage1, "pristine", False, report, 0)
    # ---- 第 2 段：extra（锚点在 proto 输出上，偏移须与规格一致）----
    n = apply_stage(buf, by_phase.get("extra", []), "post-proto", True, report, n)
    # ---- 第 3 段：optional（B5；B6 已在 extra 阶段跳过）----
    apply_stage(buf, by_phase.get("optional", []), "post-extra", False, report, n)
    return pristine, buf, report


# ---------------------------------------------------------------- manifest
def patch_manifest_text(text: str, key_b64: str | None) -> str:
    data = json.loads(text)
    data["version_name"] = VERSION_NAME
    if key_b64:
        data["key"] = key_b64
    return json.dumps(data, ensure_ascii=False, indent=4) + "\n"


def ext_id_from_key(key_b64: str) -> str:
    der = base64.b64decode(key_b64)
    h = hashlib.sha256(der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in h)


# ---------------------------------------------------------------- 落盘
def build_tree(dest: str, src_root: str, buf: dict, key_b64: str | None) -> None:
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    elif os.path.exists(dest):
        os.remove(dest)
    tmp = dest + ".tmp"
    if os.path.isdir(tmp):
        shutil.rmtree(tmp)
    shutil.copytree(src_root, tmp)  # 全量全新拷贝
    for rel, text in buf.items():
        write_text(os.path.join(tmp, rel.replace("/", os.sep)), text)
    mpath = os.path.join(tmp, "manifest.json")
    write_text(mpath, patch_manifest_text(read_text(mpath), key_b64))
    os.replace(tmp, dest)


def make_zip(tree: str, zip_path: str) -> tuple[str, int]:
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for dp, dns, fns in os.walk(tree):
            dns.sort()
            for fn in sorted(fns):
                full = os.path.join(dp, fn)
                rel = os.path.relpath(full, tree).replace(os.sep, "/")
                z.write(full, rel)          # 无父目录
    return sha256_file(zip_path), os.path.getsize(zip_path)


def chrome_version() -> str:
    base = r"C:\Program Files\Google\Chrome\Application"
    try:
        for name in os.listdir(base):
            if name[:1].isdigit() and os.path.isdir(os.path.join(base, name)):
                return name
    except OSError:
        pass
    return "unknown"


def node_version() -> str:
    try:
        return subprocess.run(["node", "--version"], capture_output=True, text=True,
                              timeout=20).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


# ---------------------------------------------------------------- main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="ACGhelper 2.8.31.16 合并补丁构建器")
    ap.add_argument("--src", default=DEF_SRC, help="原始解包目录（只读）")
    ap.add_argument("--out", default=DEF_OUT, help="输出目录")
    ap.add_argument("--with-optional", action="store_true",
                    help="额外打 B5（credentials:include）；B6 已在 extra 阶段以 X5 应用，自动跳过")
    ap.add_argument("--check", action="store_true", help="只校验锚点与内存演练，不写盘")
    args = ap.parse_args(argv)

    src = os.path.abspath(args.src)
    out = os.path.abspath(args.out)
    if not os.path.isdir(src):
        print(f"[FATAL] 源目录不存在: {src}")
        return 2

    static = load_static_patches()
    proto = load_json(PROTO_SPEC)
    extra = load_extra()
    optional = load_json(PROTO_OPT)
    items, skipped = collect(static, proto, extra, optional, args.with_optional)

    key_b64 = read_text(KEY_FILE).strip()
    if len(key_b64) != 216:
        print(f"[WARN] original-public-key.txt 长度 {len(key_b64)} != 216")

    print(f"源目录      : {src}")
    print(f"输出目录    : {out}")
    print(f"补丁规格    : static={len(static)}  proto={len(proto)}  extra={len(extra)}"
          f"  optional={len(optional)}（可用）")
    print(f"本次应用    : {len(items)} 条 = static {len(static)} + proto {len(proto)}"
          f" + extra {len(extra)}"
          f" + optional {len(items) - len(static) - len(proto) - len(extra)}"
          f"（{'含' if args.with_optional else '不含'} --with-optional）")
    if skipped:
        for s in skipped:
            print(f"  跳过可选   : [{s['id']}] {s['file']}  {s['reason']}")
    print("分段顺序    : pristine(static→proto) → post-proto(extra) → post-extra(optional)")
    print("-" * 120)

    src_fp_before = tree_fingerprint(src)
    try:
        pristine, buf, report = simulate(src, items)
    except PatchError as e:
        print(f"[FAIL] {e}")
        return 1

    print("锚点审计（每段都在『上一段输出的快照』上做）：")
    for r in report:
        a = r.get("anchor_audit") or {}
        match = a.get("offset_matches_spec")
        mtxt = "n/a" if match is None else ("OK" if match else "MISMATCH")
        print(f"  [{r['id']:4s}] {r['stage']:10s} {r['file']:26s} "
              f"count={a.get('count_in_stage_input')}  off={a.get('offset_in_stage_input')!s:>7s} "
              f"spec={a.get('spec_offset')!s:>7s} {mtxt}")
    print("-" * 120)
    for r in report:
        print(f"  #{r['order']:02d} [{r['id']}] {r['phase']:8s} {r['file']:26s} "
              f"off={r['offset_in_file']:>7d} old={r['old_len']:>3d} new={r['new_len']:>3d}"
              f"  {r['note'][:48]}")
    print("-" * 120)
    changed = {f: (len(pristine[f]), len(buf[f])) for f in buf}
    print(f"锚点预检：全部 count==1（{len(report)}/{len(report)}）；重叠检查：无")
    expect_total = len(static) + len(proto) + len(extra) + (
        len(optional) - len(skipped) if args.with_optional else 0)
    if len(report) != expect_total:
        print(f"[FAIL] 应用条数 {len(report)} != 期望 {expect_total}")
        return 1
    print(f"改动文件：{len(changed)} 个")
    for f, (a, b) in sorted(changed.items()):
        print(f"  {f:28s} {a:>7d} -> {b:>7d}  ({b - a:+d} bytes)")

    # 语义自检：每个 new 里若包含自己的 old（如 P-A 的自包含写法），文件里应出现恰好 2 次
    self_contained = [r["id"] for r in report
                      if any(it["old"] in it["new"] for it in items if it["id"] == r["id"])]
    print(f"自包含型补丁（new 含 old，属预期）：{self_contained or '无'}")

    # 可选补丁锚点可用性（默认不打，只报告）
    if optional:
        print("可选补丁锚点（默认不打）：")
        for i, p in enumerate(optional, 1):
            if any(s["id"] == f"O{i:02d}" for s in skipped):
                print(f"  [O{i:02d}] {p['file']:24s} 已在 extra 阶段应用（X5），跳过")
                continue
            print(f"  [O{i:02d}] {p['file']:24s} 可打，触发条件：{p['effect'][:48]}")

    if args.check:
        print("\n[CHECK ONLY] 未写任何文件。校验通过。")
        return 0

    # ---------------- 落盘 ----------------
    os.makedirs(out, exist_ok=True)
    plain_dir = os.path.join(out, PROD_PLAIN)
    same_dir = os.path.join(out, PROD_SAMEID)
    build_tree(plain_dir, src, buf, None)
    build_tree(same_dir, src, buf, key_b64)
    plain_zip = os.path.join(out, PROD_PLAIN + ".zip")
    same_zip = os.path.join(out, PROD_SAMEID + ".zip")
    pz_sha, pz_size = make_zip(plain_dir, plain_zip)
    sz_sha, sz_size = make_zip(same_dir, same_zip)

    computed_id = ext_id_from_key(key_b64)
    id_ok = computed_id == STOREFRONT_ID
    print(f"\n产物：\n  {plain_dir}\n  {plain_zip}  ({pz_size} bytes, sha256={pz_sha})")
    print(f"  {same_dir}\n  {same_zip}   ({sz_size} bytes, sha256={sz_sha})")
    print(f"key → 扩展 ID : {computed_id}  "
          f"{'== 商店版 ' + STOREFRONT_ID if id_ok else '!! 与商店版 ' + STOREFRONT_ID + ' 不一致'}")

    # ---------------- 报告 ----------------
    n_optional_applied = len([r for r in report if r["phase"] == "optional"])
    counts = dict(static=len([r for r in report if r["phase"] == "static"]),
                  proto=len([r for r in report if r["phase"] == "proto"]),
                  extra=len([r for r in report if r["phase"] == "extra"]),
                  optional_applied=n_optional_applied,
                  optional_available=len(optional),
                  optional_skipped=[s["id"] for s in skipped],
                  applied=len(report),
                  expected_total=expect_total)
    with open(os.path.join(out, "_patch-report.json"), "w", encoding="utf-8") as fh:
        json.dump(dict(
            generated_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            order_rule="分段 pristine(static→proto) → post-proto(extra) → post-extra(optional)；"
                       "段内同文件按快照偏移降序、旧串长度降序",
            stages=dict(stage1=list(STAGE_1), stage2=list(STAGE_2), stage3=list(STAGE_3)),
            with_optional=args.with_optional,
            counts=counts,
            patches=report), fh, ensure_ascii=False, indent=2)

    src_fp_after = tree_fingerprint(src)
    info = dict(
        built_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        manifest_version="2.8.31.16",
        version_name=VERSION_NAME,
        source_zip=dict(path=SRC_ZIP, sha256=sha256_file(SRC_ZIP),
                        size=os.path.getsize(SRC_ZIP)),
        source_dir=dict(path=src, sha256_tree=src_fp_before,
                        unchanged_before_after=(src_fp_before == src_fp_after)),
        patch_counts=counts,
        with_optional=args.with_optional,
        toolchain=dict(python=sys.version.split()[0], node=node_version(), chrome=chrome_version()),
        products=[
            dict(name=PROD_PLAIN, dir=plain_dir, zip=plain_zip, zip_size=pz_size,
                 zip_sha256=pz_sha, key_injected=False,
                 extension_id="(derived by Chrome, random)"),
            dict(name=PROD_SAMEID, dir=same_dir, zip=same_zip, zip_size=sz_size,
                 zip_sha256=sz_sha, key_injected=True, extension_id=computed_id,
                 key_matches_storefront=id_ok),
        ])
    with open(os.path.join(out, "_build-info.json"), "w", encoding="utf-8") as fh:
        json.dump(info, fh, ensure_ascii=False, indent=2)

    print(f"\n计数：{counts}")
    print(f"\n报告：{os.path.join(out, '_patch-report.json')}")
    print(f"      {os.path.join(out, '_build-info.json')}")
    print(f"src/extracted 指纹未变：{src_fp_before == src_fp_after}  ({src_fp_before[:16]}…)")
    if not id_ok or src_fp_before != src_fp_after:
        print("[FAIL] 关键自检未通过")
        return 1
    print("\nBUILD OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
