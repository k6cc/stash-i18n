#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""同步/发版后的自检：语法、版本四处一致、身份隔离、i18n 残留统计。

用法：
  python scripts/sync-verify.py LockdownI18n
  python scripts/sync-verify.py LockdownI18n --js e:\Temp\sync\merged.js   # 发版前先校验合并产物

检查项：
  1. node --check 通过
  2. yml 可解析、version 与 JS PLUGIN_VERSION 一致
  3. 根 README 插手表、插件 README 头部 note 与上面两个一致
  4. 身份隔离：PLUGIN_ID / window.__<插件ID>Loaded 已改，且无上游原版 ID/守卫残留
  5. check_i18n.py 残留统计（仅供参考，退出码不受其影响）
"""
import argparse
import io
import os
import re
import subprocess
import sys

try:
    import yaml
except ImportError:
    yaml = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(path):
    with io.open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("plugin")
    ap.add_argument("--js", help="待校验的 JS（默认 <插件目录>/<插件ID>.js）")
    a = ap.parse_args()

    pid = a.plugin
    js_path = a.js or os.path.join(ROOT, pid, pid + ".js")
    yml_path = os.path.join(ROOT, pid, pid + ".yml")
    plugin_readme = os.path.join(ROOT, pid, "README.md")
    root_readme = os.path.join(ROOT, "README.md")

    fails, notes = [], []
    js = read(js_path) if os.path.exists(js_path) else ""
    if not js:
        fails.append("找不到 JS：%s" % js_path)

    # 1. 语法
    r = subprocess.run(["node", "--check", js_path], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode == 0:
        notes.append("node --check 通过")
    else:
        fails.append("node --check 失败：%s" % (r.stderr or r.stdout).strip().splitlines()[-1:])

    # 2. 版本
    js_ver = ""
    m = re.search(r"PLUGIN_VERSION\s*=\s*['\"]([^'\"]+)['\"]", js)
    if m:
        js_ver = m.group(1)
    else:
        fails.append("JS 里没有 PLUGIN_VERSION")

    yml_ver = ""
    if os.path.exists(yml_path):
        text = read(yml_path)
        if yaml:
            try:
                yml_ver = str(yaml.safe_load(text).get("version", ""))
            except Exception as e:
                fails.append("yml 解析失败：%s" % e)
        else:
            m = re.search(r"^version:\s*(\S+)", text, re.M)
            yml_ver = m.group(1).strip("'\"") if m else ""
    if not yml_ver:
        fails.append("yml 里没有 version")
    elif js_ver and yml_ver != js_ver:
        fails.append("版本不一致：JS %s / yml %s" % (js_ver, yml_ver))
    else:
        notes.append("JS/yml 版本一致：%s" % js_ver)

    # 3. README 两处
    if os.path.exists(root_readme):
        m = re.search(r"\|\s*\[%s\]\(\./%s/?\)\s*\|\s*([^|]+)\|" % (re.escape(pid), re.escape(pid)), read(root_readme))
        if not m:
            fails.append("根 README 插手表里没有 %s 行" % pid)
        elif js_ver and m.group(1).strip() != js_ver:
            fails.append("根 README 版本为 %s，应为 %s" % (m.group(1).strip(), js_ver))
        else:
            notes.append("根 README 版本一致")
    else:
        fails.append("找不到根 README")

    if os.path.exists(plugin_readme):
        m = re.search(r"^> v([0-9A-Za-z.\-]+)", read(plugin_readme), re.M)
        if not m:
            fails.append("插件 README 头部没有 `> v<版本>` note")
        elif js_ver and m.group(1) != js_ver:
            fails.append("插件 README note 版本为 %s，应为 %s" % (m.group(1), js_ver))
        else:
            notes.append("插件 README 版本一致")
    else:
        fails.append("找不到插件 README")

    # 4. 身份隔离
    base = pid[:-4] if pid.endswith("I18n") else pid   # LockdownI18n -> Lockdown
    if re.search(r"PLUGIN_ID\s*=\s*['\"]%s['\"]" % re.escape(pid), js):
        notes.append("PLUGIN_ID = %s" % pid)
    else:
        fails.append("PLUGIN_ID 不是 %s" % pid)
    if re.search(r"window\.__%sLoaded" % re.escape(pid), js):
        notes.append("全局守卫 __%sLoaded 已改名" % pid)
    else:
        fails.append("缺少 window.__%sLoaded 守卫" % pid)
    if base != pid:
        bad = []
        if re.search(r"PLUGIN_ID\s*=\s*['\"]%s['\"]" % re.escape(base), js):
            bad.append("PLUGIN_ID 残留为 %s" % base)
        if re.search(r"window\.__%sLoaded" % re.escape(base), js):
            bad.append("守卫残留 window.__%sLoaded" % base)
        if bad:
            fails.append("上游原版身份残留：" + "；".join(bad))
        else:
            notes.append("无 %s 原版 ID/守卫残留" % base)

    # 5. i18n 残留统计（信息项）
    check = os.path.join(ROOT, "scripts", "check_i18n.py")
    if os.path.exists(check):
        r = subprocess.run([sys.executable, check, js_path], cwd=ROOT, capture_output=True,
                           text=True, encoding="utf-8", errors="replace")
        out = r.stdout or ""
        m = re.search(r"待复核[（(]?英文?[）)]?[：:（(](\d+)", out) or re.search(r"合计待复核[：:](\d+)", out)
        if m:
            notes.append("check_i18n 待复核 %s 条（需逐条确认是否为有意保留）" % m.group(1))
        else:
            notes.append("check_i18n 无残留报告")

    for n in notes:
        print("[OK]   " + n)
    for f in fails:
        print("[FAIL] " + f)
    print("\n%s：%d 项通过，%d 项失败" % (pid, len(notes), len(fails)))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
