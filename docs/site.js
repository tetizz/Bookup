const STORAGE_KEY = "bookup-web-state-v2";
const MODE_KEYS = ["rapid", "blitz", "bullet"];
const MODE_LABELS = { rapid: "Rapid", blitz: "Blitz", bullet: "Bullet" };
const DEFAULT_PROFILE = {
  username: "trixize1234",
  fallbackRating: 1507,
  games: 1096,
  wins: 602,
  draws: 50,
  losses: 444,
  accuracy: { average: 74.18, opening: 85.1, middlegame: 71.1, endgame: 77.2 },
};
const DEFAULT_DROPOFF = [
  [1, 100, 55, 5, 40],
  [101, 200, 53, 5, 42],
  [201, 300, 52, 5, 43],
  [301, 400, 51, 5, 44],
  [401, 500, 50, 6, 44],
  [501, 600, 49, 6, 45],
  [601, 700, 48, 6, 46],
  [701, 800, 47, 6, 47],
  [801, 900, 46, 6, 48],
  [901, 1000, 45, 6, 49],
];

const el = {};
const state = {
  username: DEFAULT_PROFILE.username,
  mode: "rapid",
  stats: {},
  recentGames: [],
  repertoire: [],
  studyIndex: 0,
  sessions: [],
  reviews: [],
  dropoff: DEFAULT_DROPOFF.map((row) => [...row]),
  accuracy: { ...DEFAULT_PROFILE.accuracy },
  customGames: 538,
  loading: false,
  useFallback: false,
  lastUpdated: "",
};

function $(id) {
  return document.getElementById(id);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatRating(value) {
  const parsed = Math.round(number(value, 0));
  return parsed ? String(parsed) : "-";
}

function formatCount(value) {
  return Math.round(number(value, 0)).toLocaleString("en-US");
}

function pct(value, digits = 1) {
  return `${number(value, 0).toFixed(digits)}%`;
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    username: state.username,
    mode: state.mode,
    sessions: state.sessions,
    reviews: state.reviews,
    dropoff: state.dropoff,
    accuracy: state.accuracy,
    customGames: state.customGames,
  }));
}

function loadLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (saved.username) state.username = String(saved.username);
    if (MODE_KEYS.includes(saved.mode)) state.mode = saved.mode;
    if (Array.isArray(saved.sessions)) state.sessions = saved.sessions;
    if (Array.isArray(saved.reviews)) state.reviews = saved.reviews;
    if (Array.isArray(saved.dropoff) && saved.dropoff.length) {
      state.dropoff = saved.dropoff.map((row) => row.map((item) => number(item, 0)));
    }
    if (saved.accuracy) state.accuracy = { ...state.accuracy, ...saved.accuracy };
    if (saved.customGames) state.customGames = number(saved.customGames, 538);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 404) throw new Error("That Chess.com username was not found.");
    if (response.status === 429) throw new Error("Chess.com is rate limiting public requests. Try again soon.");
    if (!response.ok) throw new Error(`Chess.com returned HTTP ${response.status}.`);
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

function status(message, kind = "normal") {
  el.statusLine.textContent = message;
  el.statusLine.dataset.kind = kind;
}

function modeFromStats(statsPayload, mode) {
  const data = statsPayload?.[`chess_${mode}`];
  if (!data?.last) return null;
  const record = data.record || {};
  const wins = number(record.win);
  const draws = number(record.draw);
  const losses = number(record.loss);
  const games = wins + draws + losses;
  return {
    rating: number(data.last.rating),
    best: number(data.best?.rating || data.last.rating),
    wins,
    draws,
    losses,
    games,
    winRate: games ? (wins / games) * 100 : 0,
    scoreRate: games ? ((wins + draws * 0.5) / games) * 100 : 0,
  };
}

function parseHeaders(pgn) {
  const headers = {};
  String(pgn || "").replace(/\[([A-Za-z0-9_]+)\s+"([^"]*)"\]/g, (_, key, value) => {
    headers[key] = value;
    return "";
  });
  return headers;
}

function parseClockSeconds(raw) {
  const match = String(raw || "").match(/(?:(\d+):)?(\d+):(\d+)/);
  if (!match) return null;
  const hours = number(match[1]);
  const minutes = number(match[2]);
  const seconds = number(match[3]);
  return hours * 3600 + minutes * 60 + seconds;
}

