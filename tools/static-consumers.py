#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
static-consumers.py — isVIP / isSuperVIP 全消费点聚类
按 webpack 模块归属聚拢，输出 模块 id + 偏移 + 上下文，用于还原"哪个功能被门控"。
"""
import os, re, sys

ROOT = r"D:\AI-Project\逆向统一\acghelper\src\extracted"
MOD_RE = re.compile(r'(?<![0-9A-Za-z_$])(\d{1,5}):\((?:e|module|t)\s*,\s*[a-zA-Z_$]\s*,\s*[a-zA-Z_$]\s*\)\s*=>')

CONSUMER = re.compile(
    r'(?:\bthis\.(?:isVIP|isSuperVIP)\b'
    r'|\.isVIP\b|\.isSuperVIP\b'
    r'|\[\s*["\']isVIP["\']\s*\]|\[\s*["\']isSuperVIP["\']\s*\]'
    r'|["\']isVIP["\']\s*[,:}]'
    r'|\bmg\)\(|\bBN\)\(|\bmg\b(?=\()|\bBN\b(?=\()'
    r')'
)

def walk(root):
    for dp, dn, fn in os.walk(root):
        for f in fn:
            if f.endswith(".js"):
                yield os.path.join(dp, f)

def read(p):
    with open(p, "rb") as fh:
        return fh.read().decode("utf-8", "replace")

def rel(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")

def dump(f, ctx=200):
    s = read(f)
    mods = [(int(m.group(1)), m.start()) for m in MOD_RE.finditer(s)]
    mods.sort(key=lambda x: x[1])
    starts = [o for _, o in mods]
    hits = list(CONSUMER.finditer(s))
    print(f"\n{'='*100}\n{rel(f)}  size={len(s)}  modules={len(mods)}  consumer-hits={len(hits)}\n{'='*100}")
    for m in hits:
        o = m.start()
        idx = 0
        for i, st in enumerate(starts):
            if st <= o:
                idx = i
            else:
                break
        mid = mods[idx][0] if mods else -1
        a = max(0, o - ctx); b = min(len(s), o + ctx)
        txt = s[a:b].replace("\n", " ")
        print(f"\n  [mod {mid}] @{o}  <<{m.group(0)}>>")
        print(f"    {txt}")

if __name__ == "__main__":
    files = sys.argv[1:]
    if not files:
        files = [p for p in walk(ROOT) if True]
        files = sorted(files, key=lambda x: -os.path.getsize(x))
    for f in files:
        p = f if os.path.isabs(f) else os.path.join(ROOT, f.replace("/", os.sep))
        dump(p)
