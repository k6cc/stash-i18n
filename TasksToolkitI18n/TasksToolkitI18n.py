"""Tasks Toolkit - the server part: what the server script reports.

Stash has no timer of its own. A routine set to run on the server is a
POSIX sh script the Tasks page writes (Unraid User Scripts or cron) that
calls Stash's GraphQL API with curl. At its start, after each step and at
its end the script calls this plugin's `note` operation, so the page can
say when the server was last heard from and how the run went, with no
browser open while it ran.

The notes are one JSON file, written atomically under a lock file:

    <Stash config dir>/plugin-data/TasksToolkitI18n/_server/notes.json

the folder Suite Data keeps every plugin's data in (the same `data_root`,
checked identical by scripts/check_shared.py). The leading underscore keeps
it out of Suite Data's keys: Suite Data lists only `<key>.json` files
directly in a plugin's folder, and its names never start with "_". The page
keeps its own data (routines, history, the runner) through Suite Data's
client; this file is the server script's log, nothing else writes it.

0.2.0, Auto tag on what is new (user: "can't auto tag only go through ones
that are not scanned yet? not the whole library?"): Stash's metadataAutoTag
takes `paths`. `autotag_paths` reads the scenes and galleries added since the
last Auto tag Tasks ran and gives their folders.
`autotag_run` does the same and starts the job itself, so the page and the
server script start it one way. The mark (`_server/autotag.json`, beside
the notes) moves only when that job is confirmed to have ended well:
`autotag_done` from the page, or the script's `note` for a step with that
job id.

0.3.0, Auto tag that ends (the user's live run went 9 hours): 0.2.x lifted
1,258 new scenes' folders to the three library folders, which is the whole
library, and asked for every name ("*"). Now the plan uses the new items'
own folders (lifted only inside a library folder, never to it; over
AT_MAX_FOLDERS several runs one after another; a library folder in the plan
is an error), reads every performer, studio and tag, keeps the ones whose
name occurs in the new paths by Stash's own rule (match_names) and starts
metadataAutoTag with those ids only. No name found: an ok step, no job.

0.4.0, Stash runs the routines by itself (the user's server routines never
ran: the User Scripts entry the old way needed was never set up): a
scheduler in the Stash container, started by `scheduler` (every Stash page
calls it once when it loads; it answers at once when the scheduler already
runs) and by the "Start scheduler" task. It is this file run as a daemon
(double fork, setsid, like IntifaceSync's backend): one per Stash (a lock
the kernel drops when it dies, and a PID file it checks before signalling),
awake every 30 s, reading the routines and guards from the same Suite Data
files the page writes (read only; it writes its own state, log and the
notes), running each routine set to run in Stash at its time with the steps
the old server script ran, and leaving the same notes. See the "Scheduler"
section below and MAINTENANCE §4.28 "0.4.0".

0.6.0, Autopilot (user: "when toggled on it will continue with its task
tree ... when I toggle it off it will pause the current task"): a switch the
page flips (`autopilot`), kept in _server/autopilot.json; while it is on the
scheduler works through AP_TREE one step at a time; off stops what may be
stopped and holds everything. See the "Autopilot" section below.

Modes (runPluginOperation args.mode): ping, notes, autotag_paths,
scheduler_status, autopilot_status (read); note, autotag_run, autotag_done,
scheduler, scheduler_stop, autopilot, autopilot_set (write). Standard library only, Python 3.6 or later; the
scheduler needs a Unix Stash (fork), as in Docker.
"""
import datetime
import http.client
import json
import logging
import logging.handlers
import os
import re
import select
import signal
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zlib

try:
    import fcntl
except ImportError:          # Windows: no scheduler there (it needs fork)
    fcntl = None

PLUGIN_ID = "TasksToolkitI18n"
PLUGIN_VERSION = "0.6.4-1"
EVENTS_MAX = 100          # the newest events kept, oldest dropped
STEPS_MAX = 40            # steps kept per run
RUNS_MAX = 50             # routines with a run on record
NAME_MAX = 60
TEXT_MAX = 300
EVENTS = ("start", "step", "done", "failed", "missed")
RESULTS = ("ok", "failed", "stopped", "skipped")
LOCK_WAIT_S = 10
LOCK_STALE_S = 30
AT_FIRST_DAYS = 7         # no Auto tag on record yet: what was added in the last week
AT_MAX_FOLDERS = 300      # folders per Auto tag (Stash ORs one path filter each); more: several runs
AT_MAX_ITEMS = 50000      # more new scenes and galleries than this: refused, never the whole library
AT_PAGE = 1000
CTRL_RX = re.compile(r"[\x00-\x1f\x7f]")


def answer(output=None, error=None):
    sys.stdout.write(json.dumps({"output": output, "error": error}))
    sys.stdout.flush()


def now_ms():
    return int(time.time() * 1000)


def data_root(conn):
    """<Stash config dir>/plugin-data. "Dir" is the folder holding Stash's
    config.yml; without it, the plugins folder's parent (PluginDir is
    <config>/plugins/SuiteData), the same place on a default install."""
    conn = conn or {}
    d = conn.get("Dir")
    if isinstance(d, str) and d and os.path.isabs(d) and os.path.isdir(d):
        return os.path.join(d, "plugin-data")
    pd = conn.get("PluginDir") or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(pd))), "plugin-data")


def notes_path(root):
    return os.path.join(root, PLUGIN_ID, "_server", "notes.json")


def clean(v, n):
    """A short single-line string: what the script sends is shown on the
    page, so control characters go and the length is capped."""
    if v is None:
        return ""
    return CTRL_RX.sub(" ", str(v)).strip()[:n]


def blank():
    return {"v": 1, "runs": {}, "events": []}


