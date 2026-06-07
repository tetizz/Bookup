/* Bookup exact-position analysis.
 * Uses Stockfish.js 18 lite (GPLv3) in a Web Worker. The engine distribution
 * and license are stored in vendor/stockfish/.
 */
(() => {
  "use strict";

  const MAX_POSITIONS = 72;
  const MAX_OPENING_PLIES = 16;
  const REPEATED_POSITION_THRESHOLD = 2;
  const ACCURACY_GAMES_PER_MODE = 5;
  const MAX_ACCURACY_MOVES = 180;
  const EXPECTED_POINTS_GRADIENT = 0.0035;
  const EXPECTED_POINTS_BANDS = [
    ["excellent", 0.02],
    ["good", 0.05],
    ["inaccuracy", 0.10],
    ["mistake", 0.20],
    ["blunder", 1],
  ];

  const fenKey = (fen) => String(fen || "").split(" ").slice(0, 4).join(" ");
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function stableHash(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function moveUci(move) {
    return move ? `${move.from}${move.to}${move.promotion || ""}` : "";
  }

  function resultBucket(game) {
    if (game.outcome === "win") return "wins";
    if (game.outcome === "loss") return "losses";
    return "draws";
  }

  function buildPositionCandidates(games) {
    const positions = new Map();
    games.forEach((game, gameIndex) => {
      const chess = new Chess();
      const playerTurn = game.color === "white" ? "w" : "b";
      const pathUci = [];
      const pathSan = [];
      let previousMove = "Start position";
      for (let ply = 0; ply < Math.min(MAX_OPENING_PLIES, game.moves.length); ply += 1) {
        const san = game.moves[ply];
        if (chess.turn() === playerTurn) {
          const key = fenKey(chess.fen());
          if (!positions.has(key)) {
            positions.set(key, {
              key,
              fen: chess.fen(),
              color: game.color,
              ply,
              triggerMove: previousMove,
              introUci: [...pathUci],
              introSan: [...pathSan],
              occurrences: 0,
              playerMoves: new Map(),
              playerSan: new Map(),
              firstSeenGame: gameIndex + 1,
              lastSeenGame: gameIndex + 1,
              firstSeenTime: game.endTime || 0,
              lastSeenTime: game.endTime || 0,
              results: { wins: 0, draws: 0, losses: 0 },
              openingName: game.headers?.Opening || game.headers?.ECOUrl?.split("/").at(-1)?.replaceAll("-", " ") || "Imported opening",
              openingCode: game.headers?.ECO || "",
            });
          }
          const position = positions.get(key);
          const probe = new Chess(chess.fen());
          const played = probe.move(san, { sloppy: true });
          if (played) {
            const uci = moveUci(played);
            position.occurrences += 1;
            position.playerMoves.set(uci, (position.playerMoves.get(uci) || 0) + 1);
            position.playerSan.set(uci, played.san);
            position.lastSeenGame = gameIndex + 1;
            position.lastSeenTime = game.endTime || position.lastSeenTime;
            position.results[resultBucket(game)] += 1;
          }
        }
        const played = chess.move(san, { sloppy: true });
        if (!played) break;
        previousMove = played.san;
        pathSan.push(played.san);
        pathUci.push(moveUci(played));
      }
    });

    return [...positions.values()]
      .filter((position) => position.occurrences >= REPEATED_POSITION_THRESHOLD && position.playerMoves.size)
      .sort((left, right) => (
        right.occurrences - left.occurrences
        || left.ply - right.ply
        || left.key.localeCompare(right.key)
      ))
      .slice(0, MAX_POSITIONS);
  }

  function parseInfo(line) {
    if (!line.startsWith("info ") || !line.includes(" pv ")) return null;
    const depth = Number(line.match(/\bdepth\s+(\d+)/)?.[1] || 0);
    const multiPv = Number(line.match(/\bmultipv\s+(\d+)/)?.[1] || 1);
    const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/);
    const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/);
    const pv = line.split(/\spv\s/, 2)[1]?.trim().split(/\s+/).filter(Boolean) || [];
    if (!pv.length || (!cpMatch && !mateMatch)) return null;
    const scoreCp = cpMatch
      ? Number(cpMatch[1])
      : (Number(mateMatch[1]) > 0 ? 100000 - Math.abs(Number(mateMatch[1])) : -100000 + Math.abs(Number(mateMatch[1])));
    return { depth, multiPv, scoreCp, mate: mateMatch ? Number(mateMatch[1]) : null, pv };
  }

  class BrowserStockfish {
    constructor(workerUrl, signal) {
      this.worker = new Worker(workerUrl);
      this.lines = [];
      this.waiters = [];
      this.signal = signal;
      this.worker.addEventListener("message", (event) => this.handleLine(String(event.data || "")));
      this.worker.addEventListener("error", (event) => {
        this.rejectAll(new Error(event.message || "Browser Stockfish could not start."));
      });
      signal?.addEventListener("abort", () => {
        this.rejectAll(new DOMException("Analysis stopped.", "AbortError"));
        this.worker.terminate();
      }, { once: true });
    }

    handleLine(line) {
      this.lines.push(line);
      const remaining = [];
      for (const waiter of this.waiters) {
        if (waiter.predicate(line)) waiter.resolve(line);
        else remaining.push(waiter);
      }
      this.waiters = remaining;
    }

    rejectAll(error) {
      this.waiters.splice(0).forEach((waiter) => waiter.reject(error));
    }

    send(command) {
      if (this.signal?.aborted) throw new DOMException("Analysis stopped.", "AbortError");
      this.worker.postMessage(command);
    }

    waitFor(predicate, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new Error("Browser Stockfish timed out."));
        }, timeoutMs);
        const waiter = {
          predicate,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        this.waiters.push(waiter);
      });
    }

    async initialize() {
      this.send("uci");
      await this.waitFor((line) => line === "uciok", 30000);
      this.send("setoption name Threads value 1");
      this.send("setoption name Hash value 32");
      this.send("isready");
      await this.waitFor((line) => line === "readyok", 30000);
    }

    async analyze(fen, { multiPv = 3, moveTimeMs = 180, searchMove = "" } = {}) {
      this.lines = [];
      this.send(`setoption name MultiPV value ${Math.max(1, multiPv)}`);
      this.send(`position fen ${fen}`);
      const command = `go movetime ${Math.max(80, moveTimeMs)}${searchMove ? ` searchmoves ${searchMove}` : ""}`;
      const done = this.waitFor((line) => line.startsWith("bestmove "), 30000);
      this.send(command);
      await done;
      const byPv = new Map();
      this.lines.map(parseInfo).filter(Boolean).forEach((info) => {
        const current = byPv.get(info.multiPv);
        if (!current || info.depth >= current.depth) byPv.set(info.multiPv, info);
      });
      return [...byPv.values()].sort((left, right) => left.multiPv - right.multiPv);
    }

    close() {
      try { this.send("quit"); } catch { /* Worker may already be closed. */ }
      this.worker.terminate();
    }
  }

  function lineSan(fen, pv) {
    const chess = new Chess(fen);
    const san = [];
    const legalUci = [];
    for (const uci of pv) {
      const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || "q" });
      if (!move) break;
      san.push(move.san);
      legalUci.push(uci);
    }
    return { san, uci: legalUci };
  }

  function classifyLoss(valueLostCp) {
    if (valueLostCp <= 20) return { key: "best", label: "Best" };
    if (valueLostCp <= 50) return { key: "good", label: "Good" };
    if (valueLostCp <= 100) return { key: "inaccuracy", label: "Inaccuracy" };
    if (valueLostCp <= 200) return { key: "mistake", label: "Mistake" };
    return { key: "blunder", label: "Blunder" };
  }

  function expectedPoints(scoreCp) {
    const bounded = clamp(Number(scoreCp) || 0, -4000, 4000);
    return 1 / (1 + Math.exp(-EXPECTED_POINTS_GRADIENT * bounded));
  }

  function classifyExpectedLoss(loss, isBestMove) {
    if (isBestMove) return { key: "best", label: "Best" };
    const key = EXPECTED_POINTS_BANDS.find(([, ceiling]) => loss <= ceiling)?.[0] || "blunder";
    return { key, label: key.charAt(0).toUpperCase() + key.slice(1) };
  }

  function moveAccuracy(loss, isPerfect) {
    if (isPerfect) return 100;
    return clamp(100 * Math.exp(-4 * Math.max(0, loss)), 0, 100);
  }

  function materialProfile(chess) {
    const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    let nonPawn = 0;
    let pieces = 0;
    let queens = 0;
    chess.board().flat().filter(Boolean).forEach((piece) => {
      pieces += 1;
      if (piece.type === "q") queens += 1;
      if (piece.type !== "p" && piece.type !== "k") nonPawn += values[piece.type] || 0;
    });
    return { nonPawn, pieces, queens };
  }

  function positionPhase(chess, ply, previousPhase, hasOpeningName) {
    if (previousPhase === "endgame") return "endgame";
    const material = materialProfile(chess);
    if (
      (material.queens === 0 && material.nonPawn <= 22)
      || material.pieces <= 10
      || (material.queens <= 1 && material.nonPawn <= 15)
    ) return "endgame";
    if (previousPhase === "middlegame") return "middlegame";
    const openingLimit = hasOpeningName ? 18 : 12;
    return ply < openingLimit ? "opening" : "middlegame";
  }

  function buildOpeningFrequency(games) {
    const positions = new Map();
    games.forEach((game) => {
      const chess = new Chess();
      for (let ply = 0; ply < Math.min(20, game.moves.length); ply += 1) {
        const fen = fenKey(chess.fen());
        const played = chess.move(game.moves[ply], { sloppy: true });
        if (!played) break;
        const uci = moveUci(played);
        const key = `${fen}:${uci}`;
        positions.set(key, (positions.get(key) || 0) + 1);
      }
    });
    return positions;
  }

  function selectAccuracyGames(games, perMode = ACCURACY_GAMES_PER_MODE) {
    const modes = [...new Set(games.map((game) => game.timeClass).filter(Boolean))];
    return modes.flatMap((mode) => games.filter((game) => game.timeClass === mode).slice(-perMode))
      .sort((left, right) => left.endTime - right.endTime);
  }

  function summarizeAccuracy(games) {
    const moves = games.flatMap((game) => game.moveAnalysis || []);
    const phaseStats = {};
    ["opening", "middlegame", "endgame"].forEach((phase) => {
      const phaseMoves = moves.filter((move) => move.phase === phase);
      phaseStats[phase] = {
        accuracy: phaseMoves.length
          ? phaseMoves.reduce((sum, move) => sum + move.accuracy, 0) / phaseMoves.length
          : null,
        moves: phaseMoves.length,
      };
    });
    const classifications = {};
    moves.forEach((move) => {
      classifications[move.classification.key] = (classifications[move.classification.key] || 0) + 1;
    });
    return {
      average: moves.length ? moves.reduce((sum, move) => sum + move.accuracy, 0) / moves.length : null,
      moves: moves.length,
      games: games.length,
      phaseStats,
      classifications,
      perfectMoves: moves.filter((move) => move.accuracy === 100).length,
    };
  }

  async function analyzeGameAccuracy(games, options = {}) {
    const selected = selectAccuracyGames(games, options.gamesPerMode || ACCURACY_GAMES_PER_MODE);
    const openingFrequency = buildOpeningFrequency(games);
    const totalPlayerMoves = selected.reduce((sum, game) => (
      sum + game.moves.filter((_, ply) => ply % 2 === (game.color === "white" ? 0 : 1)).length
    ), 0);
    const moveLimit = Math.min(MAX_ACCURACY_MOVES, options.maxMoves || MAX_ACCURACY_MOVES);
    if (!selected.length || !totalPlayerMoves) {
      return { games: [], summary: summarizeAccuracy([]), cacheHits: 0, analyzed: 0, truncated: false };
    }

    const engine = new BrowserStockfish(options.workerUrl || "./vendor/stockfish/stockfish-18-lite-single.js", options.signal);
    const analyzedGames = [];
    let cacheHits = 0;
    let analyzed = 0;
    let completed = 0;
    await engine.initialize();
    try {
      for (const game of selected) {
        if (completed >= moveLimit) break;
        const chess = new Chess();
        const playerTurn = game.color === "white" ? "w" : "b";
        const moveAnalysis = [];
        let phase = "opening";
        const hasOpeningName = Boolean(game.headers?.ECO || game.headers?.Opening || game.headers?.ECOUrl);
        for (let ply = 0; ply < game.moves.length; ply += 1) {
          if (options.signal?.aborted) throw new DOMException("Analysis stopped.", "AbortError");
          const fen = chess.fen();
          phase = positionPhase(chess, ply, phase, hasOpeningName);
          const played = chess.move(game.moves[ply], { sloppy: true });
          if (!played) break;
          if (fen.split(" ")[1] !== playerTurn) continue;
          if (completed >= moveLimit) break;
          const uci = moveUci(played);
          const cacheKey = `accuracy-stockfish18:${fenKey(fen)}:${uci}:${options.moveTimeMs || 120}`;
          let evaluation = await options.readCache?.(cacheKey);
          if (evaluation) {
            cacheHits += 1;
          } else {
            const rootLines = await engine.analyze(fen, {
              multiPv: 3,
              moveTimeMs: options.moveTimeMs || 120,
            });
            let playedLine = rootLines.find((line) => line.pv[0] === uci) || null;
            if (!playedLine) {
              playedLine = (await engine.analyze(fen, {
                multiPv: 1,
                moveTimeMs: options.moveTimeMs || 120,
                searchMove: uci,
              }))[0] || null;
            }
            evaluation = { rootLines, playedLine };
            analyzed += 1;
            await options.writeCache?.(cacheKey, evaluation);
          }
          const best = evaluation.rootLines?.[0];
          if (!best || !evaluation.playedLine) continue;
          const bestUci = best.pv?.[0] || "";
          const loss = Math.max(0, expectedPoints(best.scoreCp) - expectedPoints(evaluation.playedLine.scoreCp));
          const repeatedBookMove = (openingFrequency.get(`${fenKey(fen)}:${uci}`) || 0) >= 2;
          const isBook = phase === "opening"
            && hasOpeningName
            && ply < 18
            && loss <= 0.05
            && (repeatedBookMove || (ply < 10 && loss <= 0.02));
          const isBest = uci === bestUci || Math.abs(best.scoreCp - evaluation.playedLine.scoreCp) <= 8;
          const classification = isBook
            ? { key: "book", label: "Book" }
            : classifyExpectedLoss(loss, isBest);
          const accuracy = moveAccuracy(loss, isBook || isBest);
          moveAnalysis.push({
            ply,
            moveNumber: Math.floor(ply / 2) + 1,
            san: played.san,
            uci,
            fen,
            phase,
            accuracy: Math.round(accuracy * 10) / 10,
            expectedPointsLoss: Math.round(loss * 10000) / 10000,
            centipawnLoss: Math.max(0, Math.round(best.scoreCp - evaluation.playedLine.scoreCp)),
            bestMoveUci: bestUci,
            bestMoveSan: lineSan(fen, [bestUci]).san[0] || bestUci,
            classification,
          });
          completed += 1;
          options.onProgress?.({
            done: completed,
            total: Math.min(totalPlayerMoves, moveLimit),
            game,
            move: moveAnalysis.at(-1),
          });
          if (completed % 6 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (moveAnalysis.length) {
          const phaseAccuracy = {};
          ["opening", "middlegame", "endgame"].forEach((phaseName) => {
            const phaseMoves = moveAnalysis.filter((move) => move.phase === phaseName);
            phaseAccuracy[phaseName] = phaseMoves.length
              ? phaseMoves.reduce((sum, move) => sum + move.accuracy, 0) / phaseMoves.length
              : null;
          });
          analyzedGames.push({
            id: game.id,
            endTime: game.endTime,
            timeClass: game.timeClass,
            outcome: game.outcome,
            rating: game.rating,
            openingName: game.headers?.Opening || game.headers?.ECOUrl?.split("/").at(-1)?.replaceAll("-", " ") || "Imported game",
            accuracy: moveAnalysis.reduce((sum, move) => sum + move.accuracy, 0) / moveAnalysis.length,
            phaseAccuracy,
            moveAnalysis,
          });
        }
      }
    } finally {
      engine.close();
    }
    return {
      games: analyzedGames,
      summary: summarizeAccuracy(analyzedGames),
      cacheHits,
      analyzed,
      truncated: totalPlayerMoves > completed,
    };
  }

  function createLesson(position, rootLines, playedLine) {
    const best = rootLines[0];
    if (!best?.pv?.length) return null;
    const topMove = [...position.playerMoves.entries()].sort((left, right) => right[1] - left[1])[0];
    if (!topMove) return null;
    const [yourMoveUci, yourMoveCount] = topMove;
    const bestMoveUci = best.pv[0];
    const bestMoveSan = lineSan(position.fen, [bestMoveUci]).san[0] || bestMoveUci;
    const yourMoveSan = position.playerSan.get(yourMoveUci) || yourMoveUci;
    const inRoot = rootLines.find((line) => line.pv[0] === yourMoveUci);
    const yourScore = inRoot?.scoreCp ?? playedLine?.scoreCp ?? best.scoreCp;
    const valueLostCp = Math.max(0, best.scoreCp - yourScore);
    const repeatBestCount = position.playerMoves.get(bestMoveUci) || 0;
    const repeatMistakeCount = yourMoveUci === bestMoveUci ? 0 : yourMoveCount;
    const lineStatus = repeatMistakeCount >= REPEATED_POSITION_THRESHOLD
      ? "needs_work"
      : (repeatBestCount >= 100 ? "known" : "new");
    const continuation = lineSan(position.fen, best.pv.slice(0, 8));
    const classification = classifyLoss(valueLostCp);
    const confidence = clamp(
      18
      + Math.min(35, position.occurrences * 2.2)
      + Math.min(45, (repeatBestCount / position.occurrences) * 45)
      - Math.min(25, (repeatMistakeCount / position.occurrences) * 25)
      - Math.min(20, valueLostCp / 10),
      0,
      100
    );
    const priority = (
      position.occurrences * 10
      + Math.min(valueLostCp / 10, 60)
      + (lineStatus === "needs_work" ? 25 : 0)
      - (lineStatus === "known" ? 40 : 0)
    );
    const intro = position.introSan.slice(-6).join(" ");
    return {
      lessonId: `${position.color}:${stableHash(position.key)}:${bestMoveUci}`,
      positionFen: position.fen,
      decisionFen: position.fen,
      color: position.color,
      ply: position.ply,
      openingName: position.openingName,
      openingCode: position.openingCode,
      lineLabel: intro || position.triggerMove || "Repeated position",
      triggerMove: position.triggerMove,
      introLineSan: position.introSan.join(" "),
      introLineUci: position.introUci,
      recommendedMove: bestMoveSan,
      recommendedMoveUci: bestMoveUci,
      yourRepeatedMove: yourMoveSan,
      yourRepeatedMoveUci: yourMoveUci,
      continuationSan: continuation.san.join(" "),
      continuationMovesUci: continuation.uci,
      trainingLineUci: continuation.uci,
      frequency: position.occurrences,
      repeatCount: repeatBestCount,
      repeatMistakeCount,
      valueLostCp,
      priority: Math.round(priority * 10) / 10,
      confidence: Math.round(confidence * 10) / 10,
      lineStatus,
      classification,
      recommendedClassification: { key: "best", label: "Best" },
      firstSeenGame: position.firstSeenGame,
      lastSeenGame: position.lastSeenGame,
      firstSeenTime: position.firstSeenTime,
      lastSeenTime: position.lastSeenTime,
      resultBreakdown: position.results,
      candidateLines: rootLines.map((line) => {
        const converted = lineSan(position.fen, line.pv.slice(0, 8));
        return {
          uci: line.pv[0],
          move: converted.san[0] || line.pv[0],
          scoreCp: line.scoreCp,
          mate: line.mate,
          lineUci: converted.uci,
          lineSan: converted.san.join(" "),
        };
      }),
    };
  }

  async function analyzeImportedGames(games, options = {}) {
    const candidates = buildPositionCandidates(games);
    const lessons = [];
    if (!candidates.length) {
      return { candidates: 0, lessons, due: [], fresh: [], known: [], cacheHits: 0, analyzed: 0 };
    }
    const engine = new BrowserStockfish(options.workerUrl || "./vendor/stockfish/stockfish-18-lite-single.js", options.signal);
    let cacheHits = 0;
    let analyzed = 0;
    await engine.initialize();
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        if (options.signal?.aborted) throw new DOMException("Analysis stopped.", "AbortError");
        const position = candidates[index];
        const cacheKey = `stockfish18-lite:${fenKey(position.fen)}:${options.moveTimeMs || 180}`;
        let evaluation = await options.readCache?.(cacheKey);
        if (evaluation) {
          cacheHits += 1;
        } else {
          const rootLines = await engine.analyze(position.fen, {
            multiPv: 3,
            moveTimeMs: options.moveTimeMs || 180,
          });
          const topMove = [...position.playerMoves.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
          let playedLine = rootLines.find((line) => line.pv[0] === topMove) || null;
          if (topMove && !playedLine) {
            playedLine = (await engine.analyze(position.fen, {
              multiPv: 1,
              moveTimeMs: options.moveTimeMs || 180,
              searchMove: topMove,
            }))[0] || null;
          }
          evaluation = { rootLines, playedLine };
          analyzed += 1;
          await options.writeCache?.(cacheKey, evaluation);
        }
        const lesson = createLesson(position, evaluation.rootLines || [], evaluation.playedLine || null);
        if (lesson) lessons.push(lesson);
        options.onProgress?.({
          done: index + 1,
          total: candidates.length,
          lessons: lessons.length,
          position,
        });
        if (index % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      engine.close();
    }
    lessons.sort((left, right) => right.priority - left.priority || right.frequency - left.frequency);
    return {
      candidates: candidates.length,
      lessons,
      due: lessons.filter((lesson) => lesson.lineStatus === "needs_work"),
      fresh: lessons.filter((lesson) => lesson.lineStatus === "new"),
      known: lessons.filter((lesson) => lesson.lineStatus === "known"),
      cacheHits,
      analyzed,
    };
  }

  window.BookupPositionAnalysis = {
    analyzeImportedGames,
    analyzeGameAccuracy,
    buildPositionCandidates,
    constants: {
      maxPositions: MAX_POSITIONS,
      repeatedThreshold: REPEATED_POSITION_THRESHOLD,
      accuracyGamesPerMode: ACCURACY_GAMES_PER_MODE,
      maxAccuracyMoves: MAX_ACCURACY_MOVES,
    },
  };
})();
