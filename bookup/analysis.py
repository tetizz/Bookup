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

try:
    from Openix import ChessOpeningsLibrary
except Exception:  # pragma: no cover - optional dependency fallback
    ChessOpeningsLibrary = None

from .chesscom import ImportedGame
from .classifications import (
    PIECE_VALUES,
    annotate_candidate_classifications,
    book_classification_payload,
    classify_move_record,
    classification_payload,
    expected_points_from_evaluation,
)
from .engine import EngineSession
from .opening_names import lookup_by_board, lookup_by_eco, matches_opening_prefix, opening_prefix_count


OPENING_LIBRARY: ChessOpeningsLibrary | None = None
ONLINE_OPENING_CACHE: dict[str, dict[str, str]] = {}
EXPLORER_CACHE: dict[str, dict[str, Any]] = {}
POSITION_INSIGHT_CACHE: dict[str, dict[str, Any]] = {}
PERSISTENT_ENGINE_CACHE_LOAD: Callable[[str], dict[str, Any]] | None = None
PERSISTENT_ENGINE_CACHE_SAVE: Callable[[str, dict[str, Any]], None] | None = None
EXPLORER_AVAILABLE = False
EXPLORER_LAST_ERROR = "Online opening explorer is disabled; Bookup uses imported-game positions and Stockfish."
KNOWN_LINE_THRESHOLD = 100
OPENING_PLIES = 16
EARLY_BOOK_FREE_PLIES = 5
PV_LENGTH = 12
REPERTOIRE_LOCK_PLIES = 8
REPEATED_MISTAKE_THRESHOLD = 2
MAX_EXPLANATION_CP = 600
MAX_ANALYZED_REPERTOIRE_NODES = 72
PROFILE_ANALYSIS_TIME_SEC = 0.9
ENGINE_CACHE_SCHEMA_VERSION = 12
SMART_THEORY_SCHEMA_VERSION = 2
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
    del token
    EXPLORER_AVAILABLE = False
    EXPLORER_LAST_ERROR = "Online opening explorer is disabled; Bookup uses imported-game positions and Stockfish."
    EXPLORER_CACHE.clear()
    ONLINE_OPENING_CACHE.clear()


def configure_engine_cache(
    loader: Callable[[str], dict[str, Any]] | None = None,
    saver: Callable[[str, dict[str, Any]], None] | None = None,
) -> None:
    global PERSISTENT_ENGINE_CACHE_LOAD, PERSISTENT_ENGINE_CACHE_SAVE
    PERSISTENT_ENGINE_CACHE_LOAD = loader
    PERSISTENT_ENGINE_CACHE_SAVE = saver


def clear_runtime_caches(*, include_explorer: bool = True, include_engine_cache: bool = True) -> None:
    if include_explorer:
        EXPLORER_CACHE.clear()
        ONLINE_OPENING_CACHE.clear()
    if include_engine_cache:
        POSITION_INSIGHT_CACHE.clear()


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
        "depth": int(getattr(engine.settings, "depth", 16) or 16),
        "multipv": int(getattr(engine.settings, "multipv", limit) or limit),
        "limit": int(limit),
        "time_sec": time_key,
        "position_context": "local-import-and-engine-v1",
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
    del board, play_key
    EXPLORER_LAST_ERROR = "Online opening explorer is disabled; Bookup uses imported-game positions and Stockfish."
    return {}


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

    # Retain the flag for stored-call compatibility, but do not make an opening
    # explorer request. PGN headers and the bundled opening dataset are local.
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
    # A game's first move is always White's. When the user played Black this
    # is the opponent's opening choice, which is the useful repertoire split.
    target_color = chess.WHITE
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
        "perspective": "player" if color_name == "white" else "opponent",
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
    del board, play_uci, limit
    return []


