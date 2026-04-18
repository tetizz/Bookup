from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from statistics import mean
from typing import Any

import chess

from .chesscom import ImportedGame
from .engine import EngineSession


PHASES = ("opening", "middlegame", "endgame")
PHASE_LABELS = {
    "opening": "Opening",
    "middlegame": "Middlegame",
    "endgame": "Endgame",
}


@dataclass(slots=True)
class OpeningAdvice:
    opening: str
    color: str
    opponent_reply: str
    recommendation: str
    explanation: str
    example_line: str
    position_fen: str


def _score_cp(score: chess.engine.PovScore, turn: chess.Color) -> int:
    pov = score.pov(turn)
    if pov.is_mate():
        mate = pov.mate()
        if mate is None:
            return 0
        return 100000 - abs(mate) if mate > 0 else -100000 + abs(mate)
    return int(pov.score(mate_score=100000) or 0)


def _classify_result(result: str) -> str:
    lowered = result.lower()
    if lowered == "win":
        return "win"
    if lowered in {"agreed", "stalemate", "repetition", "timevsinsufficient", "insufficient", "50move"}:
        return "draw"
    return "loss"


def _phase_name(ply_index: int) -> str:
    if ply_index < 16:
        return "opening"
    if ply_index < 50:
        return "middlegame"
    return "endgame"


def _phase_headline(phase: str) -> str:
    if phase == "opening":
        return "You leak the most value in the opening."
    if phase == "middlegame":
        return "Most of your value loss happens once the position gets tactical."
    return "Your endgames are where the engine still sees clean points to save."


def _why_note(phase: str, played: str, best: str, loss: int) -> str:
    return f"The engine liked {best} more than {played} by about {round(loss / 100, 2)} pawns in the {phase}. That usually means your move gave up initiative, structure, or a tactical resource too soon."


def opening_name(game: ImportedGame) -> str:
    header_name = game.game.headers.get("Opening") or game.game.headers.get("ECO") or ""
    if header_name and header_name != "Unknown":
        return header_name

    board = game.game.board()
    line: list[str] = []
    for index, move in enumerate(game.game.mainline_moves()):
        if index >= 6:
            break
        line.append(board.san(move))
        board.push(move)
    return "Line: " + " ".join(line) if line else "Unknown Opening"


def _safe_mean(values: list[float]) -> float:
    return mean(values) if values else 0.0


def _clamp_pct(value: float) -> float:
    return max(0.0, min(100.0, value))


def _parse_time_control(raw: str) -> tuple[float, float]:
    if not raw:
        return 0.0, 0.0
    main = raw.split("|", 1)[0]
    if "/" in main:
        main = main.split("/", 1)[-1]
    if "+" in main:
        base, inc = main.split("+", 1)
        return float(base or 0), float(inc or 0)
    try:
        return float(main), 0.0
    except ValueError:
        return 0.0, 0.0


