from __future__ import annotations

import argparse
import csv
import json
import multiprocessing as mp
import os
import sys
import threading
import time
import webbrowser
from collections import Counter, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

import chess
import chess.svg

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from bookup.analysis import _build_branch_line, _candidate_lines_for_board
from bookup.classifications import classify_move_record
from bookup.engine import EngineSession, EngineSettings, default_engine_path


DEFAULT_DATASET = REPO_ROOT / "brilliants_no_stalemates.csv"
DEFAULT_DASHBOARD_PORT = 8765
BOARD_SIZE = 260

_WORKER_ENGINE: EngineSession | None = None
_WORKER_MULTIPV = 10
_WORKER_TIME_SEC = 5.0


def _score_band(score: float) -> str:
    if score >= 45:
        return "45+"
    if score >= 40:
        return "40-45"
    if score >= 35:
        return "35-40"
    if score >= 30:
        return "30-35"
    if score >= 25:
        return "25-30"
    return "<25"


def _piece_count_bucket(raw: str) -> str:
    pieces = [token for token in str(raw or "").split() if token]
    count = len(pieces)
    return str(count if count < 5 else "5+")


def _counter_dict(counter: Counter[str]) -> dict[str, int]:
    return {str(key): int(value) for key, value in counter.items()}


def _nested_counter_dict(nested: dict[str, Counter[str]]) -> dict[str, dict[str, int]]:
    return {str(key): _counter_dict(counter) for key, counter in nested.items()}


def _format_eta(seconds: float | None) -> str:
    if seconds is None or seconds < 0 or seconds == float("inf"):
        return "unknown"
    seconds = int(round(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m {secs}s"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


def _format_percent(numerator: int, denominator: int | None) -> str:
    if denominator is None or denominator <= 0:
        return "--"
    return f"{(numerator / denominator) * 100.0:5.1f}%"


def _count_target_rows(
    dataset_path: Path,
    *,
    offset: int,
    stride: int,
    limit: int,
) -> int:
    count = 0
    with dataset_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row_index, _row in enumerate(reader):
            if row_index < offset:
                continue
            if (row_index - offset) % stride != 0:
                continue
            count += 1
            if limit > 0 and count >= limit:
                break
    return count


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run Bookup's current engine-only Brilliant classifier against a "
            "Lichess brilliant-move CSV and collect regression stats."
        )
    )
    parser.add_argument(
        "--csv",
        default=str(DEFAULT_DATASET),
        help="Path to the brilliant CSV dataset. Defaults to brilliants_no_stalemates.csv.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=100,
        help="Rows to classify after offset/stride filtering. Use 0 for the full dataset.",
    )
    parser.add_argument(
        "--offset",
        type=int,
        default=0,
        help="Skip this many CSV rows before sampling.",
    )
    parser.add_argument(
        "--stride",
        type=int,
        default=1,
        help="Take every Nth row after the offset. Use >1 to spread the sample.",
    )
    parser.add_argument(
        "--time",
        type=float,
        default=5.0,
        help="Seconds of engine time per position.",
    )
    parser.add_argument(
        "--depth",
        type=int,
        default=26,
        help="Engine depth cap.",
    )
    parser.add_argument(
        "--multipv",
        type=int,
        default=10,
        help="MultiPV count for candidate line generation.",
    )
    parser.add_argument(
        "--engine",
        default=default_engine_path(),
        help="Path to Stockfish.",
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=1,
        help="Threads per engine worker.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=min(8, max(1, (os.cpu_count() or 4) // 2)),
        help="Number of parallel engine workers.",
    )
    parser.add_argument(
        "--hash-mb",
        type=int,
        default=512,
        help="Total hash budget across all workers.",
    )
    parser.add_argument(
        "--status-every",
        type=int,
        default=25,
        help="Print progress every N classified rows.",
    )
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=100,
        help="Write the state file every N classified rows. Ignored if no state file is provided.",
    )
    parser.add_argument(
        "--show-misses",
        type=int,
        default=15,
        help="How many missed examples to print at the end.",
    )
    parser.add_argument(
        "--sample-miss-cap",
        type=int,
        default=100,
        help="How many miss examples to keep in memory for the final summary/state file.",
    )
    parser.add_argument(
        "--state-file",
        default="",
        help="Optional JSON checkpoint path for resumable full-set runs.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from an existing state file.",
    )
    parser.add_argument(
        "--results-csv",
        default="",
        help="Optional CSV path to append one row per classified position.",
    )
    parser.add_argument(
        "--misses-csv",
        default="",
        help="Optional CSV path to append only non-Brilliant rows.",
    )
    parser.add_argument(
        "--json-out",
        default="",
        help="Optional path to write the final regression summary as JSON.",
    )
    parser.add_argument(
        "--dashboard-port",
        type=int,
        default=DEFAULT_DASHBOARD_PORT,
        help="Local dashboard port. Use 0 to disable the dashboard.",
    )
    parser.add_argument(
        "--open-dashboard",
        action="store_true",
        help="Open the live dashboard in your browser when the run starts.",
    )
    return parser.parse_args()


def _state_config(args: argparse.Namespace, dataset_path: Path) -> dict[str, Any]:
    return {
        "dataset": str(dataset_path),
        "offset": int(args.offset),
        "stride": int(args.stride),
        "limit": int(args.limit),
        "time": float(args.time),
        "depth": int(args.depth),
        "multipv": int(args.multipv),
        "threads": int(args.threads),
        "workers": int(args.workers),
        "hash_mb": int(args.hash_mb),
    }


def _initial_state(args: argparse.Namespace, dataset_path: Path) -> dict[str, Any]:
    return {
        "config": _state_config(args, dataset_path),
        "processed_rows": 0,
        "last_enqueued_row_index": -1,
        "hit_count": 0,
        "label_counts": {},
        "by_score_band": {},
        "by_piece_count": {},
        "parse_errors": 0,
        "unknown_count": 0,
        "miss_examples": [],
        "elapsed_seconds": 0.0,
        "pending_tasks": [],
        "worker_slots": [],
        "saved_at": "",
    }


