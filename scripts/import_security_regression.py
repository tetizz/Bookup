"""Focused regressions for Bookup imports, local API security, and explorer privacy."""

from __future__ import annotations

import io
import sys
from pathlib import Path
from unittest.mock import patch

import chess
import chess.pgn

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import bookup.analysis as analysis
import bookup.app as app_module
import bookup.chesscom as chesscom
from bookup.progress_tracker import infer_time_class as infer_progress_time_class


def require(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"PASS {label}")


def sample_game() -> chesscom.ImportedGame:
    pgn = """[Event "Import regression"]
[White "RegressionUser"]
[Black "Opponent"]
[TimeControl "300+5"]
[Result "1-0"]

1. e4 e5 1-0
"""
    game = chess.pgn.read_game(io.StringIO(pgn))
    assert game is not None
    return chesscom.ImportedGame(
        url="https://www.chess.com/game/live/regression",
        time_class="blitz",
        player_color="white",
        result="win",
        opponent="Opponent",
        pgn=pgn,
        game=game,
    )


def test_time_classes() -> None:
    require(chesscom.infer_time_class({"TimeControl": "300+5"}) == "blitz", "desktop_300_plus_5_is_blitz")
    require(chesscom.infer_time_class({"TimeControl": "600"}) == "rapid", "desktop_600_is_rapid")
    require(
        infer_progress_time_class({"time_control": "300+5"}) == "blitz",
        "progress_300_plus_5_matches_import",
    )
    require(chesscom.normalize_time_classes(["all"]) == set(), "all_time_classes_supported")
    try:
        chesscom.normalize_time_classes(["all", "rapid"])
    except ValueError:
        pass
    else:
        raise AssertionError("mixed_all_rejected")
    print("PASS mixed_all_rejected")
    try:
        chesscom.normalize_time_classes(["hyper"])
    except ValueError:
        pass
    else:
        raise AssertionError("unknown_time_class_rejected")
    print("PASS unknown_time_class_rejected")


def test_partial_archives() -> None:
    imported = sample_game()

    def archive_result(url: str, _username: str, _target: set[str]):
        if url.endswith("/06"):
            raise RuntimeError("temporary archive failure")
        return [imported]

    archives = [
        "https://api.chess.com/pub/player/regressionuser/games/2026/05",
        "https://api.chess.com/pub/player/regressionuser/games/2026/06",
    ]
    with patch("bookup.chesscom._fetch_archive_games", side_effect=archive_result):
        result = chesscom.fetch_games("RegressionUser", ["blitz"], None, archives=archives)
    require(len(result) == 1, "partial_archive_preserves_good_games")
    require(len(result.warnings) == 1, "partial_archive_exposes_warning")
    require(len(result.failed_archives) == 1, "partial_archive_tracks_failed_month")

    with patch("bookup.chesscom._fetch_archive_games", side_effect=RuntimeError("offline")):
        try:
            chesscom.fetch_games("RegressionUser", ["blitz"], 20, archives=archives)
        except chesscom.ArchiveImportError as exc:
            require(len(exc.warnings) == 2, "all_failed_archives_expose_warnings")
        else:
            raise AssertionError("all_failed_archives_fail_when_no_games")
    print("PASS all_failed_archives_fail_when_no_games")


def test_bounded_recent_archive_batches() -> None:
    imported = sample_game()
    calls: list[str] = []
    archives = [
        f"https://api.chess.com/pub/player/regressionuser/games/2025/{month:02d}"
        for month in range(1, 11)
    ]

    def many_games(url: str, _username: str, _target: set[str]):
        calls.append(url)
        return [imported] * 100

    with patch("bookup.chesscom._fetch_archive_games", side_effect=many_games):
        result = chesscom.fetch_games("RegressionUser", ["blitz"], 240, archives=archives)
    require(len(result) == 240, "bounded_import_respects_requested_game_limit")
    require(len(calls) == 3, "bounded_import_stops_after_recent_batch")
    require(calls[0] == archives[-1], "bounded_import_starts_with_newest_archive")


