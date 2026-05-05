from __future__ import annotations

import math
from typing import Any

import chess

from .opening_names import lookup_by_board


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
    "forced": "Forced",
}

WINTRCHESS_POINT_LOSS_BANDS = (
    ("excellent", 0.02),
    ("good", 0.05),
    ("inaccuracy", 0.10),
    ("mistake", 0.20),
)

CLASSIFICATION_VALUES = {
    "blunder": 0,
    "mistake": 1,
    "inaccuracy": 2,
    "miss": 2,
    "good": 3,
    "book": 3,
    "excellent": 4,
    "best": 5,
    "great": 5,
    "brilliant": 5,
    "forced": 5,
}

CLASSIFICATION_NAGS = {
    "brilliant": "$3",
    "great": "$1",
    "inaccuracy": "$6",
    "mistake": "$2",
    "blunder": "$4",
}

BOOK_POPULARITY_THRESHOLD = 3.0
CLASSIFICATION_ASSET_VERSION = "20260422c"
BOOK_REPEAT_THRESHOLD = 2
BOOK_ALLOWED_BASE_KEYS = {"best", "excellent", "good"}
WINTRCHESS_EXPECTED_POINTS_GRADIENT = 0.0035
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

CLASSIFICATION_ICON_ALIASES = {
    "forced": "best",
}


def _piece_key(piece: chess.Piece | None) -> tuple[bool, int] | None:
    if piece is None:
        return None
    return piece.color, piece.piece_type


def _move_identity(move_info: dict[str, Any]) -> tuple[int, int, int | None, tuple[bool, int] | None]:
    return (
        int(move_info.get("from_square", 0)),
        int(move_info.get("to_square", 0)),
        int(move_info["promotion"]) if move_info.get("promotion") is not None else None,
        _piece_key(move_info.get("piece")),
    )


def _capture_square(board: chess.Board, move: chess.Move) -> int:
    if board.is_en_passant(move):
        return move.to_square + (-8 if board.turn == chess.WHITE else 8)
    return move.to_square


def _move_info(board: chess.Board, move: chess.Move) -> dict[str, Any]:
    return {
        "from_square": move.from_square,
        "to_square": move.to_square,
        "promotion": move.promotion,
        "piece": board.piece_at(move.from_square),
        "captured": board.piece_at(_capture_square(board, move)),
    }


def _board_pieces(board: chess.Board) -> list[dict[str, Any]]:
    return [
        {
            "square": square,
            "type": piece.piece_type,
            "color": piece.color,
        }
        for square, piece in board.piece_map().items()
    ]


def _position_is_book(board: chess.Board) -> bool:
    match = lookup_by_board(board)
    return bool(str(match.get("name", "") or "").strip() or str(match.get("eco", "") or "").strip())


def _move_results_in_book(board: chess.Board, move_uci: str) -> bool:
    try:
        move = chess.Move.from_uci(move_uci)
    except ValueError:
        return False
    if move not in board.legal_moves:
        return False
    next_board = board.copy(stack=False)
    next_board.push(move)
    return _position_is_book(next_board)


def classification_icon(key: str) -> str:
    asset_key = CLASSIFICATION_ICON_ALIASES.get(key, key)
    return f"/static/move-classifications/{asset_key}.png?v={CLASSIFICATION_ASSET_VERSION}"


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
        "value": int(CLASSIFICATION_VALUES.get(key, 0)),
        "nag": CLASSIFICATION_NAGS.get(key),
        "is_only_move_that_keeps_advantage": bool(is_only_move_that_keeps_advantage),
        "is_real_piece_sacrifice": bool(is_real_piece_sacrifice),
    }


def book_classification_payload(expected_points: float, *, reason: str = "repertoire/database move") -> dict[str, Any]:
    return classification_payload("book", loss=0.0, reason=reason, expected_points=expected_points)


def expected_points_from_evaluation(*, score_type: str = "centipawn", score_value: int | float = 0) -> float:
    """Directly mirrors wintrchess expected-points math for base labels."""
    normalized_type = str(score_type or "centipawn").strip().lower()
    normalized_value = int(score_value or 0)
    if normalized_type == "mate":
        if normalized_value == 0:
            return 0.5
        return float(normalized_value > 0)
    clamped = max(-4000, min(4000, normalized_value))
    return 1.0 / (1.0 + math.exp(-WINTRCHESS_EXPECTED_POINTS_GRADIENT * clamped))


