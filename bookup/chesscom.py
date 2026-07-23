from __future__ import annotations

import io
from dataclasses import dataclass
from concurrent.futures import ThreadPoolExecutor
from typing import Iterable

import chess.pgn
import requests


HEADERS = {
    "User-Agent": "Bookup/0.2 (contact: https://github.com/tetizz/Bookup)",
}
TIME_CLASSES = frozenset({"bullet", "blitz", "rapid", "daily"})


@dataclass(slots=True)
class ImportedGame:
    url: str
    time_class: str
    player_color: str
    result: str
    opponent: str
    pgn: str
    game: chess.pgn.Game


class ImportedGames(list[ImportedGame]):
    """List-compatible archive import with non-fatal month warnings."""

    def __init__(
        self,
        games: Iterable[ImportedGame] = (),
        *,
        warnings: Iterable[str] = (),
        failed_archives: Iterable[str] = (),
    ) -> None:
        super().__init__(games)
        self.warnings = list(warnings)
        self.failed_archives = list(failed_archives)


class ArchiveImportError(RuntimeError):
    def __init__(self, message: str, *, warnings: Iterable[str] = ()) -> None:
        super().__init__(message)
        self.warnings = list(warnings)


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
    normalized = {str(value).strip().lower() for value in values if str(value).strip()}
    if not normalized or normalized == {"all"}:
        return set()
    if "all" in normalized:
        raise ValueError("Use all by itself, or choose specific time classes.")
    unsupported = normalized - TIME_CLASSES
    if unsupported:
        invalid = ", ".join(sorted(unsupported))
        raise ValueError(f"Unsupported time class: {invalid}. Use rapid, blitz, bullet, daily, or all.")
    return normalized


def infer_time_class(headers: dict[str, str]) -> str:
    explicit = str(headers.get("TimeClass", "")).lower().strip()
    if explicit in TIME_CLASSES:
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
    if total >= 86400:
        return "daily"
    if total >= 600:
        return "rapid"
    if total >= 180:
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


def _import_from_month_json(username_lc: str, month: dict, target: set[str], max_games: int | None = None) -> list[ImportedGame]:
    imported: list[ImportedGame] = []
    for raw_game in reversed(month.get("games", [])):
        time_class = infer_time_class(
            {
                "TimeClass": str(raw_game.get("time_class", "") or ""),
                "TimeControl": str(raw_game.get("time_control", "") or ""),
            }
        )
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
            break
    return imported


def _fetch_archive_games(archive_url: str, username_lc: str, target: set[str]) -> list[ImportedGame]:
    imported: list[ImportedGame] = []
    pgn_loaded = False
    try:
        pgn_blob = _get_text(f"{archive_url}/pgn")
        pgn_loaded = _import_from_pgn_blob(username_lc, pgn_blob, target, imported, None)
    except Exception:
        pgn_loaded = False

    if pgn_loaded:
        return imported

    month = _get_json(archive_url)
    return _import_from_month_json(username_lc, month, target, None)


def fetch_games(
    username: str,
    time_classes: Iterable[str],
    max_games: int | None,
    archives: list[str] | None = None,
) -> ImportedGames:
    target = normalize_time_classes(time_classes)
    archives = archives if archives is not None else fetch_archives(username)
    imported: list[ImportedGame] = []
    warnings: list[str] = []
    failed_archives: list[str] = []
    username_lc = username.lower()
    ordered_archives = list(reversed(archives))

    batch_size = min(3, max(1, len(ordered_archives)))
    try:
        with ThreadPoolExecutor(max_workers=batch_size) as executor:
            for offset in range(0, len(ordered_archives), batch_size):
                batch = ordered_archives[offset:offset + batch_size]
                futures = [
                    executor.submit(_fetch_archive_games, archive_url, username_lc, target)
                    for archive_url in batch
                ]
                for archive_url, future in zip(batch, futures):
                    try:
                        imported.extend(future.result())
                    except Exception as exc:
                        failed_archives.append(archive_url)
                        warnings.append(_archive_warning(archive_url, exc))
                    if max_games is not None and len(imported) >= max_games:
                        return ImportedGames(
                            imported[:max_games],
                            warnings=warnings,
                            failed_archives=failed_archives,
                        )
    except RuntimeError:
        imported.clear()
        warnings.clear()
        failed_archives.clear()
        for archive_url in ordered_archives:
            try:
                imported.extend(_fetch_archive_games(archive_url, username_lc, target))
            except Exception as exc:
                failed_archives.append(archive_url)
                warnings.append(_archive_warning(archive_url, exc))
            if max_games is not None and len(imported) >= max_games:
                imported = imported[:max_games]
                break
        return _finalize_import(imported, warnings, failed_archives, ordered_archives)

    return _finalize_import(imported, warnings, failed_archives, ordered_archives)


def _archive_warning(archive_url: str, exc: Exception) -> str:
    month = "/".join(str(archive_url).rstrip("/").split("/")[-2:]) or "unknown archive"
    detail = str(exc).strip() or exc.__class__.__name__
    return f"{month}: {detail}"


def _finalize_import(
    imported: list[ImportedGame],
    warnings: list[str],
    failed_archives: list[str],
    ordered_archives: list[str],
) -> ImportedGames:
    if not imported and failed_archives:
        failed = len(failed_archives)
        total = len(ordered_archives)
        raise ArchiveImportError(
            f"No games could be imported because {failed} of {total} Chess.com archives failed.",
            warnings=warnings,
        )
    return ImportedGames(imported, warnings=warnings, failed_archives=failed_archives)