def test_explorer_is_local_only() -> None:
    analysis.configure_lichess("study-secret-for-regression")
    require(analysis.EXPLORER_AVAILABLE is False, "online_explorer_is_disabled")
    with patch("requests.get") as request_get:
        require(analysis._explorer_lookup(chess.Board(), "") == {}, "explorer_lookup_uses_empty_local_fallback")
    require(not request_get.called, "explorer_lookup_makes_no_network_request")
    desktop_source = (ROOT / "bookup" / "static" / "app.js").read_text(encoding="utf-8")
    require(
        "Public Lichess database" not in desktop_source
        and "Lichess practical replies" not in desktop_source,
        "desktop_does_not_claim_public_explorer",
    )
    require(
        "Imported-game position history" in desktop_source,
        "desktop_uses_imported_position_copy",
    )


def test_local_request_security() -> None:
    app_module.configure_local_request_security(True, port=8877)
    try:
        with patch("bookup.app.load_config", return_value={}), patch("bookup.app.save_config", return_value=None):
            with app_module.app.test_client() as client:
                root = client.get("/", base_url="http://127.0.0.1:8877")
                require(root.status_code == 200, "local_root_allowed")
                require(root.headers.get("Cache-Control") == "no-store", "token_bootstrap_not_cached")
                require(
                    root.headers.get("Content-Security-Policy") == "frame-ancestors 'none'"
                    and root.headers.get("X-Frame-Options") == "DENY",
                    "local_app_cannot_be_framed",
                )
                require(
                    root.headers.get("X-Bookup-Launch") == app_module.LOCAL_REQUEST_TOKEN,
                    "local_launch_probe_is_instance_specific",
                )
                require("X-Bookup-Request" in root.get_data(as_text=True), "token_bootstrap_installs_header")

                bad_host = client.get("/", base_url="http://attacker.test:8877")
                require(bad_host.status_code == 403, "dns_rebinding_host_rejected")

                missing_token = client.post(
                    "/api/legal-moves",
                    base_url="http://127.0.0.1:8877",
                    json={"fen": "startpos"},
                )
                require(missing_token.status_code == 403, "mutation_without_launch_token_rejected")

                bad_origin = client.post(
                    "/api/legal-moves",
                    base_url="http://127.0.0.1:8877",
                    headers={
                        "Origin": "http://attacker.test:8877",
                        "X-Bookup-Request": app_module.LOCAL_REQUEST_TOKEN,
                    },
                    json={"fen": "startpos"},
                )
                require(bad_origin.status_code == 403, "cross_origin_mutation_rejected")

                valid = client.post(
                    "/api/legal-moves",
                    base_url="http://127.0.0.1:8877",
                    headers={
                        "Origin": "http://127.0.0.1:8877",
                        "X-Bookup-Request": app_module.LOCAL_REQUEST_TOKEN,
                    },
                    json={"fen": "startpos"},
                )
                require(valid.status_code == 200, "authenticated_local_mutation_allowed")
    finally:
        app_module.configure_local_request_security(False)