def expected_points_from_record(record: dict[str, Any]) -> float:
    if not record:
        return 0.5
    if "score_type" in record or "score_value" in record:
        return expected_points_from_evaluation(
            score_type=str(record.get("score_type", "centipawn") or "centipawn"),
            score_value=int(record.get("score_value", record.get("score_cp", 0)) or 0),
        )
    if "score_cp" in record:
        return expected_points_from_evaluation(
            score_type="centipawn",
            score_value=int(record.get("score_cp", 0) or 0),
        )
    return float(record.get("expected_points", 0.5) or 0.5)


def score_type_from_record(record: dict[str, Any]) -> str:
    return str(record.get("score_type", "centipawn") or "centipawn").strip().lower()


def score_value_from_record(record: dict[str, Any]) -> int:
    return int(record.get("score_value", record.get("score_cp", 0)) or 0)


def maybe_book_classification(
    existing: dict[str, Any] | None,
    *,
    opening_phase: bool,
    in_book: bool = False,
    repeated_count: int = 0,
    popularity: float = 0.0,
    line_status: str = "",
) -> dict[str, Any] | None:
    if not existing:
        return existing
    if not opening_phase:
        return existing
    if not in_book:
        return existing
    key = str(existing.get("key", "") or "").strip().lower()
    if key not in BOOK_ALLOWED_BASE_KEYS:
        return existing
    return book_classification_payload(
        float(existing.get("expected_points", 0.5)),
        reason="opening book move",
    )


def keeps_advantage(expected_points: float, score_cp: int = 0) -> bool:
    return float(expected_points) >= GREAT_KEEP_ADVANTAGE_THRESHOLD or int(score_cp) >= GREAT_KEEP_ADVANTAGE_CP


def _material_balance(board: chess.Board, turn: chess.Color) -> int:
    score = 0
    for piece in board.piece_map().values():
        value = PIECE_VALUES[piece.piece_type]
        score += value if piece.color == turn else -value
    return score


def _direct_attacking_moves(board: chess.Board, piece: dict[str, Any]) -> list[dict[str, Any]]:
    attacker_board = board.copy(stack=False)
    attacker_board.turn = not bool(piece["color"])
    attacking_moves = [
        _move_info(attacker_board, move)
        for move in attacker_board.legal_moves
        if _capture_square(attacker_board, move) == piece["square"]
    ]
    if not any((info.get("piece") and info["piece"].piece_type == chess.KING) for info in attacking_moves):
        for attacker_square in attacker_board.attackers(not bool(piece["color"]), piece["square"]):
            attacker_piece = attacker_board.piece_at(attacker_square)
            if attacker_piece and attacker_piece.piece_type == chess.KING:
                attacking_moves.append(
                    {
                        "from_square": attacker_square,
                        "to_square": piece["square"],
                        "promotion": None,
                        "piece": attacker_piece,
                        "captured": attacker_board.piece_at(piece["square"]),
                    }
                )
                break
    return attacking_moves


def _get_attacking_moves(board: chess.Board, piece: dict[str, Any], transitive: bool = True) -> list[dict[str, Any]]:
    attacking_moves = list(_direct_attacking_moves(board, piece))
    if not transitive:
        return attacking_moves

    frontier: list[dict[str, Any]] = [
        {
            "direct_fen": board.fen(),
            "square": info["from_square"],
            "piece": info.get("piece"),
        }
        for info in attacking_moves
    ]

    while frontier:
        transitive_attacker = frontier.pop()
        attacker_piece = transitive_attacker.get("piece")
        if attacker_piece is None or attacker_piece.piece_type == chess.KING:
            continue

        transitive_board = chess.Board(transitive_attacker["direct_fen"])
        old_attacking_moves = _direct_attacking_moves(transitive_board, piece)
        transitive_board.remove_piece_at(transitive_attacker["square"])
        new_attacking_moves = _direct_attacking_moves(transitive_board, piece)

        old_without_front = {
            _move_identity(info): info
            for info in old_attacking_moves
            if info["from_square"] != transitive_attacker["square"]
        }
        new_map = {_move_identity(info): info for info in new_attacking_moves}
        revealed = [info for key, info in new_map.items() if key not in old_without_front]

        attacking_moves.extend(revealed)
        frontier.extend(
            {
                "direct_fen": transitive_board.fen(),
                "square": info["from_square"],
                "piece": info.get("piece"),
            }
            for info in revealed
        )

    return attacking_moves


