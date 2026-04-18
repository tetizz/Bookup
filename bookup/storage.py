from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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

    def _write_json(self, path: Path, payload: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

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
