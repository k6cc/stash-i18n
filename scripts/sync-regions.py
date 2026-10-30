#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按注释段头把大文件切成若干区段，译完再原样拼回。

为什么不用行号：翻译会增减行，行号必然漂移；段头注释（如
`// ═══ Sounds ═══`、`// ── 2.16: the hand of cards ──`）是稳定的锚点。

用法：
  # 1) 切分：给每个区段一份完整副本（子代理只改自己副本的区段）
  python scripts/sync-regions.py split <merged.js> --outdir <工作目录> [--max-lines 1500]

  # 2) 回拼：按 manifest.json 的锚点把各副本的区段替换回源文件
  python scripts/sync-regions.py splice --dir <工作目录>

产物：
  m_A.js / m_B.js …   区段副本（内容 = 整份源文件，便于代理读上下文）
  manifest.json       区段锚点与行号（splice 只认它，不重新探测）
"""
import argparse
import io
import json
import os
import re
import shutil
import sys

MARKER = re.compile(r"^\s*//\s*(?:\u2550|\u2500){2,}")


def read_lines(path):
    with io.open(path, "r", encoding="utf-8", newline="") as f:
        return f.read().splitlines(True)


def write_lines(path, lines):
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write("".join(lines))


def key_of(line):
    """段头归一化：去掉 //、所有═/─、首尾空白，只留文字。"""
    t = line.strip()
    t = t[t.find("//") + 2:]
    t = re.sub(r"[\u2550\u2500]+", "", t)
    return " ".join(t.split())


def markers(lines, start=0, upto=None):
    ms = []
    end = len(lines) if upto is None else upto
    for i in range(start, end):
        if MARKER.match(lines[i]):
            ms.append((i, key_of(lines[i]), lines[i].rstrip("\n")))
    return ms


def nth(lines, key, occ, start=0):
    seen = -1
    for i in range(start, len(lines)):
        if MARKER.match(lines[i]) and key_of(lines[i]) == key:
            seen += 1
            if seen == occ:
                return i
    return -1


def name_for(i):
    if i < 26:
        return chr(ord("A") + i)
    return "R%d" % i


def do_split(a):
    lines = read_lines(a.src)
    ms = markers(lines)
    if not ms:
        sys.exit("没有找到 // ═══ / ── 段头注释，无法切分")
    if not os.path.isdir(a.outdir):
        os.makedirs(a.outdir)

    # 依次累计区段，超过 max-lines 就断开
    groups = []
    cur = [0]
    for k in range(1, len(ms)):
        span = ms[k][0] - ms[cur[0]][0]
        if span >= a.max_lines and span > (ms[cur[-1]][0] - ms[cur[0]][0]):
            groups.append(cur)
            cur = [k]
        else:
            cur.append(k)
    groups.append(cur)

    occ_by_index = {}
    seen = {}
    for idx, key, _raw in ms:
        occ_by_index[idx] = seen.get(key, 0)
        seen[key] = seen.get(key, 0) + 1

    regions = []
    for gi, group in enumerate(groups):
        first = group[0]
        start_idx = ms[first][0]
        if gi + 1 < len(groups):
            end_idx = ms[groups[gi + 1][0]][0]
            end_key = ms[groups[gi + 1][0]][1]
            end_occ = occ_by_index[end_idx]
            end_raw = ms[groups[gi + 1][0]][2]
            span = end_idx - start_idx
        else:
            end_key, end_occ, end_raw, span = None, None, None, len(lines) - start_idx
        name = name_for(gi)
        copy_name = "m_%s.js" % name
        shutil.copyfile(a.src, os.path.join(a.outdir, copy_name))
        regions.append({
            "name": name,
            "copy": copy_name,
            "lines": [start_idx + 1, start_idx + span],   # 1 基、含首不含尾
            "start": {"key": ms[first][1], "occ": occ_by_index[start_idx], "raw": ms[first][2]},
            "end": None if end_key is None else {"key": end_key, "occ": end_occ, "raw": end_raw},
        })

    manifest = {"src": os.path.abspath(a.src), "regions": regions}
    with io.open(os.path.join(a.outdir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("已切分 %d 段 → %s" % (len(regions), a.outdir))
    for r in regions:
        print("  %-2s 第 %6d-%6d 行  %s" % (r["name"], r["lines"][0], r["lines"][1], r["start"]["raw"].strip()))


def do_splice(a):
    mpath = os.path.join(a.dir, "manifest.json")
    if not os.path.exists(mpath):
        sys.exit("找不到 %s" % mpath)
    with io.open(mpath, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    src = manifest["src"]
    if not os.path.exists(src):
        sys.exit("源文件不存在：%s" % src)
    lines = read_lines(src)

    for r in reversed(manifest["regions"]):
        copies = read_lines(os.path.join(a.dir, r["copy"]))
        cs = nth(copies, r["start"]["key"], r["start"]["occ"])
        if cs < 0:
            sys.exit("%s 里找不到起点段头：%s" % (r["copy"], r["start"]["raw"]))
        ce = len(copies) if r["end"] is None else nth(copies, r["end"]["key"], r["end"]["occ"], cs + 1)
        if ce < 0:
            sys.exit("%s 里找不到终点段头：%s" % (r["copy"], r["end"]["raw"]))
        s = nth(lines, r["start"]["key"], r["start"]["occ"])
        if s < 0:
            sys.exit("源文件里找不到起点段头：%s" % r["start"]["raw"])
        e = len(lines) if r["end"] is None else nth(lines, r["end"]["key"], r["end"]["occ"], s + 1)
        if e < 0:
            sys.exit("源文件里找不到终点段头：%s" % r["end"]["raw"])
        block = copies[cs:ce]
        lines[s:e] = block
        print("  %-2s %s  替换 %d → %d 行" % (r["name"], os.path.basename(src), e - s, len(block)))

    write_lines(src, lines)
    print("已回拼 → %s（共 %d 行）" % (src, len(lines)))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("split")
    sp.add_argument("src")
    sp.add_argument("--outdir", required=True)
    sp.add_argument("--max-lines", type=int, default=1500, help="每段目标行数（默认 1500）")
    sp.set_defaults(func=do_split)

    sl = sub.add_parser("splice")
    sl.add_argument("--dir", required=True)
    sl.set_defaults(func=do_splice)

    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