def _get_defending_moves(board: chess.Board, piece: dict[str, Any], transitive: bool = True) -> list[dict[str, Any]]:
    defender_board = board.copy(stack=False)
    attacking_moves = _get_attacking_moves(defender_board, piece, False)

    smallest_recapturer_set: list[dict[str, Any]] | None = None
    for attacking_move in attacking_moves:
        capture_board = defender_board.copy(stack=False)
        capture_board.turn = bool(attacking_move["piece"].color) if attacking_move.get("piece") else capture_board.turn
        capture_move = chess.Move(
            attacking_move["from_square"],
            attacking_move["to_square"],
            promotion=attacking_move.get("promotion"),
        )
        try:
            capture_board.push(capture_move)
        except Exception:
            continue
        recapturers = _get_attacking_moves(
            capture_board,
            {
                "type": attacking_move["piece"].piece_type if attacking_move.get("piece") else chess.PAWN,
                "color": attacking_move["piece"].color if attacking_move.get("piece") else (not bool(piece["color"])),
                "square": attacking_move["to_square"],
            },
            transitive,
        )
        if smallest_recapturer_set is None or len(recapturers) < len(smallest_recapturer_set):
            smallest_recapturer_set = recapturers

    if smallest_recapturer_set is not None:
        return smallest_recapturer_set

    flipped_board = defender_board.copy(stack=False)
    flipped_board.set_piece_at(
        piece["square"],
        chess.Piece(piece["type"], not bool(piece["color"])),
    )
    flipped_piece = {
        "type": piece["type"],
        "color": not bool(piece["color"]),
        "square": piece["square"],
    }
    return _get_attacking_moves(flipped_board, flipped_piece, transitive)


def move_material_drop(board: chess.Board, move: chess.Move) -> int:
    before = _material_balance(board, board.turn)
    after_board = board.copy(stack=False)
    after_board.push(move)
    after = _material_balance(after_board, board.turn)
    return before - after


def _is_piece_safe(board: chess.Board, piece: dict[str, Any], played_move: chess.Move | None = None) -> bool:
    direct_attackers = _get_attacking_moves(board, piece, False)
    attackers = _get_attacking_moves(board, piece, True)
    defenders = _get_defending_moves(board, piece, True)

    if (
        played_move is not None
        and piece["type"] == chess.ROOK
        and board.piece_at(_capture_square(board, played_move)) is not None
    ):
        captured_piece = board.piece_at(_capture_square(board, played_move))
        if (
            captured_piece is not None
            and PIECE_VALUES.get(captured_piece.piece_type, 0) == PIECE_VALUES[chess.KNIGHT]
            and len(attackers) == 1
            and len(defenders) > 0
            and attackers[0].get("piece") is not None
            and PIECE_VALUES[attackers[0]["piece"].piece_type] == PIECE_VALUES[chess.KNIGHT]
        ):
            return True

    has_lower_value_attacker = any(
        info.get("piece") is not None and PIECE_VALUES[info["piece"].piece_type] < PIECE_VALUES[piece["type"]]
        for info in direct_attackers
    )
    if has_lower_value_attacker:
        return False

    if len(attackers) <= len(defenders):
        return True

    direct_attacker_values = [
        PIECE_VALUES[info["piece"].piece_type]
        for info in direct_attackers
        if info.get("piece") is not None
    ]
    if not direct_attacker_values:
        return True
    lowest_value_attacker = min(direct_attacker_values)

    if (
        PIECE_VALUES[piece["type"]] < lowest_value_attacker
        and any(
            info.get("piece") is not None and PIECE_VALUES[info["piece"].piece_type] < lowest_value_attacker
            for info in defenders
        )
    ):
        return True

    if any(info.get("piece") is not None and info["piece"].piece_type == chess.PAWN for info in defenders):
        return True

    return False


def _get_unsafe_pieces(board: chess.Board, color: chess.Color, played_move: chess.Move | None = None) -> list[dict[str, Any]]:
    captured_piece_value = 0
    if played_move is not None:
        captured_piece = board.piece_at(_capture_square(board, played_move))
        captured_piece_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0

    pieces = []
    for piece in _board_pieces(board):
        if piece["color"] != color:
            continue
        if piece["type"] in {chess.PAWN, chess.KING}:
            continue
        if PIECE_VALUES[piece["type"]] <= captured_piece_value:
            continue
        if not _is_piece_safe(board, piece, played_move):
            pieces.append(piece)
    return pieces


