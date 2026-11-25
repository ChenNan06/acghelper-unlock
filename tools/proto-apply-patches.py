#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""proto-apply-patches.py — 按 spec 生成打补丁后的副本（不动 src/extracted）。

用法:
  python proto-apply-patches.py tools/proto-patch-spec.json --out output/patch-2.8.31.16
  python proto-apply-patches.py tools/proto-patch-spec.json --out ... --node   # 追加 node --check 语法验收

规则：
  - 每个 old 必须 count==1，且字符偏移与 spec 一致，否则整批中止（不写任何文件）。
  - 只复制被改动的文件，目录结构与 src/extracted 一致。
"""
import io, json, os, sys, hashlib, argparse, subprocess, shutil

def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('spec')
    ap.add_argument('--root', default='src/extracted')
    ap.add_argument('--out', default='output/patch-2.8.31.16')
    ap.add_argument('--node', action='store_true')
    ap.add_argument('--no-offset-check', action='store_true',
                    help='只校验 old 唯一性，不校验字符偏移（与别人的补丁叠加、文件长度已变化时用）')
    a = ap.parse_args()

    spec = json.load(io.open(a.spec, encoding='utf-8'))
    # 1) 全量校验（先校验再写，失败即中止）
    bad = 0
    for i, p in enumerate(spec, 1):
        src = os.path.join(a.root, p['file'])
        t = io.open(src, encoding='utf-8', errors='surrogateescape').read()
        c, off = t.count(p['old']), t.find(p['old'])
        off_ok = a.no_offset_check or p.get('offset') is None or off == p['offset']
        if c != 1 or not off_ok:
            bad += 1
            print('FAIL #%d %s count=%d off=%s spec_off=%s' % (i, p['file'], c, off, p.get('offset')))
    if bad:
        print('中止：%d 条校验不通过，未写入任何文件' % bad)
        sys.exit(1)

    # 2) 应用并落盘
    os.makedirs(a.out, exist_ok=True)
    by_file = {}
    for p in spec:
        by_file.setdefault(p['file'], []).append(p)

    for rel, patches in by_file.items():
        src = os.path.join(a.root, rel)
        t = io.open(src, encoding='utf-8', errors='surrogateescape').read()
        before = sha(src)
        for p in patches:
            t = t.replace(p['old'], p['new'], 1)
        dst = os.path.join(a.out, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        io.open(dst, 'w', encoding='utf-8', errors='surrogateescape').write(t)
        print('%-28s %-12s -> %-12s sha256_after=%s' % (rel, before[:12], sha(dst)[:12], ''))
        if a.node:
            r = subprocess.run(['node', '--check', dst], capture_output=True, text=True)
            print('   node --check: %s %s' % ('OK' if r.returncode == 0 else 'FAIL',
                                              (r.stderr or '').strip().splitlines()[:2] if r.returncode else ''))
    print('DONE files=%d patches=%d out=%s' % (len(by_file), len(spec), a.out))

if __name__ == '__main__':
    main()
