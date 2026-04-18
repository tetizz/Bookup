const defaults = window.APP_DEFAULTS || {};
const PIECE_ASSETS = {
  P: "/static/pieces/cburnett/wP.svg",
  N: "/static/pieces/cburnett/wN.svg",
  B: "/static/pieces/cburnett/wB.svg",
  R: "/static/pieces/cburnett/wR.svg",
  Q: "/static/pieces/cburnett/wQ.svg",
  K: "/static/pieces/cburnett/wK.svg",
  p: "/static/pieces/cburnett/bP.svg",
  n: "/static/pieces/cburnett/bN.svg",
  b: "/static/pieces/cburnett/bB.svg",
  r: "/static/pieces/cburnett/bR.svg",
  q: "/static/pieces/cburnett/bQ.svg",
  k: "/static/pieces/cburnett/bK.svg",
};
const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];
const phaseColors = {
  opening: "#3ef0a0",
  middlegame: "#5ca0ff",
  endgame: "#ff5c63",
};

const el = {
  username: document.getElementById("usernameInput"),
  timeClasses: document.getElementById("timeClassesInput"),
  maxGames: document.getElementById("maxGamesInput"),
  enginePath: document.getElementById("enginePathInput"),
  depth: document.getElementById("depthInput"),
  threads: document.getElementById("threadsInput"),
  hash: document.getElementById("hashInput"),
  analyze: document.getElementById("analyzeBtn"),
  status: document.getElementById("status"),
  heroTitle: document.getElementById("heroTitle"),
  heroSummary: document.getElementById("heroSummary"),
  badgeWinRate: document.getElementById("badgeWinRate"),
  badgeChaos: document.getElementById("badgeChaos"),
  badgeColor: document.getElementById("badgeColor"),
  radarWrap: document.getElementById("radarWrap"),
  styleMetrics: document.getElementById("styleMetrics"),
  styleSummary: document.getElementById("styleSummary"),
  firstMoveLead: document.getElementById("firstMoveLead"),
  firstMoveList: document.getElementById("firstMoveList"),
  openingListWhite: document.getElementById("openingListWhite"),
  openingListBlack: document.getElementById("openingListBlack"),
  phaseBreakdown: document.getElementById("phaseBreakdown"),
  whereGamesEnd: document.getElementById("whereGamesEnd"),
  phaseBars: document.getElementById("phaseBars"),
  gameLengthStats: document.getElementById("gameLengthStats"),
  resignationStats: document.getElementById("resignationStats"),
  colorWhite: document.getElementById("colorWhite"),
  colorBlack: document.getElementById("colorBlack"),
  opponentStrength: document.getElementById("opponentStrength"),
  clockLine: document.getElementById("clockLine"),
  clockPhaseStats: document.getElementById("clockPhaseStats"),
  castlingPie: document.getElementById("castlingPie"),
  castlingStats: document.getElementById("castlingStats"),
  timeControlChart: document.getElementById("timeControlChart"),
  hourlyChart: document.getElementById("hourlyChart"),
  dossierGrid: document.getElementById("dossierGrid"),
  compareUsername: document.getElementById("compareUsernameInput"),
  compareBtn: document.getElementById("compareBtn"),
  compareSummary: document.getElementById("compareSummary"),
  comparePrimary: document.getElementById("comparePrimary"),
  compareSecondary: document.getElementById("compareSecondary"),
  improvementList: document.getElementById("improvementList"),
  adviceList: document.getElementById("adviceList"),
  board: document.getElementById("board"),
  rankLabels: document.getElementById("rankLabels"),
  fileLabels: document.getElementById("fileLabels"),
  boardTitle: document.getElementById("boardTitle"),
  boardSummary: document.getElementById("boardSummary"),
  boardLine: document.getElementById("boardLine"),
  coachPrompt: document.getElementById("coachPrompt"),
  coachFeedback: document.getElementById("coachFeedback"),
  coachList: document.getElementById("coachList"),
  coachReset: document.getElementById("coachResetBtn"),
  coachReveal: document.getElementById("coachRevealBtn"),
  coachNext: document.getElementById("coachNextBtn"),
};

let currentPrimaryPayload = null;
let currentSecondaryPayload = null;
const state = {
  boardFen: "startpos",
  legalMoves: [],
  legalByFrom: {},
  selectedSquare: "",
  dragFrom: "",
  lastMove: null,
  coachItems: [],
  coachIndex: -1,
  coachStartFen: "",
};

function init() {
  el.username.value = defaults.username || "trixize1234";
  el.timeClasses.value = defaults.time_classes || "all";
  el.maxGames.value = defaults.max_games || 40;
  el.enginePath.value = defaults.engine_path || "";
  el.depth.value = defaults.depth || 13;
  el.threads.value = defaults.threads || 8;
  el.hash.value = defaults.hash_mb || 2048;
  el.analyze.addEventListener("click", runAnalysis);
  el.compareBtn?.addEventListener("click", runCompare);
  el.coachReset?.addEventListener("click", resetCoachDrill);
  el.coachReveal?.addEventListener("click", revealCoachDrill);
  el.coachNext?.addEventListener("click", nextCoachDrill);
  renderCoords();
  renderBoard("startpos");
}

