#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
feature-webdav-apply.py —— 应用 tools/feature-webdav.json（WebDAV 云同步功能补丁）

与 tools/apply-all-patches.py 解耦：不动它、不改它的三段式规格，
在 38 条成品树之上做「新增文件 + 3 处字符串补丁」的最后一步。

用法：
  python tools/feature-webdav-apply.py --check  --tree output/ACGhelper-2.8.31.16-unlock
  python tools/feature-webdav-apply.py --tree build/webdav-test/ACGhelper-2.8.31.16-unlock
  python tools/feature-webdav-apply.py --from output/ACGhelper-2.8.31.16-unlock \\
                                       --out  build/webdav-test/ACGhelper-2.8.31.16-unlock

规则（和主构建器一致的做法）：
  * 每条字符串补丁应用前 assert s.count(old) == 1，不满足立刻报 file / old / 实际 count 并非零退出；
  * 全部在内存里算完才写盘，不留半成品；
  * --check 只校验锚点唯一性，不写任何文件。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SPEC = os.path.join(HERE, "feature-webdav.json")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def load_spec() -> dict:
    with open(SPEC, encoding="utf-8") as f:
        return json.load(f)


def norm_patches(spec: dict) -> list:
    """兼容两种写法：
         {"copy": {"from":..,"to":..}, "why":..}
         {"file":.., "old":.., "new":.., "why":..}
       以及显式 kind 写法（本 spec 用的那种）。"""
    out = []
    for i, p in enumerate(spec.get("patches", [])):
        pid = p.get("id") or f"P{i}"
        if "copy" in p:
            out.append({"id": pid, "kind": "copy", "from": p["copy"]["from"],
                        "to": p["copy"]["to"], "why": p.get("why", "")})
        elif p.get("kind") == "copy" or ("from" in p and "to" in p):
            out.append({"id": pid, "kind": "copy", "from": p["from"], "to": p["to"],
                        "why": p.get("why", "")})
        else:
            out.append({"id": pid, "kind": "file", "file": p["file"], "old": p["old"],
                        "new": p["new"], "why": p.get("why", "")})
    return out


def check(tree: str, patches: list) -> list:
    """返回逐条校验结果；同时把所有文件读进内存供后续写入。"""
    results = []
    buffers: dict = {}
    for p in patches:
        if p["kind"] == "copy":
            src = os.path.join(ROOT, p["from"])
            dst = os.path.join(tree, p["to"])
            ok = os.path.isfile(src)
            results.append({
                "id": p["id"], "kind": "copy", "from": p["from"], "to": p["to"],
                "ok": ok, "srcBytes": os.path.getsize(src) if ok else 0,
                "srcSha256": sha256_file(src) if ok else None,
                "dstExistsBefore": os.path.exists(dst),
                "why": p["why"],
            })
        else:
            fp = os.path.join(tree, p["file"])
            if fp not in buffers:
                if not os.path.isfile(fp):
                    results.append({"id": p["id"], "kind": "file", "file": p["file"],
                                    "ok": False, "count": -1, "note": "文件不存在", "why": p["why"]})
                    continue
                buffers[fp] = open(fp, encoding="utf-8").read()
            c = buffers[fp].count(p["old"])
            ok = (c == 1)
            results.append({
                "id": p["id"], "kind": "file", "file": p["file"], "ok": ok, "count": c,
                "expect": 1, "oldPreview": p["old"][:70].replace("\n", "\\n"),
                "why": p["why"],
            })
            if ok:
                buffers[fp] = buffers[fp].replace(p["old"], p["new"], 1)
    return results, buffers


def print_table(rows: list) -> None:
    print(f"{'ID':<24} {'KIND':<6} {'TARGET':<46} {'RESULT'}")
    print("-" * 104)
    for r in rows:
        if r["kind"] == "copy":
            tgt = r["to"]
            res = f"OK  {r['srcBytes']}B  sha256={r['srcSha256'][:16]}…  dst_before={'Y' if r['dstExistsBefore'] else 'N'}" \
                if r["ok"] else "FAIL 源文件缺失"
        else:
            tgt = r["file"]
            res = f"OK   count={r['count']} (expect {r['expect']})" if r["ok"] \
                else f"FAIL count={r['count']} (expect 1)  old={r.get('oldPreview','')!r}"
        print(f"{r['id']:<24} {r['kind']:<6} {tgt:<46} {res}")
    print("-" * 104)
    ok = sum(1 for r in rows if r["ok"])
    print(f"合计 {len(rows)} 条：PASS {ok} / FAIL {len(rows)-ok}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", help="已存在的扩展树（原地打补丁）")
    ap.add_argument("--from", dest="src_tree", help="源扩展树（先复制到 --out）")
    ap.add_argument("--out", dest="out_tree", help="输出扩展树")
    ap.add_argument("--check", action="store_true", help="只校验锚点，不写盘")
    ap.add_argument("--json", action="store_true", help="额外输出 JSON 结果")
    args = ap.parse_args()

    spec = load_spec()
    patches = norm_patches(spec)
    print(f"spec         : {SPEC}")
    print(f"name/version : {spec.get('name')} v{spec.get('version')}  目标 {len(patches)} 条")
    print(f"basePatches  : {spec.get('basePatchCount')}（上游三段式成品树条数）")

    tree = args.tree
    if args.src_tree and args.out_tree:
        tree = args.out_tree
        if os.path.exists(tree):
            shutil.rmtree(tree)
        os.makedirs(os.path.dirname(tree), exist_ok=True)
        shutil.copytree(args.src_tree, tree)
        print(f"已复制     : {args.src_tree} -> {tree}")
    if not tree:
        ap.error("需要 --tree 或 --from/--out")
    print(f"目标树       : {tree}")
    print()

    rows, buffers = check(tree, patches)
    print_table(rows)
    if spec.get("checkCommand"):
        print(f"\n锚点校验命令（本 spec 记录的原始命令）：\n  {spec['checkCommand']}")

    fails = [r for r in rows if not r["ok"]]
    if fails:
        print("\n[FAIL] 以下补丁未通过锚点唯一性校验，未写入任何文件：")
        for r in fails:
            print(f"  - {r['id']}: {json.dumps(r, ensure_ascii=False)}")
        return 2

    if args.check:
        print("\n[check] 全部锚点唯一，未写盘（--check 模式）")
        return 0

    written = []
    for p in patches:
        if p["kind"] == "copy":
            src = os.path.join(ROOT, p["from"])
            dst = os.path.join(tree, p["to"])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            written.append({"to": p["to"], "bytes": os.path.getsize(dst), "sha256": sha256_file(dst)})
        else:
            fp = os.path.join(tree, p["file"])
            data = buffers[fp]
            with open(fp, "w", encoding="utf-8", newline="") as f:
                f.write(data)
            written.append({"file": p["file"], "bytes": len(data.encode("utf-8")),
                            "sha256": hashlib.sha256(data.encode("utf-8")).hexdigest()})

    print(f"\n[apply] 已写入 {len(written)} 个目标：")
    for w in written:
        print(f"  {w.get('to') or w.get('file'):<52} {w['bytes']:>8}B  {w['sha256'][:16]}…")

    if args.json:
        print("\n" + json.dumps({"patches": len(patches), "written": written,
                                 "spec": spec.get("name")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
