const { chromium } = require("playwright");

const url = process.env.BOOKUP_WEB_URL || "http://127.0.0.1:8766/";
const username = process.env.BOOKUP_TEST_USERNAME || "";

function check(name, condition, detail = "") {
  if (!condition) throw new Error(`FAIL ${name}: ${detail}`);
  console.log(`PASS ${name}${detail ? ` ${detail}` : ""}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  let cloudRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (request.url().includes("/api/cloud-eval")) cloudRequests += 1;
  });

  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(500);
  const startup = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    return {
      nodes: document.querySelectorAll("*").length,
      cards: document.querySelectorAll(".line-card").length,
      boardSquares: document.querySelectorAll("#board .square").length,
      tabs: document.querySelectorAll("[data-tab-target]").length,
      domReadyMs: Math.round(navigation?.domContentLoadedEventEnd || 0),
      loadMs: Math.round(navigation?.loadEventEnd || 0),
    };
  });
  check("eight_workspaces", startup.tabs === 8, JSON.stringify(startup));
  check("lazy_startup_dom", startup.nodes < 800, `${startup.nodes} nodes`);
  check("hidden_board_not_rendered", startup.boardSquares === 0, `${startup.boardSquares} squares`);
  check("no_hidden_cards_rendered", startup.cards === 0, `${startup.cards} cards`);
  check("no_startup_cloud_request", cloudRequests === 0, `${cloudRequests} requests`);

  for (const name of ["Repertoire Map", "Progress", "Needs Work", "Theory", "Smart Theory Generator", "Review", "Setup"]) {
    const started = Date.now();
    await page.getByRole("button", { name, exact: true }).click();
    check(`tab_${name.toLowerCase().replaceAll(" ", "_")}`, Date.now() - started < 1000, `${Date.now() - started}ms`);
  }

  async function verifyRepertoireWorkflow(testKnownMove = false) {
    await page.getByRole("button", { name: "Repertoire Map", exact: true }).click();
    const workButtons = page.getByRole("button", { name: "Train position", exact: true });
    await workButtons.first().waitFor({ timeout: 5000 });
    const workCount = await workButtons.count();
    check("repertoire_cards", workCount > 0, `${workCount} buttons`);
    await workButtons.first().click();
    await page.locator("#board .square").first().waitFor({ timeout: 5000 });
    check("legal_board_lazy_render", await page.locator("#board .square").count() === 64, "64 squares");
    if (testKnownMove) {
      const moveStarted = Date.now();
      await page.evaluate(() => {
        const san = (document.querySelector("#boardLine")?.textContent.match(/best continuation:\s*(\S+)/) || [])[1];
        const move = new Chess().move(san, { sloppy: true });
        document.querySelector(`[data-square="${move.from}"]`).click();
        document.querySelector(`[data-square="${move.to}"]`).click();
      });
      await page.locator("#trainerFeedback").filter({ hasText: "Correct" }).waitFor({ timeout: 3000 });
      check("board_move_response", Date.now() - moveStarted < 700, `${Date.now() - moveStarted}ms`);
      await page.waitForTimeout(900);
      const firstPassRequests = cloudRequests;
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await page.evaluate(() => {
        const san = (document.querySelector("#boardLine")?.textContent.match(/best continuation:\s*(\S+)/) || [])[1];
        const move = new Chess().move(san, { sloppy: true });
        document.querySelector(`[data-square="${move.from}"]`).click();
        document.querySelector(`[data-square="${move.to}"]`).click();
      });
      await page.waitForTimeout(900);
      check("analysis_request_cache", cloudRequests === firstPassRequests, `${cloudRequests - firstPassRequests} duplicate requests`);
    }

    await page.getByRole("button", { name: "Setup", exact: true }).click();
    const beforeReloadCloud = cloudRequests;
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(500);
    check("reload_stays_on_setup", await page.locator('[data-tab-panel="setup"]').isVisible());
    check("reload_does_not_render_board", await page.locator("#board .square").count() === 0);
    check("reload_does_not_request_cloud", cloudRequests === beforeReloadCloud, `${cloudRequests - beforeReloadCloud} new requests`);
  }

  if (username) {
    await page.getByLabel("Chess.com import username", { exact: true }).fill(username);
    await page.getByLabel("Max games", { exact: true }).fill("40");
    const started = Date.now();
    await page.getByRole("button", { name: "Import & Analyze", exact: true }).click();
    await page.waitForFunction(() => {
      const text = document.querySelector("#status")?.textContent || "";
      return /Cached|not found|rate limiting|timed out|could not load|HTTP \d+/i.test(text);
    }, null, { timeout: 90000 });
    const importStatus = await page.locator("#status").innerText();
    check("live_import_status", importStatus.startsWith("Cached"), importStatus);
    const positions = Number(await page.locator("#summaryPositions").innerText());
    check("live_import", positions > 0, `${positions} exact positions in ${Date.now() - started}ms`);
    await verifyRepertoireWorkflow();
  } else {
    await page.locator(".import-pgn-panel").first().locator("summary").click();
    await page.getByLabel("PGN text", { exact: true }).fill(
      '[Event "Performance check 1"]\n[White "Player"]\n[Black "Opponent"]\n[Result "0-1"]\n\n1. f3 d5 2. g4 e5 0-1\n\n'
      + '[Event "Performance check 2"]\n[White "Player"]\n[Black "Opponent"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1'
    );
    await page.getByRole("button", { name: "Import PGN", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#progressLabel")?.textContent === "100%", null, { timeout: 90000 });
    check("local_pgn_import", Number(await page.locator("#summaryNeedsWork").innerText()) === 1);
    await verifyRepertoireWorkflow(true);
  }

  check("no_browser_errors", errors.length === 0, errors.join(" | "));
  console.log(`METRICS ${JSON.stringify(startup)}`);
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
