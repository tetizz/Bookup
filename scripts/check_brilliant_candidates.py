from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path
from typing import Any

import chess
import chess.pgn

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from bookup.analysis import (
    OPENING_PLIES,
    _book_state_for_line,
    _build_branch_line,
    _candidate_lines_for_board,
    _move_is_book_candidate,
)
from bookup.classifications import classify_move_record
from bookup.engine import EngineSession, EngineSettings, default_engine_path


def _normalize_key(value: str) -> str:
    return str(value or "").strip().lower().replace(" ", "_")


def _rating_from_headers(game: chess.pgn.Game, color: chess.Color) -> int | None:
    key = "WhiteElo" if color == chess.WHITE else "BlackElo"
    raw = str(game.headers.get(key, "") or "").strip()
    if not raw:
        return None
    try:
        value = int(float(raw))
    except ValueError:
        return None
    return value if value > 0 else None


def _load_games_from_text(text: str) -> list[chess.pgn.Game]:
    stream = io.StringIO(text)
    games: list[chess.pgn.Game] = []
    while True:
        game = chess.pgn.read_game(stream)
        if game is None:
            break
        games.append(game)
    return games


def _read_pgn_text(path: str | None) -> str:
    if path:
        requested = Path(path)
        if not requested.exists():
            hint = ""
            normalized = str(requested).lower().replace("/", "\\")
            if normalized in {
                "c:\\path\\to\\game.pgn",
                "\\path\\to\\game.pgn",
            }:
                hint = (
                    "\nYou used the example placeholder path. Replace it with a real PGN file path, "
                    "or pipe a PGN into stdin."
                )
            raise FileNotFoundError(
                f"PGN file not found: {requested}{hint}"
            )
        return requested.read_text(encoding="utf-8")
    text = sys.stdin.read()
    if not text.strip():
        raise ValueError("No PGN text was provided. Pass --pgn or pipe PGN text through stdin.")
    return text


def _player_color_for_game(game: chess.pgn.Game, username: str | None, side: str | None) -> chess.Color:
    if side:
        return chess.WHITE if side == "white" else chess.BLACK
    normalized_username = str(username or "").strip().lower()
    white = str(game.headers.get("White", "") or "").strip().lower()
    black = str(game.headers.get("Black", "") or "").strip().lower()
    if normalized_username:
        if white == normalized_username:
            return chess.WHITE
        if black == normalized_username:
            return chess.BLACK
        raise ValueError(
            f"Username '{username}' did not match White='{game.headers.get('White', '')}' "
            f"or Black='{game.headers.get('Black', '')}'."
        )
    return chess.WHITE


