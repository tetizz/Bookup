"""Bookup API smoke coverage for tab-critical workflows.

Run from repo root:
  py scripts/bookup_api_smoke.py
"""

from __future__ import annotations

import sys
import io
import json
import os
from pathlib import Path
from unittest.mock import patch

import chess

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from bookup.analysis import _first_move_repertoire, _move_reaction_for_board, generate_smart_theory_tree
from bookup.app import DATA_DIR, app, import_games_from_pgn_text
from bookup.chesscom import ImportedGame
from bookup.progress_tracker import progress_path


def _check(name: str, condition: bool, detail: object = "") -> None:
    if condition:
        print(f"PASS {name}")
        return
    raise RuntimeError(f"FAIL {name}: {detail}")


def _sample_profile_payload() -> dict:
    return {
        "summary": {
            "total_positions": 1,
            "needs_work": 0,
            "known_positions": 1,
        },
        "trainer_queue_due": [],
        "trainer_queue_new": [],
        "known_line_archive": [],
    }


def test_basic_endpoints() -> None:
    with app.test_client() as client:
        root = client.get("/")
        _check("root_200", root.status_code == 200, root.status_code)
        progress_alias = client.get("/?tab=progress")
        progress_alias_text = progress_alias.get_data(as_text=True)
        _check("progress_alias_200", progress_alias.status_code == 200, progress_alias.status_code)
        _check("progress_nav_label_present", 'data-tab-target="stats">Progress<' in progress_alias_text, progress_alias_text[:120])

        local_state_empty = client.get("/api/local-state")
        local_payload = local_state_empty.get_json() or {}
        _check("local_state_200", local_state_empty.status_code == 200, local_state_empty.status_code)
        _check("local_state_has_username_field", "username" in local_payload, local_payload)
        _check("local_state_has_schema_version", "schema_version" in local_payload, local_payload)

        status = client.get("/api/analysis-status")
        _check("analysis_status_200", status.status_code == 200, status.status_code)

def test_board_and_trainer_paths() -> None:
    with app.test_client() as client:
        legal = client.post("/api/legal-moves", json={"fen": "startpos"})
        _check("legal_moves_200", legal.status_code == 200, legal.status_code)
        legal_payload = legal.get_json() or {}
        moves = legal_payload.get("legal_moves") if isinstance(legal_payload, dict) else []
        _check("legal_moves_nonempty", isinstance(moves, list) and len(moves) > 0, type(moves).__name__)

        apply_ok = client.post("/api/apply-move", json={"fen": "startpos", "move_uci": "e2e4"})
        _check("apply_move_200", apply_ok.status_code == 200, apply_ok.status_code)
        apply_payload = apply_ok.get_json() or {}
        _check("apply_move_san", str(apply_payload.get("played_san", "")) == "e4", apply_payload.get("played_san"))

        apply_bad = client.post("/api/apply-move", json={"fen": "startpos", "move_uci": "e7e5"})
        _check("apply_move_illegal_400", apply_bad.status_code == 400, apply_bad.status_code)

        trainer = client.post(
            "/api/trainer-attempt",
            json={
                "fen": "startpos",
                "move_uci": "e2e4",
                "lesson": {
                    "best_reply_uci": "e2e4",
                    "continuation_moves_uci": ["e2e4", "e7e5"],
                    "explanation": "Central control.",
                },
            },
        )
        _check("trainer_attempt_200", trainer.status_code == 200, trainer.status_code)
        trainer_payload = trainer.get_json() or {}
        _check("trainer_matched_branch", bool(trainer_payload.get("matched_repertoire_branch")), trainer_payload)

        review = client.post(
            "/api/review-progress",
            json={
                "username": "smoke_api_user",
                "lessons": {"line-1": {"streak": 2, "seen": 3, "correct_count": 2, "wrong_count": 1}},
                "summary": {
                    "notes": "smoke",
                    "manual_repertoire": {
                        "smoke-pos": {
                            "lesson_id": "line-1",
                            "move_uci": "e2e4",
                            "move_san": "e4",
                            "line_label": "Smoke line",
                        }
                    },
                },
            },
        )
        _check("review_progress_200", review.status_code == 200, review.status_code)
        state_after = client.get("/api/local-state?username=smoke_api_user")
        _check("local_state_after_review_200", state_after.status_code == 200, state_after.status_code)
        state_payload = state_after.get_json() or {}
        tracked = state_payload.get("training_progress") if isinstance(state_payload, dict) else {}
        _check("review_progress_visible_in_state", isinstance(tracked, dict) and "line-1" in tracked, tracked)
        summary = state_payload.get("training_summary") if isinstance(state_payload, dict) else {}
        manual = summary.get("manual_repertoire") if isinstance(summary, dict) else {}
        _check("manual_repertoire_visible_in_state", isinstance(manual, dict) and "smoke-pos" in manual, manual)