def read_notes(path):
    """The notes, or a blank set when there are none yet. A file that does
    not parse is an error, never "none": writing over it would lose it."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (IOError, OSError):
        return blank()
    except ValueError:
        raise RuntimeError("%s does not parse; fix or move it, nothing was changed" % os.path.basename(path))
    if not isinstance(data, dict) or not isinstance(data.get("runs"), dict) or not isinstance(data.get("events"), list):
        raise RuntimeError("%s is not Tasks Toolkit's notes; nothing was changed" % os.path.basename(path))
    return data


def write_atomic(path, text):
    d = os.path.dirname(path)
    if not os.path.isdir(d):
        os.makedirs(d)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    for i in range(20):
        try:
            os.replace(tmp, path)
            break
        except PermissionError:
            # Windows: a reader holding the file open for a moment
            if i == 19:
                raise
            time.sleep(0.05)


class Lock(object):
    """One writer at a time: a lock file created exclusively. One left
    behind by a killed process is taken over after LOCK_STALE_S."""

    def __init__(self, folder):
        self.folder = folder
        self.path = os.path.join(folder, ".lock")

    def __enter__(self):
        if not os.path.isdir(self.folder):
            os.makedirs(self.folder)
        deadline = time.time() + LOCK_WAIT_S
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode("ascii"))
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.path) > LOCK_STALE_S:
                        os.remove(self.path)
                        continue
                except OSError:
                    pass
                if time.time() > deadline:
                    raise RuntimeError("the notes are busy; try again")
                time.sleep(0.03)

    def __exit__(self, *exc):
        try:
            os.remove(self.path)
        except OSError:
            pass
        return False


def add_note(notes, args, now):
    """One event from the script into the notes (changed in place, also
    returned). A step or end without a start (the start note was lost)
    opens a run there, so nothing the script says is dropped."""
    routine = clean(args.get("routine"), NAME_MAX)
    if not routine:
        raise ValueError("a note needs the routine's name")
    event = clean(args.get("event"), 10)
    if event not in EVENTS:
        raise ValueError("unknown event %r" % event)
    result = clean(args.get("result"), 10)
    if result and result not in RESULTS:
        raise ValueError("unknown result %r" % result)
    step = clean(args.get("step"), NAME_MAX)
    text = clean(args.get("text"), TEXT_MAX)
    job = clean(args.get("job"), 20)
    # 0.4.0: the catalogue key of a step ("scan"), so the page's "last scan"
    # counts the scheduler's runs too; the old script did not send it
    k = clean(args.get("k"), 40)
    runs = notes["runs"]
    run = runs.get(routine)
    if event in ("start", "missed") or not isinstance(run, dict) or run.get("endedAt"):
        prev = None
        if isinstance(run, dict):
            # the run before stays readable while this one goes on; one that
            # never said it ended (the script was killed) is "unfinished"
            prev = run if run.get("endedAt") else dict(run, result="unfinished")
        run = {"startedAt": now, "endedAt": None, "result": "running", "steps": [], "text": "", "ok": 0, "failed": 0}
        if prev:
            run["prev"] = dict((k, v) for k, v in prev.items() if k != "prev")
        runs[routine] = run
    if event == "start":
        run["text"] = text
    elif event == "missed":
        # 0.4.0: the scheduler was not running at its time, and it is too
        # late to run it now: a run that is over as it opens
        run["endedAt"] = now
        run["result"] = "missed"
        run["text"] = text
    elif event == "step":
        st = {"name": step, "result": result or "ok", "at": now, "job": job, "text": text}
        if k:
            st["k"] = k
        run["steps"].append(st)
        run["steps"] = run["steps"][-STEPS_MAX:]
        if (result or "ok") == "ok":
            run["ok"] = run.get("ok", 0) + 1
        elif result in ("failed", "stopped"):
            run["failed"] = run.get("failed", 0) + 1
    else:
        run["endedAt"] = now
        run["result"] = "ok" if event == "done" else "failed"
        run["text"] = text
    notes["events"].append({"at": now, "routine": routine, "event": event, "step": step, "result": result, "text": text})
    notes["events"] = notes["events"][-EVENTS_MAX:]
    if len(runs) > RUNS_MAX:
        # the routines heard from longest ago go first
        old = sorted(runs, key=lambda k: (runs[k] or {}).get("startedAt") or 0)
        for k in old[:len(runs) - RUNS_MAX]:
            del runs[k]
    return notes


# ── Auto tag on what is new (0.2.0) ─────────────────────────────────────────

def stash_gql(conn):
    """A GraphQL call on the Stash that started us, with the session (or
    API key) it handed over. Returns fn(query, variables) -> data."""
    conn = conn or {}
    host = conn.get("Host") or "localhost"
    if host in ("0.0.0.0", "::", ""):
        host = "localhost"
    url = "%s://%s:%s/graphql" % (conn.get("Scheme") or "http", host, conn.get("Port") or 9999)
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    ck = conn.get("SessionCookie") or {}
    if ck.get("Value"):
        headers["Cookie"] = "%s=%s" % (ck.get("Name") or "session", ck["Value"])
    if conn.get("ApiKey"):
        headers["ApiKey"] = conn["ApiKey"]
    ctx = ssl.create_default_context()
    ctx.check_hostname = False           # Stash's own address, often a self-signed certificate
    ctx.verify_mode = ssl.CERT_NONE

    def q(query, variables=None):
        body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=120, context=ctx) as res:
            d = json.loads(res.read().decode("utf-8"))
        if d.get("errors"):
            raise GqlError(d["errors"][0].get("message") or "Stash error")
        return d.get("data") or {}
    return q


class GqlError(RuntimeError):
    """Stash answered and refused (a GraphQL error), as against not
    answering at all (0.4.0: the scheduler fails the step for the first and
    stops the run after three of the second)."""


def path_sep(paths):
    """The server's separator, from the paths themselves (Stash in Docker
    on Unraid: /; on Windows: a backslash)."""
    for p in paths:
        if "/" in p:
            return "/"
        if "\\" in p:
            return "\\"
    return "/"


def _top(p, sep):
    # the filesystem's top: "/" or "C:\"
    return p == sep or (sep == "\\" and len(p) == 3 and p[1] == ":")


def parent_dir(p, sep):
    if not _top(p, sep):
        p = p.rstrip(sep)
    i = p.rfind(sep)
    if i < 0:
        return ""
    if i == 0:
        return sep
    if sep == "\\" and i == 2 and p[1] == ":":
        return p[:3]
    return p[:i]


def _under(p, root, sep):
    return p == root or p.startswith(root if root.endswith(sep) else root + sep)


def _depth(p, sep):
    return len([x for x in p.split(sep) if x])


def _norm(d, sep):
    return d if _top(d, sep) else d.rstrip(sep)


def drop_nested(dirs, sep):
    """Unique folders, one inside another on the list left out (Auto tag
    takes everything under a path)."""
    out = []
    for d in sorted(set(dirs), key=lambda x: (_depth(x, sep), x)):
        if not any(_under(d, o, sep) for o in out):
            out.append(d)
    return sorted(out)


def _too_wide(d, roots, sep):
    """d is a library folder, or holds one: Auto tag there is the whole
    library (or more of it than anyone asked for)."""
    return _top(d, sep) or any(_under(r, d, sep) for r in roots)


def _root_of(d, roots, sep):
    """The library folder d is inside (the deepest one), or None."""
    inside = [r for r in roots if _under(d, r, sep)]
    return max(inside, key=lambda r: _depth(r, sep)) if inside else None


def plan_folders(dirs, roots, max_n, sep):
    """(folders, chunks), 0.3.0. The new items' own folders. Over max_n, the
    deepest are lifted to their parent, but only inside a library folder and
    never up to it (0.2.x lifted the user's 1,258 new scenes to their three
    library folders: the whole library, 9 hours). Still over max_n: several
    Auto tags of at most max_n folders each, run one after another. A
    library folder (or one above it) in the list is refused, never run."""
    roots = [_norm(r, sep) for r in (roots or []) if r]
    cur = drop_nested([_norm(d, sep) for d in dirs if d], sep)
    wide = [d for d in cur if _too_wide(d, roots, sep)]
    if wide:
        raise RuntimeError("Auto tag's plan reached a library folder (%s), which is the whole library; nothing was started" % wide[0])

    def liftable(d):
        r = _root_of(d, roots, sep)
        if r is None:
            return False
        par = parent_dir(d, sep)
        return bool(par) and par != r and _under(par, r, sep)
    while len(cur) > max_n:
        can = [d for d in cur if liftable(d)]
        if not can:
            break
        deep = max(_depth(d, sep) for d in can)
        cur = drop_nested([parent_dir(d, sep) if (d in can and _depth(d, sep) == deep) else d for d in cur], sep)
    return cur, [cur[i:i + max_n] for i in range(0, len(cur), max_n)]


# ── Which names to look for (0.3.0) ─────────────────────────────────────────
# Stash's Auto tag with "*" goes through every file and looks up candidate
# names for each; with ids it goes name by name over the paths. Either way the
# time is in the names: Tasks finds the ones that occur in the new paths with
# Stash's own rule and asks Stash for those only. The rule, from Stash's
# pkg/match/path.go (nameToRegexp, regexpMatchesPath):
#   - the name lower-cased and regex-escaped, each space replaced by
#     [.\-_ ]* (so "Jane Doe" finds jane.doe, jane_doe, jane-doe, janedoe);
#   - before and after it the start or end of the path, "_" or a character
#     that is not a letter or digit (Go's [^\w\d], ASCII; [^\p{L}\w\d] when
#     the path has non-ASCII characters);
#   - against the lower-cased whole path (folders, file name, extension).
# Performers: the name only (pkg/match and internal/autotag have alias
# matching commented out). Studios and tags: the name and every alias.
# ignore_auto_tag skips it. No rule on short or single-word names.
AT_SEP_CLASS = "[.\\-_ ]*"


def name_rx(name, uni=False):
    body = AT_SEP_CLASS.join(re.escape(w) for w in name.lower().split(" "))
    return re.compile(r"(?:^|_|[^\w])%s(?:$|_|[^\w])" % body, 0 if uni else re.ASCII)


def _is_ascii(s):
    return all(ord(c) < 128 for c in s)


def match_names(names, paths):
    """{kind: [ids]} of the names that occur in any of the paths. names:
    {kind: [(id, [name, alias...])]}. A match starts right after a
    boundary, so the paths are indexed by the two characters found there;
    a name is looked for only in the paths holding its first two (Stash
    pre-selects by two characters the same way; thousands of names over a
    thousand paths took 17 s without it). The paths looked in go into one
    text per regex flavour, a newline between them (not a separator, and a
    boundary, so a match never runs from one path into the next)."""
    low = [p.lower() for p in paths if p]
    by_head = {}
    for i, p in enumerate(low):
        for h in set(re.findall(r"(?<![a-z0-9])(?=(..))", p, re.S)):
            by_head.setdefault(h, []).append(i)
    texts = {}

    def text(key, idx):
        if key not in texts:
            sel = [low[i] for i in idx]
            texts[key] = {False: "\n".join(p for p in sel if _is_ascii(p)), True: "\n".join(p for p in sel if not _is_ascii(p))}
        return texts[key]
    out = {}
    for kind in ("performers", "studios", "tags"):
        hit = []
        for nid, words in (names or {}).get(kind) or []:
            for w in words:
                if not w or not w.strip():
                    continue
                head = w.lower()[:2]
                if len(head) == 2 and " " not in head:
                    if head not in by_head:
                        continue
                    blobs = text(head, by_head[head])
                else:
                    blobs = text("", range(len(low)))
                # the name's first word must be there as it is (a plain
                # substring test is far quicker than the regex)
                lead = w.lower().split(" ")[0] or w.lower().strip().split(" ")[0]
                if any(blobs[u] and lead in blobs[u] and name_rx(w, u).search(blobs[u]) for u in (False, True)):
                    hit.append(str(nid))
                    break
        out[kind] = hit
    return out


def item_dirs(scene_files, gallery_paths, roots, sep):
    """(dirs, paths, loose): the folder to give Auto tag for each new item
    and the paths its names are looked for in. Stash's path filter is
    "<folder>/%", so a scene is found through its file's folder and a
    gallery (folder or zip) through the folder holding it; a folder gallery
    straight in a library folder is given as itself (its pictures are
    tagged, the gallery is not). An item straight in a library folder
    otherwise cannot be reached without the whole library: left out
    (`loose`)."""
    roots = [_norm(r, sep) for r in (roots or []) if r]
    dirs, paths, loose = [], [], 0
    for p in scene_files:
        d = parent_dir(p, sep)
        if not d or _too_wide(d, roots, sep):
            loose += 1
            continue
        dirs.append(d)
        paths.append(p)
    for p in gallery_paths:
        d = parent_dir(p, sep)
        if d and not _too_wide(d, roots, sep):
            dirs.append(d)
        elif not re.search(r"\.(zip|cbz)$", p, re.I) and not _too_wide(_norm(p, sep), roots, sep):
            dirs.append(_norm(p, sep))
        else:
            loose += 1
            continue
        paths.append(p)
    return dirs, paths, loose


def autotag_plan(scene_files, gallery_paths, roots, since, first, total=None, names=None, organized=0):
    """What Auto tag should go through, pure. scene_files: the file paths of
    the new scenes Auto tag looks at (not organized; Stash skips those);
    gallery_paths: the galleries' (a folder gallery's folder, a zip's file).
    total: the counts of everything new; more than could be read is an
    error (never the whole library by itself). names: every performer,
    studio and tag Auto tag may use (see match_names)."""
    scene_files, gallery_paths = list(scene_files), list(gallery_paths)
    total = total or {"scenes": len(scene_files) + organized, "galleries": len(gallery_paths)}
    out = {"since": int(since), "first": bool(first), "scenes": int(total.get("scenes", 0)), "galleries": int(total.get("galleries", 0)),
           "organized": int(organized), "loose": 0, "folders": 0, "paths": [], "chunks": [], "parts": 0,
           "performers": 0, "studios": 0, "tags": 0, "ids": {"performers": [], "studios": [], "tags": []}, "error": ""}
    if not out["scenes"] and not out["galleries"]:
        return out
    if out["scenes"] + out["galleries"] > AT_MAX_ITEMS or out["scenes"] + out["galleries"] > len(scene_files) + len(gallery_paths) + organized:
        out["error"] = ("more than %s scenes and galleries are new; Tasks does not send the whole library by itself "
                        "(run Auto tag from Stash's Settings > Tasks for that)" % "{:,}".format(AT_MAX_ITEMS))
        return out
    sep = path_sep(scene_files + gallery_paths + list(roots or []))
    dirs, paths, loose = item_dirs(scene_files, gallery_paths, roots, sep)
    out["loose"] = loose
    try:
        folders, chunks = plan_folders(dirs, roots, AT_MAX_FOLDERS, sep)
    except RuntimeError as e:
        out["error"] = str(e)
        return out
    ids = match_names(names, paths) if folders else {"performers": [], "studios": [], "tags": []}
    out.update(paths=folders, folders=len(folders), chunks=chunks, parts=len(chunks), ids=ids,
               performers=len(ids["performers"]), studios=len(ids["studios"]), tags=len(ids["tags"]))
    return out


def _n(n, one, many=None):
    return "%s %s" % ("{:,}".format(n), one if n == 1 else (many or one + "s"))


def autotag_label(plan):
    """The server's words for the step: "1,258 scenes added in the last 7
    days · 37 performers, 4 studios, 12 tags to look for"."""
    parts = []
    if plan["scenes"]:
        parts.append(_n(plan["scenes"], "scene"))
    if plan["galleries"]:
        parts.append(_n(plan["galleries"], "gallery", "galleries"))
    if not parts:
        return "nothing added since the last Auto tag"
    when = "in the last %d days" % AT_FIRST_DAYS if plan["first"] else "since " + time.strftime("%d %b", time.localtime(plan["since"] / 1000.0)).lstrip("0")
    s = "%s added %s" % (" and ".join(parts), when)
    if plan.get("error"):
        return "%s · %s" % (s, plan["error"])
    if not plan.get("folders"):
        s += " · none in a folder Auto tag can be given on its own"
    elif not (plan.get("performers") or plan.get("studios") or plan.get("tags")):
        s += " · no performer, studio or tag names in their paths"
    else:
        s += " · %s, %s, %s to look for" % (_n(plan["performers"], "performer"), _n(plan["studios"], "studio"), _n(plan["tags"], "tag"))
        if plan.get("parts", 0) > 1:
            s += " · in %d runs of up to %d folders" % (plan["parts"], AT_MAX_FOLDERS)
    if plan.get("loose"):
        s += " · %s straight in a library folder left out" % _n(plan["loose"], "item")
    return s


def autotag_state_path(root):
    return os.path.join(root, PLUGIN_ID, "_server", "autotag.json")


