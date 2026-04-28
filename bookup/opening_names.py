from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import chess
import requests


PACKAGE_DIR = Path(__file__).resolve().parent
ROOT_DIR = Path(__file__).resolve().parent.parent
RUNTIME_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else ROOT_DIR
DATA_DIR = RUNTIME_DIR / "bookup_data"
CACHE_PATH = DATA_DIR / "lichess_openings_cache.json"
FALLBACK_OPENINGS_PATH = PACKAGE_DIR / "resources" / "openings_fallback.json"
DATASET_BASE = "https://raw.githubusercontent.com/lichess-org/chess-openings/master"
DATASET_FILES = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"]

_CACHE: dict[str, Any] | None = None
_FALLBACK_OPENINGS: dict[str, str] | None = None


def _cache_is_fresh(payload: dict[str, Any]) -> bool:
    fetched_at = str(payload.get("fetched_at", ""))
    if not fetched_at:
        return False
    try:
        timestamp = datetime.fromisoformat(fetched_at)
    except ValueError:
        return False
    return datetime.now(timezone.utc) - timestamp <= timedelta(days=30)


def _download_dataset() -> dict[str, Any]:
    by_epd: dict[str, dict[str, str]] = {}
    by_eco: dict[str, str] = {}
    session = requests.Session()
    session.headers.update({"User-Agent": "Bookup/1.0 (local repertoire trainer)"})

    for file_name in DATASET_FILES:
        response = session.get(f"{DATASET_BASE}/{file_name}", timeout=20)
        response.raise_for_status()
        reader = csv.DictReader(response.text.splitlines(), delimiter="\t")
        for row in reader:
            eco = str(row.get("eco", "") or "").strip().upper()
            name = str(row.get("name", "") or "").strip()
            epd = str(row.get("epd", "") or "").strip()
            pgn = str(row.get("pgn", "") or "").strip()
            if eco and name and eco not in by_eco:
                by_eco[eco] = name
            if epd and name:
                current = by_epd.get(epd)
                candidate = {"name": name, "eco": eco, "pgn": pgn}
                if current is None or len(candidate["pgn"]) < len(current.get("pgn", "")):
                    by_epd[epd] = candidate

    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "by_epd": by_epd,
        "by_eco": by_eco,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(payload), encoding="utf-8")
    return payload


def load_dataset() -> dict[str, Any]:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    if CACHE_PATH.exists():
        try:
            payload = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
            if _cache_is_fresh(payload):
                _CACHE = payload
                return payload
        except Exception:
            pass
    try:
        _CACHE = _download_dataset()
    except Exception:
        _CACHE = {"by_epd": {}, "by_eco": {}, "fetched_at": ""}
    return _CACHE


def _load_fallback_openings() -> dict[str, str]:
    global _FALLBACK_OPENINGS
    if _FALLBACK_OPENINGS is not None:
        return _FALLBACK_OPENINGS
    try:
        payload = json.loads(FALLBACK_OPENINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        _FALLBACK_OPENINGS = {}
        return _FALLBACK_OPENINGS
    _FALLBACK_OPENINGS = {
        str(key or "").strip(): str(value or "").strip()
        for key, value in payload.items()
        if str(key or "").strip() and str(value or "").strip()
    }
    return _FALLBACK_OPENINGS


def lookup_by_board(board: chess.Board) -> dict[str, str]:
    payload = load_dataset()
    match = payload.get("by_epd", {}).get(board.epd())
    if match:
        return {
            "name": str(match.get("name", "") or ""),
            "eco": str(match.get("eco", "") or "").upper(),
        }
    fallback_name = _load_fallback_openings().get(board.board_fen(), "")
    if not fallback_name:
        return {}
    return {
        "name": fallback_name,
        "eco": "",
    }


def lookup_by_eco(eco: str) -> str:
    payload = load_dataset()
    return str(payload.get("by_eco", {}).get(eco.upper(), "") or "")
