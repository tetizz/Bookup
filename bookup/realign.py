from __future__ import annotations

from collections import defaultdict
from typing import Iterable

import chess


START_FEN = chess.STARTING_FEN

PIECE_NAMES = {
    "P": "White pawn",
    "N": "White knight",
    "B": "White bishop",
    "R": "White rook",
    "Q": "White queen",
    "K": "White king",
    "p": "Black pawn",
    "n": "Black knight",
    "b": "Black bishop",
    "r": "Black rook",
    "q": "Black queen",
    "k": "Black king",
}

PIECE_ORDER = {symbol: index for index, symbol in enumerate("KQRBNPkqrbnp")}


def _normalize_fen(fen: str) -> str:
    value = str(fen or "").strip()
    if not value:
        return START_FEN
    board = chess.Board(value)
    return board.fen()


def _piece_squares(board: chess.Board) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    for square, piece in board.piece_map().items():
        grouped[piece.symbol()].append(chess.square_name(square))
    for squares in grouped.values():
        squares.sort(key=_square_sort_key)
    return dict(grouped)


def _square_sort_key(square: str) -> tuple[int, int]:
    file_index = ord(square[0]) - ord("a")
    rank_index = 8 - int(square[1])
    return (rank_index, file_index)


def _manhattan_distance(source: str, target: str) -> int:
    source_file = ord(source[0]) - ord("a")
    source_rank = int(source[1]) - 1
    target_file = ord(target[0]) - ord("a")
    target_rank = int(target[1]) - 1
    return abs(source_file - target_file) + abs(source_rank - target_rank)


def _pair_moves(source_squares: list[str], target_squares: list[str]) -> tuple[list[tuple[str, str]], list[str], list[str]]:
    moves: list[tuple[str, str]] = []
    remaining_source = sorted(source_squares, key=_square_sort_key)
    remaining_target = sorted(target_squares, key=_square_sort_key)
    while remaining_source and remaining_target:
        best_pair: tuple[str, str] | None = None
        best_key: tuple[int, tuple[int, int], tuple[int, int]] | None = None
        for source in remaining_source:
            for target in remaining_target:
                key = (
                    _manhattan_distance(source, target),
                    _square_sort_key(source),
                    _square_sort_key(target),
                )
                if best_key is None or key < best_key:
                    best_key = key
                    best_pair = (source, target)
        assert best_pair is not None
        source, target = best_pair
        moves.append((source, target))
        remaining_source.remove(source)
        remaining_target.remove(target)
    return moves, remaining_source, remaining_target


def _build_steps(kind: str, symbol: str, squares: Iterable[str] | Iterable[tuple[str, str]]) -> list[dict[str, str]]:
    piece_name = PIECE_NAMES.get(symbol, symbol)
    steps: list[dict[str, str]] = []
    if kind == "move":
        for source, target in squares:  # type: ignore[misc]
            steps.append(
                {
                    "kind": "move",
                    "piece": piece_name,
                    "piece_symbol": symbol,
                    "from": source,
                    "to": target,
                    "text": f"Move {piece_name} from {source} to {target}.",
                }
            )
    elif kind == "remove":
        for square in squares:  # type: ignore[assignment]
            steps.append(
                {
                    "kind": "remove",
                    "piece": piece_name,
                    "piece_symbol": symbol,
                    "square": square,
                    "text": f"Remove {piece_name} from {square}.",
                }
            )
    elif kind == "place":
        for square in squares:  # type: ignore[assignment]
            steps.append(
                {
                    "kind": "place",
                    "piece": piece_name,
                    "piece_symbol": symbol,
                    "square": square,
                    "text": f"Place {piece_name} on {square}.",
                }
            )
    return steps


def build_realign_plan(source_fen: str, target_fen: str, target_label: str = "") -> dict[str, object]:
    source_board = chess.Board(_normalize_fen(source_fen))
    target_board = chess.Board(_normalize_fen(target_fen))
    source_map = _piece_squares(source_board)
    target_map = _piece_squares(target_board)

    unchanged_count = 0
    move_steps: list[dict[str, str]] = []
    remove_steps: list[dict[str, str]] = []
    place_steps: list[dict[str, str]] = []

    all_symbols = sorted(set(source_map) | set(target_map), key=lambda symbol: PIECE_ORDER.get(symbol, 99))
    for symbol in all_symbols:
        source_squares = list(source_map.get(symbol, []))
        target_squares = list(target_map.get(symbol, []))
        shared = sorted(set(source_squares) & set(target_squares), key=_square_sort_key)
        unchanged_count += len(shared)
        source_only = [square for square in source_squares if square not in shared]
        target_only = [square for square in target_squares if square not in shared]
        moves, extra_source, extra_target = _pair_moves(source_only, target_only)
        move_steps.extend(_build_steps("move", symbol, moves))
        remove_steps.extend(_build_steps("remove", symbol, sorted(extra_source, key=_square_sort_key)))
        place_steps.extend(_build_steps("place", symbol, sorted(extra_target, key=_square_sort_key)))

    total_actions = len(move_steps) + len(remove_steps) + len(place_steps)
    return {
        "source_fen": source_board.fen(),
        "target_fen": target_board.fen(),
        "target_label": str(target_label or "").strip(),
        "unchanged_count": unchanged_count,
        "source_piece_count": len(source_board.piece_map()),
        "target_piece_count": len(target_board.piece_map()),
        "move_steps": move_steps,
        "remove_steps": remove_steps,
        "place_steps": place_steps,
        "total_actions": total_actions,
        "already_aligned": total_actions == 0,
    }
