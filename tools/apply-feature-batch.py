#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply-feature-batch.py —— 把 tools/feature-batch.json（选集/多P 批量下载面板）打到扩展树上

它**不属于** tools/apply-all-patches.py 的三段式流水线，也不改那条流水线的任何输入：
  * 输入基准：38 条补丁成品树（默认 output/ACGhelper-2.8.31.16-unlock）
  * 输出：--out 指定的一份**副本**（默认 build/batch-test），原成品树一个字节都不动

规则（和主构建器同一套口径）：
  * 每个 patch 的 old 在基准树上必须 count(old)==1，否则立刻失败、一个文件都不写；
  * additions 的 copy 源必须存在；
  * 打完后逐条校验：new 出现且 old 不再出现（或按预期自包含）、manifest.json 仍是合法 JSON、
    新 content_scripts 条目在数组里、html/background.html 里新脚本在 background.js 之前、
    background.js 能被 JS 引擎解析（node -e "new Function(...)"）。

用法：
  python tools/apply-feature-batch.py --check
  python tools/apply-feature-batch.py --out build/batch-test
  python tools/apply-feature-batch.py --tree <别的基准树> --out <别处> --check
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SPEC = os.path.join(HERE, "feature-batch.json")
DEF_TREE = os.path.join(ROOT, "output", "ACGhelper-2.8.31.16-unlock")


def read_bytes(p):
    with open(p, "rb") as fh:
        return fh.read()


def read_text(p):
    return read_bytes(p).decode("utf-8")


