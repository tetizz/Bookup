from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from bookup.app import (
    SMART_THEORY_JOBS,
    SMART_THEORY_JOBS_LOCK,
    build_defaults_payload,
    _run_smart_theory_job,
    _smart_subtree_to_pgn,
    _smart_tree_chapter_exports,
    _smart_tree_to_pgn,
    app,
)
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


def sample_tree_with_setup() -> dict:
    return {
        "start_fen": chess.STARTING_FEN,
        "effective_start_fen": "rnbqkbnr/ppp1pppp/3p4/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        "applied_start_line_uci": ["e2e4", "d7d6"],
        "openingName": "Pirc Defense",
        "nodes": [
            {
                "id": "root",
                "parentId": "",
                "fen": "rnbqkbnr/ppp1pppp/3p4/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
                "normalizedFen": "after-e4-d6",
                "children": ["n1"],
            },
            {
                "id": "n1",
                "parentId": "root",
                "uci": "d2d4",
                "san": "d4",
                "classification": "Best",
                "openingName": "Pirc Defense",
                "fen": "rnbqkbnr/ppp1pppp/3p4/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2",
                "normalizedFen": "after-e4-d6-d4",
                "children": ["n2"],
            },
            {
                "id": "n2",
                "parentId": "n1",
                "uci": "g8f6",
                "san": "Nf6",
                "classification": "Mainline",
                "openingName": "Pirc Defense",
                "fen": "rnbqkb1r/ppp1pppp/3p1n2/8/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 1 3",
                "normalizedFen": "after-e4-d6-d4-nf6",
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
        require(str(defaults.get("bookup_opening_focus", "")).lower() == "inferred_style", "settings_focus_legacy_ignored")
        response2 = client.post("/api/settings", json={"bookup_opening_focus": "kings_indian_systems"})
        payload2 = response2.get_json() or {}
        defaults2 = payload2.get("defaults", {}) if isinstance(payload2.get("defaults"), dict) else {}
        require(str(defaults2.get("bookup_opening_focus", "")).lower() == "inferred_style", "settings_focus_inferred_style")


def test_settings_study_name_round_trip() -> None:
    with app.test_client() as client:
        response = client.post("/api/settings", json={"bookup_study_name": "Bookup Unified Study"})
        payload = response.get_json() or {}
        require(response.status_code == 200, "settings_study_name_status_200", str(payload))
        defaults = payload.get("defaults", {}) if isinstance(payload.get("defaults"), dict) else {}
        require(str(defaults.get("bookup_study_name", "")) == "Bookup Unified Study", "settings_study_name_persisted")


def test_settings_style_confidence_round_trip() -> None:
    with app.test_client() as client:
        response = client.post(
            "/api/settings",
            json={
                "bookup_expected_move_confidence_cp": 140,
                "bookup_style_move_confidence_cp": 105,
                "bookup_style_min_weight": 1.7,
            },
        )
        payload = response.get_json() or {}
        require(response.status_code == 200, "settings_style_confidence_status_200", str(payload))
        defaults = payload.get("defaults", {}) if isinstance(payload.get("defaults"), dict) else {}
        require(int(defaults.get("bookup_expected_move_confidence_cp", 0) or 0) == 140, "settings_expected_confidence_persisted")
        require(int(defaults.get("bookup_style_move_confidence_cp", 0) or 0) == 105, "settings_style_confidence_persisted")
        require(abs(float(defaults.get("bookup_style_min_weight", 0) or 0.0) - 1.7) < 0.001, "settings_style_min_weight_persisted")


def test_defaults_do_not_expose_lichess_token() -> None:
    defaults = build_defaults_payload(
        {
            "lichess_token": "test-token-hidden",
            "engine_path": "",
            "depth": 16,
            "threads": 1,
            "hash_mb": 256,
            "multipv": 2,
            "think_time_sec": 0.1,
            "parallel_workers": 1,
        }
    )
    require(str(defaults.get("lichess_token", "")) == "", "defaults_token_value_redacted")
    require(bool(defaults.get("lichess_token_configured")) is True, "defaults_token_configured_flag")
    require("test-token-hidden" not in str(defaults), "defaults_token_not_serialized")


def test_auto_create_and_chapter_naming() -> None:
    captured: dict[str, list[str]] = {"chapters": []}

    def fake_create(*, token: str, study_name: str, visibility: str) -> dict:
        require(token == "test-token", "create_uses_token")
        require(study_name == "Bookup", "create_uses_unified_name")
        return {"study_id": "AbCdEf12", "study_url": "https://lichess.org/study/AbCdEf12", "response": {"id": "AbCdEf12"}}

    def fake_import(*, study_id: str, token: str, chapter_name: str, pgn_text: str, orientation: str) -> dict:
        require(study_id == "AbCdEf12", "import_uses_created_study")
        require(token == "test-token", "import_uses_token")
        require(orientation == "black", "import_uses_orientation")
        require(bool(pgn_text.strip()), "import_has_pgn")
        captured["chapters"].append(chapter_name)
        return {"ok": True, "response": {"ok": True}}

    with app.test_client() as client, patch("bookup.app.load_config", return_value={}), patch(
        "bookup.app.save_config", return_value=None
    ), patch("bookup.app._create_lichess_study", side_effect=fake_create), patch(
        "bookup.app._list_lichess_study_chapters", return_value=[]
    ), patch(
        "bookup.app._post_pgn_to_lichess_study", side_effect=fake_import
    ), patch(
        "bookup.app._cleanup_default_placeholder_chapters",
        return_value={"deleted_count": 1, "deleted_chapter_ids": ["abc"], "errors": []},
    ):
        response = client.post(
            "/api/smart-theory/export-lichess-study",
            json={
                "study_id": "",
                "lichess_token": "test-token",
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
        require("1.d4" in first_chapter and "main line" in first_chapter.lower(), "chapter_name_style")


def test_pgn_comments_include_engine_reply_metadata() -> None:
    tree = {
        "effective_start_fen": chess.STARTING_FEN,
        "openingName": "King's Indian Defense",
        "ecoCode": "E60",
        "nodes": [
            {
                "id": "root",
                "parentId": "",
                "fen": chess.STARTING_FEN,
                "normalizedFen": "root",
                "children": ["n1"],
            },
            {
                "id": "n1",
                "parentId": "root",
                "uci": "d2d4",
                "san": "d4",
                "classification": "Best",
                "isBestEngineReply": True,
                "isOpponentSide": True,
                "bestMoveSan": "d4",
                "bestMoveUci": "d2d4",
                "recommendedResponseSan": "Nf6",
                "recommendedResponseUci": "g8f6",
                "theoryExplanation": "Test theory text",
                "planForUser": "Test plan text",
                "threatSummary": "Test threat summary",
                "whyMoveGoodOrBad": "Test why summary",
                "fen": "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
                "normalizedFen": "n1",
                "children": [],
            },
        ],
    }
    pgn_text, _meta = _smart_tree_to_pgn(tree, chapter_name="Bookup Smart Theory")
    require("Opponent: best engine move" in pgn_text, "pgn_comment_engine_reply_flag")
    require("Your reply: Nf6" in pgn_text, "pgn_comment_recommended_response")
    require("Best move" in pgn_text, "pgn_comment_best_move_present")
    require("Threat:" in pgn_text, "pgn_comment_threat_summary")
    require("Test theory text" not in pgn_text, "pgn_comment_omits_wordy_theory")
    comments = [segment.split("}", 1)[0] for segment in pgn_text.split("{")[1:]]
    require(comments and max(len(comment.strip()) for comment in comments) <= 360, "pgn_comments_are_concise", pgn_text)


def test_pgn_export_includes_setup_path_before_generated_branch() -> None:
    tree = sample_tree_with_setup()
    full_pgn, full_meta = _smart_tree_to_pgn(tree, chapter_name="Bookup Smart Theory")
    full_compact = " ".join(full_pgn.split())
    require("1. e4 d6" in full_compact and "2. d4" in full_compact, "full_pgn_replays_setup_before_branch", full_pgn)
    require("[FEN " not in full_pgn, "full_pgn_does_not_hide_setup_as_fen", full_pgn)
    require("Setup from your repertoire" in full_pgn, "full_pgn_setup_comment")
    require(int(full_meta.get("setup_moves_exported", 0) or 0) == 2, "full_pgn_setup_count")

    subtree_pgn, subtree_meta = _smart_subtree_to_pgn(
        tree,
        anchor_node_id="n1",
        chapter_name="Pirc vs e4",
    )
    subtree_compact = " ".join(subtree_pgn.split())
    require("1. e4 d6" in subtree_compact and "2. d4" in subtree_compact, "subtree_pgn_replays_setup_before_anchor", subtree_pgn)
    require("2... Nf6" in subtree_compact or "2...Nf6" in subtree_compact, "subtree_pgn_continues_after_anchor", subtree_pgn)
    require(int(subtree_meta.get("setup_moves_exported", 0) or 0) == 2, "subtree_pgn_setup_count")


def test_pgn_export_extends_short_leaf_to_move_20() -> None:
    legal_line = (
        "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 "
        "f1e1 b7b5 a4b3 d7d6 c2c3 e8g8 h2h3 c8b7 d2d4 f8e8 "
        "b1d2 e7f8 d2f1 h7h6 f1g3 c6a5 b3c2 c7c5 d4d5 a5c4 "
        "b2b3 c4b6 c3c4 b5c4 b3c4 a6a5 c1d2 g7g6 a2a4 f8g7"
    ).split()
    board = chess.Board()
    for index, move_uci in enumerate(legal_line, start=1):
        move = chess.Move.from_uci(move_uci)
        require(move in board.legal_moves, f"depth_test_line_legal_{index}", board.fen())
        board.push(move)
    continuation = legal_line[1:]
    tree = {
        "effective_start_fen": chess.STARTING_FEN,
        "openingName": "Smart Theory Depth Test",
        "nodes": [
            {"id": "root", "parentId": "", "fen": chess.STARTING_FEN, "normalizedFen": "root", "children": ["n1"]},
            {
                "id": "n1",
                "parentId": "root",
                "uci": "e2e4",
                "san": "e4",
                "classification": "Best",
                "isUserSide": True,
                "bestMoveSan": "e4",
                "principalVariation": ["e4"],
                "continuationAfterMoveUci": continuation,
                "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
                "normalizedFen": "n1",
                "children": [],
            },
        ],
    }
    pgn_text, meta = _smart_tree_to_pgn(tree, chapter_name="Bookup Smart Theory")
    require(int(meta.get("moves_exported", 0) or 0) >= 40, "pgn_tail_extends_to_move_20", pgn_text)
    require("20." in " ".join(pgn_text.split()), "pgn_tail_has_move_20_marker", pgn_text)


def test_chapter_detection_uses_setup_context_and_concise_titles() -> None:
    chapters = _smart_tree_chapter_exports(
        sample_tree_with_setup(),
        strategy="first_move",
        chapter_name_base="Bookup Smart Theory",
    )
    require(bool(chapters), "smart_chapter_detection_has_chapters")
    first_name = str(chapters[0].get("name", "") or "")
    require("Pirc vs e4" in first_name, "smart_chapter_detection_uses_setup_context", first_name)
    require(len(first_name) <= 100, "smart_chapter_title_under_lichess_limit", first_name)


def test_preview_chapters_endpoint() -> None:
    with app.test_client() as client:
        response = client.post(
            "/api/smart-theory/preview-chapters",
            json={
                "chapter_name": "Bookup Smart Theory",
                "chapter_strategy": "first_move",
                "tree": sample_tree(),
            },
        )
        payload = response.get_json() or {}
        require(response.status_code == 200, "preview_chapters_status_200", str(payload))
        require(int(payload.get("chapters_count", 0) or 0) >= 1, "preview_chapters_count")
        chapters = payload.get("chapters", []) if isinstance(payload.get("chapters"), list) else []
        first = chapters[0] if chapters else {}
        require(bool(str(first.get("name", "") or "").strip()), "preview_chapter_name_present")
        require(bool(str(first.get("pgn_excerpt", "") or "").strip()), "preview_chapter_excerpt_present")


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
                "lichess_token": "test-token",
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


def test_opening_focus_does_not_override_selected_color() -> None:
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
    require(str(settings_used.get("my_color", "")).lower() == "white", "kings_indian_defense_keeps_selected_white")
    require(str(result.get("opening_focus", "")).lower() == "inferred_style", "legacy_focus_ignored_for_white")

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
    require(str(settings_used2.get("my_color", "")).lower() == "black", "kings_indian_attack_keeps_selected_black")
    require(str(result2.get("opening_focus", "")).lower() == "inferred_style", "legacy_focus_ignored_for_black")


def test_legacy_opening_focus_does_not_force_moves() -> None:
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
        expected_white = next(iter(chess.Board().legal_moves)).uci()
        require(str(kia_moves[0].get("uci", "")) == expected_white, "legacy_focus_does_not_force_nf3")

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
        pirc_board = chess.Board()
        pirc_board.push(chess.Move.from_uci("e2e4"))
        expected_black = next(iter(pirc_board.legal_moves)).uci()
        require(str(pirc_moves[0].get("uci", "")) == expected_black, "legacy_focus_does_not_force_pirc_d6")


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
            board_d4 = board.copy(stack=False)
            board_d4.push(d4)
            d4_reply = next(iter(board_d4.legal_moves), None)
            board_e4 = board.copy(stack=False)
            board_e4.push(e4)
            e4_reply = next(iter(board_e4.legal_moves), None)
            pv_d4 = [d4] + ([d4_reply] if d4_reply is not None else [])
            pv_e4 = [e4] + ([e4_reply] if e4_reply is not None else [])
            return [
                {"pv": pv_d4, "score": chess.engine.PovScore(chess.engine.Cp(0), chess.WHITE)},
                {"pv": pv_e4, "score": chess.engine.PovScore(chess.engine.Cp(10), chess.WHITE)},
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
        "cache_evaluations": False,
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
    require(not bool(opp_without[0].get("isBestEngineReply")), "best_reply_toggle_disabled_not_flagged_engine_best")
    require(bool(opp_with[0].get("isBestEngineReply")), "best_reply_toggle_enabled_flagged_engine_best")
    require(bool(str(opp_with[0].get("recommendedResponseUci", "") or "").strip()), "best_reply_toggle_has_recommended_response")
    require("Best response for your side:" in str(opp_with[0].get("theoryExplanation", "")), "best_reply_toggle_theory_includes_response")
    require(bool(str(opp_with[0].get("threatSummary", "") or "").strip()), "best_reply_toggle_has_threat_summary")
    require(bool(str(opp_with[0].get("bestResponseSummary", "") or "").strip()), "best_reply_toggle_has_best_response_summary")


def test_user_style_priors_influence_user_move_choice() -> None:
    class _Settings:
        depth = 12
        think_time_sec = 0.2

    class _FakeEngine:
        settings = _Settings()
        worker_count = 1

        def analyse(self, board: chess.Board, *, depth: int, multipv: int, time_sec: float | None = None):
            candidates = [mv for mv in board.legal_moves if mv.uci() in {"d2d4", "e2e4"}]
            if len(candidates) < 2:
                candidates = list(board.legal_moves)[:2]
            if not candidates:
                return []
            d4 = next((mv for mv in candidates if mv.uci() == "d2d4"), candidates[0])
            e4 = next((mv for mv in candidates if mv.uci() == "e2e4"), candidates[-1])
            return [
                {"pv": [d4], "score": chess.engine.PovScore(chess.engine.Cp(8), chess.WHITE)},
                {"pv": [e4], "score": chess.engine.PovScore(chess.engine.Cp(4), chess.WHITE)},
            ]

    def fake_database_context(board: chess.Board, *, play_uci: list[str], limit: int):
        return {
            "database_moves": [
                {"uci": "d2d4", "popularity": 16.0, "games": 1200},
                {"uci": "e2e4", "popularity": 22.0, "games": 1800},
            ]
        }

    payload = {
        "my_color": "white",
        "opponent_accuracy": "mixed",
        "max_ply": 2,
        "max_positions": 20,
        "opponent_replies": 1,
        "opening_focus": "auto",
        "user_style_lines": [
            {
                "start_fen": chess.STARTING_FEN,
                "moves_uci": ["e2e4", "e7e5", "g1f3", "b8c6"],
                "weight": 5.0,
                "source": "test",
            }
        ],
    }
    with patch("bookup.analysis.database_context_for_board", side_effect=fake_database_context):
        result = generate_smart_theory_tree(chess.Board(), _FakeEngine(), payload=payload)
    user_nodes = [node for node in result.get("nodes", []) if isinstance(node, dict) and bool(node.get("isUserSide"))]
    require(bool(user_nodes), "style_priors_user_nodes_present")
    require(str(user_nodes[0].get("uci", "")) == "e2e4", "style_priors_prefer_user_move")
    require(int(result.get("user_style_positions_count", 0) or 0) >= 1, "style_priors_positions_count")


def test_inferred_user_line_is_spine_not_hidden_setup() -> None:
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
            if board.fen() == chess.STARTING_FEN:
                d4 = chess.Move.from_uci("d2d4")
                e4 = chess.Move.from_uci("e2e4")
                nf3 = chess.Move.from_uci("g1f3")
                return [
                    {"pv": [d4], "score": chess.engine.PovScore(chess.engine.Cp(8), chess.WHITE)},
                    {"pv": [e4], "score": chess.engine.PovScore(chess.engine.Cp(4), chess.WHITE)},
                    {"pv": [nf3], "score": chess.engine.PovScore(chess.engine.Cp(2), chess.WHITE)},
                ]
            return [{"pv": [moves[0]], "score": chess.engine.PovScore(chess.engine.Cp(0), chess.WHITE)}]

    def fake_database_context(board: chess.Board, *, play_uci: list[str], limit: int):
        return {"database_moves": []}

    payload = {
        "my_color": "white",
        "opponent_accuracy": "mixed",
        "max_ply": 2,
        "max_positions": 20,
        "opponent_replies": 1,
        "opening_focus": "kings_indian_attack",
        "start_play_uci": [],
        "user_book_line_uci": ["e2e4", "c7c5", "g1f3", "d7d6"],
        "user_style_lines": [
            {
                "start_fen": chess.STARTING_FEN,
                "moves_uci": ["e2e4", "c7c5", "g1f3", "d7d6"],
                "weight": 6.0,
                "source": "test",
                "player_color": "white",
            }
        ],
    }
    with patch("bookup.analysis.database_context_for_board", side_effect=fake_database_context):
        result = generate_smart_theory_tree(chess.Board(), _FakeEngine(), payload=payload)
    user_nodes = [node for node in result.get("nodes", []) if isinstance(node, dict) and bool(node.get("isUserSide"))]
    require(result.get("effective_start_fen") == chess.STARTING_FEN, "inferred_spine_start_not_advanced")
    require(result.get("applied_start_line_uci") == [], "inferred_spine_not_hidden_setup")
    require(bool(user_nodes), "inferred_spine_user_nodes_present")
    require(str(user_nodes[0].get("uci", "")) == "e2e4", "inferred_spine_prefers_user_move")
    require(str(user_nodes[0].get("uci", "")) != "g1f3", "opening_focus_does_not_beat_user_spine")


def test_backend_infers_spine_when_payload_omits_user_book_line() -> None:
    class _Settings:
        depth = 12
        think_time_sec = 0.2

    class _FakeEngine:
        settings = _Settings()
        worker_count = 1

        def analyse(self, board: chess.Board, *, depth: int, multipv: int, time_sec: float | None = None):
            legal_by_uci = {move.uci(): move for move in board.legal_moves}
            preferred_order = [
                ["d2d4", "e2e4", "g1f3"],
                ["c7c5", "e7e5", "d7d6"],
                ["d2d4", "g1f3", "b1c3"],
                ["d7d6", "b8c6", "g8f6"],
            ]
            chosen: list[chess.Move] = []
            for group in preferred_order:
                for uci in group:
                    move = legal_by_uci.get(uci)
                    if move is not None and move not in chosen:
                        chosen.append(move)
                if chosen:
                    break
            if not chosen:
                chosen = list(board.legal_moves)[:3]
            return [
                {"pv": [move], "score": chess.engine.PovScore(chess.engine.Cp(12 - (index * 4)), chess.WHITE)}
                for index, move in enumerate(chosen)
            ]

    def fake_database_context(board: chess.Board, *, play_uci: list[str], limit: int):
        legal = {move.uci() for move in board.legal_moves}
        if "c7c5" in legal:
            return {"database_moves": [{"uci": "c7c5", "popularity": 44.0, "games": 5000}]}
        return {"database_moves": []}

    payload = {
        "my_color": "white",
        "opponent_accuracy": "mixed",
        "max_ply": 3,
        "max_positions": 20,
        "opponent_replies": 1,
        "opening_focus": "kings_indian_attack",
        "start_play_uci": [],
        "user_style_lines": [
            {
                "start_fen": chess.STARTING_FEN,
                "moves_uci": ["e2e4", "c7c5", "g1f3", "d7d6"],
                "weight": 8.0,
                "source": "real_repertoire_shape",
            }
        ],
    }
    with patch("bookup.analysis.database_context_for_board", side_effect=fake_database_context):
        result = generate_smart_theory_tree(chess.Board(), _FakeEngine(), payload=payload)
    user_nodes = [node for node in result.get("nodes", []) if isinstance(node, dict) and bool(node.get("isUserSide"))]
    user_uci = [str(node.get("uci", "") or "") for node in user_nodes]
    require(result.get("effective_start_fen") == chess.STARTING_FEN, "backend_infer_start_not_advanced")
    require(str(result.get("user_book_line_source", "")) == "real_repertoire_shape", "backend_infer_source_recorded")
    require(result.get("user_book_line_uci", [])[:4] == ["e2e4", "c7c5", "g1f3", "d7d6"], "backend_infer_line_recorded")
    require(user_uci[:2] == ["e2e4", "g1f3"], "backend_infer_plays_user_spine")


def test_explicit_source_line_beats_unrelated_style_prior() -> None:
    class _Settings:
        depth = 12
        think_time_sec = 0.2

    class _FakeEngine:
        settings = _Settings()
        worker_count = 1

        def analyse(self, board: chess.Board, *, depth: int, multipv: int, time_sec: float | None = None):
            legal_by_uci = {move.uci(): move for move in board.legal_moves}
            preferred = ["e2e4", "d2d4", "g1f3", "e7e6", "d7d5", "g2g3", "f1g2"]
            moves = [legal_by_uci[uci] for uci in preferred if uci in legal_by_uci]
            if not moves:
                moves = list(board.legal_moves)[:3]
            return [
                {"pv": [move], "score": chess.engine.PovScore(chess.engine.Cp(20 - index), chess.WHITE)}
                for index, move in enumerate(moves[:4])
            ]

    def fake_database_context(board: chess.Board, *, play_uci: list[str], limit: int):
        legal = {move.uci() for move in board.legal_moves}
        moves = []
        for uci, popularity in (("e2e4", 48.0), ("g1f3", 19.0), ("d2d4", 18.0), ("e7e6", 30.0)):
            if uci in legal:
                moves.append({"uci": uci, "popularity": popularity, "games": int(popularity * 1000)})
        return {"database_moves": moves}

    payload = {
        "my_color": "white",
        "opponent_accuracy": "mixed",
        "max_ply": 4,
        "max_positions": 24,
        "opponent_replies": 1,
        "opening_focus": "kings_indian_systems",
        "start_play_uci": [],
        # The explicitly selected source line must stay authoritative. Style
        # priors may help only when no exact-position source move exists.
        "user_book_line_uci": ["e2e4", "d7d6", "d2d4", "g8f6"],
        "user_style_lines": [
            {
                "start_fen": chess.STARTING_FEN,
                "moves_uci": ["e2e4", "d7d6", "d2d4", "g8f6"],
                "weight": 9.0,
                "source": "stale_pirc_payload",
                "player_color": "black",
            },
            {
                "start_fen": chess.STARTING_FEN,
                "moves_uci": ["g1f3", "e7e6", "g2g3", "d7d5", "f1g2"],
                "weight": 3.0,
                "source": "white_nf3_system",
                "player_color": "white",
            },
        ],
    }
    with patch("bookup.analysis.database_context_for_board", side_effect=fake_database_context):
        result = generate_smart_theory_tree(chess.Board(), _FakeEngine(), payload=payload)
    user_nodes = [node for node in result.get("nodes", []) if isinstance(node, dict) and bool(node.get("isUserSide"))]
    user_uci = [str(node.get("uci", "") or "") for node in user_nodes]
    require(result.get("user_book_line_uci", [])[:4] == ["e2e4", "d7d6", "d2d4", "g8f6"], "explicit_source_line_preserved")
    require(bool(user_uci), "explicit_source_user_nodes_present")
    require(user_uci[0] == "e2e4", "explicit_source_first_move_followed")


def test_user_style_priors_fallback_when_too_weak() -> None:
    class _Settings:
        depth = 12
        think_time_sec = 0.2

    class _FakeEngine:
        settings = _Settings()
        worker_count = 1

        def analyse(self, board: chess.Board, *, depth: int, multipv: int, time_sec: float | None = None):
            candidates = [mv for mv in board.legal_moves if mv.uci() in {"d2d4", "e2e4"}]
            if len(candidates) < 2:
                candidates = list(board.legal_moves)[:2]
            if not candidates:
                return []
            d4 = next((mv for mv in candidates if mv.uci() == "d2d4"), candidates[0])
            e4 = next((mv for mv in candidates if mv.uci() == "e2e4"), candidates[-1])
            return [
                {"pv": [d4], "score": chess.engine.PovScore(chess.engine.Cp(35), chess.WHITE)},
                {"pv": [e4], "score": chess.engine.PovScore(chess.engine.Cp(-180), chess.WHITE)},
            ]

    def fake_database_context(board: chess.Board, *, play_uci: list[str], limit: int):
        return {
            "database_moves": [
                {"uci": "d2d4", "popularity": 18.0, "games": 1400},
                {"uci": "e2e4", "popularity": 24.0, "games": 2000},
            ]
        }

    payload = {
        "my_color": "white",
        "opponent_accuracy": "mixed",
        "max_ply": 2,
        "max_positions": 20,
        "opponent_replies": 1,
        "opening_focus": "auto",
        "user_style_lines": [
            {
                "start_fen": chess.STARTING_FEN,
                "moves_uci": ["e2e4", "c7c5", "g1f3", "d7d6"],
                "weight": 6.0,
                "source": "test",
            }
        ],
    }
    with patch("bookup.analysis.database_context_for_board", side_effect=fake_database_context):
        result = generate_smart_theory_tree(chess.Board(), _FakeEngine(), payload=payload)
    user_nodes = [node for node in result.get("nodes", []) if isinstance(node, dict) and bool(node.get("isUserSide"))]
    require(bool(user_nodes), "style_priors_fallback_user_nodes_present")
    require(str(user_nodes[0].get("uci", "")) == "d2d4", "style_priors_fallback_prefers_best")
    require(all(str(node.get("uci", "")) != "e2e4" for node in user_nodes), "style_priors_fallback_does_not_export_bad_user_move")
    require(str(user_nodes[0].get("stylePreferredMoveUci", "")) == "e2e4", "style_priors_fallback_records_style_move")
    require(not bool(user_nodes[0].get("styleMatchedMove")), "style_priors_fallback_not_matched")


def test_black_user_move_that_improves_white_eval_is_not_blunder() -> None:
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
            preferred = next((mv for mv in moves if mv.uci() == "d7d6"), moves[0])
            noisy = next((mv for mv in moves if mv.uci() != preferred.uci()), preferred)
            # Deliberately put a worse non-style move first. Old code used
            # absolute White-perspective swing and could label the good Black
            # style move as a blunder when the eval dropped for White.
            return [
                {"pv": [noisy], "score": chess.engine.PovScore(chess.engine.Cp(120), chess.WHITE)},
                {"pv": [preferred], "score": chess.engine.PovScore(chess.engine.Cp(-260), chess.WHITE)},
            ]

    def fake_database_context(board: chess.Board, *, play_uci: list[str], limit: int):
        return {"database_moves": []}

    board = chess.Board()
    board.push(chess.Move.from_uci("e2e4"))
    with patch("bookup.analysis.database_context_for_board", side_effect=fake_database_context):
        result = generate_smart_theory_tree(
            board,
            _FakeEngine(),
            payload={
                "my_color": "black",
                "opening_focus": "pirc_defense",
                "starting_source": "saved_line",
                "user_book_line_uci": ["d7d6"],
                "opponent_accuracy": "mixed",
                "max_ply": 1,
                "max_positions": 12,
                "opponent_replies": 1,
            },
        )
    user_nodes = [node for node in result.get("nodes", []) if isinstance(node, dict) and bool(node.get("isUserSide"))]
    require(bool(user_nodes), "black_eval_user_node_present")
    require(str(user_nodes[0].get("uci", "")) == "d7d6", "black_eval_prefers_pirc_move")
    require(str(user_nodes[0].get("classification", "")) in {"Best", "Excellent", "Good"}, "black_eval_not_mislabeled_blunder", str(user_nodes[0]))
    require(int(user_nodes[0].get("userLossCp", 999)) == 0, "black_eval_user_loss_zero", str(user_nodes[0]))


def test_opposite_color_style_lines_do_not_become_my_moves() -> None:
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
            preferred = next((mv for mv in moves if mv.uci() == "d7d6"), moves[0])
            opposite_color_style = next((mv for mv in moves if mv.uci() == "c7c5"), preferred)
            return [
                {"pv": [preferred], "score": chess.engine.PovScore(chess.engine.Cp(-45), chess.WHITE)},
                {"pv": [opposite_color_style], "score": chess.engine.PovScore(chess.engine.Cp(-10), chess.WHITE)},
            ]

    board = chess.Board()
    board.push(chess.Move.from_uci("e2e4"))
    result = generate_smart_theory_tree(
        board,
        _FakeEngine(),
        payload={
            "my_color": "black",
            "opening_focus": "auto",
            "opponent_accuracy": "mixed",
            "max_ply": 1,
            "max_positions": 12,
            "opponent_replies": 1,
            "style_move_confidence_cp": 90,
            "user_style_lines": [
                {
                    "start_fen": chess.STARTING_FEN,
                    "moves_uci": ["e2e4", "c7c5"],
                    "weight": 6.0,
                    "player_color": "white",
                    "source": "opposite-color-test",
                }
            ],
        },
    )
    user_nodes = [node for node in result.get("nodes", []) if isinstance(node, dict) and bool(node.get("isUserSide"))]
    require(bool(user_nodes), "opposite_color_style_user_nodes_present")
    require(str(user_nodes[0].get("uci", "")) == "d7d6", "opposite_color_style_skips_opponent_move", str(user_nodes[0]))
    require(int(result.get("user_style_positions_count", 0) or 0) == 0, "opposite_color_style_not_counted")


def test_opposite_color_reference_line_is_not_followed_as_my_line() -> None:
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
            preferred = next((mv for mv in moves if mv.uci() == "d7d6"), moves[0])
            wrong_reference = next((mv for mv in moves if mv.uci() == "c7c5"), preferred)
            return [
                {"pv": [preferred], "score": chess.engine.PovScore(chess.engine.Cp(-45), chess.WHITE)},
                {"pv": [wrong_reference], "score": chess.engine.PovScore(chess.engine.Cp(-20), chess.WHITE)},
            ]

    board = chess.Board()
    board.push(chess.Move.from_uci("e2e4"))
    result = generate_smart_theory_tree(
        board,
        _FakeEngine(),
        payload={
            "my_color": "black",
            "opening_focus": "auto",
            "opponent_accuracy": "mixed",
            "max_ply": 1,
            "max_positions": 12,
            "opponent_replies": 1,
            "expected_move_confidence_cp": 125,
            "user_book_line_uci": ["c7c5"],
            "user_book_line_player_color": "white",
        },
    )
    user_nodes = [node for node in result.get("nodes", []) if isinstance(node, dict) and bool(node.get("isUserSide"))]
    require(bool(user_nodes), "opposite_color_reference_user_nodes_present")
    require(str(user_nodes[0].get("uci", "")) == "d7d6", "opposite_color_reference_skips_opponent_move", str(user_nodes[0]))
    require(str(user_nodes[0].get("originalUserMove", "")) == "", "opposite_color_reference_not_marked_original")


def test_background_auto_sync_during_job() -> None:
    job_id = "test-job-background-sync"
    board_fen = chess.STARTING_FEN
    payload = {
        "auto_sync_to_study": True,
        "lichess_token": "test-token",
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
    ), patch(
        "bookup.app._list_lichess_study_chapters", return_value=[]
    ), patch("bookup.app._post_pgn_to_lichess_study", side_effect=fake_import), patch(
        "bookup.app._cleanup_default_placeholder_chapters",
        return_value={"deleted_count": 1, "deleted_chapter_ids": ["abc"], "errors": []},
    ):
        _run_smart_theory_job(
            job_id=job_id,
            board_fen=board_fen,
            payload=payload,
            settings=settings,
            lichess_token="test-token",
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
        "lichess_token": "test-token",
        "study_id": "AbCdEf12",
        "chapter_name": "Bookup Smart Theory",
        "chapter_strategy": "first_move",
        "orientation": "white",
    }
    fake_result = {
        **sample_tree(),
        "status": "stopped",
        "positions_done": 0,
        "positions_total": 1,
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
            lichess_token="test-token",
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
        "bookup.app._list_lichess_study_chapters", return_value=[]
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
                "lichess_token": "test-token",
                "auto_create_unified_study": True,
                "unified_study_name": "Bookup",
                "chapter_name": "Bookup Smart Theory",
                "chapter_strategy": "first_move",
                "replace_existing_chapters": False,
                "orientation": "white",
                "tree": sample_tree(),
            },
        )
        payload = response.get_json() or {}
        require(response.status_code == 200, "manual_cleanup_export_status_200", str(payload))
        require(cleanup_mock.called, "manual_cleanup_called")
        cleanup = payload.get("cleanup", {}) if isinstance(payload.get("cleanup"), dict) else {}
        require(int(cleanup.get("deleted_count", 0) or 0) == 1, "manual_cleanup_deleted_count")


def test_cleanup_runs_for_existing_study_exports() -> None:
    with app.test_client() as client, patch("bookup.app.load_config", return_value={}), patch(
        "bookup.app.save_config", return_value=None
    ), patch(
        "bookup.app._post_pgn_to_lichess_study",
        return_value={"ok": True, "response": {"ok": True}},
    ), patch(
        "bookup.app._cleanup_default_placeholder_chapters",
        return_value={"deleted_count": 1, "deleted_chapter_ids": ["legacy"], "errors": []},
    ) as cleanup_mock:
        response = client.post(
            "/api/smart-theory/export-lichess-study",
            json={
                "study_id": "AbCdEf12",
                "lichess_token": "test-token",
                "auto_create_unified_study": False,
                "chapter_name": "Bookup Smart Theory",
                "chapter_strategy": "single",
                "replace_existing_chapters": False,
                "orientation": "white",
                "pgn": "1. d4 Nf6 *",
            },
        )
        payload = response.get_json() or {}
        require(response.status_code == 200, "existing_study_cleanup_export_status_200", str(payload))
        require(cleanup_mock.called, "existing_study_cleanup_called")
        cleanup = payload.get("cleanup", {}) if isinstance(payload.get("cleanup"), dict) else {}
        require(int(cleanup.get("deleted_count", 0) or 0) == 1, "existing_study_cleanup_deleted_count")


def test_replace_existing_chapters_deletes_before_export() -> None:
    events: list[str] = []

    def fake_delete(*, study_id: str, chapter_id: str, token: str) -> dict:
        require(study_id == "AbCdEf12", "replace_delete_study_id")
        events.append(f"delete:{chapter_id}")
        return {"ok": True}

    def fake_import(*, study_id: str, token: str, chapter_name: str, pgn_text: str, orientation: str) -> dict:
        require(events == ["delete:old1", "delete:old2"], "replace_delete_before_import", str(events))
        events.append("import")
        return {"ok": True, "response": {"ok": True}}

    with app.test_client() as client, patch("bookup.app.load_config", return_value={}), patch(
        "bookup.app.save_config", return_value=None
    ), patch(
        "bookup.app._list_lichess_study_chapters",
        return_value=[
            {"chapter_id": "old1", "chapter_name": "Old line", "plies": 12},
            {"chapter_id": "old2", "chapter_name": "Old mistake", "plies": 8},
        ],
    ), patch("bookup.app._delete_lichess_study_chapter", side_effect=fake_delete), patch(
        "bookup.app._post_pgn_to_lichess_study", side_effect=fake_import
    ):
        response = client.post(
            "/api/smart-theory/export-lichess-study",
            json={
                "study_id": "AbCdEf12",
                "lichess_token": "test-token",
                "auto_create_unified_study": False,
                "chapter_name": "Bookup Smart Theory",
                "chapter_strategy": "single",
                "replace_existing_chapters": True,
                "orientation": "white",
                "pgn": "1. d4 Nf6 *",
            },
        )
        payload = response.get_json() or {}
        require(response.status_code == 200, "replace_export_status_200", str(payload))
        require(events == ["delete:old1", "delete:old2", "import"], "replace_event_order", str(events))
        cleanup = payload.get("cleanup", {}) if isinstance(payload.get("cleanup"), dict) else {}
        require(int(cleanup.get("deleted_count", 0) or 0) == 2, "replace_deleted_count")


def test_cleanup_placeholder_uses_event_name_fallback() -> None:
    deleted: list[str] = []

    def fake_delete(*, study_id: str, chapter_id: str, token: str) -> dict:
        deleted.append(str(chapter_id))
        return {"ok": True}

    with patch(
        "bookup.app._list_lichess_study_chapters",
        return_value=[
            {"chapter_id": "c1", "chapter_name": "", "event_name": "Chapter 1", "plies": 0},
            {"chapter_id": "c2", "chapter_name": "Real Chapter", "event_name": "Real Chapter", "plies": 12},
        ],
    ), patch("bookup.app._delete_lichess_study_chapter", side_effect=fake_delete):
        from bookup.app import _cleanup_default_placeholder_chapters

        result = _cleanup_default_placeholder_chapters(study_id="AbCdEf12", token="test-token")
        require(int(result.get("deleted_count", 0) or 0) == 1, "placeholder_event_fallback_deleted_count")
        require("c1" in deleted and "c2" not in deleted, "placeholder_event_fallback_deleted_expected")


def test_auto_create_uses_configured_study_name_when_payload_missing() -> None:
    captured: dict[str, str] = {"study_name": ""}

    def fake_create(*, token: str, study_name: str, visibility: str) -> dict:
        captured["study_name"] = str(study_name or "")
        return {"study_id": "S1udY123", "study_url": "https://lichess.org/study/S1udY123", "response": {"id": "S1udY123"}}

    with app.test_client() as client, patch(
        "bookup.app.load_config",
        return_value={"bookup_study_name": "Bookup Config Title"},
    ), patch("bookup.app.save_config", return_value=None), patch(
        "bookup.app._create_lichess_study",
        side_effect=fake_create,
    ), patch(
        "bookup.app._list_lichess_study_chapters", return_value=[]
    ), patch(
        "bookup.app._post_pgn_to_lichess_study",
        return_value={"ok": True, "response": {"ok": True}},
    ):
        response = client.post(
            "/api/smart-theory/export-lichess-study",
            json={
                "study_id": "",
                "lichess_token": "test-token",
                "auto_create_unified_study": True,
                "chapter_name": "Bookup Smart Theory",
                "chapter_strategy": "single",
                "orientation": "white",
                "pgn": "1. d4 Nf6 *",
            },
        )
        payload = response.get_json() or {}
        require(response.status_code == 200, "auto_create_config_study_name_status_200", str(payload))
        require(captured["study_name"] == "Bookup Config Title", "auto_create_config_study_name_used")


def test_refresh_unified_study_endpoint() -> None:
    with app.test_client() as client, patch("bookup.app.load_config", return_value={}), patch(
        "bookup.app.save_config", return_value=None
    ), patch(
        "bookup.app._create_lichess_study",
        return_value={"study_id": "R3fRe5h1", "study_url": "https://lichess.org/study/R3fRe5h1", "response": {"id": "R3fRe5h1"}},
    ), patch(
        "bookup.app._list_lichess_study_chapters", return_value=[]
    ), patch(
        "bookup.app._cleanup_default_placeholder_chapters",
        return_value={"deleted_count": 1, "deleted_chapter_ids": ["abc"], "errors": []},
    ):
        response = client.post(
            "/api/smart-theory/refresh-unified-study",
            json={
                "lichess_token": "test-token",
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
    test_settings_study_name_round_trip()
    test_settings_style_confidence_round_trip()
    test_defaults_do_not_expose_lichess_token()
    test_auto_create_and_chapter_naming()
    test_pgn_comments_include_engine_reply_metadata()
    test_pgn_export_includes_setup_path_before_generated_branch()
    test_pgn_export_extends_short_leaf_to_move_20()
    test_chapter_detection_uses_setup_context_and_concise_titles()
    test_preview_chapters_endpoint()
    test_unknown_focus_chapter_anchors()
    test_start_line_kept_when_book_lookup_unavailable()
    test_corrections_not_limited_to_root()
    test_opening_focus_does_not_override_selected_color()
    test_legacy_opening_focus_does_not_force_moves()
    test_include_best_engine_replies_toggle()
    test_user_style_priors_influence_user_move_choice()
    test_inferred_user_line_is_spine_not_hidden_setup()
    test_backend_infers_spine_when_payload_omits_user_book_line()
    test_explicit_source_line_beats_unrelated_style_prior()
    test_user_style_priors_fallback_when_too_weak()
    test_black_user_move_that_improves_white_eval_is_not_blunder()
    test_opposite_color_style_lines_do_not_become_my_moves()
    test_opposite_color_reference_line_is_not_followed_as_my_line()
    test_background_auto_sync_during_job()
    test_background_auto_sync_skips_without_token()
    test_background_auto_sync_skips_when_generation_stopped()
    test_manual_export_cleanup_placeholder_called()
    test_cleanup_runs_for_existing_study_exports()
    test_replace_existing_chapters_deletes_before_export()
    test_cleanup_placeholder_uses_event_name_fallback()
    test_auto_create_uses_configured_study_name_when_payload_missing()
    test_refresh_unified_study_endpoint()
    print("ALL SMART THEORY LICHESS REGRESSION CHECKS PASSED")
