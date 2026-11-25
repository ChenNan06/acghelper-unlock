#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""proto-repack.py — 把打补丁后的文件覆盖回一份完整副本并打成可加载的 zip。

用法:
  python proto-repack.py --src src/extracted --patched output/patch-2.8.31.16 \
      --stage build/acghelper-patched-2.8.31.16 --zip output/acghelper-2.8.31.16-patched.zip

特点：
  - src/extracted 只读，不写入；先整树复制到 --stage，再用补丁文件覆盖同名路径。
  - 复制时排除 docs/_scratch 之类无关目录（这里整树就是扩展本体，直接拷贝）。
  - 产出前打印每个被替换文件的新旧 SHA256 前 12 位，便于回滚核对。
"""
import os, sys, argparse, hashlib, shutil, zipfile

def sha12(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()[:12]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='src/extracted')
    ap.add_argument('--patched', default='output/patch-2.8.31.16')
    ap.add_argument('--stage', default='build/acghelper-patched-2.8.31.16')
    ap.add_argument('--zip', default='output/acghelper-2.8.31.16-patched.zip')
    a = ap.parse_args()

    if os.path.isdir(a.stage):
        shutil.rmtree(a.stage)
    shutil.copytree(a.src, a.stage)
    print('staged ->', a.stage)

    replaced = []
    for dp, dn, fn in os.walk(a.patched):
        for f in fn:
            src = os.path.join(dp, f)
            rel = os.path.relpath(src, a.patched)
            dst = os.path.join(a.stage, rel)
            old = sha12(dst) if os.path.exists(dst) else 'MISSING'
            shutil.copy2(src, dst)
            replaced.append(rel)
            print('  replace %-28s %s -> %s' % (rel, old, sha12(dst)))

    os.makedirs(os.path.dirname(a.zip), exist_ok=True)
    if os.path.exists(a.zip):
        os.remove(a.zip)
    with zipfile.ZipFile(a.zip, 'w', zipfile.ZIP_DEFLATED) as z:
        for dp, dn, fn in os.walk(a.stage):
            for f in fn:
                p = os.path.join(dp, f)
                z.write(p, os.path.relpath(p, a.stage))
    print('zip ->', a.zip, os.path.getsize(a.zip), 'bytes; replaced=%d' % len(replaced))

if __name__ == '__main__':
    main()
