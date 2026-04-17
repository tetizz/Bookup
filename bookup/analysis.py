from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from typing import Any

import chess

from .chesscom import ImportedGame
from .engine import EngineSession


@dataclass(slots=True)
class OpeningAdvice:
    opening: str
    color: str
    opponent_reply: str
    recommendation: str
    explanation: str
    example_line: str
    position_fen: str


def _score_cp(score: chess.engine.PovScore, turn: chess.Color) -> int:
    pov = score.pov(turn)
    if pov.is_mate():
        mate = pov.mate()
        if mate is None:
            return 0
        return 100000 - abs(mate) if mate > 0 else -100000 + abs(mate)
    return int(pov.score(mate_score=100000) or 0)


def _classify_result(result: str) -> str:
    lowered = result.lower()
    if lowered == "win":
        return "win"
    if lowered in {"agreed", "stalemate", "repetition", "timevsinsufficient", "insufficient", "50move"}:
        return "draw"
    return "loss"


def _phase_name(ply_index: int) -> str:
    if ply_index < 16:
        return "opening"
    if ply_index < 50:
        return "middlegame"
    return "endgame"


def _phase_headline(phase: str) -> str:
    if phase == "opening":
        return "You leak the most value in the opening."
    if phase == "middlegame":
        return "Most of your value loss happens once the position gets tactical."
    return "Your endgames are where the engine still sees clean points to save."


def _why_note(phase: str, played: str, best: str, loss: int) -> str:
    return f"The engine liked {best} more than {played} by about {round(loss / 100, 2)} pawns in the {phase}. That usually means your move gave up initiative, structure, or a tactical resource too soon."


def opening_name(game: ImportedGame) -> str:
    header_name = game.game.headers.get("Opening") or game.game.headers.get("ECO") or ""
    if header_name and header_name != "Unknown":
        return header_name

    board = game.game.board()
    line: list[str] = []
    for index, move in enumerate(game.game.mainline_moves()):
        if index >= 6:
            break
        line.append(board.san(move))
        board.push(move)
    return "Line: " + " ".join(line) if line else "Unknown Opening"


def _style_summary(castle_rate: float, queen_rate: float, capture_rate: float, checks_per_game: float) -> str:
    notes: list[str] = []
    if castle_rate >= 0.7:
        notes.append("You usually get your king safe quickly.")
    elif castle_rate <= 0.35:
        notes.append("You delay castling a lot, which gives you dynamic chances but also extra risk.")
    if queen_rate >= 0.45:
        notes.append("You bring the queen out early pretty often.")
    if capture_rate >= 0.24:
        notes.append("Your games turn tactical fast and you seem comfortable forcing contact.")
    else:
        notes.append("You usually keep tension longer before trading pieces.")
    if checks_per_game >= 2.0:
        notes.append("You look for direct pressure on the king.")
    return " ".join(notes)


def build_opening_advice(imported: ImportedGame, color: str, opening: str, reply_san: str, reply_count: int, engine: EngineSession) -> OpeningAdvice | None:
    board = imported.game.board()
    player_turn = chess.WHITE if color == "white" else chess.BLACK
    player_has_moved = False
    target_position: chess.Board | None = None

    for move in imported.game.mainline_moves():
        san = board.san(move)
        mover = board.turn
        board.push(move)
        if mover == player_turn:
            player_has_moved = True
        elif player_has_moved and san == reply_san:
            target_position = board.copy(stack=False)
            break

    if target_position is None:
        return None

    info = engine.analyse(target_position, multipv=1)[0]
    pv = info.get("pv") or []
    if not pv:
        return None

    best_move = pv[0]
    preview = target_position.copy(stack=False)
    best_san = preview.san(best_move)
    preview.push(best_move)

    line_moves = [best_san]
    follow_info = engine.analyse(preview, multipv=1)[0]
    follow_pv = follow_info.get("pv") or []
    temp = preview.copy(stack=False)
    for move in follow_pv[:4]:
        if move not in temp.legal_moves:
            break
        line_moves.append(temp.san(move))
        temp.push(move)

    explanation = (
        f"In your {opening} games as {color}, opponents often answer with {reply_san}. "
        f"Stockfish prefers {best_san} here because it keeps your position healthier and gives you the cleanest continuation."
    )
    return OpeningAdvice(
        opening=opening,
        color=color,
        opponent_reply=f"{reply_san} ({reply_count} games)",
        recommendation=best_san,
        explanation=explanation,
        example_line=" ".join(line_moves),
        position_fen=target_position.fen(),
    )


