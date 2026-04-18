from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
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
from .engine import EngineSession


OPENING_LIBRARY: ChessOpeningsLibrary | None = None
ONLINE_OPENING_CACHE: dict[str, dict[str, str]] = {}
EXPLORER_CACHE: dict[str, dict[str, Any]] = {}
EXPLORER_AVAILABLE = True
LICHESS_EXPLORER_URL = "https://explorer.lichess.ovh/lichess"
EXPLORER_HEADERS = {
    "User-Agent": "Bookup/1.0 (local repertoire trainer)",
}
KNOWN_LINE_THRESHOLD = 100
OPENING_PLIES = 16
PV_LENGTH = 8


@dataclass(slots=True)
class PositionNode:
    key: str
    color: str
    opening_name: str
    opening_code: str
    position_fen: str
    play_uci: list[str]
    trigger_move: str
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
    if normalized:
        EXPLORER_HEADERS["Authorization"] = f"Bearer {normalized}"
        EXPLORER_AVAILABLE = True
    EXPLORER_CACHE.clear()
    ONLINE_OPENING_CACHE.clear()


def _analysis_url_for_fen(fen: str) -> str:
    return f"https://lichess.org/analysis/standard/{quote(fen.replace(' ', '_'), safe='/_-')}"


def _score_cp(score: chess.engine.PovScore, turn: chess.Color) -> int:
    pov = score.pov(turn)
    if pov.is_mate():
        mate = pov.mate()
        if mate is None:
            return 0
        return 100000 - abs(mate) if mate > 0 else -100000 + abs(mate)
    return int(pov.score(mate_score=100000) or 0)


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
    library = ChessOpeningsLibrary()
    library.load_builtin_openings()
    OPENING_LIBRARY = library
    return OPENING_LIBRARY


def _explorer_lookup(board: chess.Board, play_key: str) -> dict[str, Any]:
    global EXPLORER_AVAILABLE
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
        EXPLORER_AVAILABLE = False
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


def identify_opening(imported: ImportedGame) -> dict[str, str]:
    header_name = (imported.game.headers.get("Opening") or "").strip()
    eco = (imported.game.headers.get("ECO") or "").strip().upper()
    play_key, board, play, san_moves = _opening_lookup_payload(imported)
    cache_key = f"{play_key}|{board.epd()}|{header_name}|{eco}"
    if cache_key in ONLINE_OPENING_CACHE:
        return dict(ONLINE_OPENING_CACHE[cache_key])

    result = {
        "name": header_name if header_name and header_name != "Unknown" else "",
        "code": eco,
        "position_identifier": _analysis_url_for_fen(board.fen()),
        "position_identifier_label": "Lichess analysis",
    }

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
    if opening.get("name") and not result["name"]:
        result["name"] = str(opening["name"])
    if opening.get("eco") and not result["code"]:
        result["code"] = str(opening["eco"]).upper()

    if not result["name"]:
        if result["code"]:
            result["name"] = result["code"]
        else:
            preview_board = imported.game.board()
            preview: list[str] = []
            for move in imported.game.mainline_moves():
                if len(preview) >= 6:
                    break
                preview.append(preview_board.san(move))
                preview_board.push(move)
            result["name"] = " ".join(preview) if preview else "Unknown Opening"

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


def _common_replies(board: chess.Board, play_uci: list[str], best_reply_uci: str) -> list[dict[str, Any]]:
    try:
        best_move = chess.Move.from_uci(best_reply_uci)
    except ValueError:
        return []
    if best_move not in board.legal_moves:
        return []
    board_after = board.copy(stack=False)
    board_after.push(best_move)
    explorer = _explorer_lookup(board_after, ",".join([*play_uci, best_reply_uci]))
    moves = explorer.get("moves") or []
    total = float(explorer.get("white", 0) or 0) + float(explorer.get("black", 0) or 0) + float(explorer.get("draws", 0) or 0)
    items = []
    for item in moves[:4]:
        count = float(item.get("white", 0) or 0) + float(item.get("black", 0) or 0) + float(item.get("draws", 0) or 0)
        items.append(
            {
                "san": item.get("san") or item.get("uci") or "",
                "games": int(count),
                "popularity": round((count / total) * 100, 1) if total and count else 0.0,
            }
        )
    return items