def read_autotag(path):
    """The mark: { at (ms, the last confirmed Auto tag read up to), pending
    { job, upto, and for a split one: rest (the folders still to go), ids,
    ok (this part ended well), part, parts, label } }. A file that does not
    parse is refused."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (IOError, OSError):
        return {"v": 1, "at": 0, "pending": None}
    except ValueError:
        raise RuntimeError("%s does not parse; fix or move it, nothing was changed" % os.path.basename(path))
    if not isinstance(data, dict):
        raise RuntimeError("%s is not Tasks Toolkit's Auto tag mark; nothing was changed" % os.path.basename(path))
    data.setdefault("at", 0)
    data.setdefault("pending", None)
    return data


def autotag_since(state, now):
    """(since, first): the last confirmed Auto tag, else the last week. Not
    "since the last scan": the scenes the last scan added are the ones Auto
    tag has to see."""
    at = int(state.get("at") or 0)
    if at > 0:
        return at, False
    return now - AT_FIRST_DAYS * 86400000, True


def iso_utc(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000.0))


# created_at takes a String, not a Timestamp variable (0.1.1)
AT_SCENES_Q = """query ($since: String!, $page: Int!, $per: Int!) {
  findScenes(filter: { per_page: $per, page: $page, sort: "created_at", direction: ASC },
    scene_filter: { created_at: { value: $since, modifier: GREATER_THAN } }) { count scenes { organized files { path } } } }"""
AT_GALLERIES_Q = """query ($since: String!, $page: Int!, $per: Int!) {
  findGalleries(filter: { per_page: $per, page: $page, sort: "created_at", direction: ASC },
    gallery_filter: { created_at: { value: $since, modifier: GREATER_THAN } }) { count galleries { organized folder { path } files { path } } } }"""
AT_ROOTS_Q = "{ configuration { general { stashes { path } } } }"
# 0.3.0: every name Auto tag may use, one query each (a few thousand rows)
AT_NAMES_Q = (
    ("performers", "findPerformers", "{ findPerformers(filter: { per_page: -1 }) { performers { id name ignore_auto_tag } } }"),
    ("studios", "findStudios", "{ findStudios(filter: { per_page: -1 }) { studios { id name aliases ignore_auto_tag } } }"),
    ("tags", "findTags", "{ findTags(filter: { per_page: -1 }) { tags { id name aliases ignore_auto_tag } } }"),
)
AT_RUN_Q = "mutation ($i: AutoTagMetadataInput!) { metadataAutoTag(input: $i) }"


def read_new(q, since):
    """The paths of the scenes and galleries added after `since` (ms) that
    are not organized (Stash's Auto tag skips those), at most AT_MAX_ITEMS
    of each read; the counts of everything new; how many were organized;
    the library folders."""
    iso = iso_utc(since)
    found = {"scenes": [], "galleries": []}
    total = {"scenes": 0, "galleries": 0}
    organized = 0
    for kind, query, key in (("scenes", AT_SCENES_Q, "findScenes"), ("galleries", AT_GALLERIES_Q, "findGalleries")):
        page = 1
        while True:
            d = (q(query, {"since": iso, "page": page, "per": AT_PAGE}) or {}).get(key) or {}
            total[kind] = int(d.get("count") or 0)
            rows = d.get(kind) or []
            for r in rows:
                if r.get("organized"):
                    organized += 1
                    continue
                p = (r.get("folder") or {}).get("path") if kind == "galleries" else None
                if not p:
                    p = next((f.get("path") for f in (r.get("files") or []) if f.get("path")), None)
                if p:
                    found[kind].append(p)
            if len(rows) < AT_PAGE or total[kind] > AT_MAX_ITEMS or page * AT_PAGE >= total[kind]:
                break
            page += 1
    gen = ((q(AT_ROOTS_Q) or {}).get("configuration") or {}).get("general") or {}
    roots = [s.get("path") for s in (gen.get("stashes") or []) if s.get("path")]
    return found["scenes"], found["galleries"], total, roots, organized


def read_names(q):
    """{kind: [(id, [name, alias...])]}: what Auto tag may use. Performers
    by name only (Stash does not match their aliases); ignore_auto_tag left
    out."""
    out = {}
    for kind, key, query in AT_NAMES_Q:
        lst = []
        for r in ((q(query) or {}).get(key) or {}).get(kind) or []:
            if r.get("ignore_auto_tag") or r.get("id") is None:
                continue
            words = [r.get("name") or ""] + ([] if kind == "performers" else list(r.get("aliases") or []))
            lst.append((str(r["id"]), [w for w in words if isinstance(w, str) and w.strip()]))
        out[kind] = lst
    return out


def autotag_plan_now(q, root, now):
    state = read_autotag(autotag_state_path(root))
    since, first = autotag_since(state, now)
    sc, ga, total, roots, org = read_new(q, since)
    names = read_names(q) if (sc or ga) else {}
    plan = autotag_plan(sc, ga, roots, since, first, total, names, org)
    plan["upto"] = now
    plan["label"] = autotag_label(plan)
    plan["pending"] = bool(state.get("pending"))
    return plan


# 0.3.0: the Overview's plan is kept for AT_CACHE_MS (the user's Stash was
# overloaded before; the plan reads every name with per_page -1). One cheap
# query (counts and the newest created_at, a row each) says whether it still
# holds: anything new since, or a performer, studio or tag added or removed,
# and it is planned again. autotag_run always plans afresh.
AT_CACHE_MS = 30 * 60000
AT_PROBE_Q = """query ($since: String!) {
  s: findScenes(filter: { per_page: 1, sort: "created_at", direction: DESC },
    scene_filter: { created_at: { value: $since, modifier: GREATER_THAN } }) { count scenes { created_at } }
  g: findGalleries(filter: { per_page: 1, sort: "created_at", direction: DESC },
    gallery_filter: { created_at: { value: $since, modifier: GREATER_THAN } }) { count galleries { created_at } }
  p: findPerformers(filter: { per_page: 1 }) { count }
  st: findStudios(filter: { per_page: 1 }) { count }
  t: findTags(filter: { per_page: 1 }) { count }
}"""


def autotag_cache_path(root):
    return os.path.join(root, PLUGIN_ID, "_server", "autotag_plan.json")


def autotag_probe(q, since):
    """What the cached plan depends on: the mark it was read from, the new
    items' counts and newest created_at, how many names there are."""
    d = q(AT_PROBE_Q, {"since": iso_utc(since)}) or {}

    def newest(x, kind):
        rows = (x or {}).get(kind) or []
        return str((rows[0] or {}).get("created_at") or "") if rows else ""
    return {"since": int(since), "scenes": int((d.get("s") or {}).get("count") or 0), "galleries": int((d.get("g") or {}).get("count") or 0),
            "newScene": newest(d.get("s"), "scenes"), "newGallery": newest(d.get("g"), "galleries"),
            "performers": int((d.get("p") or {}).get("count") or 0), "studios": int((d.get("st") or {}).get("count") or 0),
            "tags": int((d.get("t") or {}).get("count") or 0)}


def read_cache(path):
    # a cache that does not parse is only a cache: planned again
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (IOError, OSError, ValueError):
        return {}


def autotag_paths(q, root, now, refresh=False):
    """What Auto tag would go through now (the counts and the folders; the
    ids and the parts stay on the server). Reads only from Stash; keeps the
    plan in _server/autotag_plan.json for AT_CACHE_MS while the probe says
    nothing changed. refresh: the page's Refresh, planned again."""
    state = read_autotag(autotag_state_path(root))
    since, first = autotag_since(state, now)
    # keyed by the mark, not by `since`: with no mark yet since is "a week
    # ago", which moves every millisecond
    key = dict(autotag_probe(q, since), since=int(state.get("at") or 0))
    cpath = autotag_cache_path(root)
    c = read_cache(cpath)
    if not refresh and c.get("key") == key and isinstance(c.get("plan"), dict) and 0 <= now - int(c.get("at") or 0) < AT_CACHE_MS:
        out = dict(c["plan"])
        out.update(pending=bool(state.get("pending")), cached=True, plannedAt=int(c["at"]))
        return out
    plan = autotag_plan_now(q, root, now)
    out = dict((k, v) for k, v in plan.items() if k not in ("ids", "chunks"))
    try:
        write_atomic(cpath, json.dumps({"v": 1, "at": now, "key": key, "plan": out}))
    except (IOError, OSError):
        pass
    out.update(cached=False, plannedAt=now)
    return out


def autotag_input(ids, paths):
    """Only the names found, never "*" (with "*" Stash goes through every
    name for every file), and always the folders: no paths would be the
    whole library."""
    if not paths:
        raise RuntimeError("Auto tag without folders would be the whole library; nothing was started")
    return {"paths": list(paths), "performers": list(ids.get("performers") or []), "studios": list(ids.get("studios") or []), "tags": list(ids.get("tags") or [])}


AT_OUT = ("first", "folders", "galleries", "label", "scenes", "since", "upto", "performers", "studios", "tags", "parts", "loose", "organized")


def autotag_run(q, root, now):
    """Start Auto tag on what is new, for the names found in it. In the
    answer `job` is the only value that is a string of digits (the server
    script reads the first one); `more` says another part follows (the
    runner and the script call this again once this job ended well).
    Nothing new, or no name in the new paths: no job, and the mark moves to
    now (nothing was left out)."""
    path = autotag_state_path(root)
    st = read_autotag(path)
    p = st.get("pending")
    if isinstance(p, dict) and p.get("ok") and p.get("rest"):
        # the next part of a split Auto tag, planned when the first started
        rest = p["rest"]
        d = q(AT_RUN_Q, {"i": autotag_input(p.get("ids") or {}, rest[0])}) or {}
        job = str(d.get("metadataAutoTag") or "")
        part = int(p.get("part") or 1) + 1
        with Lock(os.path.dirname(path)):
            st = read_autotag(path)
            st["pending"] = dict(p, job=job, rest=rest[1:], ok=False, part=part)
            write_atomic(path, json.dumps(st))
        parts = int(p.get("parts") or part)
        return {"job": job, "nothing": False, "more": len(rest) > 1, "part": part, "parts": parts,
                "label": "%s · part %d of %d" % (p.get("label") or "Auto tag", part, parts)}
    plan = autotag_plan_now(q, root, now)
    if plan.get("error"):
        raise RuntimeError("Auto tag: " + plan["error"])
    out = dict((k, plan[k]) for k in AT_OUT)
    ids = plan["ids"]
    if not plan["chunks"] or not (ids["performers"] or ids["studios"] or ids["tags"]):
        with Lock(os.path.dirname(path)):
            st = read_autotag(path)
            st["at"] = max(int(st.get("at") or 0), now)
            st["pending"] = None
            write_atomic(path, json.dumps(st))
        out.update(job="", nothing=True, more=False, part=0)
        return out
    chunks = plan["chunks"]
    d = q(AT_RUN_Q, {"i": autotag_input(ids, chunks[0])}) or {}
    job = str(d.get("metadataAutoTag") or "")
    with Lock(os.path.dirname(path)):
        st = read_autotag(path)
        st["pending"] = {"job": job, "upto": now, "rest": chunks[1:], "ids": ids, "ok": False, "part": 1,
                         "parts": len(chunks), "label": plan["label"]}
        write_atomic(path, json.dumps(st))
    if len(chunks) > 1:
        out["label"] = "%s · part 1 of %d" % (plan["label"], len(chunks))
    out.update(job=job, nothing=False, more=len(chunks) > 1, part=1)
    return out


def confirm_autotag(st, job):
    """The pending Auto tag ended well. Only for that job (another job
    ending says nothing). A part with more to go is marked ok (the next
    autotag_run starts the next part); the mark moves to when the folders
    were read only after the last part."""
    p = st.get("pending")
    if not isinstance(p, dict) or not job or not p.get("job") or str(p.get("job")) != str(job):
        return False
    if p.get("rest"):
        p["ok"] = True
        return True
    st["at"] = max(int(st.get("at") or 0), int(p.get("upto") or 0))
    st["pending"] = None
    return True


def autotag_done(root, job):
    path = autotag_state_path(root)
    with Lock(os.path.dirname(path)):
        st = read_autotag(path)
        ok = confirm_autotag(st, job)
        if ok:
            write_atomic(path, json.dumps(st))
    p = st.get("pending")
    return {"ok": ok, "at": st.get("at") or 0, "more": bool(ok and isinstance(p, dict) and p.get("rest"))}


# ── Scheduler (0.4.0) ───────────────────────────────────────────────────────
# User: the routines set to run on the server never ran at night (the User
# Scripts entry the old way needed was never set up), "it should be
# automatic, no manual setup". Stash has no timer and no start-up hook for
# plugins, so Tasks starts its own: this file, run as a daemon in the Stash
# container. `scheduler` starts it (or answers that it runs); every Stash
# page calls it once when it loads, so after a container restart the first
# page opened starts it again (the one limitation; an hourly call from cron
# is the optional fallback the page offers).
#
# One per Stash. The guard is an exclusive flock on a file in the temporary
# folder (the kernel drops it when the daemon dies, so a lock left over from
# before a restart never blocks a start, the trap IntifaceSync's PID file
# fell into); `scheduler` takes it before forking and the daemon keeps it.
# Beside the notes, _server/scheduler.pid names the daemon (pid, its start
# time in /proc, version); nothing is signalled unless /proc shows that pid
# is this script and started then.
#
# Every SCHED_POLL_S it reads the routines and guards from the same Suite
# Data files the page writes (the plugin config when Suite Data is off),
# never writing them, and runs a routine set to run in Stash (`where:
# "server"`) whose time came, its steps as the old server script ran them:
# an empty Stash queue before each step, Stash's own job, its end read from
# findJob, Auto tag part after part, the toolkits' scan tasks, the safe
# Identify; three unanswered asks in a row stop the run. It writes the same
# notes as the script did, so the page's "last heard" and History need
# nothing new. Its own state is _server/scheduler.json, its log
# _server/scheduler.log (rotated).

# taken at import: the daemon changes its folder to / before it looks again
THIS_FILE = os.path.abspath(__file__)
SCHED_POLL_S = 30
SCHED_MISSED_MS = 6 * 3600000        # later than this: not run, noted "missed"
SCHED_CHECK_S = 300                  # how often it asks Stash whether the plugin is still on
SCHED_IDLE_MAX_S = 12 * 3600         # an empty queue waited for at most this long
SCHED_JOB_MAX_S = 48 * 3600          # a job followed at most this long
SCHED_MISS_MAX = 3                   # unanswered asks in a row that stop a run
SCHED_AT_PARTS = 50                  # Auto tag parts in one step, as the script
SCHED_LOG_MAX = 256 * 1024
SCHED_COMM = "tt-scheduler"          # the daemon's name in /proc/<pid>/comm
SCHED_MARKER = "TasksToolkitI18n.py"     # ...and what its command line holds
LIVE_DONE = ("FINISHED", "FAILED", "CANCELLED")

# The catalogue, as the page's CAT (scripts/test_taskstoolkit.js compares
# every name, mutation and input with the page's; the page sends the same).
Q_SCAN = "mutation ($i: ScanMetadataInput!) { metadataScan(input: $i) }"
Q_GENERATE = "mutation ($i: GenerateMetadataInput!) { metadataGenerate(input: $i) }"
Q_IDENTIFY = "mutation ($i: IdentifyMetadataInput!) { metadataIdentify(input: $i) }"
Q_CLEANGEN = "mutation ($i: CleanGeneratedInput!) { metadataCleanGenerated(input: $i) }"
Q_OPTIMISE = "mutation { optimiseDatabase }"
Q_BACKUPDB = "mutation ($i: BackupDatabaseInput!) { backupDatabase(input: $i) }"
Q_TASK = "mutation ($p: ID!, $t: String!) { runPluginTask(plugin_id: $p, task_name: $t) }"
Q_KITSCAN = "mutation ($p: ID!, $t: String!, $a: Map) { runPluginTask(plugin_id: $p, task_name: $t, args_map: $a) }"
Q_QUEUE = "{ jobQueue { id status description } }"
Q_JOB = "query ($id: ID!) { findJob(input: { id: $id }) { id status error } }"
Q_PLUGINS = "{ plugins { id version enabled } }"
Q_CONFIG = "{ configuration { plugins } }"
Q_BOXES = "{ configuration { general { stashBoxes { endpoint } } } }"
Q_ID_DEFAULTS = """{ configuration { defaults { identify { sources { source { stash_box_endpoint scraper_id } }
    options { setCoverImage setOrganized includeMalePerformers skipMultipleMatches fieldOptions { field strategy createMissing } } } } } }"""
Q_ID_SCENES = "query ($f: SceneFilterType) { findScenes(filter: { per_page: -1 }, scene_filter: $f) { scenes { id } } }"
ID_FILTER = {"is_missing": "stash_id", "NOT": {"is_missing": "phash"}}
ID_FIELDS = ("title", "code", "details", "director", "urls", "date", "studio", "performers", "tags", "stash_ids")
# [id, name, task, the version that plans its scan on the server], as the page's KITS
KITS = (
    ("PerformersToolkit", "Performers Toolkit", "Scan performers", "0.18.0"),
    ("SceneToolkit", "Scenes Toolkit", "Scan scenes", "0.10.0"),
    ("StudiosToolkit", "Studios Toolkit", "Scan studios", "0.4.0"),
    ("TagAtlas", "Tags Toolkit", "Scan tags", "1.7.0"),
    ("GalleriesToolkit", "Galleries Toolkit", "Scan galleries", "0.6.0"),
    ("Movies", "Movies Toolkit", "Scan for movies", "1.6.0"),
    ("MarkersToolkit", "Markers Toolkit", "Scan markers", "0.1.0"),
    ("ArchiveToolkit", "Archive Toolkit", "Scan archive", "0.1.0"),
)
# 0.5.0: a toolkit's second read-only step, as the page's KIT_STEPS:
# [key, plugin, name, task, args, the version that has it]. Planned on the
# server only. Scenes Toolkit 0.14.0's "Find updated scenes" reads (applying
# what it finds writes, so that stays on its page).
KIT_STEPS = (
    ("SceneToolkitUpdates", "SceneToolkit", "Scenes Toolkit: find updated scenes", "Find updated scenes", {"mode": "update"}, "0.14.0"),
)
# 0.6.0: Autopilot's own steps, as the page's AP_STEPS: [key, plugin, name,
# task, args, the version that has it]. Not in the safe catalogue: they
# write, so no routine and no "Do the safe ones" offers them. Archive
# Toolkit 0.2.3's select "auto" is its clean Ready rows with copies to
# another mount allowed (hashed before and after, within its GB cap); the
# run id lets the switch stop it between scenes, never mid-move.
AP_STEPS = (
    ("archive", "ArchiveToolkit", "Archive Toolkit: archive Ready scenes", "Archive ready scenes", {"mode": "archive", "select": "auto"}, "0.2.3"),
)
STEPS = {
    "scan": {"name": "Scan new files", "q": Q_SCAN, "i": {"rescan": False, "scanGenerateCovers": True, "scanGeneratePhashes": True}, "heavy": True},
    "genfast": {"name": "Generate covers and phashes", "q": Q_GENERATE, "i": {"covers": True, "phashes": True, "overwrite": False}, "heavy": True},
    "identify": {"name": "Identify, empty fields only", "q": Q_IDENTIFY, "special": "identify", "heavy": True},
    "autotag": {"name": "Auto tag", "special": "autotag", "heavy": False},
    "previews": {"name": "Generate previews and sprites", "q": Q_GENERATE, "i": {"previews": True, "sprites": True, "overwrite": False}, "heavy": True},
    "cleangen": {"name": "Clean generated files", "q": Q_CLEANGEN, "heavy": False,
                 "i": {"blobFiles": True, "sprites": True, "screenshots": True, "transcodes": True, "markers": True, "imageThumbnails": True, "dryRun": False}},
    "optimise": {"name": "Optimise database", "q": Q_OPTIMISE, "heavy": True},
    "backupdb": {"name": "Back up Stash's database", "q": Q_BACKUPDB, "i": {"download": False}, "heavy": False, "sync": True},
    "sdbackup": {"name": "Suite Data backup", "q": Q_TASK, "plugin": "SuiteData", "task": "Backup now", "heavy": False},
}


def step_def(k):
    """The step for a catalogue key, or None (as the page's catOf)."""
    if k in STEPS:
        return STEPS[k]
    m = re.match(r"^ap:(\w+)$", str(k or ""))
    ap = m and next((x for x in AP_STEPS if x[0] == m.group(1)), None)
    if ap:
        return {"name": ap[2], "q": Q_KITSCAN, "plugin": ap[1], "task": ap[3], "args": dict(ap[4]), "min": ap[5], "kit": ap[1], "heavy": False, "only": True,
                "writes": True, "runid": True}
    if m:
        return None
    m = re.match(r"^kit:(\w+)$", str(k or ""))
    kit = m and next((x for x in KITS if x[0] == m.group(1)), None)
    if not kit:
        ks = m and next((x for x in KIT_STEPS if x[0] == m.group(1)), None)
        if ks:
            return {"name": ks[2], "q": Q_KITSCAN, "plugin": ks[1], "task": ks[3], "args": dict(ks[4]), "min": ks[5], "kit": ks[1], "heavy": False, "only": True}
        return None
    return {"name": "%s scan" % kit[1], "q": Q_KITSCAN, "plugin": kit[0], "task": kit[2], "args": {"mode": "scan"}, "min": kit[3], "kit": kit[0], "heavy": False}


def step_vars(d):
    """The variables the step's mutation is sent with (None: none)."""
    if d.get("kit"):
        return {"p": d["plugin"], "t": d["task"], "a": d["args"]}
    if d.get("plugin"):
        return {"p": d["plugin"], "t": d["task"]}
    if "i" in d:
        return {"i": d["i"]}
    return None


def steps_table():
    """Every step's name, mutation and variables (the page's test compares)."""
    out = {}
    for k in list(STEPS) + ["kit:" + x[0] for x in KITS] + ["kit:" + x[0] for x in KIT_STEPS] + ["ap:" + x[0] for x in AP_STEPS]:
        d = step_def(k)
        out[k] = {"name": d["name"], "q": d.get("q", ""), "vars": step_vars(d), "special": d.get("special", ""), "heavy": bool(d.get("heavy")), "min": d.get("min", "")}
    return out


def ver_at_least(v, mn):
    a = [int(x) if x.isdigit() else 0 for x in re.split(r"[.-]", str(v or ""))]
    b = [int(x) if x.isdigit() else 0 for x in str(mn).split(".")]
    for i in range(3):
        x, y = (a[i] if i < len(a) else 0), (b[i] if i < len(b) else 0)
        if x != y:
            return x > y
    return True


def sh_safe(s, n=60):
    """The page's shSafe: the routine names the notes are kept under."""
    return re.sub(r"[^A-Za-z0-9 ._()+,-]", "", str(s or "")).strip()[:n]


def safe_identify_input(endpoints, ids, defaults):
    """The page's safeIdentifyInput: stash-box fingerprints only, every field
    MERGE with nothing created, no cover, organized left alone."""
    o = (defaults or {}).get("options") or {}
    return {
        "sources": [{"source": {"stash_box_endpoint": e}} for e in (endpoints or [])],
        "options": {
            "fieldOptions": [{"field": f, "strategy": "MERGE", "createMissing": False} for f in ID_FIELDS],
            "setCoverImage": False, "setOrganized": False, "skipMultipleMatches": True, "skipSingleNamePerformers": True,
            "includeMalePerformers": False if o.get("includeMalePerformers") is False else True,
        },
        "sceneIDs": [str(x) for x in (ids or [])],
    }


def id_endpoints(defaults, boxes):
    """The page's idEndpoints: the stash-boxes the user's own Identify uses,
    else every one set up."""
    known = [b.get("endpoint") for b in (boxes or []) if b and b.get("endpoint")]
    mine = [((s or {}).get("source") or {}).get("stash_box_endpoint") for s in ((defaults or {}).get("sources") or [])]
    mine = [e for e in mine if e and e in known]
    out = []
    for e in (mine or known):
        if e not in out:
            out.append(e)
    return out


# ── The routines, as the page keeps them ────────────────────────────────────

GUARDS = {"maxQueue": 3, "oneHeavy": True, "holdPlay": True, "night": False, "from": 1, "to": 8}


def parse_hm(s):
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(s or "").strip())
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        return None
    return int(m.group(1)), int(m.group(2))


