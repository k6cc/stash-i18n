#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""三方合并：把上游新版改动并进本地汉化版。

场景：上游从基线（UPSTREAM.md 记账的 sha）跳到新版本，本地是已汉化的旧版。
做法：以「基线」为共同祖先，ours = 本地汉化文件，theirs = 上游新文件，
      git merge-file 三方合并；冲突默认整段取上游（保留新功能结构，冲突区
      随后再补译文），同时保留带冲突标记的副本供对照。

用法：
  python scripts/sync-threeway.py LockdownI18n --base 8d5b6d1 --theirs 0d58f7b
  python scripts/sync-threeway.py LockdownI18n --theirs 0d58f7b --markers   # 不自动取 theirs
  python scripts/sync-threeway.py LockdownI18n --theirs 0d58f7b --out e:\Temp\sync_mine

产物（默认落在系统临时目录 stash-i18n-sync/<插件ID>/）：
  base.js / theirs.js / ours.js   三方输入
  merged.js                       合并结果（默认冲突已取 theirs）
  merged_conflicted.js            原始冲突版（保留 <<<<<<< 标记）
  conflicts.txt                   冲突清单（行号 + 两侧行数）

前置：上游 remote 需已存在（先跑 scripts/upstream-diff.ps1 -Fetch）。
"""
import argparse
import io
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_text(path):
    with io.open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()


def write_text(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def git(args, cwd=ROOT, check=True):
    p = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if check and p.returncode != 0:
        sys.exit("git %s 失败：%s" % (" ".join(args), (p.stderr or p.stdout).strip()))
    return p


def upstream_record(plugin):
    """从 UPSTREAM.md 记账表取 (仓库链接, 上游路径, 基线 sha)。"""
    path = os.path.join(ROOT, "UPSTREAM.md")
    if not os.path.exists(path):
        sys.exit("找不到 UPSTREAM.md")
    in_table = False
    for line in read_text(path).splitlines():
        if re.match(r"^\s*\|\s*插件\s*\|", line):
            in_table = True
            continue
        if not in_table or not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 6 or cells[0] != plugin:
            continue
        link = re.search(r"\((https?://[^)]+)\)", cells[1])
        up_path = cells[2].strip("`")
        base = cells[4].strip("`")
        if not link:
            sys.exit("UPSTREAM.md 里 %s 没有上游仓库链接" % plugin)
        return link.group(1), up_path, base
    sys.exit("UPSTREAM.md 记账表里没有 %s（是否还在候选表？）" % plugin)


def remote_name(url):
    m = re.search(r"[:/]([^/:]+)/([^/]+?)(?:\.git)?$", url.rstrip("/"))
    if not m:
        sys.exit("无法解析上游仓库地址：%s" % url)
    return "upstream-%s-%s" % (m.group(1), m.group(2))


CONFLICT_START = re.compile(r"^<<<<<<<\s")
CONFLICT_MID = re.compile(r"^\|\|\|\|\|\|\|\s")
CONFLICT_SEP = re.compile(r"^=======\s*$")
CONFLICT_END = re.compile(r"^>>>>>>>\s")


def split_conflicts(text):
    """返回 (已取 theirs 的正文, 冲突块列表[(起始行(1基), ours 行数, theirs 行数)])。"""
    out, blocks = [], []
    i, n = 0, 0
    lines = text.splitlines(True)
    while i < len(lines):
        line = lines[i]
        if not CONFLICT_START.match(line):
            out.append(line)
            i += 1
            continue
        start = len(out) + 1
        i += 1
        ours_n = 0
        while i < len(lines) and not CONFLICT_MID.match(lines[i]) and not CONFLICT_SEP.match(lines[i]):
            ours_n += 1
            i += 1
        while i < len(lines) and not CONFLICT_SEP.match(lines[i]):
            i += 1
        i += 1  # 跳过 =======
        theirs = []
        while i < len(lines) and not CONFLICT_END.match(lines[i]):
            theirs.append(lines[i])
            i += 1
        i += 1  # 跳过 >>>>>>>
        out.extend(theirs)
        blocks.append((start, ours_n, len(theirs)))
        n += 1
    return "".join(out), blocks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("plugin")
    ap.add_argument("--base", help="共同祖先 sha（默认取 UPSTREAM.md 记账基线）")
    ap.add_argument("--theirs", required=True, help="上游新版本 sha/ref")
    ap.add_argument("--out", help="工作目录（默认 %%TEMP%%/stash-i18n-sync/<插件ID>）")
    ap.add_argument("--markers", action="store_true", help="保留冲突标记，不自动取 theirs")
    a = ap.parse_args()

    url, up_path, base_sha = upstream_record(a.plugin)
    base_sha = a.base or base_sha
    remote = remote_name(url)
    if git(["remote", "get-url", remote], check=False).returncode != 0:
        sys.exit("缺少 remote %s：先运行 pwsh -NoProfile -File scripts/upstream-diff.ps1 -Fetch" % remote)

    outdir = a.out or os.path.join(tempfile.gettempdir(), "stash-i18n-sync", a.plugin)
    if not os.path.isdir(outdir):
        os.makedirs(outdir)

    ours_path = os.path.join(ROOT, a.plugin, a.plugin + ".js")
    if not os.path.exists(ours_path):
        sys.exit("找不到本地汉化文件：%s" % ours_path)

    base = git(["show", "%s:%s" % (base_sha, up_path)]).stdout
    theirs = git(["show", "%s:%s" % (a.theirs, up_path)]).stdout
    ours = read_text(ours_path)
    write_text(os.path.join(outdir, "base.js"), base)
    write_text(os.path.join(outdir, "theirs.js"), theirs)
    write_text(os.path.join(outdir, "ours.js"), ours)

    p = subprocess.run(["git", "merge-file", "-p", "--diff3", "--", ours_path,
                        os.path.join(outdir, "base.js"), os.path.join(outdir, "theirs.js")],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    raw = p.stdout
    write_text(os.path.join(outdir, "merged_conflicted.js"), raw)

    resolved, blocks = split_conflicts(raw)
    report = ["冲突 %d 处（起始行, ours 行数, theirs 行数）" % len(blocks), ""]
    for i, (ln, no, nt) in enumerate(blocks, 1):
        report.append("%3d. 第 %6d 行  ours %4d 行 / theirs %4d 行" % (i, ln, no, nt))
    write_text(os.path.join(outdir, "conflicts.txt"), "\n".join(report) + "\n")

    write_text(os.path.join(outdir, "merged.js"), raw if a.markers else resolved)
    kind = "保留冲突标记" if a.markers else "冲突已取上游(theirs)"
    print("[%s] base=%s theirs=%s" % (a.plugin, base_sha, a.theirs))
    print("工作目录：%s" % outdir)
    print("冲突 %d 处，%s → merged.js" % (len(blocks), kind))
    print("下一步：python scripts/sync-regions.py split %s --outdir %s"
          % (os.path.join(outdir, "merged.js"), outdir))


if __name__ == "__main__":
    main()
