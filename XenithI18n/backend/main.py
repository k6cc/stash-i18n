"""Xenith's plugin exec entry point (Stash's raw exec interface).

Dispatches on argv/stdin rather than an HTTP route: `sys.argv[1]` is the
task name (from `xenith.yml`'s `execArgs`), `sys.argv[2]` is the scope, and
stdin carries the JSON server-connection payload Stash always sends. Also
routes `runPluginOperation` calls (no argv at all) to `handle_log_operation`
before a `StashInterface` is built — see `main()`'s own comment.
"""

import os
import sys
import json

import stashapi.log as log
from stashapi.stashapp import StashInterface

from tasks import SCOPES, TASKS, handle_log_operation


def main():
    """Parses argv/stdin, dispatches to a task handler or the log operation,
    and always prints exactly one JSON line to stdout (Stash parses stdout
    as JSON regardless of success/failure).
    """
    task_name = sys.argv[1] if len(sys.argv) > 1 else None
    scope = sys.argv[2] if len(sys.argv) > 2 else "all"

    try:
        raw = sys.stdin.read()
        input_data = json.loads(raw) if raw else {}
    except json.JSONDecodeError as e:
        # Stash's raw exec interface always invokes this script, even for tasks
        # triggered without a server_connection payload; fall back rather than crash.
        log.error(f"Failed to parse stdin: {e}")
        input_data = {}

    # runPluginOperation (the frontend's batched match-log flush) calls exec
    # with no argv, so task_name is None here — distinct from an actual
    # unknown-task call, which always has a task_name string. A log operation
    # needs no StashInterface, so it's handled before that gets built.
    args = input_data.get("args") or {}
    if task_name is None and args.get("mode") == "log":
        print(json.dumps({"output": handle_log_operation(args)}))
        return

    # stashapi's StashInterface reads the cookie as conn["SessionCookie"] and
    # indexes it as conn["SessionCookie"]["Value"] (stashapi/stashapp.py) — it
    # must be forwarded verbatim under that exact key and shape, not flattened
    # or renamed, or every request goes out unauthenticated. Stash's own
    # ServerConnection payload carries no ApiKey field of its own (see
    # pkg/plugin/common/msg.go upstream), and a session cookie is known to 401
    # independent of browser login state.
    # XENITH_STASH_API_KEY is an optional escape hatch for that case: set it
    # in the container's env and stashapi sends it alongside the cookie.
    conn = input_data.get("server_connection", {})
    session_cookie = conn.get("SessionCookie")
    if not (isinstance(session_cookie, dict) and "Value" in session_cookie):
        session_cookie = None
    stash = StashInterface(
        {
            "scheme": conn.get("Scheme", "http"),
            "host": conn.get("Host", "localhost"),
            "port": conn.get("Port", "9999"),
            "SessionCookie": session_cookie,
            "ApiKey": os.environ.get("XENITH_STASH_API_KEY"),
            "logger": log,
        }
    )

    handler = TASKS.get(task_name)
    if not handler:
        log.error(f"Unknown task: {task_name}")
        print(json.dumps({"error": f"Unknown task: {task_name}"}))
        return

    if scope not in SCOPES:
        log.error(f"Unknown scope: {scope}")
        print(json.dumps({"error": f"Unknown scope: {scope}"}))
        return

    try:
        result = handler(stash, input_data, scope)
        print(json.dumps({"output": result}))
    except Exception as e:
        # Stash parses stdout as JSON regardless of outcome, so failures must still
        # emit a JSON object on stdout rather than letting the exception propagate.
        log.error(f"Task '{task_name}' failed: {e}")
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