def _board_after_move(board: chess.Board, move: chess.Move) -> chess.Board | None:
    try:
        after_board = board.copy(stack=False)
        after_board.push(move)
        return after_board
    except Exception:
        return None


def _move_creates_greater_threat(board: chess.Board, threatened_piece: dict[str, Any], acting_move_info: dict[str, Any]) -> bool:
    action_board = board.copy(stack=False)
    previous_relative_attacks = _relative_unsafe_piece_attacks(action_board, threatened_piece, bool(acting_move_info["piece"].color))
    acting_move = chess.Move(
        acting_move_info["from_square"],
        acting_move_info["to_square"],
        promotion=acting_move_info.get("promotion"),
    )
    if acting_move not in action_board.legal_moves:
        return False
    action_board.push(acting_move)
    relative_attacks = _relative_unsafe_piece_attacks(action_board, threatened_piece, bool(acting_move_info["piece"].color), acting_move)
    previous_identities = {_move_identity(info) for info in previous_relative_attacks}
    if any(_move_identity(info) not in previous_identities for info in relative_attacks):
        return True
    if PIECE_VALUES[threatened_piece["type"]] < PIECE_VALUES[chess.QUEEN]:
        for reply in list(action_board.legal_moves):
            probe = action_board.copy(stack=False)
            probe.push(reply)
            if probe.is_checkmate():
                return True
    return False


def _move_leaves_greater_threat(board: chess.Board, threatened_piece: dict[str, Any], acting_move_info: dict[str, Any]) -> bool:
    action_board = board.copy(stack=False)
    acting_move = chess.Move(
        acting_move_info["from_square"],
        acting_move_info["to_square"],
        promotion=acting_move_info.get("promotion"),
    )
    if acting_move not in action_board.legal_moves:
        return False
    action_board.push(acting_move)
    relative_attacks = _relative_unsafe_piece_attacks(action_board, threatened_piece, bool(acting_move_info["piece"].color))
    if relative_attacks:
        return True
    if PIECE_VALUES[threatened_piece["type"]] < PIECE_VALUES[chess.QUEEN]:
        for reply in list(action_board.legal_moves):
            probe = action_board.copy(stack=False)
            probe.push(reply)
            if probe.is_checkmate():
                return True
    return False


def _has_danger_levels(
    board: chess.Board,
    threatened_piece: dict[str, Any],
    acting_moves: list[dict[str, Any]],
    equality_strategy: str = "leaves",
) -> bool:
    return all(
        _move_creates_greater_threat(board, threatened_piece, acting_move)
        if equality_strategy == "creates"
        else _move_leaves_greater_threat(board, threatened_piece, acting_move)
        for acting_move in acting_moves
    )


def _relative_unsafe_piece_attacks(
    board: chess.Board,
    threatened_piece: dict[str, Any],
    color: chess.Color,
    played_move: chess.Move | None = None,
) -> list[dict[str, Any]]:
    attacks: list[dict[str, Any]] = []
    for unsafe_piece in _get_unsafe_pieces(board, color, played_move):
        if unsafe_piece["square"] == threatened_piece["square"]:
            continue
        if PIECE_VALUES[unsafe_piece["type"]] < PIECE_VALUES[threatened_piece["type"]]:
            continue
        attacks.extend(_get_attacking_moves(board, unsafe_piece, False))
    return attacks


def _is_piece_trapped(board: chess.Board, piece: dict[str, Any], danger_levels: bool = True) -> bool:
    calibrated_board = board.copy(stack=False)
    calibrated_board.turn = bool(piece["color"])
    standing_piece_safety = _is_piece_safe(calibrated_board, piece)
    piece_moves = [move for move in calibrated_board.legal_moves if move.from_square == piece["square"]]

    def move_is_unsafe(move: chess.Move) -> bool:
        if calibrated_board.piece_at(move.to_square) and calibrated_board.piece_at(move.to_square).piece_type == chess.KING:
            return False
        escape_board = calibrated_board.copy(stack=False)
        if danger_levels and _move_creates_greater_threat(escape_board, piece, _move_info(calibrated_board, move)):
            return True
        escape_board.push(move)
        escaped_piece = {**piece, "square": move.to_square}
        return not _is_piece_safe(escape_board, escaped_piece, move)

    all_moves_unsafe = all(move_is_unsafe(move) for move in piece_moves)
    return (not standing_piece_safety) and all_moves_unsafe


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


