from __future__ import annotations

import datetime as dt
import json
import math
import re
import tempfile
from pathlib import Path
from typing import Any

import requests


HEADERS = {
    "User-Agent": "Bookup/0.3 Progress Tracker (contact: https://github.com/tetizz/Bookup)",
    "Accept": "application/json",
}
API_ROOT = "https://api.chess.com/pub"
DEFAULT_ACCURACY = {"average": 74.18, "opening": 85.1, "middlegame": 71.1, "endgame": 77.2}
DEFAULT_FALLBACK = {"rating": 1507, "games": 1096, "wins": 602, "draws": 50, "losses": 444}
DEFAULT_DROPOFF = [
    {"label": "1-100", "games": 100, "wins": 55, "draws": 5, "losses": 40},
    {"label": "101-200", "games": 100, "wins": 53, "draws": 5, "losses": 42},
    {"label": "201-300", "games": 100, "wins": 52, "draws": 5, "losses": 43},
    {"label": "301-400", "games": 100, "wins": 51, "draws": 5, "losses": 44},
    {"label": "401-500", "games": 100, "wins": 50, "draws": 6, "losses": 44},
    {"label": "501-600", "games": 100, "wins": 49, "draws": 6, "losses": 45},
    {"label": "601-700", "games": 100, "wins": 48, "draws": 6, "losses": 46},
    {"label": "701-800", "games": 100, "wins": 47, "draws": 6, "losses": 47},
    {"label": "801-900", "games": 100, "wins": 46, "draws": 6, "losses": 48},
    {"label": "901-1000", "games": 100, "wins": 45, "draws": 6, "losses": 49},
]
MODES = ("rapid", "blitz", "bullet")
CLOCK_RE = re.compile(r"\[%clk\s+([0-9:.]+)\]")


class ProgressError(RuntimeError):
    def __init__(self, message: str, *, kind: str = "api_error", status_code: int | None = None) -> None:
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code


def progress_path(root: Path, username: str) -> Path:
    safe = re.sub(r"[^a-z0-9._-]+", "-", str(username or "default").lower()).strip("-") or "default"
    return root / safe / "progress_tracker.json"


def load_progress_state(root: Path, username: str) -> dict[str, Any]:
    path = progress_path(root, username)
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            payload = {}
    else:
        payload = {}
    return migrate_progress_state(payload, username)


def save_progress_state(root: Path, username: str, payload: dict[str, Any]) -> None:
    path = progress_path(root, username)
    path.parent.mkdir(parents=True, exist_ok=True)
    migrated = migrate_progress_state(payload, username)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as handle:
        json.dump(migrated, handle, indent=2)
        temp_path = Path(handle.name)
    temp_path.replace(path)


def migrate_progress_state(payload: dict[str, Any], username: str) -> dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    settings = data.setdefault("settings", {})
    settings.setdefault("username", username or "")
    settings.setdefault("mode", "rapid")
    settings.setdefault("custom_games", 538)
    settings.setdefault("accuracy", dict(DEFAULT_ACCURACY))
    settings.setdefault("dropoff_table", DEFAULT_DROPOFF)
    settings.setdefault("fallback", dict(DEFAULT_FALLBACK))
    data.setdefault("last_live", None)
    data.setdefault("sessions", [])
    data.setdefault("snapshots", [])
    data.setdefault("errors", [])
    return data


def build_progress_payload(root: Path, username: str, *, mode: str = "") -> dict[str, Any]:
    data = load_progress_state(root, username)
    active_mode = normalize_mode(mode or data["settings"].get("mode") or "rapid")
    data["settings"]["mode"] = active_mode
    profile = active_profile(data, username, active_mode)
    return {
        "username": username,
        "mode": active_mode,
        "settings": data["settings"],
        "profile": profile,
        "charts": build_charts(data, profile),
        "projection": build_projection(data, profile),
        "goals": build_goals(profile),
        "recommendations": build_recommendations(profile),
        "sessions": data.get("sessions", [])[-80:],
        "last_error": (data.get("errors") or [None])[-1],
        "saved_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "storage_path": str(progress_path(root, username)),
    }


