#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
static-patchspec.py — patch 规格唯一性校验器（不修改任何文件）
对每个 (文件, old) 计算 s.count(old)，要求 == 1；
并打印 old->new 的影响预览。用法: python static-patchspec.py [--check|--apply OUTROOT]
--apply 会把补丁应用到 OUTROOT 下的副本（默认 build/acghelper-patched），src/extracted 保持只读。
"""
import os, sys, json, shutil

ROOT = r"D:\AI-Project\逆向统一\acghelper\src\extracted"
OUT  = r"D:\AI-Project\逆向统一\acghelper\build\acghelper-patched"

FAKE = ('{bhid:0,bhName:"ACG-VIP",email:"",'
        'identities:[{name:"catVIP",from:0,to:Date.now()+31536e7,hasDateTimeLimit:!1}],'
        'isVIP:!0,isSuperVIP:!0}')

PATCHES = [
    # ---- P-A: 会员判定器 mg() 恒真（BN 委托 mg，自动跟随）----
    ("initBackground.sw.js",
     'if(!e||!e.identities||0===e.identities.length)return!1;',
     'if(1)return!0;if(!e||!e.identities||0===e.identities.length)return!1;',
     "模块3078 mg() 恒真：所有 (0,X.mg)(bhAccount) 运行时判定→true"),
    ("js/pages/config.js",
     'if(!e||!e.identities||0===e.identities.length)return!1;',
     'if(1)return!0;if(!e||!e.identities||0===e.identities.length)return!1;',
     "模块3078 mg() 恒真（配置页）"),

    # ---- P-E: 共享 UI 锁组件 E(=wn) 的会员遮罩分支，一处干掉所有 needVIP 区块的「点击开通会员」遮罩 ----
    ("js/pages/config.js",
     'if(x&&"boolean"===typeof O&&!O)return',
     'if(!1)return',
     "配置页共享锁组件：needVIP 区块不再渲染会员遮罩（登录检查保留）"),
    ("js/pages/video.js",
     'if(!e||!e.identities||0===e.identities.length)return!1;',
     'if(1)return!0;if(!e||!e.identities||0===e.identities.length)return!1;',
     "模块3078 mg() 恒真（播放页注入脚本）"),
    ("js/pages/live.js",
     'if(!e||!e.identities||0===e.identities.length)return!1;',
     'if(1)return!0;if(!e||!e.identities||0===e.identities.length)return!1;',
     "模块3078 mg() 恒真（直播页）"),
    ("js/pages/popup.js",
     'if(!e||!e.identities||0===e.identities.length)return!1;',
     'if(1)return!0;if(!e||!e.identities||0===e.identities.length)return!1;',
     "模块3078 mg() 恒真（弹窗页）"),
    ("js/pages/message.js",
     'if(!e||!e.identities||0===e.identities.length)return!1;',
     'if(1)return!0;if(!e||!e.identities||0===e.identities.length)return!1;',
     "模块3078 mg() 恒真（消息中心）"),

    # ---- P-B: getStatus 出口伪造成员账号 + hasLogin ----
    ("initBackground.sw.js",
     'return n({hasLogin:this.hasLogin,bilibiliAccount:this.bilibiliAccount?this.bilibiliAccount.toJSON():null,'
     'downloadingSettings:this.downloadingSettings,hasRegister:this.hasRegister,bhAccount:this.bhAccount})',
     'return n({hasLogin:!0,bilibiliAccount:this.bilibiliAccount?this.bilibiliAccount.toJSON():null,'
     'downloadingSettings:this.downloadingSettings,hasRegister:!0,bhAccount:this.bhAccount||' + FAKE + '})',
     "getStatus 回包：hasLogin 恒真 + bhAccount 为 null 时给出合成会员对象"),

    # ---- P-C: getBHAccount 出口伪造（UI 门控真正吃这个口）----
    ("initBackground.sw.js",
     'n(await this.getStore("default"))',
     'n({...(await this.getStore("default")||' + FAKE + '),isVIP:!0,isSuperVIP:!0,'
     'identities:[{name:"catVIP",from:0,to:Date.now()+31536e7,hasDateTimeLimit:!1}]})',
     "getBHAccount 回包：恒返回 isVIP/isSuperVIP=true 且带合法 identities[]"),

    # ---- P-D: 基类 onBHAccountChange 里 bhAccount 为空时把 isVIP 打回 false ----
    ("initBackground.sw.js",
     'this.bhAccount?this.isVIP=(0,s.mg)(this.bhAccount):this.isVIP=!1',
     'this.isVIP=!0',
     "基类 onBHAccountChange：bhAccount 为空时不再把 isVIP 置 false"),
]

def read(p):
    with open(p, "rb") as fh:
        return fh.read().decode("utf-8", "replace")

def check():
    ok = True
    print(f"{'file':28s} {'count':>6s}  old[:60]")
    print("-" * 110)
    for f, old, new, note in PATCHES:
        s = read(os.path.join(ROOT, f.replace("/", os.sep)))
        n = s.count(old)
        offs = []
        if n:
            i = -1
            while True:
                i = s.find(old, i + 1)
                if i < 0: break
                offs.append(i)
        flag = "OK " if n == 1 else "FAIL"
        if n != 1: ok = False
        print(f"{flag} {f:25s} {n:>6d}  {old[:60]!r}  offs={offs}")
    print("-" * 110)
    print("ALL UNIQUE" if ok else "!!! 有非唯一项，需重写 old 串")
    return ok

def apply():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    shutil.copytree(ROOT, OUT)
    report = []
    for f, old, new, note in PATCHES:
        p = os.path.join(OUT, f.replace("/", os.sep))
        s = read(p)
        assert s.count(old) == 1, f"{f} old not unique: {s.count(old)}"
        off = s.find(old)
        s2 = s[:off] + new + s[off + len(old):]
        with open(p, "wb") as fh:
            fh.write(s2.encode("utf-8"))
        report.append({"file": f, "offset": off, "old_len": len(old), "new_len": len(new), "note": note})
    with open(os.path.join(OUT, "_patch-report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f"applied {len(report)} patches -> {OUT}")
    for r in report:
        print(f"  {r['file']} @{r['offset']}  {r['note']}")

if __name__ == "__main__":
    if "--apply" in sys.argv:
        apply()
    else:
        sys.exit(0 if check() else 1)
