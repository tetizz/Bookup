from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Iterable

import chess.pgn
import requests


HEADERS = {
    "User-Agent": "Bookup/0.2 (username: trixize1234; contact: https://github.com/tetizz/Bookup)",
}


@dataclass(slots=True)
class ImportedGame:
    url: str
    time_class: str
    player_color: str
    result: str
    opponent: str
    pgn: str
    game: chess.pgn.Game


def _get_json(url: str) -> dict:
    response = requests.get(url, headers=HEADERS, timeout=25)
    response.raise_for_status()
    return response.json()


def _get_text(url: str) -> str:
    response = requests.get(url, headers=HEADERS, timeout=40)
    response.raise_for_status()
    return response.text


def fetch_archives(username: str) -> list[str]:
    return list(_get_json(f"https://api.chess.com/pub/player/{username}/games/archives").get("archives", []))


def normalize_time_classes(values: Iterable[str]) -> set[str]:
    normalized = {value.strip().lower() for value in values if value.strip()}
    if not normalized or normalized == {"all"}:
        return set()
    return normalized


def infer_time_class(headers: dict[str, str]) -> str:
    explicit = str(headers.get("TimeClass", "")).lower().strip()
    if explicit:
        return explicit
    raw = str(headers.get("TimeControl", "")).strip()
    if raw in {"", "-", "?"}:
        return "unknown"
    if "/" in raw:
        raw = raw.split("/", 1)[-1]
    if "+" in raw:
        base, inc = raw.split("+", 1)
        try:
            total = int(base or 0) + 40 * int(inc or 0)
        except ValueError:
            total = 0
    else:
        try:
            total = int(raw)
        except ValueError:
            total = 0
    if total >= 1500:
        return "daily"
    if total >= 480:
        return "rapid"
    if total >= 120:
        return "blitz"
    if total > 0:
        return "bullet"
    return "unknown"


def _iter_month_pgn_games(pgn_blob: str) -> Iterable[chess.pgn.Game]:
    handle = io.StringIO(pgn_blob)
    while True:
        game = chess.pgn.read_game(handle)
        if game is None:
            break
        yield game


def _import_from_pgn_blob(username_lc: str, pgn_blob: str, target: set[str], imported: list[ImportedGame], max_games: int | None) -> bool:
    found_any = False
    for game in _iter_month_pgn_games(pgn_blob):
        headers = game.headers
        white_name = str(headers.get("White", ""))
        black_name = str(headers.get("Black", ""))
        if white_name.lower() == username_lc:
            color = "white"
            opponent = black_name or "Unknown"
            result = str(headers.get("Result", ""))
        elif black_name.lower() == username_lc:
            color = "black"
            opponent = white_name or "Unknown"
            result = str(headers.get("Result", ""))
        else:
            continue

        time_class = infer_time_class(headers)
        if target and time_class not in target:
            continue

        pgn_text = str(game)
        imported.append(
            ImportedGame(
                url=str(headers.get("Link", "")),
                time_class=time_class,
                player_color=color,
                result=result,
                opponent=opponent,
                pgn=pgn_text,
                game=game,
            )
        )
        found_any = True
        if max_games is not None and len(imported) >= max_games:
            return True
    return found_any


def fetch_games(username: str, time_classes: Iterable[str], max_games: int | None) -> list[ImportedGame]:
    target = normalize_time_classes(time_classes)
    archives = fetch_archives(username)
    imported: list[ImportedGame] = []
    username_lc = username.lower()

    for archive_url in reversed(archives):
        pgn_loaded = False
        try:
            pgn_blob = _get_text(f"{archive_url}/pgn")
            pgn_loaded = _import_from_pgn_blob(username_lc, pgn_blob, target, imported, max_games)
            if max_games is not None and len(imported) >= max_games:
                return imported
        except Exception:
            pgn_loaded = False

        if pgn_loaded:
            continue

        month = _get_json(archive_url)
        for raw_game in reversed(month.get("games", [])):
            time_class = str(raw_game.get("time_class", "")).lower()
            if target and time_class not in target:
                continue
            white = raw_game.get("white", {})
            black = raw_game.get("black", {})
            if str(white.get("username", "")).lower() == username_lc:
                color = "white"
                opponent = str(black.get("username", "Unknown"))
                result = str(white.get("result", ""))
            elif str(black.get("username", "")).lower() == username_lc:
                color = "black"
                opponent = str(white.get("username", "Unknown"))
                result = str(black.get("result", ""))
            else:
                continue

            pgn_text = str(raw_game.get("pgn", ""))
            game = chess.pgn.read_game(io.StringIO(pgn_text))
            if game is None:
                continue
            imported.append(
                ImportedGame(
                    url=str(raw_game.get("url", "")),
                    time_class=time_class,
                    player_color=color,
                    result=result,
                    opponent=opponent,
                    pgn=pgn_text,
                    game=game,
                )
            )
            if max_games is not None and len(imported) >= max_games:
                return imported
    return imported