def _is_move_critical_candidate(
    board: chess.Board,
    move_record: dict[str, Any],
    second_record: dict[str, Any] | None,
) -> bool:
    current_subjective = score_value_from_record(move_record)
    second_subjective = score_value_from_record(second_record) if second_record else None

    if second_record is not None:
        if score_type_from_record(second_record) == "centipawn" and second_subjective >= 700:
            return False
    else:
        if score_type_from_record(move_record) == "centipawn" and current_subjective >= 700:
            return False

    if current_subjective < 0:
        return False

    try:
        move = chess.Move.from_uci(str(move_record.get("uci", "") or ""))
    except ValueError:
        return False

    if move.promotion == chess.QUEEN:
        return False
    if board.is_check():
        return False
    return True


def _consider_critical_classification(
    board: chess.Board,
    move_record: dict[str, Any],
    best_record: dict[str, Any],
    second_record: dict[str, Any] | None,
) -> bool:
    if not _is_move_critical_candidate(board, move_record, second_record):
        return False

    if score_type_from_record(move_record) == "mate" and score_value_from_record(move_record) > 0:
        return False

    try:
        move = chess.Move.from_uci(str(move_record.get("uci", "") or ""))
    except ValueError:
        return False

    captured_piece = board.piece_at(_capture_square(board, move)) if move in board.legal_moves else None
    if captured_piece is not None:
        captured_piece_safe = _is_piece_safe(
            board,
            {
                "color": captured_piece.color,
                "square": _capture_square(board, move),
                "type": captured_piece.piece_type,
            },
        )
        if not captured_piece_safe:
            return False

    if not second_record:
        return False

    second_top_move_point_loss = expected_points_loss_from_records(best_record, second_record)
    return second_top_move_point_loss >= 0.1


def _consider_brilliant_classification(
    board: chess.Board,
    move_record: dict[str, Any],
    second_record: dict[str, Any] | None,
) -> bool:
    if not _is_move_critical_candidate(board, move_record, second_record):
        return False

    try:
        move = chess.Move.from_uci(str(move_record.get("uci", "") or ""))
    except ValueError:
        return False
    if move.promotion is not None:
        return False

    current_board = _board_after_move(board, move)
    if current_board is None:
        return False

    mover = board.turn
    previous_unsafe_pieces = _get_unsafe_pieces(board, mover)
    unsafe_pieces = _get_unsafe_pieces(current_board, mover, move)

    if not current_board.is_check() and len(unsafe_pieces) < len(previous_unsafe_pieces):
        return False

    danger_levels_protected = all(
        _has_danger_levels(
            current_board,
            unsafe_piece,
            _get_attacking_moves(current_board, unsafe_piece, False),
        )
        for unsafe_piece in unsafe_pieces
    )
    if danger_levels_protected:
        return False

    previous_trapped_pieces = [unsafe_piece for unsafe_piece in previous_unsafe_pieces if _is_piece_trapped(board, unsafe_piece)]
    trapped_pieces = [unsafe_piece for unsafe_piece in unsafe_pieces if _is_piece_trapped(current_board, unsafe_piece)]
    moved_piece_trapped = any(trapped_piece["square"] == move.from_square for trapped_piece in previous_trapped_pieces)

    if (
        len(trapped_pieces) == len(unsafe_pieces)
        or moved_piece_trapped
        or len(trapped_pieces) < len(previous_trapped_pieces)
    ):
        return False

    return len(unsafe_pieces) > 0


def point_loss_classification_key(loss: float, *, is_best_move: bool) -> str:
    if is_best_move or loss <= 0.0001:
        return "best"
    for key, limit in WINTRCHESS_POINT_LOSS_BANDS:
        if loss < limit:
            return key
    return "blunder"


def expected_points_loss_from_records(
    previous_record: dict[str, Any],
    current_record: dict[str, Any],
) -> float:
    return max(
        0.0,
        expected_points_from_record(previous_record) - expected_points_from_record(current_record),
    )