function estimateDurationMinutes(game) {
  const pgn = String(game?.pgn || "");
  const clocks = [...pgn.matchAll(/\[%clk\s+([^\]]+)\]/g)]
    .map((match) => parseClockSeconds(match[1]))
    .filter((item) => item !== null);
  if (clocks.length >= 4) {
    const high = Math.max(...clocks.slice(0, 6));
    const low = Math.min(...clocks.slice(-8));
    const estimate = Math.max(2, (high - low) / 60);
    return Math.min(60, estimate);
  }
  const tc = String(game?.time_control || "");
  const [base, inc] = tc.split("+").map((item) => number(item));
  if (base) return Math.min(60, Math.max(2, (base * 2 + inc * 70) / 60));
  return 20;
}

function parsePgnMoves(pgn) {
  return String(pgn || "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\$\d+/g, " ")
    .replace(/\d+\.(\.\.)?/g, " ")
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, " ")
    .split(/\s+/)
    .map((token) => token.trim().replace(/[!?+#]+$/g, ""))
    .filter((token) => token && !token.startsWith("%") && !token.includes("clk"));
}

function normalizeGame(game, username) {
  const headers = parseHeaders(game.pgn);
  const lower = username.toLowerCase();
  const isWhite = String(game.white?.username || "").toLowerCase() === lower;
  const player = isWhite ? game.white : game.black;
  const result = String(player?.result || "").toLowerCase();
  const outcome = ["win"].includes(result) ? "win" : ["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"].includes(result) ? "draw" : "loss";
  return {
    endTime: number(game.end_time),
    rating: number(player?.rating),
    outcome,
    isWhite,
    moves: parsePgnMoves(game.pgn),
    timeClass: String(game.time_class || headers.TimeControl || "").toLowerCase(),
    duration: estimateDurationMinutes(game),
  };
}

function outcomeScore(outcome) {
  if (outcome === "win") return 1;
  if (outcome === "draw") return 0.5;
  return 0;
}

function buildRepertoire() {
  const groups = new Map();
  state.recentGames.forEach((game) => {
    const moves = Array.isArray(game.moves) ? game.moves.filter(Boolean) : [];
    if (moves.length < 4) return;
    const key = moves.slice(0, Math.min(8, moves.length)).join(" ");
    const current = groups.get(key) || {
      key,
      moves: moves.slice(0, 12),
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      score: 0,
      ratings: [],
      color: game.isWhite ? "White" : "Black",
    };
    current.games += 1;
    current.wins += game.outcome === "win" ? 1 : 0;
    current.draws += game.outcome === "draw" ? 1 : 0;
    current.losses += game.outcome === "loss" ? 1 : 0;
    current.score += outcomeScore(game.outcome);
    current.ratings.push(game.rating);
    groups.set(key, current);
  });
  state.repertoire = [...groups.values()]
    .map((item) => ({
      ...item,
      scoreRate: item.games ? item.score / item.games * 100 : 0,
      avgRating: item.ratings.length ? item.ratings.reduce((a, b) => a + b, 0) / item.ratings.length : 0,
    }))
    .sort((a, b) => b.games - a.games || a.scoreRate - b.scoreRate)
    .slice(0, 40);
  state.studyIndex = Math.min(state.studyIndex, Math.max(0, state.repertoire.length - 1));
}

async function fetchRecentGames(username, mode) {
  const archives = await fetchJson(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`, 12000);
  const urls = Array.isArray(archives.archives) ? archives.archives.slice(-4) : [];
  const batches = await Promise.allSettled(urls.map((url) => fetchJson(url, 15000)));
  return batches
    .filter((item) => item.status === "fulfilled")
    .flatMap((item) => Array.isArray(item.value.games) ? item.value.games : [])
    .filter((game) => String(game.time_class || "").toLowerCase() === mode)
    .map((game) => normalizeGame(game, username))
    .filter((game) => game.rating && game.endTime)
    .sort((a, b) => a.endTime - b.endTime)
    .slice(-80);
}

async function refresh() {
  const username = el.usernameInput.value.trim();
  if (!username) {
    status("Enter a Chess.com username.", "error");
    return;
  }
  state.username = username;
  state.loading = true;
  state.useFallback = false;
  state.recentGames = [];
  saveLocal();
  renderAll();
  el.refreshBtn.disabled = true;
  el.refreshBtn.textContent = "Loading";
  status(`Loading real public data for ${username}...`);
  try {
    const statsPayload = await fetchJson(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/stats`);
    MODE_KEYS.forEach((mode) => {
      state.stats[mode] = modeFromStats(statsPayload, mode);
    });
    try {
      state.recentGames = await fetchRecentGames(username, state.mode);
      buildRepertoire();
      status(`Loaded public ${MODE_LABELS[state.mode]} stats and ${state.recentGames.length} recent games for ${username}.`);
    } catch (error) {
      state.recentGames = [];
      state.repertoire = [];
      status(`Loaded public ratings. Recent games could not be loaded: ${error.message}`, "warn");
    }
    state.lastUpdated = new Date().toLocaleString();
    state.loading = false;
    renderAll();
  } catch (error) {
    state.loading = false;
    state.useFallback = true;
    status(error.name === "AbortError" ? "Chess.com took too long to respond." : error.message, "error");
    renderAll();
  } finally {
    el.refreshBtn.disabled = false;
    el.refreshBtn.textContent = "Refresh";
  }
}

function currentStats() {
  return state.stats[state.mode] || null;
}

function fallbackStats() {
  const { games, wins, draws, losses, fallbackRating } = DEFAULT_PROFILE;
  return {
    rating: fallbackRating,
    best: fallbackRating,
    wins,
    draws,
    losses,
    games,
    winRate: games ? wins / games * 100 : 0,
    scoreRate: games ? (wins + draws * 0.5) / games * 100 : 0,
  };
}

function activeStats() {
  return currentStats() || (state.useFallback ? fallbackStats() : null);
}

function renderMetrics() {
  const stats = activeStats();
  if (!stats) {
    el.ratingValue.textContent = "-";
    el.ratingSub.textContent = state.loading ? "Loading Chess.com public rating" : "Refresh to load live rating";
    el.recordValue.textContent = "-";
    el.recordSub.textContent = "Waiting for public stats";
    el.winrateValue.textContent = "-";
    el.scoreValue.textContent = "-";
    el.formValue.textContent = "-";
    el.formSub.textContent = "Waiting for recent games";
    el.lengthValue.textContent = "-";
    el.lengthSub.textContent = "Waiting for recent games";
    return;
  }
  const live = Boolean(currentStats());
  const recent = state.recentGames.slice(-20);
  const wins = recent.filter((game) => game.outcome === "win").length;
  const draws = recent.filter((game) => game.outcome === "draw").length;
  const losses = recent.filter((game) => game.outcome === "loss").length;
  const avgLength = recent.length ? recent.reduce((sum, game) => sum + game.duration, 0) / recent.length : 20;
  const shortest = recent.length ? Math.min(...recent.map((game) => game.duration)) : 20;
  const longest = recent.length ? Math.max(...recent.map((game) => game.duration)) : 20;
  el.ratingValue.textContent = formatRating(stats.rating);
  el.ratingSub.textContent = live ? `${MODE_LABELS[state.mode]} rating from Chess.com` : "Manual fallback, not live";
  el.recordValue.textContent = `${formatCount(stats.wins)}W ${formatCount(stats.draws)}D ${formatCount(stats.losses)}L`;
  el.recordSub.textContent = `${formatCount(stats.games)} rated games`;
  el.winrateValue.textContent = pct(stats.winRate);
  el.scoreValue.textContent = pct(stats.scoreRate);
  el.formValue.textContent = recent.length ? `${wins}W ${draws}D ${losses}L` : "-";
  el.formSub.textContent = recent.length ? `Last ${recent.length} public games` : "Archives unavailable";
  el.lengthValue.textContent = recent.length ? `${Math.round(avgLength)}m` : "20m";
  el.lengthSub.textContent = recent.length ? `${Math.round(shortest)}m shortest · ${Math.round(longest)}m longest` : "Fallback max estimate";
}

function renderLineChart(svg, points, options = {}) {
  const width = options.width || 820;
  const height = options.height || 300;
  const pad = { x: 42, y: 30 };
  if (!points.length) {
    svg.innerHTML = `<text x="42" y="150" class="chart-empty">Refresh public games or save sessions to draw this chart.</text>`;
    return;
  }
  const values = points.map((point) => number(point.value));
  const min = Math.min(...values) - 12;
  const max = Math.max(...values) + 12;
  const chartW = width - pad.x * 2;
  const chartH = height - pad.y * 2;
  const x = (index) => pad.x + index / Math.max(1, points.length - 1) * chartW;
  const y = (value) => pad.y + (max - value) / Math.max(1, max - min) * chartH;
  const path = points.map((point, index) => `${index ? "L" : "M"} ${x(index).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
  const area = `${path} L ${x(points.length - 1).toFixed(1)} ${height - pad.y} L ${pad.x} ${height - pad.y} Z`;
  const ticks = [max, (max + min) / 2, min];
  svg.innerHTML = `
    <defs>
      <linearGradient id="${options.gradient || "chartGradient"}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#81d99a" stop-opacity="0.34"></stop>
        <stop offset="100%" stop-color="#81d99a" stop-opacity="0.02"></stop>
      </linearGradient>
    </defs>
    ${ticks.map((tick) => `<g class="gridline"><line x1="${pad.x}" x2="${width - pad.x}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"></line><text x="8" y="${(y(tick) + 4).toFixed(1)}">${formatRating(tick)}</text></g>`).join("")}
    <path class="chart-area" d="${area}" fill="url(#${options.gradient || "chartGradient"})"></path>
    <path class="chart-line" d="${path}"></path>
    ${points.map((point, index) => `<circle class="chart-point ${point.outcome || ""}" cx="${x(index).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="4"><title>${formatRating(point.value)}</title></circle>`).join("")}
  `;
}

function renderRatingChart() {
  const games = state.recentGames.filter((game) => game.rating);
  const points = games.map((game) => ({ value: game.rating, outcome: game.outcome }));
  renderLineChart(el.ratingChart, points);
  el.chartMeta.textContent = games.length ? `${games.length} recent ${MODE_LABELS[state.mode]} games` : "Refresh to load recent games";
}

function renderImportSummary() {
  const games = state.recentGames;
  const white = games.filter((game) => game.isWhite).length;
  const black = games.length - white;
  el.importStatus.textContent = games.length ? `${games.length} ${MODE_LABELS[state.mode]} games imported` : "Refresh imports public games";
  el.importSummary.innerHTML = [
    ["Games imported", formatCount(games.length), "Recent public archives"],
    ["White / Black", `${white} / ${black}`, "Color split"],
    ["Opening lines", formatCount(state.repertoire.length), "Grouped from PGNs"],
    ["Storage", "Browser local", "Sessions and reviews stay here"],
  ].map(([label, value, note]) => `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
}

function lineRecord(line) {
  return `${line.wins}W ${line.draws}D ${line.losses}L · ${pct(line.scoreRate)} score`;
}

function lineCard(line, index, extra = "") {
  return `
    <article class="line-card">
      <div>
        <span>${line.color} · ${line.games} games</span>
        <strong>${line.moves.slice(0, 8).join(" ")}</strong>
      </div>
      <small>${lineRecord(line)}${extra ? ` · ${extra}` : ""}</small>
      <button type="button" data-study-line="${index}">Study</button>
    </article>
  `;
}

function renderRepertoire() {
  el.repertoireMeta.textContent = state.repertoire.length ? `${state.repertoire.length} grouped lines` : "No public game lines yet";
  el.repertoireList.innerHTML = state.repertoire.length
    ? state.repertoire.slice(0, 10).map((line, index) => lineCard(line, index)).join("")
    : `<p class="empty">Refresh public games to build a repertoire map from your recent openings.</p>`;

  const needs = state.repertoire
    .map((line, index) => ({ ...line, index }))
    .filter((line) => line.losses || line.scoreRate < 50)
    .sort((a, b) => b.losses - a.losses || a.scoreRate - b.scoreRate)
    .slice(0, 8);
  el.needsMeta.textContent = needs.length ? `${needs.length} lines to review` : "No urgent lines found";
  el.needsWorkList.innerHTML = needs.length
    ? needs.map((line) => lineCard(line, line.index, "review priority")).join("")
    : `<p class="empty">No repeated pain point found in the loaded recent games.</p>`;
}

function renderStudy() {
  const line = state.repertoire[state.studyIndex];
  if (!line) {
    el.studyMeta.textContent = "No study line loaded";
    el.studyCard.innerHTML = `<p class="empty">Refresh public games, then Bookup Web turns repeated openings into study cards.</p>`;
    return;
  }
  el.studyMeta.textContent = `Line ${state.studyIndex + 1} of ${state.repertoire.length}`;
  el.studyCard.innerHTML = `
    <span class="line-label">${line.color} repertoire · ${line.games} games</span>
    <h3>${line.moves[0] || "-"}</h3>
    <p>${line.moves.slice(1, 10).join(" ") || "No continuation available from imported games."}</p>
    <div class="study-stats">
      <span>${lineRecord(line)}</span>
      <span>Average rating ${formatRating(line.avgRating)}</span>
    </div>
  `;
}

function renderTheory() {
  const firstMoves = new Map();
  state.recentGames.forEach((game) => {
    const move = game.moves?.[0];
    if (!move) return;
    const item = firstMoves.get(move) || { move, games: 0, score: 0, replies: new Map() };
    item.games += 1;
    item.score += outcomeScore(game.outcome);
    const reply = game.moves?.[1] || "No reply";
    item.replies.set(reply, (item.replies.get(reply) || 0) + 1);
    firstMoves.set(move, item);
  });
  const rows = [...firstMoves.values()].sort((a, b) => b.games - a.games).slice(0, 8);
  el.theoryMeta.textContent = rows.length ? `${rows.length} first moves` : "Refresh to build tree";
  el.theoryTree.innerHTML = rows.length
    ? rows.map((row) => {
      const replies = [...row.replies.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([move, count]) => `${move} ${count}x`).join(" · ");
      return `<article><strong>${row.move}</strong><span>${row.games} games · ${pct(row.score / row.games * 100)} score</span><p>${replies}</p></article>`;
    }).join("")
    : `<p class="empty">The theory tree appears after the browser imports public games.</p>`;
}

function renderReviews() {
  el.reviewList.innerHTML = state.reviews.length
    ? state.reviews.slice(-12).reverse().map((review) => `
      <article class="line-card">
        <div><span>${review.result} · ${review.date}</span><strong>${review.line}</strong></div>
        <small>${review.note}</small>
      </article>
    `).join("")
    : `<p class="empty">Mark study lines as known or missed to build a local review queue.</p>`;
}

function renderAccuracy() {
  state.accuracy = {
    average: number(el.accuracyAvg.value, 0),
    opening: number(el.accuracyOpening.value, 0),
    middlegame: number(el.accuracyMiddle.value, 0),
    endgame: number(el.accuracyEnd.value, 0),
  };
  saveLocal();
  const phases = [
    ["Average", state.accuracy.average, 75],
    ["Opening", state.accuracy.opening, 85],
    ["Middlegame", state.accuracy.middlegame, 73],
    ["Endgame", state.accuracy.endgame, 80],
  ];
  el.phaseBars.innerHTML = phases.map(([label, value, target]) => `
    <div class="phase-row">
      <div><strong>${label}</strong><span>${pct(value)} / goal ${pct(target, 0)}</span></div>
      <i><b style="width:${Math.max(0, Math.min(100, value))}%"></b></i>
    </div>
  `).join("");
}

function goalItem(label, value, target, suffix = "") {
  const percent = target ? Math.max(0, Math.min(100, value / target * 100)) : 0;
  return `
    <article class="goal-card">
      <div><span>${label}</span><strong>${suffix === "%" ? pct(value) : formatCount(value)} / ${suffix === "%" ? pct(target, 0) : formatCount(target)}</strong></div>
      <i><b style="width:${percent}%"></b></i>
    </article>
  `;
}

function renderGoals() {
  const stats = activeStats();
  if (!stats) {
    el.goalModeLabel.textContent = `${MODE_LABELS[state.mode]} goals`;
    el.goalGrid.innerHTML = `<p class="empty">Refresh public Chess.com stats to calculate goals.</p>`;
    return;
  }
  const recent = state.recentGames.slice(-25);
  const recentWins = recent.filter((game) => game.outcome === "win").length;
  const recentWinrate = recent.length ? recentWins / recent.length * 100 : stats.winRate;
  el.goalModeLabel.textContent = `${MODE_LABELS[state.mode]} goals`;
  el.goalGrid.innerHTML = [
    ...[1600, 1700, 1800, 1900, 2000].map((target) => goalItem(`${target} rating`, stats.rating, target)),
    goalItem("538 more games", Math.min(538, stats.games), stats.games + 538),
    goalItem("1000 more games", Math.min(1000, stats.games), stats.games + 1000),
    goalItem("Avg accuracy 75", state.accuracy.average, 75, "%"),
    goalItem("Middlegame 73", state.accuracy.middlegame, 73, "%"),
    goalItem("Endgame 80", state.accuracy.endgame, 80, "%"),
    goalItem("Recent win rate 52", recentWinrate, 52, "%"),
  ].join("");
}

function renderDropoffEditor() {
  el.dropoffRows.innerHTML = state.dropoff.map((row, index) => `
    <div class="dropoff-row">
      <span>${row[0]}-${row[1]}</span>
      <label>W <input data-dropoff="${index}:2" type="number" min="0" max="100" value="${row[2]}"></label>
      <label>D <input data-dropoff="${index}:3" type="number" min="0" max="100" value="${row[3]}"></label>
      <label>L <input data-dropoff="${index}:4" type="number" min="0" max="100" value="${row[4]}"></label>
    </div>
  `).join("");
  document.querySelectorAll("[data-dropoff]").forEach((input) => {
    input.addEventListener("input", () => {
      const [row, col] = input.dataset.dropoff.split(":").map(Number);
      state.dropoff[row][col] = number(input.value);
      saveLocal();
      renderProjection();
    });
  });
}

function projectGames(count) {
  const stats = activeStats();
  if (!stats) {
    return { finalRating: 0, net: 0, wins: 0, draws: 0, losses: 0, missing: true };
  }
  let wins = 0;
  let draws = 0;
  let losses = 0;
  for (let game = 1; game <= count; game += 1) {
    const band = state.dropoff.find((row) => game >= row[0] && game <= row[1]) || state.dropoff[state.dropoff.length - 1];
    wins += band[2] / 100;
    draws += band[3] / 100;
    losses += band[4] / 100;
  }
  const net = Math.round(wins * 8 - losses * 8);
  return {
    finalRating: stats.rating + net,
    net,
    wins: Math.round(wins),
    draws: Math.round(draws),
    losses: Math.round(losses),
  };
}

function timeEstimate(count) {
  const avg = state.recentGames.length
    ? state.recentGames.reduce((sum, game) => sum + game.duration, 0) / state.recentGames.length
    : 20;
  const maxMinutes = count * 20;
  const realMinutes = count * avg;
  const fmt = (minutes) => `${formatCount(minutes)} min · ${Math.floor(minutes / 60)}h${Math.round(minutes % 60).toString().padStart(2, "0")}m`;
  return { max: fmt(maxMinutes), real: fmt(realMinutes), days20: (realMinutes / avg / 20).toFixed(1) };
}

function renderProjectionCard(resultId, subId, count) {
  const result = projectGames(count);
  if (result.missing) {
    $(resultId).textContent = "-";
    $(subId).textContent = "Refresh public Chess.com stats to project.";
    return;
  }
  const time = timeEstimate(count);
  $(resultId).textContent = `${formatRating(result.finalRating)} (${result.net >= 0 ? "+" : ""}${result.net})`;
  $(subId).textContent = `${result.wins}W ${result.draws}D ${result.losses}L · real ${time.real} · max ${time.max}`;
}

function renderProjection() {
  state.customGames = Math.max(1, number(el.customGames.value, 538));
  saveLocal();
  renderProjectionCard("projection538", "projection538Sub", 538);
  renderProjectionCard("projection1000", "projection1000Sub", 1000);
  renderProjectionCard("projectionCustom", "projectionCustomSub", state.customGames);
}

function renderSessions() {
  const sessions = [...state.sessions].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  renderLineChart(el.sessionChart, sessions.map((session) => ({ value: number(session.endRating || session.startRating) })), { width: 620, height: 240, gradient: "sessionGradient" });
  el.sessionList.innerHTML = sessions.length ? sessions.slice(-8).reverse().map((session) => `
    <article>
      <strong>${session.date || "No date"} · ${formatRating(session.startRating)} → ${formatRating(session.endRating)}</strong>
      <span>${number(session.wins)}W ${number(session.draws)}D ${number(session.losses)}L · ${session.accuracy ? pct(number(session.accuracy)) : "accuracy not set"}</span>
      <p>${session.theme || "No theme"} · ${session.next || "No next step"}</p>
    </article>
  `).join("") : `<p class="empty">No sessions saved yet. Add one on the left and Bookup Web will chart it locally.</p>`;
}

function weakness() {
  const phases = [
    ["opening", state.accuracy.opening],
    ["middlegame", state.accuracy.middlegame],
    ["endgame", state.accuracy.endgame],
  ];
  phases.sort((a, b) => a[1] - b[1]);
  return { worst: phases[0][0], best: phases[2][0] };
}

function renderTraining() {
  const stats = activeStats();
  if (!stats) {
    el.weaknessLabel.textContent = "Refresh stats to calculate weakness.";
    el.trainingGrid.innerHTML = `<article><span>Start</span><p>Refresh public Chess.com data, then Bookup Web will generate opening, middlegame, endgame, tactics, and review recommendations.</p></article>`;
    return;
  }
  const recent = state.recentGames.slice(-25);
  const recentWinrate = recent.length ? recent.filter((game) => game.outcome === "win").length / recent.length * 100 : stats.winRate;
  const weak = weakness();
  el.weaknessLabel.textContent = `Main weakness: ${weak.worst}. Best phase: ${weak.best}.`;
  const recommendations = [
    ["Opening", state.accuracy.opening >= 82 ? "Keep your current repertoire stable. Add one new response only after review sessions are clean." : "Repair early move-order mistakes. Build one response card for the reply you face most."],
    ["Middlegame", state.accuracy.middlegame >= 73 ? "Convert good openings into plans: pawn breaks, worst-piece improvement, and king safety checks." : "Main focus: pause before move 12-25, list forcing moves, and review every tactic missed in recent losses."],
    ["Endgame", state.accuracy.endgame >= 80 ? "Maintain rook and pawn endings twice a week so late-game conversion stays sharp." : "Drill king activity, rook activity, and pawn-race counting. Save every endgame loss as a session theme."],
    ["Tactics", recentWinrate >= 52 ? "Keep tactics short and daily: 10 clean puzzles before playing." : "Before each session, do forks, pins, back-rank, and removal-of-defender sets. Review losses immediately."],
    ["Review priority", `${MODE_LABELS[state.mode]} is at ${formatRating(stats.rating)} with ${pct(stats.winRate)} wins. Review ${weak.worst} positions first, then play a smaller set of games with notes.`],
  ];
  el.trainingGrid.innerHTML = recommendations.map(([title, text]) => `<article><span>${title}</span><p>${text}</p></article>`).join("");
}

function renderAll() {
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
  renderMetrics();
  renderRatingChart();
  renderImportSummary();
  renderRepertoire();
  renderStudy();
  renderTheory();
  renderReviews();
  renderAccuracy();
  renderGoals();
  renderProjection();
  renderSessions();
  renderTraining();
}

function bind() {
  Object.assign(el, {
    usernameInput: $("usernameInput"),
    refreshForm: $("refreshForm"),
    refreshBtn: $("refreshBtn"),
    statusLine: $("statusLine"),
    ratingValue: $("ratingValue"),
    ratingSub: $("ratingSub"),
    recordValue: $("recordValue"),
    recordSub: $("recordSub"),
    winrateValue: $("winrateValue"),
    scoreValue: $("scoreValue"),
    formValue: $("formValue"),
    formSub: $("formSub"),
    lengthValue: $("lengthValue"),
    lengthSub: $("lengthSub"),
    ratingChart: $("ratingChart"),
    chartMeta: $("chartMeta"),
    accuracyAvg: $("accuracyAvg"),
    accuracyOpening: $("accuracyOpening"),
    accuracyMiddle: $("accuracyMiddle"),
    accuracyEnd: $("accuracyEnd"),
    phaseBars: $("phaseBars"),
    goalGrid: $("goalGrid"),
    goalModeLabel: $("goalModeLabel"),
    customGames: $("customGames"),
    dropoffRows: $("dropoffRows"),
    sessionForm: $("sessionForm"),
    sessionDate: $("sessionDate"),
    sessionStart: $("sessionStart"),
    sessionEnd: $("sessionEnd"),
    sessionWins: $("sessionWins"),
    sessionDraws: $("sessionDraws"),
    sessionLosses: $("sessionLosses"),
    sessionAccuracy: $("sessionAccuracy"),
    sessionTheme: $("sessionTheme"),
    sessionNext: $("sessionNext"),
    sessionNotes: $("sessionNotes"),
    sessionChart: $("sessionChart"),
    sessionList: $("sessionList"),
    clearSessions: $("clearSessions"),
    importStatus: $("importStatus"),
    importSummary: $("importSummary"),
    repertoireMeta: $("repertoireMeta"),
    repertoireList: $("repertoireList"),
    needsMeta: $("needsMeta"),
    needsWorkList: $("needsWorkList"),
    studyMeta: $("studyMeta"),
    studyCard: $("studyCard"),
    prevLineBtn: $("prevLineBtn"),
    nextLineBtn: $("nextLineBtn"),
    knownLineBtn: $("knownLineBtn"),
    missedLineBtn: $("missedLineBtn"),
    theoryMeta: $("theoryMeta"),
    theoryTree: $("theoryTree"),
    clearReviews: $("clearReviews"),
    reviewList: $("reviewList"),
    trainingGrid: $("trainingGrid"),
    weaknessLabel: $("weaknessLabel"),
  });

  el.refreshForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void refresh();
  });
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      saveLocal();
      void refresh();
    });
  });
  [el.accuracyAvg, el.accuracyOpening, el.accuracyMiddle, el.accuracyEnd].forEach((input) => input.addEventListener("input", renderAll));
  el.customGames.addEventListener("input", renderProjection);
  el.sessionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.sessions.push({
      date: el.sessionDate.value,
      startRating: number(el.sessionStart.value),
      endRating: number(el.sessionEnd.value),
      wins: number(el.sessionWins.value),
      draws: number(el.sessionDraws.value),
      losses: number(el.sessionLosses.value),
      accuracy: number(el.sessionAccuracy.value),
      theme: el.sessionTheme.value.trim(),
      next: el.sessionNext.value.trim(),
      notes: el.sessionNotes.value.trim(),
    });
    saveLocal();
    el.sessionForm.reset();
    el.sessionDate.valueAsDate = new Date();
    renderAll();
  });
  el.clearSessions.addEventListener("click", () => {
    state.sessions = [];
    saveLocal();
    renderAll();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-study-line]");
    if (!button) return;
    state.studyIndex = Math.max(0, Math.min(state.repertoire.length - 1, number(button.dataset.studyLine)));
    renderStudy();
    document.getElementById("study")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  el.prevLineBtn.addEventListener("click", () => {
    state.studyIndex = Math.max(0, state.studyIndex - 1);
    renderStudy();
  });
  el.nextLineBtn.addEventListener("click", () => {
    state.studyIndex = Math.min(Math.max(0, state.repertoire.length - 1), state.studyIndex + 1);
    renderStudy();
  });
  const saveReview = (result) => {
    const line = state.repertoire[state.studyIndex];
    if (!line) return;
    state.reviews.push({
      result,
      date: new Date().toLocaleDateString(),
      line: line.moves.slice(0, 8).join(" "),
      note: lineRecord(line),
    });
    saveLocal();
    renderReviews();
  };
  el.knownLineBtn.addEventListener("click", () => saveReview("known"));
  el.missedLineBtn.addEventListener("click", () => saveReview("missed"));
  el.clearReviews.addEventListener("click", () => {
    state.reviews = [];
    saveLocal();
    renderReviews();
  });
}

loadLocal();
document.addEventListener("DOMContentLoaded", () => {
  bind();
  el.usernameInput.value = state.username;
  el.customGames.value = String(state.customGames);
  el.accuracyAvg.value = state.accuracy.average;
  el.accuracyOpening.value = state.accuracy.opening;
  el.accuracyMiddle.value = state.accuracy.middlegame;
  el.accuracyEnd.value = state.accuracy.endgame;
  el.sessionDate.valueAsDate = new Date();
  renderDropoffEditor();
  renderAll();
  void refresh();
});