async function runAnalysis() {
  setStatus("Importing games and building scout report...");
  el.analyze.disabled = true;
  try {
    const payload = await fetchProfilePayload(el.username.value.trim());
    renderProfile(payload);
    setStatus(`Analyzed ${payload.profile.games_analyzed} games for ${payload.username}.`);
  } catch (error) {
    setStatus(error.message || "Profile build failed.");
  } finally {
    el.analyze.disabled = false;
  }
}

async function runCompare() {
  if (!currentPrimaryPayload) {
    setStatus("Build a scout report first so there is a player to compare against.");
    return;
  }
  const username = (el.compareUsername?.value || "").trim();
  if (!username) {
    setStatus("Enter a second Chess.com username to compare.");
    return;
  }
  setStatus(`Comparing ${currentPrimaryPayload.username} with ${username}...`);
  el.compareBtn.disabled = true;
  try {
    const payload = await fetchProfilePayload(username);
    currentSecondaryPayload = payload;
    renderCompare(currentPrimaryPayload, currentSecondaryPayload);
    setStatus(`Compared ${currentPrimaryPayload.username} with ${payload.username}.`);
  } catch (error) {
    setStatus(error.message || "Compare build failed.");
  } finally {
    el.compareBtn.disabled = false;
  }
}

async function fetchProfilePayload(username) {
  const response = await fetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildProfileRequest(username)),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Profile build failed.");
  return payload;
}

function buildProfileRequest(username) {
  return {
    username,
    time_classes: el.timeClasses.value.trim(),
    max_games: Number(el.maxGames.value),
    engine_path: el.enginePath.value.trim(),
    depth: Number(el.depth.value),
    threads: Number(el.threads.value),
    hash_mb: Number(el.hash.value),
  };
}

function renderProfile(payload) {
  currentPrimaryPayload = payload;
  const profile = payload.profile;
  el.heroTitle.textContent = `${payload.username} scout report`;
  el.heroSummary.textContent = profile.scout_brief;
  el.badgeWinRate.textContent = `${profile.hero_stats.win_rate}%`;
  el.badgeChaos.textContent = `${profile.hero_stats.chaos_index}/100`;
  el.badgeColor.textContent = profile.hero_stats.better_as;

  renderRadar(profile.radar || {});
  renderStyleMetrics(profile.style_metrics || {});
  el.styleSummary.textContent = profile.style_summary || "";

  renderFirstMove(profile.first_move_repertoire || {});
  renderOpenings(profile.top_openings_by_color || {});
  renderPhaseBreakdown(profile.phase_breakdown || []);
  renderWhereGamesEnd(profile.phase_breakdown || []);
  renderGameLength(profile.game_length || {});
  renderResignation(profile.resignation || {});
  renderColorRecord(profile.color_record || {});
  renderOpponentStrength(profile.opponent_strength || []);
  renderClock(profile.clock || {});
  renderCastling(profile.castling || {});
  renderTimeControl(profile.time_control || {});
  renderDossier(profile.dossier || []);
  renderComparePrimary(payload);
  renderCompare(currentPrimaryPayload, currentSecondaryPayload);
  renderImprovements(profile.improvements || []);
  renderAdvice(profile.opening_advice || []);
  state.coachItems = profile.coach_positions || [];
  renderCoachList();
  if (state.coachItems.length) {
    loadCoachDrill(0).catch((error) => setStatus(error.message || "Could not load coach drill."));
  }
}

function renderStyleMetrics(metrics) {
  const items = [
    ["Chaos Index", `${Math.round(metrics.chaos_index || 0)}/100`, "accent-danger", "Thrives in chaos - keep it structured."],
    ["Aggression Index", `${Math.round(metrics.aggression_index || 0)}/100`, "accent-danger", "Highly aggressive - lots of captures and checks."],
    ["Capture Rate", `${metrics.capture_rate || 0}%`, "accent-danger", "captures / moves"],
    ["Forcing Rate", `${metrics.forcing_rate || 0}%`, "accent-gold", "forcing / moves"],
    ["Avg Captures/Game", `${metrics.avg_captures_per_game || 0}`, "accent-good", "captures each game"],
    ["Tactical Bursts", `${metrics.tactical_bursts || 0}`, "accent-good", "consecutive forcing moves"],
  ];
  el.styleMetrics.innerHTML = items.map(([label, value, accent, note]) => `
    <div class="metric">
      <div class="metric-label">${label}</div>
      <div class="metric-value ${accent}">${value}</div>
      <div class="metric-note">${note}</div>
    </div>
  `).join("");
}

function renderFirstMove(data) {
  const top = data.top_move;
  if (!top) {
    el.firstMoveLead.textContent = "No white first-move data yet.";
    el.firstMoveList.className = "stack empty";
    el.firstMoveList.textContent = "No first-move repertoire yet.";
    return;
  }
  el.firstMoveLead.innerHTML = `
    First move repertoire as White
    <strong>${top.move}</strong>
    <div class="first-move-meta">${top.pct}% - ${top.count}x</div>
    <div class="first-move-scale">
      <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
    </div>
    <div class="bar-track"><div class="bar-fill" style="width:${top.pct}%"></div></div>
  `;
  el.firstMoveList.className = "stack";
  el.firstMoveList.innerHTML = (data.items || []).map((item, index) => `
    <div class="item">
      <div class="item-title">${index + 1}. ${item.move}</div>
      <div class="item-sub">${item.pct}% - ${item.count} games</div>
      <div class="bar-track"><div class="bar-fill" style="width:${item.pct}%"></div></div>
    </div>
  `).join("");
}

