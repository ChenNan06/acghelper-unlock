#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""save_pgc_fixture.py — 抓真实 PGC v2 playurl 回包存成 fixture，并校验 durl 载荷 magic。

用法: python save_pgc_fixture.py EP QN FNVAL OUTNAME
"""
import io
import json
import os
import sys
import urllib.parse
import urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "pgc")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36")
BASE = {"User-Agent": UA, "Referer": "https://www.bilibili.com/", "Origin": "https://www.bilibili.com"}


def get(url, extra=None, raw=False):
    hdr = dict(BASE)
    if extra:
        hdr.update(extra)
    req = urllib.request.Request(url, headers=hdr)
    with urllib.request.urlopen(req, timeout=25) as r:
        data = r.read()
        return data if raw else json.loads(data.decode("utf-8", "replace"))


def main():
    ep, qn, fnval, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    os.makedirs(OUT, exist_ok=True)
    q = urllib.parse.urlencode({"ep_id": ep, "qn": qn, "fnver": 0, "fnval": fnval, "fourk": 1})
    url = "https://api.bilibili.com/pgc/player/web/v2/playurl?" + q
    d = get(url)
    vi = ((d.get("result") or {}).get("video_info") or {})
    path = os.path.join(OUT, out)
    with io.open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(d, ensure_ascii=False, indent=1))
    print("saved", path)
    print("code=%s quality=%s format=%s is_preview=%s is_drm=%s timelength=%s accept_quality=%s" % (
        d.get("code"), vi.get("quality"), vi.get("format"), vi.get("is_preview"),
        vi.get("is_drm"), vi.get("timelength"), vi.get("accept_quality")))
    print("dash=%s durl=%s durls=%s" % (bool(vi.get("dash")), bool(vi.get("durl")), bool(vi.get("durls"))))
    durl = vi.get("durl") or []
    if durl:
        f0 = durl[0]
        print("durl_n=%d keys=%s order=%s size=%s length=%s vhead=%r ahead=%r" % (
            len(durl), sorted(f0.keys()), f0.get("order"), f0.get("size"), f0.get("length"),
            f0.get("vhead"), f0.get("ahead")))
        head = get(f0["url"], {"Range": "bytes=0-63"}, raw=True)
        print("payload http head64 hex =", head[:64].hex())
        print("ftyp at", head.find(b"ftyp"), "/ FLV magic =", head[:3] == b"FLV")
    return 0


sys.exit(main())