def wintrchess_point_loss_classify(
    previous_record: dict[str, Any],
    current_record: dict[str, Any],
    *,
    is_best_move: bool = False,
) -> str:
    """Port of wintrchess point-loss classification, mapped to Bookup labels."""
    previous_score_type = score_type_from_record(previous_record)
    current_score_type = score_type_from_record(current_record)
    previous_score_value = score_value_from_record(previous_record)
    current_score_value = score_value_from_record(current_record)

    if previous_score_type == "mate" and current_score_type == "mate":
        if previous_score_value > 0 and current_score_value < 0:
            return "mistake" if current_score_value < -3 else "blunder"

        mate_loss = current_score_value - previous_score_value
        if mate_loss < 0 or (mate_loss == 0 and current_score_value < 0):
            return "best"
        if mate_loss < 2:
            return "excellent"
        if mate_loss < 7:
            return "good"
        return "inaccuracy"

    if previous_score_type == "mate" and current_score_type == "centipawn":
        if current_score_value >= 800:
            return "excellent"
        if current_score_value >= 400:
            return "good"
        if current_score_value >= 200:
            return "inaccuracy"
        if current_score_value >= 0:
            return "mistake"
        return "blunder"

    if previous_score_type == "centipawn" and current_score_type == "mate":
        if current_score_value > 0:
            return "best"
        if current_score_value >= -2:
            return "blunder"
        if current_score_value >= -5:
            return "mistake"
        return "inaccuracy"

    point_loss = expected_points_loss_from_records(previous_record, current_record)
    return point_loss_classification_key(point_loss, is_best_move=is_best_move)


def base_classification_reason(key: str, *, best_move_san: str, move_san: str) -> str:
    if key == "forced":
        return "forced move"
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
    second_record: dict[str, Any] | None = None,
    second_loss: float = 0.0,
    great_keeps_advantage_count: int = 0,
    is_player_move: bool = False,
    opening_phase: bool = False,
    in_book: bool = False,
) -> dict[str, Any]:
    best_move_san = best_record.get("move", "")
    move_san = move_record.get("move", "")
    move_uci = move_record.get("uci", "")
    best_expected = expected_points_from_record(best_record)
    move_expected = expected_points_from_record(move_record)
    loss = expected_points_loss_from_records(best_record, move_record)
    is_best_move = move_uci == best_record.get("uci") or loss <= 0.0005
    key = wintrchess_point_loss_classify(
        best_record,
        move_record,
        is_best_move=is_best_move,
    )
    reason = base_classification_reason(key, best_move_san=best_move_san, move_san=move_san)
    only_move_keeps_advantage = False
    real_piece_sacrifice = False

    if board.legal_moves.count() <= 1:
        return classification_payload(
            "forced",
            loss=loss,
            reason="forced move",
            expected_points=move_expected,
        )

    if opening_phase and in_book and key in BOOK_ALLOWED_BASE_KEYS:
        return book_classification_payload(
            move_expected,
            reason="opening book move",
        )

    try:
        move = chess.Move.from_uci(move_uci)
    except ValueError:
        move = None

    if move is not None:
        checkmate_board = _board_after_move(board, move)
        if checkmate_board is not None and checkmate_board.is_checkmate():
            key = "best"
            reason = "engine top move"

    if is_best_move and move is not None:
        real_piece_sacrifice = is_real_piece_sacrifice(board, move)
        if _consider_critical_classification(board, move_record, best_record, second_record):
            key = "great"
            only_move_keeps_advantage = True
            reason = "only move that keeps the advantage"
        if CLASSIFICATION_VALUES.get(key, 0) >= CLASSIFICATION_VALUES["best"] and _consider_brilliant_classification(board, move_record, second_record):
            key = "brilliant"
            reason = "best move plus a sound piece sacrifice"

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
            expected_points_from_record(line),
            int(line.get("score_cp", 0)),
        )
    )
    for line in candidate_lines:
        line["expected_points"] = round(expected_points_from_record(line), 4)
        line["expected_points_loss"] = round(max(0.0, best_expected - float(line.get("expected_points", 0.0))), 4)
    for line in candidate_lines:
        move_uci = str(line.get("uci", "") or "")
        repeated_count = int(repeated_counts.get(move_uci, 0) or 0)
        popularity = float(popularity_by_uci.get(move_uci, 0.0) or 0.0)
        line["classification"] = classify_move_record(
            board,
            line,
            best_record,
            second_record=candidate_lines[1] if len(candidate_lines) > 1 else None,
            second_loss=second_loss,
            great_keeps_advantage_count=great_keeps_advantage_count,
            opening_phase=opening_phase,
            in_book=(
                _move_results_in_book(board, move_uci)
                or repeated_count >= BOOK_REPEAT_THRESHOLD
                or popularity >= BOOK_POPULARITY_THRESHOLD
            ),
        )
        line["classification_label"] = line["classification"]["label"]
        line["classification_icon"] = line["classification"]["icon"]
    return candidate_lines
