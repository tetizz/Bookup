const defaults = window.APP_DEFAULTS || {};
const REVIEW_KEY = "bookup-review-stats-v1";
const PROFILE_SCHEMA_VERSION = 15;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const CLASSIFICATION_ASSET_VERSION = "20260422c";
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
  brilliant: `/static/move-classifications/brilliant.png?v=${CLASSIFICATION_ASSET_VERSION}`,
  great: `/static/move-classifications/great.png?v=${CLASSIFICATION_ASSET_VERSION}`,
  best: `/static/move-classifications/best.png?v=${CLASSIFICATION_ASSET_VERSION}`,
  forced: `/static/move-classifications/best.png?v=${CLASSIFICATION_ASSET_VERSION}`,
  excellent: `/static/move-classifications/excellent.png?v=${CLASSIFICATION_ASSET_VERSION}`,
  good: `/static/move-classifications/good.png?v=${CLASSIFICATION_ASSET_VERSION}`,
  book: `/static/move-classifications/book.png?v=${CLASSIFICATION_ASSET_VERSION}`,
  inaccuracy: `/static/move-classifications/inaccuracy.png?v=${CLASSIFICATION_ASSET_VERSION}`,
  mistake: `/static/move-classifications/mistake.png?v=${CLASSIFICATION_ASSET_VERSION}`,
  blunder: `/static/move-classifications/blunder.png?v=${CLASSIFICATION_ASSET_VERSION}`,
  miss: `/static/move-classifications/miss.png?v=${CLASSIFICATION_ASSET_VERSION}`,
};
const MOVE_CLASSIFICATION_LABELS = {
  brilliant: "Brilliant",
  great: "Great",
  best: "Best",
  forced: "Forced",
  excellent: "Excellent",
  good: "Good",
  book: "Book",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
  miss: "Miss",
};
window.BOOKUP_MOVE_CLASSIFICATION_ICONS = MOVE_CLASSIFICATION_ICONS;

function preloadClassificationIcons() {
  Object.values(MOVE_CLASSIFICATION_ICONS).forEach((src) => {
    const image = new Image();
    image.decoding = "async";
    image.src = src;
  });
}

const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];
const REVIEW_INTERVALS = [0, 1, 3, 7, 14];
const INALTERABLE_CLASSIFICATION_KEYS = new Set(["best", "great", "brilliant", "book", "forced"]);

const el = {
  username: document.getElementById("usernameInput"),
  timeClasses: document.getElementById("timeClassesInput"),
  maxGames: document.getElementById("maxGamesInput"),
  importAllGames: document.getElementById("importAllGamesInput"),
  lichessToken: document.getElementById("lichessTokenInput"),
  enginePath: document.getElementById("enginePathInput"),
  depth: document.getElementById("depthInput"),
  thinkTime: document.getElementById("thinkTimeInput"),
  multiPv: document.getElementById("multiPvInput"),
  threads: document.getElementById("threadsInput"),
  hash: document.getElementById("hashInput"),
  analyze: document.getElementById("analyzeBtn"),
  pgnImport: document.getElementById("pgnImportInput"),
  importPgn: document.getElementById("importPgnBtn"),
  pgnImportStatus: document.getElementById("pgnImportStatus"),
  status: document.getElementById("status"),
  progressTrack: document.getElementById("progressTrack"),
  progressFill: document.getElementById("progressFill"),
  progressLabel: document.getElementById("progressLabel"),
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
  healthDashboard: document.getElementById("healthDashboard"),
  memoryScorePanel: document.getElementById("memoryScorePanel"),
  driftDetectorPanel: document.getElementById("driftDetectorPanel"),
  prepPackPanel: document.getElementById("prepPackPanel"),
  cacheDashboard: document.getElementById("cacheDashboard"),
  studyPlanPanel: document.getElementById("studyPlanPanel"),
  confidenceGraphPanel: document.getElementById("confidenceGraphPanel"),
  driftFixPanel: document.getElementById("driftFixPanel"),
  importSpeedPanel: document.getElementById("importSpeedPanel"),
  transpositionList: document.getElementById("transpositionList"),
  previewPanel: document.getElementById("previewPanel"),
  knownArchiveList: document.getElementById("knownArchiveList"),
  gameMoveTree: document.getElementById("gameMoveTree"),
  theoryMove: document.getElementById("theoryMoveInput"),
  theoryPly: document.getElementById("theoryPlyInput"),
  generateTheory: document.getElementById("generateTheoryBtn"),
  theoryOutput: document.getElementById("theoryOutput"),
  theoryPresetPanel: document.getElementById("theoryPresetPanel"),
  opponentSimulatorPanel: document.getElementById("opponentSimulatorPanel"),
  trapFinderPanel: document.getElementById("trapFinderPanel"),
  repertoireExportPanel: document.getElementById("repertoireExportPanel"),
  urgentList: document.getElementById("urgentList"),
  sidelineList: document.getElementById("sidelineList"),
  suggestionList: document.getElementById("suggestionList"),
  mistakeList: document.getElementById("mistakeList"),
  mistakeHeatmap: document.getElementById("mistakeHeatmap"),
  mistakeTimeline: document.getElementById("mistakeTimeline"),
  reviewSchedule: document.getElementById("reviewSchedule"),
  smartRetryPanel: document.getElementById("smartRetryPanel"),
  premoveQuizPanel: document.getElementById("premoveQuizPanel"),
  databaseTrainingList: document.getElementById("databaseTrainingList"),
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
  studyEvalScore: document.getElementById("studyEvalScore"),
  studyEvalFill: document.getElementById("studyEvalFill"),
  studyEvalCaption: document.getElementById("studyEvalCaption"),
  studyOpeningMeta: document.getElementById("studyOpeningMeta"),
  studyPositionLinks: document.getElementById("studyPositionLinks"),
  studyAnalysisMeta: document.getElementById("studyAnalysisMeta"),
  studyDatabaseMeta: document.getElementById("studyDatabaseMeta"),
  studyMoveMeta: document.getElementById("studyMoveMeta"),
  studyEngineLines: document.getElementById("studyEngineLines"),
  studyDatabaseMoves: document.getElementById("studyDatabaseMoves"),
  studyMoveClassifications: document.getElementById("studyMoveClassifications"),
  studyMoveTrail: document.getElementById("studyMoveTrail"),
  studyLichessToken: document.getElementById("studyLichessTokenInput"),
  studyEnginePath: document.getElementById("studyEnginePathInput"),
  studyDepth: document.getElementById("studyDepthInput"),
  studyThinkTime: document.getElementById("studyThinkTimeInput"),
  studyMultiPv: document.getElementById("studyMultiPvInput"),
  studyThreads: document.getElementById("studyThreadsInput"),
  studyHash: document.getElementById("studyHashInput"),
  studyApplySettings: document.getElementById("studyApplySettingsBtn"),
  studySettingsStatus: document.getElementById("studySettingsStatus"),
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
  boardPieceMap: {},
  selectedSquare: "",
  dragFrom: "",
  dragPiece: "",
  dragGhost: null,
  dragPointerId: null,
  dragMoved: false,
  dragStartX: 0,
  dragStartY: 0,
  suppressNextClick: false,
  lastMove: null,
  lastMoveClassification: null,
  lastMoveSan: "",
  pendingMoveAnimationKey: "",
  renderedMoveAnimationKey: "",
  moveAnimationTimer: 0,
  previousRenderedPieces: {},
  activeTrainingLine: [],
  activeTrainingLineSan: [],
  playedTrainingLine: [],
  playedTrainingLineSan: [],
  branchLocked: false,
  trainerPhase: "completed",
  previewLessonId: "",
  previewInsight: null,
  currentInsight: null,
  currentInsightKey: "",
  insightLoading: false,
  lastEvalCp: null,
  positionInsightCache: {},
  insightRequestId: 0,
  lessonLoadId: 0,
  manualNeedsWork: [],
  manualRepertoire: {},
  reviewStats: {},
  games: [],
  gameMoveTree: null,
  theoryResult: null,
  repertoireExportText: "",
  manualDriftChoices: {},
  analysisProgressTimer: 0,
  prepPackText: "",
};

async function init() {
  preloadClassificationIcons();
  el.username.value = defaults.username || "trixize1234";
  el.timeClasses.value = defaults.time_classes || "all";
  el.maxGames.value = defaults.max_games ?? 0;
  el.importAllGames.checked = Number(defaults.max_games ?? 0) === 0;
  el.lichessToken.value = defaults.lichess_token || "";
  el.enginePath.value = defaults.engine_path || "";
  el.depth.value = defaults.depth || 24;
  if (el.thinkTime) el.thinkTime.value = String(defaults.think_time_sec ?? 5);
  el.multiPv.value = defaults.multipv || 5;
  el.threads.value = defaults.threads || 8;
  el.hash.value = defaults.hash_mb || 2048;
  syncStudySettingsFromSetup();

  el.analyze.addEventListener("click", runAnalysis);
  el.importPgn?.addEventListener("click", importPgnGames);
  el.importAllGames?.addEventListener("change", syncImportScope);
  el.trainerReset?.addEventListener("click", resetTrainerLesson);
  el.trainerNext?.addEventListener("click", nextLesson);
  el.studyApplySettings?.addEventListener("click", () => { void saveStudySettings(); });
  el.generateTheory?.addEventListener("click", () => { void generateTheoryLine(); });
  [el.lichessToken, el.enginePath, el.depth, el.multiPv, el.threads, el.hash].forEach((input) => {
    input?.addEventListener("change", syncStudySettingsFromSetup);
  });
  el.thinkTime?.addEventListener("change", syncStudySettingsFromSetup);
  el.tabButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tabTarget || "setup"));
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const workLineButton = target.closest("[data-work-line]");
    const workLine = workLineButton instanceof HTMLElement ? workLineButton.dataset.workLine : "";
    if (workLine) {
      loadLessonById(workLine);
      return;
    }
    const lessonLaunchButton = target.closest("[data-lesson-launch]");
    const lessonId = lessonLaunchButton instanceof HTMLElement ? lessonLaunchButton.dataset.lessonLaunch : "";
    if (lessonId) {
      loadLessonById(lessonId);
      return;
    }
    const previewTrainButton = target.closest("[data-preview-train]");
    const previewTrain = previewTrainButton instanceof HTMLElement ? previewTrainButton.dataset.previewTrain : "";
    if (previewTrain) {
      loadLessonById(previewTrain);
      return;
    }
    const previewAddButton = target.closest("[data-preview-add-needs]");
    const previewAdd = previewAddButton instanceof HTMLElement ? previewAddButton.dataset.previewAddNeeds : "";
    if (previewAdd) {
      addLessonToNeedsWork(previewAdd);
      return;
    }
    const makeRepertoireButton = target.closest("[data-make-repertoire]");
    const makeRepertoire = makeRepertoireButton instanceof HTMLElement ? makeRepertoireButton.dataset.makeRepertoire : "";
    if (makeRepertoire) {
      saveManualRepertoireMove(makeRepertoire);
      return;
    }
    const exportPrepButton = target.closest("[data-export-prep-pack]");
    if (exportPrepButton instanceof HTMLElement) {
      exportPreparationPack(exportPrepButton);
      return;
    }
    const exportRepertoireButton = target.closest("[data-export-repertoire]");
    if (exportRepertoireButton instanceof HTMLElement) {
      exportRepertoireLines(exportRepertoireButton);
      return;
    }
    const driftChoiceButton = target.closest("[data-drift-choice]");
    const driftChoice = driftChoiceButton instanceof HTMLElement ? driftChoiceButton.dataset.driftChoice : "";
    if (driftChoice) {
      saveDriftChoice(driftChoice, driftChoiceButton.dataset.driftAction || "adopt", driftChoiceButton);
      return;
    }
    const theorySeedButton = target.closest("[data-theory-seed]");
    const theorySeed = theorySeedButton instanceof HTMLElement ? theorySeedButton.dataset.theorySeed : "";
    if (theorySeed) {
      if (el.theoryMove) el.theoryMove.value = theorySeed;
      setActiveTab("theory");
      void generateTheoryLine();
      return;
    }
    const openFenButton = target.closest("[data-open-fen]");
    const openFen = openFenButton instanceof HTMLElement ? openFenButton.dataset.openFen : "";
    if (openFen) {
      event.preventDefault();
      event.stopPropagation();
      void openFenOnAnalysisBoard(openFen, openFenButton.dataset.openLabel || "Analysis position");
      return;
    }
    const trainerMoveButton = target.closest("[data-trainer-move]");
    const trainerMove = trainerMoveButton instanceof HTMLElement ? trainerMoveButton.dataset.trainerMove : "";
    if (trainerMove) {
      const from = trainerMove.slice(0, 2);
      const to = trainerMove.slice(2, 4);
      void submitTrainerMove(from, to);
      return;
    }
    const copyButton = target.closest("[data-copy-study]");
    const copyKind = copyButton instanceof HTMLElement ? copyButton.dataset.copyStudy : "";
    if (copyKind) {
      void copyStudyValue(copyKind, copyButton);
      return;
    }
    const treeButton = target.closest("[data-tree-fen]");
    const treeFen = treeButton instanceof HTMLElement ? treeButton.dataset.treeFen : "";
    if (treeFen) {
      event.preventDefault();
      event.stopPropagation();
      void openMoveTreePosition(
        treeFen,
        treeButton.dataset.treeLabel || "",
        treeButton.dataset.treePerspective || ""
      );
    }
  });
  document.addEventListener("pointerdown", unlockAudio);
  document.addEventListener("pointermove", handleGlobalPointerMove);
  document.addEventListener("pointerup", handleGlobalPointerUp);
  document.addEventListener("pointercancel", clearDragState);

  syncImportScope();
  renderCoords();
  renderBoard(START_FEN, { animate: false });
  setActiveTab("setup");
  renderStudyWorkspace();
  await bootstrapLocalState();
  void initializeFreeAnalysisBoard();
}

function normalizeFen(fen) {
  return String(fen || "").trim() || START_FEN;
}

function syncStudySettingsFromSetup() {
  if (el.studyLichessToken) el.studyLichessToken.value = el.lichessToken?.value || defaults.lichess_token || "";
  if (el.studyEnginePath) el.studyEnginePath.value = el.enginePath?.value || "";
  if (el.studyDepth) el.studyDepth.value = el.depth?.value || defaults.depth || 24;
  if (el.studyThinkTime) el.studyThinkTime.value = String(el.thinkTime?.value || defaults.think_time_sec || 5);
  if (el.studyMultiPv) el.studyMultiPv.value = el.multiPv?.value || defaults.multipv || 5;
  if (el.studyThreads) el.studyThreads.value = el.threads?.value || defaults.threads || 8;
  if (el.studyHash) el.studyHash.value = el.hash?.value || defaults.hash_mb || 2048;
}

function applyStudySettingsToSetup(saved = {}) {
  if (el.lichessToken && Object.prototype.hasOwnProperty.call(saved, "lichess_token")) el.lichessToken.value = saved.lichess_token || "";
  if (el.enginePath && Object.prototype.hasOwnProperty.call(saved, "engine_path")) el.enginePath.value = saved.engine_path || "";
  if (el.depth && Object.prototype.hasOwnProperty.call(saved, "depth")) el.depth.value = saved.depth;
  if (el.thinkTime && Object.prototype.hasOwnProperty.call(saved, "think_time_sec")) el.thinkTime.value = String(saved.think_time_sec);
  if (el.multiPv && Object.prototype.hasOwnProperty.call(saved, "multipv")) el.multiPv.value = saved.multipv;
  if (el.threads && Object.prototype.hasOwnProperty.call(saved, "threads")) el.threads.value = saved.threads;
  if (el.hash && Object.prototype.hasOwnProperty.call(saved, "hash_mb")) el.hash.value = saved.hash_mb;
  syncStudySettingsFromSetup();
}

function applyDefaultsToState(saved = {}) {
  Object.entries(saved || {}).forEach(([key, value]) => {
    defaults[key] = value;
  });
}

function currentLichessToken() {
  const token = String(el.studyLichessToken?.value || el.lichessToken?.value || defaults.lichess_token || "").trim();
  return ["demo-token", "your-token", "lichess-token", "paste-token-here"].includes(token.toLowerCase()) ? "" : token;
}

function studyCopyValue(kind) {
  if (kind === "fen") return normalizeFen(state.boardFen);
  if (kind === "pgn") return currentPlayedLineSan().join(" ");
  return "";
}

async function copyStudyValue(kind, button) {
  const value = studyCopyValue(kind);
  if (!value) {
    if (button instanceof HTMLElement) button.textContent = kind === "fen" ? "No FEN yet" : "No PGN yet";
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    if (button instanceof HTMLElement) {
      const original = button.textContent;
      button.textContent = "Copied";
      window.setTimeout(() => { button.textContent = original || "Copy"; }, 900);
    }
  } catch {
    if (button instanceof HTMLElement) button.textContent = "Copy failed";
  }
}

function currentStudySettingsPayload() {
  return {
    lichess_token: currentLichessToken(),
    engine_path: String(el.studyEnginePath?.value || el.enginePath?.value || "").trim(),
    depth: Number(el.studyDepth?.value || el.depth?.value || defaults.depth || 24),
    think_time_sec: Number(el.studyThinkTime?.value || el.thinkTime?.value || defaults.think_time_sec || 5),
    multipv: Number(el.studyMultiPv?.value || el.multiPv?.value || defaults.multipv || 5),
    threads: Number(el.studyThreads?.value || el.threads?.value || defaults.threads || 8),
    hash_mb: Number(el.studyHash?.value || el.hash?.value || defaults.hash_mb || 2048),
  };
}

async function saveStudySettings() {
  if (!el.studyApplySettings) return;
  const payload = currentStudySettingsPayload();
  el.studyApplySettings.disabled = true;
  if (el.studySettingsStatus) {
    el.studySettingsStatus.textContent = "Saving Stockfish settings for live study...";
  }
  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not save study settings.");
    }
    applyDefaultsToState(data.defaults || {});
    applyStudySettingsToSetup(data.defaults || {});
    state.positionInsightCache = {};
    state.currentInsight = null;
    if (el.studySettingsStatus) {
      el.studySettingsStatus.textContent = "Saved. Live analysis now uses the new Stockfish settings.";
    }
    if (state.activeLessonId) {
      await updateCurrentInsight();
    } else {
      renderStudyWorkspace();
    }
  } catch (error) {
    if (el.studySettingsStatus) {
      el.studySettingsStatus.textContent = error.message || "Could not save study settings.";
    }
  } finally {
    el.studyApplySettings.disabled = false;
  }
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

function currentPieceMap(fen = state.boardFen) {
  const normalized = normalizeFen(fen);
  if (normalized === normalizeFen(state.boardFen) && state.boardPieceMap && Object.keys(state.boardPieceMap).length) {
    return state.boardPieceMap;
  }
  return pieceMapFromFen(normalized);
}

function rebuildLegalByFrom() {
  state.legalByFrom = {};
  state.legalMoves.forEach((move) => {
    if (!state.legalByFrom[move.from]) state.legalByFrom[move.from] = [];
    state.legalByFrom[move.from].push(move);
  });
}

