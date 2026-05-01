from __future__ import annotations

import hashlib
import io
import json
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import chess.pgn

from .chesscom import ImportedGame


def _safe_slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-")
    return cleaned or "default"


class LocalStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _user_dir(self, username: str) -> Path:
        path = self.root / _safe_slug(username)
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _read_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default

    def _write_json(self, path: Path, payload: Any, *, pretty: bool = False) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        encoded = json.dumps(
            payload,
            indent=2 if pretty else None,
            separators=None if pretty else (",", ":"),
        )
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as handle:
            handle.write(encoded)
            temp_path = Path(handle.name)
        temp_path.replace(path)

    def _cache_dir(self, username: str, kind: str) -> Path:
        path = self._user_dir(username) / "cache" / kind
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _cache_path(self, username: str, kind: str, key: str) -> Path:
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        return self._cache_dir(username, kind) / f"{digest}.json"

    def _shared_cache_path(self, kind: str, key: str) -> Path:
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        path = self.root / "_shared" / "cache" / kind
        path.mkdir(parents=True, exist_ok=True)
        return path / f"{digest}.json"

    def load_snapshot(self, username: str) -> dict[str, Any]:
        user_dir = self._user_dir(username)
        return self._read_json(user_dir / "snapshot.json", {})

    def save_snapshot(self, username: str, payload: dict[str, Any]) -> None:
        user_dir = self._user_dir(username)
        snapshot = dict(payload)
        snapshot["saved_at"] = datetime.now(timezone.utc).isoformat()
        self._write_json(user_dir / "snapshot.json", snapshot)

    def load_progress(self, username: str) -> dict[str, Any]:
        user_dir = self._user_dir(username)
        return self._read_json(user_dir / "progress.json", {"lessons": {}, "summary": {}})

    def save_progress(self, username: str, payload: dict[str, Any]) -> None:
        user_dir = self._user_dir(username)
        progress = dict(payload)
        progress["saved_at"] = datetime.now(timezone.utc).isoformat()
        self._write_json(user_dir / "progress.json", progress)

    def load_cached_profile(self, username: str, request_key: str) -> dict[str, Any]:
        return self._read_json(self._cache_path(username, "profiles", request_key), {})

    def save_cached_profile(self, username: str, request_key: str, payload: dict[str, Any]) -> None:
        cached = dict(payload)
        cached["request_key"] = request_key
        cached["saved_at"] = datetime.now(timezone.utc).isoformat()
        self._write_json(self._cache_path(username, "profiles", request_key), cached)

    def load_cached_games(self, username: str, request_key: str) -> dict[str, Any]:
        return self._read_json(self._cache_path(username, "games", request_key), {})

    def save_cached_games(self, username: str, request_key: str, payload: dict[str, Any]) -> None:
        cached = dict(payload)
        cached["request_key"] = request_key
        cached["saved_at"] = datetime.now(timezone.utc).isoformat()
        self._write_json(self._cache_path(username, "games", request_key), cached)

    def load_engine_cache(self, key: str) -> dict[str, Any]:
        return self._read_json(self._shared_cache_path("engine", key), {})

    def save_engine_cache(self, key: str, payload: dict[str, Any]) -> None:
        cached = dict(payload)
        cached["request_key"] = key
        cached["saved_at"] = datetime.now(timezone.utc).isoformat()
        self._write_json(self._shared_cache_path("engine", key), cached)

    def cache_stats(self, username: str = "") -> dict[str, Any]:
        shared_engine_dir = self.root / "_shared" / "cache" / "engine"
        engine_files = list(shared_engine_dir.glob("*.json")) if shared_engine_dir.exists() else []
        engine_bytes = sum(path.stat().st_size for path in engine_files if path.exists())
        user_dir = self._user_dir(username) if username else None
        profile_dir = user_dir / "cache" / "profiles" if user_dir else None
        games_dir = user_dir / "cache" / "games" if user_dir else None
        profile_files = list(profile_dir.glob("*.json")) if profile_dir and profile_dir.exists() else []
        games_files = list(games_dir.glob("*.json")) if games_dir and games_dir.exists() else []
        return {
            "engine_entries": len(engine_files),
            "engine_bytes": engine_bytes,
            "profile_entries": len(profile_files),
            "game_entries": len(games_files),
            "total_entries": len(engine_files) + len(profile_files) + len(games_files),
            "total_bytes": engine_bytes
            + sum(path.stat().st_size for path in profile_files if path.exists())
            + sum(path.stat().st_size for path in games_files if path.exists()),
            "cache_root": str(self.root),
        }


def serialize_games(imported_games: list[ImportedGame]) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for game in imported_games:
        headers = game.game.headers
        serialized.append(
            {
                "url": game.url,
                "time_class": game.time_class,
                "player_color": game.player_color,
                "result": game.result,
                "opponent": game.opponent,
                "date": str(headers.get("Date", "")),
                "eco": str(headers.get("ECO", "")),
                "opening": str(headers.get("Opening", "")),
                "variation": str(headers.get("Variation", "")),
                "pgn": game.pgn,
            }
        )
    return serialized


def deserialize_games(serialized_games: list[dict[str, Any]]) -> list[ImportedGame]:
    restored: list[ImportedGame] = []
    for entry in serialized_games:
        pgn_text = str(entry.get("pgn", "") or "").strip()
        if not pgn_text:
            continue
        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if game is None:
            continue
        restored.append(
            ImportedGame(
                url=str(entry.get("url", "")),
                time_class=str(entry.get("time_class", "")),
                player_color=str(entry.get("player_color", "")),
                result=str(entry.get("result", "")),
                opponent=str(entry.get("opponent", "")),
                pgn=pgn_text,
                game=game,
            )
        )
    return restored