def test_black_first_move_is_opponent_choice() -> None:
    pgn = """[Event "Black perspective"]\n[White "Opponent"]\n[Black "Input user"]\n[Result "0-1"]\n\n1. e4 d6 2. d4 Nf6 0-1"""
    game = chess.pgn.read_game(io.StringIO(pgn))
    _check("black_first_move_fixture_parsed", game is not None)
    imported = ImportedGame(
        url="",
        time_class="rapid",
        player_color="black",
        result="0-1",
        opponent="Opponent",
        pgn=pgn,
        game=game,
    )
    first_moves = _first_move_repertoire([imported], "black")
    _check("black_first_move_is_opponent_e4", first_moves.get("items", [{}])[0].get("move") == "e4", first_moves)
    _check("black_first_move_perspective", first_moves.get("perspective") == "opponent", first_moves)


def test_realign_and_database_paths() -> None:
    start_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    with app.test_client() as client, patch(
        "bookup.app.database_context_for_board",
        return_value={"database_moves": [{"uci": "e2e4", "san": "e4", "popularity": 40.0, "games": 1200}]},
    ):
        realign = client.post(
            "/api/realign-plan",
            json={
                "source_fen": start_fen,
                "target_fen": start_fen,
                "target_label": "Smoke",
            },
        )
        _check("realign_plan_200", realign.status_code == 200, realign.status_code)

        db = client.post("/api/database-moves", json={"fen": "startpos", "play_uci": []})
        _check("database_moves_200", db.status_code == 200, db.status_code)
        db_payload = db.get_json() or {}
        db_moves = db_payload.get("database_moves") if isinstance(db_payload, dict) else []
        _check("database_moves_nonempty", isinstance(db_moves, list) and len(db_moves) >= 1, db_payload)


def test_engine_wrapped_endpoints() -> None:
    with app.test_client() as client, patch("bookup.app.shared_engine_for", return_value=object()), patch(
        "bookup.app.build_position_insight",
        return_value={"recommended": {"uci": "e2e4", "san": "e4"}, "engine_lines": []},
    ):
        insight = client.post(
            "/api/position-insight",
            json={"fen": "startpos", "play_uci": [], "your_move_uci": "e2e4"},
        )
        _check("position_insight_200", insight.status_code == 200, insight.status_code)


