const defaults = window.APP_DEFAULTS || {};
const REVIEW_KEY = "bookup-review-stats-v1";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
let audioContext = null;
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
const REVIEW_INTERVALS = [0, 1, 3, 7, 14];

const el = {
  username: document.getElementById("usernameInput"),
  timeClasses: document.getElementById("timeClassesInput"),
  maxGames: document.getElementById("maxGamesInput"),
  importAllGames: document.getElementById("importAllGamesInput"),
  lichessToken: document.getElementById("lichessTokenInput"),
  enginePath: document.getElementById("enginePathInput"),
  depth: document.getElementById("depthInput"),
  multiPv: document.getElementById("multiPvInput"),
  threads: document.getElementById("threadsInput"),
  hash: document.getElementById("hashInput"),
  analyze: document.getElementById("analyzeBtn"),
  status: document.getElementById("status"),
  heroTitle: document.getElementById("heroTitle"),
  heroSummary: document.getElementById("heroSummary"),
  summaryFamilies: document.getElementById("summaryFamilies"),
  summaryUrgent: document.getElementById("summaryUrgent"),
  summaryQueue: document.getElementById("summaryQueue"),
  badgeGames: document.getElementById("badgeGames"),
  badgeKnown: document.getElementById("badgeKnown"),
  badgeWinRate: document.getElementById("badgeWinRate"),
  firstMoveWhite: document.getElementById("firstMoveWhite"),
  firstMoveBlack: document.getElementById("firstMoveBlack"),
  openingListWhite: document.getElementById("openingListWhite"),
  openingListBlack: document.getElementById("openingListBlack"),
  repertoireTree: document.getElementById("repertoireTree"),
  urgentList: document.getElementById("urgentList"),
  sidelineList: document.getElementById("sidelineList"),
  suggestionList: document.getElementById("suggestionList"),
  mistakeList: document.getElementById("mistakeList"),
  lessonList: document.getElementById("lessonList"),
  lessonQueueMeta: document.getElementById("lessonQueueMeta"),
  boardWrap: document.querySelector(".board-wrap"),
  board: document.getElementById("board"),
  rankLabels: document.getElementById("rankLabels"),
  fileLabels: document.getElementById("fileLabels"),
  boardTitle: document.getElementById("boardTitle"),
  boardSummary: document.getElementById("boardSummary"),
  boardLine: document.getElementById("boardLine"),
  trainerFeedback: document.getElementById("trainerFeedback"),
  trainerReset: document.getElementById("trainerResetBtn"),
  trainerNext: document.getElementById("trainerNextBtn"),
  tabButtons: Array.from(document.querySelectorAll("[data-tab-target]")),
  tabPanels: Array.from(document.querySelectorAll("[data-tab-panel]")),
};

const state = {
  payload: null,
  lessons: [],
  queue: [],
  lessonIndex: -1,
  activeLessonId: "",
  boardOrientation: "white",
  trainingCursor: 0,
  lessonMistakes: 0,
  boardFen: START_FEN,
  startFen: START_FEN,
  legalMoves: [],
  legalByFrom: {},
  selectedSquare: "",
  dragFrom: "",
  lastMove: null,
  previousRenderedPieces: {},
  reviewStats: {},
  games: [],
};

async function init() {
  el.username.value = defaults.username || "trixize1234";
  el.timeClasses.value = defaults.time_classes || "all";
  el.maxGames.value = defaults.max_games ?? 0;
  el.importAllGames.checked = Number(defaults.max_games ?? 0) === 0;
  el.lichessToken.value = defaults.lichess_token || "";
  el.enginePath.value = defaults.engine_path || "";
  el.depth.value = defaults.depth || 16;
  el.multiPv.value = defaults.multipv || 5;
  el.threads.value = defaults.threads || 8;
  el.hash.value = defaults.hash_mb || 2048;

  el.analyze.addEventListener("click", runAnalysis);
  el.importAllGames?.addEventListener("change", syncImportScope);
  el.trainerReset?.addEventListener("click", resetTrainerLesson);
  el.trainerNext?.addEventListener("click", nextLesson);
  el.tabButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tabTarget || "setup"));
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const lessonId = target.dataset.lessonLaunch;
    if (lessonId) {
      launchLessonById(lessonId);
    }
  });
  document.addEventListener("pointerdown", unlockAudio);
  document.addEventListener("pointerup", handleGlobalPointerUp);
  document.addEventListener("pointercancel", clearDragState);

  syncImportScope();
  renderCoords();
  renderBoard(START_FEN);
  setActiveTab("setup");
  await bootstrapLocalState();
}

function normalizeFen(fen) {
  return String(fen || "").trim() || START_FEN;
}

function pieceMapFromFen(fen) {
  const boardPart = normalizeFen(fen).split(" ")[0] || "";
  const rows = boardPart.split("/");
  const map = {};
  rows.forEach((row, rowIndex) => {
    let fileIndex = 0;
    row.split("").forEach((char) => {
      if (/\d/.test(char)) {
        fileIndex += Number(char);
        return;
      }
      const square = `${files[fileIndex]}${8 - rowIndex}`;
      map[square] = char;
      fileIndex += 1;
    });
  });
  return map;
}