def _load_state(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _restore_counter(data: dict[str, int] | None) -> Counter[str]:
    return Counter({str(key): int(value) for key, value in (data or {}).items()})


def _restore_nested_counter(data: dict[str, dict[str, int]] | None) -> dict[str, Counter[str]]:
    return {str(key): _restore_counter(counter) for key, counter in (data or {}).items()}


def _validate_state(args: argparse.Namespace, dataset_path: Path, state: dict[str, Any]) -> None:
    expected = _state_config(args, dataset_path)
    current = state.get("config") or {}
    for key in ("dataset", "offset", "stride", "limit", "time", "depth", "multipv", "threads", "workers", "hash_mb"):
        if current.get(key) != expected.get(key):
            raise ValueError(
                f"State file config mismatch for '{key}'. "
                f"Expected {expected.get(key)!r}, found {current.get(key)!r}."
            )


def _blank_worker_slot(worker_id: int) -> dict[str, Any]:
    return {
        "worker_id": worker_id,
        "status": "idle",
        "title": "Waiting for the next position",
        "subtitle": "Ready for a new regression task.",
        "san": "",
        "site": "",
        "score": "",
        "row_index": None,
        "svg": "",
        "label": "",
        "reason": "",
        "started_at": None,
        "completed_at": None,
        "pid": None,
        "task": None,
    }


def _coerce_worker_slots(raw_slots: list[dict[str, Any]] | None, workers: int) -> list[dict[str, Any]]:
    slots = [_blank_worker_slot(worker_id + 1) for worker_id in range(workers)]
    for item in raw_slots or []:
        try:
            worker_id = int(item.get("worker_id") or 0)
        except Exception:
            worker_id = 0
        if 1 <= worker_id <= workers:
            merged = _blank_worker_slot(worker_id)
            merged.update(item)
            slots[worker_id - 1] = merged
    return slots


def _save_state(
    path: Path,
    args: argparse.Namespace,
    dataset_path: Path,
    *,
    processed_rows: int,
    last_enqueued_row_index: int,
    hit_count: int,
    label_counts: Counter[str],
    band_counts: dict[str, Counter[str]],
    piece_bucket_counts: dict[str, Counter[str]],
    parse_errors: int,
    unknown_count: int,
    miss_examples: list[dict[str, Any]],
    elapsed_seconds: float,
    pending_tasks: list[dict[str, Any]],
    worker_slots: list[dict[str, Any]],
) -> None:
    snapshot = {
        "config": _state_config(args, dataset_path),
        "processed_rows": int(processed_rows),
        "last_enqueued_row_index": int(last_enqueued_row_index),
        "hit_count": int(hit_count),
        "label_counts": _counter_dict(label_counts),
        "by_score_band": _nested_counter_dict(band_counts),
        "by_piece_count": _nested_counter_dict(piece_bucket_counts),
        "parse_errors": int(parse_errors),
        "unknown_count": int(unknown_count),
        "miss_examples": miss_examples[: max(0, args.sample_miss_cap)],
        "elapsed_seconds": float(elapsed_seconds),
        "pending_tasks": pending_tasks,
        "worker_slots": worker_slots,
        "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")


def _ensure_csv_writer(
    path_value: str,
    fieldnames: list[str],
    *,
    append: bool,
) -> tuple[Any, csv.DictWriter] | tuple[None, None]:
    if not path_value:
        return None, None
    path = Path(path_value)
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if append else "w"
    exists = append and path.exists() and path.stat().st_size > 0
    handle = path.open(mode, newline="", encoding="utf-8")
    writer = csv.DictWriter(handle, fieldnames=fieldnames)
    if not exists:
        writer.writeheader()
    return handle, writer


def _render_board_svg(board: chess.Board, move: chess.Move | None = None) -> str:
    arrows = []
    if move is not None:
        arrows = [chess.svg.Arrow(move.from_square, move.to_square, color="#5ea6ff")]
    return chess.svg.board(
        board=board,
        size=BOARD_SIZE,
        coordinates=True,
        arrows=arrows,
        colors={
            "square light": "#f1d9a8",
            "square dark": "#c08f64",
            "margin": "#0a1016",
            "coord": "#6f85b8",
            "inner border": "#101820",
            "outer border": "#101820",
            "arrow green": "#5ea6ff",
            "arrow blue": "#5ea6ff",
        },
    )


def _classify_brilliant_candidate(
    board: chess.Board,
    move: chess.Move,
    engine: EngineSession,
    *,
    multipv: int,
    time_sec: float,
) -> dict[str, Any]:
    candidate_lines, _database, _cache_hit = _candidate_lines_for_board(
        board,
        engine,
        play_uci=[],
        limit=max(10, multipv),
        time_sec=time_sec,
        include_database=False,
    )
    if not candidate_lines:
        return {
            "key": "unknown",
            "loss": None,
            "rank": None,
            "reason": "no candidate lines",
            "best_move": "",
        }

    best_line = candidate_lines[0]
    played_line = next((line for line in candidate_lines if str(line.get("uci") or "") == move.uci()), None)
    if played_line is None:
        played_line = _build_branch_line(
            board,
            move.uci(),
            board.san(move),
            engine,
            source="brilliant-regression",
            time_sec=time_sec,
            popularity=0.0,
            repeated_count=0,
        )
    if played_line is None:
        return {
            "key": "unknown",
            "loss": None,
            "rank": None,
            "reason": "could not build branch line",
            "best_move": str(best_line.get("move") or ""),
        }

    second_record = candidate_lines[1] if len(candidate_lines) > 1 else None
    second_loss = float(second_record.get("expected_points_loss", 0.0) or 0.0) if second_record else 0.0
    classification = classify_move_record(
        board,
        played_line,
        best_line,
        second_record=second_record,
        second_loss=second_loss,
        is_player_move=True,
        opening_phase=False,
        in_book=False,
        move_rank=int(played_line.get("rank", 0) or 0) or None,
        player_rating=None,
    )
    return {
        "key": str(classification.get("key") or ""),
        "loss": float(classification.get("expected_points_loss", 0.0) or 0.0),
        "rank": int(played_line.get("rank", 0) or 0) or None,
        "reason": str(classification.get("reason") or ""),
        "best_move": str(best_line.get("move") or ""),
    }


def _iter_filtered_rows(
    dataset_path: Path,
    *,
    offset: int,
    stride: int,
    limit: int,
    start_after_row_index: int,
) -> Iterator[dict[str, Any]]:
    selected = 0
    with dataset_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row_index, row in enumerate(reader):
            if row_index < offset:
                continue
            if (row_index - offset) % stride != 0:
                continue
            selected += 1
            if limit > 0 and selected > limit:
                break
            if row_index <= start_after_row_index:
                continue
            yield {
                "row_index": row_index,
                "fen": str(row.get("fen") or ""),
                "san": str(row.get("san") or ""),
                "site": str(row.get("site") or ""),
                "pieces": str(row.get("pieces") or ""),
                "score": float(row.get("score") or 0.0),
            }


def _print_progress(
    processed_rows: int,
    target_rows: int,
    hits: int,
    start_time: float,
    *,
    current_row_index: int,
    parse_errors: int,
    unknown_count: int,
    label_counts: Counter[str],
    current_move: str,
    current_site: str,
    active_workers: int,
    configured_workers: int,
) -> None:
    elapsed = max(0.001, time.monotonic() - start_time)
    rows_per_sec = processed_rows / elapsed
    hit_rate = (hits / processed_rows * 100.0) if processed_rows else 0.0
    remaining = max(0, target_rows - processed_rows)
    eta = None if rows_per_sec <= 0 else remaining / rows_per_sec
    brilliant_count = int(label_counts.get("brilliant", 0))
    goodish_count = int(
        label_counts.get("best", 0)
        + label_counts.get("excellent", 0)
        + label_counts.get("good", 0)
    )
    print(
        f"[progress] checked {processed_rows}/{target_rows} "
        f"({_format_percent(processed_rows, target_rows)}) | "
        f"left {remaining} | csv row {current_row_index} | "
        f"rate {rows_per_sec:.2f}/s | eta {_format_eta(eta)} | "
        f"elapsed {_format_eta(elapsed)} | brilliant {brilliant_count} "
        f"({hit_rate:.1f}%) | solid {goodish_count} | "
        f"parse {parse_errors} | unknown {unknown_count} | "
        f"workers {active_workers}/{configured_workers}",
        file=sys.stderr,
    )
    if current_move or current_site:
        print(
            f"           latest: {current_move or 'unknown move'}"
            + (f" | {current_site}" if current_site else ""),
            file=sys.stderr,
        )


def _dashboard_html() -> str:
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bookup Brilliant Regression</title>
  <style>
    :root {
      --bg: #111826;
      --panel: #182232;
      --panel-2: #0d141d;
      --line: rgba(126, 148, 194, 0.18);
      --text: #eef2fb;
      --muted: #9caed1;
      --accent: #5ea6ff;
      --mint: #35efaf;
      --warn: #f6cd63;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Inter, system-ui, sans-serif;
      background:
        radial-gradient(circle at top right, rgba(94,166,255,0.12), transparent 32%),
        linear-gradient(180deg, #0c121b, var(--bg));
      color: var(--text);
      min-height: 100vh;
    }
    .page {
      width: min(2140px, calc(100vw - 24px));
      margin: 0 auto;
      padding: 24px 12px 40px;
    }
    .hero {
      border: 1px solid var(--line);
      border-radius: 28px;
      padding: 22px;
      background: linear-gradient(180deg, rgba(33,48,71,0.82), rgba(17,24,38,0.96));
      box-shadow: 0 24px 80px rgba(0,0,0,0.28);
    }
    .hero-top {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .kicker {
      font-size: 13px;
      letter-spacing: 0.34em;
      text-transform: uppercase;
      color: #84a8ff;
      margin-bottom: 10px;
    }
    h1 {
      font-size: clamp(28px, 4vw, 48px);
      line-height: 1.02;
      margin: 0 0 8px;
    }
    .summary {
      color: var(--muted);
      max-width: 780px;
      margin: 0;
      font-size: 18px;
      line-height: 1.65;
    }
    .status-line {
      color: #bcd2ff;
      text-align: right;
      min-width: 320px;
      font-size: 15px;
      line-height: 1.6;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 16px;
      margin-top: 22px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 16px 18px;
      background: linear-gradient(180deg, rgba(73,108,117,0.18), rgba(41,54,82,0.7));
      min-height: 138px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow: hidden;
    }
    .metric .label {
      text-transform: uppercase;
      letter-spacing: 0.26em;
      font-size: 12px;
      color: #9db0d9;
    }
    .metric .value {
      font-size: clamp(20px, 1.8vw, 34px);
      line-height: 1.15;
      font-weight: 700;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .metric .sub {
      color: var(--muted);
      font-size: 14px;
    }
    .wall {
      display: grid;
      grid-template-columns: repeat(4, minmax(320px, 1fr));
      gap: 18px;
      margin-top: 22px;
    }
    .slot {
      border: 1px solid var(--line);
      border-radius: 24px;
      padding: 16px;
      background: linear-gradient(180deg, rgba(9,15,23,0.98), rgba(7,12,18,0.96));
      min-height: 548px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow: hidden;
    }
    .slot-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
    }
    .slot-status {
      color: var(--mint);
      text-transform: uppercase;
      letter-spacing: 0.24em;
      font-size: 12px;
    }
    .slot-title {
      font-size: 18px;
      font-weight: 700;
      margin: 0;
    }
    .slot-subtitle {
      color: var(--muted);
      font-size: 14px;
      margin: 0;
      min-height: 40px;
    }
    .board {
      margin-top: auto;
      border-radius: 18px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.06);
      background: #0a1016;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 352px;
    }
    .board svg {
      width: 100%;
      height: auto;
      display: block;
    }
    .placeholder {
      text-align: center;
      color: #91a2c6;
      font-size: 18px;
      line-height: 1.5;
      padding: 24px;
    }
    .slot-footer {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      color: #9fb0d1;
      font-size: 13px;
    }
    .badge {
      padding: 7px 11px;
      border-radius: 999px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
    }
    .badge.brilliant { color: #4ce3d6; }
    .badge.best { color: #b5e562; }
    .badge.excellent { color: #9bd27d; }
    .badge.good { color: #d6c178; }
    .badge.inaccuracy, .badge.miss { color: #f6cd63; }
    .badge.mistake { color: #ffb066; }
    .badge.blunder { color: #ff7b7b; }
    .footer-note {
      margin-top: 20px;
      color: var(--muted);
      font-size: 14px;
    }
    @media (max-width: 1650px) {
      .wall { grid-template-columns: repeat(3, minmax(300px, 1fr)); }
    }
    @media (max-width: 1280px) {
      .metrics { grid-template-columns: repeat(3, minmax(220px, 1fr)); }
      .wall { grid-template-columns: repeat(2, minmax(300px, 1fr)); }
    }
    @media (max-width: 760px) {
      .page { padding: 16px; }
      .metrics { grid-template-columns: repeat(2, minmax(160px, 1fr)); }
      .wall { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="hero-top">
        <div>
          <div class="kicker">Bookup Regression</div>
          <h1 id="headline">Booting brilliant regression...</h1>
          <p class="summary" id="summary">Preparing the dataset, engine workers, and live regression wall.</p>
        </div>
        <div class="status-line" id="statusLine"></div>
      </div>
      <div class="metrics" id="metrics"></div>
      <div class="wall" id="wall"></div>
      <div class="footer-note" id="footerNote"></div>
    </section>
  </div>
  <script>
    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
    function badgeClass(label) {
      const key = String(label || "").toLowerCase();
      return key || "idle";
    }
    function renderMetric(metric) {
      return `
        <article class="metric">
          <div class="label">${escapeHtml(metric.label)}</div>
          <div class="value">${escapeHtml(metric.value)}</div>
          <div class="sub">${escapeHtml(metric.sub || "")}</div>
        </article>
      `;
    }
    function renderSlot(slot) {
      const badge = slot.label ? `<span class="badge ${badgeClass(slot.label)}">${escapeHtml(slot.label)}</span>` : "";
      const board = slot.svg
        ? `<div class="board">${slot.svg}</div>`
        : `<div class="board"><div class="placeholder">${escapeHtml(slot.placeholder || "Waiting for the next worker position...")}</div></div>`;
      return `
        <article class="slot">
          <div class="slot-head">
            <div class="slot-status">${escapeHtml(slot.statusLabel || slot.status || "Idle")} · Worker ${escapeHtml(slot.worker_id)}</div>
            ${badge}
          </div>
          <h3 class="slot-title">${escapeHtml(slot.title || "Waiting for the next worker position")}</h3>
          <p class="slot-subtitle">${escapeHtml(slot.subtitle || "Idle")}</p>
          ${board}
          <div class="slot-footer">
            <span>${escapeHtml(slot.reason || slot.site || "")}</span>
            <span>${escapeHtml(slot.elapsed || "")}</span>
          </div>
        </article>
      `;
    }
    async function refresh() {
      try {
        const response = await fetch("./state", { cache: "no-store" });
        const state = await response.json();
        document.getElementById("headline").textContent = state.headline;
        document.getElementById("summary").textContent = state.summary;
        document.getElementById("statusLine").innerHTML = state.status_lines.map(line => `<div>${escapeHtml(line)}</div>`).join("");
        document.getElementById("metrics").innerHTML = state.metrics.map(renderMetric).join("");
        document.getElementById("wall").innerHTML = state.worker_slots.map(renderSlot).join("");
        document.getElementById("footerNote").textContent = state.footer_note;
      } catch (error) {
        document.getElementById("headline").textContent = "Live dashboard lost connection";
        document.getElementById("summary").textContent = String(error);
      }
    }
    refresh();
    setInterval(refresh, 500);
  </script>
</body>
</html>
"""


class _DashboardState:
    def __init__(self, initial: dict[str, Any]) -> None:
        self._lock = threading.Lock()
        self._state = initial

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._state))

    def update(self, updater) -> None:
        with self._lock:
            updater(self._state)


def _dashboard_snapshot(
    *,
    args: argparse.Namespace,
    dataset_path: Path,
    target_rows: int,
    processed_rows: int,
    hit_count: int,
    label_counts: Counter[str],
    parse_errors: int,
    unknown_count: int,
    worker_slots: list[dict[str, Any]],
    start_time: float,
    last_enqueued_row_index: int,
) -> dict[str, Any]:
    elapsed = max(0.001, time.monotonic() - start_time)
    rows_per_sec = processed_rows / elapsed if processed_rows else 0.0
    remaining = max(0, target_rows - processed_rows)
    eta = (remaining / rows_per_sec) if rows_per_sec > 0 else None
    active_workers = sum(
        1 for slot in worker_slots if slot.get("status") in {"queued", "analyzing"}
    )
    ready_workers = sum(1 for slot in worker_slots if slot.get("status") == "ready")
    brightest = int(label_counts.get("brilliant", 0))
    status_lines = [
        f"Dataset: {dataset_path.name}",
        f"CSV row cursor: {last_enqueued_row_index} · Positions left: {remaining}",
        f"Configured workers: {args.workers} · Threads/worker: {args.threads} · Hash/worker: {max(16, args.hash_mb // max(1, args.workers))} MB",
    ]
    return {
        "headline": f"{processed_rows}/{target_rows} positions checked",
        "summary": "Bookup is running a live Brilliant regression pass across the Lichess dataset with fixed worker lanes and engine-backed classifications.",
        "status_lines": status_lines,
        "metrics": [
            {"label": "phase", "value": "Classifying", "sub": f"{active_workers} busy · {ready_workers} ready"},
            {"label": "positions checked", "value": str(processed_rows), "sub": f"{remaining} left"},
            {"label": "complete", "value": _format_percent(processed_rows, target_rows), "sub": "Progress through sampled rows"},
            {"label": "positions / sec", "value": f"{rows_per_sec:.2f}/s" if rows_per_sec else "--", "sub": "Average throughput"},
            {"label": "eta", "value": _format_eta(eta), "sub": "Based on processed positions"},
            {"label": "workers", "value": f"{active_workers}/{args.workers}", "sub": "Active / configured"},
            {"label": "positions left", "value": str(remaining), "sub": f"CSV cursor {max(last_enqueued_row_index, 0)}"},
            {"label": "brilliants", "value": str(brightest), "sub": f"{(hit_count / processed_rows * 100.0):.1f}% hit rate" if processed_rows else "0.0% hit rate"},
            {"label": "parse errors", "value": str(parse_errors), "sub": f"unknown labels: {unknown_count}"},
            {"label": "elapsed", "value": _format_eta(elapsed), "sub": "Total runtime"},
        ],
        "worker_slots": worker_slots,
        "footer_note": "Each worker card reflects the current engine position assigned to that exact regression worker.",
    }


def _start_dashboard_server(port: int, state: _DashboardState) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path in ("/", "/index.html"):
                html = _dashboard_html().encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(html)))
                self.end_headers()
                self.wfile.write(html)
                return
            if self.path.startswith("/state"):
                payload = json.dumps(state.snapshot()).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            self.send_response(404)
            self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
            return

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def _worker_process(
    worker_id: int,
    task_queue: mp.Queue,
    result_queue: mp.Queue,
    settings_payload: dict[str, Any],
    multipv: int,
    time_sec: float,
) -> None:
    settings = EngineSettings(**settings_payload)
    try:
        with EngineSession(settings) as engine:
            result_queue.put({"type": "ready", "worker_id": worker_id, "pid": os.getpid()})
            while True:
                task = task_queue.get()
                if task is None:
                    break
                started_at = time.monotonic()
                try:
                    board = chess.Board(str(task.get("fen") or ""))
                    move = board.parse_san(str(task.get("san") or ""))
                    svg = _render_board_svg(board, move)
                    result_queue.put(
                        {
                            "type": "started",
                            "worker_id": worker_id,
                            "pid": os.getpid(),
                            "task": task,
                            "svg": svg,
                            "started_at": started_at,
                        }
                    )
                    classification = _classify_brilliant_candidate(
                        board,
                        move,
                        engine,
                        multipv=multipv,
                        time_sec=time_sec,
                    )
                    result_queue.put(
                        {
                            "type": "done",
                            "worker_id": worker_id,
                            "pid": os.getpid(),
                            "task": task,
                            "svg": svg,
                            "started_at": started_at,
                            "finished_at": time.monotonic(),
                            "classification": classification,
                        }
                    )
                except Exception as exc:  # noqa: BLE001
                    result_queue.put(
                        {
                            "type": "done",
                            "worker_id": worker_id,
                            "pid": os.getpid(),
                            "task": task,
                            "svg": "",
                            "started_at": started_at,
                            "finished_at": time.monotonic(),
                            "classification": {
                                "key": "unknown",
                                "loss": None,
                                "rank": None,
                                "reason": f"error: {exc}",
                                "best_move": "",
                            },
                        }
                    )
    except Exception as exc:  # noqa: BLE001
        result_queue.put({"type": "crash", "worker_id": worker_id, "error": str(exc), "pid": os.getpid()})
    finally:
        result_queue.put({"type": "exit", "worker_id": worker_id, "pid": os.getpid()})


def _make_output_row(
    *,
    task: dict[str, Any],
    classification: dict[str, Any],
    worker_id: int,
) -> dict[str, Any]:
    score = float(task.get("score") or 0.0)
    label = str(classification.get("key") or "unknown")
    return {
        "row_index": int(task["row_index"]),
        "fen": task.get("fen"),
        "san": task.get("san"),
        "site": task.get("site"),
        "pieces": task.get("pieces"),
        "score": score,
        "piece_bucket": _piece_count_bucket(str(task.get("pieces") or "")),
        "score_band": _score_band(score),
        "label": label,
        "reason": classification.get("reason"),
        "rank": classification.get("rank"),
        "best_move": classification.get("best_move"),
        "loss": classification.get("loss"),
        "hit": int(label == "brilliant"),
        "worker_id": worker_id,
    }


def _next_task(
    pending_tasks: list[dict[str, Any]],
    dataset_iter: Iterator[dict[str, Any]],
) -> dict[str, Any] | None:
    if pending_tasks:
        return pending_tasks.pop(0)
    return next(dataset_iter, None)


def _worker_slot_from_start(
    worker_id: int,
    message: dict[str, Any],
) -> dict[str, Any]:
    task = dict(message.get("task") or {})
    site = str(task.get("site") or "")
    subtitle = site.rsplit("/", 1)[-1] if site else "Classifying the next candidate..."
    return {
        "worker_id": worker_id,
        "status": "analyzing",
        "statusLabel": "Classifying",
        "title": str(task.get("san") or "Unknown move"),
        "subtitle": subtitle,
        "san": str(task.get("san") or ""),
        "site": site,
        "score": f"{float(task.get('score') or 0.0):.2f}",
        "row_index": int(task.get("row_index") or -1),
        "svg": str(message.get("svg") or ""),
        "label": "",
        "reason": "",
        "started_at": float(message.get("started_at") or time.monotonic()),
        "completed_at": None,
        "pid": message.get("pid"),
        "elapsed": "Working...",
        "task": task,
    }


def _worker_slot_from_queue(
    worker_id: int,
    task: dict[str, Any],
    pid: Any = None,
) -> dict[str, Any]:
    site = str(task.get("site") or "")
    subtitle = site.rsplit("/", 1)[-1] if site else "Queued for engine classification..."
    return {
        "worker_id": worker_id,
        "status": "queued",
        "statusLabel": "Queued",
        "title": str(task.get("san") or "Queued move"),
        "subtitle": subtitle,
        "san": str(task.get("san") or ""),
        "site": site,
        "score": f"{float(task.get('score') or 0.0):.2f}",
        "row_index": int(task.get("row_index") or -1),
        "svg": "",
        "label": "",
        "reason": "Loading next position",
        "started_at": time.monotonic(),
        "completed_at": None,
        "pid": pid,
        "elapsed": "Queued...",
        "task": task,
        "placeholder": "Worker is loading the next regression position...",
    }


def _worker_slot_from_done(
    worker_id: int,
    message: dict[str, Any],
) -> dict[str, Any]:
    task = dict(message.get("task") or {})
    classification = dict(message.get("classification") or {})
    label = str(classification.get("key") or "unknown")
    elapsed = max(0.0, float(message.get("finished_at") or 0.0) - float(message.get("started_at") or 0.0))
    site = str(task.get("site") or "")
    subtitle = site.rsplit("/", 1)[-1] if site else "Finished"
    return {
        "worker_id": worker_id,
        "status": "done",
        "statusLabel": "Done",
        "title": str(task.get("san") or "Unknown move"),
        "subtitle": subtitle,
        "san": str(task.get("san") or ""),
        "site": site,
        "score": f"{float(task.get('score') or 0.0):.2f}",
        "row_index": int(task.get("row_index") or -1),
        "svg": str(message.get("svg") or ""),
        "label": label,
        "reason": str(classification.get("reason") or ""),
        "started_at": float(message.get("started_at") or 0.0),
        "completed_at": float(message.get("finished_at") or 0.0),
        "pid": message.get("pid"),
        "elapsed": _format_eta(elapsed),
        "task": task,
    }


def main() -> int:
    args = _parse_args()
    dataset_path = Path(args.csv)
    if not dataset_path.exists():
        raise FileNotFoundError(f"Dataset not found: {dataset_path}")
    if args.limit < 0:
        raise ValueError("--limit must be >= 0")
    if args.stride <= 0:
        raise ValueError("--stride must be positive")
    if args.status_every <= 0:
        raise ValueError("--status-every must be positive")
    if args.checkpoint_every <= 0:
        raise ValueError("--checkpoint-every must be positive")
    if args.sample_miss_cap < 0:
        raise ValueError("--sample-miss-cap must be >= 0")
    if args.workers <= 0:
        raise ValueError("--workers must be positive")
    if args.dashboard_port < 0:
        raise ValueError("--dashboard-port must be >= 0")

    state_path = Path(args.state_file) if args.state_file else None
    results_handle = None
    misses_handle = None
    results_writer = None
    misses_writer = None

    per_worker_hash = max(16, int(args.hash_mb / max(1, args.workers)))
    settings = EngineSettings(
        path=args.engine,
        depth=args.depth,
        multipv=max(10, args.multipv),
        threads=max(1, args.threads),
        hash_mb=per_worker_hash,
    )
    settings_payload = {
        "path": settings.path,
        "depth": settings.depth,
        "multipv": settings.multipv,
        "threads": settings.threads,
        "hash_mb": settings.hash_mb,
    }

    print(f"Counting target rows in {dataset_path.name}...", file=sys.stderr)
    target_rows = _count_target_rows(
        dataset_path,
        offset=args.offset,
        stride=args.stride,
        limit=args.limit,
    )
    print(f"Target rows to classify: {target_rows}", file=sys.stderr)

    processed_rows = 0
    hit_count = 0
    parse_errors = 0
    unknown_count = 0
    last_enqueued_row_index = -1
    label_counts: Counter[str] = Counter()
    band_counts: dict[str, Counter[str]] = defaultdict(Counter)
    piece_bucket_counts: dict[str, Counter[str]] = defaultdict(Counter)
    misses: list[dict[str, Any]] = []
    resumed_elapsed = 0.0
    worker_slots = [_blank_worker_slot(worker_id + 1) for worker_id in range(args.workers)]
    pending_resume_tasks: list[dict[str, Any]] = []

    if args.resume:
        if state_path is None:
            raise ValueError("--resume requires --state-file")
        if not state_path.exists():
            raise FileNotFoundError(f"State file not found: {state_path}")
        state = _load_state(state_path)
        _validate_state(args, dataset_path, state)
        processed_rows = int(state.get("processed_rows", 0) or 0)
        hit_count = int(state.get("hit_count", 0) or 0)
        parse_errors = int(state.get("parse_errors", 0) or 0)
        unknown_count = int(state.get("unknown_count", 0) or 0)
        last_enqueued_row_index = int(state.get("last_enqueued_row_index", -1) or -1)
        label_counts = _restore_counter(state.get("label_counts"))
        band_counts = defaultdict(Counter, _restore_nested_counter(state.get("by_score_band")))
        piece_bucket_counts = defaultdict(Counter, _restore_nested_counter(state.get("by_piece_count")))
        misses = list(state.get("miss_examples") or [])[: max(0, args.sample_miss_cap)]
        resumed_elapsed = float(state.get("elapsed_seconds", 0.0) or 0.0)
        pending_resume_tasks = list(state.get("pending_tasks") or [])
        worker_slots = _coerce_worker_slots(state.get("worker_slots"), args.workers)
    elif state_path is not None:
        _save_state(
            state_path,
            args,
            dataset_path,
            processed_rows=0,
            last_enqueued_row_index=-1,
            hit_count=0,
            label_counts=Counter(),
            band_counts=defaultdict(Counter),
            piece_bucket_counts=defaultdict(Counter),
            parse_errors=0,
            unknown_count=0,
            miss_examples=[],
            elapsed_seconds=0.0,
            pending_tasks=[],
            worker_slots=worker_slots,
        )

    result_fieldnames = [
        "row_index",
        "fen",
        "san",
        "site",
        "pieces",
        "score",
        "piece_bucket",
        "score_band",
        "label",
        "reason",
        "rank",
        "best_move",
        "loss",
        "hit",
        "worker_id",
    ]
    append_mode = args.resume
    results_handle, results_writer = _ensure_csv_writer(args.results_csv, result_fieldnames, append=append_mode)
    misses_handle, misses_writer = _ensure_csv_writer(args.misses_csv, result_fieldnames, append=append_mode)

    start_time = time.monotonic() - resumed_elapsed
    last_status_print = time.monotonic()
    dashboard_state = _DashboardState(
        _dashboard_snapshot(
            args=args,
            dataset_path=dataset_path,
            target_rows=target_rows,
            processed_rows=processed_rows,
            hit_count=hit_count,
            label_counts=label_counts,
            parse_errors=parse_errors,
            unknown_count=unknown_count,
            worker_slots=worker_slots,
            start_time=start_time,
            last_enqueued_row_index=last_enqueued_row_index,
        )
    )
    dashboard_server = None
    dashboard_url = ""
    if args.dashboard_port > 0:
        dashboard_server = _start_dashboard_server(args.dashboard_port, dashboard_state)
        dashboard_url = f"http://127.0.0.1:{args.dashboard_port}"
        print(f"Live dashboard: {dashboard_url}", file=sys.stderr)
        if args.open_dashboard:
            threading.Thread(target=lambda: webbrowser.open(dashboard_url, new=1), daemon=True).start()

    def publish_dashboard() -> None:
        dashboard_state.update(
            lambda state: state.update(
                _dashboard_snapshot(
                    args=args,
                    dataset_path=dataset_path,
                    target_rows=target_rows,
                    processed_rows=processed_rows,
                    hit_count=hit_count,
                    label_counts=label_counts,
                    parse_errors=parse_errors,
                    unknown_count=unknown_count,
                    worker_slots=worker_slots,
                    start_time=start_time,
                    last_enqueued_row_index=last_enqueued_row_index,
                )
            )
        )

    ctx = mp.get_context("spawn")
    task_queues: list[mp.Queue] = [ctx.Queue() for _ in range(args.workers)]
    result_queue: mp.Queue = ctx.Queue()
    processes = [
        ctx.Process(
            target=_worker_process,
            args=(
                worker_id + 1,
                task_queues[worker_id],
                result_queue,
                settings_payload,
                args.multipv,
                args.time,
            ),
            daemon=True,
        )
        for worker_id in range(args.workers)
    ]

    pending_tasks = list(pending_resume_tasks)
    dataset_iter = _iter_filtered_rows(
        dataset_path,
        offset=args.offset,
        stride=args.stride,
        limit=args.limit,
        start_after_row_index=last_enqueued_row_index,
    )
    active_task_by_worker: dict[int, dict[str, Any]] = {}
    ready_workers: set[int] = set()
    exited_workers: set[int] = set()
    inflight_count = 0

    def dispatch_task_to_worker(worker_id: int) -> bool:
        nonlocal last_enqueued_row_index, inflight_count
        task = _next_task(pending_tasks, dataset_iter)
        if task is None:
            if 1 <= worker_id <= len(worker_slots):
                pid = worker_slots[worker_id - 1].get("pid")
                worker_slots[worker_id - 1] = _blank_worker_slot(worker_id)
                worker_slots[worker_id - 1]["status"] = "ready"
                worker_slots[worker_id - 1]["statusLabel"] = "Ready"
                worker_slots[worker_id - 1]["pid"] = pid
            return False
        pid = None
        if 1 <= worker_id <= len(worker_slots):
            pid = worker_slots[worker_id - 1].get("pid")
            worker_slots[worker_id - 1] = _worker_slot_from_queue(worker_id, task, pid=pid)
        task_queues[worker_id - 1].put(task)
        active_task_by_worker[worker_id] = task
        last_enqueued_row_index = max(last_enqueued_row_index, int(task["row_index"]))
        inflight_count += 1
        return True

    try:
        for process in processes:
            process.start()

        while processed_rows < target_rows or inflight_count > 0 or len(exited_workers) < len(processes):
            message = result_queue.get()
            message_type = str(message.get("type") or "")
            worker_id = int(message.get("worker_id") or 0)
            if message_type == "ready":
                ready_workers.add(worker_id)
                worker_slots[worker_id - 1]["pid"] = message.get("pid")
                worker_slots[worker_id - 1]["status"] = "ready"
                worker_slots[worker_id - 1]["statusLabel"] = "Ready"
                worker_slots[worker_id - 1]["title"] = "Waiting for the next position"
                worker_slots[worker_id - 1]["subtitle"] = "Ready for a new regression task."
                dispatch_task_to_worker(worker_id)
                publish_dashboard()
                continue

            if message_type == "started":
                worker_slots[worker_id - 1] = _worker_slot_from_start(worker_id, message)
                publish_dashboard()
                continue

            if message_type == "done":
                inflight_count = max(0, inflight_count - 1)
                slot = _worker_slot_from_done(worker_id, message)
                worker_slots[worker_id - 1] = slot
                active_task_by_worker.pop(worker_id, None)

                output_row = _make_output_row(
                    task=dict(message.get("task") or {}),
                    classification=dict(message.get("classification") or {}),
                    worker_id=worker_id,
                )
                label = str(output_row["label"] or "unknown")
                band = str(output_row["score_band"])
                piece_bucket = str(output_row["piece_bucket"])

                label_counts[label] += 1
                band_counts[band][label] += 1
                piece_bucket_counts[piece_bucket][label] += 1
                if label == "brilliant":
                    hit_count += 1
                elif label == "unknown":
                    unknown_count += 1
                    if str(output_row.get("reason") or "").startswith("error:"):
                        parse_errors += 1

                if results_writer is not None:
                    results_writer.writerow(output_row)
                    results_handle.flush()
                if misses_writer is not None and label != "brilliant":
                    misses_writer.writerow(output_row)
                    misses_handle.flush()

                if label != "brilliant" and len(misses) < args.sample_miss_cap:
                    misses.append(dict(output_row))

                processed_rows += 1

                dispatch_task_to_worker(worker_id)
                publish_dashboard()

                now = time.monotonic()
                should_print_status = (
                    processed_rows == 1
                    or processed_rows == target_rows
                    or processed_rows % args.status_every == 0
                    or (now - last_status_print) >= max(2.0, args.time)
                )
                if should_print_status:
                    _print_progress(
                        processed_rows,
                        target_rows,
                        hit_count,
                        start_time,
                        current_row_index=int(output_row["row_index"]),
                        parse_errors=parse_errors,
                        unknown_count=unknown_count,
                        label_counts=label_counts,
                        current_move=str(output_row.get("san") or ""),
                    current_site=str(output_row.get("site") or ""),
                        active_workers=sum(
                            1
                            for item in worker_slots
                            if item.get("status") in {"queued", "analyzing"}
                        ),
                        configured_workers=args.workers,
                    )
                    last_status_print = now

                if state_path is not None and processed_rows % args.checkpoint_every == 0:
                    _save_state(
                        state_path,
                        args,
                        dataset_path,
                        processed_rows=processed_rows,
                        last_enqueued_row_index=last_enqueued_row_index,
                        hit_count=hit_count,
                        label_counts=label_counts,
                        band_counts=band_counts,
                        piece_bucket_counts=piece_bucket_counts,
                        parse_errors=parse_errors,
                        unknown_count=unknown_count,
                        miss_examples=misses,
                        elapsed_seconds=time.monotonic() - start_time,
                        pending_tasks=[task for task in active_task_by_worker.values()],
                        worker_slots=worker_slots,
                    )

                if processed_rows >= target_rows and inflight_count == 0:
                    for queue in task_queues:
                        queue.put(None)
                continue

            if message_type == "crash":
                worker_slots[worker_id - 1]["status"] = "error"
                worker_slots[worker_id - 1]["statusLabel"] = "Error"
                worker_slots[worker_id - 1]["title"] = "Worker crashed"
                worker_slots[worker_id - 1]["subtitle"] = str(message.get("error") or "Unknown worker error")
                worker_slots[worker_id - 1]["reason"] = str(message.get("error") or "")
                publish_dashboard()
                continue

            if message_type == "exit":
                exited_workers.add(worker_id)
                if processed_rows >= target_rows and inflight_count == 0 and len(exited_workers) >= len(processes):
                    break
                continue
    finally:
        for queue in task_queues:
            try:
                queue.put_nowait(None)
            except Exception:
                pass
        for process in processes:
            process.join(timeout=1.0)
            if process.is_alive():
                process.terminate()
                process.join(timeout=1.0)
        if results_handle is not None:
            results_handle.close()
        if misses_handle is not None:
            misses_handle.close()
        if dashboard_server is not None:
            dashboard_server.shutdown()
            dashboard_server.server_close()

    elapsed = max(0.001, time.monotonic() - start_time)
    summary = {
        "dataset": str(dataset_path),
        "target_rows": target_rows,
        "processed_rows": processed_rows,
        "rows_remaining": max(0, target_rows - processed_rows),
        "percent_complete": round((processed_rows / target_rows) if target_rows else 1.0, 4),
        "last_enqueued_row_index": last_enqueued_row_index,
        "hit_count": hit_count,
        "hit_rate": round((hit_count / processed_rows) if processed_rows else 0.0, 4),
        "rows_per_second": round(processed_rows / elapsed, 4),
        "elapsed_seconds": round(elapsed, 4),
        "eta_seconds": round(((max(0, target_rows - processed_rows)) / (processed_rows / elapsed)), 4)
        if processed_rows and target_rows > processed_rows
        else 0.0,
        "parse_errors": parse_errors,
        "unknown_count": unknown_count,
        "label_counts": dict(label_counts),
        "by_score_band": {band: dict(counter) for band, counter in sorted(band_counts.items())},
        "by_piece_count": {
            bucket: dict(counter)
            for bucket, counter in sorted(piece_bucket_counts.items(), key=lambda item: item[0])
        },
        "miss_examples": misses[: max(0, args.show_misses)],
        "results_csv": args.results_csv,
        "misses_csv": args.misses_csv,
        "state_file": str(state_path) if state_path else "",
        "dashboard_url": dashboard_url,
        "workers": args.workers,
        "threads_per_worker": args.threads,
        "hash_mb_total": args.hash_mb,
        "hash_mb_per_worker": per_worker_hash,
    }

    if state_path is not None:
        _save_state(
            state_path,
            args,
            dataset_path,
            processed_rows=processed_rows,
            last_enqueued_row_index=last_enqueued_row_index,
            hit_count=hit_count,
            label_counts=label_counts,
            band_counts=band_counts,
            piece_bucket_counts=piece_bucket_counts,
            parse_errors=parse_errors,
            unknown_count=unknown_count,
            miss_examples=misses,
            elapsed_seconds=elapsed,
            pending_tasks=[],
            worker_slots=worker_slots,
        )

    print()
    print("=== Bookup Brilliant Regression ===")
    print(f"dataset:            {dataset_path}")
    print(f"target rows:        {target_rows}")
    print(f"processed rows:     {processed_rows}")
    print(f"rows left:          {max(0, target_rows - processed_rows)}")
    print(f"complete:           {_format_percent(processed_rows, target_rows)}")
    print(f"hits:               {hit_count}/{processed_rows} ({summary['hit_rate'] * 100:.1f}%)")
    print(f"positions/sec:      {summary['rows_per_second']}")
    print(f"elapsed:            {_format_eta(elapsed)}")
    print(f"eta:                {_format_eta(summary['eta_seconds'])}")
    print(f"parse errors:       {parse_errors}")
    print(f"unknown labels:     {unknown_count}")
    print(f"workers:            {args.workers} × {args.threads} thread(s)")
    print(f"hash per worker:    {per_worker_hash} MB")
    if dashboard_url:
        print(f"dashboard:          {dashboard_url}")
    print()
    print("label counts:")
    for key, count in label_counts.most_common():
        print(f"  {key:12} {count}")
    print()
    print("match rate by score band:")
    for band, counter in sorted(band_counts.items()):
        total = sum(counter.values())
        brilliant = counter.get("brilliant", 0)
        rate = (brilliant / total * 100.0) if total else 0.0
        print(f"  {band:>6}: {brilliant:6}/{total:<6} ({rate:5.1f}%)")
    print()
    print("match rate by sacrificed-piece count:")
    for bucket, counter in sorted(piece_bucket_counts.items(), key=lambda item: item[0]):
        total = sum(counter.values())
        brilliant = counter.get("brilliant", 0)
        rate = (brilliant / total * 100.0) if total else 0.0
        print(f"  {bucket:>3} piece(s): {brilliant:6}/{total:<6} ({rate:5.1f}%)")
    print()

    if misses and args.show_misses > 0:
        print("sample misses:")
        for item in misses[: args.show_misses]:
            print(
                f"  row {item['row_index']}: {item['san']} -> {item['label']} "
                f"(band={item['score_band']}, pieces={item['pieces']}, rank={item['rank']}, "
                f"best={item['best_move']}, loss={item['loss']})"
            )
            print(f"    site:   {item['site']}")
            print(f"    reason: {item['reason']}")

    if args.json_out:
        output_path = Path(args.json_out)
        output_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print()
        print(f"json written to {output_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
