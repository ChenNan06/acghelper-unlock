#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tree-diff.py —— 逐文件比对两棵扩展树（只读），列出「只在 A / 只在 B / 内容不同」

用途：证明 build/batch-inpanel-test == r3 成品树 只差 js/pages/acgx-batch.js 一个文件。

用法：python tools/tree-diff.py A B
"""
from __future__ import annotations

import hashlib
import os
import sys


def walk(root):
    out = {}
    for dp, dns, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            out[rel] = p
    return out


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for c in iter(lambda: fh.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def main():
    a, b = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    A, B = walk(a), walk(b)
    only_a = sorted(set(A) - set(B))
    only_b = sorted(set(B) - set(A))
    common = sorted(set(A) & set(B))
    diff = []
    for rel in common:
        if sha(A[rel]) != sha(B[rel]):
            diff.append(rel)
    print(f"A = {a}  ({len(A)} files)")
    print(f"B = {b}  ({len(B)} files)")
    print(f"只在 A : {len(only_a)}")
    for r in only_a:
        print("   -", r)
    print(f"只在 B : {len(only_b)}")
    for r in only_b:
        print("   +", r)
    print(f"内容不同: {len(diff)}")
    for r in diff:
        print(f"   ~ {r:44s} A={sha(A[r])[:16]}…  B={sha(B[r])[:16]}…  "
              f"A={os.path.getsize(A[r])}B  B={os.path.getsize(B[r])}B")
    print("-" * 90)
    total = len(only_a) + len(only_b) + len(diff)
    print(f"合计差异 = {total} 项 —— {'完全一致' if total == 0 else '见上表'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
