#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""proto-grep.py — 跨文件定位（多 needle / 正则），只打印 文件/字符偏移/行/短上下文。

用法:
  python proto-grep.py ROOT NEEDLE1 [NEEDLE2 ...] [--ext .js,.html] [--ctx 60] [--max 200]
  python proto-grep.py ROOT --re 'REGEX' [--ext ...] [--ctx 60]
"""
import os, io, re, argparse, sys

def files(root, exts):
    for dp, dn, fn in os.walk(root):
        for f in fn:
            if not exts or any(f.endswith(e) for e in exts):
                yield os.path.join(dp, f)

def line_of(t, off):
    return t.count('\n', 0, off) + 1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root'); ap.add_argument('needles', nargs='*')
    ap.add_argument('--re', dest='regex')
    ap.add_argument('--ext', default='.js,.html,.json')
    ap.add_argument('--ctx', type=int, default=60)
    ap.add_argument('--max', type=int, default=200)
    a = ap.parse_args()
    exts = tuple(e.strip() for e in a.ext.split(',') if e.strip())
    pats = []
    if a.regex:
        pats.append(('re:' + a.regex, re.compile(a.regex)))
    for n in a.needles:
        pats.append((n, re.compile(re.escape(n))))
    total = 0
    for p in files(a.root, exts):
        try:
            t = io.open(p, 'r', encoding='utf-8', errors='surrogateescape').read()
        except Exception as e:
            continue
        for name, rx in pats:
            for m in rx.finditer(t):
                total += 1
                off = m.start()
                s = max(0, off - a.ctx); e2 = min(len(t), m.end() + a.ctx)
                print('%-46s off=%-8d line=%-5d %-22s | %s' % (
                    os.path.relpath(p, a.root), off, line_of(t, off), name[:22],
                    t[s:e2].replace('\n', '\\n')))
                if total >= a.max:
                    print('... truncated at', a.max)
                    return
    print('TOTAL_HITS=%d' % total)

if __name__ == '__main__':
    main()
