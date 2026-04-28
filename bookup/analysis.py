from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
import math
from statistics import mean
from typing import Any
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
    classify_move_record,
    expected_points_from_evaluation,
)
from .engine import EngineSession
from .opening_names import lookup_by_board, lookup_by_eco


OPENING_LIBRARY: ChessOpeningsLibrary | None = None
ONLINE_OPENING_CACHE: dict[str, dict[str, str]] = {}
EXPLORER_CACHE: dict[str, dict[str, Any]] = {}
POSITION_INSIGHT_CACHE: dict[str, dict[str, Any]] = {}
EXPLORER_AVAILABLE = True
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

    def __post_init__(self) -> None:
        if self.player_moves is None:
            self.player_moves = Counter()
        if self.player_san is None:
            self.player_san = {}


def configure_lichess(token: str = "") -> None:
    global EXPLORER_AVAILABLE
    normalized = token.strip()
    EXPLORER_HEADERS.clear()
    EXPLORER_HEADERS["User-Agent"] = "Bookup/1.0 (local repertoire trainer)"
    EXPLORER_AVAILABLE = True
    if normalized:
        EXPLORER_HEADERS["Authorization"] = f"Bearer {normalized}"
    EXPLORER_CACHE.clear()
    ONLINE_OPENING_CACHE.clear()


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


def _classify_result(result: str) -> str:
    lowered = (result or "").lower()
    if lowered == "win":
        return "win"
    if lowered in {"agreed", "stalemate", "repetition", "timevsinsufficient", "insufficient", "50move"}:
        return "draw"
    return "loss"


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
    cache_key = f"{board.epd()}|{play_key}"
    if cache_key in EXPLORER_CACHE:
        return EXPLORER_CACHE[cache_key]
    if not EXPLORER_AVAILABLE:
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
    except Exception:
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


def identify_opening(imported: ImportedGame) -> dict[str, str]:
    header_opening = str(imported.game.headers.get("Opening", "") or "")
    header_variation = str(imported.game.headers.get("Variation", "") or "")
    header_name = _compose_opening_name(header_opening, header_variation)
    eco = (imported.game.headers.get("ECO") or "").strip().upper()
    play_key, board, play, san_moves = _opening_lookup_payload(imported)
    cache_key = f"{play_key}|{board.epd()}|{header_name}|{eco}"
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


def _collect_position_nodes(games: list[ImportedGame]) -> tuple[dict[str, PositionNode], dict[str, Counter[str]], dict[str, dict[str, Any]]]:
    nodes: dict[str, PositionNode] = {}
    position_counts: dict[str, Counter[str]] = defaultdict(Counter)
    opening_by_position: dict[str, dict[str, Any]] = {}

    for imported in games:
        user_side = chess.WHITE if imported.player_color == "white" else chess.BLACK
        opening_info = identify_opening(imported)
        board = imported.game.board()
        play_uci: list[str] = []
        last_san = "Start position"

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
                node.player_moves[move.uci()] += 1
                node.player_san[move.uci()] = san
                position_counts[key][san] += 1
            last_san = board.san(move)
            play_uci.append(move.uci())
            board.push(move)

    return nodes, position_counts, opening_by_position


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


def _candidate_lines_for_board(
    board: chess.Board,
    engine: EngineSession,
    *,
    play_uci: list[str] | None = None,
    limit: int = 5,
    time_sec: float | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    play_uci = play_uci or []
    time_key = "none" if time_sec is None else f"{float(time_sec):.2f}"
    cache_key = f"{board.epd()}|{','.join(play_uci)}|d{engine.settings.depth}|mpv{engine.settings.multipv}|t{time_key}|{limit}"
    if cache_key in POSITION_INSIGHT_CACHE:
        cached = POSITION_INSIGHT_CACHE[cache_key]
        return list(cached.get("candidate_lines", [])), list(cached.get("database_moves", []))

    root_lines = engine.analyse(
        board,
        multipv=max(limit, engine.settings.multipv),
        time_sec=time_sec,
    )
    database_moves = _database_moves(board, play_uci, limit=limit + 1)
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
    candidate_lines = annotate_candidate_classifications(
        board,
        candidate_lines,
        opening_phase=len(play_uci) < OPENING_PLIES,
        popularity_by_uci=popularity_by_uci,
    )

    POSITION_INSIGHT_CACHE[cache_key] = {
        "candidate_lines": list(candidate_lines),
        "database_moves": list(database_moves),
    }
    return candidate_lines, database_moves


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
    candidate_lines, database_moves = _candidate_lines_for_board(
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
            "recommended_move": "",
            "recommended_move_uci": "",
            "recommended_classification": None,
            "your_move_classification": None,
            "coach_explanation": "No engine line is available for this position yet.",
            "position_identifier": _analysis_url_for_fen(board.fen()),
        }
    your_move_classification = None
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
                opening_phase=len(play_uci or []) < OPENING_PLIES,
                in_book=_resulting_position_is_book(board, your_move_uci),
            )
    return {
        "candidate_lines": candidate_lines,
        "threat_lines": _threat_lines_for_board(board, candidate_lines),
        "database_moves": database_moves,
        "recommended_move": best_line["move"],
        "recommended_move_uci": best_line["uci"],
        "recommended_classification": best_line.get("classification"),
        "your_move_classification": your_move_classification,
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
    return {
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


def _build_lesson_from_node(node: PositionNode, engine: EngineSession) -> dict[str, Any]:
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
        )
        if repertoire_branch:
            branch_by_uci[top_played_uci] = repertoire_branch
            branch_lines.append(repertoire_branch)

    preferred_branch = branch_by_uci.get(best_move_uci)
    if not preferred_branch:
        return {}
    second_loss = candidate_lines[1]["expected_points_loss"] if len(candidate_lines) > 1 else 0.0
    recommended_classification = root.get("classification") or classify_move_record(
        board,
        root,
        root,
        second_record=candidate_lines[1] if len(candidate_lines) > 1 else None,
        second_loss=second_loss,
        opening_phase=node.ply_index < OPENING_PLIES,
        in_book=_resulting_position_is_book(board, best_move_uci),
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
            opening_phase=node.ply_index < OPENING_PLIES,
            in_book=_resulting_position_is_book(board, top_played_uci),
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
        "frequency": frequency,
        "importance": importance,
        "confidence": confidence,
        "priority": priority,
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


def analyse_games(games: list[ImportedGame], engine: EngineSession) -> dict[str, Any]:
    nodes, _position_counts, _opening_info = _collect_position_nodes(games)
    lessons = []
    for node in nodes.values():
        lesson = _build_lesson_from_node(node, engine)
        if lesson:
            lessons.append(lesson)

    lessons.sort(key=lambda item: (-item["priority"], -item["frequency"], item["line_label"]))
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
    total_results = Counter(_classify_result(game.result) for game in games)
    win_rate = round(((total_results["win"] + 0.5 * total_results["draw"]) / len(games)) * 100, 1) if games else 0.0
    prep_summary = (
        f"Bookup found {len(lessons)} repeated repertoire positions, {len(queue_due)} due lines that need work, and {len(known_lines)} known lines already under control. "
        "Import your games, train the branches you actually reach, and let the database plus Stockfish guide the replies."
    )

    return {
        "games_analyzed": len(games),
        "summary": {
            "win_rate": win_rate,
            "positions": len(lessons),
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
