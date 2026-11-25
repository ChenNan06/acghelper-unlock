#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""proto-patch-check.py — 校验 patch 规格：old 字符串在文件里的出现次数必须 == 1。

用法:
  python proto-patch-check.py spec.json [--root DIR]

spec.json 结构:
  [ {"file": "js/pages/video.js", "offset": 12345, "old": "...", "new": "...", "effect": "..."} , ... ]

文件路径相对 --root（默认 src/extracted）。输出每条：count / 首个字符偏移 / 行号 / PASS|FAIL。
"""
import io, json, sys, os, argparse

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('spec')
    ap.add_argument('--root', default='src/extracted')
    a = ap.parse_args()
    spec = json.load(io.open(a.spec, encoding='utf-8'))
    ok = fail = 0
    for i, p in enumerate(spec, 1):
        path = os.path.join(a.root, p['file'])
        t = io.open(path, 'r', encoding='utf-8', errors='surrogateescape').read()
        old = p['old']; new = p['new']
        c = t.count(old)
        first = t.find(old)
        line = t.count('\n', 0, first) + 1 if first >= 0 else -1
        # 校验替换后 old 不再出现、new 出现一次
        c2 = t.replace(old, new).count(new) if c else -1
        if p.get('offset') is None:
            status = 'INFO' if c == 1 else 'FAIL'
        else:
            status = 'PASS' if (c == 1 and first == p.get('offset')) else 'FAIL'
        if status == 'PASS':
            ok += 1
        else:
            fail += 1
        print('%-3d %-28s count=%-3d off=%-8s line=%-5s new_count=%-4s %s'
              % (i, os.path.basename(p['file']), c, first, line, c2, status))
        if c != 1:
            print('    !! old 不唯一或不存在: %r' % old[:90])
        elif first != p.get('offset', first):
            print('    !! 偏移不符: spec=%s actual=%s' % (p.get('offset'), first))
    print('SUMMARY ok=%d fail=%d total=%d' % (ok, fail, len(spec)))
    sys.exit(0 if fail == 0 else 1)

if __name__ == '__main__':
    main()