def test_settings_smart_theory_roundtrip() -> None:
    with app.test_client() as client, patch("bookup.app.load_config", return_value={}), patch(
        "bookup.app.save_config", return_value=None
    ):
        settings = client.post(
            "/api/settings",
            json={
                "bookup_opening_focus": "inferred_style",
                "bookup_include_best_engine_replies": True,
                "bookup_expected_move_confidence_cp": 130,
                "bookup_style_move_confidence_cp": 95,
                "bookup_style_min_weight": 1.5,
                "bookup_chapter_strategy": "first_move",
                "bookup_auto_study_sync": True,
                "bookup_study_name": "Bookup",
                "main_platform": "chesscom",
                "main_username": "setup_smoke_main",
                "username": "setup_smoke_import",
                "time_classes": "rapid,blitz,bullet",
                "max_games": 123,
                "auto_import_on_startup": False,
            },
        )
        _check("settings_200", settings.status_code == 200, settings.status_code)
        payload = settings.get_json() or {}
        defaults = payload.get("defaults") if isinstance(payload, dict) else {}
        _check("settings_defaults_dict", isinstance(defaults, dict), type(defaults).__name__)
        _check("settings_opening_focus_value", str(defaults.get("bookup_opening_focus", "")) == "inferred_style", defaults)
        _check("settings_expected_cp_value", int(defaults.get("bookup_expected_move_confidence_cp", 0) or 0) == 130, defaults)
        _check("settings_style_cp_value", int(defaults.get("bookup_style_move_confidence_cp", 0) or 0) == 95, defaults)
        _check("settings_style_weight_value", abs(float(defaults.get("bookup_style_min_weight", 0) or 0.0) - 1.5) < 0.001, defaults)
        _check("settings_main_username_value", defaults.get("main_username") == "setup_smoke_main", defaults)
        _check("settings_import_username_value", defaults.get("username") == "setup_smoke_import", defaults)
        _check("settings_time_classes_value", defaults.get("time_classes") == "rapid,blitz,bullet", defaults)
        _check("settings_max_games_value", int(defaults.get("max_games", 0) or 0) == 123, defaults)
        _check("settings_auto_import_value", defaults.get("auto_import_on_startup") is False, defaults)


def test_progress_tracker_paths() -> None:
    username = "__bookup_progress_smoke__"
    path = progress_path(DATA_DIR, username)
    if path.exists():
        path.unlink()
    try:
        with app.test_client() as client:
            initial = client.get(f"/api/progress?username={username}&mode=rapid")
            initial_payload = initial.get_json() or {}
            _check("progress_state_200", initial.status_code == 200, initial.status_code)
            _check("progress_state_mode", initial_payload.get("mode") == "rapid", initial_payload)
            profile = initial_payload.get("profile") if isinstance(initial_payload, dict) else {}
            _check("progress_state_profile", isinstance(profile, dict) and int(profile.get("rating", 0) or 0) > 0, profile)

            settings = client.post(
                "/api/progress/settings",
                json={"username": username, "mode": "blitz", "custom_games": 321},
            )
            settings_payload = settings.get_json() or {}
            settings_progress = settings_payload.get("progress") if isinstance(settings_payload, dict) else {}
            _check("progress_settings_200", settings.status_code == 200, settings.status_code)
            _check("progress_settings_mode", settings_progress.get("mode") == "blitz", settings_progress)
            projection = settings_progress.get("projection") if isinstance(settings_progress, dict) else {}
            _check("progress_settings_custom_games", int(projection.get("custom_games", 0) or 0) == 321, projection)

            live_payload = {
                "username": username,
                "modes": {
                    "rapid": {"rating": 1500, "wins": 1, "draws": 0, "losses": 0, "total_games": 1, "source": "live", "time_class": "rapid"},
                    "bullet": {"rating": 900, "wins": 2, "draws": 0, "losses": 1, "total_games": 3, "source": "live", "time_class": "bullet"},
                },
            }
            with patch("bookup.progress_tracker.fetch_live_progress", return_value=live_payload):
                refreshed = client.post("/api/progress/refresh", json={"username": username, "mode": "bullet"})
            refreshed_payload = refreshed.get_json() or {}
            refreshed_progress = refreshed_payload.get("progress") if isinstance(refreshed_payload, dict) else {}
            refreshed_profile = refreshed_progress.get("profile") if isinstance(refreshed_progress, dict) else {}
            _check("progress_refresh_mode_200", refreshed.status_code == 200, refreshed.status_code)
            _check("progress_refresh_mode_honored", refreshed_progress.get("mode") == "bullet", refreshed_progress)
            _check("progress_refresh_mode_profile", refreshed_profile.get("rating") == 900, refreshed_profile)

            session = client.post(
                "/api/progress/session",
                json={
                    "username": username,
                    "mode": "blitz",
                    "date": "2026-06-04",
                    "start_rating": 1499,
                    "end_rating": 1507,
                    "wins": 2,
                    "draws": 0,
                    "losses": 1,
                    "accuracy": 76.4,
                    "mistake_theme": "time trouble",
                    "notes": "smoke",
                    "next_work": "review tactics",
                },
            )
            session_payload = session.get_json() or {}
            session_progress = session_payload.get("progress") if isinstance(session_payload, dict) else {}
            _check("progress_session_200", session.status_code == 200, session.status_code)
            _check("progress_session_saved", len(session_progress.get("sessions") or []) == 1, session_progress.get("sessions"))
    finally:
        if path.exists():
            path.unlink()
        if path.parent.exists() and not any(path.parent.iterdir()):
            path.parent.rmdir()


