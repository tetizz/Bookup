const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.resolve(__dirname, "..");
const context = {
  console,
  setTimeout,
  clearTimeout,
  navigator: { hardwareConcurrency: 8 },
  DOMException,
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, "docs/vendor/chess.min.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(path.join(root, "docs/smart-theory-engine.js"), "utf8"), context);

function check(name, condition, detail = "") {
  if (!condition) throw new Error(`FAIL ${name}: ${detail}`);
  console.log(`PASS ${name}`);
}

(async () => {
  const chess = new context.Chess();
  const before = chess.fen();
  const move = chess.move({ from: "e2", to: "e4" });
  const after = chess.fen();
  const payload = {
    schema_version: 2,
    root_id: "root",
    nodes: [
      { id: "root", parentId: "", fenBefore: before, fenAfter: before, children: ["good", "bad"] },
      {
        id: "good",
        parentId: "root",
        fenBefore: before,
        fenAfter: after,
        uci: "e2e4",
        san: move.san,
        source: { key: "my_repertoire", label: "My repertoire" },
        classification: "Good",
        children: [],
      },
      {
        id: "bad",
        parentId: "root",
        fenBefore: before,
        fenAfter: before,
        uci: "e2e5",
        source: "bad source",
        children: [],
      },
    ],
  };
  const result = await context.BookupSmartTheory.validateTree(payload);
  check("schema_v2", result.tree.schema_version === 2);
  check("valid_edge_kept", result.tree.nodes.some((node) => node.id === "good"));
  check("illegal_edge_skipped", !result.tree.nodes.some((node) => node.id === "bad"));
  check("child_ids_canonical", result.tree.tree.root.children.length === 1 && result.tree.tree.root.children[0] === "good");
  check("fen_replayed", result.tree.tree.good.fenAfter === after);
  check("warnings_recorded", result.warnings.length >= 1);
  console.log("ALL WEB SMART THEORY SCHEMA CHECKS PASSED");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
