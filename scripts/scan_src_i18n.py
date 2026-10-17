#!/usr/bin/env python3
"""Scan an upstream plugin's *source tree* (`src/*.js`, `src/*.jsx`) for
user-visible English text, using the same logic as `check_i18n.py`.

Used for upstreams that ship as a build-source repository (e.g. Xenith:
`src/` + vite → `dist/xenith.js`). Scanning the compressed bundle is
unreliable — esbuild minifies everything onto a single line and renames the
wrapper (`tc` → `e`), so both the line numbers and the call stripping break.
The un-minified `src/` keeps named wrappers and real line numbers.

Usage:
    python3 scripts/scan_src_i18n.py <上游src目录>        # 只列确认候选
    python3 scripts/scan_src_i18n.py <上游src目录> --all  # 连被形态规则过滤的一起列

`--all` 用来人工复核短文案与白名单漏网（被 `looks_like_prose` 过滤掉的整串）。

扫不到的仍然要人工看：写死在 JSX 结构里的英文文本节点、CSS `content:`、
HTML 字符串、以 `` `${name}: `` 开头的模板字面量、部分 `throw new Error()`。
（见 i18n-playbook.md「校验清单」）
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_i18n as C

# 与 check_i18n 的默认一致：i18n 包装函数 + 不显示给用户的日志/错误调用
SKIP = ("tc", "kl", "kp", "log", "warn", "error", "Error")


def main():
    ap = argparse.ArgumentParser(description="扫描上游插件 src/ 里残留的英文界面文案")
    ap.add_argument("src_dir", help="上游 src 目录（如 e:/Temp/_xenith_upstream/src）")
    ap.add_argument("--all", action="store_true",
                    help="连被形态规则过滤掉的候选一起列出（人工复核短文案/白名单漏网）")
    args = ap.parse_args()

    src_root = Path(args.src_dir)
    if not src_root.is_dir():
        print("ERROR: 不是目录：%s" % src_root, file=sys.stderr)
        return 1

    total = 0
    files = sorted(list(src_root.rglob("*.js")) + list(src_root.rglob("*.jsx")))
    for p in files:
        src = p.read_text(encoding="utf-8")
        cands, counts = C.scan_source(src, SKIP)
        hits = []
        filtered = []
        seen = set()
        for ln, text, _kind in cands:
            found = C.visible_phrases(text)
            if found:
                for kind, phrase in found:
                    if (ln, phrase) not in seen:
                        seen.add((ln, phrase))
                        hits.append((ln, kind, phrase))
            elif args.all and text.strip():
                f = " ".join(text.split())[:100]
                if any(ch.isalpha() for ch in f):
                    filtered.append((ln, f))
        print("== %s ==  tc=%d  候选=%d" % (p.relative_to(src_root), counts["tc"], len(hits)))
        for ln, kind, phrase in hits:
            print("   %5d [%-4s] %s" % (ln, kind, phrase))
        if filtered:
            print("   -- 被形态规则过滤（人工复核）--")
            for ln, f in filtered:
                print("   %5d  %s" % (ln, f))
        total += len(hits)

    print("合计候选：%d" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
