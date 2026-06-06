/* Bookup exact-position analysis.
 * Uses Stockfish.js 18 lite (GPLv3) in a Web Worker. The engine distribution
 * and license are stored in vendor/stockfish/.
 */
(() => {
  "use strict";

  const MAX_POSITIONS = 72;
  const MAX_OPENING_PLIES = 16;
  const REPEATED_POSITION_THRESHOLD = 2;

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
    buildPositionCandidates,
    constants: {
      maxPositions: MAX_POSITIONS,
      repeatedThreshold: REPEATED_POSITION_THRESHOLD,
    },
  };
})();
