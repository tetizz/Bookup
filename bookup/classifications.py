from __future__ import annotations

import math
from typing import Any

import chess

from .opening_names import lookup_by_board, matches_opening_prefix


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

EXPECTED_POINTS_BANDS = (
    ("excellent", 0.02),
    ("good", 0.05),
    ("inaccuracy", 0.10),
    ("mistake", 0.20),
    ("blunder", 1.00),
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
CLASSIFICATION_ASSET_VERSION = "20260512a"
BOOK_REPEAT_THRESHOLD = 2
BOOK_ALLOWED_BASE_KEYS = {"best", "excellent", "good", "inaccuracy"}
EXPECTED_POINTS_GRADIENT = 0.0035
GREAT_KEEP_ADVANTAGE_THRESHOLD = 0.53
GREAT_KEEP_ADVANTAGE_CP = 20
PRACTICAL_EDGE_CP_WINDOW = 120
PRACTICAL_EDGE_INACCURACY_CP_DROP = 20
PRACTICAL_EDGE_RANK_LIMIT = 5
PRACTICAL_EDGE_INACCURACY_LOSS_FLOOR = 0.045

LOWER_RANK_EXCELLENT_MIN_RANK = 5
LOWER_RANK_EXCELLENT_MIN_LOSS = 0.012
LOWER_RANK_EXCELLENT_MIN_CP_GAP = 15
BRILLIANT_MATERIAL_DROP = 100
BRILLIANT_SOUND_THRESHOLD = 0.45
BRILLIANT_ALREADY_WINNING_THRESHOLD = 0.90
BRILLIANT_NEAR_BEST_THRESHOLD = 0.02
BRILLIANT_EXPANDED_THRESHOLD = 0.07
BRILLIANT_TOP_CANDIDATE_LIMIT = 3
BRILLIANT_TOP_CANDIDATE_THRESHOLD = 0.05
BRILLIANT_ACCEPTED_HANGING_TOP_LIMIT = 2
BRILLIANT_PV_MATERIAL_DROP = 100
BRILLIANT_PV_CONFIRM_PLIES = 6
BRILLIANT_PV_PROFILE_PLIES = 8
BRILLIANT_UNRECOVERED_ALLOWANCE = 330
MISS_WINNING_EXPECTED_POINTS = 0.78
MISS_EQUAL_OR_WORSE_EXPECTED_POINTS = 0.55
MISS_MIN_EXPECTED_POINTS_LOSS = 0.08
BEST_UNIQUENESS_THRESHOLD = 0.0005
BEST_UNIQUENESS_CP_CEILING = 350
BEST_EQUIVALENT_CP_GAP = 8
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

CLASSIFICATION_CACHE_LIMIT = 12000
_MATERIAL_VALUE_CACHE: dict[tuple[Any, ...], int] = {}
_MATERIAL_BALANCE_CACHE: dict[tuple[Any, ...], int] = {}
_LEGAL_CAPTURE_CACHE: dict[tuple[Any, ...], list[chess.Move]] = {}
_SEE_GAIN_CACHE: dict[tuple[Any, ...], int] = {}
_SEE_MOVE_CACHE: dict[tuple[Any, ...], int] = {}
_MATERIAL_INVESTMENT_CACHE: dict[tuple[Any, ...], int] = {}
_UNSAFE_PIECES_CACHE: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
_PV_PROFILE_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}
_POSITION_BOOK_CACHE: dict[tuple[Any, ...], bool] = {}
_MOVE_RESULTS_IN_BOOK_CACHE: dict[tuple[Any, ...], bool] = {}
_EXPECTED_POINTS_CACHE: dict[tuple[Any, ...], float] = {}
_CLASSIFY_RECORD_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}


def _position_cache_key(board: chess.Board) -> tuple[Any, ...]:
    """Compact position key for hot classification helpers."""
    return (
        int(board.occupied_co[chess.WHITE]),
        int(board.occupied_co[chess.BLACK]),
        int(board.pawns),
        int(board.knights),
        int(board.bishops),
        int(board.rooks),
        int(board.queens),
        int(board.kings),
        int(getattr(board, "promoted", 0)),
        bool(board.turn),
        int(board.castling_rights),
        int(board.ep_square) if board.ep_square is not None else -1,
    )


def _cache_store(cache: dict[Any, Any], key: Any, value: Any) -> Any:
    if len(cache) >= CLASSIFICATION_CACHE_LIMIT:
        cache.clear()
    cache[key] = value
    return value