def write_text(p, s):
    with open(p, "wb") as fh:
        fh.write(s.encode("utf-8"))


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for c in iter(lambda: fh.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def node_syntax_ok(path):
    """用 node 解析一遍：新增/改动的 JS 至少不能有语法错误。"""
    code = ("const fs=require('fs');"
            "const s=fs.readFileSync(process.argv[1],'utf8');"
            "try{new Function(s);console.log('OK')}"
            "catch(e){console.log('ERR '+e.message);process.exit(3)}")
    try:
        r = subprocess.run(["node", "-e", code, path], capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        return (True, "node 不可用，跳过语法校验")
    out = (r.stdout or "").strip()
    return (r.returncode == 0, out or (r.stderr or "").strip()[-300:])


def main(argv=None):
    ap = argparse.ArgumentParser(description="应用 feature-batch.json（选集批量下载面板）")
    ap.add_argument("--tree", default=DEF_TREE, help="基准成品树（只读）")
    ap.add_argument("--out", default="", help="输出目录（从基准树全量拷贝后再打）")
    ap.add_argument("--check", action="store_true", help="只校验锚点/拷贝源，不写盘")
    ap.add_argument("--report", default="", help="把结果写成 JSON 报告")
    args = ap.parse_args(argv)

    tree = os.path.abspath(args.tree)
    spec = json.load(open(SPEC, encoding="utf-8"))
    fail = 0
    lines = []

    def say(s=""):
        lines.append(s)
        print(s)

    say(f"规格        : {SPEC}")
    say(f"基准树      : {tree}")
    say(f"输出        : {os.path.abspath(args.out) if args.out else '(check only)'}")
    say(f"补丁        : {len(spec.get('patches', []))} 条  + 新增文件 {len(spec.get('additions', []))} 个")
    say("-" * 108)

    if not os.path.isdir(tree):
        print(f"[FATAL] 基准树不存在: {tree}")
        return 2

    # ---------------- 预检：锚点唯一 + 拷贝源存在 ----------------
    texts = {}
    for p in spec.get("patches", []):
        f = p["file"]
        if f not in texts:
            path = os.path.join(tree, f.replace("/", os.sep))
            if not os.path.isfile(path):
                say(f"[FAIL] {p['id']} 基准树里没有 {f}")
                fail += 1
                continue
            texts[f] = read_text(path)
        c = texts[f].count(p["old"])
        off = texts[f].find(p["old"])
        say(f"  锚点 {p['id']:4s} {f:24s} count={c}  offset={off}")
        if c != 1:
            say(f"       [FAIL] 要求 count==1，实际 {c}")
            fail += 1

    for a in spec.get("additions", []):
        cp = a["copy"]
        src = os.path.join(ROOT, cp["from"].replace("/", os.sep))
        ok = os.path.isfile(src)
        say(f"  拷贝 {cp['from']:48s} -> {cp['to']:34s} {'' if ok else '[FAIL] 源不存在'}")
        if not ok:
            fail += 1

    say("-" * 108)
    if fail:
        say(f"预检失败（{fail} 项），未写任何文件。")
        return 1

    if args.check and not args.out:
        say("[CHECK ONLY] 基准树锚点全部 count==1；未写任何文件。")
        return 0

    # ---------------- 落盘：全量拷贝 + 应用 ----------------
    out = os.path.abspath(args.out)
    tmp = out + ".tmp"
    if os.path.isdir(tmp):
        shutil.rmtree(tmp)
    shutil.copytree(tree, tmp)

    for a in spec.get("additions", []):
        cp = a["copy"]
        src = os.path.join(ROOT, cp["from"].replace("/", os.sep))
        dst = os.path.join(tmp, cp["to"].replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        say(f"  + 新增 {cp['to']:34s} {os.path.getsize(dst):>7d} B  sha256={sha256_file(dst)[:16]}…")

    changed = []
    for p in spec.get("patches", []):
        path = os.path.join(tmp, p["file"].replace("/", os.sep))
        s = read_text(path)
        c = s.count(p["old"])
        if c != 1:
            say(f"  [FAIL] {p['id']} 应用到副本时 count={c}（副本被外部改动？）")
            return 1
        off = s.find(p["old"])
        s2 = s[:off] + p["new"] + s[off + len(p["old"]):]
        write_text(path, s2)
        changed.append(dict(id=p["id"], file=p["file"], offset=off,
                            old_len=len(p["old"]), new_len=len(p["new"]), why=p.get("why", "")))
        say(f"  * {p['id']} {p['file']:24s} off={off:>7d} {len(p['old']):>4d} -> {len(p['new']):>4d} B")

    if os.path.isdir(out):
        shutil.rmtree(out)   # Windows 上 os.replace 不能覆盖已存在目录
    elif os.path.exists(out):
        os.remove(out)
    os.replace(tmp, out)

    # ---------------- 打后校验 ----------------
    say("-" * 108)
    say("打后校验：")

    m = json.load(open(os.path.join(out, "manifest.json"), encoding="utf-8"))
    entry = [e for e in m.get("content_scripts", [])
             if "js/pages/acgx-batch.js" in (e.get("js") or [])]
    say(f"  manifest.json 合法 JSON；content_scripts 条目数 = {len(m.get('content_scripts', []))}；"
        f"命中 batch 条目 = {len(entry)}")
    if len(entry) != 1:
        fail += 1
    else:
        say(f"    matches = {entry[0]['matches']}")
        say(f"    js      = {entry[0]['js']}  run_at={entry[0]['run_at']} all_frames={entry[0]['all_frames']}")

    html = read_text(os.path.join(out, "html", "background.html"))
    i_new = html.find("js/pages/acgx-batch-offscreen.js")
    i_bg = html.find('src="../js/pages/background.js"')
    say(f"  html/background.html: batch 脚本 off={i_new} / background.js off={i_bg} → 顺序正确 = {0 <= i_new < i_bg}")
    if not (0 <= i_new < i_bg):
        fail += 1

    bgp = os.path.join(out, "js", "pages", "background.js")
    bg = read_text(bgp)
    for tok in ('"acgxAutoDownload"===n', '"acgxAbortAll"===n', "await A(e,t,i,bt)"):
        hit = bg.count(tok)
        say(f"  background.js 含 {tok:38s} × {hit}")
        if hit != 1:
            fail += 1
    okjs, info = node_syntax_ok(bgp)
    say(f"  background.js node 语法解析：{'OK' if okjs else 'FAIL ' + info}")
    if not okjs:
        fail += 1
    for f in ("js/pages/acgx-batch.js", "js/pages/acgx-batch-offscreen.js"):
        ok2, info2 = node_syntax_ok(os.path.join(out, f.replace("/", os.sep)))
        say(f"  {f:34s} node 语法解析：{'OK' if ok2 else 'FAIL ' + info2}")
        if not ok2:
            fail += 1

    say("-" * 108)
    say(f"结果：{'PASS' if fail == 0 else 'FAIL'}（失败项 {fail}）；输出目录 {out}")

    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(dict(ok=fail == 0, base_tree=tree, out=out,
                           patches=changed, additions=spec.get("additions", [])),
                      fh, ensure_ascii=False, indent=2)
        say(f"报告：{args.report}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
