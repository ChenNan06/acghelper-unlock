#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""save_real_head.py — 把真实 PGC 预览 durl 的前 64 字节存成 fixture（真实数据，64 B）。"""
import io
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures", "pgc")
SRC = os.path.join(FIX, "pgc-playurl-750015-preview-durlonly.json")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36")


def main():
    d = json.load(io.open(SRC, encoding="utf-8"))
    vi = d["result"]["video_info"]
    url = vi["durl"][0]["url"]
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/",
                                              "Range": "bytes=0-63"})
    with urllib.request.urlopen(req, timeout=25) as r:
        head = r.read(64)
    out = os.path.join(FIX, "real-preview-durl-head64.bin")
    with io.open(out, "wb") as fh:
        fh.write(head)
    print("saved", out, len(head), "bytes")
    print("hex      :", head.hex())
    print("ftyp@    :", head.find(b"ftyp"))
    print("moov@    :", head.find(b"moov"))
    print("FLV magic:", head[:3] == b"FLV")
    return 0


sys.exit(main())