function renderOpenings(byColor) {
  renderOpeningColumn(el.openingListWhite, byColor.white || [], "white");
  renderOpeningColumn(el.openingListBlack, byColor.black || [], "black");
}

function renderOpeningColumn(node, items, side) {
  if (!items.length) {
    node.className = "stack empty";
    node.textContent = `No ${side} opening profile yet.`;
    return;
  }
  node.className = "stack";
  node.innerHTML = items.map((item, index) => `
    <div class="item">
      <div class="item-title">${index + 1}. ${item.opening}</div>
      <div class="item-sub">${item.count}x - ${item.win_rate}% win rate</div>
      <div class="record-line">
        <span class="record-win">${item.record.wins}W</span>
        <span class="record-draw">${item.record.draws}D</span>
        <span class="record-loss">${item.record.losses}L</span>
      </div>
    </div>
  `).join("");
}

function renderPhaseBreakdown(phases) {
  el.phaseBreakdown.innerHTML = phases.map((item) => `
    <article class="phase-card ${item.phase}">
      <div class="metric-label">${item.label}</div>
      <div class="phase-big"><strong>${item.games}</strong><span>(${item.pct}%)</span></div>
      <div class="phase-record">
        <span class="record-win">${item.wins}W</span>
        <span class="record-loss">${item.losses}L</span>
        <span class="record-draw">${item.draws}D</span>
        <span>${item.avg_seconds_per_move}s/mv</span>
      </div>
      <div class="bar-track"><div class="bar-fill ${item.phase === "middlegame" ? "blue" : item.phase === "endgame" ? "red" : ""}" style="width:${item.pct}%"></div></div>
    </article>
  `).join("");
}

function renderWhereGamesEnd(phases) {
  el.whereGamesEnd.innerHTML = renderDonut(phases.map((item) => ({
    label: item.label,
    value: item.games,
    color: phaseColors[item.phase],
  })));

  el.phaseBars.className = "stack";
  el.phaseBars.innerHTML = phases.map((item) => `
    <div class="item">
      <div class="item-title">${item.label}</div>
      <div class="record-line">
        <span class="record-win">${item.wins} wins</span>
        <span class="record-loss">${item.losses} losses</span>
        <span class="record-draw">${item.draws} draws</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill ${item.phase === "middlegame" ? "blue" : item.phase === "endgame" ? "red" : ""}" style="width:${Math.max(item.wins + item.losses + item.draws ? (item.wins / (item.wins + item.losses + item.draws)) * 100 : 0, 3)}%"></div>
      </div>
    </div>
  `).join("");
}

function renderGameLength(info) {
  const items = [
    ["Avg Game", `${info.avg_game || 0} moves`, "accent-good", ""],
    ["Avg Win", `${info.avg_win || 0} moves`, "accent-good", "when they win"],
    ["Avg Loss", `${info.avg_loss || 0} moves`, "accent-danger", "when they lose"],
    ["Endgame WR", `${info.endgame_wr || 0}%`, "accent-good", `${info.endgame_games || 0} endgame games`],
  ];
  el.gameLengthStats.innerHTML = items.map(([label, value, accent, note]) => `
    <div class="stat-card">
      <div class="metric-label">${label}</div>
      <strong class="${accent}">${value}</strong>
      <div class="record-sub">${note}</div>
    </div>
  `).join("");
}

function renderResignation(info) {
  const items = [
    ["Avg Resignation Move", info.avg_move ? `Move ${info.avg_move}` : "-", "accent-danger", "Fights hard before resigning"],
    ["Early Resign Rate", `${info.early_rate || 0}%`, "accent-danger", "resign before move 20"],
    ["Fighting Spirit", info.fighting_spirit || "-", "accent-good", ""],
  ];
  el.resignationStats.innerHTML = items.map(([label, value, accent, note]) => `
    <div class="stat-card">
      <div class="metric-label">${label}</div>
      <strong class="${accent}">${value}</strong>
      <div class="record-sub">${note}</div>
    </div>
  `).join("");
}

function renderColorRecord(info) {
  renderRecordBox(el.colorWhite, info.white, "As White");
  renderRecordBox(el.colorBlack, info.black, "As Black");
}

function renderOpponentStrength(items) {
  if (!items.length) {
    el.opponentStrength.innerHTML = `<div class="record-box empty">No opponent-strength data yet.</div>`;
    return;
  }
  el.opponentStrength.innerHTML = items.map((item) => `
    <div class="stat-card">
      <div class="metric-label">${item.bucket}</div>
      <strong class="${item.bucket === "vs higher" ? "accent-danger" : item.bucket === "vs equal" ? "accent-blue" : "accent-gold"}">${item.win_rate}%</strong>
      <div class="record-sub">${item.games} games</div>
      <div class="bar-track"><div class="bar-fill ${item.bucket === "vs higher" ? "red" : item.bucket === "vs equal" ? "blue" : "gold"}" style="width:${item.win_rate}%"></div></div>
    </div>
  `).join("");
}

function renderRecordBox(node, record, title) {
  if (!record) {
    node.className = "record-box empty";
    node.textContent = "No data yet.";
    return;
  }
  node.className = "record-box";
  node.innerHTML = `
    <div class="record-label">${title}</div>
    <strong>${record.win_rate}%</strong>
    <div class="record-line">
      <span class="record-win">${record.wins}W</span>
      <span class="record-draw">${record.draws}D</span>
      <span class="record-loss">${record.losses}L</span>
    </div>
    <div class="bar-track">
      <div class="bar-fill" style="width:${record.win_rate}%"></div>
    </div>
  `;
}