function applyBoardState(payload, options = {}) {
  const { classification = null } = options;
  state.boardFen = normalizeFen(payload?.fen || state.boardFen);
  state.boardPieceMap = pieceMapFromFen(state.boardFen);
  state.legalMoves = Array.isArray(payload?.legal_moves) ? payload.legal_moves : [];
  rebuildLegalByFrom();
  if (!state.activeLessonId) {
    state.currentInsight = null;
    state.currentInsightKey = "";
    state.insightLoading = false;
  }
  const hasLastMove = Boolean(payload) && Object.prototype.hasOwnProperty.call(payload, "last_move");
  const hasPlayedSan = Boolean(payload) && Object.prototype.hasOwnProperty.call(payload, "played_san");
  if (hasLastMove) {
    state.lastMove = payload?.last_move || null;
    state.lastMoveClassification = classification;
    if (hasPlayedSan) {
      state.lastMoveSan = String(payload?.played_san || "");
    }
    state.pendingMoveAnimationKey = state.lastMove
      ? `${state.boardFen}|${state.lastMove.from}|${state.lastMove.to}|${state.lastMoveSan}`
      : "";
  } else if (classification) {
    state.lastMoveClassification = classification;
  }
  if (state.selectedSquare && !isSquareMovableByUser(state.selectedSquare, currentLesson(), state.boardFen)) {
    state.selectedSquare = "";
  }
  if (state.activeLessonId) {
    syncTrainerPhase(currentLesson());
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

function clearMoveAnimation() {
  if (state.moveAnimationTimer) {
    window.clearTimeout(state.moveAnimationTimer);
    state.moveAnimationTimer = 0;
  }
  if (el.boardWrap) {
    el.boardWrap.querySelectorAll(".piece-ghost").forEach((node) => node.remove());
  }
  if (el.board) {
    el.board.querySelectorAll(".piece-arriving").forEach((node) => {
      if (node instanceof HTMLElement) {
        node.classList.remove("piece-arriving");
        node.style.removeProperty("transition-duration");
      }
    });
  }
}

function animateLastMove(previousPieces) {
  if (!state.lastMove || !el.boardWrap) return;
  const { from, to } = state.lastMove;
  const movedPiece = previousPieces[from];
  if (!movedPiece) return;
  clearMoveAnimation();
  const durationMs = 1350;
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
    requestAnimationFrame(() => {
      ghost.style.transitionDuration = `${durationMs}ms`;
      ghost.style.transform = `translate(${toRect.left - fromRect.left}px, ${toRect.top - fromRect.top}px)`;
    });
  });

  state.moveAnimationTimer = window.setTimeout(() => {
    if (arrivingPiece instanceof HTMLElement) {
      arrivingPiece.classList.remove("piece-arriving");
    }
    ghost.remove();
    state.moveAnimationTimer = 0;
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

function arrowMetrics(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return null;
  const startX = from.x;
  const startY = from.y;
  const endX = to.x;
  const endY = to.y;
  const length = Math.hypot(endX - startX, endY - startY);
  if (length < 8) return null;
  return {
    x: startX,
    y: startY,
    length,
    angle: `${Math.atan2(dy, dx) * 180 / Math.PI}deg`,
  };
}

function renderArrowGroup(lines = [], role = "engine") {
  return lines.map((line, index) => {
    const uci = String(line?.uci || "");
    if (uci.length < 4) return "";
    const from = squareCenter(uci.slice(0, 2));
    const to = squareCenter(uci.slice(2, 4));
    if (!from || !to) return "";
    const emphasis = role === "threat" ? Math.max(0.48, 0.72 - index * 0.08) : Math.max(0.36, 0.62 - index * 0.06);
    const thickness = 20;
    const head = 34;
    const metrics = arrowMetrics(from, to);
    if (!metrics) return "";
    return `
      <div
        class="board-arrow ${role}-arrow"
        style="
          --arrow-x: ${metrics.x}px;
          --arrow-y: ${metrics.y}px;
          --arrow-length: ${metrics.length}px;
          --arrow-angle: ${metrics.angle};
          --arrow-thickness: ${thickness}px;
          --arrow-head: ${head}px;
          --arrow-opacity: ${emphasis};
        "
      ></div>
    `;
  }).join("");
}

function renderArrows(insight = null) {
  if (!el.boardArrows || !el.boardWrap) return;
  el.boardArrows.innerHTML = "";
  const engineLines = Array.isArray(insight?.candidate_lines) ? insight.candidate_lines.slice(0, 5) : [];
  const threatLines = Array.isArray(insight?.threat_lines) ? insight.threat_lines.slice(0, 3) : [];
  if (!engineLines.length && !threatLines.length) return;
  el.boardArrows.innerHTML = [
    renderArrowGroup(threatLines, "threat"),
    renderArrowGroup(engineLines, "engine"),
  ].join("");
}

function clearDragState() {
  if (state.dragGhost instanceof HTMLElement) {
    state.dragGhost.remove();
  }
  state.dragFrom = "";
  state.dragPiece = "";
  state.dragGhost = null;
  state.dragPointerId = null;
  state.dragMoved = false;
  state.dragStartX = 0;
  state.dragStartY = 0;
}

function updateDragGhostPosition(clientX, clientY) {
  if (!(state.dragGhost instanceof HTMLElement)) return;
  state.dragGhost.style.left = `${clientX}px`;
  state.dragGhost.style.top = `${clientY}px`;
}

function beginPieceDrag(squareName, piece, event) {
  const lesson = currentLesson();
  if (lesson && !canUserInteract(lesson)) return;
  if (!isSquareMovableByUser(squareName, lesson)) return;
  event.preventDefault();
  event.stopPropagation();
  state.dragFrom = squareName;
  state.dragPiece = piece;
  state.dragPointerId = event.pointerId ?? null;
  state.dragMoved = false;
  state.dragStartX = event.clientX;
  state.dragStartY = event.clientY;
  state.selectedSquare = squareName;
  if (state.dragGhost instanceof HTMLElement) {
    state.dragGhost.remove();
  }
  const ghost = document.createElement("img");
  ghost.className = "piece-drag-ghost";
  ghost.src = PIECE_ASSETS[piece] || "";
  ghost.alt = piece;
  state.dragGhost = ghost;
  el.boardWrap?.appendChild(ghost);
  updateDragGhostPosition(event.clientX, event.clientY);
  renderBoard(state.boardFen, { animate: false });
}

function handleGlobalPointerMove(event) {
  if (!state.dragFrom) return;
  if (state.dragPointerId !== null && event.pointerId !== state.dragPointerId) return;
  updateDragGhostPosition(event.clientX, event.clientY);
  const deltaX = event.clientX - state.dragStartX;
  const deltaY = event.clientY - state.dragStartY;
  if (Math.hypot(deltaX, deltaY) > 6) {
    state.dragMoved = true;
  }
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

function setProgress(value, message = "", options = {}) {
  const bounded = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const indeterminate = Boolean(options.indeterminate);
  if (el.progressFill) {
    el.progressFill.classList.toggle("indeterminate", indeterminate);
    if (!indeterminate) {
      el.progressFill.style.width = `${bounded}%`;
    }
  }
  if (message) {
    setStatus(message);
  }
  if (el.progressLabel) {
    el.progressLabel.textContent = indeterminate ? "Working" : `${bounded}%`;
  }
}

function stopAnalysisProgress() {
  if (state.analysisProgressTimer) {
    window.clearInterval(state.analysisProgressTimer);
    state.analysisProgressTimer = 0;
  }
}

function startAnalysisProgress() {
  stopAnalysisProgress();
  const startedAt = Date.now();
  setProgress(4, "Preparing import...");
  state.analysisProgressTimer = window.setInterval(() => {
    const elapsed = Date.now() - startedAt;
    let target = 12;
    let message = "Checking saved games...";
    if (elapsed >= 1200) {
      target = 24;
      message = "Reusing saved games or importing archives...";
    }
    if (elapsed >= 3000) {
      target = 38;
      message = "Importing games from Chess.com...";
    }
    if (elapsed >= 6500) {
      target = 56;
      message = "Building your repertoire map...";
    }
    if (elapsed >= 12000) {
      target = 72;
      message = "Analyzing repeated positions with Stockfish...";
    }
    if (elapsed >= 20000) {
      target = 84;
      message = "Finalizing trainer lines...";
    }
    if (elapsed >= 32000) {
      target = 96;
      message = "Still working. Stockfish is finishing the first lesson cache...";
    }
    const current = parseInt((el.progressFill?.style.width || "0").replace("%", ""), 10) || 0;
    if (current < target) {
      setProgress(current + 1, message, { indeterminate: elapsed >= 32000 });
    } else {
      if (elapsed >= 32000) {
        setProgress(target, message, { indeterminate: true });
        return;
      }
      setStatus(message);
    }
  }, 220);
}

function setActiveTab(name) {
  el.tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tabTarget === name);
  });
  el.tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tabPanel === name);
  });
  if (name === "trainer") {
    renderStudyWorkspace();
  }
}

async function runAnalysis() {
  startAnalysisProgress();
  el.analyze.disabled = true;
  try {
    const payload = await fetchProfilePayload(el.username.value.trim());
    state.payload = payload;
    state.reviewStats = payload.training_progress || loadReviewStats(payload.username);
    state.games = payload.games || [];
    renderProfile(payload);
    if (payload.cached) {
      setProgress(
        100,
        payload.explorer_enabled
          ? `Loaded cached repertoire for ${payload.username}. ${payload.games_imported} games are already indexed, and Lichess database is active.`
          : `Loaded cached repertoire for ${payload.username}. ${payload.games_imported} games are already indexed. Add a Lichess token for richer database branching.`
      );
    } else if (payload.reused_games) {
      setProgress(
        100,
        payload.explorer_enabled
          ? `Reused ${payload.games_imported} saved games and refreshed the analysis. Lichess database is active.`
          : `Reused ${payload.games_imported} saved games and refreshed the analysis. Add a Lichess token for richer database branching.`
      );
    } else {
      setProgress(
        100,
        payload.explorer_enabled
          ? `Imported ${payload.games_imported} games. Lichess database is active.`
          : `Imported ${payload.games_imported} games. Add a Lichess token for richer database branching.`
      );
    }
  } catch (error) {
    setProgress(0, error.message || "Bookup could not build your repertoire.");
  } finally {
    stopAnalysisProgress();
    el.analyze.disabled = false;
  }
}

