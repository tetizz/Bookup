from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from bookup.app import SMART_THEORY_JOBS, SMART_THEORY_JOBS_LOCK, _run_smart_theory_job, app
from bookup.engine import EngineSettings
import chess
import chess.engine
from bookup.analysis import generate_smart_theory_tree


def sample_tree() -> dict:
    return {
        "effective_start_fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "openingName": "King's Indian Defense",
        "nodes": [
            {
                "id": "root",
                "parentId": "",
                "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                "normalizedFen": "start",
                "children": ["n1"],
            },
            {
                "id": "n1",
                "parentId": "root",
                "uci": "d2d4",
                "san": "d4",
                "classification": "Mainline",
                "openingName": "King's Indian Defense",
                "fen": "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
                "normalizedFen": "x1",
                "children": [],
            },
        ],
    }


def sample_unknown_focus_tree() -> dict:
    return {
        "effective_start_fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "openingName": "King's Indian Defense",
        "nodes": [
            {"id": "root", "parentId": "", "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "normalizedFen": "r0", "children": ["n1"]},
            {
                "id": "n1",
                "parentId": "root",
                "uci": "d2d4",
                "san": "d4",
                "classification": "Mainline",
                "openingName": "King's Indian Defense",
                "normalizedFen": "r1",
                "isUserSide": False,
                "children": ["n2"],
            },
            {
                "id": "n2",
                "parentId": "n1",
                "uci": "g8f6",
                "san": "Nf6",
                "classification": "Mainline",
                "openingName": "King's Indian Defense",
                "normalizedFen": "r2",
                "isUserSide": False,
                "children": ["n3"],
            },
            {
                "id": "n3",
                "parentId": "n2",
                "uci": "c2c4",
                "san": "c4",
                "classification": "Mistake",
                "openingName": "King's Indian Defense",
                "normalizedFen": "r3",
                "isUserSide": True,
                "children": [],
            },
        ],
    }


def require(ok: bool, label: str, detail: str = "") -> None:
    if ok:
        print(f"PASS {label}")
        return
    print(f"FAIL {label}{(': ' + detail) if detail else ''}")
    raise SystemExit(1)


def test_settings_opening_focus() -> None:
    with app.test_client() as client:
        response = client.post("/api/settings", json={"bookup_opening_focus": "kings_indian"})
        payload = response.get_json() or {}
        require(response.status_code == 200, "settings_status_200", str(payload))
        defaults = payload.get("defaults", {}) if isinstance(payload.get("defaults"), dict) else {}
        require(str(defaults.get("bookup_opening_focus", "")).lower() == "kings_indian_defense", "settings_focus_legacy_maps")
        response2 = client.post("/api/settings", json={"bookup_opening_focus": "kings_indian_systems"})
        payload2 = response2.get_json() or {}
        defaults2 = payload2.get("defaults", {}) if isinstance(payload2.get("defaults"), dict) else {}
        require(str(defaults2.get("bookup_opening_focus", "")).lower() == "kings_indian_systems", "settings_focus_persisted")


def test_auto_create_and_chapter_naming() -> None:
    captured: dict[str, list[str]] = {"chapters": []}

    def fake_create(*, token: str, study_name: str, visibility: str) -> dict:
        require(token == "lip_test_token", "create_uses_token")
        require(study_name == "Bookup", "create_uses_unified_name")
        return {"study_id": "AbCdEf12", "study_url": "https://lichess.org/study/AbCdEf12", "response": {"id": "AbCdEf12"}}

    def fake_import(*, study_id: str, token: str, chapter_name: str, pgn_text: str, orientation: str) -> dict:
        require(study_id == "AbCdEf12", "import_uses_created_study")
        require(token == "lip_test_token", "import_uses_token")
        require(orientation == "black", "import_uses_orientation")
        require(bool(pgn_text.strip()), "import_has_pgn")
        captured["chapters"].append(chapter_name)
        return {"ok": True, "response": {"ok": True}}

    with app.test_client() as client, patch("bookup.app.load_config", return_value={}), patch(
        "bookup.app.save_config", return_value=None
    ), patch("bookup.app._create_lichess_study", side_effect=fake_create), patch(
        "bookup.app._post_pgn_to_lichess_study", side_effect=fake_import
    ), patch(
        "bookup.app._cleanup_default_placeholder_chapters",
        return_value={"deleted_count": 1, "deleted_chapter_ids": ["abc"], "errors": []},
    ):
        response = client.post(
            "/api/smart-theory/export-lichess-study",
            json={
                "study_id": "",
                "lichess_token": "lip_test_token",
                "auto_create_unified_study": True,
                "unified_study_name": "Bookup",
                "chapter_name": "Bookup Smart Theory",
                "chapter_strategy": "first_move",
                "orientation": "black",
                "tree": sample_tree(),
            },
        )
        payload = response.get_json() or {}
        require(response.status_code == 200, "export_status_200", str(payload))
        require(payload.get("created_unified_study") is True, "export_created_unified")
        require(payload.get("study_id") == "AbCdEf12", "export_returns_study_id")
        require(int(payload.get("chapters_created_count", 0) or 0) == 1, "export_chapter_count")
        first_chapter = captured["chapters"][0] if captured["chapters"] else ""
        require("King's Indian Defense" in first_chapter, "chapter_name_opening")
        require("main setup" in first_chapter.lower(), "chapter_name_style")


def test_unknown_focus_chapter_anchors() -> None:
    captured: dict[str, list[str]] = {"chapters": []}

    def fake_import(*, study_id: str, token: str, chapter_name: str, pgn_text: str, orientation: str) -> dict:
        require(bool(pgn_text.strip()), "unknown_focus_has_pgn")
        captured["chapters"].append(chapter_name)
        return {"ok": True, "response": {"ok": True}}

    with app.test_client() as client, patch("bookup.app.load_config", return_value={"bookup_study_id": "AbCdEf12"}), patch(
        "bookup.app._post_pgn_to_lichess_study", side_effect=fake_import
    ):
        response = client.post(
            "/api/smart-theory/export-lichess-study",
            json={
                "study_id": "AbCdEf12",
                "lichess_token": "lip_test_token",
                "chapter_name": "Bookup Smart Theory",
                "chapter_strategy": "unknown_focus",
                "orientation": "white",
                "tree": sample_unknown_focus_tree(),
            },
        )
        payload = response.get_json() or {}
        require(response.status_code == 200, "unknown_focus_status_200", str(payload))
        require(int(payload.get("chapters_created_count", 0) or 0) >= 1, "unknown_focus_chapter_count")
        first_chapter = captured["chapters"][0] if captured["chapters"] else ""
        require("mistake" in first_chapter.lower(), "unknown_focus_prefers_weak_lines")
        require("c4" in first_chapter.lower(), "unknown_focus_anchor_move")


def test_start_line_kept_when_book_lookup_unavailable() -> None:
    class _Settings:
        depth = 12
        think_time_sec = 0.2

    class _FakeEngine:
        settings = _Settings()
        worker_count = 1

        def analyse(self, board: chess.Board, *, depth: int, multipv: int, time_sec: float | None = None):
            moves = list(board.legal_moves)
            if not moves:
                return []
            return [{"pv": [moves[0]], "score": None}]

    def fake_database_context(board: chess.Board, *, play_uci: list[str], limit: int):
        # Only fail the dedicated "is this still in book?" check (limit=16).
        if limit == 16:
            raise RuntimeError("simulated book outage")
        return {"database_moves": []}

    board = chess.Board()
    payload = {
        "my_color": "black",
        "opponent_accuracy": "mixed",
        "max_ply": 2,
        "max_positions": 16,
        "opponent_replies": 1,
        "follow_user_line_until_out_of_book": True,
        "start_play_uci": ["d2d4", "g8f6"],
    }
    with patch("bookup.analysis.database_context_for_board", side_effect=fake_database_context):
        result = generate_smart_theory_tree(board, _FakeEngine(), payload=payload)
    applied = result.get("applied_start_line_uci", [])
    require(applied[:2] == ["d2d4", "g8f6"], "start_line_preserved_when_book_lookup_unavailable", str(applied))
    require(int(result.get("learning_queue_count", 0) or 0) >= 1, "learning_queue_count_present")
    require(isinstance(result.get("learning_queue_preview", []), list), "learning_queue_preview_present")


def test_corrections_not_limited_to_root() -> None:
    class _Settings:
        depth = 12
        think_time_sec = 0.2

    class _FakeEngine:
        settings = _Settings()
        worker_count = 1

        def analyse(self, board: chess.Board, *, depth: int, multipv: int, time_sec: float | None = None):
            # Force a simple deterministic move ordering from legal moves.
            moves = list(board.legal_moves)
            if not moves:
                return []
            lines = []
            for mv in moves[: max(1, multipv)]:
                lines.append({"pv": [mv], "score": None})
            return lines

    def fake_database_context(board: chess.Board, *, play_uci: list[str], limit: int):
        # Keep seed checks available and provide empty db candidates elsewhere.
        return {"database_moves": []}

    board = chess.Board()
    payload = {
        "my_color": "white",
        "opponent_accuracy": "mixed",
        "max_ply": 4,
        "max_positions": 60,
        "opponent_replies": 1,
        "follow_user_line_until_out_of_book": False,
        "start_play_uci": ["d2d4", "g8f6"],
        "user_book_line_uci": ["d2d4", "g8f6", "c2c4", "g7g6"],
        "reference_user_move_uci": "c2c4",
    }
    with patch("bookup.analysis.database_context_for_board", side_effect=fake_database_context):
        result = generate_smart_theory_tree(board, _FakeEngine(), payload=payload)
    corrected = [node for node in result.get("nodes", []) if isinstance(node, dict) and node.get("isCorrectedMove")]
    require(len(corrected) >= 1, "non_root_corrections_present")
    # Ensure correction info carries played-line context text.
    has_played_line_reason = any("played-line move" in str(node.get("theoryExplanation", "")).lower() for node in corrected)
    require(has_played_line_reason, "non_root_corrections_use_played_line_context")


def test_opening_focus_forced_color_modes() -> None:
    class _Settings:
        depth = 12
        think_time_sec = 0.2

    class _FakeEngine:
        settings = _Settings()
        worker_count = 1

        def analyse(self, board: chess.Board, *, depth: int, multipv: int, time_sec: float | None = None):
            moves = list(board.legal_moves)
            if not moves:
                return []
            return [{"pv": [moves[0]], "score": None}]

    board = chess.Board()
    payload = {
        "my_color": "white",
        "opening_focus": "kings_indian_defense",
        "opponent_accuracy": "mixed",
        "max_ply": 2,
        "max_positions": 20,
        "opponent_replies": 1,
    }
    result = generate_smart_theory_tree(board, _FakeEngine(), payload=payload)
    settings_used = result.get("settings_used", {}) if isinstance(result.get("settings_used"), dict) else {}
    require(str(settings_used.get("my_color", "")).lower() == "black", "kings_indian_defense_forces_black")

    payload2 = {
        "my_color": "black",
        "opening_focus": "kings_indian_attack",
        "opponent_accuracy": "mixed",
        "max_ply": 2,
        "max_positions": 20,
        "opponent_replies": 1,
    }
    result2 = generate_smart_theory_tree(board, _FakeEngine(), payload=payload2)
    settings_used2 = result2.get("settings_used", {}) if isinstance(result2.get("settings_used"), dict) else {}
    require(str(settings_used2.get("my_color", "")).lower() == "white", "kings_indian_attack_forces_white")


def test_opening_focus_preferred_move_modes() -> None:
    class _Settings:
        depth = 12
        think_time_sec = 0.2

    class _FakeEngine:
        settings = _Settings()
        worker_count = 1

        def analyse(self, board: chess.Board, *, depth: int, multipv: int, time_sec: float | None = None):
            moves = list(board.legal_moves)
            if not moves:
                return []
            return [{"pv": [moves[0]], "score": None}]

    def fake_database_context(board: chess.Board, *, play_uci: list[str], limit: int):
        return {"database_moves": []}

    with patch("bookup.analysis.database_context_for_board", side_effect=fake_database_context):
        kia_result = generate_smart_theory_tree(
            chess.Board(),
            _FakeEngine(),
            payload={
                "my_color": "white",
                "opening_focus": "kings_indian_attack",
                "opponent_accuracy": "mixed",
                "max_ply": 2,
                "max_positions": 20,
                "opponent_replies": 1,
            },
        )
        kia_moves = [node for node in kia_result.get("nodes", []) if isinstance(node, dict) and bool(node.get("isUserSide"))]
        require(bool(kia_moves), "kia_user_moves_present")
        require(str(kia_moves[0].get("uci", "")) == "g1f3", "kia_prefers_nf3")

        pirc_result = generate_smart_theory_tree(
            chess.Board(),
            _FakeEngine(),
            payload={
                "my_color": "black",
                "opening_focus": "kings_indian_systems",
                "opponent_accuracy": "mixed",
                "max_ply": 2,
                "max_positions": 20,
                "opponent_replies": 1,
                "start_play_uci": ["e2e4"],
            },
        )
        pirc_moves = [node for node in pirc_result.get("nodes", []) if isinstance(node, dict) and bool(node.get("isUserSide"))]
        require(bool(pirc_moves), "pirc_user_moves_present")
        require(str(pirc_moves[0].get("uci", "")) == "d7d6", "systems_prefers_pirc_d6_in_e4_structure")


def test_include_best_engine_replies_toggle() -> None:
    class _Settings:
        depth = 12
        think_time_sec = 0.2

    class _FakeEngine:
        settings = _Settings()
        worker_count = 1

        def analyse(self, board: chess.Board, *, depth: int, multipv: int, time_sec: float | None = None):
            # Engine-best is d4; weighted human pick should prefer e4 when the
            # best-engine-replies setting is disabled.
            candidates = [mv for mv in board.legal_moves if mv.uci() in {"d2d4", "e2e4"}]
            if len(candidates) < 2:
                candidates = list(board.legal_moves)[:2]
            if not candidates:
                return []
            d4 = next((mv for mv in candidates if mv.uci() == "d2d4"), candidates[0])
            e4 = next((mv for mv in candidates if mv.uci() == "e2e4"), candidates[-1])
            return [
                {"pv": [d4], "score": chess.engine.PovScore(chess.engine.Cp(0), chess.WHITE)},
                {"pv": [e4], "score": chess.engine.PovScore(chess.engine.Cp(10), chess.WHITE)},
            ]

    def fake_database_context(board: chess.Board, *, play_uci: list[str], limit: int):
        return {
            "database_moves": [
                {"uci": "d2d4", "popularity": 0.0, "games": 0},
                {"uci": "e2e4", "popularity": 26.0, "games": 3000},
            ]
        }

    common_payload = {
        "my_color": "black",
        "opponent_accuracy": "mixed",
        "max_ply": 2,
        "max_positions": 20,
        "opponent_replies": 1,
        "include_rare_sidelines": False,
        "eco_only_mode": True,
    }
    with patch("bookup.analysis.database_context_for_board", side_effect=fake_database_context):
        without_best = generate_smart_theory_tree(
            chess.Board(),
            _FakeEngine(),
            payload={**common_payload, "include_best_engine_replies": False},
        )
        with_best = generate_smart_theory_tree(
            chess.Board(),
            _FakeEngine(),
            payload={**common_payload, "include_best_engine_replies": True},
        )
    opp_without = [node for node in without_best.get("nodes", []) if isinstance(node, dict) and bool(node.get("isOpponentSide"))]
    opp_with = [node for node in with_best.get("nodes", []) if isinstance(node, dict) and bool(node.get("isOpponentSide"))]
    require(bool(opp_without), "best_reply_toggle_without_nodes")
    require(bool(opp_with), "best_reply_toggle_with_nodes")
    require(str(opp_without[0].get("uci", "")) == "e2e4", "best_reply_toggle_disabled_prefers_weighted_human")
    require(str(opp_with[0].get("uci", "")) == "d2d4", "best_reply_toggle_enabled_includes_engine_best")


def test_background_auto_sync_during_job() -> None:
    job_id = "test-job-background-sync"
    board_fen = chess.STARTING_FEN
    payload = {
        "auto_sync_to_study": True,
        "lichess_token": "lip_test_token",
        "study_id": "",
        "chapter_name": "Bookup Smart Theory",
        "chapter_strategy": "first_move",
        "orientation": "white",
        "unified_study_name": "Bookup",
    }
    fake_result = {
        "status": "complete",
        "positions_done": 3,
        "positions_total": 3,
        "nodes": sample_tree()["nodes"],
        "warnings": [],
        "openingName": "King's Indian Defense",
        "ecoCode": "E60",
    }

    with SMART_THEORY_JOBS_LOCK:
        SMART_THEORY_JOBS[job_id] = {
            "cancelled": False,
            "status": "generating",
            "message": "Queued",
            "positions_done": 0,
            "positions_total": 0,
            "result": None,
            "error": "",
            "created_at": 0.0,
            "updated_at": 0.0,
        }

    def fake_create(*, token: str, study_name: str, visibility: str) -> dict:
        return {"study_id": "AbCdEf12", "study_url": "https://lichess.org/study/AbCdEf12", "response": {"id": "AbCdEf12"}}

    def fake_import(*, study_id: str, token: str, chapter_name: str, pgn_text: str, orientation: str) -> dict:
        return {"ok": True, "response": {"ok": True}}

    settings = EngineSettings(
        path="stockfish",
        depth=12,
        threads=1,
        hash_mb=256,
        multipv=2,
        think_time_sec=0.2,
        parallel_workers=1,
    )
    with patch("bookup.app.configure_lichess", return_value=None), patch("bookup.app.shared_engine_for", return_value=object()), patch(
        "bookup.app.generate_smart_theory_tree", return_value=fake_result
    ), patch("bookup.app.load_config", return_value={}), patch("bookup.app.save_config", return_value=None), patch(
        "bookup.app._create_lichess_study", side_effect=fake_create
    ), patch("bookup.app._post_pgn_to_lichess_study", side_effect=fake_import), patch(
        "bookup.app._cleanup_default_placeholder_chapters",
        return_value={"deleted_count": 1, "deleted_chapter_ids": ["abc"], "errors": []},
    ):
        _run_smart_theory_job(
            job_id=job_id,
            board_fen=board_fen,
            payload=payload,
            settings=settings,
            lichess_token="lip_test_token",
        )
    with SMART_THEORY_JOBS_LOCK:
        job = SMART_THEORY_JOBS.get(job_id, {})
    study_sync = job.get("study_sync", {}) if isinstance(job, dict) else {}
    require(isinstance(study_sync, dict), "background_sync_payload_present")
    require(str(study_sync.get("status", "")) == "success", "background_sync_success", str(study_sync))
    require(int(study_sync.get("chapters_created_count", 0) or 0) >= 1, "background_sync_chapters")
    cleanup = study_sync.get("cleanup", {}) if isinstance(study_sync.get("cleanup"), dict) else {}
    require(int(cleanup.get("deleted_count", 0) or 0) >= 0, "background_sync_cleanup_present")


def test_background_auto_sync_skips_without_token() -> None:
    job_id = "test-job-background-sync-no-token"
    board_fen = chess.STARTING_FEN
    payload = {
        "auto_sync_to_study": True,
        "study_id": "AbCdEf12",
        "chapter_name": "Bookup Smart Theory",
        "chapter_strategy": "first_move",
        "orientation": "white",
    }
    fake_result = {
        "status": "complete",
        "positions_done": 1,
        "positions_total": 1,
        "nodes": sample_tree()["nodes"],
        "warnings": [],
    }

    with SMART_THEORY_JOBS_LOCK:
        SMART_THEORY_JOBS[job_id] = {
            "cancelled": False,
            "status": "generating",
            "message": "Queued",
            "positions_done": 0,
            "positions_total": 0,
            "result": None,
            "error": "",
            "created_at": 0.0,
            "updated_at": 0.0,
        }

    settings = EngineSettings(
        path="stockfish",
        depth=12,
        threads=1,
        hash_mb=256,
        multipv=2,
        think_time_sec=0.2,
        parallel_workers=1,
    )
    with patch("bookup.app.configure_lichess", return_value=None), patch("bookup.app.shared_engine_for", return_value=object()), patch(
        "bookup.app.generate_smart_theory_tree", return_value=fake_result
    ):
        _run_smart_theory_job(
            job_id=job_id,
            board_fen=board_fen,
            payload=payload,
            settings=settings,
            lichess_token="",
        )
    with SMART_THEORY_JOBS_LOCK:
        job = SMART_THEORY_JOBS.get(job_id, {})
    study_sync = job.get("study_sync", {}) if isinstance(job, dict) else {}
    require(str(study_sync.get("status", "")) == "skipped", "background_sync_skip_no_token_status")
    require(str(study_sync.get("reason", "")) == "missing_lichess_token", "background_sync_skip_no_token_reason")


def test_background_auto_sync_skips_when_generation_stopped() -> None:
    job_id = "test-job-background-sync-stopped"
    board_fen = chess.STARTING_FEN
    payload = {
        "auto_sync_to_study": True,
        "lichess_token": "lip_test_token",
        "study_id": "AbCdEf12",
        "chapter_name": "Bookup Smart Theory",
        "chapter_strategy": "first_move",
        "orientation": "white",
    }
    fake_result = {
        "status": "stopped",
        "positions_done": 0,
        "positions_total": 1,
        "nodes": sample_tree()["nodes"],
        "warnings": [],
    }

    with SMART_THEORY_JOBS_LOCK:
        SMART_THEORY_JOBS[job_id] = {
            "cancelled": False,
            "status": "stopping",
            "message": "Stopping",
            "positions_done": 0,
            "positions_total": 0,
            "result": None,
            "error": "",
            "created_at": 0.0,
            "updated_at": 0.0,
        }

    settings = EngineSettings(
        path="stockfish",
        depth=12,
        threads=1,
        hash_mb=256,
        multipv=2,
        think_time_sec=0.2,
        parallel_workers=1,
    )
    with patch("bookup.app.configure_lichess", return_value=None), patch("bookup.app.shared_engine_for", return_value=object()), patch(
        "bookup.app.generate_smart_theory_tree", return_value=fake_result
    ):
        _run_smart_theory_job(
            job_id=job_id,
            board_fen=board_fen,
            payload=payload,
            settings=settings,
            lichess_token="lip_test_token",
        )
    with SMART_THEORY_JOBS_LOCK:
        job = SMART_THEORY_JOBS.get(job_id, {})
    study_sync = job.get("study_sync", {}) if isinstance(job, dict) else {}
    require(str(study_sync.get("status", "")) == "skipped", "background_sync_skip_stopped_status")
    require(str(study_sync.get("reason", "")) == "generation_stopped", "background_sync_skip_stopped_reason")


def test_manual_export_cleanup_placeholder_called() -> None:
    with app.test_client() as client, patch("bookup.app.load_config", return_value={}), patch(
        "bookup.app.save_config", return_value=None
    ), patch(
        "bookup.app._create_lichess_study",
        return_value={"study_id": "AbCdEf12", "study_url": "https://lichess.org/study/AbCdEf12", "response": {"id": "AbCdEf12"}},
    ), patch(
        "bookup.app._post_pgn_to_lichess_study",
        return_value={"ok": True, "response": {"ok": True}},
    ), patch(
        "bookup.app._cleanup_default_placeholder_chapters",
        return_value={"deleted_count": 1, "deleted_chapter_ids": ["xyz"], "errors": []},
    ) as cleanup_mock:
        response = client.post(
            "/api/smart-theory/export-lichess-study",
            json={
                "study_id": "",
                "lichess_token": "lip_test_token",
                "auto_create_unified_study": True,
                "unified_study_name": "Bookup",
                "chapter_name": "Bookup Smart Theory",
                "chapter_strategy": "first_move",
                "orientation": "white",
                "tree": sample_tree(),
            },
        )
        payload = response.get_json() or {}
        require(response.status_code == 200, "manual_cleanup_export_status_200", str(payload))
        require(cleanup_mock.called, "manual_cleanup_called")
        cleanup = payload.get("cleanup", {}) if isinstance(payload.get("cleanup"), dict) else {}
        require(int(cleanup.get("deleted_count", 0) or 0) == 1, "manual_cleanup_deleted_count")


def test_refresh_unified_study_endpoint() -> None:
    with app.test_client() as client, patch("bookup.app.load_config", return_value={}), patch(
        "bookup.app.save_config", return_value=None
    ), patch(
        "bookup.app._create_lichess_study",
        return_value={"study_id": "R3fRe5h1", "study_url": "https://lichess.org/study/R3fRe5h1", "response": {"id": "R3fRe5h1"}},
    ), patch(
        "bookup.app._cleanup_default_placeholder_chapters",
        return_value={"deleted_count": 1, "deleted_chapter_ids": ["abc"], "errors": []},
    ):
        response = client.post(
            "/api/smart-theory/refresh-unified-study",
            json={
                "lichess_token": "lip_test_token",
                "unified_study_name": "Bookup",
            },
        )
        payload = response.get_json() or {}
        require(response.status_code == 200, "refresh_study_status_200", str(payload))
        require(str(payload.get("study_id", "")) == "R3fRe5h1", "refresh_study_id")
        cleanup = payload.get("cleanup", {}) if isinstance(payload.get("cleanup"), dict) else {}
        require(int(cleanup.get("deleted_count", 0) or 0) == 1, "refresh_study_cleanup")


if __name__ == "__main__":
    test_settings_opening_focus()
    test_auto_create_and_chapter_naming()
    test_unknown_focus_chapter_anchors()
    test_start_line_kept_when_book_lookup_unavailable()
    test_corrections_not_limited_to_root()
    test_opening_focus_forced_color_modes()
    test_opening_focus_preferred_move_modes()
    test_include_best_engine_replies_toggle()
    test_background_auto_sync_during_job()
    test_background_auto_sync_skips_without_token()
    test_background_auto_sync_skips_when_generation_stopped()
    test_manual_export_cleanup_placeholder_called()
    test_refresh_unified_study_endpoint()
    print("ALL SMART THEORY LICHESS REGRESSION CHECKS PASSED")
