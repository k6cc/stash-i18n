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

    # 记账表记的是上游目录；上游文件名通常是原版名（LockdownI18n → Lockdown.js）
    up_dir = up_path.rstrip("/")
    base_name = a.plugin[:-4] if a.plugin.endswith("I18n") else a.plugin
    prefixes = [""] if up_dir in ("", ".") else [up_dir + "/"]
    candidates = [p + base_name + ".js" for p in prefixes] + [p + a.plugin + ".js" for p in prefixes]
    up_file = None
    for cand in candidates:
        if git(["cat-file", "-t", "%s:%s" % (a.theirs, cand)], check=False).stdout.strip() == "blob":
            up_file = cand
            break
    if up_file is None:
        listing = git(["ls-tree", "--name-only", a.theirs, up_dir or "."], check=False).stdout.split()
        js = [x for x in listing if x.endswith(".js")]
        if len(js) == 1:
            up_file = (up_dir + "/" if up_dir not in ("", ".") else "") + js[0]
        else:
            sys.exit("无法确定上游文件：%s 下 JS 有 %d 个（%s）" % (up_dir, len(js), ", ".join(js)))

    outdir = a.out or os.path.join(tempfile.gettempdir(), "stash-i18n-sync", a.plugin)
    if not os.path.isdir(outdir):
        os.makedirs(outdir)

    ours_path = os.path.join(ROOT, a.plugin, a.plugin + ".js")
    if not os.path.exists(ours_path):
        sys.exit("找不到本地汉化文件：%s" % ours_path)

    base = git(["show", "%s:%s" % (base_sha, up_file)]).stdout
    theirs = git(["show", "%s:%s" % (a.theirs, up_file)]).stdout
    ours = read_text(ours_path)

    # 统一换行：本仓库工作区可能是 CRLF（autocrlf），上游 blob 是 LF；
    # 不归一化时每一行都被当成「改动」，三方合并会退化成整文件冲突。
    def lf(text):
        return text.replace("\r\n", "\n").replace("\r", "\n")

    write_text(os.path.join(outdir, "base.js"), lf(base))
    write_text(os.path.join(outdir, "theirs.js"), lf(theirs))
    write_text(os.path.join(outdir, "ours.js"), lf(ours))

    p = subprocess.run(["git", "merge-file", "-p", "--diff3", "--",
                        os.path.join(outdir, "ours.js"),
                        os.path.join(outdir, "base.js"), os.path.join(outdir, "theirs.js")],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    raw = p.stdout
    write_text(os.path.join(outdir, "merged_conflicted.js"), raw)

    resolved, blocks = split_conflicts(raw)
    total = len(raw.splitlines())
    biggest = max((no + nt for _ln, no, nt in blocks), default=0)
    if not a.markers and biggest >= total * 0.9:
        write_text(os.path.join(outdir, "conflicts.txt"),
                   "整个文件被判为冲突（%d 行），已中止，未输出 merged.js。\n"
                   "常见原因：换行符/BOM 不一致、上游路径取到了目录、或本地文件被整体替换过。\n" % total)
        sys.exit("冲突覆盖整份文件（%d/%d 行），疑似换行符或路径问题，已中止；见 %s"
                 % (biggest, total, os.path.join(outdir, "conflicts.txt")))
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