async function importPgnGames() {
  const pgn = el.pgnImport?.value?.trim() || "";
  if (!pgn) {
    if (el.pgnImportStatus) el.pgnImportStatus.textContent = "Paste at least one PGN first.";
    return;
  }
  startAnalysisProgress();
  if (el.importPgn) el.importPgn.disabled = true;
  if (el.pgnImportStatus) el.pgnImportStatus.textContent = "Importing PGN and building local repertoire...";
  try {
    const response = await fetch("/api/import-pgn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: el.username.value.trim() || "PGN Player",
        pgn,
        player_color: "white",
        lichess_token: el.lichessToken.value.trim(),
        engine_path: el.enginePath.value.trim(),
        depth: Number(el.depth.value || defaults.depth || 24),
        multipv: Number(el.multiPv.value || defaults.multipv || 5),
        threads: Number(el.threads.value || defaults.threads || 8),
        hash_mb: Number(el.hash.value || defaults.hash_mb || 2048),
        think_time_sec: Number(el.thinkTime.value || defaults.think_time_sec || 5),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "PGN import failed.");
    state.payload = payload;
    state.reviewStats = payload.training_progress || loadReviewStats(payload.username);
    state.games = payload.games || [];
    renderProfile(payload);
    setProgress(100, `Imported ${payload.games_imported} PGN game${payload.games_imported === 1 ? "" : "s"} into your local Bookup workspace.`);
    if (el.pgnImportStatus) el.pgnImportStatus.textContent = "PGN import complete. The move tree, theory, and trainer are ready.";
  } catch (error) {
    setProgress(0, error.message || "PGN import failed.");
    if (el.pgnImportStatus) el.pgnImportStatus.textContent = error.message || "PGN import failed.";
  } finally {
    stopAnalysisProgress();
    if (el.importPgn) el.importPgn.disabled = false;
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
      lichess_token: currentLichessToken(),
      engine_path: el.enginePath.value.trim(),
      depth: Number(el.depth.value),
      think_time_sec: Number(el.thinkTime?.value || defaults.think_time_sec || 5),
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
      state.manualRepertoire = payload.training_summary?.manual_repertoire || {};
      state.manualDriftChoices = payload.training_summary?.manual_drift_choices || {};
      state.games = payload.games || [];
      renderProfile(state.payload);
      setProgress(
        100,
        payload.saved_at
          ? `Loaded your saved Bookup workspace for ${payload.username}.`
          : `Loaded local Bookup data for ${payload.username}.`
      );
    } else if (payload.profile) {
      state.reviewStats = payload.training_progress || {};
      setProgress(0, "Saved data is from an older Bookup version. Rebuild your repertoire to refresh it.");
    } else {
      state.reviewStats = loadReviewStats(username);
      setProgress(0, "Ready.");
    }
  } catch {
    state.reviewStats = loadReviewStats(el.username.value.trim() || "trixize1234");
    setProgress(0, "Ready.");
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
  state.gameMoveTree = profile.game_move_tree || profile.move_tree || null;
  state.manualNeedsWork = (payload.training_summary?.manual_needs_work || []);
  state.manualRepertoire = payload.training_summary?.manual_repertoire || {};
  state.manualDriftChoices = payload.training_summary?.manual_drift_choices || {};
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
  renderHealthDashboard(profile.health_dashboard || null);
  renderMemoryScores(profile.memory_scores || null);
  renderOpeningDrift(profile.opening_drift || null);
  renderPrepPack(profile.prep_pack || null);
  renderStudyPlan(profile.study_plan || null);
  renderConfidenceGraph(profile.confidence_graph || null);
  renderDriftFixes(profile.drift_fixes || null);
  renderImportSpeed(profile.import_speed_report || null);
  void refreshCacheDashboard();
  renderKnownArchive(profile.known_line_archive || []);
  renderTranspositionGroups(profile.transposition_groups || []);
  renderGameMoveTree(state.gameMoveTree);
  renderImproveList(el.urgentList, state.queueDue, "No due lines right now.");
  renderImproveList(el.sidelineList, state.queueNew, "No fresh lines waiting right now.");
  renderSuggestions(profile.repertoire_updates || []);
  renderMistakes(profile.opening_mistakes || []);
  renderMistakeHeatmap(profile.mistake_heatmap || null);
  renderMistakeTimeline(profile.mistake_timeline || null);
  renderReviewSchedule(profile.review_schedule || null);
  renderSmartRetry(profile.smart_retry || null);
  renderPremoveQuiz(profile.premove_quiz || null);
  renderDatabaseTraining(profile.database_training || []);
  renderTheoryPresets(profile.theory_v2 || null);
  renderOpponentSimulator(profile.opponent_simulator || null);
  renderTrapFinder(profile.blunder_traps || null);
  renderRepertoireExport(profile.repertoire_export || null);
  renderQueue();
  clearPreview();

  clearTrainer();
  renderStudyWorkspace();
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

function renderHealthDashboard(dashboard) {
  if (!el.healthDashboard) return;
  const cards = dashboard?.cards || [];
  if (!cards.length) {
    el.healthDashboard.className = "health-dashboard empty";
    el.healthDashboard.textContent = "Build your repertoire to see coverage, confidence, and today's study load.";
    return;
  }
  const coverage = dashboard.coverage_by_color || [];
  const weakest = dashboard.weakest_lines || [];
  const strongest = dashboard.strongest_lines || [];
  el.healthDashboard.className = "health-dashboard";
  el.healthDashboard.innerHTML = `
    <div class="health-card-grid">
      ${cards.map((card) => `
        <article class="health-card ${escapeHtml(card.tone || "")}">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
          <p>${escapeHtml(card.detail)}</p>
        </article>
      `).join("")}
    </div>
    <div class="health-columns">
      <article class="health-panel">
        <h3>Coverage by color</h3>
        ${coverage.map((row) => `
          <div class="health-bar-row">
            <div>
              <strong>${escapeHtml(row.color === "black" ? "Black" : "White")}</strong>
              <span>${Number(row.positions || 0)} positions · ${Number(row.due || 0)} due · ${Number(row.known || 0)} known</span>
            </div>
            <div class="health-bar"><span style="width:${Math.max(0, Math.min(100, Number(row.coverage || 0)))}%"></span></div>
            <b>${Number(row.coverage || 0).toFixed(0)}%</b>
          </div>
        `).join("") || "<p>No coverage data yet.</p>"}
      </article>
      <article class="health-panel">
        <h3>Weakest repeated branches</h3>
        ${weakest.map((item) => `
          <button class="health-line" type="button" data-work-line="${escapeHtml(item.lesson_id)}">
            <strong>${escapeHtml(item.line_label)}</strong>
            <span>${escapeHtml(item.your_repeated_move)} → ${escapeHtml(item.recommended_move)} · ${Number(item.repeat_mistake_count || 0)} misses</span>
          </button>
        `).join("") || "<p>No repeated problem branches right now.</p>"}
      </article>
      <article class="health-panel">
        <h3>Strongest known lines</h3>
        ${strongest.map((item) => `
          <button class="health-line" type="button" data-work-line="${escapeHtml(item.lesson_id)}">
            <strong>${escapeHtml(item.line_label)}</strong>
            <span>${escapeHtml(item.recommended_move)} · ${Number(item.repeat_count || 0)} repeats · ${Math.round(Number(item.confidence || 0))} confidence</span>
          </button>
        `).join("") || "<p>Known lines unlock once you repeatedly play the best move.</p>"}
      </article>
    </div>
  `;
}

function renderMemoryScores(memory) {
  if (!el.memoryScorePanel) return;
  if (!memory || (!memory.fragile_count && !memory.building_count && !memory.strong_count)) {
    el.memoryScorePanel.className = "stack empty";
    el.memoryScorePanel.textContent = "Memory scores will show up after Bookup has repeated positions to measure.";
    return;
  }
  const fragile = memory.fragile_lines || [];
  const strong = memory.strong_lines || [];
  el.memoryScorePanel.className = "stack";
  el.memoryScorePanel.innerHTML = `
    <div class="memory-score-hero">
      <strong>${Number(memory.average || 0).toFixed(0)}</strong>
      <span>average memory score</span>
    </div>
    <div class="memory-buckets">
      <span class="lesson-chip needs-work">${Number(memory.fragile_count || 0)} fragile</span>
      <span class="lesson-chip new">${Number(memory.building_count || 0)} building</span>
      <span class="lesson-chip known">${Number(memory.strong_count || 0)} strong</span>
    </div>
    <div class="mini-card-list">
      ${fragile.slice(0, 4).map((item) => `
        <button class="mini-card fragile" type="button" data-work-line="${escapeHtml(item.lesson_id)}">
          <strong>${escapeHtml(item.line_label)}</strong>
          <span>${Number(item.score || 0)} memory · train ${escapeHtml(item.recommended_move || "")}</span>
        </button>
      `).join("") || "<div class=\"line-note\">No fragile memory lines right now.</div>"}
      ${strong.slice(0, 2).map((item) => `
        <button class="mini-card strong" type="button" data-work-line="${escapeHtml(item.lesson_id)}">
          <strong>${escapeHtml(item.line_label)}</strong>
          <span>${Number(item.score || 0)} memory · ${escapeHtml(item.recommended_move || "")}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function renderOpeningDrift(drift) {
  if (!el.driftDetectorPanel) return;
  const sections = drift?.sections || [];
  if (!sections.length) {
    el.driftDetectorPanel.className = "stack empty";
    el.driftDetectorPanel.textContent = "Bookup will compare your recent first moves with your long-term repertoire after import.";
    return;
  }
  const alerts = drift?.alerts || [];
  el.driftDetectorPanel.className = "stack";
  el.driftDetectorPanel.innerHTML = `
    <div class="drift-alert ${alerts.length ? "active" : "quiet"}">
      <strong>${alerts.length ? `${alerts.length} repertoire drift signal${alerts.length === 1 ? "" : "s"}` : "No major drift"}</strong>
      <span>${alerts.length ? "Recent first moves changed compared with your larger sample." : "Recent games still match your usual first-move profile."}</span>
    </div>
    ${sections.map((section) => `
      <article class="drift-section">
        <div class="line-card-header">
          <div class="line-title">${section.color === "black" ? "Black" : "White"} first moves</div>
          <div class="line-badge">${Number(section.recent_games || 0)} recent / ${Number(section.games || 0)} games</div>
        </div>
        ${(section.moves || []).slice(0, 5).map((move) => `
          <div class="drift-row ${escapeHtml(move.tone || "stable")}">
            <strong>${escapeHtml(move.move || "")}</strong>
            <span>${Number(move.recent_pct || 0).toFixed(1)}% recent</span>
            <span>${Number(move.overall_pct || 0).toFixed(1)}% overall</span>
            <b>${Number(move.drift || 0) >= 0 ? "+" : ""}${Number(move.drift || 0).toFixed(1)}%</b>
          </div>
        `).join("") || "<div class=\"line-note\">No moves from this side yet.</div>"}
      </article>
    `).join("")}
  `;
}

function prepPackToText(pack) {
  if (!pack) return "";
  const lines = [pack.title || "Bookup preparation pack", ""];
  const addSection = (title, items, formatter) => {
    lines.push(title);
    if (!items?.length) {
      lines.push("- Nothing here yet.");
    } else {
      items.forEach((item, index) => lines.push(`${index + 1}. ${formatter(item)}`));
    }
    lines.push("");
  };
  addSection("Focus lines", pack.focus_lines || [], (item) => `${item.line_label}: play ${item.train}${item.instead_of ? ` instead of ${item.instead_of}` : ""}. ${item.continuation || ""}`);
  addSection("New later", pack.next_up || [], (item) => `${item.line_label}: ${item.move}. ${item.continuation || ""}`);
  addSection("Common replies", pack.common_replies || [], (item) => `${item.line_label}: against ${item.reply || "common reply"}, answer ${item.response || "the prepared move"}.`);
  addSection("Maintenance", pack.maintenance || [], (item) => `${item.line_label}: ${item.move} (${item.repeat_count || 0} repeats).`);
  return lines.join("\n");
}

function renderPrepPack(pack) {
  if (!el.prepPackPanel) return;
  const focus = pack?.focus_lines || [];
  const nextUp = pack?.next_up || [];
  const common = pack?.common_replies || [];
  const maintenance = pack?.maintenance || [];
  if (!focus.length && !nextUp.length && !common.length && !maintenance.length) {
    el.prepPackPanel.className = "stack empty";
    el.prepPackPanel.textContent = "Your compact study pack will show up once Bookup has lines to prepare.";
    state.prepPackText = "";
    return;
  }
  state.prepPackText = prepPackToText(pack);
  el.prepPackPanel.className = "stack";
  el.prepPackPanel.innerHTML = `
    <div class="prep-pack-actions">
      <span class="line-badge">Focus ${focus.length} · Replies ${common.length}</span>
      <button class="launch-btn" type="button" data-export-prep-pack="true">Export prep pack</button>
    </div>
    ${focus.slice(0, 4).map((item) => `
      <button class="mini-card prep" type="button" data-work-line="${escapeHtml(item.lesson_id)}">
        <strong>${escapeHtml(item.line_label || "Focus line")}</strong>
        <span>Play ${escapeHtml(item.train || "")}${item.instead_of ? ` instead of ${escapeHtml(item.instead_of)}` : ""}</span>
      </button>
    `).join("")}
    ${common.slice(0, 3).map((item) => `
      <div class="mini-card database">
        <strong>${escapeHtml(item.reply || "Common reply")}</strong>
        <span>${escapeHtml(item.line_label || "")} · answer ${escapeHtml(item.response || "")}</span>
      </div>
    `).join("")}
  `;
}

async function refreshCacheDashboard() {
  if (!el.cacheDashboard) return;
  try {
    const username = state.payload?.username || el.username?.value?.trim() || "trixize1234";
    const response = await fetch(`/api/cache-stats?username=${encodeURIComponent(username)}`);
    const stats = await response.json();
    if (!response.ok) throw new Error(stats.error || "Cache stats unavailable.");
    const mb = Number(stats.total_bytes || 0) / (1024 * 1024);
    el.cacheDashboard.className = "stack";
    el.cacheDashboard.innerHTML = `
      <div class="cache-meter">
        <strong>${Number(stats.engine_entries || 0)}</strong>
        <span>cached engine analyses</span>
      </div>
      <div class="chip-row">
        <span class="lesson-chip">Profiles ${Number(stats.profile_entries || 0)}</span>
        <span class="lesson-chip">Games ${Number(stats.game_entries || 0)}</span>
        <span class="lesson-chip">${mb.toFixed(2)} MB</span>
      </div>
      <div class="line-note">Repeated positions reuse this cache instead of asking Stockfish again.</div>
    `;
  } catch {
    el.cacheDashboard.className = "stack empty";
    el.cacheDashboard.textContent = "Cache stats are unavailable, but analysis caching will still work when Stockfish returns results.";
  }
}

function renderTranspositionGroups(groups) {
  if (!el.transpositionList) return;
  if (!groups.length) {
    el.transpositionList.className = "stack empty";
    el.transpositionList.textContent = "No repeated transposition groups found yet.";
    return;
  }
  el.transpositionList.className = "stack";
  el.transpositionList.innerHTML = groups.map((group, index) => `
    <article class="line-card transposition-card">
      <div class="line-card-header">
        <div>
          <div class="line-title">${index + 1}. ${escapeHtml((group.labels || [])[0] || "Shared position")}</div>
          <div class="tree-meta">${Number(group.positions || 0)} paths · ${Number(group.frequency || 0)} games · ${Math.round(Number(group.confidence || 0))} confidence</div>
        </div>
        ${group.position_identifier ? `<a class="launch-btn" href="${escapeHtml(group.position_identifier)}" target="_blank" rel="noopener noreferrer">Lichess analysis</a>` : ""}
      </div>
      <div class="line-note">${(group.labels || []).map(escapeHtml).join(" | ")}</div>
      <div class="chip-row">${(group.moves || []).map((move) => `<span class="lesson-chip">${escapeHtml(move)}</span>`).join("")}</div>
      <div class="chip-row">${(group.lesson_ids || []).slice(0, 3).map((id) => `<button class="launch-btn" type="button" data-work-line="${escapeHtml(id)}">Work branch</button>`).join("")}</div>
    </article>
  `).join("");
}

function renderMistakeHeatmap(heatmap) {
  if (!el.mistakeHeatmap) return;
  const squares = heatmap?.squares || [];
  if (!squares.length) {
    el.mistakeHeatmap.className = "heatmap-panel empty";
    el.mistakeHeatmap.textContent = "No repeated mistake clusters yet. One-off misses stay out of this heatmap.";
    return;
  }
  el.mistakeHeatmap.className = "heatmap-panel";
  el.mistakeHeatmap.innerHTML = `
    <div class="heatmap-grid">
      ${squares.map((item) => `
        <article class="heatmap-square" style="--heat:${Math.max(8, Math.min(100, Number(item.intensity || 0)))}%">
          <strong>${escapeHtml(item.square)}</strong>
          <span>${Number(item.score || 0).toFixed(0)} pressure</span>
          <small>${Number(item.sources || 0)} from · ${Number(item.targets || 0)} to</small>
        </article>
      `).join("")}
    </div>
    <div class="heatmap-lines">
      ${(heatmap.top_lines || []).map((item) => `
        <button class="health-line" type="button" data-work-line="${escapeHtml(item.lesson_id)}">
          <strong>${escapeHtml(item.line_label)}</strong>
          <span>${escapeHtml(item.your_repeated_move)} should become ${escapeHtml(item.recommended_move)} · ${Number(item.repeat_mistake_count || 0)} repeats</span>
        </button>
      `).join("")}
    </div>
  `;
}

function formatReviewTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "not worked yet";
  const diff = Date.now() - value;
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

function timelineProgressLabel(item, review) {
  if (!review || !Number(review.seen || 0)) return "untrained";
  if (review.last_result === "right" && Number(review.streak || 0) >= 2) return "improving";
  if (review.last_result === "right") return "recently fixed";
  if (review.last_result === "wrong") return "still missing";
  return "in progress";
}

function renderMistakeTimeline(timeline) {
  if (!el.mistakeTimeline) return;
  const items = timeline?.items || [];
  if (!items.length) {
    el.mistakeTimeline.className = "timeline-panel empty";
    el.mistakeTimeline.textContent = "No repeated mistake history yet. Bookup only adds positions here after they repeat.";
    return;
  }
  const summary = timeline.summary || {};
  el.mistakeTimeline.className = "timeline-panel";
  el.mistakeTimeline.innerHTML = `
    <div class="timeline-summary">
      <article><strong>${Number(summary.tracked || items.length)}</strong><span>tracked problems</span></article>
      <article><strong>${Number(summary.urgent || 0)}</strong><span>urgent</span></article>
      <article><strong>${Number(summary.active || 0)}</strong><span>active</span></article>
      <article><strong>${Number(summary.watch || 0)}</strong><span>watch</span></article>
    </div>
    <div class="timeline-list">
      ${items.map((item) => {
        const review = state.reviewStats[item.lesson_id] || null;
        const progress = timelineProgressLabel(item, review);
        const result = item.result_breakdown || {};
        return `
          <article class="timeline-item ${escapeHtml(item.severity || "watch")} ${escapeHtml(progress.replaceAll(" ", "-"))}">
            <div class="timeline-spine">
              <span class="timeline-dot"></span>
              <span class="timeline-line"></span>
            </div>
            <div class="timeline-card">
              <div class="line-card-header">
                <div>
                  <div class="line-title">${escapeHtml(item.line_label || item.opening_name || "Repeated position")}</div>
                  <div class="tree-meta">
                    First seen ${escapeHtml(item.first_seen_label || "unknown")} · last seen ${escapeHtml(item.last_seen_label || "unknown")}
                  </div>
                </div>
                <div class="line-badge ${escapeHtml(item.severity || "")}">${escapeHtml(progress)}</div>
              </div>
              <div class="timeline-move-row">
                <span>You play <strong>${escapeHtml(item.your_repeated_move || "?")}</strong></span>
                <span>Train <strong>${escapeHtml(item.recommended_move || "?")}</strong></span>
                <span>${Number(item.repeat_mistake_count || 0)} repeats</span>
              </div>
              <div class="timeline-metrics">
                <span>${Number(item.span_games || 0)} games between first and latest repeat</span>
                <span>${Number(item.value_lost_cp || 0).toFixed(0)}cp lost</span>
                <span>${Number(result.wins || 0)}W ${Number(result.draws || 0)}D ${Number(result.losses || 0)}L</span>
                <span>last worked ${formatReviewTime(review?.last_seen_at)}</span>
              </div>
              <div class="timeline-actions">
                <button class="launch-btn" type="button" data-work-line="${escapeHtml(item.lesson_id)}">Work this line</button>
                ${item.position_identifier ? `<a class="launch-btn" href="${escapeHtml(item.position_identifier)}" target="_blank" rel="noopener noreferrer">Open position</a>` : ""}
              </div>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderReviewSchedule(schedule) {
  if (!el.reviewSchedule) return;
  const groups = [
    ["Due today", schedule?.due_today || []],
    ["New later", schedule?.new_later || []],
    ["Known archive", schedule?.known_archive || []],
  ];
  if (!groups.some(([, items]) => items.length)) {
    el.reviewSchedule.className = "stack empty";
    el.reviewSchedule.textContent = "Review schedule will show up here once lines enter your queues.";
    return;
  }
  el.reviewSchedule.className = "stack review-schedule";
  el.reviewSchedule.innerHTML = groups.map(([title, items]) => `
    <article class="line-card">
      <div class="line-card-header">
        <div class="line-title">${escapeHtml(title)}</div>
        <div class="line-badge">${items.length}</div>
      </div>
      ${items.length ? items.map((item) => `
        <button class="schedule-row" type="button" data-work-line="${escapeHtml(item.lesson_id)}">
          <strong>${escapeHtml(item.line_label)}</strong>
          <span>${escapeHtml(item.interval)} · ${Math.round(Number(item.confidence || 0))} confidence</span>
        </button>
      `).join("") : `<div class="line-note">Nothing in this bucket.</div>`}
    </article>
  `).join("");
}

function renderStudyPlan(plan) {
  if (!el.studyPlanPanel) return;
  const blocks = plan?.blocks || [];
  if (!blocks.length) {
    el.studyPlanPanel.className = "stack empty";
    el.studyPlanPanel.textContent = "Bookup will build a short session plan after import.";
    return;
  }
  el.studyPlanPanel.className = "stack";
  el.studyPlanPanel.innerHTML = `
    <div class="study-plan-summary">
      <strong>${Number(plan.estimated_minutes || 0)} min</strong>
      <span>${escapeHtml(plan.summary || "Today's training plan is ready.")}</span>
    </div>
    ${blocks.map((block) => `
      <article class="plan-block">
        <div class="line-card-header">
          <div>
            <div class="line-title">${escapeHtml(block.title || "Study block")}</div>
            <div class="line-note">${escapeHtml(block.goal || "")}</div>
          </div>
          <span class="line-badge">${Number(block.minutes || 0)} min</span>
        </div>
        ${(block.items || []).slice(0, 4).map((item) => item.lesson_id ? `
          <button class="schedule-row" type="button" data-work-line="${escapeHtml(item.lesson_id)}">
            <strong>${escapeHtml(item.line_label || item.opponent_reply || "Study item")}</strong>
            <span>${escapeHtml(item.recommended_move || item.response || "")}</span>
          </button>
        ` : `<div class="line-note">${escapeHtml(item.line_label || item.opponent_reply || "Study item")}</div>`).join("") || `<div class="line-note">Nothing needed in this block yet.</div>`}
      </article>
    `).join("")}
  `;
}

function renderConfidenceGraph(graph) {
  if (!el.confidenceGraphPanel) return;
  const buckets = graph?.buckets || [];
  if (!buckets.length) {
    el.confidenceGraphPanel.className = "stack empty";
    el.confidenceGraphPanel.textContent = "Line confidence distribution will show up here.";
    return;
  }
  el.confidenceGraphPanel.className = "stack";
  el.confidenceGraphPanel.innerHTML = `
    <div class="confidence-total">${Number(graph.total || 0)} analyzed repertoire positions</div>
    <div class="confidence-bars">
      ${buckets.map((bucket) => `
        <div class="confidence-row ${escapeHtml(bucket.tone || "")}">
          <span>${escapeHtml(bucket.label)}</span>
          <div class="confidence-bar"><b style="width:${Math.max(3, Number(bucket.pct || 0))}%"></b></div>
          <strong>${Number(bucket.count || 0)}</strong>
        </div>
      `).join("")}
    </div>
    <div class="mini-card-list">
      ${(graph.slipping_lines || []).slice(0, 3).map((item) => `
        <button class="mini-card fragile" type="button" data-work-line="${escapeHtml(item.lesson_id)}">
          <strong>${escapeHtml(item.line_label)}</strong>
          <span>${Math.round(Number(item.confidence || 0))} confidence · ${escapeHtml(item.recommended_move || "")}</span>
        </button>
      `).join("") || `<div class="line-note">No slipping repeated lines.</div>`}
    </div>
  `;
}

function renderDriftFixes(fixes) {
  if (!el.driftFixPanel) return;
  const actions = fixes?.actions || [];
  if (!actions.length) {
    el.driftFixPanel.className = "stack empty";
    el.driftFixPanel.textContent = fixes?.summary || "No first-move drift needs action.";
    return;
  }
  el.driftFixPanel.className = "stack";
  el.driftFixPanel.innerHTML = `
    <div class="line-note">${escapeHtml(fixes.summary || "")}</div>
    ${actions.map((action) => {
      const saved = state.manualDriftChoices?.[action.id] || "";
      return `
        <article class="drift-fix-card">
          <div class="line-card-header">
            <div>
              <div class="line-title">${escapeHtml(action.move)} as ${escapeHtml(action.color)}</div>
              <div class="tree-meta">${Number(action.recent_pct || 0)}% recent · ${Number(action.overall_pct || 0)}% overall · ${Number(action.drift || 0)} drift</div>
            </div>
            ${saved ? `<span class="line-badge known">${escapeHtml(saved)}</span>` : ""}
          </div>
          <div class="chip-row">
            <button class="launch-btn" type="button" data-drift-choice="${escapeHtml(action.id)}" data-drift-action="adopt">${escapeHtml(action.adopt_text)}</button>
            <button class="ghost-btn" type="button" data-drift-choice="${escapeHtml(action.id)}" data-drift-action="repair">${escapeHtml(action.repair_text)}</button>
          </div>
        </article>
      `;
    }).join("")}
  `;
}

function renderImportSpeed(report) {
  if (!el.importSpeedPanel) return;
  if (!report) {
    el.importSpeedPanel.className = "stack empty";
    el.importSpeedPanel.textContent = "Import and cache diagnostics will show up here.";
    return;
  }
  const cards = [
    ["Games indexed", report.games_indexed],
    ["Positions indexed", report.positions_indexed],
    ["Repeated positions", report.repeated_positions],
    ["Analyzed", report.positions_analyzed],
    ["Lessons", report.lessons_created],
    ["Skipped by filter", report.positions_skipped],
  ];
  el.importSpeedPanel.className = "stack";
  el.importSpeedPanel.innerHTML = `
    <div class="speed-grid">
      ${cards.map(([label, value]) => `<div class="speed-card"><span>${escapeHtml(label)}</span><strong>${Number(value || 0)}</strong></div>`).join("")}
    </div>
    <div class="line-note">${escapeHtml(report.cache_key || "engine cache")}</div>
    ${(report.notes || []).map((note) => `<div class="line-note">- ${escapeHtml(note)}</div>`).join("")}
  `;
}

function renderSmartRetry(retry) {
  if (!el.smartRetryPanel) return;
  const deck = retry?.deck || [];
  if (!deck.length) {
    el.smartRetryPanel.className = "stack empty";
    el.smartRetryPanel.textContent = "Smart retry cards will show up when repeated misses are due.";
    return;
  }
  el.smartRetryPanel.className = "stack";
  el.smartRetryPanel.innerHTML = deck.slice(0, 10).map((item) => `
    <button class="line-card retry-card" type="button" data-work-line="${escapeHtml(item.lesson_id)}">
      <div class="line-card-header">
        <div class="line-title">${escapeHtml(item.line_label)}</div>
        <span class="line-badge needs-work">${escapeHtml(item.retry_interval || "retry")}</span>
      </div>
      <div class="line-note">${escapeHtml(item.reason || "")}</div>
      <div class="line-preview">Play ${escapeHtml(item.recommended_move || "")}</div>
    </button>
  `).join("");
}

function renderPremoveQuiz(quiz) {
  if (!el.premoveQuizPanel) return;
  const cards = quiz?.cards || [];
  if (!cards.length) {
    el.premoveQuizPanel.className = "stack empty";
    el.premoveQuizPanel.textContent = "Pre-move quiz cards will show up here.";
    return;
  }
  el.premoveQuizPanel.className = "stack";
  el.premoveQuizPanel.innerHTML = cards.slice(0, 10).map((item) => `
    <article class="quiz-card">
      <strong>${escapeHtml(item.prompt || "What would you play here?")}</strong>
      <div class="line-note">Answer: ${escapeHtml(item.answer || "")}</div>
      <div class="chip-row">
        <button class="launch-btn" type="button" data-work-line="${escapeHtml(item.lesson_id)}">Try on board</button>
      </div>
    </article>
  `).join("");
}

function renderTheoryPresets(theory) {
  if (!el.theoryPresetPanel) return;
  const seeds = theory?.seeds || [];
  if (!seeds.length) {
    el.theoryPresetPanel.className = "stack empty";
    el.theoryPresetPanel.textContent = "Bookup will suggest theory seeds after import.";
    return;
  }
  el.theoryPresetPanel.className = "stack";
  el.theoryPresetPanel.innerHTML = seeds.slice(0, 10).map((seed) => `
    <button class="mini-card theory-seed" type="button" data-theory-seed="${escapeHtml(seed.move || "")}">
      <strong>${escapeHtml(seed.label || "Generate theory")}</strong>
      <span>${escapeHtml(seed.line_label || "")} · ${escapeHtml(seed.move || "")}</span>
    </button>
  `).join("");
}

function renderOpponentSimulator(simulator) {
  if (!el.opponentSimulatorPanel) return;
  const scenarios = simulator?.scenarios || [];
  if (!scenarios.length) {
    el.opponentSimulatorPanel.className = "stack empty";
    el.opponentSimulatorPanel.textContent = "Opponent simulator scenarios will show up here.";
    return;
  }
  el.opponentSimulatorPanel.className = "stack";
  el.opponentSimulatorPanel.innerHTML = scenarios.slice(0, 8).map((scenario) => `
    <article class="line-card simulator-card">
      <div class="line-card-header">
        <div class="line-title">${escapeHtml(scenario.line_label || "Scenario")}</div>
        <span class="line-badge">${Number(scenario.popularity || 0)}%</span>
      </div>
      <div class="line-note">Opponent tries <strong>${escapeHtml(scenario.opponent_reply || "common reply")}</strong>; answer <strong>${escapeHtml(scenario.response || "")}</strong>.</div>
      <button class="launch-btn" type="button" data-work-line="${escapeHtml(scenario.lesson_id)}">Practice scenario</button>
    </article>
  `).join("");
}

function renderTrapFinder(traps) {
  if (!el.trapFinderPanel) return;
  const items = traps?.items || [];
  if (!items.length) {
    el.trapFinderPanel.className = "stack empty";
    el.trapFinderPanel.textContent = "No high-signal trap candidates yet.";
    return;
  }
  el.trapFinderPanel.className = "stack";
  el.trapFinderPanel.innerHTML = items.slice(0, 8).map((item) => `
    <article class="line-card trap-card">
      <div class="line-card-header">
        <div>
          <div class="line-title">${escapeHtml(item.line_label || "Trap")}</div>
          <div class="tree-meta">Trigger: ${escapeHtml(item.trigger || "common reply")}</div>
        </div>
        <span class="line-badge needs-work">${Number(item.value_lost_cp || 0) || Number(item.frequency || 0)}</span>
      </div>
      <div class="line-note">Punish with <strong>${escapeHtml(item.punish_with || "")}</strong>. ${escapeHtml(item.why || "")}</div>
      <button class="launch-btn" type="button" data-work-line="${escapeHtml(item.lesson_id)}">Work trap</button>
    </article>
  `).join("");
}

function renderRepertoireExport(exportPayload) {
  if (!el.repertoireExportPanel) return;
  state.repertoireExportText = exportPayload?.text || "";
  if (!state.repertoireExportText) {
    el.repertoireExportPanel.className = "stack empty";
    el.repertoireExportPanel.textContent = "Export will show up here after import.";
    return;
  }
  el.repertoireExportPanel.className = "stack";
  el.repertoireExportPanel.innerHTML = `
    <div class="line-note">${Number(exportPayload.line_count || 0)} prepared lines ready to export.</div>
    <button class="launch-btn" type="button" data-export-repertoire="true">Download repertoire export</button>
  `;
}

function renderDatabaseTraining(items) {
  if (!el.databaseTrainingList) return;
  if (!items.length) {
    el.databaseTrainingList.className = "stack empty";
    el.databaseTrainingList.textContent = "Import games with database context to prepare against common replies.";
    return;
  }
  el.databaseTrainingList.className = "stack";
  el.databaseTrainingList.innerHTML = items.slice(0, 8).map((item) => {
    const reply = item.top_database_reply || {};
    const moves = item.database_moves || [];
    return `
      <article class="line-card response-builder-card">
        <div class="line-card-header">
          <div>
            <div class="line-title">${escapeHtml(item.line_label)}</div>
            <div class="tree-meta">Most common reply: ${escapeHtml(reply.san || reply.uci || "unknown")} · ${Number(reply.popularity || 0)}%</div>
          </div>
          <button class="launch-btn" type="button" data-work-line="${escapeHtml(item.lesson_id)}">Train it</button>
        </div>
        <div class="line-note">Recommended response: <strong>${escapeHtml(item.recommended_move)}</strong></div>
        <div class="chip-row">${moves.map((move) => `<span class="lesson-chip">${escapeHtml(move.san || move.uci)} ${Number(move.popularity || 0)}%</span>`).join("")}</div>
      </article>
    `;
  }).join("");
}

function renderGameMoveTree(tree) {
  if (!el.gameMoveTree) return;
  const splits = tree?.by_player_color || {};
  const sections = [
    {
      key: "white",
      title: "Your White games",
      note: "Branches from games where you had the white pieces.",
      count: Number(splits.white?.total_games || tree?.player_color_counts?.white || 0),
      children: splits.white?.root?.children || [],
    },
    {
      key: "black",
      title: "Your Black games",
      note: "Branches from games where you had the black pieces.",
      count: Number(splits.black?.total_games || tree?.player_color_counts?.black || 0),
      children: splits.black?.root?.children || [],
    },
  ];
  const hasAnyNode = sections.some((section) => section.children.length) || (tree?.root?.children || []).length;
  if (!hasAnyNode) {
    el.gameMoveTree.className = "move-tree empty";
    el.gameMoveTree.textContent = "Import games to build your move tree.";
    return;
  }
  el.gameMoveTree.className = "move-tree";
  const totalGames = Number(tree?.total_games || 0);
  el.gameMoveTree.innerHTML = `
    <div class="move-tree-summary">
      <span>${totalGames} imported games</span>
      <span>${sections[0].count} as White</span>
      <span>${sections[1].count} as Black</span>
      <span>Top ${tree?.max_children || 8} replies per branch</span>
      <span>${tree?.max_depth || 20} plies deep</span>
    </div>
    <div class="move-tree-perspectives">
      ${sections.map((section) => renderMoveTreePerspective(section)).join("")}
    </div>
  `;
}

function renderMoveTreePerspective(section) {
  const children = section.children || [];
  const firstLayer = children.slice(0, 14);
  return `
    <section class="move-tree-panel ${escapeHtml(section.key)}">
      <div class="move-tree-panel-head">
        <div>
          <h3>${escapeHtml(section.title)}</h3>
          <p>${escapeHtml(section.note)}</p>
        </div>
        <span>${section.count} games</span>
      </div>
      ${
        children.length
          ? `
            <div class="move-tree-map-view">
              <div class="move-tree-origin-card">
                <span>Imported ${escapeHtml(section.key)} games</span>
                <strong>${section.count}</strong>
                <small>game${section.count === 1 ? "" : "s"}</small>
              </div>
              <div class="move-tree-map-branches">
                ${firstLayer.map((node) => renderMoveTreeMapNode(node, section.key)).join("")}
              </div>
            </div>
            <details class="move-tree-deep" open>
              <summary>Deep branch explorer</summary>
              <div class="move-tree-root">${children.map((node) => renderMoveTreeNode(node, 0, section.key)).join("")}</div>
            </details>
          `
          : `<div class="move-tree-empty">No imported games from this side yet.</div>`
      }
    </section>
  `;
}

function renderMoveTreeMapNode(node, perspective = "") {
  const opening = joinMetaParts([node?.opening_name || "", node?.opening_code || ""]);
  const label = `${node?.path_san?.join(" ") || node?.san || ""}`.trim();
  const role = node?.move_role || (node?.role === "player" ? "your move" : "opponent reply");
  const popularity = Number(node?.popularity || 0);
  const weight = Math.max(2, Math.min(22, popularity / 2.2));
  return `
    <div class="move-tree-map-branch" style="--branch-weight:${weight}px">
      <div class="move-tree-map-label">
        <strong>${opening ? escapeHtml(opening) : escapeHtml(role)}</strong>
        <span>${escapeHtml(role)} · ${Number(node?.count || 0)} games</span>
      </div>
      <span class="move-tree-map-line"></span>
      <button class="move-tree-map-node ${node?.role === "player" ? "player" : "opponent"}" type="button" data-tree-fen="${escapeHtml(node?.position_fen || "")}" data-tree-label="${escapeHtml(label || node?.san || "")}" data-tree-perspective="${escapeHtml(perspective || node?.perspective || "")}" title="Open this imported-game position">
        <strong>${escapeHtml(node?.san || "")}</strong>
        <span class="move-tree-map-percent">${popularity.toFixed(popularity >= 10 ? 0 : 1)}%</span>
        <span class="move-tree-plus">+</span>
      </button>
    </div>
  `;
}

function renderMoveTreeNode(node, depth = 0, perspective = "") {
  const children = Array.isArray(node?.children) ? node.children : [];
  const hasChildren = children.length > 0 && depth < 8;
  const opening = joinMetaParts([node?.opening_name || "", node?.opening_code || ""]);
  const label = `${node?.path_san?.join(" ") || node?.san || ""}`.trim();
  const role = node?.move_role || (node?.role === "player" ? "your move" : "opponent reply");
  const safeFen = escapeHtml(node?.position_fen || "");
  const safeLabel = escapeHtml(label || node?.san || "");
  const safePerspective = escapeHtml(perspective || node?.perspective || "");
  const row = `
    <div class="move-tree-row" style="--depth:${depth}">
      <div class="move-tree-branch">
        <span class="move-tree-connector"></span>
        <button class="move-tree-circle" type="button" data-tree-fen="${safeFen}" data-tree-label="${safeLabel}" data-tree-perspective="${safePerspective}" title="Open this position on the analysis board">
          <span class="move-tree-san">${escapeHtml(node?.san || "")}</span>
          <span class="move-tree-plus">+</span>
        </button>
        <div class="move-tree-copy">
          <div class="move-tree-role ${node?.role === "player" ? "player" : "opponent"}">${escapeHtml(role)}</div>
          ${opening ? `<div class="move-tree-opening">${escapeHtml(opening)}</div>` : ""}
          <div class="move-tree-path">${escapeHtml(label)}</div>
        </div>
      </div>
      <div class="move-tree-stats">
        <span>${Number(node?.count || 0)}x</span>
        <span>${Number(node?.popularity || 0).toFixed(1)}%</span>
        <span>${Number(node?.player_share || 0).toFixed(0)}% yours</span>
        <span>White score ${Number(node?.white_score || 0).toFixed(1)}%</span>
      </div>
    </div>
  `;
  if (!hasChildren) {
    return `<article class="move-tree-node leaf">${row}</article>`;
  }
  const open = depth < 2 ? "open" : "";
  return `
    <details class="move-tree-node" ${open}>
      <summary>${row}</summary>
      <div class="move-tree-children">
        ${children.map((child) => renderMoveTreeNode(child, depth + 1, perspective)).join("")}
      </div>
    </details>
  `;
}

async function openMoveTreePosition(fen, label = "", perspective = "") {
  if (!fen) return;
  state.activeLessonId = "";
  state.previewLessonId = "";
  state.boardFen = fen;
  state.startFen = fen;
  state.boardOrientation = perspective === "black" ? "black" : "white";
  state.selectedSquare = "";
  state.dragFrom = "";
  state.lastMove = null;
  state.lastMoveClassification = null;
  state.currentInsight = null;
  state.currentInsightKey = "";
  state.playedTrainingLine = [];
  state.playedTrainingLineSan = [];
  state.legalMoves = [];
  state.legalByFrom = {};
  setActiveTab("trainer");
  renderCoords();
  renderBoard(fen, { animate: false });
  renderStudyWorkspace();
  el.boardTitle.textContent = label ? `Tree position after ${label}` : "Move tree position";
  el.boardSummary.textContent = "Loaded from your imported move tree. You can now explore it freely on the analysis board.";
  await refreshLegalMoves(fen);
  renderBoard(fen, { animate: false });
  await updateFreeAnalysisInsight();
}

async function openFenOnAnalysisBoard(fen, label = "Analysis position") {
  if (!fen) return;
  state.activeLessonId = "";
  state.previewLessonId = "";
  state.boardFen = fen;
  state.startFen = fen;
  state.selectedSquare = "";
  state.dragFrom = "";
  state.lastMove = null;
  state.lastMoveClassification = null;
  state.currentInsight = null;
  state.currentInsightKey = "";
  state.playedTrainingLine = [];
  state.playedTrainingLineSan = [];
  setActiveTab("trainer");
  renderCoords();
  renderBoard(fen, { animate: false });
  renderStudyWorkspace();
  if (el.boardTitle) el.boardTitle.textContent = label;
  if (el.boardSummary) el.boardSummary.textContent = "Loaded as a free analysis position. You can drag or click any legal move for the side to move.";
  await refreshLegalMoves(fen);
  renderBoard(fen, { animate: false });
  await updateFreeAnalysisInsight();
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
          <span class="lesson-chip">Memory ${Math.round(Number(item.memory_score || 0))}</span>
          <span class="lesson-chip">Repeated ${item.your_top_move_count || 0}x</span>
        </div>
        <div class="line-note">${escapeHtml(item.coach_explanation || "")}</div>
        <div class="chip-row">
          <button class="launch-btn" type="button" data-work-line="${escapeHtml(item.lesson_id)}">Work on line</button>
          <button class="launch-btn" type="button" data-make-repertoire="${escapeHtml(item.lesson_id)}">Make this my repertoire</button>
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
  el.previewPanel.textContent = "Use Work on line on any repertoire card to open that exact branch in the Trainer.";
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
      <button class="launch-btn" type="button" data-preview-add-needs="${escapeHtml(lesson.lesson_id)}">Add to Needs Work</button>
      <button class="launch-btn" type="button" data-preview-train="${escapeHtml(lesson.lesson_id)}">Start training</button>
      <button class="launch-btn" type="button" data-make-repertoire="${escapeHtml(lesson.lesson_id)}">Make this my repertoire</button>
      ${lesson.position_identifier ? `<a class="launch-btn" href="${lesson.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(lesson.position_identifier_label || "Lichess analysis")}</a>` : ""}
    </div>
  `;
}

function computeEvalPercent(evalCp) {
  const score = Number(evalCp || 0);
  const logistic = 1 / (1 + Math.exp(-score / 180));
  return Math.max(6, Math.min(94, Math.round(logistic * 100)));
}

function evalCaption(evalCp) {
  const score = Number(evalCp || 0);
  if (Math.abs(score) < 25) return "Equal";
  if (score > 0) return "White edge";
  return "Black edge";
}

function renderStudyEngineLine(line, index) {
  const title = `${index + 1}. ${escapeHtml(line?.move || "")}`;
  const classification = classificationBadge(line?.classification, "compact");
  const evalText = formatEval(line?.score_cp_white ?? line?.score_cp ?? 0);
  const detail = escapeHtml(line?.purpose || "");
  const preview = escapeHtml(line?.line_san || "");
  return `
    <article class="study-engine-line">
      <div class="study-engine-head">
        <div>
          <div class="study-engine-title">${title} ${classification}</div>
          <div class="study-engine-meta">${evalText} | ${escapeHtml(line?.source || "engine")}</div>
        </div>
        <div class="line-badge">${Math.round(Number(line?.popularity || 0))}%</div>
      </div>
      <div class="study-engine-preview">${detail}</div>
      <div class="study-engine-preview">${preview || "No continuation loaded yet."}</div>
      ${line?.uci ? `<button class="tiny-action" type="button" data-trainer-move="${escapeHtml(line.uci)}">Try ${escapeHtml(line.move || line.uci)}</button>` : ""}
    </article>
  `;
}

function renderStudyDatabaseMove(line, candidateMap = {}) {
  const san = escapeHtml(line?.san || line?.uci || "");
  const count = Number(line?.games || 0);
  const popularity = Number(line?.popularity || 0);
  const candidate = candidateMap[String(line?.uci || "")] || null;
  const badge = classificationBadge(candidate?.classification, "compact");
  return `
    <article class="study-database-row">
      <div class="study-database-head">
        <div>
          <div class="study-database-title">${san} ${badge}</div>
          <div class="study-database-meta">${count} games | ${popularity}% popularity</div>
        </div>
        ${candidate?.move ? `<div class="line-badge">${escapeHtml(candidate.move)}</div>` : ""}
      </div>
      <div class="study-database-preview">${candidate?.line_san ? escapeHtml(candidate.line_san) : "Practical move from the Lichess database."}</div>
      ${line?.uci ? `<button class="tiny-action" type="button" data-trainer-move="${escapeHtml(line.uci)}">Play database move</button>` : ""}
    </article>
  `;
}

function renderStudyMoveCard(title, san, classification, copy) {
  return `
    <article class="study-move-card">
      <div class="study-move-card-head">
        <div>
          <div class="study-move-card-title">${escapeHtml(title)}</div>
          <div class="study-move-card-meta">${escapeHtml(san || "No move yet")}</div>
        </div>
        ${classificationBadge(classification, "compact")}
      </div>
      <div class="study-move-copy">${escapeHtml(copy || "")}</div>
    </article>
  `;
}

function renderStudyReviewMarkup(lesson, playedMoveSan, playedClassification, recommendedMove, recommendedClassification, coachText = "") {
  if (!playedMoveSan) {
    const fallbackMove = recommendedMove || lesson?.best_reply || "No move yet";
    const fallbackCopy = coachText || "Bookup will classify the move you play here, then compare it with the current engine recommendation.";
    return renderStudyMoveCard("Recommended move", fallbackMove, recommendedClassification, fallbackCopy);
  }
  const key = classificationKey(playedClassification);
  const icon = String(playedClassification?.icon || MOVE_CLASSIFICATION_ICONS[key] || "").trim();
  const headline = classificationDisplayMessage(playedMoveSan, playedClassification) || `${playedMoveSan} was played`;
  const detail = String(playedClassification?.reason || coachText || "Bookup classified the move from the live position.").trim();
  const bestAlternative = (
    recommendedMove
    && recommendedMove !== playedMoveSan
    && !INALTERABLE_CLASSIFICATION_KEYS.has(key)
  ) ? `Best was ${recommendedMove}.` : "";
  const openingFooter = lesson?.opening_name ? `<div class="study-review-opening">${escapeHtml(lesson.opening_name)}</div>` : "";
  return `
    <article class="study-classified-card ${key ? `classification-${escapeHtml(key)}` : ""}">
      <div class="study-classified-main">
        ${icon ? `<img class="study-classified-icon" src="${icon}" alt="${escapeHtml(playedClassification?.label || "")}" />` : ""}
        <div class="study-classified-copy">
          <div class="study-classified-title">${escapeHtml(headline)}</div>
          <div class="study-classified-detail">${escapeHtml(detail)}</div>
          ${bestAlternative ? `<div class="study-classified-alt">Best was <strong>${escapeHtml(recommendedMove)}</strong>${classificationBadge(recommendedClassification, "compact")}</div>` : ""}
        </div>
      </div>
      ${openingFooter}
    </article>
  `;
}

function renderStudyMoveTrailMarkup() {
  const tokens = currentPlayedLineSan();
  if (!tokens.length) {
    return "No played line yet.";
  }
  const startFen = normalizeFen(state.startFen || START_FEN);
  const fenParts = startFen.split(/\s+/);
  let moveNumber = Number(fenParts[5] || 1);
  let side = sideToMove(startFen);
  const rows = [];
  let currentRow = null;
  tokens.forEach((token, index) => {
    const isCurrent = index === tokens.length - 1;
    if (side === "w") {
      currentRow = {
        moveNumber,
        white: token,
        whiteCurrent: isCurrent,
      };
      side = "b";
      return;
    }
    if (!currentRow) currentRow = { moveNumber };
    currentRow.black = token;
    currentRow.blackCurrent = isCurrent;
    rows.push(currentRow);
    currentRow = null;
    moveNumber += 1;
    side = "w";
  });
  if (currentRow) rows.push(currentRow);
  const renderPlyToken = (token, isCurrent) => {
    if (!token) return `<span class="study-ply-token empty">...</span>`;
    return `<span class="study-ply-token ${isCurrent ? "current" : ""}">${escapeHtml(token)}${isCurrent ? classificationBadge(state.lastMoveClassification, "compact") : ""}</span>`;
  };
  return rows.map((row) => `
    <div class="study-ply-row">
      <span class="study-ply-number">${row.moveNumber}.</span>
      ${renderPlyToken(row.white, row.whiteCurrent)}
      ${renderPlyToken(row.black, row.blackCurrent)}
    </div>
  `).join("");
}

function currentLiveInsight(lesson = currentLesson()) {
  if (!lesson) return state.currentInsight || null;
  const expectedKey = insightCacheKey(lesson);
  if (state.positionInsightCache[expectedKey]) {
    return state.positionInsightCache[expectedKey];
  }
  if (!state.currentInsight) return null;
  return state.currentInsightKey === expectedKey ? state.currentInsight : null;
}

function isCurrentInsightRequest(lesson, cacheKey, requestId, loadId = state.lessonLoadId) {
  return Boolean(
    lesson
    && loadId === state.lessonLoadId
    && requestId === state.insightRequestId
    && state.activeLessonId === lesson.lesson_id
    && cacheKey === insightCacheKey(lesson)
  );
}

function rootRecommendedEntry(lesson) {
  if (!lesson || state.trainingCursor !== lessonRootCursor(lesson)) return null;
  const preferred = String(lesson.preferred_branch_uci || "").trim();
  if (!preferred) return null;
  return (state.legalMoves || []).find((move) => move.uci === preferred) || null;
}

function currentRecommendedMoveData(lesson = currentLesson(), insight = currentLiveInsight(lesson)) {
  if (!lesson) {
    return { san: "", uci: "", classification: null };
  }
  const expectedUci = liveExpectedMoveUci(lesson);
  const expectedEntry = expectedUci
    ? (state.legalMoves || []).find((move) => move.uci === expectedUci) || null
    : null;
  if (expectedEntry) {
    return {
      san: String(expectedEntry.san || ""),
      uci: String(expectedEntry.uci || ""),
      classification: insight?.recommended_classification || null,
    };
  }
  if (insight?.recommended_move || insight?.recommended_move_uci) {
    return {
      san: String(insight.recommended_move || ""),
      uci: String(insight.recommended_move_uci || ""),
      classification: insight.recommended_classification || null,
    };
  }
  const preferredEntry = rootRecommendedEntry(lesson);
  if (preferredEntry) {
    return {
      san: String(preferredEntry.san || ""),
      uci: String(preferredEntry.uci || ""),
      classification: lesson.recommended_classification || null,
    };
  }
  return { san: "", uci: "", classification: null };
}

function currentAnalysisRecommendation(lesson = currentLesson(), insight = currentLiveInsight(lesson)) {
  if (!lesson) {
    if (insight?.recommended_move || insight?.recommended_move_uci) {
      return {
        san: String(insight.recommended_move || ""),
        uci: String(insight.recommended_move_uci || ""),
        classification: insight.recommended_classification || null,
      };
    }
    const candidate = Array.isArray(insight?.candidate_lines) && insight.candidate_lines.length
      ? insight.candidate_lines[0]
      : null;
    if (candidate?.move || candidate?.uci) {
      return {
        san: String(candidate.move || ""),
        uci: String(candidate.uci || ""),
        classification: candidate.classification || null,
      };
    }
    return { san: "", uci: "", classification: null };
  }
  if (insight?.recommended_move || insight?.recommended_move_uci) {
    return {
      san: String(insight.recommended_move || ""),
      uci: String(insight.recommended_move_uci || ""),
      classification: insight.recommended_classification || null,
    };
  }
  const candidate = Array.isArray(insight?.candidate_lines) && insight.candidate_lines.length
    ? insight.candidate_lines[0]
    : null;
  if (candidate?.move || candidate?.uci) {
    return {
      san: String(candidate.move || ""),
      uci: String(candidate.uci || ""),
      classification: candidate.classification || null,
    };
  }
  return {
    san: String(lesson.best_reply || ""),
    uci: String(lesson.best_reply_uci || ""),
    classification: lesson.recommended_classification || null,
  };
}

function currentThinkTimeLabel() {
  const thinkTimeValue = Number(el.studyThinkTime?.value || el.thinkTime?.value || defaults.think_time_sec || 5);
  return thinkTimeValue > 0 ? `${thinkTimeValue} sec` : "Unlimited";
}

function lessonRunToken(lesson = currentLesson()) {
  return `${state.lessonLoadId}:${lesson?.lesson_id || ""}`;
}

function isLessonRunCurrent(token, lessonId = state.activeLessonId) {
  return token === `${state.lessonLoadId}:${lessonId || ""}`;
}

function classificationDisplayMessage(san, classification) {
  const label = String(classification?.label || "").trim();
  if (!san || !label) return "";
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  return `${san} is ${article} ${label.toLowerCase()} move`;
}

function lichessExplorerUrlForFen(fen = state.boardFen) {
  const analysisUrl = lichessAnalysisUrlForFen(fen);
  return analysisUrl ? `${analysisUrl}#explorer` : "";
}

function joinMetaParts(parts = []) {
  return parts.filter(Boolean).join(" · ");
}

function lichessAnalysisUrlForFen(fen = state.boardFen) {
  const normalizedFen = normalizeFen(fen);
  if (!normalizedFen) return "";
  return `https://lichess.org/analysis/standard/${encodeURIComponent(normalizedFen.replace(/ /g, "_")).replace(/%2F/g, "/")}`;
}

function currentStudyPositionLink(lesson = currentLesson(), insight = currentLiveInsight(lesson)) {
  const liveBoardHref = lichessAnalysisUrlForFen(state.boardFen);
  const href = String(
    insight?.position_identifier
    || liveBoardHref
    || lesson?.position_identifier
    || ""
  ).trim();
  if (!href) return null;
  return {
    href,
    label: String(
      insight?.position_identifier_label
      || lesson?.position_identifier_label
      || "Lichess analysis"
    ).trim() || "Lichess analysis",
  };
}

function currentStudyLinks(lesson = currentLesson(), insight = currentLiveInsight(lesson)) {
  const analysis = currentStudyPositionLink(lesson, insight);
  const explorerHref = lichessExplorerUrlForFen(state.boardFen);
  const links = [];
  if (analysis?.href) {
    links.push({
      href: analysis.href,
      label: analysis.label || "Lichess analysis",
    });
  }
  if (explorerHref) {
    links.push({
      href: explorerHref,
      label: "Lichess explorer",
    });
  }
  return links;
}

function renderStudyLinksMarkup(links = []) {
  const utilityButtons = `
    <button class="launch-btn study-link-btn utility" type="button" data-copy-study="fen">Copy FEN</button>
    <button class="launch-btn study-link-btn utility" type="button" data-copy-study="pgn">Copy PGN</button>
  `;
  if (!links.length) {
    return `${utilityButtons}<span class="line-note">Open a line to jump into Lichess analysis or explorer for the current position.</span>`;
  }
  return `${utilityButtons}${links.map((link) => `
    <a class="launch-btn study-link-btn" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">
      ${escapeHtml(link.label)}
    </a>
  `).join("")}`;
}

function currentEvalCpForStudy(lesson = currentLesson(), insight = currentLiveInsight(lesson)) {
  const bestLine = Array.isArray(insight?.candidate_lines) && insight.candidate_lines.length
    ? insight.candidate_lines[0]
    : null;
  const lessonBestLine = Array.isArray(lesson?.candidate_lines) && lesson.candidate_lines.length
    ? lesson.candidate_lines[0]
    : null;
  return Number(
    insight?.eval_cp_white
      ?? state.lastEvalCp
      ?? bestLine?.score_cp_white
      ?? bestLine?.score_cp
      ?? lessonBestLine?.score_cp_white
      ?? lessonBestLine?.score_cp
      ?? 0
  );
}

function insightStatusLabel(insight) {
  const parts = [];
  if (insight?.cache_hit) parts.push("cache hit");
  if (insight?.book_state) {
    parts.push(insight.book_state.active ? "book active" : "out of book");
  }
  return parts.join(" | ");
}

function renderEmptyStudyWorkspace() {
  state.lastEvalCp = null;
  state.currentInsight = null;
  state.currentInsightKey = "";
  state.insightLoading = false;
  state.insightRequestId = 0;
  state.positionInsightCache = {};
  state.legalMoves = [];
  state.legalByFrom = {};
  state.selectedSquare = "";
  state.lastMove = null;
  state.lastMoveClassification = null;
  state.lastMoveSan = "";
  state.boardOrientation = "white";
  state.boardFen = START_FEN;
  state.boardPieceMap = pieceMapFromFen(START_FEN);
  state.pendingMoveAnimationKey = "";
  state.renderedMoveAnimationKey = "";
  clearMoveAnimation();
  if (el.studyEvalFill) {
    el.studyEvalFill.style.setProperty("--eval-percent", "50%");
  }
  if (el.studyEvalScore) {
    el.studyEvalScore.textContent = "+0.00";
  }
  if (el.studyEvalCaption) {
    el.studyEvalCaption.textContent = "Waiting for live analysis";
  }
  if (el.studyOpeningMeta) {
    el.studyOpeningMeta.textContent = "Open a line to see its live engine and Lichess database context here.";
  }
  if (el.studyPositionLinks) {
    el.studyPositionLinks.innerHTML = renderStudyLinksMarkup([]);
  }
  if (el.studyAnalysisMeta) {
    el.studyAnalysisMeta.textContent = joinMetaParts([
      `Depth ${el.studyDepth?.value || el.depth?.value || "--"}`,
      currentThinkTimeLabel(),
      `MultiPV ${el.studyMultiPv?.value || el.multiPv?.value || "--"}`,
    ]);
  }
  if (el.studyDatabaseMeta) {
    el.studyDatabaseMeta.textContent = "No position loaded";
  }
  if (el.studyMoveMeta) {
    el.studyMoveMeta.textContent = "Waiting for a move";
  }
  if (el.studyEngineLines) {
    el.studyEngineLines.className = "stack empty";
    el.studyEngineLines.textContent = "Engine lines will show up here.";
  }
  if (el.studyDatabaseMoves) {
    el.studyDatabaseMoves.className = "stack empty";
    el.studyDatabaseMoves.textContent = "Database moves will show up here.";
  }
  if (el.studyMoveClassifications) {
    el.studyMoveClassifications.className = "stack empty";
    el.studyMoveClassifications.textContent = "Move classifications will show up here.";
  }
  if (el.studyMoveTrail) {
    el.studyMoveTrail.classList.add("empty");
    el.studyMoveTrail.textContent = "No played line yet.";
  }
  renderArrows(null);
  renderCoords();
  renderBoard(START_FEN, { animate: false });
}

function renderFreeStudyWorkspace() {
  const insight = currentLiveInsight(null);
  const candidateLines = Array.isArray(insight?.candidate_lines) ? insight.candidate_lines : [];
  const databaseMoves = Array.isArray(insight?.database_moves) ? insight.database_moves : [];
  const databaseError = String(insight?.database_error || "").trim();
  const evalCp = currentEvalCpForStudy(null, insight);
  const evalPercent = computeEvalPercent(evalCp);
  const explorerEnabled = Boolean(currentLichessToken());
  const candidateMap = Object.fromEntries(candidateLines.map((line) => [String(line?.uci || ""), line]));
  const playedMoveClassification = state.lastMoveClassification || null;
  const playedMoveSan = String(state.lastMoveSan || "");
  const recommended = currentAnalysisRecommendation(null, insight);
  const recommendedClassification = recommended.classification || insight?.recommended_classification || null;
  const recommendedMove = recommended.san || "";
  const coachText = String(insight?.coach_explanation || "").trim();
  const positionLinks = currentStudyLinks(null, insight);
  const turnLabel = sideToMove(state.boardFen) === "b" ? "Black to move" : "White to move";

  if (el.studyEvalFill) {
    el.studyEvalFill.style.setProperty("--eval-percent", `${evalPercent}%`);
  }
  if (el.studyEvalScore) {
    el.studyEvalScore.textContent = formatEval(evalCp);
  }
  if (el.studyEvalCaption) {
    el.studyEvalCaption.textContent = state.insightLoading && state.lastEvalCp !== null
      ? `${evalCaption(evalCp)} · updating`
      : evalCaption(evalCp);
  }
  if (el.studyOpeningMeta) {
    el.studyOpeningMeta.textContent = joinMetaParts([
      "Free analysis board",
      turnLabel,
      explorerEnabled ? "Lichess database ready" : "Database fallback mode",
    ]);
  }
  if (el.studyPositionLinks) {
    el.studyPositionLinks.innerHTML = renderStudyLinksMarkup(positionLinks);
  }
  if (el.studyAnalysisMeta) {
    const status = insightStatusLabel(insight);
    el.studyAnalysisMeta.textContent = joinMetaParts([
      `Depth ${el.studyDepth?.value || el.depth?.value || "--"}`,
      currentThinkTimeLabel(),
      `MultiPV ${el.studyMultiPv?.value || el.multiPv?.value || "--"}`,
      status,
    ]);
  }
  if (el.studyDatabaseMeta) {
    el.studyDatabaseMeta.textContent = explorerEnabled ? "Lichess practical replies" : "Fallback / cached moves";
  }
  if (el.studyEngineLines) {
    if (state.insightLoading && !candidateLines.length) {
      el.studyEngineLines.className = "stack empty";
      el.studyEngineLines.textContent = "Loading live Stockfish lines for this position...";
    } else if (!candidateLines.length) {
      el.studyEngineLines.className = "stack empty";
      el.studyEngineLines.textContent = "Engine lines are unavailable for this position right now.";
    } else {
      el.studyEngineLines.className = "stack";
      el.studyEngineLines.innerHTML = candidateLines.slice(0, 5).map(renderStudyEngineLine).join("");
    }
  }
  if (el.studyDatabaseMoves) {
    if (state.insightLoading && !databaseMoves.length) {
      el.studyDatabaseMoves.className = "stack empty";
      el.studyDatabaseMoves.textContent = explorerEnabled
        ? "Loading database moves for this position..."
        : "Loading fallback move context for this position...";
    } else if (!databaseMoves.length) {
      el.studyDatabaseMoves.className = "stack empty";
      el.studyDatabaseMoves.textContent = databaseError
        || (explorerEnabled
          ? "No database moves were returned for this exact position yet."
          : "Add a Lichess token in Setup or Study Lines for richer database move coverage.");
    } else {
      el.studyDatabaseMoves.className = "stack";
      el.studyDatabaseMoves.innerHTML = databaseMoves.slice(0, 6).map((line) => renderStudyDatabaseMove(line, candidateMap)).join("");
    }
  }
  if (el.studyMoveMeta) {
    el.studyMoveMeta.textContent = playedMoveSan
      ? `Last move: ${playedMoveSan}`
      : (state.insightLoading ? "Analyzing current position..." : "Waiting for a move");
  }
  if (el.studyMoveClassifications) {
    const cards = [];
    const mainReviewMarkup = renderStudyReviewMarkup(
      null,
      playedMoveSan,
      playedMoveClassification,
      recommendedMove,
      recommendedClassification,
      coachText,
    );
    if (mainReviewMarkup) cards.push(mainReviewMarkup);
    if (playedMoveSan && recommendedMove) {
      cards.push(renderStudyMoveCard(
        "Recommended move",
        recommendedMove,
        recommendedClassification,
        recommendedClassification?.reason || "Bookup's current Stockfish recommendation from this position.",
      ));
    }
    el.studyMoveClassifications.className = cards.length ? "stack" : "stack empty";
    el.studyMoveClassifications.innerHTML = cards.length
      ? cards.join("")
      : (state.insightLoading ? "Loading live move review for this position..." : "Make a move to see live classifications here.");
  }
  if (el.studyMoveTrail) {
    const markup = renderStudyMoveTrailMarkup();
    el.studyMoveTrail.classList.toggle("empty", markup === "No played line yet.");
    el.studyMoveTrail.innerHTML = markup;
  }
}

function renderStudyWorkspace() {
  const lesson = currentLesson();
  if (!lesson) {
    renderFreeStudyWorkspace();
    return;
  }
  const insight = currentLiveInsight(lesson);
  const candidateLines = Array.isArray(insight?.candidate_lines) ? insight.candidate_lines : [];
  const databaseMoves = Array.isArray(insight?.database_moves) ? insight.database_moves : [];
  const databaseError = String(insight?.database_error || "").trim();
  const evalCp = currentEvalCpForStudy(lesson, insight);
  const evalPercent = computeEvalPercent(evalCp);
  const explorerEnabled = Boolean(currentLichessToken());
  const candidateMap = Object.fromEntries(candidateLines.map((line) => [String(line?.uci || ""), line]));
  const playedMoveClassification = state.lastMoveClassification || null;
  const playedMoveSan = String(state.lastMoveSan || "");
  const recommended = currentAnalysisRecommendation(lesson, insight);
  const recommendedClassification = recommended.classification || insight?.recommended_classification || lesson?.recommended_classification || null;
  const recommendedMove = recommended.san || lesson?.best_reply || "";
  const coachText = String(insight?.coach_explanation || lesson?.coach_explanation || lesson?.explanation || "").trim();
  const positionLinks = currentStudyLinks(lesson, insight);
  const openingMeta = joinMetaParts([
    lesson.opening_name || "Unnamed line",
    lesson.line_label || "",
    explorerEnabled ? "Lichess database ready" : "Database fallback mode",
  ]);

  if (el.studyEvalFill) {
    el.studyEvalFill.style.setProperty("--eval-percent", `${evalPercent}%`);
  }
  if (el.studyEvalScore) {
    el.studyEvalScore.textContent = formatEval(evalCp);
  }
  if (el.studyEvalCaption) {
    el.studyEvalCaption.textContent = lesson
      ? (state.insightLoading && !insight && state.lastEvalCp !== null
        ? `${evalCaption(evalCp)} · updating`
        : evalCaption(evalCp))
      : "Waiting for live analysis";
  }

  if (el.studyOpeningMeta) {
    el.studyOpeningMeta.textContent = openingMeta;
  }

  if (el.studyPositionLinks) {
    el.studyPositionLinks.innerHTML = renderStudyLinksMarkup(positionLinks);
  }

  if (el.studyAnalysisMeta) {
    const status = insightStatusLabel(insight);
    el.studyAnalysisMeta.textContent = joinMetaParts([
      `Depth ${el.studyDepth?.value || el.depth?.value || "--"}`,
      currentThinkTimeLabel(),
      `MultiPV ${el.studyMultiPv?.value || el.multiPv?.value || "--"}`,
      status,
    ]);
  }

  if (el.studyDatabaseMeta) {
    el.studyDatabaseMeta.textContent = explorerEnabled
      ? "Lichess practical replies"
      : "Fallback / cached moves";
  }

  if (el.studyEngineLines) {
    if (state.insightLoading && !candidateLines.length) {
      el.studyEngineLines.className = "stack empty";
      el.studyEngineLines.textContent = "Loading live Stockfish lines for this position...";
    } else if (!candidateLines.length) {
      el.studyEngineLines.className = "stack empty";
      el.studyEngineLines.textContent = "Engine lines are unavailable for this position right now.";
    } else {
      el.studyEngineLines.className = "stack";
      el.studyEngineLines.innerHTML = candidateLines.slice(0, 5).map(renderStudyEngineLine).join("");
    }
  }

  if (el.studyDatabaseMoves) {
    if (state.insightLoading && !databaseMoves.length) {
      el.studyDatabaseMoves.className = "stack empty";
      el.studyDatabaseMoves.textContent = explorerEnabled
        ? "Loading database moves for this position..."
        : "Loading fallback move context for this position...";
    } else if (!databaseMoves.length) {
      el.studyDatabaseMoves.className = "stack empty";
      el.studyDatabaseMoves.textContent = databaseError
        || (explorerEnabled
          ? "No database moves were returned for this exact position yet."
          : "Add a Lichess token in Setup or Study Lines for richer database move coverage.");
    } else {
      el.studyDatabaseMoves.className = "stack";
      el.studyDatabaseMoves.innerHTML = databaseMoves.slice(0, 6).map((line) => renderStudyDatabaseMove(line, candidateMap)).join("");
    }
  }

  if (el.studyMoveMeta) {
    el.studyMoveMeta.textContent = playedMoveSan
      ? `Last move: ${playedMoveSan}`
      : (state.insightLoading ? "Analyzing current position..." : "Waiting for your next move");
  }

  if (el.studyMoveClassifications) {
    const cards = [];
    const mainReviewMarkup = renderStudyReviewMarkup(
      lesson,
      playedMoveSan,
      playedMoveClassification,
      recommendedMove,
      recommendedClassification,
      coachText,
    );
    if (mainReviewMarkup) {
      cards.push(mainReviewMarkup);
    }
    if (playedMoveSan && recommendedMove) {
      cards.push(renderStudyMoveCard(
        "Recommended move",
        recommendedMove,
        recommendedClassification,
        recommendedClassification?.reason || "Bookup's current Stockfish recommendation from this position.",
      ));
    }
    if (!cards.length) {
      el.studyMoveClassifications.className = "stack empty";
      el.studyMoveClassifications.textContent = state.insightLoading
        ? "Loading live move review for this position..."
        : "Make a move to see live classifications here.";
    } else {
      el.studyMoveClassifications.className = "stack";
      el.studyMoveClassifications.innerHTML = cards.join("");
    }
  }

  if (el.studyMoveTrail) {
    const markup = renderStudyMoveTrailMarkup();
    el.studyMoveTrail.classList.toggle("empty", markup === "No played line yet.");
    el.studyMoveTrail.innerHTML = markup;
  }
}

function queueReviewFactor(lesson) {
  const review = lesson?.review || state.reviewStats[lesson?.lesson_id] || null;
  if (!review || !Number(review.seen || 0)) {
    return {
      label: "Review state",
      value: "New",
      detail: "You have not worked this line in Bookup yet.",
      tone: "stable",
    };
  }
  const due = Number(review.due_at || 0);
  const isDue = !due || due <= Date.now();
  const streak = Number(review.streak || 0);
  const lastResult = review.last_result === "wrong" ? "missed" : review.last_result === "right" ? "correct" : "worked";
  return {
    label: isDue ? "Review state" : "Next review",
    value: isDue ? "Due" : formatReviewTime(due),
    detail: `Last ${lastResult}; current streak ${streak}.`,
    tone: review.last_result === "wrong" ? "urgent" : isDue ? "warning" : "stable",
  };
}

function renderQueueExplainer(lesson, variant = "full") {
  const explainer = lesson?.queue_explainer || {};
  const headline = explainer.headline || (lesson?.line_status === "new" ? "New repeated position" : "Queue reason");
  const summary = explainer.summary || "Bookup queued this from repeated game evidence and current study priority.";
  const factors = [
    ...(Array.isArray(explainer.factors) ? explainer.factors : []),
    queueReviewFactor(lesson),
  ].slice(0, variant === "compact" ? 3 : 6);
  const factorMarkup = factors
    .map((factor) => `
      <div class="queue-factor ${escapeHtml(factor?.tone || "stable")}">
        <div class="queue-factor-label">${escapeHtml(factor?.label || "Factor")}</div>
        <div class="queue-factor-value">${escapeHtml(String(factor?.value ?? ""))}</div>
        ${variant === "compact" ? "" : `<div class="queue-factor-detail">${escapeHtml(factor?.detail || "")}</div>`}
      </div>
    `)
    .join("");
  return `
    <div class="queue-explainer ${variant === "compact" ? "compact" : ""}">
      <div class="queue-explainer-head">
        <span>${escapeHtml(headline)}</span>
        ${explainer.next_action && variant !== "compact" ? `<small>${escapeHtml(explainer.next_action)}</small>` : ""}
      </div>
      <p>${escapeHtml(summary)}</p>
      <div class="queue-factor-grid">${factorMarkup}</div>
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
        ${renderQueueExplainer(item)}
        <div class="line-preview">${escapeHtml(item.continuation_san)}</div>
        <div class="line-note">${escapeHtml(item.explanation)}</div>
        <div class="chip-row">
          <button class="launch-btn" type="button" data-work-line="${escapeHtml(item.lesson_id)}">Work on line</button>
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
          ${item.lesson_id ? `<button class="launch-btn" type="button" data-work-line="${escapeHtml(item.lesson_id)}">Work on line</button>` : ""}
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
      lichess_token: currentLichessToken(),
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

async function fetchDatabaseContext(fen, playUci = []) {
  const response = await fetch("/api/database-moves", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fen,
      lichess_token: currentLichessToken(),
      play_uci: playUci,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not load database moves.");
  return payload;
}

async function generateTheoryLine() {
  if (!el.generateTheory || !el.theoryOutput) return;
  const moveUci = String(el.theoryMove?.value || "").trim();
  const plies = Math.max(1, Math.min(30, Number(el.theoryPly?.value || 10)));
  el.generateTheory.disabled = true;
  el.theoryOutput.className = "theory-output";
  el.theoryOutput.innerHTML = `<div class="line-note">Generating ${plies} best moves from the current board position...</div>`;
  try {
    const response = await fetch("/api/generate-theory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fen: normalizeFen(state.boardFen || START_FEN),
        move_uci: moveUci,
        plies,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not generate theory.");
    state.theoryResult = payload;
    renderTheoryResult(payload);
  } catch (error) {
    el.theoryOutput.className = "theory-output empty";
    el.theoryOutput.textContent = error.message || "Could not generate theory.";
  } finally {
    el.generateTheory.disabled = false;
  }
}

function renderTheoryResult(result) {
  if (!el.theoryOutput) return;
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  if (!steps.length) {
    el.theoryOutput.className = "theory-output empty";
    el.theoryOutput.textContent = "No engine theory line was generated from this position.";
    return;
  }
  el.theoryOutput.className = "theory-output";
  const seed = result.seed_move
    ? `<div class="theory-seed">After ${escapeHtml(result.seed_move.san)} (${escapeHtml(result.seed_move.uci)})</div>`
    : `<div class="theory-seed">From the current board position</div>`;
  const line = steps.map((step) => step.san).join(" ");
  el.theoryOutput.innerHTML = `
    ${seed}
    <div class="theory-line">${escapeHtml(line)}</div>
    <div class="theory-step-list">
      ${steps.map((step) => renderTheoryStep(step)).join("")}
    </div>
    <div class="chip-row">
      <button class="launch-btn study-link-btn utility" type="button" data-copy-study="fen">Copy current FEN</button>
      ${result.position_identifier ? `<a class="launch-btn study-link-btn" href="${escapeHtml(result.position_identifier)}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.position_identifier_label || "Open on Lichess")}</a>` : ""}
    </div>
  `;
}

function renderTheoryStep(step) {
  const candidates = Array.isArray(step?.candidate_lines) ? step.candidate_lines.slice(0, 3) : [];
  const db = Array.isArray(step?.database_moves) ? step.database_moves.slice(0, 3) : [];
  return `
    <article class="theory-step">
      <div class="theory-step-head">
        <div>
          <div class="theory-step-title">${Number(step?.ply || 0)}. ${escapeHtml(step?.san || "")} ${classificationBadge(step?.classification, "compact")}</div>
          <div class="tree-meta">${escapeHtml(step?.side || "")} to move | ${formatEval(step?.eval_cp_white ?? 0)}</div>
        </div>
        <span class="line-badge">${escapeHtml(step?.uci || "")}</span>
      </div>
      <div class="line-note">Top engine alternatives: ${candidates.map((line) => renderCandidateLineSummary(line)).join("") || "No alternatives."}</div>
      <div class="line-note">Database replies: ${db.map((move) => `${escapeHtml(move.san || move.uci || "")} ${Number(move.popularity || 0).toFixed(1)}%`).join(" | ") || "No database data."}</div>
    </article>
  `;
}

function buildLessonInsight(lesson) {
  return {
    candidate_lines: Array.isArray(lesson?.candidate_lines) ? lesson.candidate_lines : [],
    threat_lines: Array.isArray(lesson?.threat_lines) ? lesson.threat_lines : [],
    database_moves: Array.isArray(lesson?.database_moves) ? lesson.database_moves : [],
    database_error: lesson?.database_error || "",
    database_source: lesson?.database_source || "cached",
    recommended_move: lesson?.best_reply || "",
    recommended_move_uci: lesson?.best_reply_uci || "",
    recommended_classification: lesson?.recommended_classification || null,
    your_move_classification: lesson?.your_move_classification || null,
    coach_explanation: lesson?.coach_explanation || lesson?.explanation || "",
    position_identifier: lesson?.position_identifier || "",
    position_identifier_label: lesson?.position_identifier_label || "Lichess analysis",
  };
}

function mergeDatabaseContext(baseInsight, databaseContext) {
  const base = baseInsight || {};
  return {
    ...base,
    database_moves: Array.isArray(databaseContext?.database_moves) ? databaseContext.database_moves : [],
    database_error: databaseContext?.database_error || "",
    database_source: databaseContext?.database_source || base.database_source || "fallback",
    position_identifier: databaseContext?.position_identifier || base.position_identifier || "",
    position_identifier_label: databaseContext?.position_identifier_label || base.position_identifier_label || "Lichess analysis",
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

function saveManualRepertoireMove(lessonId) {
  const lesson = state.lessonMap[lessonId];
  if (!lesson) return;
  const moveUci = lesson.recommended_move_uci || lesson.best_reply_uci || lesson.preferred_branch_uci || "";
  const moveSan = lesson.recommended_move || lesson.best_reply || lesson.preferred_branch_san || "";
  const positionKey = lesson.position_fen || lesson.decision_fen || lesson.transposition_group_id || lessonId;
  if (!positionKey || !moveUci) return;
  state.manualRepertoire[positionKey] = {
    lesson_id: lessonId,
    move_uci: moveUci,
    move_san: moveSan,
    line_label: lesson.line_label || lesson.opening_name || "",
    saved_at: new Date().toISOString(),
  };
  if (state.payload?.username) {
    saveReviewStats(state.payload.username);
    void persistReviewStats(state.payload.username);
  }
  const message = `Saved ${moveSan || moveUci} as your repertoire move for this position.`;
  if (el.trainerFeedback) {
    el.trainerFeedback.textContent = message;
    el.trainerFeedback.classList.remove("empty");
  }
  if (el.previewPanel && state.previewLessonId === lessonId) {
    const note = document.createElement("div");
    note.className = "line-note saved-repertoire-note";
    note.textContent = message;
    el.previewPanel.appendChild(note);
  }
}

function saveDriftChoice(choiceId, action, button) {
  if (!choiceId) return;
  state.manualDriftChoices[choiceId] = action === "repair" ? "repair" : "adopt";
  if (state.payload?.username) {
    saveReviewStats(state.payload.username);
    void persistReviewStats(state.payload.username);
  }
  if (button instanceof HTMLElement) {
    const original = button.textContent;
    button.textContent = "Saved";
    window.setTimeout(() => { button.textContent = original || "Saved"; }, 1000);
  }
  renderDriftFixes(state.payload?.profile?.drift_fixes || null);
}

function exportPreparationPack(button) {
  const text = state.prepPackText || prepPackToText(state.payload?.profile?.prep_pack || null);
  if (!text) return;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `bookup-prep-pack-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  button.textContent = "Exported";
  setTimeout(() => { button.textContent = "Export prep pack"; }, 1400);
}

function exportRepertoireLines(button) {
  const text = state.repertoireExportText || state.payload?.profile?.repertoire_export?.text || "";
  if (!text) return;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = state.payload?.profile?.repertoire_export?.filename || `bookup-repertoire-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  if (button instanceof HTMLElement) {
    button.textContent = "Downloaded";
    setTimeout(() => { button.textContent = "Download repertoire export"; }, 1400);
  }
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
          <button class="launch-btn" type="button" data-work-line="${escapeHtml(item.lesson_id)}">Work on line</button>
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
          <span class="lesson-chip">Memory ${Math.round(Number(lesson.memory_score || 0))}</span>
          <span class="lesson-chip">Streak ${lesson.review.streak || 0}</span>
        </div>
        ${renderQueueExplainer(lesson, "compact")}
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

function currentPlayedLine() {
  return state.playedTrainingLine.filter(Boolean);
}

function currentPlayedLineSan() {
  return state.playedTrainingLineSan.filter(Boolean);
}

function appendPlayedMove(moveUci, moveSan) {
  if (moveUci) state.playedTrainingLine.push(moveUci);
  if (moveSan) state.playedTrainingLineSan.push(moveSan);
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

function findBranchLineByFen(lesson, fen) {
  const targetFen = normalizeFen(fen);
  return (lesson?.branch_lines || []).find((item) => normalizeFen(item.resulting_fen) === targetFen) || null;
}

function currentLesson() {
  return state.lessonMap[state.activeLessonId] || null;
}

function pieceAtSquare(squareName, fen = state.boardFen) {
  return currentPieceMap(fen)[squareName] || "";
}

function allowedUserMoves(lesson = currentLesson(), fen = state.boardFen) {
  if (lesson && !canUserInteract(lesson)) return [];
  const currentSide = sideToMove(fen);
  const pieceMap = currentPieceMap(fen);
  const sideLegalMoves = (state.legalMoves || []).filter((move) => {
    const piece = pieceMap[move.from] || "";
    return piece && pieceSide(piece) === currentSide;
  });
  return sideLegalMoves;
}

function allowedTargetsForSquare(squareName, lesson = currentLesson(), fen = state.boardFen) {
  return allowedUserMoves(lesson, fen).filter((move) => move.from === squareName);
}

function isSquareMovableByUser(squareName, lesson = currentLesson(), fen = state.boardFen) {
  if (lesson && !canUserInteract(lesson)) return false;
  const piece = pieceAtSquare(squareName, fen);
  if (!piece) return false;
  if (pieceSide(piece) !== sideToMove(fen)) return false;
  return Boolean(allowedTargetsForSquare(squareName, lesson, fen).length);
}

function squareClassificationMarkup(record) {
  const key = classificationKey(record);
  const label = String(record?.label || "").trim();
  const icon = String(record?.icon || MOVE_CLASSIFICATION_ICONS[key] || "").trim();
  if (!key || !label || !icon) return "";
  return `
    <div class="square-classification-badge ${escapeHtml(key)}" title="${escapeHtml(record?.reason || label)}" aria-label="${escapeHtml(label)}">
      <img src="${icon}" alt="${escapeHtml(label)}" />
    </div>
  `;
}

function insightCacheKey(lesson) {
  const line = lesson ? currentPlayPrefix(lesson, state.trainingCursor) : [];
  return `${normalizeFen(state.boardFen)}|${line.join(",")}|${state.activeLessonId}`;
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

function currentPlayPrefix(lesson, cursor = state.trainingCursor) {
  if (!lesson) return [];
  const played = currentPlayedLine();
  if (played.length) return played.filter(Boolean);
  return lessonTrainingLine(lesson).slice(0, cursor).filter(Boolean);
}

function moveColorLabel(colorCode) {
  return colorCode === "b" ? "Black" : "White";
}

function userColorCode(lesson) {
  return lesson?.color === "black" ? "b" : "w";
}

function isUsersTurn(lesson, fen = state.boardFen) {
  return Boolean(lesson) && sideToMove(fen) === userColorCode(lesson);
}

function moveRepeatedCount(lesson, moveUci) {
  if (!lesson || !moveUci) return 0;
  if (moveUci === lesson.your_top_move_uci) {
    return Number(lesson.your_top_move_count || 0);
  }
  const discoveryCount = (lesson.discovery_nodes || []).find((item) => item?.uci === moveUci)?.count;
  if (discoveryCount) {
    return Number(discoveryCount || 0);
  }
  const branchCount = (lesson.branch_lines || []).find((item) => item?.uci === moveUci)?.repeated_count;
  if (branchCount) {
    return Number(branchCount || 0);
  }
  return 0;
}

function computeTrainerPhase(lesson = currentLesson()) {
  if (!lesson) return "completed";
  const line = lessonTrainingLine(lesson);
  const rootCursor = lessonRootCursor(lesson);
  if (state.trainingCursor >= line.length) return "completed";
  if (!state.branchLocked) {
    if (state.trainingCursor < rootCursor) return "intro_autoplay";
    return "decision_point";
  }
  return "locked_line";
}

function syncTrainerPhase(lesson = currentLesson()) {
  state.trainerPhase = computeTrainerPhase(lesson);
  return state.trainerPhase;
}

function canUserInteract(lesson = currentLesson()) {
  const phase = computeTrainerPhase(lesson);
  return Boolean(lesson) && isUsersTurn(lesson) && phase !== "intro_autoplay" && phase !== "completed";
}

async function classifyMoveAtCurrentPosition(lesson, moveUci, moveSan, repeatedCount = 0) {
  return classifyMoveAtFen(state.boardFen, lesson, moveUci, moveSan, repeatedCount);
}

async function classifyMoveAtFen(fen, lesson, moveUci, moveSan, repeatedCount = 0) {
  if (!lesson || !moveUci) {
    return {
      insight: null,
      classification: null,
      recommendedClassification: null,
      recommendedMove: "",
    };
  }
  const insight = await fetchPositionInsight(
    fen,
    currentPlayPrefix(lesson),
    moveUci,
    moveSan,
    repeatedCount,
  ).catch(() => null);
  return {
    insight,
    classification: insight?.your_move_classification || null,
    recommendedClassification: insight?.recommended_classification || null,
    recommendedMove: insight?.recommended_move || lesson.best_reply || moveSan || moveUci,
  };
}

function currentPlyEstimate(fen = state.boardFen) {
  const parts = normalizeFen(fen).split(/\s+/);
  const turn = parts[1] || "w";
  const fullmove = Number(parts[5] || 1);
  return Math.max(0, (Math.max(1, fullmove) - 1) * 2 + (turn === "b" ? 1 : 0));
}

function localMoveClassification(key, reason) {
  return {
    key,
    label: MOVE_CLASSIFICATION_LABELS[key] || key,
    icon: MOVE_CLASSIFICATION_ICONS[key] || "",
    expected_points: 0.5,
    expected_points_loss: 0,
    reason,
  };
}

function isInstantBookMove(lesson, move) {
  const insight = currentLiveInsight(lesson);
  const bookState = insight?.book_state || null;
  if (bookState && bookState.active === false) return false;
  const moveUci = String(move?.uci || "");
  if (!moveUci || currentPlyEstimate(state.boardFen) >= 16) return false;
  if (lesson && findBranchLine(lesson, moveUci)) return true;
  const dbMove = (insight?.database_moves || []).find((item) => item?.uci === moveUci);
  if (dbMove && Number(dbMove.popularity || 0) >= 3) return true;
  return Boolean(bookState?.active && (insight?.candidate_lines || []).some((line) => line?.uci === moveUci && classificationKey(line?.classification) === "book"));
}

function instantMoveClassification(lesson, move) {
  const insight = currentLiveInsight(lesson);
  const candidate = (insight?.candidate_lines || []).find((line) => line?.uci === move?.uci);
  if (candidate?.classification) return candidate.classification;
  if (isInstantBookMove(lesson, move)) {
    return localMoveClassification("book", "opening book move");
  }
  return null;
}

function applyResolvedMoveClassification(moveUci, classification, expectedFen = "") {
  if (!classification) return;
  const lastMoveUci = state.lastMove ? `${state.lastMove.from}${state.lastMove.to}` : "";
  if (lastMoveUci !== String(moveUci || "").slice(0, 4)) return;
  if (expectedFen && normalizeFen(state.boardFen) !== normalizeFen(expectedFen)) return;
  state.lastMoveClassification = classification;
  renderBoard(state.boardFen, { animate: false });
  renderStudyWorkspace();
}

function renderAutoMoveSummary(autoMoves = []) {
  if (!autoMoves.length) return "";
  return autoMoves
    .map((entry) => `${escapeHtml(entry.color)} played <strong>${escapeHtml(entry.san)}</strong>${classificationBadge(entry.classification, "inline")}.`)
    .join(" ");
}

function renderTrainerDecision(lesson) {
  if (!lesson) {
    el.trainerDecision.textContent = "No decision point loaded yet.";
    el.trainerDecision.classList.add("empty");
    return;
  }
  const phase = syncTrainerPhase(lesson);
  if (phase === "completed") {
    el.trainerDecision.textContent = "Line complete.";
    el.trainerDecision.classList.add("empty");
    return;
  }
  if (phase === "intro_autoplay") {
    el.trainerDecision.textContent = "Bookup is stepping through the lead-in to your next real decision point.";
    el.trainerDecision.classList.remove("empty");
    return;
  }
  if (phase === "locked_line") {
    const recommended = currentRecommendedMoveData(lesson);
    const expectedText = recommended.san || lesson.best_reply || "";
    el.trainerDecision.textContent = isUsersTurn(lesson)
      ? (expectedText ? `Recommended move: ${expectedText}. You can play any legal move of your color.` : "You can play any legal move of your color here.")
      : "Bookup is playing the practical reply now.";
    el.trainerDecision.classList.remove("empty");
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
  return isUsersTurn(lesson);
}

function expectedMoveAtCursor(lesson, cursor = state.trainingCursor) {
  return lessonTrainingLine(lesson)[cursor] || "";
}

function liveExpectedMoveUci(lesson, cursor = state.trainingCursor) {
  const expected = expectedMoveAtCursor(lesson, cursor);
  if (expected && (state.legalMoves || []).some((move) => move.uci === expected)) {
    return expected;
  }
  if (state.branchLocked) {
    return expected || "";
  }
  if (cursor === lessonRootCursor(lesson)) {
    const preferred = String(lesson?.preferred_branch_uci || "").trim();
    if (preferred && (state.legalMoves || []).some((move) => move.uci === preferred)) {
      return preferred;
    }
  }
  const liveInsight = currentLiveInsight(lesson);
  const insightRecommended = String(liveInsight?.recommended_move_uci || "").trim();
  if (insightRecommended && (state.legalMoves || []).some((move) => move.uci === insightRecommended)) {
    return insightRecommended;
  }
  return expected || insightRecommended;
}

function currentBoardHint() {
  const lesson = currentLesson();
  if (!lesson || !state.boardFen) return null;
  if (state.lastMove?.to && state.lastMoveClassification) {
    const key = classificationKey(state.lastMoveClassification);
    if (key) {
      return {
        from: state.lastMove.from,
        to: state.lastMove.to,
        classification: state.lastMoveClassification,
        key,
        source: "played",
      };
    }
  }
  return null;
}

function updateTrainerCopy() {
  const lesson = currentLesson();
  if (!lesson) return;
  const phase = syncTrainerPhase(lesson);
  const line = lessonTrainingLine(lesson);
  const liveInsight = currentLiveInsight(lesson);
  const recommended = currentRecommendedMoveData(lesson, liveInsight);
  const engineCoachText = String(liveInsight?.coach_explanation || "").trim();
  const lineCoachText = String(lesson?.coach_explanation || lesson?.explanation || "").trim();
  const coachText = engineCoachText && engineCoachText !== lineCoachText
    ? engineCoachText
    : (lineCoachText || engineCoachText);
  const recommendedLabel = recommended.classification?.label || lesson?.recommended_classification?.label || "Best";
  const progress = `${Math.min(state.trainingCursor, line.length)}/${line.length}`;
  const expectedText = recommended.san || lesson.best_reply || "";
  if (phase === "decision_point") {
    const atRootDecision = state.trainingCursor === lessonRootCursor(lesson);
    const discoveryPreview = atRootDecision
      ? (lesson.discovery_nodes || [])
        .slice(0, 4)
        .map((item) => `${item.san} ${item.count}x`)
        .join(" | ")
      : "";
    el.boardTitle.textContent = atRootDecision ? "What would you play here?" : "Your move here";
    el.boardSummary.textContent = expectedText
      ? `Choose any legal move for your color. Recommended move: ${expectedText}.`
      : "Choose any legal move for your color. Bookup will follow repertoire branches and transpositions when they fit.";
    if (discoveryPreview) {
      el.trainerCoach.textContent = coachText
        ? `Your repeated moves in this position: ${discoveryPreview}. ${coachText}`
        : `Your repeated moves in this position: ${discoveryPreview}. Recommended move: ${expectedText || lesson.best_reply}.`;
    } else {
      el.trainerCoach.textContent = coachText || (expectedText
        ? `Recommended move here: ${expectedText}. Bookup will classify any legal move you choose.`
        : `Preferred move here: ${lesson.best_reply}.`);
    }
    el.trainerCoach.classList.remove("empty");
    renderTrainerDecision(lesson);
    el.boardLine.textContent = currentPlayedLineSan().join(" ") || lesson.intro_line_san || "No lead-in moves loaded.";
    el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
    renderStudyWorkspace();
    return;
  }
  renderTrainerDecision(lesson);
  if (phase === "completed") {
    el.boardTitle.textContent = "Line complete";
    el.boardSummary.textContent = "Line complete. Reset it or move on to the next due line.";
    el.trainerCoach.textContent = coachText || `Bookup ran the line through to the final planned position after ${lesson.trigger_move}.`;
    el.trainerCoach.classList.remove("empty");
    el.boardLine.textContent = currentPlayedLineSan().join(" ") || lessonTrainingLineSan(lesson).join(" ") || lesson.continuation_san || "No line loaded yet.";
    el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
    renderStudyWorkspace();
    return;
  }
  if (phase === "intro_autoplay") {
    el.boardTitle.textContent = "Follow the lead-in";
    el.boardSummary.textContent = `Bookup is stepping through the practical setup. Step ${progress}.`;
    el.trainerCoach.textContent = lineCoachText || engineCoachText || "Watch the lead-in until the board reaches your next real decision point.";
  } else if (trainerUserTurn(lesson)) {
    el.boardTitle.textContent = expectedText ? "Your move here" : "Choose your move";
    el.boardSummary.textContent = expectedText
      ? `Step ${progress}. Bookup recommends ${expectedText}, but you can play any legal move and it will classify it.`
      : `Step ${progress}. Play any legal move of your color.`;
    el.trainerCoach.textContent = coachText || (expectedText
      ? `${expectedText} is Bookup's ${recommendedLabel.toLowerCase()} recommendation here. If you choose something else, Bookup will classify it and then continue the repertoire line.`
      : "Choose your move. Bookup will classify it and continue from there.");
  } else {
    el.boardTitle.textContent = "Follow the line";
    el.boardSummary.textContent = `Bookup is playing the practical reply now. Step ${progress}.`;
    el.trainerCoach.textContent = coachText || "Watch the practical reply, then answer with your move when the board comes back to you.";
  }
  el.trainerCoach.classList.remove("empty");
  el.boardLine.textContent = currentPlayedLineSan().join(" ") || lessonTrainingLineSan(lesson).join(" ") || lesson.continuation_san || "No line loaded yet.";
  el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
  renderStudyWorkspace();
}

async function applyMoveToBoard(moveUci, classification = null) {
  const response = await fetch("/api/apply-move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fen: state.boardFen, move_uci: moveUci }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not apply move.");
  playMoveSound(payload.played_san);
  applyBoardState(payload, { classification: classification || payload.played_classification || null });
  renderBoard(state.boardFen, { animate: true });
  return payload;
}

async function previewMoveOnBoard(moveUci) {
  const response = await fetch("/api/apply-move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fen: state.boardFen, move_uci: moveUci }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not preview move.");
  return payload;
}

async function syncTrainerToPlayableTurn() {
  const lesson = currentLesson();
  if (!lesson) return { autoMoves: [] };
  const runToken = lessonRunToken(lesson);
  const line = lessonTrainingLine(lesson);
  const rootCursor = lessonRootCursor(lesson);
  const autoMoves = [];
  while (state.trainingCursor < line.length) {
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return { autoMoves };
    const phase = syncTrainerPhase(lesson);
    if (phase === "completed") break;
    if (!state.branchLocked && state.trainingCursor >= rootCursor) break;
    if (state.branchLocked && isUsersTurn(lesson)) break;
    const expectedUci = line[state.trainingCursor];
    if (!expectedUci) break;
    const movingColor = moveColorLabel(sideToMove(state.boardFen));
    let expectedEntry = (state.legalMoves || []).find((item) => item.uci === expectedUci);
    if (!expectedEntry) {
      await refreshLegalMoves(state.boardFen);
      if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return { autoMoves };
      expectedEntry = (state.legalMoves || []).find((item) => item.uci === expectedUci);
    }
    if (!expectedEntry) break;
    const expectedSan = expectedEntry?.san || expectedUci;
    const preMoveFen = state.boardFen;
    const instantClassification = instantMoveClassification(lesson, expectedEntry);
    const moveMetaPromise = classifyMoveAtFen(
      preMoveFen,
      lesson,
      expectedUci,
      expectedSan,
      moveRepeatedCount(lesson, expectedUci),
    );
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return { autoMoves };
    await applyMoveToBoard(expectedUci, instantClassification);
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return { autoMoves };
    const appliedFen = state.boardFen;
    moveMetaPromise.then((moveMeta) => {
      applyResolvedMoveClassification(expectedUci, moveMeta?.classification || moveMeta?.recommendedClassification || null, appliedFen);
    });
    state.trainingCursor += 1;
    appendPlayedMove(expectedUci, state.lastMoveSan || expectedSan);
    syncTrainerPhase(lesson);
    autoMoves.push({
      color: movingColor,
      san: state.lastMoveSan || expectedSan,
      classification: state.lastMoveClassification || instantClassification || null,
    });
    updateTrainerCopy();
  }
  if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return { autoMoves };
  updateTrainerCopy();
  await updateCurrentInsight();
  if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return { autoMoves };
  return { autoMoves };
}

async function loadLessonById(lessonId) {
  const lesson = state.lessonMap[lessonId];
  if (!lesson) return;
  const loadId = ++state.lessonLoadId;
  const combinedQueue = [...state.queueDue, ...state.queueNew];
  state.lessonIndex = combinedQueue.findIndex((item) => item.lesson_id === lessonId);
  state.activeLessonId = lesson.lesson_id;
  state.boardOrientation = lesson.color === "black" ? "black" : "white";
  state.startFen = normalizeFen(lesson.line_start_fen);
  state.boardFen = state.startFen;
  state.trainingCursor = 0;
  state.lessonMistakes = 0;
  state.activeTrainingLine = Array.isArray(lesson.training_line_uci) ? [...lesson.training_line_uci] : [];
  state.activeTrainingLineSan = String(lesson.training_line_san || "").trim().split(/\s+/).filter(Boolean);
  state.playedTrainingLine = [];
  state.playedTrainingLineSan = [];
  state.branchLocked = false;
  state.trainerPhase = "intro_autoplay";
  state.selectedSquare = "";
  state.dragFrom = "";
  state.dragPiece = "";
  clearDragState();
  state.lastMove = null;
  state.lastMoveClassification = null;
  state.lastMoveSan = "";
  state.previousRenderedPieces = {};
  state.currentInsight = null;
  state.currentInsightKey = "";
  state.insightLoading = true;
  state.lastEvalCp = Number(
    lesson?.candidate_lines?.[0]?.score_cp_white
      ?? lesson?.candidate_lines?.[0]?.score_cp
      ?? 0
  );
  state.positionInsightCache = {};
  state.pendingMoveAnimationKey = "";
  state.renderedMoveAnimationKey = "";
  el.boardTitle.textContent = "Loading line";
  el.boardSummary.textContent = "Bookup is preparing the board, live analysis, and branch context for this lesson.";
  el.trainerFeedback.textContent = lesson.line_status === "known"
    ? "You already know this line. Bookup will still run it from the beginning as maintenance."
    : "Bookup is starting from the beginning of the line. When you reach the branch, play what you would normally play there.";
  el.trainerFeedback.classList.remove("empty");
  setActiveTab("trainer");
  renderStudyWorkspace();

  try {
    await refreshLegalMoves(state.boardFen);
    if (loadId !== state.lessonLoadId || state.activeLessonId !== lesson.lesson_id) return;
    renderCoords();
    renderBoard(state.boardFen, { animate: false });
    updateTrainerCopy();
    const syncResult = await syncTrainerToPlayableTurn();
    if (loadId !== state.lessonLoadId || state.activeLessonId !== lesson.lesson_id) return;
    if (syncResult?.autoMoves?.length) {
      el.trainerFeedback.innerHTML = `Bookup played the lead-in to your decision point. ${renderAutoMoveSummary(syncResult.autoMoves)}`;
      el.trainerFeedback.classList.remove("empty");
    }
    renderQueue();
    renderStudyWorkspace();
  } catch (error) {
    if (loadId !== state.lessonLoadId) return;
    clearTrainer();
    setActiveTab("trainer");
    el.trainerFeedback.textContent = error?.message || "Bookup could not load that line.";
    el.trainerFeedback.classList.remove("empty");
  }
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
  state.lessonLoadId += 1;
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
  state.dragPiece = "";
  clearDragState();
  state.lastMove = null;
  state.lastMoveClassification = null;
  state.lastMoveSan = "";
  state.previousRenderedPieces = {};
  state.activeTrainingLine = [];
  state.activeTrainingLineSan = [];
  state.playedTrainingLine = [];
  state.playedTrainingLineSan = [];
  state.branchLocked = false;
  state.trainerPhase = "completed";
  state.currentInsight = null;
  state.currentInsightKey = "";
  state.insightLoading = false;
  state.lastEvalCp = null;
  state.positionInsightCache = {};
  state.insightRequestId = 0;
  state.pendingMoveAnimationKey = "";
  state.renderedMoveAnimationKey = "";
  clearMoveAnimation();
  el.trainerCoach.textContent = "Bookup will ask what you would play here, then lock into the repertoire branch you choose or redirect you if you leave your repertoire.";
  el.trainerCoach.classList.remove("empty");
  el.trainerDecision.textContent = "No decision point loaded yet.";
  el.trainerDecision.classList.add("empty");
  el.trainerInsight.textContent = "Blue arrows show the top engine moves. Red arrows show the main threats or replies you should expect next.";
  el.trainerInsight.classList.remove("empty");
  renderCoords();
  renderBoard(START_FEN, { animate: false });
  renderArrows(null);
  renderStudyWorkspace();
  void initializeFreeAnalysisBoard();
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
  return payload;
}

function renderCoords() {
  const rankOrder = state.boardOrientation === "black" ? [...ranks].reverse() : ranks;
  const fileOrder = state.boardOrientation === "black" ? [...files].reverse() : files;
  el.rankLabels.innerHTML = rankOrder.map((rank) => `<span>${rank}</span>`).join("");
  el.fileLabels.innerHTML = fileOrder.map((file) => `<span>${file}</span>`).join("");
}

async function updateCurrentInsight() {
  const lesson = currentLesson();
  const loadId = state.lessonLoadId;
  if (!lesson || !state.boardFen) {
    state.currentInsight = null;
    state.currentInsightKey = "";
    state.insightLoading = false;
    state.lastEvalCp = null;
    renderArrows(null);
    el.trainerInsight.textContent = "Blue arrows show the top engine moves. Red arrows show the main threats or replies you should expect next.";
    renderStudyWorkspace();
    return;
  }
  const requestId = ++state.insightRequestId;
  const cacheKey = insightCacheKey(lesson);
  state.insightLoading = true;
  const cached = state.positionInsightCache[cacheKey] || null;
  if (cached) {
    state.currentInsight = cached;
    state.currentInsightKey = cacheKey;
    state.lastEvalCp = Number(
      cached?.eval_cp_white
        ?? cached?.candidate_lines?.[0]?.score_cp_white
        ?? cached?.candidate_lines?.[0]?.score_cp
        ?? state.lastEvalCp
        ?? 0
    );
  }
  renderStudyWorkspace();
  if (cached) {
    if (!isCurrentInsightRequest(lesson, cacheKey, requestId, loadId)) return;
    state.insightLoading = false;
    renderArrows(cached);
    el.trainerInsight.textContent = cached.coach_explanation || "Blue arrows show the top engine moves. Red arrows show the main threats or replies you should expect next.";
    el.trainerInsight.classList.remove("empty");
    renderStudyWorkspace();
    return;
  }
  const yourMove = currentInsightYourMove(lesson);
  const playPrefix = currentPlayPrefix(lesson, state.trainingCursor);
  try {
    const insight = await fetchPositionInsight(
      state.boardFen,
      playPrefix,
      yourMove.uci,
      yourMove.san,
      yourMove.count
    );
    if (!isCurrentInsightRequest(lesson, cacheKey, requestId, loadId)) return;
    state.positionInsightCache[cacheKey] = insight;
    state.currentInsight = insight;
    state.currentInsightKey = cacheKey;
    state.insightLoading = false;
    state.lastEvalCp = Number(
      insight?.eval_cp_white
        ?? insight?.candidate_lines?.[0]?.score_cp_white
        ?? insight?.candidate_lines?.[0]?.score_cp
        ?? state.lastEvalCp
        ?? 0
    );
    renderArrows(insight);
    el.trainerInsight.textContent = insight.coach_explanation || "Blue arrows show the top engine moves. Red arrows show the main threats or replies you should expect next.";
  } catch (error) {
    if (!isCurrentInsightRequest(lesson, cacheKey, requestId, loadId)) return;
    try {
      const databaseContext = await fetchDatabaseContext(state.boardFen, playPrefix);
      if (!isCurrentInsightRequest(lesson, cacheKey, requestId, loadId)) return;
      state.currentInsight = mergeDatabaseContext(state.currentInsight || buildLessonInsight(lesson), databaseContext);
      state.currentInsightKey = cacheKey;
      state.positionInsightCache[cacheKey] = state.currentInsight;
    } catch {
      // Keep the current/cached insight if both engine and database refresh fail.
    }
    state.insightLoading = false;
    renderArrows(currentLiveInsight(lesson));
    el.trainerInsight.textContent = state.currentInsight?.coach_explanation
      || "Live arrows are unavailable right now. Blue arrows show top engine moves and red arrows show threats when the current position insight loads.";
  }
  el.trainerInsight.classList.remove("empty");
  renderStudyWorkspace();
}

async function updateFreeAnalysisInsight() {
  if (state.activeLessonId || !state.boardFen) return;
  const requestId = ++state.insightRequestId;
  const cacheKey = `free:${normalizeFen(state.boardFen)}:${currentPlayedLine().join(" ")}`;
  state.insightLoading = true;
  const cached = state.positionInsightCache[cacheKey] || null;
  if (cached) {
    state.currentInsight = cached;
    state.currentInsightKey = cacheKey;
    state.lastEvalCp = Number(
      cached?.eval_cp_white
        ?? cached?.candidate_lines?.[0]?.score_cp_white
        ?? cached?.candidate_lines?.[0]?.score_cp
        ?? state.lastEvalCp
        ?? 0
    );
    state.insightLoading = false;
    renderArrows(cached);
    if (el.trainerInsight) {
      el.trainerInsight.textContent = cached.coach_explanation || "Loaded cached analysis for this position.";
      el.trainerInsight.classList.remove("empty");
    }
    renderStudyWorkspace();
    return;
  }
  renderStudyWorkspace();
  try {
    const insight = await fetchPositionInsight(state.boardFen, currentPlayedLine(), "", "", 0);
    if (state.activeLessonId || requestId !== state.insightRequestId) return;
    state.positionInsightCache[cacheKey] = insight;
    state.currentInsight = insight;
    state.currentInsightKey = cacheKey;
    state.insightLoading = false;
    state.lastEvalCp = Number(
      insight?.eval_cp_white
        ?? insight?.candidate_lines?.[0]?.score_cp_white
        ?? insight?.candidate_lines?.[0]?.score_cp
        ?? state.lastEvalCp
        ?? 0
    );
    renderArrows(insight);
    if (el.trainerInsight) {
      el.trainerInsight.textContent = insight.coach_explanation || "Blue arrows show top engine moves. Red arrows show threats or practical replies.";
      el.trainerInsight.classList.remove("empty");
    }
  } catch {
    if (state.activeLessonId || requestId !== state.insightRequestId) return;
    try {
      const databaseContext = await fetchDatabaseContext(state.boardFen, currentPlayedLine());
      if (state.activeLessonId || requestId !== state.insightRequestId) return;
      state.currentInsight = mergeDatabaseContext(state.currentInsight, databaseContext);
      state.currentInsightKey = cacheKey;
      state.positionInsightCache[cacheKey] = state.currentInsight;
    } catch {
      // Keep the last visible study state when live refreshes fail.
    }
    state.insightLoading = false;
    renderArrows(state.currentInsight);
    if (el.trainerInsight) {
      el.trainerInsight.textContent = "Live analysis is unavailable right now. You can still make legal moves on the analysis board.";
      el.trainerInsight.classList.remove("empty");
    }
  }
  renderStudyWorkspace();
}

async function initializeFreeAnalysisBoard() {
  if (state.activeLessonId) return;
  try {
    await refreshLegalMoves(state.boardFen || START_FEN);
    if (state.activeLessonId) return;
    renderCoords();
    renderBoard(state.boardFen, { animate: false });
    await updateFreeAnalysisInsight();
  } catch {
    renderStudyWorkspace();
  }
}

function renderBoard(fen, options = {}) {
  const { animate = false } = options;
  state.boardFen = fen || state.boardFen;
  const previousPieces = state.previousRenderedPieces || {};
  const squares = parseFenBoard(state.boardFen);
  const moveHint = currentBoardHint();
  const lesson = currentLesson();
  const currentTurn = sideToMove(state.boardFen);
  const hasClassifiedMove = Boolean(moveHint?.classification && moveHint?.from && moveHint?.to);
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
      if (state.dragFrom === squareName) square.classList.add("drag-source");
      if (!hasClassifiedMove && state.lastMove?.from === squareName) square.classList.add("last-from");
      if (!hasClassifiedMove && state.lastMove?.to === squareName) square.classList.add("last-to");
      if (hasClassifiedMove && moveHint?.from === squareName) {
        square.classList.add("classified-source", `classification-${moveHint.key}`);
        const overlay = document.createElement("div");
        overlay.className = "square-classification-overlay";
        square.appendChild(overlay);
      }
      if (hasClassifiedMove && moveHint?.to === squareName) {
        square.classList.add("classified-target", `classification-${moveHint.key}`);
        const overlay = document.createElement("div");
        overlay.className = "square-classification-overlay";
        square.appendChild(overlay);
        square.insertAdjacentHTML("beforeend", squareClassificationMarkup(moveHint.classification));
      }

        const legalTargets = state.selectedSquare
          ? allowedTargetsForSquare(state.selectedSquare, lesson, state.boardFen)
          : [];
        const targetMove = legalTargets.find((item) => item.to === squareName);
        if (targetMove) {
          square.classList.add(targetMove.capture ? "legal-capture" : "legal-target");
          const dot = document.createElement("div");
          dot.className = "move-dot";
        square.appendChild(dot);
      }

      square.addEventListener("click", () => handleSquareClick(squareName));
      if (piece) {
        const img = document.createElement("img");
        img.className = "piece";
        img.src = PIECE_ASSETS[piece];
        img.alt = piece;
        if (state.selectedSquare === squareName) img.classList.add("piece-selected");
        if (state.dragFrom === squareName && state.dragGhost instanceof HTMLElement) {
          img.classList.add("piece-dragging-source");
        }
        if (isSquareMovableByUser(squareName, lesson, state.boardFen)) {
          img.classList.add("piece-movable");
          square.classList.add("movable-piece-square");
          img.addEventListener("pointerdown", (event) => {
            beginPieceDrag(squareName, piece, event);
          });
        }
        square.appendChild(img);
      }
      el.board.appendChild(square);
    });
  });
  const shouldAnimate = Boolean(
    animate
    && state.pendingMoveAnimationKey
    && state.pendingMoveAnimationKey !== state.renderedMoveAnimationKey
  );
  if (shouldAnimate) {
    animateLastMove(previousPieces);
    state.renderedMoveAnimationKey = state.pendingMoveAnimationKey;
  } else {
    clearMoveAnimation();
  }
  state.previousRenderedPieces = pieceMapFromFen(state.boardFen);
  renderArrows(currentLiveInsight(lesson));
}

