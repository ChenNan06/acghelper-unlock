#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""static-dump.py — 按文件+偏移 dump 上下文，用于人工核对原文与 patch old 串唯一性"""
import sys, os, json

ROOT = r"D:\AI-Project\逆向统一\acghelper\src\extracted"

def read(relp):
    p = os.path.join(ROOT, relp.replace("/", os.sep))
    with open(p, "rb") as fh:
        return fh.read().decode("utf-8", "replace")

def dump(relp, off, before=300, after=300):
    s = read(relp)
    a = max(0, off - before); b = min(len(s), off + after)
    print(f"===== {relp} @{off} (size={len(s)}) =====")
    print(s[a:b])
    print()

def count(relp, needle):
    s = read(relp)
    n = s.count(needle)
    print(f"[count] {relp} : s.count({needle!r}) == {n}")
    if n >= 1:
        i = -1
        while True:
            i = s.find(needle, i + 1)
            if i < 0: break
            print(f"        offset={i}")
    return n

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "dump":
        dump(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]) if len(sys.argv) > 4 else 300,
             int(sys.argv[5]) if len(sys.argv) > 5 else 300)
    elif cmd == "count":
        for f in sys.argv[3:]:
            count(sys.argv[2], f)