function rebuildLegalByFrom() {
  state.legalByFrom = {};
  state.legalMoves.forEach((move) => {
    if (!state.legalByFrom[move.from]) state.legalByFrom[move.from] = [];
    state.legalByFrom[move.from].push(move);
  });
}

function applyBoardState(payload) {
  state.boardFen = normalizeFen(payload?.fen || state.boardFen);
  state.legalMoves = Array.isArray(payload?.legal_moves) ? payload.legal_moves : [];
  rebuildLegalByFrom();
  state.lastMove = payload?.last_move || null;
  if (state.selectedSquare && !(state.legalByFrom[state.selectedSquare] || []).length) {
    state.selectedSquare = "";
  }
}

function unlockAudio() {
  if (!window.AudioContext && !window.webkitAudioContext) return;
  if (!audioContext) {
    const Context = window.AudioContext || window.webkitAudioContext;
    audioContext = new Context();
  }
  if (audioContext?.state === "suspended") {
    void audioContext.resume();
  }
}

function playTone({ frequency = 440, duration = 0.08, type = "sine", volume = 0.05, frequencyEnd = null }) {
  unlockAudio();
  if (!audioContext || audioContext.state !== "running") return;
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  if (frequencyEnd && frequencyEnd !== frequency) {
    oscillator.frequency.exponentialRampToValueAtTime(frequencyEnd, now + duration);
  }
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + duration + 0.02);
}

function playMoveSound(san, options = {}) {
  if (options.error) {
    playTone({ frequency: 220, frequencyEnd: 140, duration: 0.12, type: "sawtooth", volume: 0.045 });
    return;
  }
  if (options.complete) {
    playTone({ frequency: 520, frequencyEnd: 780, duration: 0.16, type: "triangle", volume: 0.05 });
    window.setTimeout(() => playTone({ frequency: 660, frequencyEnd: 990, duration: 0.14, type: "triangle", volume: 0.04 }), 70);
    return;
  }
  const notation = String(san || "");
  if (!notation) {
    playTone({ frequency: 420, frequencyEnd: 470, duration: 0.08, type: "triangle", volume: 0.03 });
    return;
  }
  if (notation.includes("#") || notation.includes("+")) {
    playTone({ frequency: 660, frequencyEnd: 900, duration: 0.12, type: "triangle", volume: 0.05 });
    return;
  }
  if (notation.startsWith("O-O")) {
    playTone({ frequency: 360, frequencyEnd: 560, duration: 0.1, type: "triangle", volume: 0.04 });
    return;
  }
  if (notation.includes("x")) {
    playTone({ frequency: 300, frequencyEnd: 220, duration: 0.1, type: "square", volume: 0.04 });
    return;
  }
  playTone({ frequency: 480, frequencyEnd: 520, duration: 0.07, type: "sine", volume: 0.025 });
}

function animateLastMove(previousPieces) {
  if (!state.lastMove || !el.boardWrap) return;
  const { from, to } = state.lastMove;
  const movedPiece = previousPieces[from];
  if (!movedPiece) return;
  const boardRect = el.boardWrap.getBoundingClientRect();
  const fromSquare = el.board.querySelector(`[data-square="${from}"]`);
  const toSquare = el.board.querySelector(`[data-square="${to}"]`);
  if (!(fromSquare instanceof HTMLElement) || !(toSquare instanceof HTMLElement)) return;
  const fromRect = fromSquare.getBoundingClientRect();
  const toRect = toSquare.getBoundingClientRect();
  const ghost = document.createElement("img");
  ghost.className = "piece-ghost";
  ghost.src = PIECE_ASSETS[movedPiece] || "";
  ghost.alt = movedPiece;
  ghost.style.left = `${fromRect.left - boardRect.left}px`;
  ghost.style.top = `${fromRect.top - boardRect.top}px`;
  ghost.style.width = `${fromRect.width}px`;
  ghost.style.height = `${fromRect.height}px`;
  el.boardWrap.appendChild(ghost);

  const arrivingPiece = toSquare.querySelector(".piece");
  if (arrivingPiece instanceof HTMLElement) {
    arrivingPiece.classList.add("piece-arriving");
  }

  requestAnimationFrame(() => {
    ghost.style.transform = `translate(${toRect.left - fromRect.left}px, ${toRect.top - fromRect.top}px)`;
    ghost.style.opacity = "0";
    if (arrivingPiece instanceof HTMLElement) {
      arrivingPiece.classList.remove("piece-arriving");
    }
  });

  window.setTimeout(() => {
    ghost.remove();
  }, 220);
}

function clearDragState() {
  if (!state.dragFrom) return;
  state.dragFrom = "";
}

function syncImportScope() {
  if (!el.importAllGames || !el.maxGames) return;
  if (el.importAllGames.checked) {
    el.maxGames.value = 0;
    el.maxGames.setAttribute("disabled", "disabled");
  } else {
    el.maxGames.removeAttribute("disabled");
    if (Number(el.maxGames.value) === 0) el.maxGames.value = 200;
  }
}

