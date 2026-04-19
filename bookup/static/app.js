const defaults = window.APP_DEFAULTS || {};
const REVIEW_KEY = "bookup-review-stats-v1";
const PROFILE_SCHEMA_VERSION = 2;
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
const MOVE_CLASSIFICATION_ICONS = {
  brilliant: "/static/move-classifications/brilliant.png",
  great: "/static/move-classifications/great.png",
  best: "/static/move-classifications/best.png",
  excellent: "/static/move-classifications/excellent.png",
  good: "/static/move-classifications/good.png",
  book: "/static/move-classifications/book.svg",
  inaccuracy: "/static/move-classifications/inaccuracy.png",
  mistake: "/static/move-classifications/mistake.png",
  blunder: "/static/move-classifications/blunder.png",
  miss: "/static/move-classifications/miss.png",
};
window.BOOKUP_MOVE_CLASSIFICATION_ICONS = MOVE_CLASSIFICATION_ICONS;
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
  summaryPositions: document.getElementById("summaryPositions"),
  summaryNeedsWork: document.getElementById("summaryNeedsWork"),
  summaryQueue: document.getElementById("summaryQueue"),
  badgeGames: document.getElementById("badgeGames"),
  badgeKnown: document.getElementById("badgeKnown"),
  badgeWinRate: document.getElementById("badgeWinRate"),
  firstMoveWhite: document.getElementById("firstMoveWhite"),
  firstMoveBlack: document.getElementById("firstMoveBlack"),
  repertoireMapWhite: document.getElementById("repertoireMapWhite"),
  repertoireMapBlack: document.getElementById("repertoireMapBlack"),
  previewPanel: document.getElementById("previewPanel"),
  knownArchiveList: document.getElementById("knownArchiveList"),
  urgentList: document.getElementById("urgentList"),
  sidelineList: document.getElementById("sidelineList"),
  suggestionList: document.getElementById("suggestionList"),
  mistakeList: document.getElementById("mistakeList"),
  lessonListDue: document.getElementById("lessonListDue"),
  lessonListNew: document.getElementById("lessonListNew"),
  lessonQueueMeta: document.getElementById("lessonQueueMeta"),
  boardWrap: document.querySelector(".board-wrap"),
  board: document.getElementById("board"),
  boardArrows: document.getElementById("boardArrows"),
  rankLabels: document.getElementById("rankLabels"),
  fileLabels: document.getElementById("fileLabels"),
  boardTitle: document.getElementById("boardTitle"),
  boardSummary: document.getElementById("boardSummary"),
  trainerCoach: document.getElementById("trainerCoach"),
  trainerDecision: document.getElementById("trainerDecision"),
  trainerInsight: document.getElementById("trainerInsight"),
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
  lessonMap: {},
  queueDue: [],
  queueNew: [],
  knownArchive: [],
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
  lastMoveSan: "",
  previousRenderedPieces: {},
  activeTrainingLine: [],
  activeTrainingLineSan: [],
  branchLocked: false,
  previewLessonId: "",
  previewInsight: null,
  currentInsight: null,
  positionInsightCache: {},
  insightRequestId: 0,
  manualNeedsWork: [],
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
  el.depth.value = defaults.depth || 24;
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
      previewLessonById(lessonId);
      return;
    }
    const previewTrain = target.dataset.previewTrain;
    if (previewTrain) {
      loadLessonById(previewTrain);
      return;
    }
    const previewAdd = target.dataset.previewAddNeeds;
    if (previewAdd) {
      addLessonToNeedsWork(previewAdd);
      return;
    }
    const trainerMove = target.dataset.trainerMove;
    if (trainerMove) {
      const from = trainerMove.slice(0, 2);
      const to = trainerMove.slice(2, 4);
      void submitTrainerMove(from, to);
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
  state.lastMoveSan = String(payload?.played_san || state.lastMoveSan || "");
  state.currentInsight = null;
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
  const notation = String(state.lastMoveSan || "");
  const durationMs = notation.includes("#") || notation.includes("+")
    ? 1450
    : notation.includes("x") || notation.startsWith("O-O")
      ? 1250
      : 1050;
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
    arrivingPiece.style.transitionDuration = `${durationMs}ms`;
  }

  requestAnimationFrame(() => {
    ghost.style.transitionDuration = `${durationMs}ms, ${durationMs}ms`;
    ghost.style.transform = `translate(${toRect.left - fromRect.left}px, ${toRect.top - fromRect.top}px)`;
    ghost.style.opacity = "0";
  });

  window.setTimeout(() => {
    if (arrivingPiece instanceof HTMLElement) {
      arrivingPiece.classList.remove("piece-arriving");
      arrivingPiece.style.removeProperty("transition-duration");
    }
    ghost.remove();
  }, durationMs + 40);
}

function squareCenter(squareName) {
  const square = el.board.querySelector(`[data-square="${squareName}"]`);
  if (!(square instanceof HTMLElement)) return null;
  return {
    x: square.offsetLeft + square.offsetWidth / 2,
    y: square.offsetTop + square.offsetHeight / 2,
  };
}

