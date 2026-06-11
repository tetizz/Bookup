from __future__ import annotations

import tempfile
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from bookup.progress_tracker import (
    accuracy_payload,
    build_goals,
    build_progress_payload,
    build_projection,
    load_progress_state,
    save_progress_state,
    save_session,
)


def require(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"PASS {label}")


def fallback_profile() -> dict:
    return {
        "mode": "rapid",
        "rating": 1499,
        "wins": 589,
        "draws": 57,
        "losses": 450,
        "total_games": 1096,
        "win_rate": 53.7,
        "score_percentage": 56.3,
        "recent": {"win_rate": 43.3, "score_percentage": 48.3},
        "duration_summary": {
            "average": 8.8,
            "shortest": 1.0,
            "longest": 18.8,
            "games_used": 30,
            "sample_warning": False,
        },
        "accuracy": accuracy_payload({"accuracy": {}}, 79.13),
    }


def test_projection_deduplicates_custom_presets() -> None:
    data = {
        "settings": {
            "custom_games": 538,
            "dropoff_table": [],
        }
    }
    result = build_projection(data, fallback_profile())
    require([item["games"] for item in result["simple"]] == [538, 1000], "projection_counts_unique")
    require([item["games"] for item in result["time"]] == [538, 1000], "time_counts_unique")
    require(result["time"][1]["max_minutes"] == 20_000, "thousand_games_twenty_thousand_minutes")


def test_rating_goal_uses_visible_progress() -> None:
    goals = build_goals(fallback_profile())
    rating_goal = next(item for item in goals if item["label"] == "1600 rating")
    require(rating_goal["progress"] == 93.7, "rating_goal_progress")


def test_manual_phase_values_are_not_measured() -> None:
    payload = accuracy_payload(
        {"accuracy": {"average": 74.18, "opening": 85.1, "middlegame": 71.1, "endgame": 77.2}},
        79.13,
    )
    require(payload["average_is_measured"] is True, "live_average_measured")
    require(payload["phase_is_measured"] is False, "manual_phases_not_measured")
    require(payload["phase_source"] == "manual_fallback", "manual_phase_source")


def test_session_phase_values_round_trip() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        username = "input-username"
        state = load_progress_state(root, username)
        save_progress_state(root, username, state)
        saved = save_session(
            root,
            username,
            {
                "date": "2026-06-11",
                "mode": "rapid",
                "start_rating": 1500,
                "end_rating": 1510,
                "wins": 2,
                "draws": 1,
                "losses": 1,
                "accuracy": 77.5,
                "opening_accuracy": 82.0,
                "middlegame_accuracy": 74.0,
                "endgame_accuracy": 79.0,
            },
        )
        accuracy = saved["profile"]["accuracy"]
        require(accuracy["average_source"] == "session", "session_average_source")
        require(accuracy["phase_is_measured"] is True, "session_phases_measured")
        require(accuracy["middlegame"] == 74.0, "session_phase_round_trip")
        rebuilt = build_progress_payload(root, username, mode="rapid")
        require(len(rebuilt["charts"]["phase_accuracy"]) == 1, "session_phase_chart_point")


def main() -> None:
    test_projection_deduplicates_custom_presets()
    test_rating_goal_uses_visible_progress()
    test_manual_phase_values_are_not_measured()
    test_session_phase_values_round_trip()
    print("ALL PRODUCT REGRESSION CHECKS PASSED")


if __name__ == "__main__":
    main()
