from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from flask import Flask, jsonify, render_template, request
import webview

from .analysis import analyse_games
from .chesscom import fetch_games
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


@app.get("/")
def index() -> str:
    config = load_config()
    defaults = {
        "username": config.get("username", "trixize1234"),
        "time_classes": config.get("time_classes", "rapid,blitz"),
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

    time_classes = [item.strip() for item in str(payload.get("time_classes", "rapid")).split(",") if item.strip()]
    max_games = max(1, min(200, int(payload.get("max_games", 40))))
    engine_path = str(payload.get("engine_path", "")).strip()
    if not engine_path:
        return jsonify({"error": "Stockfish path is required."}), 400

    settings = EngineSettings(
        path=engine_path,
        depth=max(8, min(24, int(payload.get("depth", 13)))),
        threads=max(1, min(max(1, os.cpu_count() or 8), int(payload.get("threads", max(1, os.cpu_count() or 8))))),
        hash_mb=max(256, min(32768, int(payload.get("hash_mb", 2048)))),
    )

    save_config(
        {
            "username": username,
            "time_classes": ",".join(time_classes),
            "max_games": max_games,
            "engine_path": engine_path,
            "depth": settings.depth,
            "threads": settings.threads,
            "hash_mb": settings.hash_mb,
        }
    )

    try:
        games = fetch_games(username, time_classes, max_games)
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
            "time_classes": time_classes,
            "profile": profile_data,
        }
    )


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