def _classify_played_move(
    board: chess.Board,
    move: chess.Move,
    *,
    engine: EngineSession,
    play_uci: list[str],
    time_sec: float,
    multipv: int,
    player_rating: int | None,
) -> dict[str, Any]:
    candidate_lines, _, _cache_hit = _candidate_lines_for_board(
        board,
        engine,
        play_uci=play_uci,
        limit=max(10, multipv),
        time_sec=time_sec,
        include_database=False,
    )
    if not candidate_lines:
        return {
            "key": "unknown",
            "label": "Unknown",
            "expected_points_loss": None,
            "reason": "no candidate lines were available",
            "candidate_rank": None,
            "candidate_count": 0,
            "played_san": board.san(move),
            "best_san": "",
            "best_score_cp": None,
            "score_cp": None,
            "source": "no_candidates",
        }

    played_san = board.san(move)
    best_line = candidate_lines[0]
    played_line = next((line for line in candidate_lines if str(line.get("uci") or "") == move.uci()), None)
    source = "candidate"
    if played_line is None:
        source = "branch"
        played_line = _build_branch_line(
            board,
            move.uci(),
            played_san,
            engine,
            source="standalone-brilliant-check",
            time_sec=time_sec,
            popularity=0.0,
            repeated_count=0,
        )
    if played_line is None:
        return {
            "key": "unknown",
            "label": "Unknown",
            "expected_points_loss": None,
            "reason": "move could not be analyzed",
            "candidate_rank": None,
            "candidate_count": len(candidate_lines),
            "played_san": played_san,
            "best_san": str(best_line.get("move") or ""),
            "best_score_cp": best_line.get("score_cp"),
            "score_cp": None,
            "source": "unbuilt",
        }

    second_line = candidate_lines[1] if len(candidate_lines) > 1 else None
    second_loss = float(second_line.get("expected_points_loss", 0.0) or 0.0) if second_line else 0.0
    book_state = _book_state_for_line(play_uci, board)
    classification = classify_move_record(
        board,
        played_line,
        best_line,
        second_record=second_line,
        second_loss=second_loss,
        is_player_move=True,
        opening_phase=bool(book_state.get("active")) and len(play_uci) < OPENING_PLIES,
        in_book=_move_is_book_candidate(
            board,
            move.uci(),
            book_state=book_state,
            popularity_by_uci={},
            repeated_count=0,
            move_rank=int(played_line.get("rank", 0) or 0) or None,
        ),
        move_rank=int(played_line.get("rank", 0) or 0) or None,
        player_rating=player_rating,
    )
    key = _normalize_key(classification.get("key", ""))
    return {
        "key": key,
        "label": str(classification.get("label") or key.title()),
        "expected_points_loss": classification.get("expected_points_loss"),
        "expected_points": classification.get("expected_points"),
        "reason": classification.get("reason"),
        "candidate_rank": int(played_line.get("rank", 0) or 0) or None,
        "candidate_count": len(candidate_lines),
        "played_san": played_san,
        "played_uci": move.uci(),
        "best_san": str(best_line.get("move") or ""),
        "best_uci": str(best_line.get("uci") or ""),
        "best_score_cp": best_line.get("score_cp"),
        "score_cp": played_line.get("score_cp"),
        "source": source,
        "line_san": str((played_line or {}).get("line_san", "") or ""),
    }


def _analyze_game(
    game: chess.pgn.Game,
    *,
    engine: EngineSession,
    username: str | None,
    side: str | None,
    time_sec: float,
    multipv: int,
    max_plies: int,
    only_keys: set[str],
    show_all: bool,
) -> dict[str, Any]:
    player_color = _player_color_for_game(game, username, side)
    player_rating = _rating_from_headers(game, player_color)
    board = game.board()
    play_uci: list[str] = []
    results: list[dict[str, Any]] = []
    label_counts: dict[str, int] = {}
    total_player_moves = 0

    for ply_index, move in enumerate(game.mainline_moves(), start=1):
        if max_plies > 0 and ply_index > max_plies:
            break
        if board.turn == player_color:
            total_player_moves += 1
            entry = _classify_played_move(
                board,
                move,
                engine=engine,
                play_uci=play_uci,
                time_sec=time_sec,
                multipv=multipv,
                player_rating=player_rating,
            )
            entry.update(
                {
                    "ply": ply_index,
                    "move_number": (ply_index + 1) // 2,
                    "side": "white" if player_color == chess.WHITE else "black",
                }
            )
            label_counts[entry["key"]] = int(label_counts.get(entry["key"], 0)) + 1
            if show_all or entry["key"] in only_keys:
                results.append(entry)
        play_uci.append(move.uci())
        board.push(move)

    return {
        "event": str(game.headers.get("Event", "") or ""),
        "site": str(game.headers.get("Site", "") or ""),
        "date": str(game.headers.get("Date", "") or ""),
        "white": str(game.headers.get("White", "") or ""),
        "black": str(game.headers.get("Black", "") or ""),
        "result": str(game.headers.get("Result", "") or ""),
        "link": str(game.headers.get("Link", "") or ""),
        "player_side": "white" if player_color == chess.WHITE else "black",
        "player_rating": player_rating,
        "total_player_moves": total_player_moves,
        "label_counts": dict(sorted(label_counts.items())),
        "moves": results,
    }