def test_smart_theory_check_existing_study() -> None:
    with app.test_client() as client, patch(
        "bookup.app.load_config",
        return_value={"bookup_study_id": "oldStudy", "bookup_study_name": "Bookup"},
    ), patch(
        "bookup.app.save_config", return_value=None
    ), patch(
        "bookup.app._list_lichess_study_chapters",
        return_value=[{"chapter_id": "chapter1", "chapter_name": "Main Setup", "plies": 12}],
    ):
        response = client.post(
            "/api/smart-theory/check-lichess-study",
            json={
                "study_id": "https://lichess.org/study/newStudy",
                "lichess_token": "fake-token",
                "unified_study_name": "Bookup",
            },
        )
        payload = response.get_json() or {}
        _check("check_study_200", response.status_code == 200, response.status_code)
        _check("check_study_normalizes_url", payload.get("study_id") == "newStudy", payload)
        _check("check_study_lists_chapters", int(payload.get("chapter_count", 0) or 0) == 1, payload)


def test_study_lines_tactical_reactions() -> None:
    cases = [
        {
            "name": "knight_fork",
            "fen": "r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1",
            "uci": "d5c7",
            "expected": ["royal fork", "Forks rook on a8, king on e8"],
        },
        {
            "name": "bishop_pin",
            "fen": "4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1",
            "uci": "f1b5",
            "expected": ["pin", "Pins the knight on c6 to the king"],
        },
        {
            "name": "castle_rights",
            "fen": "r3k2r/8/8/8/4B3/8/8/4K3 w kq - 0 1",
            "uci": "e4a8",
            "expected": ["castling rights", "Removes the opponent's castling rights"],
        },
        {
            "name": "prevents_fork",
            "fen": "8/8/8/8/8/8/3nk3/K1Q5 w - - 0 1",
            "uci": "c1c8",
            "expected": ["fork prevention", "Prevents the fork"],
        },
    ]
    for case in cases:
        board = chess.Board(case["fen"])
        move = chess.Move.from_uci(case["uci"])
        reaction = _move_reaction_for_board(
            board,
            move,
            classification={"key": "best", "label": "Best"},
            best_line={"uci": case["uci"], "move": board.san(move)},
            database_moves=[],
            book_state={"active": False},
        )
        combined = [*reaction.get("motifs", []), *reaction.get("reasons", [])]
        for expected in case["expected"]:
            _check(
                f"tactical_reaction_{case['name']}_{expected}",
                any(expected in str(item) for item in combined),
                combined,
            )
    recapture_board = chess.Board()
    for move_uci in ("e2e4", "d7d5", "e4d5"):
        recapture_board.push(chess.Move.from_uci(move_uci))
    recapture_move = chess.Move.from_uci("d8d5")
    recapture_reaction = _move_reaction_for_board(
        recapture_board,
        recapture_move,
        classification={"key": "best", "label": "Best"},
        best_line={"uci": recapture_move.uci(), "move": recapture_board.san(recapture_move)},
        database_moves=[],
        book_state={"active": False},
    )
    recapture_combined = [*recapture_reaction.get("motifs", []), *recapture_reaction.get("reasons", [])]
    _check(
        "tactical_reaction_recapture_phrase",
        any("recapture" in str(item).lower() for item in recapture_combined),
        recapture_combined,
    )


