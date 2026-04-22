from __future__ import annotations

import math
from typing import Any

import chess


MOVE_CLASSIFICATION_LABELS = {
    "best": "Best",
    "excellent": "Excellent",
    "good": "Good",
    "inaccuracy": "Inaccuracy",
    "mistake": "Mistake",
    "blunder": "Blunder",
    "great": "Great",
    "brilliant": "Brilliant",
    "miss": "Miss",
    "book": "Book",
}

EXPECTED_POINTS_BANDS = (
    ("excellent", 0.02),
    ("good", 0.05),
    ("inaccuracy", 0.10),
    ("mistake", 0.20),
    ("blunder", 1.00),
)

BOOK_POPULARITY_THRESHOLD = 3.0
BOOK_REPEAT_THRESHOLD = 2
BOOK_ALLOWED_BASE_KEYS = {"best", "excellent", "good"}
GREAT_KEEP_ADVANTAGE_THRESHOLD = 0.53
GREAT_KEEP_ADVANTAGE_CP = 20
BRILLIANT_MATERIAL_DROP = 200
BRILLIANT_SOUND_THRESHOLD = 0.45
BRILLIANT_ALREADY_WINNING_THRESHOLD = 0.92
PIECE_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 320,
    chess.BISHOP: 330,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 0,
}


def classification_icon(key: str) -> str:
    if key == "book":
        return "/static/move-classifications/book.svg"
    return f"/static/move-classifications/{key}.png"


def classification_payload(
    key: str,
    *,
    loss: float,
    reason: str,
    expected_points: float,
    is_only_move_that_keeps_advantage: bool = False,
    is_real_piece_sacrifice: bool = False,
) -> dict[str, Any]:
    return {
        "key": key,
        "label": MOVE_CLASSIFICATION_LABELS[key],
        "icon": classification_icon(key),
        "expected_points_loss": round(float(loss), 4),
        "expected_points": round(float(expected_points), 4),
        "reason": reason,
        "is_only_move_that_keeps_advantage": bool(is_only_move_that_keeps_advantage),
        "is_real_piece_sacrifice": bool(is_real_piece_sacrifice),
    }


def book_classification_payload(expected_points: float, *, reason: str = "repertoire/database move") -> dict[str, Any]:
    return classification_payload("book", loss=0.0, reason=reason, expected_points=expected_points)


def maybe_book_classification(
    existing: dict[str, Any] | None,
    *,
    opening_phase: bool,
    repeated_count: int = 0,
    popularity: float = 0.0,
    line_status: str = "",
) -> dict[str, Any] | None:
    if not existing:
        return existing
    if not opening_phase or line_status == "needs_work":
        return existing
    key = str(existing.get("key", "") or "").strip().lower()
    if key not in BOOK_ALLOWED_BASE_KEYS:
        return existing
    if repeated_count < BOOK_REPEAT_THRESHOLD and float(popularity or 0.0) < BOOK_POPULARITY_THRESHOLD:
        return existing
    return book_classification_payload(
        float(existing.get("expected_points", 0.0)),
        reason="conventional opening move",
    )


def keeps_advantage(expected_points: float, score_cp: int = 0) -> bool:
    return float(expected_points) >= GREAT_KEEP_ADVANTAGE_THRESHOLD or int(score_cp) >= GREAT_KEEP_ADVANTAGE_CP


def _material_balance(board: chess.Board, turn: chess.Color) -> int:
    score = 0
    for piece in board.piece_map().values():
        value = PIECE_VALUES[piece.piece_type]
        score += value if piece.color == turn else -value
    return score


def move_material_drop(board: chess.Board, move: chess.Move) -> int:
    before = _material_balance(board, board.turn)
    after_board = board.copy(stack=False)
    after_board.push(move)
    after = _material_balance(after_board, board.turn)
    return before - after


def is_real_piece_sacrifice(board: chess.Board, move: chess.Move) -> bool:
    moved_piece = board.piece_at(move.from_square)
    if moved_piece is None or moved_piece.piece_type == chess.PAWN:
        return False

    captured_piece = board.piece_at(move.to_square)
    captured_value = PIECE_VALUES[captured_piece.piece_type] if captured_piece else 0
    investment = PIECE_VALUES[moved_piece.piece_type] - captured_value
    if investment < BRILLIANT_MATERIAL_DROP:
        return False

    after_board = board.copy(stack=False)
    after_board.push(move)
    enemy_attackers = list(after_board.attackers(not moved_piece.color, move.to_square))
    if not enemy_attackers:
        return False

    enemy_min_value = min(
        PIECE_VALUES[(after_board.piece_at(square) or moved_piece).piece_type]
        for square in enemy_attackers
        if after_board.piece_at(square) is not None
    )
    friendly_defenders = list(after_board.attackers(moved_piece.color, move.to_square))
    friendly_min_value = min(
        PIECE_VALUES[(after_board.piece_at(square) or moved_piece).piece_type]
        for square in friendly_defenders
        if after_board.piece_at(square) is not None
    ) if friendly_defenders else 10_000

    return enemy_min_value <= PIECE_VALUES[moved_piece.piece_type] and enemy_min_value <= friendly_min_value