def _num(v, d=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return d


def norm_routine(r):
    """The page's normRoutine, for reading (nothing here is written back)."""
    s = r.get("sched") if isinstance(r.get("sched"), dict) else {}
    freq = s.get("freq") if s.get("freq") in ("daily", "weekly", "monthly", "hand") else "hand"
    return dict(r, id=str(r.get("id") or ""), name=str(r.get("name") or "Routine"),
                steps=[str(x) for x in r.get("steps")] if isinstance(r.get("steps"), list) else [],
                sched=dict(s, freq=freq, time=s.get("time") if parse_hm(s.get("time")) else "02:00", dow=max(0, min(6, _num(s.get("dow"))))),
                where="server" if r.get("where") == "server" else "browser",
                on=r.get("on") is not False, idle=r.get("idle") is not False, onFail="continue" if r.get("onFail") == "continue" else "stop")


def _json_value(raw, what):
    """A data key's value: JSON text (what the page writes) or already
    parsed. One that does not parse is an error, never "none"."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            raise RuntimeError("Tasks Toolkit's %s does not parse; the scheduler waits until it does" % what)
    return raw


def store_value(root, key):
    """(found, value) of Tasks Toolkit's data key in Suite Data's files."""
    path = os.path.join(root, PLUGIN_ID, key + ".json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            rec = json.load(f)
    except (IOError, OSError):
        return False, None
    except ValueError:
        raise RuntimeError("%s does not parse; the scheduler waits until it does" % os.path.basename(path))
    if not isinstance(rec, dict):
        raise RuntimeError("%s is not a Suite Data record" % os.path.basename(path))
    return True, rec.get("value")


def page_data(raw_routines, raw_guards):
    rs = _json_value(raw_routines, "routines")
    gs = _json_value(raw_guards, "guards")
    if rs is not None and not isinstance(rs, list):
        raise RuntimeError("Tasks Toolkit's routines are not a list")
    return {"routines": [norm_routine(r) for r in (rs or []) if isinstance(r, dict)],
            "guards": dict(GUARDS, **(gs if isinstance(gs, dict) else {}))}


def read_page_data(root, q, sd_on):
    """The routines and guards: Suite Data's files when it is on (the page
    keeps them there then), else the plugin config through Stash."""
    if sd_on:
        found, rs = store_value(root, "routines")
        if found:
            return page_data(rs, store_value(root, "guards")[1])
    cfg = (((q(Q_CONFIG) or {}).get("configuration") or {}).get("plugins") or {}).get(PLUGIN_ID) or {}
    return page_data(cfg.get("routines"), cfg.get("guards"))


# ── Time: the page's local time, not the container's ────────────────────────
# A container often runs in UTC while the user means 02:00 where they are,
# so the page hands over its time zone with every `scheduler` call (kept in
# _server/scheduler_conf.json). Its name when this Python knows it
# (zoneinfo), else the offset it had then; neither: the server's local time.

def zone_of(tz):
    tz = tz or {}
    name = tz.get("name")
    if isinstance(name, str) and re.match(r"^[A-Za-z0-9_+/-]{1,64}$", name):
        try:
            from zoneinfo import ZoneInfo
            return ZoneInfo(name)
        except Exception:
            pass
    off = tz.get("offset")
    if isinstance(off, (int, float)) and not isinstance(off, bool) and -900 < off < 900:
        return datetime.timezone(datetime.timedelta(minutes=int(off)))
    return None


def local_dt(ms, z):
    if z is None:
        return datetime.datetime.fromtimestamp(ms / 1000.0)
    return datetime.datetime.fromtimestamp(ms / 1000.0, z).replace(tzinfo=None)


def local_ms(dt, z):
    if z is None:
        return int(time.mktime(dt.timetuple()) * 1000)
    return int(dt.replace(tzinfo=z).timestamp() * 1000)


def _dow(dt):
    return (dt.weekday() + 1) % 7         # Sunday 0, as the page's getDay()


def day_match(s, dt):
    if s["freq"] == "daily":
        return True
    if s["freq"] == "weekly":
        return _dow(dt) == _num(s.get("dow"))
    if s["freq"] == "monthly":
        return _dow(dt) == _num(s.get("dow")) and dt.day <= 7
    return False


def _sched_at(s, now, z, back):
    t = parse_hm(s.get("time")) if s else None
    if not t or s.get("freq") not in ("daily", "weekly", "monthly"):
        return 0
    base = local_dt(now, z).date()
    for i in range(41):
        day = base - datetime.timedelta(days=i) if back else base + datetime.timedelta(days=i)
        c = datetime.datetime(day.year, day.month, day.day, t[0], t[1])
        ms = local_ms(c, z)
        if (ms <= now if back else ms > now) and day_match(s, c):
            return ms
    return 0


def last_due(s, now, z=None):
    """The page's lastDue: the latest time the routine was due, up to now."""
    return _sched_at(s, now, z, True)