function setStatus(message) {
  el.status.textContent = message;
}

function setActiveTab(name) {
  el.tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tabTarget === name);
  });
  el.tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tabPanel === name);
  });
}

async function runAnalysis() {
  setStatus("Importing games and building your repertoire tree...");
  el.analyze.disabled = true;
  try {
    const payload = await fetchProfilePayload(el.username.value.trim());
    state.payload = payload;
    state.reviewStats = payload.training_progress || loadReviewStats(payload.username);
    state.games = payload.games || [];
    renderProfile(payload);
    setStatus(
      payload.explorer_enabled
        ? `Imported ${payload.games_imported} games. Lichess database is active.`
        : `Imported ${payload.games_imported} games. Add a Lichess token for richer database branching.`
    );
  } catch (error) {
    setStatus(error.message || "Bookup could not build your repertoire.");
  } finally {
    el.analyze.disabled = false;
  }
}

async function fetchProfilePayload(username) {
  const response = await fetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      time_classes: el.timeClasses.value.trim(),
      max_games: el.importAllGames?.checked ? 0 : Number(el.maxGames.value),
      lichess_token: el.lichessToken.value.trim(),
      engine_path: el.enginePath.value.trim(),
      depth: Number(el.depth.value),
      multipv: Number(el.multiPv.value),
      threads: Number(el.threads.value),
      hash_mb: Number(el.hash.value),
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Bookup could not build your repertoire.");
  return payload;
}

async function bootstrapLocalState() {
  try {
    const username = el.username.value.trim() || "trixize1234";
    const response = await fetch(`/api/local-state?username=${encodeURIComponent(username)}`);
    const payload = await response.json();
    if (!response.ok) return;
    if (payload.profile) {
      state.payload = {
        username: payload.username,
        profile: payload.profile,
        games_imported: payload.games_imported || 0,
        archives_found: payload.archives_found || 0,
      };
      state.reviewStats = payload.training_progress || {};
      state.games = payload.games || [];
      renderProfile(state.payload);
      setStatus(
        payload.saved_at
          ? `Loaded your saved Bookup workspace for ${payload.username}.`
          : `Loaded local Bookup data for ${payload.username}.`
      );
    } else {
      state.reviewStats = loadReviewStats(username);
    }
  } catch {
    state.reviewStats = loadReviewStats(el.username.value.trim() || "trixize1234");
  }
}

function renderProfile(payload) {
  const profile = payload.profile || {};
  const summary = profile.summary || {};
  state.lessons = profile.trainer_queue || [];
  rebuildQueue();

  el.heroTitle.textContent = `${payload.username} repertoire ready`;
  el.heroSummary.textContent = summary.prep_summary || "Your repertoire tree is ready to train.";
  el.summaryFamilies.textContent = String(summary.families ?? "--");
  el.summaryUrgent.textContent = String(summary.urgent_lines ?? "--");
  el.summaryQueue.textContent = String(summary.trainable_positions ?? "--");
  el.badgeGames.textContent = String(payload.games_imported ?? "--");
  el.badgeKnown.textContent = String(summary.known_lines ?? "--");
  el.badgeWinRate.textContent = typeof summary.win_rate === "number" ? `${summary.win_rate}%` : "--";

  renderFirstMoves(profile.first_move_repertoire || {});
  renderOpeningFamilies(profile.top_openings_by_color || {});
  renderRepertoireTree(profile.repertoire_tree || []);
  renderImproveList(el.urgentList, profile.urgent_lines || [], "No urgent lines right now.");
  renderImproveList(el.sidelineList, profile.sidelines || [], "No rare sidelines right now.");
  renderSuggestions(profile.repertoire_updates || []);
  renderMistakes(profile.opening_mistakes || []);
  renderQueue();

  if (state.queue.length) {
    loadLesson(0);
  } else {
    clearTrainer();
  }
  setActiveTab("my-repertoire");
}

function renderFirstMoves(data) {
  renderFirstMoveColumn(el.firstMoveWhite, data.white || {});
  renderFirstMoveColumn(el.firstMoveBlack, data.black || {});
}

function renderFirstMoveColumn(node, repertoire) {
  const items = repertoire.items || [];
  if (!items.length) {
    node.className = "stack empty";
    node.textContent = "No first-move data yet.";
    return;
  }
  node.className = "stack";
  node.innerHTML = items
    .map((item, index) => `
      <article class="line-card">
        <div class="line-card-header">
          <div class="line-title">${index + 1}. ${escapeHtml(item.move)}</div>
          <div class="line-badge">${item.pct}% · ${item.count}x</div>
        </div>
        <div class="line-note">This move starts ${item.count} of your imported games on this side.</div>
      </article>
    `)
    .join("");
}

function renderOpeningFamilies(byColor) {
  renderOpeningFamilyColumn(el.openingListWhite, byColor.white || [], "No white opening families yet.");
  renderOpeningFamilyColumn(el.openingListBlack, byColor.black || [], "No black opening families yet.");
}

