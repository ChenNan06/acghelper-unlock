#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""proto-locate.py — 在压缩/未压缩 JS 中定位字符串，输出 字符偏移 + 行号 + 上下文。

用法:
  python proto-locate.py FILE NEEDLE [--ctx 120] [--all] [--count]
  python proto-locate.py FILE --re 'REGEX' [--ctx 120] [--all]
  python proto-locate.py FILE NEEDLE --save out.txt

约定: 偏移是 **字符偏移 (code point index)**，从 0 开始；同时给出 utf8 字节偏移。
"""
import sys, io, re, argparse, json, os

def load(path):
    with io.open(path, 'r', encoding='utf-8', errors='surrogateescape') as f:
        return f.read()

def byte_off(text, char_off):
    return len(text[:char_off].encode('utf-8', 'surrogateescape'))

def line_col(text, char_off):
    line = text.count('\n', 0, char_off) + 1
    last_nl = text.rfind('\n', 0, char_off)
    col = char_off - last_nl
    return line, col

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('needle', nargs='?')
    ap.add_argument('--re', dest='regex')
    ap.add_argument('--ctx', type=int, default=120)
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--count', action='store_true')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    text = load(args.file)
    hits = []
    if args.regex:
        for m in re.finditer(args.regex, text):
            hits.append((m.start(), m.group(0)))
    else:
        if args.needle is None:
            ap.error('needle or --re required')
        start = 0
        while True:
            i = text.find(args.needle, start)
            if i < 0:
                break
            hits.append((i, args.needle))
            start = i + 1
            if not args.all:
                break

    if args.count:
        print('count=%d' % len(hits))
        return

    out = []
    for off, frag in hits:
        line, col = line_col(text, off)
        b = byte_off(text, off)
        ctx = text[max(0, off - args.ctx): off + len(frag) + args.ctx]
        rec = {
            'file': args.file,
            'char_offset': off,
            'byte_offset': b,
            'line': line,
            'column': col,
            'match': frag,
            'context': ctx,
        }
        out.append(rec)
        if not args.json:
            print('=' * 78)
            print('[HIT] %s' % args.file)
            print('  char_offset=%d  byte_offset=%d  line=%d  col=%d' % (off, b, line, col))
            print('  match: %s' % frag)
            print('  ctx  : %s' % ctx.replace('\n', '\\n'))
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=1))

if __name__ == '__main__':
    main()
