from __future__ import annotations

import atexit
import ctypes
import hashlib
import io
import json
import os
import re
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.error import URLError
from urllib.request import Request, urlopen

import chess
import chess.pgn
from flask import Flask, jsonify, render_template, request
try:
    import webview
except Exception:
    webview = None

from .analysis import (
    analyse_games,
    build_position_insight,
    clear_runtime_caches,
    configure_engine_cache,
    configure_lichess,
    database_context_for_board,
    generate_smart_theory_tree,
    validate_smart_theory_tree,
)
from .chessnut_bridge import default_chessnut_db_path, extract_chessnut_games_as_pgn
from .chesscom import ImportedGame, fetch_archives, fetch_games, infer_time_class, normalize_time_classes
from .classifications import book_classification_payload
from .engine import EnginePool, EngineSettings, default_engine_path
from .opening_names import lookup_by_board
from .progress_tracker import (
    ProgressError,
    build_progress_payload,
    refresh_progress,
    save_progress_settings,
    save_session,
)
from .realign import START_FEN as REALIGN_START_FEN, build_realign_plan
from .storage import LocalStore, deserialize_games, serialize_games


APP_DIR = Path(__file__).resolve().parent
ROOT_DIR = APP_DIR.parent
RUNTIME_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else ROOT_DIR
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", ROOT_DIR))
CONFIG_PATH = RUNTIME_DIR / "config.json"
DATA_DIR = RUNTIME_DIR / "bookup_data"
STORE = LocalStore(DATA_DIR)
configure_engine_cache(STORE.load_engine_cache, STORE.save_engine_cache)
PROFILE_SCHEMA_VERSION = 26
GAMES_CACHE_SCHEMA_VERSION = 20
ENGINE_DEFAULTS_VERSION = 7
MAX_SAFE_PARALLEL_WORKERS = 8
WEB_MODE = False
ENGINE_LOCK = threading.Lock()
LIVE_ENGINE_SESSION: EnginePool | None = None
LIVE_ENGINE_KEY = ""
ANALYSIS_STATUS_LOCK = threading.Lock()
ANALYSIS_STATUS: dict[str, object] = {
    "active": False,
    "phase": "idle",
    "progress": 0,
    "message": "Ready.",
}
ANALYSIS_STATUS_SETTINGS: EngineSettings | None = None
ANALYSIS_STATUS_ENGINE: EnginePool | None = None
CPU_SAMPLES: dict[int, tuple[float, float]] = {}
SMART_THEORY_JOBS_LOCK = threading.Lock()
SMART_THEORY_JOBS: dict[str, dict[str, object]] = {}
SMART_THEORY_MAX_JOBS = 40

app = Flask(
    __name__,
    template_folder=str(RESOURCE_DIR / "bookup" / "templates"),
    static_folder=str(RESOURCE_DIR / "bookup" / "static"),
)


def _load_local_env_file() -> None:
    """Load simple KEY=VALUE pairs from .env.local into process env.

    Only fills missing environment variables and keeps parsing intentionally
    small so Bookup does not need a new dependency for local token testing.
    """
    env_path = ROOT_DIR / ".env.local"
    if not env_path.exists():
        return
    try:
        for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
            line = str(raw_line or "").strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip().strip('"').strip("'")
            os.environ[key] = value
    except Exception:
        # Keep startup resilient even if .env.local is malformed.
        return


_load_local_env_file()


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}