def _build_lesson_from_node(node: PositionNode, engine: EngineSession) -> dict[str, Any]:
    board = chess.Board(node.position_fen)
    root = engine.analyse(board, multipv=1)[0]
    pv = root.get("pv") or []
    if not pv:
        return {}
    best_move = pv[0]
    best_reply = board.san(best_move)
    continuation_san, continuation_uci = _pv_sans(board, pv)
    top_played_uci, top_played_count = node.player_moves.most_common(1)[0]
    top_played = node.player_san[top_played_uci]
    best_repeat_count = node.player_moves.get(best_move.uci(), 0)
    is_known = best_repeat_count >= KNOWN_LINE_THRESHOLD
    line_status = "known" if is_known else ("new" if top_played == best_reply else "needs_work")

    value_lost_cp = 0
    if top_played_uci != best_move.uci():
        played_board = board.copy(stack=False)
        played_move = chess.Move.from_uci(top_played_uci)
        if played_move in played_board.legal_moves:
            played_board.push(played_move)
            played_info = engine.analyse(played_board, multipv=1)[0]
            value_lost_cp = max(0, _score_cp(root["score"], board.turn) - _score_cp(played_info["score"], board.turn))

    common_replies = _common_replies(board, node.play_uci, best_move.uci())
    frequency = node.occurrences
    importance = round(min(100.0, (frequency * 8) + max((common_replies[0]["popularity"] if common_replies else 0.0), 0.0) * 1.5), 1)
    confidence = round(min(100.0, 35 + (frequency * 4)), 1)
    priority = round((frequency * 10) + min(value_lost_cp / 10, 60) + (25 if line_status == "needs_work" else 0) - (40 if is_known else 0), 1)
    explanation = (
        f"After {node.trigger_move}, Stockfish wants {best_reply} because it keeps the cleanest continuation."
        if top_played == best_reply
        else f"After {node.trigger_move}, {best_reply} is stronger than your usual {top_played} and saves about {round(value_lost_cp / 100, 2)} pawns."
    )

    return {
        "lesson_id": f"{node.color}:{quote(node.key, safe='')[:48]}:{best_move.uci()}",
        "position_fen": node.position_fen,
        "position_identifier": _analysis_url_for_fen(node.position_fen),
        "position_identifier_label": "Lichess analysis",
        "opening_name": node.opening_name,
        "opening_code": node.opening_code,
        "color": node.color,
        "trigger_move": node.trigger_move,
        "best_reply": best_reply,
        "best_reply_uci": best_move.uci(),
        "continuation_san": " ".join(continuation_san),
        "continuation_moves_uci": continuation_uci,
        "line_status": line_status,
        "repeat_count": best_repeat_count,
        "frequency": frequency,
        "importance": importance,
        "confidence": confidence,
        "priority": priority,
        "your_top_move": top_played,
        "your_top_move_uci": top_played_uci,
        "your_top_move_count": top_played_count,
        "value_lost_cp": value_lost_cp,
        "common_replies": common_replies,
        "player_move_frequency": [
            {
                "san": node.player_san[uci],
                "uci": uci,
                "count": count,
                "pct": round((count / node.occurrences) * 100, 1) if node.occurrences else 0.0,
            }
            for uci, count in node.player_moves.most_common(4)
        ],
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
                "title": f"Add {lesson['best_reply']} in {lesson['opening_name']}",
                "detail": f"After {lesson['trigger_move']}, make {lesson['best_reply']} your default continuation.",
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
                "title": f"Keep {lesson['opening_name']} sharp",
                "detail": f"You already know {lesson['best_reply']} after {lesson['trigger_move']}. Keep it in your maintenance queue.",
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

    lessons.sort(key=lambda item: (-item["priority"], -item["frequency"], item["opening_name"]))
    repertoire_tree = _group_repertoire(lessons)
    top_openings_by_color = _opening_lists(repertoire_tree)
    known_lines = [item for item in lessons if item["line_status"] == "known"]
    non_known = [item for item in lessons if item["line_status"] != "known"]
    urgent_lines = [item for item in non_known if item["frequency"] >= 2 or item["value_lost_cp"] >= 60]
    urgent_lines = sorted(urgent_lines, key=lambda item: (-item["priority"], -item["frequency"]))[:16]
    sidelines = [
        item
        for item in non_known
        if item not in urgent_lines and (
            any(0 < reply.get("popularity", 0) <= 10 for reply in item.get("common_replies", []))
            or item["frequency"] == 1
        )
    ][:16]
    opening_mistakes = [
        {
            "lesson_id": item["lesson_id"],
            "opening_name": item["opening_name"],
            "opening_code": item["opening_code"],
            "trigger_move": item["trigger_move"],
            "played": item["your_top_move"],
            "best_move": item["best_reply"],
            "value_lost_cp": item["value_lost_cp"],
            "position_fen": item["position_fen"],
            "position_identifier": item["position_identifier"],
            "position_identifier_label": item["position_identifier_label"],
            "explanation": item["explanation"],
            "continuation_san": item["continuation_san"],
        }
        for item in sorted(non_known, key=lambda row: (-row["value_lost_cp"], -row["frequency"]))[:20]
        if item["your_top_move"] != item["best_reply"]
    ]
    trainer_queue = sorted(non_known, key=lambda item: (-item["priority"], -item["frequency"]))[:48]
    repertoire_updates = _build_repertoire_updates(urgent_lines, known_lines)

    white_first = _first_move_repertoire(games, "white")
    black_first = _first_move_repertoire(games, "black")
    total_results = Counter(_classify_result(game.result) for game in games)
    win_rate = round(((total_results["win"] + 0.5 * total_results["draw"]) / len(games)) * 100, 1) if games else 0.0
    prep_summary = (
        f"Bookup found {len(repertoire_tree)} opening families and {len(trainer_queue)} trainable positions. "
        "Import your games, learn the lines you actually reach, and drill the replies you still miss."
    )

    return {
        "games_analyzed": len(games),
        "summary": {
            "win_rate": win_rate,
            "families": len(repertoire_tree),
            "trainable_positions": len(trainer_queue),
            "known_lines": len(known_lines),
            "urgent_lines": len(urgent_lines),
            "prep_summary": prep_summary,
        },
        "first_move_repertoire": {
            "white": white_first,
            "black": black_first,
        },
        "top_openings_by_color": top_openings_by_color,
        "repertoire_tree": repertoire_tree,
        "known_lines": known_lines,
        "urgent_lines": urgent_lines,
        "sidelines": sidelines,
        "repertoire_updates": repertoire_updates,
        "opening_mistakes": opening_mistakes,
        "trainer_queue": trainer_queue,
    }