def test_saved_token_removal() -> None:
    saved_payload: dict = {}

    def capture_config(payload: dict) -> None:
        saved_payload.update(payload)

    configured = {"lichess_token": "configured-value"}
    with (
        patch("bookup.app.load_config", return_value=configured),
        patch("bookup.app.save_config", side_effect=capture_config),
        patch("bookup.app.close_live_engine", return_value=None),
    ):
        with app_module.app.test_client() as client:
            response = client.post("/api/settings", json={"lichess_token": ""})
    require(response.status_code == 200, "saved_token_removal_request_succeeds")
    require(saved_payload.get("lichess_token") == "", "saved_token_is_erased")
    require(
        response.get_json()["defaults"]["lichess_token_configured"] is False,
        "saved_token_removal_is_reported_to_ui",
    )

    environment_saved: dict = {}
    with (
        patch.dict(app_module.os.environ, {"LICHESS_TOKEN": "environment-value"}, clear=False),
        patch("bookup.app.load_config", return_value=configured),
        patch("bookup.app.save_config", side_effect=lambda payload: environment_saved.update(payload)),
        patch("bookup.app.close_live_engine", return_value=None),
    ):
        with app_module.app.test_client() as client:
            environment_response = client.post("/api/settings", json={"lichess_token": ""})
    require(environment_saved.get("lichess_token") == "", "config_token_is_cleared_with_environment_fallback")
    require(
        environment_response.get_json()["defaults"]["lichess_token_configured"] is True,
        "environment_token_remains_authoritative",
    )


def test_partial_cache_retry_and_config_preservation() -> None:
    partial_snapshot = {
        "schema_version": app_module.PROFILE_SCHEMA_VERSION,
        "games_schema_version": app_module.GAMES_CACHE_SCHEMA_VERSION,
        "profile": {},
        "games": [{"url": "cached-game"}],
        "import_warnings": ["2026/06: temporary failure"],
        "failed_archives": ["https://api.chess.com/pub/player/example/games/2026/06"],
    }
    with (
        patch("bookup.app.load_config", return_value={"username": "Example"}),
        patch.object(app_module.STORE, "load_snapshot", return_value=partial_snapshot),
        patch("bookup.app.fetch_archives") as fetch_archive_list,
    ):
        with app_module.app.test_client() as client:
            response = client.post("/api/auto-import-status", json={"username": "Example"})
    require(response.status_code == 200, "partial_cache_retry_status_succeeds")
    require(response.get_json()["reason"] == "incomplete_archive_retry", "partial_cache_is_not_treated_as_complete")
    require(not fetch_archive_list.called, "partial_cache_retry_does_not_need_discovery_check")

    import inspect

    require("**config" in inspect.getsource(app_module.profile), "profile_import_preserves_existing_config")
    require("**config" in inspect.getsource(app_module.import_pgn), "pgn_import_preserves_existing_config")
    require(
        '"time_classes": "pgn"' not in inspect.getsource(app_module.import_pgn)
        and '"max_games": len(games)' not in inspect.getsource(app_module.import_pgn),
        "pgn_import_preserves_chesscom_scope",
    )
    require(
        '"time_classes": "chessnut"' not in inspect.getsource(app_module.import_chessnut)
        and '"max_games": len(games)' not in inspect.getsource(app_module.import_chessnut),
        "chessnut_import_preserves_chesscom_scope",
    )
    server_source = inspect.getsource(app_module._start_local_server)
    require('make_server("127.0.0.1", port' in server_source, "desktop_server_binds_before_launch")
    require("X-Bookup-Launch" in server_source, "desktop_server_verifies_its_own_instance")


def test_service_worker_scope() -> None:
    source = (ROOT / "docs" / "sw.js").read_text(encoding="utf-8")
    require("key.startsWith(CACHE_PREFIX)" in source, "service_worker_only_deletes_bookup_caches")
    require(
        'response.ok && response.type === "basic" && contentType.includes("text/html")' in source,
        "service_worker_rejects_bad_navigation_cache_entries",
    )
    require(
        '"./product-shell.css"' in source and '"./product-shell.js"' in source,
        "service_worker_caches_complete_product_shell",
    )


def main() -> None:
    test_time_classes()
    test_partial_archives()
    test_bounded_recent_archive_batches()
    test_explorer_is_local_only()
    test_local_request_security()
    test_saved_token_removal()
    test_partial_cache_retry_and_config_preservation()
    test_service_worker_scope()
    print("ALL IMPORT AND SECURITY REGRESSIONS PASSED")


if __name__ == "__main__":
    main()
