from __future__ import annotations

from collections import Counter, defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, timedelta
import json
import math
import threading
import time
from statistics import mean
from typing import Any, Callable
from urllib.parse import quote

import chess
import requests

try:
    from Openix import ChessOpeningsLibrary
except Exception:  # pragma: no cover - optional dependency fallback
    ChessOpeningsLibrary = None

from .chesscom import ImportedGame
from .classifications import (
    annotate_candidate_classifications,
    book_classification_payload,
    classify_move_record,
    classification_payload,
    expected_points_from_evaluation,
)
from .engine import EngineSession
from .opening_names import lookup_by_board, lookup_by_eco


OPENING_LIBRARY: ChessOpeningsLibrary | None = None
ONLINE_OPENING_CACHE: dict[str, dict[str, str]] = {}
EXPLORER_CACHE: dict[str, dict[str, Any]] = {}
POSITION_INSIGHT_CACHE: dict[str, dict[str, Any]] = {}
PERSISTENT_ENGINE_CACHE_LOAD: Callable[[str], dict[str, Any]] | None = None
PERSISTENT_ENGINE_CACHE_SAVE: Callable[[str, dict[str, Any]], None] | None = None
EXPLORER_AVAILABLE = True
EXPLORER_LAST_ERROR = ""
LICHESS_EXPLORER_URL = "https://explorer.lichess.ovh/lichess"
EXPLORER_HEADERS = {
    "User-Agent": "Bookup/1.0 (local repertoire trainer)",
}
KNOWN_LINE_THRESHOLD = 100
OPENING_PLIES = 16
PV_LENGTH = 12
REPERTOIRE_LOCK_PLIES = 8
REPEATED_MISTAKE_THRESHOLD = 2
MAX_EXPLANATION_CP = 600
MAX_ANALYZED_REPERTOIRE_NODES = 72
PROFILE_ANALYSIS_TIME_SEC = 0.9
ENGINE_CACHE_SCHEMA_VERSION = 9
BRILLIANT_TRACKER_GAME_LIMIT = 0
BRILLIANT_TRACKER_MAX_PLIES = 0  # 0 means no ply cap; scan every move made by the imported player.
BRILLIANT_TRACKER_LIVE_BUDGET = 0  # 0 means no cap; every scanned move gets a current-position MultiPV gate.
BRILLIANT_TRACKER_TIME_SEC = 0.8


@dataclass(slots=True)
class PositionNode:
    key: str
    color: str
    opening_name: str
    opening_code: str
    position_fen: str
    play_uci: list[str]
    trigger_move: str
    ply_index: int
    occurrences: int = 0
    player_moves: Counter[str] | None = None
    player_san: dict[str, str] | None = None
    first_seen_game: int = 0
    last_seen_game: int = 0
    first_seen_label: str = ""
    last_seen_label: str = ""
    result_counts: Counter[str] | None = None

    def __post_init__(self) -> None:
        if self.player_moves is None:
            self.player_moves = Counter()
        if self.player_san is None:
            self.player_san = {}
        if self.result_counts is None:
            self.result_counts = Counter()


def _analysis_progress_preview(
    fen: str,
    *,
    label: str = "Position",
    subtitle: str = "",
    status: str = "Analyzing",
    orientation: str = "white",
) -> dict[str, Any]:
    return {
        "fen": fen,
        "label": label,
        "subtitle": subtitle,
        "status": status,
        "orientation": "black" if orientation == "black" else "white",
    }


def configure_lichess(token: str = "") -> None:
    global EXPLORER_AVAILABLE, EXPLORER_LAST_ERROR
    normalized = token.strip()
    if normalized.lower() in {"demo-token", "your-token", "lichess-token", "paste-token-here"}:
        normalized = ""
    EXPLORER_HEADERS.clear()
    EXPLORER_HEADERS["User-Agent"] = "Bookup/1.0 (local repertoire trainer)"
    EXPLORER_AVAILABLE = bool(normalized)
    EXPLORER_LAST_ERROR = "" if normalized else "Add a real Lichess API token to show live explorer database moves."
    if normalized:
        EXPLORER_HEADERS["Authorization"] = f"Bearer {normalized}"
    EXPLORER_CACHE.clear()
    ONLINE_OPENING_CACHE.clear()


def configure_engine_cache(
    loader: Callable[[str], dict[str, Any]] | None = None,
    saver: Callable[[str, dict[str, Any]], None] | None = None,
) -> None:
    global PERSISTENT_ENGINE_CACHE_LOAD, PERSISTENT_ENGINE_CACHE_SAVE
    PERSISTENT_ENGINE_CACHE_LOAD = loader
    PERSISTENT_ENGINE_CACHE_SAVE = saver


