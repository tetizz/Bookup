const { chromium } = require("playwright");

const url = process.env.BOOKUP_WEB_URL || "http://127.0.0.1:8766/";

function check(name, condition, detail = "") {
  if (!condition) throw new Error(`FAIL ${name}: ${detail}`);
  console.log(`PASS ${name}${detail ? ` ${detail}` : ""}`);
}

function game(uuid, timeClass, endTime, result, moves, rating = 1500) {
  return {
    uuid,
    url: `https://www.chess.com/game/live/${uuid}`,
    time_class: timeClass,
    time_control: timeClass === "bullet" ? "60+0" : timeClass === "blitz" ? "300+0" : "600+0",
    end_time: endTime,
    white: { username: "input-user", rating, result: result === "1-0" ? "win" : "checkmated" },
    black: { username: "opponent", rating: rating - 20, result: result === "0-1" ? "win" : "checkmated" },
    pgn: `[Event "Import test"]\n[White "input-user"]\n[Black "opponent"]\n[Result "${result}"]\n[TimeControl "${timeClass === "bullet" ? "60+0" : timeClass === "blitz" ? "300+0" : "600+0"}"]\n\n${moves} ${result}`,
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  const attempts = new Map();
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("https://api.chess.com/**", async (route) => {
    const requestUrl = route.request().url();
    const count = (attempts.get(requestUrl) || 0) + 1;
    attempts.set(requestUrl, count);
    if (requestUrl.endsWith("/stats")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          chess_rapid: { last: { rating: 1510 }, best: { rating: 1532 }, record: { win: 12, draw: 2, loss: 8 } },
          chess_blitz: { last: { rating: 1440 }, best: { rating: 1460 }, record: { win: 7, draw: 1, loss: 6 } },
        }),
      });
    }
    if (requestUrl.endsWith("/games/archives")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          archives: [
            "https://api.chess.com/pub/player/input-user/games/2026/01",
            "https://api.chess.com/pub/player/input-user/games/2026/02",
            "https://api.chess.com/pub/player/input-user/games/2026/03",
          ],
        }),
      });
    }
    if (requestUrl.endsWith("/2026/03") && count === 1) {
      return route.fulfill({ status: 429, contentType: "application/json", body: "{}" });
    }
    if (requestUrl.endsWith("/2026/02")) {
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
    if (requestUrl.endsWith("/2026/03")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          games: [
            game("rapid-a", "rapid", 1772000000, "1-0", "1. Nf3 d5 2. g3 Nf6 3. Bg2 e6"),
            game("blitz-a", "blitz", 1772100000, "0-1", "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6"),
            game("bullet-filtered", "bullet", 1772200000, "1-0", "1. d4 d5 2. c4 e6"),
          ],
        }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        games: [
          game("rapid-a", "rapid", 1772000000, "1-0", "1. Nf3 d5 2. g3 Nf6 3. Bg2 e6"),
          game("rapid-b", "rapid", 1769000000, "1/2-1/2", "1. c4 e5 2. Nc3 Nf6 3. g3 d5"),
        ],
      }),
    });
  });

  await page.goto(url, { waitUntil: "load" });
  await page.getByLabel("Chess.com import username", { exact: true }).fill("input-user");
  await page.getByLabel("Time classes", { exact: true }).fill("rapid,blitz");
  await page.getByLabel("Max games", { exact: true }).fill("1");
  await page.getByLabel("Import all public games", { exact: true }).check();
  await page.evaluate(() => {
    window.__bookupProgressSamples = [];
    const label = document.querySelector("#progressLabel");
    new MutationObserver(() => window.__bookupProgressSamples.push(label.textContent)).observe(label, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await page.getByRole("button", { name: "Build Repertoire", exact: true }).click();
  await page.waitForFunction(() => /Cached .* public games/.test(document.querySelector("#status")?.textContent || ""), null, { timeout: 30000 });

  const status = await page.locator("#status").innerText();
  const progressSamples = await page.evaluate(() => window.__bookupProgressSamples);
  check("progress_percentage_advances", new Set(progressSamples).size >= 3 && progressSamples.at(-1) === "100%", progressSamples.join(" -> "));
  check("retry_after_rate_limit", attempts.get("https://api.chess.com/pub/player/input-user/games/2026/03") === 2);
  check("broken_archive_is_skipped", /archive warning/.test(status), status);
  check("all_games_overrides_limit", await page.locator("#badgeGames").innerText() === "3", await page.locator("#badgeGames").innerText());
  check("time_class_filter", !(await page.locator("#analysisPreviewPanel").innerText()).includes("bullet-filtered"));

  const cache = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("bookup-web-cache", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise((resolve, reject) => {
      const request = db.transaction("workspaces", "readonly").objectStore("workspaces").get("chesscom:input-user");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { games: record.games.length, branches: record.branches.length, fingerprint: record.fingerprint };
  });
  check("offline_game_cache", cache.games === 3, JSON.stringify(cache));
  check("analyzed_branch_cache", cache.branches > 0 && /^3-3-/.test(cache.fingerprint), JSON.stringify(cache));

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => /Restored 3 games/.test(document.querySelector("#status")?.textContent || ""));
  check("offline_restore", await page.locator("#badgeGames").innerText() === "3");

  await context.setOffline(false);
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await page.locator(".import-pgn-panel").first().locator("summary").click();
  await page.getByLabel("PGN text", { exact: true }).fill(
    '[Site "Local one"]\n[White "Player"]\n[Black "Opponent"]\n[Result "1-0"]\n[TimeControl "600+0"]\n\n1. d4 d5 2. c4 e6 1-0\n\n[Site "Local two"]\n[White "Player"]\n[Black "Opponent"]\n[Result "0-1"]\n[TimeControl "300+0"]\n\n1. e4 c5 2. Nf3 d6 0-1'
  );
  await page.getByRole("button", { name: "Import PGN", exact: true }).click();
  await page.waitForFunction(() => /Imported 2/.test(document.querySelector("#pgnImportStatus")?.textContent || ""));
  check("header_without_event_import", /Imported 2/.test(await page.locator("#pgnImportStatus").innerText()));
  await page.getByRole("button", { name: "Import PGN", exact: true }).click();
  await page.waitForFunction(() => /ignored 2 duplicates/.test(document.querySelector("#pgnImportStatus")?.textContent || ""));
  check("stable_pgn_deduplication", /ignored 2 duplicates/.test(await page.locator("#pgnImportStatus").innerText()));

  check("no_browser_errors", errors.length === 0, errors.join(" | "));
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