async function handleGlobalPointerUp(event) {
  if (!state.dragFrom) return;
  if (state.dragPointerId !== null && event.pointerId !== state.dragPointerId) return;
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const square = target instanceof Element ? target.closest(".square") : null;
  const from = state.dragFrom;
  const moved = state.dragMoved;
  clearDragState();
  if (!(square instanceof HTMLElement)) {
    state.selectedSquare = from;
    state.suppressNextClick = true;
    renderBoard(state.boardFen, { animate: false });
    return;
  }
  const to = square.dataset.square || "";
  if (!to) {
    state.selectedSquare = from;
    state.suppressNextClick = true;
    renderBoard(state.boardFen, { animate: false });
    return;
  }
  if (!moved || from === to) {
    state.selectedSquare = from;
    state.suppressNextClick = true;
    renderBoard(state.boardFen, { animate: false });
    return;
  }
  state.suppressNextClick = true;
  await submitTrainerMove(from, to);
}

function handleSquareClick(squareName) {
  const lesson = currentLesson();
  if (lesson && !canUserInteract(lesson)) return;
  if (!lesson && !(state.legalMoves || []).length) {
    void initializeFreeAnalysisBoard();
    return;
  }
  if (state.suppressNextClick) {
    state.suppressNextClick = false;
    return;
  }
  const clickedMovable = isSquareMovableByUser(squareName, lesson);
  if (!state.selectedSquare) {
    if (clickedMovable) {
      state.selectedSquare = squareName;
      renderBoard(state.boardFen, { animate: false });
    }
    return;
  }
  if (state.selectedSquare === squareName) {
    state.selectedSquare = "";
    renderBoard(state.boardFen, { animate: false });
    return;
  }
    const activeTargets = allowedTargetsForSquare(state.selectedSquare, lesson, state.boardFen);
    if (!activeTargets.some((item) => item.to === squareName) && clickedMovable) {
      state.selectedSquare = squareName;
      renderBoard(state.boardFen, { animate: false });
      return;
    }
  if (activeTargets.some((item) => item.to === squareName)) {
    void submitTrainerMove(state.selectedSquare, squareName);
    return;
  }
  state.selectedSquare = "";
  renderBoard(state.boardFen, { animate: false });
}

