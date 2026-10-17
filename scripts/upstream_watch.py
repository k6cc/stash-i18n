#!/usr/bin/env python3
"""Detect upstream updates for the plugins recorded in UPSTREAM.md.

Reads the UPSTREAM.md bookkeeping table, then asks the GitHub or GitLab API for
the newest commit touching each plugin's upstream path. Any plugin whose
upstream HEAD differs from the recorded baseline is reported.

Output is a Markdown report on stdout, suitable to be pasted into a GitHub
issue body. Nothing is written to stdout when everything is up to date, so
callers can simply test for empty output.

Usage:
    python3 scripts/upstream_watch.py            # report to stdout
    GITHUB_TOKEN=xxx python3 scripts/upstream_watch.py
    GITLAB_TOKEN=xxx python3 scripts/upstream_watch.py

Tokens are optional (public repos); when set they lift API rate limits and
allow private upstreams.

Exit code is always 0 (the report itself is the signal).
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPSTREAM_MD = ROOT / "UPSTREAM.md"
GH_API = "https://api.github.com"
GL_API = "https://gitlab.com/api/v4"
REPO_URL_RE = re.compile(r"\((https?://[^)]+)\)")


def http_get(url, headers=None):
    req = urllib.request.Request(url)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def github_get(path):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "stash-i18n-upstream-watch",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    return http_get(GH_API + path, headers)


def gitlab_get(path):
    headers = {"User-Agent": "stash-i18n-upstream-watch"}
    token = os.environ.get("GITLAB_TOKEN")
    if token:
        headers["PRIVATE-TOKEN"] = token
    return http_get(GL_API + path, headers)


def parse_repo(repo_url):
    """Map an upstream URL to (host, slug).

    slug keeps the full owner path, so GitLab subgroups work too:
      https://github.com/sanjiswe/plugins      -> ("github", "sanjiswe/plugins")
      https://gitlab.com/allisless0/stash-plugins
                                               -> ("gitlab", "allisless0/stash-plugins")
    Returns (None, None) when the URL is not a supported host.
    """
    m = re.match(r"https?://github\.com/([^/]+/[^/]+?)(?:\.git)?/?$", repo_url.strip())
    if m:
        return "github", m.group(1)
    m = re.match(r"https?://gitlab\.com/(.+?)(?:\.git)?/?$", repo_url.strip())
    if m:
        return "gitlab", m.group(1)
    return None, None


def upstream_commits(host, slug, path):
    """Return (web_root, branch, commits) for the newest commits touching path.

    commits is newest-first, each {sha, message, date}; raises urllib.error.HTTPError
    on API failure.
    """
    if host == "github":
        owner, repo = slug.split("/", 1)
        info = github_get("/repos/%s/%s" % (owner, repo))
        branch = info.get("default_branch", "main")
        raw = github_get("/repos/%s/%s/commits?path=%s&sha=%s&per_page=20"
                         % (owner, repo, urllib.parse.quote(path), branch))
        web_root = "https://github.com/%s" % slug
        commits = [{
            "sha": c["sha"],
            "message": c["commit"]["message"].splitlines()[0],
            "date": c["commit"]["author"]["date"][:10],
        } for c in raw]
    else:
        enc = urllib.parse.quote(slug, safe="")
        info = gitlab_get("/projects/%s" % enc)
        branch = info.get("default_branch", "main")
        raw = gitlab_get("/projects/%s/repository/commits?path=%s&ref_name=%s&per_page=20"
                         % (enc, urllib.parse.quote(path), urllib.parse.quote(branch)))
        web_root = "https://gitlab.com/%s" % slug
        commits = [{
            "sha": c["id"],
            "message": (c.get("title") or c.get("message", "").splitlines()[0]),
            "date": (c.get("authored_date") or c.get("committed_date") or "")[:10],
        } for c in raw]
    return web_root, branch, commits


def compare_url(host, web_root, base, head):
    if host == "github":
        return "%s/compare/%s...%s" % (web_root, base, head)
    return "%s/-/compare/%s...%s" % (web_root, base, head)


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
        host, slug = parse_repo(rec["repo_url"])
        if not host:
            print("WARN: %s upstream url not parseable: %s" % (rec["id"], rec["repo_url"]),
                  file=sys.stderr)
            continue
        try:
            web_root, branch, commits = upstream_commits(host, slug, rec["path"])
        except urllib.error.HTTPError as e:
            print("WARN: %s %s API error %s for %s" % (rec["id"], host, e.code, slug),
                  file=sys.stderr)
            continue

        if not commits:
            print("WARN: %s no commits found at %s in %s"
                  % (rec["id"], rec["path"], slug), file=sys.stderr)
            continue

        head_sha = commits[0]["sha"]
        base = rec["base"]
        if head_sha.startswith(base) or (base and base.startswith(head_sha[:len(base)])):
            continue  # up to date

        new = []
        for c in commits:
            if c["sha"].startswith(base):
                break
            new.append(c)
        lines = ["- `%s` %s (%s)" % (c["sha"][:7], c["message"], c["date"]) for c in new]
        compare = compare_url(host, web_root, base, head_sha[:7])
        pending.append(
            "### %s\n\n"
            "- 上游仓库：%s\n"
            "- 上游路径：`%s`\n"
            "- 记账基线：`%s` (%s)\n"
            "- 上游 HEAD：`%s`（%s 分支）\n"
            "- 对比：%s\n\n"
            "自基线以来的上游提交（最多最近 20 条）：\n\n%s\n" % (
                rec["id"], web_root, rec["path"], base, rec["date"],
                head_sha[:7], branch, compare, "\n".join(lines)))

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
