from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path

import chess.pgn


PRINTABLE_RUN = re.compile(rb"[\t\n\r\x20-\x7e]{18,}")
MOVE_NUMBER_PATTERN = re.compile(r"(?:^|\s)1\.(?:\s|[A-Za-z0-9O\-])")
RESULT_PATTERN = re.compile(r"(?:\s(?:1-0|0-1|1/2-1/2|\*))?\s*$")


@dataclass(slots=True)
class ChessnutImportBundle:
    pgn_text: str
    game_count: int
    db_path: str


def default_chessnut_db_path() -> str:
    home = Path.home()
    candidates = [
        home / "OneDrive" / "Documents" / "chessnut" / "data.mdb",
        home / "Documents" / "chessnut" / "data.mdb",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return str(candidates[0])


def extract_chessnut_games_as_pgn(
    db_path: str = "",
    *,
    username: str = "",
    player_color: str = "white",
) -> ChessnutImportBundle:
    resolved = Path(db_path or default_chessnut_db_path()).expanduser()
    if not resolved.exists():
        raise FileNotFoundError(f"Chessnut database not found at {resolved}")

    raw_bytes = resolved.read_bytes()
    printable_chunks = [match.group(0).decode("utf-8", errors="ignore") for match in PRINTABLE_RUN.finditer(raw_bytes)]
    candidates = _candidate_movetexts(printable_chunks)
    wrapped_games: list[str] = []
    normalized_seen: set[str] = set()

    clean_username = str(username or "").strip() or "Bookup Player"
    color = "black" if str(player_color or "").strip().lower() == "black" else "white"

    for movetext in candidates:
        normalized = _normalize_movetext(movetext)
        if not normalized or normalized in normalized_seen:
            continue
        pgn_text = _wrap_movetext_as_pgn(normalized, username=clean_username, player_color=color)
        if not _is_valid_pgn(pgn_text):
            continue
        normalized_seen.add(normalized)
        wrapped_games.append(pgn_text)

    if not wrapped_games:
        raise ValueError("No usable OTB games were found inside the Chessnut database.")

    combined = "\n\n".join(wrapped_games).strip() + "\n"
    return ChessnutImportBundle(
        pgn_text=combined,
        game_count=len(wrapped_games),
        db_path=str(resolved),
    )


def _candidate_movetexts(chunks: list[str]) -> list[str]:
    candidates: list[str] = []
    for chunk in chunks:
        text = chunk.replace("\r", "\n").strip()
        if not MOVE_NUMBER_PATTERN.search(text):
            continue
        if text.lstrip().startswith("[Event "):
            body = _extract_movetext_from_pgn(text)
        else:
            start = text.find("1.")
            body = text[start:] if start >= 0 else text
        body = body.strip()
        if len(body) < 12:
            continue
        candidates.append(body)
    return candidates


def _extract_movetext_from_pgn(text: str) -> str:
    parts = text.split("\n\n", 1)
    if len(parts) == 2 and MOVE_NUMBER_PATTERN.search(parts[1]):
        return parts[1]
    first_move = text.find("1.")
    return text[first_move:] if first_move >= 0 else text


def _normalize_movetext(text: str) -> str:
    cleaned = text.replace("\x00", " ").replace("\ufeff", " ")
    cleaned = re.sub(r"\{[^}]*\}", " ", cleaned)
    cleaned = re.sub(r"\([^)]*\)", " ", cleaned)
    cleaned = re.sub(r"\$\d+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = RESULT_PATTERN.sub("", cleaned).strip()
    return cleaned


def _wrap_movetext_as_pgn(movetext: str, *, username: str, player_color: str) -> str:
    white = username if player_color == "white" else "Chessnut OTB"
    black = username if player_color == "black" else "Chessnut OTB"
    lines = [
        '[Event "NewChessnut OTB"]',
        '[Site "NewChessnut"]',
        '[Date "????.??.??"]',
        '[Round "-"]',
        f'[White "{white}"]',
        f'[Black "{black}"]',
        '[Result "*"]',
        "",
        f"{movetext} *",
    ]
    return "\n".join(lines)


def _is_valid_pgn(pgn_text: str) -> bool:
    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception:
        return False
    return game is not None