def _safe_cache_scalar(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


def _record_signature(record: dict[str, Any] | None) -> tuple[Any, ...]:
    """Stable cache signature for engine line records used by classification."""
    if not record:
        return ()
    line_uci = tuple(str(item) for item in (record.get("line_uci") or ()))
    has_engine_score = "score_type" in record or "score_value" in record or "score_cp" in record
    return (
        str(record.get("uci", "") or ""),
        str(record.get("move", "") or ""),
        _safe_cache_scalar(record.get("score_type")),
        _safe_cache_scalar(record.get("score_value")),
        _safe_cache_scalar(record.get("score_cp")),
        None if has_engine_score else _safe_cache_scalar(record.get("expected_points")),
        line_uci,
    )


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


def _material_value(board: chess.Board, color: chess.Color) -> int:
    cache_key = (*_position_cache_key(board), "material", bool(color))
    cached = _MATERIAL_VALUE_CACHE.get(cache_key)
    if cached is not None:
        return cached
    total = 0
    for square, piece in board.piece_map().items():
        if piece.color != color or piece.piece_type == chess.KING:
            continue
        total += PIECE_VALUES.get(piece.piece_type, 0)
    return _cache_store(_MATERIAL_VALUE_CACHE, cache_key, total)


def _position_is_book(board: chess.Board) -> bool:
    cache_key = (*_position_cache_key(board), "position_book")
    cached = _POSITION_BOOK_CACHE.get(cache_key)
    if cached is not None:
        return cached
    match = lookup_by_board(board)
    result = bool(str(match.get("name", "") or "").strip() or str(match.get("eco", "") or "").strip())
    return _cache_store(_POSITION_BOOK_CACHE, cache_key, result)


def _move_results_in_book(board: chess.Board, move_uci: str) -> bool:
    cache_key = (
        *_position_cache_key(board),
        "move_results_book",
        move_uci,
        tuple(item.uci() for item in getattr(board, "move_stack", ()) or ()),
    )
    cached = _MOVE_RESULTS_IN_BOOK_CACHE.get(cache_key)
    if cached is not None:
        return cached
    try:
        move = chess.Move.from_uci(move_uci)
    except ValueError:
        return _cache_store(_MOVE_RESULTS_IN_BOOK_CACHE, cache_key, False)
    if move not in board.legal_moves:
        return _cache_store(_MOVE_RESULTS_IN_BOOK_CACHE, cache_key, False)
    san_tokens: list[str] = []
    if getattr(board, "move_stack", None):
        replay = chess.Board()
        san_tokens = []
        try:
            for item in board.move_stack:
                if item not in replay.legal_moves:
                    san_tokens = []
                    break
                san_tokens.append(replay.san(item))
                replay.push(item)
        except Exception:
            san_tokens = []
        if san_tokens:
            try:
                next_san = board.san(move)
            except Exception:
                next_san = ""
            if next_san and matches_opening_prefix([*san_tokens, next_san]):
                return _cache_store(_MOVE_RESULTS_IN_BOOK_CACHE, cache_key, True)
    next_board = board.copy(stack=False)
    next_board.push(move)
    return _cache_store(_MOVE_RESULTS_IN_BOOK_CACHE, cache_key, _position_is_book(next_board))


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


def _is_miss_position(
    *,
    best_expected: float,
    move_expected: float,
    loss: float,
) -> bool:
    return (
        best_expected >= MISS_WINNING_EXPECTED_POINTS
        and move_expected <= MISS_EQUAL_OR_WORSE_EXPECTED_POINTS
        and loss >= MISS_MIN_EXPECTED_POINTS_LOSS
    )


def expected_points_from_evaluation(
    *,
    score_type: str = "centipawn",
    score_value: int | float = 0,
    player_rating: int | None = None,
) -> float:
    """Convert a Stockfish score into an expected-points estimate for base labels."""
    normalized_type = str(score_type or "centipawn").strip().lower()
    normalized_value = int(score_value or 0)
    if normalized_type == "mate":
        if normalized_value == 0:
            return 0.5
        return float(normalized_value > 0)
    clamped = max(-4000, min(4000, normalized_value))
    return 1.0 / (1.0 + math.exp(-EXPECTED_POINTS_GRADIENT * clamped))


def expected_points_from_record(record: dict[str, Any], *, player_rating: int | None = None) -> float:
    if not record:
        return 0.5
    cache_key = ("expected_points", _record_signature(record), player_rating)
    cached = _EXPECTED_POINTS_CACHE.get(cache_key)
    if cached is not None:
        return cached
    if "score_type" in record or "score_value" in record:
        return _cache_store(
            _EXPECTED_POINTS_CACHE,
            cache_key,
            expected_points_from_evaluation(
                score_type=str(record.get("score_type", "centipawn") or "centipawn"),
                score_value=int(record.get("score_value", record.get("score_cp", 0)) or 0),
                player_rating=player_rating,
            ),
        )
    if "score_cp" in record:
        return _cache_store(
            _EXPECTED_POINTS_CACHE,
            cache_key,
            expected_points_from_evaluation(
                score_type="centipawn",
                score_value=int(record.get("score_cp", 0) or 0),
                player_rating=player_rating,
            ),
        )
    return _cache_store(_EXPECTED_POINTS_CACHE, cache_key, float(record.get("expected_points", 0.5) or 0.5))


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
    cache_key = (*_position_cache_key(board), "balance", bool(turn))
    cached = _MATERIAL_BALANCE_CACHE.get(cache_key)
    if cached is not None:
        return cached
    score = 0
    for piece in board.piece_map().values():
        value = PIECE_VALUES[piece.piece_type]
        score += value if piece.color == turn else -value
    return _cache_store(_MATERIAL_BALANCE_CACHE, cache_key, score)


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


def _is_piece_safe(
    board: chess.Board,
    piece: dict[str, Any],
    played_move: chess.Move | None = None,
    *,
    captured_piece_value: int | None = None,
) -> bool:
    direct_attackers = _get_attacking_moves(board, piece, False)
    attackers = _get_attacking_moves(board, piece, True)
    defenders = _get_defending_moves(board, piece, True)

    if (
        played_move is not None
        and piece["type"] == chess.ROOK
    ):
        if captured_piece_value is None:
            captured_piece = board.piece_at(_capture_square(board, played_move))
            captured_piece_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0
        if (
            captured_piece_value == PIECE_VALUES[chess.KNIGHT]
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


def _get_unsafe_pieces(
    board: chess.Board,
    color: chess.Color,
    played_move: chess.Move | None = None,
    *,
    captured_piece_value: int | None = None,
) -> list[dict[str, Any]]:
    if captured_piece_value is None:
        captured_piece_value = 0
        if played_move is not None:
            captured_piece = board.piece_at(_capture_square(board, played_move))
            captured_piece_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0

    cache_key = (
        *_position_cache_key(board),
        "unsafe",
        bool(color),
        played_move.uci() if played_move is not None else "",
        int(captured_piece_value or 0),
    )
    cached = _UNSAFE_PIECES_CACHE.get(cache_key)
    if cached is not None:
        return [dict(piece) for piece in cached]

    pieces = []
    for piece in _board_pieces(board):
        if piece["color"] != color:
            continue
        if piece["type"] in {chess.PAWN, chess.KING}:
            continue
        if PIECE_VALUES[piece["type"]] <= captured_piece_value:
            continue
        if not _is_piece_safe(board, piece, played_move, captured_piece_value=captured_piece_value):
            pieces.append(piece)
    _cache_store(_UNSAFE_PIECES_CACHE, cache_key, [dict(piece) for piece in pieces])
    return pieces


def _board_after_move(board: chess.Board, move: chess.Move) -> chess.Board | None:
    try:
        after_board = board.copy(stack=False)
        after_board.push(move)
        return after_board
    except Exception:
        return None


def _legal_captures_to_square(board: chess.Board, square: int, color: chess.Color) -> list[chess.Move]:
    """Return legal captures of the piece on `square`, ordered by least valuable attacker."""
    cache_key = (*_position_cache_key(board), "captures", int(square), bool(color))
    cached = _LEGAL_CAPTURE_CACHE.get(cache_key)
    if cached is not None:
        return list(cached)

    probe = board.copy(stack=False)
    probe.turn = color
    captures: list[tuple[int, chess.Move]] = []
    for attacker_square in probe.attackers(color, square):
        attacker = probe.piece_at(attacker_square)
        if attacker is None or attacker.piece_type == chess.KING:
            continue
        promotion = None
        if attacker.piece_type == chess.PAWN and chess.square_rank(square) in {0, 7}:
            promotion = chess.QUEEN
        move = chess.Move(attacker_square, square, promotion=promotion)
        if move not in probe.legal_moves or not probe.is_capture(move):
            continue
        if _capture_square(probe, move) != square:
            continue
        captures.append((PIECE_VALUES.get(attacker.piece_type, 0), move))
    captures.sort(key=lambda item: item[0])
    result = [move for _, move in captures]
    _cache_store(_LEGAL_CAPTURE_CACHE, cache_key, result)
    return list(result)


def _static_exchange_gain(board: chess.Board, square: int, color: chess.Color, depth: int = 0) -> int:
    """Best material gain for `color` if it starts a legal capture sequence on `square`.

    This is a real static exchange evaluator: it recursively plays legal captures
    on the target square and assumes each side can decline unfavorable recaptures.
    Positive output means the side to capture can win material on that square.
    """
    if depth > 32:
        return 0
    cache_key = (*_position_cache_key(board), "see_gain", int(square), bool(color))
    cached = _SEE_GAIN_CACHE.get(cache_key)
    if cached is not None:
        return cached
    victim = board.piece_at(square)
    if victim is None or victim.color == color or victim.piece_type == chess.KING:
        return 0

    best_gain = 0
    victim_value = PIECE_VALUES.get(victim.piece_type, 0)
    for capture in _legal_captures_to_square(board, square, color):
        reply_board = board.copy(stack=False)
        reply_board.turn = color
        try:
            reply_board.push(capture)
        except Exception:
            continue
        reply_gain = _static_exchange_gain(reply_board, square, not color, depth + 1)
        best_gain = max(best_gain, victim_value - max(0, reply_gain))
    return _cache_store(_SEE_GAIN_CACHE, cache_key, best_gain)


def static_exchange_eval(board: chess.Board, move: chess.Move) -> int:
    """Return the immediate SEE score of `move` from the mover's perspective.

    Captures start with the captured piece value, then subtract the opponent's
    best legal exchange on the destination square. Quiet moves can still be
    sacrifices when the moved piece lands on a square where it can be won.
    """
    if move not in board.legal_moves:
        return 0
    cache_key = (*_position_cache_key(board), "see_move", move.uci())
    cached = _SEE_MOVE_CACHE.get(cache_key)
    if cached is not None:
        return cached
    moved_piece = board.piece_at(move.from_square)
    if moved_piece is None or moved_piece.piece_type == chess.KING:
        return 0
    captured_piece = board.piece_at(_capture_square(board, move))
    captured_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0
    after_board = _board_after_move(board, move)
    if after_board is None:
        return _cache_store(_SEE_MOVE_CACHE, cache_key, captured_value)
    opponent_gain = _static_exchange_gain(after_board, move.to_square, not moved_piece.color)
    return _cache_store(_SEE_MOVE_CACHE, cache_key, captured_value - max(0, opponent_gain))


def _static_material_investment(board: chess.Board, move: chess.Move) -> int:
    cache_key = (*_position_cache_key(board), "investment", move.uci())
    cached = _MATERIAL_INVESTMENT_CACHE.get(cache_key)
    if cached is not None:
        return cached
    return _cache_store(_MATERIAL_INVESTMENT_CACHE, cache_key, max(0, -static_exchange_eval(board, move)))


def _direct_material_investment(board: chess.Board, move: chess.Move) -> int:
    moved_piece = board.piece_at(move.from_square)
    if moved_piece is None or moved_piece.piece_type == chess.KING:
        return 0
    captured_piece = board.piece_at(_capture_square(board, move)) if move in board.legal_moves else None
    if captured_piece is None:
        return 0
    captured_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0
    moved_value = PIECE_VALUES.get(moved_piece.piece_type, 0)
    return max(0, moved_value - captured_value)


def _moved_piece_left_unsafe(
    board: chess.Board,
    move: chess.Move,
    *,
    after_board: chess.Board | None = None,
    see_investment: int | None = None,
    captured_piece_value: int | None = None,
) -> bool:
    moved_piece = board.piece_at(move.from_square)
    if moved_piece is None:
        return False
    if see_investment is None:
        see_investment = _static_material_investment(board, move)
    if see_investment >= BRILLIANT_MATERIAL_DROP:
        return True
    if captured_piece_value is None:
        captured_piece = board.piece_at(_capture_square(board, move)) if move in board.legal_moves else None
        captured_piece_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0
    if after_board is None:
        after_board = _board_after_move(board, move)
    if after_board is None:
        return False
    unsafe_after = _get_unsafe_pieces(
        after_board,
        moved_piece.color,
        move,
        captured_piece_value=captured_piece_value,
    )
    return any(
        unsafe_piece["square"] == move.to_square
        and unsafe_piece["type"] == moved_piece.piece_type
        and unsafe_piece["color"] == moved_piece.color
        for unsafe_piece in unsafe_after
    )


def _least_direct_attacker_value(board: chess.Board, square: int, color: chess.Color) -> int | None:
    values: list[int] = []
    for attacker_square in board.attackers(not color, square):
        attacker_piece = board.piece_at(attacker_square)
        if attacker_piece is None or attacker_piece.piece_type == chess.KING:
            continue
        values.append(PIECE_VALUES.get(attacker_piece.piece_type, 0))
    return min(values) if values else None


def _least_direct_defender_value(board: chess.Board, square: int, color: chess.Color) -> int | None:
    values: list[int] = []
    for defender_square in board.attackers(color, square):
        defender_piece = board.piece_at(defender_square)
        if defender_piece is None or defender_piece.piece_type == chess.KING:
            continue
        values.append(PIECE_VALUES.get(defender_piece.piece_type, 0))
    return min(values) if values else None


def _has_material_winning_direct_defender(board: chess.Board, square: int, color: chess.Color) -> bool:
    least_attacker_value = _least_direct_attacker_value(board, square, color)
    if least_attacker_value is None:
        return False
    for defender_square in board.attackers(color, square):
        defender_piece = board.piece_at(defender_square)
        if defender_piece is None or defender_piece.piece_type == chess.KING:
            continue
        if PIECE_VALUES.get(defender_piece.piece_type, 0) <= least_attacker_value:
            return True
    return False


def _is_piece_materially_hanging(board: chess.Board, piece: dict[str, Any]) -> bool:
    piece_value = PIECE_VALUES.get(piece["type"], 0)
    if piece_value <= 0:
        return False
    if _static_exchange_gain(board, piece["square"], not bool(piece["color"])) >= BRILLIANT_MATERIAL_DROP:
        return True
    least_attacker_value = _least_direct_attacker_value(board, piece["square"], piece["color"])
    if least_attacker_value is None:
        return False
    if least_attacker_value > piece_value:
        return False
    least_defender_value = _least_direct_defender_value(board, piece["square"], piece["color"])
    if least_defender_value is None:
        return True
    return least_defender_value > least_attacker_value


def _move_targets_high_value_piece(after_board: chess.Board, move: chess.Move, mover: chess.Color) -> bool:
    moved_piece = after_board.piece_at(move.to_square)
    if moved_piece is None or moved_piece.color != mover:
        return False
    attack_mask = after_board.attacks(move.to_square)
    for target_square in attack_mask:
        target_piece = after_board.piece_at(target_square)
        if target_piece is None or target_piece.color == mover:
            continue
        if target_piece.piece_type in {chess.QUEEN, chess.ROOK}:
            return True
    return False


def _move_creates_greater_threat(board: chess.Board, threatened_piece: dict[str, Any], acting_move_info: dict[str, Any]) -> bool:
    action_board = board.copy(stack=False)
    acting_piece = acting_move_info.get("piece")
    if acting_piece is None:
        return False
    previous_relative_attacks = _relative_unsafe_piece_attacks(action_board, threatened_piece, bool(acting_piece.color))
    acting_move = chess.Move(
        acting_move_info["from_square"],
        acting_move_info["to_square"],
        promotion=acting_move_info.get("promotion"),
    )
    if acting_move not in action_board.legal_moves:
        return False
    captured_piece = acting_move_info.get("captured")
    captured_piece_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0
    action_board.push(acting_move)
    relative_attacks = _relative_unsafe_piece_attacks(
        action_board,
        threatened_piece,
        bool(acting_piece.color),
        acting_move,
        captured_piece_value=captured_piece_value,
    )
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
    acting_piece = acting_move_info.get("piece")
    if acting_piece is None:
        return False
    acting_move = chess.Move(
        acting_move_info["from_square"],
        acting_move_info["to_square"],
        promotion=acting_move_info.get("promotion"),
    )
    if acting_move not in action_board.legal_moves:
        return False
    action_board.push(acting_move)
    relative_attacks = _relative_unsafe_piece_attacks(action_board, threatened_piece, bool(acting_piece.color))
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
    *,
    captured_piece_value: int | None = None,
) -> list[dict[str, Any]]:
    attacks: list[dict[str, Any]] = []
    for unsafe_piece in _get_unsafe_pieces(board, color, played_move, captured_piece_value=captured_piece_value):
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
        acting_move_info = _move_info(calibrated_board, move)
        if danger_levels and _move_creates_greater_threat(escape_board, piece, acting_move_info):
            return True
        captured_piece = acting_move_info.get("captured")
        captured_piece_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0
        escape_board.push(move)
        escaped_piece = {**piece, "square": move.to_square}
        return not _is_piece_safe(escape_board, escaped_piece, move, captured_piece_value=captured_piece_value)

    all_moves_unsafe = all(move_is_unsafe(move) for move in piece_moves)
    return (not standing_piece_safety) and all_moves_unsafe


def is_real_piece_sacrifice(
    board: chess.Board,
    move: chess.Move,
    *,
    after_board: chess.Board | None = None,
    see_investment: int | None = None,
) -> bool:
    moved_piece = board.piece_at(move.from_square)
    if moved_piece is None or moved_piece.piece_type == chess.KING:
        return False

    if see_investment is None:
        see_investment = _static_material_investment(board, move)
    if see_investment >= BRILLIANT_MATERIAL_DROP:
        return True

    investment = _direct_material_investment(board, move)
    if investment < BRILLIANT_MATERIAL_DROP:
        return False

    if after_board is None:
        after_board = _board_after_move(board, move)
    if after_board is None:
        return False

    if not _moved_piece_left_unsafe(
        board,
        move,
        after_board=after_board,
        see_investment=see_investment,
    ):
        return False
    least_enemy_attacker = _least_direct_attacker_value(after_board, move.to_square, moved_piece.color)
    if least_enemy_attacker is None:
        return False
    if least_enemy_attacker > PIECE_VALUES.get(moved_piece.piece_type, 0):
        return False
    if _has_material_winning_direct_defender(after_board, move.to_square, moved_piece.color):
        return False

    return True


def _pv_tactical_profile(
    board: chess.Board,
    move_record: dict[str, Any],
    *,
    after_board: chess.Board | None = None,
    see_investment: int | None = None,
) -> dict[str, Any]:
    move_uci = str(move_record.get("uci", "") or "")
    line_uci = list(move_record.get("line_uci") or [])
    if not move_uci:
        return {}
    try:
        move = chess.Move.from_uci(move_uci)
    except ValueError:
        return {}
    if move not in board.legal_moves:
        return {}

    moved_piece = board.piece_at(move.from_square)
    if moved_piece is None or moved_piece.piece_type == chess.KING:
        return {}

    preview_uci = list(line_uci[:BRILLIANT_PV_PROFILE_PLIES])
    if not preview_uci:
        preview_uci = [move_uci]
    elif preview_uci[0] != move_uci:
        preview_uci.insert(0, move_uci)
    cache_key = (*_position_cache_key(board), "pv_profile", tuple(preview_uci))
    cached = _PV_PROFILE_CACHE.get(cache_key)
    if cached is not None:
        return dict(cached)

    mover = board.turn
    material_before = _material_value(board, mover)
    unsafe_before = _get_unsafe_pieces(board, mover)
    if after_board is None:
        after_board = _board_after_move(board, move)
    if see_investment is None:
        see_investment = _static_material_investment(board, move)
    direct_investment = max(_direct_material_investment(board, move), see_investment)
    captured_piece = board.piece_at(_capture_square(board, move)) if move in board.legal_moves else None
    captured_piece_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0
    moved_piece_unsafe = _moved_piece_left_unsafe(
        board,
        move,
        after_board=after_board,
        see_investment=see_investment,
        captured_piece_value=captured_piece_value,
    )
    unsafe_after = (
        _get_unsafe_pieces(
            after_board,
            mover,
            move,
            captured_piece_value=captured_piece_value,
        )
        if after_board is not None
        else []
    )
    unsafe_after_keys = {
        (piece["square"], piece["type"], piece["color"])
        for piece in unsafe_after
    }
    accepted_hanging_piece_value = 0
    for piece in unsafe_before:
        if piece["square"] == move.from_square:
            continue
        piece_key = (piece["square"], piece["type"], piece["color"])
        if piece_key in unsafe_after_keys and _is_piece_materially_hanging(board, piece):
            accepted_hanging_piece_value = max(
                accepted_hanging_piece_value,
                PIECE_VALUES.get(piece["type"], 0),
            )
    replay_board = board.copy(stack=False)
    min_delta = 0
    max_delta = 0
    final_delta = 0

    for reply_uci in preview_uci:
        try:
            reply_move = chess.Move.from_uci(reply_uci)
        except ValueError:
            break
        if reply_move not in replay_board.legal_moves:
            break
        replay_board.push(reply_move)
        material_delta = _material_value(replay_board, mover) - material_before
        min_delta = min(min_delta, material_delta)
        max_delta = max(max_delta, material_delta)
        final_delta = material_delta

    gives_check = bool(after_board and after_board.is_check())
    high_value_threat = bool(after_board) and _move_targets_high_value_piece(after_board, move, mover)
    materially_defended = (
        bool(after_board)
        and see_investment < BRILLIANT_MATERIAL_DROP
        and _has_material_winning_direct_defender(after_board, move.to_square, mover)
    )

    profile = {
        "move": move,
        "direct_investment": direct_investment,
        "see_investment": see_investment,
        "moved_piece_unsafe": moved_piece_unsafe,
        "accepted_hanging_piece_value": accepted_hanging_piece_value,
        "accepted_hanging_piece": accepted_hanging_piece_value >= PIECE_VALUES[chess.KNIGHT],
        "gives_check": gives_check,
        "high_value_threat": high_value_threat,
        "materially_defended": materially_defended,
        "min_delta": min_delta,
        "max_delta": max_delta,
        "final_delta": final_delta,
        "swing": max_delta - min_delta,
        "recovered_from_risk": min_delta <= -BRILLIANT_PV_MATERIAL_DROP and (final_delta - min_delta) >= BRILLIANT_PV_MATERIAL_DROP,
    }
    _cache_store(_PV_PROFILE_CACHE, cache_key, dict(profile))
    return profile


def _pv_confirms_material_investment(
    board: chess.Board,
    move_record: dict[str, Any],
    tactical_profile: dict[str, Any] | None = None,
) -> bool:
    profile = tactical_profile or _pv_tactical_profile(board, move_record)
    if not profile:
        return False
    forcing_signal = profile["gives_check"] or profile["high_value_threat"]
    if not profile["moved_piece_unsafe"] and profile["direct_investment"] < BRILLIANT_MATERIAL_DROP:
        return False
    if profile["direct_investment"] < BRILLIANT_MATERIAL_DROP:
        return forcing_signal and profile["moved_piece_unsafe"] and profile["recovered_from_risk"]
    if profile["recovered_from_risk"]:
        return True
    return forcing_signal and profile["swing"] >= BRILLIANT_PV_MATERIAL_DROP


def _is_good_piece_sacrifice_profile(
    profile: dict[str, Any],
    *,
    move_rank: int | None = None,
    loss: float | None = None,
) -> bool:
    if not profile:
        return False
    direct_investment = int(profile.get("direct_investment", 0) or 0)
    moved_piece_unsafe = bool(profile.get("moved_piece_unsafe"))
    accepted_hanging_piece = bool(profile.get("accepted_hanging_piece"))
    accepted_hanging_piece_value = int(profile.get("accepted_hanging_piece_value", 0) or 0)
    min_delta = int(profile.get("min_delta", 0) or 0)
    recovered_from_risk = bool(profile.get("recovered_from_risk"))
    gives_check = bool(profile.get("gives_check"))
    high_value_threat = bool(profile.get("high_value_threat"))
    materially_defended = bool(profile.get("materially_defended"))
    swing = int(profile.get("swing", 0) or 0)
    final_delta = int(profile.get("final_delta", 0) or 0)

    accepted_hanging_candidate = (
        accepted_hanging_piece
        and direct_investment < BRILLIANT_MATERIAL_DROP
        and not moved_piece_unsafe
        and not materially_defended
        and move_rank is not None
        and move_rank <= BRILLIANT_ACCEPTED_HANGING_TOP_LIMIT
        and (loss is None or loss <= BRILLIANT_TOP_CANDIDATE_THRESHOLD)
    )

    sacrifice_committed = direct_investment >= BRILLIANT_MATERIAL_DROP
    if not sacrifice_committed and accepted_hanging_candidate:
        return True
    if not sacrifice_committed:
        return False

    if materially_defended and not moved_piece_unsafe:
        return False

    if direct_investment >= BRILLIANT_MATERIAL_DROP:
        if not moved_piece_unsafe:
            return False
        tolerated_deficit = -(direct_investment + BRILLIANT_UNRECOVERED_ALLOWANCE)
        if recovered_from_risk:
            return True
        if final_delta < tolerated_deficit:
            return False
        return bool(
            gives_check
            or high_value_threat
            or swing >= BRILLIANT_PV_MATERIAL_DROP
        )

    return moved_piece_unsafe and recovered_from_risk


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
    *,
    player_rating: int | None = None,
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

    second_top_move_point_loss = expected_points_loss_from_records(
        best_record,
        second_record,
        player_rating=player_rating,
    )
    return second_top_move_point_loss >= 0.1


def _best_move_was_critical(
    board: chess.Board,
    best_record: dict[str, Any],
    second_record: dict[str, Any] | None,
) -> bool:
    """A miss should point to a genuinely critical continuation, not any win."""
    if not second_record:
        return False
    return _consider_critical_classification(
        board,
        best_record,
        best_record,
        second_record,
        player_rating=None,
    )


def _consider_brilliant_classification(
    board: chess.Board,
    move_record: dict[str, Any],
    second_record: dict[str, Any] | None,
    *,
    move_rank: int | None = None,
    loss: float | None = None,
    tactical_profile: dict[str, Any] | None = None,
) -> bool:
    if not _is_move_critical_candidate(board, move_record, second_record):
        return False
    if move_rank is not None and move_rank > BRILLIANT_TOP_CANDIDATE_LIMIT:
        return False
    profile = tactical_profile or _pv_tactical_profile(board, move_record)
    return _is_good_piece_sacrifice_profile(
        profile,
        move_rank=move_rank,
        loss=loss,
    )


def _brilliant_loss_limit(
    *,
    tactical_shape: bool,
    gives_check: bool,
) -> float:
    if tactical_shape or gives_check:
        return BRILLIANT_EXPANDED_THRESHOLD
    return BRILLIANT_NEAR_BEST_THRESHOLD


def point_loss_classification_key(loss: float, *, is_best_move: bool) -> str:
    if is_best_move:
        return "best"
    for key, limit in EXPECTED_POINTS_BANDS:
        if loss <= limit:
            return key
    return "blunder"


def base_classification_key(loss: float, *, is_best_move: bool) -> str:
    return point_loss_classification_key(loss, is_best_move=is_best_move)


def expected_points_loss_from_records(
    previous_record: dict[str, Any],
    current_record: dict[str, Any],
    *,
    player_rating: int | None = None,
) -> float:
    return max(
        0.0,
        expected_points_from_record(previous_record, player_rating=player_rating)
        - expected_points_from_record(current_record, player_rating=player_rating),
    )


def _practical_edge_floor_key(
    best_record: dict[str, Any],
    move_record: dict[str, Any],
    current_key: str,
    *,
    move_rank: int | None = None,
    loss: float = 0.0,
    opening_phase: bool = False,
    player_rating: int | None = None,
) -> str:
    """Tighten labels when a move gives away a small practical edge.

    Expected-points loss can be too soft in close positions where several
    alternatives are "playable" but still clearly surrender the best edge.
    This guard promotes near-equal centipawn drops into Inaccuracy so second-
    best/third-best moves are not over-rewarded just for being on the PV list.
    """
    if current_key not in {"excellent", "good"}:
        return current_key
    if opening_phase:
        return current_key
    if move_rank is None or move_rank <= 1 or move_rank > PRACTICAL_EDGE_RANK_LIMIT:
        return current_key
    if score_type_from_record(best_record) != "centipawn" or score_type_from_record(move_record) != "centipawn":
        return current_key
    best_cp = int(best_record.get("score_cp", 0) or 0)
    move_cp = int(move_record.get("score_cp", 0) or 0)
    cp_drop = best_cp - move_cp
    cp_drop_floor = max(25, PRACTICAL_EDGE_INACCURACY_CP_DROP)
    if cp_drop < cp_drop_floor:
        return current_key
    if loss < PRACTICAL_EDGE_INACCURACY_LOSS_FLOOR:
        return current_key
    if abs(best_cp) > PRACTICAL_EDGE_CP_WINDOW:
        return current_key
    return "inaccuracy"


def _branch_quality_floor_key(
    current_key: str,
    *,
    move_rank: int | None = None,
    loss: float = 0.0,
    opening_phase: bool = False,
) -> str:
    """Branch-only moves need a little more skepticism than PV candidates."""
    if move_rank is not None:
        return current_key
    excellent_floor = 0.012 if opening_phase else 0.008
    good_floor = 0.05 if opening_phase else 0.04
    inaccuracy_floor = 0.13 if opening_phase else 0.11
    if current_key == "excellent" and loss >= excellent_floor:
        return "good"
    if current_key == "good" and loss >= good_floor:
        return "inaccuracy"
    if current_key == "inaccuracy" and loss >= inaccuracy_floor:
        return "mistake"
    return current_key


def _lower_rank_excellent_floor_key(
    best_record: dict[str, Any],
    move_record: dict[str, Any],
    current_key: str,
    *,
    move_rank: int | None = None,
    loss: float = 0.0,
) -> str:
    """Avoid over-rewarding lower-ranked PV moves as Excellent.

    Some deeper PV candidates remain engine-approved but are clearly below the
    best practical continuation. When they sit farther down the PV list and
    give away enough centipawns, keep them in Good instead of Excellent.
    """
    if current_key != "excellent":
        return current_key
    if move_rank is None or move_rank < LOWER_RANK_EXCELLENT_MIN_RANK:
        return current_key
    if loss < LOWER_RANK_EXCELLENT_MIN_LOSS:
        return current_key
    if score_type_from_record(best_record) != "centipawn" or score_type_from_record(move_record) != "centipawn":
        return current_key
    best_cp = int(best_record.get("score_cp", 0) or 0)
    move_cp = int(move_record.get("score_cp", 0) or 0)
    if abs(best_cp - move_cp) < LOWER_RANK_EXCELLENT_MIN_CP_GAP:
        return current_key
    return "good"


def _promote_near_best_key(
    best_record: dict[str, Any],
    move_record: dict[str, Any],
    current_key: str,
    *,
    move_rank: int | None = None,
) -> str:
    """Promote moves that are effectively tied with the engine top line.

    MultiPV ordering can still rank near-identical continuations slightly
    apart. If the scores are effectively tied, prefer the stronger label so
    we don't understate a move simply because it landed on PV #2 or #3.
    """
    if current_key not in {"excellent", "good"}:
        return current_key
    if move_rank is not None and move_rank > 3:
        return current_key
    if _records_are_effectively_tied(best_record, move_record):
        return "best"
    if (
        current_key == "good"
        and move_rank is not None
        and move_rank <= 2
        and score_type_from_record(best_record) == "centipawn"
        and score_type_from_record(move_record) == "centipawn"
        and abs(int(best_record.get("score_cp", 0) or 0) - int(move_record.get("score_cp", 0) or 0)) <= 18
    ):
        return "excellent"
    return current_key


def _records_are_effectively_tied(
    first_record: dict[str, Any] | None,
    second_record: dict[str, Any] | None,
) -> bool:
    if not first_record or not second_record:
        return False
    first_type = score_type_from_record(first_record)
    second_type = score_type_from_record(second_record)
    if first_type != second_type:
        return False
    first_value = score_value_from_record(first_record)
    second_value = score_value_from_record(second_record)
    if first_type == "mate":
        return (first_value > 0) == (second_value > 0) and abs(first_value - second_value) <= 1
    return abs(first_value - second_value) <= BEST_EQUIVALENT_CP_GAP


def expected_point_loss_classify(
    previous_record: dict[str, Any],
    current_record: dict[str, Any],
    *,
    is_best_move: bool = False,
    player_rating: int | None = None,
) -> str:
    """Classify a move by expected-points loss, mapped to Bookup labels."""
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

    point_loss = expected_points_loss_from_records(
        previous_record,
        current_record,
        player_rating=player_rating,
    )
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
        return "best or nearly-best move plus a good sacrifice"
    if key == "miss":
        return "fails to convert the stronger continuation"
    if key == "book":
        return "repertoire/database move"
    return f"{move_san} trails the best move {best_move_san}."


def _has_at_most_one_legal_move(board: chess.Board) -> bool:
    """Cheap forced-move check without materializing/counting every legal move."""
    legal_moves = iter(board.legal_moves)
    try:
        next(legal_moves)
    except StopIteration:
        return True
    try:
        next(legal_moves)
    except StopIteration:
        return True
    return False


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
    move_rank: int | None = None,
    player_rating: int | None = None,
) -> dict[str, Any]:
    classification_cache_key = (
        *_position_cache_key(board),
        "classify",
        _record_signature(move_record),
        _record_signature(best_record),
        _record_signature(second_record),
        round(float(second_loss or 0.0), 6),
        int(great_keeps_advantage_count or 0),
        bool(is_player_move),
        bool(opening_phase),
        bool(in_book),
        int(move_rank or 0),
        player_rating,
    )
    cached_classification = _CLASSIFY_RECORD_CACHE.get(classification_cache_key)
    if cached_classification is not None:
        return dict(cached_classification)

    def _remember_classification(payload: dict[str, Any]) -> dict[str, Any]:
        _cache_store(_CLASSIFY_RECORD_CACHE, classification_cache_key, dict(payload))
        return payload

    best_move_san = best_record.get("move", "")
    move_san = move_record.get("move", "")
    move_uci = move_record.get("uci", "")
    best_expected = expected_points_from_record(best_record, player_rating=player_rating)
    move_expected = expected_points_from_record(move_record, player_rating=player_rating)
    loss = max(0.0, best_expected - move_expected)
    is_best_move = move_uci == best_record.get("uci")
    key = base_classification_key(loss, is_best_move=is_best_move)
    key = _practical_edge_floor_key(
        best_record,
        move_record,
        key,
        move_rank=move_rank,
        loss=loss,
        opening_phase=opening_phase,
        player_rating=player_rating,
    )
    key = _branch_quality_floor_key(
        key,
        move_rank=move_rank,
        loss=loss,
        opening_phase=opening_phase,
    )
    key = _promote_near_best_key(
        best_record,
        move_record,
        key,
        move_rank=move_rank,
    )
    key = _lower_rank_excellent_floor_key(
        best_record,
        move_record,
        key,
        move_rank=move_rank,
        loss=loss,
    )
    reason = base_classification_reason(key, best_move_san=best_move_san, move_san=move_san)
    only_move_keeps_advantage = False
    real_piece_sacrifice = False
    tactical_brilliant_shape = False
    tactical_profile: dict[str, Any] = {}

    if _has_at_most_one_legal_move(board):
        return _remember_classification(classification_payload(
            "forced",
            loss=loss,
            reason="forced move",
            expected_points=move_expected,
        ))

    if opening_phase and in_book and key in BOOK_ALLOWED_BASE_KEYS:
        return _remember_classification(book_classification_payload(
            move_expected,
            reason="opening book move",
        ))

    if (
        key == "best"
        and second_record
        and float(second_loss or 0.0) <= BEST_UNIQUENESS_THRESHOLD
        and score_type_from_record(best_record) == "centipawn"
        and abs(int(best_record.get("score_cp", 0) or 0)) <= BEST_UNIQUENESS_CP_CEILING
    ):
        key = "excellent"
        reason = "very close to best"

    try:
        move = chess.Move.from_uci(move_uci)
    except ValueError:
        move = None

    is_direct_checkmate = False
    after_board = None
    if move is not None:
        after_board = _board_after_move(board, move)
        if after_board is not None and after_board.is_checkmate():
            is_direct_checkmate = True
            key = "best"
            reason = "engine top move"

    if move is not None:
        if is_best_move and _consider_critical_classification(
            board,
            move_record,
            best_record,
            second_record,
            player_rating=player_rating,
        ):
            key = "great"
            only_move_keeps_advantage = True
            reason = "only move that keeps the advantage"
        gives_check = bool(after_board is not None and after_board.is_check())
        top_candidate_brilliant = (
            move_rank is not None
            and move_rank <= BRILLIANT_TOP_CANDIDATE_LIMIT
            and loss <= BRILLIANT_TOP_CANDIDATE_THRESHOLD
        )

        # Brilliant detection is the expensive path: it runs SEE and PV shape
        # checks. Gate it with cheap rank/loss/soundness tests so normal move
        # labels do not pay that cost.
        preliminary_brilliant_loss_limit = _brilliant_loss_limit(
            tactical_shape=False,
            gives_check=gives_check,
        )
        could_be_brilliant = (
            not is_direct_checkmate
            and move_expected >= BRILLIANT_SOUND_THRESHOLD
            and best_expected < BRILLIANT_ALREADY_WINNING_THRESHOLD
            and (
                is_best_move
                or loss <= preliminary_brilliant_loss_limit
                or top_candidate_brilliant
                or (
                    move_rank is not None
                    and move_rank <= BRILLIANT_TOP_CANDIDATE_LIMIT
                    and loss <= BRILLIANT_EXPANDED_THRESHOLD
                )
            )
        )
        brilliant_applied = False
        if could_be_brilliant:
            see_investment = _static_material_investment(board, move)
            real_piece_sacrifice = is_real_piece_sacrifice(
                board,
                move,
                after_board=after_board,
                see_investment=see_investment,
            )
            tactical_profile = _pv_tactical_profile(
                board,
                move_record,
                after_board=after_board,
                see_investment=see_investment,
            )
            tactical_brilliant_shape = _consider_brilliant_classification(
                board,
                move_record,
                second_record,
                move_rank=move_rank,
                loss=loss,
                tactical_profile=tactical_profile,
            )
            # SEE can spot that material is invested, but that alone is not enough
            # for Brilliant. A sacrifice still needs a confirming PV profile so
            # ordinary "best move, piece can be taken" positions do not flood the
            # Brilliant tracker with false positives.
            confirmed_real_sacrifice = real_piece_sacrifice and _pv_confirms_material_investment(
                board,
                move_record,
                tactical_profile=tactical_profile,
            )
            good_piece_sacrifice = bool(tactical_brilliant_shape or confirmed_real_sacrifice)
            brilliant_loss_limit = _brilliant_loss_limit(
                tactical_shape=tactical_brilliant_shape,
                gives_check=gives_check,
            )
            qualifies_for_brilliant = is_best_move or loss <= brilliant_loss_limit or top_candidate_brilliant
            already_winning = best_expected >= BRILLIANT_ALREADY_WINNING_THRESHOLD
            sound_enough = move_expected >= BRILLIANT_SOUND_THRESHOLD
            if qualifies_for_brilliant and good_piece_sacrifice and sound_enough and not already_winning:
                key = "brilliant"
                reason = "best or nearly-best move plus a good piece sacrifice"
                brilliant_applied = True
        if (
            not brilliant_applied
            and is_player_move
            and move_uci != best_record.get("uci")
            and _is_miss_position(
                best_expected=best_expected,
                move_expected=move_expected,
                loss=loss,
            )
            and _best_move_was_critical(board, best_record, second_record)
        ):
            key = "miss"
            reason = "misses the critical continuation"

    return _remember_classification(classification_payload(
        key,
        loss=loss,
        reason=reason,
        expected_points=move_expected,
        is_only_move_that_keeps_advantage=only_move_keeps_advantage,
        is_real_piece_sacrifice=bool(real_piece_sacrifice),
    ))