function renderOpeningFamilyColumn(node, items, emptyText) {
  if (!items.length) {
    node.className = "stack empty";
    node.textContent = emptyText;
    return;
  }
  node.className = "stack";
  node.innerHTML = items
    .map((item, index) => `
      <article class="opening-family-card">
        <div class="opening-family-header">
          <div>
            <div class="opening-family-title">${index + 1}. ${escapeHtml(item.opening)}</div>
            <div class="tree-meta">${escapeHtml(item.opening_code || "")}</div>
          </div>
          <div class="line-badge">${item.count} positions</div>
        </div>
        <div class="line-note">${item.trainable_count} trainable lines · ${item.known_count} known lines</div>
        ${item.position_identifier ? `<div class="line-note"><a href="${item.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.position_identifier_label || "Lichess analysis")}</a></div>` : ""}
      </article>
    `)
    .join("");
}

function renderRepertoireTree(groups) {
  if (!groups.length) {
    el.repertoireTree.className = "stack empty";
    el.repertoireTree.textContent = "Your repertoire tree will show up here.";
    return;
  }
  el.repertoireTree.className = "stack";
  el.repertoireTree.innerHTML = groups
    .map((group) => `
      <article class="card">
        <div class="opening-family-header">
          <div>
            <div class="opening-family-title">${escapeHtml(group.opening_name)}</div>
            <div class="tree-meta">${escapeHtml(group.color)} repertoire${group.opening_code ? ` · ${escapeHtml(group.opening_code)}` : ""}</div>
          </div>
          <div class="line-badge">${group.total_frequency}x</div>
        </div>
        <div class="tree-node-list">
          ${(group.nodes || []).map(renderTreeNode).join("")}
        </div>
      </article>
    `)
    .join("");
}

function renderTreeNode(node) {
  const replies = (node.common_replies || [])
    .map((reply) => `${escapeHtml(reply.san)} ${reply.popularity}%`)
    .join(" · ");
  const moveFreq = (node.player_move_frequency || [])
    .map((move) => `${escapeHtml(move.san)} ${move.count}x`)
    .join(" · ");
  const candidatePreview = (node.candidate_lines || [])
    .slice(0, 5)
    .map((line) => `${escapeHtml(line.move)} (${formatCp(line.score_cp)})`)
    .join(" · ");
  return `
    <div class="tree-node">
      <div class="line-card-header">
        <div>
          <div class="line-title">After ${escapeHtml(node.trigger_move)}, play ${escapeHtml(node.best_reply)}</div>
          <div class="tree-meta">${escapeHtml(node.position_fen)}</div>
        </div>
        <div class="line-badge ${statusClass(node.line_status)}">${labelForStatus(node.line_status)}</div>
      </div>
      <div class="chip-row">
        <span class="lesson-chip">Frequency ${node.frequency}</span>
        <span class="lesson-chip">Importance ${node.importance}</span>
        <span class="lesson-chip">Confidence ${node.confidence}</span>
        <span class="lesson-chip">Best move played ${node.repeat_count}x</span>
      </div>
      <div class="line-note">Your current moves: ${moveFreq || "No move frequency yet."}</div>
      <div class="line-note">Common opponent replies: ${replies || "No Lichess reply data available."}</div>
      <div class="line-note">Top engine lines: ${candidatePreview || "No candidate lines available."}</div>
      <div class="line-preview">${escapeHtml(node.continuation_san)}</div>
      <div class="line-note">${escapeHtml(node.explanation)}</div>
      <div class="chip-row">
        <button class="launch-btn" type="button" data-lesson-launch="${escapeHtml(node.lesson_id)}">Train this line</button>
        ${node.position_identifier ? `<a class="launch-btn" href="${node.position_identifier}" target="_blank" rel="noopener noreferrer">Lichess analysis</a>` : ""}
      </div>
    </div>
  `;
}

function renderImproveList(node, items, emptyText) {
  if (!items.length) {
    node.className = "stack empty";
    node.textContent = emptyText;
    return;
  }
  node.className = "stack";
  node.innerHTML = items
    .map((item) => {
      const candidatePreview = (item.candidate_lines || [])
        .slice(0, 5)
        .map((line) => `${escapeHtml(line.move)} (${formatCp(line.score_cp)})`)
        .join(" · ");
      return `
      <article class="line-card">
        <div class="line-card-header">
          <div>
            <div class="line-title">${escapeHtml(item.opening_name)}</div>
            <div class="tree-meta">After ${escapeHtml(item.trigger_move)}</div>
          </div>
          <div class="line-badge ${statusClass(item.line_status)}">${labelForStatus(item.line_status)}</div>
        </div>
        <div class="line-note">Best continuation: <strong>${escapeHtml(item.best_reply)}</strong></div>
        <div class="line-note">Top engine lines: ${candidatePreview || "No candidate lines available."}</div>
        <div class="chip-row">
          <span class="lesson-chip">Frequency ${item.frequency}</span>
          <span class="lesson-chip">Priority ${Math.round(item.priority)}</span>
          <span class="lesson-chip">Value lost ${formatCp(item.value_lost_cp)}</span>
        </div>
        <div class="line-preview">${escapeHtml(item.continuation_san)}</div>
        <div class="line-note">${escapeHtml(item.explanation)}</div>
        <div class="chip-row">
          <button class="launch-btn" type="button" data-lesson-launch="${escapeHtml(item.lesson_id)}">Train this line</button>
          ${item.position_identifier ? `<a class="launch-btn" href="${item.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.position_identifier_label || "Lichess analysis")}</a>` : ""}
        </div>
      </article>
    `;
    })
    .join("");
}

function renderSuggestions(items) {
  if (!items.length) {
    el.suggestionList.className = "stack empty";
    el.suggestionList.textContent = "No repertoire updates yet.";
    return;
  }
  el.suggestionList.className = "stack";
  el.suggestionList.innerHTML = items
    .map((item) => `
      <article class="suggestion-card">
        <div class="line-title">${escapeHtml(item.title)}</div>
        <div class="line-note">${escapeHtml(item.detail)}</div>
        ${item.line ? `<div class="line-preview">${escapeHtml(item.line)}</div>` : ""}
        <div class="chip-row">
          ${item.lesson_id ? `<button class="launch-btn" type="button" data-lesson-launch="${escapeHtml(item.lesson_id)}">Train this line</button>` : ""}
          ${item.position_identifier ? `<a class="launch-btn" href="${item.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.position_identifier_label || "Lichess analysis")}</a>` : ""}
        </div>
      </article>
    `)
    .join("");
}

function renderMistakes(items) {
  if (!items.length) {
    el.mistakeList.className = "stack empty";
    el.mistakeList.textContent = "No opening mistakes to review right now.";
    return;
  }
  el.mistakeList.className = "stack";
  el.mistakeList.innerHTML = items
    .map((item, index) => `
      <article class="mistake-card">
        <div class="mistake-header">
          <div>
            <div class="mistake-title">${index + 1}. ${escapeHtml(item.opening_name)}</div>
            <div class="tree-meta">After ${escapeHtml(item.trigger_move)}</div>
          </div>
          <div class="line-badge needs-work">${formatCp(item.value_lost_cp)}</div>
        </div>
        <div class="mistake-copy">You usually play <strong>${escapeHtml(item.played)}</strong>, but the best continuation is <strong>${escapeHtml(item.best_move)}</strong>.</div>
        <div class="line-note">${escapeHtml(item.explanation)}</div>
        <div class="line-preview">${escapeHtml(item.continuation_san || "")}</div>
        <div class="chip-row">
          <button class="launch-btn" type="button" data-lesson-launch="${escapeHtml(item.lesson_id)}">Train this position</button>
          ${item.position_identifier ? `<a class="launch-btn" href="${item.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.position_identifier_label || "Lichess analysis")}</a>` : ""}
        </div>
      </article>
    `)
    .join("");
}

function rebuildQueue() {
  state.queue = (state.lessons || [])
    .map((lesson) => {
      const review = state.reviewStats[lesson.lesson_id] || defaultReviewState();
      const due = review.due_at || 0;
      const overdue = due <= Date.now();
      const score = (overdue ? 1000 : 0) + lesson.priority - (review.streak || 0) * 10 + (review.last_result === "wrong" ? 120 : 0);
      return { ...lesson, review, dueSoon: overdue, queueScore: score };
    })
    .sort((a, b) => b.queueScore - a.queueScore);
}

function renderQueue() {
  if (!state.queue.length) {
    el.lessonQueueMeta.textContent = "No repeated misses due right now.";
    el.lessonList.className = "stack empty";
    el.lessonList.textContent = "Bookup only queues repeated repertoire misses here. Import more games or launch a line from My Repertoire.";
    return;
  }
  const dueNow = state.queue.filter((item) => item.dueSoon).length;
  el.lessonQueueMeta.textContent = `${dueNow} due now · ${state.queue.length} total lines in the queue`;
  el.lessonList.className = "stack";
  el.lessonList.innerHTML = state.queue
    .map((lesson, index) => `
      <button class="queue-card ${lesson.lesson_id === currentLessonId() ? "active" : ""}" type="button" data-lesson-launch="${escapeHtml(lesson.lesson_id)}">
        <div class="queue-card-header">
          <div>
            <div class="queue-title">${escapeHtml(lesson.opening_name)}</div>
            <div class="tree-meta">After ${escapeHtml(lesson.trigger_move)} → ${escapeHtml(lesson.best_reply)}</div>
          </div>
          <div class="line-badge ${statusClass(lesson.line_status)}">${index === 0 ? "Next" : labelForStatus(lesson.line_status)}</div>
        </div>
        <div class="chip-row">
          <span class="lesson-chip">Priority ${Math.round(lesson.priority)}</span>
          <span class="lesson-chip">Frequency ${lesson.frequency}</span>
          <span class="lesson-chip">Streak ${lesson.review.streak || 0}</span>
        </div>
      </button>
    `)
    .join("");
}

function currentLessonId() {
  return state.activeLessonId || "";
}

function launchLessonById(lessonId) {
  const index = state.queue.findIndex((item) => item.lesson_id === lessonId);
  if (index >= 0) loadLesson(index);
}

function lessonTrainingLine(lesson) {
  return Array.isArray(lesson?.training_line_uci) ? lesson.training_line_uci.filter(Boolean) : [];
}

function currentLesson() {
  return state.queue.find((item) => item.lesson_id === state.activeLessonId) || null;
}

function trainerUserTurn(lesson, cursor = state.trainingCursor) {
  return (cursor % 2 === 0 && lesson?.color === "white") || (cursor % 2 === 1 && lesson?.color === "black");
}

function expectedMoveAtCursor(lesson, cursor = state.trainingCursor) {
  return lessonTrainingLine(lesson)[cursor] || "";
}

function updateTrainerCopy() {
  const lesson = currentLesson();
  if (!lesson) return;
  const line = lessonTrainingLine(lesson);
  const expectedUci = expectedMoveAtCursor(lesson);
  const expectedEntry = (state.legalMoves || []).find((move) => move.uci === expectedUci);
  const progress = `${Math.min(state.trainingCursor, line.length)}/${line.length}`;
  const openingLabel = lesson.opening_code ? `${lesson.opening_name} · ${lesson.opening_code}` : lesson.opening_name;
  el.boardTitle.textContent = openingLabel;
  if (state.trainingCursor >= line.length) {
    el.boardSummary.textContent = "Line complete. Reset it or move on to the next due line.";
    el.boardLine.textContent = lesson.training_line_san || lesson.continuation_san || "No line loaded yet.";
    el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
    return;
  }
  if (trainerUserTurn(lesson)) {
    const targetText = expectedEntry?.san || lesson.best_reply;
    el.boardSummary.textContent = `Play the repertoire move here: ${targetText}. Step ${progress}.`;
  } else {
    el.boardSummary.textContent = `Bookup is playing the line for the other side. Step ${progress}.`;
  }
  el.boardLine.textContent = lesson.training_line_san || lesson.continuation_san || "No line loaded yet.";
  el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
}

async function applyMoveToBoard(moveUci) {
  const response = await fetch("/api/apply-move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fen: state.boardFen, move_uci: moveUci }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not apply move.");
  playMoveSound(payload.played_san);
  applyBoardState(payload);
  renderBoard(state.boardFen);
  return payload;
}

async function syncTrainerToPlayableTurn() {
  const lesson = currentLesson();
  if (!lesson) return;
  const line = lessonTrainingLine(lesson);
  while (state.trainingCursor < line.length && !trainerUserTurn(lesson)) {
    const expectedUci = line[state.trainingCursor];
    await applyMoveToBoard(expectedUci);
    state.trainingCursor += 1;
  }
  updateTrainerCopy();
}

async function loadLesson(index) {
  const lesson = state.queue[index];
  if (!lesson) return;
  state.lessonIndex = index;
  state.activeLessonId = lesson.lesson_id;
  state.boardOrientation = lesson.color === "black" ? "black" : "white";
  state.startFen = normalizeFen(lesson.line_start_fen);
  state.boardFen = state.startFen;
  state.trainingCursor = 0;
  state.lessonMistakes = 0;
  state.selectedSquare = "";
  state.dragFrom = "";
  state.lastMove = null;
  el.trainerFeedback.textContent = lesson.line_status === "known"
    ? "You already know this line. Bookup will still run it from the beginning as maintenance."
    : "Bookup is starting from the beginning of the line. Play your side's move whenever it is your turn.";
  el.trainerFeedback.classList.remove("empty");

  await refreshLegalMoves(state.boardFen);
  renderCoords();
  renderBoard(state.boardFen);
  await syncTrainerToPlayableTurn();
  renderQueue();
  setActiveTab("trainer");
}

function nextLesson() {
  if (!state.queue.length) return;
  const currentIndex = state.queue.findIndex((item) => item.lesson_id === state.activeLessonId);
  const next = currentIndex < 0 ? 0 : (currentIndex + 1) % state.queue.length;
  loadLesson(next);
}

function resetTrainerLesson() {
  const index = state.queue.findIndex((item) => item.lesson_id === state.activeLessonId);
  if (index < 0) return;
  loadLesson(index);
}

function clearTrainer() {
  el.boardTitle.textContent = "No lesson loaded";
  el.boardSummary.textContent = "Build your repertoire, then train the next due line from your queue.";
  el.boardLine.textContent = "No line loaded yet.";
  el.boardLine.classList.add("empty");
  el.trainerFeedback.textContent = "Choose a due line from the queue or launch one from a repertoire card.";
  el.trainerFeedback.classList.remove("empty");
  state.lessonIndex = -1;
  state.boardFen = START_FEN;
  state.activeLessonId = "";
  state.boardOrientation = "white";
  state.startFen = START_FEN;
  state.trainingCursor = 0;
  state.lessonMistakes = 0;
  state.legalMoves = [];
  state.legalByFrom = {};
  state.selectedSquare = "";
  state.dragFrom = "";
  state.lastMove = null;
  state.previousRenderedPieces = {};
  renderCoords();
  renderBoard(START_FEN);
}

async function refreshLegalMoves(fen = state.boardFen) {
  const response = await fetch("/api/legal-moves", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fen: normalizeFen(fen) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not load legal moves.");
  applyBoardState(payload);
}

function renderCoords() {
  const rankOrder = state.boardOrientation === "black" ? [...ranks].reverse() : ranks;
  const fileOrder = state.boardOrientation === "black" ? [...files].reverse() : files;
  el.rankLabels.innerHTML = rankOrder.map((rank) => `<span>${rank}</span>`).join("");
  el.fileLabels.innerHTML = fileOrder.map((file) => `<span>${file}</span>`).join("");
}

function renderBoard(fen) {
  state.boardFen = fen || state.boardFen;
  const previousPieces = state.previousRenderedPieces || {};
  const squares = parseFenBoard(state.boardFen);
  const displayFiles = state.boardOrientation === "black" ? [...files].reverse() : files;
  const displayRanks = state.boardOrientation === "black" ? [...ranks].reverse() : ranks;
  el.board.innerHTML = "";
  displayRanks.forEach((rankLabel, rowIndex) => {
    displayFiles.forEach((fileLabel, colIndex) => {
    const file = files.indexOf(fileLabel);
    const rank = 8 - Number(rankLabel);
    const squareName = `${fileLabel}${rankLabel}`;
    const piece = squares[(rank * 8) + file];
    const square = document.createElement("div");
    square.className = `square ${(rowIndex + colIndex) % 2 === 0 ? "light" : "dark"} selectable`;
    square.dataset.square = squareName;
    if (state.selectedSquare === squareName) square.classList.add("selected");
    if (state.lastMove?.from === squareName) square.classList.add("last-from");
    if (state.lastMove?.to === squareName) square.classList.add("last-to");

    const legalTargets = state.selectedSquare ? state.legalByFrom[state.selectedSquare] || [] : [];
    const targetMove = legalTargets.find((item) => item.to === squareName);
    if (targetMove) {
      square.classList.add(targetMove.capture ? "legal-capture" : "legal-target");
      const dot = document.createElement("div");
      dot.className = "move-dot";
      square.appendChild(dot);
    }

    square.addEventListener("click", () => handleSquareClick(squareName));
    square.addEventListener("pointerdown", (event) => {
      if (!piece || pieceSide(piece) !== sideToMove(state.boardFen)) return;
      event.preventDefault();
      state.dragFrom = squareName;
      state.selectedSquare = squareName;
    });
    if (piece) {
      const img = document.createElement("img");
      img.className = "piece";
      img.src = PIECE_ASSETS[piece];
      img.alt = piece;
      img.addEventListener("pointerdown", (event) => {
        if (pieceSide(piece) !== sideToMove(state.boardFen)) return;
        event.preventDefault();
        state.dragFrom = squareName;
        state.selectedSquare = squareName;
      });
      square.appendChild(img);
    }
    el.board.appendChild(square);
    });
  });
  animateLastMove(previousPieces);
  state.previousRenderedPieces = pieceMapFromFen(state.boardFen);
}

async function handleGlobalPointerUp(event) {
  if (!state.dragFrom) return;
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const square = target instanceof Element ? target.closest(".square") : null;
  const from = state.dragFrom;
  state.dragFrom = "";
  if (!(square instanceof HTMLElement)) {
    renderBoard(state.boardFen);
    return;
  }
  const to = square.dataset.square || "";
  if (!to) {
    renderBoard(state.boardFen);
    return;
  }
  await submitTrainerMove(from, to);
}

function handleSquareClick(squareName) {
  if (state.lessonIndex < 0) return;
  if (!state.selectedSquare) {
    if ((state.legalByFrom[squareName] || []).length) {
      state.selectedSquare = squareName;
      renderBoard(state.boardFen);
    }
    return;
  }
  if (state.selectedSquare === squareName) {
    state.selectedSquare = "";
    renderBoard(state.boardFen);
    return;
  }
  submitTrainerMove(state.selectedSquare, squareName);
}

async function submitTrainerMove(from, to) {
  const move = (state.legalByFrom[from] || []).find((item) => item.to === to);
  state.selectedSquare = "";
  renderBoard(state.boardFen);
  if (!move) return;

  const lesson = currentLesson();
  if (!lesson) return;
  const expectedUci = expectedMoveAtCursor(lesson);
  const expectedEntry = (state.legalMoves || []).find((item) => item.uci === expectedUci);
  if (!expectedUci) return;

  if (move.uci !== expectedUci) {
    state.lessonMistakes += 1;
    recordReview(lesson.lesson_id, false);
    playMoveSound("", { error: true });
    const expectedSan = expectedEntry?.san || lesson.best_reply;
    const explanation =
      state.trainingCursor === (lesson.target_ply_index || 0)
        ? lesson.explanation
        : `To stay inside this repertoire line, Bookup wants ${expectedSan} here before moving on.`;
    el.trainerFeedback.textContent = `${move.san} misses the line here. ${explanation} Best move: ${expectedSan}.`;
    el.trainerFeedback.classList.remove("empty");
    el.boardLine.textContent = lesson.training_line_san || lesson.continuation_san || "";
    el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
    state.lastMove = null;
    await applyMoveToBoard(expectedUci);
    state.trainingCursor += 1;
    await syncTrainerToPlayableTurn();
    rebuildQueue();
    renderQueue();
    return;
  }

  await applyMoveToBoard(move.uci);
  state.trainingCursor += 1;
  await syncTrainerToPlayableTurn();

  const lineFinished = state.trainingCursor >= lessonTrainingLine(lesson).length;
  if (lineFinished) {
    if (state.lessonMistakes === 0) {
      recordReview(lesson.lesson_id, true);
    }
    rebuildQueue();
    renderQueue();
    playMoveSound("", { complete: true });
  }

  const successExplanation =
    state.trainingCursor - 1 === (lesson.target_ply_index || 0)
      ? lesson.explanation
      : `That keeps the line on track inside ${lesson.opening_name}.`;
  el.trainerFeedback.textContent = lineFinished
    ? `Line complete. ${successExplanation}`
    : `Correct. ${successExplanation}`;
  el.trainerFeedback.classList.remove("empty");
  el.boardLine.textContent = lesson.training_line_san || lesson.continuation_san || "";
  el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
}

function defaultReviewState() {
  return {
    streak: 0,
    due_at: 0,
    seen: 0,
    correct_count: 0,
    wrong_count: 0,
    worked_on_count: 0,
    last_seen_at: 0,
    last_result: "",
  };
}

function loadReviewStats(username) {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEW_KEY) || "{}");
    return raw[username] || {};
  } catch {
    return {};
  }
}

function saveReviewStats(username) {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEW_KEY) || "{}");
    raw[username] = state.reviewStats;
    localStorage.setItem(REVIEW_KEY, JSON.stringify(raw));
  } catch {
    // ignore storage failures
  }
}

function recordReview(lessonId, correct) {
  const current = state.reviewStats[lessonId] || defaultReviewState();
  const seen = (current.seen || 0) + 1;
  const streak = correct ? Math.min((current.streak || 0) + 1, REVIEW_INTERVALS.length - 1) : 0;
  const nextDays = REVIEW_INTERVALS[streak];
  const dueAt = Date.now() + nextDays * 24 * 60 * 60 * 1000;
  state.reviewStats[lessonId] = {
    seen,
    streak,
    correct_count: Number(current.correct_count || 0) + (correct ? 1 : 0),
    wrong_count: Number(current.wrong_count || 0) + (correct ? 0 : 1),
    worked_on_count: Number(current.worked_on_count || 0) + 1,
    last_seen_at: Date.now(),
    due_at: dueAt,
    last_result: correct ? "right" : "wrong",
  };
  if (state.payload?.username) {
    saveReviewStats(state.payload.username);
    void persistReviewStats(state.payload.username);
  }
}

async function persistReviewStats(username) {
  try {
    await fetch("/api/review-progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        lessons: state.reviewStats,
        summary: buildReviewSummary(),
      }),
    });
  } catch {
    // ignore sync failures
  }
}

function buildReviewSummary() {
  const lessons = Object.values(state.reviewStats || {});
  const seen = lessons.reduce((sum, item) => sum + Number(item.seen || 0), 0);
  const correct = lessons.reduce((sum, item) => sum + Number(item.correct_count || 0), 0);
  const wrong = lessons.reduce((sum, item) => sum + Number(item.wrong_count || 0), 0);
  return {
    lessons_tracked: lessons.length,
    attempts_seen: seen,
    correct_attempts: correct,
    wrong_attempts: wrong,
    last_saved_at: new Date().toISOString(),
  };
}

function parseFenBoard(fen) {
  const rows = String(fen || "").split(" ")[0].split("/");
  const squares = [];
  rows.forEach((row) => {
    row.split("").forEach((char) => {
      if (/\d/.test(char)) {
        for (let i = 0; i < Number(char); i += 1) squares.push("");
      } else {
        squares.push(char);
      }
    });
  });
  return squares;
}

function pieceSide(piece) {
  return piece === piece.toUpperCase() ? "w" : "b";
}

function sideToMove(fen) {
  return String(fen || "").split(" ")[1] || "w";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCp(cp) {
  const pawns = Number(cp || 0) / 100;
  const sign = pawns > 0 ? "+" : "";
  return `${sign}${pawns.toFixed(2)} pawns`;
}

function statusClass(status) {
  if (status === "known") return "known";
  if (status === "sideline") return "sideline";
  if (status === "new") return "new";
  return "needs-work";
}

function labelForStatus(status) {
  if (status === "known") return "Known";
  if (status === "sideline") return "Sideline";
  if (status === "new") return "New";
  return "Needs work";
}

init();
