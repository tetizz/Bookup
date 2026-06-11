const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const context = {
  console,
  setTimeout,
  clearTimeout,
  navigator: { hardwareConcurrency: 8 },
  DOMException,
  AbortController,
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, "docs/vendor/chess.min.js"), "utf8"), context);

class FakeStockfish {
  constructor(_url, signal) {
    this.signal = signal;
  }

  async initialize() {}

  async analyze(fen, options = {}) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (this.signal?.aborted) throw new DOMException("Stopped", "AbortError");
    const chess = new context.Chess(fen);
    const legal = chess.moves({ verbose: true })
      .sort((left, right) => `${left.from}${left.to}`.localeCompare(`${right.from}${right.to}`));
    const requested = options.searchMove
      ? legal.filter((move) => `${move.from}${move.to}${move.promotion || ""}` === options.searchMove)
      : legal.slice(0, Math.max(1, options.multiPv || 1));
    return requested.map((move, index) => ({
      scoreCp: 80 - index * 35,
      pv: [`${move.from}${move.to}${move.promotion || ""}`],
    }));
  }

  close() {}
}

context.BookupPositionAnalysis = { BrowserStockfish: FakeStockfish };
vm.runInContext(fs.readFileSync(path.join(root, "docs/smart-theory-engine.js"), "utf8"), context);

function check(name, condition, detail = "") {
  if (!condition) throw new Error(`FAIL ${name}: ${detail}`);
  console.log(`PASS ${name}`);
}

(async () => {
  const start = new context.Chess();
  const source = {
    type: "saved_line",
    id: "fixture",
    label: "Saved line fixture",
    fen: start.fen(),
    moves_uci: ["e2e4", "e7e5"],
    player_color: "white",
  };
  const tree = await context.BookupSmartTheory.generate({
    source,
    maxPly: 4,
    maxPositions: 16,
    opponentReplies: 3,
    opponentModel: "mixed",
    includeRare: true,
    includeMistakes: true,
    includeBlunders: true,
    includeBestEngineReplies: true,
    moveTimeMs: 80,
    stylePriors: new Map(),
    databaseReplies: async () => [],
  });
  check("generation_complete", tree.status === "complete");
  check("source_fen_stable", tree.start_fen === start.fen());
  const rootNode = tree.tree[tree.root_id];
  const first = tree.tree[rootNode.children[0]];
  check("saved_line_followed", first.uci === "e2e4" && first.source.label === "My saved line");
  check("opponent_engine_replies", first.children.length >= 2);
  for (const node of tree.nodes.filter((item) => item.parentId)) {
    const probe = new context.Chess(node.fenBefore);
    const move = probe.move({
      from: node.uci.slice(0, 2),
      to: node.uci.slice(2, 4),
      promotion: node.uci.slice(4, 5) || "q",
    });
    check(`legal_${node.id}`, Boolean(move) && probe.fen() === node.fenAfter);
  }

  const controller = new AbortController();
  const partial = await context.BookupSmartTheory.generate({
    source,
    maxPly: 12,
    maxPositions: 80,
    opponentReplies: 4,
    opponentModel: "mixed",
    includeRare: true,
    includeMistakes: true,
    includeBlunders: true,
    includeBestEngineReplies: true,
    moveTimeMs: 80,
    stylePriors: new Map(),
    signal: controller.signal,
    databaseReplies: async () => [],
    onProgress: ({ done }) => {
      if (done >= 3) controller.abort();
    },
  });
  check("stop_preserves_partial_tree", partial.status === "stopped" && partial.nodes.length >= 2);
  check("stop_records_warning", partial.warnings.some((warning) => warning.includes("partial tree")));
  console.log("ALL WEB SMART THEORY GENERATION CHECKS PASSED");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