function renderClock(clock) {
  const linePoints = [
    { label: "Start", value: parseClockText(clock.avg_remaining?.start) },
    { label: "Mid", value: parseClockText(clock.avg_remaining?.middlegame) },
    { label: "Endgame", value: parseClockText(clock.avg_remaining?.endgame) },
    { label: "End", value: parseClockText(clock.avg_remaining?.end) },
  ];
  el.clockLine.className = "chart-wrap";
  el.clockLine.innerHTML = renderLineChart(linePoints, "#3ef0a0", 600);

  const items = [
    ["Game Start", clock.avg_remaining?.start || "-", "accent-good"],
    ["Middlegame", clock.avg_remaining?.middlegame || "-", "accent-blue"],
    ["Endgame", clock.avg_remaining?.endgame || "-", "accent-gold"],
    ["Game End", clock.avg_remaining?.end || "-", "accent-danger"],
    ["Clock Burn Rate", `${clock.burn_rate_pct || 0}% burned`, "accent-good"],
    ["Opening s/mv", `${clock.seconds_per_move?.opening || 0}s`, "accent-blue"],
    ["Middlegame s/mv", `${clock.seconds_per_move?.middlegame || 0}s`, "accent-blue"],
    ["Endgame s/mv", `${clock.seconds_per_move?.endgame || 0}s`, "accent-gold"],
  ];
  el.clockPhaseStats.innerHTML = items.map(([label, value, accent]) => `
    <div class="mini-card">
      <div class="metric-label">${label}</div>
      <strong class="${accent}">${value}</strong>
    </div>
  `).join("");
}

function renderCastling(castling) {
  el.castlingPie.innerHTML = renderDonut([
    { label: "Kingside", value: castling.kingside || 0, color: "#3ef0a0" },
    { label: "Queenside", value: castling.queenside || 0, color: "#f3c542" },
    { label: "No Castle", value: castling.no_castle || 0, color: "#5ca0ff" },
  ]);
  const items = [
    ["Avg Castle Move", castling.avg_move ? `Move ${castling.avg_move}` : "-", "accent-good"],
    ["Castle Rate", `${castling.rate || 0}%`, "accent-good"],
    ["Early (<= 8)", `${castling.early_pct || 0}%`, "accent-good"],
    ["Late (> 15)", `${castling.late_pct || 0}%`, "accent-danger"],
    ["Kingside", `${castling.kingside || 0} games`, "accent-blue"],
    ["Queenside", `${castling.queenside || 0} games`, "accent-gold"],
  ];
  el.castlingStats.innerHTML = items.map(([label, value, accent]) => `
    <div class="mini-card">
      <div class="metric-label">${label}</div>
      <strong class="${accent}">${value}</strong>
    </div>
  `).join("");
}

function renderTimeControl(info) {
  const classes = info.by_class || [];
  if (!classes.length) {
    el.timeControlChart.className = "stack empty";
    el.timeControlChart.textContent = "No time control data yet.";
  } else {
    el.timeControlChart.className = "stack";
    el.timeControlChart.innerHTML = classes.map((item) => `
      <div class="item">
        <div class="item-title">${item.label}</div>
        <div class="record-line">
          <span>${item.games} games</span>
          <span class="record-win">${item.wins}W</span>
          <span class="record-loss">${item.losses}L</span>
          <span class="record-draw">${item.draws}D</span>
          <span class="record-gold">${item.win_rate}% WR</span>
        </div>
        <div class="bar-track"><div class="bar-fill blue" style="width:${item.win_rate}%"></div></div>
      </div>
    `).join("");
  }
  const hourly = (info.hourly || []).map((item) => ({ label: formatHour(item.hour), value: item.win_rate ?? 0 }));
  el.hourlyChart.className = "chart-wrap";
  el.hourlyChart.innerHTML = renderLineChart(hourly, "#f3c542", 100, 720);
}

function renderDossier(items) {
  el.dossierGrid.innerHTML = items.map((item) => `
    <article class="dossier-card">
      <div class="dossier-label">${item.label}</div>
      <div class="dossier-value ${accentClass(item.accent)}">${item.value}</div>
      <div class="small-note">${item.detail}</div>
      <div class="small-note ${item.tone === "critical" ? "accent-danger" : "accent-good"}">${item.tone}</div>
    </article>
  `).join("");
}

function renderComparePrimary(payload) {
  if (!payload) {
    el.comparePrimary.className = "compare-player-body empty";
    el.comparePrimary.textContent = "No primary player loaded yet.";
    return;
  }
  el.comparePrimary.className = "compare-player-body";
  el.comparePrimary.innerHTML = renderComparePlayerCard(payload);
}