def next_run(s, now, z=None):
    return _sched_at(s, now, z, False)


def due_routines(now, routines, last_runs, z=None, since=0):
    """Pure: what the scheduler should do now. A list of {r, due, state},
    oldest due first. state: "due" (run it), "missed" (its time passed more
    than SCHED_MISSED_MS ago while the scheduler was not running: noted,
    not run) or "old" (due before the scheduler first ran: dropped without
    a word). Only routines set to run in Stash, on, with a timer; a due from
    before the routine was made or last changed, or one already handled
    (last_runs[id].due), does not count, as on the page (dueState)."""
    out = []
    for r in routines or []:
        if not r.get("on") or r.get("where") != "server" or (r.get("sched") or {}).get("freq") == "hand":
            continue
        d = last_due(r["sched"], now, z)
        if not d:
            continue
        rec = (last_runs or {}).get(r.get("id")) or {}
        if d <= max(_num(r.get("created")), _num(r.get("edited")), _num(r.get("takenDue")), _num(r.get("skipDue")), _num(rec.get("due"))):
            continue
        state = "due" if now - d <= SCHED_MISSED_MS else "missed" if d > since else "old"
        out.append({"r": r, "due": d, "state": state})
    return sorted(out, key=lambda x: x["due"])


def next_due(now, routines, z=None):
    """The next routine the scheduler will run: {id, name, at} or None."""
    best = None
    for r in routines or []:
        if not r.get("on") or r.get("where") != "server" or (r.get("sched") or {}).get("freq") == "hand":
            continue
        at = next_run(r["sched"], now, z)
        if at and (best is None or at < best["at"]):
            best = {"id": r["id"], "name": r["name"], "at": at}
    return best


def in_night(h, a, b):
    return a <= h < b if a <= b else (h >= a or h < b)


# ── Running a routine ───────────────────────────────────────────────────────

class StopRun(Exception):
    """The whole run stops: Stash does not answer, or the scheduler stops."""


def _no_answer(e):
    return isinstance(e, (OSError, http.client.HTTPException, ValueError)) and not isinstance(e, GqlError)


def _login_refused(e):
    return isinstance(e, urllib.error.HTTPError) and e.code in (401, 403)


LOGIN_WORDS = ("Stash refused the scheduler's login (HTTP %s): generate an API key in Stash's Settings > Security; "
               "the scheduler reads it from Stash's config")


class Runner(object):
    """One routine's steps on Stash, as the server script ran them. q: the
    GraphQL call; env: sleep(s), now() (ms), poll (s), stopping() (the
    scheduler's reason to stop, or ""), beat(step) (still alive), guards,
    z (the time zone), log."""

    def __init__(self, q, root, env):
        self.q, self.root, self.env = q, root, env
        self.poll = env.get("poll", SCHED_POLL_S)
        self.log = env.get("log") or logging.getLogger("TasksToolkitI18n.scheduler")

    def now(self):
        return self.env.get("now", now_ms)()

    def sleep(self):
        self.env.get("sleep", time.sleep)(self.poll)

    def check_stop(self):
        why = self.env.get("stopping", lambda: "")()
        if why:
            raise StopRun(why)

    def note(self, routine, event, step="", result="", text="", job="", k=""):
        path = notes_path(self.root)
        try:
            with Lock(os.path.dirname(path)):
                notes = add_note(read_notes(path), {"routine": routine, "event": event, "step": step, "result": result,
                                                    "text": text, "job": job, "k": k}, self.now())
                write_atomic(path, json.dumps(notes, ensure_ascii=False, separators=(",", ":")))
        except Exception as e:
            # a note never stops the run (the script's `|| true`)
            self.log.warning("note not written: %s", e)

    def ask(self, query, variables=None, misses=None):
        """One call that may go unanswered: None then (misses counted; the
        third in a row stops the run). A refused login stops it at once."""
        try:
            d = self.q(query, variables)
            if misses is not None:
                misses[0] = 0
            return d or {}
        except GqlError:
            raise
        except Exception as e:
            if _login_refused(e):
                raise StopRun(LOGIN_WORDS % e.code)
            if not _no_answer(e):
                raise
            if misses is not None:
                misses[0] += 1
                if misses[0] >= SCHED_MISS_MAX:
                    raise StopRun("Stash did not answer")
            return None

    def wait_idle(self, heavy):
        """Until Stash's queue has nothing live in it (and, for a heavy step
        with "heavy work only at night", the night has come)."""
        g = self.env.get("guards") or GUARDS
        start, misses = self.now(), [0]
        while True:
            self.check_stop()
            d = self.ask(Q_QUEUE, None, misses)
            if d is not None:
                live = [j for j in (d.get("jobQueue") or []) if j and j.get("status") not in LIVE_DONE]
                night_ok = not (heavy and g.get("night")) or in_night(local_dt(self.now(), self.env.get("z")).hour, _num(g.get("from"), 1), _num(g.get("to"), 8))
                if not live and night_ok:
                    return
            if self.now() - start > SCHED_IDLE_MAX_S * 1000:
                raise StopRun("Stash stayed busy for 12 h")
            self.env.get("beat", lambda s: None)("waiting for Stash's queue to be empty")
            self.sleep()

    def wait_job(self, job):
        """(result, text) of Stash's job once it ended."""
        start, misses = self.now(), [0]
        while True:
            self.check_stop()
            try:
                d = self.ask(Q_JOB, {"id": str(job)}, misses)
            except GqlError:
                # findJob refuses an id it no longer has on some versions
                return "ok", "Stash no longer lists the job"
            if d is not None:
                f = d.get("findJob")
                if not f:
                    return "ok", "Stash no longer lists the job"
                st = f.get("status")
                if st == "FINISHED":
                    return "ok", ""
                if st == "FAILED":
                    return "failed", clean(f.get("error") or "Stash reports FAILED", 200)
                if st == "CANCELLED":
                    return "stopped", "Stopped in Stash"
            if self.now() - start > SCHED_JOB_MAX_S * 1000:
                return "failed", "no end after 48 h; it may still run in Stash"
            self.env.get("beat", lambda s: None)("waiting for job %s" % job)
            self.sleep()

    def start(self, query, variables):
        """Send a step's mutation: its answer, or raise GqlError (refused) /
        StopRun (no answer)."""
        self.check_stop()
        try:
            return self.q(query, variables) or {}
        except GqlError:
            raise
        except Exception as e:
            if _login_refused(e):
                raise StopRun(LOGIN_WORDS % e.code)
            if _no_answer(e):
                raise StopRun("Stash did not answer")
            raise

    def run_step(self, k, plugins, name):
        """(result, text, job). Auto tag notes each part itself (returns
        noted=True through the text being None)."""
        d = step_def(k)
        if not d:
            return "skipped", "not a step Tasks knows", ""
        if d.get("kit"):
            p = (plugins or {}).get(d["kit"])
            if not p or p.get("enabled") is False:
                return "skipped", "left out: not installed in Stash, or off", ""
            if not ver_at_least(p.get("version"), d["min"]):
                return "skipped", "left out: version %s %s; update it to %s" % (clean(p.get("version"), 12), "does not have this step" if d.get("only")
                                                                               else "plans its scan on its page only", d["min"]), ""
        self.wait_idle(bool(d.get("heavy")))
        if d.get("special") == "autotag":
            return self.run_autotag(name)
        variables = step_vars(d)
        if d.get("special") == "identify":
            boxes = ((((self.ask(Q_BOXES) or {}).get("configuration") or {}).get("general") or {}).get("stashBoxes")) or []
            try:
                defaults = (((self.q(Q_ID_DEFAULTS) or {}).get("configuration") or {}).get("defaults") or {}).get("identify")
            except Exception:
                defaults = None
            ends = id_endpoints(defaults, boxes)
            if not ends:
                return "skipped", "no stash-box is set up in Stash", ""
            sc = self.ask(Q_ID_SCENES, {"f": ID_FILTER})
            if sc is None:
                raise StopRun("Stash did not answer")
            ids = [s.get("id") for s in ((sc.get("findScenes") or {}).get("scenes") or []) if s and s.get("id") is not None]
            if not ids:
                return "skipped", "nothing to identify", ""
            variables = {"i": safe_identify_input(ends, ids, defaults)}
        extra = {}
        if d.get("runid"):
            # 0.6.0: Archive Toolkit's run id, so the Autopilot switch can
            # ask it to stop between scenes (its runStop)
            extra["run"] = "a%d" % self.now()
            variables = dict(variables, a=dict(variables["a"], run=extra["run"]))
        try:
            r = self.start(d["q"], variables)
        except GqlError as e:
            return "failed", clean("Stash refused it: %s" % e, 200), ""
        if d.get("sync"):
            return "ok", "", ""
        v = next(iter(r.values()), None) if isinstance(r, dict) and r else None
        job = "" if v is None else clean(v, 20)
        self.env.get("started", lambda j, x: None)(job, extra)
        if not job:
            return "ok", "", ""
        res, text = self.wait_job(job)
        return res, text, job

    def run_autotag(self, name):
        """Auto tag on what is new, in parts (autotag_run / autotag_done, the
        same calls the page and the script make), each part a step note."""
        label = STEPS["autotag"]["name"]
        for part in range(SCHED_AT_PARTS):
            if part:
                self.wait_idle(False)
            try:
                r = autotag_run(self.q, self.root, self.now())
            except GqlError as e:
                return "failed", clean("Stash refused it: %s" % e, 200), ""
            except RuntimeError as e:
                # the plan refused (a library folder in it, too much new)
                return "failed", clean(str(e), 200), ""
            except Exception as e:
                if _login_refused(e):
                    raise StopRun(LOGIN_WORDS % e.code)
                if _no_answer(e):
                    raise StopRun("Stash did not answer")
                raise
            if r.get("nothing") or not r.get("job"):
                return "ok", clean(r.get("label") or "nothing added since the last Auto tag", TEXT_MAX), ""
            job = str(r["job"])
            res, text = self.wait_job(job)
            if res != "ok":
                return res, text, job
            done = autotag_done(self.root, job)
            if not done.get("more"):
                return "ok", clean(r.get("label") or "", TEXT_MAX), job
            # a part of a split Auto tag: its own note, then the next part
            self.note(name, "step", label, "ok", clean(r.get("label") or "", TEXT_MAX), job, "autotag")
        return "ok", "stopped after %d parts" % SCHED_AT_PARTS, ""

    def run_routine(self, r, plugins):
        """Run one routine; its notes as the script left them. Returns
        {result, ok, failed, of, text}."""
        name = sh_safe(r.get("name")) or "Routine"
        steps = [k for k in r.get("steps") or [] if step_def(k)]
        self.note(name, "start", text="run by Stash's scheduler (Tasks Toolkit %s); a scene playing cannot be seen from here, "
                                      "so that guard does not apply" % PLUGIN_VERSION)
        ok = failed = 0
        try:
            for k in steps:
                d = step_def(k)
                self.env.get("beat", lambda s: None)(d["name"])
                res, text, job = self.run_step(k, plugins, name)
                if res == "stopped":
                    # stopped by the switch going off, not by someone in Stash
                    self.check_stop()
                self.note(name, "step", sh_safe(d["name"]), res, text, job, k)
                if res == "ok":
                    ok += 1
                elif res in ("failed", "stopped"):
                    failed += 1
                    if r.get("onFail") != "continue":
                        break
        except Exception as e:
            if isinstance(e, StopRun) and str(e) == AP_PAUSED:
                # 0.6.0: the Autopilot switch went off; the routine is due
                # again and runs once the switch is back on (its done steps
                # skip what they already did)
                text = "paused by the Autopilot switch after %d of %d steps; it runs again when Autopilot is back on" % (ok, len(steps))
                self.note(name, "failed", text=text)
                return {"result": "paused", "ok": ok, "failed": failed, "of": len(steps), "text": text}
            # StopRun (Stash not answering, the scheduler stopping) or
            # anything unforeseen: the run ends, said in its notes
            text = clean("%s%s; %d of %d steps ok" % ("" if isinstance(e, StopRun) else "error: ", e, ok, len(steps)), TEXT_MAX)
            self.note(name, "failed", text=text)
            return {"result": "failed", "ok": ok, "failed": failed, "of": len(steps), "text": text}
        text = "%d of %d steps ok" % (ok, len(steps))
        self.note(name, "failed" if failed else "done", text=text)
        return {"result": "failed" if failed else "ok", "ok": ok, "failed": failed, "of": len(steps), "text": text}