function arrowPath(from, to, bodyWidth, headWidth, headLength) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return "";
  const ux = dx / distance;
  const uy = dy / distance;
  const px = -uy;
  const py = ux;
  const startInset = 14;
  const endInset = 18;
  const shaftStartX = from.x + ux * startInset;
  const shaftStartY = from.y + uy * startInset;
  const arrowTipX = to.x - ux * endInset;
  const arrowTipY = to.y - uy * endInset;
  const headBaseX = arrowTipX - ux * headLength;
  const headBaseY = arrowTipY - uy * headLength;
  const tailLeftX = shaftStartX + px * (bodyWidth / 2);
  const tailLeftY = shaftStartY + py * (bodyWidth / 2);
  const tailRightX = shaftStartX - px * (bodyWidth / 2);
  const tailRightY = shaftStartY - py * (bodyWidth / 2);
  const headLeftX = headBaseX + px * (headWidth / 2);
  const headLeftY = headBaseY + py * (headWidth / 2);
  const headRightX = headBaseX - px * (headWidth / 2);
  const headRightY = headBaseY - py * (headWidth / 2);
  return [
    `M ${tailLeftX} ${tailLeftY}`,
    `L ${headLeftX} ${headLeftY}`,
    `L ${arrowTipX} ${arrowTipY}`,
    `L ${headRightX} ${headRightY}`,
    `L ${tailRightX} ${tailRightY}`,
    "Z",
  ].join(" ");
}

function renderArrowGroup(lines = [], color = "rgba(84, 139, 255, 0.68)", role = "engine") {
  return lines.map((line, index) => {
    const uci = String(line?.uci || "");
    if (uci.length < 4) return "";
    const from = squareCenter(uci.slice(0, 2));
    const to = squareCenter(uci.slice(2, 4));
    if (!from || !to) return "";
    const emphasis = Math.max(0.3, 1 - index * 0.16);
    const bodyWidth = role === "threat" ? Math.max(22 - index * 2.5, 12) : Math.max(20 - index * 2.4, 11);
    const headWidth = role === "threat" ? Math.max(34 - index * 3, 18) : Math.max(30 - index * 2.6, 17);
    const headLength = role === "threat" ? Math.max(34 - index * 2.8, 20) : Math.max(28 - index * 2.4, 18);
    const pathD = arrowPath(from, to, bodyWidth, headWidth, headLength);
    if (!pathD) return "";
    return `<path class="board-arrow ${role}-arrow" d="${pathD}" fill="${color}" opacity="${emphasis}"></path>`;
  }).join("");
}