def _snapshot_style_lines(limit: int = 36) -> list[dict]:
    configured_path = os.environ.get("BOOKUP_SMOKE_SNAPSHOT", "").strip()
    if not configured_path:
        return []
    snapshot_path = Path(configured_path).expanduser()
    if not snapshot_path.exists():
        return []
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8-sig"))
    profile = snapshot.get("profile") if isinstance(snapshot, dict) else {}
    if not isinstance(profile, dict):
        return []
    lessons: list[dict] = []
    for key in ("trainer_queue_due", "trainer_queue_new", "known_line_archive"):
        value = profile.get(key)
        if isinstance(value, list):
            lessons.extend(item for item in value if isinstance(item, dict))
    for opening in profile.get("repertoire_tree") or []:
        if not isinstance(opening, dict):
            continue
        for node in opening.get("nodes") or []:
            if isinstance(node, dict):
                lessons.append(node)
    lines: list[dict] = []
    for lesson in lessons[:limit]:
        training = lesson.get("training_line_uci") if isinstance(lesson.get("training_line_uci"), list) else []
        intro = lesson.get("intro_line_uci") if isinstance(lesson.get("intro_line_uci"), list) else []
        moves = training or intro
        clean_moves = [str(item or "").strip().lower() for item in moves if str(item or "").strip()]
        if not clean_moves:
            continue
        lines.append(
            {
                "start_fen": str(lesson.get("line_start_fen") or chess.STARTING_FEN),
                "moves_uci": clean_moves[:64],
                "weight": max(1.0, min(9.0, float(lesson.get("frequency", 1) or 1) / 10.0)),
                "source": "configured_snapshot",
                "player_color": str(lesson.get("player_color") or lesson.get("color") or "").strip().lower(),
            }
        )
    return lines


def test_smart_theory_uses_real_snapshot_spines() -> None:
    style_lines = _snapshot_style_lines()
    if not style_lines:
        print("PASS configured_snapshot_style_lines_skipped")
        return

    class _Settings:
        depth = 12
        think_time_sec = 0.2

    class _FakeEngine:
        settings = _Settings()
        worker_count = 1

        def analyse(self, board: chess.Board, *, depth: int, multipv: int, time_sec: float | None = None):
            legal_by_uci = {move.uci(): move for move in board.legal_moves}
            # Prefer the same first moves that appear heavily in the real cache,
            # but keep alternatives nearby so the style spine is actually tested.
            preferred = [
                "g1f3", "e2e4", "d2d4",
                "d7d6", "g8f6", "g7g6", "f8g7",
                "c7c5", "e7e6", "e7e5",
            ]
            moves = [legal_by_uci[uci] for uci in preferred if uci in legal_by_uci]
            if not moves:
                moves = list(board.legal_moves)[:3]
            return [
                {"pv": [move], "score": chess.engine.PovScore(chess.engine.Cp(10 - index), chess.WHITE)}
                for index, move in enumerate(moves[:4])
            ]

    def fake_database_context(board: chess.Board, *, play_uci: list[str], limit: int):
        popular = []
        for uci, pop in (("e2e4", 42.0), ("g1f3", 38.0), ("d7d6", 35.0), ("g8f6", 30.0), ("g7g6", 28.0)):
            try:
                move = chess.Move.from_uci(uci)
            except ValueError:
                continue
            if move in board.legal_moves:
                popular.append({"uci": uci, "popularity": pop, "games": int(pop * 1000)})
        return {"database_moves": popular}

    common_payload = {
        "opponent_accuracy": "mixed",
        "max_ply": 4,
        "max_positions": 30,
        "opponent_replies": 1,
        "opening_focus": "inferred_style",
        "start_play_uci": [],
        "user_style_lines": style_lines,
        "include_best_engine_replies": False,
    }
    with patch("bookup.analysis.database_context_for_board", side_effect=fake_database_context):
        white = generate_smart_theory_tree(chess.Board(), _FakeEngine(), payload={**common_payload, "my_color": "white"})
        black = generate_smart_theory_tree(chess.Board(), _FakeEngine(), payload={**common_payload, "my_color": "black"})
    white_user = [str(node.get("uci", "") or "") for node in white.get("nodes", []) if isinstance(node, dict) and node.get("isUserSide")]
    black_user = [str(node.get("uci", "") or "") for node in black.get("nodes", []) if isinstance(node, dict) and node.get("isUserSide")]
    _check("real_snapshot_white_line_inferred", bool(white.get("user_book_line_uci")), white.get("warnings"))
    _check("real_snapshot_white_plays_nf3_system", bool(white_user) and white_user[0] == "g1f3", white_user[:4])
    _check("real_snapshot_black_line_inferred", bool(black.get("user_book_line_uci")), black.get("warnings"))
    _check("real_snapshot_black_plays_user_move", any(uci in {"d7d6", "g8f6", "g7g6", "f8g7"} for uci in black_user[:4]), black_user[:6])


