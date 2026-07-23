const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "docs/index.html"), "utf8");
const source = fs.readFileSync(path.join(root, "docs/web-app.js"), "utf8");
const desktopHtml = fs.readFileSync(path.join(root, "bookup/templates/index.html"), "utf8");
const desktopSource = fs.readFileSync(path.join(root, "bookup/static/app.js"), "utf8");
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
vm.runInContext(source, context);

function check(name, condition, detail = "") {
  if (!condition) throw new Error(`FAIL ${name}: ${detail}`);
  console.log(`PASS ${name}`);
}

const hooks = context.BookupTrainerTestHooks;
check("test_hooks_loaded", Boolean(hooks));

const start = new context.Chess();
const startFen = start.fen();
const whiteManual = hooks.manualEntryPlan({
  fen: startFen,
  uci: "e2e4",
  playerColor: "white",
});
check("white_manual_exact_turn", whiteManual.ok && whiteManual.color === "white" && whiteManual.move.san === "e4");

const wrongColorManual = hooks.manualEntryPlan({
  fen: startFen,
  uci: "e2e4",
  playerColor: "black",
});
check("wrong_color_manual_rejected", !wrongColorManual.ok && /white to move/i.test(wrongColorManual.message));

start.move("e4");
const blackManual = hooks.manualEntryPlan({
  fen: start.fen(),
  uci: "e7e5",
  playerColor: "black",
});
check("black_manual_exact_turn", blackManual.ok && blackManual.color === "black" && blackManual.move.san === "e5");

const autoReplyLesson = hooks.lessonStartPlan({
  decisionFen: startFen,
  color: "black",
  trainingLineUci: ["e2e4", "e7e5"],
  recommendedMoveUci: "e7e5",
});
check("black_lesson_auto_reply_plan", autoReplyLesson.ok && autoReplyLesson.autoReplyPlies === 1);

const impossibleLesson = hooks.lessonStartPlan({
  decisionFen: startFen,
  color: "black",
  trainingLineUci: ["e2e4"],
  recommendedMoveUci: "e2e4",
});
check("lesson_without_user_turn_rejected", !impossibleLesson.ok);

check(
  "white_board_axes",
  hooks.boardAxes("white").files.join("") === "abcdefgh" && hooks.boardAxes("white").ranks.join("") === "87654321"
);
check(
  "black_board_axes",
  hooks.boardAxes("black").files.join("") === "hgfedcba" && hooks.boardAxes("black").ranks.join("") === "12345678"
);
check(
  "square_accessible_name",
  hooks.squareAccessibilityLabel("e2", { color: "w", type: "p" }, false, false) === "e2, White pawn"
);
check("storage_success_reported", hooks.flushSave() === true);
const originalSetItem = context.localStorage.setItem;
context.localStorage.setItem = () => { throw new Error("quota"); };
check("storage_failure_reported", hooks.flushSave() === false);
context.localStorage.setItem = originalSetItem;
check(
  "workspace_cache_key_changes_with_scope",
  hooks.workspaceCacheKey("Example", { timeClasses: ["rapid"], maxGames: 240, importAllGames: false })
    !== hooks.workspaceCacheKey("Example", { timeClasses: ["blitz"], maxGames: 240, importAllGames: false })
    && hooks.workspaceCacheKey("Example", { timeClasses: ["rapid"], maxGames: 240, importAllGames: false })
      !== hooks.workspaceCacheKey("Example", { timeClasses: ["rapid"], maxGames: 500, importAllGames: false }),
);

