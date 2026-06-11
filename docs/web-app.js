/* Bookup Web
 * Browser-native port of the desktop workspace. Public chess data is fetched
 * directly; imported PGNs, settings, sessions, and review progress stay local.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "bookup-web-desktop-v2";
  const CACHE_DB_NAME = "bookup-web-cache";
  const CACHE_DB_VERSION = 3;
  const ANALYSIS_VERSION = 5;
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
    gameAnalysis: [],
    gameAnalysisMeta: null,
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
    smartSelectedNodeId: "",
    smartController: null,
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
        if (!db.objectStoreNames.contains("smart_theory")) db.createObjectStore("smart_theory", { keyPath: "key" });
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
      const transaction = db.transaction(["workspaces", "analysis", "smart_theory"], "readwrite");
      transaction.objectStore("workspaces").clear();
      transaction.objectStore("analysis").clear();
      transaction.objectStore("smart_theory").clear();
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

  async function readSmartTheoryCache(key) {
    const db = await openCacheDb();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const request = db.transaction("smart_theory", "readonly").objectStore("smart_theory").get(key);
      request.onsuccess = () => resolve(request.result?.payload || null);
      request.onerror = () => reject(request.error);
    }).finally(() => db.close());
  }

  async function writeSmartTheoryCache(key, payload) {
    const db = await openCacheDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const request = db.transaction("smart_theory", "readwrite").objectStore("smart_theory").put({ key, updatedAt: Date.now(), payload });
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
      gameAnalysis: state.gameAnalysis,
      gameAnalysisMeta: state.gameAnalysisMeta,
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
    state.gameAnalysis = cached.analysisVersion === ANALYSIS_VERSION && cached.fingerprint === fingerprint && Array.isArray(cached.gameAnalysis)
      ? cached.gameAnalysis
      : [];
    state.gameAnalysisMeta = cached.analysisVersion === ANALYSIS_VERSION && cached.fingerprint === fingerprint
      ? (cached.gameAnalysisMeta || null)
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
      gameAnalysis: state.gameAnalysis,
      gameAnalysisMeta: state.gameAnalysisMeta,
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
      if (Array.isArray(data.gameAnalysis)) state.gameAnalysis = data.gameAnalysis;
      if (data.gameAnalysisMeta) state.gameAnalysisMeta = data.gameAnalysisMeta;
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

  async function analyzeImportedAccuracy(signal, progressStart = 73, progressEnd = 98) {
    const analyzer = window.BookupPositionAnalysis;
    if (!analyzer?.analyzeGameAccuracy) {
      throw new Error("The move accuracy analyzer did not load. Refresh the page and try again.");
    }
    const startedAt = Date.now();
    const moveTimeMs = clamp(Math.round(num($("thinkTimeInput")?.value, 0.18) * 700), 90, 220);
    setImportProgress(0, 0, "Preparing move-by-move accuracy analysis...", progressStart, progressStart);
    const result = await analyzer.analyzeGameAccuracy(state.games, {
      workerUrl: "./vendor/stockfish/stockfish-18-lite-single.js",
      signal,
      moveTimeMs,
      gamesPerMode: 5,
      maxMoves: 180,
      readCache: (key) => readAnalysisCache(key, 90 * 24 * 60 * 60 * 1000).catch(() => null),
      writeCache: (key, payload) => writeAnalysisCache(key, payload).catch(() => {}),
      onProgress: ({ done, total, move }) => {
        setImportProgress(
          done,
          total,
          `Measuring move accuracy ${done}/${total} · ${move?.phase || "position"} · ${move?.classification?.label || ""}`,
          progressStart,
          progressEnd
        );
      },
    });
    state.gameAnalysis = result.games;
    const summary = result.summary || {};
    const phaseStats = summary.phaseStats || {};
    if (num(summary.moves) > 0) {
      state.accuracy = {
        average: num(summary.average),
        opening: phaseStats.opening?.accuracy ?? 0,
        middlegame: phaseStats.middlegame?.accuracy ?? 0,
        endgame: phaseStats.endgame?.accuracy ?? 0,
      };
    }
    state.gameAnalysisMeta = {
      ...summary,
      cacheHits: result.cacheHits,
      analyzed: result.analyzed,
      truncated: result.truncated,
      moveTimeMs,
      elapsedMs: Date.now() - startedAt,
      completedAt: Date.now(),
      methodology: "Bookup expected-points accuracy",
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
    await analyzeImportedPositions(signal, 58, 72);
    await analyzeImportedAccuracy(signal, 73, 98);
    markDataDirty();
    setImportProgress(1, 1, "Saving games, lessons, and move accuracy for offline use...", 98, 99);
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
      gameAnalysis: state.gameAnalysis,
      gameAnalysisMeta: state.gameAnalysisMeta,
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
    const classification = String(lesson?.classification?.key || "").toLowerCase();
    return lesson?.lineStatus === "needs_work"
      && lesson.repeatMistakeCount >= 2
      && ["inaccuracy", "mistake", "blunder"].includes(classification);
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
    const recent = state.games.filter((game) => game.timeClass === state.mode).slice(-30);
    const measured = summarizeModeAccuracy(state.mode);
    if (!data) {
      setHtml("progressMetricGrid", [
        ["Live rating", "--", `No Chess.com ${state.mode} rating loaded`],
        ["Imported games", count(recent.length), `${state.mode} games on this device`],
        ["Bookup accuracy", measured.moves ? percent(measured.average) : "--", measured.moves ? `${measured.moves} moves measured` : "run local analysis"],
        ["Analyzed games", count(measured.games.length), "recent local sample"],
        ["Needs work", count(state.lessons.filter(lessonNeedsWork).length), "repeated best-move misses"],
      ].map(([label, value, note]) => `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join(""));
      setText("progressStatus", `No live ${state.mode} rating is loaded. Local game analysis remains available.`);
      setText("progressRatingContext", `${recent.length} imported ${state.mode} games`);
      setText("progressDeltaTitle", "Game-by-game rating change");
      setText("progressDeltaContext", "Import rated games with rating headers to build this chart.");
      drawRatingChart("progressRatingChart", recent.filter((game) => game.rating).map((game) => ({ x: game.endTime, y: game.rating })), "#7da2ff");
      const rated = recent.filter((game) => game.rating);
      drawBarChart("progressDeltaChart", rated.slice(1).map((game, index) => ({ x: game.endTime, y: game.rating - rated[index].rating })));
      drawRatingChart("progressGamesChart", [], "#74d39b");
      drawRatingChart("progressWinRateChart", [], "#f1c96a", { suffix: "%" });
      drawRatingChart("progressAccuracyChart", measured.games.map((game) => ({ x: game.endTime, y: game.accuracy })), "#c79bff", { suffix: "%" });
      renderAccuracyLab(measured);
      setHtml("progressGoalGrid", `<p class="line-note">Load Chess.com stats to track rating goals.</p>`);
      setHtml("progressProjectionPanel", `<p class="line-note">Load a live rating to calculate projections.</p>`);
      setHtml("progressProjectionBands", "");
      renderTimeCalculator();
      renderRecommendations(0, measured.moves ? {
        average: measured.average,
        opening: measured.phaseStats.opening.accuracy,
        middlegame: measured.phaseStats.middlegame.accuracy,
        endgame: measured.phaseStats.endgame.accuracy,
      } : null);
      renderSessions();
      return;
    }
    const snapshots = state.snapshots.filter((item) => item.mode === state.mode).slice(-90);
    const recentWins = recent.filter((game) => game.outcome === "win").length;
    const recentScore = recent.length ? recentWins / recent.length * 100 : 0;
    const imported = importedStats();
    const accuracy = measured.moves ? {
      average: measured.average,
      opening: measured.phaseStats.opening.accuracy,
      middlegame: measured.phaseStats.middlegame.accuracy,
      endgame: measured.phaseStats.endgame.accuracy,
    } : null;
    setHtml("progressMetricGrid", [
      ["Current rating", rating(data.rating), `${state.mode} from Chess.com`],
      ["Record", `${count(data.wins)}W ${count(data.draws)}D ${count(data.losses)}L`, `${count(data.games)} games`],
      ["Recent score", percent(recent.length ? (recentWins + recent.filter((game) => game.outcome === "draw").length * 0.5) / recent.length * 100 : 0), `${recent.length} imported ${state.mode} games`],
      ["Bookup accuracy", measured.moves ? percent(measured.average) : "--", measured.moves ? `${measured.moves} moves measured` : "run local analysis"],
      ["Needs work", count(state.lessons.filter(lessonNeedsWork).length), "repeated best-move misses"],
    ].map(([label, value, note]) => `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join(""));
    setText("progressStatus", `Live ${state.mode} stats for ${state.username}. Accuracy is measured locally and cached offline.`);
    const ratingPoints = snapshots.length >= 2
      ? snapshots.map((item) => ({ x: item.date, y: item.rating }))
      : recent.map((game) => ({ x: game.endTime, y: game.rating }));
    setText("progressRatingContext", snapshots.length >= 2
      ? `${snapshots.length} daily snapshots`
      : `${recent.length} recent imported games`);
    drawRatingChart("progressRatingChart", ratingPoints, "#7da2ff");
    const deltaSource = snapshots.length >= 2 ? snapshots : recent;
    const deltas = deltaSource.slice(1).map((item, index) => ({
      x: item.date || item.endTime,
      y: item.rating - deltaSource[index].rating,
    }));
    setText("progressDeltaTitle", snapshots.length >= 2 ? "Daily rating gain / loss" : "Game-by-game rating change");
    setText("progressDeltaContext", snapshots.length >= 2
      ? "Change between locally saved daily snapshots."
      : "Change between consecutive imported games. This switches to daily data after more snapshot days are saved.");
    drawBarChart("progressDeltaChart", deltas);
    drawRatingChart("progressGamesChart", snapshots.map((item) => ({ x: item.date, y: item.games })), "#74d39b");
    drawRatingChart("progressWinRateChart", snapshots.map((item) => ({
      x: item.date,
      y: item.games ? item.wins / item.games * 100 : 0,
    })), "#f1c96a", { suffix: "%" });
    drawRatingChart("progressAccuracyChart", measured.games.map((game) => ({
      x: game.endTime,
      y: game.accuracy,
    })), "#c79bff", { suffix: "%" });
    renderAccuracyLab(measured);
    renderGoals(data, recentScore, accuracy);
    renderProjection(data);
    renderTimeCalculator();
    renderRecommendations(recentScore, accuracy);
    renderSessions();
  }

  function summarizeModeAccuracy(mode) {
    const games = state.gameAnalysis.filter((game) => game.timeClass === mode);
    const moves = games.flatMap((game) => game.moveAnalysis || []);
    const phaseStats = {};
    ["opening", "middlegame", "endgame"].forEach((phase) => {
      const phaseMoves = moves.filter((move) => move.phase === phase);
      phaseStats[phase] = {
        moves: phaseMoves.length,
        accuracy: phaseMoves.length
          ? phaseMoves.reduce((sum, move) => sum + num(move.accuracy), 0) / phaseMoves.length
          : null,
      };
    });
    const classifications = {};
    moves.forEach((move) => {
      const key = move.classification?.key || "unknown";
      classifications[key] = (classifications[key] || 0) + 1;
    });
    return {
      games,
      moves: moves.length,
      average: moves.length ? moves.reduce((sum, move) => sum + num(move.accuracy), 0) / moves.length : 0,
      phaseStats,
      classifications,
    };
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

  function chartLabel(value) {
    if (typeof value === "number" && value > 1000000000) {
      return new Date(value * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
    const date = new Date(String(value || ""));
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return String(value ?? "");
  }

  function drawRatingChart(id, points, color, options = {}) {
    const target = canvasContext(id);
    if (!target) return;
    const { ctx, width, height } = target;
    ctx.clearRect(0, 0, width, height);
    const plot = { left: 50, right: width - 16, top: 16, bottom: height - 32 };
    if (!points.length) {
      ctx.fillStyle = "#8d9bb0"; ctx.font = "13px Segoe UI"; ctx.fillText("More saved data is needed for this trend.", plot.left, height / 2);
      return;
    }
    const values = points.map((point) => point.y);
    const spread = Math.max(1, Math.max(...values) - Math.min(...values));
    const pad = Math.max(options.suffix === "%" ? 2 : 1, spread * 0.12);
    const min = Math.min(...values) - pad;
    const max = Math.max(...values) + pad;
    ctx.font = "11px Cascadia Mono";
    for (let i = 0; i <= 4; i += 1) {
      const ratio = i / 4;
      const y = plot.top + ratio * (plot.bottom - plot.top);
      const value = max - ratio * (max - min);
      ctx.strokeStyle = i === 4 ? "#3b4758" : "#283241";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(plot.left, y); ctx.lineTo(plot.right, y); ctx.stroke();
      ctx.fillStyle = "#8d9bb0";
      ctx.textAlign = "right";
      ctx.fillText(`${Math.round(value)}${options.suffix || ""}`, plot.left - 7, y + 4);
    }
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath();
    points.forEach((point, index) => {
      const x = plot.left + index / Math.max(1, points.length - 1) * (plot.right - plot.left);
      const y = plot.top + (max - point.y) / Math.max(1, max - min) * (plot.bottom - plot.top);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    points.forEach((point, index) => {
      const x = plot.left + index / Math.max(1, points.length - 1) * (plot.right - plot.left);
      const y = plot.top + (max - point.y) / Math.max(1, max - min) * (plot.bottom - plot.top);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, points.length > 24 ? 2 : 3, 0, Math.PI * 2);
      ctx.fill();
    });
    const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    ctx.fillStyle = "#8d9bb0";
    ctx.font = "11px Segoe UI";
    labelIndexes.forEach((index) => {
      const x = plot.left + index / Math.max(1, points.length - 1) * (plot.right - plot.left);
      ctx.textAlign = index === 0 ? "left" : index === points.length - 1 ? "right" : "center";
      ctx.fillText(chartLabel(points[index].x), x, height - 10);
    });
    ctx.textAlign = "left";
  }

  function drawBarChart(id, points) {
    const target = canvasContext(id);
    if (!target) return;
    const { ctx, width, height } = target;
    ctx.clearRect(0, 0, width, height);
    if (!points.length) {
      ctx.fillStyle = "#8d9bb0"; ctx.font = "13px Segoe UI"; ctx.fillText("At least two dated ratings are needed.", 50, height / 2);
      return;
    }
    const plot = { left: 48, right: width - 14, top: 20, bottom: height - 34 };
    const max = Math.max(8, ...points.map((point) => Math.abs(point.y)));
    const middle = plot.top + (plot.bottom - plot.top) / 2;
    [-max, 0, max].forEach((value) => {
      const y = middle - value / max * (plot.bottom - plot.top) / 2;
      ctx.strokeStyle = value === 0 ? "#526174" : "#283241";
      ctx.beginPath(); ctx.moveTo(plot.left, y); ctx.lineTo(plot.right, y); ctx.stroke();
      ctx.fillStyle = "#8d9bb0"; ctx.font = "11px Cascadia Mono"; ctx.textAlign = "right";
      ctx.fillText(`${value > 0 ? "+" : ""}${Math.round(value)}`, plot.left - 7, y + 4);
    });
    const barWidth = (plot.right - plot.left) / points.length;
    points.forEach((point, index) => {
      const size = Math.abs(point.y) / max * (plot.bottom - plot.top) / 2;
      ctx.fillStyle = point.y >= 0 ? "#74d39b" : "#ff7f87";
      const x = plot.left + index * barWidth + Math.min(3, barWidth * 0.12);
      ctx.fillRect(x, point.y >= 0 ? middle - size : middle, Math.max(2, barWidth - Math.min(6, barWidth * 0.24)), Math.max(1, size));
      if (points.length <= 14 && point.y) {
        ctx.fillStyle = point.y >= 0 ? "#9ce8bc" : "#ffabb0";
        ctx.font = "10px Cascadia Mono";
        ctx.textAlign = "center";
        ctx.fillText(`${point.y > 0 ? "+" : ""}${Math.round(point.y)}`, x + Math.max(2, barWidth - 6) / 2, point.y >= 0 ? middle - size - 5 : middle + size + 12);
      }
    });
    const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    ctx.fillStyle = "#8d9bb0"; ctx.font = "11px Segoe UI";
    labelIndexes.forEach((index) => {
      const x = plot.left + (index + 0.5) * barWidth;
      ctx.textAlign = index === 0 ? "left" : index === points.length - 1 ? "right" : "center";
      ctx.fillText(chartLabel(points[index].x), x, height - 9);
    });
    ctx.textAlign = "left";
  }

  function renderAccuracyLab(measured) {
    const hasMeasured = measured.moves > 0;
    const rows = [
      ["Opening", "opening"],
      ["Middlegame", "middlegame"],
      ["Endgame", "endgame"],
    ];
    setText("progressAccuracyMethod", hasMeasured
      ? `${measured.games.length} games · ${measured.moves} moves`
      : "No measured sample yet");
    setHtml("progressAccuracySummary", [
      ["Overall", hasMeasured ? percent(measured.average) : "--", "average analyzed move"],
      ["Perfect", hasMeasured ? percent((num(measured.classifications.book) + num(measured.classifications.best)) / measured.moves * 100) : "--", "book or best"],
      ["Games", count(measured.games.length), "recent local sample"],
      ["Engine cache", count(state.gameAnalysisMeta?.cacheHits || 0), "moves restored offline"],
    ].map(([label, value, note]) => `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join(""));
    setHtml("progressPhaseChart", rows.map(([label, key, fallback]) => {
      const stat = measured.phaseStats[key];
      const value = stat?.accuracy ?? 0;
      return `<div class="progress-phase-measure">
        <div><strong>${label}</strong><span>${stat?.moves || 0} moves</span></div>
        <div class="progress-phase-track"><span style="width:${clamp(num(value), 0, 100)}%"></span></div>
        <b>${stat?.moves ? percent(value) : "--"}</b>
      </div>`;
    }).join(""));
    const order = ["book", "best", "excellent", "good", "inaccuracy", "mistake", "blunder"];
    setHtml("progressClassificationPanel", hasMeasured ? order.map((key) => {
      const value = num(measured.classifications[key]);
      return `<div class="classification-row classification-${key}">
        <span>${key.charAt(0).toUpperCase() + key.slice(1)}</span>
        <div><i style="width:${value / measured.moves * 100}%"></i></div>
        <strong>${value}</strong>
      </div>`;
    }).join("") : `<p class="line-note">Import games to classify your moves.</p>`);
    const measuredRows = rows.filter(([, key]) => measured.phaseStats[key]?.moves);
    if (measuredRows.length) {
      const sorted = measuredRows.slice().sort((left, right) =>
        measured.phaseStats[left[1]].accuracy - measured.phaseStats[right[1]].accuracy
      );
      const weakest = sorted[0];
      const strongest = sorted.at(-1);
      const weakLessons = state.lessons.filter(lessonNeedsWork).slice(0, 2)
        .map((lesson) => `${lesson.yourRepeatedMove} → ${lesson.recommendedMove}`).join(" · ");
      setHtml("progressWeaknessPanel", `<div class="progress-plan-callout">
        <span>Main weakness</span><strong>${weakest[0]} · ${percent(measured.phaseStats[weakest[1]].accuracy)}</strong>
        <p>${weakest[0] === "Opening" ? "Repair repeated opening decisions in the exact-position queue." : weakest[0] === "Middlegame" ? "Review forcing moves, pawn breaks, and your worst piece before the next session." : "Train king activity, rook activity, and pawn races from your recent games."}</p>
        ${weakLessons ? `<small>Queue: ${escapeHtml(weakLessons)}</small>` : ""}
        <small>Best measured phase: ${strongest[0]} · ${percent(measured.phaseStats[strongest[1]].accuracy)}</small>
      </div>`);
    } else {
      setHtml("progressWeaknessPanel", `<p class="line-note">No move-by-move sample exists for ${escapeHtml(state.mode)} yet.</p>`);
    }
    setHtml("progressAnalyzedGames", measured.games.slice().reverse().map((game) => `<div class="progress-analysis-row">
      <div><strong>${escapeHtml(game.openingName || "Imported game")}</strong><span>${new Date(num(game.endTime) * 1000).toLocaleDateString()} · ${outcomeLabel(game.outcome)} · ${rating(game.rating)}</span></div>
      <b>${percent(game.accuracy)}</b>
      <span>O ${game.phaseAccuracy.opening == null ? "--" : percent(game.phaseAccuracy.opening)}</span>
      <span>M ${game.phaseAccuracy.middlegame == null ? "--" : percent(game.phaseAccuracy.middlegame)}</span>
      <span>E ${game.phaseAccuracy.endgame == null ? "--" : percent(game.phaseAccuracy.endgame)}</span>
    </div>`).join("") || `No analyzed ${escapeHtml(state.mode)} games yet.`, !measured.games.length);
  }

  function goalRow(label, value, target, suffix = "") {
    const progress = clamp(value / target * 100, 0, 100);
    return `<div class="goal-row"><div><span>${label}</span><strong>${suffix === "rating" ? rating(value) : `${num(value).toFixed(suffix === "%" ? 1 : 0)}${suffix === "%" ? "%" : ""}`} / ${target}</strong></div><div class="goal-track"><div style="width:${progress}%"></div></div></div>`;
  }

  function renderGoals(data, recentWinRate, accuracy = null) {
    const rows = [1600, 1700, 1800, 1900, 2000].map((target) => goalRow(`${target} rating`, data.rating, target, "rating"));
    const gamesSinceBaseline = Math.max(0, num(data.games) - num(state.goalBaselines[state.mode], data.games));
    rows.push(goalRow("538 more games", Math.min(538, gamesSinceBaseline), 538));
    rows.push(goalRow("1000 more games", Math.min(1000, gamesSinceBaseline), 1000));
    if (accuracy && Number.isFinite(Number(accuracy.average))) {
      rows.push(goalRow("Average accuracy", accuracy.average, 75, "%"));
    }
    if (accuracy && Number.isFinite(Number(accuracy.middlegame))) {
      rows.push(goalRow("Middlegame accuracy", accuracy.middlegame, 73, "%"));
    }
    if (accuracy && Number.isFinite(Number(accuracy.endgame))) {
      rows.push(goalRow("Endgame accuracy", accuracy.endgame, 80, "%"));
    }
    rows.push(goalRow("Recent win rate", recentWinRate, 52, "%"));
    if (!accuracy) rows.push(`<p class="line-note">Accuracy goals appear after Bookup has analyzed moves in this time control.</p>`);
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
    const values = [...new Set([538, 1000, custom])];
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
    const [baseRaw, incRaw] = String(game.timeControl || "").split("+");
    const base = num(baseRaw);
    const inc = num(incRaw, 0);
    const estimate = base ? (base * 2 + inc * 70) / 60 : 20;
    return Number.isFinite(estimate) ? clamp(estimate, 2, 80) : 20;
  }

  function durationText(minutes) {
    const rounded = Math.round(minutes);
    const days = rounded >= 1440 ? ` · about ${(rounded / 1440).toFixed(1)} nonstop days` : "";
    return `${count(rounded)} min · ${Math.floor(rounded / 60)}h ${rounded % 60}m${days}`;
  }

  function renderTimeCalculator() {
    const games = state.games.filter((game) => game.timeClass === state.mode).slice(-50);
    const lengths = games.map(estimateMinutes).filter((value) => Number.isFinite(value) && value > 0);
    const avg = lengths.length ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 20;
    const custom = state.customGames;
    const rows = [...new Set([538, 1000, custom])].map((gamesCount) => card(`${count(gamesCount)} games`, `Max ${durationText(gamesCount * 20)} · real ${durationText(gamesCount * avg)}`, `${avg.toFixed(1)} min average`));
    const days = [10, 15, 20, 25, 40].map((perDay) => `${perDay}/day: ${Math.ceil(custom / perDay)} days`).join(" · ");
    rows.push(card("Recent duration sample", `${games.length ? `${Math.min(...lengths).toFixed(1)} shortest · ${Math.max(...lengths).toFixed(1)} longest` : "No clock sample; using 20 min/game."}<br>${days}`, `${games.length} games used${games.length < 10 ? " · small sample" : ""}`));
    setHtml("progressTimePanel", rows.join(""));
  }

  function renderRecommendations(recentWinRate, accuracy = null) {
    const weakLines = state.lessons.filter(lessonNeedsWork).slice(0, 3)
      .map((lesson) => `${lesson.yourRepeatedMove} → ${lesson.recommendedMove}`).join("; ");
    const items = [
      card("Opening", weakLines ? `Review these exact move corrections first: ${weakLines}.` : "Import games to identify repeated decision mistakes.", accuracy?.opening == null ? "needs analysis" : percent(accuracy.opening)),
      card("Middlegame", accuracy?.middlegame == null ? "Analyze recent games before assigning a middlegame priority." : accuracy.middlegame < 73 ? "Pause on forcing moves, pawn breaks, and worst-piece improvement before committing." : "Maintain plan recognition with annotated game reviews.", accuracy?.middlegame == null ? "needs analysis" : percent(accuracy.middlegame)),
      card("Endgame", accuracy?.endgame == null ? "Analyze recent games before assigning an endgame priority." : accuracy.endgame < 80 ? "Prioritize king activity, rook activity, and pawn-race counting." : "Maintain two endgame sessions each week.", accuracy?.endgame == null ? "needs analysis" : percent(accuracy.endgame)),
      card("Tactics", recentWinRate < 52 ? "Do a short clean tactics block before playing, then review every loss immediately." : "Keep tactics short and daily; avoid exhausting calculation before games.", percent(recentWinRate)),
    ];
    const phases = accuracy
      ? [["opening", accuracy.opening], ["middlegame", accuracy.middlegame], ["endgame", accuracy.endgame]]
        .filter(([, value]) => Number.isFinite(Number(value)))
        .sort((a, b) => a[1] - b[1])
      : [];
    items.push(card("Review priority", phases.length
      ? `${phases[0][0]} is the lowest measured phase. Pair it with the highest-priority exact position in your queue.`
      : "Start with the highest-priority exact position in your queue until a phase sample is available.", "today"));
    setHtml("progressRecommendationPanel", items.join(""));
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
    board.dataset.fen = chess.fen();
    board.dataset.orientation = orientation;
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
    const needsCorrection = ["inaccuracy", "mistake", "blunder"].includes(String(lesson.classification?.key || "").toLowerCase());
    setText("boardSummary", needsCorrection
      ? `This is the exact position where you repeatedly played ${lesson.yourRepeatedMove}. Find Stockfish's correction.`
      : `This is the exact position where you repeatedly played ${lesson.yourRepeatedMove}, a ${lesson.classification?.label || "sound"} move. Rehearse your repertoire choice.`);
    setText("boardLine", `${lesson.introLineSan || lesson.lineLabel} · best continuation: ${lesson.continuationSan || lesson.recommendedMove}`);
    setText("trainerFeedback", needsCorrection
      ? `Your repeated move was ${lesson.yourRepeatedMove}. Find the correction ${lesson.recommendedMove}.`
      : `Your repeated move ${lesson.yourRepeatedMove} is sound. Play it again to reinforce the line.`);
    setText("trainerDecision", `You are ${lesson.color}. ${needsCorrection ? "Choose the correcting move" : "Play your repertoire move"} in this position.`);
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

  function sansToUci(moves, startFen = new Chess().fen()) {
    const chess = new Chess(startFen);
    const output = [];
    for (const san of moves || []) {
      const move = chess.move(san, { sloppy: true });
      if (!move) break;
      output.push(`${move.from}${move.to}${move.promotion || ""}`);
    }
    return output;
  }

  function smartSourceItems(type) {
    if (type === "saved_line") return state.lessons.map((lesson, index) => ({
      id: lesson.lessonId || `lesson-${index}`,
      label: lesson.lineLabel || `Saved line ${index + 1}`,
      detail: lesson.recommendedMove || "",
      fen: lesson.decisionFen || new Chess().fen(),
      moves_uci: lesson.trainingLineUci || [lesson.recommendedMoveUci].filter(Boolean),
      player_color: lesson.color || lesson.playerColor || $("smartTheoryMyColor")?.value || "white",
    }));
    if (type === "imported_game") return state.games.map((game, index) => ({
      id: String(game.id || game.url || `game-${index}`),
      label: `${game.headers?.White || "White"} - ${game.headers?.Black || "Black"}`,
      detail: game.headers?.Opening || game.timeClass || "Imported game",
      fen: game.headers?.FEN || new Chess().fen(),
      moves_uci: sansToUci(game.moves, game.headers?.FEN || new Chess().fen()),
      player_color: game.color || "white",
    }));
    if (type === "my_repertoire") return state.branches.map((branch, index) => ({
      id: String(branch.id || `branch-${index}`),
      label: `${branch.color} · ${branch.moves.slice(0, 5).join(" ")}`,
      detail: `${branch.games || 0} imported games`,
      fen: new Chess().fen(),
      moves_uci: sansToUci(branch.moves),
      player_color: branch.color || "white",
    }));
    return [];
  }

  function refreshSmartSourcePicker() {
    const type = $("smartTheoryStartingSource")?.value || "current_board";
    const picker = $("smartTheorySourcePicker");
    const wrap = $("smartTheorySourcePickerWrap");
    if (!picker) return;
    const items = smartSourceItems(type);
    const previous = picker.value;
    const needsItem = type !== "current_board";
    if (wrap) wrap.hidden = !needsItem;
    picker.innerHTML = needsItem
      ? `<option value="">Select ${escapeHtml(type.replaceAll("_", " "))}</option>${items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("")}`
      : '<option value="">Current board</option>';
    if (items.some((item) => item.id === previous)) picker.value = previous;
    previewSmartSource();
  }

  function resolveSmartSource() {
    const type = $("smartTheoryStartingSource")?.value || "current_board";
    if (type === "current_board") return {
      type, id: "", label: "Current board", fen: state.trainer.chess.fen(), moves_uci: [],
      player_color: $("smartTheoryMyColor")?.value || "white",
    };
    const item = smartSourceItems(type).find((candidate) => candidate.id === $("smartTheorySourcePicker")?.value);
    if (!item) throw new Error(`Select a specific ${type.replaceAll("_", " ")} before generating.`);
    return { type, ...item };
  }

  function previewSmartSource() {
    try {
      const source = resolveSmartSource();
      if ($("smartTheoryMyColor")) $("smartTheoryMyColor").value = source.player_color || "white";
      setText("smartTheorySourcePreview", `${source.label}${source.detail ? ` · ${source.detail}` : ""}. Generation starts from this exact board.`);
      renderMiniBoard(source.fen);
      if ($("smartTheoryGenerateBtn")) $("smartTheoryGenerateBtn").disabled = false;
    } catch (error) {
      setText("smartTheorySourcePreview", error.message);
      renderMiniBoard(new Chess().fen());
      if ($("smartTheoryGenerateBtn")) $("smartTheoryGenerateBtn").disabled = true;
    }
  }

  function clearSmartTheoryResult() {
    state.smartController?.abort();
    state.smartController = null;
    state.smartTree = null;
    state.smartSelectedNodeId = "";
    [
      "smartTheoryRunSummary",
      "smartTheoryCurrentMeta",
      "smartTheoryMoveList",
      "smartTheoryOpeningMeta",
      "smartTheoryRecommendation",
      "smartTheoryLearningQueue",
      "smartTheoryOpponentReplies",
      "smartTheoryExplanation",
      "smartTheoryTree",
    ].forEach((id) => setHtml(id, "No generated theory in this session.", true));
    setText("smartTheoryStatus", "Idle");
    setText("smartTheoryProgress", "No generation in progress.");
    previewSmartSource();
  }

  function smartStylePriors() {
    const map = new Map();
    state.games.forEach((game) => {
      const chess = new Chess(game.headers?.FEN || new Chess().fen());
      const playerTurn = game.color === "black" ? "b" : "w";
      game.moves.forEach((san) => {
        const before = fenKey(chess.fen());
        const move = chess.move(san, { sloppy: true });
        if (!move) return;
        if (move.color !== playerTurn) return;
        const uci = `${move.from}${move.to}${move.promotion || ""}`;
        const list = map.get(before) || [];
        const found = list.find((item) => item.uci === uci);
        if (found) found.weight += 1;
        else list.push({ uci, weight: 1 });
        list.sort((a, b) => b.weight - a.weight || a.uci.localeCompare(b.uci));
        map.set(before, list);
      });
    });
    return map;
  }

  function smartCacheKey(source, settings) {
    const text = JSON.stringify({ schema: 2, source, settings });
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `tree-v2:${(hash >>> 0).toString(16)}`;
  }

  async function generateSmartTheory() {
    const engine = window.BookupSmartTheory;
    if (!engine?.generate) throw new Error("Smart Theory engine did not load. Refresh and try again.");
    const source = resolveSmartSource();
    const settings = {
      maxPly: clamp(num($("smartTheoryMaxPly")?.value, 12), 2, 20),
      maxPositions: clamp(num($("smartTheoryMaxPositions")?.value, 80), 10, 300),
      opponentReplies: clamp(num($("smartTheoryReplies")?.value, 5), 1, 12),
      opponentModel: $("smartTheoryOpponentAccuracy")?.value || "mixed",
      includeMistakes: Boolean($("smartTheoryIncludeMistakes")?.checked),
      includeBlunders: Boolean($("smartTheoryIncludeBlunders")?.checked),
      includeBestEngineReplies: Boolean($("smartTheoryIncludeBestEngineReplies")?.checked),
      moveTimeMs: 180,
    };
    const key = smartCacheKey(source, settings);
    const cached = await readSmartTheoryCache(key).catch(() => null);
    if (cached) {
      state.smartTree = (await engine.validateTree(cached)).tree;
      state.smartSelectedNodeId = state.smartTree.root_id;
      setText("smartTheoryStatus", "Cached");
      setText("smartTheoryProgress", `${state.smartTree.nodes.length} validated nodes restored offline.`);
      renderSmartTheory();
      return;
    }
    state.smartController?.abort();
    state.smartController = new AbortController();
    state.smartStop = false;
    setText("smartTheoryStatus", "Generating");
    setText("smartTheoryProgress", "Starting browser Stockfish workers...");
    state.smartTree = await engine.generate({
      source,
      ...settings,
      stylePriors: smartStylePriors(),
      signal: state.smartController.signal,
      includeRare: Boolean($("smartTheoryIncludeRare")?.checked),
      cacheGet: (cacheKey) => readAnalysisCache(cacheKey, 180 * 24 * 60 * 60 * 1000).catch(() => null),
      cacheSet: (cacheKey, payload) => writeAnalysisCache(cacheKey, payload).catch(() => {}),
      databaseReplies: async (fen) => {
        try {
          const payload = await positionData(fen);
          return (payload.moves || []).map((move) => ({
            uci: move.uci,
            san: move.san,
            games: num(move.white) + num(move.draws) + num(move.black),
          }));
        } catch {
          return [];
        }
      },
      onProgress: ({ done, queued, cacheHits, engineCalls, workers }) => {
        setText("smartTheoryProgress", `${done} nodes · ${queued} queued · ${workers} worker${workers === 1 ? "" : "s"} · ${cacheHits} cache hits · ${engineCalls} engine calls`);
      },
    });
    state.smartSelectedNodeId = state.smartTree.root_id;
    await writeSmartTheoryCache(key, state.smartTree).catch(() => {});
    setText("smartTheoryStatus", state.smartTree.status === "stopped" ? "Stopped" : "Complete");
    setText("smartTheoryProgress", `${state.smartTree.nodes.length} legally connected nodes · ${state.smartTree.cache_hit_count || 0} cache hits · ${state.smartTree.warnings?.length || 0} warnings`);
    renderSmartTheory();
  }

  function smartNodeMap() {
    return new Map((state.smartTree?.nodes || []).map((node) => [String(node.id), node]));
  }

  function flattenTree(rootOrTree, output = []) {
    if (!state.smartTree) return output;
    const byId = smartNodeMap();
    const root = rootOrTree?.id ? rootOrTree : byId.get(state.smartTree.root_id || "root");
    const visit = (node) => (node?.children || []).forEach((id) => {
      const child = typeof id === "object" ? id : byId.get(String(id));
      if (!child) return;
      output.push(child);
      visit(child);
    });
    visit(root);
    return output;
  }

  function smartPath(node) {
    const byId = smartNodeMap();
    const path = [];
    let cursor = node;
    while (cursor && cursor.parentId) {
      path.unshift(cursor);
      cursor = byId.get(String(cursor.parentId));
    }
    return path;
  }

  function selectSmartNode(nodeId) {
    const byId = smartNodeMap();
    const node = byId.get(String(nodeId));
    if (!node) return;
    state.smartSelectedNodeId = node.id;
    const source = node.source?.label || "Starting source";
    setHtml("smartTheoryCurrentMeta", `<strong>${escapeHtml(node.san || "(root position)")}</strong><span>${escapeHtml(source)} · ${escapeHtml(node.classification || "Root")}</span>`);
    setHtml("smartTheoryMoveList", smartPath(node).map((item) => escapeHtml(item.san)).join(" ") || "Root position.", !node.parentId);
    setHtml("smartTheoryOpeningMeta", `<strong>Exact FEN</strong><span class="mono-inline">${escapeHtml(node.fenAfter || node.fen)}</span>`);
    setHtml("smartTheoryRecommendation", `<strong>${escapeHtml(node.bestMoveSan || node.san || "Position ready")}</strong><span>${escapeHtml(source)}</span>${node.correctedMove ? `<small>${escapeHtml(node.originalUserMove)} → ${escapeHtml(node.correctedMove)}</small>` : ""}`);
    const explanation = node.explanation || {};
    setHtml("smartTheoryExplanation", `<strong>${escapeHtml(explanation.summary || "Selected starting position.")}</strong>${explanation.why ? `<p>${escapeHtml(explanation.why)}</p>` : ""}${explanation.threat ? `<p><b>Threat:</b> ${escapeHtml(explanation.threat)}</p>` : ""}${explanation.response ? `<p><b>Response:</b> ${escapeHtml(explanation.response)}</p>` : ""}${explanation.plan ? `<p><b>Plan:</b> ${escapeHtml(explanation.plan)}</p>` : ""}`);
    const children = (node.children || []).map((id) => byId.get(String(id))).filter(Boolean);
    setHtml("smartTheoryOpponentReplies", children.map((child) => `<button class="smart-reply-row" data-smart-select="${escapeHtml(child.id)}" type="button"><strong>${escapeHtml(child.san)}</strong><span>${escapeHtml(child.source?.label || "")}</span><small>${escapeHtml(child.classification || "")}</small></button>`).join("") || "No generated child replies.", !children.length);
    qsa("[data-smart-select]").forEach((button) => button.addEventListener("click", () => selectSmartNode(button.dataset.smartSelect)));
    const evalCp = num(node.eval?.afterCp ?? node.evalAfter);
    setText("smartTheoryEvalLabel", `${evalCp >= 0 ? "+" : ""}${(evalCp / 100).toFixed(2)}`);
    if ($("smartTheoryEvalFill")) $("smartTheoryEvalFill").style.height = `${clamp(50 + evalCp / 10, 8, 92)}%`;
    renderMiniBoard(node.fenAfter || node.fen);
    renderSmartTheoryTree();
  }

  function renderSmartTheoryTree() {
    const tree = state.smartTree;
    if (!tree) return;
    const byId = smartNodeMap();
    const root = byId.get(tree.root_id || "root");
    const query = String($("smartTheoryTreeSearch")?.value || "").toLowerCase();
    const focus = $("smartTheoryTreeFocus")?.value || "all";
    const bucket = (node) => node.isCorrectedMove ? "corrected" : node.isUserSide && ["Inaccuracy", "Mistake", "Blunder"].includes(node.classification) ? "needs_work" : node.isBestEngineReply ? "engine_pressure" : node.source?.label === "My repertoire" ? "style_matched" : "all";
    const selfMatches = (node) => (focus === "all" || bucket(node) === focus) && [node.san, node.uci, node.source?.label, node.classification].some((value) => String(value || "").toLowerCase().includes(query));
    const branchMatches = (node, seen = new Set()) => {
      if (!node || seen.has(node.id)) return false;
      seen.add(node.id);
      return selfMatches(node) || (node.children || []).some((id) => branchMatches(byId.get(String(id)), new Set(seen)));
    };
    const renderBranch = (node, depth, seen = new Set()) => {
      if (!node || seen.has(node.id)) return "";
      seen.add(node.id);
      const children = (node.children || []).map((id) => byId.get(String(id))).filter((child) => branchMatches(child));
      return `<button class="smart-tree-row ${node.id === state.smartSelectedNodeId ? "selected" : ""}" data-smart-node="${escapeHtml(node.id)}" style="--tree-depth:${depth}" type="button"><span class="smart-tree-connector"></span><span class="smart-tree-move">${escapeHtml(node.san)}</span><span class="smart-tree-eval">${(num(node.eval?.afterCp) / 100).toFixed(2)}</span><span class="smart-tree-source">${escapeHtml(node.source?.label || "")}</span><span class="smart-tree-classification">${escapeHtml(node.classification || "")}</span></button>${children.map((child) => renderBranch(child, depth + 1, new Set(seen))).join("")}`;
    };
    const html = (root?.children || []).map((id) => byId.get(String(id))).filter((node) => branchMatches(node)).map((node) => renderBranch(node, 0)).join("");
    setHtml("smartTheoryTree", html || "No connected branches match this filter.", !html);
    qsa("[data-smart-node]").forEach((button) => button.addEventListener("click", () => selectSmartNode(button.dataset.smartNode)));
  }

  function renderSmartTheory() {
    if (!state.smartTree) return;
    const nodes = flattenTree(state.smartTree);
    setHtml("smartTheoryRunSummary", `<strong>${nodes.length} generated moves</strong><span>${state.smartTree.worker_count || 1} browser worker(s) · ${state.smartTree.cache_hit_count || 0} cache hits · ${state.smartTree.warnings?.length || 0} warnings</span>`);
    const priority = nodes.filter((node) => node.isCorrectedMove || ["Inaccuracy", "Mistake", "Blunder"].includes(node.classification)).slice(0, 8);
    setHtml("smartTheoryLearningQueue", priority.map((node) => `<button class="smart-reply-row" data-smart-priority="${escapeHtml(node.id)}" type="button"><strong>${escapeHtml(node.san)}</strong><span>${escapeHtml(node.classification)}</span></button>`).join("") || "No urgent corrections in this tree.", !priority.length);
    qsa("[data-smart-priority]").forEach((button) => button.addEventListener("click", () => selectSmartNode(button.dataset.smartPriority)));
    renderSmartTheoryTree();
    const first = nodes[0] || smartNodeMap().get(state.smartTree.root_id || "root");
    selectSmartNode(state.smartSelectedNodeId && smartNodeMap().has(state.smartSelectedNodeId) ? state.smartSelectedNodeId : first.id);
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
      renderMoveTree();
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
    refreshSmartSourcePicker();
    state.dirtyTabs.delete("setup");
    renderTab(state.activeTab);
  }

  function activateTab(name) {
    const aliases = { "needs-work": "trainer", review: "trainer", theory: "smart-theory" };
    name = aliases[name] || name;
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
      gameAnalysis: state.gameAnalysis,
      gameAnalysisMeta: state.gameAnalysisMeta,
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
      await analyzeImportedPositions(options.signal, 20, 55);
      await analyzeImportedAccuracy(options.signal, 56, 98);
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
      setText("smartTheoryStatus", error?.name === "AbortError" ? "Stopped" : "Error"); setText("smartTheoryProgress", error?.name === "AbortError" ? "Generation stopped. Partial work was not cached." : error.message);
    }));
    $("smartTheoryStopBtn")?.addEventListener("click", () => { state.smartStop = true; state.smartController?.abort(); setText("smartTheoryStatus", "Stopping"); });
    $("smartTheoryStartingSource")?.addEventListener("change", () => {
      clearSmartTheoryResult();
      refreshSmartSourcePicker();
    });
    $("smartTheorySourcePicker")?.addEventListener("change", clearSmartTheoryResult);
    $("smartTheoryClearBtn")?.addEventListener("click", clearSmartTheoryResult);
    $("smartTheoryExportBtn")?.addEventListener("click", () => {
      if (!state.smartTree) return;
      download("bookup-smart-theory.json", JSON.stringify(state.smartTree, null, 2), "application/json");
    });
    $("smartTheoryImportInput")?.addEventListener("change", async (event) => {
      try {
        const imported = JSON.parse(await event.target.files[0].text());
        const validated = await window.BookupSmartTheory.validateTree(imported);
        state.smartTree = validated.tree;
        state.smartSelectedNodeId = state.smartTree.root_id;
        await writeSmartTheoryCache(`imported:${Date.now()}`, state.smartTree);
        renderSmartTheory();
        setText("smartTheoryStatus", "Imported");
        setText("smartTheoryProgress", `${state.smartTree.nodes.length} validated nodes loaded${validated.warnings.length ? ` · ${validated.warnings.length} warnings` : ""}.`);
      } catch (error) {
        setText("smartTheoryStatus", "Invalid JSON");
        setText("smartTheoryProgress", error.message || "Could not import Smart Theory JSON.");
      }
      event.target.value = "";
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
      const node = smartNodeMap().get(String(state.smartSelectedNodeId));
      if (!node) return;
      const correction = node.correctedMove || node.bestMoveUci || node.uci;
      const base = new Chess(node.fenBefore || state.smartTree.start_fen);
      const move = base.move({ from: correction.slice(0, 2), to: correction.slice(2, 4), promotion: correction.slice(4, 5) || "q" });
      if (!move) { setText("smartTheoryStatus", "No legal correction"); return; }
      const prefix = smartPath(node).slice(0, -1).map((item) => item.san);
      state.branches.unshift({ id: `smart-${Date.now()}`, color: $("smartTheoryMyColor")?.value || "white", moves: [...prefix, move.san], games: 1, wins: 0, draws: 1, losses: 0, ratings: [], lastSeen: 0, examples: [] });
      markDataDirty();
      save(); renderAll(); refreshSmartSourcePicker(); setText("smartTheoryStatus", "Saved to repertoire");
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
    $("smartTheoryTreeSearch")?.addEventListener("input", renderSmartTheoryTree);
    $("smartTheoryTreeFocus")?.addEventListener("change", renderSmartTheoryTree);
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
    const byId = smartNodeMap();
    const children = (parent?.children || []).map((child) => typeof child === "object" ? child : byId.get(String(child))).filter(Boolean);
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
    const root = smartNodeMap().get(state.smartTree.root_id || "root");
    const rootFen = state.smartTree.start_fen || root?.fenAfter || new Chess().fen();
    const startPly = pgnStartPly(rootFen);
    if (strategy === "single") {
      const body = serializeSmartTree(root, startPly);
      return [{
        name: baseName,
        moves: flattenTree(state.smartTree, []).length,
        strategy: "single full variation tree",
        pgn: `${smartPgnHeader(baseName, rootFen)}\n\n${body} *`,
      }];
    }
    if (strategy === "first_move") {
      return (root?.children || []).map((id) => smartNodeMap().get(String(id))).filter(Boolean).slice(0, maxChapters).map((node, index) => {
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
    const leaves = flattenTree(root, []).filter((node) => !node.children?.length).slice(0, maxChapters);
    return leaves.map((node, index) => {
      const lineMoves = smartPath(node).map((item) => item.san);
      const line = lineMoves.map((san, offset) => pgnMoveToken(san, startPly + offset)).join(" ");
      const name = `${baseName} ${index + 1}`;
      return {
        name,
        moves: lineMoves.length,
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
    refreshSmartSourcePicker();
    if (restored && state.games.length && !state.analysisMeta) {
      status(`Upgrading ${count(state.games.length)} cached games to exact-position lessons...`);
      try {
        await analyzeImportedPositions(undefined, 5, 45);
        await analyzeImportedAccuracy(undefined, 46, 98);
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
