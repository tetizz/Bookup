(() => {
  "use strict";

  const SCHEMA_VERSION = 2;
  const SOURCE_LABELS = new Set([
    "My saved line",
    "My imported game",
    "My repertoire",
    "Stockfish correction",
    "Stockfish best move",
    "Opponent database reply",
    "Opponent best engine reply",
    "Fallback legal move",
  ]);
  const fenKey = (fen) => String(fen || "").split(" ").slice(0, 4).join(" ");
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const uciOf = (move) => move ? `${move.from}${move.to}${move.promotion || ""}` : "";
  const moveObject = (uci) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || "q" });
  const sleep = () => new Promise((resolve) => setTimeout(resolve, 0));

  function legalMove(chess, uci) {
    const probe = new Chess(chess.fen());
    const move = probe.move(moveObject(uci));
    return move ? { move, fenAfter: probe.fen(), chess: probe } : null;
  }

  function sourceMap(context) {
    const map = new Map();
    const chess = new Chess(context.fen);
    for (const raw of context.moves_uci || []) {
      const uci = String(raw || "").toLowerCase();
      const played = chess.move(moveObject(uci));
      if (!played) break;
      map.set(fenKey(played.before || new Chess(context.fen).fen()), uci);
    }
    const replay = new Chess(context.fen);
    map.clear();
    for (const raw of context.moves_uci || []) {
      const uci = String(raw || "").toLowerCase();
      map.set(fenKey(replay.fen()), uci);
      if (!replay.move(moveObject(uci))) {
        map.delete(fenKey(replay.fen()));
        break;
      }
    }
    return map;
  }

  function classifyLoss(loss) {
    if (loss <= 10) return "Best";
    if (loss <= 25) return "Excellent";
    if (loss <= 75) return "Good";
    if (loss <= 150) return "Inaccuracy";
    if (loss <= 300) return "Mistake";
    return "Blunder";
  }

  function whiteCp(line, turn) {
    const cp = Number(line?.scoreCp || 0);
    return turn === "w" ? cp : -cp;
  }

  function moverLoss(before, after, turn) {
    return Math.max(0, turn === "w" ? before - after : after - before);
  }

  function explanationFor({ san, source, classification, isUser, isBestReply, correction, response }) {
    const weak = ["Inaccuracy", "Mistake", "Blunder"].includes(classification);
    const summary = correction
      ? `${san} replaces ${correction.original} because the original move loses too much evaluation.`
      : isUser
      ? `${san} is the recommended continuation from this exact position.`
      : `${san} is a realistic opponent reply from this exact position.`;
    return {
      summary,
      why: correction
        ? `Stockfish prefers ${correction.corrected}; the saved move was classified ${correction.originalClass}.`
        : weak
        ? "This move gives the other side a concrete opportunity."
        : `${source} supports this move without leaving the selected branch.`,
      threat: isBestReply ? "This is the opponent's strongest engine resource and demands an accurate response." : "",
      response: response ? `Meet it with ${response}.` : "",
      plan: weak ? "Convert the concession before the opponent can recover." : "Continue development while preserving the position's main pawn breaks.",
    };
  }

  class StockfishPool {
    constructor({ workers = 1, signal, workerUrl } = {}) {
      const Engine = window.BookupPositionAnalysis?.BrowserStockfish;
      if (!Engine) throw new Error("Browser Stockfish is not available.");
      this.signal = signal;
      this.engines = Array.from({ length: clamp(workers, 1, 2) }, () => new Engine(workerUrl || "./vendor/stockfish/stockfish-18-lite-single.js", signal));
      this.chains = this.engines.map(() => Promise.resolve());
      this.cursor = 0;
    }

    async initialize() {
      await Promise.all(this.engines.map((engine) => engine.initialize()));
    }

    analyze(fen, options) {
      const index = this.cursor++ % this.engines.length;
      const task = this.chains[index].then(() => this.engines[index].analyze(fen, options));
      this.chains[index] = task.catch(() => {});
      return task;
    }

    close() {
      this.engines.forEach((engine) => engine.close());
    }
  }

  async function validateTree(payload) {
    if (!payload || typeof payload !== "object") throw new Error("Smart Theory import must be an object.");
    const raw = payload.tree && typeof payload.tree === "object"
      ? Object.values(payload.tree)
      : Array.isArray(payload.nodes) ? payload.nodes : [];
    if (!raw.length) throw new Error("Smart Theory import contains no nodes.");
    const rawMap = new Map(raw.filter(Boolean).map((node) => [String(node.id || ""), { ...node }]));
    let rootId = String(payload.root_id || "root");
    if (!rawMap.has(rootId)) {
      const roots = raw.filter((node) => !String(node.parentId || ""));
      if (roots.length !== 1) throw new Error("Smart Theory import must contain one root.");
      rootId = String(roots[0].id);
    }
    const rootRaw = rawMap.get(rootId);
    const rootFen = String(rootRaw.fenAfter || rootRaw.fenBefore || rootRaw.fen || payload.effective_start_fen || "");
    let rootChess;
    try {
      rootChess = new Chess(rootFen);
    } catch {
      throw new Error(`Root node ${rootId} has an invalid FEN.`);
    }
    const warnings = [];
    const tree = {};
    const nodes = [];
    const root = {
      ...rootRaw,
      id: rootId,
      parentId: "",
      fenBefore: rootChess.fen(),
      fenAfter: rootChess.fen(),
      fen: rootChess.fen(),
      move: null,
      san: "",
      uci: "",
      source: rootRaw.source || { key: "starting_source", label: "Current board" },
      classification: "Root",
      eval: rootRaw.eval || {},
      explanation: rootRaw.explanation || { summary: "Starting position.", why: "", threat: "", response: "", plan: "" },
      children: [],
    };
    tree[rootId] = root;
    nodes.push(root);
    const declaredChildren = (nodeId) => {
      const node = rawMap.get(nodeId);
      if (Array.isArray(node?.children)) return node.children.map(String);
      return raw.filter((child) => String(child.parentId || "") === nodeId).map((child) => String(child.id));
    };
    const seen = new Set([rootId]);
    const visit = (parentId, parentChess) => {
      for (const childId of declaredChildren(parentId)) {
        const rawChild = rawMap.get(childId);
        if (!rawChild || seen.has(childId)) {
          warnings.push(`Skipped duplicate or cyclic node ${childId}.`);
          continue;
        }
        if (String(rawChild.parentId || parentId) !== parentId) {
          warnings.push(`Skipped node ${childId} with a mismatched parent.`);
          continue;
        }
        const result = legalMove(parentChess, String(rawChild.uci || "").toLowerCase());
        if (!result) {
          warnings.push(`Skipped illegal node ${childId}.`);
          continue;
        }
        const declaredBefore = String(rawChild.fenBefore || parentChess.fen());
        const declaredAfter = String(rawChild.fenAfter || rawChild.fen || result.fenAfter);
        let canonicalBefore;
        let canonicalAfter;
        try {
          canonicalBefore = new Chess(declaredBefore).fen();
          canonicalAfter = new Chess(declaredAfter).fen();
        } catch {
          warnings.push(`Skipped node ${childId} with an invalid FEN.`);
          continue;
        }
        if (canonicalBefore !== parentChess.fen() || canonicalAfter !== result.fenAfter) {
          warnings.push(`Skipped node ${childId} because its FEN did not replay.`);
          continue;
        }
        const label = String(rawChild.source?.label || rawChild.source || "");
        const source = SOURCE_LABELS.has(label) ? (rawChild.source || { key: label.toLowerCase().replaceAll(" ", "_"), label }) : { key: "fallback_legal_move", label: "Fallback legal move" };
        const child = {
          ...rawChild,
          id: childId,
          parentId,
          fenBefore: parentChess.fen(),
          fenAfter: result.fenAfter,
          fen: result.fenAfter,
          move: { from: result.move.from, to: result.move.to, promotion: result.move.promotion || "" },
          san: String(rawChild.san || result.move.san),
          uci: uciOf(result.move),
          source,
          classification: String(rawChild.classification || "Good"),
          eval: rawChild.eval || {},
          explanation: rawChild.explanation || { summary: String(rawChild.theoryExplanation || ""), why: "", threat: "", response: "", plan: "" },
          children: [],
        };
        seen.add(childId);
        tree[childId] = child;
        nodes.push(child);
        tree[parentId].children.push(childId);
        visit(childId, result.chess);
      }
    };
    visit(rootId, rootChess);
    return {
      tree: {
        ...payload,
        schema_version: SCHEMA_VERSION,
        root_id: rootId,
        start_fen: rootChess.fen(),
        effective_start_fen: rootChess.fen(),
        nodes_total: nodes.length,
        nodes,
        tree,
        warnings: [...(payload.warnings || []), ...warnings],
      },
      warnings,
    };
  }

  async function generate(options) {
    const context = options.source;
    if (!context?.fen) throw new Error("Select a valid starting source.");
    const rootChess = new Chess(context.fen);
    const sourceMoves = sourceMap(context);
    const stylePriors = options.stylePriors instanceof Map ? options.stylePriors : new Map();
    const signal = options.signal;
    const workers = navigator.hardwareConcurrency >= 6 ? 2 : 1;
    const pool = new StockfishPool({ workers, signal, workerUrl: options.workerUrl });
    const cacheGet = options.cacheGet || (async () => null);
    const cacheSet = options.cacheSet || (async () => {});
    const warnings = [];
    let cacheHits = 0;
    let engineCalls = 0;
    let counter = 0;
    const nodes = [];
    const tree = {};
    const root = {
      id: "root",
      parentId: "",
      fenBefore: rootChess.fen(),
      fenAfter: rootChess.fen(),
      fen: rootChess.fen(),
      move: null,
      san: "",
      uci: "",
      source: { key: "starting_source", label: context.label || "Current board" },
      classification: "Root",
      eval: { beforeCp: 0, afterCp: 0, lossCp: 0, swingCp: 0 },
      explanation: { summary: "Selected starting position.", why: "Every branch begins here.", threat: "", response: "", plan: "Follow your known moves while they remain sound." },
      ply: 0,
      children: [],
    };
    nodes.push(root);
    tree.root = root;
    const queue = [{ parentId: "root", fen: rootChess.fen(), ply: 0 }];

    const analyze = async (fen, multiPv = 5) => {
      const key = `smart-v2:${fenKey(fen)}:${multiPv}:${options.moveTimeMs || 180}`;
      const cached = await cacheGet(key);
      if (Array.isArray(cached) && cached.length) {
        cacheHits += 1;
        return cached;
      }
      engineCalls += 1;
      const lines = await pool.analyze(fen, { multiPv, moveTimeMs: options.moveTimeMs || 180 });
      await cacheSet(key, lines);
      return lines;
    };

    await pool.initialize();
    try {
      while (queue.length && nodes.length < options.maxPositions) {
        if (signal?.aborted) throw new DOMException("Generation stopped.", "AbortError");
        const item = queue.shift();
        if (item.ply >= options.maxPly) continue;
        const chess = new Chess(item.fen);
        if (chess.game_over()) continue;
        let lines = await analyze(chess.fen(), Math.max(4, options.opponentReplies + 2));
        lines = lines.filter((line) => legalMove(chess, line.pv?.[0]));
        if (!lines.length) {
          const fallback = chess.moves({ verbose: true })[0];
          if (!fallback) continue;
          lines = [{ scoreCp: 0, pv: [uciOf(fallback)], fallback: true }];
          warnings.push(`Used a deterministic legal fallback at ${fenKey(chess.fen())}.`);
        }
        const turn = chess.turn();
        const isUser = (turn === "w") === (context.player_color !== "black");
        const beforeCp = whiteCp(lines[0], turn);
        const bestUci = String(lines[0].pv?.[0] || "");
        const exactUci = sourceMoves.get(fenKey(chess.fen())) || "";
        const style = stylePriors.get(fenKey(chess.fen())) || [];
        const styleUci = style[0]?.uci || "";
        const knownUci = exactUci || styleUci;
        const candidates = [];

        if (isUser) {
          let chosen = lines[0];
          let sourceLabel = "Stockfish best move";
          let classification = "Best";
          let correction = null;
          if (knownUci && legalMove(chess, knownUci)) {
            let knownLine = lines.find((line) => line.pv?.[0] === knownUci);
            if (!knownLine) {
              const after = legalMove(chess, knownUci);
              const replyLines = await analyze(after.fenAfter, 1);
              const afterWhiteCp = whiteCp(replyLines[0], after.chess.turn());
              knownLine = { scoreCp: turn === "w" ? afterWhiteCp : -afterWhiteCp, pv: [knownUci] };
            }
            const knownCp = whiteCp(knownLine, turn);
            const loss = moverLoss(beforeCp, knownCp, turn);
            classification = classifyLoss(loss);
            if (["Best", "Excellent", "Good"].includes(classification)) {
              chosen = knownLine;
              sourceLabel = exactUci
                ? ({ saved_line: "My saved line", imported_game: "My imported game", my_repertoire: "My repertoire" }[context.type] || "My repertoire")
                : "My repertoire";
            } else {
              sourceLabel = "Stockfish correction";
              correction = { original: knownUci, corrected: bestUci, originalClass: classification, loss };
              classification = "Best";
            }
          }
          candidates.push({ line: chosen, sourceLabel, classification, correction });
        } else {
          const database = await options.databaseReplies?.(chess.fen()) || [];
          const seen = new Set();
          if (options.includeBestEngineReplies !== false) {
            candidates.push({ line: lines[0], sourceLabel: "Opponent best engine reply", classification: "Best", isBest: true });
            seen.add(bestUci);
          }
          for (const reply of database) {
            const uci = String(reply.uci || "");
            if (!uci || seen.has(uci) || !legalMove(chess, uci)) continue;
            const line = lines.find((entry) => entry.pv?.[0] === uci) || { scoreCp: lines[0].scoreCp, pv: [uci] };
            const delta = Math.abs(Number(lines[0].scoreCp || 0) - Number(line.scoreCp || 0));
            const classification = lines.includes(line) ? classifyLoss(delta) : "Sideline";
            const allowed = ["Best", "Excellent", "Good", "Sideline"].includes(classification)
              || options.includeMistakes && ["Inaccuracy", "Mistake"].includes(classification)
              || options.includeBlunders && classification === "Blunder";
            if (!allowed) continue;
            candidates.push({ line, sourceLabel: "Opponent database reply", classification, database: reply });
            seen.add(uci);
          }
          candidates.splice(options.opponentReplies);
        }

        for (const candidate of candidates) {
          if (nodes.length >= options.maxPositions) break;
          const uci = String(candidate.line.pv?.[0] || "");
          const result = legalMove(chess, uci);
          if (!result) {
            warnings.push(`Skipped illegal generated move ${uci || "(empty)"}.`);
            continue;
          }
          const afterCp = whiteCp(candidate.line, turn);
          const loss = isUser ? moverLoss(beforeCp, afterCp, turn) : Math.abs(afterCp - beforeCp);
          counter += 1;
          const id = `n${counter}`;
          const responseLine = candidate.line.pv?.[1] || "";
          const response = responseLine ? legalMove(result.chess, responseLine)?.move?.san || responseLine : "";
          const explanation = explanationFor({
            san: result.move.san,
            source: candidate.sourceLabel,
            classification: candidate.classification,
            isUser,
            isBestReply: Boolean(candidate.isBest),
            correction: candidate.correction,
            response,
          });
          const node = {
            id,
            parentId: item.parentId,
            fenBefore: chess.fen(),
            fenAfter: result.fenAfter,
            fen: result.fenAfter,
            move: { from: result.move.from, to: result.move.to, promotion: result.move.promotion || "" },
            san: result.move.san,
            uci,
            source: { key: candidate.sourceLabel.toLowerCase().replaceAll(" ", "_"), label: candidate.sourceLabel },
            classification: candidate.classification,
            eval: { beforeCp, afterCp, lossCp: loss, swingCp: afterCp - beforeCp },
            explanation,
            evalBefore: beforeCp,
            evalAfter: afterCp,
            evalSwing: afterCp - beforeCp,
            bestMoveUci: bestUci,
            bestMoveSan: legalMove(chess, bestUci)?.move?.san || bestUci,
            principalVariationUci: candidate.line.pv || [],
            isUserSide: isUser,
            isOpponentSide: !isUser,
            isBestEngineReply: Boolean(candidate.isBest),
            isCorrectedMove: Boolean(candidate.correction),
            originalUserMove: candidate.correction?.original || "",
            correctedMove: candidate.correction?.corrected || "",
            recommendedResponseUci: !isUser ? responseLine : "",
            recommendedResponseSan: !isUser ? response : "",
            theoryExplanation: explanation.summary,
            whyMoveGoodOrBad: explanation.why,
            threatSummary: explanation.threat,
            bestResponseSummary: explanation.response,
            followUpPlan: explanation.plan,
            ply: item.ply + 1,
            children: [],
          };
          const verify = new Chess(node.fenBefore);
          if (!verify.move(moveObject(node.uci)) || verify.fen() !== node.fenAfter) {
            warnings.push(`Skipped node ${id} after replay validation failed.`);
            continue;
          }
          nodes.push(node);
          tree[id] = node;
          tree[item.parentId].children.push(id);
          if (node.ply < options.maxPly) queue.push({ parentId: id, fen: node.fenAfter, ply: node.ply });
        }
        options.onProgress?.({ done: nodes.length, queued: queue.length, cacheHits, engineCalls, workers });
        if (nodes.length % 4 === 0) await sleep();
      }
    } finally {
      pool.close();
    }
    const payload = {
      schema_version: SCHEMA_VERSION,
      status: signal?.aborted ? "stopped" : "complete",
      root_id: "root",
      start_fen: rootChess.fen(),
      effective_start_fen: rootChess.fen(),
      starting_source: context.type,
      source_context: context,
      nodes_total: nodes.length,
      nodes,
      tree,
      warnings,
      cache_hit_count: cacheHits,
      engine_calls: engineCalls,
      worker_count: workers,
    };
    return (await validateTree(payload)).tree;
  }

  window.BookupSmartTheory = {
    schemaVersion: SCHEMA_VERSION,
    generate,
    validateTree,
    fenKey,
  };
})();
