"""Xenith plugin task implementations, dispatched by `main.py`'s `TASKS` map.

Each `task_*(stash, input_data, scope)` handler matches an `execArgs` entry
in `xenith.yml` and returns a plain string result. `handle_log_operation`
is not a task — it has no `stash`/`scope`, and is invoked directly by
`main.py` for the frontend's `runPluginOperation` batched-log-flush path.
"""

import json
import os
from datetime import datetime

import stashapi.log as log

from queries import PERFORMER_FRAGMENT, SCENE_FRAGMENT

SNAPSHOTS_DIR = os.environ.get("XENITH_SNAPSHOTS_DIR") or os.path.join(
    os.path.dirname(__file__), "..", "snapshots"
)

SNAPSHOT_SUFFIX = "Xenith Snapshot.json"

# Scopes a task run can be limited to via execArgs (see xenith.yml).
SCOPES = ("all", "performers", "scenes")

# Keys must match STATS_KEY/RECORD_KEY (and their legacy counterparts) in
# src/matchmaking.js — this is the only place those custom_fields keys are
# hardcoded outside the frontend. Both generations are removed so wipe works
# whether or not task_migrate has run yet. One list is used for every entity
# type (scenes never wrote the legacy performer_record key, so that one is a
# no-op for scenes) rather than a list per type, so a future entity type
# can't silently miss a key because someone forgot to extend a per-type list.
WIPE_KEYS = ["xenith_stats", "xenith_record", "hotornot_stats", "performer_record"]


def _scope_summary(performers, scenes):
    """Joins whichever of `performers`/`scenes` was actually fetched (the
    other is `None` when `scope` excluded it) into a "N performers and
    M scenes"-style fragment for a task's result message.
    """
    parts = []
    if performers is not None:
        parts.append(f"{len(performers)} performers")
    if scenes is not None:
        parts.append(f"{len(scenes)} scenes")
    return " and ".join(parts)


def task_wipe(stash, _input, scope="all"):
    """Removes every Xenith (and legacy HotOrNot-era) custom_fields key —
    `WIPE_KEYS` — from performers, scenes, or both per `scope` ("all" /
    "performers" / "scenes", see `xenith.yml`'s scoped task variants).
    """
    performers = None
    if scope in ("all", "performers"):
        performers = stash.find_performers(filter={"per_page": -1})
        if performers:
            ids = [p["id"] for p in performers]
            stash.update_performers(
                {"ids": ids, "custom_fields": {"remove": WIPE_KEYS}}
            )

    scenes = None
    if scope in ("all", "scenes"):
        scenes = stash.find_scenes(filter={"per_page": -1})
        if scenes:
            ids = [s["id"] for s in scenes]
            stash.update_scenes(
                {"ids": ids, "custom_fields": {"remove": WIPE_KEYS}}
            )

    message = f"Wiped history for {_scope_summary(performers, scenes)}."
    log.info(message)
    return message


def task_reset(stash, _input, scope="all"):
    """Nulls `rating100` back to the implicit DEFAULT_RATING every code path
    already assumes, for performers, scenes, or both per `scope`.
    """
    performers = None
    if scope in ("all", "performers"):
        performers = stash.find_performers(filter={"per_page": -1})
        if performers:
            ids = [p["id"] for p in performers]
            stash.update_performers({"ids": ids, "rating100": None})

    scenes = None
    if scope in ("all", "scenes"):
        scenes = stash.find_scenes(filter={"per_page": -1})
        if scenes:
            ids = [s["id"] for s in scenes]
            stash.update_scenes({"ids": ids, "rating100": None})

    message = f"Reset ratings for {_scope_summary(performers, scenes)}."
    log.info(message)
    return message


def _database_path(stash):
    """Stable per-Stash-instance identifier (path to the SQLite database file).

    Scenes have no natural key stable across databases (titles collide,
    files get renamed/moved), unlike performers which are remapped by name.
    Recording this at export time lets import refuse to apply scene data
    onto a different database's scene IDs instead of silently corrupting it.
    """
    result = stash.call_GQL("query XenithSystemStatus { systemStatus { databasePath } }")
    return result.get("systemStatus", {}).get("databasePath")