check("workspace_tablist_named", /class="workspace-tabs"[^>]*role="tablist"[^>]*aria-label="Bookup workspace"/.test(html));
check("workspace_tabs_selected", (html.match(/role="tab"/g) || []).length === 5 && /aria-selected="true"/.test(html));
check("workspace_panels_linked", (html.match(/role="tabpanel"/g) || []).length === 5 && (html.match(/data-tab-panel=/g) || []).length === 5);
check("workspace_notice_announced", /id="workspaceNotice"[^>]*role="status"[^>]*aria-live="polite"/.test(html));
check("progress_modes_pressed_group", /class="progress-mode-tabs"[^>]*role="group"/.test(html) && (html.match(/aria-pressed=/g) || []).length >= 3);
check("single_visible_username", /id="mainUsernameInput"[^>]*type="text"/.test(html) && /id="usernameInput"[^>]*type="hidden"/.test(html));
check("fixed_platform_hidden", /id="mainPlatformInput"[^>]*type="hidden"[^>]*value="chesscom"/.test(html));
check(
  "time_class_toggles_first_class",
  ["rapid", "blitz", "bullet", "daily"].every((mode) => html.includes(`data-time-class-toggle="${mode}"`))
    && /id="timeClassesInput"[^>]*type="hidden"/.test(html)
    && html.includes("data-time-class-all")
);
check("trainer_board_named", /id="board"[^>]*role="group"[^>]*aria-describedby="trainerDecision trainerFeedback"/.test(html));
check("trainer_feedback_announced", /id="trainerDecision"[^>]*role="status"/.test(html) && /id="trainerFeedback"[^>]*role="status"/.test(html));
check("roving_square_focus_implemented", /node\.tabIndex = square === focusedSquare \? 0 : -1/.test(source));
check("orientation_keyboard_handler_bound", /board\?\.addEventListener\("keydown", handleBoardKeydown\)/.test(source));
check("time_class_toggle_handler_bound", /button\.addEventListener\("click", \(\) => toggleTimeClass\(button\)\)/.test(source));
check("decorative_piece_images_hidden", /alt="" aria-hidden="true"/.test(source));
check(
  "saved_lichess_token_can_be_removed",
  /id="clearLichessTokenBtn"/.test(desktopHtml) &&
    /body:\s*JSON\.stringify\(\{\s*lichess_token:\s*""\s*\}\)/.test(desktopSource) &&
    desktopSource.includes("A Lichess Study token from the environment remains active"),
);
check(
  "desktop_workspace_accessible",
  /class="workspace-tabs"[^>]*role="tablist"/.test(desktopHtml) &&
    (desktopHtml.match(/role="tabpanel"/g) || []).length === 5 &&
    /id="mainUsernameInput"[^>]*type="text"/.test(desktopHtml) &&
    /id="usernameInput"[^>]*type="hidden"/.test(desktopHtml),
);
check(
  "desktop_time_controls_are_buttons",
  ["rapid", "blitz", "bullet", "daily"].every((mode) => desktopHtml.includes(`data-time-class-toggle="${mode}"`)) &&
    /id="timeClassesInput"[^>]*type="hidden"/.test(desktopHtml) &&
    desktopSource.includes("function toggleTimeClass(button)"),
);
check(
  "desktop_board_is_keyboard_accessible",
  /id="board"[^>]*role="group"/.test(desktopHtml) &&
    /document\.createElement\("button"\)/.test(desktopSource) &&
    desktopSource.includes("function handleBoardKeydown(event)") &&
    desktopSource.includes("function squareAccessibilityLabel(squareName, piece)"),
);
check(
  "desktop_manual_repertoire_is_durable",
  desktopSource.includes("manual_repertoire: state.manualRepertoire") &&
    desktopSource.includes("async function persistReviewStats(username)") &&
    desktopSource.includes('fetch("/api/apply-move"') &&
    desktopSource.includes("player_color: playerColor"),
);
check(
  "newest_manual_correction_wins",
  desktopSource.includes("function mergeManualRepertoire(serverEntries = {}, localEntries = {})") &&
    desktopSource.includes("if (!serverEntry || localTime >= serverTime)"),
);

console.log("ALL WEB TRAINER ACCESSIBILITY CHECKS PASSED");
