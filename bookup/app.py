from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import chess
from flask import Flask, jsonify, render_template, request
import webview

from .analysis import analyse_games, build_position_insight, configure_lichess
from .chesscom import fetch_archives, fetch_games, normalize_time_classes
from .engine import EngineSession, EngineSettings, default_engine_path
from .storage import LocalStore, deserialize_games, serialize_games


APP_DIR = Path(__file__).resolve().parent
ROOT_DIR = APP_DIR.parent
RUNTIME_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else ROOT_DIR
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", ROOT_DIR))
CONFIG_PATH = RUNTIME_DIR / "config.json"
DATA_DIR = RUNTIME_DIR / "bookup_data"
STORE = LocalStore(DATA_DIR)
PROFILE_SCHEMA_VERSION = 7

app = Flask(
    __name__,
    template_folder=str(RESOURCE_DIR / "bookup" / "templates"),
    static_folder=str(RESOURCE_DIR / "bookup" / "static"),
)


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(payload: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def build_engine_settings(payload: dict) -> EngineSettings:
    engine_path = str(payload.get("engine_path", "")).strip() or default_engine_path()
    try:
        think_time_sec = float(payload.get("think_time_sec", 5.0) or 0)
    except (TypeError, ValueError):
        think_time_sec = 5.0
    return EngineSettings(
        path=engine_path,
        depth=max(10, min(30, int(payload.get("depth", 24)))),
        threads=max(1, min(max(1, os.cpu_count() or 8), int(payload.get("threads", max(1, os.cpu_count() or 8))))),
        hash_mb=max(256, min(32768, int(payload.get("hash_mb", 2048)))),
        multipv=max(1, min(10, int(payload.get("multipv", 5)))),
        think_time_sec=max(0.0, min(60.0, think_time_sec)),
    )


def apply_engine_settings_to_config(config: dict, settings: EngineSettings) -> dict:
    updated = dict(config)
    updated["engine_path"] = settings.path
    updated["depth"] = settings.depth
    updated["multipv"] = settings.multipv
    updated["threads"] = settings.threads
    updated["hash_mb"] = settings.hash_mb
    updated["think_time_sec"] = settings.think_time_sec
    return updated


def build_defaults_payload(config: dict) -> dict:
    settings = build_engine_settings(config)
    return {
        "username": config.get("username", "trixize1234"),
        "time_classes": config.get("time_classes", "all"),
        "max_games": int(config.get("max_games", 0)),
        "lichess_token": config.get("lichess_token", ""),
        "engine_path": settings.path,
        "depth": settings.depth,
        "threads": settings.threads,
        "hash_mb": settings.hash_mb,
        "multipv": settings.multipv,
        "think_time_sec": settings.think_time_sec,
    }


def profile_request_key(
    username: str,
    normalized_time_classes: list[str],
    max_games: int | None,
    lichess_token: str,
    settings: EngineSettings,
) -> str:
    return json.dumps(
        {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "username": username,
            "time_classes": sorted(normalized_time_classes),
            "max_games": 0 if max_games is None else max_games,
            "explorer_enabled": bool(lichess_token.strip()),
            "engine": {
                "path": settings.path,
                "depth": settings.depth,
                "threads": settings.threads,
                "hash_mb": settings.hash_mb,
                "multipv": settings.multipv,
                "think_time_sec": settings.think_time_sec,
            },
        },
        sort_keys=True,
    )


def game_request_key(
    username: str,
    normalized_time_classes: list[str],
    max_games: int | None,
) -> str:
    return json.dumps(
        {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "username": username,
            "time_classes": sorted(normalized_time_classes),
            "max_games": 0 if max_games is None else max_games,
        },
        sort_keys=True,
    )


def profile_response_payload(
    *,
    username: str,
    normalized_time_classes: list[str],
    archives_found: int,
    games: list[dict],
    profile_data: dict,
    progress: dict,
    lichess_token: str,
    cached: bool,
    reused_games: bool = False,
) -> dict:
    return {
        "username": username,
        "time_classes": sorted(normalized_time_classes) if normalized_time_classes else ["all public games"],
        "archives_found": archives_found,
        "games_imported": len(games),
        "games": games,
        "explorer_enabled": bool(lichess_token),
        "explorer_notice": (
            "Lichess explorer is authenticated and can be used for richer repertoire move popularity."
            if lichess_token
            else "Add a Lichess token to use the live Lichess opening database for richer repertoire branching."
        ),
        "schema_version": PROFILE_SCHEMA_VERSION,
        "profile": profile_data,
        "training_progress": progress.get("lessons", {}),
        "training_summary": progress.get("summary", {}),
        "cached": cached,
        "reused_games": reused_games,
    }


def serialize_legal_moves(board: chess.Board) -> list[dict]:
    moves: list[dict] = []
    for move in board.legal_moves:
        san = board.san(move)
        capture = board.is_capture(move)
        moves.append(
            {
                "uci": move.uci(),
                "from": chess.square_name(move.from_square),
                "to": chess.square_name(move.to_square),
                "san": san,
                "capture": capture,
            }
        )
    return moves



@app.get("/")
def index() -> str:
    config = load_config()
    bundled_engine = default_engine_path()
    default_engine = bundled_engine or config.get("engine_path", "")
    if getattr(sys, "frozen", False) and bundled_engine:
        engine_path = bundled_engine
    else:
        engine_path = config.get("engine_path", "") or default_engine
    defaults = build_defaults_payload({**config, "engine_path": engine_path})
    return render_template("index.html", defaults=defaults)


@app.get("/api/local-state")
def local_state() -> tuple:
    username = str(request.args.get("username", "")).strip() or "trixize1234"
    snapshot = STORE.load_snapshot(username)
    progress = STORE.load_progress(username)
    return jsonify(
        {
            "username": username,
            "profile": snapshot.get("profile"),
            "games_imported": snapshot.get("games_imported", 0),
            "archives_found": snapshot.get("archives_found", 0),
            "games": snapshot.get("games", []),
            "saved_at": snapshot.get("saved_at"),
            "training_progress": progress.get("lessons", {}),
            "training_summary": progress.get("summary", {}),
            "schema_version": snapshot.get("schema_version", 0),
        }
    )


@app.post("/api/settings")
def save_settings() -> tuple:
    payload = request.get_json(force=True)
    config = load_config()

    if "engine_path" in payload:
        engine_path = str(payload.get("engine_path", "")).strip() or default_engine_path()
        config["engine_path"] = engine_path
    if "depth" in payload:
        try:
            config["depth"] = int(payload.get("depth", config.get("depth", 24)))
        except (TypeError, ValueError):
            pass
    if "multipv" in payload:
        try:
            config["multipv"] = int(payload.get("multipv", config.get("multipv", 5)))
        except (TypeError, ValueError):
            pass
    if "threads" in payload:
        try:
            config["threads"] = int(payload.get("threads", config.get("threads", max(1, os.cpu_count() or 8))))
        except (TypeError, ValueError):
            pass
    if "hash_mb" in payload:
        try:
            config["hash_mb"] = int(payload.get("hash_mb", config.get("hash_mb", 2048)))
        except (TypeError, ValueError):
            pass
    if "lichess_token" in payload:
        config["lichess_token"] = str(payload.get("lichess_token", config.get("lichess_token", ""))).strip()
    if "think_time_sec" in payload:
        try:
            config["think_time_sec"] = float(payload.get("think_time_sec", config.get("think_time_sec", 5.0)))
        except (TypeError, ValueError):
            pass

    settings = build_engine_settings(config)
    config = apply_engine_settings_to_config(config, settings)
    save_config(config)
    configure_lichess(str(config.get("lichess_token", "")))

    return jsonify(
        {
            "ok": True,
            "defaults": build_defaults_payload(config),
        }
    )


@app.post("/api/profile")
def profile() -> tuple:
    payload = request.get_json(force=True)
    username = str(payload.get("username", "")).strip()
    if not username:
        return jsonify({"error": "Chess.com username is required."}), 400

    raw_time_classes = str(payload.get("time_classes", "all")).strip()
    time_classes = [item.strip() for item in raw_time_classes.split(",") if item.strip()]
    normalized_time_classes = normalize_time_classes(time_classes)
    raw_max_games = payload.get("max_games", 0)
    try:
        parsed_max_games = int(raw_max_games or 0)
    except (TypeError, ValueError):
        parsed_max_games = 0
    max_games = None if parsed_max_games <= 0 else max(1, min(20000, parsed_max_games))
    lichess_token = str(payload.get("lichess_token", "")).strip()
    engine_path = str(payload.get("engine_path", "")).strip() or default_engine_path()
    if not engine_path:
        return jsonify({"error": "Stockfish path is required."}), 400

    settings = build_engine_settings(payload)
    configure_lichess(lichess_token)
    request_key = profile_request_key(
        username,
        normalized_time_classes,
        max_games,
        lichess_token,
        settings,
    )
    games_cache_key = game_request_key(username, normalized_time_classes, max_games)

    save_config(
        apply_engine_settings_to_config(
            {
                "username": username,
                "time_classes": raw_time_classes or "all",
                "max_games": 0 if max_games is None else max_games,
                "lichess_token": lichess_token,
                "engine_path": engine_path,
            },
            settings,
        )
    )

    snapshot = STORE.load_snapshot(username)
    cached_profile = snapshot.get("profile")
    cached_games = snapshot.get("games") or []
    cached_request_key = str(snapshot.get("request_key", ""))
    cached_games_request_key = str(snapshot.get("games_request_key", ""))
    cached_schema = int(snapshot.get("schema_version", 0) or 0)
    progress = STORE.load_progress(username)
    keyed_profile_cache = STORE.load_cached_profile(username, request_key)
    keyed_games_cache = STORE.load_cached_games(username, games_cache_key)
    keyed_profile_schema = int(keyed_profile_cache.get("schema_version", 0) or 0)
    keyed_games_schema = int(keyed_games_cache.get("schema_version", 0) or 0)
    keyed_profile_data = keyed_profile_cache.get("profile")
    keyed_profile_games = keyed_profile_cache.get("games") or []
    keyed_games = keyed_games_cache.get("games") or []
    keyed_archives_found = int(keyed_profile_cache.get("archives_found", 0) or keyed_games_cache.get("archives_found", 0) or 0)
    if (
        keyed_profile_schema >= PROFILE_SCHEMA_VERSION
        and isinstance(keyed_profile_data, dict)
        and keyed_profile_games
    ):
        return jsonify(
            profile_response_payload(
                username=username,
                normalized_time_classes=normalized_time_classes,
                archives_found=keyed_archives_found,
                games=list(keyed_profile_games),
                profile_data=keyed_profile_data,
                progress=progress,
                lichess_token=lichess_token,
                cached=True,
                reused_games=True,
            )
        )
    if (
        cached_schema >= PROFILE_SCHEMA_VERSION
        and cached_request_key == request_key
        and isinstance(cached_profile, dict)
        and cached_games
    ):
        return jsonify(
            profile_response_payload(
                username=username,
                normalized_time_classes=normalized_time_classes,
                archives_found=int(snapshot.get("archives_found", 0) or 0),
                games=list(cached_games),
                profile_data=cached_profile,
                progress=progress,
                lichess_token=lichess_token,
                cached=True,
                reused_games=True,
            )
        )

    archives_found = int(snapshot.get("archives_found", 0) or 0)
    reused_games = False
    if (
        keyed_games_schema >= PROFILE_SCHEMA_VERSION
        and keyed_games
    ):
        games = deserialize_games(list(keyed_games))
        archives_found = keyed_archives_found
        reused_games = bool(games)
    elif (
        cached_schema >= PROFILE_SCHEMA_VERSION
        and cached_games_request_key == games_cache_key
        and cached_games
    ):
        games = deserialize_games(list(cached_games))
        reused_games = bool(games)
    else:
        try:
            archives = fetch_archives(username)
            games = fetch_games(username, normalized_time_classes, max_games, archives=archives)
            archives_found = len(archives)
        except Exception as exc:
            return jsonify({"error": f"Could not import Chess.com games: {exc}"}), 502

    if not games:
        return jsonify({"error": "No matching public games were found for that username and time control."}), 404

    try:
        with EngineSession(settings) as engine:
            profile_data = analyse_games(games, engine)
    except FileNotFoundError:
        return jsonify({"error": "The Stockfish executable could not be opened."}), 400
    except Exception as exc:
        return jsonify({"error": f"Engine analysis failed: {exc}"}), 500

    serialized_games = serialize_games(games)
    STORE.save_cached_games(
        username,
        games_cache_key,
        {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "archives_found": archives_found,
            "games_imported": len(games),
            "games": serialized_games,
        },
    )
    STORE.save_cached_profile(
        username,
        request_key,
        {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "games_request_key": games_cache_key,
            "archives_found": archives_found,
            "games_imported": len(games),
            "games": serialized_games,
            "profile": profile_data,
        },
    )
    STORE.save_snapshot(
        username,
        {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "request_key": request_key,
            "games_request_key": games_cache_key,
            "archives_found": archives_found,
            "games_imported": len(games),
            "games": serialized_games,
            "profile": profile_data,
        },
    )

    return jsonify(
        profile_response_payload(
            username=username,
            normalized_time_classes=normalized_time_classes,
            archives_found=archives_found,
            games=serialized_games,
            profile_data=profile_data,
            progress=progress,
            lichess_token=lichess_token,
            cached=False,
            reused_games=reused_games,
        )
    )


@app.post("/api/position-insight")
def position_insight() -> tuple:
    payload = request.get_json(force=True)
    fen = str(payload.get("fen", "")).strip()
    if not fen:
        return jsonify({"error": "FEN is required."}), 400
    try:
        board = chess.Board(fen)
    except ValueError:
        return jsonify({"error": "Invalid FEN."}), 400

    config = load_config()
    settings = build_engine_settings(config)
    configure_lichess(str(config.get("lichess_token", "")))
    play_uci = [str(item) for item in payload.get("play_uci", []) if str(item)]
    your_move_uci = str(payload.get("your_move_uci", "")).strip()
    your_move_san = str(payload.get("your_move_san", "")).strip()
    your_move_count = int(payload.get("your_move_count", 0) or 0)
    try:
        with EngineSession(settings) as engine:
            insight = build_position_insight(
                board,
                engine,
                play_uci=play_uci,
                your_move_uci=your_move_uci,
                your_move_san=your_move_san,
                your_move_count=your_move_count,
                time_sec=settings.think_time_sec,
            )
    except FileNotFoundError:
        return jsonify({"error": "The Stockfish executable could not be opened."}), 400
    except Exception as exc:
        return jsonify({"error": f"Position insight failed: {exc}"}), 500

    return jsonify(insight)


@app.post("/api/legal-moves")
def legal_moves() -> tuple:
    payload = request.get_json(force=True)
    fen = str(payload.get("fen", "")).strip()
    if not fen:
        return jsonify({"error": "FEN is required."}), 400
    try:
        board = chess.Board(fen)
    except ValueError:
        return jsonify({"error": "Invalid FEN."}), 400
    return jsonify({"fen": board.fen(), "legal_moves": serialize_legal_moves(board)})


@app.post("/api/apply-move")
def apply_move() -> tuple:
    payload = request.get_json(force=True)
    fen = str(payload.get("fen", "")).strip()
    move_uci = str(payload.get("move_uci", "")).strip()
    if not fen or not move_uci:
        return jsonify({"error": "FEN and move are required."}), 400
    try:
        board = chess.Board(fen)
        move = chess.Move.from_uci(move_uci)
    except ValueError:
        return jsonify({"error": "Invalid move."}), 400
    if move not in board.legal_moves:
        return jsonify({"error": "That move is not legal in this position."}), 400
    san = board.san(move)
    board.push(move)
    return jsonify(
        {
            "fen": board.fen(),
            "played_san": san,
            "last_move": {"from": move_uci[:2], "to": move_uci[2:4]},
            "legal_moves": serialize_legal_moves(board),
        }
    )


@app.post("/api/trainer-attempt")
def trainer_attempt() -> tuple:
    payload = request.get_json(force=True)
    fen = str(payload.get("fen", "")).strip()
    move_uci = str(payload.get("move_uci", "")).strip()
    lesson = payload.get("lesson") or {}
    if not fen or not move_uci:
        return jsonify({"error": "FEN and move are required."}), 400
    try:
        board = chess.Board(fen)
        move = chess.Move.from_uci(move_uci)
    except ValueError:
        return jsonify({"error": "Invalid trainer move."}), 400
    if move not in board.legal_moves:
        return jsonify({"error": "That move is not legal in this position."}), 400

    attempted_san = board.san(move)
    best_uci = str(lesson.get("best_reply_uci", "")).strip()
    if not best_uci:
        return jsonify({"error": "Lesson is missing the best move."}), 400
    try:
        best_move = chess.Move.from_uci(best_uci)
    except ValueError:
        return jsonify({"error": "Lesson best move is invalid."}), 400
    if best_move not in board.legal_moves:
        return jsonify({"error": "Lesson best move is not legal in this position."}), 400
    best_san = board.san(best_move)

    if move.uci() != best_uci:
        return jsonify(
            {
                "ok": False,
                "played_san": attempted_san,
                "best_san": best_san,
                "explanation": str(lesson.get("explanation", "")),
                "continuation": str(lesson.get("continuation_san", "")),
                "fen": fen,
            }
        )

    line_sans = [attempted_san]
    board.push(move)
    last_move = {"from": move_uci[:2], "to": move_uci[2:4]}
    continuation_ucis = [str(item) for item in lesson.get("continuation_moves_uci", []) if str(item)]
    for continuation in continuation_ucis[1:]:
        try:
            follow = chess.Move.from_uci(continuation)
        except ValueError:
            break
        if follow not in board.legal_moves:
            break
        follow_san = board.san(follow)
        line_sans.append(follow_san)
        board.push(follow)
        last_move = {"from": continuation[:2], "to": continuation[2:4]}

    return jsonify(
        {
            "ok": True,
            "played_san": attempted_san,
            "best_san": best_san,
            "line": " ".join(line_sans),
            "fen": board.fen(),
            "last_move": last_move,
            "explanation": str(lesson.get("explanation", "")),
            "legal_moves": serialize_legal_moves(board),
        }
    )


@app.post("/api/review-progress")
def review_progress() -> tuple:
    payload = request.get_json(force=True)
    username = str(payload.get("username", "")).strip() or "trixize1234"
    lessons = payload.get("lessons", {})
    summary = payload.get("summary", {})
    if not isinstance(lessons, dict):
        return jsonify({"error": "Lesson progress payload must be an object."}), 400
    if not isinstance(summary, dict):
        summary = {}
    STORE.save_progress(username, {"lessons": lessons, "summary": summary})
    return jsonify({"ok": True})


def run_app() -> None:
    port = 8877
    url = f"http://127.0.0.1:{port}/"
    server = threading.Thread(
        target=lambda: app.run(host="127.0.0.1", port=port, debug=False, threaded=True, use_reloader=False),
        daemon=True,
    )
    server.start()

    for _ in range(80):
        try:
            with urlopen(url, timeout=0.25) as response:
                if response.status == 200:
                    break
        except URLError:
            pass
        except Exception:
            pass
        threading.Event().wait(0.1)

    webview.create_window(
        "Bookup",
        url,
        width=1500,
        height=980,
        min_size=(1120, 760),
        text_select=True,
    )
    webview.start()