# ── Autopilot (0.6.0) ───────────────────────────────────────────────────────
# User: "when toggled on it will continue with its task tree ... when I
# toggle it off it will pause the current task and let me operate stash the
# way I want and clears Stash's own task scheduler for my operations. then
# if I toggle it back on it carries on". A switch in the page's top bar,
# kept in _server/autopilot.json (this part's file, like the notes; any
# device sees the same). While it is on the scheduler works through AP_TREE
# one step at a time, each when it is due, after any routine that is due.
# Off: the maintenance jobs and the toolkits' read-only scans are stopped
# (Stash cannot pause a job: the step starts again when the switch is back
# on, and every step skips what is already done), anything that writes is
# left to finish (Archive's own run stops between scenes), and nothing new
# starts, routines included. Never switched (at 0): routines as before.
# User's choices: only the switch pauses it (no scene-playing guard); off
# and forgotten, it is back on at the first 01:00 an hour or more after it
# went off (autoOn, a page setting); routines are turned off by the page
# the first time it is switched on (kept, their steps are in the tree).

AP_NAME = "Autopilot"
AP_PAUSED = "paused by the Autopilot switch"
AP_H = 3600000
AP_D = 24 * AP_H
AP_RETRY_MS = 6 * AP_H         # a failed step is tried again after this (or its interval, if shorter)
AP_HOLD_MS = 10 * 60000        # Stash not answering: no step for this long
AP_BACK_H = 1                  # off and forgotten: back on at 01:00
AP_BACK_GAP_MS = AP_H          # ...the first 01:00 at least this long after it went off
# 0.6.4 (forum, Scenes Toolkit topic #11: "the autopilot feature activated
# automatically after a period by default ... it should be opt-in"): back on
# by itself is off until the user ticks it. A switch file from before (v 1)
# had it on without anyone choosing it, so it reads as off once (v 2 then
# keeps what the user sets).
AP_DEFAULT = {"v": 2, "on": False, "at": 0, "by": "", "offAt": 0, "autoOn": False, "skip": [], "taken": 0}
# The tree: (key, every ms, keys whose newer good end makes it due now).
# Its order is the priority: new files, what they need, the toolkits'
# reads, archiving after its scan, backups, the long ones last.
AP_TREE = (
    ("scan", 6 * AP_H, ()),
    ("genfast", AP_D, ("scan",)),
    ("autotag", AP_D, ("scan",)),
    ("identify", AP_D, ()),
) + tuple(("kit:" + k[0], 7 * AP_D, ()) for k in KITS if k[0] != "ArchiveToolkit") + tuple(
    ("kit:" + x[0], 7 * AP_D, ()) for x in KIT_STEPS) + (
    ("kit:ArchiveToolkit", AP_D, ()),
    ("ap:archive", AP_D, ("kit:ArchiveToolkit",)),
    ("sdbackup", AP_D, ()),
    ("backupdb", 7 * AP_D, ()),
    ("previews", AP_D, ()),
    ("cleangen", 30 * AP_D, ()),
    ("optimise", 30 * AP_D, ()),
)
Q_STOP = "mutation ($id: ID!) { stopJob(job_id: $id) }"
Q_SD = 'mutation ($a: Map) { runPluginOperation(plugin_id: "SuiteData", args: $a) }'
# Stash names a plugin task's job "Running plugin task: <task>"
AP_TASK_RX = re.compile(r"plugin task", re.I)
AP_READ_TASKS = tuple(k[2] for k in KITS) + tuple(x[3] for x in KIT_STEPS)


def ap_path(root):
    return os.path.join(sched_dir(root), "autopilot.json")


def ap_norm(v):
    a = dict(AP_DEFAULT, **(v if isinstance(v, dict) else {}))
    a["on"] = a.get("on") is True
    a["autoOn"] = a.get("autoOn") is True and _num(a.get("v")) >= 2
    a["v"] = 2
    a["skip"] = [str(x) for x in a.get("skip")] if isinstance(a.get("skip"), list) else []
    for k in ("at", "offAt", "taken"):
        a[k] = _num(a.get(k))
    return a


def ap_read(root):
    return ap_norm(read_json_file(ap_path(root)))


def ap_write(root, fn):
    """fn(the switch) returns it changed, or None (nothing written)."""
    with Lock(sched_dir(root)):
        cur = ap_read(root)
        nxt = fn(dict(cur))
        if nxt is None:
            return cur
        nxt = ap_norm(nxt)
        write_atomic(ap_path(root), json.dumps(nxt, separators=(",", ":")))
        return nxt


def ap_held(a):
    """Switched off (once used): nothing new starts, routines included."""
    return a["at"] > 0 and not a["on"]


def ap_back_at(a, z=None):
    """When the switch goes back on by itself (ms), or 0."""
    if a["on"] or not a["autoOn"] or not a["at"]:
        return 0
    base = (a["offAt"] or a["at"]) + AP_BACK_GAP_MS
    dt = local_dt(base, z)
    c = dt.replace(hour=AP_BACK_H, minute=0, second=0, microsecond=0)
    if c < dt:
        c += datetime.timedelta(days=1)
    return local_ms(c, z)


def ap_avail(k, plugins):
    """Why the step cannot run here ("" = it can)."""
    d = step_def(k)
    if not d:
        return "not a step Tasks knows"
    need = d.get("kit") or d.get("plugin")
    if need:
        p = (plugins or {}).get(need)
        if not p or p.get("enabled") is False:
            return "not installed"
        if d.get("min") and not ver_at_least(p.get("version"), d["min"]):
            return "needs %s %s" % (need, d["min"])
    if d.get("writes") and need == "ArchiveToolkit":
        sd = (plugins or {}).get("SuiteData")
        if not sd or sd.get("enabled") is False:
            return "needs Suite Data"
    return ""


def ap_due_at(k, every, after, last):
    """When the step is due (ms; 0 = now: never run)."""
    rec = last.get(k) or {}
    at = _num(rec.get("at"))
    if not at:
        return 0
    if rec.get("result") in ("failed", "stopped"):
        return at + min(AP_RETRY_MS, every)
    for a in after:
        ar = last.get(a) or {}
        if ar.get("result") == "ok" and _num(ar.get("at")) > at:
            return _num(ar.get("at"))
    return at + every


def ap_pick(now, last, plugins, skip=(), paused="", heavy_ok=True, tree=AP_TREE):
    """Pure: (the step to run now or None, the tree as the page shows it).
    The first due step in the tree's order; a step the switch paused goes
    first again while it is due."""
    view, ready = [], []
    for k, every, after in tree:
        d = step_def(k)
        why = "left out by you" if k in (skip or ()) else ap_avail(k, plugins)
        due = ap_due_at(k, every, after, last)
        heavy = bool(d and d.get("heavy"))
        row = {"k": k, "every": every, "after": list(after), "last": last.get(k) or None, "due": due, "why": why, "heavy": heavy}
        if not why and due <= now and not (heavy and not heavy_ok):
            ready.append(k)
        view.append(row)
    pick = paused if paused in ready else (ready[0] if ready else None)
    return pick, view


def ap_seed(notes, history):
    """{key: {at, result}}: the last good end of each step that Tasks has on
    record (the scheduler's notes, the page's history), so the first
    switch-on does not redo what ran last night."""
    out = {}

    def take(k, at):
        if k and at and at > _num((out.get(k) or {}).get("at")):
            out[k] = {"at": at, "result": "ok", "seeded": True}
    for run in ((notes or {}).get("runs") or {}).values():
        for r in (run, (run or {}).get("prev")):
            for st in ((r or {}).get("steps") or []):
                if isinstance(st, dict) and (st.get("result") or "ok") == "ok":
                    take(st.get("k"), _num(st.get("at")))
    for e in history or []:
        if isinstance(e, dict) and e.get("result") == "ok" and step_def(e.get("k")):
            take(e.get("k"), _num(e.get("end")))
    return out


def ap_stoppable(desc):
    """A job the switch may stop: Stash's scan, generate, identify, auto tag
    and clean generated files, and the toolkits' read-only scans. Anything
    that writes what the user made (a toolkit's save, archiving, Undo,
    optimising, a backup, another plugin's task) is left to finish."""
    d = str(desc or "")
    if AP_TASK_RX.search(d):
        return any(d.endswith(t) for t in AP_READ_TASKS)
    if re.search(r"optimi|backup|migrat|import|export|delet|move|renam", d, re.I):
        return False
    if re.search(r"clean", d, re.I):
        return bool(re.search(r"generat", d, re.I))
    return bool(re.search(r"scan|generat|identif|auto.?tag", d, re.I))


def archive_stop(q, run):
    """Archive Toolkit's runStop through Suite Data: its run stops between
    scenes (a move is never cut in half). True when written."""
    def sd(a):
        return ((q(Q_SD, {"a": a}) or {}).get("runPluginOperation")) or {}
    it = ((sd({"mode": "get", "plugin": "ArchiveToolkit", "keys": json.dumps(["runStop"])}).get("items")) or {}).get("runStop") or {}
    r = sd({"mode": "put", "plugin": "ArchiveToolkit", "items": json.dumps({"runStop": {"value": run, "base": _num(it.get("rev"))}}), "by": "Tasks Toolkit Autopilot"})
    return bool(r.get("ok"))


def ap_clear_queue(q, cur, put_stop):
    """The switch went off: stop what may be stopped, say what is left.
    cur: the step Autopilot is in ({k, job, run}) or None."""
    jobs = (q(Q_QUEUE) or {}).get("jobQueue") or []
    stopped, left = [], []
    for j in jobs:
        if not j or j.get("status") not in ("READY", "RUNNING"):
            continue
        desc = clean(j.get("description") or "a job", 80)
        if cur and cur.get("run") and str(cur.get("job") or "") == str(j.get("id")):
            try:
                ok = put_stop(cur["run"])
            except Exception:
                ok = False
            left.append({"d": desc, "why": "stops after the scene in hand" if ok else "could not be asked to stop; it ends by itself"})
            continue
        if not ap_stoppable(desc):
            left.append({"d": desc, "why": "it writes your data, so it is left to finish"})
            continue
        try:
            q(Q_STOP, {"id": str(j.get("id"))})
            stopped.append(desc)
        except Exception as e:
            left.append({"d": desc, "why": clean("Stash did not stop it: %s" % e, 120)})
    return stopped, left


def ap_status(root, busy=None):
    """What the page's switch and Autopilot card show: the switch, when it
    is back on by itself, the step it is in, the tree."""
    a = ap_read(root)
    st = read_json_file(sched_path(root, "json"))
    z = zone_of((read_json_file(sched_path(root, "conf")) or {}).get("tz"))
    sch = sched_status(root, busy=busy)
    s = st.get("ap") if isinstance(st.get("ap"), dict) else {}
    return dict(a, backAt=ap_back_at(a, z), held=ap_held(a), cur=s.get("cur") if sch["running"] else None, view=s.get("view") or [],
                wait=(s.get("wait") or "") if sch["running"] else "", lastAt=_num(s.get("at")),
                sched={"running": sch["running"], "supported": sch["supported"], "stale": sch.get("stale"), "lastError": sch.get("lastError") or ""},
                pluginVersion=PLUGIN_VERSION)


def ap_switch(root, q, on, now, by="you", put_stop=None):
    """The page's switch: on or off; off also clears what may be cleared."""
    def fn(a):
        if a["on"] == on and a["at"]:
            return None
        a.update(on=on, at=now, by=by)
        if not on:
            a["offAt"] = now
        return a
    ap_write(root, fn)
    out = {"stopped": [], "left": []}
    if not on and q is not None:
        cur = ((read_json_file(sched_path(root, "json")).get("ap") or {}).get("cur")) or None
        try:
            out["stopped"], out["left"] = ap_clear_queue(q, cur, put_stop or (lambda run: archive_stop(q, run)))
        except Exception as e:
            out["error"] = clean("could not read Stash's queue: %s" % e, 200)
    return dict(ap_status(root), **out)