def _clock_hms(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    mins, sec = divmod(seconds, 60)
    return f"{mins}m {sec:02d}s"


def _find_player_first_move(game: ImportedGame) -> str | None:
    board = game.game.board()
    target = chess.WHITE if game.player_color == "white" else chess.BLACK
    for move in game.game.mainline_moves():
        if board.turn == target:
            return board.san(move)
        board.push(move)
    return None


def _extract_phase_clock_data(imported: ImportedGame) -> dict[str, Any]:
    game = imported.game
    player_turn = chess.WHITE if imported.player_color == "white" else chess.BLACK
    base_seconds, increment = _parse_time_control(game.headers.get("TimeControl", ""))
    prev_clock = base_seconds
    clocks: list[float] = []
    spend_by_phase: dict[str, list[float]] = defaultdict(list)
    end_clock = base_seconds

    node = game
    while node.variations:
        next_node = node.variation(0)
        board = node.board()
        move = next_node.move
        phase = _phase_name(len(board.move_stack))
        if board.turn == player_turn:
            clock = next_node.clock()
            if clock is not None:
                clocks.append(clock)
                spent = max(0.0, prev_clock + increment - clock)
                spend_by_phase[phase].append(spent)
                prev_clock = clock
                end_clock = clock
        node = next_node

    if not clocks:
        return {
            "avg_remaining": {"start": 0, "middlegame": 0, "endgame": 0, "end": 0},
            "seconds_per_move": {phase: 0 for phase in PHASES},
            "burn_rate_pct": 0.0,
        }

    checkpoints = {
        "start": clocks[0],
        "middlegame": clocks[min(len(clocks) - 1, max(0, len(clocks) // 2))],
        "endgame": clocks[min(len(clocks) - 1, max(0, int(len(clocks) * 0.8)))],
        "end": end_clock,
    }
    burn_rate_pct = 0.0
    if base_seconds > 0:
        burn_rate_pct = _clamp_pct((1 - (end_clock / base_seconds)) * 100)

    return {
        "avg_remaining": checkpoints,
        "seconds_per_move": {phase: _safe_mean(spend_by_phase[phase]) for phase in PHASES},
        "burn_rate_pct": burn_rate_pct,
    }


def _termination_bucket(game: ImportedGame) -> str:
    termination = (game.game.headers.get("Termination", "") or "").lower()
    if "checkmate" in termination:
        return "checkmate"
    if "time" in termination:
        return "timeout"
    if "resignation" in termination:
        return "resigned"
    return "other"


def _style_summary(castle_rate: float, queen_rate: float, capture_rate: float, checks_per_game: float, avg_game_moves: float, color_gap: float) -> str:
    notes: list[str] = []
    if capture_rate >= 0.24 or checks_per_game >= 2.0:
        notes.append("This profile leans sharp and forcing rather than quiet and technical.")
    else:
        notes.append("This profile keeps tension and prefers cleaner positions over chaos.")
    if castle_rate >= 0.75:
        notes.append("They get the king safe early in most games.")
    elif castle_rate <= 0.35:
        notes.append("They often delay castling and live with extra king risk.")
    if avg_game_moves >= 65:
        notes.append("Their games usually run long, so they are comfortable grinding.")
    if queen_rate >= 0.4:
        notes.append("Early queen activity shows up often in their practical choices.")
    if color_gap >= 8:
        notes.append("There is a meaningful color split you can prepare around.")
    return " ".join(notes)


def _win_rate(record: dict[str, int]) -> float:
    total = record["win"] + record["loss"] + record["draw"]
    if not total:
        return 0.0
    return ((record["win"] + 0.5 * record["draw"]) / total) * 100


def _build_radar(style_metrics: dict[str, float], castle_rate_pct: float, early_queen_pct: float, avg_game_moves: float, endgame_wr: float, burn_rate_pct: float, improvement_pressure: float) -> dict[str, float]:
    aggression = _clamp_pct(style_metrics["capture_rate"] * 1.8 + style_metrics["checks_per_game"] * 18)
    tactical = _clamp_pct(style_metrics["forcing_rate"] * 1.9 + style_metrics["tactical_bursts"] * 9)
    positional = _clamp_pct(60 + castle_rate_pct * 0.22 - aggression * 0.25 + endgame_wr * 0.15)
    opening_prep = _clamp_pct(45 + style_metrics["opening_loyalty"] * 0.55 - improvement_pressure * 0.12)
    time_pressure = _clamp_pct(burn_rate_pct * 0.9 + style_metrics["clock_drain"] * 0.5)
    endgame = _clamp_pct(endgame_wr * 0.9 + min(100, avg_game_moves) * 0.2)
    return {
        "Aggression": round(aggression, 1),
        "Tactical": round(tactical, 1),
        "Positional": round(positional, 1),
        "Opening Prep": round(opening_prep, 1),
        "Time Pressure": round(time_pressure, 1),
        "Endgame": round(endgame, 1),
    }


def _build_dossier(style_metrics: dict[str, float], white_wr: float, black_wr: float, avg_game_moves: float, resigned_move_avg: float, resigned_early_pct: float) -> list[dict[str, Any]]:
    color_gap = round(abs(white_wr - black_wr), 1)
    return [
        {
            "label": "Chaos Index",
            "value": round(style_metrics["chaos_index"]),
            "detail": "Higher capture volume, forcing moves, and tactical bursts suggest a sharper game tree.",
            "tone": "critical" if style_metrics["chaos_index"] >= 65 else "low",
            "accent": "danger",
        },
        {
            "label": "Aggression Index",
            "value": round(style_metrics["aggression_index"]),
            "detail": "Attacks relentlessly when checks and captures keep appearing above baseline.",
            "tone": "critical" if style_metrics["aggression_index"] >= 65 else "low",
            "accent": "danger",
        },
        {
            "label": "Colour Comfort Gap",
            "value": f"{color_gap:.1f}%",
            "detail": f"White win rate {white_wr:.1f}% vs Black {black_wr:.1f}%.",
            "tone": "critical" if color_gap >= 12 else "low",
            "accent": "good",
        },
        {
            "label": "Opening Loyalty",
            "value": f"{style_metrics['opening_loyalty']:.0f}%",
            "detail": "How concentrated their openings are around a small recurring set.",
            "tone": "critical" if style_metrics["opening_loyalty"] >= 35 else "low",
            "accent": "blue",
        },
        {
            "label": "Endgame Grit",
            "value": round(style_metrics["endgame_grit"]),
            "detail": f"Average resignation move {round(resigned_move_avg) if resigned_move_avg else 0}, early resign rate {resigned_early_pct:.0f}%.",
            "tone": "critical" if style_metrics["endgame_grit"] >= 70 else "low",
            "accent": "good",
        },
        {
            "label": "Volatility Index",
            "value": round(style_metrics["volatility_index"]),
            "detail": f"Average game length {round(avg_game_moves)} moves with result swings tied to tactical games.",
            "tone": "critical" if style_metrics["volatility_index"] >= 65 else "low",
            "accent": "danger",
        },
    ]


def build_opening_advice(imported: ImportedGame, color: str, opening: str, reply_san: str, reply_count: int, engine: EngineSession) -> OpeningAdvice | None:
    board = imported.game.board()
    player_turn = chess.WHITE if color == "white" else chess.BLACK
    player_has_moved = False
    target_position: chess.Board | None = None

    for move in imported.game.mainline_moves():
        san = board.san(move)
        mover = board.turn
        board.push(move)
        if mover == player_turn:
            player_has_moved = True
        elif player_has_moved and san == reply_san:
            target_position = board.copy(stack=False)
            break

    if target_position is None:
        return None

    info = engine.analyse(target_position, multipv=1)[0]
    pv = info.get("pv") or []
    if not pv:
        return None

    best_move = pv[0]
    preview = target_position.copy(stack=False)
    best_san = preview.san(best_move)
    preview.push(best_move)

    line_moves = [best_san]
    follow_info = engine.analyse(preview, multipv=1)[0]
    follow_pv = follow_info.get("pv") or []
    temp = preview.copy(stack=False)
    for move in follow_pv[:4]:
        if move not in temp.legal_moves:
            break
        line_moves.append(temp.san(move))
        temp.push(move)

    explanation = (
        f"In your {opening} games as {color}, opponents often answer with {reply_san}. "
        f"Stockfish prefers {best_san} here because it keeps your position healthier and gives you the cleanest continuation."
    )
    return OpeningAdvice(
        opening=opening,
        color=color,
        opponent_reply=f"{reply_san} ({reply_count} games)",
        recommendation=best_san,
        explanation=explanation,
        example_line=" ".join(line_moves),
        position_fen=target_position.fen(),
    )


def analyse_games(games: list[ImportedGame], engine: EngineSession) -> dict[str, Any]:
    color_openings: Counter[tuple[str, str]] = Counter()
    opening_records: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    opening_responses: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    outcome_counter: Counter[str] = Counter()
    termination_counter: Counter[str] = Counter()
    first_move_white: Counter[str] = Counter()
    mistake_counter: Counter[str] = Counter()
    mistake_examples: dict[str, list[dict[str, Any]]] = defaultdict(list)
    advice: list[OpeningAdvice] = []

    total_games = len(games)
    total_player_moves = 0
    total_captures = 0
    total_checks = 0
    total_castles = 0
    early_queen_games = 0
    tactical_bursts: list[int] = []
    game_lengths: list[int] = []
    win_lengths: list[int] = []
    loss_lengths: list[int] = []
    clock_game_infos: list[dict[str, Any]] = []
    phase_ending_records: dict[str, Counter[str]] = defaultdict(Counter)
    phase_seconds: dict[str, list[float]] = defaultdict(list)
    clock_snapshots: dict[str, list[float]] = defaultdict(list)
    seconds_per_move_by_phase: dict[str, list[float]] = defaultdict(list)
    color_records: dict[str, Counter[str]] = {"white": Counter(), "black": Counter()}
    time_class_records: dict[str, Counter[str]] = defaultdict(Counter)
    hourly_records: dict[int, Counter[str]] = defaultdict(Counter)
    castling_moves: list[int] = []
    castle_side_counter: Counter[str] = Counter()
    resigned_loss_moves: list[int] = []
    rating_buckets: dict[str, Counter[str]] = defaultdict(Counter)

    for imported in games:
        game = imported.game
        board = game.board()
        opening = opening_name(imported)
        color = imported.player_color
        result = _classify_result(imported.result)
        outcome_counter[result] += 1
        color_openings[(color, opening)] += 1
        opening_records[(color, opening)][result] += 1
        color_records[color][result] += 1
        time_class_records[imported.time_class][result] += 1
        termination_counter[_termination_bucket(imported)] += 1

        if color == "white":
            first = _find_player_first_move(imported)
            if first:
                first_move_white[first] += 1

        player_elo = int(game.headers.get("WhiteElo", "0") if color == "white" else game.headers.get("BlackElo", "0") or 0)
        opponent_elo = int(game.headers.get("BlackElo", "0") if color == "white" else game.headers.get("WhiteElo", "0") or 0)
        if opponent_elo > player_elo + 50:
            rating_buckets["vs higher"][result] += 1
        elif opponent_elo < player_elo - 50:
            rating_buckets["vs lower"][result] += 1
        else:
            rating_buckets["vs equal"][result] += 1

        utc_time = game.headers.get("UTCTime", "")
        if utc_time:
            try:
                hour = int(utc_time.split(":", 1)[0])
                hourly_records[hour][result] += 1
            except ValueError:
                pass

        player_move_index = 0
        player_seen_queen = False
        player_castled = False
        first_reply = None
        line_prefix: list[str] = []
        burst = 0
        max_burst = 0

        clock_info = _extract_phase_clock_data(imported)
        clock_game_infos.append(clock_info)
        for key, value in clock_info["avg_remaining"].items():
            clock_snapshots[key].append(value)
        for phase, value in clock_info["seconds_per_move"].items():
            if value:
                seconds_per_move_by_phase[phase].append(value)

        for move in game.mainline_moves():
            mover = board.turn
            san = board.san(move)
            line_prefix.append(san)
            if mover == (chess.WHITE if color == "white" else chess.BLACK):
                before_move = board.copy(stack=False)
                total_player_moves += 1
                gave_check = board.gives_check(move)
                is_capture = board.is_capture(move)
                if is_capture:
                    total_captures += 1
                if gave_check:
                    total_checks += 1
                if is_capture or gave_check:
                    burst += 1
                    max_burst = max(max_burst, burst)
                else:
                    burst = 0

                if san in {"O-O", "O-O-O"}:
                    player_castled = True
                    total_castles += 1
                    castling_moves.append(player_move_index + 1)
                    castle_side_counter["kingside" if san == "O-O" else "queenside"] += 1
                piece = board.piece_at(move.from_square)
                if piece and piece.piece_type == chess.QUEEN and player_move_index < 6:
                    player_seen_queen = True

                info = engine.analyse(board, multipv=1)[0]
                pv = info.get("pv") or []
                best_move = pv[0] if pv else None
                score_before = _score_cp(info["score"], mover)
                board.push(move)
                if best_move:
                    next_info = engine.analyse(board, multipv=1)[0]
                    score_after = _score_cp(next_info["score"], mover)
                    loss = score_before - score_after
                    if move != best_move and loss >= 80:
                        phase = _phase_name(len(board.move_stack))
                        mistake_counter[phase] += 1
                        if len(mistake_examples[phase]) < 4:
                            best_san = before_move.san(best_move)
                            mistake_examples[phase].append(
                                {
                                    "played": san,
                                    "best": best_san,
                                    "best_uci": best_move.uci(),
                                    "loss_cp": loss,
                                    "line": " ".join(line_prefix[-10:]),
                                    "why": _why_note(phase, san, best_san, loss),
                                    "position_fen": before_move.fen(),
                                }
                            )
                player_move_index += 1
            else:
                if first_reply is None:
                    first_reply = san
                board.push(move)

        if not player_castled:
            castle_side_counter["no_castle"] += 1
        if player_seen_queen:
            early_queen_games += 1
        if first_reply:
            opening_responses[(color, opening)][first_reply] += 1

        total_moves = len(board.move_stack)
        phase_end = _phase_name(total_moves)
        phase_ending_records[phase_end][result] += 1
        phase_seconds[phase_end].append(clock_info["seconds_per_move"].get(phase_end, 0))

        total_full_moves = max(1, total_moves // 2)
        game_lengths.append(total_full_moves)
        if result == "win":
            win_lengths.append(total_full_moves)
        elif result == "loss":
            loss_lengths.append(total_full_moves)

        if result == "loss" and _termination_bucket(imported) == "resigned":
            resigned_loss_moves.append(total_full_moves)

        tactical_bursts.append(max_burst)

    for (color, opening), _count in color_openings.most_common(8):
        common_reply = opening_responses[(color, opening)].most_common(1)
        if not common_reply:
            continue
        reply, reply_count = common_reply[0]
        sample = next(
            (
                item
                for item in games
                if item.player_color == color and opening_name(item) == opening
            ),
            None,
        )
        if sample is None:
            continue
        advice_item = build_opening_advice(sample, color, opening, reply, reply_count, engine)
        if advice_item:
            advice.append(advice_item)

    improvements = []
    coach_positions = []
    total_mistakes = sum(mistake_counter.values())
    for phase, count in mistake_counter.most_common():
        examples = mistake_examples[phase]
        example = examples[0] if examples else None
        improvements.append(
            {
                "phase": phase,
                "count": count,
                "headline": _phase_headline(phase),
                "detail": example["why"] if example else "",
                "example": example,
            }
        )
        for index, mistake in enumerate(examples):
            coach_positions.append(
                {
                    "id": f"{phase}-{index}",
                    "phase": phase,
                    "headline": _phase_headline(phase),
                    "prompt": f"Find the best continuation in this {phase} position.",
                    "position_fen": mistake["position_fen"],
                    "played_move": mistake["played"],
                    "best_move": mistake["best"],
                    "best_move_uci": mistake["best_uci"],
                    "loss_cp": mistake["loss_cp"],
                    "line": mistake["line"],
                    "why": mistake["why"],
                }
            )

    capture_rate = (total_captures / total_player_moves) if total_player_moves else 0.0
    checks_per_game = (total_checks / total_games) if total_games else 0.0
    forcing_rate = ((total_captures + total_checks) / total_player_moves) if total_player_moves else 0.0
    avg_captures_per_game = (total_captures / total_games) if total_games else 0.0
    avg_burst = _safe_mean(tactical_bursts)
    avg_game_moves = _safe_mean(game_lengths)
    castle_rate = (total_castles / total_games) if total_games else 0.0
    queen_rate = (early_queen_games / total_games) if total_games else 0.0
    endgame_games = sum(phase_ending_records["endgame"].values())
    endgame_wr = _win_rate(phase_ending_records["endgame"])
    white_wr = _win_rate(color_records["white"])
    black_wr = _win_rate(color_records["black"])
    color_gap = abs(white_wr - black_wr)
    opening_loyalty = 0.0
    if total_games:
        top_opening_count = max((count for (_color, _opening), count in color_openings.items()), default=0)
        opening_loyalty = (top_opening_count / total_games) * 100
    avg_resignation_move = _safe_mean(resigned_loss_moves)
    early_resign_rate = 0.0
    if resigned_loss_moves:
        early_resign_rate = (sum(1 for value in resigned_loss_moves if value < 20) / len(resigned_loss_moves)) * 100

    clock_avg_remaining = {key: _safe_mean(values) for key, values in clock_snapshots.items()}
    burn_rate_pct = _clamp_pct(_safe_mean([info["burn_rate_pct"] for info in clock_game_infos]))
    sec_per_move = {phase: _safe_mean(values) for phase, values in seconds_per_move_by_phase.items()}

    style_metrics = {
        "capture_rate": round(capture_rate * 100, 1),
        "forcing_rate": round(forcing_rate * 100, 1),
        "checks_per_game": round(checks_per_game, 2),
        "avg_captures_per_game": round(avg_captures_per_game, 1),
        "tactical_bursts": round(avg_burst, 1),
        "clock_drain": round(burn_rate_pct, 1),
        "opening_loyalty": round(opening_loyalty, 1),
        "chaos_index": round(_clamp_pct(capture_rate * 220 + forcing_rate * 110 + avg_burst * 8), 1),
        "aggression_index": round(_clamp_pct(capture_rate * 180 + checks_per_game * 16 + avg_burst * 5), 1),
        "endgame_grit": round(_clamp_pct((endgame_wr * 0.65) + min(100, (avg_resignation_move or avg_game_moves) * 0.7) - early_resign_rate * 0.5), 1),
        "volatility_index": round(_clamp_pct(capture_rate * 180 + avg_burst * 10 + abs(white_wr - black_wr)), 1),
    }
    radar = _build_radar(style_metrics, round(castle_rate * 100, 1), round(queen_rate * 100, 1), avg_game_moves, endgame_wr, burn_rate_pct, (total_mistakes / total_games) if total_games else 0)
    dossier = _build_dossier(style_metrics, white_wr, black_wr, avg_game_moves, avg_resignation_move, early_resign_rate)

    top_openings_by_color = {
        side: [
            {
                "opening": opening,
                "count": count,
                "win_rate": round(_win_rate(opening_records[(side, opening)]), 1),
                "record": {
                    "wins": opening_records[(side, opening)]["win"],
                    "draws": opening_records[(side, opening)]["draw"],
                    "losses": opening_records[(side, opening)]["loss"],
                },
            }
            for (side_name, opening), count in color_openings.most_common()
            if side_name == side
        ][:8]
        for side in ("white", "black")
    }

    first_move_total = sum(first_move_white.values())
    first_move_items = [
        {"move": move, "count": count, "pct": round((count / first_move_total) * 100, 1) if first_move_total else 0}
        for move, count in first_move_white.most_common(6)
    ]

    phase_breakdown = []
    for phase in PHASES:
        record = phase_ending_records[phase]
        games_here = sum(record.values())
        phase_breakdown.append(
            {
                "phase": phase,
                "label": PHASE_LABELS[phase],
                "games": games_here,
                "pct": round((games_here / total_games) * 100, 1) if total_games else 0,
                "wins": record["win"],
                "losses": record["loss"],
                "draws": record["draw"],
                "avg_seconds_per_move": round(sec_per_move.get(phase, 0.0), 1),
            }
        )

    color_summary = {
        side: {
            "wins": color_records[side]["win"],
            "draws": color_records[side]["draw"],
            "losses": color_records[side]["loss"],
            "win_rate": round(_win_rate(color_records[side]), 1),
        }
        for side in ("white", "black")
    }
    better_as = "White" if color_summary["white"]["win_rate"] >= color_summary["black"]["win_rate"] else "Black"

    time_control_summary = [
        {
            "label": label,
            "games": rec["win"] + rec["loss"] + rec["draw"],
            "wins": rec["win"],
            "losses": rec["loss"],
            "draws": rec["draw"],
            "win_rate": round(_win_rate(rec), 1),
        }
        for label, rec in sorted(time_class_records.items(), key=lambda item: (item[1]["win"] + item[1]["loss"] + item[1]["draw"]), reverse=True)
    ]

    hourly_series = []
    best_hour = None
    worst_hour = None
    best_wr = -1.0
    worst_wr = 101.0
    for hour in range(24):
        rec = hourly_records[hour]
        total = rec["win"] + rec["loss"] + rec["draw"]
        wr = round(_win_rate(rec), 1) if total else None
        hourly_series.append({"hour": hour, "win_rate": wr, "games": total})
        if wr is None:
            continue
        if wr > best_wr:
            best_wr = wr
            best_hour = hour
        if wr < worst_wr:
            worst_wr = wr
            worst_hour = hour

    castle_avg_move = round(_safe_mean(castling_moves)) if castling_moves else 0
    early_castle_pct = round((sum(1 for move in castling_moves if move <= 8) / len(castling_moves)) * 100, 1) if castling_moves else 0
    late_castle_pct = round((sum(1 for move in castling_moves if move > 15) / len(castling_moves)) * 100, 1) if castling_moves else 0

    verdict = (
        f"{games[0].opponent if False else 'This player'} performs better as {better_as} "
        f"({color_summary['white']['win_rate']:.0f}% as White vs {color_summary['black']['win_rate']:.0f}% as Black)."
    )
    scout_brief = (
        f"{games[0].player_color if False else 'This player'} is most dangerous in {better_as.lower()} games, "
        f"wins {round(_win_rate(outcome_counter), 1) if isinstance(outcome_counter, dict) else round(_win_rate(outcome_counter), 1)}% overall, "
        f"and leans {'sharp' if style_metrics['chaos_index'] >= 60 else 'structured'} based on captures, forcing moves, and game length."
    )

    return {
        "games_analyzed": total_games,
        "outcomes": dict(outcome_counter),
        "hero_stats": {
            "win_rate": round(_win_rate(outcome_counter), 1),
            "chaos_index": round(style_metrics["chaos_index"]),
            "better_as": better_as,
        },
        "scout_brief": scout_brief,
        "verdict": verdict,
        "style_summary": _style_summary(castle_rate, queen_rate, capture_rate, checks_per_game, avg_game_moves, color_gap),
        "style_metrics": {
            "castle_rate": round(castle_rate * 100, 1),
            "early_queen_rate": round(queen_rate * 100, 1),
            "capture_rate": style_metrics["capture_rate"],
            "checks_per_game": round(checks_per_game, 2),
            "forcing_rate": style_metrics["forcing_rate"],
            "avg_captures_per_game": style_metrics["avg_captures_per_game"],
            "tactical_bursts": style_metrics["tactical_bursts"],
        },
        "radar": radar,
        "dossier": dossier,
        "first_move_repertoire": {
            "top_move": first_move_items[0] if first_move_items else None,
            "items": first_move_items,
            "total_games": first_move_total,
        },
        "top_openings_by_color": top_openings_by_color,
        "improvements": improvements,
        "coach_positions": coach_positions,
        "opening_advice": [asdict(entry) for entry in advice],
        "phase_breakdown": phase_breakdown,
        "game_length": {
            "avg_game": round(avg_game_moves),
            "avg_win": round(_safe_mean(win_lengths)),
            "avg_loss": round(_safe_mean(loss_lengths)),
            "endgame_wr": round(endgame_wr, 1),
            "endgame_games": endgame_games,
        },
        "resignation": {
            "avg_move": round(avg_resignation_move) if avg_resignation_move else 0,
            "early_rate": round(early_resign_rate, 1),
            "fighting_spirit": "High" if early_resign_rate <= 10 and (avg_resignation_move or avg_game_moves) >= 45 else "Medium",
        },
        "color_record": color_summary,
        "opponent_strength": [
            {
                "bucket": key,
                "win_rate": round(_win_rate(value), 1),
                "games": value["win"] + value["loss"] + value["draw"],
            }
            for key, value in [
                ("vs higher", rating_buckets["vs higher"]),
                ("vs equal", rating_buckets["vs equal"]),
                ("vs lower", rating_buckets["vs lower"]),
            ]
        ],
        "time_control": {
            "by_class": time_control_summary,
            "best_format": time_control_summary[0]["label"] if time_control_summary else "Unknown",
            "hourly": hourly_series,
            "best_hour": best_hour,
            "worst_hour": worst_hour,
        },
        "clock": {
            "avg_remaining": {key: _clock_hms(value) for key, value in clock_avg_remaining.items()},
            "burn_rate_pct": round(burn_rate_pct, 1),
            "seconds_per_move": {phase: round(value, 1) for phase, value in sec_per_move.items()},
        },
        "castling": {
            "avg_move": castle_avg_move,
            "rate": round(castle_rate * 100, 1),
            "early_pct": early_castle_pct,
            "late_pct": late_castle_pct,
            "kingside": castle_side_counter["kingside"],
            "queenside": castle_side_counter["queenside"],
            "no_castle": castle_side_counter["no_castle"],
        },
        "termination": dict(termination_counter),
    }