def refresh_progress(root: Path, username: str, *, mode: str | None = None) -> dict[str, Any]:
    data = load_progress_state(root, username)
    requested_mode = normalize_mode(mode or data["settings"].get("mode", "rapid"))
    try:
        live = fetch_live_progress(username)
    except ProgressError as exc:
        data.setdefault("errors", []).append(
            {"at": dt.datetime.now(dt.timezone.utc).isoformat(), "message": str(exc), "kind": exc.kind, "status_code": exc.status_code}
        )
        save_progress_state(root, username, data)
        raise
    data["last_live"] = live
    data["settings"]["username"] = username
    data["settings"]["mode"] = requested_mode
    data["errors"] = []
    save_daily_snapshots(data, live)
    save_progress_state(root, username, data)
    return build_progress_payload(root, username, mode=requested_mode)


def save_session(root: Path, username: str, raw: dict[str, Any]) -> dict[str, Any]:
    data = load_progress_state(root, username)
    mode = normalize_mode(raw.get("mode") or raw.get("time_class") or data["settings"].get("mode", "rapid"))
    session = {
        "id": dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S%f"),
        "date": str(raw.get("date") or dt.date.today().isoformat()),
        "mode": mode,
        "start_rating": safe_int(raw.get("start_rating")),
        "end_rating": safe_int(raw.get("end_rating")),
        "wins": safe_int(raw.get("wins")) or 0,
        "draws": safe_int(raw.get("draws")) or 0,
        "losses": safe_int(raw.get("losses")) or 0,
        "accuracy": safe_float(raw.get("accuracy")),
        "notes": str(raw.get("notes") or "").strip(),
        "mistake_theme": str(raw.get("mistake_theme") or "").strip(),
        "next_work": str(raw.get("next_work") or "").strip(),
    }
    if session["end_rating"] is None:
        raise ProgressError("End rating is required to save a session.", kind="validation")
    data.setdefault("sessions", []).append(session)
    add_session_snapshot(data, session)
    save_progress_state(root, username, data)
    return build_progress_payload(root, username, mode=mode)


def save_progress_settings(root: Path, username: str, raw: dict[str, Any]) -> dict[str, Any]:
    data = load_progress_state(root, username)
    settings = data["settings"]
    if "mode" in raw:
        settings["mode"] = normalize_mode(raw.get("mode"))
    if "custom_games" in raw:
        custom_games = safe_int(raw.get("custom_games"))
        if custom_games and custom_games > 0:
            settings["custom_games"] = custom_games
    if isinstance(raw.get("accuracy"), dict):
        for key in ("average", "opening", "middlegame", "endgame"):
            value = safe_float(raw["accuracy"].get(key))
            if value is not None:
                settings["accuracy"][key] = value
    if isinstance(raw.get("dropoff_table"), list) and raw["dropoff_table"]:
        settings["dropoff_table"] = normalize_dropoff(raw["dropoff_table"])
    save_progress_state(root, username, data)
    return build_progress_payload(root, username, mode=settings.get("mode", "rapid"))