def save_config(payload: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def system_memory_snapshot() -> dict[str, int]:
    try:
        status = MEMORYSTATUSEX()
        status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return {
                "total_mb": max(1024, int(status.ullTotalPhys // (1024 * 1024))),
                "available_mb": max(0, int(status.ullAvailPhys // (1024 * 1024))),
                "load_percent": max(0, min(100, int(status.dwMemoryLoad))),
            }
    except Exception:
        pass
    return {"total_mb": 16384, "available_mb": 8192, "load_percent": 50}


def system_total_ram_mb() -> int:
    return int(system_memory_snapshot()["total_mb"])


def system_available_ram_mb() -> int:
    return int(system_memory_snapshot()["available_mb"])


def safe_stockfish_hash_limit_mb() -> int:
    """Upper bound for the total Stockfish hash budget across all workers.

    Hash is split between workers by EnginePool. Keep a generous but safe reserve
    for Windows, the browser/webview, and Python so a huge manual value does not
    push the machine into paging.
    """
    snapshot = system_memory_snapshot()
    total_mb = max(1024, int(snapshot["total_mb"]))
    available_mb = max(1024, int(snapshot["available_mb"]))
    reserved_mb = max(8192, int(total_mb * 0.10))
    available_limited = max(512, available_mb - reserved_mb)
    total_limited = max(512, int(total_mb * 0.80))
    return max(512, (min(available_limited, total_limited) // 128) * 128)


CPU_THREADS = max(1, os.cpu_count() or 8)
TOTAL_RAM_MB = system_total_ram_mb()


class FILETIME(ctypes.Structure):
    _fields_ = [
        ("dwLowDateTime", ctypes.c_ulong),
        ("dwHighDateTime", ctypes.c_ulong),
    ]


class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def _filetime_seconds(value: FILETIME) -> float:
    ticks = (int(value.dwHighDateTime) << 32) + int(value.dwLowDateTime)
    return ticks / 10_000_000.0


def _process_handle(pid: int):
    if sys.platform != "win32":
        return None
    access = 0x1000 | 0x0010  # PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ
    try:
        return ctypes.windll.kernel32.OpenProcess(access, False, int(pid))
    except Exception:
        return None


def _process_memory_mb(pid: int) -> float | None:
    handle = _process_handle(pid)
    if not handle:
        return None
    try:
        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            return round(float(counters.WorkingSetSize) / (1024 * 1024), 1)
    except Exception:
        return None
    finally:
        try:
            ctypes.windll.kernel32.CloseHandle(handle)
        except Exception:
            pass
    return None


def _process_cpu_seconds(pid: int) -> float | None:
    handle = _process_handle(pid)
    if not handle:
        return None
    try:
        creation = FILETIME()
        exit_time = FILETIME()
        kernel = FILETIME()
        user = FILETIME()
        if ctypes.windll.kernel32.GetProcessTimes(
            handle,
            ctypes.byref(creation),
            ctypes.byref(exit_time),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            return _filetime_seconds(kernel) + _filetime_seconds(user)
    except Exception:
        return None
    finally:
        try:
            ctypes.windll.kernel32.CloseHandle(handle)
        except Exception:
            pass
    return None


def engine_resource_snapshot(settings: EngineSettings, engine: EnginePool | None) -> dict[str, object]:
    pids = engine.worker_pids() if engine is not None and hasattr(engine, "worker_pids") else []
    memory_values = [value for pid in pids if (value := _process_memory_mb(pid)) is not None]
    runtime = engine.runtime_stats() if engine is not None and hasattr(engine, "runtime_stats") else {}
    memory_snapshot = system_memory_snapshot()
    now = time.monotonic()
    cpu_delta = 0.0
    wall_delta = 0.0
    sampled = 0
    for pid in pids:
        cpu_seconds = _process_cpu_seconds(pid)
        if cpu_seconds is None:
            continue
        previous = CPU_SAMPLES.get(pid)
        CPU_SAMPLES[pid] = (now, cpu_seconds)
        if previous:
            previous_wall, previous_cpu = previous
            elapsed = max(0.001, now - previous_wall)
            cpu_delta += max(0.0, cpu_seconds - previous_cpu)
            wall_delta = max(wall_delta, elapsed)
            sampled += 1
    stale_pids = set(CPU_SAMPLES) - set(pids)
    for pid in stale_pids:
        CPU_SAMPLES.pop(pid, None)

    cpu_percent = None
    cpu_cores = None
    cpu_budget_usage_percent = None
    if sampled and wall_delta > 0:
        cpu_cores = round(max(0.0, cpu_delta / wall_delta), 2)
        cpu_percent = round(min(100.0, (cpu_cores / max(1, CPU_THREADS)) * 100), 1)
        cpu_budget_usage_percent = round(
            min(100.0, (cpu_cores / max(1, int(settings.threads))) * 100),
            1,
        )

    workers = max(1, int(getattr(engine, "worker_count", settings.parallel_workers) if engine else settings.parallel_workers))
    memory_mb = round(sum(memory_values), 1) if memory_values else 0.0
    return {
        "workers": workers,
        "active_workers": int(runtime.get("active_workers", 0) or 0),
        "jobs_started": int(runtime.get("jobs_started", 0) or 0),
        "jobs_completed": int(runtime.get("jobs_completed", 0) or 0),
        "worker_pids": pids,
        "threads": int(settings.threads),
        "worker_threads": max(1, int(settings.threads) // workers),
        "hash_mb": int(settings.hash_mb),
        "worker_hash_mb": max(128, int(settings.hash_mb) // workers),
        "hash_limit_mb": safe_stockfish_hash_limit_mb(),
        "multipv": int(settings.multipv),
        "depth": int(settings.depth),
        "think_time_sec": float(settings.think_time_sec),
        "cpu_percent": cpu_percent,
        "cpu_cores": cpu_cores,
        "cpu_budget_usage_percent": cpu_budget_usage_percent,
        "cpu_budget_percent": round(min(100.0, (int(settings.threads) / max(1, CPU_THREADS)) * 100), 1),
        "memory_mb": memory_mb,
        "estimated_hash_mb": int(settings.hash_mb),
        "system_threads": CPU_THREADS,
        "system_ram_mb": int(memory_snapshot["total_mb"]),
        "system_available_ram_mb": int(memory_snapshot["available_mb"]),
        "system_memory_load_percent": int(memory_snapshot["load_percent"]),
    }


def reset_analysis_status(kind: str, username: str, settings: EngineSettings, engine: EnginePool | None) -> None:
    global ANALYSIS_STATUS, ANALYSIS_STATUS_SETTINGS, ANALYSIS_STATUS_ENGINE
    now = time.monotonic()
    with ANALYSIS_STATUS_LOCK:
        ANALYSIS_STATUS_SETTINGS = settings
        ANALYSIS_STATUS_ENGINE = engine
        ANALYSIS_STATUS = {
            "active": True,
            "kind": kind,
            "username": username,
            "phase": "starting",
            "progress": 2,
            "message": "Starting Stockfish analysis...",
            "started_at": now,
            "elapsed_sec": 0.0,
            "eta_sec": None,
            "positions_done": 0,
            "positions_total": 0,
            "positions_per_second": 0.0,
            "live_positions": [],
            "scan_active_workers": 0,
            "scan_active_slots": [],
            "resources": engine_resource_snapshot(settings, engine),
        }


def update_analysis_status(
    *,
    settings: EngineSettings | None = None,
    engine: EnginePool | None = None,
    **patch: object,
) -> None:
    global ANALYSIS_STATUS_SETTINGS, ANALYSIS_STATUS_ENGINE
    with ANALYSIS_STATUS_LOCK:
        if not ANALYSIS_STATUS:
            return
        if settings is not None:
            ANALYSIS_STATUS_SETTINGS = settings
        if engine is not None:
            ANALYSIS_STATUS_ENGINE = engine
        clean_patch = {key: value for key, value in patch.items() if value is not None}
        old_phase = str(ANALYSIS_STATUS.get("phase", "") or "")
        if "progress" in clean_patch:
            try:
                next_progress = int(clean_patch["progress"] or 0)
                current_progress = int(ANALYSIS_STATUS.get("progress", 0) or 0)
                next_phase = str(clean_patch.get("phase", ANALYSIS_STATUS.get("phase", "")))
                if (
                    ANALYSIS_STATUS.get("active")
                    and next_phase not in {"complete", "failed"}
                    and next_progress < current_progress
                ):
                    clean_patch["progress"] = current_progress
            except (TypeError, ValueError):
                clean_patch.pop("progress", None)
        next_phase = str(clean_patch.get("phase", ANALYSIS_STATUS.get("phase", "")) or "")
        live_preview_phases = {"stockfish_positions", "brilliant_scan"}
        phase_changed = bool(next_phase) and next_phase != old_phase
        if phase_changed and next_phase not in live_preview_phases:
            clean_patch.setdefault("live_positions", [])
            clean_patch.setdefault("scan_active_workers", 0)
            clean_patch.setdefault("scan_active_slots", [])
            clean_patch.setdefault("active_workers", 0)
        ANALYSIS_STATUS.update(clean_patch)
        now = time.monotonic()
        phase = str(ANALYSIS_STATUS.get("phase", "") or "")
        if phase != old_phase:
            ANALYSIS_STATUS["phase_started_at"] = now
        started = float(ANALYSIS_STATUS.get("started_at", now) or now)
        elapsed = max(0.001, now - started)
        phase_started = float(ANALYSIS_STATUS.get("phase_started_at", started) or started)
        phase_elapsed = max(0.001, now - phase_started)
        position_done = int(ANALYSIS_STATUS.get("positions_done", 0) or 0)
        position_total = int(ANALYSIS_STATUS.get("positions_total", 0) or 0)
        done = position_done
        total = position_total
        if done <= 0 or total <= 0:
            if phase in {"loading_games", "fetch_archives", "fetch_games", "indexing"}:
                done = int(ANALYSIS_STATUS.get("games_done", 0) or 0)
                total = int(ANALYSIS_STATUS.get("games_total", 0) or 0)
            elif phase == "brilliant_scan":
                # Game completion is the unit of work here. A single game can
                # finish its current move batch while the full scan still has
                # hundreds of games left, so move counts make the ETA lie.
                done = int(ANALYSIS_STATUS.get("brilliant_games_done", 0) or 0)
                total = int(ANALYSIS_STATUS.get("brilliant_games_total", 0) or 0)
                if done <= 0 or total <= 0:
                    done = int(ANALYSIS_STATUS.get("classified_moves", 0) or 0)
                    total = int(ANALYSIS_STATUS.get("moves_scanned", 0) or 0)
        if done > 0:
            rate = done / phase_elapsed
            if position_done > 0:
                ANALYSIS_STATUS["positions_per_second"] = round(position_done / phase_elapsed, 2)
            ANALYSIS_STATUS["items_per_second"] = round(rate, 2)
            ANALYSIS_STATUS["eta_sec"] = round(max(0.0, (total - done) / rate), 1) if total > done and rate > 0 else 0
        elif ANALYSIS_STATUS.get("active"):
            ANALYSIS_STATUS["positions_per_second"] = 0.0
            ANALYSIS_STATUS["items_per_second"] = 0.0
            ANALYSIS_STATUS["eta_sec"] = None
        ANALYSIS_STATUS["elapsed_sec"] = round(elapsed, 1)
        ANALYSIS_STATUS["phase_elapsed_sec"] = round(phase_elapsed, 1)
        current_settings = settings or ANALYSIS_STATUS_SETTINGS
        current_engine = engine or ANALYSIS_STATUS_ENGINE
        if current_settings is not None:
            ANALYSIS_STATUS["resources"] = engine_resource_snapshot(current_settings, current_engine)


def finish_analysis_status(*, ok: bool, message: str = "") -> None:
    with ANALYSIS_STATUS_LOCK:
        ANALYSIS_STATUS["active"] = False
        ANALYSIS_STATUS["phase"] = "complete" if ok else "failed"
        ANALYSIS_STATUS["progress"] = 100 if ok else 0
        ANALYSIS_STATUS["eta_sec"] = 0
        ANALYSIS_STATUS["live_positions"] = []
        ANALYSIS_STATUS["scan_active_workers"] = 0
        ANALYSIS_STATUS["scan_active_slots"] = []
        if message:
            ANALYSIS_STATUS["message"] = message
        ANALYSIS_STATUS["completed_at"] = time.monotonic()


def reset_analysis_status_to_idle(message: str = "Ready.") -> None:
    global ANALYSIS_STATUS, ANALYSIS_STATUS_SETTINGS, ANALYSIS_STATUS_ENGINE
    with ANALYSIS_STATUS_LOCK:
        ANALYSIS_STATUS_SETTINGS = None
        ANALYSIS_STATUS_ENGINE = None
        ANALYSIS_STATUS = {
            "active": False,
            "phase": "idle",
            "progress": 0,
            "message": message,
            "eta_sec": 0,
            "elapsed_sec": 0,
            "positions_done": 0,
            "positions_total": 0,
            "positions_per_second": 0.0,
            "live_positions": [],
            "scan_active_workers": 0,
            "scan_active_slots": [],
            "resources": {},
        }


def analysis_status_payload() -> dict[str, object]:
    with ANALYSIS_STATUS_LOCK:
        settings = ANALYSIS_STATUS_SETTINGS
        engine = ANALYSIS_STATUS_ENGINE
        payload = dict(ANALYSIS_STATUS)
    if settings is not None:
        payload["resources"] = engine_resource_snapshot(settings, engine)
    payload = _augment_analysis_status(payload)
    return payload


def _trim_smart_theory_jobs_locked() -> None:
    if len(SMART_THEORY_JOBS) <= SMART_THEORY_MAX_JOBS:
        return
    ordered = sorted(
        SMART_THEORY_JOBS.items(),
        key=lambda item: float(item[1].get("updated_at", item[1].get("created_at", 0.0)) or 0.0),
    )
    for key, _job in ordered[: max(0, len(ordered) - SMART_THEORY_MAX_JOBS)]:
        SMART_THEORY_JOBS.pop(key, None)


def _extract_study_id(raw_value: str) -> str:
    value = str(raw_value or "").strip()
    if not value:
        return ""
    marker = "/study/"
    if marker in value:
        tail = value.split(marker, 1)[1]
        candidate = tail.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
        return candidate.strip()
    return value


def _smart_tree_children(nodes: list[dict[str, Any]]) -> tuple[str, dict[str, list[dict[str, Any]]], dict[str, dict[str, Any]]]:
    by_id: dict[str, dict[str, Any]] = {}
    children: dict[str, list[dict[str, Any]]] = {}
    root_id = "root"
    for item in nodes:
        if not isinstance(item, dict):
            continue
        node_id = str(item.get("id", "")).strip()
        if not node_id:
            continue
        by_id[node_id] = item
        if node_id == "root":
            root_id = node_id
    for item in by_id.values():
        parent_id = str(item.get("parentId", "") or "")
        node_id = str(item.get("id", "") or "")
        if node_id == root_id:
            continue
        children.setdefault(parent_id, []).append(item)
    for key in list(children.keys()):
        children[key].sort(
            key=lambda node: (
                int(node.get("ply", 0) or 0),
                -float(node.get("popularity", 0) or 0),
                -int(node.get("gameCount", 0) or 0),
                str(node.get("san", "") or str(node.get("uci", ""))),
            )
        )
    return root_id, children, by_id


def _same_export_position(left: chess.Board, right: chess.Board) -> bool:
    """Compare only the fields that determine legal continuation from a PGN node."""
    return (
        left.board_fen() == right.board_fen()
        and left.turn == right.turn
        and left.castling_rights == right.castling_rights
        and left.ep_square == right.ep_square
    )


def _smart_tree_export_context(
    tree_payload: dict[str, Any],
    root_node: dict[str, Any],
    warnings: list[str],
) -> tuple[chess.Board, list[chess.Move]]:
    """Return the PGN start board plus setup moves that reach the generated root.

    Smart Theory generation may start from an already-applied repertoire setup.
    For Lichess studies, exporting that setup as a FEN hides how the position was
    reached. Prefer the original start FEN plus the applied setup moves whenever
    they legally replay into the generated root position.
    """
    effective_fen = (
        str(tree_payload.get("effective_start_fen", "") or "").strip()
        or str(root_node.get("fen", "") or "").strip()
        or chess.STARTING_FEN
    )
    original_fen = (
        str(tree_payload.get("start_fen", "") or "").strip()
        or effective_fen
        or chess.STARTING_FEN
    )
    raw_setup = [
        str(item or "").strip()
        for item in (tree_payload.get("applied_start_line_uci") or [])
        if str(item or "").strip()
    ]

    try:
        fallback_board = chess.Board(effective_fen)
    except ValueError:
        fallback_board = chess.Board(chess.STARTING_FEN)
        warnings.append("Smart Theory effective root FEN was invalid; used the standard start position.")

    try:
        start_board = chess.Board(original_fen)
    except ValueError as exc:
        warnings.append(f"Smart Theory original start FEN was invalid; exported from generated root instead: {exc}")
        return fallback_board, []

    if not raw_setup:
        return start_board, []

    replay = start_board.copy(stack=False)
    setup_moves: list[chess.Move] = []
    for move_uci in raw_setup:
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            warnings.append(f"Skipped setup path because {move_uci} is not valid UCI; exported from generated root instead.")
            return fallback_board, []
        if move not in replay.legal_moves:
            warnings.append(f"Skipped setup path because {move_uci} is illegal from the exported start position.")
            return fallback_board, []
        setup_moves.append(move)
        replay.push(move)

    if not _same_export_position(replay, fallback_board):
        warnings.append("Skipped setup path because it did not reach the generated Smart Theory root position.")
        return fallback_board, []
    return start_board, setup_moves


def _append_smart_setup_moves(
    *,
    game: chess.pgn.Game,
    board: chess.Board,
    setup_moves: list[chess.Move],
) -> tuple[chess.pgn.GameNode, chess.Board, int, list[str]]:
    parent_pgn_node: chess.pgn.GameNode = game
    parent_board = board
    setup_san: list[str] = []
    for move in setup_moves:
        san = parent_board.san(move)
        next_board = parent_board.copy(stack=False)
        next_board.push(move)
        setup_san.append(san)
        parent_pgn_node = parent_pgn_node.add_variation(move)
        parent_board = next_board
    if setup_san:
        parent_pgn_node.comment = "Setup from your repertoire; generated line starts here."
    return parent_pgn_node, parent_board, len(setup_moves), setup_san


def _smart_comment_fragment(raw: object, *, limit: int = 72) -> str:
    text = re.sub(r"\s+", " ", str(raw or "").strip())
    if not text:
        return ""
    text = re.sub(r"^(theory|plan|why|threat|best response)\s*:\s*", "", text, flags=re.IGNORECASE).strip()
    if len(text) <= limit:
        return text
    cut = text[: max(0, limit - 1)].rsplit(" ", 1)[0].strip()
    return f"{cut or text[: max(0, limit - 1)].strip()}…"


def _smart_node_comment(node: dict[str, Any]) -> str:
    """Compact PGN comments for Lichess studies.

    The in-app tree keeps the full coaching text. Lichess should stay scannable,
    so each move gets only classification, eval, correction/response, and one
    short idea instead of the complete explanation block.
    """
    parts: list[str] = []
    classification = str(node.get("classification", "") or "").strip()
    is_opponent = bool(node.get("isOpponentSide"))
    is_user = bool(node.get("isUserSide"))
    san = str(node.get("san", "") or node.get("uci", "") or "").strip()
    best = str(node.get("bestMoveSan", "") or node.get("bestMoveUci", "") or "").strip()
    pv = [str(item or "").strip() for item in (node.get("principalVariation") or []) if str(item or "").strip()]
    if is_opponent:
        if bool(node.get("isBestEngineReply")):
            parts.append("Opponent: best engine move")
        elif classification:
            parts.append(f"Opponent: {classification}")
    elif is_user and classification:
        parts.append(f"You: {classification}")
    elif classification:
        parts.append(f"Class: {classification}")

    eval_after = node.get("evalAfter")
    if isinstance(eval_after, (int, float)):
        parts.append(f"Eval {float(eval_after) / 100:.2f}")

    original = str(node.get("originalUserMove", "") or "").strip()
    corrected = str(node.get("correctedMove", "") or "").strip()
    if original and corrected:
        parts.append(f"Correction: your line had {original}; play {corrected}")
    if best:
        if best == san:
            parts.append(f"Best move: {best}")
        else:
            parts.append(f"Best move here: {best}")

    recommended_response = str(node.get("recommendedResponseSan", "") or node.get("recommendedResponseUci", "") or "").strip()
    if recommended_response:
        parts.append(f"Your reply: {recommended_response}")
    if pv:
        parts.append(f"PV: {' '.join(pv[:10])}")

    threat = _smart_comment_fragment(node.get("threatSummary"), limit=68)
    if threat:
        parts.append(f"Threat: {threat}")
    else:
        idea = _smart_comment_fragment(node.get("opponentIdea") or node.get("whyMoveGoodOrBad") or node.get("planForUser"), limit=68)
        if idea:
            parts.append(f"Idea: {idea}")

    return _smart_comment_fragment(" | ".join(part for part in parts if part), limit=360)


SMART_THEORY_EXPORT_TARGET_PLIES = 40


def _append_smart_pv_tail(
    *,
    parent_pgn_node: chess.pgn.GameNode,
    parent_board: chess.Board,
    node_payload: dict[str, Any],
    depth: int,
    warnings: list[str],
    target_depth: int = SMART_THEORY_EXPORT_TARGET_PLIES,
) -> int:
    """Extend a short leaf with its engine PV so chapters still reach move 20."""
    if depth >= target_depth:
        return 0
    raw_tail = node_payload.get("continuationAfterMoveUci") or []
    if not isinstance(raw_tail, list) or not raw_tail:
        return 0
    cursor_node = parent_pgn_node
    cursor_board = parent_board.copy(stack=False)
    added = 0
    for raw_uci in raw_tail:
        if depth + added >= target_depth:
            break
        uci = str(raw_uci or "").strip()
        if not uci:
            continue
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            warnings.append(f"Skipped PV tail move; invalid UCI: {uci}.")
            break
        if move not in cursor_board.legal_moves:
            warnings.append(f"Stopped PV tail; move {uci} is illegal in this branch.")
            break
        cursor_node = cursor_node.add_variation(move)
        cursor_board.push(move)
        added += 1
    return added


def _smart_tree_to_pgn(tree_payload: dict[str, Any], *, chapter_name: str = "Bookup Smart Theory") -> tuple[str, dict[str, Any]]:
    nodes = tree_payload.get("nodes", [])
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("Smart theory tree has no nodes to export.")
    root_id, children, by_id = _smart_tree_children(nodes)
    root_node = by_id.get(root_id)
    if not isinstance(root_node, dict):
        raise ValueError("Smart theory root node is missing.")

    warnings: list[str] = []
    board, setup_moves = _smart_tree_export_context(tree_payload, root_node, warnings)

    game = chess.pgn.Game()
    game.headers["Event"] = chapter_name
    game.headers["Site"] = "Bookup Smart Theory"
    game.headers["Date"] = time.strftime("%Y.%m.%d")
    game.headers["Round"] = "-"
    game.headers["White"] = "Bookup"
    game.headers["Black"] = "Lichess Study"
    game.headers["Result"] = "*"
    opening_name = str(tree_payload.get("openingName", "") or root_node.get("openingName", "") or "").strip()
    eco_code = str(tree_payload.get("ecoCode", "") or root_node.get("ecoCode", "") or "").strip()
    if opening_name:
        game.headers["Opening"] = opening_name
    if eco_code:
        game.headers["ECO"] = eco_code
    if board.fen() != chess.STARTING_FEN:
        game.headers["SetUp"] = "1"
        game.headers["FEN"] = board.fen()

    setup_node, setup_board, setup_count, setup_san = _append_smart_setup_moves(
        game=game,
        board=board,
        setup_moves=setup_moves,
    )
    move_count = setup_count
    edge_seen: set[tuple[str, str]] = set()

    def _walk(parent_id: str, parent_pgn_node: chess.pgn.GameNode, parent_board: chess.Board, depth: int) -> None:
        nonlocal move_count
        if depth > 60:
            return
        branch_children = children.get(parent_id, [])
        legal_children_added = 0
        for child in branch_children:
            child_id = str(child.get("id", "") or "")
            if not child_id:
                continue
            edge = (parent_id, child_id)
            if edge in edge_seen:
                continue
            edge_seen.add(edge)
            uci = str(child.get("uci", "") or "").strip()
            if not uci:
                warnings.append(f"Skipped node {child_id} with empty UCI.")
                continue
            try:
                move = chess.Move.from_uci(uci)
            except ValueError:
                warnings.append(f"Skipped node {child_id}; invalid UCI: {uci}.")
                continue
            if move not in parent_board.legal_moves:
                warnings.append(f"Skipped node {child_id}; move {uci} is illegal in this branch.")
                continue
            child_board = parent_board.copy(stack=False)
            child_board.push(move)
            move_count += 1
            legal_children_added += 1
            child_pgn_node = parent_pgn_node.add_variation(move)
            comment = _smart_node_comment(child)
            if comment:
                child_pgn_node.comment = comment
            _walk(child_id, child_pgn_node, child_board, depth + 1)
        if legal_children_added == 0 and parent_id != root_id:
            current_node = by_id.get(parent_id, {})
            if isinstance(current_node, dict):
                move_count += _append_smart_pv_tail(
                    parent_pgn_node=parent_pgn_node,
                    parent_board=parent_board,
                    node_payload=current_node,
                    depth=depth,
                    warnings=warnings,
                )

    _walk(root_id, setup_node, setup_board, setup_count)
    if move_count <= 0:
        raise ValueError("Smart theory tree did not contain any legal moves to export.")

    exporter = chess.pgn.StringExporter(headers=True, variations=True, comments=True)
    pgn_text = game.accept(exporter).strip()
    metadata = {
        "root_id": root_id,
        "moves_exported": move_count,
        "setup_moves_exported": setup_count,
        "setup_san": setup_san,
        "warnings": warnings[:50],
        "start_fen": board.fen(),
    }
    return pgn_text, metadata


def _smart_subtree_to_pgn(
    tree_payload: dict[str, Any],
    *,
    anchor_node_id: str,
    chapter_name: str,
    include_root_siblings: bool = False,
) -> tuple[str, dict[str, Any]]:
    nodes = tree_payload.get("nodes", [])
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("Smart theory tree has no nodes to export.")
    root_id, children, by_id = _smart_tree_children(nodes)
    root_node = by_id.get(root_id)
    anchor = by_id.get(str(anchor_node_id or "").strip())
    if not isinstance(root_node, dict) or not isinstance(anchor, dict):
        raise ValueError("Could not find a valid anchor node in the Smart Theory tree.")

    warnings: list[str] = []
    board, setup_moves = _smart_tree_export_context(tree_payload, root_node, warnings)

    game = chess.pgn.Game()
    game.headers["Event"] = chapter_name
    game.headers["Site"] = "Bookup Smart Theory"
    game.headers["Date"] = time.strftime("%Y.%m.%d")
    game.headers["Round"] = "-"
    game.headers["White"] = "Bookup"
    game.headers["Black"] = "Lichess Study"
    game.headers["Result"] = "*"
    if board.fen() != chess.STARTING_FEN:
        game.headers["SetUp"] = "1"
        game.headers["FEN"] = board.fen()

    setup_node, setup_board, setup_count, setup_san = _append_smart_setup_moves(
        game=game,
        board=board,
        setup_moves=setup_moves,
    )
    move_count = setup_count
    edge_seen: set[tuple[str, str]] = set()

    def _walk(parent_id: str, parent_pgn_node: chess.pgn.GameNode, parent_board: chess.Board, depth: int) -> None:
        nonlocal move_count
        if depth > 60:
            return
        branch_children = children.get(parent_id, [])
        legal_children_added = 0
        for child in branch_children:
            child_id = str(child.get("id", "") or "")
            if not child_id:
                continue
            edge = (parent_id, child_id)
            if edge in edge_seen:
                continue
            edge_seen.add(edge)
            uci = str(child.get("uci", "") or "").strip()
            if not uci:
                warnings.append(f"Skipped node {child_id} with empty UCI.")
                continue
            try:
                move = chess.Move.from_uci(uci)
            except ValueError:
                warnings.append(f"Skipped node {child_id}; invalid UCI: {uci}.")
                continue
            if move not in parent_board.legal_moves:
                warnings.append(f"Skipped node {child_id}; move {uci} is illegal in this branch.")
                continue
            child_board = parent_board.copy(stack=False)
            child_board.push(move)
            move_count += 1
            legal_children_added += 1
            child_pgn_node = parent_pgn_node.add_variation(move)
            comment = _smart_node_comment(child)
            if comment:
                child_pgn_node.comment = comment
            _walk(child_id, child_pgn_node, child_board, depth + 1)
        if legal_children_added == 0 and parent_id != root_id:
            current_node = by_id.get(parent_id, {})
            if isinstance(current_node, dict):
                move_count += _append_smart_pv_tail(
                    parent_pgn_node=parent_pgn_node,
                    parent_board=parent_board,
                    node_payload=current_node,
                    depth=depth,
                    warnings=warnings,
                )

    anchor_parent = str(anchor.get("parentId", "") or "")
    if include_root_siblings and anchor_parent == root_id:
        _walk(root_id, setup_node, setup_board, setup_count)
    else:
        # Build the path from root to anchor so chapter starts with familiar line.
        chain: list[dict[str, Any]] = []
        cursor = anchor
        safety = 0
        while isinstance(cursor, dict) and str(cursor.get("id", "")) != root_id and safety < 256:
            chain.append(cursor)
            cursor = by_id.get(str(cursor.get("parentId", "") or ""))
            safety += 1
        chain.reverse()
        parent_pgn_node = setup_node
        parent_board = setup_board
        for step in chain:
            step_id = str(step.get("id", "") or "")
            uci = str(step.get("uci", "") or "").strip()
            if not uci:
                continue
            try:
                move = chess.Move.from_uci(uci)
            except ValueError:
                warnings.append(f"Skipped path move for node {step_id}; invalid UCI: {uci}.")
                break
            if move not in parent_board.legal_moves:
                warnings.append(f"Skipped path move for node {step_id}; illegal UCI: {uci}.")
                break
            next_board = parent_board.copy(stack=False)
            next_board.push(move)
            move_count += 1
            node = parent_pgn_node.add_variation(move)
            comment = _smart_node_comment(step)
            if comment:
                node.comment = comment
            parent_pgn_node = node
            parent_board = next_board
        _walk(str(anchor.get("id", "") or ""), parent_pgn_node, parent_board, setup_count + len(chain))

    if move_count <= 0:
        raise ValueError("Smart theory subtree did not contain any legal moves to export.")

    exporter = chess.pgn.StringExporter(headers=True, variations=True, comments=True)
    pgn_text = game.accept(exporter).strip()
    return pgn_text, {
        "moves_exported": move_count,
        "setup_moves_exported": setup_count,
        "setup_san": setup_san,
        "warnings": warnings[:50],
    }


def _smart_focused_line_to_pgn(
    tree_payload: dict[str, Any],
    *,
    anchor_node_id: str,
    chapter_name: str,
    target_plies: int = SMART_THEORY_EXPORT_TARGET_PLIES,
    tail_engine: Any | None = None,
    tail_depth: int = 12,
    tail_time_sec: float = 0.05,
) -> tuple[str, dict[str, Any]]:
    """Export one clean chapter line instead of a giant recursive variation tree."""
    nodes = tree_payload.get("nodes", [])
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("Smart theory tree has no nodes to export.")
    root_id, children, by_id = _smart_tree_children(nodes)
    root_node = by_id.get(root_id)
    anchor = by_id.get(str(anchor_node_id or "").strip())
    if not isinstance(root_node, dict) or not isinstance(anchor, dict):
        raise ValueError("Could not find a valid anchor node in the Smart Theory tree.")

    warnings: list[str] = []
    board, setup_moves = _smart_tree_export_context(tree_payload, root_node, warnings)
    game = chess.pgn.Game()
    game.headers["Event"] = chapter_name
    game.headers["Site"] = "Bookup Smart Theory"
    game.headers["Date"] = time.strftime("%Y.%m.%d")
    game.headers["Round"] = "-"
    game.headers["White"] = "Bookup"
    game.headers["Black"] = "Lichess Study"
    game.headers["Result"] = "*"
    opening_name = str(tree_payload.get("openingName", "") or root_node.get("openingName", "") or "").strip()
    eco_code = str(tree_payload.get("ecoCode", "") or root_node.get("ecoCode", "") or "").strip()
    if opening_name:
        game.headers["Opening"] = opening_name
    if eco_code:
        game.headers["ECO"] = eco_code
    if board.fen() != chess.STARTING_FEN:
        game.headers["SetUp"] = "1"
        game.headers["FEN"] = board.fen()

    parent_pgn_node, parent_board, setup_count, setup_san = _append_smart_setup_moves(
        game=game,
        board=board,
        setup_moves=setup_moves,
    )
    move_count = setup_count
    parent_by_id: dict[str, str] = {
        str(node.get("id", "") or ""): str(node.get("parentId", "") or "")
        for node in nodes
        if isinstance(node, dict)
    }

    chain: list[dict[str, Any]] = []
    cursor = anchor
    safety = 0
    while isinstance(cursor, dict) and str(cursor.get("id", "") or "") != root_id and safety < 256:
        chain.append(cursor)
        cursor = by_id.get(parent_by_id.get(str(cursor.get("id", "") or ""), ""))
        safety += 1
    chain.reverse()

    def _append_node_move(step: dict[str, Any]) -> bool:
        nonlocal parent_pgn_node, parent_board, move_count
        step_id = str(step.get("id", "") or "")
        uci = str(step.get("uci", "") or "").strip()
        if not uci:
            return False
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            warnings.append(f"Skipped focused path move for node {step_id}; invalid UCI: {uci}.")
            return False
        if move not in parent_board.legal_moves:
            warnings.append(f"Skipped focused path move for node {step_id}; illegal UCI: {uci}.")
            return False
        next_board = parent_board.copy(stack=False)
        next_board.push(move)
        parent_pgn_node = parent_pgn_node.add_variation(move)
        comment = _smart_node_comment(step)
        if comment:
            parent_pgn_node.comment = comment
        parent_board = next_board
        move_count += 1
        return True

    def _append_uci_tail(raw_tail: object) -> int:
        nonlocal parent_pgn_node, parent_board, move_count
        if move_count >= target_plies or not isinstance(raw_tail, list):
            return 0
        added = 0
        for raw_uci in raw_tail:
            if move_count >= target_plies:
                break
            uci = str(raw_uci or "").strip()
            if not uci:
                continue
            try:
                move = chess.Move.from_uci(uci)
            except ValueError:
                warnings.append(f"Skipped focused PV tail move; invalid UCI: {uci}.")
                break
            if move not in parent_board.legal_moves:
                warnings.append(f"Stopped focused PV tail; move {uci} is illegal in this branch.")
                break
            parent_pgn_node = parent_pgn_node.add_variation(move)
            parent_board.push(move)
            move_count += 1
            added += 1
        return added

    def _append_engine_tail() -> int:
        nonlocal parent_pgn_node, parent_board, move_count
        if tail_engine is None or move_count >= target_plies:
            return 0
        added = 0
        while move_count < target_plies and not parent_board.is_game_over(claim_draw=True):
            try:
                lines = tail_engine.analyse(
                    parent_board,
                    depth=max(6, min(18, int(tail_depth or 12))),
                    multipv=1,
                    time_sec=max(0.01, min(0.5, float(tail_time_sec or 0.05))),
                )
            except Exception as exc:
                warnings.append(f"Stopped engine tail; Stockfish failed: {exc}")
                break
            pv = (lines[0].get("pv") if lines else []) or []
            move = pv[0] if pv else None
            if not isinstance(move, chess.Move) or move not in parent_board.legal_moves:
                warnings.append("Stopped engine tail; no legal best move returned.")
                break
            san = parent_board.san(move)
            parent_pgn_node = parent_pgn_node.add_variation(move)
            if added == 0:
                parent_pgn_node.comment = f"Engine tail: Stockfish best move {san} continues the chapter to move 20."
            parent_board.push(move)
            move_count += 1
            added += 1
        return added

    for step in chain:
        if not _append_node_move(step):
            break

    seen_node_ids = {str(step.get("id", "") or "") for step in chain}
    current_id = str(anchor.get("id", "") or "")

    def _focused_child_score(child: dict[str, Any]) -> tuple[int, int, int, int]:
        classification = str(child.get("classification", "") or "").strip().lower()
        is_user = bool(child.get("isUserSide"))
        is_opponent = bool(child.get("isOpponentSide"))
        priority = 0
        if is_user:
            priority += 500
            if classification in {"best", "good", "mainline"}:
                priority += 220
            if bool(child.get("styleMatchedMove")):
                priority += 120
        if is_opponent:
            if bool(child.get("isBestEngineReply")):
                priority += 460
            if classification in {"mainline", "popular"}:
                priority += 170
            if classification in {"sideline", "inaccuracy", "mistake", "blunder"}:
                priority += 80
        if child.get("principalVariationUci"):
            priority += 40
        return (
            priority,
            int(child.get("gameCount", 0) or 0),
            int(child.get("learningPriority", 0) or 0),
            -int(child.get("ply", 0) or 0),
        )

    while current_id and move_count < target_plies:
        candidates = [
            child
            for child in children.get(current_id, [])
            if isinstance(child, dict) and str(child.get("id", "") or "") not in seen_node_ids
        ]
        legal_candidates: list[dict[str, Any]] = []
        for child in candidates:
            try:
                move = chess.Move.from_uci(str(child.get("uci", "") or ""))
            except ValueError:
                continue
            if move in parent_board.legal_moves:
                legal_candidates.append(child)
        if not legal_candidates:
            node_payload = by_id.get(current_id, {})
            if isinstance(node_payload, dict):
                _append_uci_tail(node_payload.get("continuationAfterMoveUci") or [])
                _append_engine_tail()
            break
        next_child = max(legal_candidates, key=_focused_child_score)
        if not _append_node_move(next_child):
            break
        current_id = str(next_child.get("id", "") or "")
        seen_node_ids.add(current_id)

    if move_count < target_plies and current_id:
        node_payload = by_id.get(current_id, {})
        if isinstance(node_payload, dict):
            _append_uci_tail(node_payload.get("continuationAfterMoveUci") or [])
            _append_engine_tail()

    if move_count <= 0:
        raise ValueError("Smart theory focused line did not contain any legal moves to export.")

    exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=True)
    pgn_text = game.accept(exporter).strip()
    return pgn_text, {
        "moves_exported": move_count,
        "setup_moves_exported": setup_count,
        "setup_san": setup_san,
        "warnings": warnings[:50],
    }


def _smart_tree_chapter_exports(
    tree_payload: dict[str, Any],
    *,
    strategy: str,
    chapter_name_base: str,
    max_chapters: int = 62,
    min_chapter_moves: int = 0,
    tail_engine: Any | None = None,
    tail_depth: int = 12,
    tail_time_sec: float = 0.05,
) -> list[dict[str, Any]]:
    normalized_strategy = str(strategy or "").strip().lower()
    if normalized_strategy not in {"single", "first_move", "unknown_focus", "deep_focus"}:
        normalized_strategy = "first_move"
    max_chapters = max(1, min(80, int(max_chapters or 62)))
    min_chapter_moves = max(0, min(80, int(min_chapter_moves or 0)))

    if normalized_strategy == "single":
        pgn_text, meta = _smart_tree_to_pgn(tree_payload, chapter_name=chapter_name_base)
        return [{"name": chapter_name_base, "pgn": pgn_text, "meta": meta}]

    nodes = tree_payload.get("nodes", [])
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("Smart theory tree has no nodes for chapter export.")
    root_id, children, by_id = _smart_tree_children(nodes)
    root_node = by_id.get(root_id, {})
    first_moves = children.get(root_id, [])
    if not first_moves:
        pgn_text, meta = _smart_tree_to_pgn(tree_payload, chapter_name=chapter_name_base)
        return [{"name": chapter_name_base, "pgn": pgn_text, "meta": meta}]

    chapters: list[dict[str, Any]] = []
    setup_san_for_titles: list[str] = []
    if isinstance(root_node, dict):
        try:
            setup_warnings: list[str] = []
            setup_board, setup_moves = _smart_tree_export_context(tree_payload, root_node, setup_warnings)
            replay = setup_board.copy(stack=False)
            for setup_move in setup_moves:
                setup_san_for_titles.append(replay.san(setup_move))
                replay.push(setup_move)
        except Exception:
            setup_san_for_titles = []
    parent_by_id: dict[str, str] = {
        str(node.get("id", "") or ""): str(node.get("parentId", "") or "")
        for node in nodes
        if isinstance(node, dict)
    }

    def _node_chain_to_root(node: dict[str, Any]) -> list[dict[str, Any]]:
        chain: list[dict[str, Any]] = []
        cursor = node
        safety = 0
        while isinstance(cursor, dict) and safety < 256:
            node_id = str(cursor.get("id", "") or "")
            if not node_id or node_id == root_id:
                break
            chain.append(cursor)
            parent_id = parent_by_id.get(node_id, "")
            cursor = by_id.get(parent_id)
            safety += 1
        chain.reverse()
        return chain

    def _path_caption(node: dict[str, Any]) -> str:
        chain = _node_chain_to_root(node)
        sans = [*setup_san_for_titles, *[str(step.get("san", "") or step.get("uci", "")).strip() for step in chain]]
        sans = [item for item in sans if item]
        if not sans:
            return ""
        tail = sans[-6:]
        return " ".join(tail)

    def _chapter_title(core_title: str) -> str:
        title = str(core_title or "").strip()
        if not title:
            title = "Smart Theory Line"
        return title[:100]

    def _opening_family_title(opening_name: str, path_caption: str) -> str:
        opening_lower = str(opening_name or "").lower()
        path_lower = f" {str(path_caption or '').lower()} "
        has_e4 = bool(re.search(r"\be4\b", path_lower))
        has_d4 = bool(re.search(r"\bd4\b", path_lower))
        has_c4 = bool(re.search(r"\bc4\b", path_lower))
        has_c5 = bool(re.search(r"\bc5\b", path_lower))
        has_d5 = bool(re.search(r"\bd5\b", path_lower))
        has_e5 = bool(re.search(r"\be5\b", path_lower))
        has_n_f3 = bool(re.search(r"\bnf3\b", path_lower))
        has_g3 = bool(re.search(r"\bg3\b", path_lower))
        has_bg2 = bool(re.search(r"\bbg2\b", path_lower))
        has_nf6 = bool(re.search(r"\bnf6\b", path_lower))
        has_g6 = bool(re.search(r"\bg6\b", path_lower))
        has_bg7 = bool(re.search(r"\bbg7\b", path_lower))
        has_bf4 = bool(re.search(r"\bbf4\b", path_lower))

        if "pirc" in opening_lower or (has_e4 and (has_nf6 or has_g6) and "d6" in path_lower):
            if has_e5:
                return "Pirc when Black plays ...e5"
            return "Pirc vs e4"
        if "king" in opening_lower and "indian" in opening_lower and "attack" in opening_lower or (has_n_f3 and has_g3 and has_bg2):
            if has_c5:
                return "KIA vs Sicilian Setup"
            if has_d5:
                return "King's Indian Attack vs ...d5"
            if has_e5:
                return "King's Indian Attack vs ...e5"
            return "King's Indian Attack Main Setup"
        if (
            "king" in opening_lower
            and "indian" in opening_lower
            and "defense" in opening_lower
        ) or ((has_d4 or has_c4) and has_nf6 and (has_g6 or has_bg7)):
            if has_bf4:
                return "KID vs London Setup"
            return "King's Indian Defense Main Setup"
        return str(opening_name or "").strip()

    def _unknown_focus_anchors() -> list[dict[str, Any]]:
        weak_class_order = {"blunder": 0, "mistake": 1, "inaccuracy": 2}

        def _weak_score(node: dict[str, Any]) -> tuple[int, int, int, int]:
            classification = str(node.get("classification", "") or "").strip().lower()
            is_user_side = bool(node.get("isUserSide"))
            corrected = bool(node.get("isCorrectedMove"))
            # Prefer "I don't know this move" positions first:
            # corrected user-side misses, then user-side inaccuracies/mistakes/blunders.
            class_rank = weak_class_order.get(classification, 9)
            corrected_rank = 0 if corrected else 1
            user_rank = 0 if is_user_side else 1
            ply_rank = int(node.get("ply", 0) or 0)
            return (corrected_rank, class_rank, user_rank, ply_rank)

        candidates = [
            node
            for node in nodes
            if isinstance(node, dict)
            and str(node.get("id", "") or "") != root_id
            and (
                bool(node.get("isCorrectedMove"))
                or str(node.get("classification", "") or "").strip().lower() in {"inaccuracy", "mistake", "blunder"}
            )
        ]
        if not candidates:
            return []
        ranked = sorted(candidates, key=_weak_score)
        unique: list[dict[str, Any]] = []
        seen_keys: set[str] = set()
        for node in ranked:
            node_id = str(node.get("id", "") or "")
            fen_key = str(node.get("normalizedFen", "") or node.get("fen", "") or node_id)
            if fen_key in seen_keys:
                continue
            seen_keys.add(fen_key)
            unique.append(node)
            if len(unique) >= max_chapters:
                break
        return unique

    def _chapter_label_for(node: dict[str, Any], index: int) -> str:
        move_name = str(node.get("san", "") or node.get("uci", "") or f"branch-{index}").strip() or f"branch-{index}"
        opening_name = str(node.get("openingName", "") or tree_payload.get("openingName", "") or "").strip()
        classification = str(node.get("classification", "") or "").strip()
        if classification:
            classification = classification.lower().replace("_", " ")
        path_caption = _path_caption(node)
        family_title = _opening_family_title(opening_name, path_caption)
        try:
            ply = max(1, int(node.get("ply", 1) or 1))
        except (TypeError, ValueError):
            ply = 1
        move_number = (ply + 1) // 2
        numbered_move = f"{move_number}.{move_name}" if ply % 2 == 1 else f"{move_number}...{move_name}"
        compact_path = path_caption
        if compact_path:
            compact_path = " ".join(compact_path.split()[-8:])

        if normalized_strategy == "unknown_focus":
            if bool(node.get("isCorrectedMove")):
                focus_kind = "Fix this line"
            elif classification and classification not in {"mainline", "best"}:
                focus_kind = classification.title()
            elif bool(node.get("isBestEngineReply")):
                focus_kind = "Best opponent reply"
            else:
                focus_kind = "Study this line"
            focus_bits = [f"{numbered_move} {focus_kind}"]
            if compact_path and move_name.lower() not in compact_path.lower().split()[-2:]:
                focus_bits.append(f"after {compact_path}")
            focus_label = " | ".join(focus_bits)
            if family_title:
                return _chapter_title(f"{family_title} | {focus_label}")
            return _chapter_title(focus_label)

        original = str(node.get("originalUserMove", "") or "").strip()
        corrected = str(node.get("correctedMove", "") or "").strip()
        if original and corrected:
            branch_label = f"{numbered_move} correction"
        elif bool(node.get("isBestEngineReply")):
            branch_label = f"{numbered_move} best opponent move"
        elif classification and classification not in {"mainline", "best"}:
            branch_label = f"{numbered_move} {classification}"
        else:
            branch_label = f"{numbered_move} main line"
        if compact_path and move_name.lower() not in compact_path.lower().split()[-2:]:
            branch_label = f"{branch_label} after {compact_path}"
        if family_title:
            return _chapter_title(f"{family_title} | {branch_label}")
        return _chapter_title(branch_label or "Smart Theory Line")

    def _chapter_anchor_score(node: dict[str, Any]) -> tuple[int, int, int, int]:
        node_id = str(node.get("id", "") or "")
        parent_id = str(node.get("parentId", "") or "")
        classification = str(node.get("classification", "") or "").strip().lower()
        ply = int(node.get("ply", 0) or 0)
        is_root_child = parent_id == root_id
        is_corrected = bool(node.get("isCorrectedMove"))
        is_best_engine = bool(node.get("isBestEngineReply"))
        is_weak = classification in {"inaccuracy", "mistake", "blunder"}
        priority = 0
        if is_root_child:
            priority += 900
        if is_corrected:
            priority += 520
        if is_best_engine:
            priority += 220
        if is_weak:
            priority += 180
        priority += max(0, 16 - min(16, ply))
        return (-priority, ply, -int(node.get("gameCount", 0) or 0), hash(node_id) % 997)

    anchor_nodes = first_moves[:16]
    if normalized_strategy == "unknown_focus":
        focus_nodes = _unknown_focus_anchors()
        if focus_nodes:
            anchor_nodes = focus_nodes
    elif normalized_strategy == "deep_focus":
        anchor_pool = [
            node
            for node in nodes
            if isinstance(node, dict)
            and str(node.get("id", "") or "") != root_id
            and str(node.get("uci", "") or "").strip()
            and int(node.get("ply", 0) or 0) <= 28
        ]
        ranked_pool = sorted(anchor_pool, key=_chapter_anchor_score)
        anchor_nodes = []
        seen_anchor_keys: set[str] = set()
        for node in ranked_pool:
            node_id = str(node.get("id", "") or "")
            key = str(node.get("normalizedFen", "") or node.get("fen", "") or node_id)
            if not node_id or key in seen_anchor_keys:
                continue
            seen_anchor_keys.add(key)
            anchor_nodes.append(node)
            if len(anchor_nodes) >= max_chapters * 4:
                break
    else:
        anchor_pool: list[dict[str, Any]] = [
            node
            for node in nodes
            if isinstance(node, dict)
            and str(node.get("id", "") or "") != root_id
            and (
                str(node.get("parentId", "") or "") == root_id
                or bool(node.get("isCorrectedMove"))
                or bool(node.get("isBestEngineReply"))
                or str(node.get("classification", "") or "").strip().lower() in {"inaccuracy", "mistake", "blunder"}
            )
        ]
        ranked_pool = sorted(anchor_pool, key=_chapter_anchor_score)
        anchor_nodes = []
        seen_anchor_keys: set[str] = set()
        for node in ranked_pool:
            node_id = str(node.get("id", "") or "")
            key = str(node.get("normalizedFen", "") or node.get("fen", "") or node_id)
            if not node_id or key in seen_anchor_keys:
                continue
            seen_anchor_keys.add(key)
            anchor_nodes.append(node)
            if len(anchor_nodes) >= max_chapters:
                break

    seen_titles: dict[str, int] = {}
    for index, node in enumerate(anchor_nodes, start=1):
        label = _chapter_label_for(node, index)
        title_count = seen_titles.get(label, 0) + 1
        seen_titles[label] = title_count
        if title_count > 1:
            label = _chapter_title(f"{label} #{title_count}")
        if normalized_strategy == "deep_focus":
            pgn_text, meta = _smart_focused_line_to_pgn(
                tree_payload,
                anchor_node_id=str(node.get("id", "") or ""),
                chapter_name=label,
                tail_engine=tail_engine,
                tail_depth=tail_depth,
                tail_time_sec=tail_time_sec,
            )
        else:
            pgn_text, meta = _smart_subtree_to_pgn(
                tree_payload,
                anchor_node_id=str(node.get("id", "") or ""),
                chapter_name=label,
                include_root_siblings=False,
            )
        if min_chapter_moves and int((meta or {}).get("moves_exported", 0) or 0) < min_chapter_moves:
            continue
        chapter_meta = dict(meta or {})
        chapter_meta["anchor_node_id"] = str(node.get("id", "") or "")
        chapter_meta["anchor_classification"] = str(node.get("classification", "") or "")
        chapters.append({"name": _chapter_title(label), "pgn": pgn_text, "meta": chapter_meta})
        if len(chapters) >= max_chapters:
            break
    return chapters


def _create_lichess_study(*, token: str, study_name: str = "Bookup", visibility: str = "unlisted") -> dict[str, Any]:
    bearer = str(token or "").strip()
    if not bearer:
        raise ValueError("Lichess token is required.")
    vis = str(visibility or "unlisted").strip().lower()
    if vis not in {"public", "unlisted", "private"}:
        vis = "unlisted"
    body = urlencode(
        {
            "name": str(study_name or "Bookup").strip()[:100] or "Bookup",
            "visibility": vis,
            "computer": "everyone",
            "explorer": "everyone",
            "cloneable": "everyone",
            "shareable": "everyone",
            "chat": "member",
            "sticky": "true",
        }
    ).encode("utf-8")
    request = Request(
        url="https://lichess.org/api/study",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": "Bookup Smart Theory Export",
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw else {}
            study_id = _extract_study_id(str(data.get("id", "") or ""))
            if not study_id:
                raise RuntimeError("Lichess did not return a study ID after creation.")
            return {
                "ok": True,
                "study_id": study_id,
                "study_url": f"https://lichess.org/study/{study_id}",
                "response": data,
            }
    except URLError as exc:
        reason = getattr(exc, "reason", None)
        raise RuntimeError(f"Lichess study creation failed: {reason or exc}") from exc


def _post_pgn_to_lichess_study(*, study_id: str, token: str, chapter_name: str, pgn_text: str, orientation: str = "white") -> dict[str, Any]:
    normalized_study_id = _extract_study_id(study_id)
    if not normalized_study_id:
        raise ValueError("Lichess study ID is required.")
    bearer = str(token or "").strip()
    if not bearer:
        raise ValueError("Lichess token is required.")
    normalized_orientation = "black" if str(orientation or "").strip().lower() == "black" else "white"
    body = urlencode(
        {
            "name": str(chapter_name or "Bookup Smart Theory").strip() or "Bookup Smart Theory",
            "pgn": str(pgn_text or "").strip(),
            "orientation": normalized_orientation,
        }
    ).encode("utf-8")
    request = Request(
        url=f"https://lichess.org/api/study/{normalized_study_id}/import-pgn",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": "Bookup Smart Theory Export",
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                data = {"raw": raw}
            return {
                "ok": True,
                "status_code": int(getattr(response, "status", 200) or 200),
                "study_id": normalized_study_id,
                "study_url": f"https://lichess.org/study/{normalized_study_id}",
                "response": data,
            }
    except URLError as exc:
        reason = getattr(exc, "reason", None)
        raise RuntimeError(f"Lichess study import failed: {reason or exc}") from exc


def _list_lichess_study_chapters(*, study_id: str, token: str) -> list[dict[str, Any]]:
    normalized_study_id = _extract_study_id(study_id)
    if not normalized_study_id:
        raise ValueError("Lichess study ID is required.")
    bearer = str(token or "").strip()
    if not bearer:
        raise ValueError("Lichess token is required.")
    request = Request(
        url=f"https://lichess.org/api/study/{normalized_study_id}.pgn",
        method="GET",
        headers={
            "Authorization": f"Bearer {bearer}",
            "Accept": "application/x-chess-pgn",
            "User-Agent": "Bookup Smart Theory Export",
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except URLError as exc:
        reason = getattr(exc, "reason", None)
        raise RuntimeError(f"Lichess chapter listing failed: {reason or exc}") from exc
    chapters: list[dict[str, Any]] = []
    handle = io.StringIO(raw)
    while True:
        game = chess.pgn.read_game(handle)
        if game is None:
            break
        chapter_name = str(game.headers.get("ChapterName", "") or "").strip()
        event_name = str(game.headers.get("Event", "") or "").strip()
        if not chapter_name and event_name:
            # Some study exports omit ChapterName but keep the chapter title in Event.
            chapter_name = event_name
        chapter_url = str(game.headers.get("ChapterURL", "") or "").strip()
        chapter_id = chapter_url.rstrip("/").split("/")[-1] if chapter_url else ""
        plies = sum(1 for _ in game.mainline_moves())
        chapters.append(
            {
                "chapter_id": chapter_id,
                "chapter_name": chapter_name,
                "event_name": event_name,
                "plies": int(plies),
            }
        )
    return chapters


def _delete_lichess_study_chapter(*, study_id: str, chapter_id: str, token: str) -> dict[str, Any]:
    normalized_study_id = _extract_study_id(study_id)
    normalized_chapter_id = str(chapter_id or "").strip()
    bearer = str(token or "").strip()
    if not normalized_study_id:
        raise ValueError("Lichess study ID is required.")
    if not normalized_chapter_id:
        raise ValueError("Lichess chapter ID is required.")
    if not bearer:
        raise ValueError("Lichess token is required.")
    request = Request(
        url=f"https://lichess.org/api/study/{normalized_study_id}/{normalized_chapter_id}",
        method="DELETE",
        headers={
            "Authorization": f"Bearer {bearer}",
            "Accept": "application/json",
            "User-Agent": "Bookup Smart Theory Export",
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                data = {"raw": raw}
            return {
                "ok": True,
                "status_code": int(getattr(response, "status", 200) or 200),
                "study_id": normalized_study_id,
                "chapter_id": normalized_chapter_id,
                "response": data,
            }
    except URLError as exc:
        reason = getattr(exc, "reason", None)
        raise RuntimeError(f"Lichess chapter delete failed: {reason or exc}") from exc


def _cleanup_default_placeholder_chapters(*, study_id: str, token: str) -> dict[str, Any]:
    """Delete empty default chapters (for example 'Chapter 1') when possible."""
    chapters = _list_lichess_study_chapters(study_id=study_id, token=token)
    deleted: list[str] = []
    errors: list[str] = []
    placeholder_pattern = re.compile(r"^chapter\s+\d+$")
    for chapter in chapters:
        chapter_id = str(chapter.get("chapter_id", "") or "").strip()
        chapter_name = str(chapter.get("chapter_name", "") or "").strip().lower()
        event_name = str(chapter.get("event_name", "") or "").strip().lower()
        effective_name = chapter_name or event_name
        plies = int(chapter.get("plies", 0) or 0)
        # Lichess creates an empty starter chapter for a new study. Remove it so
        # Bookup sync produces a clean chapter list.
        is_placeholder = (
            not effective_name
            or effective_name in {"chapter 1", "default"}
            or bool(placeholder_pattern.match(effective_name))
        )
        if is_placeholder and plies == 0 and chapter_id:
            try:
                _delete_lichess_study_chapter(study_id=study_id, chapter_id=chapter_id, token=token)
                deleted.append(chapter_id)
            except Exception as exc:
                errors.append(str(exc))
    return {
        "deleted_count": len(deleted),
        "deleted_chapter_ids": deleted,
        "errors": errors[:10],
    }


def _cleanup_all_study_chapters(*, study_id: str, token: str) -> dict[str, Any]:
    """Delete all existing chapters before posting a fresh Smart Theory export."""
    chapters = _list_lichess_study_chapters(study_id=study_id, token=token)
    deleted: list[str] = []
    errors: list[str] = []
    for chapter in chapters:
        chapter_id = str(chapter.get("chapter_id", "") or "").strip()
        if not chapter_id:
            continue
        try:
            _delete_lichess_study_chapter(study_id=study_id, chapter_id=chapter_id, token=token)
            deleted.append(chapter_id)
        except Exception as exc:
            errors.append(str(exc))
    return {
        "deleted_count": len(deleted),
        "deleted_chapter_ids": deleted,
        "chapters_seen": len(chapters),
        "errors": errors[:10],
    }


def _is_missing_study_error(exc: Exception) -> bool:
    text = str(exc or "").lower()
    return ("404" in text and "study" in text) or "not found" in text


def _normalize_opening_focus(raw: object, fallback: str = "inferred_style") -> str:
    # Opening families are inferred from the selected source. Legacy KIA/KID/Pirc
    # settings remain readable but can no longer force unrelated moves.
    return "inferred_style"


def _normalize_bool(raw: object, fallback: bool = True) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    text = str(raw or "").strip().lower()
    if not text:
        return fallback
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return fallback


def _normalize_int_range(raw: object, *, fallback: int, minimum: int, maximum: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = int(fallback)
    return max(minimum, min(maximum, value))


def _normalize_float_range(raw: object, *, fallback: float, minimum: float, maximum: float) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = float(fallback)
    return max(minimum, min(maximum, value))


def _normalize_study_history(raw: object) -> list[str]:
    if isinstance(raw, list):
        values = [str(item or "").strip() for item in raw]
    else:
        values = [str(raw or "").strip()]
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in values:
        study_id = _extract_study_id(item)
        if not study_id or study_id in seen:
            continue
        seen.add(study_id)
        cleaned.append(study_id)
    return cleaned[:24]


def _append_study_history(config: dict[str, Any], previous_study_id: str) -> None:
    prev = _extract_study_id(previous_study_id)
    if not prev:
        return
    history = _normalize_study_history(config.get("bookup_study_id_history", []))
    if prev in history:
        history = [item for item in history if item != prev]
    history.insert(0, prev)
    config["bookup_study_id_history"] = history[:24]


def _normalize_unified_study_name(raw: object, *, fallback: str = "Bookup") -> str:
    text = " ".join(str(raw or "").strip().split())
    if not text:
        text = " ".join(str(fallback or "Bookup").strip().split()) or "Bookup"
    return text[:120]


def _smart_theory_state_name(raw_status: str) -> str:
    status = str(raw_status or "").strip().lower()
    if status in {"generating", "queued", "starting"}:
        return "Generating"
    if status == "analyzing":
        return "Analyzing"
    if status == "stopping":
        return "Stopping"
    if status == "complete":
        return "Complete"
    if status == "stopped":
        return "Complete"
    if status in {"failed", "error"}:
        return "Error"
    return "Idle"


def _smart_job_payload(job_id: str, job: dict[str, object]) -> dict[str, object]:
    status = str(job.get("status", "idle") or "idle")
    warnings_list = job.get("warnings", []) if isinstance(job.get("warnings"), list) else []
    try:
        warnings_count = int(job.get("warnings_count", len(warnings_list)) or 0)
    except (TypeError, ValueError):
        warnings_count = len(warnings_list)
    return {
        "job_id": job_id,
        "status": status,
        "generation_state": _smart_theory_state_name(status),
        "message": str(job.get("message", "") or ""),
        "positions_done": int(job.get("positions_done", 0) or 0),
        "positions_total": int(job.get("positions_total", 0) or 0),
        "cancelled": bool(job.get("cancelled")),
        "created_at": float(job.get("created_at", 0.0) or 0.0),
        "updated_at": float(job.get("updated_at", 0.0) or 0.0),
        "has_result": bool(job.get("result")),
        "warnings_count": max(0, warnings_count),
        "warning_latest": str(job.get("warning_latest", "") or ""),
        "partial_nodes": job.get("partial_nodes", []) if isinstance(job.get("partial_nodes"), list) else [],
        "partial_total_nodes": int(job.get("partial_total_nodes", 0) or 0),
        "study_sync": job.get("study_sync") if isinstance(job.get("study_sync"), dict) else None,
    }


def _resolve_smart_theory_source(payload: dict[str, object]) -> dict[str, object]:
    source = payload.get("source_context")
    source = source if isinstance(source, dict) else {}
    source_type = str(
        source.get("type")
        or payload.get("starting_source")
        or "current_board"
    ).strip().lower()
    aliases = {
        "imported_pgn": "imported_game",
        "starting_position": "current_board",
        "selected_move": "current_board",
    }
    source_type = aliases.get(source_type, source_type)
    allowed = {"current_board", "saved_line", "imported_game", "my_repertoire"}
    if source_type not in allowed:
        raise ValueError("Starting source must be Current board, Saved line, Imported game, or My repertoire.")
    source_id = str(source.get("id") or payload.get("source_id") or "").strip()
    if source_type != "current_board" and not source_id:
        raise ValueError(f"Select a specific {source_type.replace('_', ' ')} before generating.")
    imported_pgn = str(source.get("pgn") or "").strip()
    imported_moves: list[str] = []
    imported_fen = ""
    if source_type == "imported_game" and imported_pgn:
        try:
            imported_game = chess.pgn.read_game(io.StringIO(imported_pgn))
        except Exception as exc:
            raise ValueError("The selected imported game could not be parsed.") from exc
        if imported_game is None:
            raise ValueError("The selected imported game contains no readable PGN game.")
        imported_board = imported_game.board()
        imported_fen = imported_board.fen()
        for move in imported_game.mainline_moves():
            if move not in imported_board.legal_moves:
                raise ValueError("The selected imported game contains an illegal move.")
            imported_moves.append(move.uci())
            imported_board.push(move)
    raw_fen = str(source.get("fen") or imported_fen or payload.get("fen") or chess.STARTING_FEN).strip()
    if raw_fen == "startpos":
        raw_fen = chess.STARTING_FEN
    try:
        board = chess.Board(raw_fen)
    except ValueError as exc:
        raise ValueError("The selected Smart Theory source has an invalid starting position.") from exc
    raw_moves = source.get("moves_uci")
    if source_type == "imported_game" and imported_moves and (not isinstance(raw_moves, list) or not raw_moves):
        raw_moves = imported_moves
    if not isinstance(raw_moves, list):
        raw_moves = (
            imported_moves
            if imported_moves
            else payload.get("user_book_line_uci")
            if isinstance(payload.get("user_book_line_uci"), list)
            else []
        )
    moves_uci: list[str] = []
    cursor = board.copy(stack=False)
    for index, raw_move in enumerate(raw_moves[:160]):
        move_uci = str(raw_move or "").strip().lower()
        if not move_uci:
            continue
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError as exc:
            raise ValueError(f"Source move {index + 1} is not valid UCI: {move_uci}.") from exc
        if move not in cursor.legal_moves:
            raise ValueError(f"Source move {index + 1} ({move_uci}) is illegal from the preceding source position.")
        moves_uci.append(move_uci)
        cursor.push(move)
    player_color = "black" if str(source.get("player_color") or payload.get("my_color") or "white").lower() == "black" else "white"
    label = str(source.get("label") or {
        "current_board": "Current board",
        "saved_line": "My saved line",
        "imported_game": "My imported game",
        "my_repertoire": "My repertoire",
    }[source_type]).strip()
    fingerprint_payload = {
        "schema": 2,
        "type": source_type,
        "id": source_id,
        "fen": board.fen(),
        "moves_uci": moves_uci,
        "player_color": player_color,
    }
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {
        "type": source_type,
        "id": source_id,
        "label": label,
        "fen": board.fen(),
        "moves_uci": moves_uci,
        "player_color": player_color,
        "fingerprint": fingerprint,
    }


def _smart_theory_tree_cache_key(board_fen: str, payload: dict[str, object], settings: EngineSettings) -> str:
    cache_payload = {
        "schema": 2,
        "fen": chess.Board(board_fen).fen(),
        "source_fingerprint": str(payload.get("source_fingerprint", "") or ""),
        "my_color": str(payload.get("my_color", "white") or "white"),
        "opponent_accuracy": str(payload.get("opponent_accuracy", "mixed") or "mixed"),
        "depth": int(settings.depth),
        "multipv": int(settings.multipv),
        "time_sec": float(settings.think_time_sec),
        "workers": int(settings.parallel_workers),
        "max_ply": int(payload.get("max_ply", 40) or 40),
        "max_positions": int(payload.get("max_positions", 900) or 900),
        "opponent_replies": int(payload.get("opponent_replies", 6) or 6),
        "expected_move_confidence_cp": int(payload.get("expected_move_confidence_cp", 125) or 125),
        "style_move_confidence_cp": int(payload.get("style_move_confidence_cp", 90) or 90),
        "style_preferred_min_weight": float(payload.get("style_preferred_min_weight", 1.2) or 1.2),
        "include_rare_sidelines": bool(payload.get("include_rare_sidelines", True)),
        "include_opponent_mistakes": bool(payload.get("include_opponent_mistakes", True)),
        "include_opponent_blunders": bool(payload.get("include_opponent_blunders", False)),
        "include_best_engine_replies": bool(payload.get("include_best_engine_replies", True)),
        "avoid_absurd_moves": bool(payload.get("avoid_absurd_moves", True)),
    }
    digest = hashlib.sha256(
        json.dumps(cache_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"smart-theory-tree-v2:{digest}"


def _run_smart_theory_job(
    *,
    job_id: str,
    board_fen: str,
    payload: dict[str, object],
    settings: EngineSettings,
    lichess_token: str,
) -> None:
    # Background worker for one Smart Theory job. We keep job state in-memory so
    # the UI can poll lightweight status updates without blocking the request thread.
    def _status_update(phase: str, message: str, done: int, total: int, **extra: object) -> None:
        with SMART_THEORY_JOBS_LOCK:
            job = SMART_THEORY_JOBS.get(job_id)
            if not isinstance(job, dict):
                return
            if not job.get("cancelled") and phase == "stopping":
                phase = "analyzing"
            if phase == "complete":
                phase = "analyzing"
                message = "Validating and finalizing the Smart Theory tree..."
            elif phase == "stopped":
                phase = "stopping"
                message = "Finalizing the partial Smart Theory tree..."
            job["status"] = phase
            job["message"] = message
            job["positions_done"] = int(done)
            job["positions_total"] = int(total)
            partial_nodes = extra.get("partial_nodes")
            partial_total_nodes = extra.get("partial_total_nodes")
            warning_latest = extra.get("warning_latest")
            warnings_count = extra.get("warnings_count")
            if isinstance(partial_nodes, list):
                job["partial_nodes"] = partial_nodes
            if partial_total_nodes is not None:
                try:
                    job["partial_total_nodes"] = int(partial_total_nodes)
                except (TypeError, ValueError):
                    pass
            if warning_latest is not None:
                job["warning_latest"] = str(warning_latest or "")
            if warnings_count is not None:
                try:
                    job["warnings_count"] = int(warnings_count)
                except (TypeError, ValueError):
                    pass
            job["updated_at"] = time.time()

    def _cancelled() -> bool:
        with SMART_THEORY_JOBS_LOCK:
            return bool(SMART_THEORY_JOBS.get(job_id, {}).get("cancelled"))

    def _background_study_sync(result_payload: dict[str, Any]) -> dict[str, Any]:
        auto_sync = bool(payload.get("auto_sync_to_study", False))
        if not auto_sync:
            return {"status": "skipped", "reason": "auto_sync_disabled"}
        if str(result_payload.get("status", "")).lower() == "stopped":
            return {"status": "skipped", "reason": "generation_stopped"}
        token = str(payload.get("lichess_token") or lichess_token or "").strip()
        if not token:
            return {"status": "skipped", "reason": "missing_lichess_token"}
        config = migrate_engine_defaults(load_config())
        study_id = _extract_study_id(str(payload.get("study_id", "") or "")) or _extract_study_id(str(config.get("bookup_study_id", "") or ""))
        configured_unified_name = _normalize_unified_study_name(config.get("bookup_study_name", "Bookup"), fallback="Bookup")
        unified_name = _normalize_unified_study_name(
            payload.get("unified_study_name", configured_unified_name),
            fallback=configured_unified_name,
        )
        created_unified_study = False
        previous_study_id = _extract_study_id(str(config.get("bookup_study_id", "") or ""))
        if not study_id:
            created = _create_lichess_study(token=token, study_name=unified_name, visibility="unlisted")
            study_id = str(created.get("study_id", "") or "")
            if study_id:
                created_unified_study = True
                # Verify study is reachable before switching local config.
                _list_lichess_study_chapters(study_id=study_id, token=token)
                if previous_study_id and previous_study_id != study_id:
                    _append_study_history(config, previous_study_id)
                config["bookup_study_id"] = study_id
                config["bookup_study_name"] = unified_name
                save_config(config)
        if not study_id:
            return {"status": "error", "error": "No study ID available for background sync."}
        chapter_name = str(payload.get("chapter_name", "") or "").strip() or "Bookup Smart Theory"
        orientation = "black" if str(payload.get("orientation", "white") or "white").strip().lower() == "black" else "white"
        chapter_strategy = str(payload.get("chapter_strategy", config.get("bookup_chapter_strategy", "single")) or "single").strip().lower()
        if chapter_strategy not in {"single", "first_move", "unknown_focus", "deep_focus"}:
            chapter_strategy = "single"
        max_chapters = _normalize_int_range(payload.get("max_chapters", 62), fallback=62, minimum=1, maximum=80)
        min_chapter_moves = _normalize_int_range(payload.get("min_chapter_moves", 40 if chapter_strategy == "deep_focus" else 0), fallback=40 if chapter_strategy == "deep_focus" else 0, minimum=0, maximum=80)
        extend_with_engine_tail = _normalize_bool(payload.get("extend_with_engine_tail", True), fallback=True)
        tail_depth = _normalize_int_range(payload.get("tail_depth", 12), fallback=12, minimum=6, maximum=18)
        tail_time_sec = _normalize_float_range(payload.get("tail_time_sec", 0.05), fallback=0.05, minimum=0.01, maximum=0.5)
        replace_existing_chapters = bool(payload.get("replace_existing_chapters", True))
        tail_engine = None
        if chapter_strategy == "deep_focus" and extend_with_engine_tail:
            tail_settings = request_engine_settings(payload, config)
            tail_settings = EngineSettings(
                path=tail_settings.path,
                depth=tail_depth,
                threads=max(1, min(4, int(tail_settings.threads))),
                hash_mb=max(256, min(2048, int(tail_settings.hash_mb))),
                multipv=1,
                think_time_sec=tail_time_sec,
                parallel_workers=1,
            )
            tail_engine = shared_engine_for(tail_settings)
        chapters_payload = _smart_tree_chapter_exports(
            result_payload,
            strategy=chapter_strategy,
            chapter_name_base=chapter_name,
            max_chapters=max_chapters,
            min_chapter_moves=min_chapter_moves,
            tail_engine=tail_engine,
            tail_depth=tail_depth,
            tail_time_sec=tail_time_sec,
        )
        cleanup_result = {"deleted_count": 0, "deleted_chapter_ids": [], "errors": []}
        if replace_existing_chapters:
            try:
                cleanup_result = _cleanup_all_study_chapters(study_id=study_id, token=token)
            except Exception as cleanup_exc:
                cleanup_result = {
                    "deleted_count": 0,
                    "deleted_chapter_ids": [],
                    "errors": [str(cleanup_exc)],
                }
        created_chapters: list[dict[str, Any]] = []
        for chapter in chapters_payload[:max_chapters]:
            response = _post_pgn_to_lichess_study(
                study_id=study_id,
                token=token,
                chapter_name=str(chapter.get("name", chapter_name) or chapter_name),
                pgn_text=str(chapter.get("pgn", "") or ""),
                orientation=orientation,
            )
            created_chapters.append(
                {
                    "name": str(chapter.get("name", "") or ""),
                    "meta": chapter.get("meta", {}),
                    "lichess_response": response.get("response", {}),
                }
            )
        if created_unified_study and not replace_existing_chapters:
            try:
                cleanup_result = _cleanup_default_placeholder_chapters(study_id=study_id, token=token)
            except Exception as cleanup_exc:
                cleanup_result = {
                    "deleted_count": 0,
                    "deleted_chapter_ids": [],
                    "errors": [str(cleanup_exc)],
                }
        elif replace_existing_chapters:
            try:
                placeholder_cleanup = _cleanup_default_placeholder_chapters(study_id=study_id, token=token)
                cleanup_result["deleted_count"] = int(cleanup_result.get("deleted_count", 0) or 0) + int(placeholder_cleanup.get("deleted_count", 0) or 0)
                cleanup_result["deleted_chapter_ids"] = [
                    *list(cleanup_result.get("deleted_chapter_ids", []) or []),
                    *list(placeholder_cleanup.get("deleted_chapter_ids", []) or []),
                ]
                cleanup_result["errors"] = [
                    *list(cleanup_result.get("errors", []) or []),
                    *list(placeholder_cleanup.get("errors", []) or []),
                ][:10]
            except Exception as cleanup_exc:
                cleanup_result["errors"] = [*list(cleanup_result.get("errors", []) or []), str(cleanup_exc)][:10]
        return {
            "status": "success",
            "study_id": study_id,
            "study_url": f"https://lichess.org/study/{study_id}",
            "created_unified_study": created_unified_study,
            "unified_study_name": unified_name,
            "previous_study_id": previous_study_id or "",
            "chapter_strategy": chapter_strategy,
            "max_chapters": max_chapters,
            "min_chapter_moves": min_chapter_moves,
            "extend_with_engine_tail": extend_with_engine_tail,
            "replace_existing_chapters": replace_existing_chapters,
            "chapters_created_count": len(created_chapters),
            "chapters_created": created_chapters,
            "moves_exported": sum(
                int((chapter.get("meta", {}) or {}).get("moves_exported", 0) or 0)
                for chapter in created_chapters
            ),
            "cleanup": cleanup_result,
        }

    try:
        board = chess.Board(board_fen)
        configure_lichess(lichess_token)
        engine = shared_engine_for(settings)
        tree_cache_key = _smart_theory_tree_cache_key(board_fen, payload, settings)
        cached_tree_payload = STORE.load_engine_cache(tree_cache_key) if bool(payload.get("cache_evaluations", False)) else {}
        cached_result = cached_tree_payload.get("smart_theory_tree") if isinstance(cached_tree_payload, dict) else None
        if isinstance(cached_result, dict) and int(cached_result.get("schema_version", 0) or 0) == 2:
            result = dict(cached_result)
            result["cache_hit"] = True
            result["generation_seconds"] = 0.0
            _status_update(
                "analyzing",
                "Restored a matching Smart Theory tree from the offline cache.",
                int(result.get("positions_done", 0) or 0),
                int(result.get("positions_total", 0) or 0),
                partial_nodes=list(result.get("nodes", []) or [])[-160:],
                partial_total_nodes=len(list(result.get("nodes", []) or [])),
            )
        else:
            result = generate_smart_theory_tree(
                board,
                engine,
                payload=payload,
                is_cancelled=_cancelled,
                status_callback=_status_update,
            )
            result, validation_warnings = validate_smart_theory_tree(result)
            if validation_warnings:
                result["warnings"] = list(result.get("warnings") or [])[:120]
            result["cache_hit"] = False
            if bool(payload.get("cache_evaluations", False)) and str(result.get("status", "")).lower() == "complete":
                STORE.save_engine_cache(tree_cache_key, {"smart_theory_tree": result})
        study_sync_result: dict[str, Any]
        try:
            study_sync_result = _background_study_sync(result)
        except Exception as sync_exc:
            study_sync_result = {"status": "error", "error": str(sync_exc)}
            warnings = result.get("warnings", [])
            if isinstance(warnings, list):
                warnings.append(f"Background Lichess study sync failed: {sync_exc}")
                result["warnings"] = warnings[:120]
        result["study_sync"] = study_sync_result
        with SMART_THEORY_JOBS_LOCK:
            job = SMART_THEORY_JOBS.get(job_id)
            if not isinstance(job, dict):
                return
            job["result"] = result
            job["partial_nodes"] = result.get("nodes", [])[-200:] if isinstance(result.get("nodes"), list) else []
            job["partial_total_nodes"] = len(result.get("nodes", []) if isinstance(result.get("nodes"), list) else [])
            job["warnings"] = result.get("warnings", [])
            job["warnings_count"] = len(job["warnings"]) if isinstance(job["warnings"], list) else 0
            job["warning_latest"] = str((job["warnings"][-1] if isinstance(job["warnings"], list) and job["warnings"] else "") or "")
            job["study_sync"] = study_sync_result
            status = str(result.get("status", "complete") or "complete")
            job["status"] = "stopped" if status == "stopped" else "complete"
            if status == "stopped":
                job["message"] = "Smart theory generation stopped."
            elif isinstance(study_sync_result, dict) and str(study_sync_result.get("status", "")).lower() == "success":
                chapters = int(study_sync_result.get("chapters_created_count", 0) or 0)
                job["message"] = f"Smart theory generation complete. Background study sync exported {chapters} chapter{'s' if chapters != 1 else ''}."
            else:
                job["message"] = "Smart theory generation complete."
            job["positions_done"] = int(result.get("positions_done", 0) or 0)
            job["positions_total"] = int(result.get("positions_total", 0) or 0)
            job["updated_at"] = time.time()
    except Exception as exc:
        with SMART_THEORY_JOBS_LOCK:
            job = SMART_THEORY_JOBS.get(job_id)
            if not isinstance(job, dict):
                return
            job["status"] = "error"
            job["message"] = f"Smart theory generation failed: {exc}"
            job["error"] = str(exc)
            job["updated_at"] = time.time()


def _numeric_status_value(payload: dict[str, object], key: str) -> float:
    try:
        return float(payload.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def _int_status_value(payload: dict[str, object], key: str) -> int:
    return max(0, int(_numeric_status_value(payload, key)))


def _augment_analysis_status(payload: dict[str, object]) -> dict[str, object]:
    """Add derived status fields so the UI does not infer stale worker state."""
    enriched = dict(payload)
    resources = enriched.get("resources")
    resources = resources if isinstance(resources, dict) else {}
    workers = _int_status_value(enriched, "workers") or int(resources.get("workers", 0) or 0)
    if workers:
        enriched["workers"] = workers

    positions_done = _int_status_value(enriched, "positions_done") or _int_status_value(enriched, "positions_analyzed")
    positions_total = _int_status_value(enriched, "positions_total")
    games_done = _int_status_value(enriched, "games_done")
    games_total = _int_status_value(enriched, "games_total")
    brilliant_games_done = _int_status_value(enriched, "brilliant_games_done")
    brilliant_games_total = _int_status_value(enriched, "brilliant_games_total")
    classified_moves = _int_status_value(enriched, "classified_moves")
    player_moves_total = _int_status_value(enriched, "player_moves_total") or _int_status_value(enriched, "moves_scanned")

    enriched["positions_left"] = max(0, positions_total - positions_done) if positions_total else 0
    enriched["games_left"] = max(0, games_total - games_done) if games_total else 0
    enriched["brilliant_games_left"] = max(0, brilliant_games_total - brilliant_games_done) if brilliant_games_total else 0
    enriched["moves_left"] = max(0, player_moves_total - classified_moves) if player_moves_total else 0

    slots = enriched.get("scan_active_slots")
    live_positions = enriched.get("live_positions")
    slot_count = len(slots) if isinstance(slots, list) else 0
    preview_count = len(live_positions) if isinstance(live_positions, list) else 0
    reported_active = _int_status_value(enriched, "active_workers") or _int_status_value(enriched, "scan_active_workers")
    if bool(enriched.get("active")) and str(enriched.get("phase", "")) in {"stockfish_positions", "brilliant_scan"}:
        # Worker previews are pushed asynchronously; keep the status dashboard tied to
        # actual slots/previews so it does not flash 0/8 while jobs are in flight.
        active_workers = max(1 if workers else 0, reported_active, slot_count, min(workers or preview_count, preview_count))
    else:
        active_workers = reported_active
    if workers:
        active_workers = min(workers, active_workers)
    enriched["active_workers"] = active_workers
    enriched["scan_active_workers"] = active_workers if str(enriched.get("phase", "")) in {"stockfish_positions", "brilliant_scan"} else _int_status_value(enriched, "scan_active_workers")

    phase = str(enriched.get("phase", "") or "")
    if phase == "brilliant_scan":
        total = brilliant_games_total or player_moves_total
        done = brilliant_games_done or classified_moves
        left = max(0, total - done) if total else 0
        rate = _numeric_status_value(enriched, "games_per_second") or _numeric_status_value(enriched, "items_per_second") or _numeric_status_value(enriched, "positions_per_second")
    elif phase in {"loading_games", "fetch_archives", "fetch_games", "indexing"}:
        total = games_total
        done = games_done
        left = max(0, total - done) if total else 0
        rate = _numeric_status_value(enriched, "games_per_second") or _numeric_status_value(enriched, "items_per_second")
    else:
        total = positions_total
        done = positions_done
        left = max(0, total - done) if total else 0
        rate = _numeric_status_value(enriched, "positions_per_second") or _numeric_status_value(enriched, "items_per_second")
    enriched["work_total"] = total
    enriched["work_done"] = done
    enriched["work_left"] = left
    if bool(enriched.get("active")) and left > 0 and rate > 0:
        enriched["eta_sec"] = max(1, int(round(left / rate)))
    return enriched


def recommended_engine_defaults() -> dict:
    # Strong live-analysis defaults without making imports painfully expensive.
    # The hash value is a total budget; EnginePool divides it between workers.
    snapshot = system_memory_snapshot()
    safe_hash = safe_stockfish_hash_limit_mb()
    preferred_hash = max(2048, int(snapshot["available_mb"] * 0.60))
    hash_mb = max(2048, (min(safe_hash, preferred_hash) // 128) * 128)
    workers = max(1, min(MAX_SAFE_PARALLEL_WORKERS, CPU_THREADS // 2 if CPU_THREADS >= 12 else CPU_THREADS // 4 if CPU_THREADS >= 8 else 1))
    return {
        "depth": 26,
        "threads": max(1, min(CPU_THREADS, 16)),
        "hash_mb": hash_mb,
        "multipv": 5,
        "think_time_sec": 5.0,
        "parallel_workers": workers,
    }


def migrate_engine_defaults(config: dict) -> dict:
    migrated = dict(config)
    if int(config.get("engine_defaults_version", 0) or 0) < ENGINE_DEFAULTS_VERSION:
        defaults = recommended_engine_defaults()
        for key, value in defaults.items():
            current = migrated.get(key)
            if current in (None, ""):
                migrated[key] = value
                continue
            if key in {"parallel_workers", "hash_mb", "threads"}:
                try:
                    migrated[key] = max(int(current), int(value))
                except (TypeError, ValueError):
                    migrated[key] = value
        try:
            migrated["parallel_workers"] = max(1, min(MAX_SAFE_PARALLEL_WORKERS, int(migrated.get("parallel_workers", defaults["parallel_workers"]) or defaults["parallel_workers"])))
        except (TypeError, ValueError):
            migrated["parallel_workers"] = defaults["parallel_workers"]
        migrated["engine_defaults_version"] = ENGINE_DEFAULTS_VERSION
    if not str(migrated.get("engine_path", "")).strip():
        migrated["engine_path"] = default_engine_path()
    if "bookup_auto_study_sync" not in migrated:
        migrated["bookup_auto_study_sync"] = True
    if not str(migrated.get("bookup_chapter_strategy", "")).strip():
        migrated["bookup_chapter_strategy"] = "single"
    migrated["bookup_opening_focus"] = "inferred_style"
    migrated["bookup_include_best_engine_replies"] = _normalize_bool(
        migrated.get("bookup_include_best_engine_replies", True),
        fallback=True,
    )
    migrated["bookup_expected_move_confidence_cp"] = _normalize_int_range(
        migrated.get("bookup_expected_move_confidence_cp", 125),
        fallback=125,
        minimum=20,
        maximum=300,
    )
    migrated["bookup_style_move_confidence_cp"] = _normalize_int_range(
        migrated.get("bookup_style_move_confidence_cp", 90),
        fallback=90,
        minimum=20,
        maximum=300,
    )
    migrated["bookup_style_min_weight"] = _normalize_float_range(
        migrated.get("bookup_style_min_weight", 1.2),
        fallback=1.2,
        minimum=0.2,
        maximum=8.0,
    )
    migrated["bookup_study_name"] = _normalize_unified_study_name(
        migrated.get("bookup_study_name", "Bookup"),
        fallback="Bookup",
    )
    migrated["bookup_study_id_history"] = _normalize_study_history(migrated.get("bookup_study_id_history", []))
    return migrated


def local_lichess_token(config: dict | None = None) -> str:
    env_token = os.environ.get("LICHESS_TOKEN", "").strip()
    if env_token:
        return env_token
    return str((config or {}).get("lichess_token", "")).strip()


def build_engine_settings(payload: dict) -> EngineSettings:
    defaults = recommended_engine_defaults()
    engine_path = str(payload.get("engine_path", "")).strip() or default_engine_path()
    try:
        think_time_sec = float(payload.get("think_time_sec", defaults["think_time_sec"]) or 0)
    except (TypeError, ValueError):
        think_time_sec = float(defaults["think_time_sec"])
    try:
        parallel_workers = int(payload.get("parallel_workers", defaults["parallel_workers"]) or defaults["parallel_workers"])
    except (TypeError, ValueError):
        parallel_workers = int(defaults["parallel_workers"])
    parallel_workers = max(1, min(MAX_SAFE_PARALLEL_WORKERS, parallel_workers))
    try:
        requested_hash_mb = int(payload.get("hash_mb", defaults["hash_mb"]))
    except (TypeError, ValueError):
        requested_hash_mb = int(defaults["hash_mb"])
    hash_mb = max(256, min(safe_stockfish_hash_limit_mb(), requested_hash_mb))
    return EngineSettings(
        path=engine_path,
        depth=max(10, min(30, int(payload.get("depth", defaults["depth"])))),
        threads=max(1, min(CPU_THREADS, int(payload.get("threads", defaults["threads"])))),
        hash_mb=hash_mb,
        multipv=max(1, min(10, int(payload.get("multipv", defaults["multipv"])))),
        think_time_sec=max(0.0, min(60.0, think_time_sec)),
        parallel_workers=parallel_workers,
    )


def request_engine_settings(payload: dict, config: dict) -> EngineSettings:
    overrides = {
        key: payload.get(key)
        for key in ("engine_path", "depth", "threads", "hash_mb", "multipv", "think_time_sec", "parallel_workers")
        if key in payload and payload.get(key) not in (None, "")
    }
    return build_engine_settings({**config, **overrides})


def import_engine_settings(settings: EngineSettings, payload: dict | None = None) -> EngineSettings:
    """Keep game imports responsive even when deep prep settings are saved."""
    payload = payload or {}
    deep_import = _normalize_bool(payload.get("deep_import", False), fallback=False)
    if deep_import:
        return settings
    return EngineSettings(
        path=settings.path,
        depth=max(10, min(16, int(settings.depth))),
        threads=max(1, min(8, int(settings.threads))),
        hash_mb=max(256, min(4096, int(settings.hash_mb))),
        multipv=max(1, min(4, int(settings.multipv))),
        think_time_sec=max(0.05, min(1.0, float(settings.think_time_sec))),
        parallel_workers=max(1, min(MAX_SAFE_PARALLEL_WORKERS, int(settings.parallel_workers))),
    )


def engine_session_key(settings: EngineSettings) -> str:
    return json.dumps(
        {
            "path": settings.path,
            "depth": settings.depth,
            "threads": settings.threads,
            "hash_mb": settings.hash_mb,
            "multipv": settings.multipv,
            "parallel_workers": settings.parallel_workers,
        },
        sort_keys=True,
    )


def close_live_engine() -> None:
    global LIVE_ENGINE_KEY, LIVE_ENGINE_SESSION
    if LIVE_ENGINE_SESSION is not None:
        try:
            LIVE_ENGINE_SESSION.close()
        except Exception:
            pass
    LIVE_ENGINE_SESSION = None
    LIVE_ENGINE_KEY = ""


def live_engine_for(settings: EngineSettings) -> EnginePool:
    global LIVE_ENGINE_KEY, LIVE_ENGINE_SESSION
    key = engine_session_key(settings)
    if LIVE_ENGINE_SESSION is None or LIVE_ENGINE_KEY != key:
        close_live_engine()
        LIVE_ENGINE_SESSION = EnginePool(settings)
        LIVE_ENGINE_SESSION.open()
        LIVE_ENGINE_KEY = key
    return LIVE_ENGINE_SESSION


def shared_engine_for(settings: EngineSettings) -> EnginePool:
    with ENGINE_LOCK:
        return live_engine_for(settings)


atexit.register(close_live_engine)


def apply_engine_settings_to_config(config: dict, settings: EngineSettings) -> dict:
    updated = dict(config)
    updated["engine_path"] = settings.path
    updated["depth"] = settings.depth
    updated["multipv"] = settings.multipv
    updated["threads"] = settings.threads
    updated["hash_mb"] = settings.hash_mb
    updated["think_time_sec"] = settings.think_time_sec
    updated["parallel_workers"] = settings.parallel_workers
    updated["engine_defaults_version"] = ENGINE_DEFAULTS_VERSION
    return updated


def build_defaults_payload(config: dict) -> dict:
    migrated = migrate_engine_defaults(config)
    settings = build_engine_settings(migrated)
    configured_lichess_token = local_lichess_token(migrated)
    return {
        "username": migrated.get("username", ""),
        "main_platform": str(migrated.get("main_platform", "chesscom") or "chesscom").strip().lower() or "chesscom",
        "main_username": str(migrated.get("main_username", "") or "").strip(),
        "lichess_username": str(migrated.get("lichess_username", "") or "").strip(),
        "time_classes": migrated.get("time_classes", "all"),
        "max_games": int(migrated.get("max_games", 0)),
        "auto_import_on_startup": bool(migrated.get("auto_import_on_startup", True)),
        "chessnut_db_path": str(migrated.get("chessnut_db_path", "") or default_chessnut_db_path()).strip(),
        "chessnut_player_color": "black" if str(migrated.get("chessnut_player_color", "white")).strip().lower() == "black" else "white",
        "lichess_token": "",
        "lichess_token_configured": bool(configured_lichess_token),
        "engine_path": settings.path,
        "depth": settings.depth,
        "threads": settings.threads,
        "hash_mb": settings.hash_mb,
        "multipv": settings.multipv,
        "think_time_sec": settings.think_time_sec,
        "parallel_workers": settings.parallel_workers,
        "bookup_study_name": _normalize_unified_study_name(
            migrated.get("bookup_study_name", "Bookup"),
            fallback="Bookup",
        ),
        "bookup_study_id": str(migrated.get("bookup_study_id", "") or "").strip(),
        "bookup_study_id_history": _normalize_study_history(migrated.get("bookup_study_id_history", [])),
        "bookup_auto_study_sync": bool(migrated.get("bookup_auto_study_sync", True)),
        "bookup_chapter_strategy": str(migrated.get("bookup_chapter_strategy", "single") or "single").strip().lower(),
        "bookup_opening_focus": "inferred_style",
        "bookup_include_best_engine_replies": _normalize_bool(
            migrated.get("bookup_include_best_engine_replies", True),
            fallback=True,
        ),
        "bookup_expected_move_confidence_cp": _normalize_int_range(
            migrated.get("bookup_expected_move_confidence_cp", 125),
            fallback=125,
            minimum=20,
            maximum=300,
        ),
        "bookup_style_move_confidence_cp": _normalize_int_range(
            migrated.get("bookup_style_move_confidence_cp", 90),
            fallback=90,
            minimum=20,
            maximum=300,
        ),
        "bookup_style_min_weight": _normalize_float_range(
            migrated.get("bookup_style_min_weight", 1.2),
            fallback=1.2,
            minimum=0.2,
            maximum=8.0,
        ),
        "web_mode": WEB_MODE,
    }


def primary_chesscom_username(config: dict | None = None) -> str:
    migrated = migrate_engine_defaults(config or load_config())
    explicit = str(migrated.get("username", "") or "").strip()
    if explicit:
        return explicit
    platform = str(migrated.get("main_platform", "chesscom") or "chesscom").strip().lower()
    main_username = str(migrated.get("main_username", "") or "").strip()
    if platform == "chesscom" and main_username:
        return main_username
    return ""


def resolve_username(preferred: object = "", config: dict | None = None) -> str:
    explicit = str(preferred or "").strip()
    if explicit:
        return explicit
    return primary_chesscom_username(config)


def configure_runtime_mode(*, web_mode: bool) -> None:
    global WEB_MODE
    WEB_MODE = bool(web_mode)


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
            "runtime": {"web_mode": WEB_MODE},
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
            "schema_version": GAMES_CACHE_SCHEMA_VERSION,
            "username": username,
            "time_classes": sorted(normalized_time_classes),
            "max_games": 0 if max_games is None else max_games,
        },
        sort_keys=True,
    )


def game_identity_from_serialized(entry: dict) -> str:
    url = str(entry.get("url", "") or "").strip()
    if url:
        return f"url:{url}"
    pgn = str(entry.get("pgn", "") or "").strip()
    return f"pgn:{hashlib.sha256(pgn.encode('utf-8')).hexdigest()}" if pgn else ""


def game_identity_from_imported(game: ImportedGame) -> str:
    if game.url:
        return f"url:{game.url}"
    return f"pgn:{hashlib.sha256(game.pgn.encode('utf-8')).hexdigest()}"


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
    progress = normalize_training_progress(progress)
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
        "profile": browser_profile_view(profile_data),
        "training_progress": progress.get("lessons", {}),
        "training_summary": progress.get("summary", {}),
        "cached": cached,
        "reused_games": reused_games,
    }


def browser_profile_view(profile_data: dict | None) -> dict | None:
    return profile_data


def _safe_number(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_training_progress(progress: dict | None) -> dict:
    progress = progress if isinstance(progress, dict) else {}
    raw_lessons = progress.get("lessons", {})
    raw_lessons = raw_lessons if isinstance(raw_lessons, dict) else {}
    lessons: dict[str, dict] = {}
    for lesson_id, item in raw_lessons.items():
        if not isinstance(item, dict):
            continue
        lesson_key = str(lesson_id).strip()
        if not lesson_key:
            continue
        streak = max(0, int(_safe_number(item.get("streak"), 0)))
        completed_count = max(0, int(_safe_number(item.get("completed_count"), 0)))
        clean_completed_count = max(0, int(_safe_number(item.get("clean_completed_count"), 0)))
        line_state = str(item.get("line_state", "")).strip()
        if streak >= 3:
            line_state = "mastered"
        elif completed_count and not line_state:
            line_state = "completed"
        lessons[lesson_key] = {
            "streak": streak,
            "due_at": max(0, int(_safe_number(item.get("due_at"), 0))),
            "seen": max(0, int(_safe_number(item.get("seen"), 0))),
            "correct_count": max(0, int(_safe_number(item.get("correct_count"), 0))),
            "wrong_count": max(0, int(_safe_number(item.get("wrong_count"), 0))),
            "completed_count": completed_count,
            "clean_completed_count": clean_completed_count,
            "worked_on_count": max(0, int(_safe_number(item.get("worked_on_count"), 0))),
            "last_seen_at": max(0, int(_safe_number(item.get("last_seen_at"), 0))),
            "last_completed_at": max(0, int(_safe_number(item.get("last_completed_at"), 0))),
            "last_result": str(item.get("last_result", ""))[:80],
            "line_state": line_state,
        }
    raw_summary = progress.get("summary", {})
    raw_summary = raw_summary if isinstance(raw_summary, dict) else {}
    lesson_values = list(lessons.values())
    summary = {
        **raw_summary,
        "lessons_tracked": len(lesson_values),
        "lessons_completed": sum(1 for item in lesson_values if item.get("completed_count", 0) > 0),
        "mastered_lines": sum(1 for item in lesson_values if item.get("line_state") == "mastered"),
        "attempts_seen": sum(int(item.get("seen", 0)) for item in lesson_values),
        "correct_attempts": sum(int(item.get("correct_count", 0)) for item in lesson_values),
        "wrong_attempts": sum(int(item.get("wrong_count", 0)) for item in lesson_values),
        "completed_runs": sum(int(item.get("completed_count", 0)) for item in lesson_values),
        "clean_completed_runs": sum(int(item.get("clean_completed_count", 0)) for item in lesson_values),
    }
    return {"lessons": lessons, "summary": summary}


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


def board_ply(board: chess.Board) -> int:
    return max(0, (board.fullmove_number - 1) * 2 + (0 if board.turn == chess.WHITE else 1))


def _collect_lesson_move_uci(value: Any, moves: set[str]) -> None:
    if isinstance(value, str):
        text = value.strip()
        if len(text) in {4, 5}:
            try:
                chess.Move.from_uci(text)
            except ValueError:
                return
            moves.add(text)
        return
    if isinstance(value, dict):
        for key in ("uci", "move_uci", "best_reply_uci", "preferred_branch_uci"):
            _collect_lesson_move_uci(value.get(key), moves)
        for key in ("line_uci", "moves_uci", "continuation_moves_uci", "training_line_uci", "locked_training_line_uci"):
            _collect_lesson_move_uci(value.get(key), moves)
        return
    if isinstance(value, (list, tuple, set)):
        for item in value:
            _collect_lesson_move_uci(item, moves)


def lesson_book_move_set(lesson: Any) -> set[str]:
    moves: set[str] = set()
    if not isinstance(lesson, dict):
        return moves
    for key in (
        "best_reply_uci",
        "preferred_branch_uci",
        "continuation_moves_uci",
        "training_line_uci",
        "locked_training_line_uci",
        "intro_line_uci",
        "branch_lines",
        "branches",
        "database_moves",
        "common_replies",
        "player_move_frequency",
        "transposition_targets",
    ):
        _collect_lesson_move_uci(lesson.get(key), moves)
    return moves


def move_book_context(board: chess.Board, move: chess.Move, payload: dict | None = None) -> tuple[dict | None, dict]:
    payload = payload or {}
    lesson = payload.get("lesson") if isinstance(payload, dict) else {}
    ply_before = board_ply(board)
    current_opening = lookup_by_board(board)
    next_board = board.copy(stack=False)
    next_board.push(move)
    next_opening = lookup_by_board(next_board)
    lesson_moves = lesson_book_move_set(lesson)
    move_uci = move.uci()
    explicit_book = bool(payload.get("is_book") or payload.get("force_book"))
    in_lesson = move_uci in lesson_moves
    has_opening_name = bool(
        current_opening.get("name")
        or current_opening.get("eco")
        or next_opening.get("name")
        or next_opening.get("eco")
    )
    # Opening book is position-contextual, not just "first move". This keeps early
    # known theory from being relabeled as Excellent/Good while still letting the
    # engine classify middlegame choices once the opening database goes quiet.
    is_book = explicit_book or in_lesson or (ply_before <= 16 and has_opening_name)
    context = {
        "is_book": is_book,
        "explicit_book": explicit_book,
        "in_lesson": in_lesson,
        "ply_before": ply_before,
        "current_opening": current_opening,
        "next_opening": next_opening,
    }
    if not is_book:
        return None, context
    reason = "repertoire/database move" if in_lesson or explicit_book else "opening book move"
    return book_classification_payload(0.5, reason=reason), context


def _result_for_color(result: str, color: str) -> str:
    if result == "1/2-1/2":
        return "draw"
    if result == "1-0":
        return "win" if color == "white" else "loss"
    if result == "0-1":
        return "win" if color == "black" else "loss"
    return result or "unknown"


def import_games_from_pgn_text(pgn_text: str, username: str, fallback_color: str = "white") -> list[ImportedGame]:
    handle = io.StringIO(pgn_text)
    games: list[ImportedGame] = []
    username_lc = username.lower().strip()
    fallback_color = "black" if fallback_color.lower().strip() == "black" else "white"
    while True:
        game = chess.pgn.read_game(handle)
        if game is None:
            break
        headers = game.headers
        white = str(headers.get("White", "") or "")
        black = str(headers.get("Black", "") or "")
        result = str(headers.get("Result", "") or "")
        if username_lc and white.lower() == username_lc:
            color = "white"
            opponent = black or "Unknown"
        elif username_lc and black.lower() == username_lc:
            color = "black"
            opponent = white or "Unknown"
        else:
            color = fallback_color
            opponent = black if color == "white" else white
            opponent = opponent or "Unknown"
        games.append(
            ImportedGame(
                url=str(headers.get("Link", "") or headers.get("Site", "") or "PGN import"),
                time_class=infer_time_class(headers),
                player_color=color,
                result=_result_for_color(result, color),
                opponent=opponent,
                pgn=str(game),
                game=game,
            )
        )
    return games



@app.get("/")
def index() -> str:
    config = migrate_engine_defaults(load_config())
    save_config(config)
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
    username = resolve_username(request.args.get("username", ""))
    if not username:
        return jsonify(
            {
                "username": "",
                "profile": None,
                "games_imported": 0,
                "archives_found": 0,
                "games": [],
                "saved_at": None,
                "training_progress": {},
                "training_summary": {},
                "schema_version": 0,
            }
        )
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
    config = migrate_engine_defaults(load_config())

    if "username" in payload:
        config["username"] = str(payload.get("username", "") or "").strip()
    if "main_platform" in payload:
        config["main_platform"] = str(payload.get("main_platform", "chesscom") or "chesscom").strip().lower() or "chesscom"
    if "main_username" in payload:
        config["main_username"] = str(payload.get("main_username", "") or "").strip()
    if "lichess_username" in payload:
        config["lichess_username"] = str(payload.get("lichess_username", "") or "").strip()
    if "time_classes" in payload:
        raw_time_classes = str(payload.get("time_classes", "all") or "all").strip()
        config["time_classes"] = raw_time_classes or "all"
    if "max_games" in payload:
        try:
            config["max_games"] = max(0, min(20000, int(payload.get("max_games", 0) or 0)))
        except (TypeError, ValueError):
            config["max_games"] = 0
    if "chessnut_db_path" in payload:
        config["chessnut_db_path"] = str(payload.get("chessnut_db_path", "") or "").strip()
    if "chessnut_player_color" in payload:
        config["chessnut_player_color"] = "black" if str(payload.get("chessnut_player_color", "white")).strip().lower() == "black" else "white"
    if "engine_path" in payload:
        engine_path = str(payload.get("engine_path", "")).strip() or default_engine_path()
        config["engine_path"] = engine_path
    if "depth" in payload:
        try:
            config["depth"] = int(payload.get("depth", config.get("depth", recommended_engine_defaults()["depth"])))
        except (TypeError, ValueError):
            pass
    if "multipv" in payload:
        try:
            config["multipv"] = int(payload.get("multipv", config.get("multipv", 5)))
        except (TypeError, ValueError):
            pass
    if "threads" in payload:
        try:
            config["threads"] = int(payload.get("threads", config.get("threads", recommended_engine_defaults()["threads"])))
        except (TypeError, ValueError):
            pass
    if "hash_mb" in payload:
        try:
            config["hash_mb"] = int(payload.get("hash_mb", config.get("hash_mb", recommended_engine_defaults()["hash_mb"])))
        except (TypeError, ValueError):
            pass
    if "lichess_token" in payload:
        config["lichess_token"] = str(payload.get("lichess_token", config.get("lichess_token", ""))).strip()
    if "think_time_sec" in payload:
        try:
            config["think_time_sec"] = float(payload.get("think_time_sec", config.get("think_time_sec", 5.0)))
        except (TypeError, ValueError):
            pass
    if "parallel_workers" in payload:
        try:
            config["parallel_workers"] = int(payload.get("parallel_workers", config.get("parallel_workers", recommended_engine_defaults()["parallel_workers"])))
        except (TypeError, ValueError):
            pass
    if "auto_import_on_startup" in payload:
        config["auto_import_on_startup"] = bool(payload.get("auto_import_on_startup"))
    if "bookup_study_id" in payload:
        new_study_id = _extract_study_id(str(payload.get("bookup_study_id", "") or ""))
        prev_study_id = _extract_study_id(str(config.get("bookup_study_id", "") or ""))
        if prev_study_id and prev_study_id != new_study_id:
            _append_study_history(config, prev_study_id)
        config["bookup_study_id"] = new_study_id
    if "bookup_study_name" in payload:
        config["bookup_study_name"] = _normalize_unified_study_name(
            payload.get("bookup_study_name", "Bookup"),
            fallback="Bookup",
        )
    if "bookup_auto_study_sync" in payload:
        config["bookup_auto_study_sync"] = bool(payload.get("bookup_auto_study_sync"))
    if "bookup_chapter_strategy" in payload:
        strategy = str(payload.get("bookup_chapter_strategy", "single") or "single").strip().lower()
        if strategy not in {"single", "first_move", "unknown_focus", "deep_focus"}:
            strategy = "single"
        config["bookup_chapter_strategy"] = strategy
    if "bookup_opening_focus" in payload:
        config["bookup_opening_focus"] = _normalize_opening_focus(
            payload.get("bookup_opening_focus", "inferred_style"),
            fallback="inferred_style",
        )
    if "bookup_include_best_engine_replies" in payload:
        config["bookup_include_best_engine_replies"] = _normalize_bool(
            payload.get("bookup_include_best_engine_replies", True),
            fallback=True,
        )
    if "bookup_expected_move_confidence_cp" in payload:
        config["bookup_expected_move_confidence_cp"] = _normalize_int_range(
            payload.get("bookup_expected_move_confidence_cp", 125),
            fallback=125,
            minimum=20,
            maximum=300,
        )
    if "bookup_style_move_confidence_cp" in payload:
        config["bookup_style_move_confidence_cp"] = _normalize_int_range(
            payload.get("bookup_style_move_confidence_cp", 90),
            fallback=90,
            minimum=20,
            maximum=300,
        )
    if "bookup_style_min_weight" in payload:
        config["bookup_style_min_weight"] = _normalize_float_range(
            payload.get("bookup_style_min_weight", 1.2),
            fallback=1.2,
            minimum=0.2,
            maximum=8.0,
        )

    settings = request_engine_settings(payload, config)
    config = apply_engine_settings_to_config(config, settings)
    save_config(config)
    configure_lichess(local_lichess_token(config))
    with ENGINE_LOCK:
        close_live_engine()

    return jsonify(
        {
            "ok": True,
            "defaults": build_defaults_payload(config),
        }
    )


@app.post("/api/auto-import-status")
def auto_import_status() -> tuple:
    payload = request.get_json(force=True)
    config = migrate_engine_defaults(load_config())
    username = resolve_username(payload.get("username"), config)
    if not username:
        return jsonify({"needs_import": False, "message": "No Chess.com username is saved yet."})

    raw_time_classes = str(payload.get("time_classes", config.get("time_classes", "all"))).strip()
    time_classes = [item.strip() for item in raw_time_classes.split(",") if item.strip()]
    normalized_time_classes = normalize_time_classes(time_classes)
    raw_max_games = payload.get("max_games", config.get("max_games", 0))
    try:
        parsed_max_games = int(raw_max_games or 0)
    except (TypeError, ValueError):
        parsed_max_games = 0
    max_games = None if parsed_max_games <= 0 else max(1, min(20000, parsed_max_games))

    snapshot = STORE.load_snapshot(username)
    cached_games = snapshot.get("games") or []
    cached_profile = snapshot.get("profile")
    cached_schema = int(snapshot.get("schema_version", 0) or 0)
    if cached_schema < PROFILE_SCHEMA_VERSION or not isinstance(cached_profile, dict) or not cached_games:
        return jsonify(
            {
                "needs_import": True,
                "reason": "no_current_workspace",
                "new_games": 0,
                "message": "No current local repertoire was found, so Bookup can build one automatically.",
            }
        )

    try:
        archives = fetch_archives(username)
    except Exception as exc:
        return jsonify(
            {
                "needs_import": False,
                "reason": "archive_check_failed",
                "message": f"Auto-import check skipped: {exc}",
            }
        )

    cached_archive_urls = {str(item) for item in snapshot.get("archive_urls", []) if str(item)}
    archives_changed = len(archives) != int(snapshot.get("archives_found", 0) or 0)
    if archives and cached_archive_urls and archives[-1] not in cached_archive_urls:
        archives_changed = True

    latest_games: list[ImportedGame] = []
    if archives:
        try:
            latest_games = fetch_games(username, normalized_time_classes, None, archives=[archives[-1]])
        except Exception:
            latest_games = []

    cached_ids = {game_identity_from_serialized(entry) for entry in cached_games if isinstance(entry, dict)}
    cached_ids.discard("")
    latest_ids = {game_identity_from_imported(game) for game in latest_games}
    new_ids = latest_ids - cached_ids

    needs_import = archives_changed or bool(new_ids)
    if not needs_import:
        return jsonify(
            {
                "needs_import": False,
                "reason": "up_to_date",
                "archives_found": len(archives),
                "checked_games": len(latest_games),
                "new_games": 0,
                "message": f"Bookup checked Chess.com. No new {raw_time_classes or 'public'} games were found.",
            }
        )

    return jsonify(
        {
            "needs_import": True,
            "reason": "new_games_found" if new_ids else "new_archive_found",
            "archives_found": len(archives),
            "checked_games": len(latest_games),
            "new_games": len(new_ids),
            "message": (
                f"Bookup found {len(new_ids)} new game{'' if len(new_ids) == 1 else 's'} in the latest Chess.com archive."
                if new_ids
                else "Bookup found a new Chess.com archive."
            ),
        }
    )


@app.get("/api/progress")
def progress_state() -> tuple:
    config = migrate_engine_defaults(load_config())
    username = resolve_username(request.args.get("username", ""), config)
    if not username:
        return jsonify({"error": "Save a Chess.com username before loading progress."}), 400
    mode = str(request.args.get("mode", "") or "").strip().lower()
    return jsonify(build_progress_payload(DATA_DIR, username, mode=mode))


@app.post("/api/progress/refresh")
def progress_refresh() -> tuple:
    payload = request.get_json(force=True)
    config = migrate_engine_defaults(load_config())
    username = resolve_username(payload.get("username", ""), config)
    if not username:
        return jsonify({"error": "Save a Chess.com username before refreshing progress."}), 400
    mode = str(payload.get("mode", "") or "").strip().lower()
    try:
        return jsonify({"ok": True, "progress": refresh_progress(DATA_DIR, username, mode=mode)})
    except ProgressError as exc:
        return jsonify({"ok": False, "error": str(exc), "kind": exc.kind, "progress": build_progress_payload(DATA_DIR, username, mode=mode)}), 400


@app.post("/api/progress/settings")
def progress_settings() -> tuple:
    payload = request.get_json(force=True)
    config = migrate_engine_defaults(load_config())
    username = resolve_username(payload.get("username", ""), config)
    if not username:
        return jsonify({"error": "Save a Chess.com username before saving progress settings."}), 400
    return jsonify({"ok": True, "progress": save_progress_settings(DATA_DIR, username, payload)})


@app.post("/api/progress/session")
def progress_session() -> tuple:
    payload = request.get_json(force=True)
    config = migrate_engine_defaults(load_config())
    username = resolve_username(payload.get("username", ""), config)
    if not username:
        return jsonify({"error": "Save a Chess.com username before saving a session."}), 400
    try:
        return jsonify({"ok": True, "progress": save_session(DATA_DIR, username, payload)})
    except ProgressError as exc:
        return jsonify({"ok": False, "error": str(exc), "kind": exc.kind}), 400


@app.get("/api/analysis-status")
def analysis_status() -> tuple:
    return jsonify(analysis_status_payload())


@app.post("/api/reset-local-workspace")
def reset_local_workspace() -> tuple:
    payload = request.get_json(force=True)
    username = resolve_username(payload.get("username", ""))
    if not username:
        return jsonify({"error": "Save a Chess.com import username before resetting the local workspace."}), 400
    clear_engine_cache = bool(payload.get("clear_engine_cache", True))

    with ANALYSIS_STATUS_LOCK:
        if bool(ANALYSIS_STATUS.get("active")):
            return jsonify({"error": "Bookup is still analyzing. Wait for the current job to finish before resetting local data."}), 409

    user_cleared = STORE.clear_user_workspace(username)
    shared_cleared = STORE.clear_shared_engine_cache() if clear_engine_cache else {"removed_files": 0, "removed_bytes": 0}
    clear_runtime_caches(include_explorer=True, include_engine_cache=True)
    CPU_SAMPLES.clear()
    with ENGINE_LOCK:
        close_live_engine()
    reset_analysis_status_to_idle("Local cache cleared. Bookup is ready for a clean rebuild.")

    return jsonify(
        {
            "ok": True,
            "username": username,
            "message": "Local cache cleared. Build Repertoire to reclassify everything from scratch.",
            "removed_user_files": int(user_cleared.get("removed_files", 0)),
            "removed_engine_entries": int(shared_cleared.get("removed_files", 0)),
            "removed_engine_bytes": int(shared_cleared.get("removed_bytes", 0)),
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
    config = migrate_engine_defaults(load_config())
    lichess_token = str(payload.get("lichess_token", local_lichess_token(config))).strip()
    engine_path = str(payload.get("engine_path", "")).strip() or default_engine_path()
    if not engine_path:
        return jsonify({"error": "Stockfish path is required."}), 400

    requested_settings = build_engine_settings(payload)
    settings = import_engine_settings(requested_settings, payload)
    force_refresh = bool(payload.get("force_refresh"))
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
                "auto_import_on_startup": bool(payload.get("auto_import_on_startup", config.get("auto_import_on_startup", True))),
            },
            requested_settings,
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
        not force_refresh
        and
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
        not force_refresh
        and
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

    try:
        engine = shared_engine_for(settings)
        reset_analysis_status("profile", username, settings, engine)
        update_analysis_status(
            settings=settings,
            engine=engine,
            phase="loading_games",
            progress=5,
            message="Loading saved games or checking Chess.com archives...",
        )
    except FileNotFoundError:
        finish_analysis_status(ok=False, message="The Stockfish executable could not be opened.")
        return jsonify({"error": "The Stockfish executable could not be opened."}), 400

    archives_found = int(snapshot.get("archives_found", 0) or 0)
    archive_urls = list(snapshot.get("archive_urls", []) or [])
    reused_games = False
    if (
        not force_refresh
        and
        keyed_games_schema >= GAMES_CACHE_SCHEMA_VERSION
        and keyed_games
    ):
        games = deserialize_games(list(keyed_games))
        archives_found = keyed_archives_found
        archive_urls = list(keyed_games_cache.get("archive_urls", []) or archive_urls)
        reused_games = bool(games)
        update_analysis_status(
            settings=settings,
            engine=engine,
            phase="loading_games",
            progress=12,
            message=f"Reusing {len(games)} saved games from the local cache...",
        )
    elif (
        not force_refresh
        and
        cached_schema >= GAMES_CACHE_SCHEMA_VERSION
        and cached_games_request_key == games_cache_key
        and cached_games
    ):
        games = deserialize_games(list(cached_games))
        reused_games = bool(games)
        update_analysis_status(
            settings=settings,
            engine=engine,
            phase="loading_games",
            progress=12,
            message=f"Reusing {len(games)} saved games from the local cache...",
        )
    else:
        try:
            update_analysis_status(
                settings=settings,
                engine=engine,
                phase="fetch_archives",
                progress=8,
                message="Fetching Chess.com archive list...",
            )
            archives = fetch_archives(username)
            update_analysis_status(
                settings=settings,
                engine=engine,
                phase="fetch_games",
                progress=12,
                message=f"Importing {raw_time_classes or 'all'} Chess.com games...",
            )
            games = fetch_games(username, normalized_time_classes, max_games, archives=archives)
            archives_found = len(archives)
            archive_urls = archives
        except Exception as exc:
            finish_analysis_status(ok=False, message=f"Could not import Chess.com games: {exc}")
            return jsonify({"error": f"Could not import Chess.com games: {exc}"}), 502

    if not games:
        finish_analysis_status(ok=False, message="No matching public games were found.")
        return jsonify({"error": "No matching public games were found for that username and time control."}), 404

    try:
        profile_data = analyse_games(
            games,
            engine,
            progress_callback=lambda **patch: update_analysis_status(settings=settings, engine=engine, **patch),
        )
        finish_analysis_status(ok=True, message="Analysis complete.")
    except FileNotFoundError:
        finish_analysis_status(ok=False, message="The Stockfish executable could not be opened.")
        return jsonify({"error": "The Stockfish executable could not be opened."}), 400
    except Exception as exc:
        finish_analysis_status(ok=False, message=f"Engine analysis failed: {exc}")
        return jsonify({"error": f"Engine analysis failed: {exc}"}), 500

    serialized_games = serialize_games(games)
    STORE.save_cached_games(
        username,
        games_cache_key,
        {
            "schema_version": GAMES_CACHE_SCHEMA_VERSION,
            "archives_found": archives_found,
            "archive_urls": archive_urls,
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
            "archive_urls": archive_urls,
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
            "archive_urls": archive_urls,
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


@app.post("/api/import-pgn")
def import_pgn() -> tuple:
    payload = request.get_json(force=True)
    username = str(payload.get("username", "")).strip() or "PGN Player"
    pgn_text = str(payload.get("pgn", "") or "").strip()
    if not pgn_text:
        return jsonify({"error": "Paste one or more PGNs first."}), 400

    fallback_color = str(payload.get("player_color", "white") or "white")
    games = import_games_from_pgn_text(pgn_text, username, fallback_color=fallback_color)
    if not games:
        return jsonify({"error": "No valid PGN games were found."}), 400

    config = migrate_engine_defaults(load_config())
    lichess_token = str(payload.get("lichess_token", local_lichess_token(config))).strip()
    requested_settings = build_engine_settings(payload)
    settings = import_engine_settings(requested_settings, payload)
    engine_path = str(payload.get("engine_path", "")).strip() or default_engine_path()
    if not engine_path:
        return jsonify({"error": "Stockfish path is required."}), 400
    configure_lichess(lichess_token)

    save_config(
        apply_engine_settings_to_config(
            {
                "username": username,
                "time_classes": "pgn",
                "max_games": len(games),
                "lichess_token": lichess_token,
                "engine_path": engine_path,
            },
            requested_settings,
        )
    )

    try:
        engine = shared_engine_for(settings)
        reset_analysis_status("pgn", username, settings, engine)
        profile_data = analyse_games(
            games,
            engine,
            progress_callback=lambda **patch: update_analysis_status(settings=settings, engine=engine, **patch),
        )
        finish_analysis_status(ok=True, message="PGN analysis complete.")
    except FileNotFoundError:
        finish_analysis_status(ok=False, message="The Stockfish executable could not be opened.")
        return jsonify({"error": "The Stockfish executable could not be opened."}), 400
    except Exception as exc:
        finish_analysis_status(ok=False, message=f"PGN analysis failed: {exc}")
        return jsonify({"error": f"PGN analysis failed: {exc}"}), 500

    serialized_games = serialize_games(games)
    pgn_hash = hashlib.sha256(pgn_text.encode("utf-8")).hexdigest()
    request_key = json.dumps(
        {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "source": "pgn",
            "username": username,
            "pgn_hash": pgn_hash,
            "settings": {
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
    STORE.save_snapshot(
        username,
        {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "request_key": request_key,
            "games_request_key": f"pgn:{pgn_hash}",
            "archives_found": 0,
            "games_imported": len(games),
            "games": serialized_games,
            "profile": profile_data,
        },
    )
    progress = STORE.load_progress(username)
    return jsonify(
        profile_response_payload(
            username=username,
            normalized_time_classes=["pgn import"],
            archives_found=0,
            games=serialized_games,
            profile_data=profile_data,
            progress=progress,
            lichess_token=lichess_token,
            cached=False,
            reused_games=False,
        )
    )


@app.post("/api/import-chessnut")
def import_chessnut() -> tuple:
    payload = request.get_json(force=True)
    username = str(payload.get("username", "")).strip() or "Chessnut Player"
    db_path = str(payload.get("db_path") or payload.get("chessnut_db_path") or "").strip()
    player_color = "black" if str(payload.get("player_color") or payload.get("chessnut_player_color") or "white").strip().lower() == "black" else "white"

    try:
        bundle = extract_chessnut_games_as_pgn(db_path, username=username, player_color=player_color)
    except (FileNotFoundError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    games = import_games_from_pgn_text(bundle.pgn_text, username, fallback_color=player_color)
    if not games:
        return jsonify({"error": "No valid OTB PGN games were found in the NewChessnut database."}), 400

    config = migrate_engine_defaults(load_config())
    lichess_token = str(payload.get("lichess_token", local_lichess_token(config))).strip()
    requested_settings = build_engine_settings(payload)
    settings = import_engine_settings(requested_settings, payload)
    engine_path = str(payload.get("engine_path", "")).strip() or default_engine_path()
    if not engine_path:
        return jsonify({"error": "Stockfish path is required."}), 400
    configure_lichess(lichess_token)

    save_config(
        apply_engine_settings_to_config(
            {
                **config,
                "username": username,
                "time_classes": "chessnut",
                "max_games": len(games),
                "lichess_token": lichess_token,
                "engine_path": engine_path,
                "chessnut_db_path": bundle.db_path,
                "chessnut_player_color": player_color,
            },
            requested_settings,
        )
    )

    try:
        engine = shared_engine_for(settings)
        reset_analysis_status("chessnut", username, settings, engine)
        profile_data = analyse_games(
            games,
            engine,
            progress_callback=lambda **patch: update_analysis_status(settings=settings, engine=engine, **patch),
        )
        finish_analysis_status(ok=True, message="NewChessnut OTB import complete.")
    except FileNotFoundError:
        finish_analysis_status(ok=False, message="The Stockfish executable could not be opened.")
        return jsonify({"error": "The Stockfish executable could not be opened."}), 400
    except Exception as exc:
        finish_analysis_status(ok=False, message=f"NewChessnut OTB import failed: {exc}")
        return jsonify({"error": f"NewChessnut OTB import failed: {exc}"}), 500

    serialized_games = serialize_games(games)
    pgn_hash = hashlib.sha256(bundle.pgn_text.encode("utf-8")).hexdigest()
    request_key = json.dumps(
        {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "source": "chessnut",
            "username": username,
            "db_path": bundle.db_path,
            "player_color": player_color,
            "pgn_hash": pgn_hash,
            "settings": {
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
    STORE.save_snapshot(
        username,
        {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "request_key": request_key,
            "games_request_key": f"chessnut:{pgn_hash}",
            "archives_found": 0,
            "games_imported": len(games),
            "games": serialized_games,
            "profile": profile_data,
        },
    )
    progress = STORE.load_progress(username)
    return jsonify(
        profile_response_payload(
            username=username,
            normalized_time_classes=["chessnut otb"],
            archives_found=0,
            games=serialized_games,
            profile_data=profile_data,
            progress=progress,
            lichess_token=lichess_token,
            cached=False,
            reused_games=False,
        )
    )


@app.post("/api/realign-plan")
def realign_plan() -> tuple:
    payload = request.get_json(force=True) or {}
    source_fen = str(payload.get("source_fen") or "").strip() or REALIGN_START_FEN
    target_fen = str(payload.get("target_fen") or "").strip() or REALIGN_START_FEN
    target_label = str(payload.get("target_label") or "").strip()
    try:
        plan = build_realign_plan(source_fen, target_fen, target_label=target_label)
    except ValueError as exc:
        return jsonify({"error": f"Could not build the Chessnut realign plan: {exc}"}), 400
    return jsonify(plan), 200


@app.post("/api/position-insight")
def position_insight() -> tuple:
    payload = request.get_json(force=True)
    fen = str(payload.get("fen", "")).strip()
    if fen == "startpos":
        fen = chess.STARTING_FEN
    if not fen:
        return jsonify({"error": "FEN is required."}), 400
    try:
        board = chess.Board(fen)
    except ValueError:
        return jsonify({"error": "Invalid FEN."}), 400

    config = load_config()
    settings = request_engine_settings(payload, config)
    request_token = str(payload.get("lichess_token") or local_lichess_token(config)).strip()
    configure_lichess(request_token)
    play_uci = [str(item) for item in payload.get("play_uci", []) if str(item)]
    your_move_uci = str(payload.get("your_move_uci", "")).strip()
    your_move_san = str(payload.get("your_move_san", "")).strip()
    your_move_count = int(payload.get("your_move_count", 0) or 0)
    try:
        engine = shared_engine_for(settings)
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


@app.post("/api/database-moves")
def database_moves() -> tuple:
    payload = request.get_json(force=True)
    fen = str(payload.get("fen", "")).strip()
    if fen == "startpos":
        fen = chess.STARTING_FEN
    if not fen:
        return jsonify({"error": "FEN is required."}), 400
    try:
        board = chess.Board(fen)
    except ValueError:
        return jsonify({"error": "Invalid FEN."}), 400

    config = load_config()
    request_token = str(payload.get("lichess_token") or local_lichess_token(config)).strip()
    configure_lichess(request_token)
    play_uci = [str(item) for item in payload.get("play_uci", []) if str(item)]
    return jsonify(database_context_for_board(board, play_uci=play_uci, limit=8))


@app.post("/api/smart-theory/resolve-source")
def resolve_smart_theory_source() -> tuple:
    payload = request.get_json(force=True) or {}
    try:
        return jsonify({"source": _resolve_smart_theory_source(payload)}), 200
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/smart-theory/validate-tree")
def validate_smart_theory_import() -> tuple:
    payload = request.get_json(force=True) or {}
    try:
        tree, warnings = validate_smart_theory_tree(payload)
        return jsonify({"tree": tree, "warnings": warnings}), 200
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/generate-smart-theory")
def generate_smart_theory() -> tuple:
    payload = request.get_json(force=True) or {}
    try:
        source_context = _resolve_smart_theory_source(payload)
        fen = str(source_context["fen"])
        board = chess.Board(fen)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    payload["source_context"] = source_context
    payload["starting_source"] = source_context["type"]
    payload["source_id"] = source_context["id"]
    payload["source_label"] = source_context["label"]
    payload["source_fingerprint"] = source_context["fingerprint"]
    payload["fen"] = source_context["fen"]
    payload["start_play_uci"] = []
    if source_context["type"] != "current_board":
        payload["user_book_line_uci"] = list(source_context["moves_uci"])
        payload["my_color"] = source_context["player_color"]

    config = load_config()
    if "include_best_engine_replies" not in payload:
        payload["include_best_engine_replies"] = _normalize_bool(
            config.get("bookup_include_best_engine_replies", True),
            fallback=True,
        )
    if "expected_move_confidence_cp" not in payload:
        payload["expected_move_confidence_cp"] = _normalize_int_range(
            config.get("bookup_expected_move_confidence_cp", 125),
            fallback=125,
            minimum=20,
            maximum=300,
        )
    if "style_move_confidence_cp" not in payload:
        payload["style_move_confidence_cp"] = _normalize_int_range(
            config.get("bookup_style_move_confidence_cp", 90),
            fallback=90,
            minimum=20,
            maximum=300,
        )
    if "style_preferred_min_weight" not in payload:
        payload["style_preferred_min_weight"] = _normalize_float_range(
            config.get("bookup_style_min_weight", 1.2),
            fallback=1.2,
            minimum=0.2,
            maximum=8.0,
        )
    payload["opening_focus"] = "inferred_style"
    settings = request_engine_settings(payload, config)
    # Smart Theory is tree-based, so we allow multiple workers, but clamp to
    # safe interactive limits so status polling and UI controls stay responsive.
    settings = EngineSettings(
        path=settings.path,
        depth=max(10, min(26, int(settings.depth))),
        threads=max(2, min(16, int(settings.threads))),
        hash_mb=max(512, min(6144, int(settings.hash_mb))),
        multipv=max(2, min(8, int(settings.multipv))),
        think_time_sec=max(0.05, min(8.0, float(settings.think_time_sec))),
        parallel_workers=max(1, min(4, int(settings.parallel_workers))),
    )
    job_id = str(payload.get("job_id") or f"smart-{int(time.time() * 1000)}")
    if not job_id:
        return jsonify({"error": "job_id is required."}), 400

    request_token = str(payload.get("lichess_token") or local_lichess_token(config)).strip()
    with SMART_THEORY_JOBS_LOCK:
        existing = SMART_THEORY_JOBS.get(job_id, {})
        if isinstance(existing, dict) and str(existing.get("status", "")).lower() in {"generating", "analyzing", "stopping"}:
            return jsonify({"error": f"Job {job_id} is already running."}), 409
        now = time.time()
        SMART_THEORY_JOBS[job_id] = {
            "cancelled": False,
            "status": "generating",
            "message": "Queued Smart Theory generation.",
            "positions_done": 0,
            "positions_total": 0,
            "result": None,
            "error": "",
            "created_at": now,
            "updated_at": now,
        }
        _trim_smart_theory_jobs_locked()

    # Start generation asynchronously so the tab can show real-time progress
    # ("Generating" -> "Analyzing" -> "Complete/Error") and respond to Stop.
    worker = threading.Thread(
        target=_run_smart_theory_job,
        kwargs={
            "job_id": job_id,
            "board_fen": board.fen(),
            "payload": dict(payload),
            "settings": settings,
            "lichess_token": request_token,
        },
        daemon=True,
        name=f"bookup-smart-theory-{job_id}",
    )
    worker.start()
    with SMART_THEORY_JOBS_LOCK:
        snapshot = _smart_job_payload(job_id, SMART_THEORY_JOBS[job_id])
    return jsonify(snapshot), 202


@app.get("/api/smart-theory-status/<job_id>")
def smart_theory_status(job_id: str) -> tuple:
    key = str(job_id or "").strip()
    if not key:
        return jsonify({"error": "job_id is required."}), 400
    with SMART_THEORY_JOBS_LOCK:
        job = SMART_THEORY_JOBS.get(key)
        if not isinstance(job, dict):
            return jsonify({"error": "Smart theory job not found."}), 404
        payload = _smart_job_payload(key, job)
    return jsonify(payload), 200


@app.get("/api/smart-theory-result/<job_id>")
def smart_theory_result(job_id: str) -> tuple:
    key = str(job_id or "").strip()
    if not key:
        return jsonify({"error": "job_id is required."}), 400
    with SMART_THEORY_JOBS_LOCK:
        job = SMART_THEORY_JOBS.get(key)
        if not isinstance(job, dict):
            return jsonify({"error": "Smart theory job not found."}), 404
        status = str(job.get("status", "idle") or "idle").lower()
        result = job.get("result")
        payload = _smart_job_payload(key, job)
        error_text = str(job.get("error", "") or "")
    if status == "error":
        return jsonify({**payload, "error": error_text or payload.get("message")}), 500
    # Result polling stays separate from status polling so the UI can update
    # progress frequently without repeatedly transferring the full tree payload.
    if result is None:
        return jsonify(payload), 202
    return jsonify({"job_id": key, **result}), 200


@app.post("/api/stop-smart-theory")
def stop_smart_theory() -> tuple:
    payload = request.get_json(force=True) or {}
    job_id = str(payload.get("job_id") or "").strip()
    if not job_id:
        return jsonify({"error": "job_id is required."}), 400
    with SMART_THEORY_JOBS_LOCK:
        if job_id not in SMART_THEORY_JOBS:
            return jsonify({"ok": True, "job_id": job_id, "status": "missing"}), 200
        SMART_THEORY_JOBS[job_id]["cancelled"] = True
        SMART_THEORY_JOBS[job_id]["status"] = "stopping"
        SMART_THEORY_JOBS[job_id]["message"] = "Stopping generation..."
        SMART_THEORY_JOBS[job_id]["updated_at"] = time.time()
    return jsonify({"ok": True, "job_id": job_id, "status": "stopping"}), 200


@app.post("/api/smart-theory/preview-chapters")
def preview_smart_theory_chapters() -> tuple:
    payload = request.get_json(force=True) or {}
    config = migrate_engine_defaults(load_config())
    chapter_name = str(payload.get("chapter_name", "") or "").strip() or "Bookup Smart Theory"
    chapter_strategy = str(payload.get("chapter_strategy", "single") or "single").strip().lower()
    if chapter_strategy not in {"single", "first_move", "unknown_focus", "deep_focus"}:
        chapter_strategy = "single"
    max_chapters = _normalize_int_range(payload.get("max_chapters", 62), fallback=62, minimum=1, maximum=80)
    min_chapter_moves = _normalize_int_range(payload.get("min_chapter_moves", 40 if chapter_strategy == "deep_focus" else 0), fallback=40 if chapter_strategy == "deep_focus" else 0, minimum=0, maximum=80)
    extend_with_engine_tail = _normalize_bool(payload.get("extend_with_engine_tail", True), fallback=True)
    tail_depth = _normalize_int_range(payload.get("tail_depth", 12), fallback=12, minimum=6, maximum=18)
    tail_time_sec = _normalize_float_range(payload.get("tail_time_sec", 0.05), fallback=0.05, minimum=0.01, maximum=0.5)
    tree_payload = payload.get("tree")
    if not isinstance(tree_payload, dict):
        return jsonify({"error": "Smart theory tree payload is required for chapter preview."}), 400
    try:
        tail_engine = None
        if chapter_strategy == "deep_focus" and extend_with_engine_tail:
            tail_settings = request_engine_settings(payload, config)
            tail_settings = EngineSettings(
                path=tail_settings.path,
                depth=tail_depth,
                threads=max(1, min(4, int(tail_settings.threads))),
                hash_mb=max(256, min(2048, int(tail_settings.hash_mb))),
                multipv=1,
                think_time_sec=tail_time_sec,
                parallel_workers=1,
            )
            tail_engine = shared_engine_for(tail_settings)
        chapters_payload = _smart_tree_chapter_exports(
            tree_payload,
            strategy=chapter_strategy,
            chapter_name_base=chapter_name,
            max_chapters=max_chapters,
            min_chapter_moves=min_chapter_moves,
            tail_engine=tail_engine,
            tail_depth=tail_depth,
            tail_time_sec=tail_time_sec,
        )
        if not chapters_payload:
            return jsonify({"error": "No chapters were generated for preview."}), 400
        chapters_preview: list[dict[str, Any]] = []
        for chapter in chapters_payload[:max_chapters]:
            pgn_text = str(chapter.get("pgn", "") or "")
            meta = chapter.get("meta", {}) if isinstance(chapter.get("meta"), dict) else {}
            move_text = " ".join(
                line.strip()
                for line in pgn_text.splitlines()
                if line.strip() and not line.strip().startswith("[")
            ).strip()
            move_text = re.sub(r"\{[^}]*\}", "", move_text)
            move_text = re.sub(r"\s+", " ", move_text).strip()
            if len(move_text) > 220:
                move_text = f"{move_text[:220].rstrip()}..."
            chapters_preview.append(
                {
                    "name": str(chapter.get("name", chapter_name) or chapter_name).strip(),
                    "moves_exported": int(meta.get("moves_exported", 0) or 0),
                    "warnings_count": len(meta.get("warnings", [])) if isinstance(meta.get("warnings"), list) else 0,
                    "anchor_node_id": str(meta.get("anchor_node_id", "") or ""),
                    "anchor_classification": str(meta.get("anchor_classification", "") or ""),
                    "pgn_excerpt": move_text,
                    "pgn_text": pgn_text,
                }
            )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"Could not build chapter preview: {exc}"}), 500
    return jsonify(
        {
            "ok": True,
            "chapter_name": chapter_name,
            "chapter_strategy": chapter_strategy,
            "max_chapters": max_chapters,
            "min_chapter_moves": min_chapter_moves,
            "extend_with_engine_tail": extend_with_engine_tail,
            "chapters_count": len(chapters_preview),
            "chapters": chapters_preview,
        }
    ), 200


@app.post("/api/smart-theory/export-lichess-study")
def export_smart_theory_to_lichess_study() -> tuple:
    payload = request.get_json(force=True) or {}
    config = migrate_engine_defaults(load_config())
    previous_study_id = _extract_study_id(str(config.get("bookup_study_id", "") or ""))
    study_id = _extract_study_id(str(payload.get("study_id", "") or "")) or _extract_study_id(str(config.get("bookup_study_id", "") or ""))
    token = str(payload.get("lichess_token") or local_lichess_token(config)).strip()
    if not token:
        return jsonify({"error": "A Lichess token with study:write scope is required."}), 400
    auto_create_unified = bool(payload.get("auto_create_unified_study", True))
    configured_unified_name = _normalize_unified_study_name(config.get("bookup_study_name", "Bookup"), fallback="Bookup")
    unified_study_name = _normalize_unified_study_name(
        payload.get("unified_study_name", configured_unified_name),
        fallback=configured_unified_name,
    )
    created_unified_study = False
    if not study_id and auto_create_unified:
        try:
            created = _create_lichess_study(token=token, study_name=unified_study_name, visibility="unlisted")
            study_id = str(created.get("study_id", "") or "")
            created_unified_study = bool(study_id)
            if created_unified_study:
                _list_lichess_study_chapters(study_id=study_id, token=token)
                if previous_study_id and previous_study_id != study_id:
                    _append_study_history(config, previous_study_id)
                config["bookup_study_id"] = study_id
                config["bookup_study_name"] = unified_study_name
                save_config(config)
        except Exception as exc:
            return jsonify({"error": f"Could not auto-create unified Bookup study: {exc}"}), 502
    if not study_id:
        return jsonify({"error": "A Lichess study ID (or study URL) is required."}), 400
    chapter_name = str(payload.get("chapter_name", "") or "").strip() or "Bookup Smart Theory"
    orientation = str(payload.get("orientation", "white") or "white").strip().lower()
    if orientation not in {"white", "black"}:
        orientation = "white"
    chapter_strategy = str(payload.get("chapter_strategy", config.get("bookup_chapter_strategy", "single")) or "single").strip().lower()
    if chapter_strategy not in {"single", "first_move", "unknown_focus", "deep_focus"}:
        chapter_strategy = "single"
    max_chapters = _normalize_int_range(payload.get("max_chapters", 62), fallback=62, minimum=1, maximum=80)
    min_chapter_moves = _normalize_int_range(payload.get("min_chapter_moves", 40 if chapter_strategy == "deep_focus" else 0), fallback=40 if chapter_strategy == "deep_focus" else 0, minimum=0, maximum=80)
    extend_with_engine_tail = _normalize_bool(payload.get("extend_with_engine_tail", True), fallback=True)
    tail_depth = _normalize_int_range(payload.get("tail_depth", 12), fallback=12, minimum=6, maximum=18)
    tail_time_sec = _normalize_float_range(payload.get("tail_time_sec", 0.05), fallback=0.05, minimum=0.01, maximum=0.5)
    replace_existing_chapters = bool(payload.get("replace_existing_chapters", True))
    cleanup_default_placeholders = bool(payload.get("cleanup_default_placeholders", not replace_existing_chapters))

    provided_pgn = str(payload.get("pgn", "") or "").strip()
    tree_payload = payload.get("tree")
    try:
        chapters_payload: list[dict[str, Any]] = []
        if provided_pgn and chapter_strategy == "single":
            chapters_payload = [{"name": chapter_name, "pgn": provided_pgn, "meta": {"moves_exported": None, "warnings": []}}]
        else:
            if not isinstance(tree_payload, dict):
                return jsonify({"error": "Smart theory tree payload is required when PGN is not provided."}), 400
            tail_engine = None
            if chapter_strategy == "deep_focus" and extend_with_engine_tail:
                tail_settings = request_engine_settings(payload, config)
                tail_settings = EngineSettings(
                    path=tail_settings.path,
                    depth=tail_depth,
                    threads=max(1, min(4, int(tail_settings.threads))),
                    hash_mb=max(256, min(2048, int(tail_settings.hash_mb))),
                    multipv=1,
                    think_time_sec=tail_time_sec,
                    parallel_workers=1,
                )
                tail_engine = shared_engine_for(tail_settings)
            chapters_payload = _smart_tree_chapter_exports(
                tree_payload,
                strategy=chapter_strategy,
                chapter_name_base=chapter_name,
                max_chapters=max_chapters,
                min_chapter_moves=min_chapter_moves,
                tail_engine=tail_engine,
                tail_depth=tail_depth,
                tail_time_sec=tail_time_sec,
            )
        if not chapters_payload:
            return jsonify({"error": "No chapters were generated for Lichess study export."}), 400
        created_chapters: list[dict[str, Any]] = []
        cleanup_result = {"deleted_count": 0, "deleted_chapter_ids": [], "errors": []}
        if replace_existing_chapters:
            try:
                cleanup_result = _cleanup_all_study_chapters(study_id=study_id, token=token)
            except Exception as cleanup_exc:
                cleanup_result = {
                    "deleted_count": 0,
                    "deleted_chapter_ids": [],
                    "errors": [str(cleanup_exc)],
                }
        for chapter in chapters_payload[:max_chapters]:
            result = _post_pgn_to_lichess_study(
                study_id=study_id,
                token=token,
                chapter_name=str(chapter.get("name", chapter_name) or chapter_name),
                pgn_text=str(chapter.get("pgn", "") or ""),
                orientation=orientation,
            )
            created_chapters.append(
                {
                    "name": str(chapter.get("name", "")),
                    "meta": chapter.get("meta", {}),
                    "lichess_response": result.get("response", {}),
                }
            )
        if cleanup_default_placeholders and not replace_existing_chapters:
            try:
                cleanup_result = _cleanup_default_placeholder_chapters(study_id=study_id, token=token)
            except Exception as cleanup_exc:
                cleanup_result = {
                    "deleted_count": 0,
                    "deleted_chapter_ids": [],
                    "errors": [str(cleanup_exc)],
                }
        elif replace_existing_chapters:
            try:
                placeholder_cleanup = _cleanup_default_placeholder_chapters(study_id=study_id, token=token)
                cleanup_result["deleted_count"] = int(cleanup_result.get("deleted_count", 0) or 0) + int(placeholder_cleanup.get("deleted_count", 0) or 0)
                cleanup_result["deleted_chapter_ids"] = [
                    *list(cleanup_result.get("deleted_chapter_ids", []) or []),
                    *list(placeholder_cleanup.get("deleted_chapter_ids", []) or []),
                ]
                cleanup_result["errors"] = [
                    *list(cleanup_result.get("errors", []) or []),
                    *list(placeholder_cleanup.get("errors", []) or []),
                ][:10]
            except Exception as cleanup_exc:
                cleanup_result["errors"] = [*list(cleanup_result.get("errors", []) or []), str(cleanup_exc)][:10]
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502
    except Exception as exc:
        return jsonify({"error": f"Could not export Smart Theory to Lichess study: {exc}"}), 500

    return jsonify(
        {
            "ok": True,
            "study_id": study_id,
            "study_url": f"https://lichess.org/study/{study_id}",
            "created_unified_study": created_unified_study,
            "unified_study_name": unified_study_name,
            "previous_study_id": previous_study_id or "",
            "chapter_name": chapter_name,
            "chapter_strategy": chapter_strategy,
            "replace_existing_chapters": replace_existing_chapters,
            "max_chapters": max_chapters,
            "min_chapter_moves": min_chapter_moves,
            "extend_with_engine_tail": extend_with_engine_tail,
            "chapters_created": created_chapters,
            "chapters_created_count": len(created_chapters),
            "cleanup": cleanup_result,
            "orientation": orientation,
            "export_meta": {
                "chapter_strategy": chapter_strategy,
                "replace_existing_chapters": replace_existing_chapters,
                "max_chapters": max_chapters,
                "min_chapter_moves": min_chapter_moves,
                "extend_with_engine_tail": extend_with_engine_tail,
                "chapters_attempted": len(chapters_payload[:max_chapters]),
                "chapters_created": len(created_chapters),
                "warnings": [
                    warning
                    for chapter in created_chapters
                    for warning in (chapter.get("meta", {}) or {}).get("warnings", [])
                ][:100],
                "moves_exported": sum(
                    int((chapter.get("meta", {}) or {}).get("moves_exported", 0) or 0)
                    for chapter in created_chapters
                ),
            },
        }
    ), 200


@app.post("/api/smart-theory/refresh-unified-study")
def refresh_unified_smart_theory_study() -> tuple:
    payload = request.get_json(force=True) or {}
    config = migrate_engine_defaults(load_config())
    previous_study_id = _extract_study_id(str(config.get("bookup_study_id", "") or ""))
    token = str(payload.get("lichess_token") or local_lichess_token(config)).strip()
    if not token:
        return jsonify({"error": "A Lichess token with study:write scope is required."}), 400
    configured_unified_name = _normalize_unified_study_name(config.get("bookup_study_name", "Bookup"), fallback="Bookup")
    unified_name = _normalize_unified_study_name(
        payload.get("unified_study_name", configured_unified_name),
        fallback=configured_unified_name,
    )
    try:
        created = _create_lichess_study(token=token, study_name=unified_name, visibility="unlisted")
        study_id = str(created.get("study_id", "") or "")
        if not study_id:
            return jsonify({"error": "Lichess did not return a study ID."}), 502
        # Verify the new study is reachable before switching local config.
        chapters = _list_lichess_study_chapters(study_id=study_id, token=token)
        cleanup = _cleanup_default_placeholder_chapters(study_id=study_id, token=token)
        if previous_study_id and previous_study_id != study_id:
            _append_study_history(config, previous_study_id)
        config["bookup_study_id"] = study_id
        config["bookup_study_name"] = unified_name
        save_config(config)
        return jsonify(
            {
                "ok": True,
                "study_id": study_id,
                "study_url": f"https://lichess.org/study/{study_id}",
                "unified_study_name": unified_name,
                "previous_study_id": previous_study_id or "",
                "verified_reachable": True,
                "chapter_count": len(chapters),
                "cleanup": cleanup,
            }
        ), 200
    except Exception as exc:
        return jsonify({"error": f"Could not create fresh unified Bookup study: {exc}"}), 502


@app.post("/api/smart-theory/check-lichess-study")
def check_smart_theory_lichess_study() -> tuple:
    payload = request.get_json(force=True) or {}
    config = migrate_engine_defaults(load_config())
    token = str(payload.get("lichess_token") or local_lichess_token(config)).strip()
    if not token:
        return jsonify({"error": "A Lichess token with study:read or study:write scope is required."}), 400

    requested_study_id = _extract_study_id(str(payload.get("study_id", "") or ""))
    saved_study_id = _extract_study_id(str(config.get("bookup_study_id", "") or ""))
    study_id = requested_study_id or saved_study_id
    if not study_id:
        history = _normalize_study_history(config.get("bookup_study_id_history", []))
        return jsonify(
            {
                "error": "Paste a Lichess study ID/URL first, or create a fresh Bookup study.",
                "study_id_history": history,
            }
        ), 400

    previous_study_id = saved_study_id
    unified_name = _normalize_unified_study_name(
        payload.get("unified_study_name", config.get("bookup_study_name", "Bookup")),
        fallback=_normalize_unified_study_name(config.get("bookup_study_name", "Bookup"), fallback="Bookup"),
    )
    try:
        chapters = _list_lichess_study_chapters(study_id=study_id, token=token)
        if previous_study_id and previous_study_id != study_id:
            _append_study_history(config, previous_study_id)
        config["bookup_study_id"] = study_id
        config["bookup_study_name"] = unified_name
        save_config(config)
        return jsonify(
            {
                "ok": True,
                "status": "connected_existing_study",
                "study_id": study_id,
                "study_url": f"https://lichess.org/study/{study_id}",
                "unified_study_name": unified_name,
                "previous_study_id": previous_study_id if previous_study_id != study_id else "",
                "verified_reachable": True,
                "chapter_count": len(chapters),
                "chapters": chapters[:100],
                "study_id_history": _normalize_study_history(config.get("bookup_study_id_history", [])),
            }
        ), 200
    except Exception as exc:
        return jsonify({"error": f"Could not check that Lichess study: {exc}"}), 502


@app.post("/api/legal-moves")
def legal_moves() -> tuple:
    payload = request.get_json(force=True)
    fen = str(payload.get("fen", "")).strip()
    if fen == "startpos":
        fen = chess.STARTING_FEN
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
    if fen == "startpos":
        fen = chess.STARTING_FEN
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
    ply_before_move = board_ply(board)
    san = board.san(move)
    played_classification, book_context = move_book_context(board, move, payload)
    board.push(move)
    return jsonify(
        {
            "ok": True,
            "fen": board.fen(),
            "side_to_move": "white" if board.turn == chess.WHITE else "black",
            "turn": "white" if board.turn == chess.WHITE else "black",
            "move_uci": move_uci,
            "played_san": san,
            "played_classification": played_classification,
            "book_context": book_context,
            "opening": book_context.get("next_opening") or book_context.get("current_opening"),
            "ply_before": ply_before_move,
            "ply_after": board_ply(board),
            "last_move": {"from": move_uci[:2], "to": move_uci[2:4]},
            "legal_moves": serialize_legal_moves(board),
        }
    )


@app.post("/api/trainer-attempt")
def trainer_attempt() -> tuple:
    payload = request.get_json(force=True)
    fen = str(payload.get("fen", "")).strip()
    if fen == "startpos":
        fen = chess.STARTING_FEN
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
    best_san = ""
    best_move: chess.Move | None = None
    if best_uci:
        try:
            candidate = chess.Move.from_uci(best_uci)
            if candidate in board.legal_moves:
                best_move = candidate
                best_san = board.san(candidate)
        except ValueError:
            best_move = None

    line_sans = [attempted_san]
    played_classification, book_context = move_book_context(board, move, payload)
    matches_repertoire = bool(best_uci and move.uci() == best_uci) or bool(book_context.get("in_lesson"))
    board.push(move)
    last_move = {"from": move_uci[:2], "to": move_uci[2:4]}
    continuation_ucis = [str(item) for item in lesson.get("continuation_moves_uci", []) if str(item)]
    if best_uci and move.uci() == best_uci:
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
    line_completed = bool(board.is_game_over() or (best_uci and move.uci() == best_uci and len(line_sans) >= len(continuation_ucis or [best_uci])))
    if matches_repertoire:
        message = f"{attempted_san} matches a known branch." if best_uci and move.uci() != best_uci else f"{attempted_san} keeps this line on track."
    elif best_san:
        message = f"{attempted_san} is legal but leaves this repertoire branch. Recommended move: {best_san}."
    else:
        message = f"{attempted_san} is legal. Bookup will continue from the live position."

    return jsonify(
        {
            "ok": True,
            "played_san": attempted_san,
            "best_san": best_san,
            "preferred_uci": best_uci,
            "preferred_san": best_san,
            "played_classification": played_classification,
            "book_context": book_context,
            "matched_repertoire_branch": matches_repertoire,
            "branch_locked": matches_repertoire,
            "trainer_phase": "completed" if line_completed else ("locked_line" if matches_repertoire else "decision_point"),
            "line_completed": line_completed,
            "message": message,
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
    username = resolve_username(payload.get("username", ""))
    if not username:
        return jsonify({"error": "A username is required to save review progress."}), 400
    lessons = payload.get("lessons", {})
    summary = payload.get("summary", {})
    if not isinstance(lessons, dict):
        return jsonify({"error": "Lesson progress payload must be an object."}), 400
    if not isinstance(summary, dict):
        summary = {}
    progress = normalize_training_progress({"lessons": lessons, "summary": summary})
    STORE.save_progress(username, progress)
    return jsonify({"ok": True, "summary": progress.get("summary", {})})


def run_app() -> None:
    configure_runtime_mode(web_mode=False)
    if webview is None:
        run_browser_app()
        return
    port = 8877
    url = _start_local_server(port)
    webview.create_window(
        "Bookup",
        url,
        width=1500,
        height=980,
        min_size=(1120, 760),
        text_select=True,
    )
    try:
        webview.start()
    except Exception as exc:
        print(f"Bookup desktop webview failed; opening browser fallback instead: {exc}", file=sys.stderr)
        configure_runtime_mode(web_mode=True)
        webbrowser.open(url, new=2)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return


def _start_local_server(port: int) -> str:
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
    return url


def run_browser_app() -> None:
    configure_runtime_mode(web_mode=True)
    url = _start_local_server(8877)
    webbrowser.open(url, new=2)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        return
