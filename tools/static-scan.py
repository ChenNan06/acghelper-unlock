#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
static-scan.py — ACGhelper 2.8.31.16 会员锁静态普查
只读 src/extracted，不修改任何样本文件。
用法: python static-scan.py [--section all|vipmod|roles|assign|uigate|bhaccount|telemetry|context]
"""
import os, re, sys, json, io

ROOT = r"D:\AI-Project\逆向统一\acghelper\src\extracted"
OUT  = r"D:\AI-Project\逆向统一\acghelper\docs"

def walk(root):
    for dp, dn, fn in os.walk(root):
        for f in fn:
            if f.endswith(".js"):
                yield os.path.join(dp, f)

FILES = sorted(walk(ROOT), key=lambda p: -os.path.getsize(p))

def read(p):
    with open(p, "rb") as fh:
        return fh.read().decode("utf-8", "replace")

def rel(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")

# ---------------------------------------------------------------- section: vipmod
# 模块 3078 特征: identities.map((({name:e,to:a,hasDateTimeLimit:i})=>...
VIPMOD_RE = re.compile(r"identities\.map\(\(\{name:\w+,to:\w+,hasDateTimeLimit:\w+\}\)")
# 更宽松: 任何出现 identities 的 map 调用
IDENT_ANY = re.compile(r"identities")

def section_vipmod():
    print("=" * 100)
    print("[A] 模块 3078 / 4707 全量定位")
    print("=" * 100)
    total = 0
    for p in FILES:
        s = read(p)
        hits = [m.start() for m in VIPMOD_RE.finditer(s)]
        idn  = [m.start() for m in IDENT_ANY.finditer(s)]
        if hits or idn:
            print(f"\n--- {rel(p)}  size={len(s)}")
            print(f"    module3078 signature hits={len(hits)} offsets={hits}")
            print(f"    'identities' occurrences={len(idn)} offsets={idn[:40]}")
            total += len(hits)
            for h in hits:
                a = max(0, h - 260); b = min(len(s), h + 220)
                print(f"    [{h}] ...{s[a:b]}...")
    print(f"\nTOTAL module3078 signature = {total}")

    print("\n" + "-" * 100)
    print("[A2] 角色数组 4707: superAdmin/admin/catForever/catVIP")
    for p in FILES:
        s = read(p)
        for m in re.finditer(r'\["superAdmin","admin","catForever","catVIP"\]|\["superAdmin","admin","catForever"\]', s):
            a = max(0, m.start() - 200); b = min(len(s), m.end() + 200)
            print(f"\n--- {rel(p)} [{m.start()}]")
            print(f"    ...{s[a:b]}...")

    print("\n" + "-" * 100)
    print("[A3] 等价实现排查: role 白名单比较 / identities[0].name / catVIP 字面量")
    for p in FILES:
        s = read(p)
        for pat, name in [
            (r'identities\[\s*0\s*\]', 'identities[0]'),
            (r'\.identities\s*&&', 'identities &&'),
            (r'\.identities\.length', 'identities.length'),
            (r'["\']catVIP["\']', 'literal catVIP'),
            (r'["\']catForever["\']', 'literal catForever'),
            (r'["\']superAdmin["\']', 'literal superAdmin'),
        ]:
            offs = [m.start() for m in re.finditer(pat, s)]
            if offs:
                print(f"  {rel(p):55s} {name:22s} n={len(offs):3d} {offs[:20]}")

# ---------------------------------------------------------------- section: assign
ASSIGN_RE = re.compile(r"this\.(isVIP|isSuperVIP)\s*=")

def section_assign():
    print("\n" + "=" * 100)
    print("[C] isVIP / isSuperVIP 所有赋值点与消费点")
    print("=" * 100)
    for p in FILES:
        s = read(p)
        asg = [m.start() for m in ASSIGN_RE.finditer(s)]
        if asg:
            print(f"\n--- {rel(p)}")
            for o in asg:
                a = max(0, o - 120); b = min(len(s), o + 150)
                print(f"    赋值 [{o}] ...{s[a:b]}...")
        # 消费点: .isVIP / ["isVIP"] / isSuperVIP 读取
        con = [m.start() for m in re.finditer(r'\.isVIP\b|\.isSuperVIP\b|\[\s*["\']isVIP["\']\s*\]|\[\s*["\']isSuperVIP["\']\s*\]', s)]
        if con:
            print(f"    消费点 n={len(con)}")
            for o in con:
                a = max(0, o - 150); b = min(len(s), o + 130)
                print(f"       [{o}] ...{s[a:b]}...")

# ---------------------------------------------------------------- section: uigate
UIGATE_RE = re.compile(r'\[\s*["\']isVIP["\']\s*\]|\[\s*["\']isSuperVIP["\']\s*\]')
PAY_RE   = re.compile(r'sendPaymentMessage|openPayPage|paymentMessage')

def section_uigate():
    print("\n" + "=" * 100)
    print("[4] UI 门控: !!t && t[isVIP] / sendPaymentMessage")
    print("=" * 100)
    for p in FILES:
        s = read(p)
        g = [m.start() for m in UIGATE_RE.finditer(s)]
        pay = [m.start() for m in PAY_RE.finditer(s)]
        if not (g or pay):
            continue
        print(f"\n--- {rel(p)}  gates={len(g)} pay={len(pay)}")
        for o in g:
            a = max(0, o - 260); b = min(len(s), o + 160)
            print(f"    GATE [{o}] ...{s[a:b]}...")
        for o in pay:
            a = max(0, o - 200); b = min(len(s), o + 120)
            print(f"    PAY  [{o}] ...{s[a:b]}...")

# ---------------------------------------------------------------- section: bhaccount
def section_bhaccount():
    print("\n" + "=" * 100)
    print("[B] bhAccount 生命周期")
    print("=" * 100)
    for p in FILES:
        s = read(p)
        for pat, name in [
            (r'bhAccount', 'bhAccount'),
            (r'bilibiliHelperAccountController', 'biliHelperAccountCtl'),
            (r'hasLogin', 'hasLogin'),
            (r'accountChanged', 'accountChanged'),
            (r'getStatus', 'getStatus'),
            (r'identities', 'identities'),
        ]:
            offs = [m.start() for m in re.finditer(pat, s)]
            if offs:
                print(f"  {rel(p):50s} {name:24s} n={len(offs):3d} {offs[:12]}")

# ---------------------------------------------------------------- section: telemetry
def section_telemetry():
    print("\n" + "=" * 100)
    print("[E] 完整性 / 遥测")
    print("=" * 100)
    pats = [
        (r'getManifest\(\)\.version', 'getManifest().version'),
        (r'googletagmanager', 'googletagmanager'),
        (r'google-analytics', 'google-analytics'),
        (r'gtag\(', 'gtag('),
        (r'dataLayer', 'dataLayer'),
        (r'G-[A-Z0-9]{8,}', 'GA4 measurement id'),
        (r'UA-\d{4,}-\d+', 'UA id'),
        (r'acghelper\.com', 'acghelper.com'),
        (r'sendBeacon', 'sendBeacon'),
        (r'crx', 'crx'),
    ]
    for p in FILES:
        s = read(p)
        line = []
        for pat, name in pats:
            offs = [m.start() for m in re.finditer(pat, s)]
            if offs:
                line.append(f"{name}={len(offs)}{offs[:6]}")
        if line:
            print(f"  {rel(p)}\n      " + "\n      ".join(line))

if __name__ == "__main__":
    sec = sys.argv[1] if len(sys.argv) > 1 else "all"
    if sec in ("all", "vipmod"):    section_vipmod()
    if sec in ("all", "assign"):    section_assign()
    if sec in ("all", "uigate"):    section_uigate()
    if sec in ("all", "bhaccount"): section_bhaccount()
    if sec in ("all", "telemetry"): section_telemetry()