async function submitTrainerMove(from, to) {
  const lesson = currentLesson();
  if (!lesson) {
    await submitFreeAnalysisMove(from, to);
    return;
  }
  if (!canUserInteract(lesson)) {
    state.selectedSquare = "";
    renderBoard(state.boardFen, { animate: false });
    return;
  }
    const move = allowedTargetsForSquare(from, lesson, state.boardFen).find((item) => item.to === to);
  if (!move) {
    state.selectedSquare = from;
    renderBoard(state.boardFen, { animate: false });
    return;
  }
  state.selectedSquare = "";
  renderBoard(state.boardFen, { animate: false });

  const phase = syncTrainerPhase(lesson);
  const rootCursor = lessonRootCursor(lesson);
  const runToken = lessonRunToken(lesson);
  const preMoveFen = state.boardFen;
  const instantClassification = instantMoveClassification(lesson, move);
  const moveMetaPromise = classifyMoveAtFen(
    preMoveFen,
    lesson,
    move.uci,
    move.san,
    moveRepeatedCount(lesson, move.uci),
  );
  const moveInsight = currentLiveInsight(lesson);
  const playedClassification = instantClassification;
  const recommendedClassification =
    moveInsight?.recommended_classification
    || lesson.recommended_classification
    || null;
  const recommendedMoveLabel = moveInsight?.recommended_move || lesson.best_reply;

  if (phase === "decision_point") {
    const previewPayload = await previewMoveOnBoard(move.uci);
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;
    const chosenBranch = findBranchLine(lesson, move.uci) || findBranchLineByFen(lesson, previewPayload?.fen);
    if (chosenBranch) {
      state.branchLocked = true;
      state.activeTrainingLine = [...(lesson.intro_line_uci || []), ...(chosenBranch.line_uci || [])];
      state.activeTrainingLineSan = combineSanSegments(lesson.intro_line_san, chosenBranch.line_san);
      state.trainerPhase = "locked_line";
      playMoveSound(previewPayload.played_san);
      applyBoardState(previewPayload, { classification: playedClassification || recommendedClassification || null });
      appendPlayedMove(move.uci, previewPayload.played_san || move.san);
      renderBoard(state.boardFen, { animate: true });
      const appliedFen = state.boardFen;
      moveMetaPromise.then((moveMeta) => {
        applyResolvedMoveClassification(move.uci, moveMeta?.classification || null, appliedFen);
      });
      state.trainingCursor = rootCursor + 1;
      syncTrainerPhase(lesson);
      if (chosenBranch.uci === lesson.preferred_branch_uci) {
        el.trainerFeedback.innerHTML = `Correct. <strong>${escapeHtml(move.san)}</strong>${classificationBadge(playedClassification, "inline")} ${escapeHtml(lesson.explanation)}`;
      } else {
        const sourceLabel = move.uci === chosenBranch.uci
          ? (chosenBranch.source === "repertoire" ? "your repeated repertoire branch" : "a known branch in this position")
          : "a transposition back into your repertoire";
        el.trainerFeedback.innerHTML = `<strong>${escapeHtml(move.san)}</strong>${classificationBadge(playedClassification, "inline")} matches ${escapeHtml(sourceLabel)}. Bookup will follow it, but the preferred move here is <strong>${escapeHtml(recommendedMoveLabel)}</strong>${classificationBadge(recommendedClassification, "inline")}.`;
      }
      el.trainerFeedback.classList.remove("empty");
      const syncResult = await syncTrainerToPlayableTurn();
      if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;
      if (syncResult?.autoMoves?.length) {
        el.trainerFeedback.innerHTML += ` ${renderAutoMoveSummary(syncResult.autoMoves)}`;
      }
      renderQueue();
      return;
    }

    state.lessonMistakes += 1;
    recordReview(lesson.lesson_id, false);
    playMoveSound("", { error: true });
    playMoveSound(previewPayload.played_san || move.san);
    applyBoardState(previewPayload, { classification: playedClassification || recommendedClassification || null });
    appendPlayedMove(move.uci, previewPayload.played_san || move.san);
    renderBoard(state.boardFen, { animate: true });
    const appliedFen = state.boardFen;
    moveMetaPromise.then((moveMeta) => {
      applyResolvedMoveClassification(move.uci, moveMeta?.classification || null, appliedFen);
    });
    state.trainingCursor += 1;
    state.branchLocked = false;
    syncTrainerPhase(lesson);
    el.trainerFeedback.innerHTML = `<strong>${escapeHtml(move.san)}</strong>${classificationBadge(playedClassification, "inline")} leaves your known repertoire here. Recommended move: <strong>${escapeHtml(recommendedMoveLabel)}</strong>${classificationBadge(recommendedClassification, "inline")}. Play it if you want to continue this repertoire line, or choose another legal move.`;
    el.trainerFeedback.classList.remove("empty");
    updateTrainerCopy();
    await updateCurrentInsight();
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;
    return;
  }

  if (phase === "intro_autoplay" || phase === "completed") return;

  let expectedUci = liveExpectedMoveUci(lesson);
  let expectedEntry = (state.legalMoves || []).find((item) => item.uci === expectedUci);
  if (expectedUci && !expectedEntry) {
    await refreshLegalMoves(state.boardFen);
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;
    expectedUci = liveExpectedMoveUci(lesson);
    expectedEntry = (state.legalMoves || []).find((item) => item.uci === expectedUci);
  }
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
    el.trainerFeedback.innerHTML = `<strong>${escapeHtml(move.san)}</strong>${classificationBadge(playedClassification, "inline")} leaves this repertoire line. ${escapeHtml(explanation)} Recommended move: <strong>${escapeHtml(expectedSan)}</strong>${classificationBadge(recommendedClassification, "inline")}. Choose another legal move or play the recommendation to continue.`;
    el.trainerFeedback.classList.remove("empty");
    await applyMoveToBoard(move.uci, playedClassification || recommendedClassification || null);
    const appliedFen = state.boardFen;
    moveMetaPromise.then((moveMeta) => {
      applyResolvedMoveClassification(move.uci, moveMeta?.classification || null, appliedFen);
    });
    appendPlayedMove(move.uci, state.lastMoveSan || move.san);
    state.trainingCursor += 1;
    state.branchLocked = false;
    syncTrainerPhase(lesson);
    el.boardLine.textContent = currentPlayedLineSan().join(" ") || lessonTrainingLineSan(lesson).join(" ") || lesson.continuation_san || "";
    el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
    updateTrainerCopy();
    await updateCurrentInsight();
    return;
  }

  await applyMoveToBoard(move.uci, playedClassification || recommendedClassification || null);
  if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;
  const appliedFen = state.boardFen;
  moveMetaPromise.then((moveMeta) => {
    applyResolvedMoveClassification(move.uci, moveMeta?.classification || null, appliedFen);
  });
  appendPlayedMove(move.uci, state.lastMoveSan || move.san);
  state.trainingCursor += 1;
  syncTrainerPhase(lesson);
  const syncResult = await syncTrainerToPlayableTurn();
  if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;

  const lineFinished = syncTrainerPhase(lesson) === "completed";
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
      : "That keeps the repertoire line on track.";
  el.trainerFeedback.innerHTML = lineFinished
    ? `Line complete. <strong>${escapeHtml(move.san)}</strong>${classificationBadge(playedClassification || recommendedClassification, "inline")} ${escapeHtml(successExplanation)}`
    : `Correct. <strong>${escapeHtml(move.san)}</strong>${classificationBadge(playedClassification || recommendedClassification, "inline")} ${escapeHtml(successExplanation)}`;
  if (syncResult?.autoMoves?.length) {
    el.trainerFeedback.innerHTML += ` ${renderAutoMoveSummary(syncResult.autoMoves)}`;
  }
  el.trainerFeedback.classList.remove("empty");
  el.boardLine.textContent = currentPlayedLineSan().join(" ") || lessonTrainingLineSan(lesson).join(" ") || lesson.continuation_san || "";
  el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
}