def _write_snapshot(stash, label=None):
    """Writes a snapshot file and returns (path, performer_count, scene_count).

    `label`, if given, is inserted before SNAPSHOT_SUFFIX (not after) so the
    filename still ends with SNAPSHOT_SUFFIX and still starts with the
    timestamp — task_snapshot_import relies on both (endswith filter,
    reverse-lexicographic sort for newest-first).
    """
    performers = stash.find_performers(
        filter={"per_page": -1},
        fragment=PERFORMER_FRAGMENT,
    )
    scenes = stash.find_scenes(
        filter={"per_page": -1},
        fragment=SCENE_FRAGMENT,
    )
    database_path = _database_path(stash)

    os.makedirs(SNAPSHOTS_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    suffix = f"{label} {SNAPSHOT_SUFFIX}" if label else SNAPSHOT_SUFFIX
    path = os.path.join(SNAPSHOTS_DIR, f"[{ts}] {suffix}")

    with open(path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "database_path": database_path,
                "performers": performers,
                "scenes": scenes,
            },
            f,
            indent=2,
            default=str,
        )

    log.info(f"Exported snapshot to {path}")
    return path, len(performers), len(scenes)


def task_snapshot_export(stash, _input, _scope=None):
    """Writes a full performer/scene snapshot via `_write_snapshot` and
    returns a human-readable summary of what was exported.
    """
    path, performer_count, scene_count = _write_snapshot(stash)
    return f"Exported {performer_count} performers, {scene_count} scenes to {path}"


def task_snapshot_import(stash, _input, _scope=None):
    """Applies the most recent snapshot file back onto the live Stash
    instance. Performers are matched by ID (same database) or name
    (different database, skipping ambiguous/unknown names); scenes are only
    applied when the snapshot's recorded database_path matches the live one,
    since scene IDs have no natural key stable across databases. See the
    inline comments below for the full matching logic.
    """
    if not os.path.exists(SNAPSHOTS_DIR):
        raise FileNotFoundError("Snapshots directory not found.")

    # Filenames are "[YYYY-MM-DD-HHMMSS] Xenith Snapshot.json", so lexicographic
    # reverse sort is equivalent to newest-first; don't change the timestamp format.
    files = sorted(
        [f for f in os.listdir(SNAPSHOTS_DIR) if f.endswith(SNAPSHOT_SUFFIX)],
        reverse=True,
    )
    if not files:
        raise FileNotFoundError("No snapshot files found.")

    with open(os.path.join(SNAPSHOTS_DIR, files[0]), encoding="utf-8") as f:
        data = json.load(f)

    # Same database_path check used for scenes below — computed once up front
    # so performers can also use it (ID match when verified same-database,
    # since IDs are stable within one database but not across databases).
    snapshot_database_path = data.get("database_path")
    live_database_path = _database_path(stash)
    same_database = (
        snapshot_database_path is not None
        and snapshot_database_path == live_database_path
    )
    log.debug(
        f"Snapshot import database check: snapshot={snapshot_database_path!r} "
        f"live={live_database_path!r} same_database={same_database}"
    )

    # Build id set and name -> id, tracking names that collide within the
    # CURRENT library (Stash permits duplicate performer names) so we never
    # guess which of two same-named performers a snapshot entry belongs to.
    current_ids = set()
    name_to_id = {}
    ambiguous_names = set()
    for p in stash.find_performers(filter={"per_page": -1}, fragment="id name"):
        current_ids.add(p["id"])
        key = p["name"].lower()
        if key in name_to_id:
            ambiguous_names.add(key)
        else:
            name_to_id[key] = p["id"]

    imported = 0
    skipped_unknown = 0
    skipped_ambiguous = 0
    for p in data.get("performers", []):
        # Same database: IDs are a stable natural key, so match directly and
        # skip the name-collision guesswork entirely. Falls through to name
        # matching for a snapshot ID no longer present (e.g. deleted since
        # export) rather than treating it as unknown outright.
        if same_database and p.get("id") in current_ids:
            pid = p["id"]
        else:
            key = p["name"].lower()
            if key in ambiguous_names:
                log.debug(f"Skipping ambiguous performer name: {p['name']}")
                skipped_ambiguous += 1
                continue
            pid = name_to_id.get(key)
            if not pid:
                log.debug(f"Skipping unknown performer: {p['name']}")
                skipped_unknown += 1
                continue
        # "partial" merges instead of overwriting custom_fields; a plain dict here
        # would wipe any keys not present in the snapshot.
        update = {
            "id": pid,
            "custom_fields": {"partial": p.get("custom_fields") or {}},
        }
        # Only touch rating100 if the snapshot entry actually captured one —
        # an absent/None value means "never rated in the snapshot", not
        # "clear the current rating".
        if p.get("rating100") is not None:
            update["rating100"] = p["rating100"]
        stash.update_performer(update)
        imported += 1

    # Scenes have no natural key stable across databases (titles aren't unique,
    # files get renamed), unlike performers which are matched by ID/name above.
    # So instead of remapping, refuse to apply scene data unless the snapshot
    # was taken from this exact Stash database — an unverifiable match (missing
    # or mismatched database_path, e.g. an older snapshot predating this field)
    # is treated as "different database" and scenes are skipped entirely rather
    # than silently writing ratings onto whatever scene happens to hold that ID.
    scene_count = 0
    skipped_scenes_database_mismatch = 0
    for s in data.get("scenes", []):
        if not same_database:
            skipped_scenes_database_mismatch += 1
            continue
        update = {
            "id": s["id"],
            "custom_fields": {"partial": s.get("custom_fields") or {}},
        }
        if s.get("rating100") is not None:
            update["rating100"] = s["rating100"]
        stash.update_scene(update)
        scene_count += 1

    scene_skip_note = (
        ": snapshot is from a different or unverified database"
        if skipped_scenes_database_mismatch
        else ""
    )
    message = (
        f"Imported {imported} performers, {scene_count} scenes from {files[0]} "
        f"(skipped {skipped_unknown} unknown, {skipped_ambiguous} ambiguous "
        f"performers; skipped {skipped_scenes_database_mismatch} scenes"
        f"{scene_skip_note})"
    )
    log.info(message)
    return message