def test_profile_and_import_pgn_paths() -> None:
    pgn_text = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *"
    games = import_games_from_pgn_text(pgn_text, username="smoke_api_user", fallback_color="white")
    _check("sample_games_present", len(games) >= 1, len(games))
    engine_settings_seen = []

    def fake_shared_engine_for(settings):
        engine_settings_seen.append(settings)
        return object()

    with app.test_client() as client, patch("bookup.app.load_config", return_value={}), patch(
        "bookup.app.save_config", return_value=None
    ), patch("bookup.app.shared_engine_for", side_effect=fake_shared_engine_for), patch(
        "bookup.app.fetch_archives", return_value=["https://api.chess.com/pub/player/smoke_api_user/games/2026/05"]
    ), patch(
        "bookup.app.fetch_games", return_value=games
    ), patch(
        "bookup.app.analyse_games", return_value=_sample_profile_payload()
    ):
        profile = client.post(
            "/api/profile",
            json={
                "username": "smoke_api_user",
                "time_classes": "all",
                "max_games": 5,
                "engine_path": "stockfish",
                "depth": 24,
                "threads": 16,
                "hash_mb": 30000,
                "multipv": 10,
                "think_time_sec": 30,
                "parallel_workers": 8,
                "lichess_token": "",
                "force_refresh": True,
            },
        )
        profile_payload = profile.get_json() or {}
        _check("profile_200", profile.status_code == 200, profile.status_code)
        _check("profile_has_profile", isinstance(profile_payload.get("profile"), dict), type(profile_payload.get("profile")).__name__)
        _check("profile_games_imported", int(profile_payload.get("games_imported", 0) or 0) >= 1, profile_payload.get("games_imported"))

        import_pgn = client.post(
            "/api/import-pgn",
            json={
                "username": "smoke_api_user",
                "pgn": pgn_text,
                "player_color": "white",
                "engine_path": "stockfish",
                "depth": 24,
                "threads": 16,
                "hash_mb": 30000,
                "multipv": 10,
                "think_time_sec": 30,
                "parallel_workers": 8,
                "lichess_token": "",
            },
        )
        import_payload = import_pgn.get_json() or {}
        _check("import_pgn_200", import_pgn.status_code == 200, import_pgn.status_code)
        _check("import_pgn_games_imported", int(import_payload.get("games_imported", 0) or 0) >= 1, import_payload.get("games_imported"))
        _check("import_engine_settings_seen", len(engine_settings_seen) >= 2, len(engine_settings_seen))
        _check("import_depth_is_capped", all(int(item.depth) <= 16 for item in engine_settings_seen), [item.depth for item in engine_settings_seen])
        _check("import_movetime_is_capped", all(float(item.think_time_sec) <= 1.0 for item in engine_settings_seen), [item.think_time_sec for item in engine_settings_seen])


def main() -> None:
    test_basic_endpoints()
    test_board_and_trainer_paths()
    test_black_first_move_is_opponent_choice()
    test_realign_and_database_paths()
    test_engine_wrapped_endpoints()
    test_settings_smart_theory_roundtrip()
    test_progress_tracker_paths()
    test_smart_theory_check_existing_study()
    test_study_lines_tactical_reactions()
    test_smart_theory_uses_real_snapshot_spines()
    test_profile_and_import_pgn_paths()
    print("ALL BOOKUP API SMOKE CHECKS PASSED")


if __name__ == "__main__":
    main()
