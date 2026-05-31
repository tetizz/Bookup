"""Smart Theory regression smoke test.

Run from repo root:
  py scripts/smart_theory_regression.py
"""

from __future__ import annotations

import time
from itertools import product
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from bookup.app import app


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
        "cache_evaluations": True,
    }

    if source == "custom_fen":
        payload["fen"] = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    if source in {"saved_line", "selected_move", "imported_pgn"}:
        payload["start_play_uci"] = ["e2e4", "e7e5", "g1f3"]

    start = client.post("/api/generate-smart-theory", json=payload)
    _check("start_202", start.status_code == 202, start.status_code)

    terminal = ""
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
            break
        time.sleep(0.1)

    _check("terminal_ok", terminal in {"complete", "stopped"}, terminal or "none")
    _check("saw_partial", saw_partial, source)

    result_resp = client.get(f"/api/smart-theory-result/{job_id}")
    result = result_resp.get_json() or {}
    _check("result_200", result_resp.status_code == 200, result_resp.status_code)
    _check("nodes_present", isinstance(result.get("nodes"), list) and len(result["nodes"]) >= 1, type(result.get("nodes")).__name__)
    _check("nodes_total_present", "nodes_total" in result, "nodes_total")
    _check("duration_present", "generation_seconds" in result, "generation_seconds")


def main() -> None:
    with app.test_client() as client:
        _check("legal_moves", client.post("/api/legal-moves", json={"fen": "startpos"}).status_code == 200)
        _check("apply_move", client.post("/api/apply-move", json={"fen": "startpos", "move_uci": "e2e4"}).status_code == 200)

        sources = [
            "starting_position",
            "current_board",
            "custom_fen",
            "saved_line",
            "selected_move",
            "imported_pgn",
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
            },
        )
        _check("stop_start_202", stop_start.status_code == 202, stop_start.status_code)
        time.sleep(0.4)
        stop_req = client.post("/api/stop-smart-theory", json={"job_id": stop_id})
        _check("stop_req_200", stop_req.status_code == 200, stop_req.status_code)

        stop_terminal = ""
        for _ in range(140):
            status = (client.get(f"/api/smart-theory-status/{stop_id}").get_json() or {})
            phase = str(status.get("status", "")).lower()
            if phase in {"complete", "stopped", "error"}:
                stop_terminal = phase
                break
            time.sleep(0.1)
        _check("stop_terminal_ok", stop_terminal in {"stopped", "complete"}, stop_terminal or "none")

    print("ALL SMART THEORY REGRESSION CHECKS PASSED")


if __name__ == "__main__":
    main()
