#!/usr/bin/env python3
"""Detect upstream updates for the plugins recorded in UPSTREAM.md.

Reads the UPSTREAM.md bookkeeping table, then asks the GitHub API for the
newest commit touching each plugin's upstream path. Any plugin whose upstream
HEAD differs from the recorded baseline is reported.

Output is a Markdown report on stdout, suitable to be pasted into a GitHub
issue body. Nothing is written to stdout when everything is up to date, so
callers can simply test for empty output.

Usage:
    python3 scripts/upstream_watch.py            # report to stdout
    GITHUB_TOKEN=xxx python3 scripts/upstream_watch.py

Exit code is always 0 (the report itself is the signal).
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPSTREAM_MD = ROOT / "UPSTREAM.md"
API = "https://api.github.com"
REPO_URL_RE = re.compile(r"\((https?://[^)]+)\)")


def github_get(path):
    req = urllib.request.Request(API + path)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "stash-i18n-upstream-watch")
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def owner_repo(repo_url):
    """https://github.com/owner/repo(.git) -> (owner, repo)"""
    m = re.match(r"https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$", repo_url.strip())
    if not m:
        return None
    return m.group(1), m.group(2)


def parse_records(text):
    """Parse the UPSTREAM.md bookkeeping table into a list of dicts."""
    records = []
    in_table = False
    for line in text.splitlines():
        if re.match(r"^\s*\|\s*插件\s*\|", line):
            in_table = True
            continue
        if not in_table:
            continue
        if not line.lstrip().startswith("|"):
            if records:
                break
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 6 or set(cells[0]) <= set("-: "):
            continue
        m = REPO_URL_RE.search(cells[1])
        repo_url = m.group(1) if m else ""
        if not repo_url and re.match(r"^[\w.-]+/[\w.-]+$", cells[1]):
            repo_url = "https://github.com/" + cells[1] + ".git"
        records.append({
            "id": cells[0],
            "repo_url": repo_url,
            "path": cells[2].strip("`"),
            "base": cells[4].strip("`"),
            "date": cells[5],
        })
    return records


def main():
    if not UPSTREAM_MD.exists():
        print("ERROR: %s not found" % UPSTREAM_MD, file=sys.stderr)
        sys.exit(1)
    records = parse_records(UPSTREAM_MD.read_text(encoding="utf-8"))
    if not records:
        print("ERROR: no plugin rows parsed from UPSTREAM.md", file=sys.stderr)
        sys.exit(1)

    pending = []
    for rec in records:
        if not rec["repo_url"]:
            print("WARN: %s has no upstream repo url, skipped" % rec["id"], file=sys.stderr)
            continue
        slug = owner_repo(rec["repo_url"])
        if not slug:
            print("WARN: %s upstream url not parseable: %s" % (rec["id"], rec["repo_url"]),
                  file=sys.stderr)
            continue
        owner, repo = slug
        try:
            info = github_get("/repos/%s/%s" % (owner, repo))
            branch = info.get("default_branch", "main")
            commits = github_get(
                "/repos/%s/%s/commits?path=%s&sha=%s&per_page=5"
                % (owner, repo, urllib.request.quote(rec["path"]), branch))
        except urllib.error.HTTPError as e:
            print("WARN: %s GitHub API error %s for %s/%s" % (rec["id"], e.code, owner, repo),
                  file=sys.stderr)
            continue

        if not commits:
            print("WARN: %s no commits found at %s in %s/%s"
                  % (rec["id"], rec["path"], owner, repo), file=sys.stderr)
            continue

        head = commits[0]
        head_sha = head["sha"]
        base = rec["base"]
        if head_sha.startswith(base) or base.startswith(head_sha[:len(base)]):
            continue  # up to date

        new = []
        for c in commits:
            if c["sha"].startswith(base):
                break
            new.append(c)
        lines = []
        for c in new:
            msg = c["commit"]["message"].splitlines()[0]
            date = c["commit"]["author"]["date"][:10]
            lines.append("- `%s` %s (%s)" % (c["sha"][:7], msg, date))
        compare = "https://github.com/%s/%s/compare/%s...%s" % (owner, repo, base, head_sha[:7])
        pending.append(
            "### %s\n\n"
            "- 上游仓库：https://github.com/%s/%s\n"
            "- 上游路径：`%s`\n"
            "- 记账基线：`%s` (%s)\n"
            "- 上游 HEAD：`%s`\n"
            "- 对比：%s\n\n"
            "自基线以来的上游提交（最多最近 5 条）：\n\n%s\n" % (
                rec["id"], owner, repo, rec["path"], base, rec["date"],
                head_sha[:7], compare, "\n".join(lines)))

    if not pending:
        return

    print("<!-- upstream-watch -->")
    print()
    print("检测到以下汉化插件的上游有新提交，请按 `UPSTREAM.md` 的同步流程拉取合并：")
    print()
    print("```")
    print("powershell -File scripts/upstream-diff.ps1 -Plugin <插件名>")
    print("```")
    print()
    print("\n".join(pending))
    print("---")
    print("同步完成后执行 `powershell -File scripts/upstream-diff.ps1 -Plugin <插件名> -Record` 推进基线。")


if __name__ == "__main__":
    main()
