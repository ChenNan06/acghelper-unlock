#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply-all-plus-features.py —— ACGhelper 2.8.31.16 v2/r4 唯一权威构建器

一条流水线把「既有 38 条」与「五路新功能」串起来，全部在内存里算完才落盘：

  ① 既有 38 条（**复用** tools/apply-all-patches.py 的补丁定义，import 不复制、不改它的规格）：
       static 10（static-patchspec.py 的 PATCHES）
     + proto  23（proto-patch-spec.json）
     + extra   5（extra-patch-spec.json，X1..X5）
     + optional 2（proto-patch-optional.json，默认不打，--with-optional 才打 B5；B6 已被 X5 消费）
  ② feature pgc-fix     4（feature-pgc-fix.json，F1..F4）—— PGC durl-MP4 形态 0 字节修复
  ③ feature dash-auth-fix 8（feature-dash-auth-fix.json，F1..F8）—— DASH 音轨-only 可见性 + PGC 试看/鉴权
  ④ feature dash-fallback 5（feature-dash-fallback.json，DF1..DF5）—— 空视频段自动回退最优视频轨（r3 根治）
  ⑤ feature webdav      9（feature-webdav.json v2：6 个新增文件 + 3 处字符串补丁）—— 设置页「同步」栏
  ⑥ feature batch       3（feature-batch.json v2：3 处字符串补丁 + 2 个新增文件）—— 选集入口并入插件面板

  目标计数：默认 38 + 4 + 8 + 5 + 9 + 3 = **67** 条；新增文件 8 个（webdav 6 + batch 2）。
  （r2 = 53 = 38 + 4 + 8 + 3；r3 = 66 = 38 + 4 + 8 + 5 + 8 + 3；r4 = 67，webdav 由 8 升到 9。）
  **总条数一律由规格算出**（38 + Σ feature.expect），写进 _patch-report.json 的 totals，
  不在代码里写死成品数 —— 规格一变，报告跟着变，硬断言只比「算出值 == 实落值」。

设计约束（与既有流水线同一套口径，另加 feature 段）：
  * 每条锚点应用前 assert 当前缓冲里 count(old)==1；不满足立刻报 file/old/实际 count 并退出码 1，
    **一个字节都不写**（全部内存演练通过才进落盘阶段）。
  * 分段：pristine(static→proto) → post-proto(extra) → post-extra(optional) → feature:pgc-fix
    → feature:dash-auth-fix → feature:dash-fallback → feature:webdav → feature:batch。
    段内同文件按「进入本段时的偏移降序、旧串长度降序」。
  * 五段 feature 的顺序理由：pgc-fix 与 dash-auth-fix 都只动 js/pages/background.js，dash-auth-fix 的 8 条
    锚点是**在 pgc-fix 之后**的树上取的（r2 成品树 count==1 实测），所以 pgc-fix 必须在前；
    dash-fallback 的 DF5 锚点紧贴 dash-auth-fix 的 F1/F2 区间之前（64148 < 63900+），
    DF5 只看 `const o=track.../useStreamSaver` 这一小段，与 F1/F2 无区间重叠，
    但其语义依赖「F1/F2 读到的 s.video 已被回退填好」→ 必须排在 dash-auth-fix 之后。
    webdav/batch 只动 manifest/config/background.html/initBackground.sw.js 与 background.js 尾部分发器，
    与前两段无重叠。
  * feature 段的输入不是原始树，而是「上一段输出」：base.simulate() 返回的 buf；对 feature 才触及的
    文件（manifest.json / html/config.html / initBackground.sw.js）按需 materialize —— 未打过补丁的
    文件取 src/extracted 原文，manifest.json 取「已写入 version_name 的规范化文本」，与 38 条成品树
    逐字节一致（feature 锚点就是在那棵树上验的）。
  * **webdav 段有一层「v1 前置态重建」(bridge)**：feature-webdav.json v2 的 9 条锚点是在 r3 成品树
    （已含 v1 WebDAV 落地的三处痕迹）上取的，而本流水线从 pristine 起跑。所以 webdav 段正式打之前，
    先用 webdav_legacy_bridge() 把这三处补回 v1 态：
      WBR1 html/config.html      </body> 前补回 v1 的「注释 + inject.js」两行（由 W1.old 反推）
      WBR2 manifest.json         host_permissions 末项后补回 infini-cloud + optional_host_permissions（由 W2.old 反推）
      WBR3 initBackground.sw.js  尾部补回 importScripts 引导块（由 W3.old 反推）
    bridge 的 old **全部由 v2 规格锚点反向推导**，不硬编码 v1 文本；每条同样 count==1 才动手；
    不计入「补丁条数」（它只是把输入补成规格声明的基准态，报告里单列 bridge 段）。拿已含 v1 的树
    当 --src（例如 r3 树）时，因 count(spec_old)==1 会自动跳过对应 bridge 步。
  * manifest.json 一律经 patch_manifest_text() 规范化重排（dict 顺序不变，缩进 4），因此 W2/FB1 的
    插入会以 4 空格缩进落盘；version_name = 2.8.31.16(Beta) unlock r4，version 数字段仍 2.8.31.16。
  * 新增文件按**二进制**拷贝（不做换行/编码转换），SHA256 记录进报告。
  * 旧成品不删：--archive-legacy 时先整目录/整 zip 移进 build/legacy-intermediate/（重名加时间戳）。
  * src/extracted 只读：构建前后各算一次目录指纹，必须一致。

