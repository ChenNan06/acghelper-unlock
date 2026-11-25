#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
static-mod.py — 按 webpack 模块 id 精确切片并输出全文/片段
用法: python static-mod.py <相对路径> <模块id> [before_ctx]
"""
import os, re, sys

ROOT = r"D:\AI-Project\逆向统一\acghelper\src\extracted"
MOD_RE = re.compile(r'(?<![0-9A-Za-z_$])(\d{1,5}):\((?:e|module|t)\s*,\s*[a-zA-Z_$]\s*,\s*[a-zA-Z_$]\s*\)\s*=>')

def read(p):
    with open(p, "rb") as fh:
        return fh.read().decode("utf-8", "replace")

def rel(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")

def slice_mod(relp, mid):
    s = read(os.path.join(ROOT, relp.replace("/", os.sep)))
    hits = sorted([(int(m.group(1)), m.start()) for m in MOD_RE.finditer(s)], key=lambda x: x[1])
    for i, (m, off) in enumerate(hits):
        if m == mid:
            end = hits[i + 1][1] if i + 1 < len(hits) else len(s)
            return s, off, end
    return s, None, None

if __name__ == "__main__":
    relp = sys.argv[1]; mid = int(sys.argv[2])
    s, a, b = slice_mod(relp, mid)
    if a is None:
        print(f"module {mid} not found in {relp}"); sys.exit(1)
    print(f"===== {relp} module {mid} @{a}..{b} len={b-a} =====")
    print(s[a:b])