function renderCompare(primaryPayload, secondaryPayload) {
  renderComparePrimary(primaryPayload);
  if (!secondaryPayload) {
    el.compareSummary.className = "compare-summary empty";
    el.compareSummary.textContent = primaryPayload
      ? `Scout report ready for ${primaryPayload.username}. Search a second player to compare style, results, and preparation risk side by side.`
      : "Build a scout report first, then search a second Chess.com username here to compare both profiles side by side.";
    el.compareSecondary.className = "compare-player-body empty";
    el.compareSecondary.textContent = "No comparison player loaded yet.";
    return;
  }

  el.compareSecondary.className = "compare-player-body";
  el.compareSecondary.innerHTML = renderComparePlayerCard(secondaryPayload);
  el.compareSummary.className = "compare-summary";
  el.compareSummary.textContent = buildCompareSummary(primaryPayload, secondaryPayload);
}

function renderComparePlayerCard(payload) {
  const profile = payload.profile || {};
  const hero = profile.hero_stats || {};
  const styleTag = classifyStyleTag(profile);
  const topOpening = pickTopOpening(profile);
  return `
    <div class="compare-player-name">${escapeHtml(payload.username)}</div>
    <div class="compare-player-tag">${escapeHtml(styleTag)}</div>
    <div class="compare-metrics">
      <div class="mini-card">
        <div class="metric-label">Win Rate</div>
        <strong class="accent-good">${hero.win_rate || 0}%</strong>
      </div>
      <div class="mini-card">
        <div class="metric-label">Chaos</div>
        <strong class="accent-danger">${hero.chaos_index || 0}/100</strong>
      </div>
      <div class="mini-card">
        <div class="metric-label">Better As</div>
        <strong class="accent-blue">${escapeHtml(hero.better_as || "-")}</strong>
      </div>
    </div>
    <div class="compare-notes">
      <div><span class="metric-label">Top opening</span><strong>${escapeHtml(topOpening.name)}</strong></div>
      <div><span class="metric-label">Opening WR</span><strong>${topOpening.winRate}%</strong></div>
      <div><span class="metric-label">Games</span><strong>${profile.games_analyzed || 0}</strong></div>
    </div>
  `;
}

function buildCompareSummary(primaryPayload, secondaryPayload) {
  const primary = primaryPayload.profile || {};
  const secondary = secondaryPayload.profile || {};
  const pHero = primary.hero_stats || {};
  const sHero = secondary.hero_stats || {};
  const primaryScore = Number(pHero.win_rate || 0) + (Number(pHero.chaos_index || 0) * 0.15);
  const secondaryScore = Number(sHero.win_rate || 0) + (Number(sHero.chaos_index || 0) * 0.15);
  const edge = primaryScore === secondaryScore
    ? "looks even"
    : primaryScore > secondaryScore
      ? `${primaryPayload.username} has the edge`
      : `${secondaryPayload.username} has the edge`;

  const whiteGap = Number(primary.color_record?.white?.win_rate || 0) - Number(secondary.color_record?.white?.win_rate || 0);
  const sharper = Number(primary.style_metrics?.chaos_index || 0) >= Number(secondary.style_metrics?.chaos_index || 0)
    ? primaryPayload.username
    : secondaryPayload.username;
  const steadier = sharper === primaryPayload.username ? secondaryPayload.username : primaryPayload.username;

  return `${edge}: ${sharper} is sharper and more chaotic, while ${steadier} is steadier. ${Math.abs(whiteGap).toFixed(1)}% separates their White win rates, so color assignment and opening choice should matter in this matchup.`;
}

function classifyStyleTag(profile) {
  const style = profile.style_metrics || {};
  if ((style.aggression_index || 0) >= 70 && (style.chaos_index || 0) >= 65) return "The Attacker";
  if ((style.endgame_grit || 0) >= 70) return "The Grinder";
  if ((style.opening_loyalty || 0) >= 35) return "The Specialist";
  return "The Explorer";
}

function pickTopOpening(profile) {
  const white = profile.top_openings_by_color?.white || [];
  const black = profile.top_openings_by_color?.black || [];
  const combined = [...white, ...black].sort((a, b) => (b.count || 0) - (a.count || 0));
  if (!combined.length) {
    return { name: "No opening data", winRate: 0 };
  }
  return {
    name: combined[0].opening || "Unknown",
    winRate: combined[0].win_rate || 0,
  };
}

function renderImprovements(improvements) {
  if (!improvements.length) {
    el.improvementList.className = "stack empty";
    el.improvementList.textContent = "No engine notes yet.";
    return;
  }
  el.improvementList.className = "stack";
  el.improvementList.innerHTML = improvements.map((item, index) => `
    <div class="item clickable" data-improvement-index="${index}">
      <div class="item-title">${item.headline}</div>
      <div class="item-sub">${item.detail || ""}</div>
      ${item.example ? `<div class="item-note">Played ${item.example.played} | Engine wanted ${item.example.best}</div>` : ""}
    </div>
  `).join("");
  el.improvementList.querySelectorAll("[data-improvement-index]").forEach((node) => {
    node.addEventListener("click", () => {
      const item = improvements[Number(node.dataset.improvementIndex)];
      if (item?.example?.position_fen) {
        loadBoardPreview(
          item.example.position_fen,
          item.headline,
          item.detail || "Engine improvement example.",
          item.example.line || `${item.example.played} -> ${item.example.best}`
        );
        el.coachPrompt.textContent = "Previewing an engine mistake example.";
        el.coachFeedback.textContent = `You played ${item.example.played}; the engine preferred ${item.example.best}.`;
        el.coachFeedback.classList.remove("empty");
      }
    });
  });
}

