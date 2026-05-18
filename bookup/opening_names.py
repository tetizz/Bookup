from __future__ import annotations

import csv
import json
import re
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
_OPENING_PREFIXES: dict[tuple[str, ...], int] | None = None

_PGN_MOVE_TOKEN_RE = re.compile(r"^\d+\.(\.\.)?")
_PGN_RESULT_TOKENS = {"*", "1-0", "0-1", "1/2-1/2"}
_PREFIX_KEY_SEPARATOR = "\u241f"


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
    prefixes: dict[str, int] = {}
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
            tokens = _normalize_pgn_tokens(pgn)
            if tokens:
                for length in range(1, min(len(tokens), 20) + 1):
                    prefix_key = _PREFIX_KEY_SEPARATOR.join(tokens[:length])
                    prefixes[prefix_key] = prefixes.get(prefix_key, 0) + 1
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
        "prefixes": prefixes,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(payload), encoding="utf-8")
    return payload


def _payload_has_pgn(payload: dict[str, Any]) -> bool:
    by_epd = payload.get("by_epd", {})
    if not isinstance(by_epd, dict) or not by_epd:
        return False
    for item in by_epd.values():
        if isinstance(item, dict) and "pgn" in item:
            return True
    return False


def _payload_has_prefixes(payload: dict[str, Any]) -> bool:
    prefixes = payload.get("prefixes", {})
    return isinstance(prefixes, dict) and bool(prefixes)


def load_dataset() -> dict[str, Any]:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    if CACHE_PATH.exists():
        try:
            payload = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
            if _cache_is_fresh(payload) and _payload_has_pgn(payload) and _payload_has_prefixes(payload):
                _CACHE = payload
                return payload
        except Exception:
            pass
    try:
        _CACHE = _download_dataset()
    except Exception:
        _CACHE = {"by_epd": {}, "by_eco": {}, "fetched_at": ""}
    return _CACHE


def _normalize_pgn_tokens(pgn: str) -> list[str]:
    tokens: list[str] = []
    for raw in str(pgn or "").replace("\n", " ").split():
        token = raw.strip()
        if not token or token in _PGN_RESULT_TOKENS:
            continue
        if _PGN_MOVE_TOKEN_RE.match(token):
            cleaned = _PGN_MOVE_TOKEN_RE.sub("", token, count=1).strip()
            if not cleaned:
                continue
            token = cleaned
        token = (
            token.replace("!!", "")
            .replace("??", "")
            .replace("!?", "")
            .replace("?!", "")
            .replace("!", "")
            .replace("?", "")
        )
        if token:
            tokens.append(token)
    return tokens


def _load_opening_prefixes() -> dict[tuple[str, ...], int]:
    global _OPENING_PREFIXES
    if _OPENING_PREFIXES is not None:
        return _OPENING_PREFIXES

    payload = load_dataset()
    raw_prefixes = payload.get("prefixes", {})
    prefixes: dict[tuple[str, ...], int] = {}
    if isinstance(raw_prefixes, dict) and raw_prefixes:
        for raw_key, count in raw_prefixes.items():
            tokens = tuple(str(raw_key or "").split(_PREFIX_KEY_SEPARATOR))
            if not tokens or any(not token for token in tokens):
                continue
            prefixes[tokens] = int(count or 0)
    else:
        for item in payload.get("by_epd", {}).values():
            if not isinstance(item, dict):
                continue
            tokens = _normalize_pgn_tokens(str(item.get("pgn", "") or ""))
            if not tokens:
                continue
            for length in range(1, min(len(tokens), 20) + 1):
                prefix = tuple(tokens[:length])
                prefixes[prefix] = prefixes.get(prefix, 0) + 1
    _OPENING_PREFIXES = prefixes
    return _OPENING_PREFIXES


def opening_prefix_count(tokens: list[str]) -> int:
    if not tokens:
        return 0
    return int(_load_opening_prefixes().get(tuple(tokens), 0) or 0)


def matches_opening_prefix(tokens: list[str]) -> bool:
    return opening_prefix_count(tokens) > 0


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
