const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const webHtml = fs.readFileSync(path.join(root, "docs/index.html"), "utf8");
const desktopHtml = fs.readFileSync(path.join(root, "bookup/templates/index.html"), "utf8");
const webSource = fs.readFileSync(path.join(root, "docs/web-app.js"), "utf8");
const desktopSource = fs.readFileSync(path.join(root, "bookup/static/app.js"), "utf8");

function check(name, condition, detail = "") {
  if (!condition) throw new Error(`FAIL ${name}: ${detail}`);
  console.log(`PASS ${name}`);
}

function extractFunction(source, functionName) {
  const marker = `function ${functionName}(`;
  const startIndex = source.indexOf(marker);
  if (startIndex < 0) throw new Error(`FAIL missing function: ${functionName}`);
  const bodyStart = source.indexOf("{", source.indexOf(")", startIndex));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, index + 1);
    }
  }
  throw new Error(`FAIL incomplete function: ${functionName}`);
}

for (const [name, html] of [["web", webHtml], ["desktop", desktopHtml]]) {
  check(`${name}_train_next_actions`, html.includes('id="repertoireTrainNextBtn"') && html.includes('id="progressTrainNextBtn"'));
  check(`${name}_queue_summaries_announced`, /id="repertoireQueueSummary"[^>]*role="status"/.test(html) && /id="progressTrainingSummary"[^>]*role="status"/.test(html));
  check(`${name}_status_and_side_filters`, html.includes('data-repertoire-filter="needs_work"') && html.includes('data-repertoire-filter="all"') && ["all", "white", "black"].every((side) => html.includes(`data-repertoire-side="${side}"`)));
  check(`${name}_filters_expose_pressed_state`, (html.match(/data-repertoire-(?:filter|side)=/g) || []).length === (html.match(/<button(?=[^>]*data-repertoire-(?:filter|side)=)(?=[^>]*aria-pressed=)[^>]*>/g) || []).length);
  check(`${name}_show_more_controls_results`, /id="repertoireShowMoreBtn"[^>]*aria-controls="repertoireMapWhite repertoireMapBlack"/.test(html));
  check(`${name}_full_repertoire_collapsed`, /<details class="section-disclosure repertoire-library">/.test(html));
  check(`${name}_deep_progress_collapsed`, /<details id="progressDeepDetails" class="section-disclosure progress-deep-disclosure">/.test(html));
}

const stored = new Map();
const context = {
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  navigator: { hardwareConcurrency: 8, onLine: true },
  DOMException,
  AbortController,
  document: {
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; },
  },
  localStorage: {
    getItem(key) { return stored.get(key) || null; },
    setItem(key, value) { stored.set(key, value); },
    removeItem(key) { stored.delete(key); },
  },
  __BOOKUP_TEST__: true,
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, "docs/vendor/chess.min.js"), "utf8"), context);
vm.runInContext(webSource, context);

const hooks = context.BookupTrainerTestHooks;
const due = { lessonId: "due", lineStatus: "needs_work", repeatMistakeCount: 2, classification: { key: "mistake" }, priority: 20 };
const weak = { lessonId: "weak", lineStatus: "needs_work", repeatMistakeCount: 3, classification: { key: "blunder" }, priority: 90 };
const manual = { id: "manual", fen: new context.Chess().fen(), uci: "e2e4", savedAt: 10 };
check("web_due_target_wins", hooks.trainingNextTarget([due], [weak], { start: manual }).item.lessonId === "due");
check("web_weak_target_fallback", hooks.trainingNextTarget([], [weak], { start: manual }).item.lessonId === "weak");
check("web_manual_target_fallback", hooks.trainingNextTarget([], [], { start: manual }).type === "manual");
check("web_empty_target_disables_training", hooks.trainingNextTarget([], [], {}) === null);
check("web_results_are_bounded", webSource.includes(".slice(0, state.repertoireVisible)"));
check("web_show_more_is_incremental", webSource.includes("state.repertoireVisible += 8"));

const desktopContext = {};
vm.createContext(desktopContext);
vm.runInContext(`${extractFunction(desktopSource, "desktopTrainingNextTarget")}\nthis.pick = desktopTrainingNextTarget;`, desktopContext);
const pickDesktop = desktopContext.pick;
check("desktop_due_target_wins", pickDesktop([{ lesson_id: "due" }], [{ lesson_id: "new" }], {}).item.lesson_id === "due");
check("desktop_new_target_fallback", pickDesktop([], [{ lesson_id: "new" }], {}).item.lesson_id === "new");
check("desktop_manual_target_fallback", pickDesktop([], [], { key: { move_uci: "e2e4" } }).type === "manual");
check("desktop_empty_target_disables_training", pickDesktop([], [], {}) === null);
check("desktop_results_are_bounded", desktopSource.includes("].slice(0, state.repertoireVisible)"));
check("desktop_show_more_is_incremental", desktopSource.includes("state.repertoireVisible += 8"));
check("desktop_manual_positions_are_trainable", desktopSource.includes("function loadManualRepertoirePosition(positionKey, entry)"));

console.log("ALL TRAINING-FIRST WORKFLOW CHECKS PASSED");
