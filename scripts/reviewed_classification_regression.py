from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
import sys
from typing import Any

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import chess
import chess.pgn

from bookup.analysis import (
    OPENING_PLIES,
    _book_state_for_line,
    _build_branch_line,
    _candidate_lines_for_board,
    _move_is_book_candidate,
)
from bookup.classifications import classify_move_record
from bookup.engine import EngineSession, EngineSettings, default_engine_path

REVIEWED_DIR = ROOT / "reviewed_games"


def _normalize_label(label: str) -> str:
    return str(label or "").strip().lower().replace(" ", "_")


def _load_fixture(path: Path) -> tuple[chess.pgn.Game, list[dict[str, Any]], str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    pgn_path = path.parent / str(data["pgn"])
    game = chess.pgn.read_game(io.StringIO(pgn_path.read_text(encoding="utf-8")))
    if game is None:
        raise ValueError(f"Could not parse PGN fixture: {pgn_path}")
    return game, list(data.get("expected", [])), str(data.get("name") or path.stem)


def _classify_played_move(
    board: chess.Board,
    move: chess.Move,
    engine: EngineSession,
    play_uci: list[str],
    *,
    multipv: int,
    time_sec: float,
    player_rating: int | None = None,
) -> dict[str, Any]:
    candidate_lines, _, _cache_hit = _candidate_lines_for_board(
        board,
        engine,
        play_uci=play_uci,
        limit=max(5, multipv),
        time_sec=time_sec,
        include_database=False,
    )
    if not candidate_lines:
        return {
            "actual": "unknown",
            "best": "",
            "loss": None,
            "source": "no_candidates",
            "san": board.san(move),
        }

    best_line = candidate_lines[0]
    played_san = board.san(move)
    played_line = next((line for line in candidate_lines if str(line.get("uci") or "") == move.uci()), None)
    if played_line is None:
        played_line = _build_branch_line(
            board,
            move.uci(),
            played_san,
            engine,
            source="reviewed-regression",
            time_sec=time_sec,
            popularity=0.0,
            repeated_count=0,
        )
    if played_line is None:
        return {
            "actual": "unknown",
            "best": str(best_line.get("classification", {}).get("key") or ""),
            "loss": None,
            "source": "illegal_or_unbuilt",
            "san": played_san,
        }

    second_record = candidate_lines[1] if len(candidate_lines) > 1 else None
    second_loss = float(second_record.get("expected_points_loss", 0.0) or 0.0) if second_record else 0.0
    book_state = _book_state_for_line(play_uci, board)
    classification = classify_move_record(
        board,
        played_line,
        best_line,
        second_record=second_record,
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
    return {
        "actual": str(classification.get("key") or ""),
        "best": str(best_line.get("classification", {}).get("key") or ""),
        "loss": float(classification.get("expected_points_loss", 0.0) or 0.0),
        "rank": int(played_line.get("rank", 0) or 0) or None,
        "score_cp": int(played_line.get("score_cp", 0) or 0),
        "best_score_cp": int(best_line.get("score_cp", 0) or 0),
        "source": "candidate" if any(str(line.get("uci") or "") == move.uci() for line in candidate_lines) else "branch",
        "san": played_san,
        "classification": classification,
    }


def _rating_from_game_headers(game: chess.pgn.Game, color: chess.Color) -> int | None:
    key = "WhiteElo" if color == chess.WHITE else "BlackElo"
    raw = str(game.headers.get(key, "") or "").strip()
    if not raw:
        return None
    try:
        value = int(float(raw))
    except ValueError:
        return None
    return value if value > 0 else None


def run_fixture(path: Path, *, depth: int, multipv: int, time_sec: float) -> int:
    game, expected_rows, title = _load_fixture(path)
    board = game.board()
    moves = list(game.mainline_moves())
    play_uci: list[str] = []

    engine_path = default_engine_path()
    if not engine_path:
        raise RuntimeError("No Stockfish path could be found for regression testing.")

    settings = EngineSettings(
        path=engine_path,
        depth=depth,
        threads=4,
        hash_mb=1024,
        multipv=multipv,
        think_time_sec=time_sec,
        parallel_workers=1,
    )

    print(f"\n=== {title} ===")
    print(f"Depth {depth} | MultiPV {multipv} | {time_sec:.1f}s\n")

    mismatches = 0
    with EngineSession(settings) as engine:
        for index, move in enumerate(moves):
            if index >= len(expected_rows):
                break
            expected = expected_rows[index]
            player_rating = _rating_from_game_headers(game, board.turn)
            actual = _classify_played_move(
                board,
                move,
                engine,
                play_uci,
                multipv=multipv,
                time_sec=time_sec,
                player_rating=player_rating,
            )
            expected_label = _normalize_label(expected.get("label", ""))
            actual_label = _normalize_label(actual.get("actual", ""))
            ply = int(expected.get("ply", index + 1))
            san = str(expected.get("san") or actual.get("san") or "")
            match = expected_label == actual_label
            if not match:
                mismatches += 1
            loss_text = "--" if actual.get("loss") is None else f"{float(actual['loss']):.4f}"
            rank_text = "--" if actual.get("rank") is None else str(int(actual["rank"]))
            cp_text = f"{int(actual.get('score_cp', 0)):+d}/{int(actual.get('best_score_cp', 0)):+d}"
            marker = "OK " if match else "MIS"
            print(
                f"{marker} ply {ply:>2} {san:<8} expected={expected_label:<11} "
                f"actual={actual_label:<11} best={_normalize_label(actual.get('best', '')):<11} "
                f"loss={loss_text:<8} rank={rank_text:<3} cp={cp_text:<13} rating={str(player_rating or '--'):<5} source={actual.get('source', '')}"
            )
            play_uci.append(move.uci())
            board.push(move)

    print(f"\nMismatches: {mismatches}/{min(len(moves), len(expected_rows))}\n")
    return mismatches


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Bookup classification regression against reviewed games.")
    parser.add_argument("--fixture", default="", help="Optional path to one labels.json fixture.")
    parser.add_argument("--depth", type=int, default=20)
    parser.add_argument("--multipv", type=int, default=5)
    parser.add_argument("--time", type=float, default=1.5, dest="time_sec")
    args = parser.parse_args()

    if args.fixture:
        fixtures = [Path(args.fixture).resolve()]
    else:
        fixtures = sorted(REVIEWED_DIR.glob("*.labels.json"))
    if not fixtures:
        print("SKIP reviewed classification regression: no reviewed game fixtures found.")
        return 0

    total_mismatches = 0
    for fixture in fixtures:
        total_mismatches += run_fixture(
            fixture,
            depth=args.depth,
            multipv=args.multipv,
            time_sec=args.time_sec,
        )
    raise SystemExit(1 if total_mismatches else 0)


if __name__ == "__main__":
    main()
