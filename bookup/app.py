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

from .analysis import analyse_games
from .chesscom import fetch_archives, fetch_games, normalize_time_classes
from .engine import EngineSession, EngineSettings, default_engine_path


APP_DIR = Path(__file__).resolve().parent
ROOT_DIR = APP_DIR.parent
RUNTIME_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else ROOT_DIR
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", ROOT_DIR))
CONFIG_PATH = RUNTIME_DIR / "config.json"

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
    engine_path = str(payload.get("engine_path", "")).strip()
    return EngineSettings(
        path=engine_path,
        depth=max(8, min(24, int(payload.get("depth", 13)))),
        threads=max(1, min(max(1, os.cpu_count() or 8), int(payload.get("threads", max(1, os.cpu_count() or 8))))),
        hash_mb=max(256, min(32768, int(payload.get("hash_mb", 2048)))),
    )


def serialize_legal_moves(board: chess.Board) -> list[dict]:
    items = []
    for move in board.legal_moves:
        items.append(
            {
                "uci": move.uci(),
                "from": chess.square_name(move.from_square),
                "to": chess.square_name(move.to_square),
                "san": board.san(move),
                "promotion": chess.piece_symbol(move.promotion) if move.promotion else "",
            }
        )
    return items


def normalize_move_uci(board: chess.Board, move_uci: str) -> chess.Move | None:
    cleaned = str(move_uci or "").strip().lower()
    if len(cleaned) < 4:
        return None
    if len(cleaned) == 4:
        base = chess.Move.from_uci(cleaned)
        if base in board.legal_moves:
            return base
        for suffix in ("q", "r", "b", "n"):
            promoted = chess.Move.from_uci(cleaned + suffix)
            if promoted in board.legal_moves:
                return promoted
        return None
    move = chess.Move.from_uci(cleaned)
    return move if move in board.legal_moves else None


def score_cp(score: chess.engine.PovScore, turn: chess.Color) -> int:
    pov = score.pov(turn)
    if pov.is_mate():
        mate = pov.mate()
        if mate is None:
            return 0
        return 100000 - abs(mate) if mate > 0 else -100000 + abs(mate)
    return int(pov.score(mate_score=100000) or 0)


def san_line(board: chess.Board, pv: list[chess.Move], plies: int = 4) -> list[str]:
    probe = board.copy(stack=False)
    out: list[str] = []
    for move in pv[:plies]:
        if move not in probe.legal_moves:
            break
        out.append(probe.san(move))
        probe.push(move)
    return out


def explain_best_move(board: chess.Board, best_move: chess.Move, best_line: list[str], eval_gain_cp: int) -> str:
    best_san = board.san(best_move)
    move_piece = board.piece_at(best_move.from_square)
    piece_name = chess.piece_name(move_piece.piece_type).title() if move_piece else "Move"
    reasons: list[str] = []
    if "+" in best_san or "#" in best_san:
        reasons.append("it creates an immediate forcing threat against the king")
    if "x" in best_san:
        reasons.append("it wins material or forces a material concession")
    if best_move.to_square in chess.SquareSet(chess.BB_CENTER):
        reasons.append("it improves central control and piece activity")
    if not reasons:
        reasons.append("it keeps the initiative and preserves the healthiest evaluation")
    line_text = " ".join(best_line) if best_line else best_san
    return (
        f"{best_san} is best because {piece_name.lower()} {reasons[0]}. "
        f"The engine continuation is {line_text}. "
        f"This keeps roughly {round(eval_gain_cp / 100, 2)} pawns more value than the move you chose."
    )


@app.get("/")
def index() -> str:
    config = load_config()
    defaults = {
        "username": config.get("username", "trixize1234"),
        "time_classes": config.get("time_classes", "all"),
        "max_games": int(config.get("max_games", 40)),
        "engine_path": config.get("engine_path", default_engine_path()),
        "depth": int(config.get("depth", 13)),
        "threads": int(config.get("threads", max(1, os.cpu_count() or 8))),
        "hash_mb": int(config.get("hash_mb", 2048)),
    }
    return render_template("index.html", defaults=defaults)


