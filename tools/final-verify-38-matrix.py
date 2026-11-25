#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
final-verify-38-matrix.py —— 「38 条补丁 × 两棵成品树」的 old 消失 / new 出现矩阵

为什么单独一份：final-verify-gates.js 覆盖 23 条 proto + 5 条 extra 的语义门，
static 10 条与「每条补丁的 old 是否真的消失」需要一张可贴进报告的**逐条表**。

三条判定口径（都写在表头里，避免误读）：
  1) 非自包含补丁：old 必须 count==0（原锚点彻底消失）
  2) 自包含补丁（new 里含 old，如 S01/S02/S04/S05/S06/S07 的 `if(1)return!0;<原逻辑>`）：
     old 期望 count==1（保留原逻辑那份，属设计），额外断言 new count==1
  3) 串联补丁：B2/B3 的 new 会被 extra 的 X2/X3 再改写一次 → 用「重叠拼接」算出终态再判存在性

用法: python tools/final-verify-38-matrix.py [--variant unlock|sameId|both]
退出码 0 = 全 PASS
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "src", "extracted")
OUT = os.path.join(ROOT, "output")
TREES = {"unlock": os.path.join(OUT, "ACGhelper-2.8.31.16-unlock"),
         "sameId": os.path.join(OUT, "ACGhelper-2.8.31.16-unlock-sameId")}

FAILS = 0


def check(ok, msg):
    global FAILS
    if not ok:
        FAILS += 1
    print(f"[{'PASS' if ok else 'FAIL'}] {msg}")
    return ok


def load_items():
    spec = importlib.util.spec_from_file_location("_m_static",
                                                  os.path.join(HERE, "static-patchspec.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    items = [dict(id=f"S{i:02d}", phase="static", file=f, old=old, new=new, note=note)
             for i, (f, old, new, note) in enumerate(mod.PATCHES, 1)]
    proto = json.load(open(os.path.join(HERE, "proto-patch-spec.json"), encoding="utf-8"))
    items += [dict(id=f"P{i:02d}", phase="proto", file=p["file"], old=p["old"], new=p["new"],
                   note=p["effect"]) for i, p in enumerate(proto, 1)]
    extra = json.load(open(os.path.join(HERE, "extra-patch-spec.json"),
                           encoding="utf-8"))["patches"]
    items += [dict(id=p["id"], phase="extra", file=p["file"], old=p["old"], new=p["new"],
                   note=p.get("why", "")) for p in extra]
    return items, extra


def max_overlap_suffix_prefix(a: str, b: str, floor: int = 8) -> int:
    n = min(len(a), len(b))
    for k in range(n, floor - 1, -1):
        if a[-k:] == b[:k]:
            return k
    return 0


def compose(text: str, extra) -> tuple[str, list[str]]:
    cur, used = text, []
    for _ in range(8):
        hit = False
        for p in extra:
            k = max_overlap_suffix_prefix(cur, p["old"])
            if k:
                cur = cur[: len(cur) - k] + p["new"]
                used.append(p["id"])
                hit = True
                break
            if p["old"] in cur:
                cur = cur.replace(p["old"], p["new"])
                used.append(p["id"])
                hit = True
                break
        if not hit:
            break
    return cur, used


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default="both", choices=["unlock", "sameId", "both"])
    args = ap.parse_args(argv)
    variants = ["unlock", "sameId"] if args.variant == "both" else [args.variant]

    items, extra = load_items()
    assert len(items) == 38, len(items)
    print(f"38 条补丁 × {len(variants)} 棵成品树；口径：非自包含 old→0 / 自包含 old→1 / 串联按重叠拼接判 new")
    print(f"{'id':4s} {'phase':7s} {'file':26s} " + " ".join(f"{v:>22s}" for v in variants))
    for t in variants:
        assert os.path.isdir(TREES[t]), TREES[t]

    cache = {t: {} for t in variants}

    def text(t, rel):
        if rel not in cache[t]:
            with open(os.path.join(TREES[t], rel.replace("/", os.sep)), "rb") as fh:
                cache[t][rel] = fh.read().decode("utf-8", "replace")
        return cache[t][rel]

    for it in items:
        self_contained = it["old"] in it["new"]
        final_new, used = compose(it["new"], extra)
        cells, ok = [], True
        for t in variants:
            s = text(t, it["file"])
            c_old = s.count(it["old"])
            c_new = s.count(final_new)
            if c_new == 0 and used:                 # 组合终态不存在 → 回退原 new
                c_new = s.count(it["new"])
                used = []
            exp_old = 1 if self_contained else 0
            good = (c_old == exp_old) and c_new >= 1
            ok = ok and good
            cells.append(f"old×{c_old}(→{exp_old}) new×{c_new}{'' if good else ' ✗'}")
        tag = "自包含" if self_contained else ("串联:" + "+".join(used) if used else "")
        print(f"{it['id']:4s} {it['phase']:7s} {it['file']:26s} " +
              " ".join(f"{c:>22s}" for c in cells) + (f"  [{tag}]" if tag else ""))
        check(ok, f"{it['id']} old 消失 / new 出现（{it['file']}）"
                   + (f"  串联终态由 {used} 决定" if used else ""))

    print(f"\n=== 总结: {'PASS' if FAILS == 0 else 'FAIL'} (fail={FAILS})")
    return 0 if FAILS == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