function renderArrows(insight = null) {
  if (!el.boardArrows || !el.boardWrap) return;
  const width = el.board.clientWidth || 0;
  const height = el.board.clientHeight || 0;
  el.boardArrows.setAttribute("viewBox", `0 0 ${width} ${height}`);
  el.boardArrows.innerHTML = "";
  const engineLines = Array.isArray(insight?.candidate_lines) ? insight.candidate_lines.slice(0, 5) : [];
  const threatLines = Array.isArray(insight?.threat_lines) ? insight.threat_lines.slice(0, 3) : [];
  if (!engineLines.length && !threatLines.length) return;
  el.boardArrows.innerHTML = [
    renderArrowGroup(threatLines, "rgba(219, 83, 83, 0.56)", "threat"),
    renderArrowGroup(engineLines, "rgba(102, 164, 255, 0.52)", "engine"),
  ].join("");
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
    const profile = payload.profile || {};
    const snapshotLooksCurrent =
      Number(payload.schema_version || 0) >= PROFILE_SCHEMA_VERSION &&
      Boolean(profile.repertoire_map && Array.isArray(profile.trainer_queue_due));
    if (snapshotLooksCurrent) {
      state.payload = {
        username: payload.username,
        profile,
        games_imported: payload.games_imported || 0,
        archives_found: payload.archives_found || 0,
      };
      state.reviewStats = payload.training_progress || {};
      state.manualNeedsWork = payload.training_summary?.manual_needs_work || [];
      state.games = payload.games || [];
      renderProfile(state.payload);
      setStatus(
        payload.saved_at
          ? `Loaded your saved Bookup workspace for ${payload.username}.`
          : `Loaded local Bookup data for ${payload.username}.`
      );
    } else if (payload.profile) {
      state.reviewStats = payload.training_progress || {};
      setStatus("Saved data is from an older Bookup version. Rebuild your repertoire to refresh it.");
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
  state.lessons = [
    ...(profile.trainer_queue_due || []),
    ...(profile.trainer_queue_new || []),
    ...(profile.known_line_archive || []),
  ];
  const seenLessonIds = new Set(state.lessons.map((lesson) => lesson.lesson_id));
  (profile.previewable_lines || []).forEach((lesson) => {
    if (!seenLessonIds.has(lesson.lesson_id)) {
      state.lessons.push(lesson);
      seenLessonIds.add(lesson.lesson_id);
    }
  });
  state.lessonMap = Object.fromEntries(state.lessons.map((lesson) => [lesson.lesson_id, lesson]));
  state.knownArchive = profile.known_line_archive || [];
  state.manualNeedsWork = (payload.training_summary?.manual_needs_work || []);
  rebuildQueue();

  el.heroTitle.textContent = `${payload.username} repertoire ready`;
  el.heroSummary.textContent = summary.prep_summary || "Your repertoire positions are ready to train.";
  el.summaryPositions.textContent = String(summary.positions ?? "--");
  el.summaryNeedsWork.textContent = String((profile.needs_work || []).length ?? "--");
  el.summaryQueue.textContent = String(summary.trainable_positions ?? "--");
  el.badgeGames.textContent = String(payload.games_imported ?? "--");
  el.badgeKnown.textContent = String(summary.known_lines ?? "--");
  el.badgeWinRate.textContent = typeof summary.win_rate === "number" ? `${summary.win_rate}%` : "--";

  renderFirstMoves(profile.first_move_repertoire || {});
  renderRepertoireMap(profile.repertoire_map || {});
  renderKnownArchive(profile.known_line_archive || []);
  renderImproveList(el.urgentList, state.queueDue, "No due lines right now.");
  renderImproveList(el.sidelineList, state.queueNew, "No fresh lines waiting right now.");
  renderSuggestions(profile.repertoire_updates || []);
  renderMistakes(profile.opening_mistakes || []);
  renderQueue();
  clearPreview();

  if (state.queueDue.length || state.queueNew.length) {
    previewLessonById((state.queueDue[0] || state.queueNew[0]).lesson_id);
  } else {
    clearTrainer();
  }
  setActiveTab("repertoire-map");
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
          <div class="line-badge">${item.pct}% | ${item.count}x</div>
        </div>
        <div class="line-note">This move starts ${item.count} of your imported games on this side.</div>
      </article>
    `)
    .join("");
}

function renderKnownArchive(items) {
  if (!items.length) {
    el.knownArchiveList.className = "stack empty";
    el.knownArchiveList.textContent = "Known lines will show up here once Bookup sees you playing the best move 100+ times.";
    return;
  }
  el.knownArchiveList.className = "stack";
  el.knownArchiveList.innerHTML = items
    .map((item) => `
      <article class="line-card">
        <div class="line-card-header">
          <div>
            <div class="line-title">${escapeHtml(item.line_label || item.opening_name)}</div>
            ${item.opening_name ? `<div class="tree-meta">${escapeHtml(item.opening_name)}${item.opening_code ? ` | ${escapeHtml(item.opening_code)}` : ""}</div>` : ""}
          </div>
          <div class="line-badge known">Known</div>
        </div>
        <div class="chip-row">
          <span class="lesson-chip known">Best move played ${item.repeat_count}x</span>
          <span class="lesson-chip">Frequency ${item.frequency}</span>
        </div>
        <div class="line-preview">${escapeHtml(item.continuation_san || item.training_line_san || "")}</div>
      </article>
    `)
    .join("");
}

function renderRepertoireMapColumn(node, items, emptyText) {
  if (!items.length) {
    node.className = "stack empty";
    node.textContent = emptyText;
    return;
  }
  node.className = "stack";
  node.innerHTML = items
    .map((item, index) => `
      <article class="opening-family-card repertoire-node-card">
        <div class="opening-family-header">
          <div>
            <div class="opening-family-title">${index + 1}. ${escapeHtml(item.line_label || item.opening_name)}</div>
            <div class="tree-meta">${escapeHtml(item.opening_name || "")}${item.opening_code ? ` | ${escapeHtml(item.opening_code)}` : ""}</div>
          </div>
          <div class="line-badge ${statusClass(item.line_status)}">${labelForStatus(item.line_status)}</div>
        </div>
        <div class="line-note">
          You usually play <strong>${escapeHtml(item.your_repeated_move || item.recommended_move)}</strong>${classificationBadge(item.your_move_classification, "inline")}
          . Stockfish recommends <strong>${escapeHtml(item.recommended_move)}</strong>${classificationBadge(item.recommended_classification, "inline")}.
        </div>
        <div class="chip-row">
          <span class="lesson-chip">Frequency ${item.frequency}</span>
          <span class="lesson-chip">Confidence ${Math.round(item.confidence)}</span>
          <span class="lesson-chip">Repeated ${item.your_top_move_count || 0}x</span>
        </div>
        <div class="line-note">${escapeHtml(item.coach_explanation || "")}</div>
        <div class="chip-row">
          <button class="launch-btn" type="button" data-lesson-launch="${escapeHtml(item.lesson_id)}">Preview line</button>
          ${item.position_identifier ? `<a class="launch-btn" href="${item.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.position_identifier_label || "Lichess analysis")}</a>` : ""}
        </div>
      </article>
    `)
    .join("");
}

function renderRepertoireMap(mapByColor) {
  renderRepertoireMapColumn(el.repertoireMapWhite, mapByColor.white || [], "No white repertoire positions yet.");
  renderRepertoireMapColumn(el.repertoireMapBlack, mapByColor.black || [], "No black repertoire positions yet.");
}

function clearPreview() {
  state.previewLessonId = "";
  state.previewInsight = null;
  el.previewPanel.classList.add("empty");
  el.previewPanel.textContent = "Click a repertoire position to preview the line, blue engine arrows, database moves, and coaching before adding it to Needs Work or starting training.";
}

async function previewLessonById(lessonId) {
  const lesson = state.lessonMap[lessonId];
  if (!lesson) return;
  state.previewLessonId = lessonId;
  el.previewPanel.classList.remove("empty");
  setActiveTab("repertoire-map");
  const insight = buildLessonInsight(lesson);
  state.previewInsight = insight;
  renderPreview(lesson, insight);
}

function renderPreview(lesson, insight) {
  const enginePreview = (insight.candidate_lines || [])
    .slice(0, 5)
    .map((line) => renderCandidateLineSummary(line))
    .join("");
  const dbPreview = (insight.database_moves || [])
    .slice(0, 5)
    .map((line) => `${escapeHtml(line.san)} ${line.popularity}%`)
    .join(" | ");
  el.previewPanel.innerHTML = `
    <div class="section-label">Preview</div>
    <h3 class="section-title">${escapeHtml(lesson.line_label || lesson.opening_name)}</h3>
    <div class="line-note">
      You usually play <strong>${escapeHtml(lesson.your_repeated_move || lesson.best_reply)}</strong>${classificationBadge(lesson.your_move_classification, "inline")}
      here. Bookup recommends <strong>${escapeHtml(lesson.best_reply)}</strong>${classificationBadge(insight.recommended_classification || lesson.recommended_classification, "inline")}.
    </div>
    <div class="chip-row">
      <span class="lesson-chip">Frequency ${lesson.frequency}</span>
      <span class="lesson-chip">Repeated ${lesson.your_top_move_count || 0}x</span>
      <span class="lesson-chip ${statusClass(lesson.line_status)}">${labelForStatus(lesson.line_status)}</span>
    </div>
    ${lesson.opening_name ? `<div class="line-note">${escapeHtml(lesson.opening_name)}${lesson.opening_code ? ` | ${escapeHtml(lesson.opening_code)}` : ""}</div>` : ""}
    <div class="line-note">Top engine lines: <span class="candidate-line-list">${enginePreview || "No engine candidates yet."}</span></div>
    <div class="line-note">Common database moves: ${dbPreview || "No database move data available."}</div>
    <div class="line-preview">${escapeHtml(lesson.continuation_san || lesson.training_line_san || "")}</div>
    <div class="line-note">${escapeHtml(insight.coach_explanation || lesson.coach_explanation || lesson.explanation || "")}</div>
    <div class="chip-row">
      <button class="launch-btn" type="button" data-previewAddNeeds="${escapeHtml(lesson.lesson_id)}">Add to Needs Work</button>
      <button class="launch-btn" type="button" data-previewTrain="${escapeHtml(lesson.lesson_id)}">Start training</button>
      ${lesson.position_identifier ? `<a class="launch-btn" href="${lesson.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(lesson.position_identifier_label || "Lichess analysis")}</a>` : ""}
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
        .map((line) => renderCandidateLineSummary(line))
        .join("");
      return `
      <article class="line-card">
        <div class="line-card-header">
          <div>
            <div class="line-title">${escapeHtml(item.line_label || item.opening_name)}</div>
            <div class="tree-meta">${escapeHtml(item.opening_name || "")}</div>
          </div>
          <div class="line-badge ${statusClass(item.line_status)}">${labelForStatus(item.line_status)}</div>
        </div>
        <div class="line-note">
          Best continuation: <strong>${escapeHtml(item.best_reply)}</strong>${classificationBadge(item.recommended_classification, "inline")}
        </div>
        <div class="line-note">Top engine lines: <span class="candidate-line-list">${candidatePreview || "No candidate lines available."}</span></div>
        <div class="line-note">Repeated mistake count: ${item.repeat_mistake_count || 0}</div>
        <div class="chip-row">
          <span class="lesson-chip">Frequency ${item.frequency}</span>
          <span class="lesson-chip">Priority ${Math.round(item.priority)}</span>
          <span class="lesson-chip">${describeEdge(item.value_lost_cp)}</span>
        </div>
        <div class="line-preview">${escapeHtml(item.continuation_san)}</div>
        <div class="line-note">${escapeHtml(item.explanation)}</div>
        <div class="chip-row">
          <button class="launch-btn" type="button" data-lesson-launch="${escapeHtml(item.lesson_id)}">Preview line</button>
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

async function fetchPositionInsight(fen, playUci = [], yourMoveUci = "", yourMoveSan = "", yourMoveCount = 0) {
  const response = await fetch("/api/position-insight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fen,
      play_uci: playUci,
      your_move_uci: yourMoveUci,
      your_move_san: yourMoveSan,
      your_move_count: yourMoveCount,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not load position insight.");
  return payload;
}

function buildLessonInsight(lesson) {
  return {
    candidate_lines: Array.isArray(lesson?.candidate_lines) ? lesson.candidate_lines : [],
    threat_lines: Array.isArray(lesson?.threat_lines) ? lesson.threat_lines : [],
    database_moves: Array.isArray(lesson?.database_moves) ? lesson.database_moves : [],
    recommended_move: lesson?.best_reply || "",
    recommended_move_uci: lesson?.best_reply_uci || "",
    recommended_classification: lesson?.recommended_classification || null,
    your_move_classification: lesson?.your_move_classification || null,
    coach_explanation: lesson?.coach_explanation || lesson?.explanation || "",
    position_identifier: lesson?.position_identifier || "",
    position_identifier_label: lesson?.position_identifier_label || "Lichess analysis",
  };
}

function addLessonToNeedsWork(lessonId) {
  if (!lessonId) return;
  if (!state.manualNeedsWork.includes(lessonId)) {
    state.manualNeedsWork.push(lessonId);
  }
  rebuildQueue();
  renderQueue();
  if (state.payload?.username) {
    saveReviewStats(state.payload.username);
    void persistReviewStats(state.payload.username);
  }
  setActiveTab("needs-work");
}

function renderMistakes(items) {
  const repeatedItems = items.filter((item) => (item.repeat_mistake_count || 0) >= 2);
  if (!repeatedItems.length) {
    el.mistakeList.className = "stack empty";
    el.mistakeList.textContent = "No opening mistakes to review right now.";
    return;
  }
  el.mistakeList.className = "stack";
  el.mistakeList.innerHTML = repeatedItems
    .map((item, index) => `
      <article class="mistake-card">
        <div class="mistake-header">
          <div>
            <div class="mistake-title">${index + 1}. ${escapeHtml(item.line_label || item.opening_name)}</div>
            <div class="tree-meta">${escapeHtml(item.opening_name || "")}</div>
          </div>
          <div class="line-badge needs-work">Needs work</div>
        </div>
        <div class="mistake-copy">
          You usually play <strong>${escapeHtml(item.played)}</strong>${classificationBadge(item.played_classification, "inline")},
          but the best continuation is <strong>${escapeHtml(item.best_move)}</strong>${classificationBadge(item.recommended_classification, "inline")}.
        </div>
        <div class="line-note">Repeated mistake count: ${item.repeat_mistake_count || 0}</div>
        <div class="line-note">${escapeHtml(item.explanation)}</div>
        <div class="line-preview">${escapeHtml(item.continuation_san || "")}</div>
        <div class="chip-row">
          <button class="launch-btn" type="button" data-lesson-launch="${escapeHtml(item.lesson_id)}">Preview position</button>
          ${item.position_identifier ? `<a class="launch-btn" href="${item.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.position_identifier_label || "Lichess analysis")}</a>` : ""}
        </div>
      </article>
    `)
    .join("");
}

function rebuildQueue() {
  const enrich = (lesson) => {
    const review = state.reviewStats[lesson.lesson_id] || defaultReviewState();
    const due = review.due_at || 0;
    const overdue = due <= Date.now();
    const manualBoost = state.manualNeedsWork.includes(lesson.lesson_id) ? 220 : 0;
    const score = (overdue ? 1000 : 0) + lesson.priority + manualBoost - (review.streak || 0) * 10 + (review.last_result === "wrong" ? 120 : 0);
    return { ...lesson, review, dueSoon: overdue, queueScore: score };
  };
  state.queueDue = (state.payload?.profile?.trainer_queue_due || [])
    .map(enrich)
    .sort((a, b) => b.queueScore - a.queueScore);
  const manualOnly = state.manualNeedsWork
    .map((lessonId) => state.lessonMap[lessonId])
    .filter(Boolean)
    .filter((lesson) => !state.queueDue.some((item) => item.lesson_id === lesson.lesson_id) && lesson.line_status !== "known")
    .map(enrich)
    .sort((a, b) => b.queueScore - a.queueScore);
  state.queueDue = [...manualOnly, ...state.queueDue];
  state.queueNew = (state.payload?.profile?.trainer_queue_new || [])
    .map(enrich)
    .sort((a, b) => b.priority - a.priority || b.frequency - a.frequency);
  state.knownArchive = state.payload?.profile?.known_line_archive || [];
}

function renderQueue() {
  const dueNow = state.queueDue.filter((item) => item.dueSoon).length;
  const total = state.queueDue.length + state.queueNew.length;
  el.lessonQueueMeta.textContent = total
    ? `${dueNow} due now | ${total} total lines across due and new queues`
    : "No repeated misses due right now.";

  const renderQueueList = (node, items, emptyText) => {
    if (!items.length) {
      node.className = "stack empty";
      node.textContent = emptyText;
      return;
    }
    node.className = "stack";
    node.innerHTML = items
      .map((lesson, index) => `
      <button class="queue-card ${lesson.lesson_id === currentLessonId() ? "active" : ""}" type="button" data-lesson-launch="${escapeHtml(lesson.lesson_id)}">
        <div class="queue-card-header">
          <div>
            <div class="queue-title">${escapeHtml(lesson.line_label || lesson.opening_name)}</div>
            <div class="tree-meta">${escapeHtml(lesson.opening_name || "")} -> ${escapeHtml(lesson.best_reply)}</div>
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
  };

  renderQueueList(
    el.lessonListDue,
    state.queueDue,
    "No repeated misses are due right now. Bookup will keep this queue focused on repeated repertoire mistakes only."
  );
  renderQueueList(
    el.lessonListNew,
    state.queueNew,
    "No fresh lines are waiting right now."
  );
}