def _print_report(report: list[dict[str, Any]]) -> None:
    for index, game in enumerate(report, start=1):
        title = f"{game['white']} vs {game['black']} · {game['date'] or '?'}"
        print(f"\n=== Game {index}: {title} ===")
        if game.get("link"):
            print(game["link"])
        label_counts = dict(game.get("label_counts") or {})
        summary_chunks = [f"{key}={value}" for key, value in label_counts.items()]
        summary_text = ", ".join(summary_chunks) if summary_chunks else "no player moves analyzed"
        print(
            f"Player side: {game.get('player_side', '?')} | "
            f"Rating: {game.get('player_rating') or '--'} | "
            f"Moves analyzed: {game.get('total_player_moves', 0)}"
        )
        print(f"Label counts: {summary_text}")
        moves = list(game.get("moves") or [])
        if not moves:
            print("No matching moves.")
            continue
        for row in moves:
            loss = row.get("expected_points_loss")
            loss_text = "--" if loss is None else f"{float(loss):.4f}"
            rank = row.get("candidate_rank")
            rank_text = "--" if rank is None else str(rank)
            print(
                f"ply {row['ply']:>2} {row['played_san']:<8} -> {row['key']:<11} "
                f"loss={loss_text:<8} rank={rank_text:<3} best={row['best_san']}"
            )
            print(f"  reason: {row.get('reason', '')}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run Bookup's current engine-only classifier against one or more PGNs."
    )
    parser.add_argument("--pgn", default="", help="Path to a PGN file. If omitted, PGN is read from stdin.")
    parser.add_argument("--username", default="", help="Username to match against White/Black headers.")
    parser.add_argument("--side", choices=["white", "black"], default="", help="Force the side to analyze.")
    parser.add_argument("--depth", type=int, default=26)
    parser.add_argument("--multipv", type=int, default=10)
    parser.add_argument("--time", type=float, default=5.0, dest="time_sec")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--hash-mb", type=int, default=1024, dest="hash_mb")
    parser.add_argument("--max-plies", type=int, default=0, help="Optional ply limit (0 means all plies).")
    parser.add_argument(
        "--only",
        default="brilliant",
        help="Comma-separated keys to print (default: brilliant). Use --show-all to print every player move.",
    )
    parser.add_argument("--show-all", action="store_true", help="Print every player move instead of only selected keys.")
    parser.add_argument("--json-out", default="", help="Optional path to save the full JSON report.")
    args = parser.parse_args()

    pgn_text = _read_pgn_text(args.pgn or None)
    games = _load_games_from_text(pgn_text)
    if not games:
        raise SystemExit("No PGN games could be parsed from the provided input.")

    engine_path = default_engine_path()
    if not engine_path:
        raise SystemExit("No Stockfish executable could be found. Set your engine path first.")

    only_keys = {_normalize_key(item) for item in str(args.only or "").split(",") if item.strip()}
    settings = EngineSettings(
        path=engine_path,
        depth=max(1, int(args.depth)),
        threads=max(1, int(args.threads)),
        hash_mb=max(64, int(args.hash_mb)),
        multipv=max(1, int(args.multipv)),
        think_time_sec=max(0.1, float(args.time_sec)),
        parallel_workers=1,
    )

    report: list[dict[str, Any]] = []
    with EngineSession(settings) as engine:
        for game in games:
            report.append(
                _analyze_game(
                    game,
                    engine=engine,
                    username=str(args.username or "").strip() or None,
                    side=str(args.side or "").strip() or None,
                    time_sec=float(args.time_sec),
                    multipv=max(1, int(args.multipv)),
                    max_plies=max(0, int(args.max_plies)),
                    only_keys=only_keys,
                    show_all=bool(args.show_all),
                )
            )

    if args.json_out:
        output_path = Path(args.json_out)
        output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Wrote JSON report to {output_path}")
    else:
        _print_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
