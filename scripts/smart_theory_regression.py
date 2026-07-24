"""Smart Theory regression smoke test.

Run from repo root:
  py scripts/smart_theory_regression.py
"""

from __future__ import annotations

import time
from itertools import product
from pathlib import Path
import sys
from unittest.mock import patch
import chess
import chess.engine

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from bookup.app import app


class _DeterministicEngineSettings:
    """Small, machine-independent settings surface used by the regression engine."""

    depth = 10
    think_time_sec = 0.01


class _DeterministicEngine:
    """Legal, deterministic analysis fixture for the Smart Theory API regression.

    Stockfish availability is a packaging concern covered by the release workflow.
    This suite exercises the asynchronous API and the full tree generator on every
    runner, so it uses a stable engine fixture instead of relying on a binary that
    may or may not be installed on the CI host.
    """

    settings = _DeterministicEngineSettings()
    worker_count = 1

    _PREFERRED_MOVES = (
        "e2e4",
        "e7e5",
        "d2d4",
        "d7d5",
        "g1f3",
        "g8f6",
        "c2c4",
        "c7c5",
        "b1c3",
        "b8c6",
        "f1b5",
        "f8b4",
        "f1c4",
        "f8c5",
        "g2g3",
        "g7g6",
        "f1g2",
        "f8g7",
        "e1g1",
        "e8g8",
    )
    _PIECE_VALUES = {
        chess.PAWN: 100,
        chess.KNIGHT: 320,
        chess.BISHOP: 330,
        chess.ROOK: 500,
        chess.QUEEN: 900,
        chess.KING: 0,
    }

    @classmethod
    def _ordered_moves(cls, board: chess.Board) -> list[chess.Move]:
        legal = list(board.legal_moves)
        preference = {uci: index for index, uci in enumerate(cls._PREFERRED_MOVES)}

        def move_key(move: chess.Move) -> tuple[int, int, int, int, str]:
            preferred_index = preference.get(move.uci(), len(preference))
            return (
                preferred_index,
                -int(bool(move.promotion)),
                -int(board.is_capture(move)),
                -int(board.gives_check(move)),
                move.uci(),
            )

        return sorted(legal, key=move_key)

    @classmethod
    def _material_score(cls, board: chess.Board) -> int:
        return sum(
            value * (len(board.pieces(piece_type, chess.WHITE)) - len(board.pieces(piece_type, chess.BLACK)))
            for piece_type, value in cls._PIECE_VALUES.items()
        )

    def analyse(
        self,
        board: chess.Board,
        *,
        depth: int,
        multipv: int,
        time_sec: float | None = None,
    ) -> list[dict]:
        del depth, time_sec
        candidates = self._ordered_moves(board)[: max(1, int(multipv))]
        lines: list[dict] = []
        for index, first_move in enumerate(candidates):
            cursor = board.copy(stack=False)
            cursor.push(first_move)
            score_cp = self._material_score(cursor)
            score_cp += (24 - (index * 8)) if board.turn == chess.WHITE else (-24 + (index * 8))

            pv = [first_move]
            for _ in range(2):
                replies = self._ordered_moves(cursor)
                if not replies:
                    break
                reply = replies[0]
                pv.append(reply)
                cursor.push(reply)

            lines.append(
                {
                    "pv": pv,
                    "score": chess.engine.PovScore(chess.engine.Cp(score_cp), chess.WHITE),
                }
            )
        return lines


def _deterministic_database_context(
    board: chess.Board,
    *,
    play_uci: list[str],
    limit: int,
) -> dict:
    """Stable local move statistics, independent of a developer's saved games."""

    del play_uci
    moves = _DeterministicEngine._ordered_moves(board)[: max(1, int(limit))]
    return {
        "database_moves": [
            {
                "uci": move.uci(),
                "popularity": max(1.0, 42.0 - (index * 3.0)),
                "games": max(1, 4200 - (index * 250)),
            }
            for index, move in enumerate(moves)
        ]
    }


def _check(name: str, condition: bool, detail: object = "") -> None:
    if condition:
        print(f"PASS {name}")
        return
    raise RuntimeError(f"FAIL {name}: {detail}")