function renderAdvice(advice) {
  if (!advice.length) {
    el.adviceList.className = "stack empty";
    el.adviceList.textContent = "No opening-response advice yet.";
    return;
  }
  el.adviceList.className = "stack";
  el.adviceList.innerHTML = advice.map((item, index) => `
    <div class="item clickable" data-advice-index="${index}">
      <div class="item-title">${item.opening}</div>
      <div class="item-sub">When opponents usually answer with ${item.opponent_reply}, the engine wants ${item.recommendation}.</div>
      <div class="item-sub">${item.explanation}</div>
      <div class="item-note">${item.example_line}</div>
    </div>
  `).join("");
  el.adviceList.querySelectorAll("[data-advice-index]").forEach((node) => {
    node.addEventListener("click", () => {
      const item = advice[Number(node.dataset.adviceIndex)];
      if (item?.position_fen) {
        loadBoardPreview(
          item.position_fen,
          item.opening,
          item.explanation,
          item.example_line || item.recommendation
        );
        el.coachPrompt.textContent = "Previewing an opening recommendation position.";
        el.coachFeedback.textContent = `Engine recommendation: ${item.recommendation}.`;
        el.coachFeedback.classList.remove("empty");
      }
    });
  });
}

function renderRadar(radar) {
  const entries = Object.entries(radar);
  if (!entries.length) {
    el.radarWrap.textContent = "No radar data yet.";
    return;
  }
  const size = 420;
  const cx = 210;
  const cy = 210;
  const radius = 140;
  const levels = 5;
  const points = entries.map(([label, value], index) => {
    const angle = (-Math.PI / 2) + (Math.PI * 2 * index / entries.length);
    const r = radius * (value / 100);
    return {
      label,
      value,
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      lx: cx + Math.cos(angle) * (radius + 34),
      ly: cy + Math.sin(angle) * (radius + 34),
      ax: cx + Math.cos(angle) * radius,
      ay: cy + Math.sin(angle) * radius,
    };
  });
  const gridPolys = [];
  for (let level = 1; level <= levels; level += 1) {
    const r = radius * (level / levels);
    gridPolys.push(points.map((_, index) => {
      const angle = (-Math.PI / 2) + (Math.PI * 2 * index / entries.length);
      return `${cx + Math.cos(angle) * r},${cy + Math.sin(angle) * r}`;
    }).join(" "));
  }
  const polygon = points.map((point) => `${point.x},${point.y}`).join(" ");
  el.radarWrap.innerHTML = `
    <svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Style radar">
      ${gridPolys.map((poly) => `<polygon points="${poly}" fill="none" stroke="rgba(126, 168, 146, 0.25)" stroke-width="1.4"></polygon>`).join("")}
      ${points.map((point) => `<line x1="${cx}" y1="${cy}" x2="${point.ax}" y2="${point.ay}" stroke="rgba(126, 168, 146, 0.25)" stroke-width="1.2"></line>`).join("")}
      <polygon points="${polygon}" fill="rgba(62, 240, 160, 0.18)" stroke="#3ef0a0" stroke-width="3"></polygon>
      ${points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="5.5" fill="#10231c" stroke="#3ef0a0" stroke-width="2"></circle>`).join("")}
      ${points.map((point) => `<text x="${point.lx}" y="${point.ly}" fill="#f2efe3" font-size="12" font-family="'JetBrains Mono', monospace" text-anchor="middle">${escapeHtml(point.label)}</text>`).join("")}
    </svg>
  `;
}

function renderDonut(items) {
  const total = items.reduce((sum, item) => sum + (item.value || 0), 0) || 1;
  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const rings = items.map((item) => {
    const fraction = (item.value || 0) / total;
    const length = fraction * circumference;
    const ring = `<circle r="${radius}" cx="110" cy="110" fill="none" stroke="${item.color}" stroke-width="34" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 110 110)"></circle>`;
    offset += length;
    return ring;
  }).join("");
  return `
    <svg viewBox="0 0 260 260">
      <circle r="${radius}" cx="110" cy="110" fill="none" stroke="rgba(111, 152, 136, 0.14)" stroke-width="34"></circle>
      ${rings}
      <circle r="52" cx="110" cy="110" fill="#10231c"></circle>
      <text x="110" y="114" fill="#f2efe3" font-family="'JetBrains Mono', monospace" font-size="24" text-anchor="middle">${items.reduce((sum, item) => sum + (item.value || 0), 0)}</text>
      ${items.map((item, index) => `<text x="18" y="${228 + index * 18}" fill="${item.color}" font-family="'JetBrains Mono', monospace" font-size="11">${escapeHtml(item.label)}: ${item.value}</text>`).join("")}
    </svg>
  `;
}