function currentLessonId() {
  return state.activeLessonId || "";
}

function launchLessonById(lessonId) {
  loadLessonById(lessonId);
}

function lessonTrainingLine(lesson) {
  if (state.activeTrainingLine.length) return state.activeTrainingLine.filter(Boolean);
  return Array.isArray(lesson?.training_line_uci) ? lesson.training_line_uci.filter(Boolean) : [];
}

function lessonTrainingLineSan(lesson) {
  if (state.activeTrainingLineSan.length) return state.activeTrainingLineSan.filter(Boolean);
  return String(lesson?.training_line_san || "").trim().split(/\s+/).filter(Boolean);
}

function combineSanSegments(...segments) {
  return segments
    .map((segment) => String(segment || "").trim())
    .filter(Boolean)
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function lessonRootCursor(lesson) {
  return Array.isArray(lesson?.intro_line_uci) ? lesson.intro_line_uci.length : 0;
}

function findBranchLine(lesson, moveUci) {
  return (lesson?.branch_lines || []).find((item) => item.uci === moveUci) || null;
}

function currentLesson() {
  return state.lessonMap[state.activeLessonId] || null;
}

function insightCacheKey(lesson) {
  const line = lesson ? lessonTrainingLine(lesson).slice(0, state.trainingCursor) : [];
  return `${normalizeFen(state.boardFen)}|${line.join(",")}|${state.activeLessonId}|${state.trainingCursor}`;
}

function currentInsightYourMove(lesson) {
  if (!lesson || state.branchLocked || state.trainingCursor !== lessonRootCursor(lesson)) {
    return { uci: "", san: "", count: 0 };
  }
  const repeated = (lesson.discovery_nodes || [])
    .filter((item) => item && item.uci && item.count)
    .sort((a, b) => (b.count || 0) - (a.count || 0))[0];
  if (!repeated) return { uci: "", san: "", count: 0 };
  return {
    uci: repeated.uci || "",
    san: repeated.san || "",
    count: repeated.count || 0,
  };
}

function renderTrainerDecision(lesson) {
  if (!lesson) {
    el.trainerDecision.textContent = "No decision point loaded yet.";
    el.trainerDecision.classList.add("empty");
    return;
  }
  if (state.branchLocked || state.trainingCursor !== lessonRootCursor(lesson)) {
    el.trainerDecision.textContent = "Bookup is inside a locked repertoire branch now.";
    el.trainerDecision.classList.add("empty");
    return;
  }

  const knownMoves = (lesson.discovery_nodes || [])
    .filter((item) => item.has_branch_line)
    .slice(0, 6);
  const practicalMoves = (lesson.common_replies || [])
    .slice(0, 5)
    .map((item) => `${escapeHtml(item.san)} ${item.popularity}%`)
    .join(" | ");

  el.trainerDecision.classList.remove("empty");
  el.trainerDecision.innerHTML = `
    <div class="trainer-decision-copy">What would you play here? Pick your move on the board, or tap one of your known branches below.</div>
    <div class="chip-row">
      ${knownMoves.map((item) => `
        <button class="launch-btn" type="button" data-trainer-move="${escapeHtml(item.uci)}">
          ${escapeHtml(item.san)} ${item.is_preferred ? "(preferred)" : `${item.count}x`}
        </button>
      `).join("")}
    </div>
    <div class="line-note">Moves played from this position on Lichess: ${practicalMoves || "No explorer move data available."}</div>
  `;
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
  const openingLabel = lesson.line_label || lesson.opening_name;
  el.boardTitle.textContent = openingLabel;
  if (!state.branchLocked && state.trainingCursor === lessonRootCursor(lesson)) {
    const discoveryPreview = (lesson.discovery_nodes || [])
      .slice(0, 4)
      .map((item) => `${item.san} ${item.count}x`)
      .join(" | ");
    el.boardSummary.textContent = `What would you play here? Bookup will follow your branch if it stays inside your repertoire.`;
    el.trainerCoach.textContent = discoveryPreview
      ? `Your repeated moves in this position: ${discoveryPreview}. Preferred move: ${lesson.best_reply}.`
      : `Preferred move here: ${lesson.best_reply}.`;
    el.trainerCoach.classList.remove("empty");
    renderTrainerDecision(lesson);
    el.trainerFeedback.textContent = "Your repertoire check: what would you play here?";
    el.trainerFeedback.classList.remove("empty");
    el.boardLine.textContent = lesson.intro_line_san || "No lead-in moves loaded.";
    el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
    return;
  }
  el.trainerDecision.textContent = "Bookup is inside a locked repertoire branch now.";
  el.trainerDecision.classList.add("empty");
  if (state.trainingCursor >= line.length) {
    el.boardSummary.textContent = "Line complete. Reset it or move on to the next due line.";
    el.trainerCoach.textContent = `Bookup locked this line after ${lesson.trigger_move} and ran the continuation to the end.`;
    el.trainerCoach.classList.remove("empty");
    el.boardLine.textContent = lessonTrainingLineSan(lesson).join(" ") || lesson.continuation_san || "No line loaded yet.";
    el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
    return;
  }
  if (trainerUserTurn(lesson)) {
    const targetText = expectedEntry?.san || lesson.best_reply;
    el.boardSummary.textContent = `Play the repertoire move here: ${targetText}. Step ${progress}.`;
  } else {
    el.boardSummary.textContent = `Bookup is playing the line for the other side. Step ${progress}.`;
  }
  el.trainerCoach.textContent = `Bookup is now training the branch you reached from this position.`;
  el.trainerCoach.classList.remove("empty");
  el.boardLine.textContent = lessonTrainingLineSan(lesson).join(" ") || lesson.continuation_san || "No line loaded yet.";
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
  const rootCursor = lessonRootCursor(lesson);
  if (!state.branchLocked) {
    while (state.trainingCursor < rootCursor) {
      const setupMove = line[state.trainingCursor];
      if (!setupMove) break;
      await applyMoveToBoard(setupMove);
      state.trainingCursor += 1;
    }
    updateTrainerCopy();
    await updateCurrentInsight();
    return;
  }
  while (state.trainingCursor < line.length && !trainerUserTurn(lesson)) {
    const expectedUci = line[state.trainingCursor];
    await applyMoveToBoard(expectedUci);
    state.trainingCursor += 1;
  }
  updateTrainerCopy();
  await updateCurrentInsight();
}

async function loadLessonById(lessonId) {
  const lesson = state.lessonMap[lessonId];
  if (!lesson) return;
  state.lessonIndex = state.queueDue.findIndex((item) => item.lesson_id === lessonId);
  state.activeLessonId = lesson.lesson_id;
  state.boardOrientation = lesson.color === "black" ? "black" : "white";
  state.startFen = normalizeFen(lesson.line_start_fen);
  state.boardFen = state.startFen;
  state.trainingCursor = 0;
  state.lessonMistakes = 0;
  state.activeTrainingLine = Array.isArray(lesson.intro_line_uci) ? [...lesson.intro_line_uci] : [];
  state.activeTrainingLineSan = String(lesson.intro_line_san || "").trim().split(/\s+/).filter(Boolean);
  state.branchLocked = false;
  state.selectedSquare = "";
  state.dragFrom = "";
  state.lastMove = null;
  state.lastMoveSan = "";
  state.previousRenderedPieces = {};
  state.currentInsight = null;
  el.trainerFeedback.textContent = lesson.line_status === "known"
    ? "You already know this line. Bookup will still run it from the beginning as maintenance."
    : "Bookup is starting from the beginning of the line. When you reach the branch, play what you would normally play there.";
  el.trainerFeedback.classList.remove("empty");

  await refreshLegalMoves(state.boardFen);
  renderCoords();
  renderBoard(state.boardFen);
  await updateCurrentInsight();
  await syncTrainerToPlayableTurn();
  renderQueue();
  setActiveTab("trainer");
}

function nextLesson() {
  const combined = [...state.queueDue, ...state.queueNew];
  if (!combined.length) return;
  const currentIndex = combined.findIndex((item) => item.lesson_id === state.activeLessonId);
  const next = currentIndex < 0 ? 0 : (currentIndex + 1) % combined.length;
  loadLessonById(combined[next].lesson_id);
}

function resetTrainerLesson() {
  if (!state.activeLessonId) return;
  loadLessonById(state.activeLessonId);
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
  state.lastMoveSan = "";
  state.previousRenderedPieces = {};
  state.activeTrainingLine = [];
  state.activeTrainingLineSan = [];
  state.branchLocked = false;
  state.currentInsight = null;
  state.positionInsightCache = {};
  state.insightRequestId = 0;
  el.trainerCoach.textContent = "Bookup will ask what you would play here, then lock into the repertoire branch you choose or redirect you if you leave your repertoire.";
  el.trainerCoach.classList.remove("empty");
  el.trainerDecision.textContent = "No decision point loaded yet.";
  el.trainerDecision.classList.add("empty");
  el.trainerInsight.textContent = "Blue arrows show the top engine moves. Red arrows show the main threats or replies you should expect next.";
  el.trainerInsight.classList.remove("empty");
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

async function updateCurrentInsight() {
  const lesson = currentLesson();
  if (!lesson || !state.boardFen) {
    state.currentInsight = null;
    renderArrows(null);
    el.trainerInsight.textContent = "Blue arrows show the top engine moves. Red arrows show the main threats or replies you should expect next.";
    return;
  }
  const requestId = ++state.insightRequestId;
  const cacheKey = insightCacheKey(lesson);
  if (state.positionInsightCache[cacheKey]) {
    state.currentInsight = state.positionInsightCache[cacheKey];
    renderArrows(state.currentInsight);
    el.trainerInsight.textContent = state.currentInsight.coach_explanation || "Blue arrows show the top engine moves. Red arrows show the main threats or replies you should expect next.";
    el.trainerInsight.classList.remove("empty");
    return;
  }
  const yourMove = currentInsightYourMove(lesson);
  const playPrefix = lessonTrainingLine(lesson).slice(0, state.trainingCursor);
  try {
    const insight = await fetchPositionInsight(
      state.boardFen,
      playPrefix,
      yourMove.uci,
      yourMove.san,
      yourMove.count
    );
    if (requestId !== state.insightRequestId || normalizeFen(state.boardFen) !== cacheKey.split("|")[0]) {
      return;
    }
    state.positionInsightCache[cacheKey] = insight;
    state.currentInsight = insight;
    renderArrows(insight);
    el.trainerInsight.textContent = insight.coach_explanation || "Blue arrows show the top engine moves. Red arrows show the main threats or replies you should expect next.";
  } catch (error) {
    state.currentInsight = null;
    renderArrows(null);
    el.trainerInsight.textContent = "Live arrows are unavailable right now. Blue arrows show top engine moves and red arrows show threats when the current position insight loads.";
  }
  el.trainerInsight.classList.remove("empty");
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
  renderArrows(state.currentInsight);
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
  const rootCursor = lessonRootCursor(lesson);

  if (!state.branchLocked && state.trainingCursor === rootCursor) {
    const preferredBranch = findBranchLine(lesson, lesson.preferred_branch_uci);
    const chosenBranch = findBranchLine(lesson, move.uci);
    if (chosenBranch) {
      state.branchLocked = true;
      state.activeTrainingLine = [...(lesson.intro_line_uci || []), ...(chosenBranch.line_uci || [])];
      state.activeTrainingLineSan = combineSanSegments(lesson.intro_line_san, chosenBranch.line_san);
      await applyMoveToBoard(move.uci);
      state.trainingCursor = rootCursor + 1;
      if (move.uci === lesson.preferred_branch_uci) {
        el.trainerFeedback.textContent = `Correct. ${lesson.explanation}`;
      } else {
        const sourceLabel = chosenBranch.source === "repertoire" ? "your repeated repertoire branch" : "a known branch in this position";
        el.trainerFeedback.textContent = `${move.san} is ${sourceLabel}. Bookup will follow it, but the preferred move here is ${lesson.best_reply}.`;
      }
      el.trainerFeedback.classList.remove("empty");
      await syncTrainerToPlayableTurn();
      renderQueue();
      return;
    }

    state.lessonMistakes += 1;
    recordReview(lesson.lesson_id, false);
    playMoveSound("", { error: true });
    el.trainerFeedback.textContent = `${move.san} leaves your known repertoire here. Bookup recommends ${lesson.best_reply} and will switch back to that branch.`;
    el.trainerFeedback.classList.remove("empty");
    if (preferredBranch) {
      state.branchLocked = true;
      state.activeTrainingLine = [...(lesson.intro_line_uci || []), ...(preferredBranch.line_uci || [])];
      state.activeTrainingLineSan = combineSanSegments(lesson.intro_line_san, preferredBranch.line_san);
      await applyMoveToBoard(lesson.preferred_branch_uci);
      state.trainingCursor = rootCursor + 1;
      await syncTrainerToPlayableTurn();
      rebuildQueue();
      renderQueue();
    }
    return;
  }

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
    el.boardLine.textContent = lessonTrainingLineSan(lesson).join(" ") || lesson.continuation_san || "";
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
  el.boardLine.textContent = lessonTrainingLineSan(lesson).join(" ") || lesson.continuation_san || "";
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
    manual_needs_work: state.manualNeedsWork,
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

function formatEval(cp) {
  const value = Number(cp || 0);
  if (Math.abs(value) >= 9000) return value > 0 ? "winning" : "losing";
  const pawns = Math.max(-6, Math.min(6, value / 100));
  const sign = pawns > 0 ? "+" : "";
  return `${sign}${pawns.toFixed(1)}`;
}

function describeEdge(cp) {
  const value = Math.abs(Number(cp || 0));
  if (value < 40) return "Tiny edge";
  if (value < 120) return "Small edge";
  if (value < 250) return "Clear edge";
  return "Big edge";
}

function classificationKey(record) {
  return String(record?.key || record?.label || "").trim().toLowerCase();
}

function classificationBadge(record, extraClass = "") {
  const key = classificationKey(record);
  const label = String(record?.label || "").trim();
  if (!key || !label) return "";
  const icon = MOVE_CLASSIFICATION_ICONS[key];
  if (!icon) return "";
  const title = escapeHtml(record?.reason || label);
  return `
    <span class="classification-badge ${escapeHtml(extraClass)} ${escapeHtml(key)}" title="${title}">
      <img src="${icon}" alt="${escapeHtml(label)}" />
      <span>${escapeHtml(label)}</span>
    </span>
  `;
}

function renderCandidateLineSummary(line) {
  const badge = classificationBadge(line?.classification, "compact");
  const move = escapeHtml(line?.move || "");
  const evalText = formatEval(line?.score_cp);
  if (!move) return "";
  return `<span class="candidate-line">${badge}${move} ${evalText}</span>`;
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