def ap_set(root, args):
    """The page's Autopilot settings: a step left out or back in, back on
    by itself at night, routines taken over."""
    def fn(a):
        k = str(args.get("k") or "")
        if args.get("skip") in ("1", "0") and step_def(k):
            s = [x for x in a["skip"] if x != k]
            a["skip"] = s + [k] if args.get("skip") == "1" else s
        if args.get("autoOn") in ("1", "0"):
            a["autoOn"] = args.get("autoOn") == "1"
        if args.get("taken"):
            a["taken"] = _num(args.get("taken"))
        return a
    ap_write(root, fn)
    return ap_status(root)


# ── The daemon's files and its one-at-a-time guard ──────────────────────────

def sched_dir(root):
    return os.path.join(root, PLUGIN_ID, "_server")


def sched_path(root, what):
    # what: "json" (its state), "pid", "conf" (the page's time zone), "log"
    return os.path.join(sched_dir(root), {"json": "scheduler.json", "pid": "scheduler.pid", "conf": "scheduler_conf.json", "log": "scheduler.log"}[what])


def lock_file(root):
    # the temporary folder of the container, not the config share: the
    # kernel's flock is sure there, and one Stash's lock never meets another's
    return os.path.join(tempfile.gettempdir(), "tasks_toolkit_scheduler_%08x.lock" % (zlib.crc32(os.path.abspath(root).encode("utf-8")) & 0xffffffff))


def lock_take(root):
    """The scheduler's lock, held (an fd), or None when another holds it."""
    if fcntl is None:
        return None
    fd = os.open(lock_file(root), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except OSError:
        os.close(fd)
        return None


def lock_busy(root):
    """True while a scheduler holds the lock (None: no flock here)."""
    if fcntl is None:
        return None
    fd = lock_take(root)
    if fd is None:
        return True
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)
    return False


def read_json_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (IOError, OSError, ValueError):
        return {}


def _read_cmdline(pid):
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", "replace")
    except (IOError, OSError):
        return None


def _read_start(pid):
    """The process's start time (clock ticks after boot, /proc/<pid>/stat
    field 22): a pid reused after a restart has another one."""
    try:
        with open("/proc/%d/stat" % pid, "rb") as f:
            s = f.read().decode("ascii", "replace")
        return s[s.rindex(")") + 2:].split()[19]
    except (IOError, OSError, ValueError, IndexError):
        return None


def is_scheduler_pid(rec, read_cmdline=_read_cmdline, read_start=_read_start, me=None):
    """True only for a process that verifiably is the scheduler named in the
    PID file: never pid 1 (the container's init, often Stash), never this
    process, its command line this script, its start time the one recorded.
    Unknown is no: signalling the wrong process could take Stash down."""
    try:
        pid = int((rec or {}).get("pid") or 0)
    except (TypeError, ValueError):
        return False
    if pid <= 1 or pid == (os.getpid() if me is None else me):
        return False
    cmd = read_cmdline(pid)
    if not cmd or SCHED_MARKER not in cmd:
        return False
    want = (rec or {}).get("start")
    if want:
        got = read_start(pid)
        if got is None or str(got) != str(want):
            return False
    return True


def file_version(path):
    """PLUGIN_VERSION in the plugin file on disk ("" when it is gone)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            m = re.search(r'^PLUGIN_VERSION = "([^"]+)"', f.read(), re.M)
        return m.group(1) if m else ""
    except (IOError, OSError):
        return ""


def plugin_gone(file_path, version, plugins):
    """Why the scheduler should exit now ("" = it should not). plugins:
    {id: {version, enabled}} from Stash, or None when Stash did not answer
    (then only the file is looked at: Stash restarting is no reason)."""
    v = file_version(file_path)
    if not v:
        return "the plugin file is gone (Tasks Toolkit removed)"
    if v != version:
        return "the plugin was updated to %s; the next page or task starts that one" % v
    if plugins is not None:
        p = plugins.get(PLUGIN_ID)
        if not p:
            return "Stash no longer lists Tasks Toolkit"
        if p.get("enabled") is False:
            return "Tasks Toolkit is turned off in Stash"
    return ""


def api_key_of(conn):
    """Stash's API key from its config.yml (beside which Stash keeps its
    data), so night runs sign in after the page's session has expired (an
    hour by default). Read each run, kept in memory only."""
    d = (conn or {}).get("Dir")
    if not isinstance(d, str) or not d:
        return ""
    try:
        with open(os.path.join(d, "config.yml"), "r", encoding="utf-8") as f:
            for line in f:
                m = re.match(r"""^api_key:\s*["']?([A-Za-z0-9._\-]+)""", line)
                if m:
                    return m.group(1)
    except (IOError, OSError, UnicodeDecodeError):
        pass
    return ""


def plugin_list(q):
    """{id: {version, enabled}} or None when Stash did not answer."""
    try:
        return dict((p["id"], p) for p in ((q(Q_PLUGINS) or {}).get("plugins") or []) if p and p.get("id"))
    except Exception:
        return None


class Scheduler(object):
    """The daemon's loop. Injected for tests: q (GraphQL), sleep, now,
    file_path (the plugin file whose version and presence it checks)."""

    def __init__(self, conn, root, q=None, sleep=None, now=now_ms, poll=SCHED_POLL_S, file_path=None, log=None, pid=None):
        self.conn, self.root, self.q_fixed, self.now, self.poll = conn or {}, root, q, now, poll
        self.sleep_fn = sleep or self._nap
        self.file_path = file_path or THIS_FILE
        self.log = log or logging.getLogger("TasksToolkitI18n.scheduler")
        self.stop_why = ""
        self.checked = 0
        self.plugins = None
        self.cfg = None
        st = read_json_file(sched_path(root, "json"))
        t = self.now()
        self.state = {"v": 1, "runs": st.get("runs") if isinstance(st.get("runs"), dict) else {},
                      "firstStarted": _num(st.get("firstStarted")) or t, "pid": os.getpid() if pid is None else pid,
                      "version": PLUGIN_VERSION, "started": t, "lastTick": 0, "next": None, "running": None,
                      "lastError": "", "stoppedAt": 0, "stopWhy": "", "auth": "", "tz": None,
                      # 0.6.0: Autopilot's record (each step's last end) outlives a restart
                      "ap": dict(st["ap"], cur=None, wait="") if isinstance(st.get("ap"), dict) else {}}

    def stop(self, why):
        self.stop_why = self.stop_why or why

    def _nap(self, s):
        # a second at a time, so a stop (SIGTERM) is seen within a second
        end = time.time() + s
        while not self.stop_why and time.time() < end:
            time.sleep(min(1.0, max(0.0, end - time.time())))

    def stopping(self):
        return self.stop_why

    def ap_off(self):
        try:
            return ap_held(ap_read(self.root))
        except Exception:
            return False

    def ap_stopping(self):
        """Why the step in hand stops: the scheduler stopping, or the
        Autopilot switch gone off (read from its file at every look)."""
        return self.stop_why or (AP_PAUSED if self.ap_off() else "")

    def ap_tick(self, q, data, z, now):
        """The switch is on and no routine is due: the next step of the tree."""
        apst = self.state["ap"]
        if now < _num(apst.get("holdUntil")):
            return
        plugins = plugin_list(q)
        if plugins is None:
            apst.update(wait="Stash did not answer", holdUntil=now + AP_HOLD_MS)
            return
        self.plugins = plugins
        last = apst.setdefault("last", {})
        if not apst.get("seeded"):
            hist = []
            try:
                found, h = store_value(self.root, "history")
                hist = _json_value(h, "history") if found else []
            except Exception:
                hist = []
            try:
                notes = read_notes(notes_path(self.root))
            except Exception:
                notes = None
            for k, v in ap_seed(notes, hist if isinstance(hist, list) else []).items():
                if _num((last.get(k) or {}).get("at")) < v["at"]:
                    last[k] = v
            apst["seeded"] = now
        g = data["guards"]
        heavy_ok = not g.get("night") or in_night(local_dt(now, z).hour, _num(g.get("from"), 1), _num(g.get("to"), 8))
        a = ap_read(self.root)
        k, view = ap_pick(now, last, plugins, a["skip"], apst.get("paused") or "", heavy_ok)
        apst.update(view=view, at=now, wait="" if k or heavy_ok else "heavy work waits for the night")
        if k:
            self.ap_step(q, k, plugins, data, z)

    def ap_step(self, q, k, plugins, data, z):
        """One step of the tree, noted under "Autopilot" (a run per day)."""
        apst = self.state["ap"]
        d = step_def(k)
        now = self.now()
        noter = Runner(q, self.root, {"now": self.now, "log": self.log})
        day = local_dt(now, z).strftime("%Y-%m-%d")
        if apst.get("open") != day:
            if apst.get("open"):
                noter.note(AP_NAME, "done", text="a new day")
            noter.note(AP_NAME, "start", text="Autopilot (Tasks Toolkit %s): one step at a time while the switch is on" % PLUGIN_VERSION)
            apst["open"] = day
        apst.update(cur={"k": k, "name": d["name"], "since": now, "job": "", "run": ""}, wait="")
        self.state["running"] = {"id": "autopilot", "name": AP_NAME, "since": now, "step": d["name"]}
        self.save()
        self.log.info("Autopilot: %s", d["name"])

        def started(job, extra):
            if apst.get("cur"):
                apst["cur"].update(job=job, run=extra.get("run", ""))
                self.save()
        env = {"now": self.now, "sleep": self.sleep_fn, "poll": self.poll, "stopping": self.ap_stopping, "beat": self.beat,
               "guards": data["guards"], "z": z, "log": self.log, "started": started}
        hold = False
        try:
            res, text, job = Runner(q, self.root, env).run_step(k, plugins, AP_NAME)
            if res == "stopped" and self.ap_off():
                res = "paused"
        except StopRun as e:
            job = (apst.get("cur") or {}).get("job", "")
            if str(e) == AP_PAUSED or self.stop_why:
                # the switch went off, or the scheduler stops: due again
                res, text = "paused", ""
            else:
                res, text, hold = "failed", str(e), True
        except Exception as e:
            self.log.exception("Autopilot %s", k)
            res, text, job = "failed", clean("error: %s" % e, 200), ""
        end = self.now()
        last = apst.setdefault("last", {})
        if res == "paused":
            apst["paused"] = k
            noter.note(AP_NAME, "step", sh_safe(d["name"]), "skipped", "paused by the switch; it starts again when Autopilot is back on", job, k)
        else:
            if apst.get("paused") == k:
                apst["paused"] = ""
            if hold:
                # Stash not answering is no verdict on the step: tried again soon
                apst["holdUntil"] = end + AP_HOLD_MS
                self.state["lastError"] = clean(text, TEXT_MAX)
            else:
                last[k] = {"at": end, "result": res, "text": clean(text or "", 200)}
            noter.note(AP_NAME, "step", sh_safe(d["name"]), res, text, job, k)
        apst["cur"] = None
        self.state["running"] = None
        self.save()
        self.log.info("Autopilot: %s %s %s", d["name"], res, text or "")

    def make_q(self):
        if self.q_fixed:
            return self.q_fixed
        conn = dict(self.conn)
        key = api_key_of(conn)
        if key:
            # the key alone: the page's session cookie expires within the hour
            conn["ApiKey"] = key
            conn.pop("SessionCookie", None)
        self.state["auth"] = "apikey" if key else "session" if ((conn.get("SessionCookie") or {}).get("Value")) else "none"
        return stash_gql(conn)

    def save(self):
        try:
            write_atomic(sched_path(self.root, "json"), json.dumps(self.state, ensure_ascii=False, separators=(",", ":")))
        except (IOError, OSError) as e:
            self.log.warning("state not written: %s", e)

    def beat(self, step):
        self.state["lastTick"] = self.now()
        if self.state.get("running"):
            self.state["running"]["step"] = clean(step, NAME_MAX)
        self.save()

    def tick(self):
        """One look. Returns why the scheduler should exit, or ""."""
        now = self.now()
        q = self.make_q()
        # the file every look (a read), Stash's plugin list every few minutes
        fresh = not self.checked or now - self.checked >= SCHED_CHECK_S * 1000
        if fresh:
            self.plugins = plugin_list(q)
            self.checked = now
        why = plugin_gone(self.file_path, PLUGIN_VERSION, self.plugins if fresh else None)
        if why:
            self.stop(why)
            return why
        conf = read_json_file(sched_path(self.root, "conf"))
        self.state["tz"] = conf.get("tz") if isinstance(conf.get("tz"), dict) else None
        z = zone_of(self.state["tz"])
        try:
            if self.plugins is None:
                # Stash's list unknown: Suite Data's file, when there is one
                sd_on = os.path.isfile(os.path.join(self.root, PLUGIN_ID, "routines.json"))
            else:
                sd_on = "SuiteData" in self.plugins and self.plugins["SuiteData"].get("enabled") is not False
            if sd_on:
                data = read_page_data(self.root, q, True)
            elif self.cfg and now - self.cfg[0] < SCHED_CHECK_S * 1000:
                # the plugin config holds the other plugins' copies too (a MB
                # and more): read every few minutes, not every look
                data = self.cfg[1]
            else:
                data = read_page_data(self.root, q, False)
                self.cfg = (now, data)
        except Exception as e:
            self.state["lastError"] = clean("could not read the routines: %s" % e, TEXT_MAX)
            self.state["lastTick"] = now
            self.save()
            return ""
        runs = self.state["runs"]
        # 0.6.0: the Autopilot switch; off and forgotten, it is back on at night
        try:
            a = ap_read(self.root)
            back = ap_back_at(a, z)
            if back and now >= back:
                a = ap_write(self.root, lambda x: None if x["on"] else dict(x, on=True, at=now, by="night"))
                self.log.info("Autopilot back on by itself (%s)", local_dt(back, z).strftime("%H:%M"))
        except Exception as e:
            self.log.warning("Autopilot's switch not read: %s", e)
            a = ap_norm({})
        apst = self.state["ap"]
        if ap_held(a):
            # off: nothing new starts, routines included; their dues wait
            if apst.get("open"):
                Runner(q, self.root, {"now": self.now, "log": self.log}).note(AP_NAME, "done", text="switched off")
                apst["open"] = ""
            apst.update(cur=None, wait="switched off")
            self.state["next"] = next_due(now, data["routines"], z)
            self.state["lastTick"] = now
            self.save()
            return ""
        todo = due_routines(now, data["routines"], runs, z, self.state["firstStarted"])
        for x in todo:
            r = x["r"]
            if x["state"] == "due":
                continue
            runs[r["id"]] = {"due": x["due"], "at": now, "end": now, "result": x["state"], "name": r["name"], "text": ""}
            if x["state"] == "missed":
                when = local_dt(x["due"], z).strftime("%a %d %b %H:%M")
                Runner(q, self.root, {"now": self.now, "log": self.log}).note(sh_safe(r["name"]) or "Routine", "missed",
                                                                            text="due %s while Stash's scheduler was not running; over 6 h late, so not run" % when)
        due = [x for x in todo if x["state"] == "due"]
        if due:
            x = due[0]
            r = x["r"]
            prev = runs.get(r["id"])
            runs[r["id"]] = {"due": x["due"], "at": now, "end": 0, "result": "running", "name": r["name"], "text": ""}
            self.state["running"] = {"id": r["id"], "name": r["name"], "since": now, "step": ""}
            self.save()
            self.log.info("running %s (due %s)", r["name"], x["due"])
            env = {"now": self.now, "sleep": self.sleep_fn, "poll": self.poll, "stopping": self.ap_stopping, "beat": self.beat,
                   "guards": data["guards"], "z": z, "log": self.log}
            try:
                res = Runner(q, self.root, env).run_routine(r, plugin_list(q) or self.plugins or {})
            except Exception as e:
                self.log.exception("routine %s", r["name"])
                res = {"result": "failed", "text": clean("the scheduler hit an error: %s" % e, TEXT_MAX)}
            if res["result"] == "paused":
                # due again: it runs when the switch is back on
                if prev:
                    runs[r["id"]] = prev
                else:
                    runs.pop(r["id"], None)
            else:
                runs[r["id"]].update(result=res["result"], end=self.now(), text=res.get("text", ""))
            self.state["running"] = None
            t = res.get("text", "")
            self.state["lastError"] = t if res["result"] != "ok" and ("did not answer" in t or "login" in t) else ""
            self.log.info("%s: %s, %s", r["name"], res["result"], res.get("text", ""))
        elif a["on"]:
            self.ap_tick(q, data, z, now)
        # routines taken out stop being remembered
        ids = set(r["id"] for r in data["routines"])
        for k in [k for k in runs if k not in ids]:
            del runs[k]
        self.state["next"] = next_due(self.now(), data["routines"], z)
        self.state["lastTick"] = self.now()
        self.save()
        return ""

    def loop(self):
        self.save()
        while not self.stop_why:
            try:
                why = self.tick()
            except Exception as e:
                self.log.exception("tick")
                self.state["lastError"] = clean("tick: %s" % e, TEXT_MAX)
                why = ""
            if why or self.stop_why:
                break
            self.sleep_fn(self.poll)
        self.state.update(running=None, stoppedAt=self.now(), stopWhy=self.stop_why)
        self.save()
        self.log.info("scheduler stopped: %s", self.stop_why)


