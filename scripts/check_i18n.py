#!/usr/bin/env python3
"""Report user-visible English text still left in a localized Stash plugin.

汉化插件里所有界面文案都应被 i18n 包装函数裹住（本仓库约定为 `tc(zh, en)`，
LockdownI18n 另有 `kl()` / `kp()` 便捷包装）。本脚本先剥掉注释，再把包装调用与
日志调用（`log` / `warn` / `error` / `Error`，都不显示给用户）整体剔除，然后只
报告「看着像给人看的英文」的候选，供人工复核是否漏译：

  [html]  从模板字符串/字符串里取出的 HTML 文本节点（`>文字<`）—— 一定会显示
  [text]  整条字符串本身就是一句人话 —— 可能是 alert/提示/未包装的标签

过滤分两层：

- 形态规则：只保留「以字母开头、只用散文标点、不含数字、非标识符形态
  （camelCase / PascalCase 多段 / ALL_CAPS / snake_case）、非 CSS 值 / 选择器 /
  URL / 路径 / GraphQL」的文本
- 白名单：品牌词与领域技术词（可在脚本顶部 `ALLOW_WORDS` 追加）

这只是启发式筛查，有两类遮不住：英文直接写死在 HTML 结构里（不经字符串）、
CSS `content:` 属性里的英文 —— 需要人工扫一眼。反过来也可能有少量误报，
所以它报告的是「候选」，不是「错误」。

Usage:
    python3 scripts/check_i18n.py                     # 扫描全部插件
    python3 scripts/check_i18n.py LockdownI18n        # 只扫某个插件（ID 或路径）
    python3 scripts/check_i18n.py --show-all          # 连被过滤掉的候选一起列
    python3 scripts/check_i18n.py --skip-fn tc,kl,kp  # 只看 i18n 包装之外的文本

`--strict` 让发现候选时以退出码 1 结束（供 CI 使用），默认始终为 0。
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 默认整体剔除：i18n 包装函数 + 不显示给用户的日志/错误调用
DEFAULT_SKIP_FN = ("tc", "kl", "kp", "log", "warn", "error", "Error")

# 允许直接留在界面上的英文：品牌词、上游技术词、按键名、领域术语
ALLOW_WORDS = {
    "stash", "stashdb", "lockdown", "ostats", "pluginapi", "react", "graphql",
    "suite", "plugin", "api", "json", "yml", "zip", "sha", "gql",
    "boolean", "string", "number", "id", "url", "utf",
    "enter", "escape", "tab", "space", "shift", "control", "alt", "meta",
    "delete", "backspace", "home", "end", "pageup", "pagedown",
}

# 只允许「散文标点」；出现这些字符的一律当作代码
CODE_CHARS_RE = re.compile(r"[{}<>\[\]=\"#$@&*+^~\\|;`_]")
WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\u2019]*")
HTML_NODE_RE = re.compile(r">([^<>]{2,})<")


def read_string(src, i, line):
    """Read a quoted string starting at src[i]; return (text, next_i, line)."""
    q = src[i]
    j = i + 1
    buf = []
    n = len(src)
    while j < n:
        c = src[j]
        if c == "\\":
            if j + 1 < n and src[j + 1] == "\n":
                line += 1
            buf.append(src[j:j + 2])
            j += 2
            continue
        if c == "\n":
            break  # 未闭合（JS 里非法），到此为止
        if c == q:
            j += 1
            break
        buf.append(c)
        j += 1
    return "".join(buf), j, line


def skip_interp(src, i, line):
    """Skip a `${ ... }` interpolation starting at src[i] == '$'; return (next_i, line)."""
    j = i + 2
    depth = 1
    n = len(src)
    while j < n and depth:
        c = src[j]
        if c == "\\":
            j += 2
            continue
        if c == "\n":
            line += 1
            j += 1
            continue
        if c in "\"'`":
            _, j, line = read_literal(src, j, line)
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        j += 1
    return j, line


def read_literal(src, i, line):
    """Read a string or template literal; return (parts, next_i, line).

    Template literals are split at `${}` so only the literal fragments
    (the text that actually renders) are returned.
    """
    if src[i] != "`":
        s, j, line = read_string(src, i, line)
        return [s], j, line
    j = i + 1
    n = len(src)
    parts = []
    cur = []
    while j < n:
        c = src[j]
        if c == "\\":
            if j + 1 < n and src[j + 1] == "\n":
                line += 1
            cur.append(src[j:j + 2])
            j += 2
            continue
        if c == "\n":
            line += 1
            cur.append(c)
            j += 1
            continue
        if c == "`":
            j += 1
            break
        if c == "$" and j + 1 < n and src[j + 1] == "{":
            parts.append("".join(cur))
            cur = []
            j, line = skip_interp(src, j, line)
            continue
        cur.append(c)
        j += 1
    parts.append("".join(cur))
    return parts, j, line


def skip_wrapper_call(src, i, line):
    """Skip a `name(...)` call; src[i] == '('; return (next_i, line)."""
    j = i
    n = len(src)
    depth = 0
    while j < n:
        c = src[j]
        if c == "\\":
            j += 2
            continue
        if c == "\n":
            line += 1
            j += 1
            continue
        if c in "\"'`":
            _, j, line = read_literal(src, j, line)
            continue
        if src.startswith("//", j):
            k = src.find("\n", j)
            j = n if k < 0 else k
            continue
        if src.startswith("/*", j):
            k = src.find("*/", j + 2)
            end = n if k < 0 else k + 2
            line += src.count("\n", j, end)
            j = end
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return j + 1, line
        j += 1
    return j, line


def scan_source(src, skip_fns):
    """Walk src once. Return (candidates, call_counts).

    candidates: list of (line, text, kind); kind is "str" or "tpl".
    call_counts: {wrapper_name: n} — how many wrapper calls were stripped.
    """
    cands = []
    counts = {fn: 0 for fn in skip_fns}
    i = 0
    line = 1
    n = len(src)
    ident_re = re.compile(r"[A-Za-z_$][\w$]*")
    while i < n:
        c = src[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if src.startswith("//", i):
            k = src.find("\n", i)
            i = n if k < 0 else k
            continue
        if src.startswith("/*", i):
            k = src.find("*/", i + 2)
            end = n if k < 0 else k + 2
            line += src.count("\n", i, end)
            i = end
            continue
        if c in "\"'`":
            start = line
            parts, i, line = read_literal(src, i, line)
            kind = "tpl" if c == "`" else "str"
            for p in parts:
                cands.append((start, p, kind))
            continue
        m = ident_re.match(src, i)
        if m:
            word = m.group(0)
            word_end = m.end()
            k = word_end
            while k < n and src[k] in " \t":
                k += 1
            if word in skip_fns and k < n and src[k] == "(":
                counts[word] += 1
                i, line = skip_wrapper_call(src, k, line)
                continue
            i = word_end
            continue
        i += 1
    return cands, counts


def is_ident_shape(w):
    """True when the word looks like a code identifier rather than prose."""
    if re.match(r"^[a-z][a-z0-9]*[A-Z]", w):                    # camelCase
        return True
    if re.match(r"^[A-Z][a-z0-9]*([A-Z][a-z0-9]*)+$", w):        # PascalCase 多段
        return True
    if len(w) > 1 and w.isupper() and "_" not in w:              # ALLCAPS 常量
        return True
    return False


def looks_like_prose(text):
    """Heuristic: would a human read this as displayed text?"""
    t = text.strip()
    if len(t) < 4 or len(t) > 160:
        return False
    if not re.match(r"^[A-Za-z]", t):
        return False
    if CODE_CHARS_RE.search(t):
        return False
    if re.search(r"[A-Za-z]\.[A-Za-z]", t):                      # a.selector / domain
        return False
    tokens = [tok for tok in t.split() if tok]
    if not tokens:
        return False
    if any(re.search(r"\d", tok) for tok in tokens):             # 尺寸/CSS/变量名
        return False
    if any(tok.startswith((".", "#", "@", "$")) for tok in tokens):
        return False
    hyphenated = sum(1 for tok in tokens if "-" in tok)
    if hyphenated and hyphenated * 2 >= len(tokens):             # CSS 类名列表
        return False
    words = WORD_RE.findall(t)
    if not words or any(is_ident_shape(w) for w in words):
        return False
    low = [w.lower().strip("'\u2019") for w in words]
    if all(w in ALLOW_WORDS for w in low):
        return False
    if len(words) == 1:
        # 单个词：要像标签（首字母大写、够长、不含连字符）
        w = words[0]
        return len(w) >= 5 and w[0].isupper() and "-" not in w
    # 多个词：要有大写起头的词，或本身够长像句子
    return any(w[0].isupper() for w in words) or len(words) >= 3


def visible_phrases(text):
    """Return [(kind, phrase)] — HTML text nodes plus the whole-string case."""
    out = []
    for node in HTML_NODE_RE.findall(text):
        if looks_like_prose(node):
            out.append(("html", node.strip()))
    if looks_like_prose(text):
        out.append(("text", text.strip()))
    return out


def plugin_files(targets):
    """Resolve CLI targets to a list of (label, path) JS files to scan."""
    files = []
    if targets:
        for t in targets:
            p = Path(t)
            if not p.is_absolute():
                p = ROOT / p
            if p.is_dir():
                for jsf in sorted(p.glob("*.js")):
                    files.append((jsf.parent.name + "/" + jsf.name, jsf))
            elif p.is_file():
                files.append((p.name, p))
            else:
                print("WARN: 未找到 %s" % t, file=sys.stderr)
    else:
        for jsf in sorted(ROOT.glob("*/*.js")):
            if jsf.stem == jsf.parent.name:      # 目录名 = 插件 ID = js 名
                files.append((jsf.parent.name + "/" + jsf.name, jsf))
    return files


def main():
    ap = argparse.ArgumentParser(description="扫描汉化插件里残留的英文界面文案")
    ap.add_argument("targets", nargs="*", help="插件 ID 或路径（默认扫描全部插件）")
    ap.add_argument("--skip-fn", default=",".join(DEFAULT_SKIP_FN),
                    help="整体剔除的调用名（i18n 包装函数 / 日志函数），逗号分隔（默认 %s）"
                         % ",".join(DEFAULT_SKIP_FN))
    ap.add_argument("--show-all", action="store_true", help="连被过滤掉的候选一起列出")
    ap.add_argument("--strict", action="store_true", help="发现候选时以退出码 1 结束")
    args = ap.parse_args()

    skip_fns = tuple(f.strip() for f in args.skip_fn.split(",") if f.strip())
    files = plugin_files(args.targets)
    if not files:
        print("ERROR: 没有可扫描的插件 JS 文件", file=sys.stderr)
        return 1

    total = 0
    for label, jsf in files:
        src = jsf.read_text(encoding="utf-8")
        cands, counts = scan_source(src, skip_fns)
        stripped = ", ".join("%s=%d" % (k, v) for k, v in counts.items())
        print("== %s ==" % label)
        print("   已剔除包装调用: %s" % (stripped or "（无）"))

        hits = []
        filtered = []
        seen = set()
        for ln, text, _kind in cands:
            found = visible_phrases(text)
            if found:
                for kind, phrase in found:
                    if (ln, phrase) not in seen:
                        seen.add((ln, phrase))
                        hits.append((ln, kind, phrase))
            elif text.strip():
                filtered.append((ln, " ".join(text.split())[:110]))

        if hits:
            print("   待复核英文（%d 条）：" % len(hits))
            for ln, kind, phrase in hits:
                print("   %5d  [%-4s] %s" % (ln, kind, phrase))
        else:
            print("   待复核英文：0 条")
        if args.show_all and filtered:
            print("   （已过滤 %d 条候选）" % len(filtered))
            for ln, text in filtered:
                print("   %5d  %s" % (ln, text))
        print()
        total += len(hits)

    print("合计待复核：%d 条" % total)
    return 1 if (args.strict and total) else 0


if __name__ == "__main__":
    sys.exit(main())