def database_context_for_board(board: chess.Board, play_uci: list[str] | None = None, limit: int = 8) -> dict[str, Any]:
    moves = _database_moves(board, play_uci or [], limit=limit)
    return {
        "fen": board.fen(),
        "database_moves": moves,
        "database_error": EXPLORER_LAST_ERROR,
        "database_source": "local-import",
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
    san_tokens: list[str] = []
    last_prefix_count = 0
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
        san_tokens.append(probe.san(move))
        probe.push(move)
        prefix_count = opening_prefix_count(san_tokens)
        if ply_index <= EARLY_BOOK_FREE_PLIES or prefix_count > 0 or _position_has_book_name(probe):
            last_book_ply = ply_index
            last_prefix_count = prefix_count
            continue
        return {
            "active": False,
            "reason": f"left named opening book after ply {ply_index}",
            "ply": ply_index,
            "last_book_ply": last_book_ply,
            "position_matches_prefix": board.epd() == probe.epd() if board is not None else True,
            "san_tokens": san_tokens,
            "prefix_count": last_prefix_count,
        }

    return {
        "active": True,
        "reason": "still inside opening-book context",
        "ply": len(play_uci),
        "last_book_ply": last_book_ply,
        "position_matches_prefix": board.epd() == probe.epd() if board is not None else True,
        "san_tokens": san_tokens,
        "prefix_count": last_prefix_count,
    }


def _move_is_book_candidate(
    board: chess.Board,
    move_uci: str,
    *,
    book_state: dict[str, Any] | None = None,
    popularity_by_uci: dict[str, float] | None = None,
    repeated_count: int = 0,
    move_rank: int | None = None,
) -> bool:
    if not (book_state or {}).get("active", False):
        return False
    if repeated_count >= REPEATED_MISTAKE_THRESHOLD:
        return True
    if float((popularity_by_uci or {}).get(move_uci, 0.0) or 0.0) >= 3.0:
        return True
    try:
        move = chess.Move.from_uci(move_uci)
    except ValueError:
        return False
    if move not in board.legal_moves:
        return False
    next_tokens = [*list((book_state or {}).get("san_tokens") or []), board.san(move)]
    if matches_opening_prefix(next_tokens):
        return True
    moving_piece = board.piece_at(move.from_square)
    if (
        (book_state or {}).get("ply", 0) <= 4
        and moving_piece is not None
        and moving_piece.piece_type != chess.QUEEN
    ):
        return True
    return False


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


def _append_unique(items: list[str], value: str) -> None:
    normalized = value.strip()
    if normalized and normalized not in items:
        items.append(normalized)


def _captured_piece_for_reaction(board: chess.Board, move: chess.Move) -> chess.Piece | None:
    captured = board.piece_at(move.to_square)
    if captured is not None:
        return captured
    if board.is_en_passant(move):
        offset = -8 if board.turn == chess.WHITE else 8
        return board.piece_at(move.to_square + offset)
    return None


def _reaction_tone_for_key(key: str, *, database_hit: bool, book_active: bool) -> str:
    if key == "book" and book_active:
        return "book"
    if key == "brilliant":
        return "brilliant"
    if key == "great":
        return "great"
    if key in {"best", "excellent"}:
        return "positive"
    if key == "good" or database_hit:
        return "steady"
    if key in {"inaccuracy", "miss"}:
        return "warning"
    if key in {"mistake", "blunder"}:
        return "danger"
    return "neutral"


def _reaction_tone_label(tone: str) -> str:
    return {
        "book": "Book memory",
        "brilliant": "Tactical spark",
        "great": "Only-move find",
        "positive": "Clean choice",
        "steady": "Practical choice",
        "warning": "Needs a look",
        "danger": "Repair point",
        "neutral": "Move note",
    }.get(tone, "Move note")


def _move_motif_tags(
    board: chess.Board,
    move: chess.Move,
    *,
    after: chess.Board | None,
    classification_key: str,
    database_hit: dict[str, Any] | None,
    book_active: bool,
    best_line: dict[str, Any] | None,
) -> list[str]:
    motifs: list[str] = []
    moving_piece = board.piece_at(move.from_square)
    captured_piece = _captured_piece_for_reaction(board, move)
    mover = board.turn
    enemy = not mover

    if book_active and (classification_key == "book" or database_hit):
        _append_unique(motifs, "book")
    if database_hit:
        _append_unique(motifs, "database")
    if best_line and best_line.get("uci") == move.uci():
        _append_unique(motifs, "engine top")
    if classification_key == "great":
        _append_unique(motifs, "only move")
    if classification_key == "brilliant":
        _append_unique(motifs, "sacrifice")

    if after is not None and after.is_checkmate():
        _append_unique(motifs, "mate")
    elif after is not None and after.is_check():
        _append_unique(motifs, "check")
    if board.is_capture(move):
        _append_unique(motifs, "capture")
    if board.is_castling(move):
        _append_unique(motifs, "king safety")

    if moving_piece:
        destination = chess.square_name(move.to_square)
        if moving_piece.piece_type in (chess.KNIGHT, chess.BISHOP) and chess.square_rank(move.from_square) in (0, 7):
            _append_unique(motifs, "development")
        if moving_piece.piece_type == chess.PAWN and destination in {"c4", "d4", "e4", "c5", "d5", "e5"}:
            _append_unique(motifs, "center")
        if moving_piece.piece_type in (chess.ROOK, chess.QUEEN):
            _append_unique(motifs, "heavy piece")

    if moving_piece and after is not None:
        moved_value = PIECE_VALUES.get(moving_piece.piece_type, 0)
        captured_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0
        destination_attacked = after.is_attacked_by(enemy, move.to_square)
        destination_defended = after.is_attacked_by(mover, move.to_square)
        if destination_attacked and moved_value >= PIECE_VALUES[chess.KNIGHT]:
            if board.is_capture(move) and moved_value > captured_value + 100:
                _append_unique(motifs, "material investment")
            elif not board.is_capture(move):
                _append_unique(motifs, "piece offered")
        if destination_attacked and destination_defended:
            _append_unique(motifs, "contested square")

    if after is not None and after.is_check() and (board.is_capture(move) or classification_key in {"brilliant", "great"}):
        _append_unique(motifs, "zwischenzug")

    return motifs[:7]


def _piece_target_label(piece: chess.Piece | None, square: int) -> str:
    name = chess.piece_name(piece.piece_type) if piece else "piece"
    return f"{name} on {chess.square_name(square)}"


def _attacked_enemy_piece_targets(board: chess.Board, attacker_color: bool, attacker_square: int) -> list[tuple[int, chess.Piece]]:
    targets: list[tuple[int, chess.Piece]] = []
    attacks = board.attacks(attacker_square)
    for square in attacks:
        piece = board.piece_at(square)
        if piece is not None and piece.color != attacker_color:
            targets.append((square, piece))
    return targets


def _fork_targets_after_move(after: chess.Board, move: chess.Move, mover: bool) -> list[tuple[int, chess.Piece]]:
    targets = _attacked_enemy_piece_targets(after, mover, move.to_square)
    king_square = after.king(not mover)
    moved_piece = after.piece_at(move.to_square)
    if king_square is not None and moved_piece is not None and king_square in after.attacks(move.to_square):
        king_piece = after.piece_at(king_square)
        if king_piece is not None and all(square != king_square for square, _piece in targets):
            targets.append((king_square, king_piece))
    return targets


def _new_absolute_pins(before: chess.Board, after: chess.Board, pinned_color: bool) -> list[tuple[int, chess.Piece]]:
    pins: list[tuple[int, chess.Piece]] = []
    for square, piece in after.piece_map().items():
        if piece.color != pinned_color or piece.piece_type == chess.KING:
            continue
        if after.is_pinned(pinned_color, square) and not before.is_pinned(pinned_color, square):
            pins.append((square, piece))
    return pins


def _castling_rights_removed(before: chess.Board, after: chess.Board, color: bool) -> bool:
    before_kingside = before.has_kingside_castling_rights(color)
    before_queenside = before.has_queenside_castling_rights(color)
    after_kingside = after.has_kingside_castling_rights(color)
    after_queenside = after.has_queenside_castling_rights(color)
    return (before_kingside and not after_kingside) or (before_queenside and not after_queenside)


def _material_threats_from_square(board: chess.Board, attacker_color: bool, attacker_square: int, moving_piece: chess.Piece | None) -> list[tuple[int, chess.Piece]]:
    if moving_piece is None:
        return []
    moved_value = PIECE_VALUES.get(moving_piece.piece_type, 0)
    targets = []
    for square, piece in _attacked_enemy_piece_targets(board, attacker_color, attacker_square):
        target_value = PIECE_VALUES.get(piece.piece_type, 0)
        defended = board.is_attacked_by(not attacker_color, square)
        if target_value > moved_value or (target_value >= PIECE_VALUES[chess.ROOK] and not defended):
            targets.append((square, piece))
    return targets


def _recapture_context(board: chess.Board, move: chess.Move, captured_piece: chess.Piece | None) -> str:
    if captured_piece is None or not board.move_stack:
        return ""
    last_move = board.peek()
    if last_move.to_square != move.to_square:
        return ""
    try:
        return board.san(move)
    except Exception:
        return move.uci()


def _moved_piece_escape_reason(board: chess.Board, move: chess.Move, after: chess.Board, moving_piece: chess.Piece | None, mover: bool) -> str:
    if moving_piece is None or moving_piece.piece_type == chess.KING:
        return ""
    enemy = not mover
    piece_value = PIECE_VALUES.get(moving_piece.piece_type, 0)
    if piece_value < PIECE_VALUES[chess.KNIGHT]:
        return ""
    if not board.is_attacked_by(enemy, move.from_square):
        return ""
    if after.is_attacked_by(enemy, move.to_square):
        return ""
    return f"Moves the {chess.piece_name(moving_piece.piece_type)} out of danger."


def _candidate_tactical_threat(board: chess.Board, candidate: chess.Move, attacker_color: bool) -> dict[str, Any] | None:
    piece = board.piece_at(candidate.from_square)
    if piece is None:
        return None
    try:
        candidate_san = board.san(candidate)
    except Exception:
        candidate_san = candidate.uci()
    candidate_after = board.copy(stack=False)
    try:
        candidate_after.push(candidate)
    except Exception:
        return None

    if candidate_after.is_checkmate():
        return {
            "key": f"mate:{candidate.uci()}",
            "motif": "mate threat",
            "priority": 100,
            "description": f"{candidate_san} checkmate",
            "prevented": f"Prevents {candidate_san} checkmate.",
        }

    fork_targets = _fork_targets_after_move(candidate_after, candidate, attacker_color)
    high_value_fork_targets = [
        (square, target)
        for square, target in fork_targets
        if target.piece_type == chess.KING or PIECE_VALUES.get(target.piece_type, 0) >= PIECE_VALUES[chess.ROOK]
    ]
    if len(high_value_fork_targets) >= 2:
        labels = ", ".join(_piece_target_label(target, square) for square, target in high_value_fork_targets[:2])
        return {
            "key": "fork:" + ",".join(f"{piece.piece_type}@{square}" for square, piece in high_value_fork_targets[:3]),
            "motif": "fork threat",
            "priority": 90,
            "description": f"{candidate_san}, forking {labels}",
            "prevented": f"Prevents the fork {candidate_san} on {labels}.",
        }

    captured_piece = _captured_piece_for_reaction(board, candidate)
    if captured_piece and PIECE_VALUES.get(captured_piece.piece_type, 0) >= PIECE_VALUES[chess.ROOK]:
        target_label = _piece_target_label(captured_piece, candidate.to_square)
        return {
            "key": f"material:{captured_piece.piece_type}@{candidate.to_square}",
            "motif": "material threat",
            "priority": 80,
            "description": f"winning the {target_label} with {candidate_san}",
            "prevented": f"Prevents {candidate_san}, which would win the {target_label}.",
        }

    new_pins = _new_absolute_pins(board, candidate_after, not attacker_color)
    if new_pins:
        square, pinned_piece = new_pins[0]
        target_label = _piece_target_label(pinned_piece, square)
        return {
            "key": f"pin:{pinned_piece.piece_type}@{square}",
            "motif": "pin threat",
            "priority": 70,
            "description": f"{candidate_san}, pinning the {target_label}",
            "prevented": f"Prevents {candidate_san}, which would pin the {target_label}.",
        }

    if _castling_rights_removed(board, candidate_after, not attacker_color):
        return {
            "key": f"castle:{not attacker_color}",
            "motif": "castling-rights threat",
            "priority": 60,
            "description": f"{candidate_san}, taking away castling rights",
            "prevented": f"Prevents {candidate_san} from taking away castling rights.",
        }

    if candidate.promotion:
        promoted_name = chess.piece_name(candidate.promotion)
        return {
            "key": f"promotion:{candidate.to_square}:{candidate.promotion}",
            "motif": "promotion threat",
            "priority": 55,
            "description": f"{candidate_san}, promoting to a {promoted_name}",
            "prevented": f"Prevents the promotion idea {candidate_san}.",
        }

    return None


def _candidate_tactical_threats(board: chess.Board, attacker_color: bool, *, limit: int = 80) -> list[dict[str, Any]]:
    probe = board.copy(stack=False)
    probe.turn = attacker_color
    threats: list[dict[str, Any]] = []
    for candidate in list(probe.legal_moves)[:limit]:
        threat = _candidate_tactical_threat(probe, candidate, attacker_color)
        if threat is not None:
            threats.append(threat)
    threats.sort(key=lambda item: int(item.get("priority", 0)), reverse=True)
    return threats


def _prevented_enemy_tactical_threats(before: chess.Board, after: chess.Board, mover: bool) -> list[dict[str, Any]]:
    if before.is_check():
        return []
    enemy = not mover
    before_threats = _candidate_tactical_threats(before, enemy)
    if not before_threats:
        return []
    after_threat_keys = {str(item.get("key", "")) for item in _candidate_tactical_threats(after, enemy)}
    prevented: list[dict[str, Any]] = []
    for threat in before_threats:
        if str(threat.get("key", "")) not in after_threat_keys:
            prevented.append(threat)
        if len(prevented) >= 3:
            break
    return prevented


def _ignored_reply_tactical_threats(after: chess.Board, mover: bool) -> list[str]:
    if after.is_check():
        return []
    future = after.copy(stack=False)
    future.turn = mover
    threats: list[str] = []
    for candidate in list(future.legal_moves)[:80]:
        threat = _candidate_tactical_threat(future, candidate, mover)
        if threat is not None:
            _append_unique(threats, f"threatens {threat.get('description', candidate.uci())}")
        if len(threats) >= 3:
            break
    return threats[:3]


def _move_tactical_annotations(board: chess.Board, move: chess.Move, after: chess.Board | None) -> tuple[list[str], list[str]]:
    if after is None:
        return [], []
    mover = not after.turn
    enemy = after.turn
    moving_piece = after.piece_at(move.to_square)
    captured_piece = _captured_piece_for_reaction(board, move)
    reasons: list[str] = []
    motifs: list[str] = []

    if board.is_check() and not after.is_check():
        _append_unique(motifs, "check defense")
        reasons.append("Answers the check safely.")

    recapture_san = _recapture_context(board, move, captured_piece)
    if recapture_san:
        _append_unique(motifs, "recapture")
        reasons.append(f"Recaptures on {chess.square_name(move.to_square)}, restoring material balance.")

    escape_reason = _moved_piece_escape_reason(board, move, after, moving_piece, mover)
    if escape_reason:
        _append_unique(motifs, "escape")
        reasons.append(escape_reason)

    checkers = list(after.checkers()) if after.is_check() else []
    if after.is_checkmate():
        _append_unique(motifs, "checkmate")
        reasons.append("Ends the line with checkmate.")
    elif len(checkers) >= 2:
        _append_unique(motifs, "double check")
        reasons.append("Creates a double check, so the king has to move.")
    elif checkers and move.to_square not in checkers:
        _append_unique(motifs, "discovered check")
        reasons.append("Moves out of the way to reveal a discovered check.")
    elif after.is_check():
        _append_unique(motifs, "check")

    fork_targets = _fork_targets_after_move(after, move, mover)
    valuable_fork_targets = [
        (square, piece)
        for square, piece in fork_targets
        if piece.piece_type == chess.KING or PIECE_VALUES.get(piece.piece_type, 0) >= PIECE_VALUES[chess.ROOK]
    ]
    if len(valuable_fork_targets) >= 2:
        fork_label = "royal fork" if any(piece.piece_type == chess.KING for _square, piece in valuable_fork_targets) else "fork"
        labels = ", ".join(_piece_target_label(piece, square) for square, piece in valuable_fork_targets[:3])
        _append_unique(motifs, fork_label)
        reasons.append(f"Forks {labels}, so one of them is hard to save.")

    new_pins = _new_absolute_pins(board, after, enemy)
    if new_pins:
        square, pinned_piece = new_pins[0]
        _append_unique(motifs, "pin")
        reasons.append(f"Pins the {_piece_target_label(pinned_piece, square)} to the king.")

    if moving_piece and moving_piece.piece_type in {chess.BISHOP, chess.ROOK, chess.QUEEN} and after.is_check():
        enemy_king = after.king(enemy)
        if enemy_king is not None:
            direction = chess.square_file(enemy_king) - chess.square_file(move.to_square), chess.square_rank(enemy_king) - chess.square_rank(move.to_square)
            if direction != (0, 0):
                _append_unique(motifs, "skewer pressure")

    if captured_piece:
        captured_value = PIECE_VALUES.get(captured_piece.piece_type, 0)
        if captured_value >= PIECE_VALUES[chess.ROOK]:
            _append_unique(motifs, "wins material")
            reasons.append(f"Wins material by taking the {_piece_target_label(captured_piece, move.to_square)}.")
        defended_by_capture = [
            square
            for square in board.attacks(move.to_square)
            if (piece := board.piece_at(square)) is not None and piece.color == enemy and PIECE_VALUES.get(piece.piece_type, 0) >= PIECE_VALUES[chess.KNIGHT]
        ]
        if defended_by_capture:
            _append_unique(motifs, "removes defender")
            reasons.append("Removes a defender, so nearby pieces and squares become weaker.")
        if after.is_check() and captured_value >= PIECE_VALUES[chess.KNIGHT]:
            _append_unique(motifs, "zwischenzug")
            reasons.append("Captures with check, which works like a forcing in-between move.")

    material_threats = _material_threats_from_square(after, mover, move.to_square, moving_piece)
    if material_threats:
        square, target = material_threats[0]
        _append_unique(motifs, "material threat")
        reasons.append(f"Attacks the {_piece_target_label(target, square)}, creating a material threat.")

    if _castling_rights_removed(board, after, enemy):
        _append_unique(motifs, "castling rights")
        reasons.append("Removes the opponent's castling rights.")
    if _castling_rights_removed(board, after, mover) and not board.is_castling(move):
        _append_unique(motifs, "king commitment")
        reasons.append("Commits your king or rook, so your own castling rights are gone.")

    if move.promotion:
        promoted_name = chess.piece_name(move.promotion)
        _append_unique(motifs, "promotion")
        reasons.append(f"Promotes the pawn into a {promoted_name}.")
    if board.is_en_passant(move):
        _append_unique(motifs, "en passant")
        reasons.append("Uses en passant to remove the advanced pawn.")

    for threat in _prevented_enemy_tactical_threats(board, after, mover):
        prevented = str(threat.get("prevented", "") or "").strip()
        motif = str(threat.get("motif", "") or "").strip()
        if motif:
            _append_unique(motifs, motif.replace(" threat", " prevention"))
        if prevented:
            reasons.append(prevented)

    for threat in _ignored_reply_tactical_threats(after, mover):
        _append_unique(motifs, "threat")
        reasons.append(threat.capitalize() + ".")

    return reasons[:6], motifs[:8]


def _move_momentum_summary(
    board: chess.Board,
    move: chess.Move,
    *,
    classification_key: str,
    label: str,
    best_line: dict[str, Any] | None,
    database_hit: dict[str, Any] | None,
    book_active: bool,
) -> str:
    san = board.san(move) if move in board.legal_moves else move.uci()
    if classification_key == "book" and book_active:
        return f"{san} stays in the prepared opening path, so Bookup keeps engine coaching light here."
    if classification_key == "brilliant":
        return f"{san} is treated as a strong sacrifice idea because the move stays sound while creating a tactical resource."
    if classification_key == "great":
        return f"{san} is the critical practical move: alternatives lose the advantage or let the position slip."
    if best_line and best_line.get("uci") == move.uci():
        return f"{san} matches the current top engine continuation from this exact board."
    if classification_key in {"inaccuracy", "mistake", "blunder", "miss"}:
        best_san = best_line.get("move") if best_line else ""
        if best_san and best_line.get("uci") != move.uci():
            return f"{san} gives up momentum; {best_san} is the cleaner way to handle this position."
        return f"{san} gives up momentum compared with the engine's preferred plan."
    if database_hit:
        return f"{san} is a practical database move, even if it is not the very top engine choice."
    return f"{san} is {label.lower()} and keeps the position understandable."


def _move_next_step(
    move: chess.Move,
    *,
    classification_key: str,
    best_line: dict[str, Any] | None,
) -> str:
    if classification_key in {"book", "best", "excellent", "good", "great", "brilliant"}:
        return "Keep following the continuation and watch the opponent's most common reply."
    best_san = best_line.get("move") if best_line else ""
    if best_san and best_line.get("uci") != move.uci():
        return f"Compare this with {best_san}, then replay the branch once from the live board."
    return "Replay the position once and look for the forcing move before choosing."


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
    tone = _reaction_tone_for_key(key, database_hit=bool(database_hit), book_active=book_active)
    motifs = _move_motif_tags(
        board,
        move,
        after=after,
        classification_key=key,
        database_hit=database_hit,
        book_active=book_active,
        best_line=best_line,
    )
    tactical_reasons, tactical_motifs = _move_tactical_annotations(board, move, after)
    for motif in tactical_motifs:
        _append_unique(motifs, motif)

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
        reasons.insert(0, "Still follows your repertoire or imported-game history." if book_active else "This branch has left the known book position.")
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

    for reason in tactical_reasons:
        _append_unique(reasons, reason)

    while len(reasons) < 2:
        reasons.append(_move_purpose(board, move).capitalize() + ".")

    return {
        "move": san,
        "uci": move.uci(),
        "label": label,
        "classification_key": key,
        "tone": tone,
        "tone_label": _reaction_tone_label(tone),
        "headline": headline,
        "summary": _move_momentum_summary(
            board,
            move,
            classification_key=key,
            label=label,
            best_line=best_line,
            database_hit=database_hit,
            book_active=book_active,
        ),
        "next_step": _move_next_step(move, classification_key=key, best_line=best_line),
        "reasons": reasons[:6],
        "features": features[:6],
        "motifs": motifs[:10],
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
    tactic_note = ""
    try:
        best_move = chess.Move.from_uci(best_move_uci)
    except ValueError:
        best_move = None
    if best_move is not None and best_move in board.legal_moves:
        after = board.copy(stack=False)
        after.push(best_move)
        tactical_reasons, tactical_motifs = _move_tactical_annotations(board, best_move, after)
        if tactical_reasons:
            tactic_note = f" Tactically, {tactical_reasons[0][0].lower()}{tactical_reasons[0][1:]}"
        elif tactical_motifs:
            tactic_note = f" It also carries the motif: {', '.join(tactical_motifs[:3])}."
    database_note = ""
    if database_moves:
        top_reply = database_moves[0]
        popularity = top_reply.get("popularity", 0)
        if popularity:
            database_note = f" You played that reply in about {popularity}% of your imported games from this position."
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
            f"{tactic_note} The main continuation is {best_line.get('line_san', best_move_san)}.{database_note}"
        )
    return (
        f"{best_move_san} is best because it {purpose}."
        f"{tactic_note} The main continuation is {best_line.get('line_san', best_move_san)}.{database_note}"
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
            "database_source": "local-import",
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
                move_rank=int(your_line.get("rank", 0) or 0) or None,
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
        "database_source": "local-import",
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


def _smart_eval_classification(delta_cp: int) -> str:
    loss = abs(int(delta_cp))
    if loss <= 25:
        return "Best"
    if loss <= 75:
        return "Inaccuracy"
    if loss <= 150:
        return "Mistake"
    return "Blunder"


def _smart_eval_label_for_user(delta_cp: int) -> str:
    loss = abs(int(delta_cp))
    if loss <= 10:
        return "Best"
    if loss <= 25:
        return "Excellent"
    if loss <= 75:
        return "Good"
    if loss <= 150:
        return "Mistake"
    return "Blunder"


def _smart_rule_explanation(
    board: chess.Board,
    move: chess.Move,
    san: str,
    *,
    opening_name: str,
    is_user_side: bool,
    classification: str,
    eval_swing: int,
    is_engine_best_reply: bool = False,
    recommended_user_reply_san: str = "",
    recommended_user_reply_uci: str = "",
    pv_preview: list[str] | None = None,
) -> tuple[str, str, str]:
    piece_name = {
        chess.PAWN: "pawn",
        chess.KNIGHT: "knight",
        chess.BISHOP: "bishop",
        chess.ROOK: "rook",
        chess.QUEEN: "queen",
        chess.KING: "king",
    }.get(board.piece_type_at(move.from_square), "piece")
    center_targets = {"d4", "d5", "e4", "e5", "c4", "c5", "f4", "f5"}
    to_sq = chess.square_name(move.to_square)
    controls_center = to_sq in center_targets
    check_note = " It gives check." if board.gives_check(move) else ""
    capture_note = " It captures material." if board.is_capture(move) else ""
    opening_part = f"In {opening_name}, " if opening_name else ""
    if is_user_side:
        theory = (
            f"{opening_part}{san} is recommended because it improves {piece_name} activity and keeps your position practical."
            f"{check_note}{capture_note}"
        )
        if controls_center:
            theory += " It also fights for central control."
        plan = "Develop smoothly, protect king safety, and prepare the next central break."
        idea = "Punish loose development and keep pressure on key central squares."
        return theory, plan, idea
    quality = classification.lower()
    reply_label = str(recommended_user_reply_san or recommended_user_reply_uci or "").strip()
    pv = [str(item or "").strip() for item in (pv_preview or []) if str(item or "").strip()]
    continuation = " ".join(pv[:6]) if pv else ""
    theory = (
        f"Opponent plays {san}. Classification: {classification}. "
        f"Eval swing is {eval_swing / 100:.2f} pawns from White's perspective."
    )
    if is_engine_best_reply:
        theory += " This is the strongest engine-backed defensive try in this position and it asks you a concrete question right away."
    elif quality in {"mistake", "blunder", "inaccuracy"}:
        theory += " This creates targets you can challenge immediately."
    else:
        theory += " This is a practical reply that keeps the position sound."
    if reply_label:
        theory += f" Best response for your side: {reply_label}."
    if continuation:
        theory += f" Critical continuation: {continuation}."
    if is_engine_best_reply:
        plan = (
            f"Meet this move with {reply_label if reply_label else 'the engine-recommended reply'}, "
            "finish development quickly, and avoid drifting into passive setups."
        )
        idea = "Opponent is trying to equalize with precise activity and force you to solve immediate coordination problems."
    elif quality in {"mistake", "blunder", "inaccuracy"}:
        plan = (
            f"Use {reply_label if reply_label else 'the strongest practical reply'} to seize space or initiative, "
            "then convert by improving piece activity before grabbing material."
        )
        idea = "Opponent's move loosens key squares and creates tactical or strategic targets."
    else:
        plan = (
            f"Answer with {reply_label if reply_label else 'a principled engine-approved move'}, "
            "then continue with healthy development and king safety."
        )
        idea = "Opponent is aiming for active piece play and central influence."
    return theory, plan, idea


def _smart_explanation_blocks(
    *,
    san: str,
    is_user_side: bool,
    classification: str,
    eval_swing: int,
    is_engine_best_reply: bool,
    recommended_user_reply_san: str,
    recommended_user_reply_uci: str,
    theory: str,
    plan: str,
    opponent_idea: str,
) -> dict[str, str]:
    response = str(recommended_user_reply_san or recommended_user_reply_uci or "").strip()
    swing = f"{eval_swing / 100:.2f}"
    if is_user_side:
        return {
            "threat": f"{san} strengthens your position and asks practical questions immediately.",
            "why": f"Classification: {classification}. Eval swing from White perspective: {swing} pawns.",
            "best_response": "Expect principled resistance; be ready to switch to the top engine continuation if the position sharpens.",
            "follow_up": str(plan or "Continue development, king safety, and central control.").strip(),
        }
    if is_engine_best_reply:
        threat = (
            f"{san} is the strongest defensive resource here and can neutralize your initiative if answered inaccurately."
        )
    else:
        threat = f"{san} creates a practical challenge you need to solve accurately."
    return {
        "threat": threat,
        "why": f"Classification: {classification}. Eval swing from White perspective: {swing} pawns. {str(opponent_idea or '').strip()}".strip(),
        "best_response": response or "Use the engine's top continuation from this node.",
        "follow_up": str(plan or theory or "Consolidate and keep improving piece activity.").strip(),
    }


def _build_user_style_move_priors(
    raw_style_lines: object,
    *,
    my_color: str,
) -> dict[str, dict[str, float]]:
    """Build per-position move priors from user repertoire lines."""
    if not isinstance(raw_style_lines, list):
        return {}
    priors: dict[str, dict[str, float]] = defaultdict(dict)
    for raw_line in raw_style_lines[:360]:
        if not isinstance(raw_line, dict):
            continue
        line_player_color = str(raw_line.get("player_color") or raw_line.get("source_player_color") or "").strip().lower()
        if line_player_color in {"white", "black"} and line_player_color != my_color:
            continue
        start_fen = str(raw_line.get("start_fen", "") or chess.STARTING_FEN).strip() or chess.STARTING_FEN
        try:
            board = chess.Board(start_fen)
        except ValueError:
            continue
        moves_uci = [str(item or "").strip() for item in (raw_line.get("moves_uci") or []) if str(item or "").strip()]
        if not moves_uci:
            continue
        try:
            line_weight = float(raw_line.get("weight", 1.0) or 1.0)
        except (TypeError, ValueError):
            line_weight = 1.0
        line_weight = max(0.2, min(6.0, line_weight))
        for ply_index, move_uci in enumerate(moves_uci[:80]):
            try:
                move = chess.Move.from_uci(move_uci)
            except ValueError:
                break
            if move not in board.legal_moves:
                break
            mover = "white" if board.turn == chess.WHITE else "black"
            if mover == my_color:
                fen_key = _normalize_position_key(board)
                existing = float(priors.get(fen_key, {}).get(move_uci, 0.0) or 0.0)
                ply_weight = 1.18 if ply_index <= 14 else 1.0 if ply_index <= 28 else 0.88
                priors.setdefault(fen_key, {})[move_uci] = existing + (line_weight * ply_weight)
            board.push(move)
    return {key: dict(value) for key, value in priors.items() if value}


def generate_smart_theory_tree(
    board: chess.Board,
    engine: EngineSession,
    *,
    payload: dict[str, Any] | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    status_callback: Callable[..., None] | None = None,
) -> dict[str, Any]:
    # Smart Theory keeps all eval math in White's perspective so a positive score
    # always means White is better, regardless of side to move.
    generation_started_at = time.time()
    request = payload or {}
    my_color = "black" if str(request.get("my_color", "white")).strip().lower() == "black" else "white"
    opponent_accuracy = str(request.get("opponent_accuracy", "mixed")).strip().lower() or "mixed"
    # "Move 20" is 40 plies. Keep the default there so exported study lines do
    # not collapse into the old 5-10 move samples.
    max_ply = max(2, min(40, int(request.get("max_ply", 40) or 40)))
    max_positions = max(10, min(1500, int(request.get("max_positions", 900) or 900)))
    opponent_replies = max(1, min(12, int(request.get("opponent_replies", 6) or 6)))
    include_best_engine_replies = bool(request.get("include_best_engine_replies", True))
    include_rare_sidelines = bool(request.get("include_rare_sidelines", True))
    include_mistakes = bool(request.get("include_opponent_mistakes", True))
    include_blunders = bool(request.get("include_opponent_blunders", True))
    avoid_absurd_moves = bool(request.get("avoid_absurd_moves", True))
    eco_only_mode = bool(request.get("eco_only_mode", False))
    cache_evals = bool(request.get("cache_evaluations", False))
    try:
        expected_move_confidence_cp = int(request.get("expected_move_confidence_cp", 125) or 125)
    except (TypeError, ValueError):
        expected_move_confidence_cp = 125
    expected_move_confidence_cp = max(20, min(300, expected_move_confidence_cp))
    try:
        style_move_confidence_cp = int(request.get("style_move_confidence_cp", 90) or 90)
    except (TypeError, ValueError):
        style_move_confidence_cp = 90
    style_move_confidence_cp = max(20, min(300, style_move_confidence_cp))
    try:
        style_preferred_min_weight = float(request.get("style_preferred_min_weight", 1.2) or 1.2)
    except (TypeError, ValueError):
        style_preferred_min_weight = 1.2
    style_preferred_min_weight = max(0.2, min(8.0, style_preferred_min_weight))
    legacy_opening_focus = str(request.get("opening_focus", "auto") or "auto").strip().lower()
    warnings_for_later = []
    if legacy_opening_focus not in {"", "auto", "inferred_style"}:
        warnings_for_later.append(
            "Ignored the legacy opening-system override. Smart Theory now follows only the selected source and exact-position repertoire evidence."
        )
    opening_focus = "inferred_style"
    follow_user_line_until_out_of_book = bool(request.get("follow_user_line_until_out_of_book", True))
    start_play_uci = [str(item) for item in (request.get("start_play_uci") or []) if str(item)]
    user_book_line_uci = [str(item) for item in (request.get("user_book_line_uci") or []) if str(item)]
    user_book_line_player_color = str(request.get("user_book_line_player_color", "") or "").strip().lower()
    if user_book_line_player_color in {"white", "black"} and user_book_line_player_color != my_color:
        user_book_line_uci = []
    user_style_lines = request.get("user_style_lines") or []
    user_style_move_priors = _build_user_style_move_priors(user_style_lines, my_color=my_color)
    reference_user_move_uci = str(request.get("reference_user_move_uci", "") or "").strip()
    starting_source = str(request.get("starting_source", "current_board") or "current_board")
    time_sec = request.get("engine_movetime_sec")
    try:
        time_sec = float(time_sec) if time_sec is not None else None
    except (TypeError, ValueError):
        time_sec = None

    worker_count = max(1, int(getattr(engine, "worker_count", 1) or 1))
    node_counter = 0
    root_board = board.copy(stack=False)
    start_warnings: list[str] = []

    def _trim_line_to_legal_continuation(
        start_board: chess.Board,
        raw_line_uci: list[str],
        *,
        min_plies: int = 1,
    ) -> list[str]:
        """Return the best legal suffix from raw_line_uci for start_board.

        This keeps Smart Theory aligned with the user's real line even when
        the provided sequence includes earlier prefix moves from a different
        starting context.
        """
        cleaned = [str(item or "").strip() for item in raw_line_uci if str(item or "").strip()]
        if not cleaned:
            return []
        best_line: list[str] = []
        best_score = -1
        for offset in range(len(cleaned)):
            board_cursor = start_board.copy(stack=False)
            legal_seq: list[str] = []
            for move_uci in cleaned[offset:]:
                try:
                    move = chess.Move.from_uci(move_uci)
                except ValueError:
                    break
                if move not in board_cursor.legal_moves:
                    break
                legal_seq.append(move_uci)
                board_cursor.push(move)
            # Favor longer legal continuations; small offset penalty breaks ties.
            score = (len(legal_seq) * 12) - offset
            if len(legal_seq) >= min_plies and score > best_score:
                best_score = score
                best_line = legal_seq
        return best_line

    def _infer_user_book_line_from_style_data(start_board: chess.Board) -> tuple[list[str], str]:
        if not isinstance(user_style_lines, list):
            return [], ""
        ranked_lines: list[tuple[float, int, list[str], str]] = []
        for index, raw_line in enumerate(user_style_lines[:420]):
            if not isinstance(raw_line, dict):
                continue
            line_player_color = str(raw_line.get("player_color") or raw_line.get("source_player_color") or "").strip().lower()
            if line_player_color in {"white", "black"} and line_player_color != my_color:
                continue
            raw_moves = [str(item or "").strip() for item in (raw_line.get("moves_uci") or []) if str(item or "").strip()]
            if not raw_moves:
                continue
            legal_line = _trim_line_to_legal_continuation(start_board, raw_moves, min_plies=1)
            if not legal_line:
                continue
            try:
                weight = float(raw_line.get("weight", 1.0) or 1.0)
            except (TypeError, ValueError):
                weight = 1.0
            # Prefer lines where the first move by our side appears quickly,
            # then use saved-repertoire weight as the tie-breaker.
            board_cursor = start_board.copy(stack=False)
            first_my_ply = 999
            my_move_count = 0
            for ply_index, move_uci in enumerate(legal_line[:24]):
                if ("white" if board_cursor.turn == chess.WHITE else "black") == my_color:
                    first_my_ply = min(first_my_ply, ply_index)
                    my_move_count += 1
                try:
                    board_cursor.push(chess.Move.from_uci(move_uci))
                except Exception:
                    break
            if my_move_count <= 0:
                continue
            score = (weight * 100.0) + (my_move_count * 8.0) - first_my_ply - (index * 0.01)
            ranked_lines.append((score, index, legal_line, str(raw_line.get("source", "user_style_lines") or "user_style_lines")))
        if not ranked_lines:
            return [], ""
        ranked_lines.sort(key=lambda item: item[0], reverse=True)
        _score, _index, legal_line, source = ranked_lines[0]
        return legal_line[:80], source

    def _in_book(board_for_book: chess.Board, move_uci: str) -> bool | None:
        # Treat strong local repertoire priors as "known book" even when online
        # explorer data is sparse or missing for the exact position.
        local_priors = user_style_move_priors.get(_normalize_position_key(board_for_book), {})
        local_weight = float(local_priors.get(move_uci, 0.0) or 0.0)
        if local_weight >= style_preferred_min_weight:
            return True
        try:
            context = database_context_for_board(board_for_book, play_uci=[], limit=16)
            db_moves = context.get("database_moves", []) if isinstance(context, dict) else []
            if not db_moves:
                return None
            for item in db_moves:
                if str(item.get("uci", "") or "") == move_uci:
                    popularity = float(item.get("popularity", item.get("percent", 0.0)) or 0.0)
                    return popularity > 0.0
        except Exception:
            return None
        return False

    applied_start_moves: list[str] = []
    # Only explicit setup/context moves should advance the starting board.
    # A user repertoire line inferred from saved games is the line to generate,
    # not a hidden prefix to skip over. Treating it as setup made Smart Theory
    # appear to start from random middlegame-ish opening positions.
    opening_seed_source = start_play_uci[:]
    opening_seed_line = _trim_line_to_legal_continuation(root_board, opening_seed_source, min_plies=1)
    for move_uci in opening_seed_line:
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            start_warnings.append(f"Ignored invalid start move: {move_uci}")
            continue
        if move not in root_board.legal_moves:
            start_warnings.append(f"Ignored illegal start move in position: {move_uci}")
            continue
        if follow_user_line_until_out_of_book:
            in_book = _in_book(root_board, move_uci)
            if in_book is False:
                start_warnings.append(f"Stopped opening seed at {move_uci} because it appears outside book coverage.")
                break
            if in_book is None:
                start_warnings.append(
                    f"Book coverage was unavailable while checking {move_uci}; continued with your played line."
                )
        root_board.push(move)
        applied_start_moves.append(move_uci)

    # Keep a per-ply reference of the user's known line after the applied seed.
    # Align by legality against the post-seed board so we can follow user's real
    # repertoire even when the input line includes earlier moves.
    inferred_user_line_source = ""
    if not user_book_line_uci:
        user_book_line_uci, inferred_user_line_source = _infer_user_book_line_from_style_data(root_board)
        if user_book_line_uci:
            start_warnings.append(
                f"Inferred your Smart Theory spine from {inferred_user_line_source}; first moves: {' '.join(user_book_line_uci[:8])}."
            )
    user_line_source = user_book_line_uci[:] if user_book_line_uci else start_play_uci[:]
    remaining_user_line_uci: list[str] = _trim_line_to_legal_continuation(
        root_board,
        user_line_source,
        min_plies=1,
    )
    source_move_by_fen: dict[str, str] = {}
    source_cursor = root_board.copy(stack=False)
    for move_uci in remaining_user_line_uci:
        try:
            source_move = chess.Move.from_uci(move_uci)
        except ValueError:
            break
        if source_move not in source_cursor.legal_moves:
            break
        source_move_by_fen[_normalize_position_key(source_cursor)] = move_uci
        source_cursor.push(source_move)

    eval_cache: dict[str, dict[str, Any]] = {}
    eval_cache_lock = threading.Lock()
    visited: set[str] = set()
    nodes: dict[str, dict[str, Any]] = {}
    node_list: list[dict[str, Any]] = []
    queue: deque[tuple[str, chess.Board, int, list[str]]] = deque()
    positions_done = 0
    positions_total_hint = max_positions
    warnings: list[str] = [*warnings_for_later, *start_warnings]

    def cb(phase: str, message: str, extra: dict[str, Any] | None = None) -> None:
        if status_callback:
            payload = dict(extra or {})
            payload["warnings_count"] = len(warnings)
            if warnings:
                payload["warning_latest"] = str(warnings[-1])
            status_callback(phase, message, positions_done, positions_total_hint, **payload)

    def cancelled() -> bool:
        return bool(is_cancelled and is_cancelled())

    def normalized_fen(b: chess.Board) -> str:
        return _normalize_position_key(b)

    def board_opening(b: chess.Board) -> tuple[str, str]:
        hit = lookup_by_board(b)
        return str(hit.get("name", "")), str(hit.get("eco", ""))

    def eval_lines(b: chess.Board, multipv: int = 4) -> list[dict[str, Any]]:
        persistent_key = _engine_cache_key(
            "smart-theory-eval",
            b,
            engine,
            limit=multipv,
            time_sec=time_sec,
            extra={"schema": SMART_THEORY_SCHEMA_VERSION},
        )
        key = persistent_key
        if cache_evals:
            with eval_cache_lock:
                if key in eval_cache:
                    cached = eval_cache[key]
                    return list(cached.get("lines", []))
            cached = _load_engine_cache(persistent_key)
            cached_rows = cached.get("smart_theory_lines") if isinstance(cached, dict) else None
            if isinstance(cached_rows, list):
                lines: list[dict[str, Any]] = []
                for row in cached_rows:
                    if not isinstance(row, dict):
                        continue
                    pv_moves: list[chess.Move] = []
                    for move_uci in row.get("pv_uci", []):
                        try:
                            pv_moves.append(chess.Move.from_uci(str(move_uci)))
                        except ValueError:
                            break
                    if not pv_moves:
                        continue
                    lines.append(
                        {
                            "pv": pv_moves,
                            "score": chess.engine.PovScore(
                                chess.engine.Cp(int(row.get("score_white_cp", 0) or 0)),
                                chess.WHITE,
                            ),
                        }
                    )
                with eval_cache_lock:
                    eval_cache[key] = {"lines": lines}
                return lines
        try:
            lines = engine.analyse(
                b,
                depth=max(10, int(engine.settings.depth or 16)),
                multipv=max(1, multipv),
                time_sec=time_sec,
            )
        except Exception as exc:
            warnings.append(f"Engine analysis failed for {normalized_fen(b)}: {exc}")
            return []
        if cache_evals:
            with eval_cache_lock:
                eval_cache[key] = {"lines": list(lines)}
            serializable_lines = []
            for line in lines:
                pv = [move.uci() for move in (line.get("pv") or []) if isinstance(move, chess.Move)]
                if not pv:
                    continue
                serializable_lines.append(
                    {
                        "pv_uci": pv,
                        "score_white_cp": score_white_cp(line, b.turn),
                    }
                )
            _save_engine_cache(persistent_key, {"smart_theory_lines": serializable_lines})
        return list(lines)

    def score_white_cp(line: dict[str, Any], turn: bool) -> int:
        score = line.get("score")
        if score is None:
            return 0
        return int(_score_cp(score, chess.WHITE))

    def opponent_category(*, delta: int, popularity: float) -> str:
        if delta <= 25 and popularity >= 12:
            return "Mainline"
        if popularity >= 5 and delta <= 75:
            return "Popular"
        if delta <= 75:
            return "Sideline"
        if delta <= 150:
            return "Inaccuracy"
        if delta <= 300:
            return "Mistake"
        return "Blunder"

    def user_category(delta: int) -> str:
        loss = max(0, int(delta))
        if loss <= 10:
            return "Best"
        if loss <= 25:
            return "Excellent"
        if loss <= 75:
            return "Good"
        if loss <= 150:
            return "Inaccuracy"
        if loss <= 300:
            return "Mistake"
        return "Blunder"

    def user_loss_cp(*, before_white_cp: int, after_white_cp: int, mover_color: chess.Color) -> int:
        # Eval values are always White-perspective. Loss must be measured from
        # the mover's perspective, otherwise good Black moves look like blunders.
        if mover_color == chess.WHITE:
            return max(0, int(before_white_cp) - int(after_white_cp))
        return max(0, int(after_white_cp) - int(before_white_cp))

    def learning_priority_for_node(
        *,
        is_user_side: bool,
        is_corrected_move: bool,
        move_class: str,
        ply_index: int,
    ) -> tuple[int, str]:
        label = str(move_class or "").strip().lower()
        if is_corrected_move:
            return 1000 - max(0, ply_index), "Corrected your repeated move"
        if is_user_side and label == "blunder":
            return 920 - max(0, ply_index), "You blunder this position often"
        if is_user_side and label == "mistake":
            return 880 - max(0, ply_index), "You often play a mistake here"
        if is_user_side and label == "inaccuracy":
            return 840 - max(0, ply_index), "You often choose an inaccurate move here"
        if is_user_side and label in {"good", "excellent", "best"}:
            return 520 - max(0, ply_index), "Known but worth reviewing for consistency"
        if not is_user_side and label in {"blunder", "mistake", "inaccuracy"}:
            return 460 - max(0, ply_index), "Useful opponent error branch to convert"
        return 320 - max(0, ply_index), "General repertoire context"

    def motifs_for_move(b: chess.Board, mv: chess.Move) -> list[str]:
        motifs: list[str] = []
        if b.is_capture(mv):
            motifs.append("capture")
        if b.gives_check(mv):
            motifs.append("check")
        try:
            promo = mv.promotion
            if promo:
                motifs.append("promotion")
        except Exception:
            pass
        try:
            after = b.copy(stack=False)
            after.push(mv)
            _tactical_reasons, tactical_motifs = _move_tactical_annotations(b, mv, after)
            for motif in tactical_motifs:
                _append_unique(motifs, motif)
        except Exception:
            pass
        return motifs

    root_id = "root"
    root_opening, root_eco = board_opening(root_board)
    effective_opening_focus = "inferred_style"
    root_node = {
        "id": root_id,
        "parentId": "",
        "fenBefore": root_board.fen(),
        "fenAfter": root_board.fen(),
        "fen": root_board.fen(),
        "normalizedFen": normalized_fen(root_board),
        "ply": 0,
        "san": "",
        "uci": "",
        "move": None,
        "source": {"key": "starting_source", "label": str(request.get("source_label", "Current board") or "Current board")},
        "sideToMove": "white" if root_board.turn == chess.WHITE else "black",
        "openingName": root_opening,
        "ecoCode": root_eco,
        "evalBefore": 0,
        "evalAfter": 0,
        "evalSwing": 0,
        "bestMoveUci": "",
        "bestMoveSan": "",
        "principalVariation": [],
        "engineDepth": int(engine.settings.depth),
        "databaseMoves": [],
        "popularity": 0,
        "gameCount": 0,
        "classification": "Root",
        "eval": {"beforeCp": 0, "afterCp": 0, "lossCp": 0, "swingCp": 0},
        "opponentAccuracy": opponent_accuracy,
        "isUserSide": False,
        "isOpponentSide": False,
        "isCorrectedMove": False,
        "originalUserMove": "",
        "correctedMove": "",
        "theoryExplanation": "Start position for smart theory generation.",
        "explanation": {
            "summary": "Start position for Smart Theory generation.",
            "why": "Every generated child must be legally reachable from this exact position.",
            "threat": "",
            "response": "",
            "plan": "Follow the selected source while its moves remain sound, then use Stockfish corrections.",
        },
        "planForUser": "Build a stable opening structure and stay consistent with your repertoire themes.",
        "opponentIdea": "",
        "threatSummary": "No immediate tactical threat at the root; establish your preferred setup.",
        "whyMoveGoodOrBad": "Baseline starting node before move selection.",
        "bestResponseSummary": "",
        "followUpPlan": "Develop naturally and follow your repertoire until correction is needed.",
        "tacticalMotifs": [],
        "importantSquares": ["d4", "d5", "e4", "e5"],
        "pawnBreaks": [],
        "children": [],
        "createdAt": int(time.time()),
        "updatedAt": int(time.time()),
    }
    nodes[root_id] = root_node
    node_list.append(root_node)
    queue.append((root_id, root_board, 0, []))
    visited.add(root_node["normalizedFen"])

    cb("generating", "Building smart theory tree...", {"partial_nodes": node_list[:], "partial_total_nodes": len(node_list)})
    # Use the Stockfish worker pool + batched queue expansion so large trees stay
    # responsive instead of serially blocking one long engine loop.
    with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="bookup-smart-theory") as executor:
      while queue and len(node_list) < max_positions:
        if cancelled():
            cb("stopping", "Generation stopped by user.")
            break
        batch: list[tuple[str, chess.Board, int, list[str]]] = []
        while queue and len(batch) < worker_count:
            batch.append(queue.popleft())
        ready_batch = [item for item in batch if item[2] < max_ply and not item[1].is_game_over(claim_draw=True)]
        if not ready_batch:
            continue
        positions_done += len(ready_batch)
        cb("analyzing", f"Analyzing position {positions_done} of {positions_total_hint}")

        future_map = {
            executor.submit(eval_lines, current_board, max(4, opponent_replies + 2)): (parent_id, current_board, ply, path)
            for parent_id, current_board, ply, path in ready_batch
        }
        for future in as_completed(future_map):
            if cancelled() or len(node_list) >= max_positions:
                break
            parent_id, current_board, ply, path = future_map[future]
            parent = nodes[parent_id]
            try:
                lines = future.result()
            except Exception as exc:
                warnings.append(f"Worker failed on position {normalized_fen(current_board)}: {exc}")
                continue
            if not lines:
                fallback_move = next(iter(current_board.legal_moves), None)
                if fallback_move is None:
                    continue
                warnings.append(
                    f"Engine and database analysis were unavailable for {normalized_fen(current_board)}; used deterministic legal fallback {fallback_move.uci()}."
                )
                lines = [{"pv": [fallback_move], "score": None, "_fallback": True}]

            mover = "white" if current_board.turn == chess.WHITE else "black"
            user_to_move = mover == my_color
            eval_before = score_white_cp(lines[0], current_board.turn)
            top_line = lines[0]
            top_pv = top_line.get("pv") or []
            top_best_uci = top_pv[0].uci() if top_pv else ""
            style_preferred_uci = ""
            style_prior_map: dict[str, float] = {}

            candidate_moves: list[tuple[chess.Move, str, int, dict[str, Any], float, int, str, list[dict[str, Any]]]] = []
            db = database_context_for_board(current_board, play_uci=path, limit=max(10, opponent_replies + 4))
            db_moves = list(db.get("database_moves", []))
            db_map = {str(item.get("uci", "")): item for item in db_moves if item.get("uci")}

            if user_to_move:
                if not top_pv:
                    continue
                expected_user_move_from_line = str(
                    source_move_by_fen.get(normalized_fen(current_board), "") or ""
                ).strip()
                def user_line_for_uci(move_uci: str) -> dict[str, Any] | None:
                    if not move_uci:
                        return None
                    cached_line = next(
                        (
                            line
                            for line in lines
                            if (line.get("pv") or [None])[0]
                            and (line.get("pv") or [None])[0].uci() == move_uci
                        ),
                        None,
                    )
                    if cached_line is not None:
                        return cached_line
                    try:
                        forced_move = chess.Move.from_uci(move_uci)
                    except ValueError:
                        return None
                    if forced_move not in current_board.legal_moves:
                        return None
                    forced_board = current_board.copy(stack=False)
                    forced_board.push(forced_move)
                    forced_lines = eval_lines(forced_board, 1)
                    if not forced_lines:
                        return None
                    forced_top = dict(forced_lines[0])
                    continuation = [mv for mv in (forced_top.get("pv") or []) if isinstance(mv, chess.Move)]
                    forced_top["pv"] = [forced_move, *continuation]
                    return forced_top
                style_prior_map = user_style_move_priors.get(normalized_fen(current_board), {})
                if isinstance(style_prior_map, dict) and style_prior_map:
                    legal_style_moves: list[str] = []
                    for uci in style_prior_map.keys():
                        try:
                            move = chess.Move.from_uci(uci)
                        except ValueError:
                            continue
                        if move in current_board.legal_moves:
                            legal_style_moves.append(uci)
                    if legal_style_moves:
                        strongest = max(legal_style_moves, key=lambda uci: float(style_prior_map.get(uci, 0.0) or 0.0))
                        strongest_weight = float(style_prior_map.get(strongest, 0.0) or 0.0)
                        if strongest_weight >= style_preferred_min_weight:
                            style_preferred_uci = strongest
                mv = top_pv[0]
                if mv not in current_board.legal_moves:
                    continue
                san = current_board.san(mv)
                cp = score_white_cp(top_line, current_board.turn)
                candidate_moves.append((mv, san, cp, top_line, 100.0, 0, "Best", db_moves))
                if style_preferred_uci and all(item[0].uci() != style_preferred_uci for item in candidate_moves):
                    try:
                        style_move = chess.Move.from_uci(style_preferred_uci)
                    except ValueError:
                        style_move = None
                    if style_move and style_move in current_board.legal_moves:
                        style_line = user_line_for_uci(style_preferred_uci)
                        if style_line is not None:
                            style_cp = score_white_cp(style_line, current_board.turn)
                            style_san = current_board.san(style_move)
                            style_category = user_category(
                                user_loss_cp(before_white_cp=eval_before, after_white_cp=style_cp, mover_color=current_board.turn)
                            )
                            style_strength = float(style_prior_map.get(style_preferred_uci, 0.0) or 0.0)
                            candidate_moves.append((style_move, style_san, style_cp, style_line, min(95.0, 80.0 + style_strength), 0, style_category, db_moves))
                # Surface "unknown line" learning at the root by also including
                # the user's frequently played move when it differs from the best.
                if ply == 0 and reference_user_move_uci:
                    try:
                        user_move = chess.Move.from_uci(reference_user_move_uci)
                    except ValueError:
                        user_move = None
                    if user_move and user_move in current_board.legal_moves and all(item[0].uci() != reference_user_move_uci for item in candidate_moves):
                        user_line = user_line_for_uci(reference_user_move_uci)
                        if user_line is not None:
                            user_cp = score_white_cp(user_line, current_board.turn)
                            user_san = current_board.san(user_move)
                            user_category_label = user_category(
                                user_loss_cp(before_white_cp=eval_before, after_white_cp=user_cp, mover_color=current_board.turn)
                            )
                            candidate_moves.append((user_move, user_san, user_cp, user_line, 80.0, 0, user_category_label, db_moves))
                if expected_user_move_from_line:
                    try:
                        expected_user_move = chess.Move.from_uci(expected_user_move_from_line)
                    except ValueError:
                        expected_user_move = None
                    if expected_user_move and expected_user_move in current_board.legal_moves and all(
                        item[0].uci() != expected_user_move_from_line for item in candidate_moves
                    ):
                        expected_line = user_line_for_uci(expected_user_move_from_line)
                        if expected_line is not None:
                            expected_cp = score_white_cp(expected_line, current_board.turn)
                            expected_san = current_board.san(expected_user_move)
                            expected_category_label = user_category(
                                user_loss_cp(before_white_cp=eval_before, after_white_cp=expected_cp, mover_color=current_board.turn)
                            )
                            candidate_moves.append(
                                (
                                    expected_user_move,
                                    expected_san,
                                    expected_cp,
                                    expected_line,
                                    78.0,
                                    0,
                                    expected_category_label,
                                    db_moves,
                                )
                            )
                # Play like the user when the known move is still sound; switch
                # to the strongest correction only when the known move is too weak.
                if candidate_moves:
                    best_candidate = candidate_moves[0]
                    expected_candidate = None
                    if expected_user_move_from_line:
                        expected_candidate = next(
                            (item for item in candidate_moves if item[0].uci() == expected_user_move_from_line),
                            None,
                        )
                    style_candidate = None
                    if style_preferred_uci:
                        style_candidate = next(
                            (item for item in candidate_moves if item[0].uci() == style_preferred_uci),
                            None,
                        )
                    if expected_candidate is not None:
                        best_score_known = best_candidate[3].get("score") is not None if isinstance(best_candidate[3], dict) else False
                        expected_score_known = expected_candidate[3].get("score") is not None if isinstance(expected_candidate[3], dict) else False
                        expected_loss = user_loss_cp(
                            before_white_cp=int(best_candidate[2]),
                            after_white_cp=int(expected_candidate[2]),
                            mover_color=current_board.turn,
                        )
                        if best_score_known and expected_score_known and expected_loss <= expected_move_confidence_cp:
                            candidate_moves = [expected_candidate]
                        else:
                            # Grandmaster-version mode: do not export the user's
                            # bad move as "my" playable branch. Keep the best
                            # correction and store the played move as context.
                            candidate_moves = [best_candidate]
                    elif style_candidate is not None:
                        # Mubassar-style confidence gate: keep the familiar move
                        # when it is close enough, otherwise keep best+style for
                        # clear correction context.
                        style_loss = user_loss_cp(
                            before_white_cp=int(best_candidate[2]),
                            after_white_cp=int(style_candidate[2]),
                            mover_color=current_board.turn,
                        )
                        if style_loss <= style_move_confidence_cp:
                            candidate_moves = [style_candidate]
                        else:
                            # If the style move is too weak, annotate the
                            # correction but keep the exported repertoire line
                            # on the engine-approved move.
                            candidate_moves = [best_candidate]
                    else:
                        candidate_moves = [best_candidate]
            else:
                for line in lines:
                    pv = line.get("pv") or []
                    if not pv:
                        continue
                    mv = pv[0]
                    if mv not in current_board.legal_moves:
                        continue
                    san = current_board.san(mv)
                    uci = mv.uci()
                    cp = score_white_cp(line, current_board.turn)
                    db_entry = db_map.get(uci, {})
                    popularity = float(db_entry.get("popularity", db_entry.get("percent", 0.0)) or 0.0)
                    games = int(db_entry.get("games", db_entry.get("game_count", db_entry.get("play_count", 0))) or 0)
                    delta = abs(cp - eval_before)
                    category = opponent_category(delta=delta, popularity=popularity)
                    candidate_moves.append((mv, san, cp, line, popularity, games, category, db_moves))

                def _opp_weight(item: tuple[chess.Move, str, int, dict[str, Any], float, int, str, list[dict[str, Any]]]) -> float:
                    # Blend engine quality with practical popularity so opponent
                    # lines feel human and mode-dependent instead of perfect-only.
                    _, _, cp, _, pop, games, category, _ = item
                    eval_penalty = abs(cp - eval_before) / 100.0
                    pop_factor = pop / 100.0
                    games_factor = min(1.0, games / 10000.0)
                    category_bonus = {
                        "Mainline": 0.8,
                        "Popular": 0.55,
                        "Sideline": 0.3,
                        "Inaccuracy": 0.12,
                        "Mistake": 0.05,
                        "Blunder": 0.0,
                    }.get(category, 0.1)
                    if opponent_accuracy == "grandmaster":
                        return (2.1 - eval_penalty) + (pop_factor * 0.9) + (games_factor * 0.35) + category_bonus
                    if opponent_accuracy == "strong_club":
                        return (1.85 - eval_penalty) + (pop_factor * 0.75) + category_bonus
                    if opponent_accuracy == "club":
                        return (1.6 - (eval_penalty * 0.82)) + (pop_factor * 0.62) + category_bonus
                    if opponent_accuracy in {"beginner", "intermediate", "beginner_intermediate"}:
                        return (1.15 - (eval_penalty * 0.5)) + (pop_factor * 0.42) + (0.1 if category in {"Mistake", "Blunder"} else 0.0)
                    return (1.5 - (eval_penalty * 0.74)) + (pop_factor * 0.7) + (games_factor * 0.2) + category_bonus

                ranked = sorted(candidate_moves, key=_opp_weight, reverse=True)[: max(2, opponent_replies * 3)]
                selected: list[tuple[chess.Move, str, int, dict[str, Any], float, int, str, list[dict[str, Any]]]] = []

                def _add_opponent_candidate(
                    bucket: list[tuple[chess.Move, str, int, dict[str, Any], float, int, str, list[dict[str, Any]]]],
                    item: tuple[chess.Move, str, int, dict[str, Any], float, int, str, list[dict[str, Any]]] | None,
                ) -> None:
                    if item is None or len(bucket) >= opponent_replies:
                        return
                    _, _, cp, _, _, _, category, _ = item
                    delta = abs(cp - eval_before)
                    if eco_only_mode and category not in {"Mainline", "Popular"}:
                        return
                    if category == "Sideline" and not include_rare_sidelines:
                        return
                    if category == "Blunder" and not include_blunders:
                        return
                    if category in {"Inaccuracy", "Mistake"} and not include_mistakes:
                        return
                    if avoid_absurd_moves and delta >= 450:
                        return
                    key = item[0].uci()
                    if key != top_best_uci and key not in db_map:
                        return
                    if any(existing[0].uci() == key for existing in bucket):
                        return
                    bucket.append(item)

                # Deliberately cover the opponent buckets the study should teach:
                # engine best, database most-played, and realistic inaccuracies.
                if include_best_engine_replies and top_best_uci:
                    _add_opponent_candidate(
                        selected,
                        next((item for item in ranked if item[0].uci() == top_best_uci), None),
                    )
                _add_opponent_candidate(
                    selected,
                    next(
                        (
                            item
                            for item in sorted(
                                candidate_moves,
                                key=lambda item: (float(item[4]), int(item[5])),
                                reverse=True,
                            )
                        ),
                        None,
                    ),
                )
                if include_mistakes:
                    for weak_category in ("Inaccuracy", "Mistake"):
                        _add_opponent_candidate(
                            selected,
                            next((item for item in ranked if item[6] == weak_category), None),
                        )
                if include_blunders:
                    _add_opponent_candidate(
                        selected,
                        next((item for item in ranked if item[6] == "Blunder"), None),
                    )
                for item in ranked:
                    if len(selected) >= opponent_replies:
                        break
                    _add_opponent_candidate(selected, item)
                if selected:
                    candidate_moves = selected
                else:
                    fallback_move = next(iter(current_board.legal_moves), None)
                    if fallback_move is None:
                        candidate_moves = []
                    else:
                        fallback_board = current_board.copy(stack=False)
                        fallback_board.push(fallback_move)
                        fallback_lines = eval_lines(fallback_board, 1)
                        fallback_cp = (
                            score_white_cp(fallback_lines[0], fallback_board.turn)
                            if fallback_lines
                            else eval_before
                        )
                        candidate_moves = [(
                            fallback_move,
                            current_board.san(fallback_move),
                            fallback_cp,
                            {"pv": [fallback_move], "score": None, "_fallback": True},
                            0.0,
                            0,
                            "Sideline",
                            db_moves,
                        )]
                # Keep one engine-top defensive resource available when enabled,
                # even if weighting/filtering picked only weaker human-like lines.
                if include_best_engine_replies and top_best_uci:
                    engine_best_item = next((item for item in candidate_moves if item[0].uci() == top_best_uci), None)
                    if engine_best_item is None:
                        engine_best_item = next((item for item in ranked if item[0].uci() == top_best_uci), None)
                    if engine_best_item is None:
                        best_move = top_pv[0] if top_pv else None
                        if best_move and best_move in current_board.legal_moves:
                            best_san = current_board.san(best_move)
                            best_line = next(
                                (
                                    line
                                    for line in lines
                                    if (line.get("pv") or [None])[0]
                                    and (line.get("pv") or [None])[0].uci() == top_best_uci
                                ),
                                top_line,
                            )
                            best_cp = score_white_cp(best_line, current_board.turn)
                            best_db_entry = db_map.get(top_best_uci, {})
                            best_popularity = float(best_db_entry.get("popularity", best_db_entry.get("percent", 0.0)) or 0.0)
                            best_games = int(best_db_entry.get("games", best_db_entry.get("game_count", best_db_entry.get("play_count", 0))) or 0)
                            best_delta = abs(best_cp - eval_before)
                            best_category = opponent_category(delta=best_delta, popularity=best_popularity)
                            engine_best_item = (best_move, best_san, best_cp, best_line, best_popularity, best_games, best_category, db_moves)
                    if engine_best_item is not None and all(item[0].uci() != top_best_uci for item in candidate_moves):
                        candidate_moves = [engine_best_item, *candidate_moves]
                        # De-duplicate while preserving order, then respect cap.
                        deduped: list[tuple[chess.Move, str, int, dict[str, Any], float, int, str, list[dict[str, Any]]]] = []
                        seen_uci: set[str] = set()
                        for item in candidate_moves:
                            key = item[0].uci()
                            if key in seen_uci:
                                continue
                            seen_uci.add(key)
                            deduped.append(item)
                        candidate_moves = deduped[:opponent_replies]

            for move, san, eval_after, line_meta, popularity, game_count, category, db_moves in candidate_moves:
                if cancelled() or len(node_list) >= max_positions:
                    break
                if move not in current_board.legal_moves:
                    warnings.append(f"Illegal move skipped during generation: {move.uci()}")
                    continue
                eval_swing = eval_after - eval_before
                next_board = current_board.copy(stack=False)
                try:
                    next_board.push(move)
                except Exception as exc:
                    warnings.append(f"Move push failed and was skipped ({move.uci()}): {exc}")
                    continue
                verification_board = chess.Board(current_board.fen())
                try:
                    verification_board.push(chess.Move.from_uci(move.uci()))
                except Exception as exc:
                    warnings.append(f"Node validation failed for {move.uci()}: {exc}")
                    continue
                if verification_board.fen() != next_board.fen():
                    warnings.append(
                        f"Node FEN mismatch skipped for {move.uci()}: expected {verification_board.fen()}, received {next_board.fen()}."
                    )
                    continue
                opening_name, eco_code = board_opening(next_board)
                if eco_only_mode and not (opening_name or eco_code):
                    continue
                line_pv = line_meta.get("pv") or []
                pv_san, pv_uci = _pv_sans(current_board, line_pv)
                recommended_user_reply_uci = ""
                recommended_user_reply_san = ""
                if not user_to_move:
                    if len(pv_uci) >= 2:
                        recommended_user_reply_uci = str(pv_uci[1] or "").strip()
                    if len(pv_san) >= 2:
                        recommended_user_reply_san = str(pv_san[1] or "").strip()
                is_engine_best_reply = bool((not user_to_move) and top_best_uci and move.uci() == top_best_uci)
                user_loss = user_loss_cp(
                    before_white_cp=eval_before,
                    after_white_cp=eval_after,
                    mover_color=current_board.turn,
                ) if user_to_move else 0
                move_class = user_category(user_loss) if user_to_move else category
                original_user_move = ""
                corrected_move = ""
                correction_note = ""
                expected_user_move_uci = (
                    str(source_move_by_fen.get(normalized_fen(current_board), "") or "").strip()
                    if user_to_move
                    else ""
                )
                if user_to_move and not expected_user_move_uci and reference_user_move_uci and ply == 0:
                    expected_user_move_uci = reference_user_move_uci
                if user_to_move and expected_user_move_uci:
                    original_user_move = expected_user_move_uci
                    if expected_user_move_uci != move.uci():
                        corrected_move = move.uci()
                        candidate = next(
                            (
                                line
                                for line in lines
                                if (line.get("pv") or [None])[0]
                                and (line.get("pv") or [None])[0].uci() == expected_user_move_uci
                            ),
                            None,
                        )
                        if candidate is None:
                            candidate = user_line_for_uci(expected_user_move_uci)
                        if candidate is not None:
                            ref_cp = score_white_cp(candidate, current_board.turn)
                            ref_loss = user_loss_cp(
                                before_white_cp=eval_before,
                                after_white_cp=ref_cp,
                                mover_color=current_board.turn,
                            )
                            ref_class = user_category(ref_loss)
                            correction_note = (
                                f" Correction: your played-line move {expected_user_move_uci} is classified as {ref_class}. "
                                f"Use {move.uci()} instead."
                            )
                        else:
                            correction_note = (
                                f" Correction: your played-line move {expected_user_move_uci} was outside the legal/engine candidate set here. "
                                f"Use {move.uci()} instead."
                            )
                theory, plan, opp_idea = _smart_rule_explanation(
                    current_board,
                    move,
                    san,
                    opening_name=opening_name,
                    is_user_side=user_to_move,
                    classification=move_class,
                    eval_swing=eval_swing,
                    is_engine_best_reply=is_engine_best_reply,
                    recommended_user_reply_san=recommended_user_reply_san,
                    recommended_user_reply_uci=recommended_user_reply_uci,
                    pv_preview=pv_san[:6],
                )
                if correction_note:
                    theory = f"{theory}{correction_note}"
                tactical_reasons, tactical_motifs = _move_tactical_annotations(current_board, move, next_board)
                if tactical_reasons:
                    theory = f"{theory} Tactical note: {' '.join(tactical_reasons[:2])}"
                explanation_blocks = _smart_explanation_blocks(
                    san=san,
                    is_user_side=bool(user_to_move),
                    classification=str(move_class or ""),
                    eval_swing=int(eval_swing or 0),
                    is_engine_best_reply=bool(is_engine_best_reply),
                    recommended_user_reply_san=recommended_user_reply_san,
                    recommended_user_reply_uci=recommended_user_reply_uci,
                    theory=theory,
                    plan=plan,
                    opponent_idea=opp_idea,
                )
                learning_priority, learning_reason = learning_priority_for_node(
                    is_user_side=bool(user_to_move),
                    is_corrected_move=bool(corrected_move),
                    move_class=move_class,
                    ply_index=ply + 1,
                )
                node_counter += 1
                node_id = f"n{node_counter}"
                source_key = "stockfish_best_move"
                source_label = "Stockfish best move"
                if user_to_move and corrected_move:
                    source_key = "stockfish_correction"
                    source_label = "Stockfish correction"
                elif user_to_move and expected_user_move_uci and expected_user_move_uci == move.uci():
                    source_key = starting_source
                    source_label = {
                        "saved_line": "My saved line",
                        "imported_game": "My imported game",
                        "imported_pgn": "My imported game",
                        "my_repertoire": "My repertoire",
                    }.get(starting_source, "My repertoire")
                elif user_to_move and style_preferred_uci and style_preferred_uci == move.uci():
                    source_key = "my_repertoire"
                    source_label = "My repertoire"
                elif not user_to_move and is_engine_best_reply:
                    source_key = "opponent_best_engine_reply"
                    source_label = "Opponent best engine reply"
                elif not user_to_move and str(move.uci()) in db_map:
                    source_key = "opponent_database_reply"
                    source_label = "Opponent database reply"
                elif bool(line_meta.get("_fallback")):
                    source_key = "fallback_legal_move"
                    source_label = "Fallback legal move"
                node = {
                    "id": node_id,
                    "parentId": parent_id,
                    "fenBefore": current_board.fen(),
                    "fenAfter": next_board.fen(),
                    "fen": next_board.fen(),
                    "normalizedFen": normalized_fen(next_board),
                    "ply": ply + 1,
                    "san": san,
                    "uci": move.uci(),
                    "move": {
                        "from": chess.square_name(move.from_square),
                        "to": chess.square_name(move.to_square),
                        "promotion": chess.piece_symbol(move.promotion) if move.promotion else "",
                    },
                    "source": {"key": source_key, "label": source_label},
                    "sideToMove": "white" if next_board.turn == chess.WHITE else "black",
                    "openingName": opening_name,
                    "ecoCode": eco_code,
                    "evalBefore": eval_before,
                    "evalAfter": eval_after,
                    "evalSwing": eval_swing,
                    "userLossCp": int(user_loss) if user_to_move else 0,
                    "bestMoveUci": top_best_uci or (pv_uci[0] if pv_uci else ""),
                    "bestMoveSan": pv_san[0] if pv_san else "",
                    "principalVariation": pv_san[:16],
                    "principalVariationUci": pv_uci[:40],
                    "continuationAfterMoveUci": pv_uci[1:40],
                    "engineDepth": int(engine.settings.depth),
                    "databaseMoves": db_moves[:8],
                    "popularity": round(float(popularity), 2),
                    "gameCount": int(game_count),
                    "classification": move_class,
                    "eval": {
                        "beforeCp": int(eval_before),
                        "afterCp": int(eval_after),
                        "lossCp": int(user_loss) if user_to_move else max(0, abs(int(eval_swing))),
                        "swingCp": int(eval_swing),
                    },
                    "isBestEngineReply": bool(is_engine_best_reply),
                    "opponentAccuracy": opponent_accuracy,
                    "isUserSide": bool(user_to_move),
                    "isOpponentSide": bool(not user_to_move),
                    "isCorrectedMove": bool(corrected_move),
                    "originalUserMove": original_user_move,
                    "correctedMove": corrected_move,
                    "stylePreferredMoveUci": style_preferred_uci if user_to_move else "",
                    "stylePreferredMoveWeight": float(style_prior_map.get(style_preferred_uci, 0.0) or 0.0) if (user_to_move and style_preferred_uci) else 0.0,
                    "styleMatchedMove": bool(user_to_move and style_preferred_uci and move.uci() == style_preferred_uci),
                    "recommendedResponseUci": recommended_user_reply_uci if not user_to_move else "",
                    "recommendedResponseSan": recommended_user_reply_san if not user_to_move else "",
                    "learningPriority": int(learning_priority),
                    "learningReason": learning_reason,
                    "theoryExplanation": theory,
                    "explanation": {
                        "summary": theory,
                        "why": str(explanation_blocks.get("why", "") or ""),
                        "threat": str(explanation_blocks.get("threat", "") or ""),
                        "response": str(explanation_blocks.get("best_response", "") or ""),
                        "plan": str(explanation_blocks.get("follow_up", "") or plan or ""),
                    },
                    "planForUser": plan,
                    "opponentIdea": opp_idea if not user_to_move else "",
                    "threatSummary": str(explanation_blocks.get("threat", "") or ""),
                    "whyMoveGoodOrBad": str(explanation_blocks.get("why", "") or ""),
                    "bestResponseSummary": str(explanation_blocks.get("best_response", "") or ""),
                    "followUpPlan": str(explanation_blocks.get("follow_up", "") or ""),
                    "tacticalMotifs": tactical_motifs or motifs_for_move(current_board, move),
                    "importantSquares": ["d4", "d5", "e4", "e5"],
                    "pawnBreaks": ["c4", "d4", "e4"] if my_color == "white" else ["c5", "d5", "e5"],
                    "children": [],
                    "createdAt": int(time.time()),
                    "updatedAt": int(time.time()),
                }
                nodes[node_id] = node
                node_list.append(node)
                parent["children"].append(node_id)
                if ply + 1 < max_ply and len(node_list) < max_positions:
                    nfen = node["normalizedFen"]
                    if nfen not in visited:
                        visited.add(nfen)
                        queue.append((node_id, next_board, ply + 1, [*path, move.uci()]))
            cb(
                "analyzing",
                f"Analyzing position {positions_done} of {positions_total_hint}",
                {
                    "partial_nodes": node_list[-160:],
                    "partial_total_nodes": len(node_list),
                },
            )

    if not cancelled() and len(node_list) <= 1:
        warnings.append(
            "No candidate moves were generated beyond the root position. "
            "Try a lower depth/time, disable ECO-only mode, or broaden sidelines."
        )
    phase = "complete" if not cancelled() else "stopped"
    generation_seconds = round(max(0.0, time.time() - generation_started_at), 3)
    weak_classes = {"inaccuracy", "mistake", "blunder"}
    user_weak_nodes = [
        node
        for node in node_list
        if node.get("id") != "root"
        and bool(node.get("isUserSide"))
        and str(node.get("classification", "")).strip().lower() in weak_classes
    ]
    corrected_nodes = [node for node in node_list if bool(node.get("isCorrectedMove"))]
    learning_queue = sorted(
        [node for node in node_list if node.get("id") != "root"],
        key=lambda item: (-int(item.get("learningPriority", 0) or 0), int(item.get("ply", 0) or 0)),
    )[:40]
    cb(phase, "Smart theory generation complete." if phase == "complete" else "Smart theory generation stopped.")
    return {
        "schema_version": SMART_THEORY_SCHEMA_VERSION,
        "status": phase,
        "generation_state": phase,
        "generation_seconds": generation_seconds,
        "positions_done": positions_done,
        "positions_total": positions_total_hint,
        "root_id": root_id,
        "nodes_total": len(node_list),
        "nodes": node_list,
        "tree": nodes,
        "warnings": warnings[:120],
        "starting_source": starting_source,
        "opening_focus": effective_opening_focus,
        "applied_start_line_uci": applied_start_moves,
        "user_book_line_uci": remaining_user_line_uci,
        "user_book_line_source": inferred_user_line_source or ("payload" if user_book_line_uci else ""),
        "user_style_positions_count": len(user_style_move_priors),
        "learning_queue_count": len(learning_queue),
        "corrected_nodes_count": len(corrected_nodes),
        "user_weak_nodes_count": len(user_weak_nodes),
        "learning_queue_preview": [
            {
                "id": str(node.get("id", "") or ""),
                "ply": int(node.get("ply", 0) or 0),
                "san": str(node.get("san", "") or ""),
                "classification": str(node.get("classification", "") or ""),
                "learningPriority": int(node.get("learningPriority", 0) or 0),
                "learningReason": str(node.get("learningReason", "") or ""),
            }
            for node in learning_queue[:12]
        ],
        "start_fen": board.fen(),
        "effective_start_fen": root_board.fen(),
        "openingName": root_opening,
        "ecoCode": root_eco,
        "settings_used": {
            "my_color": my_color,
            "opponent_accuracy": opponent_accuracy,
            "max_ply": max_ply,
            "max_positions": max_positions,
            "opponent_replies": opponent_replies,
            "include_best_engine_replies": include_best_engine_replies,
            "include_rare_sidelines": include_rare_sidelines,
            "include_opponent_mistakes": include_mistakes,
            "include_opponent_blunders": include_blunders,
            "avoid_absurd_moves": avoid_absurd_moves,
            "eco_only_mode": eco_only_mode,
            "cache_evaluations": cache_evals,
            "expected_move_confidence_cp": expected_move_confidence_cp,
            "style_move_confidence_cp": style_move_confidence_cp,
            "style_preferred_min_weight": style_preferred_min_weight,
            "worker_count": worker_count,
        },
    }


def validate_smart_theory_tree(payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Migrate and validate a Smart Theory payload without trusting stored FENs."""
    if not isinstance(payload, dict):
        raise ValueError("Smart Theory import must be a JSON object.")
    warnings: list[str] = []
    raw_tree = payload.get("tree")
    raw_nodes = payload.get("nodes")
    node_map: dict[str, dict[str, Any]] = {}
    if isinstance(raw_tree, dict):
        node_map = {
            str(node_id): dict(node)
            for node_id, node in raw_tree.items()
            if isinstance(node, dict)
        }
    elif isinstance(raw_nodes, list):
        node_map = {
            str(node.get("id") or ""): dict(node)
            for node in raw_nodes
            if isinstance(node, dict) and str(node.get("id") or "").strip()
        }
    if not node_map:
        raise ValueError("Smart Theory import contains no nodes.")
    root_id = str(payload.get("root_id") or "root")
    if root_id not in node_map:
        roots = [
            node_id
            for node_id, node in node_map.items()
            if not str(node.get("parentId") or "").strip()
        ]
        if len(roots) != 1:
            raise ValueError("Smart Theory import must contain exactly one root node.")
        root_id = roots[0]
    raw_root = node_map[root_id]
    root_fen = str(
        raw_root.get("fenAfter")
        or raw_root.get("fenBefore")
        or raw_root.get("fen")
        or payload.get("effective_start_fen")
        or payload.get("start_fen")
        or ""
    ).strip()
    try:
        root_board = chess.Board(root_fen)
    except ValueError as exc:
        raise ValueError(f"Root node {root_id} has an invalid FEN.") from exc

    validated: dict[str, dict[str, Any]] = {}
    ordered: list[dict[str, Any]] = []

    def normalized_source(raw: object, *, is_root: bool = False) -> dict[str, str]:
        if isinstance(raw, dict):
            key = str(raw.get("key") or "").strip()
            label = str(raw.get("label") or "").strip()
        else:
            label = str(raw or "").strip()
            key = label.lower().replace(" ", "_")
        if is_root:
            return {"key": key or "starting_source", "label": label or "Current board"}
        allowed_labels = {
            "My saved line",
            "My imported game",
            "My repertoire",
            "Stockfish correction",
            "Stockfish best move",
            "Opponent database reply",
            "Opponent best engine reply",
            "Fallback legal move",
        }
        if label not in allowed_labels:
            warnings.append(f"Node source '{label or key}' was normalized to Fallback legal move.")
            return {"key": "fallback_legal_move", "label": "Fallback legal move"}
        return {"key": key or label.lower().replace(" ", "_"), "label": label}

    def child_ids_for(node_id: str, node: dict[str, Any]) -> list[str]:
        declared = node.get("children")
        if isinstance(declared, list):
            return [str(item) for item in declared if str(item) in node_map]
        return [
            child_id
            for child_id, child in node_map.items()
            if str(child.get("parentId") or "") == node_id
        ]

    root = dict(raw_root)
    root.update(
        {
            "id": root_id,
            "parentId": "",
            "fenBefore": root_board.fen(),
            "fenAfter": root_board.fen(),
            "fen": root_board.fen(),
            "move": None,
            "san": "",
            "uci": "",
            "source": normalized_source(root.get("source"), is_root=True),
            "classification": str(root.get("classification") or "Root"),
            "eval": root.get("eval") if isinstance(root.get("eval"), dict) else {},
            "explanation": root.get("explanation") if isinstance(root.get("explanation"), dict) else {
                "summary": str(root.get("theoryExplanation") or "Starting position."),
                "why": "",
                "threat": "",
                "response": "",
                "plan": str(root.get("planForUser") or ""),
            },
            "children": [],
        }
    )
    validated[root_id] = root
    ordered.append(root)

    visiting: set[str] = set()

    def visit(parent_id: str, parent_board: chess.Board) -> None:
        if parent_id in visiting:
            warnings.append(f"Cycle detected at node {parent_id}; descendants were skipped.")
            return
        visiting.add(parent_id)
        parent = validated[parent_id]
        for child_id in child_ids_for(parent_id, node_map[parent_id]):
            if child_id in validated:
                warnings.append(f"Duplicate or cyclic node {child_id} was skipped.")
                continue
            raw_child = node_map.get(child_id)
            if not isinstance(raw_child, dict):
                continue
            declared_parent = str(raw_child.get("parentId") or parent_id)
            if declared_parent != parent_id:
                warnings.append(
                    f"Node {child_id} declares parent {declared_parent}, expected {parent_id}; node and descendants skipped."
                )
                continue
            move_uci = str(raw_child.get("uci") or "").strip().lower()
            try:
                move = chess.Move.from_uci(move_uci)
            except ValueError:
                warnings.append(f"Node {child_id} has invalid UCI '{move_uci}'; node and descendants skipped.")
                continue
            if move not in parent_board.legal_moves:
                warnings.append(f"Node {child_id} move {move_uci} is illegal from its parent; node and descendants skipped.")
                continue
            next_board = parent_board.copy(stack=False)
            expected_san = parent_board.san(move)
            next_board.push(move)
            declared_before = str(raw_child.get("fenBefore") or parent_board.fen()).strip()
            declared_after = str(raw_child.get("fenAfter") or raw_child.get("fen") or next_board.fen()).strip()
            try:
                canonical_before = chess.Board(declared_before).fen()
                canonical_after = chess.Board(declared_after).fen()
            except ValueError:
                warnings.append(f"Node {child_id} contains an invalid FEN; node and descendants skipped.")
                continue
            if canonical_before != parent_board.fen() or canonical_after != next_board.fen():
                warnings.append(f"Node {child_id} FEN replay mismatch; node and descendants skipped.")
                continue
            child = dict(raw_child)
            child.update(
                {
                    "id": child_id,
                    "parentId": parent_id,
                    "fenBefore": parent_board.fen(),
                    "fenAfter": next_board.fen(),
                    "fen": next_board.fen(),
                    "move": {
                        "from": chess.square_name(move.from_square),
                        "to": chess.square_name(move.to_square),
                        "promotion": chess.piece_symbol(move.promotion) if move.promotion else "",
                    },
                    "san": str(raw_child.get("san") or expected_san),
                    "uci": move_uci,
                    "source": normalized_source(raw_child.get("source")),
                    "classification": str(raw_child.get("classification") or "Good"),
                    "eval": raw_child.get("eval") if isinstance(raw_child.get("eval"), dict) else {
                        "beforeCp": int(raw_child.get("evalBefore", 0) or 0),
                        "afterCp": int(raw_child.get("evalAfter", 0) or 0),
                        "lossCp": int(raw_child.get("userLossCp", 0) or 0),
                        "swingCp": int(raw_child.get("evalSwing", 0) or 0),
                    },
                    "explanation": raw_child.get("explanation") if isinstance(raw_child.get("explanation"), dict) else {
                        "summary": str(raw_child.get("theoryExplanation") or ""),
                        "why": str(raw_child.get("whyMoveGoodOrBad") or ""),
                        "threat": str(raw_child.get("threatSummary") or ""),
                        "response": str(raw_child.get("bestResponseSummary") or ""),
                        "plan": str(raw_child.get("followUpPlan") or raw_child.get("planForUser") or ""),
                    },
                    "children": [],
                }
            )
            validated[child_id] = child
            ordered.append(child)
            parent["children"].append(child_id)
            visit(child_id, next_board)
        visiting.remove(parent_id)

    visit(root_id, root_board)
    unreachable = sorted(set(node_map) - set(validated))
    if unreachable:
        warnings.append(f"Skipped {len(unreachable)} invalid or unreachable node(s).")
    migrated = dict(payload)
    migrated.update(
        {
            "schema_version": SMART_THEORY_SCHEMA_VERSION,
            "root_id": root_id,
            "start_fen": root_board.fen(),
            "effective_start_fen": root_board.fen(),
            "nodes_total": len(ordered),
            "nodes": ordered,
            "tree": validated,
            "warnings": [*list(payload.get("warnings") or []), *warnings][:120],
        }
    )
    return migrated, warnings


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

    branch_time_sec = None
    if time_sec is not None:
        branch_time_sec = min(4.0, max(1.5, float(time_sec or 0.0) * 2.0))
    analysis = engine.analyse(
        branch_board,
        depth=max(14, int(engine.settings.depth or 14)),
        multipv=1,
        time_sec=branch_time_sec,
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
                "detail": "Your imported move history makes this position more practical to study.",
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
    database_moves = [
        {
            "san": node.player_san.get(uci, uci),
            "uci": uci,
            "games": int(count),
            "popularity": round((count / node.occurrences) * 100, 1) if node.occurrences else 0.0,
            "source": "imported-games",
        }
        for uci, count in node.player_moves.most_common(8)
    ]
    insight["database_moves"] = database_moves
    insight["database_error"] = ""
    insight["database_source"] = "imported-games"
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
    repeat_mistake_count = top_played_count if top_played_uci != best_move_uci else 0
    best_repeat_ratio = (best_repeat_count / frequency) if frequency else 0.0
    repeat_mistake_ratio = (repeat_mistake_count / frequency) if frequency else 0.0
    confidence_frequency_component = min(35.0, float(frequency) * 2.2)
    confidence_execution_component = max(0.0, min(45.0, best_repeat_ratio * 45.0))
    confidence_mistake_penalty = max(0.0, min(25.0, repeat_mistake_ratio * 25.0))
    confidence_eval_penalty = max(0.0, min(20.0, float(value_lost_cp) / 10.0))
    confidence = round(
        max(
            0.0,
            min(
                100.0,
                18.0
                + confidence_frequency_component
                + confidence_execution_component
                - confidence_mistake_penalty
                - confidence_eval_penalty,
            ),
        ),
        1,
    )
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
        move_rank=int(root.get("rank", 0) or 0) or 1,
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
            move_rank=int(your_branch.get("rank", 0) or 0) or None,
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
        "confidence_breakdown": {
            "base": 18.0,
            "frequency_component": round(confidence_frequency_component, 1),
            "execution_component": round(confidence_execution_component, 1),
            "mistake_penalty": round(confidence_mistake_penalty, 1),
            "eval_penalty": round(confidence_eval_penalty, 1),
            "best_repeat_ratio": round(best_repeat_ratio, 3),
            "repeat_mistake_ratio": round(repeat_mistake_ratio, 3),
        },
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
        "database_error": "",
        "database_source": "imported-games",
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
                "detail": (
                    f"Average confidence {average_confidence:.1f} across {total} repeated positions "
                    "(confidence blends frequency, correct-repeat ratio, mistakes, and eval loss)"
                ),
                "tone": status,
            },
            {
                "label": "Due today",
                "value": len(queue_due),
                "detail": f"{len(queue_due)} of {total} positions ({due_share}%) need repeated-mistake review now",
                "tone": "urgent" if queue_due else "quiet",
            },
            {
                "label": "Known coverage",
                "value": f"{known_share:.0f}%",
                "detail": f"{len(known_lines)} known lines out of {total} tracked repeated positions",
                "tone": "strong" if known_share >= 35 else "quiet",
            },
            {
                "label": "Review load",
                "value": review_load,
                "detail": f"Suggested session size = due ({len(queue_due)}) + min(new, 8) ({min(len(queue_new), 8)})",
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
    preview_slot_count = max(1, min(worker_count, 8))
    live_position_lock = threading.Lock()
    live_position_previews: list[dict[str, Any] | None] = [None] * preview_slot_count
    live_position_active_slots: set[int] = set()
    last_position_preview_emit = 0.0

    def _node_preview(node: PositionNode, status: str) -> dict[str, Any]:
        return _analysis_progress_preview(
            node.position_fen,
            label=node.player_san.get(node.player_moves.most_common(1)[0][0], node.trigger_move) if node.player_moves else node.trigger_move,
            subtitle=f"{node.occurrences}x · {node.opening_name}",
            status=status,
            orientation=node.color,
        )

    def _lesson_preview(node: PositionNode, lesson: dict[str, Any], status: str = "Analyzed") -> dict[str, Any]:
        return _analysis_progress_preview(
            lesson.get("position_fen") or lesson.get("line_start_fen") or chess.STARTING_FEN,
            label=str(lesson.get("recommended_move") or lesson.get("best_reply") or lesson.get("line_label") or "Position"),
            subtitle=f"{lesson.get('frequency', node.occurrences)}x · {lesson.get('opening_name', node.opening_name)}",
            status=status,
            orientation=str(lesson.get("side") or node.color),
        )

    def _current_worker_slot() -> int:
        suffix = threading.current_thread().name.rsplit("_", 1)[-1]
        if suffix.isdigit():
            return int(suffix) % preview_slot_count
        return 0

    def _live_position_snapshot() -> list[dict[str, Any] | None]:
        with live_position_lock:
            return list(live_position_previews)

    def _live_position_active_count() -> int:
        with live_position_lock:
            return len(live_position_active_slots)

    def _live_position_active_slots() -> list[int]:
        with live_position_lock:
            return sorted(live_position_active_slots)

    def _publish_live_position(
        slot: int,
        preview: dict[str, Any] | None = None,
        *,
        active: bool = True,
        force: bool = False,
    ) -> bool:
        nonlocal last_position_preview_emit
        now = time.monotonic()
        with live_position_lock:
            if preview is not None:
                live_position_previews[slot] = preview
            if active:
                live_position_active_slots.add(slot)
            else:
                live_position_active_slots.discard(slot)
            should_emit = force or now - last_position_preview_emit >= 0.25
            if should_emit:
                last_position_preview_emit = now
        return should_emit

    for slot, node in enumerate(analyzed_nodes[:preview_slot_count]):
        live_position_previews[slot] = _node_preview(node, "Queued")

    def _build_lesson_for_live_worker(node: PositionNode) -> tuple[PositionNode, dict[str, Any] | None, int]:
        slot = _current_worker_slot()
        _publish_live_position(slot, _node_preview(node, "Analyzing"), active=True, force=True)
        return node, _build_lesson_from_node(node, engine, time_sec=quick_time_sec), slot

    def _notify_stockfish_positions(*, message: str, force: bool = False) -> None:
        notify(
            phase="stockfish_positions",
            progress=20 + int((positions_done / total_positions) * 48),
            positions_done=positions_done,
            positions_total=len(analyzed_nodes),
            live_positions=_live_position_snapshot(),
            scan_active_workers=_live_position_active_count(),
            scan_active_slots=_live_position_active_slots(),
            message=message,
        )

    notify(
        phase="stockfish_positions",
        progress=20 if analyzed_nodes else 68,
        positions_done=0,
        positions_total=len(analyzed_nodes),
        live_positions=_live_position_snapshot(),
        scan_active_workers=0,
        scan_active_slots=[],
        message=(
            f"Stockfish is analyzing {len(analyzed_nodes)} repeated positions with "
            f"{min(worker_count, max(1, len(analyzed_nodes)))} worker(s)..."
            if analyzed_nodes
            else "No repeated positions need Stockfish analysis yet. Building queues..."
        ),
    )
    if worker_count > 1 and len(analyzed_nodes) > 1:
        try:
            parallel_workers = min(worker_count, len(analyzed_nodes))
            with live_position_lock:
                live_position_active_slots.clear()
                live_position_active_slots.update(range(min(parallel_workers, preview_slot_count)))
            with ThreadPoolExecutor(max_workers=parallel_workers, thread_name_prefix="bookup-stockfish") as executor:
                futures = {executor.submit(_build_lesson_for_live_worker, node): node for node in analyzed_nodes}
                for future in as_completed(futures):
                    node, lesson, slot = future.result()
                    if lesson:
                        lessons.append(lesson)
                        _publish_live_position(slot, _lesson_preview(node, lesson), active=True, force=True)
                    else:
                        _publish_live_position(slot, _node_preview(node, "Skipped"), active=True, force=True)
                    positions_done += 1
                    _notify_stockfish_positions(message=f"Stockfish analyzed {positions_done}/{len(analyzed_nodes)} repeated positions...", force=True)
        except RuntimeError:
            with live_position_lock:
                live_position_active_slots.clear()
                live_position_active_slots.add(0)
            for node in analyzed_nodes:
                _publish_live_position(0, _node_preview(node, "Analyzing"), active=True, force=True)
                lesson = _build_lesson_from_node(node, engine, time_sec=quick_time_sec)
                if lesson:
                    lessons.append(lesson)
                    _publish_live_position(0, _lesson_preview(node, lesson), active=True, force=True)
                else:
                    _publish_live_position(0, _node_preview(node, "Skipped"), active=True, force=True)
                positions_done += 1
                _notify_stockfish_positions(message=f"Stockfish analyzed {positions_done}/{len(analyzed_nodes)} repeated positions...", force=True)
    else:
        with live_position_lock:
            live_position_active_slots.clear()
            if analyzed_nodes:
                live_position_active_slots.add(0)
        for node in analyzed_nodes:
            _publish_live_position(0, _node_preview(node, "Analyzing"), active=True, force=True)
            lesson = _build_lesson_from_node(node, engine, time_sec=quick_time_sec)
            if lesson:
                lessons.append(lesson)
                _publish_live_position(0, _lesson_preview(node, lesson), active=True, force=True)
            else:
                _publish_live_position(0, _node_preview(node, "Skipped"), active=True, force=True)
            positions_done += 1
            _notify_stockfish_positions(message=f"Stockfish analyzed {positions_done}/{len(analyzed_nodes)} repeated positions...", force=True)

    with live_position_lock:
        live_position_active_slots.clear()

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
    known_line_archive = sorted(known_lines, key=lambda item: (-item["repeat_count"], -item["frequency"]))[:24]

    white_first = _first_move_repertoire(games, "white")
    black_first = _first_move_repertoire(games, "black")
    game_move_tree = _build_game_move_tree(games)
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
    transposition_groups = _build_transposition_groups(lessons)
    elapsed_sec = max(0.001, time.perf_counter() - analysis_started)
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
        "health_dashboard": health_dashboard,
        "transposition_groups": transposition_groups,
        "stockfish_stats": stockfish_stats,
        "known_lines": known_lines,
        "needs_work": queue_due,
        "trainer_queue_due": queue_due,
        "trainer_queue_new": queue_new,
        "trainer_queue": queue_due,
        "known_line_archive": known_line_archive,
        "known_archive": known_line_archive,
        "previewable_lines": lessons[:200],
    }
