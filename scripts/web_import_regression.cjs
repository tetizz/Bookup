const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("docs/web-app.js", "utf8");
const html = fs.readFileSync("docs/index.html", "utf8");

function requireCheck(condition, label) {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
}

function functionSource(name, nextName) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf(`\n  function ${nextName}(`, start);
  if (start < 0 || end < 0) throw new Error(`Could not extract ${name}`);
  return source.slice(start, end);
}

const sandbox = {
  num: (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  },
};
vm.createContext(sandbox);
vm.runInContext(
  `${functionSource("inferTimeClass", "estimatePgnMinutes")}
   ${functionSource("parseTimeClasses", "importedStats")}
   globalThis.results = {
     blitz: inferTimeClass({ time_control: "300+5" }, {}),
     rapid: inferTimeClass({ time_control: "600" }, {}),
     daily: inferTimeClass({ time_control: "1/86400" }, {}),
     all: parseTimeClasses("all"),
     archiveOrder: orderedArchiveUrls(
       ["new-3", "new-2", "new-1", "old-2", "old-1"],
       ["old-1", "new-2", "removed"],
       3
     ),
   };
   try { parseTimeClasses("all,rapid"); } catch (error) { globalThis.mixedError = error.message; }
   try { parseTimeClasses("hyper"); } catch (error) { globalThis.unknownError = error.message; }`,
  sandbox,
);

requireCheck(sandbox.results.blitz === "blitz", "web_300_plus_5_is_blitz");
requireCheck(sandbox.results.rapid === "rapid", "web_600_is_rapid");
requireCheck(sandbox.results.daily === "daily", "web_daily_control_is_daily");
requireCheck(sandbox.results.all.length === 4, "web_all_expands_to_canonical_classes");
requireCheck(Boolean(sandbox.mixedError), "web_mixed_all_rejected");
requireCheck(Boolean(sandbox.unknownError), "web_unknown_time_class_rejected");
requireCheck(
  sandbox.results.archiveOrder.join(",") === "new-3,new-2,new-1,old-1,old-2",
  "web_failed_archives_retry_after_recent_batch",
);
requireCheck(
  !source.includes("fetchExplorerSource") &&
    !source.includes("explorer.lichess") &&
    source.includes("async function fetchExplorer(fen)") &&
    source.includes("return localPositionData(fen);"),
  "web_explorer_uses_local_position_data_only",
);
requireCheck(
  !html.includes('id="lichessTokenInput"') &&
    !html.includes('id="studyLichessTokenInput"') &&
    !source.includes("function sessionToken()"),
  "web_never_requests_unused_lichess_token",
);
requireCheck(
  source.includes("pendingRetryUrls.size === 0") &&
    source.includes("failedArchiveUrls: [...failedArchiveUrls]") &&
    source.includes("archivesComplete: failedArchiveUrls.size === 0"),
  "web_failed_archives_persist_until_retried",
);
requireCheck(
  source.includes("const statsResult = await Promise.race") &&
    source.includes("rating request was slow, so game import continued without waiting") &&
    !source.includes("const [statsResult, archivesResult] = await Promise.allSettled"),
  "web_slow_stats_do_not_block_archive_import",
);
requireCheck(
  source.includes("else if (state.cacheKey !== requestedCacheKey)") &&
    source.includes("state.stats = {};"),
  "web_new_user_does_not_keep_previous_stats",
);
const refreshStart = source.indexOf("  async function refreshAll()");
const refreshEnd = source.indexOf("\n  function parseTimeClasses", refreshStart);
const refreshSource = source.slice(refreshStart, refreshEnd);
requireCheck(
  refreshStart >= 0 &&
    refreshSource.indexOf("const previousWorkspace") < refreshSource.indexOf("state.username = username") &&
    refreshSource.includes("username: state.username") &&
    refreshSource.includes("settings: {") &&
    refreshSource.includes("Object.assign(state, previousWorkspace)"),
  "web_failed_user_import_restores_identity_and_settings",
);
requireCheck(
  source.includes("function workspaceCacheKey(username, settings = state.settings)") &&
    source.includes("const requestedCacheKey = workspaceCacheKey(state.username, state.settings)") &&
    source.includes("const key = workspaceCacheKey(state.username, state.settings)"),
  "web_cache_key_includes_import_scope",
);
requireCheck(
  source.includes("function stashUserWorkspace(username = state.username)") &&
    source.includes("function applyUserWorkspace(username)") &&
    source.includes("userWorkspaces"),
  "web_user_progress_is_partitioned",
);

console.log("ALL WEB IMPORT REGRESSIONS PASSED");