def _run_case(client, source: str, accuracy: str, case_id: int) -> None:
    job_id = f"reg-{case_id}-{int(time.time() * 1000)}"
    payload = {
        "job_id": job_id,
        "fen": "startpos",
        "starting_source": source,
        "my_color": "white",
        "opponent_accuracy": accuracy,
        "depth": 10,
        "engine_movetime_sec": 0.12,
        "opponent_replies": 2,
        "max_ply": 6,
        "max_positions": 32,
        "include_rare_sidelines": True,
        "include_opponent_mistakes": True,
        "include_opponent_blunders": True,
        "avoid_absurd_moves": True,
        "eco_only_mode": False,
        # Never mix deterministic fixture evaluations into the user's real
        # Stockfish cache when this smoke test is run from a working checkout.
        "cache_evaluations": False,
    }
    source_context = {
        "type": source,
        "id": "" if source == "current_board" else f"{source}-fixture",
        "label": {
            "current_board": "Current board",
            "saved_line": "My saved line",
            "imported_game": "My imported game",
            "my_repertoire": "My repertoire",
        }[source],
        "fen": chess.STARTING_FEN,
        "moves_uci": [],
        "player_color": "white",
    }
    if source == "saved_line":
        source_context["moves_uci"] = ["e2e4", "e7e5", "g1f3"]
    elif source == "imported_game":
        source_context["pgn"] = "1. d4 Nf6 2. Nf3 g6 3. g3 *"
    elif source == "my_repertoire":
        source_context["moves_uci"] = ["g1f3"]
    payload["source_context"] = source_context

    start = client.post("/api/generate-smart-theory", json=payload)
    _check("start_202", start.status_code == 202, start.status_code)

    terminal = ""
    terminal_status: dict = {}
    saw_partial = False
    for _ in range(240):
        status_resp = client.get(f"/api/smart-theory-status/{job_id}")
        if status_resp.status_code != 200:
            time.sleep(0.1)
            continue
        status = status_resp.get_json() or {}
        phase = str(status.get("status", "")).lower()
        if isinstance(status.get("partial_nodes"), list) and status["partial_nodes"]:
            saw_partial = True
        if phase in {"complete", "stopped", "error"}:
            terminal = phase
            terminal_status = status
            break
        time.sleep(0.1)

    terminal_detail = (
        terminal_status.get("error")
        or terminal_status.get("message")
        or terminal
        or "none"
    )
    _check("terminal_ok", terminal in {"complete", "stopped"}, terminal_detail)
    _check("saw_partial", saw_partial, source)

    result_resp = client.get(f"/api/smart-theory-result/{job_id}")
    result = result_resp.get_json() or {}
    _check("result_200", result_resp.status_code == 200, result_resp.status_code)
    _check("nodes_present", isinstance(result.get("nodes"), list) and len(result["nodes"]) >= 1, type(result.get("nodes")).__name__)
    _check("nodes_total_present", "nodes_total" in result, "nodes_total")
    _check("duration_present", "generation_seconds" in result, "generation_seconds")
    by_id = {str(node.get("id")): node for node in result["nodes"]}
    for node in result["nodes"]:
        if not node.get("parentId"):
            _check("root_fen_stable", node.get("fenBefore") == source_context["fen"] == node.get("fenAfter"), node)
            continue
        parent = by_id[str(node["parentId"])]
        board = chess.Board(str(node["fenBefore"]))
        move = chess.Move.from_uci(str(node["uci"]))
        _check("edge_parent_fen", str(node["fenBefore"]) == str(parent["fenAfter"]), node["id"])
        _check("edge_legal", move in board.legal_moves, node["id"])
        board.push(move)
        _check("edge_fen_after", board.fen() == str(node["fenAfter"]), node["id"])


def main() -> None:
    deterministic_engine = _DeterministicEngine()
    with (
        patch("bookup.app.shared_engine_for", return_value=deterministic_engine),
        patch("bookup.analysis.database_context_for_board", side_effect=_deterministic_database_context),
        app.test_client() as client,
    ):
        _check("legal_moves", client.post("/api/legal-moves", json={"fen": "startpos"}).status_code == 200)
        _check("apply_move", client.post("/api/apply-move", json={"fen": "startpos", "move_uci": "e2e4"}).status_code == 200)

        sources = [
            "current_board",
            "saved_line",
            "imported_game",
            "my_repertoire",
        ]
        accuracies = ["mixed", "grandmaster", "club", "beginner_intermediate"]
        case_id = 0
        for source, accuracy in product(sources, accuracies):
            case_id += 1
            print(f"CASE {source} / {accuracy}")
            _run_case(client, source, accuracy, case_id)

        stop_id = f"reg-stop-{int(time.time() * 1000)}"
        stop_start = client.post(
            "/api/generate-smart-theory",
            json={
                "job_id": stop_id,
                "fen": "startpos",
                "my_color": "white",
                "opponent_accuracy": "mixed",
                "depth": 12,
                "engine_movetime_sec": 0.6,
                "opponent_replies": 3,
                "max_ply": 16,
                "max_positions": 220,
                "cache_evaluations": False,
            },
        )
        _check("stop_start_202", stop_start.status_code == 202, stop_start.status_code)
        time.sleep(0.4)
        stop_req = client.post("/api/stop-smart-theory", json={"job_id": stop_id})
        _check("stop_req_200", stop_req.status_code == 200, stop_req.status_code)

        stop_terminal = ""
        stop_status: dict = {}
        for _ in range(140):
            status = (client.get(f"/api/smart-theory-status/{stop_id}").get_json() or {})
            stop_status = status
            phase = str(status.get("status", "")).lower()
            if phase in {"complete", "stopped", "error"}:
                stop_terminal = phase
                break
            time.sleep(0.1)
        stop_message = (
            stop_status.get("error")
            or stop_status.get("message")
            or stop_terminal
            or "none"
        )
        stop_detail = (
            f"{stop_message} "
            f"({stop_status.get('positions_done', 0)}/{stop_status.get('positions_total', 0)})"
        )
        _check("stop_terminal_ok", stop_terminal in {"stopped", "complete"}, stop_detail)

    print("ALL SMART THEORY REGRESSION CHECKS PASSED")


if __name__ == "__main__":
    main()
