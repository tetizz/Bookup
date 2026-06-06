/* Bookup Web
 * Browser-native port of the desktop workspace. Public chess data is fetched
 * directly; imported PGNs, settings, sessions, and review progress stay local.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "bookup-web-desktop-v2";
  const CACHE_DB_NAME = "bookup-web-cache";
  const CACHE_DB_VERSION = 2;
  const ANALYSIS_VERSION = 4;
  const MODES = ["rapid", "blitz", "bullet"];
  const PIECE_NAMES = { p: "P", n: "N", b: "B", r: "R", q: "Q", k: "K" };
  const DEFAULT_ACCURACY = { average: 74.18, opening: 85.1, middlegame: 71.1, endgame: 77.2 };
  const DEFAULT_DROPOFF = [
    [1, 100, 55, 5, 40], [101, 200, 53, 5, 42], [201, 300, 52, 5, 43],
    [301, 400, 51, 5, 44], [401, 500, 50, 6, 44], [501, 600, 49, 6, 45],
    [601, 700, 48, 6, 46], [701, 800, 47, 6, 47], [801, 900, 46, 6, 48],
    [901, 1000, 45, 6, 49],
  ];
  const ALL_TABS = ["setup", "repertoire-map", "stats", "needs-work", "trainer", "theory", "smart-theory", "review"];
  const cloudCache = new Map();
  const explorerCache = new Map();
  const state = {
    username: "",
    mode: "rapid",
    settings: {
      timeClasses: ["rapid", "blitz", "bullet"],
      maxGames: 240,
      importAllGames: false,
      autoImportStartup: false,
    },
    stats: {},
    games: [],
    branches: [],
    lessons: [],
    analysisMeta: null,
    reviews: [],
    sessions: [],
    snapshots: [],
    goalBaselines: {},
    accuracy: { ...DEFAULT_ACCURACY },
    dropoff: DEFAULT_DROPOFF.map((row) => [...row]),
    projectionMode: "realistic",
    customGames: 538,
    selectedBranch: null,
    selectedLesson: null,
    trainer: {
      chess: new Chess(),
      selected: "",
      orientation: "white",
      cursor: 0,
      mistakes: 0,
      boardNodes: new Map(),
      renderedOrientation: "",
    },
    database: null,
    cloud: null,
    smartTree: null,
    smartStop: false,
    loading: false,
    activeTab: "setup",
    dirtyTabs: new Set(ALL_TABS),
    weakCache: null,
    positionIndex: null,
    saveTimer: 0,
    positionRequestId: 0,
    resizeTimer: 0,
    tabFrame: 0,
    intelligenceTimer: 0,
    importController: null,
    importMeta: null,
    cacheKey: "local",
    cacheRestored: false,
  };

  const $ = (id) => document.getElementById(id);
  const qsa = (selector) => [...document.querySelectorAll(selector)];
  const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const rating = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? String(Math.round(Number(value))) : "--";
  const count = (value) => Math.round(num(value)).toLocaleString("en-US");
  const percent = (value, digits = 1) => `${num(value).toFixed(digits)}%`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
  const today = () => new Date().toISOString().slice(0, 10);
  const outcomeLabel = (value) => value === "win" ? "W" : value === "loss" ? "L" : "D";
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Import stopped.", "AbortError"));
    }, { once: true });
  });

  function openCacheDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        resolve(null);
        return;
      }
      const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("workspaces")) db.createObjectStore("workspaces", { keyPath: "key" });
        if (!db.objectStoreNames.contains("analysis")) db.createObjectStore("analysis", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readWorkspaceCache(key) {
    const db = await openCacheDb();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const request = db.transaction("workspaces", "readonly").objectStore("workspaces").get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    }).finally(() => db.close());
  }

  async function writeWorkspaceCache(record) {
    const db = await openCacheDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const request = db.transaction("workspaces", "readwrite").objectStore("workspaces").put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  }

  async function clearWorkspaceCache() {
    const db = await openCacheDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(["workspaces", "analysis"], "readwrite");
      transaction.objectStore("workspaces").clear();
      transaction.objectStore("analysis").clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }

  async function readAnalysisCache(key, maxAgeMs) {
    const db = await openCacheDb();
    if (!db) return null;
    const record = await new Promise((resolve, reject) => {
      const request = db.transaction("analysis", "readonly").objectStore("analysis").get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    }).finally(() => db.close());
    if (!record || Date.now() - num(record.updatedAt) > maxAgeMs) return null;
    return record.payload;
  }

  async function writeAnalysisCache(key, payload) {
    const db = await openCacheDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const request = db.transaction("analysis", "readwrite").objectStore("analysis").put({
        key,
        updatedAt: Date.now(),
        payload,
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  }

  function gameFingerprint(games) {
    let hash = 2166136261;
    const ids = games.map((game) => String(game.id)).sort();
    for (const id of ids) {
      for (let index = 0; index < id.length; index += 1) {
        hash ^= id.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
    return `${ANALYSIS_VERSION}-${ids.length}-${(hash >>> 0).toString(16)}`;
  }

  function compactGame(game) {
    return {
      id: game.id,
      headers: game.headers,
      moves: game.moves,
      color: game.color,
      outcome: game.outcome,
      rating: game.rating,
      timeClass: game.timeClass,
      endTime: game.endTime,
      url: game.url,
      timeControl: game.timeControl,
      accuracy: game.accuracy,
      durationMinutes: game.durationMinutes,
    };
  }

  async function persistAnalysisCache() {
    if (!state.games.length) return;
    const fingerprint = gameFingerprint(state.games);
    const record = {
      key: state.cacheKey,
      username: state.username,
      updatedAt: Date.now(),
      fingerprint,
      analysisVersion: ANALYSIS_VERSION,
      games: state.games.map(compactGame),
      branches: state.branches,
      importMeta: state.importMeta,
      lessons: state.lessons,
      analysisMeta: state.analysisMeta,
    };
    await writeWorkspaceCache(record);
    state.cacheRestored = true;
  }

  async function restoreAnalysisCache() {
    const key = state.username ? `chesscom:${state.username.toLowerCase()}` : "local";
    const cached = await readWorkspaceCache(key);
    if (!cached?.games?.length) return false;
    state.cacheKey = key;
    state.games = cached.games;
    const fingerprint = gameFingerprint(state.games);
    state.branches = cached.analysisVersion === ANALYSIS_VERSION && cached.fingerprint === fingerprint && Array.isArray(cached.branches)
      ? cached.branches
      : buildBranches(state.games);
    state.lessons = cached.analysisVersion === ANALYSIS_VERSION && cached.fingerprint === fingerprint && Array.isArray(cached.lessons)
      ? cached.lessons
      : [];
    state.analysisMeta = cached.analysisVersion === ANALYSIS_VERSION && cached.fingerprint === fingerprint
      ? (cached.analysisMeta || null)
      : null;
    state.importMeta = cached.importMeta || null;
    state.cacheRestored = true;
    markDataDirty();
    return true;
  }

  function serializedState() {
    return JSON.stringify({
      username: state.username,
      mode: state.mode,
      settings: state.settings,
      reviews: state.reviews,
      sessions: state.sessions,
      snapshots: state.snapshots.map((item) => ({ ...item })),
      goalBaselines: state.goalBaselines,
      accuracy: state.accuracy,
      dropoff: state.dropoff,
      customGames: state.customGames,
      projectionMode: state.projectionMode,
      branches: state.branches.slice(0, 180).map((branch) => ({
        id: branch.id,
        color: branch.color,
        moves: branch.moves,
        games: branch.games,
        wins: branch.wins,
        draws: branch.draws,
        losses: branch.losses,
        lastSeen: branch.lastSeen,
        intervalDays: branch.intervalDays || 0,
        due: branch.due || today(),
        ease: branch.ease || 2.5,
      })),
      stats: state.stats,
      lessons: state.lessons,
      analysisMeta: state.analysisMeta,
    });
  }

  function flushSave() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = 0;
    }
    try {
      localStorage.setItem(STORAGE_KEY, serializedState());
    } catch {
      // The app remains usable even if browser storage is unavailable or full.
    }
  }

  function save() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => {
      state.saveTimer = 0;
      const run = () => flushSave();
      if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 800 });
      else run();
    }, 120);
  }

  function markDataDirty() {
    state.branches.forEach((branch, index) => { branch._index = index; });
    state.weakCache = null;
    state.positionIndex = null;
    ALL_TABS.forEach((tab) => state.dirtyTabs.add(tab));
  }

  function markTabsDirty(...tabs) {
    tabs.forEach((tab) => state.dirtyTabs.add(tab));
  }

  function yieldToMain() {
    return new Promise((resolve) => {
      if ("scheduler" in window && typeof window.scheduler.yield === "function") {
        window.scheduler.yield().then(resolve);
      } else {
        window.setTimeout(resolve, 0);
      }
    });
  }

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (data.username) state.username = String(data.username);
      if (MODES.includes(data.mode)) state.mode = data.mode;
      if (data.settings) state.settings = { ...state.settings, ...data.settings };
      if (Array.isArray(data.reviews)) state.reviews = data.reviews;
      if (Array.isArray(data.sessions)) state.sessions = data.sessions;
      if (Array.isArray(data.snapshots)) state.snapshots = data.snapshots;
      if (data.goalBaselines && typeof data.goalBaselines === "object") state.goalBaselines = data.goalBaselines;
      if (data.accuracy) state.accuracy = { ...state.accuracy, ...data.accuracy };
      if (Array.isArray(data.dropoff)) state.dropoff = data.dropoff;
      if (data.customGames) state.customGames = num(data.customGames, 538);
      if (["simple", "realistic"].includes(data.projectionMode)) state.projectionMode = data.projectionMode;
      if (Array.isArray(data.branches)) state.branches = data.branches;
      if (Array.isArray(data.lessons)) state.lessons = data.lessons;
      if (data.analysisMeta) state.analysisMeta = data.analysisMeta;
      if (data.stats) state.stats = data.stats;
      markDataDirty();
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  function setText(id, text) {
    const node = $(id);
    if (node) node.textContent = text;
  }

  function setHtml(id, html, empty = false) {
    const node = $(id);
    if (!node) return;
    if (node.__bookupHtml !== html) {
      node.innerHTML = html;
      node.__bookupHtml = html;
    }
    node.classList.toggle("empty", empty);
  }

  function status(message, tone = "") {
    setText("status", message);
    const node = $("status");
    if (node) node.dataset.tone = tone;
  }

  function card(title, body, meta = "", actions = "") {
    return `<article class="line-card">
      <div class="line-card-header"><div><strong>${escapeHtml(title)}</strong>${meta ? `<span class="line-note">${escapeHtml(meta)}</span>` : ""}</div>${actions}</div>
      <div class="line-note">${body}</div>
    </article>`;
  }

  async function fetchJson(url, options = {}, timeoutMs = 18000, retries = 2) {
    const externalSignal = options.signal;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const abort = () => controller.abort(externalSignal?.reason);
      externalSignal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (response.status === 404) {
          const error = new Error("The requested player or archive was not found.");
          error.status = 404;
          throw error;
        }
        if (response.status === 429 || response.status >= 500) {
          const error = new Error(response.status === 429
            ? "The public API is rate limiting requests."
            : `Public API returned HTTP ${response.status}.`);
          error.status = response.status;
          error.retryAfter = num(response.headers.get("retry-after"), 0);
          throw error;
        }
        if (!response.ok) {
          const error = new Error(`Public API returned HTTP ${response.status}.`);
          error.status = response.status;
          throw error;
        }
        return await response.json();
      } catch (error) {
        if (externalSignal?.aborted) throw new DOMException("Import stopped.", "AbortError");
        const retryable = error.status === 429 || error.status >= 500 || error.name === "TypeError" || (error.name === "AbortError" && controller.signal.reason === "timeout");
        if (!retryable || attempt >= retries) {
          if (error.name === "AbortError") throw new Error("The request timed out. Check your connection and try again.");
          throw error;
        }
        const delay = error.retryAfter ? error.retryAfter * 1000 : 500 * (2 ** attempt);
        await sleep(delay, externalSignal);
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abort);
      }
    }
    throw new Error("The public API request failed.");
  }

  function inferTimeClass(raw, headers) {
    const explicit = String(raw.time_class || headers.TimeClass || "").toLowerCase();
    if (explicit && explicit !== "pgn") return explicit;
    const control = String(raw.time_control || headers.TimeControl || "");
    const base = num(control.split("+")[0]);
    if (!base) return "unknown";
    if (base < 180) return "bullet";
    if (base < 600) return "blitz";
    if (base < 86400) return "rapid";
    return "daily";
  }

  function estimatePgnMinutes(pgn, timeControl) {
    const clocks = [...String(pgn || "").matchAll(/\[%clk\s+(?:(\d+):)?(\d+):(\d+)\]/g)]
      .map((match) => num(match[1]) * 3600 + num(match[2]) * 60 + num(match[3]));
    if (clocks.length >= 4) {
      const start = Math.max(...clocks.slice(0, 6));
      const finish = Math.min(...clocks.slice(-8));
      return clamp((start - finish) * 2 / 60, 2, 240);
    }
    const [base, inc] = String(timeControl || "").split("+").map(num);
    return base ? clamp((base * 2 + inc * 70) / 60, 2, 240) : 20;
  }

  function parseGame(raw, options = {}) {
    const chess = new Chess();
    let loaded = false;
    try { loaded = chess.load_pgn(String(raw.pgn || ""), { sloppy: true }); } catch { loaded = false; }
    if (!loaded) return null;
    const headers = chess.header();
    const moves = chess.history();
    if (!moves.length) return null;
    const username = String(options.username ?? state.username).toLowerCase();
    const whiteName = String(raw.white?.username || headers.White || "").toLowerCase();
    const blackName = String(raw.black?.username || headers.Black || "").toLowerCase();
    const color = options.playerColor || (whiteName === username ? "white" : blackName === username ? "black" : "white");
    const resultCode = headers.Result || "";
    const won = (color === "white" && resultCode === "1-0") || (color === "black" && resultCode === "0-1");
    const lost = (color === "white" && resultCode === "0-1") || (color === "black" && resultCode === "1-0");
    const outcome = won ? "win" : lost ? "loss" : "draw";
    const player = color === "white" ? raw.white : raw.black;
    const timeControl = raw.time_control || headers.TimeControl || "";
    return {
      id: raw.uuid || raw.url || `${headers.Date || ""}-${moves.join("-")}`,
      pgn: raw.pgn || "",
      headers,
      moves,
      color,
      outcome,
      rating: num(player?.rating),
      timeClass: inferTimeClass(raw, headers),
      endTime: num(raw.end_time, Date.parse(String(headers.UTCDate || headers.Date || "").replaceAll(".", "-")) / 1000 || 0),
      url: raw.url || "",
      timeControl,
      accuracy: num(color === "white" ? raw.accuracies?.white : raw.accuracies?.black, 0),
      durationMinutes: estimatePgnMinutes(raw.pgn, timeControl),
    };
  }

  function branchResult(branch) {
    const total = branch.wins + branch.draws + branch.losses;
    return {
      total,
      winRate: total ? branch.wins / total * 100 : 0,
      score: total ? (branch.wins + branch.draws * 0.5) / total * 100 : 0,
      lossRate: total ? branch.losses / total * 100 : 0,
    };
  }

  function buildBranches(games) {
    const map = new Map();
    for (const game of games) {
      const depth = Math.min(14, game.moves.length);
      const moves = game.moves.slice(0, depth);
      const key = `${game.color}|${moves.slice(0, 8).join(" ")}`;
      if (!map.has(key)) {
        map.set(key, {
          id: key, color: game.color, moves, games: 0, wins: 0, draws: 0, losses: 0,
          ratings: [], lastSeen: 0, examples: [], intervalDays: 0, due: today(), ease: 2.5,
        });
      }
      const branch = map.get(key);
      branch.games += 1;
      if (game.outcome === "win") branch.wins += 1;
      else if (game.outcome === "loss") branch.losses += 1;
      else branch.draws += 1;
      branch.ratings.push(game.rating);
      branch.lastSeen = Math.max(branch.lastSeen, game.endTime);
      if (branch.examples.length < 3) branch.examples.push(game.url);
    }
    const branches = [...map.values()].sort((a, b) => {
      const aa = branchResult(a);
      const bb = branchResult(b);
      return (bb.total * (0.5 + bb.lossRate / 100)) - (aa.total * (0.5 + aa.lossRate / 100));
    });
    branches.forEach((branch, index) => { branch._index = index; });
    return branches;
  }

  function setImportProgress(done, total, message = "", rangeStart = 0, rangeEnd = 100) {
    const ratio = total ? clamp(done / total, 0, 1) : 0;
    const percentDone = total
      ? Math.round(rangeStart + ratio * (rangeEnd - rangeStart))
      : Math.round(rangeStart);
    setText("progressLabel", `${percentDone}%`);
    const fill = $("progressFill");
    if (fill) {
      fill.classList.toggle("indeterminate", !total);
      fill.style.inlineSize = total ? `${percentDone}%` : "35%";
    }
    if (message) status(message);
  }

  function gameIdentity(raw) {
    if (raw.uuid) return String(raw.uuid);
    if (raw.url) return String(raw.url);
    return `${raw.end_time || ""}|${raw.white?.username || ""}|${raw.black?.username || ""}|${String(raw.pgn || "").slice(-160)}`;
  }

  async function analyzeImportedPositions(signal, progressStart = 58, progressEnd = 96) {
    const analyzer = window.BookupPositionAnalysis;
    if (!analyzer?.analyzeImportedGames) {
      throw new Error("The exact-position analyzer did not load. Refresh the page and try again.");
    }
    const startedAt = Date.now();
    const moveTimeMs = clamp(Math.round(num($("thinkTimeInput")?.value, 0.18) * 1000), 120, 350);
    setImportProgress(0, 0, "Finding repeated decision positions...", progressStart, progressStart);
    const result = await analyzer.analyzeImportedGames(state.games, {
      workerUrl: "./vendor/stockfish/stockfish-18-lite-single.js",
      signal,
      moveTimeMs,
      readCache: (key) => readAnalysisCache(key, 90 * 24 * 60 * 60 * 1000).catch(() => null),
      writeCache: (key, payload) => writeAnalysisCache(key, payload).catch(() => {}),
      onProgress: ({ done, total, lessons }) => {
        setImportProgress(
          done,
          total,
          `Stockfish checked ${done}/${total} repeated positions · ${lessons} lessons built`,
          progressStart,
          progressEnd
        );
      },
    });
    state.lessons = result.lessons;
    state.analysisMeta = {
      candidates: result.candidates,
      lessons: result.lessons.length,
      due: result.due.length,
      fresh: result.fresh.length,
      known: result.known.length,
      cacheHits: result.cacheHits,
      analyzed: result.analyzed,
      moveTimeMs,
      elapsedMs: Date.now() - startedAt,
      completedAt: Date.now(),
    };
    return result;
  }

  function saveDailySnapshots(statsByMode) {
    const date = today();
    Object.entries(statsByMode).forEach(([mode, data]) => {
      if (!state.goalBaselines[mode]) state.goalBaselines[mode] = num(data.games);
      const snapshot = {
        date,
        mode,
        rating: num(data.rating),
        games: num(data.games),
        wins: num(data.wins),
        draws: num(data.draws),
        losses: num(data.losses),
      };
      const index = state.snapshots.findIndex((item) => item.date === date && item.mode === mode);
      if (index >= 0) state.snapshots[index] = snapshot;
      else state.snapshots.push(snapshot);
    });
    state.snapshots = state.snapshots
      .sort((left, right) => String(left.date).localeCompare(String(right.date)))
      .slice(-1095);
  }

  async function fetchPublicGames(signal) {
    const username = encodeURIComponent(state.username);
    setImportProgress(1, 1, `Connecting to Chess.com for ${state.username}...`, 0, 4);
    const statsRequest = fetchJson(`https://api.chess.com/pub/player/${username}/stats`, { signal });
    const archivesRequest = fetchJson(`https://api.chess.com/pub/player/${username}/games/archives`, { signal });
    const statsPayload = await statsRequest;
    setImportProgress(1, 1, "Rating and record loaded. Finding game archives...", 4, 9);
    const archivesPayload = await archivesRequest;
    setImportProgress(1, 1, "Archive list loaded. Scanning recent games...", 9, 12);
    const parsedStats = {};
    for (const mode of MODES) {
      const item = statsPayload[`chess_${mode}`];
      if (!item?.last) continue;
      const wins = num(item.record?.win);
      const draws = num(item.record?.draw);
      const losses = num(item.record?.loss);
      parsedStats[mode] = {
        rating: num(item.last.rating), best: num(item.best?.rating, item.last.rating),
        wins, draws, losses, games: wins + draws + losses,
      };
    }
    state.stats = parsedStats;
    saveDailySnapshots(parsedStats);
    const urls = (archivesPayload.archives || []).slice().reverse();
    if (!urls.length) throw new Error("Chess.com returned no public game archives for this username.");
    const importAll = state.settings.importAllGames;
    const wanted = importAll ? Number.POSITIVE_INFINITY : clamp(num(state.settings.maxGames, 240), 1, 20000);
    const previousKey = state.cacheKey;
    const nextKey = `chesscom:${state.username.toLowerCase()}`;
    const existingGames = previousKey === nextKey ? state.games : [];
    const knownIds = new Set(existingGames.map((game) => String(game.id)));
    const imported = [];
    const rawSeen = new Set();
    const warnings = [];
    let skipped = 0;
    let duplicates = 0;
    let archivesScanned = 0;
    const startedAt = Date.now();
    const batchSize = 3;
    for (let offset = 0; offset < urls.length && imported.length < wanted; offset += batchSize) {
      const batch = urls.slice(offset, offset + batchSize);
      const results = await Promise.allSettled(batch.map((archiveUrl) => fetchJson(archiveUrl, { signal }, 22000, 3)));
      let batchUnknownGames = 0;
      for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
        if (signal.aborted) throw new DOMException("Import stopped.", "AbortError");
        archivesScanned += 1;
        const result = results[resultIndex];
        if (result.status === "rejected") {
          warnings.push(`${batch[resultIndex].split("/").slice(-2).join("-")}: ${result.reason?.message || "archive failed"}`);
          continue;
        }
        const archiveGames = (result.value.games || []).slice().reverse();
        for (let index = 0; index < archiveGames.length && imported.length < wanted; index += 1) {
          const raw = archiveGames[index];
          const identity = gameIdentity(raw);
          if (rawSeen.has(identity) || knownIds.has(identity)) {
            duplicates += 1;
            continue;
          }
          batchUnknownGames += 1;
          rawSeen.add(identity);
          if (!state.settings.timeClasses.includes(String(raw.time_class || "").toLowerCase())) continue;
          const parsed = parseGame(raw);
          if (parsed) imported.push(parsed);
          else skipped += 1;
          if (index > 0 && index % 40 === 0) await yieldToMain();
        }
      }
      const archiveRatio = importAll
        ? archivesScanned / urls.length
        : Math.max(archivesScanned / urls.length, imported.length / wanted);
      setImportProgress(
        archiveRatio,
        1,
        `Scanning Chess.com archives: ${archivesScanned}/${urls.length} · ${count(imported.length)} new games`,
        12,
        55
      );
      await yieldToMain();
      if (!importAll && existingGames.length && batchUnknownGames === 0) break;
    }
    const merged = [...existingGames, ...imported];
    const unique = [...new Map(merged.map((game) => [String(game.id), game])).values()]
      .sort((a, b) => a.endTime - b.endTime);
    state.cacheKey = nextKey;
    state.games = importAll ? unique : unique.slice(-wanted);
    const previousFingerprint = previousKey === nextKey && existingGames.length ? gameFingerprint(existingGames) : "";
    const nextFingerprint = gameFingerprint(state.games);
    if (previousFingerprint !== nextFingerprint || !state.branches.length) state.branches = buildBranches(state.games);
    state.importMeta = {
      source: "Chess.com",
      username: state.username,
      imported: imported.length,
      totalCached: state.games.length,
      duplicates,
      skipped,
      archivesScanned,
      archivesAvailable: urls.length,
      warnings: warnings.slice(0, 12),
      completedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      fingerprint: nextFingerprint,
    };
    markDataDirty();
    await analyzeImportedPositions(signal, 58, 96);
    markDataDirty();
    setImportProgress(1, 1, "Saving games and exact-position lessons for offline use...", 96, 99);
    await persistAnalysisCache();
  }

  async function refreshAll() {
    if (state.loading) return;
    state.loading = true;
    document.body.classList.add("is-loading");
    const buttons = [$("analyzeBtn"), $("progressRefreshBtn")].filter(Boolean);
    buttons.forEach((button) => { button.disabled = true; });
    const stopButton = $("stopImportBtn");
    if (stopButton) stopButton.hidden = false;
    const username = String($("usernameInput")?.value || $("mainUsernameInput")?.value || state.username).trim();
    if (!username) {
      status("Enter a Chess.com username.", "error");
      state.loading = false;
      document.body.classList.remove("is-loading");
      buttons.forEach((item) => { item.disabled = false; });
      if (stopButton) stopButton.hidden = true;
      return;
    }
    state.username = username;
    state.settings.maxGames = clamp(num($("maxGamesInput")?.value, 240), 1, 20000);
    state.settings.timeClasses = parseTimeClasses($("timeClassesInput")?.value);
    state.settings.importAllGames = Boolean($("importAllGamesInput")?.checked);
    state.settings.autoImportStartup = Boolean($("autoImportStartupInput")?.checked);
    state.importController = new AbortController();
    status(`Loading public games for ${state.username}...`);
    setImportProgress(0, 0, `Starting import for ${state.username}...`, 1, 1);
    const previousWorkspace = {
      cacheKey: state.cacheKey,
      games: state.games,
      branches: state.branches,
      lessons: state.lessons,
      stats: state.stats,
      snapshots: state.snapshots.map((item) => ({ ...item })),
      goalBaselines: { ...state.goalBaselines },
      importMeta: state.importMeta,
      analysisMeta: state.analysisMeta,
    };
    try {
      await fetchPublicGames(state.importController.signal);
      save();
      renderAll();
      const warningText = state.importMeta?.warnings?.length ? ` ${state.importMeta.warnings.length} archive warning(s) were skipped.` : "";
      status(`Cached ${count(state.games.length)} public games and ${count(state.lessons.filter((lesson) => lesson.lineStatus === "needs_work").length)} due positions offline.${warningText}`, "success");
      setImportProgress(1, 1);
    } catch (error) {
      Object.assign(state, previousWorkspace);
      markDataDirty();
      const stopped = error.name === "AbortError";
      const message = /failed to fetch|networkerror|network request failed/i.test(String(error.message || ""))
        ? "No internet connection. Your existing offline games and lessons are still available."
        : (error.message || "Bookup could not load public games.");
      status(stopped ? "Import stopped. Your previous offline cache is still intact." : message, stopped ? "" : "error");
      setText("progressLabel", stopped ? "Stopped" : "Error");
      const fill = $("progressFill");
      if (fill) {
        fill.classList.remove("indeterminate");
        fill.style.inlineSize = "0%";
      }
      renderAll();
    } finally {
      state.importController = null;
      state.loading = false;
      document.body.classList.remove("is-loading");
      buttons.forEach((button) => { button.disabled = false; });
      if (stopButton) stopButton.hidden = true;
    }
  }

  function parseTimeClasses(value) {
    const text = String(value || "rapid,blitz,bullet").toLowerCase();
    if (text.trim() === "all") return ["rapid", "blitz", "bullet", "daily"];
    const values = text.split(",").map((item) => item.trim()).filter(Boolean);
    return values.length ? values : ["rapid", "blitz", "bullet"];
  }

  function importedStats() {
    let wins = 0;
    let draws = 0;
    let losses = 0;
    if (state.games.length) {
      state.games.forEach((game) => {
        if (game.outcome === "win") wins += 1;
        else if (game.outcome === "loss") losses += 1;
        else draws += 1;
      });
    } else {
      state.branches.forEach((branch) => {
        wins += branch.wins;
        draws += branch.draws;
        losses += branch.losses;
      });
    }
    const total = wins + draws + losses;
    return { wins, draws, losses, total, score: total ? (wins + draws * 0.5) / total * 100 : 0 };
  }

  function latestLessonReview(lessonId) {
    for (let index = state.reviews.length - 1; index >= 0; index -= 1) {
      if (state.reviews[index].lessonId === lessonId) return state.reviews[index];
    }
    return null;
  }

  function lessonNeedsWork(lesson) {
    return lesson?.lineStatus === "needs_work" && lesson.repeatMistakeCount >= 2;
  }

  function lessonIsDue(lesson) {
    if (!lessonNeedsWork(lesson)) return false;
    const review = latestLessonReview(lesson.lessonId);
    return !review || review.result === "missed" || String(review.due || today()) <= today();
  }

  function dueLessons() {
    return state.lessons
      .filter(lessonIsDue)
      .sort((left, right) => {
        const leftReview = latestLessonReview(left.lessonId);
        const rightReview = latestLessonReview(right.lessonId);
        return Number(Boolean(rightReview)) - Number(Boolean(leftReview))
          || right.priority - left.priority
          || right.repeatMistakeCount - left.repeatMistakeCount;
      })
      .slice(0, 32);
  }

  function lessonCard(lesson, includeAction = true) {
    const action = includeAction
      ? `<button class="ghost-btn" data-open-lesson="${escapeHtml(lesson.lessonId)}" type="button">Train position</button>`
      : "";
    const date = lesson.lastSeenTime ? new Date(lesson.lastSeenTime * 1000).toLocaleDateString() : "PGN import";
    const loss = Math.round(num(lesson.valueLostCp));
    const title = `${lesson.recommendedMove} instead of ${lesson.yourRepeatedMove}`;
    const body = `You chose ${escapeHtml(lesson.yourRepeatedMove)} in ${count(lesson.repeatMistakeCount)} repeated games. Stockfish prefers ${escapeHtml(lesson.recommendedMove)}${loss ? ` by about ${(loss / 100).toFixed(2)} pawns` : ""}.`;
    const meta = `${lesson.color} · ${lesson.openingName || lesson.lineLabel || "exact position"} · last seen ${date}`;
    return card(title, `${body}<br><span class="lesson-continuation">${escapeHtml(lesson.continuationSan || "")}</span>`, meta, action);
  }

  function renderSummary() {
    const imported = importedStats();
    const needsWork = state.lessons.filter(lessonNeedsWork);
    const queue = dueLessons();
    const analyzed = num(state.analysisMeta?.candidates, state.lessons.length);
    setText("summaryPositions", count(analyzed));
    setText("summaryNeedsWork", count(needsWork.length));
    setText("summaryQueue", count(queue.length));
    setText("heroTitle", state.games.length ? `${state.username || "Your"} exact-position training` : "No games loaded yet");
    setText("heroSummary", state.games.length
      ? `${count(imported.total)} real games were indexed into ${count(analyzed)} repeated decision positions. ${count(needsWork.length)} positions contain a repeated move that differs from Stockfish's best move.`
      : "Import public games or paste PGN to find the exact positions where your repeated move missed Stockfish's best move.");
    setText("badgeGames", imported.total ? count(imported.total) : "--");
    setText("badgeKnown", count(state.reviews.filter((review) => review.result === "known" && review.lessonId).length));
    setText("badgeWinRate", imported.total ? percent(imported.wins / imported.total * 100) : "--");
    setHtml("analysisPreviewPanel", state.games.length
      ? `<div class="analysis-landscape-metrics">
          <article><span>Source</span><strong>${escapeHtml(state.importMeta?.source || "Local PGN")}</strong></article>
          <article><span>Imported</span><strong>${count(imported.total)} games</strong></article>
          <article><span>Exact positions</span><strong>${count(analyzed)}</strong></article>
          <article><span>Engine cache</span><strong>${count(state.analysisMeta?.cacheHits || 0)} reused</strong></article>
        </div>${state.importMeta ? `<p class="line-note">${count(state.importMeta.duplicates)} duplicates ignored · ${count(state.importMeta.skipped)} parse failures${state.importMeta.warnings?.length ? ` · ${count(state.importMeta.warnings.length)} archive warnings` : ""}</p>` : ""}`
      : "Run an import to see live import details.", !state.games.length);
  }

  function renderHealth() {
    if (!state.games.length) {
      setHtml("healthDashboard", "Build your repertoire to see coverage, confidence, and today's study load.", true);
      return;
    }
    const totalVisits = state.lessons.reduce((sum, lesson) => sum + num(lesson.frequency), 0);
    const weak = state.lessons.filter(lessonNeedsWork);
    const confidence = state.lessons.length
      ? state.lessons.reduce((sum, lesson) => sum + num(lesson.confidence), 0) / state.lessons.length
      : 0;
    const known = state.reviews.filter((review) => review.result === "known" && review.lessonId).length;
    setHtml("healthDashboard", `<div class="analysis-landscape-metrics">
      <article><span>Analyzed</span><strong>${count(state.analysisMeta?.candidates || state.lessons.length)}</strong><small>repeated exact positions</small></article>
      <article><span>Confidence</span><strong>${percent(confidence, 0)}</strong><small>frequency and move consistency</small></article>
      <article><span>Known reps</span><strong>${count(known)}</strong><small>clean local reviews</small></article>
      <article><span>Needs work</span><strong>${count(weak.length)}</strong><small>${count(totalVisits)} repeated visits checked</small></article>
    </div>`);
  }

  function branchCard(branch, index, includeAction = true) {
    const result = branchResult(branch);
    const title = branch.moves.slice(0, 8).join(" ");
    const action = includeAction ? `<button class="ghost-btn" data-open-branch="${index}" type="button">Work on line</button>` : "";
    return card(title, `${branch.wins}W ${branch.draws}D ${branch.losses}L · score ${percent(result.score)} · last seen ${branch.lastSeen ? new Date(branch.lastSeen * 1000).toLocaleDateString() : "PGN import"}`, `${branch.color} · ${branch.games} games`, action);
  }

  function renderRepertoire() {
    const white = state.branches.filter((branch) => branch.color === "white");
    const black = state.branches.filter((branch) => branch.color === "black");
    const firstMove = (items, perspective) => {
      const map = {};
      items.forEach((branch) => { map[branch.moves[0]] = (map[branch.moves[0]] || 0) + branch.games; });
      return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([move, games]) => card(
          move,
          `${games} imported games`,
          perspective === "opponent" ? "opponent opens with" : "you open with"
        )).join("");
    };
    setHtml("firstMoveWhite", firstMove(white, "player") || "No games where you played White yet.", !white.length);
    setHtml("firstMoveBlack", firstMove(black, "opponent") || "No games where you played Black yet.", !black.length);
    const whiteLessons = state.lessons.filter((lesson) => lesson.color === "white" && lessonNeedsWork(lesson));
    const blackLessons = state.lessons.filter((lesson) => lesson.color === "black" && lessonNeedsWork(lesson));
    setHtml("repertoireMapWhite", whiteLessons.slice(0, 30).map((lesson) => lessonCard(lesson)).join("") || "No repeated white mistakes were found.", !whiteLessons.length);
    setHtml("repertoireMapBlack", blackLessons.slice(0, 30).map((lesson) => lessonCard(lesson)).join("") || "No repeated black mistakes were found.", !blackLessons.length);
    const preview = state.selectedLesson || [...whiteLessons, ...blackLessons].sort((a, b) => b.priority - a.priority)[0];
    setHtml("previewPanel", preview ? lessonCard(preview) : "No exact-position lesson is available to preview.", !preview);
    const knownIds = new Set(state.reviews.filter((item) => item.result === "known" && item.lessonId).map((item) => item.lessonId));
    const known = state.lessons.filter((lesson) => knownIds.has(lesson.lessonId));
    setHtml("knownArchiveList", known.slice(0, 30).map((lesson) => lessonCard(lesson, false)).join("") || "Complete clean position reviews to build the known archive.", !known.length);
    const byPosition = new Map();
    state.branches.forEach((branch) => {
      const chess = new Chess();
      const path = [];
      branch.moves.slice(0, 16).forEach((san) => {
        const move = chess.move(san, { sloppy: true });
        if (!move) return;
        path.push(move.san);
        const key = fenKey(chess.fen());
        if (!byPosition.has(key)) byPosition.set(key, new Set());
        byPosition.get(key).add(path.join(" "));
      });
    });
    const transpositions = [...byPosition.entries()]
      .map(([fen, paths]) => [fen, [...paths]])
      .filter(([, paths]) => paths.length > 1)
      .sort((left, right) => right[1].length - left[1].length)
      .slice(0, 12);
    setHtml("transpositionList", transpositions.map(([fen, paths]) => card(
      `${paths.length} move orders`,
      paths.slice(0, 3).map(escapeHtml).join("<br>"),
      fen.split(" ").slice(0, 2).join(" ")
    )).join("") || "No true FEN transpositions found in this import.", !transpositions.length);
  }

  function weakBranches() {
    if (state.weakCache) return state.weakCache;
    state.weakCache = [...state.branches].sort((a, b) => {
      const aa = branchResult(a);
      const bb = branchResult(b);
      return (bb.lossRate * Math.log2(bb.total + 1)) - (aa.lossRate * Math.log2(aa.total + 1));
    });
    return state.weakCache;
  }

  function renderNeedsWork() {
    const urgent = state.lessons.filter(lessonNeedsWork).sort((a, b) => b.priority - a.priority);
    const later = urgent.filter((lesson) => lesson.valueLostCp < 100).slice(0, 16);
    setHtml("urgentList", urgent.slice(0, 20).map((lesson) => lessonCard(lesson)).join("") || "No repeated best-move misses were found.", !urgent.length);
    setHtml("sidelineList", later.map((lesson) => lessonCard(lesson)).join("") || "No lower-priority exact positions yet.", !later.length);
    setHtml("suggestionList", urgent.slice(0, 10).map((lesson) => card(
      lesson.recommendedMove,
      `Replace ${escapeHtml(lesson.yourRepeatedMove)} with ${escapeHtml(lesson.recommendedMove)} after ${escapeHtml(lesson.lineLabel)}. Rehearse ${escapeHtml(lesson.continuationSan || "the resulting position")}.`,
      `${lesson.classification?.label || "miss"} · priority ${Math.round(lesson.priority)}`
    )).join("") || "Import games to surface exact move upgrades.", !urgent.length);
    const squares = new Map();
    urgent.forEach((lesson) => {
      const move = String(lesson.yourRepeatedMoveUci || "");
      [move.slice(0, 2), move.slice(2, 4)].filter(Boolean).forEach((square) => {
        squares.set(square, (squares.get(square) || 0) + Math.max(1, num(lesson.repeatMistakeCount)));
      });
    });
    const heat = [...squares.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    setHtml("mistakeHeatmap", heat.length ? `<div class="heatmap-grid">${heat.map(([square, hits]) => `<div class="heatmap-cell"><strong>${square}</strong><span>${count(hits)}</span></div>`).join("")}</div>` : "No repeated-mistake squares yet.", !heat.length);
    setHtml("mistakeTimeline", urgent.slice(0, 8).map((lesson) => card(
      new Date((lesson.lastSeenTime || Date.now() / 1000) * 1000).toLocaleDateString(),
      `${escapeHtml(lesson.yourRepeatedMove)} → ${escapeHtml(lesson.recommendedMove)}`,
      `${count(lesson.repeatMistakeCount)} repeats`
    )).join("") || "No repeated mistakes yet.", !urgent.length);
    renderReviewSchedule();
    setHtml("smartRetryPanel", urgent.slice(0, 8).map((lesson) => lessonCard(lesson)).join("") || "No retry positions yet.", !urgent.length);
    setHtml("premoveQuizPanel", urgent.slice(0, 6).map((lesson, index) => card(
      `After ${lesson.lineLabel}, what is best?`,
      `<button class="ghost-btn" data-reveal="${index}" type="button">Reveal answer</button><span class="quiz-answer" hidden>${escapeHtml(lesson.recommendedMove)} · ${escapeHtml(lesson.continuationSan || "")}</span>`,
      "exact-position recall"
    )).join("") || "No position quizzes yet.", !urgent.length);
  }

  function renderReviewSchedule() {
    const items = state.reviews.filter((item) => item.lessonId).slice().sort((a, b) => String(a.due).localeCompare(String(b.due))).slice(0, 25);
    setHtml("reviewSchedule", items.map((item) => card(item.line, `${item.result === "known" ? "Clean position" : "Retry needed"} · next review ${item.due}`, item.result)).join("") || "Review schedule appears once exact positions enter the queue.", !items.length);
    const waiting = dueLessons();
    setHtml("mistakeList", waiting.map((lesson) => lessonCard(lesson)).join("") || "No missed positions are waiting.", !waiting.length);
  }

  function renderMoveTree() {
    if (!state.branches.length) {
      setHtml("gameMoveTree", "Import games to build your move tree.", true);
      return;
    }
    const root = {};
    for (const branch of state.branches) {
      let node = root;
      branch.moves.slice(0, 10).forEach((move) => {
        node[move] ||= { _count: 0, _children: {} };
        node[move]._count += branch.games;
        node = node[move]._children;
      });
    }
    const renderNode = (node, depth = 0) => Object.entries(node)
      .sort((a, b) => b[1]._count - a[1]._count).slice(0, depth < 2 ? 8 : 4)
      .map(([move, data]) => `<details class="move-tree-node" ${depth < 1 ? "open" : ""}>
        <summary><strong>${escapeHtml(move)}</strong><span>${count(data._count)} games</span></summary>
        <div class="tree-node-list">${depth < 6 ? renderNode(data._children, depth + 1) : ""}</div>
      </details>`).join("");
    setHtml("gameMoveTree", renderNode(root));
  }

  function renderTheoryTools() {
    const top = state.branches.slice(0, 10);
    setHtml("theoryPresetPanel", top.map((branch) => `<button class="ghost-btn" data-open-branch="${branch._index}" type="button">${escapeHtml(branch.moves.slice(0, 5).join(" "))}</button>`).join("") || "Import games to suggest theory seeds.", !top.length);
    const replyMap = {};
    state.branches.forEach((branch) => {
      const reply = branch.moves[1] || "";
      if (reply) replyMap[reply] = (replyMap[reply] || 0) + branch.games;
    });
    const replies = Object.entries(replyMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
    setHtml("databaseTrainingList", replies.map(([move, games]) => card(move, `${games} imported games`, "common reply")).join("") || "No reply data yet.", !replies.length);
    setHtml("opponentSimulatorPanel", replies.slice(0, 5).map(([move, games]) => card(`Opponent plays ${move}`, `Practice your prepared answer against a reply seen ${games} times.`, "simulator")).join("") || "No simulator scenarios yet.", !replies.length);
    const traps = weakBranches().filter((branch) => branch.wins > branch.losses && branch.games >= 2).slice(0, 6);
    setHtml("trapFinderPanel", traps.map((branch) => card(branch.moves.slice(0, 8).join(" "), `${branch.wins} wins in ${branch.games} games. Verify tactically with cloud analysis before relying on it.`, "practical chance")).join("") || "No repeated practical chances found.", !traps.length);
    setHtml("repertoireExportPanel", state.branches.length
      ? `<div class="chip-row"><button id="downloadPgnBtn" class="launch-btn" type="button">Download repertoire PGN</button><button id="downloadJsonBtn" class="ghost-btn" type="button">Download Bookup JSON</button></div><p class="line-note">${count(state.branches.length)} branches ready. Exports contain no tokens.</p>`
      : "Import games to prepare a repertoire export.", !state.branches.length);
  }

  function renderProgress() {
    const data = state.stats[state.mode];
    qsa("[data-progress-mode]").forEach((button) => button.classList.toggle("active", button.dataset.progressMode === state.mode));
    if (!data) {
      setHtml("progressMetricGrid", card("No live rating", `Chess.com has no ${state.mode} rating for this player.`));
      return;
    }
    const recent = state.games.filter((game) => game.timeClass === state.mode).slice(-30);
    const snapshots = state.snapshots.filter((item) => item.mode === state.mode).slice(-90);
    const recentWins = recent.filter((game) => game.outcome === "win").length;
    const recentScore = recent.length ? recentWins / recent.length * 100 : 0;
    const imported = importedStats();
    setHtml("progressMetricGrid", [
      ["Current rating", rating(data.rating), `${state.mode} from Chess.com`],
      ["Record", `${count(data.wins)}W ${count(data.draws)}D ${count(data.losses)}L`, `${count(data.games)} games`],
      ["Win rate", percent(data.games ? data.wins / data.games * 100 : 0), "career public stats"],
      ["Recent form", percent(recentScore), `${recentWins} wins in ${recent.length} imported ${state.mode} games`],
      ["Imported score", percent(imported.score), "draw counts as half"],
      ["Best rating", rating(data.best), "Chess.com best"],
    ].map(([label, value, note]) => `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join(""));
    setText("progressStatus", `Live ${state.mode} stats for ${state.username}. Ratings are shown without commas.`);
    const ratingPoints = snapshots.length >= 2
      ? snapshots.map((item) => ({ x: item.date, y: item.rating }))
      : recent.map((game) => ({ x: game.endTime, y: game.rating }));
    drawRatingChart("progressRatingChart", ratingPoints, "#7da2ff");
    const deltaSource = snapshots.length >= 2 ? snapshots : recent;
    const deltas = deltaSource.slice(1).map((item, index) => ({ x: index, y: item.rating - deltaSource[index].rating }));
    drawBarChart("progressDeltaChart", deltas);
    drawRatingChart("progressGamesChart", snapshots.map((item) => ({ x: item.date, y: item.games })), "#74d39b");
    drawRatingChart("progressWinRateChart", snapshots.map((item) => ({
      x: item.date,
      y: item.games ? item.wins / item.games * 100 : 0,
    })), "#f1c96a");
    drawRatingChart("progressAccuracyChart", state.sessions.filter((session) => num(session.accuracy) > 0)
      .map((session) => ({ x: session.date, y: session.accuracy })), "#c79bff");
    drawPhaseChart();
    renderGoals(data, recentScore);
    renderProjection(data);
    renderTimeCalculator();
    renderRecommendations(recentScore);
    renderSessions();
  }

  function canvasContext(id) {
    const canvas = $(id);
    if (!canvas) return null;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(320, canvas.clientWidth || 640);
    const height = num(canvas.getAttribute("height"), 220);
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    return { canvas, ctx, width, height };
  }

  function drawRatingChart(id, points, color) {
    const target = canvasContext(id);
    if (!target) return;
    const { ctx, width, height } = target;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#283241";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      ctx.beginPath(); ctx.moveTo(35, i * height / 4); ctx.lineTo(width - 12, i * height / 4); ctx.stroke();
    }
    if (!points.length) {
      ctx.fillStyle = "#8d9bb0"; ctx.font = "14px Segoe UI"; ctx.fillText("Import games to draw this chart.", 42, height / 2);
      return;
    }
    const values = points.map((point) => point.y);
    const min = Math.min(...values) - 8;
    const max = Math.max(...values) + 8;
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath();
    points.forEach((point, index) => {
      const x = 38 + index / Math.max(1, points.length - 1) * (width - 58);
      const y = 15 + (max - point.y) / Math.max(1, max - min) * (height - 35);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    if (points.length === 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(38, height / 2, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#d2dae6"; ctx.font = "12px Cascadia Mono";
    ctx.fillText(String(Math.max(...values)), 4, 20);
    ctx.fillText(String(Math.min(...values)), 4, height - 12);
  }

  function drawBarChart(id, points) {
    const target = canvasContext(id);
    if (!target) return;
    const { ctx, width, height } = target;
    ctx.clearRect(0, 0, width, height);
    const middle = height / 2;
    ctx.strokeStyle = "#364558"; ctx.beginPath(); ctx.moveTo(12, middle); ctx.lineTo(width - 12, middle); ctx.stroke();
    if (!points.length) return;
    const max = Math.max(8, ...points.map((point) => Math.abs(point.y)));
    const barWidth = (width - 30) / points.length;
    points.forEach((point, index) => {
      const size = Math.abs(point.y) / max * (height / 2 - 18);
      ctx.fillStyle = point.y >= 0 ? "#74d39b" : "#ff7f87";
      ctx.fillRect(15 + index * barWidth, point.y >= 0 ? middle - size : middle, Math.max(2, barWidth - 2), size);
    });
  }

  function drawPhaseChart() {
    const target = canvasContext("progressPhaseChart");
    if (!target) return;
    const { ctx, width, height } = target;
    ctx.clearRect(0, 0, width, height);
    const rows = [["Opening", state.accuracy.opening], ["Middlegame", state.accuracy.middlegame], ["Endgame", state.accuracy.endgame]];
    const history = state.sessions.filter((session) =>
      num(session.openingAccuracy) > 0 || num(session.middlegameAccuracy) > 0 || num(session.endgameAccuracy) > 0
    ).slice(-30);
    if (history.length >= 2) {
      ctx.strokeStyle = "#283241";
      for (let index = 1; index < 4; index += 1) {
        const y = index * height / 4;
        ctx.beginPath(); ctx.moveTo(35, y); ctx.lineTo(width - 12, y); ctx.stroke();
      }
      const series = [
        ["Opening", "openingAccuracy", "#74d39b"],
        ["Middlegame", "middlegameAccuracy", "#7da2ff"],
        ["Endgame", "endgameAccuracy", "#f1c96a"],
      ];
      series.forEach(([label, key, color], seriesIndex) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        history.forEach((session, index) => {
          const x = 38 + index / Math.max(1, history.length - 1) * (width - 58);
          const y = 12 + (100 - clamp(num(session[key]), 0, 100)) / 100 * (height - 40);
          if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = "12px Segoe UI";
        ctx.fillText(label, 12 + seriesIndex * Math.max(90, width / 3), height - 8);
      });
    } else {
      rows.forEach(([label, value], index) => {
        const y = 34 + index * 58;
        ctx.fillStyle = "#283241"; ctx.fillRect(100, y, width - 130, 20);
        ctx.fillStyle = value >= 80 ? "#74d39b" : value >= 73 ? "#7da2ff" : "#f1c96a";
        ctx.fillRect(100, y, (width - 130) * value / 100, 20);
        ctx.fillStyle = "#d2dae6"; ctx.font = "13px Segoe UI"; ctx.fillText(label, 12, y + 15);
        ctx.font = "12px Cascadia Mono"; ctx.fillText(percent(value), width - 52, y + 15);
      });
    }
    const phases = rows.slice().sort((a, b) => a[1] - b[1]);
    setHtml("progressWeaknessPanel", card(`Main weakness: ${phases[0][0]}`, `Best phase: ${phases.at(-1)[0]}. Focus the next review block on ${phases[0][0].toLowerCase()} decisions.`, `average ${percent(state.accuracy.average)}`));
  }

  function goalRow(label, value, target, suffix = "") {
    const progress = clamp(value / target * 100, 0, 100);
    return `<div class="goal-row"><div><span>${label}</span><strong>${suffix === "rating" ? rating(value) : `${num(value).toFixed(suffix === "%" ? 1 : 0)}${suffix === "%" ? "%" : ""}`} / ${target}</strong></div><div class="goal-track"><div style="width:${progress}%"></div></div></div>`;
  }

  function renderGoals(data, recentWinRate) {
    const rows = [1600, 1700, 1800, 1900, 2000].map((target) => goalRow(`${target} rating`, data.rating, target, "rating"));
    const gamesSinceBaseline = Math.max(0, num(data.games) - num(state.goalBaselines[state.mode], data.games));
    rows.push(goalRow("538 more games", Math.min(538, gamesSinceBaseline), 538));
    rows.push(goalRow("1000 more games", Math.min(1000, gamesSinceBaseline), 1000));
    rows.push(goalRow("Average accuracy", state.accuracy.average, 75, "%"));
    rows.push(goalRow("Middlegame accuracy", state.accuracy.middlegame, 73, "%"));
    rows.push(goalRow("Endgame accuracy", state.accuracy.endgame, 80, "%"));
    rows.push(goalRow("Recent win rate", recentWinRate, 52, "%"));
    setHtml("progressGoalGrid", rows.join(""));
  }

  function projectGames(gameCount, data) {
    if (state.projectionMode === "simple") {
      const total = Math.max(1, num(data.games));
      const wins = gameCount * num(data.wins) / total;
      const draws = gameCount * num(data.draws) / total;
      const losses = gameCount * num(data.losses) / total;
      const change = Math.round((wins - losses) * 8);
      return { wins: Math.round(wins), draws: Math.round(draws), losses: Math.round(losses), change, final: data.rating + change };
    }
    let wins = 0, draws = 0, losses = 0;
    let remaining = gameCount;
    for (const band of state.dropoff) {
      if (remaining <= 0) break;
      const bandSize = Math.max(0, band[1] - band[0] + 1);
      const gamesInBand = Math.min(remaining, bandSize);
      wins += gamesInBand * band[2] / 100;
      draws += gamesInBand * band[3] / 100;
      losses += gamesInBand * band[4] / 100;
      remaining -= gamesInBand;
    }
    if (remaining > 0) {
      const band = state.dropoff.at(-1);
      wins += remaining * band[2] / 100;
      draws += remaining * band[3] / 100;
      losses += remaining * band[4] / 100;
    }
    const change = Math.round((wins - losses) * 8);
    return { wins: Math.round(wins), draws: Math.round(draws), losses: Math.round(losses), change, final: data.rating + change };
  }

  function renderProjection(data) {
    const custom = clamp(num($("progressCustomGames")?.value, state.customGames), 1, 5000);
    state.customGames = custom;
    state.projectionMode = $("progressProjectionMode")?.value || state.projectionMode;
    const values = [538, 1000, custom];
    setHtml("progressProjectionPanel", values.map((games) => {
      const result = projectGames(games, data);
      return card(
        `${count(games)} games → ${rating(result.final)}`,
        `${result.wins}W ${result.draws}D ${result.losses}L · net ${result.change >= 0 ? "+" : ""}${result.change}`,
        state.projectionMode === "simple" ? "current W/D/L rates" : "realistic drop-off"
      );
    }).join(""));
    setHtml("progressProjectionBands", state.projectionMode === "realistic"
      ? `<div class="projection-table-wrap"><table class="projection-table">
          <thead><tr><th>Games</th><th>W%</th><th>D%</th><th>L%</th></tr></thead>
          <tbody>${state.dropoff.map((row, index) => `<tr>
            <td>${row[0]}-${row[1]}</td>
            <td><input type="number" min="0" max="100" data-dropoff-row="${index}" data-dropoff-field="2" value="${row[2]}"></td>
            <td><input type="number" min="0" max="100" data-dropoff-row="${index}" data-dropoff-field="3" value="${row[3]}"></td>
            <td><input type="number" min="0" max="100" data-dropoff-row="${index}" data-dropoff-field="4" value="${row[4]}"></td>
          </tr>`).join("")}</tbody>
        </table></div><p class="line-note">Each row should total 100%. Save projection applies your edits.</p>`
      : `<p class="line-note">Uses the current public ${state.mode} career percentages: ${percent(data.games ? data.wins / data.games * 100 : 0)} wins, ${percent(data.games ? data.draws / data.games * 100 : 0)} draws, ${percent(data.games ? data.losses / data.games * 100 : 0)} losses.</p>`);
  }

  function estimateMinutes(game) {
    if (num(game.durationMinutes) > 0) return num(game.durationMinutes);
    const clocks = [...String(game.pgn || "").matchAll(/\[%clk\s+(?:(\d+):)?(\d+):(\d+)\]/g)]
      .map((match) => num(match[1]) * 3600 + num(match[2]) * 60 + num(match[3]));
    if (clocks.length >= 4) {
      const start = Math.max(...clocks.slice(0, 6));
      const finish = Math.min(...clocks.slice(-8));
      return clamp((start - finish) * 2 / 60, 2, 80);
    }
    const [base, inc] = String(game.timeControl || "").split("+").map(num);
    return base ? clamp((base * 2 + inc * 70) / 60, 2, 80) : 20;
  }

  function durationText(minutes) {
    const rounded = Math.round(minutes);
    const days = rounded >= 1440 ? ` · about ${(rounded / 1440).toFixed(1)} nonstop days` : "";
    return `${count(rounded)} min · ${Math.floor(rounded / 60)}h ${rounded % 60}m${days}`;
  }

  function renderTimeCalculator() {
    const games = state.games.filter((game) => game.timeClass === state.mode).slice(-50);
    const lengths = games.map(estimateMinutes);
    const avg = lengths.length ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 20;
    const custom = state.customGames;
    const rows = [538, 1000, custom].map((gamesCount) => card(`${count(gamesCount)} games`, `Max ${durationText(gamesCount * 20)} · real ${durationText(gamesCount * avg)}`, `${avg.toFixed(1)} min average`));
    const days = [10, 15, 20, 25, 40].map((perDay) => `${perDay}/day: ${Math.ceil(custom / perDay)} days`).join(" · ");
    rows.push(card("Recent duration sample", `${games.length ? `${Math.min(...lengths).toFixed(1)} shortest · ${Math.max(...lengths).toFixed(1)} longest` : "No clock sample; using 20 min/game."}<br>${days}`, `${games.length} games used${games.length < 10 ? " · small sample" : ""}`));
    setHtml("progressTimePanel", rows.join(""));
  }

  function renderRecommendations(recentWinRate) {
    const phases = [["opening", state.accuracy.opening], ["middlegame", state.accuracy.middlegame], ["endgame", state.accuracy.endgame]].sort((a, b) => a[1] - b[1]);
    const weakLines = state.lessons.filter(lessonNeedsWork).slice(0, 3)
      .map((lesson) => `${lesson.yourRepeatedMove} → ${lesson.recommendedMove}`).join("; ");
    setHtml("progressRecommendationPanel", [
      card("Opening", weakLines ? `Review these exact move corrections first: ${weakLines}.` : "Import games to identify repeated decision mistakes.", percent(state.accuracy.opening)),
      card("Middlegame", state.accuracy.middlegame < 73 ? "Pause on forcing moves, pawn breaks, and worst-piece improvement before committing." : "Maintain plan recognition with annotated game reviews.", percent(state.accuracy.middlegame)),
      card("Endgame", state.accuracy.endgame < 80 ? "Prioritize king activity, rook activity, and pawn-race counting." : "Maintain two endgame sessions each week.", percent(state.accuracy.endgame)),
      card("Tactics", recentWinRate < 52 ? "Do a short clean tactics block before playing, then review every loss immediately." : "Keep tactics short and daily; avoid exhausting calculation before games.", percent(recentWinRate)),
      card("Review priority", `${phases[0][0]} is the lowest phase. Pair it with the highest-priority exact position in your queue.`, "today"),
    ].join(""));
  }

  function renderSessions() {
    const items = state.sessions.slice().reverse();
    setHtml("progressSessionList", items.map((session) => card(
      `${session.date} · ${rating(session.startRating)} → ${rating(session.endRating)}`,
      `${session.wins}W ${session.draws}D ${session.losses}L${session.accuracy ? ` · ${percent(session.accuracy)} accuracy` : ""}`
        + `${session.openingAccuracy ? `<br>O ${percent(session.openingAccuracy)} · M ${percent(session.middlegameAccuracy)} · E ${percent(session.endgameAccuracy)}` : ""}`
        + `<br>${escapeHtml(session.notes || session.nextWork || "No notes")}`,
      session.theme || "training session"
    )).join("") || "No local progress sessions yet.", !items.length);
  }

  function renderIntelligence() {
    const weak = state.lessons.filter(lessonNeedsWork).sort((a, b) => b.priority - a.priority);
    const knownCount = state.reviews.filter((item) => item.lessonId && item.result === "known").length;
    const missedCount = state.reviews.filter((item) => item.lessonId && item.result === "missed").length;
    const totalReviews = knownCount + missedCount;
    setHtml("statsSummaryPanel", (() => {
      const data = importedStats();
      return data.total ? `<div class="analysis-landscape-metrics"><article><span>Games</span><strong>${count(data.total)}</strong></article><article><span>Record</span><strong>${data.wins}W ${data.draws}D ${data.losses}L</strong></article><article><span>Score</span><strong>${percent(data.score)}</strong></article><article><span>Controls</span><strong>${[...new Set(state.games.map((game) => game.timeClass))].join(", ")}</strong></article></div>` : "Import games to see the split.";
    })(), !state.branches.length);
    setHtml("memoryScorePanel", card("Retention", totalReviews ? percent(knownCount / totalReviews * 100) : "--", `${knownCount} clean · ${missedCount} missed`));
    const recentFirst = state.games.slice(-30).map((game) => game.moves[0]);
    const allFirst = state.games.map((game) => game.moves[0]);
    const recentTop = mostCommon(recentFirst);
    const allTop = mostCommon(allFirst);
    setHtml("driftDetectorPanel", card(recentTop || "No data", recentTop && allTop && recentTop !== allTop ? `Recent first move differs from your long-term ${allTop}. Decide whether to adopt or repair it.` : "Recent first-move choices match the long-term repertoire.", "opening drift"));
    setHtml("prepPackPanel", weak.slice(0, 5).map((lesson) => lessonCard(lesson, false)).join("") || "Import games to assemble a preparation pack.", !weak.length);
    setHtml("cacheDashboard", card(
      "Offline analysis cache",
      `${count(state.games.length)} normalized games, ${count(state.lessons.length)} exact-position lessons, and ${count(state.reviews.filter((item) => item.lessonId).length)} position reviews are stored on this device.`,
      state.importMeta?.fingerprint ? `fingerprint ${state.importMeta.fingerprint}` : "IndexedDB + local settings"
    ));
    setHtml("studyPlanPanel", [
      card("10 min", "Recall the best move in the top three due positions.", "warm-up"),
      card("20 min", "Train repeated best-move misses on the exact-position board.", "main work"),
      card("10 min", "Generate one database-backed theory continuation.", "extend"),
    ].join(""));
    const confidence = [
      ["High", state.lessons.filter((lesson) => lesson.confidence >= 70).length],
      ["Medium", state.lessons.filter((lesson) => lesson.confidence >= 40 && lesson.confidence < 70).length],
      ["Low", state.lessons.filter((lesson) => lesson.confidence < 40).length],
    ];
    setHtml("confidenceGraphPanel", confidence.map(([label, value]) => goalRow(label, value, Math.max(1, state.lessons.length))).join(""));
    setHtml("driftFixPanel", card(recentTop || "No drift data", recentTop && allTop && recentTop !== allTop ? `Either add ${recentTop} as a deliberate branch or return to ${allTop}.` : "No first-move repair is currently indicated.", "adopt or repair"));
    setHtml("importSpeedPanel", card("Browser import", `${importedStats().total} games indexed into ${state.analysisMeta?.candidates || 0} repeated positions.`, "direct public API"));
    setHtml("stockfishStatsPanel", card(
      "Browser Stockfish",
      state.analysisMeta
        ? `${count(state.analysisMeta.analyzed)} positions analyzed now · ${count(state.analysisMeta.cacheHits)} restored from the offline engine cache.`
        : "Run an import to analyze repeated positions locally.",
      "Stockfish 18 lite"
    ));
    const bestMoves = state.lessons.filter((lesson) => lesson.yourRepeatedMoveUci === lesson.recommendedMoveUci);
    setHtml("brilliantTrackerPanel", bestMoves.length
      ? bestMoves.slice(0, 8).map((lesson) => card(
          lesson.recommendedMove,
          `Your repeated move matches Stockfish across ${count(lesson.frequency)} visits to this exact position.`,
          lesson.openingName || lesson.lineLabel
        )).join("")
      : "No repeated position in the current analysis sample has your most-played move matching Stockfish yet.", !bestMoves.length);
  }

  function mostCommon(values) {
    const map = {};
    values.filter(Boolean).forEach((value) => { map[value] = (map[value] || 0) + 1; });
    return Object.entries(map).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  }

  function renderBoard() {
    const chess = state.trainer.chess;
    const orientation = state.trainer.orientation;
    const files = orientation === "white" ? ["a","b","c","d","e","f","g","h"] : ["h","g","f","e","d","c","b","a"];
    const ranks = orientation === "white" ? [8,7,6,5,4,3,2,1] : [1,2,3,4,5,6,7,8];
    const board = $("board");
    if (!board) return;
    if (state.trainer.renderedOrientation !== orientation || state.trainer.boardNodes.size !== 64) {
      setHtml("rankLabels", ranks.map((rankValue) => `<span>${rankValue}</span>`).join(""));
      setHtml("fileLabels", files.map((file) => `<span>${file}</span>`).join(""));
      const fragment = document.createDocumentFragment();
      state.trainer.boardNodes = new Map();
      ranks.forEach((rankValue) => files.forEach((file) => {
        const square = `${file}${rankValue}`;
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.square = square;
        fragment.appendChild(button);
        state.trainer.boardNodes.set(square, button);
      }));
      board.replaceChildren(fragment);
      board.__bookupHtml = null;
      state.trainer.renderedOrientation = orientation;
    }
    const selected = state.trainer.selected;
    const legal = selected ? chess.moves({ square: selected, verbose: true }) : [];
    const legalTargets = new Set(legal.map((move) => move.to));
    ranks.forEach((rankValue, rankIndex) => files.forEach((file, fileIndex) => {
      const square = `${file}${rankValue}`;
      const piece = chess.get(square);
      const dark = (rankIndex + fileIndex) % 2 === 1;
      const classes = ["square", dark ? "dark" : "light", "selectable"];
      if (selected === square) classes.push("selected");
      if (legalTargets.has(square)) classes.push(piece ? "legal-capture" : "legal-target");
      const node = state.trainer.boardNodes.get(square);
      node.className = classes.join(" ");
      const renderKey = `${piece ? piece.color + piece.type : ""}|${legalTargets.has(square) ? "target" : ""}`;
      if (node.dataset.renderKey !== renderKey) {
        const image = piece ? `<img class="piece" draggable="false" decoding="async" src="assets/pieces/cburnett/${piece.color}${PIECE_NAMES[piece.type]}.svg" alt="${piece.color === "w" ? "White" : "Black"} ${PIECE_NAMES[piece.type]}">` : "";
        node.innerHTML = `${legalTargets.has(square) ? '<span class="move-dot"></span>' : ""}${image}`;
        node.dataset.renderKey = renderKey;
      }
    }));
    setText("studyEvalScore", cloudScore());
    const score = cloudCp();
    const whiteShare = clamp(50 + score / 16, 5, 95);
    const fill = $("studyEvalFill");
    if (fill) fill.style.height = `${whiteShare}%`;
    const history = chess.history();
    setHtml("studyMoveTrail", history.length ? history.map((move, index) =>
      `<span>${index % 2 === 0 ? `${Math.floor(index / 2) + 1}. ` : ""}${escapeHtml(move)}</span>`
    ).join(" ") : "No moves played from this decision position yet.", !history.length);
  }

  function cloudCp() {
    const cp = state.cloud?.pvs?.[0]?.cp;
    const mate = state.cloud?.pvs?.[0]?.mate;
    if (Number.isFinite(cp)) return cp;
    if (Number.isFinite(mate)) return mate > 0 ? 1000 : -1000;
    return 0;
  }

  function cloudScore() {
    const pv = state.cloud?.pvs?.[0];
    if (!pv) return "+0.00";
    if (Number.isFinite(pv.mate)) return `#${pv.mate}`;
    const value = num(pv.cp) / 100;
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
  }

  function openBranch(index) {
    const branch = state.branches[num(index, -1)];
    if (!branch) return;
    state.selectedBranch = branch;
    state.selectedLesson = null;
    state.trainer.chess = new Chess();
    state.trainer.selected = "";
    state.trainer.orientation = branch.color;
    state.trainer.cursor = 0;
    state.trainer.mistakes = 0;
    state.cloud = null;
    state.database = null;
    setText("boardTitle", branch.moves.slice(0, 6).join(" "));
    setText("boardSummary", `Train this ${branch.color} branch from the beginning. Bookup checks legal moves and the imported continuation.`);
    setText("boardLine", branch.moves.join(" "));
    setText("trainerFeedback", `Your expected first move is ${branch.moves[0]}.`);
    setText("trainerDecision", "Choose a legal piece, then choose its destination.");
    setText("trainerCoach", "Your move is compared with the imported repertoire. Opponent moves are replayed automatically.");
    markTabsDirty("trainer");
    activateTab("trainer");
    requestPositionData();
  }

  function openLesson(lessonId) {
    const lesson = state.lessons.find((item) => item.lessonId === String(lessonId));
    if (!lesson) return;
    state.selectedLesson = lesson;
    state.selectedBranch = null;
    state.trainer.chess = new Chess(lesson.decisionFen);
    state.trainer.selected = "";
    state.trainer.orientation = lesson.color;
    state.trainer.cursor = 0;
    state.trainer.mistakes = 0;
    state.cloud = null;
    state.database = null;
    setText("boardTitle", lesson.openingName || lesson.lineLabel || "Exact decision position");
    setText("boardSummary", `This is the exact position where you repeatedly played ${lesson.yourRepeatedMove}. Find Stockfish's best move.`);
    setText("boardLine", `${lesson.introLineSan || lesson.lineLabel} · best continuation: ${lesson.continuationSan || lesson.recommendedMove}`);
    setText("trainerFeedback", `Your repeated move was ${lesson.yourRepeatedMove}. Find a stronger move.`);
    setText("trainerDecision", `You are ${lesson.color}. Choose the best move in this position.`);
    setText("trainerCoach", `${count(lesson.repeatMistakeCount)} repeats · about ${(num(lesson.valueLostCp) / 100).toFixed(2)} pawns lost · ${Math.round(num(lesson.confidence))}% confidence`);
    setText("studyMoveMeta", "Exact position");
    setHtml("studyMoveClassifications", card(
      `${lesson.yourRepeatedMove} was ${lesson.classification?.label || "weaker"}`,
      `The target move is hidden until you play. This lesson was built from ${count(lesson.frequency)} visits to this exact FEN.`,
      "Stockfish lesson"
    ));
    markTabsDirty("trainer");
    activateTab("trainer");
    requestPositionData();
  }

  function moveMatchesUci(move, uci) {
    return Boolean(move && uci && `${move.from}${move.to}${move.promotion || ""}` === uci);
  }

  function clickSquare(square) {
    const chess = state.trainer.chess;
    const selected = state.trainer.selected;
    if (!selected) {
      const piece = chess.get(square);
      if (piece && piece.color === chess.turn()) {
        state.trainer.selected = square;
        renderBoard();
      }
      return;
    }
    if (selected === square) {
      state.trainer.selected = "";
      renderBoard();
      return;
    }
    const move = chess.move({ from: selected, to: square, promotion: "q" });
    state.trainer.selected = "";
    if (!move) {
      const piece = chess.get(square);
      if (piece && piece.color === chess.turn()) state.trainer.selected = square;
      renderBoard();
      return;
    }
    const lesson = state.selectedLesson;
    if (lesson) {
      const expectedUci = lesson.trainingLineUci?.[state.trainer.cursor] || lesson.recommendedMoveUci;
      const correct = moveMatchesUci(move, expectedUci);
      if (!correct) {
        state.trainer.mistakes += 1;
        chess.undo();
        setText("studyMoveMeta", "Try again");
        setHtml("studyMoveClassifications", card(
          move.san,
          `${move.san} is legal, but Stockfish's best move here is ${lesson.recommendedMove}. The position remains on the board so you can correct it.`,
          lesson.classification?.label || "miss"
        ));
        setText("trainerFeedback", `${move.san} was not the target. Try ${lesson.recommendedMove}.`);
        renderBoard();
        return;
      }
      state.trainer.cursor += 1;
      setText("studyMoveMeta", "Best move");
      setHtml("studyMoveClassifications", card(
        move.san,
        `Correct. ${lesson.continuationSan ? `Continue with ${escapeHtml(lesson.continuationSan)}.` : "The exact-position lesson is complete."}`,
        "Stockfish best"
      ));
      setText("trainerFeedback", `Correct: ${move.san}.`);
      if (state.trainer.cursor >= (lesson.trainingLineUci?.length || 1)) {
        finishTrainer(state.trainer.mistakes === 0);
      } else {
        window.setTimeout(playOpponentMoves, 260);
      }
      renderBoard();
      requestPositionData();
      return;
    }
    const branch = state.selectedBranch;
    const expected = branch?.moves[state.trainer.cursor];
    const correct = !expected || move.san === expected || move.san.replace(/[+#]/g, "") === expected.replace(/[+#]/g, "");
    if (!correct) state.trainer.mistakes += 1;
    setText("studyMoveMeta", correct ? "Book move" : "Outside imported line");
    setHtml("studyMoveClassifications", card(move.san, correct ? "Matches this imported repertoire branch." : `Expected ${expected}. The move was legal, but this line is now marked for review.`, correct ? "book" : "miss"));
    state.trainer.cursor += 1;
    if (branch && state.trainer.cursor >= branch.moves.length) {
      finishTrainer(correct && state.trainer.mistakes === 0);
    } else {
      setText("trainerFeedback", correct ? `Correct: ${move.san}.` : `${move.san} is legal, but the imported continuation was ${expected}.`);
      window.setTimeout(playOpponentMoves, 260);
    }
    renderBoard();
    requestPositionData();
  }

  function playOpponentMoves() {
    const lesson = state.selectedLesson;
    if (lesson) {
      const userTurn = lesson.color === "white" ? "w" : "b";
      while (state.trainer.cursor < lesson.trainingLineUci.length && state.trainer.chess.turn() !== userTurn) {
        const uci = lesson.trainingLineUci[state.trainer.cursor];
        const move = state.trainer.chess.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.slice(4, 5) || "q",
        });
        if (!move) break;
        state.trainer.cursor += 1;
      }
      if (state.trainer.cursor >= lesson.trainingLineUci.length) {
        finishTrainer(state.trainer.mistakes === 0);
      } else {
        const expectedUci = lesson.trainingLineUci[state.trainer.cursor];
        const probe = new Chess(state.trainer.chess.fen());
        const expected = probe.move({
          from: expectedUci.slice(0, 2),
          to: expectedUci.slice(2, 4),
          promotion: expectedUci.slice(4, 5) || "q",
        });
        setText("trainerDecision", `Your move. Find ${expected?.san || "the best continuation"}.`);
      }
      renderBoard();
      requestPositionData();
      return;
    }
    const branch = state.selectedBranch;
    if (!branch) return;
    const userTurn = branch.color === "white" ? "w" : "b";
    while (state.trainer.cursor < branch.moves.length && state.trainer.chess.turn() !== userTurn) {
      const san = branch.moves[state.trainer.cursor];
      const move = state.trainer.chess.move(san, { sloppy: true });
      if (!move) break;
      state.trainer.cursor += 1;
    }
    if (state.trainer.cursor >= branch.moves.length) finishTrainer(state.trainer.mistakes === 0);
    else setText("trainerDecision", `Your move. Imported continuation: ${branch.moves[state.trainer.cursor]}.`);
    renderBoard();
    requestPositionData();
  }

  function finishTrainer(clean) {
    const lesson = state.selectedLesson;
    if (lesson) {
      const previous = latestLessonReview(lesson.lessonId);
      const streak = clean ? num(previous?.streak) + 1 : 0;
      const intervals = [1, 3, 7, 14, 30];
      const interval = clean ? intervals[Math.min(streak, intervals.length - 1)] : 1;
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + interval);
      state.reviews.push({
        lessonId: lesson.lessonId,
        result: clean ? "known" : "missed",
        date: today(),
        due: dueDate.toISOString().slice(0, 10),
        streak,
        line: `${lesson.lineLabel}: ${lesson.recommendedMove}`,
        note: clean ? "Clean exact-position repetition" : `${state.trainer.mistakes} incorrect attempt(s)`,
      });
      save();
      markTabsDirty("setup", "repertoire-map", "needs-work", "trainer", "review", "stats");
      setText("trainerFeedback", clean
        ? `Position complete. Next review is ${dueDate.toLocaleDateString()}.`
        : "Position complete after a correction. It is due again tomorrow.");
      renderQueue();
      return;
    }
    const branch = state.selectedBranch;
    if (!branch) return;
    const interval = clean ? 7 : 1;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + interval);
    state.reviews.push({
      branchId: branch.id,
      result: clean ? "known" : "missed",
      date: today(),
      due: dueDate.toISOString().slice(0, 10),
      line: branch.moves.slice(0, 10).join(" "),
      note: clean ? "Clean board repetition" : `${state.trainer.mistakes} mismatch(es)`,
    });
    save();
    markTabsDirty("setup", "repertoire-map", "needs-work", "trainer", "review", "stats");
    setText("trainerFeedback", clean ? "Line complete. Clean repetition saved." : "Line complete. It has been scheduled for a near-term retry.");
    renderQueue();
  }

  function fenKey(fen) {
    return String(fen || "").split(" ").slice(0, 4).join(" ");
  }

  function sessionToken() {
    return String($("studyLichessTokenInput")?.value || $("lichessTokenInput")?.value || $("smartTheoryLichessToken")?.value || "").trim();
  }

  function buildPositionIndex() {
    const positions = new Map();
    for (const branch of state.branches) {
      const chess = new Chess();
      for (const san of branch.moves) {
        const key = fenKey(chess.fen());
        if (!positions.has(key)) positions.set(key, { source: "local", white: 0, draws: 0, black: 0, moveMap: new Map() });
        const position = positions.get(key);
        if (!position.moveMap.has(san)) position.moveMap.set(san, { san, white: 0, draws: 0, black: 0, source: "imported games" });
        const item = position.moveMap.get(san);
        const whiteWins = branch.color === "white" ? branch.wins : branch.losses;
        const blackWins = branch.color === "black" ? branch.wins : branch.losses;
        item.white += whiteWins;
        item.draws += branch.draws;
        item.black += blackWins;
        position.white += whiteWins;
        position.draws += branch.draws;
        position.black += blackWins;
        if (!chess.move(san, { sloppy: true })) break;
      }
    }
    positions.forEach((position) => {
      position.moves = [...position.moveMap.values()].sort((a, b) => (b.white + b.draws + b.black) - (a.white + a.draws + a.black));
      delete position.moveMap;
    });
    state.positionIndex = positions;
    return positions;
  }

  function localPositionData(fen) {
    const positions = state.positionIndex || buildPositionIndex();
    const existing = positions.get(fenKey(fen));
    if (existing) return existing;
    return {
      source: "local",
      white: 0,
      draws: 0,
      black: 0,
      moves: [],
    };
  }

  function memoizedRequest(cache, key, loader, limit = 160) {
    if (cache.has(key)) return cache.get(key);
    const request = loader().catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, request);
    if (cache.size > limit) cache.delete(cache.keys().next().value);
    return request;
  }

  function persistentAnalysisRequest(memoryCache, key, loader, maxAgeMs) {
    return memoizedRequest(memoryCache, key, async () => {
      const cached = await readAnalysisCache(key, maxAgeMs).catch(() => null);
      if (cached) return cached;
      const payload = await loader();
      writeAnalysisCache(key, payload).catch(() => {});
      return payload;
    });
  }

  function fetchCloud(fen, multiPv = 1) {
    const key = `cloud:${fenKey(fen)}|${multiPv}`;
    return persistentAnalysisRequest(cloudCache, key, () =>
      fetchJson(`https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}&variant=standard`)
    , 7 * 24 * 60 * 60 * 1000);
  }

  async function fetchExplorerSource(fen, token) {
    const url = `https://explorer.lichess.org/lichess?variant=standard&speeds=bullet,blitz,rapid,classical&ratings=1000,1200,1400,1600,1800,2000,2200,2500&fen=${encodeURIComponent(fen)}`;
    const key = `explorer:lichess:${fenKey(fen)}`;
    const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
    const payload = await persistentAnalysisRequest(explorerCache, key, () =>
      fetchJson(url, { headers }, 18000)
    , 24 * 60 * 60 * 1000);
    return { ...payload, source: "lichess" };
  }

  async function fetchExplorer(fen) {
    const token = sessionToken();
    if (!token) return null;
    return fetchExplorerSource(fen, token);
  }

  async function positionData(fen) {
    const local = localPositionData(fen);
    if (local.moves.length) return local;
    try { return await fetchExplorer(fen) || local; }
    catch { return local; }
  }

  async function cloudChoice(fen) {
    try {
      const payload = await fetchCloud(fen, 1);
      const uci = String(payload.pvs?.[0]?.moves || "").split(/\s+/)[0];
      if (!uci) return null;
      const chess = new Chess(fen);
      const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || "q" });
      if (!move) return null;
      return { san: move.san, uci, white: 0, draws: 0, black: 0, source: "Lichess cloud evaluation" };
    } catch {
      return null;
    }
  }

  async function requestPositionData() {
    const fen = state.trainer.chess.fen();
    const requestId = ++state.positionRequestId;
    setText("studyOpeningMeta", "Loading imported-game database and public cloud evaluation...");
    setText("studyDatabaseMeta", "Loading");
    setText("studyAnalysisMeta", "Public cloud");
    setHtml("studyPositionLinks", `<a class="ghost-btn" href="https://lichess.org/analysis/standard/${escapeHtml(fen.replaceAll(" ", "_"))}" target="_blank" rel="noopener">Open position in Lichess</a>`);
    state.database = localPositionData(fen);
    const [cloudResult, explorerResult] = await Promise.allSettled([
      fetchCloud(fen, 3),
      fetchExplorer(fen),
    ]);
    if (requestId !== state.positionRequestId || fen !== state.trainer.chess.fen()) return;
    state.cloud = cloudResult.status === "fulfilled" ? cloudResult.value : null;
    if (explorerResult.status === "fulfilled" && explorerResult.value) state.database = explorerResult.value;
    renderPositionData();
    renderBoard();
    if (state.activeTab === "stats") renderIntelligence();
  }

  function renderPositionData() {
    const db = state.database;
    if (db) {
      const total = num(db.white) + num(db.draws) + num(db.black);
      setText("studyOpeningMeta", `${db.opening?.name || (db.source === "local" ? "Your imported games" : "Lichess opening position")} · ${count(total)} database games`);
      setText("studyDatabaseMeta", `${count(total)} games${db.source === "local" ? " · local corpus" : " · Lichess"}`);
      setHtml("studyDatabaseMoves", (db.moves || []).slice(0, 8).map((move) => {
        const games = num(move.white) + num(move.draws) + num(move.black);
        return card(move.san || move.uci, `${count(games)} games · White ${percent(games ? move.white / games * 100 : 0)} · Draw ${percent(games ? move.draws / games * 100 : 0)}`, db.source === "local" ? "your imported games" : "Lichess database");
      }).join("") || "No public database moves for this position.", !(db.moves || []).length);
    } else {
      setText("studyOpeningMeta", "No public opening database result for this position.");
      setText("studyDatabaseMeta", "Unavailable");
      setHtml("studyDatabaseMoves", "Database unavailable or this position has no indexed games.", true);
    }
    const cloud = state.cloud;
    if (cloud?.pvs?.length) {
      setText("studyAnalysisMeta", `Depth ${cloud.depth || "?"} · ${cloud.pvs.length} PV`);
      setText("studyEvalCaption", "Lichess cloud evaluation");
      setHtml("studyEngineLines", cloud.pvs.map((pv, index) => card(`#${index + 1} ${Number.isFinite(pv.mate) ? `#${pv.mate}` : `${num(pv.cp) >= 0 ? "+" : ""}${(num(pv.cp) / 100).toFixed(2)}`}`, escapeHtml(pv.moves || ""), "cloud PV")).join(""));
    } else {
      setText("studyAnalysisMeta", "No cached cloud analysis");
      setText("studyEvalCaption", "No public cloud evaluation");
      setHtml("studyEngineLines", "This position is not currently available in the public cloud cache.", true);
    }
  }

  function renderQueue() {
    const queue = dueLessons();
    const due = queue.filter((lesson) => Boolean(latestLessonReview(lesson.lessonId))).slice(0, 16);
    const fresh = queue.filter((lesson) => !latestLessonReview(lesson.lessonId)).slice(0, 16);
    setText("lessonQueueMeta", `${due.length} due · ${fresh.length} new`);
    setHtml("lessonListDue", due.map((lesson) => lessonCard(lesson)).join("") || "No reviewed positions are due today.", !due.length);
    setHtml("lessonListNew", fresh.map((lesson) => lessonCard(lesson)).join("") || "No new repeated mistakes are waiting.", !fresh.length);
  }

  function repertoirePgn() {
    return state.branches.map((branch, index) => {
      const tokens = [];
      branch.moves.forEach((move, ply) => {
        if (ply % 2 === 0) tokens.push(`${Math.floor(ply / 2) + 1}.`);
        tokens.push(move);
      });
      return `[Event "Bookup Web Line ${index + 1}"]\n[Site "https://tetizz.github.io/Bookup/"]\n[Date "${today().replaceAll("-", ".")}"]\n[Round "-"]\n[White "${branch.color === "white" ? state.username : "Repertoire opponent"}"]\n[Black "${branch.color === "black" ? state.username : "Repertoire opponent"}"]\n[Result "*"]\n\n${tokens.join(" ")} *`;
    }).join("\n\n");
  }

  function download(name, content, type = "text/plain") {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function generateTheory() {
    const requestedMove = String($("theoryMoveInput")?.value || "").trim();
    const plies = clamp(num($("theoryPlyInput")?.value, 10), 1, 20);
    const chess = new Chess(state.trainer.chess.fen());
    if (requestedMove && !chess.move(requestedMove, { sloppy: true })) {
      setHtml("theoryOutput", `Move ${escapeHtml(requestedMove)} is not legal in the current board position.`, false);
      return;
    }
    setHtml("theoryOutput", "Querying the public opening database...");
    const generated = [];
    for (let ply = 0; ply < plies; ply += 1) {
      const payload = await positionData(chess.fen());
      const choice = payload.moves?.[0] || await cloudChoice(chess.fen());
      if (!choice) break;
      const move = chess.move(choice.san || choice.uci, { sloppy: true });
      if (!move) break;
      generated.push({ san: move.san, games: num(choice.white) + num(choice.draws) + num(choice.black), opening: payload.opening?.name || "", source: choice.source || payload.source });
    }
    setHtml("theoryOutput", generated.length ? generated.map((item, index) => card(`${index + 1}. ${item.san}`, item.games ? `${count(item.games)} real imported/database games` : "Top public cloud-evaluation continuation", item.opening || item.source || "verified continuation")).join("") : "No real database or cloud continuation exists for this position.", !generated.length);
  }

  async function generateSmartTheory() {
    state.smartStop = false;
    const source = $("smartTheoryStartingSource")?.value || "starting_position";
    const maxPly = clamp(num($("smartTheoryMaxPly")?.value, 12), 2, 20);
    const configuredReplies = clamp(num($("smartTheoryReplies")?.value, 3), 1, 12);
    const opponentProfile = $("smartTheoryOpponentAccuracy")?.value || "mixed";
    const replyCount = {
      grandmaster: Math.min(2, configuredReplies),
      strong_club: Math.min(3, configuredReplies),
      club: Math.min(5, configuredReplies),
      beginner_intermediate: Math.min(8, configuredReplies + 2),
      mixed: configuredReplies,
    }[opponentProfile] || configuredReplies;
    const includeRare = Boolean($("smartTheoryIncludeRare")?.checked);
    let fen = new Chess().fen();
    if (source === "current_board" || source === "selected_move") fen = state.trainer.chess.fen();
    if (source === "saved_line" && state.selectedBranch) {
      const seed = new Chess();
      state.selectedBranch.moves.slice(0, 8).forEach((move) => seed.move(move, { sloppy: true }));
      fen = seed.fen();
    }
    if (source === "custom_fen") fen = String($("smartTheoryCustomFen")?.value || fen);
    if (!new Chess().validate_fen(fen).valid) {
      setText("smartTheoryStatus", "Invalid FEN");
      return;
    }
    setText("smartTheoryStatus", "Generating");
    setText("smartTheoryProgress", "Starting public database search...");
    const root = { san: "Start", fen, children: [], path: [], games: 0 };
    const queue = [{ node: root, ply: 0 }];
    let positions = 0;
    const maxPositions = clamp(num($("smartTheoryMaxPositions")?.value, 80), 10, 300);
    while (queue.length && positions < maxPositions && !state.smartStop) {
      const { node, ply } = queue.shift();
      if (ply >= maxPly) continue;
      let payload;
      try { payload = await positionData(node.fen); } catch { payload = null; }
      const chess = new Chess(node.fen);
      const myColor = $("smartTheoryMyColor")?.value === "black" ? "b" : "w";
      let choices;
      if (chess.turn() === myColor) {
        const correction = state.lessons.find((lesson) => fenKey(lesson.decisionFen) === fenKey(node.fen) && lessonNeedsWork(lesson));
        if (correction) {
          choices = [{
            san: correction.recommendedMove,
            uci: correction.recommendedMoveUci,
            white: 0,
            draws: 0,
            black: 0,
            source: "local Stockfish correction",
          }];
        } else {
          const cloud = await cloudChoice(node.fen);
          choices = cloud ? [cloud] : (payload?.moves || []).slice(0, 1);
        }
      } else {
        choices = (payload?.moves || []).slice(0, replyCount);
      }
      if (!includeRare && choices.length > 1) {
        const topGames = num(choices[0].white) + num(choices[0].draws) + num(choices[0].black);
        choices = choices.filter((choice, index) => {
          if (index === 0) return true;
          const games = num(choice.white) + num(choice.draws) + num(choice.black);
          return games >= Math.max(2, topGames * 0.05);
        });
      }
      if (!choices.length) {
        const cloud = await cloudChoice(node.fen);
        if (cloud) choices = [cloud];
      }
      for (const choice of choices) {
        const next = new Chess(node.fen);
        const move = next.move(choice.san, { sloppy: true });
        if (!move) continue;
        const games = num(choice.white) + num(choice.draws) + num(choice.black);
        const child = {
          san: move.san, uci: choice.uci, fen: next.fen(), games,
          opening: payload?.opening?.name || "", path: [...node.path, move.san], children: [],
          white: num(choice.white), draws: num(choice.draws), black: num(choice.black),
          source: choice.source || payload?.source || "cloud",
        };
        node.children.push(child);
        queue.push({ node: child, ply: ply + 1 });
      }
      positions += 1;
      setText("smartTheoryProgress", `${positions} positions · ${queue.length} queued`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    state.smartTree = root;
    setText("smartTheoryStatus", state.smartStop ? "Stopped" : "Complete");
    setText("smartTheoryProgress", `${positions} public positions generated for the ${opponentProfile.replaceAll("_", " ")} profile.`);
    renderSmartTheory();
  }

  function flattenTree(node, output = []) {
    (node?.children || []).forEach((child) => {
      output.push(child);
      flattenTree(child, output);
    });
    return output;
  }

  function renderSmartTheory() {
    const root = state.smartTree;
    if (!root) return;
    const nodes = flattenTree(root);
    const first = nodes[0];
    setHtml("smartTheoryRunSummary", card("Generation complete", `${nodes.length} moves from real imported games, authenticated opening data when available, and public cloud evaluation. No generated move is fabricated.`, "browser theory"));
    setHtml("smartTheoryCurrentMeta", first ? card(first.san, first.path.join(" "), `${count(first.games)} games`) : "No generated node.", !first);
    setHtml("smartTheoryMoveList", first ? card("Main path", first.path.join(" "), "SAN") : "No path.", !first);
    setHtml("smartTheoryOpeningMeta", first ? card(first.opening || "Unclassified position", first.fen, "FEN") : "No opening data.", !first);
    const correction = first?.source === "local Stockfish correction";
    setHtml("smartTheoryRecommendation", first ? card(
      first.san,
      correction
        ? "Recommended by the cached exact-position Stockfish lesson because your repeated move missed the best move here."
        : `Most-played continuation among the selected public database filters (${count(first.games)} games).`,
      correction ? "Stockfish correction" : "database recommendation"
    ) : "No recommendation.", !first);
    setHtml("smartTheoryLearningQueue", nodes.slice().sort((a, b) => b.games - a.games).slice(0, 8).map((node) => card(node.path.join(" "), `${count(node.games)} public games`, "study first")).join("") || "No learning queue.", !nodes.length);
    setHtml("smartTheoryOpponentReplies", root.children.map((node) => card(node.san, `${count(node.games)} public games`, node.opening || "reply")).join("") || "No replies.", !root.children.length);
    setHtml("smartTheoryExplanation", first ? card(
      "Why this move",
      correction
        ? `${first.san} replaces the repeated mistake found at this exact FEN. The recommendation comes from local browser Stockfish and is saved in the offline lesson cache.`
        : `${first.san} is the highest-volume continuation in the available imported or public opening data for this position.`,
      first.source || "evidence"
    ) : "No explanation.", !first);
    const search = String($("smartTheoryTreeSearch")?.value || "").trim().toLowerCase();
    if (search) {
      const matches = nodes.filter((node) => [
        node.san, node.uci, node.opening, node.path.join(" "),
      ].some((value) => String(value || "").toLowerCase().includes(search)));
      setHtml("smartTheoryTree", matches.slice(0, 80).map((node) => card(
        node.path.join(" "),
        `${count(node.games)} public games · ${escapeHtml(node.opening || node.source || "position")}`,
        node.san
      )).join("") || "No generated line matches this search.", !matches.length);
    } else {
      setHtml("smartTheoryTree", renderSmartNodes(root.children));
    }
    renderMiniBoard(first?.fen || root.fen);
  }

  function renderSmartNodes(nodes, depth = 0) {
    return (nodes || []).map((node) => `<details class="move-tree-node" ${depth < 1 ? "open" : ""}><summary><strong>${escapeHtml(node.san)}</strong><span>${count(node.games)} games</span></summary><div class="tree-node-list">${depth < 8 ? renderSmartNodes(node.children, depth + 1) : ""}</div></details>`).join("");
  }

  function renderMiniBoard(fen) {
    const chess = new Chess(fen);
    const board = chess.board();
    const html = `<div class="mini-board">${board.flatMap((rank, rankIndex) => rank.map((piece, fileIndex) => {
      const dark = (rankIndex + fileIndex) % 2 === 1;
      const image = piece ? `<img src="assets/pieces/cburnett/${piece.color}${PIECE_NAMES[piece.type]}.svg" alt="">` : "";
      return `<div class="mini-square ${dark ? "dark" : "light"}">${image}</div>`;
    })).join("")}</div>`;
    setHtml("smartTheoryMiniBoard", html);
  }

  function renderTab(name, force = false) {
    if (!force && !state.dirtyTabs.has(name)) return;
    if (name === "setup") renderSummary();
    else if (name === "repertoire-map") {
      renderHealth();
      renderRepertoire();
    } else if (name === "stats") {
      renderProgress();
      clearTimeout(state.intelligenceTimer);
      state.intelligenceTimer = window.setTimeout(() => {
        state.intelligenceTimer = 0;
        if (state.activeTab === "stats") renderIntelligence();
        else state.dirtyTabs.add("stats");
      }, 80);
    } else if (name === "needs-work") {
      renderNeedsWork();
    } else if (name === "trainer") {
      renderQueue();
      renderBoard();
    } else if (name === "theory") {
      renderMoveTree();
      renderTheoryTools();
    } else if (name === "smart-theory" && state.smartTree) {
      renderSmartTheory();
    } else if (name === "review") {
      renderReviewSchedule();
    }
    state.dirtyTabs.delete(name);
  }

  function renderAll() {
    renderSummary();
    state.dirtyTabs.delete("setup");
    renderTab(state.activeTab);
  }

  function activateTab(name) {
    if (name === "trainer" && !state.selectedLesson && !state.selectedBranch) {
      const next = dueLessons()[0];
      if (next) {
        openLesson(next.lessonId);
        return;
      }
    }
    state.activeTab = name;
    qsa("[data-tab-target]").forEach((button) => button.classList.toggle("active", button.dataset.tabTarget === name));
    qsa("[data-tab-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.tabPanel === name));
    if (state.tabFrame) cancelAnimationFrame(state.tabFrame);
    state.tabFrame = requestAnimationFrame(() => {
      state.tabFrame = 0;
      if (state.activeTab === name) renderTab(name);
    });
    window.scrollTo({ top: document.querySelector(".workspace-tabs")?.offsetTop || 0, behavior: "auto" });
  }

  function splitPgnGames(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const chunks = [];
    let current = [];
    let hasMoves = false;
    for (const line of lines) {
      const trimmed = line.trim();
      const isHeader = /^\[[A-Za-z0-9_]+\s+".*"\]$/.test(trimmed);
      if (isHeader && hasMoves) {
        const chunk = current.join("\n").trim();
        if (chunk) chunks.push(chunk);
        current = [];
        hasMoves = false;
      }
      current.push(line);
      if (trimmed && !isHeader && /\b(?:O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|\d+\.)\b/.test(trimmed)) hasMoves = true;
    }
    const finalChunk = current.join("\n").trim();
    if (finalChunk) chunks.push(finalChunk);
    return chunks;
  }

  function stableTextId(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `local-${(hash >>> 0).toString(16)}`;
  }

  async function importPgnText(text, options = {}) {
    const chunks = splitPgnGames(text);
    const existing = new Set(state.games.map((game) => String(game.id)));
    const parsed = [];
    let skipped = 0;
    let duplicates = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const pgn = chunks[index];
      const id = stableTextId(pgn.replace(/\s+/g, " ").trim());
      if (existing.has(id)) {
        duplicates += 1;
        continue;
      }
      const game = parseGame({ pgn, uuid: id }, options);
      if (game) {
        parsed.push(game);
        existing.add(id);
      } else {
        skipped += 1;
      }
      if (index > 0 && index % 30 === 0) await yieldToMain();
    }
    if (!parsed.length && !duplicates) throw new Error(`No valid PGN games were found. ${skipped} section(s) could not be parsed.`);
    const previousWorkspace = {
      games: state.games,
      branches: state.branches,
      lessons: state.lessons,
      importMeta: state.importMeta,
      analysisMeta: state.analysisMeta,
    };
    try {
      state.games = [...state.games, ...parsed].sort((a, b) => a.endTime - b.endTime);
      state.branches = buildBranches(state.games);
      state.importMeta = {
        source: options.source || "Local PGN",
        imported: parsed.length,
        totalCached: state.games.length,
        duplicates,
        skipped,
        warnings: [],
        completedAt: Date.now(),
        fingerprint: gameFingerprint(state.games),
      };
      markDataDirty();
      await analyzeImportedPositions(options.signal, 20, 96);
      markDataDirty();
      save();
      renderAll();
      await persistAnalysisCache();
      setImportProgress(1, 1, `Analysis complete: ${count(state.analysisMeta?.due || 0)} exact positions need work.`, 100, 100);
      return { imported: parsed.length, duplicates, skipped, total: state.games.length };
    } catch (error) {
      Object.assign(state, previousWorkspace);
      markDataDirty();
      renderAll();
      throw error;
    }
  }

  function bind() {
    qsa("[data-tab-target]").forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.tabTarget)));
    qsa("[data-progress-mode]").forEach((button) => button.addEventListener("click", () => {
      state.mode = button.dataset.progressMode;
      save();
      renderProgress();
    }));
    document.addEventListener("click", (event) => {
      const lessonButton = event.target.closest("[data-open-lesson]");
      if (lessonButton) openLesson(lessonButton.dataset.openLesson);
      const branchButton = event.target.closest("[data-open-branch]");
      if (branchButton) openBranch(branchButton.dataset.openBranch);
      const square = event.target.closest("[data-square]");
      if (square) clickSquare(square.dataset.square);
      const reveal = event.target.closest("[data-reveal]");
      if (reveal) reveal.parentElement.querySelector(".quiz-answer")?.removeAttribute("hidden");
      const exportName = state.username || "player";
      if (event.target.closest("#downloadPgnBtn")) download(`bookup-${exportName}-repertoire.pgn`, repertoirePgn(), "application/x-chess-pgn");
      if (event.target.closest("#downloadJsonBtn")) download(`bookup-${exportName}.json`, JSON.stringify({ version: 1, username: state.username, branches: state.branches, reviews: state.reviews }, null, 2), "application/json");
    });
    $("analyzeBtn")?.addEventListener("click", refreshAll);
    $("progressRefreshBtn")?.addEventListener("click", refreshAll);
    $("stopImportBtn")?.addEventListener("click", () => state.importController?.abort());
    $("mainUsernameInput")?.addEventListener("input", (event) => {
      if ($("usernameInput")) $("usernameInput").value = event.currentTarget.value;
    });
    $("usernameInput")?.addEventListener("input", (event) => {
      if ($("mainUsernameInput")) $("mainUsernameInput").value = event.currentTarget.value;
    });
    $("saveSetupBtn")?.addEventListener("click", () => {
      state.username = String($("usernameInput")?.value || state.username).trim();
      state.settings.maxGames = clamp(num($("maxGamesInput")?.value, 240), 1, 20000);
      state.settings.timeClasses = parseTimeClasses($("timeClassesInput")?.value);
      state.settings.importAllGames = Boolean($("importAllGamesInput")?.checked);
      state.settings.autoImportStartup = Boolean($("autoImportStartupInput")?.checked);
      save();
      status("Setup saved in this browser.", "success");
    });
    $("resetWorkspaceBtn")?.addEventListener("click", async () => {
      if (!confirm("Clear Bookup Web data stored in this browser?")) return;
      localStorage.removeItem(STORAGE_KEY);
      await clearWorkspaceCache().catch(() => {});
      location.reload();
    });
    $("reclassifyFreshBtn")?.addEventListener("click", () => {
      state.reviews = [];
      state.branches = buildBranches(state.games);
      markDataDirty();
      save();
      persistAnalysisCache().catch(() => {});
      renderAll(); status("Position review history reset. Engine lessons remain cached.", "success");
    });
    $("importPgnBtn")?.addEventListener("click", async () => {
      state.importController = new AbortController();
      try {
        const report = await importPgnText($("pgnImportInput")?.value, { source: "Local PGN", signal: state.importController.signal });
        setText("pgnImportStatus", `Imported ${report.imported}; ignored ${report.duplicates} duplicates; ${report.skipped} failed to parse. ${state.analysisMeta?.due || 0} exact positions need work and are cached offline.`);
      } catch (error) { setText("pgnImportStatus", error.name === "AbortError" ? "Import stopped." : error.message); }
      finally { state.importController = null; }
    });
    $("importChessnutBtn")?.addEventListener("click", async () => {
      const file = $("chessnutDbPathInput")?.files?.[0];
      if (!file) { setText("chessnutImportStatus", "Select a PGN export first."); return; }
      try {
        const report = await importPgnText(await file.text(), {
          source: "NewChessnut PGN",
          playerColor: $("chessnutPlayerColorInput")?.value || "white",
        });
        setText("chessnutImportStatus", `Imported ${report.imported}; ignored ${report.duplicates} duplicates; ${report.skipped} failed to parse. ${state.analysisMeta?.due || 0} exact positions need work and are cached offline.`);
      } catch (error) { setText("chessnutImportStatus", error.message); }
    });
    $("trainerResetBtn")?.addEventListener("click", () => {
      if (state.selectedLesson) openLesson(state.selectedLesson.lessonId);
      else if (state.selectedBranch) openBranch(state.branches.indexOf(state.selectedBranch));
    });
    $("trainerNextBtn")?.addEventListener("click", () => {
      const queue = dueLessons();
      const current = queue.findIndex((lesson) => lesson.lessonId === state.selectedLesson?.lessonId);
      const next = queue[(current + 1) % Math.max(1, queue.length)];
      if (next) openLesson(next.lessonId);
    });
    $("studyApplySettingsBtn")?.addEventListener("click", () => {
      const token = $("studyLichessTokenInput")?.value || "";
      if ($("lichessTokenInput")) $("lichessTokenInput").value = token;
      setText("studySettingsStatus", "Browser analysis settings applied. Tokens remain in memory only and are never saved.");
      requestPositionData();
    });
    $("generateTheoryBtn")?.addEventListener("click", () => generateTheory().catch((error) => setHtml("theoryOutput", escapeHtml(error.message))));
    qsa("[data-smart-preset]").forEach((button) => button.addEventListener("click", () => {
      const presets = {
        balanced: { replies: 4, ply: 12, positions: 80, opponent: "mixed" },
        fast: { replies: 2, ply: 8, positions: 30, opponent: "club" },
        deep: { replies: 6, ply: 18, positions: 180, opponent: "grandmaster" },
        realistic: { replies: 6, ply: 14, positions: 120, opponent: "mixed" },
      };
      const preset = presets[button.dataset.smartPreset] || presets.balanced;
      if ($("smartTheoryReplies")) $("smartTheoryReplies").value = preset.replies;
      if ($("smartTheoryMaxPly")) $("smartTheoryMaxPly").value = preset.ply;
      if ($("smartTheoryMaxPositions")) $("smartTheoryMaxPositions").value = preset.positions;
      if ($("smartTheoryOpponentAccuracy")) $("smartTheoryOpponentAccuracy").value = preset.opponent;
      qsa("[data-smart-preset]").forEach((item) => item.classList.toggle("active", item === button));
      setText("smartTheoryProgress", `${button.textContent.trim()} preset applied.`);
    }));
    $("smartTheoryGenerateBtn")?.addEventListener("click", () => generateSmartTheory().catch((error) => {
      setText("smartTheoryStatus", "Error"); setText("smartTheoryProgress", error.message);
    }));
    $("smartTheoryStopBtn")?.addEventListener("click", () => { state.smartStop = true; setText("smartTheoryStatus", "Stopping"); });
    $("smartTheoryClearBtn")?.addEventListener("click", () => {
      state.smartTree = null;
      ["smartTheoryRunSummary","smartTheoryCurrentMeta","smartTheoryMoveList","smartTheoryOpeningMeta","smartTheoryRecommendation","smartTheoryLearningQueue","smartTheoryOpponentReplies","smartTheoryExplanation","smartTheoryTree"].forEach((id) => setHtml(id, "No generated theory in this session.", true));
      setText("smartTheoryStatus", "Idle");
    });
    $("smartTheoryExportBtn")?.addEventListener("click", () => {
      if (!state.smartTree) return;
      download("bookup-smart-theory.json", JSON.stringify(state.smartTree, null, 2), "application/json");
    });
    $("smartTheoryImportInput")?.addEventListener("change", async (event) => {
      try { state.smartTree = JSON.parse(await event.target.files[0].text()); renderSmartTheory(); }
      catch { setText("smartTheoryStatus", "Invalid JSON"); }
    });
    $("smartTheoryPreviewChaptersBtn")?.addEventListener("click", () => {
      const chapters = smartTheoryChapters();
      setHtml("smartTheoryChapterPreview", chapters.map((chapter, index) => card(
        `Chapter ${index + 1}: ${chapter.name}`,
        `${chapter.moves} generated moves · ${chapter.strategy}`,
        "Lichess-ready PGN"
      )).join("") || "Generate a tree first.", !chapters.length);
    });
    $("smartTheorySaveCorrectionBtn")?.addEventListener("click", () => {
      const node = flattenTree(state.smartTree || { children: [] })[0];
      if (!node) return;
      state.branches.unshift({ id: `smart-${Date.now()}`, color: $("smartTheoryMyColor")?.value || "white", moves: node.path, games: 1, wins: 0, draws: 1, losses: 0, ratings: [], lastSeen: 0, examples: [] });
      markDataDirty();
      save(); renderAll(); setText("smartTheoryStatus", "Saved to repertoire");
    });
    $("smartTheoryExportLichessBtn")?.addEventListener("click", () => {
      if (!state.smartTree) { setText("smartTheoryLichessHint", "Generate a tree first."); return; }
      download("bookup-smart-theory.pgn", smartTreePgn(), "application/x-chess-pgn");
      const chapters = smartTheoryChapters();
      setText("smartTheoryLichessHint", `${chapters.length} Lichess-ready chapter(s) downloaded. No private token was exposed or saved.`);
      setHtml("smartTheoryStudySyncMeta", card(
        "PGN ready",
        `Downloaded ${chapters.length} chapter(s). Use Lichess Study's PGN import to add the complete variation tree.`,
        $("smartTheoryChapterStrategy")?.selectedOptions?.[0]?.textContent || "export"
      ));
    });
    $("smartTheoryFreshStudyBtn")?.addEventListener("click", () => {
      window.open("https://lichess.org/study/new/hot", "_blank", "noopener");
      setText("smartTheoryLichessHint", "Opened Lichess study creation in a new tab. Export the PGN here, then import it there.");
    });
    $("smartTheoryCheckStudyBtn")?.addEventListener("click", () => {
      const id = String($("smartTheoryLichessStudyId")?.value || "").trim().split("/").filter(Boolean).at(-1);
      if (!id) { setText("smartTheoryLichessHint", "Enter a Lichess study ID or URL first."); return; }
      window.open(`https://lichess.org/study/${encodeURIComponent(id)}`, "_blank", "noopener");
    });
    $("smartTheoryTreeSearch")?.addEventListener("input", () => {
      if (state.smartTree) renderSmartTheory();
    });
    $("progressSaveProjectionBtn")?.addEventListener("click", () => {
      state.customGames = clamp(num($("progressCustomGames")?.value, 538), 1, 5000);
      state.projectionMode = $("progressProjectionMode")?.value || "realistic";
      qsa("[data-dropoff-row]").forEach((input) => {
        const row = num(input.dataset.dropoffRow, -1);
        const field = num(input.dataset.dropoffField, -1);
        if (state.dropoff[row] && field >= 2 && field <= 4) {
          state.dropoff[row][field] = clamp(num(input.value), 0, 100);
        }
      });
      const invalid = state.dropoff.find((row) => Math.abs(row[2] + row[3] + row[4] - 100) > 0.01);
      if (invalid && state.projectionMode === "realistic") {
        status(`Projection row ${invalid[0]}-${invalid[1]} must total 100%.`, "error");
        return;
      }
      save(); renderProgress();
      status("Projection settings saved locally.", "success");
    });
    $("progressProjectionMode")?.addEventListener("change", (event) => {
      state.projectionMode = event.currentTarget.value;
      save();
      const data = state.stats[state.mode];
      if (data) renderProjection(data);
    });
    $("progressSessionForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      state.sessions.push({
        date: String(data.get("date") || today()),
        startRating: num(data.get("start_rating")),
        endRating: num(data.get("end_rating")),
        wins: num(data.get("wins")), draws: num(data.get("draws")), losses: num(data.get("losses")),
        accuracy: num(data.get("accuracy")), theme: String(data.get("mistake_theme") || ""),
        openingAccuracy: num(data.get("opening_accuracy")),
        middlegameAccuracy: num(data.get("middlegame_accuracy")),
        endgameAccuracy: num(data.get("endgame_accuracy")),
        notes: String(data.get("notes") || ""), nextWork: String(data.get("next_work") || ""),
      });
      const latest = state.sessions.at(-1);
      if (latest.accuracy) state.accuracy.average = latest.accuracy;
      if (latest.openingAccuracy) state.accuracy.opening = latest.openingAccuracy;
      if (latest.middlegameAccuracy) state.accuracy.middlegame = latest.middlegameAccuracy;
      if (latest.endgameAccuracy) state.accuracy.endgame = latest.endgameAccuracy;
      save(); renderProgress(); event.currentTarget.reset();
      const dateInput = event.currentTarget.querySelector('[name="date"]'); if (dateInput) dateInput.value = today();
    });
    $("realignUseStartBtn")?.addEventListener("click", () => { if ($("realignSourceFenInput")) $("realignSourceFenInput").value = new Chess().fen(); });
    $("realignGenerateBtn")?.addEventListener("click", generateRealignPlan);
    window.addEventListener("resize", () => {
      if (state.activeTab !== "stats") return;
      clearTimeout(state.resizeTimer);
      state.resizeTimer = window.setTimeout(() => renderProgress(), 140);
    }, { passive: true });
    window.addEventListener("pagehide", flushSave);
  }

  function pgnStartPly(fen) {
    const fields = String(fen || "").split(/\s+/);
    return Math.max(0, (num(fields[5], 1) - 1) * 2 + (fields[1] === "b" ? 1 : 0));
  }

  function pgnMoveToken(san, ply) {
    const moveNumber = Math.floor(ply / 2) + 1;
    return ply % 2 === 0 ? `${moveNumber}. ${san}` : `${moveNumber}... ${san}`;
  }

  function serializeSmartTree(parent, ply) {
    const children = parent?.children || [];
    if (!children.length) return "";
    const [main, ...alternatives] = children;
    const mainToken = pgnMoveToken(main.san, ply);
    const variationText = alternatives.map((node) =>
      `(${pgnMoveToken(node.san, ply)} ${serializeSmartTree(node, ply + 1)})`.replace(/\s+\)/g, ")")
    ).join(" ");
    const continuation = serializeSmartTree(main, ply + 1);
    return [mainToken, variationText, continuation].filter(Boolean).join(" ").trim();
  }

  function smartPgnHeader(name, fen) {
    const startFen = new Chess().fen();
    const setup = fenKey(fen) === fenKey(startFen) ? "" : `[SetUp "1"]\n[FEN "${fen}"]\n`;
    const orientation = $("smartTheoryLichessOrientation")?.value || $("smartTheoryMyColor")?.value || "white";
    return `[Event "${String(name || "Bookup Smart Theory").replaceAll('"', "'")}"]\n[Site "https://tetizz.github.io/Bookup/"]\n[Date "${today().replaceAll("-", ".")}"]\n[Orientation "${orientation}"]\n${setup}[Result "*"]`;
  }

  function smartTheoryChapters() {
    if (!state.smartTree) return [];
    const strategy = $("smartTheoryChapterStrategy")?.value || "single";
    const maxChapters = clamp(num($("smartTheoryMaxChapters")?.value, 20), 1, 80);
    const baseName = String(
      $("smartTheoryLichessChapterName")?.value
      || $("smartTheoryLichessStudyName")?.value
      || "Bookup Smart Theory"
    ).trim();
    const rootFen = state.smartTree.fen;
    const startPly = pgnStartPly(rootFen);
    if (strategy === "single") {
      const body = serializeSmartTree(state.smartTree, startPly);
      return [{
        name: baseName,
        moves: flattenTree(state.smartTree, []).length,
        strategy: "single full variation tree",
        pgn: `${smartPgnHeader(baseName, rootFen)}\n\n${body} *`,
      }];
    }
    if (strategy === "first_move") {
      return (state.smartTree.children || []).slice(0, maxChapters).map((node, index) => {
        const parent = { children: [node] };
        const name = `${baseName} ${index + 1} - ${node.san}`;
        return {
          name,
          moves: flattenTree(node, []).length + 1,
          strategy: "first-move chapter",
          pgn: `${smartPgnHeader(name, rootFen)}\n\n${serializeSmartTree(parent, startPly)} *`,
        };
      });
    }
    const leaves = flattenTree(state.smartTree, []).filter((node) => !node.children?.length).slice(0, maxChapters);
    return leaves.map((node, index) => {
      const line = node.path.map((san, offset) => pgnMoveToken(san, startPly + offset)).join(" ");
      const name = `${baseName} ${index + 1}`;
      return {
        name,
        moves: node.path.length,
        strategy: "deep focus line",
        pgn: `${smartPgnHeader(name, rootFen)}\n\n${line} *`,
      };
    });
  }

  function smartTreePgn() {
    return smartTheoryChapters().map((chapter) => chapter.pgn).join("\n\n");
  }

  function generateRealignPlan() {
    const sourceFen = String($("realignSourceFenInput")?.value || new Chess().fen());
    try {
      const source = new Chess(sourceFen).board().flat();
      const target = state.trainer.chess.board().flat();
      const sourceCounts = {};
      const targetCounts = {};
      source.filter(Boolean).forEach((piece) => { const key = piece.color + piece.type; sourceCounts[key] = (sourceCounts[key] || 0) + 1; });
      target.filter(Boolean).forEach((piece) => { const key = piece.color + piece.type; targetCounts[key] = (targetCounts[key] || 0) + 1; });
      const differences = [...new Set([...Object.keys(sourceCounts), ...Object.keys(targetCounts)])].filter((key) => sourceCounts[key] !== targetCounts[key]);
      setText("realignStatus", differences.length ? "Piece inventory differs; use the target board shown at left." : "Piece inventory matches. Reposition pieces square by square to the target.");
      setHtml("realignOutput", card("Target FEN", state.trainer.chess.fen(), differences.length ? `${differences.length} inventory differences` : "same inventory"));
    } catch {
      setText("realignStatus", "The source FEN is invalid.");
    }
  }

  async function initialize() {
    load();
    bind();
    const defaults = {
      mainPlatformInput: "chesscom", mainUsernameInput: state.username, usernameInput: state.username,
      timeClassesInput: state.settings.timeClasses.join(","), maxGamesInput: state.settings.maxGames,
      thinkTimeInput: "0.18",
      progressCustomGames: state.customGames, progressProjectionMode: state.projectionMode,
    };
    Object.entries(defaults).forEach(([id, value]) => { if ($(id)) $(id).value = String(value); });
    if ($("importAllGamesInput")) $("importAllGamesInput").checked = Boolean(state.settings.importAllGames);
    if ($("autoImportStartupInput")) $("autoImportStartupInput").checked = Boolean(state.settings.autoImportStartup);
    const sessionDate = $("progressSessionForm")?.querySelector('[name="date"]');
    if (sessionDate) sessionDate.value = today();
    const restored = await restoreAnalysisCache().catch(() => false);
    renderAll();
    if (restored && state.games.length && !state.analysisMeta) {
      status(`Upgrading ${count(state.games.length)} cached games to exact-position lessons...`);
      try {
        await analyzeImportedPositions(undefined, 5, 96);
        markDataDirty();
        save();
        await persistAnalysisCache();
        renderAll();
        status(`Restored ${count(state.games.length)} games and ${count(state.analysisMeta?.due || 0)} due exact positions from the offline cache.`, "success");
      } catch (error) {
        status(`Games restored, but exact-position analysis could not start: ${error.message}`, "error");
      }
    } else {
      status(restored
        ? `Restored ${count(state.games.length)} games and ${count(state.analysisMeta?.due || 0)} due exact positions from the offline cache.`
        : (state.branches.length ? "Loaded local settings. Import games to rebuild exact-position lessons." : "Ready. Import public games or PGN to find repeated best-move misses."));
    }
    if (state.settings.autoImportStartup && state.username && navigator.onLine) {
      window.setTimeout(() => refreshAll(), 500);
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