产出（默认 output/）：
  ACGhelper-2.8.31.16-unlock/ + .zip            完整扩展树（无 key）
  ACGhelper-2.8.31.16-unlock-sameId/ + .zip     注入 "key"（扩展 ID 与商店版一致）
  _patch-report.json（分段计数 + 总条数（规格算出）+ 每条 feature 补丁 id + 新增文件清单/sha256 + bridge 段）
  _build-info.json（源哈希 / 树指纹 / 分段计数 / 新 zip sha256 / 工具链版本）

用法：
  python tools/apply-all-plus-features.py --check                  # 零写入：锚点 + 全内存演练
  python tools/apply-all-plus-features.py --archive-legacy         # 完整构建 67 条（旧成品先归档）
  python tools/apply-all-plus-features.py --skip-feature batch     # 只打 64 条
  python tools/apply-all-plus-features.py --with-optional          # 68 条（+B5）
  python tools/apply-all-plus-features.py --out build/v2-test      # 换输出目录
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

DEF_SRC = os.path.join(ROOT, "src", "extracted")
DEF_OUT = os.path.join(ROOT, "output")

BASE_SCRIPT = os.path.join(HERE, "apply-all-patches.py")
WEBDAV_APPLIER = os.path.join(HERE, "feature-webdav-apply.py")
KEY_FILE = os.path.join(HERE, "original-public-key.txt")
SRC_ZIP = os.path.join(ROOT, "acg-helper-2.8.31.16.zip")
LEGACY_DIR = os.path.join(ROOT, "build", "legacy-intermediate")

STOREFRONT_ID = "kpbnombpnpcffllnianjibmpadjolanh"
PROD_PLAIN = "ACGhelper-2.8.31.16-unlock"
PROD_SAMEID = "ACGhelper-2.8.31.16-unlock-sameId"
VERSION_NAME = "2.8.31.16(Beta) unlock r4"

# 五路新功能：顺序即应用顺序；expect = 该 spec 的 patches[] 声明条数
# （webdav 的 6 个新增文件写在 patches[] 里，因此计入 9；batch 的 2 个新增文件写在 additions[]，不计入 3）
FEATURES = [
    dict(name="pgc-fix", spec=os.path.join(HERE, "feature-pgc-fix.json"),
         label="PGC 0 字节修复（FLV/durl-MP4 形态）", expect=4),
    dict(name="dash-auth-fix", spec=os.path.join(HERE, "feature-dash-auth-fix.json"),
         label="DASH 音轨-only 可见性 + PGC 试看/鉴权（r3 合入）", expect=8),
    dict(name="dash-fallback", spec=os.path.join(HERE, "feature-dash-fallback.json"),
         label="空视频段自动回退最优视频轨（r3 根治用户主诉）", expect=5),
    dict(name="webdav", spec=os.path.join(HERE, "feature-webdav.json"),
         label="WebDAV 云同步（v2：设置页「同步」栏）", expect=9),
    dict(name="batch", spec=os.path.join(HERE, "feature-batch.json"),
         label="选集/多P 批量下载（v2：入口并入插件面板）", expect=3),
]
EXPECT_FEATURE_PATCHES = sum(f["expect"] for f in FEATURES)   # 29 = 4+8+5+9+3
EXPECT_NEW_FILES = 8                                          # webdav 6 + batch 2
EXPECT_TOTAL_DEFAULT = 38 + EXPECT_FEATURE_PATCHES            # 67


class PatchError(RuntimeError):
    pass