function renderLineChart(points, color, maxValue, width = 520, height = 260) {
  const svgWidth = width;
  const svgHeight = height;
  const pad = { top: 28, right: 16, bottom: 42, left: 38 };
  const chartWidth = svgWidth - pad.left - pad.right;
  const chartHeight = svgHeight - pad.top - pad.bottom;
  const safeMax = maxValue || Math.max(...points.map((point) => point.value || 0), 1);
  const coords = points.map((point, index) => {
    const x = pad.left + (chartWidth * (points.length === 1 ? 0 : index / (points.length - 1)));
    const y = pad.top + chartHeight - (((point.value || 0) / safeMax) * chartHeight);
    return { ...point, x, y };
  });
  const path = coords.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const area = `${path} L ${coords[coords.length - 1].x} ${pad.top + chartHeight} L ${coords[0].x} ${pad.top + chartHeight} Z`;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((tick) => ({
    value: safeMax * tick,
    y: pad.top + chartHeight - (chartHeight * tick),
  }));
  return `
    <svg viewBox="0 0 ${svgWidth} ${svgHeight}">
      ${yTicks.map((tick) => `<line x1="${pad.left}" y1="${tick.y}" x2="${pad.left + chartWidth}" y2="${tick.y}" stroke="rgba(111, 152, 136, 0.14)" stroke-dasharray="4 4"></line>`).join("")}
      <path d="${area}" fill="${color}20"></path>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"></path>
      ${coords.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="4" fill="${color}"></circle>`).join("")}
      ${coords.map((point) => `<text x="${point.x}" y="${svgHeight - 10}" fill="#6f9888" font-family="'JetBrains Mono', monospace" font-size="11" text-anchor="middle">${escapeHtml(point.label)}</text>`).join("")}
    </svg>
  `;
}

function renderCoords() {
  el.rankLabels.innerHTML = ranks.map((r) => `<span>${r}</span>`).join("");
  el.fileLabels.innerHTML = files.map((f) => `<span>${f}</span>`).join("");
}

function renderBoard(fen) {
  state.boardFen = fen || state.boardFen;
  const squares = parseFenBoard(fen);
  el.board.innerHTML = "";
  squares.forEach((piece, index) => {
    const square = document.createElement("div");
    const file = index % 8;
    const rank = Math.floor(index / 8);
    const squareName = `${files[file]}${8 - rank}`;
    square.className = `square ${(file + rank) % 2 === 0 ? "light" : "dark"} selectable`;
    square.dataset.square = squareName;
    if (state.selectedSquare === squareName) square.classList.add("selected");
    if (state.lastMove?.from === squareName) square.classList.add("last-from");
    if (state.lastMove?.to === squareName) square.classList.add("last-to");
    const legalTargets = state.selectedSquare ? (state.legalByFrom[state.selectedSquare] || []) : [];
    const targetMove = legalTargets.find((item) => item.to === squareName);
    if (targetMove) {
      square.classList.add(targetMove.capture ? "legal-capture" : "legal-target");
      const dot = document.createElement("div");
      dot.className = "move-dot";
      square.appendChild(dot);
    }
    square.addEventListener("click", () => handleSquareClick(squareName));
    square.addEventListener("dragover", (event) => {
      if (!state.dragFrom) return;
      const moves = state.legalByFrom[state.dragFrom] || [];
      if (moves.some((move) => move.to === squareName)) event.preventDefault();
    });
    square.addEventListener("drop", async (event) => {
      event.preventDefault();
      if (!state.dragFrom) return;
      await submitCoachMove(state.dragFrom, squareName);
      state.dragFrom = "";
    });
    if (piece) {
      const img = document.createElement("img");
      img.className = "piece";
      img.src = PIECE_ASSETS[piece];
      img.alt = piece;
      img.draggable = isDraggablePiece(piece, squareName);
      img.addEventListener("dragstart", () => {
        state.dragFrom = squareName;
      });
      square.appendChild(img);
    }
    el.board.appendChild(square);
  });
}

function loadBoardPreview(fen, title, summary, lineText) {
  state.selectedSquare = "";
  state.lastMove = null;
  renderBoard(fen);
  refreshLegalMoves(fen);
  el.boardTitle.textContent = title;
  el.boardSummary.textContent = summary;
  el.boardLine.textContent = lineText;
  el.boardLine.classList.remove("empty");
}

function renderCoachList() {
  if (!state.coachItems.length) {
    el.coachList.className = "stack empty";
    el.coachList.textContent = "No coach drills yet.";
    return;
  }
  el.coachList.className = "stack";
  el.coachList.innerHTML = state.coachItems.map((item, index) => `
    <div class="item clickable coach-item ${index === state.coachIndex ? "active" : ""}" data-coach-index="${index}">
      <div class="item-title">${item.headline}</div>
      <div class="item-sub">${item.prompt}</div>
      <div class="coach-item-meta">${item.phase} - missed ${item.best_move} - ${((item.loss_cp || 0) / 100).toFixed(2)} pawns lost</div>
    </div>
  `).join("");
  el.coachList.querySelectorAll("[data-coach-index]").forEach((node) => {
    node.addEventListener("click", () => loadCoachDrill(Number(node.dataset.coachIndex)));
  });
}

async function loadCoachDrill(index) {
  const item = state.coachItems[index];
  if (!item) return;
  state.coachIndex = index;
  state.coachStartFen = item.position_fen;
  state.selectedSquare = "";
  state.lastMove = null;
  el.boardTitle.textContent = item.headline;
  el.boardSummary.textContent = item.why;
  el.coachPrompt.textContent = item.prompt;
  el.coachFeedback.textContent = `You originally played ${item.played_move}. Find the engine move instead.`;
  el.coachFeedback.classList.remove("empty");
  el.boardLine.textContent = item.line || "No reference line yet.";
  el.boardLine.classList.remove("empty");
  await refreshLegalMoves(item.position_fen);
  renderBoard(item.position_fen);
  renderCoachList();
}

async function refreshLegalMoves(fen = state.boardFen) {
  const response = await fetch("/api/legal-moves", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fen }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not load legal moves.");
  state.boardFen = payload.fen;
  state.legalMoves = payload.legal_moves || [];
  state.legalByFrom = groupLegalMoves(state.legalMoves);
  return payload;
}

function groupLegalMoves(moves) {
  return moves.reduce((acc, move) => {
    const entry = { ...move, capture: move.san.includes("x") };
    if (!acc[move.from]) acc[move.from] = [];
    acc[move.from].push(entry);
    return acc;
  }, {});
}

function isDraggablePiece(piece, square) {
  const turn = turnFromFen(state.boardFen);
  if ((turn === "white" && piece !== piece.toUpperCase()) || (turn === "black" && piece !== piece.toLowerCase())) {
    return false;
  }
  return !!(state.legalByFrom[square] || []).length;
}

function turnFromFen(fen) {
  const side = String(fen || "").split(" ")[1];
  return side === "b" ? "black" : "white";
}

function handleSquareClick(square) {
  const movesFromSquare = state.legalByFrom[square] || [];
  const selectedMoves = state.selectedSquare ? (state.legalByFrom[state.selectedSquare] || []) : [];
  if (state.selectedSquare && selectedMoves.some((move) => move.to === square)) {
    submitCoachMove(state.selectedSquare, square);
    return;
  }
  if (movesFromSquare.length) {
    state.selectedSquare = state.selectedSquare === square ? "" : square;
    renderBoard(state.boardFen);
    return;
  }
  state.selectedSquare = "";
  renderBoard(state.boardFen);
}

async function submitCoachMove(from, to) {
  const legal = (state.legalByFrom[from] || []).find((move) => move.to === to);
  if (!legal) return;
  setStatus(`Checking ${legal.san}...`);
  try {
    const response = await fetch("/api/coach-move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fen: state.boardFen,
        move_uci: legal.uci,
        engine_path: el.enginePath.value.trim(),
        depth: Number(el.depth.value),
        threads: Number(el.threads.value),
        hash_mb: Number(el.hash.value),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Coach move check failed.");

    if (!payload.correct) {
      state.selectedSquare = "";
      state.lastMove = null;
      el.coachFeedback.textContent = payload.message;
      el.coachFeedback.classList.remove("empty");
      el.boardLine.textContent = payload.best_line?.length
        ? `Best move: ${payload.best_move_san} | ${payload.best_line.join(" ")}`
        : `Best move: ${payload.best_move_san}`;
      el.boardLine.classList.remove("empty");
      setStatus("That wasn't the engine continuation.");
      renderBoard(state.boardFen);
      return;
    }

    state.selectedSquare = "";
    state.boardFen = payload.final_fen;
    state.lastMove = parseUciMove(payload.last_move_uci || legal.uci);
    state.legalMoves = payload.legal_moves || [];
    state.legalByFrom = groupLegalMoves(state.legalMoves);
    el.coachFeedback.textContent = payload.message;
    el.coachFeedback.classList.remove("empty");
    el.boardLine.textContent = payload.continuation?.length
      ? `${payload.played_move_san} ${payload.continuation.join(" ")}`
      : payload.played_move_san;
    el.boardLine.classList.remove("empty");
    renderBoard(state.boardFen);
    setStatus(payload.line_over ? "Correct. The line is complete." : "Correct. Bookup played the continuation.");
  } catch (error) {
    setStatus(error.message || "Coach move check failed.");
  }
}

function resetCoachDrill() {
  if (state.coachIndex < 0) return;
  loadCoachDrill(state.coachIndex);
}

function revealCoachDrill() {
  const item = state.coachItems[state.coachIndex];
  if (!item) return;
  el.coachFeedback.textContent = `Best move: ${item.best_move}. ${item.why}`;
  el.coachFeedback.classList.remove("empty");
  el.boardLine.textContent = item.line || item.best_move;
  el.boardLine.classList.remove("empty");
}

function nextCoachDrill() {
  if (!state.coachItems.length) return;
  const nextIndex = state.coachIndex < 0 ? 0 : (state.coachIndex + 1) % state.coachItems.length;
  loadCoachDrill(nextIndex);
}

function parseUciMove(uci) {
  const move = String(uci || "");
  return move.length >= 4 ? { from: move.slice(0, 2), to: move.slice(2, 4) } : null;
}

function parseFenBoard(fen) {
  const boardPart = (fen || "").split(" ")[0];
  if (!boardPart || boardPart === "startpos") {
    return parseFenBoard("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  }
  const out = [];
  boardPart.split("/").forEach((rank) => {
    rank.split("").forEach((char) => {
      if (/\d/.test(char)) {
        for (let i = 0; i < Number(char); i += 1) out.push("");
      } else {
        out.push(char);
      }
    });
  });
  return out;
}

function parseClockText(text) {
  if (!text) return 0;
  const [mins, secs] = String(text).replace("m", "").replace("s", "").split(/\s+/).filter(Boolean);
  if (String(text).includes("m")) {
    const match = String(text).match(/(\d+)m\s+(\d+)s/);
    if (match) return Number(match[1]) * 60 + Number(match[2]);
  }
  return Number(mins) || 0;
}

function accentClass(accent) {
  if (accent === "danger") return "accent-danger";
  if (accent === "blue") return "accent-blue";
  if (accent === "gold") return "accent-gold";
  return "accent-good";
}

function formatHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(message) {
  el.status.textContent = message;
}

init();
