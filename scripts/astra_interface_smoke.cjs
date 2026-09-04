const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "docs/index.html"), "utf8");
const mirrorHtml = fs.readFileSync(path.join(root, "docs/app.html"), "utf8");
const app = fs.readFileSync(path.join(root, "docs/web-app.js"), "utf8");
const shell = fs.readFileSync(path.join(root, "docs/product-shell.js"), "utf8");
const shellCssPath = path.join(root, "docs/product-shell.css");
const shellCss = fs.readFileSync(shellCssPath, "utf8");
const sw = fs.readFileSync(path.join(root, "docs/sw.js"), "utf8");

function check(name, condition, detail = "") {
  if (!condition) throw new Error(`FAIL ${name}: ${detail}`);
  console.log(`PASS ${name}`);
}

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
check("html_ids_are_unique", duplicateIds.length === 0, duplicateIds.join(", "));
check("generated_html_mirror_matches", html === mirrorHtml);
check(
  "static_shell_header_has_h1",
  /<h1>Bookup<\/h1>/.test(html) && /class="product-header"/.test(html),
);
check(
  "skip_link_targets_workspace",
  /class="skip-link" href="#bookupWorkspace"/.test(html)
    && /id="bookupWorkspace"[^>]*tabindex="-1"/.test(html),
);
check(
  "workspace_panels_are_focusable",
  (html.match(/role="tabpanel"/g) || []).length === 5
    && (html.match(/role="tabpanel"[^>]*tabindex="0"/g) || []).length === 5,
);
check(
  "import_progress_is_accessible",
  /id="progressTrack"[^>]*role="progressbar"[^>]*aria-valuemin="0"[^>]*aria-valuemax="100"[^>]*aria-valuenow="0"/.test(html)
    && app.includes('track.setAttribute("aria-valuetext"')
    && app.includes('track.removeAttribute("aria-valuenow")'),
);
check(
  "import_statuses_are_announced",
  ["status", "pgnImportStatus", "chessnutImportStatus"].every((id) => (
    new RegExp(`id="${id}"[^>]*role="status"[^>]*aria-live="polite"`).test(html)
  )),
);
check(
  "checkbox_labels_are_not_nested",
  !/<label class="field field-check">[\s\S]*?<label class="checkbox-row">/.test(html),
);
check(
  "complete_archive_control_is_unambiguous",
  /id="maxGamesInput"[^>]*min="1"/.test(html)
    && html.includes("Use “Import all public games” for the complete archive.")
    && app.includes('maxGames.disabled = allGames'),
);
check(
  "empty_username_gets_focus_and_error_state",
  app.includes('usernameInput?.setAttribute("aria-invalid", "true")')
    && app.includes("usernameInput?.focus()"),
);
check(
  "cleared_username_does_not_reuse_stale_state",
  app.includes('const username = String(usernameField ? usernameField.value : state.username).trim()')
    && !app.includes('$("usernameInput")?.value || $("mainUsernameInput")?.value || state.username'),
);
check(
  "tab_switch_keeps_panel_heading_visible",
  app.includes('window.scrollTo({ top: 0, behavior: "auto" })')
    && !app.includes('document.querySelector(".workspace-tabs")?.offsetTop')
    && /scroll-behavior:\s*auto/.test(shellCss),
);
check(
  "destructive_review_reset_requires_confirmation",
  app.includes('confirm("Reset all Bookup position-review history on this device?'),
);
check(
  "dynamic_import_results_expose_tone",
  app.includes('fieldStatus("pgnImportStatus"')
    && app.includes('fieldStatus("chessnutImportStatus"'),
);
check(
  "shell_avoids_whole_dom_mutation_observer",
  !shell.includes("MutationObserver")
    && shell.includes("ResizeObserver")
    && shell.includes("scheduleBoardSize"),
);
check(
  "shell_css_has_no_ambient_motion_or_blur",
  !shellCss.includes("productAmbientGrid")
    && !shellCss.includes("productSignalDrift")
    && !shellCss.includes("backdrop-filter"),
);
check(
  "shell_css_is_within_transfer_budget",
  fs.statSync(shellCssPath).size < 65000,
  `${fs.statSync(shellCssPath).size} bytes`,
);
check(
  "phone_shell_can_shrink",
  /body\s*\{[\s\S]*?min-width:\s*0/.test(shellCss)
    && /@media \(max-width: 620px\)/.test(shellCss)
    && shellCss.includes("grid-template-columns: repeat(5, minmax(0, 1fr))"),
);
check(
  "reduced_motion_is_supported",
  /@media \(prefers-reduced-motion: reduce\)/.test(shellCss)
    && shellCss.includes("animation-duration: 0.01ms"),
);
check(
  "service_worker_uses_fast_repeat_asset_path",
  sw.includes("shell-v14")
    && sw.includes("const cacheKey = `${requestUrl.origin}${requestUrl.pathname}`")
    && sw.includes("caches.match(cacheKey)")
    && sw.includes("cache.put(cacheKey")
    && sw.includes("event.waitUntil(update"),
);

console.log("ALL ASTRA INTERFACE CHECKS PASSED");
