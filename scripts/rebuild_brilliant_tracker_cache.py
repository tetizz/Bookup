from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from bookup.analysis import _build_game_brilliant_tracker
from bookup.app import (
    STORE,
    build_engine_settings,
    close_live_engine,
    clear_runtime_caches,
    load_config,
    migrate_engine_defaults,
    shared_engine_for,
)
from bookup.storage import deserialize_games


def _tracker_summary(tracker: dict[str, Any] | None) -> dict[str, int]:
    summary = (tracker or {}).get("summary") or {}
    return {
        "total_brilliants": int(summary.get("total_brilliants", 0) or 0),
        "games_with_brilliants": int(summary.get("games_with_brilliants", 0) or 0),
        "moves_scanned": int(summary.get("moves_scanned", 0) or 0),
        "classified_moves": int(summary.get("classified_moves", 0) or 0),
    }


def _rebuild_tracker_for_payload(
    *,
    games_payload: list[dict[str, Any]],
    profile_payload: dict[str, Any],
    engine: Any,
) -> dict[str, Any]:
    games = deserialize_games(list(games_payload))
    if not games:
        raise ValueError("No cached games were available to rebuild the Brilliant tracker.")
    lessons = list(profile_payload.get("previewable_lines") or [])
    tracker = _build_game_brilliant_tracker(games, lessons, engine)
    updated_profile = dict(profile_payload)
    updated_profile["brilliant_tracker"] = tracker
    return updated_profile


def rebuild_username(username: str) -> dict[str, Any]:
    config = migrate_engine_defaults(load_config())
    settings = build_engine_settings(config)
    cleared_engine_cache = STORE.clear_shared_engine_cache()
    clear_runtime_caches(include_explorer=False, include_engine_cache=True)
    engine = shared_engine_for(settings)

    repaired_entries: list[dict[str, Any]] = []

    snapshot = STORE.load_snapshot(username)
    snapshot_path = STORE._user_dir(username) / "snapshot.json"
    if snapshot and isinstance(snapshot.get("profile"), dict) and snapshot.get("games"):
        before = _tracker_summary(snapshot.get("profile", {}).get("brilliant_tracker"))
        snapshot["profile"] = _rebuild_tracker_for_payload(
            games_payload=list(snapshot.get("games") or []),
            profile_payload=dict(snapshot.get("profile") or {}),
            engine=engine,
        )
        STORE.save_snapshot(username, snapshot)
        after = _tracker_summary(snapshot.get("profile", {}).get("brilliant_tracker"))
        repaired_entries.append(
            {
                "kind": "snapshot",
                "path": str(snapshot_path),
                "before": before,
                "after": after,
            }
        )

    profile_dir = STORE._cache_dir(username, "profiles")
    for cache_path in sorted(profile_dir.glob("*.json")):
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        profile_payload = cached.get("profile")
        games_payload = cached.get("games") or []
        if not isinstance(profile_payload, dict) or not games_payload:
            continue
        before = _tracker_summary(profile_payload.get("brilliant_tracker"))
        cached["profile"] = _rebuild_tracker_for_payload(
            games_payload=list(games_payload),
            profile_payload=dict(profile_payload),
            engine=engine,
        )
        cached["saved_at"] = datetime.now(timezone.utc).isoformat()
        STORE._write_json(cache_path, cached)
        after = _tracker_summary(cached.get("profile", {}).get("brilliant_tracker"))
        repaired_entries.append(
            {
                "kind": "cached_profile",
                "path": str(cache_path),
                "before": before,
                "after": after,
            }
        )

    close_live_engine()
    return {
        "username": username,
        "cleared_engine_cache": cleared_engine_cache,
        "settings": {
            "engine_path": settings.path,
            "depth": settings.depth,
            "threads": settings.threads,
            "hash_mb": settings.hash_mb,
            "multipv": settings.multipv,
            "think_time_sec": settings.think_time_sec,
            "parallel_workers": settings.parallel_workers,
        },
        "entries": repaired_entries,
    }


def main() -> int:
    config = migrate_engine_defaults(load_config())
    parser = argparse.ArgumentParser(description="Rebuild Brilliant tracker data from cached Bookup games.")
    parser.add_argument(
        "--username",
        default=str(config.get("username", "")).strip(),
        help="Bookup username cache folder to repair.",
    )
    args = parser.parse_args()
    username = str(args.username or "").strip()
    if not username:
        raise SystemExit("No username was provided and config.json does not define one.")
    result = rebuild_username(username)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