def base_classification_key(loss: float, *, is_best_move: bool) -> str:
    if is_best_move or loss <= 0.0005:
        return "best"
    for key, limit in EXPECTED_POINTS_BANDS:
        if loss <= limit:
            return key
    return "blunder"


def base_classification_reason(key: str, *, best_move_san: str, move_san: str) -> str:
    if key == "best":
        return "engine top move"
    if key == "excellent":
        return "very close to best"
    if key == "good":
        return "solid but slightly below best"
    if key == "inaccuracy":
        return "small drop"
    if key == "mistake":
        return "meaningful drop"
    if key == "blunder":
        return "large drop"
    if key == "great":
        return "only move that keeps the advantage"
    if key == "brilliant":
        return "best move plus a sound piece sacrifice"
    if key == "miss":
        return "fails to convert the stronger continuation"
    if key == "book":
        return "repertoire/database move"
    return f"{move_san} trails the best move {best_move_san}."


def classify_move_record(
    board: chess.Board,
    move_record: dict[str, Any],
    best_record: dict[str, Any],
    *,
    second_loss: float = 0.0,
    great_keeps_advantage_count: int = 0,
    is_player_move: bool = False,
) -> dict[str, Any]:
    best_move_san = best_record.get("move", "")
    move_san = move_record.get("move", "")
    move_uci = move_record.get("uci", "")
    best_expected = float(best_record.get("expected_points", 0.0))
    move_expected = float(move_record.get("expected_points", 0.0))
    loss = max(0.0, best_expected - move_expected)
    is_best_move = move_uci == best_record.get("uci") or loss <= 0.0005
    key = base_classification_key(loss, is_best_move=is_best_move)
    reason = base_classification_reason(key, best_move_san=best_move_san, move_san=move_san)
    only_move_keeps_advantage = False
    real_piece_sacrifice = False

    if is_best_move:
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            move = None
        if move is not None:
            real_piece_sacrifice = is_real_piece_sacrifice(board, move)
            already_winning = best_expected >= BRILLIANT_ALREADY_WINNING_THRESHOLD
            sound_enough = best_expected >= BRILLIANT_SOUND_THRESHOLD
            if real_piece_sacrifice and sound_enough and not already_winning:
                key = "brilliant"
                reason = "best move plus a sound piece sacrifice"
            else:
                only_move_keeps_advantage = (
                    great_keeps_advantage_count == 1
                    and keeps_advantage(best_expected, int(best_record.get("score_cp", 0)))
                    and second_loss >= 0.08
                )
                if only_move_keeps_advantage:
                    key = "great"
                    reason = "only move that keeps the advantage"
    elif is_player_move and best_expected >= 0.75 and 0.05 <= loss <= 0.20:
        key = "miss"
        reason = "fails to convert the stronger continuation"

    return classification_payload(
        key,
        loss=loss,
        reason=reason,
        expected_points=move_expected,
        is_only_move_that_keeps_advantage=only_move_keeps_advantage,
        is_real_piece_sacrifice=real_piece_sacrifice,
    )


def annotate_candidate_classifications(
    board: chess.Board,
    candidate_lines: list[dict[str, Any]],
    *,
    opening_phase: bool = False,
    repeated_counts: dict[str, int] | None = None,
    popularity_by_uci: dict[str, float] | None = None,
    line_status: str = "",
) -> list[dict[str, Any]]:
    if not candidate_lines:
        return candidate_lines
    repeated_counts = repeated_counts or {}
    popularity_by_uci = popularity_by_uci or {}
    best_record = candidate_lines[0]
    best_expected = float(best_record.get("expected_points", 0.0))
    second_loss = 0.0
    if len(candidate_lines) > 1:
        second_loss = max(0.0, best_expected - float(candidate_lines[1].get("expected_points", 0.0)))
    great_keeps_advantage_count = sum(
        1
        for line in candidate_lines
        if keeps_advantage(
            float(line.get("expected_points", 0.0)),
            int(line.get("score_cp", 0)),
        )
    )
    for line in candidate_lines:
        line["expected_points_loss"] = round(max(0.0, best_expected - float(line.get("expected_points", 0.0))), 4)
    for line in candidate_lines:
        line["classification"] = classify_move_record(
            board,
            line,
            best_record,
            second_loss=second_loss,
            great_keeps_advantage_count=great_keeps_advantage_count,
        )
        line["classification"] = maybe_book_classification(
            line["classification"],
            opening_phase=opening_phase,
            repeated_count=int(repeated_counts.get(str(line.get("uci", "")), 0) or 0),
            popularity=float(popularity_by_uci.get(str(line.get("uci", "")), 0.0) or 0.0),
            line_status=line_status,
        )
        line["classification_label"] = line["classification"]["label"]
        line["classification_icon"] = line["classification"]["icon"]
    return candidate_lines
