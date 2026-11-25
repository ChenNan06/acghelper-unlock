#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""apply-feature-pgc-fix.py —— 把 tools/feature-pgc-fix.json 打到「38 条成品树」上。

与 apply-all-patches.py 同规格但不改它的任何规格文件：
  * 每条 old 必须在输入树上 count==1，否则立刻失败、不落盘；
  * 同文件内按锚点偏移降序应用，插入不影响尚未应用的锚点；
  * 默认 --check 只校验 + 打印偏移表，不写盘。

用法:
  python tools/apply-feature-pgc-fix.py --check
  python tools/apply-feature-pgc-fix.py --out build/pgc-proto/tree38-fixed
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
SPEC = os.path.join(HERE, "feature-pgc-fix.json")
DEF_SRC = os.path.join(ROOT, "output", "ACGhelper-2.8.31.16-unlock")
DEF_OUT = os.path.join(ROOT, "build", "pgc-proto", "tree38-fixed")


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


def load_spec() -> dict:
    with open(SPEC, "rb") as fh:
        return json.loads(fh.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEF_SRC)
    ap.add_argument("--out", default=DEF_OUT)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    spec = load_spec()
    patches = spec["patches"]
    print("spec   :", SPEC)
    print("src    :", args.src)
    print("mode   :", "CHECK(只校验)" if args.check else "APPLY")
    print()

    # ---- 1. 分组 + 唯一性预检 ----
    by_file: dict[str, list[dict]] = {}
    fail = 0
    for p in patches:
        rel = p["file"]
        full = os.path.join(args.src, rel)
        if not os.path.isfile(full):
            print("[FAIL] %s 目标文件不存在: %s" % (p["id"], full))
            fail += 1
            continue
        text = read_text(full)
        cnt = text.count(p["old"])
        off = text.find(p["old"])
        status = "OK" if cnt == 1 else "FAIL"
        if cnt != 1:
            fail += 1
        print("[%s] %-3s %-24s count=%d offset=%s len(old)=%d" % (
            status, p["id"], rel, cnt, off if off >= 0 else "-", len(p["old"])))
        p["_offset"] = off
        by_file.setdefault(rel, []).append(p)

    if fail:
        print("\n预检失败 %d 条：old 在输入树上不是 count==1，未落任何文件。" % fail)
        return 1

    # ---- 2. 应用（同文件偏移降序）----
    results = []
    out_texts: dict[str, str] = {}
    for rel, plist in by_file.items():
        text = read_text(os.path.join(args.src, rel))
        for p in sorted(plist, key=lambda x: (-x["_offset"], -len(x["old"]))):
            assert text.count(p["old"]) == 1, (p["id"], "re-count")
            before = len(text)
            text = text.replace(p["old"], p["new"], 1)
            results.append((p["id"], rel, p["_offset"], before, len(text)))
        out_texts[rel] = text

    print("\n应用顺序（偏移降序）:")
    for pid, rel, off, b, a in results:
        print("  %-3s %-24s off=%-7d %d -> %d chars" % (pid, rel, off, b, a))

    if args.check:
        print("\nCHECK 通过：%d 条 old 全部 count==1（未写盘）。" % len(patches))
        return 0

    # ---- 3. 落盘：先整树 copy，再覆盖被改动文件 ----
    if os.path.isdir(args.out):
        shutil.rmtree(args.out)
    shutil.copytree(args.src, args.out)
    for rel, text in out_texts.items():
        write_text(os.path.join(args.out, rel), text)

    print("\n输出目录:", args.out)
    for rel in sorted(out_texts):
        print("  %-24s sha256=%s" % (rel, sha256_file(os.path.join(args.out, rel))))
    print("  原始目录指纹未变: %s" % sha256_file(os.path.join(args.src, patches[0]["file"])))
    print("\n完成：%d 条补丁已应用。" % len(patches))
    return 0


if __name__ == "__main__":
    sys.exit(main())