def fetch_live_progress(username: str) -> dict[str, Any]:
    stats = get_json(f"{API_ROOT}/player/{username}/stats")
    recent_by_mode = {mode: fetch_recent_games(username, mode, limit=220) for mode in MODES}
    modes = {}
    for mode in MODES:
        mode_payload = mode_from_stats(username, stats, mode, recent_by_mode.get(mode, []))
        if mode_payload:
            modes[mode] = mode_payload
    if not modes:
        raise ProgressError("Chess.com did not return rapid, blitz, or bullet stats for this player.", kind="missing_fields")
    return {"source": "live", "username": username, "modes": modes, "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat()}


def get_json(url: str) -> dict[str, Any]:
    try:
        response = requests.get(url, headers=HEADERS, timeout=25)
    except requests.exceptions.ConnectionError as exc:
        raise ProgressError("No internet connection. Check your network and refresh again.", kind="network") from exc
    except requests.exceptions.Timeout as exc:
        raise ProgressError("Chess.com took too long to respond. Try again in a minute.", kind="timeout") from exc
    except requests.exceptions.RequestException as exc:
        raise ProgressError(f"Could not reach Chess.com: {exc}", kind="network") from exc
    if response.status_code == 404:
        raise ProgressError("That Chess.com username was not found.", kind="invalid_username", status_code=404)
    if response.status_code == 429:
        raise ProgressError("Chess.com rate-limited this refresh. Wait a bit and try again.", kind="rate_limited", status_code=429)
    if response.status_code >= 500:
        raise ProgressError("Chess.com is having trouble right now. Try again later.", kind="server", status_code=response.status_code)
    if not response.ok:
        raise ProgressError(f"Chess.com API error {response.status_code}.", status_code=response.status_code)
    try:
        payload = response.json()
    except ValueError as exc:
        raise ProgressError("Chess.com returned data in an unexpected format.", kind="bad_json") from exc
    return payload if isinstance(payload, dict) else {}


def fetch_recent_games(username: str, mode: str, *, limit: int) -> list[dict[str, Any]]:
    archives = get_json(f"{API_ROOT}/player/{username}/games/archives").get("archives", [])
    games: list[dict[str, Any]] = []
    username_lc = username.lower()
    for archive_url in reversed([str(item) for item in archives if item]):
        month = get_json(archive_url)
        for raw in reversed(month.get("games", []) if isinstance(month.get("games"), list) else []):
            if not isinstance(raw, dict) or infer_time_class(raw) != mode:
                continue
            parsed = parse_game(raw, username_lc)
            if parsed:
                games.append(parsed)
            if len(games) >= limit:
                return games
    return games


def mode_from_stats(username: str, stats: dict[str, Any], mode: str, recent_games: list[dict[str, Any]]) -> dict[str, Any] | None:
    block = stats.get(f"chess_{mode}")
    if not isinstance(block, dict):
        return None
    last = block.get("last") if isinstance(block.get("last"), dict) else {}
    record = block.get("record") if isinstance(block.get("record"), dict) else {}
    rating = safe_int(last.get("rating"))
    wins = safe_int(record.get("win"))
    draws = safe_int(record.get("draw"))
    losses = safe_int(record.get("loss"))
    if rating is None or wins is None or draws is None or losses is None:
        return None
    total = wins + draws + losses
    recent = recent_summary(recent_games[:30])
    duration_values = [safe_float(game.get("duration_minutes")) for game in recent_games]
    duration_values = [value for value in duration_values if value is not None]
    accuracy_values = [safe_float(game.get("accuracy")) for game in recent_games]
    accuracy_values = [value for value in accuracy_values if value is not None]
    return {
        "source": "live",
        "username": username,
        "mode": mode,
        "rating": rating,
        "wins": wins,
        "draws": draws,
        "losses": losses,
        "total_games": total,
        "win_rate": round((wins / total) * 100, 1) if total else 0,
        "score_percentage": round(((wins + 0.5 * draws) / total) * 100, 1) if total else 0,
        "recent": recent,
        "rating_series": [{"date": game["date"], "value": game["user_rating"], "url": game.get("url", "")} for game in reversed(recent_games) if game.get("user_rating") is not None][-140:],
        "recent_games": recent_games[:80],
        "duration_summary": {
            "average": round(sum(duration_values) / len(duration_values), 1) if duration_values else 20.0,
            "shortest": round(min(duration_values), 1) if duration_values else 20.0,
            "longest": round(max(duration_values), 1) if duration_values else 20.0,
            "games_used": len(duration_values),
            "sample_warning": len(duration_values) < 20,
        },
        "accuracy_from_live_games": round(sum(accuracy_values) / len(accuracy_values), 2) if accuracy_values else None,
        "accuracy_games_used": len(accuracy_values),
    }


def parse_game(raw: dict[str, Any], username_lc: str) -> dict[str, Any] | None:
    white = raw.get("white") if isinstance(raw.get("white"), dict) else {}
    black = raw.get("black") if isinstance(raw.get("black"), dict) else {}
    if str(white.get("username", "")).lower() == username_lc:
        mine, theirs, color = white, black, "white"
        accuracy = (raw.get("accuracies") or {}).get("white") if isinstance(raw.get("accuracies"), dict) else None
    elif str(black.get("username", "")).lower() == username_lc:
        mine, theirs, color = black, white, "black"
        accuracy = (raw.get("accuracies") or {}).get("black") if isinstance(raw.get("accuracies"), dict) else None
    else:
        return None
    end_time = safe_int(raw.get("end_time")) or 0
    time_control = str(raw.get("time_control") or "")
    pgn = str(raw.get("pgn") or "")
    return {
        "url": str(raw.get("url") or ""),
        "date": dt.datetime.fromtimestamp(end_time, tz=dt.timezone.utc).date().isoformat() if end_time else "",
        "result": str(mine.get("result") or ""),
        "color": color,
        "opponent": str(theirs.get("username") or "Unknown"),
        "user_rating": safe_int(mine.get("rating")),
        "opponent_rating": safe_int(theirs.get("rating")),
        "time_control": time_control,
        "accuracy": safe_float(accuracy),
        "duration_minutes": estimate_duration_minutes(time_control, pgn),
    }


def infer_time_class(game: dict[str, Any]) -> str:
    explicit = str(game.get("time_class", "") or "").lower().strip()
    if explicit:
        return explicit
    base, inc = parse_time_control(str(game.get("time_control", "") or ""))
    total = base + 40 * inc
    if total >= 1500:
        return "daily"
    if total >= 480:
        return "rapid"
    if total >= 120:
        return "blitz"
    return "bullet" if total > 0 else "unknown"


def estimate_duration_minutes(time_control: str, pgn: str) -> float:
    base, inc = parse_time_control(time_control)
    clocks = [clock_to_seconds(item) for item in CLOCK_RE.findall(pgn or "")]
    clocks = [item for item in clocks if item is not None]
    if base > 0 and len(clocks) >= 2:
        white = clocks[0::2]
        black = clocks[1::2]
        used = max(0, base + inc * max(0, len(white) - 1) - white[-1]) + max(0, base + inc * max(0, len(black) - 1) - black[-1])
        if used > 0:
            return round(max(1.0, min(240.0, used / 60)), 1)
    if base <= 0:
        return 20.0
    return round(max(3.0, min(60.0, (((base * 2) + (inc * 70)) / 60) * 0.72)), 1)


def parse_time_control(raw_value: str) -> tuple[int, int]:
    raw = str(raw_value or "").strip()
    if "/" in raw:
        raw = raw.split("/", 1)[-1]
    try:
        if "+" in raw:
            base, inc = raw.split("+", 1)
            return int(base or 0), int(inc or 0)
        return int(raw or 0), 0
    except ValueError:
        return 0, 0


def clock_to_seconds(raw: str) -> int | None:
    parts = raw.strip().split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(float(parts[2]))
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(float(parts[1]))
        return int(float(parts[0]))
    except (TypeError, ValueError, IndexError):
        return None


def active_profile(data: dict[str, Any], username: str, mode: str) -> dict[str, Any]:
    live = data.get("last_live") if isinstance(data.get("last_live"), dict) else None
    modes = live.get("modes", {}) if live else {}
    if isinstance(modes, dict) and isinstance(modes.get(mode), dict):
        profile = dict(modes[mode])
        profile["fallback_active"] = False
        profile["available_modes"] = [key for key in MODES if key in modes]
    else:
        fallback = data["settings"].get("fallback") or DEFAULT_FALLBACK
        wins = safe_int(fallback.get("wins")) or DEFAULT_FALLBACK["wins"]
        draws = safe_int(fallback.get("draws")) or DEFAULT_FALLBACK["draws"]
        losses = safe_int(fallback.get("losses")) or DEFAULT_FALLBACK["losses"]
        total = safe_int(fallback.get("games")) or (wins + draws + losses)
        profile = {
            "source": "fallback",
            "username": username,
            "mode": mode,
            "rating": safe_int(fallback.get("rating")) or DEFAULT_FALLBACK["rating"],
            "wins": wins,
            "draws": draws,
            "losses": losses,
            "total_games": total,
            "win_rate": round((wins / total) * 100, 1) if total else 0,
            "score_percentage": round(((wins + 0.5 * draws) / total) * 100, 1) if total else 0,
            "recent": {"games": 0, "wins": 0, "draws": 0, "losses": 0, "win_rate": 0, "score_percentage": 0},
            "rating_series": [],
            "recent_games": [],
            "duration_summary": {"average": 20.0, "shortest": 20.0, "longest": 20.0, "games_used": 0, "sample_warning": True},
            "fallback_active": True,
            "available_modes": list(MODES),
        }
    profile["accuracy"] = accuracy_payload(data["settings"], profile.get("accuracy_from_live_games"))
    profile["fetched_at"] = live.get("fetched_at") if live else None
    return profile


def accuracy_payload(settings: dict[str, Any], live_average: Any) -> dict[str, Any]:
    saved = settings.get("accuracy") or DEFAULT_ACCURACY
    average = safe_float(live_average)
    payload = {
        "average": round(average if average is not None else safe_float(saved.get("average")) or DEFAULT_ACCURACY["average"], 2),
        "opening": safe_float(saved.get("opening")) or DEFAULT_ACCURACY["opening"],
        "middlegame": safe_float(saved.get("middlegame")) or DEFAULT_ACCURACY["middlegame"],
        "endgame": safe_float(saved.get("endgame")) or DEFAULT_ACCURACY["endgame"],
        "average_is_live": average is not None,
    }
    phases = {key: payload[key] for key in ("opening", "middlegame", "endgame")}
    payload["main_weakness"] = min(phases, key=phases.get)
    payload["best_phase"] = max(phases, key=phases.get)
    return payload


def build_charts(data: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    mode = profile.get("mode", "rapid")
    snapshots = [item for item in data.get("snapshots", []) if item.get("mode", "rapid") == mode]
    rating = profile.get("rating_series") or [{"date": item.get("date", ""), "value": item.get("rating", 0)} for item in snapshots]
    if not rating:
        rating = [{"date": dt.date.today().isoformat(), "value": profile.get("rating", 0)}]
    return {
        "rating": rating,
        "daily_delta": daily_delta_from_rating(rating),
        "games": [{"date": item.get("date", ""), "value": item.get("games", 0)} for item in snapshots] or [{"date": dt.date.today().isoformat(), "value": profile.get("total_games", 0)}],
        "win_rate": [{"date": item.get("date", ""), "value": item.get("win_rate", 0)} for item in snapshots] or [{"date": dt.date.today().isoformat(), "value": profile.get("win_rate", 0)}],
        "accuracy": [{"date": item.get("date", ""), "value": item.get("accuracy", 0)} for item in snapshots] or [{"date": dt.date.today().isoformat(), "value": profile["accuracy"]["average"]}],
        "phase_accuracy": [{"date": item.get("date", ""), "opening": item.get("opening_accuracy", 0), "middlegame": item.get("middlegame_accuracy", 0), "endgame": item.get("endgame_accuracy", 0)} for item in snapshots]
        or [{"date": dt.date.today().isoformat(), "opening": profile["accuracy"]["opening"], "middlegame": profile["accuracy"]["middlegame"], "endgame": profile["accuracy"]["endgame"]}],
    }


def daily_delta_from_rating(series: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_date: dict[str, list[float]] = {}
    for point in series:
        value = safe_float(point.get("value") if "value" in point else point.get("rating"))
        date_value = str(point.get("date") or "")
        if value is None or not date_value:
            continue
        by_date.setdefault(date_value, []).append(value)
    rows = []
    prev = None
    for date_value in sorted(by_date):
        ratings = by_date[date_value]
        start = prev if prev is not None else ratings[0]
        end = ratings[-1]
        rows.append({"date": date_value, "value": round(end - start, 1)})
        prev = end
    return rows


def build_projection(data: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    settings = data["settings"]
    custom = safe_int(settings.get("custom_games")) or 538
    counts = [538, 1000, custom]
    table = normalize_dropoff(settings.get("dropoff_table"))
    average = safe_float(profile.get("duration_summary", {}).get("average")) or 20.0
    return {
        "custom_games": custom,
        "dropoff_table": table,
        "simple": [simple_projection(profile, count) for count in counts],
        "dropoff": [dropoff_projection(safe_int(profile.get("rating")) or 0, count, table) for count in counts],
        "time": [time_estimate(count, average) for count in counts],
        "duration_summary": profile.get("duration_summary", {}),
        "max_1000_note": {"minutes": 20000, "label": "333h 20m · about 13.9 nonstop days"},
    }


def simple_projection(profile: dict[str, Any], games: int) -> dict[str, Any]:
    total = max(1, safe_int(profile.get("total_games")) or 1)
    wins = games * ((safe_int(profile.get("wins")) or 0) / total)
    draws = games * ((safe_int(profile.get("draws")) or 0) / total)
    losses = games * ((safe_int(profile.get("losses")) or 0) / total)
    delta = round((wins - losses) * 8)
    return projection_payload("simple", safe_int(profile.get("rating")) or 0, games, wins, draws, losses, delta)


def dropoff_projection(rating: int, games: int, table: list[dict[str, Any]]) -> dict[str, Any]:
    remaining = games
    wins = draws = losses = 0.0
    for row in table:
        if remaining <= 0:
            break
        used = min(remaining, safe_int(row.get("games")) or 100)
        scale = used / max(1, safe_int(row.get("games")) or 100)
        wins += (safe_float(row.get("wins")) or 0) * scale
        draws += (safe_float(row.get("draws")) or 0) * scale
        losses += (safe_float(row.get("losses")) or 0) * scale
        remaining -= used
    delta = round((wins - losses) * 8)
    return projection_payload("dropoff", rating, games, wins, draws, losses, delta)


def projection_payload(mode: str, rating: int, games: int, wins: float, draws: float, losses: float, delta: int) -> dict[str, Any]:
    return {"mode": mode, "games": games, "expected_wins": round(wins, 1), "expected_draws": round(draws, 1), "expected_losses": round(losses, 1), "net_rating_change": delta, "final_rating": rating + delta}


def time_estimate(games: int, average: float) -> dict[str, Any]:
    return {
        "games": games,
        "max_minutes": games * 20,
        "max_label": duration_label(games * 20),
        "real_minutes": round(games * average, 1),
        "real_label": duration_label(games * average),
        "days_at": {str(rate): round(games / rate, 1) for rate in (10, 15, 20, 25, 40)},
    }


def duration_label(minutes: float) -> str:
    hours = math.floor(minutes / 60)
    mins = int(round(minutes - hours * 60))
    if mins == 60:
        hours += 1
        mins = 0
    return f"{hours}h {mins}m · {minutes / 1440:.1f} nonstop days" if hours else f"{mins}m"


def build_goals(profile: dict[str, Any]) -> list[dict[str, Any]]:
    rating = safe_int(profile.get("rating")) or 0
    games = safe_int(profile.get("total_games")) or 0
    acc = profile["accuracy"]
    recent_win = safe_float(profile.get("recent", {}).get("win_rate")) or profile.get("win_rate") or 0
    goals = [{"label": f"{target} rating", "value": rating, "target": target} for target in (1600, 1700, 1800, 1900, 2000)]
    goals += [
        {"label": "538 more games", "value": max(0, games - DEFAULT_FALLBACK["games"]), "target": 538},
        {"label": "1000 more games", "value": max(0, games - DEFAULT_FALLBACK["games"]), "target": 1000},
        {"label": "Avg accuracy 75", "value": acc["average"], "target": 75},
        {"label": "Middlegame 73", "value": acc["middlegame"], "target": 73},
        {"label": "Endgame 80", "value": acc["endgame"], "target": 80},
        {"label": "Recent win rate 52%", "value": recent_win, "target": 52},
    ]
    for goal in goals:
        target = safe_float(goal["target"]) or 1
        value = safe_float(goal["value"]) or 0
        if "rating" in str(goal["label"]):
            pct = ((value - 1500) / max(1, target - 1500)) * 100
        else:
            pct = (value / max(1, target)) * 100
        goal["progress"] = round(max(0, min(100, pct)), 1)
    return goals


def build_recommendations(profile: dict[str, Any]) -> list[dict[str, str]]:
    weakness = str(profile["accuracy"].get("main_weakness", "middlegame"))
    score = safe_float(profile.get("recent", {}).get("score_percentage")) or profile.get("score_percentage") or 0
    return [
        {"area": "Opening", "priority": "steady" if profile["accuracy"]["opening"] >= 82 else "high", "text": "Use Bookup's repertoire map and Smart Theory seeds to patch the first position where your plan gets vague."},
        {"area": "Middlegame", "priority": "high" if weakness == "middlegame" else "medium", "text": "Tag losses by motif, then drill candidate moves, loose pieces, and king safety before calculating forcing lines."},
        {"area": "Endgame", "priority": "high" if weakness == "endgame" else "medium", "text": "Review conversion misses and rehearse rook activity, pawn races, and practical equal-material endings."},
        {"area": "Tactics", "priority": "high" if score < 52 else "medium", "text": "Start sessions with short puzzle bursts and then inspect the same motif in your Bookup game tree."},
        {"area": "Review", "priority": "high", "text": f"Open with one {weakness} review card, one due line, and one recent loss before adding new games."},
    ]


def save_daily_snapshots(data: dict[str, Any], live: dict[str, Any]) -> None:
    today = dt.date.today().isoformat()
    snapshots = data.setdefault("snapshots", [])
    for mode, profile in (live.get("modes") or {}).items():
        if not isinstance(profile, dict):
            continue
        snapshot = {
            "date": today,
            "mode": mode,
            "source": "live",
            "rating": profile.get("rating"),
            "games": profile.get("total_games"),
            "wins": profile.get("wins"),
            "draws": profile.get("draws"),
            "losses": profile.get("losses"),
            "win_rate": profile.get("win_rate"),
            "score_percentage": profile.get("score_percentage"),
            "accuracy": profile.get("accuracy_from_live_games") or data["settings"]["accuracy"]["average"],
            "opening_accuracy": data["settings"]["accuracy"]["opening"],
            "middlegame_accuracy": data["settings"]["accuracy"]["middlegame"],
            "endgame_accuracy": data["settings"]["accuracy"]["endgame"],
        }
        existing = next((item for item in snapshots if item.get("date") == today and item.get("mode") == mode and item.get("source") == "live"), None)
        if existing:
            existing.update(snapshot)
        else:
            snapshots.append(snapshot)


def add_session_snapshot(data: dict[str, Any], session: dict[str, Any]) -> None:
    games = (session.get("wins") or 0) + (session.get("draws") or 0) + (session.get("losses") or 0)
    snapshot = {
        "date": session["date"],
        "mode": session["mode"],
        "source": "session",
        "rating": session.get("end_rating"),
        "rating_delta": (session.get("end_rating") or 0) - (session.get("start_rating") or session.get("end_rating") or 0),
        "games": games,
        "wins": session.get("wins") or 0,
        "draws": session.get("draws") or 0,
        "losses": session.get("losses") or 0,
        "win_rate": round(((session.get("wins") or 0) / games) * 100, 1) if games else 0,
        "score_percentage": round((((session.get("wins") or 0) + 0.5 * (session.get("draws") or 0)) / games) * 100, 1) if games else 0,
        "accuracy": session.get("accuracy") or data["settings"]["accuracy"]["average"],
        "opening_accuracy": data["settings"]["accuracy"]["opening"],
        "middlegame_accuracy": data["settings"]["accuracy"]["middlegame"],
        "endgame_accuracy": data["settings"]["accuracy"]["endgame"],
    }
    data.setdefault("snapshots", []).append(snapshot)


def recent_summary(games: list[dict[str, Any]]) -> dict[str, Any]:
    wins = draws = losses = 0
    score = 0.0
    for game in games:
        result = str(game.get("result") or "").lower()
        if result == "win":
            wins += 1
            score += 1
        elif result in {"agreed", "repetition", "stalemate", "50move", "timevsinsufficient", "insufficient"}:
            draws += 1
            score += 0.5
        else:
            losses += 1
    total = len(games)
    return {"games": total, "wins": wins, "draws": draws, "losses": losses, "win_rate": round((wins / total) * 100, 1) if total else 0, "score_percentage": round((score / total) * 100, 1) if total else 0}


def normalize_dropoff(rows: Any) -> list[dict[str, Any]]:
    source = rows if isinstance(rows, list) and rows else DEFAULT_DROPOFF
    cleaned = []
    for index, row in enumerate(source):
        if not isinstance(row, dict):
            continue
        games = safe_int(row.get("games")) or 100
        wins = safe_float(row.get("wins")) or 0
        draws = safe_float(row.get("draws")) or 0
        losses = safe_float(row.get("losses")) or 0
        total = wins + draws + losses
        if total <= 0:
            wins, draws, losses, total = 50, 5, 45, 100
        scale = games / total
        cleaned.append({"label": str(row.get("label") or f"Block {index + 1}"), "games": games, "wins": round(wins * scale, 2), "draws": round(draws * scale, 2), "losses": round(losses * scale, 2)})
    return cleaned or DEFAULT_DROPOFF


def normalize_mode(value: Any) -> str:
    mode = str(value or "rapid").strip().lower()
    return mode if mode in MODES else "rapid"


def safe_int(value: Any) -> int | None:
    try:
        if value in (None, ""):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def safe_float(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None