@app.post("/api/profile")
def profile() -> tuple:
    payload = request.get_json(force=True)
    username = str(payload.get("username", "")).strip()
    if not username:
        return jsonify({"error": "Chess.com username is required."}), 400

    raw_time_classes = str(payload.get("time_classes", "all")).strip()
    time_classes = [item.strip() for item in raw_time_classes.split(",") if item.strip()]
    normalized_time_classes = normalize_time_classes(time_classes)
    max_games = max(1, min(200, int(payload.get("max_games", 40))))
    engine_path = str(payload.get("engine_path", "")).strip()
    if not engine_path:
        return jsonify({"error": "Stockfish path is required."}), 400

    settings = build_engine_settings(payload)

    save_config(
        {
            "username": username,
            "time_classes": raw_time_classes or "all",
            "max_games": max_games,
            "engine_path": engine_path,
            "depth": settings.depth,
            "threads": settings.threads,
            "hash_mb": settings.hash_mb,
        }
    )

    try:
        archives = fetch_archives(username)
        games = fetch_games(username, normalized_time_classes, max_games)
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

    return jsonify(
        {
            "username": username,
            "time_classes": sorted(normalized_time_classes) if normalized_time_classes else ["all public games"],
            "archives_found": len(archives),
            "games_imported": len(games),
            "profile": profile_data,
        }
    )


@app.post("/api/legal-moves")
def legal_moves() -> tuple:
    payload = request.get_json(force=True)
    fen = str(payload.get("fen", "")).strip()
    if not fen:
        return jsonify({"error": "FEN is required."}), 400
    try:
        board = chess.Board(fen)
    except ValueError as exc:
        return jsonify({"error": f"Invalid FEN: {exc}"}), 400
    return jsonify(
        {
            "fen": board.fen(),
            "turn": "white" if board.turn == chess.WHITE else "black",
            "legal_moves": serialize_legal_moves(board),
        }
    )


@app.post("/api/coach-move")
def coach_move() -> tuple:
    payload = request.get_json(force=True)
    fen = str(payload.get("fen", "")).strip()
    move_uci = str(payload.get("move_uci", "")).strip()
    if not fen or not move_uci:
        return jsonify({"error": "FEN and move_uci are required."}), 400

    try:
        board = chess.Board(fen)
    except ValueError as exc:
        return jsonify({"error": f"Invalid FEN: {exc}"}), 400

    selected_move = normalize_move_uci(board, move_uci)
    if selected_move is None:
        return jsonify({"error": "That move is not legal from this position.", "legal_moves": serialize_legal_moves(board)}), 400

    settings = build_engine_settings(payload)
    if not settings.path:
        return jsonify({"error": "Stockfish path is required."}), 400

    try:
        with EngineSession(settings) as engine:
            root_info = engine.analyse(board, multipv=1)[0]
            pv = root_info.get("pv") or []
            if not pv:
                return jsonify({"error": "Engine did not return a principal variation."}), 500
            best_move = pv[0]
            best_move_san = board.san(best_move)
            root_eval = score_cp(root_info["score"], board.turn)
            if selected_move != best_move:
                wrong_probe = board.copy(stack=False)
                wrong_san = wrong_probe.san(selected_move)
                wrong_probe.push(selected_move)
                wrong_info = engine.analyse(wrong_probe, multipv=1)[0]
                wrong_eval = score_cp(wrong_info["score"], board.turn)
                best_line = san_line(board, pv, 5)
                explanation = explain_best_move(board, best_move, best_line, max(0, root_eval - wrong_eval))
                return jsonify(
                    {
                        "correct": False,
                        "fen": board.fen(),
                        "played_move_san": wrong_san,
                        "best_move_uci": best_move.uci(),
                        "best_move_san": best_move_san,
                        "best_line": best_line,
                        "explanation": explanation,
                        "message": f"Best move was {best_move_san}. {explanation}",
                        "legal_moves": serialize_legal_moves(board),
                    }
                )

            played_san = board.san(selected_move)
            board.push(selected_move)
            continuation = []
            final_reply_uci = selected_move.uci()
            reply_info = engine.analyse(board, multipv=1)[0]
            reply_pv = reply_info.get("pv") or []
            for follow_move in reply_pv[:4]:
                if follow_move not in board.legal_moves:
                    break
                continuation.append(board.san(follow_move))
                final_reply_uci = follow_move.uci()
                board.push(follow_move)

            return jsonify(
                {
                    "correct": True,
                    "played_move_san": played_san,
                    "best_move_uci": best_move.uci(),
                    "best_move_san": best_move_san,
                    "continuation": continuation,
                    "final_fen": board.fen(),
                    "last_move_uci": final_reply_uci,
                    "line_over": len(continuation) < 4,
                    "message": "Correct. Bookup played out the engine continuation from there.",
                    "legal_moves": serialize_legal_moves(board),
                }
            )
    except FileNotFoundError:
        return jsonify({"error": "The Stockfish executable could not be opened."}), 400
    except Exception as exc:
        return jsonify({"error": f"Coach analysis failed: {exc}"}), 500


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
