#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
static-modules.py — webpack 模块索引器
在 bundle 里定位每个 `NNNN:(e,t,n)=>{` 模块定义，输出 id -> 偏移/长度，
专门用于精确锁定 3078（会员判定器）与角色数组模块（4707 / 634）在各 bundle 的位置。
"""
import os, re, sys, json

ROOT = r"D:\AI-Project\逆向统一\acghelper\src\extracted"

MOD_RE = re.compile(r'(?<![0-9A-Za-z_$])(\d{1,5}):\((?:e|module|t)\s*,\s*[a-zA-Z_$]\s*,\s*[a-zA-Z_$]\s*\)\s*=>')

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

def build(s):
    hits = [(int(m.group(1)), m.start()) for m in MOD_RE.finditer(s)]
    # 去重（同 id 可能出现多次 -> 记录全部）
    return hits

if __name__ == "__main__":
    targets = [int(x) for x in sys.argv[1:]] or [3078]
    print(f"targets={targets}")
    for p in sorted(walk(ROOT), key=lambda x: -os.path.getsize(x)):
        s = read(p)
        hits = build(s)
        ids = {}
        for mid, off in hits:
            ids.setdefault(mid, []).append(off)
        found = {t: ids.get(t) for t in targets if ids.get(t)}
        if found:
            print(f"\n--- {rel(p)}  (modules={len(hits)}, size={len(s)})")
            for t, offs in found.items():
                print(f"    module {t}: offsets={offs}")
        # 角色数组模块：找 WH 导出
        for m in re.finditer(r'n\.d\(t,\{WH:\(\)=>', s):
            # 回溯找最近的模块 id
            prev = [h for h in hits if h[1] <= m.start()]
            mid = prev[-1][0] if prev else -1
            print(f"    [roles] {rel(p)} moduleID={mid} offset={m.start()} WH_export_at={m.start()}")