# ---------------------------------------------------------------- 基础工具
def load_module(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


BASE = load_module(BASE_SCRIPT, "_acg_apply_all_base")
WEBDAV_APPLY = load_module(WEBDAV_APPLIER, "_acg_feature_webdav_apply")

read_text = BASE.read_text
write_text = BASE.write_text
sha256_file = BASE.sha256_file
tree_fingerprint = BASE.tree_fingerprint
ext_id_from_key = BASE.ext_id_from_key


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def patch_manifest_text(text: str, key_b64: str | None, version_name: str = VERSION_NAME) -> str:
    """与 apply-all-patches.py 同一个做法：json round-trip，dict 顺序不变，缩进 4。"""
    data = json.loads(text)
    data["version_name"] = version_name
    if key_b64:
        data["key"] = key_b64
    return json.dumps(data, ensure_ascii=False, indent=4) + "\n"


# ---------------------------------------------------------------- 读 feature 规格
def load_feature_ops(feature: dict) -> tuple:
    """把一个 feature 规格归一成 (bytes_ops, copy_ops, declared)。

    * bytes_op: {kind:'bytes', id, feature, file, old, new, why, counted=True}
    * copy_op : {kind:'copy',  id, feature, src, dst, why, counted}
        counted=True  —— 写在 spec 的 patches[] 里（webdav 的 5 个新增文件），算进「补丁条数」
        counted=False —— 写在 spec 的 additions[] 里（batch 的 2 个新增文件），只算「新增文件」
    webdav 的归一化直接复用 tools/feature-webdav-apply.py 的 norm_patches()，保证与那支独立
    应用器逐字同义（不复制它的逻辑，也不改它）。
    """
    name = feature["name"]
    with open(feature["spec"], encoding="utf-8") as fh:
        data = json.load(fh)
    declared = len(data.get("patches", []))
    bytes_ops, copy_ops = [], []
    if name == "webdav":
        for p in WEBDAV_APPLY.norm_patches(data):
            if p["kind"] == "copy":
                copy_ops.append(dict(kind="copy", id=p["id"], feature=name, counted=True,
                                     src=p["from"], dst=p["to"], why=p.get("why", "")))
            else:
                bytes_ops.append(dict(kind="bytes", id=p["id"], feature=name, counted=True,
                                      file=p["file"], old=p["old"], new=p["new"],
                                      why=p.get("why", "")))
    else:
        for p in data.get("patches", []):
            bytes_ops.append(dict(kind="bytes", id=p["id"], feature=name, counted=True,
                                  file=p["file"], old=p["old"], new=p["new"],
                                  why=p.get("why", "")))
        for i, a in enumerate(data.get("additions", []), 1):
            cp = a["copy"]
            copy_ops.append(dict(kind="copy", id=f"{name}-add{i}", feature=name, counted=False,
                                 src=cp["from"], dst=cp["to"],
                                 why="新增文件（不经锚点替换，仅在 additions[] 里声明）"))
    return bytes_ops, copy_ops, declared


# ---------------------------------------------------------------- webdav v1 bridge
def webdav_legacy_bridge(bytes_ops: list, buf: dict, src: str, manifest_seed: str) -> list:
    """把输入补成「v1 WebDAV 已落地」的 r3 前置态（feature-webdav.json v2 的锚点基准）。

    为什么需要它
    ------------
    v2 规格的 9 条锚点是在 **r3 成品树**上取的：W1.old 里含着 v1 注入的两行（注释 +
    inject.js），W2/W3 的 old==new 是「v1 已落地」的幂等状态断言。本流水线的输入是
    pristine（src/extracted），这三处痕迹都不存在 —— 直接打会因为 count==0 全部失配。
    所以先把它们补回 v1 态，v2 规格就能原样生效；同时 v2 的 W1 会把那两行**换掉**
    （不再加载 inject.js、不再有浮动按钮），所以 bridge 只是过渡态，不是最终产物。

    三条 bridge 的 old **全部由 v2 规格锚点反向推导**（不硬编码 v1 文本）：
      WBR1  由 W1.old 去掉尾部 </body> 得到 v1 的两行
      WBR2  由 W2.old 去掉 infini-cloud 行与 optional_host_permissions 段、去掉逗号
      WBR3  由 W3.old 截到 "\\n;(function(){try{if(self.importScripts)" 之前

    规则与正式补丁一致：每条 bridge 动手前 assert count(old)==1，失败立刻 PatchError（零写入）。
    拿已含 v1 的树当 --src 时（count(spec_old)==1），对应 bridge 步自动跳过。
    """
    ops = {o["id"]: o for o in bytes_ops}
    steps = []

    def _step(sid, op, old, new, why):
        cur = materialize(buf, op["file"], src, manifest_seed)
        c = cur.count(old)
        if c != 1:
            raise PatchError(f"[feature:webdav bridge] {sid} 前置态重建失败（未写任何文件）：\n"
                             f"  file = {op['file']}\n  count(old) = {c}  (要求 1)\n"
                             f"  old = {old[:200]!r}")
        off = cur.find(old)
        buf[op["file"]] = cur[:off] + new + cur[off + len(old):]
        steps.append(dict(id=sid, stage="feature:webdav:bridge", file=op["file"],
                          offset_in_file=off, offset_in_stage_input=off,
                          old_len=len(old), new_len=len(new), why=why,
                          old_head=old[:80], new_head=new[:80]))

    # ---- WBR1：html/config.html 补回 v1 的「注释 + inject.js」两行 ----
    w1 = ops.get("W1-config-html")
    if w1:
        cur = materialize(buf, w1["file"], src, manifest_seed)
        if cur.count(w1["old"]) != 1:
            tail = "</body>"
            if not w1["old"].endswith("\n" + tail):
                raise PatchError(f"[feature:webdav bridge] W1.old 尾部不是换行+{tail}，无法反推 v1 前置态")
            pre = w1["old"][: -(len(tail) + 1)]
            _step("WBR1", w1, tail, pre + "\n" + tail,
                  "v1 前置态：</body> 前补回 v1 的注释 + inject.js（W1.old 反推）")

    # ---- WBR2：manifest.json 补回 infini-cloud host 权限 + optional_host_permissions ----
    w2 = ops.get("W2-manifest-hostperm")
    if w2:
        cur = materialize(buf, w2["file"], src, manifest_seed)
        if cur.count(w2["old"]) != 1:
            lines = w2["old"].split("\n")
            first, last = lines[0], lines[-1]
            if not (first.rstrip().endswith(",") and last.strip() == "],"):
                raise PatchError("[feature:webdav bridge] W2.old 首尾形态不符合预期，无法反推 v1 前置态")
            bridge_old = first.rstrip()[:-1] + "\n" + last
            _step("WBR2", w2, bridge_old, w2["old"],
                  "v1 前置态：host_permissions 末项后补回 infini-cloud + optional_host_permissions（W2.old 反推）")

    # ---- WBR3：initBackground.sw.js 尾部补回 importScripts 引导 ----
    w3 = ops.get("W3-sw-bootstrap")
    if w3:
        cur = materialize(buf, w3["file"], src, manifest_seed)
        if cur.count(w3["old"]) != 1:
            sep = "\n;(function(){try{if(self.importScripts)"
            i = w3["old"].find(sep)
            if i <= 0:
                raise PatchError("[feature:webdav bridge] W3.old 里找不到引导块分隔点，无法反推 v1 前置态")
            tail_old = w3["old"][:i]
            _step("WBR3", w3, tail_old, w3["old"],
                  "v1 前置态：SW 尾部补回 importScripts 引导块（W3.old 反推）")

    # ---- bridge 后复核：v2 的 9 条锚点必须全部 count==1 ----
    bad = []
    for o in bytes_ops:
        c = buf[o["file"]].count(o["old"])
        if c != 1:
            bad.append(f"  [{o['id']}] {o['file']} count={c}")
    if bad:
        raise PatchError("[feature:webdav bridge] 前置态重建后锚点仍不唯一：\n" + "\n".join(bad))
    return steps


# ---------------------------------------------------------------- feature 段
def materialize(buf: dict, rel: str, src: str, manifest_seed: str) -> str:
    """确保 buf 里有 rel 的「38 条成品树」文本；返回该文本。"""
    if rel in buf:
        return buf[rel]
    if rel == "manifest.json":
        buf[rel] = manifest_seed
        return buf[rel]
    path = os.path.join(src, rel.replace("/", os.sep))
    if not os.path.isfile(path):
        raise PatchError(f"feature 目标文件在基准树里不存在：{rel}（{path}）")
    buf[rel] = read_text(path)
    return buf[rel]


def apply_feature(feature: dict, plan: tuple, buf: dict, src: str, manifest_seed: str,
                  report: list, added: list) -> int:
    name = feature["name"]
    bytes_ops, copy_ops, declared = plan
    counted = len(bytes_ops) + len([c for c in copy_ops if c["counted"]])
    if declared != feature["expect"] or counted != declared:
        raise PatchError(f"[feature:{name}] 规格条数不一致：patches[]={declared} "
                         f"声明预期={feature['expect']} 实际可应用={counted}（{feature['spec']}）")

    # ---- 预检：快照上逐条 count==1；同文件区间不重叠 ----
    for o in bytes_ops:
        materialize(buf, o["file"], src, manifest_seed)
    snapshot = {rel: buf[rel] for rel in {o["file"] for o in bytes_ops}}
    problems, anchors = [], []
    for o in bytes_ops:
        s = snapshot[o["file"]]
        c = s.count(o["old"])
        off = s.find(o["old"])
        anchors.append(dict(id=o["id"], file=o["file"], stage=f"feature:{name}",
                            count_in_stage_input=c, offset_in_stage_input=off,
                            spec_offset=None, offset_matches_spec=None))
        if c != 1:
            problems.append((o, c, "feature 阶段输入里锚点不唯一"))
    by_file = {}
    for o in bytes_ops:
        off = snapshot[o["file"]].find(o["old"])
        if off >= 0:
            by_file.setdefault(o["file"], []).append((off, off + len(o["old"]), o["id"]))
    for f, spans in by_file.items():
        spans.sort()
        for a, b in zip(spans, spans[1:]):
            if a[1] > b[0]:
                o = next(x for x in bytes_ops if x["id"] == b[2])
                problems.append((o, 1, f"feature 阶段：与 {a[2]} 在 {f} 内区间重叠"))
    # 新增文件：源必须存在，目标在基准树里必须**不存在**（只增不改）
    for o in copy_ops:
        sp = os.path.join(ROOT, o["src"].replace("/", os.sep))
        if not os.path.isfile(sp):
            problems.append((o, 0, f"新增文件源不存在：{o['src']}"))
        elif os.path.exists(os.path.join(src, o["dst"].replace("/", os.sep))):
            problems.append((o, 0, f"新增文件目标已存在于基准树：{o['dst']}（会变成覆盖，拒绝）"))
    if problems:
        lines = [f"[feature:{name}] 锚点/新增文件预检失败（未写任何文件）："]
        for o, c, why in problems:
            lines.append(f"  [{o['id']}] {o.get('file') or o.get('dst')}  count={c}  {why}\n"
                         f"      old={(o.get('old') or o.get('src') or '')[:140]!r}")
        raise PatchError("\n".join(lines))

    # ---- 应用：同文件按快照偏移降序、旧串长度降序 ----
    order = sorted(bytes_ops, key=lambda o: (o["file"],
                                             -snapshot[o["file"]].find(o["old"]),
                                             -len(o["old"])))
    for o in order:
        s = buf[o["file"]]
        c = s.count(o["old"])
        if c != 1:
            raise PatchError(f"[feature:{name}] 锚点失配（未写任何文件）：\n"
                             f"  [{o['id']}] {o['file']}\n  count(old) = {c}  (要求 1)\n"
                             f"  old = {o['old'][:200]!r}")
        off = s.find(o["old"])
        buf[o["file"]] = s[:off] + o["new"] + s[off + len(o["old"]):]
        entry = dict(order=len(report) + 1, id=o["id"], phase="feature", feature=name,
                     stage=f"feature:{name}", route=feature["label"], priority="P0",
                     file=o["file"], kind="bytes", offset_in_file=off,
                     offset_in_stage_input=snapshot[o["file"]].find(o["old"]),
                     old_len=len(o["old"]), new_len=len(o["new"]),
                     note=(o.get("why") or "")[:300],
                     old_head=o["old"][:80], new_head=o["new"][:80])
        entry["anchor_audit"] = next(a for a in anchors if a["id"] == o["id"])
        report.append(entry)

    for o in copy_ops:
        sp = os.path.join(ROOT, o["src"].replace("/", os.sep))
        data = open(sp, "rb").read()
        added.append(dict(feature=name, id=o["id"], counted_in_patches=o["counted"],
                          src=o["src"], to=o["dst"], bytes=len(data),
                          sha256=sha256_bytes(data)))
        if o["counted"]:
            report.append(dict(order=len(report) + 1, id=o["id"], phase="feature", feature=name,
                               stage=f"feature:{name}", route=feature["label"], priority="P0",
                               file=o["dst"], kind="copy", offset_in_file=None,
                               offset_in_stage_input=None, old_len=0, new_len=len(data),
                               note="新增文件：" + (o.get("why") or "")[:200],
                               old_head="", new_head=""))
    print(f"  feature:{name:8s} 声明 {declared} 条 = 字节补丁 {len(bytes_ops)} "
          f"+ 新增文件 {len(copy_ops)}；锚点全部 count==1"
          + (f"（其中 {sum(1 for c in copy_ops if c['counted'])} 个新增文件计入 patches[]）"
             if copy_ops else ""))
    return counted


# ---------------------------------------------------------------- 落盘
def build_tree(dest: str, src: str, buf: dict, added: dict, key_b64: str | None) -> None:
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    elif os.path.exists(dest):
        os.remove(dest)
    tmp = dest + ".tmp"
    if os.path.isdir(tmp):
        shutil.rmtree(tmp)
    shutil.copytree(src, tmp)
    for rel, text in buf.items():
        if rel == "manifest.json":
            continue
        write_text(os.path.join(tmp, rel.replace("/", os.sep)), text)
    for rel, data in added.items():
        p = os.path.join(tmp, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as fh:
            fh.write(data)
    write_text(os.path.join(tmp, "manifest.json"),
               patch_manifest_text(buf["manifest.json"], key_b64))
    os.replace(tmp, dest)


def archive_legacy(out: str, names) -> list:
    os.makedirs(LEGACY_DIR, exist_ok=True)
    moved = []
    for n in names:
        p = os.path.join(out, n)
        if not os.path.exists(p):
            continue
        dst = os.path.join(LEGACY_DIR, n)
        if os.path.exists(dst):
            dst = os.path.join(LEGACY_DIR, f"{n}-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.move(p, dst)
        moved.append((p, dst))
    return moved


# ---------------------------------------------------------------- main
def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="ACGhelper 2.8.31.16 v2/r4 权威构建器（38 + 29 feature = 67，总条数由规格算出）")
    ap.add_argument("--src", default=DEF_SRC, help="原始解包目录（只读）")
    ap.add_argument("--out", default=DEF_OUT, help="输出目录")
    ap.add_argument("--with-optional", action="store_true",
                    help="额外打 B5（credentials:include）→ 67 条；B6 已被 X5 消费自动跳过")
    ap.add_argument("--skip-feature", action="append", default=[],
                    help="跳过某个 feature（pgc-fix / dash-auth-fix / dash-fallback / webdav / batch），"
                         "可重复或用逗号分隔")
    ap.add_argument("--check", action="store_true", help="只校验锚点与全内存演练，零写入")
    ap.add_argument("--archive-legacy", action="store_true",
                    help="落盘前把 output 里的旧成品（目录 + zip）移进 build/legacy-intermediate/")
    args = ap.parse_args(argv)

    skip = set()
    for s in args.skip_feature:
        for x in str(s).replace("，", ",").split(","):
            x = x.strip()
            if x:
                skip.add(x)
    unknown = skip - {f["name"] for f in FEATURES}
    if unknown:
        print(f"[FATAL] 未知 feature: {sorted(unknown)}"
              f"（可选：pgc-fix / dash-auth-fix / dash-fallback / webdav / batch）")
        return 2

    src = os.path.abspath(args.src)
    out = os.path.abspath(args.out)
    if not os.path.isdir(src):
        print(f"[FATAL] 源目录不存在: {src}")
        return 2

    # ---- 五路 feature：先把规格读干净（条数不符即刻失败，不进入任何演练）----
    active = [f for f in FEATURES if f["name"] not in skip]
    plans = {}
    for f in active:
        bytes_ops, copy_ops, declared = load_feature_ops(f)
        if declared != f["expect"]:
            print(f"[FAIL] [feature:{f['name']}] 规格 patches[] = {declared} != 预期 {f['expect']}")
            return 1
        plans[f["name"]] = (bytes_ops, copy_ops, declared)
    expect_feature = sum(plans[f["name"]][2] for f in active)
    expect_added = sum(len(plans[f["name"]][1]) for f in active)

    # ---- 既有 38 条：复用 apply-all-patches.py 的定义 ----
    static = BASE.load_static_patches()
    proto = BASE.load_json(BASE.PROTO_SPEC)
    extra = BASE.load_extra()
    optional = BASE.load_json(BASE.PROTO_OPT)
    items, skipped_opt = BASE.collect(static, proto, extra, optional, args.with_optional)
    expect_base = len(items)
    expect_total = expect_base + expect_feature

    key_b64 = read_text(KEY_FILE).strip()
    if len(key_b64) != 216:
        print(f"[WARN] original-public-key.txt 长度 {len(key_b64)} != 216")

    print("=" * 118)
    print(f"构建器      : {os.path.basename(__file__)}（r4：既有 38 条 + 五路新功能）")
    print(f"源目录      : {src}（只读）")
    print(f"输出目录    : {out}")
    print(f"既有补丁    : static {len(static)} + proto {len(proto)} + extra {len(extra)}"
          f" + optional {len(items) - len(static) - len(proto) - len(extra)} = {expect_base}")
    for f in FEATURES:
        flag = "跳过" if f["name"] in skip else "应用"
        print(f"feature     : {f['name']:14s} {f['expect']:>2d} 条  [{flag}]  —— {f['label']}")
    if skipped_opt:
        for s in skipped_opt:
            print(f"  跳过可选  : [{s['id']}] {s['file']}  {s['reason']}")
    print(f"预期总计数  : {expect_base} + {expect_feature} = {expect_total} 条"
          f"（规格算出：38 + {'+'.join(str(plans[f['name']][2]) for f in active)} = {expect_total}；"
          f"默认口径 38 + 4+8+5+9+3 = {EXPECT_TOTAL_DEFAULT}）；"
          f"计划新增文件 {expect_added} 个（默认口径 {EXPECT_NEW_FILES}）")
    print("分段顺序    : pristine(static→proto) → post-proto(extra) → post-extra(optional)"
          " → feature:pgc-fix → feature:dash-auth-fix → feature:dash-fallback"
          " → feature:webdav(WBR1..3 bridge → 9 条) → feature:batch")
    print("=" * 118)

    src_fp_before = tree_fingerprint(src)
    bridge_steps = []
    try:
        pristine, buf, report = BASE.simulate(src, items)
        print(f"既有段：{len(report)} 条全部应用（每段锚点 count==1、同文件区间不重叠）")
        # feature 段的 manifest 种子 = 「已写 version_name 的规范化文本」，与 38 条成品树逐字节一致
        manifest_seed = patch_manifest_text(read_text(os.path.join(src, "manifest.json")), None)
        added = []
        for f in active:
            if f["name"] == "webdav":
                bridge_steps = webdav_legacy_bridge(plans["webdav"][0], buf, src, manifest_seed)
                if bridge_steps:
                    print(f"  feature:webdav   v1 前置态重建 {len(bridge_steps)} 步（不计入补丁条数）：")
                    for b in bridge_steps:
                        print(f"    [{b['id']}] {b['file']:24s} off={b['offset_in_file']:>8d} "
                              f"{b['old_len']:>6d}B → {b['new_len']:>6d}B  {b['why'][:60]}")
                else:
                    print("  feature:webdav   输入已是 v1 前置态，跳过 bridge")
            apply_feature(f, plans[f["name"]], buf, src, manifest_seed, report, added)
        added_bytes = {a["to"]: open(os.path.join(ROOT, a["src"].replace("/", os.sep)), "rb").read()
                       for a in added}
    except (PatchError, BASE.PatchError) as e:
        print(f"[FAIL] {e}")
        return 1

    # ---- 内存态自检 ----
    n_feature = len([r for r in report if r["phase"] == "feature"])
    counts = dict(
        static=len([r for r in report if r["phase"] == "static"]),
        proto=len([r for r in report if r["phase"] == "proto"]),
        extra=len([r for r in report if r["phase"] == "extra"]),
        feature=n_feature,
        feature_by_name={f["name"]: len([r for r in report
                                        if r["phase"] == "feature" and r["feature"] == f["name"]])
                         for f in active},
        optional_applied=len([r for r in report if r["phase"] == "optional"]),
        optional_available=len(optional),
        optional_skipped=[s["id"] for s in skipped_opt],
        applied=len(report), expected_total=expect_total,
        added_files=len(added), expected_added_files=expect_added)
    print("-" * 118)
    print("feature 锚点审计（在『上一段输出』的快照上做）：")
    for r in report:
        if r["phase"] != "feature":
            continue
        a = r.get("anchor_audit") or {}
        if r["kind"] == "copy":
            print(f"  [{r['id']:12s}] feature:copy     {r['file']:32s} 新增 {r['new_len']:>7d} B")
        else:
            print(f"  [{r['id']:12s}] feature:{r['feature']:8s} {r['file']:26s} "
                  f"count={a.get('count_in_stage_input')}  off={a.get('offset_in_stage_input')!s:>7s}")
    print("-" * 118)
    print(f"计数：static={counts['static']}  proto={counts['proto']}  extra={counts['extra']}  "
          f"feature={counts['feature']}  applied={counts['applied']}/{expect_total}  "
          f"新增文件={counts['added_files']}")
    if n_feature != expect_feature:
        print(f"[FAIL] feature 应用 {n_feature} 条 != 期望 {expect_feature}")
        return 1
    if counts["applied"] != expect_total:
        print(f"[FAIL] 总计 {counts['applied']} != 期望 {expect_total}")
        return 1
    if len(added) != expect_added:
        print(f"[FAIL] 新增文件 {len(added)} != 期望 {expect_added}")
        return 1

    # 每个 feature 的 new 必须出现、old 必须不再出现（自包含型除外）
    post_fail, self_contained = [], []
    for f in active:
        bytes_ops = plans[f["name"]][0]
        for o in bytes_ops:
            s = buf[o["file"]]
            if s.count(o["new"]) < 1:
                post_fail.append(f"[{o['id']}] new 未出现")
            if o["old"] in o["new"]:
                self_contained.append(o["id"])
            elif s.count(o["old"]) != 0:
                post_fail.append(f"[{o['id']}] old 仍在（count={s.count(o['old'])}）")
    if post_fail:
        print("[FAIL] feature 打后校验失败：")
        for x in post_fail:
            print("   " + x)
        return 1
    print(f"feature 打后校验：{expect_feature} 条的 new 全部出现 / old 全部消失")
    print(f"自包含型 feature 补丁（new 含 old，属预期）：{self_contained or '无'}")
    newly = sorted(set(buf) - set(pristine))
    print(f"改动文件 {len(buf)} 个；其中 feature 段才 materialize 的：{newly}")

    if args.check:
        print("\n[CHECK ONLY] 全内存演练通过，未写任何文件。")
        print(f"  预计落盘：{PROD_PLAIN}/ + .zip、{PROD_SAMEID}/ + .zip、"
              f"_patch-report.json、_build-info.json")
        return 0

    # ---------------- 落盘 ----------------
    os.makedirs(out, exist_ok=True)
    if args.archive_legacy:
        for a, b in archive_legacy(out, [PROD_PLAIN, PROD_SAMEID,
                                         PROD_PLAIN + ".zip", PROD_SAMEID + ".zip"]):
            print(f"旧成品归档 : {a}\n          -> {b}")
    plain_dir = os.path.join(out, PROD_PLAIN)
    same_dir = os.path.join(out, PROD_SAMEID)
    build_tree(plain_dir, src, buf, added_bytes, None)
    build_tree(same_dir, src, buf, added_bytes, key_b64)
    plain_zip = os.path.join(out, PROD_PLAIN + ".zip")
    same_zip = os.path.join(out, PROD_SAMEID + ".zip")
    pz_sha, pz_size = BASE.make_zip(plain_dir, plain_zip)
    sz_sha, sz_size = BASE.make_zip(same_dir, same_zip)

    computed_id = ext_id_from_key(key_b64)
    id_ok = computed_id == STOREFRONT_ID
    plain_fp = tree_fingerprint(plain_dir)
    same_fp = tree_fingerprint(same_dir)
    print(f"\n产物：\n  {plain_dir}  (tree sha256={plain_fp})")
    print(f"  {plain_zip}  ({pz_size} bytes, sha256={pz_sha})")
    print(f"  {same_dir}  (tree sha256={same_fp})")
    print(f"  {same_zip}   ({sz_size} bytes, sha256={sz_sha})")
    print(f"key → 扩展 ID : {computed_id}  "
          f"{'== 商店版 ' + STOREFRONT_ID if id_ok else '!! 与商店版 ' + STOREFRONT_ID + ' 不一致'}")

    # 落盘后回读校验（成品树必须真的带 version_name / 新增文件 / key）
    for label, tree in (("plain", plain_dir), ("sameId", same_dir)):
        man = json.loads(read_text(os.path.join(tree, "manifest.json")))
        if man["version_name"] != VERSION_NAME or man["version"] != "2.8.31.16":
            print(f"[FAIL] [{label}] manifest version 字段不符：{man['version_name']} / {man['version']}")
            return 1
        if label == "sameId" and man.get("key") != key_b64:
            print(f"[FAIL] [{label}] manifest.key 与 original-public-key.txt 不一致")
            return 1
        for a in added:
            p = os.path.join(tree, a["to"].replace("/", os.sep))
            if not os.path.isfile(p) or sha256_file(p) != a["sha256"]:
                print(f"[FAIL] [{label}] 新增文件缺失或哈希不符：{a['to']}")
                return 1
        print(f"  [{label}] version_name / version / 新增 {len(added)} 文件哈希 回读 OK"
              + (" / key OK" if label == "sameId" else ""))

    # ---------------- 报告 ----------------
    feature_ids = {f["name"]: [r["id"] for r in report
                               if r["phase"] == "feature" and r["feature"] == f["name"]]
                   for f in FEATURES if f["name"] not in skip}
    base_ids = dict(
        static=[r["id"] for r in report if r["phase"] == "static"],
        proto=[r["id"] for r in report if r["phase"] == "proto"],
        extra=[r["id"] for r in report if r["phase"] == "extra"],
        optional=[r["id"] for r in report if r["phase"] == "optional"],
    )
    release_segments = [
        dict(order=i, segment=f"feature:{f['name']}", declared=f["expect"],
             applied=counts["feature_by_name"].get(f["name"], 0),
             ids=feature_ids.get(f["name"], []),
             bytes_patches=len([o for o in plans[f["name"]][0]]),
             added_files=len(plans[f["name"]][1]),
             label=f["label"])
        for i, f in enumerate(active, 1)]
    # 总条数**由规格算出**：38 既有 + Σ feature.patches[]（webdav 的新增文件条目写在 patches[] 里，一并计入）
    _formula_parts = ["38"]
    for _f in active:
        _formula_parts.append("%s=%d" % (_f["name"], plans[_f["name"]][2]))
    totals = dict(
        base=dict(static=len(base_ids["static"]), proto=len(base_ids["proto"]),
                  extra=len(base_ids["extra"]), optional_applied=len(base_ids["optional"]),
                  optional_available=len(optional), sum_base=expect_base),
        feature={f["name"]: dict(declared=plans[f["name"]][2],
                                 bytes_patches=len(plans[f["name"]][0]),
                                 added_files=len(plans[f["name"]][1]))
                 for f in active},
        feature_sum=expect_feature,
        total_from_spec=expect_total,
        total_applied=counts["applied"],
        formula=" + ".join(_formula_parts) + " = %d" % expect_total,
        new_files_from_spec=expect_added,
        new_files_applied=len(added),
        bridge_steps=len(bridge_steps),
        bridge_note="bridge 只是把 pristine 补成 webdav v2 规格声明的 v1 前置态，不计入补丁条数",
    )
    with open(os.path.join(out, "_patch-report.json"), "w", encoding="utf-8") as fh:
        json.dump(dict(
            generated_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            builder=os.path.basename(__file__),
            version_name=VERSION_NAME,
            order_rule="分段 pristine(static→proto) → post-proto(extra) → post-extra(optional) "
                       "→ feature:pgc-fix → feature:dash-auth-fix → feature:dash-fallback "
                       "→ feature:webdav(bridge→9 条) → feature:batch；"
                       "段内同文件按快照偏移降序、旧串长度降序",
            stages=dict(stage1=["static", "proto"], stage2=["extra"], stage3=["optional"],
                        stage4=[f"feature:{f['name']}" for f in active]),
            totals=totals,
            base_patch_ids=base_ids,
            feature_segments=release_segments,
            feature_segment_counts={f["name"]: counts["feature_by_name"].get(f["name"], 0)
                                    for f in active},
            webdav_bridge=bridge_steps,
            with_optional=args.with_optional,
            skipped_features=sorted(skip),
            counts=counts,
            feature_patches=feature_ids,
            added_files=added,
            patches=report), fh, ensure_ascii=False, indent=2)

    src_fp_after = tree_fingerprint(src)
    info = dict(
        built_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        builder=os.path.basename(__file__),
        manifest_version="2.8.31.16",
        version_name=VERSION_NAME,
        source_zip=dict(path=SRC_ZIP, sha256=sha256_file(SRC_ZIP), size=os.path.getsize(SRC_ZIP)),
        source_dir=dict(path=src, sha256_tree=src_fp_before,
                        unchanged_before_after=(src_fp_before == src_fp_after)),
        patch_counts=counts,
        totals=totals,
        webdav_bridge=bridge_steps,
        feature_ids=feature_ids,
        added_files=added,
        with_optional=args.with_optional,
        skipped_features=sorted(skip),
        toolchain=dict(python=sys.version.split()[0], node=BASE.node_version(),
                       chrome=BASE.chrome_version()),
        products=[
            dict(name=PROD_PLAIN, dir=plain_dir, tree_sha256=plain_fp, zip=plain_zip,
                 zip_size=pz_size, zip_sha256=pz_sha, key_injected=False,
                 extension_id="(derived by Chrome, random)"),
            dict(name=PROD_SAMEID, dir=same_dir, tree_sha256=same_fp, zip=same_zip,
                 zip_size=sz_size, zip_sha256=sz_sha, key_injected=True,
                 extension_id=computed_id, key_matches_storefront=id_ok),
        ])
    with open(os.path.join(out, "_build-info.json"), "w", encoding="utf-8") as fh:
        json.dump(info, fh, ensure_ascii=False, indent=2)

    print(f"\n计数：{json.dumps(counts, ensure_ascii=False)}")
    print(f"总条数（规格算出）：{totals['formula']}"
          f"；实落 {totals['total_applied']}；新增文件 规格 {totals['new_files_from_spec']}"
          f" / 实落 {totals['new_files_applied']}；bridge {totals['bridge_steps']} 步（不计入）")
    print(f"feature 补丁 id：{json.dumps(feature_ids, ensure_ascii=False)}")
    print(f"报告：{os.path.join(out, '_patch-report.json')}")
    print(f"      {os.path.join(out, '_build-info.json')}")
    print(f"src/extracted 指纹未变：{src_fp_before == src_fp_after}  ({src_fp_before[:16]}…)")
    if not id_ok or src_fp_before != src_fp_after:
        print("[FAIL] 关键自检未通过")
        return 1
    print("\nBUILD OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