def _set_comm():
    try:
        with open("/proc/self/comm", "w") as f:
            f.write(SCHED_COMM)
    except (IOError, OSError):
        pass


def daemon_body(conn, root, lock_fd, ready_w):
    """The double-forked child: quiet stdio, its log, its PID file, then the
    loop. Keeps lock_fd open (the lock) until it exits."""
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    os.close(devnull)
    try:
        os.chdir("/")
    except OSError:
        pass
    _set_comm()
    d = sched_dir(root)
    if not os.path.isdir(d):
        os.makedirs(d)
    log = logging.getLogger("TasksToolkitI18n.scheduler")
    log.handlers[:] = []
    h = logging.handlers.RotatingFileHandler(sched_path(root, "log"), maxBytes=SCHED_LOG_MAX, backupCount=1, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(h)
    log.setLevel(logging.INFO)
    log.propagate = False
    pid = os.getpid()
    rec = {"pid": pid, "start": _read_start(pid) or "", "version": PLUGIN_VERSION, "started": now_ms()}
    write_atomic(sched_path(root, "pid"), json.dumps(rec))
    sch = Scheduler(conn, root, log=log)
    signal.signal(signal.SIGTERM, lambda *a: sch.stop("stopped (scheduler_stop or Stash shutting down)"))
    signal.signal(signal.SIGINT, lambda *a: sch.stop("interrupted"))
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    log.info("scheduler %s started (pid %d)", PLUGIN_VERSION, pid)
    try:
        os.write(ready_w, b"K")
        os.close(ready_w)
    except OSError:
        pass
    try:
        sch.loop()
    finally:
        if read_json_file(sched_path(root, "pid")).get("pid") == pid:
            try:
                os.remove(sched_path(root, "pid"))
            except OSError:
                pass
        os.close(lock_fd)


def sched_status(root, read_cmdline=_read_cmdline, read_start=_read_start, busy=None):
    """What the page shows: running?, pid, since, version, next, last tick,
    last results per routine, the error last seen."""
    st = read_json_file(sched_path(root, "json"))
    rec = read_json_file(sched_path(root, "pid"))
    held = lock_busy(root) if busy is None else busy
    alive = is_scheduler_pid(rec, read_cmdline, read_start)
    running = alive if held is None else bool(held)
    out = {"supported": hasattr(os, "fork") and fcntl is not None, "running": running, "verified": alive,
           "pid": rec.get("pid") if running else None, "version": (rec.get("version") or st.get("version") or "") if running else "",
           "started": (rec.get("started") or st.get("started") or 0) if running else 0, "pluginVersion": PLUGIN_VERSION,
           "lastTick": st.get("lastTick") or 0, "next": st.get("next") if running else None, "busy": st.get("running") if running else None,
           "runs": st.get("runs") or {}, "lastError": st.get("lastError") or "", "auth": st.get("auth") or "",
           "stoppedAt": st.get("stoppedAt") or 0, "stopWhy": st.get("stopWhy") or "", "tz": st.get("tz")}
    out["stale"] = bool(running and out["version"] and out["version"] != PLUGIN_VERSION)
    return out


def write_tz(root, tz):
    """The page's time zone for the scheduler (only when it changed)."""
    if not isinstance(tz, dict):
        return
    tz = {"name": clean(tz.get("name"), 64), "offset": _num(tz.get("offset"))}
    path = sched_path(root, "conf")
    cur = read_json_file(path)
    if cur.get("tz") != tz:
        write_atomic(path, json.dumps(dict(cur, tz=tz, at=now_ms())))


def sched_stop(root, kill=os.kill, read_cmdline=_read_cmdline, read_start=_read_start, wait_s=5.0):
    """Ask the scheduler to stop (SIGTERM; it ends at its next look, within
    SCHED_POLL_S, noting a run it was in as failed). Only a pid that
    verifiably is the scheduler is signalled."""
    rec = read_json_file(sched_path(root, "pid"))
    if not is_scheduler_pid(rec, read_cmdline, read_start):
        return {"stopped": False, "why": "no running scheduler found"}
    try:
        kill(int(rec["pid"]), signal.SIGTERM)
    except OSError as e:
        return {"stopped": False, "why": str(e)}
    deadline = time.time() + wait_s
    while time.time() < deadline and lock_busy(root):
        time.sleep(0.1)
    return {"stopped": True, "pid": rec["pid"], "gone": not lock_busy(root)}


def sched_ensure(conn, root, args):
    """Start the scheduler unless it runs (then only its status). A running
    one of another version is stopped first when it is between routines (in
    the middle of one it finishes and exits by itself: it checks the file's
    version every look)."""
    tz = args.get("tz")
    if isinstance(tz, str):
        try:
            tz = json.loads(tz)
        except ValueError:
            tz = None
    write_tz(root, tz)
    if not hasattr(os, "fork") or fcntl is None:
        out = sched_status(root, busy=False)
        out.update(supported=False, error="the scheduler needs Stash on Linux (as in Docker); here routines run from a browser only")
        return out
    st = sched_status(root)
    if st["running"]:
        if not st["stale"] or st["busy"]:
            return dict(st, startedNow=False)
        sched_stop(root)
    fd = lock_take(root)
    if fd is None:
        return dict(sched_status(root), startedNow=False)
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(r)
            os.setsid()
            if os.fork() > 0:
                os._exit(0)
            daemon_body(conn, root, fd, w)
        except BaseException:
            pass
        os._exit(0)
    os.close(w)
    os.close(fd)
    ready, deadline = False, time.time() + 5.0
    while time.time() < deadline:
        rl = select.select([r], [], [], 0.2)[0]
        if rl:
            ready = os.read(r, 1) == b"K"
            break
    os.close(r)
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
    return dict(sched_status(root), startedNow=ready)


def run(args, conn, q=None):
    root = data_root(conn)
    path = notes_path(root)
    mode = args.get("mode")
    if mode == "ping":
        return {"ok": True, "version": PLUGIN_VERSION, "python": sys.version.split()[0], "file": path}
    if mode == "notes":
        out = read_notes(path)
        out["version"] = PLUGIN_VERSION
        return out
    if mode == "note":
        with Lock(os.path.dirname(path)):
            notes = add_note(read_notes(path), args, now_ms())
            write_atomic(path, json.dumps(notes, ensure_ascii=False, separators=(",", ":")))
        # the server script's step ended well: if it was the pending Auto
        # tag (its job id), the mark moves
        if args.get("event") == "step" and (args.get("result") or "ok") == "ok" and args.get("job"):
            autotag_done(root, clean(args.get("job"), 20))
        return {"ok": True, "version": PLUGIN_VERSION}
    if mode == "autotag_paths":
        return autotag_paths(q or stash_gql(conn), root, now_ms(), str(args.get("refresh") or "") in ("1", "true", "True"))
    if mode == "autotag_run":
        return autotag_run(q or stash_gql(conn), root, now_ms())
    if mode == "autotag_done":
        return autotag_done(root, clean(args.get("job"), 20))
    # 0.4.0: Stash's scheduler
    if mode == "scheduler":
        return sched_ensure(conn, root, args)
    if mode == "scheduler_status":
        return sched_status(root)
    if mode == "scheduler_stop":
        return sched_stop(root)
    # 0.6.0: Autopilot's switch
    if mode == "autopilot_status":
        return ap_status(root)
    if mode == "autopilot":
        on = str(args.get("on") or "") in ("1", "true", "True")
        return ap_switch(root, q or stash_gql(conn), on, now_ms())
    if mode == "autopilot_set":
        return ap_set(root, args)
    raise ValueError("unknown mode")


def main():
    try:
        inp = json.loads(sys.stdin.read() or "{}")
    except Exception:
        inp = {}
    try:
        out, err = run(inp.get("args") or {}, inp.get("server_connection") or {}), None
    except Exception as e:
        out, err = None, str(e)
    answer(out, err)


if __name__ == "__main__":
    main()
