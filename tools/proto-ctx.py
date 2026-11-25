#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""proto-ctx.py — 打印某个 needle 的上下文（多针一次跑完，输出紧凑）。

用法: python proto-ctx.py FILE NEEDLE [BEFORE] [AFTER] [MAXHITS]
"""
import sys, io

f = sys.argv[1]
needle = sys.argv[2]
before = int(sys.argv[3]) if len(sys.argv) > 3 else 200
after = int(sys.argv[4]) if len(sys.argv) > 4 else 400
maxhits = int(sys.argv[5]) if len(sys.argv) > 5 else 4
t = io.open(f, encoding='utf-8', errors='surrogateescape').read()
i, n = 0, 0
while n < maxhits:
    j = t.find(needle, i)
    if j < 0:
        break
    print('#' * 70)
    print('[%s] off=%d' % (needle, j))
    print(t[max(0, j - before): j + after])
    i = j + 1
    n += 1
print('TOTAL_HITS_SHOWN=%d' % n)
