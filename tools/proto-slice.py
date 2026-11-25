#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""proto-slice.py — 按字符偏移切出 JS 片段（可选按 CSS 选择器/关键字断行）并写文件。

用法:
  python proto-slice.py FILE START END OUT [--wrap 200] [--break-on 'async ,onLaunch,constructor']

偏移规则与 proto-locate.py 一致：字符偏移 (code point index)。
"""
import sys, io, argparse, re

def load(path):
    with io.open(path, 'r', encoding='utf-8', errors='surrogateescape') as f:
        return f.read()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file'); ap.add_argument('start', type=int); ap.add_argument('end', type=int)
    ap.add_argument('out')
    ap.add_argument('--wrap', type=int, default=0)
    ap.add_argument('--break-on', default='')
    a = ap.parse_args()
    t = load(a.file)
    seg = t[a.start:a.end]
    if a.break_on:
        pats = [p for p in a.break_on.split(',') if p]
        for p in pats:
            seg = seg.replace(p, '\n' + p)
    if a.wrap:
        lines = []
        for ln in seg.split('\n'):
            while len(ln) > a.wrap:
                lines.append(ln[:a.wrap]); ln = ln[a.wrap:]
            lines.append(ln)
        seg = '\n'.join(lines)
    with io.open(a.out, 'w', encoding='utf-8', errors='surrogateescape') as f:
        f.write('# %s [%d:%d] len=%d\n' % (a.file, a.start, a.end, len(seg)))
        f.write(seg)
    print('wrote', a.out, 'len', len(seg))

if __name__ == '__main__':
    main()