def analyse_games(games: list[ImportedGame], engine: EngineSession) -> dict[str, Any]:
    color_openings: Counter[tuple[str, str]] = Counter()
    opening_responses: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    outcome_counter: Counter[str] = Counter()
    mistake_counter: Counter[str] = Counter()
    mistake_examples: dict[str, list[dict[str, Any]]] = defaultdict(list)
    advice: list[OpeningAdvice] = []

    total_games = len(games)
    total_castles = 0
    early_queen_games = 0
    total_player_moves = 0
    total_captures = 0
    total_checks = 0

    for imported in games:
        game = imported.game
        board = game.board()
        opening = opening_name(imported)
        color = imported.player_color
        color_openings[(color, opening)] += 1
        outcome_counter[_classify_result(imported.result)] += 1

        first_reply = None
        player_move_index = 0
        player_seen_queen = False
        player_castled = False
        line_prefix: list[str] = []

        for move in game.mainline_moves():
            mover = board.turn
            san = board.san(move)
            line_prefix.append(san)
            if mover == (chess.WHITE if color == "white" else chess.BLACK):
                before_move = board.copy(stack=False)
                total_player_moves += 1
                if board.is_capture(move):
                    total_captures += 1
                if board.gives_check(move):
                    total_checks += 1
                if san in {"O-O", "O-O-O"}:
                    player_castled = True
                piece = board.piece_at(move.from_square)
                if piece and piece.piece_type == chess.QUEEN and player_move_index < 6:
                    player_seen_queen = True

                info = engine.analyse(board, multipv=1)[0]
                pv = info.get("pv") or []
                best_move = pv[0] if pv else None
                score_before = _score_cp(info["score"], mover)
                board.push(move)
                if best_move:
                    next_info = engine.analyse(board, multipv=1)[0]
                    score_after = _score_cp(next_info["score"], mover)
                    loss = score_before - score_after
                    if move != best_move and loss >= 80:
                        phase = _phase_name(len(board.move_stack))
                        mistake_counter[phase] += 1
                        if len(mistake_examples[phase]) < 4:
                            best_san = before_move.san(best_move)
                            mistake_examples[phase].append(
                                {
                                    "played": san,
                                    "best": best_san,
                                    "loss_cp": loss,
                                    "line": " ".join(line_prefix[-10:]),
                                    "why": _why_note(phase, san, best_san, loss),
                                    "position_fen": before_move.fen(),
                                }
                            )
                player_move_index += 1
            else:
                if first_reply is None:
                    first_reply = san
                board.push(move)

        if player_castled:
            total_castles += 1
        if player_seen_queen:
            early_queen_games += 1
        if first_reply:
            opening_responses[(color, opening)][first_reply] += 1

    for (color, opening), _count in color_openings.most_common(3):
        common_reply = opening_responses[(color, opening)].most_common(1)
        if not common_reply:
            continue
        reply, reply_count = common_reply[0]
        sample = next(
            (
                item
                for item in games
                if item.player_color == color
                and opening_name(item) == opening
            ),
            None,
        )
        if sample is None:
            continue
        advice_item = build_opening_advice(sample, color, opening, reply, reply_count, engine)
        if advice_item:
            advice.append(advice_item)

    castle_rate = total_castles / total_games if total_games else 0
    queen_rate = early_queen_games / total_games if total_games else 0
    capture_rate = total_captures / total_player_moves if total_player_moves else 0
    checks_per_game = total_checks / total_games if total_games else 0

    improvements = []
    for phase, count in mistake_counter.most_common():
        example = mistake_examples[phase][0] if mistake_examples[phase] else None
        improvements.append(
            {
                "phase": phase,
                "count": count,
                "headline": _phase_headline(phase),
                "detail": example["why"] if example else "",
                "example": example,
            }
        )

    return {
        "games_analyzed": total_games,
        "outcomes": dict(outcome_counter),
        "style_summary": _style_summary(castle_rate, queen_rate, capture_rate, checks_per_game),
        "style_metrics": {
            "castle_rate": round(castle_rate * 100, 1),
            "early_queen_rate": round(queen_rate * 100, 1),
            "capture_rate": round(capture_rate * 100, 1),
            "checks_per_game": round(checks_per_game, 2),
        },
        "top_openings": [
            {"color": color, "opening": opening, "count": count}
            for (color, opening), count in color_openings.most_common(8)
        ],
        "improvements": improvements,
        "opening_advice": [asdict(entry) for entry in advice],
    }
