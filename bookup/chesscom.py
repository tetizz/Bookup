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


def fetch_archives(username: str) -> list[str]:
    return list(_get_json(f"https://api.chess.com/pub/player/{username}/games/archives").get("archives", []))


def normalize_time_classes(values: Iterable[str]) -> set[str]:
    normalized = {value.strip().lower() for value in values if value.strip()}
    if not normalized or normalized == {"all"}:
        return set()
    return normalized


def fetch_games(username: str, time_classes: Iterable[str], max_games: int) -> list[ImportedGame]:
    target = normalize_time_classes(time_classes)
    archives = fetch_archives(username)
    imported: list[ImportedGame] = []
    username_lc = username.lower()

    for archive_url in reversed(archives):
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
            if len(imported) >= max_games:
                return imported
    return imported