def annotate_candidate_classifications(
    board: chess.Board,
    candidate_lines: list[dict[str, Any]],
    *,
    opening_phase: bool = False,
    repeated_counts: dict[str, int] | None = None,
    popularity_by_uci: dict[str, float] | None = None,
    line_status: str = "",
    player_rating: int | None = None,
) -> list[dict[str, Any]]:
    if not candidate_lines:
        return candidate_lines
    repeated_counts = repeated_counts or {}
    popularity_by_uci = popularity_by_uci or {}
    best_record = candidate_lines[0]
    expected_points_by_index = [
        float(expected_points_from_record(line, player_rating=player_rating))
        for line in candidate_lines
    ]
    best_expected = expected_points_by_index[0]
    second_loss = 0.0
    if len(candidate_lines) > 1:
        second_loss = max(0.0, best_expected - expected_points_by_index[1])
    # The current Great/Miss rules compare top lines directly, so avoid a full
    # repeated "keeps advantage" pass over every candidate during hot UI refreshes.
    great_keeps_advantage_count = 0
    for index, (line, expected_points) in enumerate(zip(candidate_lines, expected_points_by_index), start=1):
        line["rank"] = index
        line["expected_points"] = round(expected_points, 4)
        line["expected_points_loss"] = round(max(0.0, best_expected - expected_points), 4)
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
            move_rank=int(line.get("rank", 0) or 0),
            player_rating=player_rating,
        )
        line["classification_label"] = line["classification"]["label"]
        line["classification_icon"] = line["classification"]["icon"]
    return candidate_lines
