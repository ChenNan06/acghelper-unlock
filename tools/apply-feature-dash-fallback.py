#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply-feature-dash-fallback.py —— 应用 tools/feature-dash-fallback.json（r3 新增）

用法：
  python tools/apply-feature-dash-fallback.py --check                    # 只校验锚点（在 r2 成品树上 count==1）
  python tools/apply-feature-dash-fallback.py --check --base <DIR>       # 指定基准树
  python tools/apply-feature-dash-fallback.py --base <DIR> --out <DIR>   # 复制 base → out 后打补丁
  python tools/apply-feature-dash-fallback.py --apply <DIR>              # 直接在 <DIR> 上打补丁（已校验）

规则（与 apply-feature-dash-auth-fix.py 同一套口径）：
  * 每条 old 必须在目标文件内 count==1，否则整批不落盘（先全文件校验，再逐文件写）
  * 同一文件内多条补丁按文件内偏移降序应用，前一条的 new 不会污染后一条的 old 定位
  * 全程 UTF-8 读写（newline='' 保持原换行体系），不重排、不加 BOM
"""
import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SPEC = os.path.join(HERE, 'feature-dash-fallback.json')
BASE_R2 = os.path.join(ROOT, 'output', 'ACGhelper-2.8.31.16-unlock')


def load_spec():
    with open(SPEC, encoding='utf-8') as f:
        return json.load(f)


def verify(spec, base):
    ok = True
    for p in spec['patches']:
        path = os.path.join(base, p['file'].replace('/', os.sep))
        if not os.path.exists(path):
            print('MISSING FILE %s (%s)' % (p['id'], p['file']))
            ok = False
            continue
        s = open(path, encoding='utf-8', newline='').read()
        c = s.count(p['old'])
        print('%-4s %-24s count=%d  off=%-7d old.len=%d' % (p['id'], p['file'], c, s.find(p['old']), len(p['old'])))
        if c != 1:
            ok = False
    return ok


def apply(spec, base):
    by_file = {}
    for p in spec['patches']:
        by_file.setdefault(p['file'], []).append(p)

    total = 0
    for rel, patches in by_file.items():
        path = os.path.join(base, rel.replace('/', os.sep))
        s = open(path, encoding='utf-8', newline='').read()
        located = []
        for p in patches:
            off = s.find(p['old'])
            if off < 0 or s.count(p['old']) != 1:
                raise SystemExit('锚点校验失败 %s @ %s (count=%d)' % (p['id'], rel, s.count(p['old'])))
            located.append((off, p))
        located.sort(key=lambda x: -x[0])
        for off, p in located:
            s = s[:off] + p['new'] + s[off + len(p['old']):]
            total += 1
            print('applied %-4s @ %-24s off=%d  +%d B' % (p['id'], rel, off, len(p['new']) - len(p['old'])))
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            f.write(s)
        os.replace(tmp, path)
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--base', default=BASE_R2)
    ap.add_argument('--out', default=None)
    ap.add_argument('--apply', default=None)
    a = ap.parse_args()
    spec = load_spec()

    if a.check:
        ok = verify(spec, a.base)
        print('\n%s' % ('ANCHORS_OK (%d patches)' % len(spec['patches']) if ok else 'ANCHORS_FAILED'))
        return 0 if ok else 1

    if a.apply:
        if not verify(spec, a.apply):
            print('\nANCHORS_FAILED')
            return 1
        n = apply(spec, a.apply)
        print('\nAPPLIED %d patches → %s' % (n, a.apply))
        return 0

    if not a.out:
        print('need --out or --apply or --check')
        return 2
    if not verify(spec, a.base):
        print('\nANCHORS_FAILED')
        return 1
    if os.path.exists(a.out):
        shutil.rmtree(a.out)
    shutil.copytree(a.base, a.out)
    n = apply(spec, a.out)
    print('\nAPPLIED %d patches: %s → %s' % (n, a.base, a.out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