async function submitFreeAnalysisMove(from, to) {
  const move = allowedTargetsForSquare(from, null, state.boardFen).find((item) => item.to === to);
  if (!move) {
    state.selectedSquare = from;
    renderBoard(state.boardFen, { animate: false });
    return;
  }
  state.selectedSquare = "";
  renderBoard(state.boardFen, { animate: false });

  const preMoveFen = state.boardFen;
  const playedClassification = instantMoveClassification(null, move);
  const classificationPromise = fetchPositionInsight(preMoveFen, currentPlayedLine(), move.uci, move.san, 0)
    .then((moveInsight) => moveInsight?.your_move_classification || moveInsight?.played_classification || null)
    .catch(() => null);

  try {
    const payload = await applyMoveToBoard(move.uci, playedClassification);
    const appliedFen = state.boardFen;
    classificationPromise.then((classification) => {
      applyResolvedMoveClassification(move.uci, classification, appliedFen);
    });
    appendPlayedMove(move.uci, payload.played_san || move.san);
    state.currentInsight = null;
    state.currentInsightKey = "";
    el.boardLine.textContent = currentPlayedLineSan().join(" ") || "No line loaded yet.";
    el.boardLine.classList.toggle("empty", !currentPlayedLineSan().length);
    await updateFreeAnalysisInsight();
  } catch (error) {
    el.trainerFeedback.textContent = error?.message || "That move could not be applied.";
    el.trainerFeedback.classList.remove("empty");
    renderBoard(state.boardFen, { animate: false });
  }
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
    renderMistakeTimeline(state.payload?.profile?.mistake_timeline || null);
    renderReviewSchedule(state.payload?.profile?.review_schedule || null);
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
    manual_repertoire: state.manualRepertoire,
    manual_drift_choices: state.manualDriftChoices,
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
  const icon = String(record?.icon || MOVE_CLASSIFICATION_ICONS[key] || "").trim();
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