def _engine_cache_key(
    kind: str,
    board: chess.Board,
    engine: EngineSession,
    *,
    play_uci: list[str] | None = None,
    limit: int = 1,
    time_sec: float | None = None,
    extra: dict[str, Any] | None = None,
) -> str:
    time_key = "none" if time_sec is None else f"{float(time_sec):.2f}"
    payload = {
        "schema": ENGINE_CACHE_SCHEMA_VERSION,
        "kind": kind,
        "fen_key": board.epd(),
        "turn": "white" if board.turn == chess.WHITE else "black",
        "play_uci": play_uci or [],
        "depth": int(engine.settings.depth),
        "multipv": int(engine.settings.multipv),
        "limit": int(limit),
        "time_sec": time_key,
        "explorer": bool(EXPLORER_AVAILABLE),
        "extra": extra or {},
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _load_engine_cache(cache_key: str) -> dict[str, Any] | None:
    cached = POSITION_INSIGHT_CACHE.get(cache_key)
    if cached:
        return cached
    if not PERSISTENT_ENGINE_CACHE_LOAD:
        return None
    try:
        payload = PERSISTENT_ENGINE_CACHE_LOAD(cache_key)
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("schema") != ENGINE_CACHE_SCHEMA_VERSION:
        return None
    POSITION_INSIGHT_CACHE[cache_key] = payload
    return payload


def _save_engine_cache(cache_key: str, payload: dict[str, Any]) -> None:
    cached = {"schema": ENGINE_CACHE_SCHEMA_VERSION, **payload}
    POSITION_INSIGHT_CACHE[cache_key] = cached
    if not PERSISTENT_ENGINE_CACHE_SAVE:
        return
    try:
        PERSISTENT_ENGINE_CACHE_SAVE(cache_key, cached)
    except Exception:
        pass


def _analysis_url_for_fen(fen: str) -> str:
    return f"https://lichess.org/analysis/standard/{quote(fen.replace(' ', '_'), safe='/_-')}"


def _clean_header_name(value: str) -> str:
    cleaned = (value or "").strip()
    if not cleaned or cleaned.lower() in {"unknown", "?", "n/a"}:
        return ""
    return cleaned


def _compose_opening_name(opening: str, variation: str) -> str:
    opening_clean = _clean_header_name(opening)
    variation_clean = _clean_header_name(variation)
    if opening_clean and variation_clean:
        if variation_clean.lower().startswith(opening_clean.lower()):
            return variation_clean
        return f"{opening_clean}: {variation_clean}"
    return opening_clean or variation_clean


def _score_cp(score: chess.engine.PovScore, turn: chess.Color) -> int:
    pov = score.pov(turn)
    if pov.is_mate():
        mate = pov.mate()
        if mate is None:
            return 0
        return 100000 - abs(mate) if mate > 0 else -100000 + abs(mate)
    return int(pov.score(mate_score=100000) or 0)


def _score_meta(score: chess.engine.PovScore, turn: chess.Color) -> tuple[str, int]:
    pov = score.pov(turn)
    if pov.is_mate():
        mate = pov.mate()
        return "mate", int(mate or 0)
    return "centipawn", int(pov.score(mate_score=100000) or 0)


def _clamp_cp(cp: int, limit: int = MAX_EXPLANATION_CP) -> int:
    return max(-limit, min(limit, int(cp)))


def _expected_points_from_cp(cp: int) -> float:
    return expected_points_from_evaluation(score_type="centipawn", score_value=int(cp))


def _expected_points_from_score(score: chess.engine.PovScore, turn: chess.Color, ply: int = 24) -> float:
    score_type, score_value = _score_meta(score, turn)
    return expected_points_from_evaluation(score_type=score_type, score_value=score_value)


def _edge_label(cp: int) -> str:
    value = abs(int(cp))
    if value < 40:
        return "tiny edge"
    if value < 120:
        return "small edge"
    if value < 250:
        return "clear edge"
    return "big edge"


def _line_label(trigger_move: str, play_uci: list[str]) -> str:
    intro = _uci_line_sans_from_start(play_uci)
    if intro:
        tail = " ".join(intro[-6:])
        return f"After {tail}"
    if trigger_move and trigger_move != "Start position":
        return f"After {trigger_move}"
    return "From the start position"


def _safe_mean(values: list[float]) -> float:
    return mean(values) if values else 0.0


def _classify_result(result: str, player_color: str = "") -> str:
    lowered = (result or "").lower()
    color = (player_color or "").lower()
    if lowered in {"1/2-1/2", "1/2", "draw"}:
        return "draw"
    if lowered == "1-0":
        return "win" if color != "black" else "loss"
    if lowered == "0-1":
        return "win" if color == "black" else "loss"
    if lowered == "win":
        return "win"
    if lowered in {"agreed", "stalemate", "repetition", "timevsinsufficient", "timeoutvsinsufficient", "insufficient", "50move"}:
        return "draw"
    return "loss"


def _game_date_label(imported: ImportedGame, fallback_index: int) -> str:
    headers = imported.game.headers
    date = str(headers.get("Date") or headers.get("UTCDate") or headers.get("EndDate") or "").strip()
    if date and date not in {"?", "????.??.??"}:
        return date.replace("????", "unknown").replace(".??", "")
    return f"Game {fallback_index}"


def _header_text(imported: ImportedGame, *names: str) -> str:
    headers = imported.game.headers
    for name in names:
        value = str(headers.get(name, "") or "").strip()
        if value and value not in {"?", "-", "????.??.??"}:
            return value
    return ""


def _parse_game_date(imported: ImportedGame) -> date | None:
    raw_date = _header_text(imported, "EndDate", "UTCDate", "Date").replace(".", "-")
    if not raw_date:
        return None
    date_part = raw_date.split(" ", 1)[0]
    parts = date_part.split("-")
    if len(parts) < 3 or any(not part.isdigit() for part in parts[:3]):
        return None
    try:
        return date(int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None


def _parse_game_time_seconds(imported: ImportedGame) -> int:
    raw_time = _header_text(imported, "EndTime", "UTCTime", "Time")
    if not raw_time:
        return 0
    time_part = raw_time.split(" ", 1)[0]
    pieces = time_part.split(":")
    if len(pieces) < 2 or any(not piece.isdigit() for piece in pieces[:2]):
        return 0
    try:
        hours = int(pieces[0])
        minutes = int(pieces[1])
        seconds = int(pieces[2]) if len(pieces) > 2 and pieces[2].isdigit() else 0
    except ValueError:
        return 0
    return max(0, min(86399, hours * 3600 + minutes * 60 + seconds))


def _rating_from_headers(imported: ImportedGame, color: str) -> int | None:
    color_prefix = "White" if color == "white" else "Black"
    for name in (f"{color_prefix}Elo", f"{color_prefix}Rating"):
        raw = _header_text(imported, name)
        if not raw:
            continue
        try:
            value = int(float(raw))
        except ValueError:
            continue
        if value > 0:
            return value
    return None


def _format_progress_date(value: date) -> str:
    return f"{value.strftime('%b')} {value.day}"


def _rating_delta(start: int | None, end: int | None) -> int | None:
    if start is None or end is None:
        return None
    return int(end) - int(start)


def _result_record_text(wins: int, draws: int, losses: int) -> str:
    return f"{wins}W {draws}D {losses}L"


def _score_rate(wins: int, draws: int, losses: int) -> float:
    games = wins + draws + losses
    if not games:
        return 0.0
    return round(((wins + 0.5 * draws) / games) * 100, 1)


def _win_rate(wins: int, draws: int, losses: int) -> float:
    games = wins + draws + losses
    if not games:
        return 0.0
    return round((wins / games) * 100, 1)


def _dominant_result(wins: int, draws: int, losses: int) -> str:
    values = {"win": wins, "draw": draws, "loss": losses}
    if not any(values.values()):
        return "idle"
    ordered = sorted(values.items(), key=lambda item: (-item[1], item[0]))
    if len([value for value in values.values() if value == ordered[0][1]]) > 1:
        return "mixed"
    return ordered[0][0]


def _build_rating_progress(games: list[ImportedGame], *, split_by_time_class: bool = True) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for index, imported in enumerate(games, start=1):
        played_on = _parse_game_date(imported)
        if played_on is None:
            continue
        player_color = imported.player_color if imported.player_color in {"white", "black"} else "white"
        opponent_color = "black" if player_color == "white" else "white"
        result = _classify_result(imported.result or str(imported.game.headers.get("Result", "")), player_color)
        player_rating = _rating_from_headers(imported, player_color)
        opponent_rating = _rating_from_headers(imported, opponent_color)
        opening_name = _compose_opening_name(
            str(imported.game.headers.get("Opening", "") or ""),
            str(imported.game.headers.get("Variation", "") or ""),
        )
        opening_code = str(imported.game.headers.get("ECO", "") or "").strip().upper()
        ply_count_raw = str(imported.game.headers.get("PlyCount", "") or "").strip()
        try:
            move_count = max(0, int(ply_count_raw)) // 2 if ply_count_raw else None
        except ValueError:
            move_count = None
        rows.append(
            {
                "index": index,
                "date": played_on,
                "sort_seconds": _parse_game_time_seconds(imported),
                "rating": player_rating,
                "opponent_rating": opponent_rating,
                "result": result,
                "time_class": imported.time_class or "unknown",
                "opponent": imported.opponent or "Unknown",
                "color": player_color,
                "url": imported.url,
                "opening": opening_name or opening_code or "Unknown opening",
                "move_count": move_count,
            }
        )
    rows.sort(key=lambda row: (row["date"], row["sort_seconds"], row["index"]))

    if not rows:
        return {
            "available": False,
            "message": "No dated games with rating headers were available yet.",
            "total_games": len(games),
            "dated_games": 0,
            "ranges": {},
            "default_range": "90",
        }

    daily: dict[date, dict[str, Any]] = {}
    time_class_counts: Counter[str] = Counter()
    last_rating: int | None = None
    for row in rows:
        day = row["date"]
        bucket = daily.setdefault(
            day,
            {
                "date": day,
                "games": 0,
                "wins": 0,
                "draws": 0,
                "losses": 0,
                "rating": None,
                "ratings": [],
                "opponents": [],
                "games_detail": [],
                "time_classes": Counter(),
            },
        )
        bucket["games"] += 1
        if row["result"] == "win":
            bucket["wins"] += 1
        elif row["result"] == "draw":
            bucket["draws"] += 1
        else:
            bucket["losses"] += 1
        bucket["opponents"].append(row["opponent"])
        bucket["games_detail"].append(
            {
                "opponent": row["opponent"],
                "result": row["result"],
                "rating": row["rating"],
                "opponent_rating": row["opponent_rating"],
                "color": row["color"],
                "time_class": row["time_class"],
                "url": row["url"],
                "opening": row["opening"],
                "move_count": row["move_count"],
            }
        )
        bucket["time_classes"][row["time_class"]] += 1
        time_class_counts[row["time_class"]] += 1
        if row["rating"] is not None:
            bucket["rating"] = row["rating"]
            bucket["ratings"].append(row["rating"])
            last_rating = row["rating"]
    if last_rating is None:
        last_rating = next((row["rating"] for row in reversed(rows) if row["rating"] is not None), None)

    all_dates = sorted(daily)
    earliest_date = all_dates[0]
    latest_date = all_dates[-1]
    all_ratings = [int(row["rating"]) for row in rows if row["rating"] is not None]

    def build_range(key: str, days: int | None) -> dict[str, Any]:
        range_labels = {
            "7": "Last 7 days",
            "30": "Last 30 days",
            "90": "Last 90 days",
            "365": "Last year",
            "all": "All time",
        }
        start_date = earliest_date if days is None else max(earliest_date, latest_date - timedelta(days=days - 1))
        points: list[dict[str, Any]] = []
        range_rows = [row for row in rows if row["date"] >= start_date]
        carry_rating = next((row["rating"] for row in reversed(rows) if row["date"] < start_date and row["rating"] is not None), None)
        active_dates = []
        if days is None:
            date_sequence = [day for day in all_dates if day >= start_date]
        else:
            date_sequence = []
            date_cursor = start_date
            while date_cursor <= latest_date:
                date_sequence.append(date_cursor)
                date_cursor += timedelta(days=1)
        for date_cursor in date_sequence:
            bucket = daily.get(date_cursor)
            if bucket:
                active_dates.append(date_cursor)
                if bucket["rating"] is not None:
                    carry_rating = bucket["rating"]
                wins = int(bucket["wins"])
                draws = int(bucket["draws"])
                losses = int(bucket["losses"])
                games_count = int(bucket["games"])
                common_time_class = bucket["time_classes"].most_common(1)[0][0] if bucket["time_classes"] else "unknown"
                opponents = bucket["opponents"][:4]
                game_links = list(bucket.get("games_detail", []))[-8:]
                last_game_url = next((item.get("url", "") for item in reversed(game_links) if item.get("url")), "")
                point = {
                    "date": date_cursor.isoformat(),
                    "label": _format_progress_date(date_cursor),
                    "games": games_count,
                    "wins": wins,
                    "draws": draws,
                    "losses": losses,
                    "record": _result_record_text(wins, draws, losses),
                    "score_rate": _score_rate(wins, draws, losses),
                    "win_rate": _win_rate(wins, draws, losses),
                    "rating": bucket["rating"],
                    "rating_graph": carry_rating,
                    "result_tone": _dominant_result(wins, draws, losses),
                    "time_class": common_time_class,
                    "opponents": opponents,
                    "game_links": game_links,
                    "last_game_url": last_game_url,
                    "summary": f"{games_count} game{'s' if games_count != 1 else ''}: {_result_record_text(wins, draws, losses)}",
                }
            else:
                point = {
                    "date": date_cursor.isoformat(),
                    "label": _format_progress_date(date_cursor),
                    "games": 0,
                    "wins": 0,
                    "draws": 0,
                    "losses": 0,
                    "record": "0W 0D 0L",
                    "score_rate": 0.0,
                    "win_rate": 0.0,
                    "rating": None,
                    "rating_graph": carry_rating,
                    "result_tone": "idle",
                    "time_class": "",
                    "opponents": [],
                    "game_links": [],
                    "last_game_url": "",
                    "summary": "No games imported for this day.",
                }
            points.append(point)

        wins = sum(1 for row in range_rows if row["result"] == "win")
        draws = sum(1 for row in range_rows if row["result"] == "draw")
        losses = sum(1 for row in range_rows if row["result"] == "loss")
        range_ratings = [int(row["rating"]) for row in range_rows if row["rating"] is not None]
        first_rating = range_ratings[0] if range_ratings else carry_rating
        final_rating = range_ratings[-1] if range_ratings else carry_rating
        busiest = max((daily[day] for day in active_dates), key=lambda item: (int(item["games"]), item["date"]), default=None)
        best_score_day = max(
            (daily[day] for day in active_dates if int(daily[day]["games"]) > 0),
            key=lambda item: (_score_rate(int(item["wins"]), int(item["draws"]), int(item["losses"])), int(item["games"])),
            default=None,
        )
        return {
            "key": key,
            "label": range_labels.get(key, "All time" if days is None else f"{days} days"),
            "days": days,
            "start_date": start_date.isoformat(),
            "end_date": latest_date.isoformat(),
            "games": len(range_rows),
            "wins": wins,
            "draws": draws,
            "losses": losses,
            "record": _result_record_text(wins, draws, losses),
            "score_rate": _score_rate(wins, draws, losses),
            "win_rate": _win_rate(wins, draws, losses),
            "rating_start": first_rating,
            "rating_end": final_rating,
            "rating_change": _rating_delta(first_rating, final_rating),
            "best_rating": max(range_ratings) if range_ratings else final_rating,
            "worst_rating": min(range_ratings) if range_ratings else final_rating,
            "points": points,
            "busiest_day": {
                "date": busiest["date"].isoformat(),
                "label": _format_progress_date(busiest["date"]),
                "games": int(busiest["games"]),
                "record": _result_record_text(int(busiest["wins"]), int(busiest["draws"]), int(busiest["losses"])),
            } if busiest else None,
            "best_score_day": {
                "date": best_score_day["date"].isoformat(),
                "label": _format_progress_date(best_score_day["date"]),
                "games": int(best_score_day["games"]),
                "record": _result_record_text(int(best_score_day["wins"]), int(best_score_day["draws"]), int(best_score_day["losses"])),
                "score_rate": _score_rate(int(best_score_day["wins"]), int(best_score_day["draws"]), int(best_score_day["losses"])),
            } if best_score_day else None,
        }

    time_class_progress: dict[str, Any] = {}
    default_time_class = ""
    if split_by_time_class:
        seen_classes = [key for key, _value in time_class_counts.most_common()]
        for time_class in seen_classes:
            class_games = [
                imported
                for imported in games
                if (imported.time_class or "unknown") == time_class
            ]
            if not class_games:
                continue
            class_payload = _build_rating_progress(class_games, split_by_time_class=False)
            if not class_payload.get("available"):
                continue
            class_payload["time_class_key"] = time_class
            class_payload["time_class_label"] = time_class.replace("_", " ").title()
            time_class_progress[time_class] = class_payload
            if not default_time_class and time_class != "unknown":
                default_time_class = time_class

    return {
        "available": True,
        "total_games": len(games),
        "dated_games": len(rows),
        "latest_date": latest_date.isoformat(),
        "latest_rating": last_rating,
        "best_rating": max(all_ratings) if all_ratings else None,
        "worst_rating": min(all_ratings) if all_ratings else None,
        "default_range": "90",
        "default_time_class": default_time_class,
        "time_class_breakdown": [
            {"label": key, "games": int(value)}
            for key, value in time_class_counts.most_common()
        ],
        "time_class_progress": time_class_progress,
        "ranges": {
            "7": build_range("7", 7),
            "30": build_range("30", 30),
            "90": build_range("90", 90),
            "365": build_range("365", 365),
            "all": build_range("all", None),
        },
    }


def _normalize_position_key(board: chess.Board) -> str:
    return board.epd()


def _opening_library() -> ChessOpeningsLibrary | None:
    global OPENING_LIBRARY
    if OPENING_LIBRARY is not None:
        return OPENING_LIBRARY
    if ChessOpeningsLibrary is None:
        return None
    try:
        library = ChessOpeningsLibrary()
        library.load_builtin_openings()
    except Exception:
        OPENING_LIBRARY = None
        return None
    OPENING_LIBRARY = library
    return OPENING_LIBRARY


def _explorer_lookup(board: chess.Board, play_key: str) -> dict[str, Any]:
    global EXPLORER_LAST_ERROR
    cache_key = f"{board.epd()}|{play_key}"
    if cache_key in EXPLORER_CACHE:
        return EXPLORER_CACHE[cache_key]
    if not EXPLORER_AVAILABLE:
        EXPLORER_LAST_ERROR = "Add a real Lichess API token to show live explorer database moves."
        return {}
    try:
        response = requests.get(
            LICHESS_EXPLORER_URL,
            params={
                "variant": "standard",
                "fen": board.fen(),
                "play": play_key,
                "moves": 12,
                "speeds": "bullet,blitz,rapid,classical",
            },
            headers=EXPLORER_HEADERS,
            timeout=5,
        )
        response.raise_for_status()
        payload = response.json()
        EXPLORER_LAST_ERROR = ""
    except Exception:
        EXPLORER_LAST_ERROR = "Lichess explorer rejected the token or could not be reached."
        payload = {}
    EXPLORER_CACHE[cache_key] = payload
    return payload


def _opening_lookup_payload(imported: ImportedGame, max_plies: int = 12) -> tuple[str, chess.Board, list[str], list[str]]:
    board = imported.game.board()
    play: list[str] = []
    san_moves: list[str] = []
    for index, move in enumerate(imported.game.mainline_moves()):
        if index >= max_plies:
            break
        san_moves.append(board.san(move))
        play.append(move.uci())
        board.push(move)
    return ",".join(play), board, play, san_moves


def _find_named_dataset_position(imported: ImportedGame, max_plies: int = 12) -> dict[str, str]:
    board = imported.game.board()
    best_match: dict[str, str] = {}
    for index, move in enumerate(imported.game.mainline_moves()):
        if index >= max_plies:
            break
        board.push(move)
        match = lookup_by_board(board)
        if match.get("name"):
            best_match = match
    return best_match


def identify_opening(imported: ImportedGame, *, use_explorer: bool = False) -> dict[str, str]:
    header_opening = str(imported.game.headers.get("Opening", "") or "")
    header_variation = str(imported.game.headers.get("Variation", "") or "")
    header_name = _compose_opening_name(header_opening, header_variation)
    eco = (imported.game.headers.get("ECO") or "").strip().upper()
    play_key, board, play, san_moves = _opening_lookup_payload(imported)
    cache_key = f"{int(use_explorer)}|{play_key}|{board.epd()}|{header_name}|{eco}"
    if cache_key in ONLINE_OPENING_CACHE:
        return dict(ONLINE_OPENING_CACHE[cache_key])

    result = {
        "name": header_name,
        "code": eco,
        "position_identifier": _analysis_url_for_fen(board.fen()),
        "position_identifier_label": "Lichess analysis",
    }

    lichess_dataset_match = _find_named_dataset_position(imported)
    dataset_name = _clean_header_name(lichess_dataset_match.get("name", ""))
    dataset_eco = _clean_header_name(lichess_dataset_match.get("eco", "")).upper()
    if dataset_name and (not result["name"] or result["name"] == result["code"]):
        result["name"] = dataset_name
    if dataset_eco and not result["code"]:
        result["code"] = dataset_eco

    library = _opening_library()
    if library and san_moves:
        try:
            for length in range(len(san_moves), 0, -1):
                matches = library.find_openings_after_moves(san_moves[:length])
                if not matches:
                    continue
                best_match = max(matches, key=lambda item: len(getattr(item, "moves_list", []) or []))
                if getattr(best_match, "name", ""):
                    result["name"] = str(best_match.name)
                if getattr(best_match, "eco_code", ""):
                    result["code"] = str(best_match.eco_code).upper()
                break
        except Exception:
            pass

    # Live explorer lookup is useful for one-off position views, but it is far
    # too expensive during bulk import. The local Lichess opening dataset and
    # PGN headers give us stable names without blocking game indexing.
    if use_explorer:
        explorer = _explorer_lookup(board, play_key)
        opening = explorer.get("opening") or {}
        explorer_name = _clean_header_name(str(opening.get("name", "") or ""))
        if explorer_name and (
            not result["name"]
            or result["name"] == result["code"]
            or len(explorer_name) > len(result["name"])
        ):
            result["name"] = explorer_name
        if opening.get("eco") and not result["code"]:
            result["code"] = str(opening["eco"]).upper()

    if not result["name"] and result["code"]:
        result["name"] = lookup_by_eco(result["code"])

    if not result["name"]:
        preview_board = imported.game.board()
        preview: list[str] = []
        for move in imported.game.mainline_moves():
            if len(preview) >= 6:
                break
            preview.append(preview_board.san(move))
            preview_board.push(move)
        result["name"] = " ".join(preview) if preview else (result["code"] or "Unknown Opening")

    ONLINE_OPENING_CACHE[cache_key] = dict(result)
    return result


def _pv_sans(board: chess.Board, pv: list[chess.Move], limit: int = PV_LENGTH) -> tuple[list[str], list[str]]:
    line_board = board.copy(stack=False)
    sans: list[str] = []
    ucis: list[str] = []
    for move in pv[:limit]:
        if move not in line_board.legal_moves:
            break
        sans.append(line_board.san(move))
        ucis.append(move.uci())
        line_board.push(move)
    return sans, ucis


def _uci_line_sans_from_start(moves_uci: list[str]) -> list[str]:
    board = chess.Board()
    sans: list[str] = []
    for uci in moves_uci:
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            break
        if move not in board.legal_moves:
            break
        sans.append(board.san(move))
        board.push(move)
    return sans


def _first_move_repertoire(games: list[ImportedGame], color_name: str) -> dict[str, Any]:
    counter: Counter[str] = Counter()
    target_color = chess.WHITE if color_name == "white" else chess.BLACK
    for imported in games:
        if imported.player_color != color_name:
            continue
        board = imported.game.board()
        for move in imported.game.mainline_moves():
            if board.turn == target_color:
                counter[board.san(move)] += 1
                break
            board.push(move)
    total = sum(counter.values())
    items = [
        {
            "move": move,
            "count": count,
            "pct": round((count / total) * 100, 1) if total else 0.0,
        }
        for move, count in counter.most_common(8)
    ]
    return {
        "top_move": items[0] if items else None,
        "items": items,
        "total_games": total,
    }


def _book_payload_for_tree() -> dict[str, Any]:
    return book_classification_payload(0.5, reason="move from your imported opening tree")


def _build_game_move_tree(
    games: list[ImportedGame],
    *,
    max_depth: int = 20,
    max_children: int = 8,
) -> dict[str, Any]:
    """Build a compact practical move tree from imported games without engine work."""

    def new_node() -> dict[str, Any]:
        return {
            "uci": "",
            "san": "Start",
            "count": 0,
            "white_wins": 0,
            "draws": 0,
            "black_wins": 0,
            "player_move_count": 0,
            "opponent_move_count": 0,
            "children": {},
        }

    roots = {
        "all": new_node(),
        "white": new_node(),
        "black": new_node(),
    }
    player_color_counts = Counter(imported.player_color for imported in games)
    opening_cache: dict[str, dict[str, Any]] = {}

    def add_game_to_root(root: dict[str, Any], imported: ImportedGame, perspective: str) -> None:
        board = imported.game.board()
        node = root
        result = str(imported.game.headers.get("Result", "") or "")
        white_score = 0.5
        if result == "1-0":
            white_score = 1.0
        elif result == "0-1":
            white_score = 0.0

        path_san: list[str] = []
        path_uci: list[str] = []
        for ply_index, move in enumerate(imported.game.mainline_moves()):
            if ply_index >= max_depth:
                break
            if move not in board.legal_moves:
                break
            san = board.san(move)
            uci = move.uci()
            color = "white" if board.turn == chess.WHITE else "black"
            role = "player" if color == imported.player_color else "opponent"
            next_board = board.copy(stack=False)
            next_board.push(move)
            opening_key = next_board.epd()
            opening = opening_cache.get(opening_key)
            if opening is None:
                opening = lookup_by_board(next_board) if ply_index < OPENING_PLIES else {}
                opening_cache[opening_key] = opening
            next_path_san = [*path_san, san]
            next_path_uci = [*path_uci, uci]
            children = node.setdefault("children", {})
            child = children.get(uci)
            if child is None:
                child = {
                    "uci": uci,
                    "san": san,
                    "color": color,
                    "role": role,
                    "perspective": perspective,
                    "player_color": imported.player_color,
                    "count": 0,
                    "white_wins": 0,
                    "draws": 0,
                    "black_wins": 0,
                    "player_move_count": 0,
                    "opponent_move_count": 0,
                    "ply": ply_index + 1,
                    "path_san": next_path_san,
                    "path_uci": next_path_uci,
                    "classification": _book_payload_for_tree() if ply_index < OPENING_PLIES else None,
                    "opening_name": str(opening.get("name", "") or ""),
                    "opening_code": str(opening.get("eco", "") or ""),
                    "position_fen": next_board.fen(),
                    "position_identifier": _analysis_url_for_fen(next_board.fen()),
                    "children": {},
                }
                children[uci] = child
            child["count"] += 1
            if white_score == 1.0:
                child["white_wins"] += 1
            elif white_score == 0.0:
                child["black_wins"] += 1
            else:
                child["draws"] += 1
            if role == "player":
                child["player_move_count"] += 1
            else:
                child["opponent_move_count"] += 1
            node = child
            board.push(move)
            path_san = next_path_san
            path_uci = next_path_uci

    for imported in games:
        add_game_to_root(roots["all"], imported, "all")
        add_game_to_root(roots[imported.player_color], imported, imported.player_color)

    def prune(node: dict[str, Any], depth: int = 0) -> dict[str, Any]:
        raw_children = list((node.get("children") or {}).values())
        raw_children.sort(key=lambda item: (-int(item.get("count", 0)), str(item.get("san", ""))))
        total = sum(int(item.get("count", 0) or 0) for item in raw_children)
        kept = []
        for child in raw_children[:max_children]:
            count = int(child.get("count", 0) or 0)
            score_games = count or 1
            white_score = (float(child.get("white_wins", 0) or 0) + 0.5 * float(child.get("draws", 0) or 0)) / score_games
            player_move_count = int(child.get("player_move_count", 0) or 0)
            opponent_move_count = int(child.get("opponent_move_count", 0) or 0)
            compact = {
                "uci": child.get("uci", ""),
                "san": child.get("san", ""),
                "color": child.get("color", ""),
                "role": "player" if player_move_count >= opponent_move_count else "opponent",
                "move_role": "your move" if player_move_count >= opponent_move_count else "opponent reply",
                "perspective": child.get("perspective", ""),
                "player_color": child.get("player_color", ""),
                "ply": int(child.get("ply", 0) or 0),
                "path_san": child.get("path_san", []),
                "path_uci": child.get("path_uci", []),
                "count": count,
                "popularity": round((count / total) * 100, 1) if total else 0.0,
                "white_score": round(white_score * 100, 1),
                "player_move_count": player_move_count,
                "opponent_move_count": opponent_move_count,
                "player_share": round((player_move_count / count) * 100, 1) if count else 0.0,
                "classification": child.get("classification"),
                "opening_name": child.get("opening_name", ""),
                "opening_code": child.get("opening_code", ""),
                "position_fen": child.get("position_fen", ""),
                "position_identifier": child.get("position_identifier", ""),
                "children": [],
            }
            if depth + 1 < max_depth:
                compact["children"] = prune(child, depth + 1).get("children", [])
            kept.append(compact)
        return {"children": kept}

    for key, root in roots.items():
        root["count"] = len(games) if key == "all" else int(player_color_counts.get(key, 0))
    return {
        "total_games": len(games),
        "player_color_counts": {
            "white": int(player_color_counts.get("white", 0)),
            "black": int(player_color_counts.get("black", 0)),
        },
        "max_depth": max_depth,
        "max_children": max_children,
        "root": prune(roots["all"]),
        "by_player_color": {
            "white": {
                "total_games": int(player_color_counts.get("white", 0)),
                "root": prune(roots["white"]),
            },
            "black": {
                "total_games": int(player_color_counts.get("black", 0)),
                "root": prune(roots["black"]),
            },
        },
    }


def _collect_position_nodes(
    games: list[ImportedGame],
    progress_callback: Callable[..., None] | None = None,
) -> tuple[dict[str, PositionNode], dict[str, Counter[str]], dict[str, dict[str, Any]]]:
    nodes: dict[str, PositionNode] = {}
    position_counts: dict[str, Counter[str]] = defaultdict(Counter)
    opening_by_position: dict[str, dict[str, Any]] = {}
    live_previews: deque[dict[str, Any]] = deque(maxlen=6)
    total_games = len(games)
    started = time.perf_counter()
    last_notify = 0.0

    def report(game_index: int, *, force: bool = False) -> None:
        nonlocal last_notify
        if not progress_callback:
            return
        now = time.perf_counter()
        if not force and game_index < total_games and game_index % 20 and now - last_notify < 0.75:
            return
        last_notify = now
        progress = 8
        if total_games:
            progress = 8 + int((game_index / max(1, total_games)) * 10)
        elapsed = max(0.001, now - started)
        rate = game_index / elapsed if game_index > 0 else 0.0
        eta = ((total_games - game_index) / rate) if rate > 0 and total_games > game_index else 0
        try:
            progress_callback(
                phase="indexing",
                progress=progress,
                games_done=game_index,
                games_total=total_games,
                positions_indexed=len(nodes),
                items_per_second=round(rate, 2),
                games_per_second=round(rate, 2),
                eta_sec=round(eta, 1) if eta else 0,
                live_positions=list(live_previews),
                message=f"Indexed {game_index}/{total_games} games into {len(nodes)} repertoire positions...",
            )
        except Exception:
            pass

    for game_index, imported in enumerate(games, start=1):
        user_side = chess.WHITE if imported.player_color == "white" else chess.BLACK
        opening_info = identify_opening(imported, use_explorer=False)
        board = imported.game.board()
        play_uci: list[str] = []
        last_san = "Start position"
        seen_label = _game_date_label(imported, game_index)
        game_result = _classify_result(imported.result, imported.player_color)

        for ply_index, move in enumerate(imported.game.mainline_moves()):
            if ply_index >= OPENING_PLIES:
                break
            if board.turn == user_side:
                key = _normalize_position_key(board)
                node = nodes.get(key)
                if node is None:
                    node = PositionNode(
                        key=key,
                        color=imported.player_color,
                        opening_name=opening_info["name"],
                        opening_code=opening_info["code"],
                        position_fen=board.fen(),
                        play_uci=list(play_uci),
                        trigger_move=last_san,
                        ply_index=ply_index,
                    )
                    nodes[key] = node
                    opening_by_position[key] = opening_info
                san = board.san(move)
                node.occurrences += 1
                if not node.first_seen_game:
                    node.first_seen_game = game_index
                    node.first_seen_label = seen_label
                node.last_seen_game = game_index
                node.last_seen_label = seen_label
                node.result_counts[game_result] += 1
                node.player_moves[move.uci()] += 1
                node.player_san[move.uci()] = san
                position_counts[key][san] += 1
                live_previews.append(
                    _analysis_progress_preview(
                        board.fen(),
                        label=san,
                        subtitle=f"{seen_label} · {opening_info['name']}",
                        status="Indexing",
                        orientation=imported.player_color,
                    )
                )
            last_san = board.san(move)
            play_uci.append(move.uci())
            board.push(move)
        report(game_index, force=game_index == total_games)

    return nodes, position_counts, opening_by_position


def _rank_nodes_for_analysis(nodes: dict[str, PositionNode]) -> list[PositionNode]:
    """Analyze the most useful repeated positions first so imports stay responsive."""
    repeated_nodes = [node for node in nodes.values() if node.occurrences >= REPEATED_MISTAKE_THRESHOLD]
    repeated_nodes.sort(
        key=lambda node: (
            -node.occurrences,
            node.ply_index,
            node.color,
            node.trigger_move,
            node.key,
        )
    )
    return repeated_nodes[:MAX_ANALYZED_REPERTOIRE_NODES]


def _database_moves(board: chess.Board, play_uci: list[str], limit: int = 6) -> list[dict[str, Any]]:
    explorer = _explorer_lookup(board, ",".join(play_uci))
    moves = explorer.get("moves") or []
    total = float(explorer.get("white", 0) or 0) + float(explorer.get("black", 0) or 0) + float(explorer.get("draws", 0) or 0)
    items = []
    for item in moves[:limit]:
        count = float(item.get("white", 0) or 0) + float(item.get("black", 0) or 0) + float(item.get("draws", 0) or 0)
        items.append(
            {
                "san": item.get("san") or item.get("uci") or "",
                "uci": item.get("uci") or "",
                "games": int(count),
                "popularity": round((count / total) * 100, 1) if total and count else 0.0,
            }
        )
    return items


def database_context_for_board(board: chess.Board, play_uci: list[str] | None = None, limit: int = 8) -> dict[str, Any]:
    moves = _database_moves(board, play_uci or [], limit=limit)
    return {
        "fen": board.fen(),
        "database_moves": moves,
        "database_error": EXPLORER_LAST_ERROR,
        "database_source": "lichess" if moves else ("disabled" if EXPLORER_LAST_ERROR else "lichess"),
        "position_identifier": _analysis_url_for_fen(board.fen()),
        "position_identifier_label": "Lichess analysis",
    }


def _resulting_position_is_book(board: chess.Board, move_uci: str) -> bool:
    try:
        move = chess.Move.from_uci(move_uci)
    except ValueError:
        return False
    if move not in board.legal_moves:
        return False
    next_board = board.copy(stack=False)
    next_board.push(move)
    match = lookup_by_board(next_board)
    return bool(str(match.get("name", "") or "").strip() or str(match.get("eco", "") or "").strip())


def _position_has_book_name(board: chess.Board) -> bool:
    match = lookup_by_board(board)
    return bool(str(match.get("name", "") or "").strip() or str(match.get("eco", "") or "").strip())


def _book_state_for_line(play_uci: list[str] | None, board: chess.Board | None = None) -> dict[str, Any]:
    play_uci = [str(item) for item in (play_uci or []) if str(item)]
    if len(play_uci) >= OPENING_PLIES:
        return {
            "active": False,
            "reason": "outside opening-book ply window",
            "ply": len(play_uci),
            "last_book_ply": OPENING_PLIES,
            "position_matches_prefix": False if board is not None else True,
        }

    probe = chess.Board()
    last_book_ply = 0
    for ply_index, move_uci in enumerate(play_uci, start=1):
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            return {
                "active": False,
                "reason": f"invalid move {move_uci} in book path",
                "ply": ply_index - 1,
                "last_book_ply": last_book_ply,
                "position_matches_prefix": False,
            }
        if move not in probe.legal_moves:
            return {
                "active": False,
                "reason": f"illegal move {move_uci} in book path",
                "ply": ply_index - 1,
                "last_book_ply": last_book_ply,
                "position_matches_prefix": False,
            }
        probe.push(move)
        if ply_index <= 2 or _position_has_book_name(probe):
            last_book_ply = ply_index
            continue
        return {
            "active": False,
            "reason": f"left named opening book after ply {ply_index}",
            "ply": ply_index,
            "last_book_ply": last_book_ply,
            "position_matches_prefix": board.epd() == probe.epd() if board is not None else True,
        }

    return {
        "active": True,
        "reason": "still inside opening-book context",
        "ply": len(play_uci),
        "last_book_ply": last_book_ply,
        "position_matches_prefix": board.epd() == probe.epd() if board is not None else True,
    }


def _move_is_book_candidate(
    board: chess.Board,
    move_uci: str,
    *,
    book_state: dict[str, Any] | None = None,
    popularity_by_uci: dict[str, float] | None = None,
    repeated_count: int = 0,
) -> bool:
    if not (book_state or {}).get("active", False):
        return False
    if repeated_count >= REPEATED_MISTAKE_THRESHOLD:
        return True
    if float((popularity_by_uci or {}).get(move_uci, 0.0) or 0.0) >= 3.0:
        return True
    return _resulting_position_is_book(board, move_uci)


def _move_purpose(board: chess.Board, move: chess.Move) -> str:
    piece = board.piece_at(move.from_square)
    if piece is None:
        return "improves coordination"
    san = board.san(move)
    destination = chess.square_name(move.to_square)
    if board.is_castling(move):
        return "gets the king safe and connects the rooks"
    if "+" in san or "#" in san:
        return "creates forcing pressure against the king"
    if board.is_capture(move):
        return f"wins material or removes a defender on {destination}"
    if piece.piece_type == chess.PAWN:
        if destination in {"d4", "d5", "e4", "e5", "c4", "c5"}:
            return f"claims central space with the pawn on {destination}"
        return f"improves the pawn structure with {san}"
    if piece.piece_type == chess.KNIGHT:
        return f"improves the knight on {destination}"
    if piece.piece_type == chess.BISHOP:
        return f"activates the bishop toward {destination}"
    if piece.piece_type == chess.ROOK:
        return f"brings the rook onto a more active file or rank via {destination}"
    if piece.piece_type == chess.QUEEN:
        return f"improves the queen while keeping pressure on the position"
    return "improves coordination"


def _matching_database_move(database_moves: list[dict[str, Any]], move_uci: str, san: str) -> dict[str, Any] | None:
    for item in database_moves or []:
        if item.get("uci") == move_uci or item.get("san") == san:
            return item
    return None


def _move_reaction_for_board(
    board: chess.Board,
    move: chess.Move,
    *,
    classification: dict[str, Any] | None = None,
    best_line: dict[str, Any] | None = None,
    database_moves: list[dict[str, Any]] | None = None,
    book_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a short, concrete coach reaction for a move from the live board."""
    try:
        san = board.san(move)
    except Exception:
        san = move.uci()
    moving_piece = board.piece_at(move.from_square)
    mover = board.turn
    after = board.copy(stack=False)
    try:
        after.push(move)
    except Exception:
        after = None

    key = (classification or {}).get("key") or "unknown"
    label = (classification or {}).get("label") or "Move"
    from_name = chess.square_name(move.from_square)
    to_name = chess.square_name(move.to_square)
    reasons: list[str] = []
    features: list[str] = []
    database_hit = _matching_database_move(database_moves or [], move.uci(), san)
    book_active = (book_state or {}).get("active", True)

    if moving_piece:
        piece_name = chess.piece_name(moving_piece.piece_type)
        features.append(piece_name)
        if moving_piece.piece_type in (chess.KNIGHT, chess.BISHOP) and from_name in {"b1", "g1", "b8", "g8"}:
            reasons.append(f"Develops the {piece_name} from {from_name} to {to_name}.")
        elif moving_piece.piece_type == chess.PAWN and chess.square_file(move.to_square) in (2, 3, 4):
            reasons.append(f"Claims space or opens lines with the pawn on {to_name}.")
        elif moving_piece.piece_type in (chess.ROOK, chess.QUEEN):
            reasons.append(f"Moves a heavy piece onto {to_name}.")

    if board.is_castling(move):
        features.append("castle")
        reasons.insert(0, "Castles to improve king safety and connect the rooks.")
    if board.is_capture(move):
        features.append("capture")
        captured = board.piece_at(move.to_square)
        if captured:
            reasons.insert(0, f"Captures the {chess.piece_name(captured.piece_type)} on {to_name}.")
        else:
            reasons.insert(0, f"Captures on {to_name}.")
    if after is not None and after.is_checkmate():
        features.append("checkmate")
        reasons.insert(0, "Gives checkmate.")
    elif after is not None and after.is_check():
        features.append("check")
        reasons.insert(0, "Gives check and forces a reply.")

    if database_hit:
        features.append("database")
        pct = database_hit.get("percent")
        if isinstance(pct, (int, float)):
            reasons.append(f"Database move from this position, seen about {pct:.1f}% of the time.")
        else:
            reasons.append("Database move from this position.")

    if key == "book":
        headline = f"{san} is a book move." if book_active else f"{san} is no longer in book."
        reasons.insert(0, "Still follows your repertoire or opening database." if book_active else "This branch has left the known book position.")
    elif key == "brilliant":
        headline = f"{san} is a brilliant resource."
        reasons.insert(0, "It keeps the position sound while investing material for a tactic.")
    elif key == "great":
        headline = f"{san} is the only move that keeps the advantage."
        reasons.insert(0, "Other candidate moves drop the result much more clearly.")
    elif key == "best":
        headline = f"{san} is the engine top move."
    elif key in {"excellent", "good"}:
        headline = f"{san} is {label.lower()}."
    elif key in {"inaccuracy", "mistake", "blunder", "miss"}:
        headline = f"{san} is a {label.lower()}."
        best_san = best_line.get("move") if best_line else ""
        if best_san and best_line.get("uci") != move.uci():
            reasons.insert(0, f"The engine prefers {best_san} from this exact position.")
    else:
        headline = f"{san} was played."

    if best_line and best_line.get("uci") == move.uci() and key not in {"book", "great", "brilliant"}:
        reasons.append("It starts the top Stockfish continuation.")

    while len(reasons) < 2:
        reasons.append(_move_purpose(board, move).capitalize() + ".")

    return {
        "move": san,
        "uci": move.uci(),
        "label": label,
        "classification_key": key,
        "headline": headline,
        "reasons": reasons[:4],
        "features": features[:6],
        "side": "white" if mover == chess.WHITE else "black",
    }


def _candidate_lines_for_board(
    board: chess.Board,
    engine: EngineSession,
    *,
    play_uci: list[str] | None = None,
    limit: int = 5,
    time_sec: float | None = None,
    include_database: bool = True,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
    play_uci = play_uci or []
    cache_key = _engine_cache_key(
        "candidate-lines",
        board,
        engine,
        play_uci=play_uci,
        limit=limit,
        time_sec=time_sec,
        extra={"include_database": bool(include_database)},
    )
    cached = _load_engine_cache(cache_key)
    if cached:
        cached_lines = list(cached.get("candidate_lines", []))
        cached_database = list(cached.get("database_moves", []))
        if cached_lines and any("reaction" not in line for line in cached_lines):
            cached_book_state = _book_state_for_line(play_uci, board)
            cached_best = cached_lines[0]
            for line in cached_lines:
                try:
                    first_move = chess.Move.from_uci(str(line.get("uci") or ""))
                except ValueError:
                    continue
                if first_move not in board.legal_moves:
                    continue
                line["reaction"] = _move_reaction_for_board(
                    board,
                    first_move,
                    classification=line.get("classification"),
                    best_line=cached_best,
                    database_moves=cached_database,
                    book_state=cached_book_state,
                )
        return cached_lines, cached_database, True

    root_lines = engine.analyse(
        board,
        multipv=max(limit, engine.settings.multipv),
        time_sec=time_sec,
    )
    database_moves = _database_moves(board, play_uci, limit=limit + 1) if include_database else []
    popularity_by_uci = {
        str(item.get("uci", "")): float(item.get("popularity", 0.0) or 0.0)
        for item in database_moves
        if item.get("uci")
    }
    candidate_lines: list[dict[str, Any]] = []
    for line in root_lines[:limit]:
        pv = line.get("pv") or []
        if not pv:
            continue
        first_move = pv[0]
        if first_move not in board.legal_moves:
            continue
        first_san = board.san(first_move)
        continuation_san, continuation_uci = _pv_sans(board, pv)
        score_type, score_value = _score_meta(line["score"], board.turn)
        candidate_lines.append(
            {
                "move": first_san,
                "uci": first_move.uci(),
                "score_cp": _score_cp(line["score"], board.turn),
                "score_cp_white": _score_cp(line["score"], chess.WHITE),
                "score_type": score_type,
                "score_value": score_value,
                "expected_points": _expected_points_from_score(line["score"], board.turn, engine.settings.depth),
                "line_san": " ".join(continuation_san),
                "line_uci": continuation_uci,
                "purpose": _move_purpose(board, first_move),
                "source": "engine",
                "popularity": next((item["popularity"] for item in database_moves if item.get("uci") == first_move.uci()), 0.0),
            }
        )
    book_state = _book_state_for_line(play_uci, board)
    candidate_lines = annotate_candidate_classifications(
        board,
        candidate_lines,
        opening_phase=bool(book_state.get("active")) and len(play_uci) < OPENING_PLIES,
        popularity_by_uci=popularity_by_uci,
    )
    best_line = candidate_lines[0] if candidate_lines else None
    for line in candidate_lines:
        try:
            first_move = chess.Move.from_uci(str(line.get("uci") or ""))
        except ValueError:
            continue
        if first_move not in board.legal_moves:
            continue
        line["reaction"] = _move_reaction_for_board(
            board,
            first_move,
            classification=line.get("classification"),
            best_line=best_line,
            database_moves=database_moves,
            book_state=book_state,
        )

    _save_engine_cache(cache_key, {
        "candidate_lines": list(candidate_lines),
        "database_moves": list(database_moves),
    })
    return candidate_lines, database_moves, False


def _threat_lines_for_board(
    board: chess.Board,
    candidate_lines: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    threats: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, line in enumerate(candidate_lines[:5]):
        continuation = list(line.get("line_uci") or [])
        if len(continuation) < 2:
            continue
        reply_uci = continuation[1]
        if not reply_uci or reply_uci in seen:
            continue
        try:
            reply_move = chess.Move.from_uci(reply_uci)
        except ValueError:
            continue
        reply_board = board.copy(stack=False)
        first_uci = str(line.get("uci") or "")
        try:
            first_move = chess.Move.from_uci(first_uci)
        except ValueError:
            continue
        if first_move not in reply_board.legal_moves:
            continue
        reply_board.push(first_move)
        if reply_move not in reply_board.legal_moves:
            continue
        threats.append(
            {
                "move": reply_board.san(reply_move),
                "uci": reply_uci,
                "source": "threat",
                "weight": max(0, 100 - index * 18),
            }
        )
        seen.add(reply_uci)
    return threats


def _build_coach_explanation(
    board: chess.Board,
    *,
    best_move_uci: str,
    best_move_san: str,
    candidate_lines: list[dict[str, Any]],
    database_moves: list[dict[str, Any]],
    your_move_uci: str = "",
    your_move_san: str = "",
    your_move_count: int = 0,
) -> str:
    best_line = next((line for line in candidate_lines if line["uci"] == best_move_uci), candidate_lines[0] if candidate_lines else None)
    if best_line is None:
        return f"{best_move_san} is the best move here."
    purpose = best_line.get("purpose") or "improves the position"
    database_note = ""
    if database_moves:
        top_reply = database_moves[0]
        popularity = top_reply.get("popularity", 0)
        if popularity:
            database_note = f" That reply shows up in about {popularity}% of the Lichess database."
    if your_move_uci and your_move_uci != best_move_uci:
        alt_line = next((line for line in candidate_lines if line["uci"] == your_move_uci), None)
        best_score = _clamp_cp(best_line.get("score_cp", 0))
        alt_score = _clamp_cp(alt_line.get("score_cp", best_score) if alt_line else best_score)
        score_delta = best_score - alt_score
        habit_note = f" You usually play {your_move_san or your_move_uci} here"
        if your_move_count:
            habit_note += f" ({your_move_count}x)"
        habit_note += "."
        return (
            f"{best_move_san} is best because it {purpose}."
            f"{habit_note} Compared with {your_move_san or your_move_uci}, it keeps a {_edge_label(score_delta)} for your side."
            f" The main continuation is {best_line.get('line_san', best_move_san)}.{database_note}"
        )
    return (
        f"{best_move_san} is best because it {purpose}."
        f" The main continuation is {best_line.get('line_san', best_move_san)}.{database_note}"
    )


def build_position_insight(
    board: chess.Board,
    engine: EngineSession,
    *,
    play_uci: list[str] | None = None,
    your_move_uci: str = "",
    your_move_san: str = "",
    your_move_count: int = 0,
    time_sec: float | None = None,
) -> dict[str, Any]:
    play_uci = play_uci or []
    book_state = _book_state_for_line(play_uci, board)
    candidate_lines, database_moves, cache_hit = _candidate_lines_for_board(
        board,
        engine,
        play_uci=play_uci,
        limit=5,
        time_sec=time_sec,
    )
    best_line = candidate_lines[0] if candidate_lines else None
    if best_line is None:
        return {
            "candidate_lines": [],
            "threat_lines": [],
            "database_moves": database_moves,
            "database_error": EXPLORER_LAST_ERROR,
            "database_source": "lichess" if database_moves else ("disabled" if EXPLORER_LAST_ERROR else "lichess"),
            "book_state": book_state,
            "cache_hit": cache_hit,
            "recommended_move": "",
            "recommended_move_uci": "",
            "recommended_classification": None,
            "your_move_classification": None,
            "recommended_reaction": None,
            "your_move_reaction": None,
            "coach_reaction": None,
            "coach_explanation": "No engine line is available for this position yet.",
            "position_identifier": _analysis_url_for_fen(board.fen()),
        }
    your_move_classification = None
    your_move_reaction = None
    your_line = None
    popularity_by_uci = {
        str(item.get("uci", "")): float(item.get("popularity", 0.0) or 0.0)
        for item in database_moves
        if item.get("uci")
    }
    if your_move_uci:
        your_line = next((line for line in candidate_lines if line["uci"] == your_move_uci), None)
        if your_line is None:
            your_line = _build_branch_line(
                board,
                your_move_uci,
                your_move_san or your_move_uci,
                engine,
                source="repertoire",
                repeated_count=your_move_count,
                popularity=next((item["popularity"] for item in database_moves if item.get("uci") == your_move_uci), 0.0),
                time_sec=time_sec,
            )
        if your_line is not None:
            second_loss = candidate_lines[1]["expected_points_loss"] if len(candidate_lines) > 1 else 0.0
            your_move_classification = classify_move_record(
                board,
                your_line,
                best_line,
                second_record=candidate_lines[1] if len(candidate_lines) > 1 else None,
                second_loss=second_loss,
                is_player_move=True,
                opening_phase=bool(book_state.get("active")) and len(play_uci) < OPENING_PLIES,
                in_book=_move_is_book_candidate(
                    board,
                    your_move_uci,
                    book_state=book_state,
                    popularity_by_uci=popularity_by_uci,
                    repeated_count=your_move_count,
                ),
            )
            try:
                reaction_move = chess.Move.from_uci(your_move_uci)
            except ValueError:
                reaction_move = None
            if reaction_move is not None and reaction_move in board.legal_moves:
                your_move_reaction = _move_reaction_for_board(
                    board,
                    reaction_move,
                    classification=your_move_classification,
                    best_line=best_line,
                    database_moves=database_moves,
                    book_state=book_state,
                )
    recommended_reaction = None
    try:
        best_move = chess.Move.from_uci(str(best_line.get("uci") or ""))
    except ValueError:
        best_move = None
    if best_move is not None and best_move in board.legal_moves:
        recommended_reaction = _move_reaction_for_board(
            board,
            best_move,
            classification=best_line.get("classification"),
            best_line=best_line,
            database_moves=database_moves,
            book_state=book_state,
        )
    return {
        "candidate_lines": candidate_lines,
        "threat_lines": _threat_lines_for_board(board, candidate_lines),
        "database_moves": database_moves,
        "database_error": EXPLORER_LAST_ERROR,
        "database_source": "lichess" if database_moves else ("disabled" if EXPLORER_LAST_ERROR else "lichess"),
        "book_state": book_state,
        "cache_hit": cache_hit,
        "recommended_move": best_line["move"],
        "recommended_move_uci": best_line["uci"],
        "recommended_classification": best_line.get("classification"),
        "your_move_classification": your_move_classification,
        "recommended_reaction": recommended_reaction,
        "your_move_reaction": your_move_reaction,
        "coach_reaction": your_move_reaction or recommended_reaction,
        "eval_cp_white": best_line.get("score_cp_white", best_line.get("score_cp", 0)),
        "eval_cp_turn": best_line.get("score_cp", 0),
        "coach_explanation": _build_coach_explanation(
            board,
            best_move_uci=best_line["uci"],
            best_move_san=best_line["move"],
            candidate_lines=candidate_lines,
            database_moves=database_moves,
            your_move_uci=your_move_uci,
            your_move_san=your_move_san,
            your_move_count=your_move_count,
        ),
        "position_identifier": _analysis_url_for_fen(board.fen()),
        "position_identifier_label": "Lichess analysis",
    }


def generate_theory_line(
    board: chess.Board,
    engine: EngineSession,
    *,
    seed_move_uci: str = "",
    plies: int = 10,
    time_sec: float | None = None,
) -> dict[str, Any]:
    """Generate a best-play theory line from the current position or after one seed move."""
    work_board = board.copy(stack=False)
    seed = None
    if seed_move_uci:
        try:
            seed_move = chess.Move.from_uci(seed_move_uci)
        except ValueError as exc:
            raise ValueError("Seed move must be UCI, like e2e4 or e7e8q.") from exc
        if seed_move not in work_board.legal_moves:
            raise ValueError("Seed move is not legal in the current position.")
        seed = {
            "uci": seed_move.uci(),
            "san": work_board.san(seed_move),
            "from": chess.square_name(seed_move.from_square),
            "to": chess.square_name(seed_move.to_square),
        }
        work_board.push(seed_move)

    steps: list[dict[str, Any]] = []
    requested_plies = max(1, min(30, int(plies or 10)))
    for index in range(requested_plies):
        if work_board.is_game_over(claim_draw=True):
            break
        candidate_lines, database_moves, cache_hit = _candidate_lines_for_board(
            work_board,
            engine,
            play_uci=[],
            limit=5,
            time_sec=time_sec,
        )
        if not candidate_lines:
            break
        best = candidate_lines[0]
        try:
            move = chess.Move.from_uci(str(best.get("uci", "")))
        except ValueError:
            break
        if move not in work_board.legal_moves:
            break
        san = work_board.san(move)
        from_square = chess.square_name(move.from_square)
        to_square = chess.square_name(move.to_square)
        side = "white" if work_board.turn == chess.WHITE else "black"
        work_board.push(move)
        steps.append(
            {
                "ply": index + 1,
                "side": side,
                "uci": move.uci(),
                "san": san,
                "from": from_square,
                "to": to_square,
                "fen_after": work_board.fen(),
                "eval_cp_white": best.get("score_cp_white", best.get("score_cp", 0)),
                "classification": best.get("classification"),
                "candidate_lines": candidate_lines,
                "database_moves": database_moves,
                "cache_hit": cache_hit,
            }
        )

    return {
        "fen": board.fen(),
        "seed_move": seed,
        "plies_requested": requested_plies,
        "plies_generated": len(steps),
        "line_san": " ".join(step["san"] for step in steps),
        "line_uci": [step["uci"] for step in steps],
        "resulting_fen": work_board.fen(),
        "steps": steps,
        "position_identifier": _analysis_url_for_fen(work_board.fen()),
        "position_identifier_label": "Open final position on Lichess",
    }


def _build_branch_line(
    board: chess.Board,
    move_uci: str,
    move_san: str,
    engine: EngineSession,
    *,
    source: str,
    repeated_count: int = 0,
    popularity: float = 0.0,
    score_cp: int | None = None,
    time_sec: float | None = None,
) -> dict[str, Any] | None:
    try:
        move = chess.Move.from_uci(move_uci)
    except ValueError:
        return None
    if move not in board.legal_moves:
        return None

    branch_board = board.copy(stack=False)
    branch_board.push(move)
    cache_key = _engine_cache_key(
        "branch-line",
        branch_board,
        engine,
        limit=1,
        time_sec=time_sec,
        extra={
            "move_uci": move_uci,
            "move_san": move_san,
            "source": source,
            "score_cp": score_cp,
        },
    )
    cached = _load_engine_cache(cache_key)
    if cached and isinstance(cached.get("branch_line"), dict):
        branch_line = dict(cached["branch_line"])
        branch_line["source"] = source
        branch_line["repeated_count"] = repeated_count
        branch_line["popularity"] = popularity
        return branch_line

    analysis = engine.analyse(
        branch_board,
        depth=max(8, min(14, engine.settings.depth - 4)),
        multipv=1,
        time_sec=time_sec,
    )
    if not analysis:
        return None
    line = analysis[0]
    pv = line.get("pv") or []
    continuation_san, continuation_uci = _pv_sans(branch_board, pv)
    score_type, score_value = _score_meta(line["score"], board.turn)
    branch_score_cp = score_cp if score_cp is not None else _score_cp(line["score"], board.turn)
    full_uci = [move_uci, *continuation_uci]
    full_san = [move_san, *continuation_san]
    branch_line = {
        "move": move_san,
        "uci": move_uci,
        "resulting_fen": branch_board.fen(),
        "score_cp": branch_score_cp,
        "score_type": score_type,
        "score_value": score_value,
        "expected_points": _expected_points_from_score(line["score"], board.turn, engine.settings.depth),
        "line_san": " ".join(full_san),
        "line_uci": full_uci,
        "source": source,
        "repeated_count": repeated_count,
        "popularity": popularity,
    }
    _save_engine_cache(cache_key, {"branch_line": dict(branch_line)})
    return branch_line


def _build_queue_explainer(
    *,
    line_status: str,
    line_label: str,
    top_played: str,
    best_reply: str,
    repeat_mistake_count: int,
    frequency: int,
    value_lost_cp: int,
    priority: float,
    confidence: float,
    database_moves: list[dict[str, Any]],
    first_seen_label: str,
    last_seen_label: str,
    result_counts: Counter[str],
) -> dict[str, Any]:
    """Explain why a line belongs in a queue without changing queue priority logic."""

    top_database = max((float(item.get("popularity", 0.0) or 0.0) for item in database_moves), default=0.0)
    losses = int(result_counts.get("loss", 0))
    wins = int(result_counts.get("win", 0))
    draws = int(result_counts.get("draw", 0))
    factors: list[dict[str, Any]] = []

    if line_status == "needs_work":
        headline = "Repeated repertoire miss"
        summary = (
            f"Bookup queued this because you reached {line_label} {frequency} times and repeated "
            f"{top_played} instead of {best_reply} {repeat_mistake_count} times."
        )
        next_action = f"Work this until {best_reply} feels automatic from the shown position."
        factors.append(
            {
                "label": "Repeated miss",
                "value": f"{repeat_mistake_count}x",
                "detail": f"Your repeated move here is {top_played}; Bookup recommends {best_reply}.",
                "tone": "urgent",
            }
        )
    elif line_status == "new":
        headline = "New repeated position"
        summary = (
            f"This position repeated {frequency} times in your games. It is ready to learn later, "
            "but it is not a repeated mistake yet."
        )
        next_action = "Review it after the repeated-miss queue is clear."
        factors.append(
            {
                "label": "Trainable",
                "value": f"{frequency}x",
                "detail": "Repeated enough to be a real repertoire position, not a random one-off.",
                "tone": "stable",
            }
        )
    elif line_status == "known":
        headline = "Known line"
        summary = f"You already play the recommended move {best_reply} often enough for Bookup to archive this line."
        next_action = "Keep it archived unless it starts producing repeated misses later."
        factors.append(
            {
                "label": "Confidence",
                "value": f"{round(confidence)}",
                "detail": "High confidence keeps this out of active Needs Work.",
                "tone": "stable",
            }
        )
    else:
        headline = "Queue candidate"
        summary = f"Bookup ranked this line from repeated game evidence and current engine/database context."
        next_action = "Open the line to decide whether to add it to Needs Work."

    if value_lost_cp > 0:
        factors.append(
            {
                "label": "Engine swing",
                "value": f"{value_lost_cp}cp",
                "detail": "Estimated centipawn loss compared with the current top engine continuation.",
                "tone": "warning" if value_lost_cp >= 80 else "stable",
            }
        )
    else:
        factors.append(
            {
                "label": "Engine swing",
                "value": "0cp",
                "detail": "No clear engine loss was measured for your main move.",
                "tone": "stable",
            }
        )

    factors.append(
        {
            "label": "Game frequency",
            "value": f"{frequency}x",
            "detail": f"Seen from {first_seen_label or 'your games'} to {last_seen_label or 'your latest import'}.",
            "tone": "database" if frequency >= 8 else "stable",
        }
    )

    if top_database > 0:
        factors.append(
            {
                "label": "Database weight",
                "value": f"{top_database:.1f}%",
                "detail": "Lichess/player-database replies make this position more practical to study.",
                "tone": "database",
            }
        )

    if losses or wins or draws:
        factors.append(
            {
                "label": "Results",
                "value": f"{wins}-{draws}-{losses}",
                "detail": "Win-draw-loss record from imported games that reached this position.",
                "tone": "warning" if losses > wins else "stable",
            }
        )

    return {
        "headline": headline,
        "summary": summary,
        "factors": factors[:5],
        "rank_inputs": {
            "priority": priority,
            "frequency": frequency,
            "repeat_mistake_count": repeat_mistake_count,
            "value_lost_cp": value_lost_cp,
            "database_popularity": round(top_database, 1),
            "confidence": confidence,
            "line_status": line_status,
        },
        "next_action": next_action,
    }


def _build_lesson_from_node(node: PositionNode, engine: EngineSession, *, time_sec: float | None = None) -> dict[str, Any]:
    if node.occurrences < REPEATED_MISTAKE_THRESHOLD:
        return {}

    board = chess.Board(node.position_fen)
    insight = build_position_insight(
        board,
        engine,
        play_uci=node.play_uci,
        your_move_uci=node.player_moves.most_common(1)[0][0] if node.player_moves else "",
        your_move_san=node.player_san.get(node.player_moves.most_common(1)[0][0], "") if node.player_moves else "",
        your_move_count=node.player_moves.most_common(1)[0][1] if node.player_moves else 0,
        time_sec=time_sec,
    )
    candidate_lines = insight["candidate_lines"]
    database_moves = insight["database_moves"]
    if not candidate_lines:
        return {}
    root = candidate_lines[0]
    best_move_uci = root["uci"]
    best_reply = root["move"]
    top_played_uci, top_played_count = node.player_moves.most_common(1)[0]
    top_played = node.player_san[top_played_uci]
    best_repeat_count = node.player_moves.get(best_move_uci, 0)
    # Keep repertoire work inside the opening family the user already plays.
    # If this is still a defining early fork and their main branch is at least as common
    # as the engine alternative,
    # do not turn "switch openings" into a trainer lesson.
    repertoire_locked = (
        node.ply_index <= REPERTOIRE_LOCK_PLIES
        and top_played_uci != best_move_uci
        and top_played_count >= 2
    )
    if repertoire_locked:
        return {}

    is_known = best_repeat_count >= KNOWN_LINE_THRESHOLD
    line_status = "known" if is_known else ("new" if top_played == best_reply else "needs_work")
    if line_status == "needs_work" and top_played_count < REPEATED_MISTAKE_THRESHOLD:
        return {}

    value_lost_cp = 0
    if top_played_uci != best_move_uci:
        compared_line = next((line for line in candidate_lines if line["uci"] == top_played_uci), None)
        compared_score = compared_line["score_cp"] if compared_line else root["score_cp"]
        value_lost_cp = max(0, _clamp_cp(root["score_cp"]) - _clamp_cp(compared_score))

    frequency = node.occurrences
    importance = round(min(100.0, (frequency * 8) + max((database_moves[0]["popularity"] if database_moves else 0.0), 0.0) * 1.5), 1)
    confidence = round(min(100.0, 35 + (frequency * 4)), 1)
    priority = round((frequency * 10) + min(value_lost_cp / 10, 60) + (25 if line_status == "needs_work" else 0) - (40 if is_known else 0), 1)
    intro_line_uci = list(node.play_uci)
    intro_line_san = _uci_line_sans_from_start(intro_line_uci)
    branch_lines: list[dict[str, Any]] = []
    branch_by_uci: dict[str, dict[str, Any]] = {}
    for line in candidate_lines[: engine.settings.multipv]:
        branch_record = _build_branch_line(
            board,
            line["uci"],
            line["move"],
            engine,
            source="engine",
            repeated_count=node.player_moves.get(line["uci"], 0),
            popularity=next((item["popularity"] for item in database_moves if item.get("uci") == line["uci"]), 0.0),
            score_cp=line["score_cp"],
            time_sec=time_sec,
        )
        if branch_record:
            branch_by_uci[line["uci"]] = branch_record
            branch_lines.append(branch_record)

    if top_played_count >= REPEATED_MISTAKE_THRESHOLD and top_played_uci not in branch_by_uci:
        repertoire_branch = _build_branch_line(
            board,
            top_played_uci,
            top_played,
            engine,
            source="repertoire",
            repeated_count=top_played_count,
            popularity=next((item["popularity"] for item in database_moves if item.get("uci") == top_played_uci), 0.0),
            time_sec=time_sec,
        )
        if repertoire_branch:
            branch_by_uci[top_played_uci] = repertoire_branch
            branch_lines.append(repertoire_branch)

    preferred_branch = branch_by_uci.get(best_move_uci)
    if not preferred_branch:
        return {}
    second_loss = candidate_lines[1]["expected_points_loss"] if len(candidate_lines) > 1 else 0.0
    book_state = _book_state_for_line(node.play_uci, board)
    popularity_by_uci = {
        str(item.get("uci", "")): float(item.get("popularity", 0.0) or 0.0)
        for item in database_moves
        if item.get("uci")
    }
    recommended_classification = root.get("classification") or classify_move_record(
        board,
        root,
        root,
        second_record=candidate_lines[1] if len(candidate_lines) > 1 else None,
        second_loss=second_loss,
        opening_phase=bool(book_state.get("active")) and node.ply_index < OPENING_PLIES,
        in_book=_move_is_book_candidate(
            board,
            best_move_uci,
            book_state=book_state,
            popularity_by_uci=popularity_by_uci,
            repeated_count=best_repeat_count,
        ),
    )
    your_branch = branch_by_uci.get(top_played_uci) or next((line for line in candidate_lines if line["uci"] == top_played_uci), None)
    your_move_classification = None
    if your_branch:
        your_move_classification = your_branch.get("classification") or classify_move_record(
            board,
            your_branch,
            root,
            second_record=candidate_lines[1] if len(candidate_lines) > 1 else None,
            second_loss=second_loss,
            is_player_move=True,
            opening_phase=bool(book_state.get("active")) and node.ply_index < OPENING_PLIES,
            in_book=_move_is_book_candidate(
                board,
                top_played_uci,
                book_state=book_state,
                popularity_by_uci=popularity_by_uci,
                repeated_count=top_played_count,
            ),
        )

    locked_training_line_uci = [*node.play_uci, *preferred_branch["line_uci"]]
    locked_training_line_san = _uci_line_sans_from_start(locked_training_line_uci)
    decision_board = chess.Board()
    for move_uci in intro_line_uci:
        try:
            decision_board.push(chess.Move.from_uci(move_uci))
        except ValueError:
            break
    discovery_nodes = [
        {
            "san": move["san"],
            "uci": move["uci"],
            "count": move["count"],
            "pct": move["pct"],
            "is_preferred": move["uci"] == best_move_uci,
            "is_repertoire": move["count"] >= REPEATED_MISTAKE_THRESHOLD,
            "has_branch_line": move["uci"] in branch_by_uci,
        }
        for move in [
            {
                "san": node.player_san[uci],
                "uci": uci,
                "count": count,
                "pct": round((count / node.occurrences) * 100, 1) if node.occurrences else 0.0,
            }
            for uci, count in node.player_moves.most_common(4)
        ]
    ]
    if best_move_uci not in {item["uci"] for item in discovery_nodes}:
        discovery_nodes.insert(
            0,
            {
                "san": best_reply,
                "uci": best_move_uci,
                "count": best_repeat_count,
                "pct": round((best_repeat_count / node.occurrences) * 100, 1) if node.occurrences else 0.0,
                "is_preferred": True,
                "is_repertoire": best_repeat_count >= REPEATED_MISTAKE_THRESHOLD,
                "has_branch_line": True,
            },
        )
    repeat_mistake_count = top_played_count if top_played_uci != best_move_uci else 0

    explanation = insight["coach_explanation"]
    line_label = _line_label(node.trigger_move, node.play_uci)
    queue_explainer = _build_queue_explainer(
        line_status=line_status,
        line_label=line_label,
        top_played=top_played,
        best_reply=best_reply,
        repeat_mistake_count=repeat_mistake_count,
        frequency=frequency,
        value_lost_cp=value_lost_cp,
        priority=priority,
        confidence=confidence,
        database_moves=database_moves,
        first_seen_label=node.first_seen_label,
        last_seen_label=node.last_seen_label,
        result_counts=node.result_counts,
    )

    return {
        "lesson_id": f"{node.color}:{quote(node.key, safe='')[:48]}:{best_move_uci}",
        "position_fen": node.position_fen,
        "position_identifier": _analysis_url_for_fen(node.position_fen),
        "position_identifier_label": "Lichess analysis",
        "opening_name": node.opening_name,
        "opening_code": node.opening_code,
        "line_label": line_label,
        "transposition_group_id": node.key,
        "color": node.color,
        "line_start_fen": chess.STARTING_FEN,
        "line_root_fen": chess.STARTING_FEN,
        "decision_fen": decision_board.fen(),
        "intro_line_uci": intro_line_uci,
        "intro_line_san": " ".join(intro_line_san),
        "training_line_uci": locked_training_line_uci,
        "training_line_san": " ".join(locked_training_line_san),
        "target_ply_index": len(node.play_uci),
        "trigger_move": node.trigger_move,
        "best_reply": best_reply,
        "best_reply_uci": best_move_uci,
        "preferred_branch_san": preferred_branch["move"],
        "preferred_branch_uci": preferred_branch["uci"],
        "locked_training_line_san": " ".join(locked_training_line_san),
        "locked_training_line_uci": locked_training_line_uci,
        "continuation_san": preferred_branch["line_san"],
        "continuation_moves_uci": preferred_branch["line_uci"],
        "line_status": line_status,
        "repeat_count": best_repeat_count,
        "repeat_mistake_count": repeat_mistake_count,
        "first_seen_game": node.first_seen_game,
        "last_seen_game": node.last_seen_game,
        "first_seen_label": node.first_seen_label,
        "last_seen_label": node.last_seen_label,
        "result_breakdown": {
            "wins": int(node.result_counts.get("win", 0)),
            "draws": int(node.result_counts.get("draw", 0)),
            "losses": int(node.result_counts.get("loss", 0)),
        },
        "frequency": frequency,
        "importance": importance,
        "confidence": confidence,
        "priority": priority,
        "queue_explainer": queue_explainer,
        "your_top_move": top_played,
        "your_top_move_uci": top_played_uci,
        "your_top_move_count": top_played_count,
        "value_lost_cp": value_lost_cp,
        "recommended_move": best_reply,
        "recommended_classification": recommended_classification,
        "your_repeated_move": top_played,
        "your_move_classification": your_move_classification,
        "common_replies": database_moves,
        "database_moves": database_moves,
        "discovery_nodes": discovery_nodes,
        "transposition_targets": [
            {
                "uci": item["uci"],
                "san": item["move"],
                "resulting_fen": item.get("resulting_fen", ""),
                "source": item["source"],
                "repeated_count": item["repeated_count"],
                "popularity": item["popularity"],
            }
            for item in branch_lines
        ],
        "trainer_phase": "intro_autoplay",
        "branch_locked": False,
        "line_completed": False,
        "branch_lines": branch_lines,
        "candidate_lines": candidate_lines,
        "player_move_frequency": [
            {
                "san": node.player_san[uci],
                "uci": uci,
                "count": count,
                "pct": round((count / node.occurrences) * 100, 1) if node.occurrences else 0.0,
                "classification": (
                    your_move_classification
                    if uci == top_played_uci
                    else next((line.get("classification") for line in candidate_lines if line["uci"] == uci), None)
                ),
            }
            for uci, count in node.player_moves.most_common(4)
        ],
        "coach_explanation": explanation,
        "explanation": explanation,
    }


def _group_repertoire(lessons: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for lesson in lessons:
        grouped[(lesson["color"], lesson["opening_name"], lesson["opening_code"])].append(lesson)

    repertoire = []
    for (color, opening_name, opening_code), items in sorted(
        grouped.items(),
        key=lambda kv: sum(item["frequency"] for item in kv[1]),
        reverse=True,
    ):
        items.sort(key=lambda item: (-item["frequency"], -item["priority"], item["trigger_move"]))
        repertoire.append(
            {
                "color": color,
                "opening_name": opening_name,
                "opening_code": opening_code,
                "total_frequency": sum(item["frequency"] for item in items),
                "known_count": sum(1 for item in items if item["line_status"] == "known"),
                "nodes": items,
            }
        )
    return repertoire


def _build_repertoire_map(lessons: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    by_color: dict[str, list[dict[str, Any]]] = {"white": [], "black": []}
    for lesson in lessons:
        if lesson["your_top_move_uci"] == lesson["best_reply_uci"]:
            continue
        by_color[lesson["color"]].append(
            {
                "lesson_id": lesson["lesson_id"],
                "position_fen": lesson["position_fen"],
                "position_identifier": lesson["position_identifier"],
                "position_identifier_label": lesson["position_identifier_label"],
                "line_label": lesson["line_label"],
                "opening_name": lesson["opening_name"],
                "opening_code": lesson["opening_code"],
                "trigger_move": lesson["trigger_move"],
                "recommended_move": lesson["recommended_move"],
                "your_repeated_move": lesson["your_repeated_move"],
                "repeat_count": lesson["repeat_count"],
                "your_top_move_count": lesson["your_top_move_count"],
                "frequency": lesson["frequency"],
                "confidence": lesson["confidence"],
                "memory_score": lesson.get("memory_score", 0),
                "priority": lesson["priority"],
                "line_status": lesson["line_status"],
                "database_moves": lesson["database_moves"],
                "candidate_lines": lesson["candidate_lines"],
                "transposition_group_id": lesson["transposition_group_id"],
                "coach_explanation": lesson["coach_explanation"],
                "recommended_classification": lesson["recommended_classification"],
                "your_move_classification": lesson["your_move_classification"],
                "player_move_frequency": lesson["player_move_frequency"],
                "continuation_san": lesson["continuation_san"],
            }
        )
    for color in by_color:
        by_color[color].sort(key=lambda item: (-item["frequency"], -item["priority"], item["opening_name"]))
    return by_color


def _opening_lists(repertoire_tree: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    by_color: dict[str, list[dict[str, Any]]] = {"white": [], "black": []}
    for group in repertoire_tree:
        record = {
            "opening": group["opening_name"],
            "opening_code": group["opening_code"],
            "count": group["total_frequency"],
            "known_count": group["known_count"],
            "trainable_count": sum(1 for node in group["nodes"] if node["line_status"] != "known"),
            "position_identifier": group["nodes"][0]["position_identifier"] if group["nodes"] else "",
            "position_identifier_label": "Lichess analysis",
        }
        by_color[group["color"]].append(record)
    for side in by_color:
        by_color[side].sort(key=lambda item: item["count"], reverse=True)
        by_color[side] = by_color[side][:10]
    return by_color


def _build_repertoire_updates(urgent: list[dict[str, Any]], known_lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    updates = []
    for lesson in urgent[:8]:
        updates.append(
            {
                "title": lesson["line_label"],
                "detail": f"After this position, make {lesson['best_reply']} your default continuation.",
                "line": lesson["continuation_san"],
                "lesson_id": lesson["lesson_id"],
                "position_identifier": lesson["position_identifier"],
                "position_identifier_label": "Lichess analysis",
            }
        )
    if not updates and known_lines:
        lesson = known_lines[0]
        updates.append(
            {
                "title": lesson["line_label"],
                "detail": f"You already know {lesson['best_reply']} here. Keep it in your maintenance queue.",
                "line": lesson["continuation_san"],
                "lesson_id": lesson["lesson_id"],
                "position_identifier": lesson["position_identifier"],
                "position_identifier_label": "Lichess analysis",
            }
        )
    return updates


def _build_health_dashboard(
    *,
    lessons: list[dict[str, Any]],
    queue_due: list[dict[str, Any]],
    queue_new: list[dict[str, Any]],
    known_lines: list[dict[str, Any]],
    repeated_work_lines: list[dict[str, Any]],
    games_count: int,
    win_rate: float,
) -> dict[str, Any]:
    total = len(lessons)
    average_confidence = round(mean([float(item.get("confidence", 0)) for item in lessons]), 1) if lessons else 0.0
    due_share = round((len(queue_due) / total) * 100, 1) if total else 0.0
    known_share = round((len(known_lines) / total) * 100, 1) if total else 0.0
    review_load = len(queue_due) + min(len(queue_new), 8)
    status = "stable"
    if len(queue_due) >= 12 or due_share >= 35:
        status = "heavy"
    elif len(queue_due) <= 3 and known_share >= 35:
        status = "strong"

    coverage_by_color = []
    for color in ("white", "black"):
        color_lessons = [item for item in lessons if item.get("color") == color]
        color_known = [item for item in known_lines if item.get("color") == color]
        color_due = [item for item in queue_due if item.get("color") == color]
        coverage_by_color.append(
            {
                "color": color,
                "positions": len(color_lessons),
                "due": len(color_due),
                "known": len(color_known),
                "coverage": round((len(color_known) / len(color_lessons)) * 100, 1) if color_lessons else 0.0,
                "confidence": round(mean([float(item.get("confidence", 0)) for item in color_lessons]), 1) if color_lessons else 0.0,
            }
        )

    weakest = sorted(
        repeated_work_lines,
        key=lambda item: (-float(item.get("value_lost_cp", 0)), -int(item.get("repeat_mistake_count", 0)), -int(item.get("frequency", 0))),
    )[:5]
    strongest = sorted(
        known_lines,
        key=lambda item: (-int(item.get("repeat_count", 0)), -float(item.get("confidence", 0)), -int(item.get("frequency", 0))),
    )[:5]

    return {
        "status": status,
        "cards": [
            {
                "label": "Repertoire health",
                "value": f"{average_confidence:.0f}",
                "detail": "average confidence across analyzed repeated positions",
                "tone": status,
            },
            {
                "label": "Due today",
                "value": len(queue_due),
                "detail": f"{due_share}% of analyzed positions need repeated-mistake review",
                "tone": "urgent" if queue_due else "quiet",
            },
            {
                "label": "Known coverage",
                "value": f"{known_share:.0f}%",
                "detail": f"{len(known_lines)} known lines out of {total}",
                "tone": "strong" if known_share >= 35 else "quiet",
            },
            {
                "label": "Review load",
                "value": review_load,
                "detail": "suggested focused lines for today's session",
                "tone": "heavy" if review_load >= 16 else "stable",
            },
        ],
        "games_count": games_count,
        "win_rate": win_rate,
        "coverage_by_color": coverage_by_color,
        "weakest_lines": [
            {
                "lesson_id": item["lesson_id"],
                "line_label": item["line_label"],
                "recommended_move": item["recommended_move"],
                "your_repeated_move": item["your_repeated_move"],
                "repeat_mistake_count": item["repeat_mistake_count"],
                "value_lost_cp": item["value_lost_cp"],
                "frequency": item["frequency"],
            }
            for item in weakest
        ],
        "strongest_lines": [
            {
                "lesson_id": item["lesson_id"],
                "line_label": item["line_label"],
                "recommended_move": item["recommended_move"],
                "repeat_count": item["repeat_count"],
                "confidence": item["confidence"],
                "frequency": item["frequency"],
            }
            for item in strongest
        ],
    }


def _build_mistake_heatmap(repeated_work_lines: list[dict[str, Any]]) -> dict[str, Any]:
    square_totals: dict[str, dict[str, Any]] = defaultdict(lambda: {"square": "", "score": 0.0, "sources": 0, "targets": 0, "lines": []})
    for item in repeated_work_lines:
        uci = str(item.get("your_repeated_move_uci") or item.get("your_top_move_uci") or "")
        if len(uci) < 4:
            continue
        source, target = uci[:2], uci[2:4]
        severity = max(1.0, float(item.get("value_lost_cp", 0))) * max(1, int(item.get("repeat_mistake_count", 0)))
        for square, kind in ((source, "sources"), (target, "targets")):
            bucket = square_totals[square]
            bucket["square"] = square
            bucket["score"] += severity
            bucket[kind] += 1
            bucket["lines"].append(
                {
                    "lesson_id": item.get("lesson_id", ""),
                    "line_label": item.get("line_label", ""),
                    "your_repeated_move": item.get("your_repeated_move", ""),
                    "recommended_move": item.get("recommended_move", ""),
                    "repeat_mistake_count": item.get("repeat_mistake_count", 0),
                }
            )
    squares = sorted(square_totals.values(), key=lambda item: -item["score"])[:12]
    max_score = max([item["score"] for item in squares], default=1.0)
    for item in squares:
        item["intensity"] = round((item["score"] / max_score) * 100, 1)
        item["score"] = round(item["score"], 1)
        item["lines"] = item["lines"][:3]
    return {
        "squares": squares,
        "top_lines": [
            {
                "lesson_id": item["lesson_id"],
                "line_label": item["line_label"],
                "your_repeated_move": item["your_repeated_move"],
                "recommended_move": item["recommended_move"],
                "repeat_mistake_count": item["repeat_mistake_count"],
                "value_lost_cp": item["value_lost_cp"],
            }
            for item in sorted(repeated_work_lines, key=lambda row: (-row["repeat_mistake_count"], -row["value_lost_cp"]))[:8]
        ],
    }


def _build_mistake_timeline(repeated_work_lines: list[dict[str, Any]]) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for item in sorted(
        repeated_work_lines,
        key=lambda row: (
            int(row.get("first_seen_game", 0) or 0),
            -int(row.get("repeat_mistake_count", 0) or 0),
            -float(row.get("value_lost_cp", 0) or 0),
        ),
    ):
        first_seen = int(item.get("first_seen_game", 0) or 0)
        last_seen = int(item.get("last_seen_game", 0) or first_seen)
        span = max(0, last_seen - first_seen)
        repeat_misses = int(item.get("repeat_mistake_count", 0) or 0)
        value_lost = float(item.get("value_lost_cp", 0) or 0)
        severity = "watch"
        if repeat_misses >= 5 or value_lost >= 120:
            severity = "urgent"
        elif repeat_misses >= 3 or value_lost >= 60:
            severity = "active"
        result_breakdown = item.get("result_breakdown") or {}
        items.append(
            {
                "lesson_id": item.get("lesson_id", ""),
                "line_label": item.get("line_label", ""),
                "opening_name": item.get("opening_name", ""),
                "opening_code": item.get("opening_code", ""),
                "color": item.get("color", ""),
                "first_seen_game": first_seen,
                "last_seen_game": last_seen,
                "first_seen_label": item.get("first_seen_label") or (f"Game {first_seen}" if first_seen else "Unknown"),
                "last_seen_label": item.get("last_seen_label") or (f"Game {last_seen}" if last_seen else "Unknown"),
                "span_games": span,
                "your_repeated_move": item.get("your_repeated_move", ""),
                "recommended_move": item.get("recommended_move", ""),
                "repeat_mistake_count": repeat_misses,
                "frequency": item.get("frequency", 0),
                "value_lost_cp": round(value_lost, 1),
                "severity": severity,
                "result_breakdown": {
                    "wins": int(result_breakdown.get("wins", 0) or 0),
                    "draws": int(result_breakdown.get("draws", 0) or 0),
                    "losses": int(result_breakdown.get("losses", 0) or 0),
                },
                "continuation_san": item.get("continuation_san", ""),
                "position_identifier": item.get("position_identifier", ""),
            }
        )
    recent = sorted(items, key=lambda row: (-int(row.get("last_seen_game", 0) or 0), -int(row.get("repeat_mistake_count", 0) or 0)))[:8]
    oldest = items[:8]
    urgent = [item for item in items if item["severity"] == "urgent"][:8]
    return {
        "items": items[:40],
        "recent": recent,
        "oldest": oldest,
        "urgent": urgent,
        "summary": {
            "tracked": len(items),
            "urgent": len([item for item in items if item["severity"] == "urgent"]),
            "active": len([item for item in items if item["severity"] == "active"]),
            "watch": len([item for item in items if item["severity"] == "watch"]),
        },
    }


def _build_transposition_groups(lessons: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for lesson in lessons:
        key = str(lesson.get("transposition_group_id") or lesson.get("position_identifier") or lesson.get("position_fen") or "")
        if key:
            grouped[key].append(lesson)

    groups: list[dict[str, Any]] = []
    for key, items in grouped.items():
        labels: list[str] = []
        moves: list[str] = []
        for item in items:
            label = str(item.get("line_label") or item.get("opening_name") or "")
            if label and label not in labels:
                labels.append(label)
            for target in item.get("transposition_targets", []) or []:
                move_label = str(target.get("san") or target.get("uci") or "")
                if move_label and move_label not in moves:
                    moves.append(move_label)
        if len(items) < 2 and len(moves) < 2:
            continue
        sample = items[0]
        groups.append(
            {
                "transposition_group_id": key,
                "position_fen": sample.get("position_fen", ""),
                "position_identifier": sample.get("position_identifier", ""),
                "side_to_move": sample.get("side_to_move", ""),
                "labels": labels[:5],
                "moves": moves[:6],
                "positions": len(items),
                "frequency": sum(int(item.get("frequency", 0)) for item in items),
                "confidence": round(mean([float(item.get("confidence", 0)) for item in items]), 1),
                "lesson_ids": [str(item.get("lesson_id", "")) for item in items[:6] if item.get("lesson_id")],
            }
        )
    return sorted(groups, key=lambda item: (-item["frequency"], -item["positions"]))[:18]


def _build_review_schedule(
    queue_due: list[dict[str, Any]],
    queue_new: list[dict[str, Any]],
    known_line_archive: list[dict[str, Any]],
) -> dict[str, Any]:
    def compact(item: dict[str, Any], bucket: str) -> dict[str, Any]:
        confidence = float(item.get("confidence", 0))
        if bucket == "due":
            interval = "today"
        elif confidence >= 80:
            interval = "14 days"
        elif confidence >= 55:
            interval = "7 days"
        else:
            interval = "3 days"
        return {
            "lesson_id": item.get("lesson_id", ""),
            "line_label": item.get("line_label", ""),
            "bucket": bucket,
            "interval": interval,
            "confidence": confidence,
            "repeat_count": item.get("repeat_count", 0),
            "status": item.get("line_status", ""),
        }

    return {
        "due_today": [compact(item, "due") for item in queue_due[:16]],
        "new_later": [compact(item, "new") for item in queue_new[:12]],
        "known_archive": [compact(item, "known") for item in known_line_archive[:12]],
    }


def _build_database_training(queue_due: list[dict[str, Any]], queue_new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for item in [*queue_due, *queue_new]:
        replies = item.get("common_replies") or item.get("database_moves") or []
        if not replies:
            continue
        candidates.append(
            {
                "lesson_id": item.get("lesson_id", ""),
                "line_label": item.get("line_label", ""),
                "position_fen": item.get("position_fen", ""),
                "recommended_move": item.get("recommended_move", ""),
                "recommended_move_uci": item.get("recommended_move_uci") or item.get("best_reply_uci", ""),
                "top_database_reply": replies[0],
                "database_moves": replies[:5],
                "priority": item.get("priority", 0),
                "frequency": item.get("frequency", 0),
            }
        )
    return sorted(candidates, key=lambda item: (-float(item.get("priority", 0)), -int(item.get("frequency", 0))))[:20]


def _memory_score_for_line(item: dict[str, Any]) -> int:
    confidence = float(item.get("confidence", 0) or 0)
    repeats = min(30.0, float(item.get("repeat_count", 0) or 0) / 4)
    frequency = min(15.0, float(item.get("frequency", 0) or 0) * 1.5)
    misses = min(35.0, float(item.get("repeat_mistake_count", 0) or 0) * 8)
    value_loss = min(20.0, float(item.get("value_lost_cp", 0) or 0) / 12)
    if item.get("line_status") == "known":
        raw = confidence + repeats + frequency
    elif item.get("line_status") == "needs_work":
        raw = confidence + frequency - misses - value_loss
    else:
        raw = confidence + frequency - 8
    return int(max(0, min(100, round(raw))))


def _build_memory_scores(lessons: list[dict[str, Any]]) -> dict[str, Any]:
    scored: list[dict[str, Any]] = []
    for item in lessons:
        score = _memory_score_for_line(item)
        bucket = "strong"
        if score < 45:
            bucket = "fragile"
        elif score < 70:
            bucket = "building"
        scored.append(
            {
                "lesson_id": item.get("lesson_id", ""),
                "line_label": item.get("line_label", ""),
                "opening_name": item.get("opening_name", ""),
                "color": item.get("color", ""),
                "score": score,
                "bucket": bucket,
                "status": item.get("line_status", ""),
                "recommended_move": item.get("recommended_move", ""),
                "your_repeated_move": item.get("your_repeated_move", ""),
                "repeat_mistake_count": item.get("repeat_mistake_count", 0),
                "frequency": item.get("frequency", 0),
                "confidence": item.get("confidence", 0),
            }
        )
    fragile = sorted([item for item in scored if item["bucket"] == "fragile"], key=lambda row: row["score"])[:8]
    strong = sorted([item for item in scored if item["bucket"] == "strong"], key=lambda row: -row["score"])[:8]
    average = round(mean([item["score"] for item in scored]), 1) if scored else 0.0
    return {
        "average": average,
        "fragile_count": len([item for item in scored if item["bucket"] == "fragile"]),
        "building_count": len([item for item in scored if item["bucket"] == "building"]),
        "strong_count": len([item for item in scored if item["bucket"] == "strong"]),
        "fragile_lines": fragile,
        "strong_lines": strong,
    }


def _first_player_move(imported: ImportedGame) -> tuple[str, str] | None:
    board = imported.game.board()
    player_is_white = imported.player_color == "white"
    for move in imported.game.mainline_moves():
        if board.turn == player_is_white:
            san = board.san(move)
            return san, move.uci()
        board.push(move)
    return None


def _build_opening_drift(games: list[ImportedGame]) -> dict[str, Any]:
    by_color: dict[str, list[ImportedGame]] = {"white": [], "black": []}
    for imported in games:
        if imported.player_color in by_color:
            by_color[imported.player_color].append(imported)

    sections: list[dict[str, Any]] = []
    alerts: list[dict[str, Any]] = []
    for color, color_games in by_color.items():
        total_moves: Counter[str] = Counter()
        recent_moves: Counter[str] = Counter()
        recent_count = min(len(color_games), max(8, len(color_games) // 4)) if color_games else 0
        recent_games = color_games[-recent_count:] if recent_count else []
        uci_by_san: dict[str, str] = {}

        for imported in color_games:
            first = _first_player_move(imported)
            if not first:
                continue
            san, uci = first
            total_moves[san] += 1
            uci_by_san.setdefault(san, uci)
        for imported in recent_games:
            first = _first_player_move(imported)
            if not first:
                continue
            san, uci = first
            recent_moves[san] += 1
            uci_by_san.setdefault(san, uci)

        total_seen = sum(total_moves.values())
        recent_seen = sum(recent_moves.values())
        rows: list[dict[str, Any]] = []
        for san, recent_n in recent_moves.most_common(8):
            old_pct = (total_moves[san] / total_seen) * 100 if total_seen else 0.0
            recent_pct = (recent_n / recent_seen) * 100 if recent_seen else 0.0
            drift = round(recent_pct - old_pct, 1)
            row = {
                "color": color,
                "move": san,
                "uci": uci_by_san.get(san, ""),
                "recent_count": recent_n,
                "total_count": total_moves[san],
                "recent_pct": round(recent_pct, 1),
                "overall_pct": round(old_pct, 1),
                "drift": drift,
                "tone": "new" if total_moves[san] <= recent_n and recent_n >= 2 else ("rising" if drift >= 12 else "stable"),
            }
            rows.append(row)
            if row["tone"] in {"new", "rising"}:
                alerts.append(row)

        sections.append(
            {
                "color": color,
                "games": len(color_games),
                "recent_games": recent_count,
                "moves": rows,
            }
        )

    return {
        "sections": sections,
        "alerts": sorted(alerts, key=lambda row: (-float(row.get("drift", 0)), -int(row.get("recent_count", 0))))[:8],
    }


def _build_prep_pack(
    queue_due: list[dict[str, Any]],
    queue_new: list[dict[str, Any]],
    database_training: list[dict[str, Any]],
    known_line_archive: list[dict[str, Any]],
) -> dict[str, Any]:
    focus = queue_due[:6]
    next_up = queue_new[:4]
    replies = database_training[:5]
    maintenance = known_line_archive[:4]
    return {
        "title": "Bookup preparation pack",
        "focus_lines": [
            {
                "lesson_id": item.get("lesson_id", ""),
                "line_label": item.get("line_label", ""),
                "train": item.get("recommended_move", ""),
                "instead_of": item.get("your_repeated_move", ""),
                "why": item.get("queue_explainer", {}).get("summary") or item.get("coach_explanation", ""),
                "continuation": item.get("continuation_san", ""),
            }
            for item in focus
        ],
        "next_up": [
            {
                "lesson_id": item.get("lesson_id", ""),
                "line_label": item.get("line_label", ""),
                "move": item.get("recommended_move", ""),
                "continuation": item.get("continuation_san", ""),
            }
            for item in next_up
        ],
        "common_replies": [
            {
                "lesson_id": item.get("lesson_id", ""),
                "line_label": item.get("line_label", ""),
                "reply": (item.get("top_database_reply") or {}).get("san") or (item.get("top_database_reply") or {}).get("uci", ""),
                "response": item.get("recommended_move", ""),
            }
            for item in replies
        ],
        "maintenance": [
            {
                "lesson_id": item.get("lesson_id", ""),
                "line_label": item.get("line_label", ""),
                "move": item.get("recommended_move", ""),
                "repeat_count": item.get("repeat_count", 0),
            }
            for item in maintenance
        ],
    }


def _compact_training_card(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "lesson_id": item.get("lesson_id", ""),
        "line_label": item.get("line_label", ""),
        "opening_name": item.get("opening_name", ""),
        "opening_code": item.get("opening_code", ""),
        "position_fen": item.get("position_fen", ""),
        "recommended_move": item.get("recommended_move", ""),
        "your_repeated_move": item.get("your_repeated_move", item.get("your_top_move", "")),
        "continuation_san": item.get("continuation_san", ""),
        "frequency": item.get("frequency", 0),
        "priority": item.get("priority", 0),
        "repeat_count": item.get("repeat_count", 0),
        "repeat_mistake_count": item.get("repeat_mistake_count", 0),
        "confidence": item.get("confidence", 0),
        "memory_score": item.get("memory_score", 0),
        "line_status": item.get("line_status", ""),
        "classification": item.get("recommended_classification") or {},
    }


def _build_study_plan(
    queue_due: list[dict[str, Any]],
    queue_new: list[dict[str, Any]],
    known_line_archive: list[dict[str, Any]],
    memory_scores: dict[str, Any],
    database_training: list[dict[str, Any]],
) -> dict[str, Any]:
    fragile = memory_scores.get("fragile_lines", []) if memory_scores else []
    focus = fragile[:4] or queue_due[:4]
    new_preview = queue_new[:3]
    replies = database_training[:3]
    maintenance = known_line_archive[:2]
    minutes = 8 + (len(focus) * 3) + (len(new_preview) * 2) + (len(replies) * 2)
    blocks = [
        {
            "title": "Warm up known lines",
            "minutes": 4,
            "goal": "Start with easy wins so the board feels familiar.",
            "items": [_compact_training_card(item) for item in maintenance],
        },
        {
            "title": "Repair fragile branches",
            "minutes": max(6, len(focus) * 3),
            "goal": "Repeat the exact positions that have the lowest memory score or highest priority.",
            "items": [_compact_training_card(item) for item in focus],
        },
        {
            "title": "Opponent reply simulator",
            "minutes": max(4, len(replies) * 2),
            "goal": "Answer common practical replies from the database, not random engine fantasy.",
            "items": [
                {
                    "lesson_id": item.get("lesson_id", ""),
                    "line_label": item.get("line_label", ""),
                    "opponent_reply": (item.get("top_database_reply") or {}).get("san") or (item.get("top_database_reply") or {}).get("uci", ""),
                    "response": item.get("recommended_move", ""),
                    "popularity": (item.get("top_database_reply") or {}).get("popularity", 0),
                }
                for item in replies
            ],
        },
        {
            "title": "Preview new branches",
            "minutes": max(4, len(new_preview) * 2),
            "goal": "Look at new-but-not-urgent positions without polluting the due queue.",
            "items": [_compact_training_card(item) for item in new_preview],
        },
    ]
    return {
        "estimated_minutes": minutes,
        "summary": f"{minutes} minute session: repair {len(focus)} fragile branches, rehearse {len(replies)} common replies, and preview {len(new_preview)} new lines.",
        "blocks": blocks,
    }


def _build_confidence_graph(lessons: list[dict[str, Any]]) -> dict[str, Any]:
    buckets = [
        {"label": "0-30", "min": 0, "max": 30, "count": 0, "tone": "danger"},
        {"label": "31-50", "min": 31, "max": 50, "count": 0, "tone": "warn"},
        {"label": "51-70", "min": 51, "max": 70, "count": 0, "tone": "building"},
        {"label": "71-85", "min": 71, "max": 85, "count": 0, "tone": "stable"},
        {"label": "86-100", "min": 86, "max": 100, "count": 0, "tone": "strong"},
    ]
    by_status = Counter()
    for item in lessons:
        confidence = int(round(float(item.get("confidence", 0) or 0)))
        by_status[str(item.get("line_status", "unknown"))] += 1
        for bucket in buckets:
            if bucket["min"] <= confidence <= bucket["max"]:
                bucket["count"] += 1
                break
    total = max(1, len(lessons))
    for bucket in buckets:
        bucket["pct"] = round((bucket["count"] / total) * 100, 1)
    slipping = sorted(
        [item for item in lessons if item.get("line_status") == "needs_work"],
        key=lambda row: (float(row.get("memory_score", 100) or 100), -int(row.get("priority", 0) or 0)),
    )[:6]
    locked = sorted(
        [item for item in lessons if item.get("line_status") == "known"],
        key=lambda row: (-int(row.get("repeat_count", 0) or 0), -float(row.get("confidence", 0) or 0)),
    )[:6]
    return {
        "total": len(lessons),
        "buckets": buckets,
        "by_status": dict(by_status),
        "slipping_lines": [_compact_training_card(item) for item in slipping],
        "locked_lines": [_compact_training_card(item) for item in locked],
    }


def _classification_key(record: dict[str, Any] | None) -> str:
    return str((record or {}).get("key") or (record or {}).get("label") or "").strip().lower()


def _build_repertoire_brilliant_watchlist(lessons: list[dict[str, Any]]) -> dict[str, Any]:
    watchlist: list[dict[str, Any]] = []
    counts: Counter[str] = Counter()
    seen: set[tuple[str, str, str]] = set()

    def add_candidate(lesson: dict[str, Any], *, role: str, move: str, uci: str, classification: dict[str, Any] | None) -> None:
        key = _classification_key(classification)
        if not key:
            return
        counts[key] += 1
        if key not in {"brilliant", "great", "best", "excellent"}:
            return
        unique_key = (str(lesson.get("lesson_id", "")), role, uci or move)
        if unique_key in seen:
            return
        seen.add(unique_key)
        item = {
            "lesson_id": lesson.get("lesson_id", ""),
            "line_label": lesson.get("line_label", ""),
            "opening_name": lesson.get("opening_name", ""),
            "opening_code": lesson.get("opening_code", ""),
            "position_fen": lesson.get("position_fen", ""),
            "position_identifier": lesson.get("position_identifier", ""),
            "role": role,
            "move": move,
            "uci": uci,
            "classification": classification or {},
            "reason": (classification or {}).get("reason", ""),
            "priority": int(lesson.get("priority", 0) or 0),
            "frequency": int(lesson.get("frequency", 0) or 0),
        }
        watchlist.append(item)

    for lesson in lessons:
        add_candidate(
            lesson,
            role="recommended move",
            move=str(lesson.get("recommended_move", "") or ""),
            uci=str(lesson.get("best_reply_uci", "") or ""),
            classification=lesson.get("recommended_classification"),
        )
        add_candidate(
            lesson,
            role="your repeated move",
            move=str(lesson.get("your_repeated_move", "") or ""),
            uci=str(lesson.get("your_top_move_uci", "") or ""),
            classification=lesson.get("your_move_classification"),
        )
        for index, line in enumerate((lesson.get("candidate_lines") or [])[:5], start=1):
            add_candidate(
                lesson,
                role=f"engine line {index}",
                move=str(line.get("move", "") or ""),
                uci=str(line.get("uci", "") or ""),
                classification=line.get("classification"),
            )

    sort_key = lambda item: (-int(item.get("priority", 0) or 0), -int(item.get("frequency", 0) or 0), str(item.get("line_label", "")))
    watchlist.sort(key=sort_key)
    return {
        "summary": {
            "lessons_scanned": len(lessons),
            "watchlist": len(watchlist),
            "counts": dict(counts),
        },
        "watchlist": watchlist[:32],
    }


def _cached_candidate_lines_for_brilliant_scan(
    board: chess.Board,
    engine: EngineSession,
    *,
    live_budget: list[int],
    budget_lock: threading.Lock | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
    cache_key = _engine_cache_key(
        "candidate-lines",
        board,
        engine,
        play_uci=[],
        limit=5,
        time_sec=BRILLIANT_TRACKER_TIME_SEC,
        extra={"include_database": False},
    )
    cached = _load_engine_cache(cache_key)
    if cached:
        return list(cached.get("candidate_lines", [])), list(cached.get("database_moves", [])), True
    if not _take_brilliant_live_budget(live_budget, budget_lock):
        return [], [], False
    candidate_lines, database_moves, _cache_hit = _candidate_lines_for_board(
        board,
        engine,
        play_uci=[],
        limit=5,
        time_sec=BRILLIANT_TRACKER_TIME_SEC,
        include_database=False,
    )
    return candidate_lines, database_moves, False


def _take_brilliant_live_budget(live_budget: list[int], budget_lock: threading.Lock | None = None) -> bool:
    def take() -> bool:
        if live_budget[0] < 0:
            return True
        if live_budget[0] <= 0:
            return False
        live_budget[0] -= 1
        return True

    if budget_lock is None:
        return take()
    with budget_lock:
        return take()


def _within_brilliant_scan_window(ply_index: int) -> bool:
    if BRILLIANT_TRACKER_MAX_PLIES <= 0:
        return True
    return ply_index <= BRILLIANT_TRACKER_MAX_PLIES


def _played_move_classification_for_brilliant_scan(
    board: chess.Board,
    move: chess.Move,
    move_san: str,
    *,
    path_uci: list[str],
    candidate_lines: list[dict[str, Any]],
    database_moves: list[dict[str, Any]],
    engine: EngineSession,
    live_budget: list[int],
    budget_lock: threading.Lock | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str]:
    """Classify the played move from the current-position MultiPV candidates.

    A move must be a current top candidate before it can be Brilliant. The older
    direct played-branch scan was too permissive and promoted random late moves
    after the position had already changed.
    """

    played_uci = move.uci()
    played_line = next((line for line in candidate_lines if str(line.get("uci") or "") == played_uci), None)
    if played_line:
        return played_line, played_line.get("classification"), "candidate"
    if not candidate_lines:
        return None, None, "no_candidates"
    return None, None, "not_top_candidate"


def _node_has_chesscom_brilliant_annotation(node: Any) -> bool:
    """Detect trusted Chess.com review Brilliant marks preserved in imported PGN nodes."""

    nags = getattr(node, "nags", set()) or set()
    try:
        if 3 in nags:  # PGN $3 / "!!"
            return True
    except TypeError:
        pass
    comment = str(getattr(node, "comment", "") or "").lower()
    return "type;brilliant" in comment or "classification=brilliant" in comment or "$3" in comment


def _game_url_label(imported: ImportedGame, index: int) -> str:
    if imported.url:
        return imported.url.rsplit("/", 1)[-1] or imported.url
    site = _header_text(imported, "Site")
    if site:
        return site.rsplit("/", 1)[-1] or site
    return f"game-{index}"


def _empty_brilliant_progress(message: str = "Import games to chart Brilliant moves over time.") -> dict[str, Any]:
    return {
        "available": False,
        "message": message,
        "default_range": "90",
        "default_time_class": "",
        "ranges": {},
        "time_class_progress": {},
        "time_class_breakdown": [],
    }


def _brilliant_range_label(key: str) -> str:
    return {
        "7": "7 days",
        "30": "30 days",
        "90": "90 days",
        "365": "1 year",
        "all": "All imported",
    }.get(key, key)


def _build_brilliant_progress(game_rows: list[dict[str, Any]]) -> dict[str, Any]:
    dated_rows = [row for row in game_rows if isinstance(row.get("date_obj"), date)]
    if not dated_rows:
        return _empty_brilliant_progress("No dated games are available for the Brilliant timeline yet.")

    time_counter: Counter[str] = Counter()
    brilliant_counter: Counter[str] = Counter()
    for row in dated_rows:
        key = str(row.get("time_class") or "unknown")
        time_counter[key] += 1
        brilliant_counter[key] += int(row.get("brilliants", 0) or 0)

    def build_payload(rows: list[dict[str, Any]], label: str, time_key: str = "") -> dict[str, Any]:
        if not rows:
            return {
                "available": False,
                "time_class_label": label,
                "ranges": {},
                "default_range": "90",
                "total_games": 0,
                "total_brilliants": 0,
                "games_with_brilliants": 0,
            }
        rows = sorted(rows, key=lambda item: (item["date_obj"], int(item.get("source_index", 0) or 0)))
        daily: dict[date, dict[str, Any]] = {}
        for row in rows:
            day = row["date_obj"]
            bucket = daily.setdefault(
                day,
                {
                    "date": day,
                    "games": 0,
                    "wins": 0,
                    "draws": 0,
                    "losses": 0,
                    "brilliants": 0,
                    "games_with_brilliants": 0,
                    "opponents": [],
                    "game_links": [],
                },
            )
            result = str(row.get("result") or "")
            bucket["games"] += 1
            bucket["wins"] += 1 if result == "win" else 0
            bucket["draws"] += 1 if result == "draw" else 0
            bucket["losses"] += 1 if result == "loss" else 0
            brilliant_count = int(row.get("brilliants", 0) or 0)
            bucket["brilliants"] += brilliant_count
            if brilliant_count > 0:
                bucket["games_with_brilliants"] += 1
                bucket["game_links"].append(
                    {
                        "url": row.get("game_url", ""),
                        "opponent": row.get("opponent", ""),
                        "result": result,
                        "color": row.get("player_color", ""),
                        "time_class": row.get("time_class", "unknown"),
                        "brilliants": brilliant_count,
                        "pgn_path": row.get("pgn_path", ""),
                    }
                )
            opponent = row.get("opponent")
            if opponent:
                bucket["opponents"].append(str(opponent))

        ordered_days = [daily[day] for day in sorted(daily)]
        first_day = ordered_days[0]["date"]
        last_day = ordered_days[-1]["date"]

        def make_range(key: str, days: int | None) -> dict[str, Any]:
            cutoff = first_day if days is None else max(first_day, last_day - timedelta(days=max(days - 1, 0)))
            selected = [bucket for bucket in ordered_days if bucket["date"] >= cutoff]
            points = []
            for index, bucket in enumerate(selected):
                brilliants = int(bucket["brilliants"])
                games = int(bucket["games"])
                game_links = sorted(
                    bucket["game_links"],
                    key=lambda item: (-int(item.get("brilliants", 0) or 0), str(item.get("opponent", ""))),
                )
                points.append(
                    {
                        "index": index,
                        "date": bucket["date"].isoformat(),
                        "label": _format_progress_date(bucket["date"]),
                        "graph_value": brilliants,
                        "brilliants": brilliants,
                        "games": games,
                        "games_with_brilliants": int(bucket["games_with_brilliants"]),
                        "wins": int(bucket["wins"]),
                        "draws": int(bucket["draws"]),
                        "losses": int(bucket["losses"]),
                        "record": _result_record_text(int(bucket["wins"]), int(bucket["draws"]), int(bucket["losses"])),
                        "win_rate": _win_rate(int(bucket["wins"]), int(bucket["draws"]), int(bucket["losses"])),
                        "score_rate": _score_rate(int(bucket["wins"]), int(bucket["draws"]), int(bucket["losses"])),
                        "summary": f"{brilliants} Brilliant{'s' if brilliants != 1 else ''} in {games} game{'s' if games != 1 else ''}",
                        "opponents": sorted(set(bucket["opponents"]))[:8],
                        "game_links": game_links,
                        "last_game_url": game_links[-1].get("url", "") if game_links else "",
                        "result_tone": "win" if brilliants >= 2 else ("draw" if brilliants == 1 else "idle"),
                    }
                )
            total_games = sum(int(point["games"]) for point in points)
            total_brilliants = sum(int(point["brilliants"]) for point in points)
            total_with = sum(int(point["games_with_brilliants"]) for point in points)
            best_day = max(points, key=lambda point: (int(point["brilliants"]), int(point["games"])), default=None)
            busiest_day = max(points, key=lambda point: int(point["games"]), default=None)
            return {
                "available": bool(points),
                "label": _brilliant_range_label(key),
                "points": points,
                "start_date": points[0]["date"] if points else "",
                "end_date": points[-1]["date"] if points else "",
                "games": total_games,
                "total_games": total_games,
                "total_brilliants": total_brilliants,
                "games_with_brilliants": total_with,
                "best_day": best_day,
                "busiest_day": busiest_day,
                "brilliants_per_game": round(total_brilliants / total_games, 3) if total_games else 0,
                "max_brilliants": int(best_day.get("brilliants", 0)) if best_day else 0,
            }

        ranges = {
            "7": make_range("7", 7),
            "30": make_range("30", 30),
            "90": make_range("90", 90),
            "365": make_range("365", 365),
            "all": make_range("all", None),
        }
        return {
            "available": True,
            "time_class_label": label,
            "time_class": time_key,
            "ranges": ranges,
            "default_range": "90" if ranges.get("90", {}).get("points") else "all",
            "total_games": len(rows),
            "dated_games": len(rows),
            "total_brilliants": sum(int(row.get("brilliants", 0) or 0) for row in rows),
            "games_with_brilliants": sum(1 for row in rows if int(row.get("brilliants", 0) or 0) > 0),
        }

    time_class_progress: dict[str, Any] = {}
    for key in sorted(time_counter, key=lambda item: (-brilliant_counter[item], -time_counter[item], item)):
        rows = [row for row in dated_rows if str(row.get("time_class") or "unknown") == key]
        time_class_progress[key] = build_payload(rows, key.replace("_", " ").title(), key)

    default_time_class = next(iter(time_class_progress), "")
    return {
        **build_payload(dated_rows, "All imported games", ""),
        "default_time_class": default_time_class,
        "time_class_progress": time_class_progress,
        "time_class_breakdown": [
            {
                "key": key,
                "label": key,
                "games": int(time_counter[key]),
                "brilliants": int(brilliant_counter[key]),
                "games_with_brilliants": int(time_class_progress.get(key, {}).get("games_with_brilliants", 0) or 0),
            }
            for key in sorted(time_counter, key=lambda item: (-brilliant_counter[item], -time_counter[item], item))
        ],
    }


def _build_game_brilliant_tracker(
    games: list[ImportedGame],
    lessons: list[dict[str, Any]],
    engine: EngineSession,
    progress_callback: Callable[..., None] | None = None,
) -> dict[str, Any]:
    repertoire_watchlist = _build_repertoire_brilliant_watchlist(lessons)
    live_budget = [-1 if BRILLIANT_TRACKER_LIVE_BUDGET <= 0 else max(BRILLIANT_TRACKER_LIVE_BUDGET, min(900, len(games) * 2))]
    budget_lock = threading.Lock()
    brilliant_moves: list[dict[str, Any]] = []
    brilliant_games: list[dict[str, Any]] = []
    game_rows: list[dict[str, Any]] = []
    counts: Counter[str] = Counter()
    games_scanned = 0
    moves_scanned = 0
    classified_moves = 0
    candidate_cache_hits = 0
    candidate_live_hits = 0
    played_cache_hits = 0
    played_live_hits = 0
    not_top_candidate_moves = 0
    skipped_live_budget = 0
    unclassified_moves = 0
    total_game_moves = 0
    player_moves_total = 0
    opponent_moves_ignored = 0
    moves_outside_scan_window = 0

    def notify(**patch: Any) -> None:
        if not progress_callback:
            return
        try:
            progress_callback(**patch)
        except Exception:
            pass

    def sort_date_key(imported: ImportedGame) -> tuple[date, int]:
        return (_parse_game_date(imported) or date.min, _parse_game_time_seconds(imported))

    ordered_games = sorted(games, key=sort_date_key, reverse=True)
    scan_started = time.perf_counter()
    total_games = len(ordered_games)
    configured_workers = max(1, int(getattr(engine, "worker_count", 1) or 1))
    scan_workers = max(1, min(configured_workers, total_games or 1))

    def scan_game(game_index: int, imported: ImportedGame) -> dict[str, Any]:
        player_color = imported.player_color if imported.player_color in {"white", "black"} else "white"
        player_turn = chess.WHITE if player_color == "white" else chess.BLACK
        board = imported.game.board()
        path_san: list[str] = []
        path_uci: list[str] = []
        game_brilliants: list[dict[str, Any]] = []
        local_counts: Counter[str] = Counter()
        local_moves_scanned = 0
        local_classified_moves = 0
        local_candidate_cache_hits = 0
        local_candidate_live_hits = 0
        local_played_cache_hits = 0
        local_played_live_hits = 0
        local_not_top_candidate_moves = 0
        local_skipped_live_budget = 0
        local_unclassified_moves = 0
        local_total_game_moves = 0
        local_player_moves_total = 0
        local_opponent_moves_ignored = 0
        local_moves_outside_scan_window = 0
        local_live_positions: list[dict[str, Any]] = []
        played_on = _parse_game_date(imported)
        result_key = _classify_result(imported.result or str(imported.game.headers.get("Result", "")), player_color)
        opponent = imported.opponent or ("Black" if player_color == "white" else "White")
        game_id = _game_url_label(imported, game_index)
        date_label = _game_date_label(imported, game_index)
        time_class = imported.time_class or "unknown"
        node = imported.game
        ply_index = 0
        while node.variations:
            child = node.variation(0)
            move = child.move
            ply_index += 1
            if move not in board.legal_moves:
                break
            san = board.san(move)
            local_total_game_moves += 1
            is_player_move = board.turn == player_turn
            in_scan_window = _within_brilliant_scan_window(ply_index)
            if is_player_move:
                local_player_moves_total += 1
            else:
                local_opponent_moves_ignored += 1
            if is_player_move and not in_scan_window:
                local_moves_outside_scan_window += 1
            has_review_brilliant = _node_has_chesscom_brilliant_annotation(child)
            should_scan = is_player_move and (in_scan_window or has_review_brilliant)
            if should_scan:
                local_moves_scanned += 1
                played_uci = move.uci()
                if len(local_live_positions) < 3:
                    local_live_positions.append(
                        _analysis_progress_preview(
                            board.fen(),
                            label=san,
                            subtitle=f"{date_label} · vs {opponent}",
                            status="Classifying",
                            orientation=player_color,
                        )
                    )
                if has_review_brilliant:
                    played_line = {
                        "uci": played_uci,
                        "move": san,
                        "san": san,
                        "line_san": san,
                    }
                    classification = classification_payload(
                        "brilliant",
                        loss=0.0,
                        expected_points=1.0,
                        reason="Chess.com review marked this move Brilliant",
                        is_real_piece_sacrifice=True,
                    )
                    classification_source = "pgn_brilliant"
                else:
                    candidate_lines, database_moves, from_cache = _cached_candidate_lines_for_brilliant_scan(
                        board,
                        engine,
                        live_budget=live_budget,
                        budget_lock=budget_lock,
                    )
                    if from_cache:
                        local_candidate_cache_hits += 1
                    elif candidate_lines:
                        local_candidate_live_hits += 1
                    played_line, classification, classification_source = _played_move_classification_for_brilliant_scan(
                        board,
                        move,
                        san,
                        path_uci=list(path_uci),
                        candidate_lines=candidate_lines,
                        database_moves=database_moves,
                        engine=engine,
                        live_budget=live_budget,
                        budget_lock=budget_lock,
                    )
                    if classification_source == "played_cache":
                        local_played_cache_hits += 1
                    elif classification_source == "played_live":
                        local_played_live_hits += 1
                    elif classification_source == "not_top_candidate":
                        local_not_top_candidate_moves += 1
                    elif classification_source == "budget_exhausted":
                        local_skipped_live_budget += 1
                key = _classification_key(classification)
                if key:
                    local_classified_moves += 1
                    local_counts[key] += 1
                elif classification_source == "not_top_candidate":
                    local_classified_moves += 1
                    local_counts["not_brilliant"] += 1
                else:
                    local_unclassified_moves += 1
                if key == "brilliant" and classification_source == "pgn_brilliant":
                    before_path = list(path_san)
                    item = {
                        "game_id": game_id,
                        "game_url": imported.url,
                        "date": played_on.isoformat() if played_on else "",
                        "date_label": date_label,
                        "time_class": time_class,
                        "result": result_key,
                        "opponent": opponent,
                        "player_color": player_color,
                        "move_number": (ply_index + 1) // 2,
                        "ply": ply_index,
                        "move": san,
                        "uci": played_uci,
                        "position_fen": board.fen(),
                        "position_identifier": _normalize_position_key(board),
                        "pgn_path": " ".join(before_path + [san]),
                        "classification": classification or {},
                        "reason": (classification or {}).get("reason", "best move plus a sound piece sacrifice"),
                        "line_san": str((played_line or {}).get("line_san", "") or ""),
                        "expected_points": float((classification or {}).get("expected_points", (played_line or {}).get("expected_points", 0.5)) or 0.5),
                        "classification_source": classification_source,
                    }
                    game_brilliants.append(item)
            board.push(move)
            path_san.append(san)
            path_uci.append(move.uci())
            node = child

        game_row = {
            "source_index": game_index,
            "game_id": game_id,
            "game_url": imported.url,
            "date_obj": played_on,
            "date": played_on.isoformat() if played_on else "",
            "date_label": date_label,
            "time_class": time_class,
            "result": result_key,
            "opponent": opponent,
            "player_color": player_color,
            "brilliants": len(game_brilliants),
            "pgn_path": game_brilliants[-1].get("pgn_path", "") if game_brilliants else " ".join(path_san[:12]),
        }
        brilliant_game = None
        if game_brilliants:
            brilliant_game = {
                "game_id": game_id,
                "game_url": imported.url,
                "date": played_on.isoformat() if played_on else "",
                "date_label": date_label,
                "time_class": time_class,
                "result": result_key,
                "opponent": opponent,
                "player_color": player_color,
                "brilliants": len(game_brilliants),
                "moves": game_brilliants[:6],
                "pgn_path": game_brilliants[-1].get("pgn_path", ""),
            }
        return {
            "game_index": game_index,
            "game_row": game_row,
            "brilliant_game": brilliant_game,
            "brilliant_moves": game_brilliants,
            "counts": local_counts,
            "moves_scanned": local_moves_scanned,
            "classified_moves": local_classified_moves,
            "candidate_cache_hits": local_candidate_cache_hits,
            "candidate_live_hits": local_candidate_live_hits,
            "played_cache_hits": local_played_cache_hits,
            "played_live_hits": local_played_live_hits,
            "not_top_candidate_moves": local_not_top_candidate_moves,
            "skipped_live_budget": local_skipped_live_budget,
            "unclassified_moves": local_unclassified_moves,
            "total_game_moves": local_total_game_moves,
            "player_moves_total": local_player_moves_total,
            "opponent_moves_ignored": local_opponent_moves_ignored,
            "moves_outside_scan_window": local_moves_outside_scan_window,
            "live_positions": local_live_positions,
        }

    def merge_scan_result(result: dict[str, Any]) -> None:
        nonlocal games_scanned, moves_scanned, classified_moves
        nonlocal candidate_cache_hits, candidate_live_hits, played_cache_hits, played_live_hits
        nonlocal not_top_candidate_moves, skipped_live_budget, unclassified_moves
        nonlocal total_game_moves, player_moves_total, opponent_moves_ignored, moves_outside_scan_window
        games_scanned += 1
        moves_scanned += int(result.get("moves_scanned", 0) or 0)
        classified_moves += int(result.get("classified_moves", 0) or 0)
        candidate_cache_hits += int(result.get("candidate_cache_hits", 0) or 0)
        candidate_live_hits += int(result.get("candidate_live_hits", 0) or 0)
        played_cache_hits += int(result.get("played_cache_hits", 0) or 0)
        played_live_hits += int(result.get("played_live_hits", 0) or 0)
        not_top_candidate_moves += int(result.get("not_top_candidate_moves", 0) or 0)
        skipped_live_budget += int(result.get("skipped_live_budget", 0) or 0)
        unclassified_moves += int(result.get("unclassified_moves", 0) or 0)
        total_game_moves += int(result.get("total_game_moves", 0) or 0)
        player_moves_total += int(result.get("player_moves_total", 0) or 0)
        opponent_moves_ignored += int(result.get("opponent_moves_ignored", 0) or 0)
        moves_outside_scan_window += int(result.get("moves_outside_scan_window", 0) or 0)
        counts.update(result.get("counts", Counter()))
        game_rows.append(result["game_row"])
        brilliant_moves.extend(result.get("brilliant_moves", []))
        if result.get("brilliant_game"):
            brilliant_games.append(result["brilliant_game"])
        for preview in result.get("live_positions", []) or []:
            live_scan_previews.append(preview)

    def notify_scan_progress(force: bool = False) -> None:
        if not force and games_scanned != 1 and games_scanned % 5 != 0 and games_scanned != total_games:
            return
        elapsed = max(0.001, time.perf_counter() - scan_started)
        rate = games_scanned / elapsed
        eta = ((total_games - games_scanned) / rate) if games_scanned and rate > 0 and total_games > games_scanned else 0
        notify(
            phase="brilliant_scan",
            progress=min(98, 80 + int((games_scanned / max(1, total_games)) * 18)),
            brilliant_games_done=games_scanned,
            brilliant_games_total=total_games,
            moves_scanned=moves_scanned,
            classified_moves=classified_moves,
            player_moves_total=player_moves_total,
            total_game_moves=total_game_moves,
            opponent_moves_ignored=opponent_moves_ignored,
            moves_outside_scan_window=moves_outside_scan_window,
            cache_hits=candidate_cache_hits + played_cache_hits,
            live_hits=candidate_live_hits + played_live_hits,
            eta_sec=round(eta, 1),
            items_per_second=round(rate, 2),
            games_per_second=round(rate, 2),
            live_positions=list(live_scan_previews),
            message=f"Scanning Brilliant candidates in your moves {games_scanned}/{total_games} games with {scan_workers} workers...",
        )

    live_scan_previews: deque[dict[str, Any]] = deque(maxlen=6)
    if scan_workers > 1 and total_games > 1:
        with ThreadPoolExecutor(max_workers=scan_workers, thread_name_prefix="bookup-brilliant") as executor:
            futures = [
                executor.submit(scan_game, game_index, imported)
                for game_index, imported in enumerate(ordered_games, start=1)
            ]
            for future in as_completed(futures):
                merge_scan_result(future.result())
                notify_scan_progress()
    else:
        for game_index, imported in enumerate(ordered_games, start=1):
            merge_scan_result(scan_game(game_index, imported))
            notify_scan_progress()

    notify_scan_progress(force=True)

    brilliant_moves.sort(key=lambda item: (str(item.get("date", "")), int(item.get("ply", 0) or 0)), reverse=True)
    brilliant_games.sort(key=lambda item: (-int(item.get("brilliants", 0) or 0), str(item.get("date_label", ""))), reverse=False)
    best_game = brilliant_games[0] if brilliant_games else None
    progress = _build_brilliant_progress(game_rows)
    cached_hits = candidate_cache_hits + played_cache_hits
    live_hits = candidate_live_hits + played_live_hits
    classification_status = {
        "stored_with_profile": True,
        "classified_during_import": True,
        "scope": "all imported games, every move made by you",
        "scan_mode": "trusted Chess.com review Brilliant markers stored; live engine ideas stay descriptive",
        "player_move_scope": "your moves only",
        "games_scanned": games_scanned,
        "moves_scanned": moves_scanned,
        "classified_moves": classified_moves,
        "player_moves_total": player_moves_total,
        "total_game_moves": total_game_moves,
        "opponent_moves_ignored": opponent_moves_ignored,
        "moves_outside_scan_window": moves_outside_scan_window,
        "cached_hits": cached_hits,
        "live_hits": live_hits,
        "candidate_cache_hits": candidate_cache_hits,
        "candidate_live_hits": candidate_live_hits,
        "played_cache_hits": played_cache_hits,
        "played_live_hits": played_live_hits,
        "not_top_candidate_moves": not_top_candidate_moves,
        "skipped_live_budget": skipped_live_budget,
        "unclassified_moves": unclassified_moves,
        "remaining_live_budget": live_budget[0],
        "scan_ply_limit": BRILLIANT_TRACKER_MAX_PLIES,
        "engine": {
            "depth": int(engine.settings.depth),
            "multipv": int(engine.settings.multipv),
            "think_time_sec": float(engine.settings.think_time_sec),
            "threads": int(engine.settings.threads),
            "hash_mb": int(engine.settings.hash_mb),
        },
    }
    return {
        "summary": {
            "total_brilliants": len(brilliant_moves),
            "games_with_brilliants": len(brilliant_games),
            "total_games": len(games),
            "games_scanned": games_scanned,
            "moves_scanned": moves_scanned,
            "classified_moves": classified_moves,
            "player_moves_total": player_moves_total,
            "total_game_moves": total_game_moves,
            "opponent_moves_ignored": opponent_moves_ignored,
            "moves_outside_scan_window": moves_outside_scan_window,
            "cached_hits": cached_hits,
            "live_hits": live_hits,
            "candidate_cache_hits": candidate_cache_hits,
            "candidate_live_hits": candidate_live_hits,
            "played_cache_hits": played_cache_hits,
            "played_live_hits": played_live_hits,
            "not_top_candidate_moves": not_top_candidate_moves,
            "skipped_live_budget": skipped_live_budget,
            "unclassified_moves": unclassified_moves,
            "scan_game_limit": "all",
            "scan_ply_limit": BRILLIANT_TRACKER_MAX_PLIES,
            "remaining_live_budget": live_budget[0],
            "counts": dict(counts),
            "watchlist": len(repertoire_watchlist.get("watchlist", [])),
            "stored_with_profile": True,
            "classified_during_import": True,
        },
        "high_confidence": brilliant_moves[:32],
        "recent_brilliants": brilliant_moves[:24],
        "games": brilliant_games,
        "best_game": best_game,
        "progress": progress,
        "classification_status": classification_status,
        "watchlist": repertoire_watchlist.get("watchlist", [])[:24],
    }


def _build_drift_fixes(opening_drift: dict[str, Any]) -> dict[str, Any]:
    actions = []
    for alert in (opening_drift or {}).get("alerts", [])[:8]:
        move = alert.get("move", "")
        color = alert.get("color", "")
        recent_pct = float(alert.get("recent_pct", 0) or 0)
        overall_pct = float(alert.get("overall_pct", 0) or 0)
        if not move:
            continue
        actions.append(
            {
                "id": f"{color}:{move}",
                "color": color,
                "move": move,
                "recent_pct": round(recent_pct, 1),
                "overall_pct": round(overall_pct, 1),
                "drift": round(float(alert.get("drift", 0) or 0), 1),
                "adopt_text": f"Make {move} my current {color} starter",
                "repair_text": f"Train back to the older {color} starter mix",
            }
        )
    return {
        "actions": actions,
        "summary": "No first-move drift needs action." if not actions else f"{len(actions)} first-move drift action{'s' if len(actions) != 1 else ''} ready.",
    }


def _build_import_speed_report(
    games: list[ImportedGame],
    nodes: dict[str, PositionNode] | list[PositionNode],
    analyzed_nodes: list[PositionNode],
    lessons: list[dict[str, Any]],
) -> dict[str, Any]:
    node_items = list(nodes.values()) if isinstance(nodes, dict) else list(nodes)
    repeated_nodes = len([node for node in node_items if node.occurrences >= REPEATED_MISTAKE_THRESHOLD])
    skipped = max(0, len(node_items) - len(analyzed_nodes))
    return {
        "games_indexed": len(games),
        "positions_indexed": len(node_items),
        "repeated_positions": repeated_nodes,
        "positions_analyzed": len(analyzed_nodes),
        "lessons_created": len(lessons),
        "positions_skipped": skipped,
        "cache_key": f"engine-v{ENGINE_CACHE_SCHEMA_VERSION}",
        "notes": [
            "Repeated transpositions are grouped before analysis.",
            "Only the highest-signal repeated positions get engine work during import.",
            "Engine cache keys use normalized FEN, depth, MultiPV, and thinking time.",
        ],
    }


def _build_repertoire_export(lessons: list[dict[str, Any]], game_move_tree: dict[str, Any]) -> dict[str, Any]:
    lines = [
        "# Bookup repertoire export",
        "# Generated locally from imported games.",
        "",
    ]
    for index, item in enumerate(lessons[:80], start=1):
        label = item.get("line_label") or item.get("opening_name") or "Repertoire line"
        move = item.get("recommended_move", "")
        status = item.get("line_status", "")
        continuation = item.get("continuation_san") or item.get("training_line_san") or ""
        lines.append(f"{index}. {label}")
        lines.append(f"   Status: {status} | Move: {move} | Frequency: {item.get('frequency', 0)}")
        if continuation:
            lines.append(f"   Line: {continuation}")
        lines.append("")
    root_children = (((game_move_tree or {}).get("root") or {}).get("children") or [])[:12]
    if root_children:
        lines.append("# First moves from imported games")
        for child in root_children:
            lines.append(f"- {child.get('san', '')}: {child.get('count', 0)} games")
    return {
        "filename": "bookup-repertoire-export.txt",
        "line_count": min(len(lessons), 80),
        "text": "\n".join(lines).strip() + "\n",
    }


def _build_blunder_traps(
    queue_due: list[dict[str, Any]],
    queue_new: list[dict[str, Any]],
    database_training: list[dict[str, Any]],
) -> dict[str, Any]:
    traps = []
    candidates = queue_due + queue_new
    for item in candidates:
        value = int(item.get("value_lost_cp", 0) or 0)
        spread = max([abs(int(line.get("cp", 0) or 0)) for line in item.get("candidate_lines", [])[:5]] or [0])
        if value < 70 and spread < 180:
            continue
        traps.append(
            {
                "lesson_id": item.get("lesson_id", ""),
                "line_label": item.get("line_label", ""),
                "trigger": item.get("trigger_move", ""),
                "punish_with": item.get("recommended_move", ""),
                "why": item.get("coach_explanation") or item.get("explanation", ""),
                "value_lost_cp": value,
                "frequency": item.get("frequency", 0),
            }
        )
    for reply in database_training[:8]:
        top_reply = reply.get("top_database_reply") or {}
        if int(top_reply.get("popularity", 0) or 0) >= 20:
            traps.append(
                {
                    "lesson_id": reply.get("lesson_id", ""),
                    "line_label": reply.get("line_label", ""),
                    "trigger": top_reply.get("san") or top_reply.get("uci", ""),
                    "punish_with": reply.get("recommended_move", ""),
                    "why": "This reply is common in the database, so having the answer ready is practical prep.",
                    "value_lost_cp": 0,
                    "frequency": top_reply.get("popularity", 0),
                }
            )
    unique: dict[str, dict[str, Any]] = {}
    for trap in traps:
        key = f"{trap.get('lesson_id')}:{trap.get('trigger')}:{trap.get('punish_with')}"
        unique[key] = trap
    return {"items": list(unique.values())[:16]}


def _build_premove_quiz(queue_due: list[dict[str, Any]], queue_new: list[dict[str, Any]]) -> dict[str, Any]:
    source = queue_due[:8] + queue_new[:4]
    return {
        "cards": [
            {
                **_compact_training_card(item),
                "prompt": f"What would you play after {item.get('trigger_move') or item.get('line_label', 'this position')}?",
                "answer": item.get("recommended_move", ""),
                "hint": item.get("coach_explanation", ""),
            }
            for item in source
        ]
    }


def _build_smart_retry(queue_due: list[dict[str, Any]], memory_scores: dict[str, Any]) -> dict[str, Any]:
    fragile_ids = {item.get("lesson_id") for item in (memory_scores or {}).get("fragile_lines", [])}
    deck = []
    for item in queue_due:
        misses = int(item.get("repeat_mistake_count", 0) or 0)
        deck.append(
            {
                **_compact_training_card(item),
                "retry_interval": "again now" if item.get("lesson_id") in fragile_ids or misses >= 3 else "later today",
                "reason": f"{misses} repeated miss{'es' if misses != 1 else ''} in this exact position.",
            }
        )
    return {"deck": deck[:16]}


def _build_opponent_simulator(database_training: list[dict[str, Any]]) -> dict[str, Any]:
    scenarios = []
    for item in database_training[:16]:
        reply = item.get("top_database_reply") or {}
        scenarios.append(
            {
                "lesson_id": item.get("lesson_id", ""),
                "line_label": item.get("line_label", ""),
                "opponent_reply": reply.get("san") or reply.get("uci", ""),
                "response": item.get("recommended_move", ""),
                "popularity": reply.get("popularity", 0),
                "mode": "database" if reply.get("popularity", 0) else "fallback",
            }
        )
    return {"scenarios": scenarios}


def _build_theory_v2(database_training: list[dict[str, Any]], queue_due: list[dict[str, Any]]) -> dict[str, Any]:
    seeds = []
    for item in database_training[:8]:
        if item.get("recommended_move_uci"):
            reply = item.get("top_database_reply") or {}
            seeds.append(
                {
                    "label": f"Against {reply.get('san') or reply.get('uci') or 'common reply'}",
                    "move": item.get("recommended_move_uci", ""),
                    "lesson_id": item.get("lesson_id", ""),
                    "line_label": item.get("line_label", ""),
                }
            )
    for item in queue_due[:6]:
        if item.get("recommended_move_uci"):
            seeds.append(
                {
                    "label": f"Repair {item.get('line_label', 'line')}",
                    "move": item.get("recommended_move_uci", ""),
                    "lesson_id": item.get("lesson_id", ""),
                    "line_label": item.get("line_label", ""),
                }
            )
    return {"seeds": seeds[:12]}


def analyse_games(
    games: list[ImportedGame],
    engine: EngineSession,
    progress_callback: Callable[..., None] | None = None,
) -> dict[str, Any]:
    analysis_started = time.perf_counter()

    def notify(**patch: Any) -> None:
        if not progress_callback:
            return
        try:
            progress_callback(**patch)
        except Exception:
            pass

    notify(phase="indexing", progress=8, games_done=0, games_total=len(games), message="Indexing imported games...")
    nodes, _position_counts, _opening_info = _collect_position_nodes(games, progress_callback=notify)
    analyzed_nodes = _rank_nodes_for_analysis(nodes)
    notify(
        phase="position_index",
        progress=18,
        games_done=len(games),
        games_total=len(games),
        positions_indexed=len(nodes),
        positions_total=len(analyzed_nodes),
        message=f"Indexed {len(nodes)} repeated positions. Preparing Stockfish...",
    )
    quick_time_sec = max(0.35, min(PROFILE_ANALYSIS_TIME_SEC, float(engine.settings.think_time_sec or PROFILE_ANALYSIS_TIME_SEC)))
    lessons = []
    worker_count = max(1, int(getattr(engine, "worker_count", 1) or 1))
    total_positions = max(1, len(analyzed_nodes))
    positions_done = 0
    live_position_previews: deque[dict[str, Any]] = deque(
        (
            _analysis_progress_preview(
                node.position_fen,
                label=node.player_san.get(node.player_moves.most_common(1)[0][0], node.trigger_move) if node.player_moves else node.trigger_move,
                subtitle=f"{node.occurrences}x · {node.opening_name}",
                status="Queued",
                orientation=node.color,
            )
            for node in analyzed_nodes[:6]
        ),
        maxlen=6,
    )
    notify(
        phase="stockfish_positions",
        progress=20 if analyzed_nodes else 68,
        positions_done=0,
        positions_total=len(analyzed_nodes),
        live_positions=list(live_position_previews),
        message=(
            f"Stockfish is analyzing {len(analyzed_nodes)} repeated positions with "
            f"{min(worker_count, max(1, len(analyzed_nodes)))} worker(s)..."
            if analyzed_nodes
            else "No repeated positions need Stockfish analysis yet. Building queues..."
        ),
    )
    if worker_count > 1 and len(analyzed_nodes) > 1:
        with ThreadPoolExecutor(max_workers=min(worker_count, len(analyzed_nodes)), thread_name_prefix="bookup-stockfish") as executor:
            futures = {
                executor.submit(_build_lesson_from_node, node, engine, time_sec=quick_time_sec): node
                for node in analyzed_nodes
            }
            for future in as_completed(futures):
                node = futures[future]
                lesson = future.result()
                if lesson:
                    lessons.append(lesson)
                    live_position_previews.append(
                        _analysis_progress_preview(
                            lesson.get("position_fen") or lesson.get("line_start_fen") or chess.STARTING_FEN,
                            label=str(lesson.get("recommended_move") or lesson.get("best_reply") or lesson.get("line_label") or "Position"),
                            subtitle=f"{lesson.get('frequency', node.occurrences)}x · {lesson.get('opening_name', node.opening_name)}",
                            status="Analyzed",
                            orientation=str(lesson.get("side") or node.color),
                        )
                    )
                positions_done += 1
                notify(
                    phase="stockfish_positions",
                    progress=20 + int((positions_done / total_positions) * 48),
                    positions_done=positions_done,
                    positions_total=len(analyzed_nodes),
                    live_positions=list(live_position_previews),
                    message=f"Stockfish analyzed {positions_done}/{len(analyzed_nodes)} repeated positions...",
                )
    else:
        for node in analyzed_nodes:
            lesson = _build_lesson_from_node(node, engine, time_sec=quick_time_sec)
            if lesson:
                lessons.append(lesson)
                live_position_previews.append(
                    _analysis_progress_preview(
                        lesson.get("position_fen") or lesson.get("line_start_fen") or chess.STARTING_FEN,
                        label=str(lesson.get("recommended_move") or lesson.get("best_reply") or lesson.get("line_label") or "Position"),
                        subtitle=f"{lesson.get('frequency', node.occurrences)}x · {lesson.get('opening_name', node.opening_name)}",
                        status="Analyzed",
                        orientation=str(lesson.get("side") or node.color),
                    )
                )
            positions_done += 1
            notify(
                phase="stockfish_positions",
                progress=20 + int((positions_done / total_positions) * 48),
                positions_done=positions_done,
                positions_total=len(analyzed_nodes),
                live_positions=list(live_position_previews),
                message=f"Stockfish analyzed {positions_done}/{len(analyzed_nodes)} repeated positions...",
            )

    lessons.sort(key=lambda item: (-item["priority"], -item["frequency"], item["line_label"]))
    for lesson in lessons:
        lesson["memory_score"] = _memory_score_for_line(lesson)
    repertoire_map = _build_repertoire_map(lessons)
    repertoire_tree = _group_repertoire(lessons)
    top_openings_by_color = _opening_lists(repertoire_tree)
    known_lines = [item for item in lessons if item["line_status"] == "known"]
    needs_work_lines = [item for item in lessons if item["line_status"] == "needs_work"]
    new_lines = [item for item in lessons if item["line_status"] == "new"]
    repeated_work_lines = [
        item
        for item in needs_work_lines
        if item["repeat_mistake_count"] >= REPEATED_MISTAKE_THRESHOLD
    ]
    queue_due = sorted(repeated_work_lines, key=lambda item: (-item["priority"], -item["frequency"]))[:32]
    queue_new = sorted(
        [item for item in new_lines if item["repeat_count"] < KNOWN_LINE_THRESHOLD and item["frequency"] >= REPEATED_MISTAKE_THRESHOLD],
        key=lambda item: (-item["frequency"], -item["priority"]),
    )[:24]
    urgent_lines = [item for item in repeated_work_lines if item["frequency"] >= REPEATED_MISTAKE_THRESHOLD or item["value_lost_cp"] >= 60]
    urgent_lines = sorted(urgent_lines, key=lambda item: (-item["priority"], -item["frequency"]))[:16]
    sidelines = [
        item
        for item in needs_work_lines
        if item not in urgent_lines and item["repeat_mistake_count"] >= REPEATED_MISTAKE_THRESHOLD and (
            any(0 < reply.get("popularity", 0) <= 10 for reply in item.get("common_replies", []))
            or item["frequency"] == 1
        )
    ][:16]
    opening_mistakes = [
        {
            "lesson_id": item["lesson_id"],
            "line_label": item["line_label"],
            "opening_name": item["opening_name"],
            "opening_code": item["opening_code"],
            "trigger_move": item["trigger_move"],
            "played": item["your_top_move"],
            "best_move": item["best_reply"],
            "value_lost_cp": item["value_lost_cp"],
            "recommended_classification": item["recommended_classification"],
            "played_classification": item["your_move_classification"],
            "position_fen": item["position_fen"],
            "position_identifier": item["position_identifier"],
            "position_identifier_label": item["position_identifier_label"],
            "explanation": item["explanation"],
            "continuation_san": item["continuation_san"],
            "repeat_mistake_count": item["repeat_mistake_count"],
        }
        for item in sorted(repeated_work_lines, key=lambda row: (-row["value_lost_cp"], -row["frequency"]))[:20]
    ]
    repertoire_updates = _build_repertoire_updates(urgent_lines, known_lines)
    known_line_archive = sorted(known_lines, key=lambda item: (-item["repeat_count"], -item["frequency"]))[:24]

    white_first = _first_move_repertoire(games, "white")
    black_first = _first_move_repertoire(games, "black")
    game_move_tree = _build_game_move_tree(games)
    rating_progress = _build_rating_progress(games)
    total_results = Counter(_classify_result(game.result, game.player_color) for game in games)
    win_rate = round((total_results["win"] / len(games)) * 100, 1) if games else 0.0
    score_rate = round(((total_results["win"] + 0.5 * total_results["draw"]) / len(games)) * 100, 1) if games else 0.0
    health_dashboard = _build_health_dashboard(
        lessons=lessons,
        queue_due=queue_due,
        queue_new=queue_new,
        known_lines=known_lines,
        repeated_work_lines=repeated_work_lines,
        games_count=len(games),
        win_rate=win_rate,
    )
    mistake_heatmap = _build_mistake_heatmap(repeated_work_lines)
    mistake_timeline = _build_mistake_timeline(repeated_work_lines)
    transposition_groups = _build_transposition_groups(lessons)
    review_schedule = _build_review_schedule(queue_due, queue_new, known_line_archive)
    database_training = _build_database_training(queue_due, queue_new)
    memory_scores = _build_memory_scores(lessons)
    opening_drift = _build_opening_drift(games)
    prep_pack = _build_prep_pack(queue_due, queue_new, database_training, known_line_archive)
    study_plan = _build_study_plan(queue_due, queue_new, known_line_archive, memory_scores, database_training)
    confidence_graph = _build_confidence_graph(lessons)
    notify(phase="brilliant_scan", progress=78, message="Classifying Brilliant moves from imported games...")
    brilliant_tracker = _build_game_brilliant_tracker(games, lessons, engine, progress_callback=notify)
    drift_fixes = _build_drift_fixes(opening_drift)
    import_speed_report = _build_import_speed_report(games, nodes, analyzed_nodes, lessons)
    elapsed_sec = max(0.001, time.perf_counter() - analysis_started)
    brilliant_summary = brilliant_tracker.get("summary", {}) if isinstance(brilliant_tracker, dict) else {}
    stockfish_stats = {
        "positions_analyzed": len(analyzed_nodes),
        "positions_total": len(analyzed_nodes),
        "positions_per_second": round(len(analyzed_nodes) / elapsed_sec, 2),
        "elapsed_sec": round(elapsed_sec, 2),
        "eta_sec": 0,
        "workers": worker_count,
        "threads": int(engine.settings.threads),
        "worker_threads": max(1, int(engine.settings.threads) // max(1, worker_count)),
        "hash_mb": int(engine.settings.hash_mb),
        "worker_hash_mb": max(128, int(engine.settings.hash_mb) // max(1, worker_count)),
        "multipv": int(engine.settings.multipv),
        "depth": int(engine.settings.depth),
        "think_time_sec": float(engine.settings.think_time_sec),
        "brilliant_moves_scanned": int(brilliant_summary.get("moves_scanned", 0) or 0),
        "brilliant_moves_classified": int(brilliant_summary.get("classified_moves", 0) or 0),
        "engine_cache_hits": int(brilliant_summary.get("cached_hits", 0) or 0),
        "engine_live_hits": int(brilliant_summary.get("live_hits", 0) or 0),
    }
    notify(
        phase="complete",
        progress=100,
        positions_done=len(analyzed_nodes),
        positions_total=len(analyzed_nodes),
        positions_per_second=stockfish_stats["positions_per_second"],
        elapsed_sec=stockfish_stats["elapsed_sec"],
        eta_sec=0,
        message="Analysis complete.",
    )
    repertoire_export = _build_repertoire_export(lessons, game_move_tree)
    blunder_traps = _build_blunder_traps(queue_due, queue_new, database_training)
    premove_quiz = _build_premove_quiz(queue_due, queue_new)
    smart_retry = _build_smart_retry(queue_due, memory_scores)
    opponent_simulator = _build_opponent_simulator(database_training)
    theory_v2 = _build_theory_v2(database_training, queue_due)
    prep_summary = (
        f"Bookup found {len(lessons)} repeated repertoire positions, {len(queue_due)} due lines that need work, and {len(known_lines)} known lines already under control. "
        "Import your games, train the branches you actually reach, and let the database plus Stockfish guide the replies."
    )

    return {
        "games_analyzed": len(games),
        "summary": {
            "win_rate": win_rate,
            "score_rate": score_rate,
            "record": _result_record_text(total_results["win"], total_results["draw"], total_results["loss"]),
            "positions": len(lessons),
            "positions_indexed": len(nodes),
            "positions_analyzed": len(analyzed_nodes),
            "trainable_positions": len(queue_due) + len(queue_new),
            "known_lines": len(known_lines),
            "urgent_lines": len(urgent_lines),
            "prep_summary": prep_summary,
        },
        "first_move_repertoire": {
            "white": white_first,
            "black": black_first,
        },
        "top_openings_by_color": top_openings_by_color,
        "repertoire_map": repertoire_map,
        "repertoire_tree": repertoire_tree,
        "game_move_tree": game_move_tree,
        "move_tree": game_move_tree,
        "rating_progress": rating_progress,
        "health_dashboard": health_dashboard,
        "mistake_heatmap": mistake_heatmap,
        "mistake_timeline": mistake_timeline,
        "transposition_groups": transposition_groups,
        "review_schedule": review_schedule,
        "database_training": database_training,
        "memory_scores": memory_scores,
        "opening_drift": opening_drift,
        "prep_pack": prep_pack,
        "study_plan": study_plan,
        "confidence_graph": confidence_graph,
        "brilliant_tracker": brilliant_tracker,
        "drift_fixes": drift_fixes,
        "import_speed_report": import_speed_report,
        "stockfish_stats": stockfish_stats,
        "repertoire_export": repertoire_export,
        "blunder_traps": blunder_traps,
        "premove_quiz": premove_quiz,
        "smart_retry": smart_retry,
        "opponent_simulator": opponent_simulator,
        "theory_v2": theory_v2,
        "known_lines": known_lines,
        "urgent_lines": urgent_lines,
        "needs_work": queue_due,
        "sidelines": sidelines,
        "repertoire_updates": repertoire_updates,
        "opening_mistakes": opening_mistakes,
        "trainer_queue_due": queue_due,
        "trainer_queue_new": queue_new,
        "trainer_queue": queue_due,
        "known_line_archive": known_line_archive,
        "known_archive": known_line_archive,
        "previewable_lines": lessons[:200],
    }