# Old key -> new key. Must match STATS_KEY/RECORD_KEY and their LEGACY_*
# counterparts in src/matchmaking.js.
STATS_KEY_MIGRATION = ("hotornot_stats", "xenith_stats")
RECORD_KEY_MIGRATION = ("performer_record", "xenith_record")


def task_migrate(stash, _input, _scope=None):
    """Copies legacy hotornot_stats/performer_record data to the xenith_
    namespace, then removes the legacy keys. Idempotent: a field already
    copied to its new key is never re-copied or overwritten, so re-running
    after further matches have been played can't clobber fresh data with a
    stale one, and a second run is a genuine no-op.

    Scenes only ever wrote the legacy hotornot_stats key, never the legacy
    performer_record key (that name predates scenes writing xenith_record at
    all), so only the stats key is migrated for scenes.
    """
    snapshot_path, _, _ = _write_snapshot(stash, label="Pre-Migration")

    old_stats_key, new_stats_key = STATS_KEY_MIGRATION
    old_record_key, new_record_key = RECORD_KEY_MIGRATION

    performers = stash.find_performers(filter={"per_page": -1}, fragment="id custom_fields")
    performers_copied = 0
    for p in performers:
        cf = p.get("custom_fields") or {}
        partial = {}
        if old_stats_key in cf and new_stats_key not in cf:
            partial[new_stats_key] = cf[old_stats_key]
        if old_record_key in cf and new_record_key not in cf:
            partial[new_record_key] = cf[old_record_key]
        if partial:
            stash.update_performer({"id": p["id"], "custom_fields": {"partial": partial}})
            performers_copied += 1
    if performers:
        stash.update_performers(
            {
                "ids": [p["id"] for p in performers],
                "custom_fields": {"remove": [old_stats_key, old_record_key]},
            }
        )

    scenes = stash.find_scenes(filter={"per_page": -1}, fragment="id custom_fields")
    scenes_copied = 0
    for s in scenes:
        cf = s.get("custom_fields") or {}
        if old_stats_key in cf and new_stats_key not in cf:
            stash.update_scene(
                {"id": s["id"], "custom_fields": {"partial": {new_stats_key: cf[old_stats_key]}}}
            )
            scenes_copied += 1
    if scenes:
        stash.update_scenes(
            {
                "ids": [s["id"] for s in scenes],
                "custom_fields": {"remove": [old_stats_key]},
            }
        )

    message = (
        f"Migrated {performers_copied} performers, {scenes_copied} scenes to the "
        f"xenith_ field namespace. Pre-migration snapshot: {snapshot_path}"
    )
    log.info(message)
    return message


TASKS = {
    "wipe": task_wipe,
    "reset": task_reset,
    "snapshot_export": task_snapshot_export,
    "snapshot_import": task_snapshot_import,
    "migrate": task_migrate,
}

_LOG_LEVELS = {"debug": log.debug, "info": log.info, "warning": log.warning}


def handle_log_operation(args):
    """Writes a batch of match-result lines (src/stash-log.js) to Stash's
    log. Not a task: takes no `stash`/`scope`, invoked directly by main.py
    for runPluginOperation calls rather than through TASKS.
    """
    level = _LOG_LEVELS.get(args.get("level"), log.debug)
    lines = args.get("lines") or []
    for line in lines:
        level(line)
    return {"logged": len(lines)}
