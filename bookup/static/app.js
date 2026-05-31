const defaults = window.APP_DEFAULTS || {};

if (typeof document !== "undefined") {
  document.documentElement.dataset.bookupUi = "compact-redesign-v9";
}
const webMode = Boolean(defaults.web_mode);
const brilliantTrackerEnabled = defaults.enable_brilliant_tracker !== false;
const REVIEW_KEY = "bookup-review-stats-v1";
const PROFILE_SCHEMA_VERSION = 24;
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
  mainPlatform: document.getElementById("mainPlatformInput"),
  mainUsername: document.getElementById("mainUsernameInput"),
  lichessUsername: document.getElementById("lichessUsernameInput"),
  username: document.getElementById("usernameInput"),
  timeClasses: document.getElementById("timeClassesInput"),
  maxGames: document.getElementById("maxGamesInput"),
  importAllGames: document.getElementById("importAllGamesInput"),
  autoImportStartup: document.getElementById("autoImportStartupInput"),
  lichessToken: document.getElementById("lichessTokenInput"),
  enginePath: document.getElementById("enginePathInput"),
  depth: document.getElementById("depthInput"),
  thinkTime: document.getElementById("thinkTimeInput"),
  multiPv: document.getElementById("multiPvInput"),
  threads: document.getElementById("threadsInput"),
  parallelWorkers: document.getElementById("parallelWorkersInput"),
  hash: document.getElementById("hashInput"),
  analyze: document.getElementById("analyzeBtn"),
  pgnImport: document.getElementById("pgnImportInput"),
  importPgn: document.getElementById("importPgnBtn"),
  pgnImportStatus: document.getElementById("pgnImportStatus"),
  chessnutDbPath: document.getElementById("chessnutDbPathInput"),
  chessnutPlayerColor: document.getElementById("chessnutPlayerColorInput"),
  importChessnut: document.getElementById("importChessnutBtn"),
  chessnutImportStatus: document.getElementById("chessnutImportStatus"),
  status: document.getElementById("status"),
  progressTrack: document.getElementById("progressTrack"),
  progressFill: document.getElementById("progressFill"),
  progressLabel: document.getElementById("progressLabel"),
  analysisPreviewPanel: document.getElementById("analysisPreviewPanel"),
  heroTitle: document.getElementById("heroTitle"),
  heroSummary: document.getElementById("heroSummary"),
  summaryPositions: document.getElementById("summaryPositions"),
  summaryNeedsWork: document.getElementById("summaryNeedsWork"),
  summaryQueue: document.getElementById("summaryQueue"),
  badgeGames: document.getElementById("badgeGames"),
  badgeKnown: document.getElementById("badgeKnown"),
  badgeWinRate: document.getElementById("badgeWinRate"),
  reclassifyFresh: document.getElementById("reclassifyFreshBtn"),
  resetWorkspace: document.getElementById("resetWorkspaceBtn"),
  firstMoveWhite: document.getElementById("firstMoveWhite"),
  firstMoveBlack: document.getElementById("firstMoveBlack"),
  repertoireMapWhite: document.getElementById("repertoireMapWhite"),
  repertoireMapBlack: document.getElementById("repertoireMapBlack"),
  healthDashboard: document.getElementById("healthDashboard"),
  statsSummary: document.getElementById("statsSummaryPanel"),
  brilliantTrackerSection: document.getElementById("brilliantTrackerSection"),
  ratingProgress: document.getElementById("ratingProgressPanel"),
  brilliantTracker: document.getElementById("brilliantTrackerPanel"),
  memoryScorePanel: document.getElementById("memoryScorePanel"),
  driftDetectorPanel: document.getElementById("driftDetectorPanel"),
  prepPackPanel: document.getElementById("prepPackPanel"),
  cacheDashboard: document.getElementById("cacheDashboard"),
  studyPlanPanel: document.getElementById("studyPlanPanel"),
  confidenceGraphPanel: document.getElementById("confidenceGraphPanel"),
  driftFixPanel: document.getElementById("driftFixPanel"),
  importSpeedPanel: document.getElementById("importSpeedPanel"),
  stockfishStatsPanel: document.getElementById("stockfishStatsPanel"),
  transpositionList: document.getElementById("transpositionList"),
  previewPanel: document.getElementById("previewPanel"),
  knownArchiveList: document.getElementById("knownArchiveList"),
  gameMoveTree: document.getElementById("gameMoveTree"),
  theoryMove: document.getElementById("theoryMoveInput"),
  theoryPly: document.getElementById("theoryPlyInput"),
  generateTheory: document.getElementById("generateTheoryBtn"),
  theoryOutput: document.getElementById("theoryOutput"),
  smartTheoryStartingSource: document.getElementById("smartTheoryStartingSource"),
  smartTheoryMyColor: document.getElementById("smartTheoryMyColor"),
  smartTheoryOpponentAccuracy: document.getElementById("smartTheoryOpponentAccuracy"),
  smartTheoryDepth: document.getElementById("smartTheoryDepth"),
  smartTheoryMoveTime: document.getElementById("smartTheoryMoveTime"),
  smartTheoryReplies: document.getElementById("smartTheoryReplies"),
  smartTheoryMaxPly: document.getElementById("smartTheoryMaxPly"),
  smartTheoryMaxPositions: document.getElementById("smartTheoryMaxPositions"),
  smartTheoryCustomFen: document.getElementById("smartTheoryCustomFen"),
  smartTheoryIncludeRare: document.getElementById("smartTheoryIncludeRare"),
  smartTheoryIncludeMistakes: document.getElementById("smartTheoryIncludeMistakes"),
  smartTheoryIncludeBlunders: document.getElementById("smartTheoryIncludeBlunders"),
  smartTheoryAvoidAbsurd: document.getElementById("smartTheoryAvoidAbsurd"),
  smartTheoryEcoOnly: document.getElementById("smartTheoryEcoOnly"),
  smartTheoryCacheEvals: document.getElementById("smartTheoryCacheEvals"),
  smartTheoryGenerate: document.getElementById("smartTheoryGenerateBtn"),
  smartTheoryStop: document.getElementById("smartTheoryStopBtn"),
  smartTheoryClear: document.getElementById("smartTheoryClearBtn"),
  smartTheoryExport: document.getElementById("smartTheoryExportBtn"),
  smartTheoryImport: document.getElementById("smartTheoryImportInput"),
  smartTheoryStatus: document.getElementById("smartTheoryStatus"),
  smartTheoryProgress: document.getElementById("smartTheoryProgress"),
  smartTheoryMiniBoard: document.getElementById("smartTheoryMiniBoard"),
  smartTheoryCurrentMeta: document.getElementById("smartTheoryCurrentMeta"),
  smartTheoryMoveList: document.getElementById("smartTheoryMoveList"),
  smartTheoryOpeningMeta: document.getElementById("smartTheoryOpeningMeta"),
  smartTheoryRecommendation: document.getElementById("smartTheoryRecommendation"),
  smartTheorySaveCorrection: document.getElementById("smartTheorySaveCorrectionBtn"),
  smartTheoryOpponentReplies: document.getElementById("smartTheoryOpponentReplies"),
  smartTheoryExplanation: document.getElementById("smartTheoryExplanation"),
  smartTheoryTree: document.getElementById("smartTheoryTree"),
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
  studyParallelWorkers: document.getElementById("studyParallelWorkersInput"),
  studyHash: document.getElementById("studyHashInput"),
  studyApplySettings: document.getElementById("studyApplySettingsBtn"),
  studySettingsStatus: document.getElementById("studySettingsStatus"),
  realignSourceFen: document.getElementById("realignSourceFenInput"),
  realignUseStart: document.getElementById("realignUseStartBtn"),
  realignGenerate: document.getElementById("realignGenerateBtn"),
  realignStatus: document.getElementById("realignStatus"),
  realignOutput: document.getElementById("realignOutput"),
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
  ratingProgressRange: "90",
  ratingProgressTimeClass: "",
  ratingProgressPointIndex: null,
  brilliantProgressRange: "90",
  brilliantProgressTimeClass: "",
  brilliantProgressPointIndex: null,
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
  lastMoveReaction: null,
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
  freeBranchMode: false,
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
  analysisProgressValue: 0,
  analysisStatusTimer: 0,
  analysisStatusPollStartedAt: 0,
  autoImportRunning: false,
  prepPackText: "",
  smartTheoryJobId: "",
  smartTheoryTree: null,
  smartTheorySelectedNodeId: "",
  smartTheoryPollTimer: 0,
};

async function init() {
  const savedNotice = sessionStorage.getItem("bookup-status-message") || "";
  const shouldAutoRebuild = sessionStorage.getItem("bookup-auto-rebuild") === "1";
  sessionStorage.removeItem("bookup-status-message");
  sessionStorage.removeItem("bookup-auto-rebuild");
  preloadClassificationIcons();
  syncIdentityDefaults();
  el.timeClasses.value = defaults.time_classes || "all";
  el.maxGames.value = defaults.max_games ?? 0;
  el.importAllGames.checked = Number(defaults.max_games ?? 0) === 0;
  if (el.autoImportStartup) el.autoImportStartup.checked = defaults.auto_import_on_startup !== false;
  el.lichessToken.value = defaults.lichess_token || "";
  el.enginePath.value = defaults.engine_path || "";
  if (el.chessnutDbPath) el.chessnutDbPath.value = defaults.chessnut_db_path || "";
  if (el.chessnutPlayerColor) el.chessnutPlayerColor.value = defaults.chessnut_player_color || "white";
  el.depth.value = defaults.depth || 24;
  if (el.thinkTime) el.thinkTime.value = String(defaults.think_time_sec ?? 5);
  el.multiPv.value = defaults.multipv || 5;
  el.threads.value = defaults.threads || 8;
  if (el.parallelWorkers) el.parallelWorkers.value = defaults.parallel_workers || 1;
  el.hash.value = defaults.hash_mb || 2048;
  if (el.smartTheoryDepth) el.smartTheoryDepth.value = String(Math.max(10, Math.min(28, Number(defaults.depth || 18))));
  if (el.smartTheoryMoveTime) el.smartTheoryMoveTime.value = String(Number(defaults.think_time_sec || 1.2));
  if (el.smartTheoryReplies) el.smartTheoryReplies.value = "3";
  if (el.smartTheoryMaxPly) el.smartTheoryMaxPly.value = "20";
  if (el.smartTheoryMaxPositions) el.smartTheoryMaxPositions.value = "300";
  if (el.smartTheoryIncludeRare) el.smartTheoryIncludeRare.checked = true;
  if (el.smartTheoryIncludeMistakes) el.smartTheoryIncludeMistakes.checked = true;
  if (el.smartTheoryIncludeBlunders) el.smartTheoryIncludeBlunders.checked = false;
  if (el.smartTheoryAvoidAbsurd) el.smartTheoryAvoidAbsurd.checked = true;
  if (el.smartTheoryEcoOnly) el.smartTheoryEcoOnly.checked = false;
  if (el.smartTheoryCacheEvals) el.smartTheoryCacheEvals.checked = true;
  syncStudySettingsFromSetup();

  el.analyze.addEventListener("click", runAnalysis);
  el.importPgn?.addEventListener("click", importPgnGames);
  el.importChessnut?.addEventListener("click", importChessnutGames);
  el.importAllGames?.addEventListener("change", syncImportScope);
  el.autoImportStartup?.addEventListener("change", () => { void saveStartupImportSetting(); });
  el.reclassifyFresh?.addEventListener("click", () => { void resetLocalWorkspace({ rebuild: true }); });
  el.resetWorkspace?.addEventListener("click", () => { void resetLocalWorkspace({ rebuild: false }); });
  el.trainerReset?.addEventListener("click", resetTrainerLesson);
  el.trainerNext?.addEventListener("click", nextLesson);
  el.studyApplySettings?.addEventListener("click", () => { void saveStudySettings(); });
  el.realignUseStart?.addEventListener("click", () => {
    if (el.realignSourceFen) {
      el.realignSourceFen.value = START_FEN;
    }
    if (el.realignStatus) {
      el.realignStatus.textContent = "Using the standard starting position as your current Chessnut setup.";
    }
  });
  el.realignGenerate?.addEventListener("click", () => { void generateRealignPlan(); });
  el.generateTheory?.addEventListener("click", () => { void generateTheoryLine(); });
  el.smartTheoryGenerate?.addEventListener("click", () => { void runSmartTheoryGeneration(); });
  el.smartTheoryStop?.addEventListener("click", () => { void stopSmartTheoryGeneration(); });
  el.smartTheoryClear?.addEventListener("click", clearSmartTheoryState);
  el.smartTheoryExport?.addEventListener("click", exportSmartTheoryJson);
  el.smartTheoryImport?.addEventListener("change", importSmartTheoryJson);
  el.smartTheorySaveCorrection?.addEventListener("click", () => { void saveSmartTheoryCorrection(); });
  [el.lichessToken, el.enginePath, el.depth, el.multiPv, el.threads, el.parallelWorkers, el.hash].forEach((input) => {
    input?.addEventListener("change", syncStudySettingsFromSetup);
  });
  el.mainPlatform?.addEventListener("change", handleMainIdentityChange);
  el.mainUsername?.addEventListener("input", handleMainIdentityChange);
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
  if (!brilliantTrackerEnabled && el.brilliantTrackerSection) {
    el.brilliantTrackerSection.hidden = true;
  }
  renderCoords();
  renderBoard(START_FEN, { animate: false });
  setActiveTab("setup");
  renderStudyWorkspace();
  await bootstrapLocalState();
  void initializeFreeAnalysisBoard();
  if (savedNotice) {
    setProgress(0, savedNotice, { allowDecrease: true });
  }
  if (shouldAutoRebuild) {
    await runAnalysis({ forceRefresh: true });
    return;
  }
  void checkAutoImportOnStartup();
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
  if (el.studyParallelWorkers) el.studyParallelWorkers.value = el.parallelWorkers?.value || defaults.parallel_workers || 1;
  if (el.studyHash) el.studyHash.value = el.hash?.value || defaults.hash_mb || 2048;
}

function resolveConfiguredUsername() {
  const direct = String(el.username?.value || "").trim();
  if (direct) return direct;
  const mainPlatform = String(el.mainPlatform?.value || defaults.main_platform || "chesscom").trim().toLowerCase();
  const mainUsername = String(el.mainUsername?.value || defaults.main_username || "").trim();
  if (mainPlatform === "chesscom" && mainUsername) return mainUsername;
  return String(defaults.username || "").trim();
}

function syncIdentityDefaults() {
  if (el.mainPlatform) {
    el.mainPlatform.value = String(defaults.main_platform || "chesscom").trim().toLowerCase() || "chesscom";
  }
  if (el.mainUsername) {
    el.mainUsername.value = defaults.main_username || "";
  }
  if (el.lichessUsername) {
    el.lichessUsername.value = defaults.lichess_username || "";
  }
  const importUsername = String(defaults.username || "").trim();
  if (el.username) {
    el.username.value = importUsername;
    if (!el.username.value && String(el.mainPlatform?.value || "").toLowerCase() === "chesscom") {
      el.username.value = String(el.mainUsername?.value || "").trim();
    }
  }
}

function handleMainIdentityChange() {
  if (!el.username) return;
  const currentImport = String(el.username.value || "").trim();
  const previousDefault = String(defaults.username || "").trim();
  if (currentImport && currentImport !== previousDefault) return;
  if (String(el.mainPlatform?.value || "").toLowerCase() === "chesscom") {
    el.username.value = String(el.mainUsername?.value || "").trim();
  } else if (!currentImport || currentImport === previousDefault) {
    el.username.value = "";
  }
}

function applyStudySettingsToSetup(saved = {}) {
  if (el.lichessToken && Object.prototype.hasOwnProperty.call(saved, "lichess_token")) el.lichessToken.value = saved.lichess_token || "";
  if (el.enginePath && Object.prototype.hasOwnProperty.call(saved, "engine_path")) el.enginePath.value = saved.engine_path || "";
  if (el.depth && Object.prototype.hasOwnProperty.call(saved, "depth")) el.depth.value = saved.depth;
  if (el.thinkTime && Object.prototype.hasOwnProperty.call(saved, "think_time_sec")) el.thinkTime.value = String(saved.think_time_sec);
  if (el.multiPv && Object.prototype.hasOwnProperty.call(saved, "multipv")) el.multiPv.value = saved.multipv;
  if (el.threads && Object.prototype.hasOwnProperty.call(saved, "threads")) el.threads.value = saved.threads;
  if (el.parallelWorkers && Object.prototype.hasOwnProperty.call(saved, "parallel_workers")) el.parallelWorkers.value = saved.parallel_workers;
  if (el.hash && Object.prototype.hasOwnProperty.call(saved, "hash_mb")) el.hash.value = saved.hash_mb;
  syncStudySettingsFromSetup();
}

function applyDefaultsToState(saved = {}) {
  Object.entries(saved || {}).forEach(([key, value]) => {
    defaults[key] = value;
  });
  syncIdentityDefaults();
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
    parallel_workers: Number(el.studyParallelWorkers?.value || el.parallelWorkers?.value || defaults.parallel_workers || 1),
    hash_mb: Number(el.studyHash?.value || el.hash?.value || defaults.hash_mb || 2048),
  };
}

function currentSetupSettingsPayload() {
  return {
    username: resolveConfiguredUsername(),
    main_platform: String(el.mainPlatform?.value || defaults.main_platform || "chesscom").trim().toLowerCase(),
    main_username: String(el.mainUsername?.value || defaults.main_username || "").trim(),
    lichess_username: String(el.lichessUsername?.value || defaults.lichess_username || "").trim(),
    time_classes: String(el.timeClasses?.value || defaults.time_classes || "all").trim(),
    max_games: el.importAllGames?.checked ? 0 : Number(el.maxGames?.value || defaults.max_games || 0),
    auto_import_on_startup: el.autoImportStartup?.checked !== false,
    chessnut_db_path: String(el.chessnutDbPath?.value || defaults.chessnut_db_path || "").trim(),
    chessnut_player_color: String(el.chessnutPlayerColor?.value || defaults.chessnut_player_color || "white").trim().toLowerCase(),
    ...currentStudySettingsPayload(),
  };
}

async function saveStartupImportSetting() {
  try {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentSetupSettingsPayload()),
    });
    defaults.auto_import_on_startup = el.autoImportStartup?.checked !== false;
  } catch {
    // Non-critical; the next profile save will persist the same checkbox value.
  }
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

function renderRealignPlan(plan) {
  if (!el.realignOutput) return;
  const moveSteps = Array.isArray(plan?.move_steps) ? plan.move_steps : [];
  const removeSteps = Array.isArray(plan?.remove_steps) ? plan.remove_steps : [];
  const placeSteps = Array.isArray(plan?.place_steps) ? plan.place_steps : [];
  const sections = [];

  if (moveSteps.length) {
    sections.push(`
      <div class="realign-step-group">
        <div class="section-label">Move pieces</div>
        <div class="realign-step-list">
          ${moveSteps.map((step) => `<div class="realign-step">${escapeHtml(step.text || "")}</div>`).join("")}
        </div>
      </div>
    `);
  }
  if (removeSteps.length) {
    sections.push(`
      <div class="realign-step-group">
        <div class="section-label">Remove extras</div>
        <div class="realign-step-list">
          ${removeSteps.map((step) => `<div class="realign-step">${escapeHtml(step.text || "")}</div>`).join("")}
        </div>
      </div>
    `);
  }
  if (placeSteps.length) {
    sections.push(`
      <div class="realign-step-group">
        <div class="section-label">Place missing pieces</div>
        <div class="realign-step-list">
          ${placeSteps.map((step) => `<div class="realign-step">${escapeHtml(step.text || "")}</div>`).join("")}
        </div>
      </div>
    `);
  }

  const targetLabel = String(plan?.target_label || "").trim() || "Current analysis position";
  if (plan?.already_aligned) {
    el.realignOutput.className = "realign-output";
    el.realignOutput.innerHTML = `
      <div class="realign-summary">
        <strong>Your physical board already matches the current analysis position.</strong>
        <span>Target: ${escapeHtml(targetLabel)} · ${Number(plan?.target_piece_count || 0)} pieces in place</span>
      </div>
    `;
    return;
  }

  el.realignOutput.className = "realign-output";
  el.realignOutput.innerHTML = `
    <div class="realign-summary">
      <strong>${Number(plan?.total_actions || 0)} actions to realign your Chessnut board</strong>
      <span>Target: ${escapeHtml(targetLabel)} · unchanged ${Number(plan?.unchanged_count || 0)}/${Number(plan?.target_piece_count || 0)} pieces</span>
    </div>
    ${sections.join("") || `<div class="line-note">No changes were required.</div>`}
  `;
}

async function generateRealignPlan() {
  if (!el.realignGenerate) return;
  const sourceFen = String(el.realignSourceFen?.value || "").trim();
  const targetFen = normalizeFen(state.boardFen || START_FEN);
  const targetLabel = String(el.boardTitle?.textContent || "").trim() || "Current analysis position";
  el.realignGenerate.disabled = true;
  if (el.realignStatus) {
    el.realignStatus.textContent = "Building the Chessnut realign plan for the current analysis position...";
  }
  if (el.realignOutput) {
    el.realignOutput.className = "realign-output empty";
    el.realignOutput.textContent = "Generating plan...";
  }
  try {
    const response = await fetch("/api/realign-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_fen: sourceFen,
        target_fen: targetFen,
        target_label: targetLabel,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not build the Chessnut realign plan.");
    }
    renderRealignPlan(data);
    if (el.realignStatus) {
      el.realignStatus.textContent = data.already_aligned
        ? "Your Chessnut board already matches the analysis board."
        : `Plan ready. Follow the ${Number(data.total_actions || 0)} realign steps on your physical board.`;
    }
  } catch (error) {
    if (el.realignOutput) {
      el.realignOutput.className = "realign-output empty";
      el.realignOutput.textContent = error.message || "Could not build the Chessnut realign plan.";
    }
    if (el.realignStatus) {
      el.realignStatus.textContent = error.message || "Could not build the Chessnut realign plan.";
    }
  } finally {
    el.realignGenerate.disabled = false;
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
  const { classification = null, reaction = null } = options;
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
    state.lastMoveReaction = reaction;
    if (hasPlayedSan) {
      state.lastMoveSan = String(payload?.played_san || "");
    }
    state.pendingMoveAnimationKey = state.lastMove
      ? `${state.boardFen}|${state.lastMove.from}|${state.lastMove.to}|${state.lastMoveSan}`
      : "";
  } else if (classification) {
    state.lastMoveClassification = classification;
    state.lastMoveReaction = reaction || state.lastMoveReaction;
  }
  if (state.selectedSquare && !isSquareMovableByUser(state.selectedSquare, currentLesson(), state.boardFen)) {
    state.selectedSquare = "";
  }
  if (state.activeLessonId) {
    syncTrainerPhase(currentLesson());
  }
}

async function resetLocalWorkspace({ rebuild = false } = {}) {
  const username = resolveConfiguredUsername();
  if (!username) {
    setProgress(0, "Enter a Chess.com username before resetting the local workspace.", { allowDecrease: true });
    return;
  }
  const prompt = rebuild
    ? `Clear Bookup's local cache for ${username} and rebuild the full repertoire from scratch?`
    : `Clear Bookup's local cache for ${username}? This removes the saved repertoire, progress, and engine cache for a clean install.`;
  if (!window.confirm(prompt)) {
    return;
  }
  const disabledButtons = [el.analyze, el.importPgn, el.importChessnut, el.reclassifyFresh, el.resetWorkspace].filter(Boolean);
  disabledButtons.forEach((button) => { button.disabled = true; });
  stopAnalysisProgress();
  setProgress(6, rebuild ? "Clearing local cache before a full reclassification..." : "Clearing local cache and saved analysis...", { allowDecrease: true });
  try {
    const response = await fetch("/api/reset-local-workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        clear_engine_cache: true,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Bookup could not clear the local workspace.");
    }
    sessionStorage.setItem("bookup-status-message", payload.message || "Local cache cleared.");
    if (rebuild) {
      sessionStorage.setItem("bookup-auto-rebuild", "1");
    }
    window.location.reload();
  } catch (error) {
    setProgress(0, error.message || "Bookup could not clear the local workspace.", { allowDecrease: true });
    disabledButtons.forEach((button) => { button.disabled = false; });
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

function boardSquareSize() {
  const board = el.board;
  if (!(board instanceof HTMLElement) || !board.offsetWidth) return 80;
  return board.offsetWidth / 8;
}

function arrowMetrics(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return null;
  const squareSize = boardSquareSize();
  const unitX = dx / distance;
  const unitY = dy / distance;
  const tailInset = Math.min(squareSize * 0.18, distance * 0.18);
  const headInset = Math.min(squareSize * 0.34, distance * 0.24);
  const startX = from.x + unitX * tailInset;
  const startY = from.y + unitY * tailInset;
  const endX = to.x - unitX * headInset;
  const endY = to.y - unitY * headInset;
  const length = Math.hypot(endX - startX, endY - startY);
  if (length < 12) return null;
  return {
    startX,
    startY,
    endX,
    endY,
    length,
    thickness: Math.max(14, Math.min(squareSize * 0.18, 18)),
    headSize: Math.max(20, Math.min(squareSize * 0.42, 30)),
  };
}

// Board-arrow overlay approach adapted from tetizz/play, with Bookup-specific colors and labels.
function renderArrowGroup(lines = [], role = "engine") {
  const palette = role === "threat"
    ? { marker: "threatArrowHead", color: "226, 84, 84", minOpacity: 0.5, falloff: 0.08 }
    : { marker: "engineArrowHead", color: "90, 176, 255", minOpacity: 0.42, falloff: 0.06 };
  return lines.map((line, index) => {
    const uci = String(line?.uci || "");
    if (uci.length < 4) return "";
    const from = squareCenter(uci.slice(0, 2));
    const to = squareCenter(uci.slice(2, 4));
    if (!from || !to) return "";
    const metrics = arrowMetrics(from, to);
    if (!metrics) return "";
    const emphasis = Math.max(palette.minOpacity, 0.72 - index * palette.falloff);
    return `
      <line
        class="board-arrow-line ${role}-arrow-line"
        x1="${metrics.startX.toFixed(2)}"
        y1="${metrics.startY.toFixed(2)}"
        x2="${metrics.endX.toFixed(2)}"
        y2="${metrics.endY.toFixed(2)}"
        stroke="rgba(${palette.color}, ${emphasis.toFixed(3)})"
        stroke-width="${metrics.thickness.toFixed(2)}"
        marker-end="url(#${palette.marker})"
      />
    `;
  }).join("");
}

function renderArrows(insight = null) {
  if (!el.boardArrows || !el.boardWrap) return;
  el.boardArrows.innerHTML = "";
  const engineLines = Array.isArray(insight?.candidate_lines) ? insight.candidate_lines.slice(0, 5) : [];
  const threatLines = Array.isArray(insight?.threat_lines) ? insight.threat_lines.slice(0, 3) : [];
  if (!engineLines.length && !threatLines.length) return;
  const board = el.board;
  const width = board instanceof HTMLElement && board.offsetWidth ? board.offsetWidth : 640;
  const height = board instanceof HTMLElement && board.offsetHeight ? board.offsetHeight : 640;
  const squareSize = boardSquareSize();
  const headSize = Math.max(18, Math.min(squareSize * 0.4, 28));
  const markerHalf = Math.max(9, headSize * 0.42);
  el.boardArrows.innerHTML = `
    <svg class="board-arrow-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <marker id="engineArrowHead" markerWidth="${headSize}" markerHeight="${headSize}" refX="${headSize - 2}" refY="${markerHalf}" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M 0 0 L ${headSize} ${markerHalf} L 0 ${headSize} L ${headSize * 0.28} ${markerHalf} Z" fill="rgba(90, 176, 255, 0.92)"></path>
        </marker>
        <marker id="threatArrowHead" markerWidth="${headSize}" markerHeight="${headSize}" refX="${headSize - 2}" refY="${markerHalf}" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M 0 0 L ${headSize} ${markerHalf} L 0 ${headSize} L ${headSize * 0.28} ${markerHalf} Z" fill="rgba(226, 84, 84, 0.92)"></path>
        </marker>
      </defs>
      <g class="board-arrow-group threat-arrows">${renderArrowGroup(threatLines, "threat")}</g>
      <g class="board-arrow-group engine-arrows">${renderArrowGroup(engineLines, "engine")}</g>
    </svg>
  `;
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
  const building = Boolean(
    state.analysisProgressTimer
    || el.analyze?.disabled
    || el.importPgn?.disabled
    || el.importChessnut?.disabled
    || state.autoImportRunning
  );
  const current = Number.isFinite(Number(state.analysisProgressValue))
    ? Number(state.analysisProgressValue)
    : 0;
  const displayValue = (!options.allowDecrease && building && bounded < current && bounded !== 100)
    ? current
    : bounded;
  state.analysisProgressValue = displayValue;
  const indeterminate = Boolean(options.indeterminate);
  if (el.progressFill) {
    el.progressFill.classList.toggle("indeterminate", indeterminate);
    if (!indeterminate) {
      el.progressFill.style.width = `${displayValue}%`;
    }
  }
  if (message) {
    setStatus(message);
  }
  if (el.progressLabel) {
    el.progressLabel.textContent = indeterminate ? "Working" : `${displayValue}%`;
  }
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "--";
  const total = Math.max(0, Math.round(Number(seconds)));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return `${hours}h ${rem}m`;
  }
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatRate(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "--";
  return `${numeric.toFixed(numeric >= 10 ? 1 : 2)}/s`;
}

function stockfishStatsFromStatus(status) {
  if (!status) return null;
  const resources = status.resources || {};
  return {
    ...resources,
    phase: status.phase || "idle",
    message: status.message || "",
    active: Boolean(status.active),
    progress: Number(status.progress || 0),
    games_done: Number(status.games_done ?? 0),
    games_total: Number(status.games_total ?? 0),
    positions_indexed: Number(status.positions_indexed ?? 0),
    positions_analyzed: Number(status.positions_done ?? status.positions_analyzed ?? 0),
    positions_total: Number(status.positions_total ?? 0),
    positions_left: Number(status.positions_left ?? 0),
    games_left: Number(status.games_left ?? 0),
    moves_left: Number(status.moves_left ?? 0),
    work_done: Number(status.work_done ?? 0),
    work_total: Number(status.work_total ?? 0),
    work_left: Number(status.work_left ?? 0),
    positions_per_second: Number(status.positions_per_second ?? 0),
    items_per_second: Number(status.items_per_second ?? 0),
    games_per_second: Number(status.games_per_second ?? status.items_per_second ?? 0),
    elapsed_sec: Number(status.elapsed_sec ?? 0),
    eta_sec: status.eta_sec,
    live_positions: Array.isArray(status.live_positions) ? status.live_positions : [],
    scan_active_workers: Number(status.scan_active_workers ?? 0),
    scan_active_slots: Array.isArray(status.scan_active_slots) ? status.scan_active_slots : [],
    brilliant_games_done: Number(status.brilliant_games_done ?? 0),
    brilliant_games_total: Number(status.brilliant_games_total ?? 0),
    brilliant_games_left: Number(status.brilliant_games_left ?? 0),
    brilliant_moves_scanned: Number(status.moves_scanned ?? 0),
    brilliant_moves_classified: Number(status.classified_moves ?? 0),
    brilliant_player_moves_total: Number(status.player_moves_total ?? status.moves_scanned ?? 0),
    brilliant_total_game_moves: Number(status.total_game_moves ?? 0),
    brilliant_opponent_moves_ignored: Number(status.opponent_moves_ignored ?? 0),
    brilliant_moves_outside_scan_window: Number(status.moves_outside_scan_window ?? 0),
    engine_cache_hits: Number(status.cache_hits ?? 0),
    engine_live_hits: Number(status.live_hits ?? 0),
  };
}

function analysisPhaseLabel(phase) {
  const labels = {
    starting: "Starting",
    loading_games: "Loading",
    fetch_archives: "Checking archives",
    fetch_games: "Importing",
    indexing: "Indexing",
    position_index: "Preparing engine",
    stockfish_positions: "Analyzing",
    brilliant_scan: "Classifying",
    complete: "Complete",
    failed: "Failed",
  };
  return labels[phase] || String(phase || "Analysis");
}

function analysisWorkSummary(stats) {
  const phase = stats.phase || "";
  const gamesDone = Number(stats.games_done || 0);
  const gamesTotal = Number(stats.games_total || 0);
  const indexed = Number(stats.positions_indexed || 0);
  const done = Number(stats.positions_analyzed || 0);
  const total = Number(stats.positions_total || 0);
  const scanDone = Number(stats.brilliant_games_done || 0);
  const scanTotal = Number(stats.brilliant_games_total || 0);
  const classified = Number(stats.brilliant_moves_classified || 0);
  const scanned = Number(stats.brilliant_player_moves_total || stats.brilliant_moves_scanned || 0);
  if (["loading_games", "fetch_archives", "fetch_games"].includes(phase)) {
    return gamesTotal ? `${gamesDone}/${gamesTotal} games` : "Loading games";
  }
  if (phase === "indexing") {
    return gamesTotal ? `${gamesDone}/${gamesTotal} games indexed` : "Indexing games";
  }
  if (phase === "position_index") {
    return `${indexed} positions indexed`;
  }
  if (phase === "brilliant_scan") {
    if (scanTotal) return `${scanDone}/${scanTotal} games scanned`;
    if (scanned) return `${classified}/${scanned} moves classified`;
    return "Classifying moves";
  }
  if (phase === "stockfish_positions" || total) {
    return `${done}${total ? `/${total}` : ""} positions`;
  }
  return stats.active ? "Working" : "Ready";
}

function analysisPrimaryCard(stats) {
  const phase = stats.phase || "";
  if (["loading_games", "fetch_archives", "fetch_games", "indexing"].includes(phase)) {
    const done = Number(stats.games_done || 0);
    const total = Number(stats.games_total || 0);
    return ["Games", total ? `${done}/${total}` : "--"];
  }
  if (phase === "brilliant_scan") {
    const scanDone = Number(stats.brilliant_games_done || 0);
    const scanTotal = Number(stats.brilliant_games_total || 0);
    if (scanTotal) return ["Games scanned", `${scanDone}/${scanTotal}`];
    const scanned = Number(stats.brilliant_moves_scanned || 0);
    const playerMoves = Number(stats.brilliant_player_moves_total || scanned || 0);
    const classified = Number(stats.brilliant_moves_classified || 0);
    return ["Your moves", playerMoves ? `${classified}/${playerMoves}` : "--"];
  }
  return ["Positions/sec", formatRate(stats.positions_per_second)];
}

function analysisRemainingCard(stats) {
  const phase = stats.phase || "";
  if (["loading_games", "fetch_archives", "fetch_games", "indexing"].includes(phase)) {
    const left = Number(stats.games_left ?? NaN);
    if (Number.isFinite(left) && left >= 0) return ["Games left", left || 0];
    const done = Number(stats.games_done || 0);
    const total = Number(stats.games_total || 0);
    return ["Games left", total ? Math.max(0, total - done) : "--"];
  }
  if (phase === "brilliant_scan") {
    const backendGamesLeft = Number(stats.brilliant_games_left ?? stats.games_left ?? NaN);
    if (Number.isFinite(backendGamesLeft) && backendGamesLeft > 0) return ["Games left", backendGamesLeft];
    const backendMovesLeft = Number(stats.moves_left ?? NaN);
    if (Number.isFinite(backendMovesLeft) && backendMovesLeft > 0) return ["Moves left", backendMovesLeft];
    const scanDone = Number(stats.brilliant_games_done || 0);
    const scanTotal = Number(stats.brilliant_games_total || 0);
    if (scanTotal) return ["Games left", Math.max(0, scanTotal - scanDone)];
    const scanned = Number(stats.brilliant_moves_scanned || 0);
    const playerMoves = Number(stats.brilliant_player_moves_total || scanned || 0);
    const classified = Number(stats.brilliant_moves_classified || 0);
    return ["Moves left", playerMoves ? Math.max(0, playerMoves - classified) : "--"];
  }
  const backendPositionsLeft = Number(stats.positions_left ?? NaN);
  if (Number.isFinite(backendPositionsLeft) && backendPositionsLeft >= 0) return ["Positions left", backendPositionsLeft || 0];
  const done = Number(stats.positions_analyzed || stats.positions_done || 0);
  const total = Number(stats.positions_total || 0);
  return ["Positions left", total ? Math.max(0, total - done) : "--"];
}

function analysisEtaText(stats) {
  if (!stats.active) return "Done";
  const eta = Number(stats.eta_sec);
  if (Number.isFinite(eta) && eta > 0) return formatDuration(eta);
  const progress = Number(stats.progress || 0);
  const elapsed = Number(stats.elapsed_sec || 0);
  if (progress > 3 && progress < 96 && elapsed > 2) {
    const estimatedRemaining = Math.max(3, (elapsed * (100 - progress)) / progress);
    return formatDuration(estimatedRemaining);
  }
  if (["loading_games", "fetch_archives", "fetch_games", "indexing", "position_index"].includes(stats.phase)) {
    return "Preparing";
  }
  if (stats.phase === "stockfish_positions") {
    return Number(stats.positions_analyzed || 0) ? "Calculating" : "Starting";
  }
  if (stats.phase === "brilliant_scan") return "Calculating";
  return "Working";
}

function renderStockfishStats(stats, options = {}) {
  const live = Boolean(options.live);
  const node = live ? null : el.stockfishStatsPanel;
  if (!stats) {
    if (!live && node) {
      node.className = "stack empty";
      node.textContent = "Live Stockfish throughput, ETA, CPU, and memory will show up here.";
    }
    renderAnalysisPreviewPanel(null);
    return;
  }
  const phase = stats.phase || "idle";
  const isEnginePhase = phase === "stockfish_positions" || phase === "brilliant_scan";
  const memory = Number(stats.memory_mb || 0);
  const freeMemory = Number(stats.system_available_ram_mb || 0);
  const totalMemory = Number(stats.system_ram_mb || 0);
  const activeWorkers = phase === "brilliant_scan" || phase === "stockfish_positions"
    ? Number(stats.scan_active_workers || stats.active_workers || 0)
    : Number(stats.active_workers || 0);
  const workers = Number(stats.workers || 1);
  const hasLiveCpu = stats.cpu_percent != null && (isEnginePhase || activeWorkers > 0 || Number(stats.jobs_started || 0) > 0);
  const cpu = hasLiveCpu ? stats.cpu_percent : stats.cpu_budget_percent;
  const cpuLabel = hasLiveCpu ? "Stockfish CPU" : "CPU budget";
  const cpuCoreText = hasLiveCpu && stats.cpu_cores != null
    ? `${Number(stats.cpu_cores).toFixed(1)}/${Number(stats.system_threads || 0)}`
    : `${Number(stats.threads || 0)}/${Number(stats.system_threads || 0)} planned`;
  const workerCard = isEnginePhase
    ? ["Active workers", `${activeWorkers}/${workers}`]
    : ["Stockfish workers", `${workers} ready`];
  const throughputCard = phase === "stockfish_positions"
    ? ["Positions/sec", formatRate(stats.positions_per_second)]
    : phase === "brilliant_scan"
      ? ["Games/sec", formatRate(stats.games_per_second || stats.items_per_second)]
      : ["Index rate", formatRate(stats.items_per_second)];
  const memoryText = memory > 0
    ? `${memory.toFixed(memory >= 100 ? 0 : 1)} MB`
    : `${Number(stats.estimated_hash_mb || stats.hash_mb || 0)} MB hash`;
  const hashLimit = Number(stats.hash_limit_mb || 0);
  const primaryCard = analysisPrimaryCard(stats);
  const remainingCard = analysisRemainingCard(stats);
  const cards = [
    throughputCard,
    primaryCard,
    remainingCard,
    ["ETA", analysisEtaText(stats)],
    workerCard,
    [cpuLabel, cpu == null ? "--" : `${Number(cpu).toFixed(1)}%`],
    ["CPU cores", cpuCoreText],
    ["Memory", memoryText],
    ["Configured workers", workers],
    ["Threads", `${Number(stats.threads || 0)} total`],
    ["Hash budget", `${Number(stats.hash_mb || 0)} MB`],
    ["Depth / MultiPV", `${Number(stats.depth || 0)} / ${Number(stats.multipv || 0)}`],
    ["Classified", `${Number(stats.brilliant_moves_classified || 0)}/${Number(stats.brilliant_player_moves_total || stats.brilliant_moves_scanned || 0)}`],
  ];
  if (!live && node) {
    node.className = "stack stockfish-stats-panel";
    node.innerHTML = `
      <div class="stockfish-status-head">
        <span>${escapeHtml(analysisPhaseLabel(phase))}</span>
        <strong>${escapeHtml(analysisWorkSummary(stats))}</strong>
        <small>${escapeHtml(stats.message || (stats.active ? "Stockfish is working..." : "Analysis cache is ready."))}</small>
      </div>
      <div class="speed-grid stockfish-speed-grid">
        ${cards.map(([label, value]) => `<div class="speed-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("")}
      </div>
      <div class="line-note">
        Elapsed ${formatDuration(stats.elapsed_sec)} · ${Number(stats.worker_threads || 0)} thread${Number(stats.worker_threads || 0) === 1 ? "" : "s"} per worker · ${Number(stats.worker_hash_mb || 0)} MB hash per worker.
        ${freeMemory ? ` Windows reports ${Math.round(freeMemory)} MB free${totalMemory ? ` of ${Math.round(totalMemory)} MB` : ""}.` : ""}
        ${hashLimit ? ` Safe hash ceiling: ${hashLimit} MB.` : ""}
      </div>
    `;
  }
  renderAnalysisPreviewPanel(stats);
}

function renderAnalysisPreviewPanel(stats) {
  const node = el.analysisPreviewPanel;
  if (!node) return;
  const livePositionCount = Array.isArray(stats?.live_positions) ? stats.live_positions.length : 0;
  const configuredWorkers = Number(stats?.workers || 0);
  const workerSlots = Math.min(Math.max(configuredWorkers, livePositionCount, 1), 8);
  const previews = Array.isArray(stats?.live_positions) ? stats.live_positions.slice(0, workerSlots) : [];
  const activeSlots = new Set(Array.isArray(stats?.scan_active_slots) ? stats.scan_active_slots.map((slot) => Number(slot)) : []);
  const active = Boolean(stats?.active);
  const rawPhase = stats?.phase || "";
  const liveBoardPhase = rawPhase === "brilliant_scan" || rawPhase === "stockfish_positions";
  const hasPreviewContent = previews.some(Boolean);
  if (!stats || (!active && !hasPreviewContent)) {
    node.className = "analysis-preview-panel empty";
    node.textContent = "Run an import to see live worker stats and the positions Bookup is analyzing.";
    return;
  }
  const phase = analysisPhaseLabel(rawPhase);
  if (!liveBoardPhase) {
    node.className = "analysis-preview-panel empty";
    node.innerHTML = `
      <div class="analysis-preview-head">
        <div>
          <span class="section-label">Live Analysis</span>
          <h3>${escapeHtml(analysisWorkSummary(stats))}</h3>
        </div>
        <small>${escapeHtml(stats.message || "Bookup is preparing the next analysis batch.")}</small>
      </div>
    `;
    return;
  }
  const remainingCard = analysisRemainingCard(stats);
  const renderedActiveWorkers = rawPhase === "brilliant_scan" || rawPhase === "stockfish_positions"
    ? Math.max(Number(stats.scan_active_workers || stats.active_workers || 0), activeSlots.size)
    : Number(stats.active_workers || 0);
  const gamesDone = Number(stats.games_done || stats.brilliant_games_done || 0);
  const gamesTotal = Number(stats.games_total || stats.brilliant_games_total || 0);
  const positionDone = Number(stats.positions_analyzed || 0);
  const positionTotal = Number(stats.positions_total || 0);
  const gameRate = ["loading_games", "fetch_archives", "fetch_games", "indexing", "brilliant_scan"].includes(rawPhase)
    ? Number(stats.games_per_second || stats.items_per_second || 0)
    : 0;
  const headerCards = [
    { label: "Games/sec", value: formatRate(gameRate) },
    { label: "Positions/sec", value: formatRate(stats.positions_per_second) },
    { label: "Workers", value: `${renderedActiveWorkers}/${Number(stats.workers || 0)}` },
    { label: remainingCard[0], value: String(remainingCard[1]) },
    { label: "ETA", value: analysisEtaText(stats) },
    { label: "CPU", value: stats.cpu_percent == null ? "--" : `${Number(stats.cpu_percent).toFixed(1)}%` },
  ];
  const workLine = gamesTotal
    ? `${gamesDone}/${gamesTotal} games`
    : positionTotal
      ? `${positionDone}/${positionTotal} positions`
      : analysisWorkSummary(stats);
  const previewCards = [];
  for (let index = 0; index < Math.max(workerSlots, 1); index += 1) {
    previewCards.push(renderAnalysisPreviewCard(previews[index] || null, {
      slot: index,
      busy: activeSlots.has(index),
    }));
  }
  node.className = "analysis-preview-panel";
  node.innerHTML = `
    <div class="analysis-preview-head">
      <div>
        <span class="section-label">Live Analysis</span>
        <div class="analysis-preview-phase-row">
          <span class="analysis-phase-pill">${escapeHtml(phase)}</span>
        </div>
        <h3>${escapeHtml(workLine)}</h3>
      </div>
      <small>${escapeHtml(stats.message || "Bookup is preparing the next analysis batch.")}</small>
    </div>
    <div class="analysis-landscape-metrics">
      ${headerCards.map(({ label, value, className = "" }) => `
        <article class="${className}">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(String(value))}</strong>
        </article>
      `).join("")}
    </div>
    <div class="analysis-live-board-grid">
      ${previewCards.join("")}
    </div>
  `;
}

function renderAnalysisPreviewCard(item, options = {}) {
  const slot = Number(options.slot || 0);
  const busy = Boolean(options.busy);
  if (!item) {
    return `
      <article class="analysis-preview-card empty ${busy ? "busy" : ""}">
        <div class="analysis-preview-card-head">
          <span>${busy ? `Worker ${slot + 1}` : "Idle"}</span>
          <strong>${busy ? "Loading next position" : "Waiting for work"}</strong>
          <small>${busy ? "This worker is preparing its next position now." : "This slot will populate as soon as a worker is assigned."}</small>
        </div>
        <div class="mini-board-placeholder" aria-hidden="true">
          <span>${busy ? "Preparing next position" : "Ready for next worker"}</span>
        </div>
      </article>
    `;
  }
  const label = item?.label || item?.move || "Position";
  const subtitle = item?.subtitle || item?.status || "";
  const status = item?.status || "Analyzing";
  return `
    <article class="analysis-preview-card">
      <div class="analysis-preview-card-head">
        <span>${escapeHtml(`${status}${busy ? ` · Worker ${slot + 1}` : ""}`)}</span>
        <strong>${escapeHtml(label)}</strong>
        ${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ""}
      </div>
      ${renderMiniBoard(item?.fen || START_FEN, item?.orientation || "white")}
    </article>
  `;
}

function renderMiniBoard(fen, orientation = "white") {
  const squares = parseFenBoard(fen);
  const displayFiles = orientation === "black" ? [...files].reverse() : files;
  const displayRanks = orientation === "black" ? [...ranks].reverse() : ranks;
  const cells = [];
  displayRanks.forEach((rankLabel, rowIndex) => {
    displayFiles.forEach((fileLabel, colIndex) => {
      const file = files.indexOf(fileLabel);
      const rank = 8 - Number(rankLabel);
      const piece = squares[(rank * 8) + file] || "";
      cells.push(`
        <span class="mini-square ${(rowIndex + colIndex) % 2 === 0 ? "light" : "dark"}">
          ${piece ? `<img src="${escapeHtml(PIECE_ASSETS[piece])}" alt="${escapeHtml(piece)}">` : ""}
        </span>
      `);
    });
  });
  return `<div class="mini-board" aria-hidden="true">${cells.join("")}</div>`;
}

function stopAnalysisStatusPolling() {
  if (state.analysisStatusTimer) {
    window.clearInterval(state.analysisStatusTimer);
    state.analysisStatusTimer = 0;
  }
}

async function pollAnalysisStatus() {
  try {
    const response = await fetch("/api/analysis-status");
    const status = await response.json();
    if (!response.ok) return;
    const stats = stockfishStatsFromStatus(status);
    renderStockfishStats(stats, { live: true });
    if (status.active) {
      setProgress(Number(status.progress || 0), status.message || "", {
        indeterminate: Number(status.progress || 0) >= 96,
      });
    } else if (
      state.analysisStatusTimer
      && Date.now() - state.analysisStatusPollStartedAt > 2500
      && !state.analysisProgressTimer
      && !el.analyze?.disabled
      && !el.importPgn?.disabled
      && !el.importChessnut?.disabled
    ) {
      stopAnalysisStatusPolling();
      renderStockfishStats(stats, { live: true });
    }
  } catch {
    // Keep the optimistic progress bar if the status poll races the server.
  }
}

function startAnalysisStatusPolling() {
  stopAnalysisStatusPolling();
  state.analysisStatusPollStartedAt = Date.now();
  void pollAnalysisStatus();
  state.analysisStatusTimer = window.setInterval(pollAnalysisStatus, 400);
}

function stopAnalysisProgress() {
  if (state.analysisProgressTimer) {
    window.clearInterval(state.analysisProgressTimer);
    state.analysisProgressTimer = 0;
  }
  stopAnalysisStatusPolling();
}

function startAnalysisProgress() {
  stopAnalysisProgress();
  const startedAt = Date.now();
  state.analysisProgressValue = 0;
  setProgress(4, "Preparing import...", { allowDecrease: true });
  renderAnalysisPreviewPanel({
    active: true,
    phase: "loading_games",
    workers: Number(el.parallelWorkers?.value || defaults.parallel_workers || 1),
    live_positions: [],
    scan_active_slots: [],
    scan_active_workers: 0,
    message: "Loading saved games or checking Chess.com archives...",
  });
  startAnalysisStatusPolling();
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
      message = "Classifying Brilliant moves from your imported games...";
    }
    if (elapsed >= 32000) {
      target = 96;
      message = "Still working. Stockfish is storing Brilliant stats and lesson cache...";
    }
    const current = Number(state.analysisProgressValue || 0);
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
  document.body.dataset.activeTab = name;
  if (name === "trainer") {
    renderStudyWorkspace();
  }
}

async function runAnalysis(options = {}) {
  startAnalysisProgress();
  el.analyze.disabled = true;
  try {
    const payload = await fetchProfilePayload(resolveConfiguredUsername(), {
      forceRefresh: Boolean(options.forceRefresh),
    });
    state.payload = payload;
    state.reviewStats = mergeReviewStats(payload.training_progress || {}, loadReviewStats(payload.username));
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
    setProgress(0, error.message || "Bookup could not build your repertoire.", { allowDecrease: true });
  } finally {
    stopAnalysisProgress();
    el.analyze.disabled = false;
  }
}

async function checkAutoImportOnStartup() {
  if (!el.autoImportStartup || el.autoImportStartup.checked === false || state.autoImportRunning) return;
  const username = resolveConfiguredUsername();
  if (!username) return;
  state.autoImportRunning = true;
  try {
    setProgress(Math.max(3, Number(el.progressLabel?.textContent?.replace("%", "") || 0)), "Checking Chess.com for new games...");
    const response = await fetch("/api/auto-import-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentSetupSettingsPayload()),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not check for new games.");
    if (!payload.needs_import) {
      setProgress(100, payload.message || "Local repertoire cache is current.");
      return;
    }
    const countText = Number(payload.new_game_count || 0) > 0
      ? `${payload.new_game_count} new game${payload.new_game_count === 1 ? "" : "s"} found`
      : "A fresh import is needed";
    setProgress(8, `${countText}; refreshing your local repertoire now...`);
    await runAnalysis({ forceRefresh: true });
  } catch (error) {
    setProgress(
      state.payload ? 100 : 0,
      error.message || "Startup auto-import check failed. You can still build manually.",
      { allowDecrease: true }
    );
  } finally {
    state.autoImportRunning = false;
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
        username: resolveConfiguredUsername() || "PGN Player",
        pgn,
        player_color: "white",
        lichess_token: el.lichessToken.value.trim(),
        engine_path: el.enginePath.value.trim(),
        depth: Number(el.depth.value || defaults.depth || 24),
        multipv: Number(el.multiPv.value || defaults.multipv || 5),
        threads: Number(el.threads.value || defaults.threads || 8),
        parallel_workers: Number(el.parallelWorkers?.value || defaults.parallel_workers || 1),
        hash_mb: Number(el.hash.value || defaults.hash_mb || 2048),
        think_time_sec: Number(el.thinkTime.value || defaults.think_time_sec || 5),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "PGN import failed.");
    state.payload = payload;
    state.reviewStats = mergeReviewStats(payload.training_progress || {}, loadReviewStats(payload.username));
    state.games = payload.games || [];
    renderProfile(payload);
    setProgress(100, `Imported ${payload.games_imported} PGN game${payload.games_imported === 1 ? "" : "s"} into your local Bookup workspace.`);
    if (el.pgnImportStatus) el.pgnImportStatus.textContent = "PGN import complete. The move tree, theory, and trainer are ready.";
  } catch (error) {
    setProgress(0, error.message || "PGN import failed.", { allowDecrease: true });
    if (el.pgnImportStatus) el.pgnImportStatus.textContent = error.message || "PGN import failed.";
  } finally {
    stopAnalysisProgress();
    if (el.importPgn) el.importPgn.disabled = false;
  }
}

async function importChessnutGames() {
  const dbPath = (el.chessnutDbPath?.value || defaults.chessnut_db_path || "").trim();
  const playerColor = (el.chessnutPlayerColor?.value || defaults.chessnut_player_color || "white").trim().toLowerCase() === "black" ? "black" : "white";
  if (!dbPath) {
    if (el.chessnutImportStatus) el.chessnutImportStatus.textContent = "Pick the local NewChessnut data.mdb path first.";
    return;
  }
  startAnalysisProgress();
  if (el.importChessnut) el.importChessnut.disabled = true;
  if (el.importPgn) el.importPgn.disabled = true;
  if (el.chessnutImportStatus) el.chessnutImportStatus.textContent = "Reading NewChessnut OTB games and building your local repertoire...";
  try {
    const response = await fetch("/api/import-chessnut", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: resolveConfiguredUsername() || "Chessnut Player",
        db_path: dbPath,
        player_color: playerColor,
        chessnut_db_path: dbPath,
        chessnut_player_color: playerColor,
        lichess_token: el.lichessToken.value.trim(),
        engine_path: el.enginePath.value.trim(),
        depth: Number(el.depth.value || defaults.depth || 24),
        multipv: Number(el.multiPv.value || defaults.multipv || 5),
        threads: Number(el.threads.value || defaults.threads || 8),
        parallel_workers: Number(el.parallelWorkers?.value || defaults.parallel_workers || 1),
        hash_mb: Number(el.hash.value || defaults.hash_mb || 2048),
        think_time_sec: Number(el.thinkTime.value || defaults.think_time_sec || 5),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "NewChessnut import failed.");
    defaults.chessnut_db_path = dbPath;
    defaults.chessnut_player_color = playerColor;
    state.payload = payload;
    state.reviewStats = mergeReviewStats(payload.training_progress || {}, loadReviewStats(payload.username));
    state.games = payload.games || [];
    renderProfile(payload);
    setProgress(100, `Imported ${payload.games_imported} NewChessnut OTB game${payload.games_imported === 1 ? "" : "s"} into your local Bookup workspace.`);
    if (el.chessnutImportStatus) el.chessnutImportStatus.textContent = "Chessnut import complete. The move tree, theory, and trainer are ready.";
  } catch (error) {
    setProgress(0, error.message || "NewChessnut import failed.", { allowDecrease: true });
    if (el.chessnutImportStatus) el.chessnutImportStatus.textContent = error.message || "NewChessnut import failed.";
  } finally {
    stopAnalysisProgress();
    if (el.importChessnut) el.importChessnut.disabled = false;
    if (el.importPgn) el.importPgn.disabled = false;
  }
}

async function fetchProfilePayload(username, options = {}) {
  const response = await fetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      time_classes: el.timeClasses.value.trim(),
      max_games: el.importAllGames?.checked ? 0 : Number(el.maxGames.value),
      auto_import_on_startup: el.autoImportStartup?.checked !== false,
      force_refresh: Boolean(options.forceRefresh),
      lichess_token: currentLichessToken(),
      engine_path: el.enginePath.value.trim(),
      depth: Number(el.depth.value),
      think_time_sec: Number(el.thinkTime?.value || defaults.think_time_sec || 5),
      multipv: Number(el.multiPv.value),
      threads: Number(el.threads.value),
      parallel_workers: Number(el.parallelWorkers?.value || defaults.parallel_workers || 1),
      hash_mb: Number(el.hash.value),
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Bookup could not build your repertoire.");
  return payload;
}

async function bootstrapLocalState() {
  try {
    const username = resolveConfiguredUsername();
    if (!username) {
      state.reviewStats = loadReviewStats("");
      setProgress(0, "Ready.");
      return;
    }
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
      state.reviewStats = mergeReviewStats(payload.training_progress || {}, loadReviewStats(payload.username));
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
      state.reviewStats = mergeReviewStats(payload.training_progress || {}, loadReviewStats(payload.username));
      setProgress(0, "Saved data is from an older Bookup version. Rebuild your repertoire to refresh it.");
    } else {
      state.reviewStats = loadReviewStats(username);
      setProgress(0, "Ready.");
    }
  } catch {
    state.reviewStats = loadReviewStats(resolveConfiguredUsername());
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
  const trainedKnownCount = Object.values(state.reviewStats || {})
    .filter((item) => item?.line_state === "mastered" || Number(item?.streak || 0) >= 3)
    .length;

  el.heroTitle.textContent = `${payload.username} repertoire ready`;
  el.heroSummary.textContent = summary.prep_summary || "Your repertoire positions are ready to train.";
  el.summaryPositions.textContent = String(summary.positions ?? "--");
  el.summaryNeedsWork.textContent = String((profile.needs_work || []).length ?? "--");
  el.summaryQueue.textContent = String(summary.trainable_positions ?? "--");
  el.badgeGames.textContent = String(payload.games_imported ?? "--");
  el.badgeKnown.textContent = String(Number(summary.known_lines || 0) + trainedKnownCount || "--");
  el.badgeWinRate.textContent = typeof summary.win_rate === "number" ? `${summary.win_rate}%` : "--";

  renderFirstMoves(profile.first_move_repertoire || {});
  renderRepertoireMap(profile.repertoire_map || {});
  renderHealthDashboard(profile.health_dashboard || null);
  renderStatsSummary(profile, payload);
  renderRatingProgress(profile.rating_progress || null);
  if (brilliantTrackerEnabled) {
    renderBrilliantTracker(profile.brilliant_tracker || null);
  }
  renderMemoryScores(profile.memory_scores || null);
  renderOpeningDrift(profile.opening_drift || null);
  renderPrepPack(profile.prep_pack || null);
  renderStudyPlan(profile.study_plan || null);
  renderConfidenceGraph(profile.confidence_graph || null);
  renderDriftFixes(profile.drift_fixes || null);
  renderImportSpeed(profile.import_speed_report || null);
  renderStockfishStats(profile.stockfish_stats || null);
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
  const combinedItems = state.knownArchive?.length ? state.knownArchive : items;
  if (!combinedItems.length) {
    el.knownArchiveList.className = "stack empty";
    el.knownArchiveList.textContent = "Known lines will show up here once Bookup sees you playing the best move 100+ times or you complete a line cleanly enough in training.";
    return;
  }
  el.knownArchiveList.className = "stack";
  el.knownArchiveList.innerHTML = combinedItems
    .map((item) => `
      <article class="line-card">
        <div class="line-card-header">
          <div>
            <div class="line-title">${escapeHtml(item.line_label || item.opening_name)}</div>
            ${item.opening_name ? `<div class="tree-meta">${escapeHtml(item.opening_name)}${item.opening_code ? ` | ${escapeHtml(item.opening_code)}` : ""}</div>` : ""}
          </div>
          <div class="line-badge known">${item.training_known ? "Training known" : "Known"}</div>
        </div>
        <div class="chip-row">
          <span class="lesson-chip known">${item.training_known ? `Clean streak ${item.review?.streak || 0}` : `Best move played ${item.repeat_count}x`}</span>
          <span class="lesson-chip">Frequency ${item.frequency}</span>
          ${item.completedCount ? `<span class="lesson-chip">Completed ${item.completedCount}x</span>` : ""}
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

function renderStatsSummary(profile, payload) {
  if (!el.statsSummary) return;
  const summary = profile?.summary || {};
  const progress = profile?.rating_progress || {};
  const record = summary.record || "0W 0D 0L";
  const games = Number(payload?.games_imported ?? progress.total_games ?? 0);
  const winRate = typeof summary.win_rate === "number" ? `${summary.win_rate}%` : "--";
  const scoreRate = typeof summary.score_rate === "number" ? `${summary.score_rate}%` : "--";
  const currentRange = progress?.ranges?.[state.ratingProgressRange] || progress?.ranges?.["90"] || progress?.ranges?.["30"] || null;
  const ratingNow = currentRange?.rating_end ?? progress.rating_end ?? "--";
  const ratingDelta = currentRange?.delta ?? 0;
  const split = (progress.time_class_breakdown || []).slice(0, 4);
  if (!games && !progress.available) {
    el.statsSummary.className = "stats-summary-panel empty";
    el.statsSummary.textContent = "Import rated Chess.com games to unlock W/D/L, rating form, time-control splits, and brilliant tracking.";
    return;
  }
  el.statsSummary.className = "stats-summary-panel";
  el.statsSummary.innerHTML = `
    <div class="stats-card-grid">
      <article class="stats-card rating">
        <span>Current rating</span>
        <strong>${escapeHtml(ratingNow)}</strong>
        <p>${Number(ratingDelta) >= 0 ? "+" : ""}${escapeHtml(ratingDelta)} over selected range</p>
      </article>
      <article class="stats-card">
        <span>Record</span>
        <strong>${escapeHtml(record)}</strong>
        <p>${escapeHtml(winRate)} wins · ${escapeHtml(scoreRate)} score</p>
      </article>
      <article class="stats-card">
        <span>Games indexed</span>
        <strong>${escapeHtml(games)}</strong>
        <p>${Number(summary.positions_indexed || 0)} positions · ${Number(summary.trainable_positions || 0)} trainable</p>
      </article>
      <article class="stats-card">
        <span>Line state</span>
        <strong>${Number(summary.known_lines || 0)}</strong>
        <p>${Number(summary.urgent_lines || 0)} due · ${Number(summary.positions || 0)} analyzed lessons</p>
      </article>
    </div>
    <div class="stats-time-split">
      ${split.length ? split.map((item) => `
        <div class="stats-split-row">
          <strong>${escapeHtml(item.label || item.key || "time control")}</strong>
          <span>${Number(item.games || 0)} games · ${Number(item.win_rate || 0)}% wins</span>
          <b>${escapeHtml(item.rating_current ?? "--")}</b>
        </div>
      `).join("") : "<p>No rated time-control split available yet.</p>"}
    </div>
  `;
}

function renderBrilliantTracker(tracker) {
  if (!el.brilliantTracker) return;
  const high = tracker?.high_confidence || tracker?.recent_brilliants || [];
  const games = tracker?.games || [];
  const watch = tracker?.watchlist || [];
  const bestGame = tracker?.best_game || games[0] || null;
  const summary = tracker?.summary || {};
  const progress = tracker?.progress || null;
  const hasScanData = Boolean(progress?.available || Number(summary.games_scanned || 0) || Number(summary.moves_scanned || 0));
  if (!high.length && !watch.length && !games.length && !hasScanData) {
    el.brilliantTracker.className = "brilliant-tracker-panel empty";
    el.brilliantTracker.textContent = "No Brilliant moves are cached from your games yet. Bookup scans your imported positions with Stockfish and only stores near-best good piece sacrifices that stay sound.";
    return;
  }
  el.brilliantTracker.className = "brilliant-tracker-panel";
  el.brilliantTracker.innerHTML = `
    <div class="brilliant-summary-grid">
      <article><span>Total brilliants</span><strong>${Number(summary.total_brilliants || high.length)}</strong><p>Confirmed Brilliant moves found in your imported games.</p></article>
      <article><span>Games with brilliants</span><strong>${Number(summary.games_with_brilliants || games.length)}</strong><p>Imported games where at least one Brilliant appeared.</p></article>
      <article><span>Best game</span><strong>${bestGame ? `${Number(bestGame.brilliants || 0)}×` : "0×"}</strong><p>${escapeHtml(bestGame ? `${bestGame.opponent || "Opponent"} · ${bestGame.date_label || ""}` : "No Brilliant game found yet.")}</p></article>
      <article><span>Your moves scanned</span><strong>${Number(summary.classified_moves || 0)}/${Number(summary.player_moves_total || summary.moves_scanned || 0)}</strong><p>${Number(summary.games_scanned || 0)} games · ${Number(summary.opponent_moves_ignored || 0)} opponent moves ignored · ${Number(summary.not_top_candidate_moves || 0)} ruled out outside MultiPV.</p></article>
    </div>
    ${renderBrilliantClassificationStatus(tracker)}
    ${renderBrilliantProgress(progress)}
    <div class="brilliant-tracker-grid">
      <section>
        <h3>Recent Brilliant Moves</h3>
        ${renderBrilliantTrackerList(high, "No confirmed Brilliant moves from your games yet.")}
      </section>
      <section>
        <h3>Games With Brilliants</h3>
        ${renderBrilliantGameList(games, "No game-level Brilliant hits yet.")}
      </section>
    </div>
    ${watch.length ? `
      <section class="brilliant-watchlist">
        <h3>Repertoire Watchlist</h3>
        ${renderBrilliantTrackerList(watch, "No Great/Best tactical candidates cached yet.")}
      </section>
    ` : ""}
  `;
  bindBrilliantProgressEvents();
}

function renderBrilliantClassificationStatus(tracker) {
  const status = tracker?.classification_status || {};
  const summary = tracker?.summary || {};
  const engine = status.engine || {};
  const stored = status.stored_with_profile || summary.stored_with_profile;
  const duringImport = status.classified_during_import || summary.classified_during_import;
  return `
    <section class="brilliant-scan-status">
      <div>
        <span class="line-badge">Classification proof</span>
        <h3>Brilliant scan runs during profile import</h3>
        <p>Results are saved inside the local profile cache. Bookup checks cached candidate lines first, then directly classifies the actual move you played if it was not already in the top candidate set.</p>
      </div>
      <div class="brilliant-scan-grid">
        <article><span>Stored</span><strong>${stored ? "Yes" : "No"}</strong><small>Profile cache payload</small></article>
        <article><span>Import pass</span><strong>${duringImport ? "Yes" : "No"}</strong><small>${escapeHtml(status.scope || "all imported games")}</small></article>
        <article><span>Your move scan</span><strong>${Number(status.classified_moves || summary.classified_moves || 0)}/${Number(status.player_moves_total || summary.player_moves_total || status.moves_scanned || summary.moves_scanned || 0)}</strong><small>${Number(status.total_game_moves || summary.total_game_moves || 0)} total game moves seen</small></article>
        <article><span>Candidate cache/live</span><strong>${Number(status.candidate_cache_hits || summary.candidate_cache_hits || 0)}/${Number(status.candidate_live_hits || summary.candidate_live_hits || 0)}</strong><small>top-line cache / live</small></article>
        <article><span>Ruled out</span><strong>${Number(status.not_top_candidate_moves || summary.not_top_candidate_moves || 0)}</strong><small>not in current top MultiPV</small></article>
        <article><span>Engine skips</span><strong>${Number(status.skipped_live_budget || summary.skipped_live_budget || 0)}</strong><small>positions without candidate lines</small></article>
        <article><span>Depth</span><strong>${Number(engine.depth || 0) || "--"}</strong><small>Stockfish depth</small></article>
        <article><span>MultiPV</span><strong>${Number(engine.multipv || 0) || "--"}</strong><small>candidate lines</small></article>
        <article><span>Think time</span><strong>${engine.think_time_sec == null ? "--" : `${Number(engine.think_time_sec)}s`}</strong><small>per live scan</small></article>
        <article><span>Scope</span><strong>${Number(status.scan_ply_limit || summary.scan_ply_limit || 0)}</strong><small>opening plies per game</small></article>
      </div>
    </section>
  `;
}

function renderBrilliantProgress(progress) {
  if (!progress?.available || !progress.ranges || !Object.keys(progress.ranges).length) {
    return `
      <section class="brilliant-progress-panel empty">
        ${escapeHtml(progress?.message || "Import dated games to chart Brilliant moves over time.")}
      </section>
    `;
  }
  const splitPayloads = progress.time_class_progress || {};
  const splitKeys = [];
  (progress.time_class_breakdown || []).forEach((item) => {
    const key = String(item.key || item.label || "").trim();
    if (key && splitPayloads[key] && !splitKeys.includes(key)) splitKeys.push(key);
  });
  Object.keys(splitPayloads).forEach((key) => {
    if (!splitKeys.includes(key)) splitKeys.push(key);
  });
  const defaultTimeKey = progress.default_time_class && splitKeys.includes(progress.default_time_class)
    ? progress.default_time_class
    : (splitKeys[0] || "");
  if (splitKeys.length && (!state.brilliantProgressTimeClass || !splitKeys.includes(state.brilliantProgressTimeClass))) {
    state.brilliantProgressTimeClass = defaultTimeKey;
  }
  if (!splitKeys.length) state.brilliantProgressTimeClass = "";
  const activeTimeKey = splitKeys.length && splitKeys.includes(state.brilliantProgressTimeClass)
    ? state.brilliantProgressTimeClass
    : "";
  const activeProgress = activeTimeKey ? (splitPayloads[activeTimeKey] || progress) : progress;
  const timeClassLabel = activeTimeKey
    ? activeProgress.time_class_label || activeTimeKey.replace(/_/g, " ")
    : "All imported games";
  const ranges = activeProgress.ranges || {};
  const rangeOrder = ["7", "30", "90", "365", "all"].filter((key) => ranges[key]);
  if (!rangeOrder.includes(state.brilliantProgressRange)) {
    state.brilliantProgressRange = activeProgress.default_range || progress.default_range || rangeOrder[0] || "90";
  }
  const activeKey = ranges[state.brilliantProgressRange] ? state.brilliantProgressRange : rangeOrder[0];
  const range = ranges[activeKey] || {};
  const points = Array.isArray(range.points) ? range.points : [];
  const graphPoints = points
    .map((point, index) => ({
      ...point,
      index,
      graphValue: Number(point.graph_value ?? point.brilliants ?? 0),
      result_tone: Number(point.brilliants || 0) > 1 ? "win" : (Number(point.brilliants || 0) === 1 ? "draw" : "idle"),
    }))
    .filter((point) => Number.isFinite(point.graphValue));
  const selectedIndex = pickBrilliantProgressIndex(graphPoints);
  const selected = graphPoints[selectedIndex] || graphPoints[graphPoints.length - 1] || points[points.length - 1] || null;
  const chart = buildRatingProgressChart(graphPoints, selected?.index, {
    dense: graphPoints.length > 130,
    baselineValue: 0,
    valueLabel: "Brilliants",
    minSpread: Math.max(8, Number(range.best_day?.brilliants || 0) + 2),
    robustDomain: false,
  });
  return `
    <section class="brilliant-progress-panel">
      <div class="rating-progress-head brilliant-progress-head">
        <div>
          <div class="line-badge">Brilliant tracker</div>
          <h3>${escapeHtml(range.label || "Brilliant timeline")} · ${escapeHtml(timeClassLabel)}</h3>
          <p>${Number(range.total_brilliants || 0)} Brilliant${Number(range.total_brilliants || 0) === 1 ? "" : "s"} across ${Number(range.games || 0)} game${Number(range.games || 0) === 1 ? "" : "s"} from ${escapeHtml(range.start_date || "")} to ${escapeHtml(range.end_date || "")}</p>
        </div>
        <div class="progress-filter-stack">
          <div class="progress-range-tabs" role="tablist" aria-label="Brilliant range">
            ${rangeOrder.map((key) => `
              <button class="progress-range-btn ${key === activeKey ? "active" : ""}" type="button" data-brilliant-range="${escapeHtml(key)}">
                ${escapeHtml(ranges[key]?.label || key)}
              </button>
            `).join("")}
          </div>
          ${splitKeys.length ? `<div class="progress-range-tabs compact" role="tablist" aria-label="Brilliant time-control split">
            ${splitKeys.map((key) => {
              const payload = splitPayloads[key] || {};
              const label = payload.time_class_label || key.replace(/_/g, " ");
              const total = payload.total_brilliants || 0;
              return `
                <button class="progress-range-btn ${key === activeTimeKey ? "active" : ""}" type="button" data-brilliant-time-class="${escapeHtml(key)}">
                  ${escapeHtml(label)} <span>${Number(total || 0)}</span>
                </button>
              `;
            }).join("")}
          </div>` : ""}
        </div>
      </div>
      <div class="progress-metric-grid brilliant-metric-grid">
        <article><span>Brilliants</span><strong>${Number(range.total_brilliants || 0)}</strong><small>${Number(range.games_with_brilliants || 0)} games with at least one</small></article>
        <article><span>Best day</span><strong>${Number(range.best_day?.brilliants || 0)}</strong><small>${escapeHtml(range.best_day?.label || "No Brilliant day yet")}</small></article>
        <article><span>Games scanned</span><strong>${Number(range.games || 0)}</strong><small>${Number(range.brilliants_per_game || 0).toFixed(3)} Brilliants per game</small></article>
        <article><span>Busiest day</span><strong>${Number(range.busiest_day?.games || 0)}</strong><small>${escapeHtml(range.busiest_day?.label || "No games in range")}</small></article>
      </div>
      <div class="rating-chart-wrap">
        <div class="rating-chart brilliant-chart ${chart.dense ? "dense" : ""}">
          ${chart.svg}
          <div class="rating-point-layer">
            ${chart.points.map((point) => `
              <button
                class="rating-point brilliant-point ${Number(point.graphValue || 0) > 0 ? "hot" : "idle"} ${point.sourceIndex === selected?.index ? "active" : ""}"
                type="button"
                style="left:${point.x}%; top:${point.y}%"
                title="${escapeHtml(point.title)}"
                data-brilliant-index="${point.sourceIndex}"
                aria-label="${escapeHtml(point.title)}"
              ></button>
            `).join("")}
          </div>
          <div class="rating-result-ribbon" aria-hidden="true">
            ${chart.resultTicks.map((tick) => `
              <span
                class="rating-result-tick ${Number(tick.graphValue || 0) > 0 ? "win" : "idle"}"
                style="left:${tick.x}%"
                title="${escapeHtml(tick.title)}"
              ></span>
            `).join("")}
          </div>
          <div class="rating-chart-legend brilliant-legend">
            <span><i class="brilliant-hot"></i>Brilliant day</span>
            <span><i class="brilliant-quiet"></i>No Brilliant</span>
          </div>
          <div class="rating-axis top">${chart.maxLabel}</div>
          <div class="rating-axis bottom">${chart.minLabel}</div>
          <div class="rating-axis baseline">Brilliants / day</div>
        </div>
        <div class="progress-highlight brilliant-highlight" data-brilliant-highlight>
          ${renderBrilliantProgressHighlight(selected, range)}
        </div>
      </div>
      <div class="progress-insights brilliant-insights">
        ${renderBrilliantProgressInsight("Best Brilliant day", range.best_day)}
        ${renderBrilliantProgressInsight("Busiest imported day", range.busiest_day)}
        ${renderBrilliantBreakdown(activeProgress.time_class_breakdown || progress.time_class_breakdown || [])}
      </div>
    </section>
  `;
}

function pickBrilliantProgressIndex(graphPoints) {
  if (!graphPoints.length) return -1;
  const requested = Number(state.brilliantProgressPointIndex);
  if (Number.isInteger(requested)) {
    const found = graphPoints.findIndex((point) => Number(point.index) === requested);
    if (found >= 0) return found;
  }
  for (let index = graphPoints.length - 1; index >= 0; index -= 1) {
    if (Number(graphPoints[index].brilliants || 0) > 0) return index;
  }
  return graphPoints.length - 1;
}

function renderBrilliantProgressHighlight(point, range) {
  if (!point) {
    return "<strong>No day selected</strong><span>Hover a chart marker to inspect Brilliant games for that day.</span>";
  }
  const gameLinks = renderBrilliantProgressGameLinks(point.game_links || []);
  return `
    <div>
      <span class="line-badge">${escapeHtml(point.label || point.date || "Selected day")}</span>
      <strong>${Number(point.brilliants || 0)} Brilliant${Number(point.brilliants || 0) === 1 ? "" : "s"}</strong>
      <p>${Number(point.games || 0)} games · ${Number(point.games_with_brilliants || 0)} games with Brilliants · ${escapeHtml(point.record || "")}</p>
    </div>
    <div class="progress-highlight-grid">
      <span><b>${Number(point.brilliants || 0)}</b> Brilliant moves</span>
      <span><b>${Number(point.games || 0)}</b> games</span>
      <span><b>${Number(point.wins || 0)}</b> wins</span>
      <span><b>${Number(point.losses || 0)}</b> losses</span>
    </div>
    ${gameLinks || "<small>No Brilliant games on this day yet.</small>"}
  `;
}

function renderBrilliantProgressGameLinks(items) {
  if (!Array.isArray(items) || !items.length) return "";
  return `
    <div class="progress-game-list brilliant-progress-games">
      ${items.slice(0, 8).map((item) => {
        const content = `
          <span class="progress-game-dot brilliant"></span>
          <b>${escapeHtml(item.opponent || "Unknown opponent")}</b>
          <small>${Number(item.brilliants || 0)} Brilliant${Number(item.brilliants || 0) === 1 ? "" : "s"} · ${escapeHtml(item.time_class || "unknown")} · ${escapeHtml(item.color || "")} · ${escapeHtml(item.result || "")}</small>
        `;
        return item.url
          ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${content}</a>`
          : `<span>${content}</span>`;
      }).join("")}
    </div>
  `;
}

function renderBrilliantProgressInsight(label, item) {
  if (!item) {
    return `
      <article class="progress-insight">
        <span>${escapeHtml(label)}</span>
        <strong>Waiting for data</strong>
        <small>No Brilliant activity in this range yet.</small>
      </article>
    `;
  }
  return `
    <article class="progress-insight">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(item.label || item.date || "")}</strong>
      <small>${Number(item.brilliants || 0)} Brilliant${Number(item.brilliants || 0) === 1 ? "" : "s"} · ${Number(item.games || 0)} games · ${escapeHtml(item.record || "")}</small>
    </article>
  `;
}

function renderBrilliantBreakdown(items) {
  if (!Array.isArray(items) || !items.length) {
    return `
      <article class="progress-insight">
        <span>Time-control split</span>
        <strong>No split yet</strong>
        <small>Rated game imports will populate this.</small>
      </article>
    `;
  }
  return `
    <article class="progress-insight breakdown">
      <span>Time-control split</span>
      <strong>${items.reduce((sum, item) => sum + Number(item.brilliants || 0), 0)} total</strong>
      <small>${items.slice(0, 4).map((item) => `${escapeHtml(item.label || item.key || "games")}: ${Number(item.brilliants || 0)} / ${Number(item.games || 0)} games`).join(" · ")}</small>
    </article>
  `;
}

function bindBrilliantProgressEvents() {
  if (!el.brilliantTracker) return;
  el.brilliantTracker.querySelectorAll("[data-brilliant-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.brilliantProgressRange = button.dataset.brilliantRange || "90";
      state.brilliantProgressPointIndex = null;
      if (brilliantTrackerEnabled) renderBrilliantTracker(state.payload?.profile?.brilliant_tracker || null);
    });
  });
  el.brilliantTracker.querySelectorAll("[data-brilliant-time-class]").forEach((button) => {
    button.addEventListener("click", () => {
      state.brilliantProgressTimeClass = button.dataset.brilliantTimeClass || "";
      state.brilliantProgressPointIndex = null;
      if (brilliantTrackerEnabled) renderBrilliantTracker(state.payload?.profile?.brilliant_tracker || null);
    });
  });
  el.brilliantTracker.querySelectorAll("[data-brilliant-index]").forEach((button) => {
    const update = () => {
      state.brilliantProgressPointIndex = Number(button.dataset.brilliantIndex);
      if (brilliantTrackerEnabled) renderBrilliantTracker(state.payload?.profile?.brilliant_tracker || null);
    };
    button.addEventListener("click", update);
    button.addEventListener("focus", update);
    button.addEventListener("mouseenter", update);
  });
}

function renderBrilliantTrackerList(items, emptyText) {
  if (!Array.isArray(items) || !items.length) return `<p class="line-note">${escapeHtml(emptyText)}</p>`;
  return items.slice(0, 10).map((item) => `
    <article class="brilliant-card ${escapeHtml(classificationKey(item.classification))}">
      <div class="brilliant-card-head">
        <div>
          <strong>${escapeHtml(item.move || item.san || "")}</strong>
          <span>${escapeHtml(item.role || item.time_class || "game move")} · ${escapeHtml(item.opponent ? `vs ${item.opponent}` : item.line_label || "Repertoire position")}</span>
        </div>
        ${classificationBadge(item.classification, "compact")}
      </div>
      <p>${escapeHtml(item.reason || item.classification?.reason || "Cached engine candidate from your repertoire.")}</p>
      ${item.pgn_path ? `<p class="brilliant-path">${escapeHtml(item.pgn_path)}</p>` : ""}
      <div class="chip-row">
        ${item.lesson_id ? `<button class="launch-btn" type="button" data-work-line="${escapeHtml(item.lesson_id)}">Work on line</button>` : ""}
        ${item.game_url ? `<a class="launch-btn" href="${escapeHtml(item.game_url)}" target="_blank" rel="noopener noreferrer">Open game</a>` : ""}
      </div>
    </article>
  `).join("");
}

function renderBrilliantGameList(items, emptyText) {
  if (!Array.isArray(items) || !items.length) return `<p class="line-note">${escapeHtml(emptyText)}</p>`;
  return items.slice(0, 24).map((game) => `
    <article class="brilliant-card brilliant-game-card">
      <div class="brilliant-card-head">
        <div>
          <strong>${Number(game.brilliants || 0)} Brilliant${Number(game.brilliants || 0) === 1 ? "" : "s"}</strong>
          <span>${escapeHtml(game.date_label || "Imported game")} · ${escapeHtml(game.time_class || "unknown")} · ${escapeHtml(game.result || "")}</span>
        </div>
        ${game.game_url ? `<a class="launch-btn" href="${escapeHtml(game.game_url)}" target="_blank" rel="noopener noreferrer">Open game</a>` : ""}
      </div>
      <p>Against ${escapeHtml(game.opponent || "opponent")} as ${escapeHtml(game.player_color || "your color")}.</p>
      ${game.pgn_path ? `<p class="brilliant-path">${escapeHtml(game.pgn_path)}</p>` : ""}
    </article>
  `).join("");
}

function renderRatingProgress(progress) {
  if (!el.ratingProgress) return;
  if (!progress?.available || !progress.ranges || !Object.keys(progress.ranges).length) {
    el.ratingProgress.className = "rating-progress-panel empty";
    el.ratingProgress.textContent = progress?.message || "Import rated Chess.com games to see rating, record, and form over time.";
    return;
  }
  const splitPayloads = progress.time_class_progress || {};
  const splitKeys = [];
  (progress.time_class_breakdown || []).forEach((item) => {
    const key = String(item.label || item.key || "").trim();
    if (key && splitPayloads[key] && !splitKeys.includes(key)) splitKeys.push(key);
  });
  Object.keys(splitPayloads).forEach((key) => {
    if (!splitKeys.includes(key)) splitKeys.push(key);
  });
  const timeClassOrder = splitKeys;
  const defaultTimeKey = progress.default_time_class && timeClassOrder.includes(progress.default_time_class)
    ? progress.default_time_class
    : (timeClassOrder[0] || "");
  if (timeClassOrder.length && (!state.ratingProgressTimeClass || !timeClassOrder.includes(state.ratingProgressTimeClass))) {
    state.ratingProgressTimeClass = defaultTimeKey;
  }
  if (!timeClassOrder.length) {
    state.ratingProgressTimeClass = "";
  }
  const activeTimeKey = timeClassOrder.length && timeClassOrder.includes(state.ratingProgressTimeClass)
    ? state.ratingProgressTimeClass
    : "";
  const activeProgress = activeTimeKey ? (splitPayloads[activeTimeKey] || progress) : progress;
  const timeClassLabel = activeTimeKey
    ? activeProgress.time_class_label || activeTimeKey.replace(/_/g, " ")
    : "Rated games";
  const ranges = activeProgress.ranges || {};
  const rangeOrder = ["7", "30", "90", "365", "all"].filter((key) => ranges[key]);
  if (!rangeOrder.includes(state.ratingProgressRange)) {
    state.ratingProgressRange = activeProgress.default_range || progress.default_range || rangeOrder[0] || "90";
  }
  const activeKey = ranges[state.ratingProgressRange] ? state.ratingProgressRange : rangeOrder[0];
  const range = ranges[activeKey] || {};
  const points = Array.isArray(range.points) ? range.points : [];
  const graphPoints = points
    .map((point, index) => ({ ...point, index, graphValue: Number(point.rating_graph ?? point.rating) }))
    .filter((point) => Number.isFinite(point.graphValue));
  const selectedIndex = pickRatingProgressIndex(graphPoints);
  const selected = graphPoints[selectedIndex] || graphPoints[graphPoints.length - 1] || points[points.length - 1] || null;
  const isMixedAllChart = false;
  const chart = buildRatingProgressChart(graphPoints, selected?.index, {
    dense: graphPoints.length > 130,
    baselineValue: range.rating_start,
    minSpread: 300,
  });
  const ratingEnd = range.rating_end ?? activeProgress.latest_rating ?? progress.latest_rating ?? null;
  const ratingChange = range.rating_change;
  const changeClass = Number(ratingChange || 0) > 0 ? "up" : Number(ratingChange || 0) < 0 ? "down" : "flat";
  const gameTypeText = activeTimeKey ? `${timeClassLabel.toLowerCase()} game` : "rated game";
  el.ratingProgress.className = "rating-progress-panel";
  el.ratingProgress.innerHTML = `
    <div class="rating-progress-head">
      <div>
        <div class="line-badge">Imported form tracker</div>
        <h3>${escapeHtml(range.label || "Progress")} · ${escapeHtml(timeClassLabel)}</h3>
        <p>${Number(range.games || 0)} ${escapeHtml(gameTypeText)}${Number(range.games || 0) === 1 ? "" : "s"} from ${escapeHtml(range.start_date || "")} to ${escapeHtml(range.end_date || "")}</p>
      </div>
      <div class="progress-filter-stack">
        <div class="progress-range-tabs" role="tablist" aria-label="Progress range">
          ${rangeOrder.map((key) => `
            <button class="progress-range-btn ${key === activeKey ? "active" : ""}" type="button" data-progress-range="${escapeHtml(key)}">
              ${escapeHtml(ranges[key]?.label || key)}
            </button>
          `).join("")}
        </div>
        ${timeClassOrder.length ? `<div class="progress-range-tabs compact" role="tablist" aria-label="Time-control split">
          ${timeClassOrder.map((key) => {
            const payload = splitPayloads[key] || {};
            const label = payload.time_class_label || key.replace(/_/g, " ");
            const games = payload.dated_games || payload.total_games || 0;
            return `
              <button class="progress-range-btn ${key === activeTimeKey ? "active" : ""}" type="button" data-progress-time-class="${escapeHtml(key)}">
                ${escapeHtml(label)} <span>${Number(games || 0)}</span>
              </button>
            `;
          }).join("")}
        </div>` : ""}
      </div>
    </div>
    <div class="progress-metric-grid">
      <article>
        <span>Rating now</span>
        <strong>${ratingEnd == null ? "--" : Number(ratingEnd)}</strong>
        <small class="${changeClass}">${formatRatingDelta(ratingChange)}</small>
      </article>
      <article>
        <span>Record</span>
        <strong>${escapeHtml(range.record || "0W 0D 0L")}</strong>
        <small>${Number(range.win_rate || 0).toFixed(1)}% wins</small>
      </article>
      <article>
        <span>Score rate</span>
        <strong>${Number(range.score_rate || 0).toFixed(1)}%</strong>
        <small>${Number(range.games || 0)} games</small>
      </article>
      <article>
        <span>Peak</span>
        <strong>${range.best_rating == null ? "--" : Number(range.best_rating)}</strong>
        <small>${range.worst_rating == null ? "No rating floor yet" : `low ${Number(range.worst_rating)}`}</small>
      </article>
    </div>
    <div class="rating-chart-wrap">
      <div class="rating-chart ${chart.dense ? "dense" : ""} ${isMixedAllChart ? "mixed" : ""}">
        ${chart.svg}
        <div class="rating-point-layer">
          ${chart.points.map((point) => `
            <button
              class="rating-point ${escapeHtml(point.tone)} ${point.sourceIndex === selected?.index ? "active" : ""}"
              type="button"
              style="left:${point.x}%; top:${point.y}%"
              title="${escapeHtml(point.title)}"
              data-progress-index="${point.sourceIndex}"
              aria-label="${escapeHtml(point.title)}"
            ></button>
          `).join("")}
        </div>
        <div class="rating-result-ribbon" aria-hidden="true">
          ${chart.resultTicks.map((tick) => `
            <span
              class="rating-result-tick ${escapeHtml(tick.tone)}"
              style="left:${tick.x}%"
              title="${escapeHtml(tick.title)}"
            ></span>
          `).join("")}
        </div>
        <div class="rating-chart-legend">
          <span><i class="win"></i>Win</span>
          <span><i class="draw"></i>Draw</span>
          <span><i class="loss"></i>Loss</span>
        </div>
        <div class="rating-axis top">${chart.maxLabel}</div>
        <div class="rating-axis bottom">${chart.minLabel}</div>
        <div class="rating-axis baseline">Start ${chart.baselineLabel}</div>
      </div>
      <div class="progress-highlight" data-progress-highlight>
        ${renderRatingProgressHighlight(selected, range)}
      </div>
    </div>
    <div class="progress-insights">
      ${renderRatingProgressInsight("Busiest day", range.busiest_day)}
      ${renderRatingProgressInsight("Best scoring day", range.best_score_day)}
      ${renderTimeClassBreakdown(activeProgress.time_class_breakdown || progress.time_class_breakdown || [])}
    </div>
  `;
  bindRatingProgressEvents();
}

function pickRatingProgressIndex(graphPoints) {
  if (!graphPoints.length) return -1;
  const requested = Number(state.ratingProgressPointIndex);
  if (Number.isInteger(requested)) {
    const found = graphPoints.findIndex((point) => Number(point.index) === requested);
    if (found >= 0) return found;
  }
  for (let index = graphPoints.length - 1; index >= 0; index -= 1) {
    if (Number(graphPoints[index].games || 0) > 0) return index;
  }
  return graphPoints.length - 1;
}

function buildRatingProgressChart(graphPoints, selectedSourceIndex, options = {}) {
  if (!graphPoints.length) {
    return {
      svg: "<div class=\"rating-chart-empty\">No rating points in this range yet.</div>",
      points: [],
      resultTicks: [],
      minLabel: "--",
      maxLabel: "--",
      baselineLabel: "--",
      dense: false,
    };
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const isValueChart = Boolean(options.valueLabel);
  const values = graphPoints
    .map((point) => Number(point.graphValue))
    .filter((value) => Number.isFinite(value));
  const sortedValues = [...values].sort((a, b) => a - b);
  const percentile = (pct) => {
    if (!sortedValues.length) return 0;
    const position = clamp(pct, 0, 1) * (sortedValues.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sortedValues[lower];
    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
  };
  let domainValues = sortedValues;
  if (!isValueChart && options.robustDomain !== false && sortedValues.length >= 12) {
    const p10 = percentile(0.1);
    const p90 = percentile(0.9);
    const spread = Math.max(1, p90 - p10);
    const fence = Math.max(90, spread * 0.85);
    const trimmed = sortedValues.filter((value) => value >= p10 - fence && value <= p90 + fence);
    if (trimmed.length >= Math.max(8, Math.floor(sortedValues.length * 0.7))) {
      domainValues = trimmed;
    }
  }

  let minValue = domainValues.length ? Math.min(...domainValues) : 0;
  let maxValue = domainValues.length ? Math.max(...domainValues) : 1;
  const requestedMinSpread = Number(options.minSpread);
  const minSpread = Number.isFinite(requestedMinSpread)
    ? requestedMinSpread
    : (isValueChart ? Math.max(6, maxValue - minValue) : 240);
  if (maxValue - minValue < minSpread) {
    const center = (maxValue + minValue) / 2;
    minValue = center - minSpread / 2;
    maxValue = center + minSpread / 2;
  }
  const padding = isValueChart
    ? Math.max(1, Math.ceil((maxValue - minValue) * 0.08))
    : Math.max(25, Math.ceil((maxValue - minValue) * 0.1));
  minValue = Math.floor(minValue - padding);
  maxValue = Math.ceil(maxValue + padding);
  if (isValueChart && Number(options.baselineValue) === 0) {
    minValue = Math.min(0, minValue);
  }
  const span = maxValue - minValue || 1;
  const toX = (index) => graphPoints.length === 1 ? 50 : (index / (graphPoints.length - 1)) * 100;
  const toY = (value) => clamp(88 - ((Number(value) - minValue) / span) * 72, 6, 96);
  const pointTitle = (point) => {
    const pieces = [point.label || point.date || "Day"];
    if (isValueChart) {
      pieces.push(`${Number(point.graphValue || 0)} ${options.valueLabel}`);
    } else {
      pieces.push(`${point.rating_graph ?? point.rating ?? "--"} rating`);
    }
    if (point.result) pieces.push(point.result);
    if (point.opponent) pieces.push(`vs ${point.opponent}`);
    if (point.opening) pieces.push(point.opening);
    if (point.summary) pieces.push(point.summary);
    return pieces.filter(Boolean).join(" · ");
  };
  const coords = graphPoints.map((point, index) => ({
    x: Number(toX(index).toFixed(3)),
    y: Number(toY(point.graphValue).toFixed(3)),
    sourceIndex: point.index,
    tone: point.result_tone || "idle",
    graphValue: point.graphValue,
    title: pointTitle(point),
  }));

  const smoothPath = (points) => {
    if (!points.length) return "";
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 0; index < points.length - 1; index += 1) {
      const p0 = points[Math.max(0, index - 1)];
      const p1 = points[index];
      const p2 = points[index + 1];
      const p3 = points[Math.min(points.length - 1, index + 2)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      path += ` C ${Number(cp1x.toFixed(3))} ${Number(cp1y.toFixed(3))}, ${Number(cp2x.toFixed(3))} ${Number(cp2y.toFixed(3))}, ${p2.x} ${p2.y}`;
    }
    return path;
  };

  const lineStep = Math.max(1, Math.ceil(coords.length / 420));
  const pathCoords = coords.filter((_point, index) => index % lineStep === 0 || index === coords.length - 1);
  const linePath = smoothPath(pathCoords);
  const areaPath = pathCoords.length
    ? `${linePath} L ${pathCoords[pathCoords.length - 1].x} 98 L ${pathCoords[0].x} 98 Z`
    : "";
  const selected = coords.find((point) => Number(point.sourceIndex) === Number(selectedSourceIndex));
  const selectedLine = selected ? `<line class="rating-selected-line" x1="${selected.x}" x2="${selected.x}" y1="8" y2="96"></line>` : "";
  const baselineValue = Number.isFinite(Number(options.baselineValue))
    ? Number(options.baselineValue)
    : Number(graphPoints[0]?.graphValue);
  const baselineY = Number.isFinite(baselineValue) ? Number(toY(baselineValue).toFixed(3)) : null;
  const baselineLine = baselineY == null
    ? ""
    : `<line class="rating-baseline-line" x1="0" x2="100" y1="${baselineY}" y2="${baselineY}"></line>`;
  const dense = Boolean(options.dense);
  const markerLimit = dense ? 80 : 160;
  const markerStep = Math.max(1, Math.ceil(coords.length / markerLimit));
  const markerPoints = coords.filter((point, index) => (
    index % markerStep === 0 ||
    index === 0 ||
    index === coords.length - 1 ||
    point.tone !== "idle" ||
    Number(point.sourceIndex) === Number(selectedSourceIndex)
  ));
  const playedCoords = coords
    .map((point, index) => ({ ...point, games: Number(graphPoints[index]?.games || 0) }))
    .filter((point) => point.games > 0);
  const tickLimit = dense ? 86 : 120;
  const tickStep = Math.max(1, Math.ceil(playedCoords.length / tickLimit));
  const resultTicks = playedCoords.filter((point, index) => (
    index % tickStep === 0 ||
    index === playedCoords.length - 1 ||
    Number(point.sourceIndex) === Number(selectedSourceIndex)
  ));
  return {
    svg: `
      <svg viewBox="0 0 100 104" preserveAspectRatio="none" aria-hidden="true">
        ${baselineLine}
        <path class="rating-area" d="${areaPath}"></path>
        <path class="rating-line-halo" d="${linePath}"></path>
        <path class="rating-line" d="${linePath}"></path>
        ${selectedLine}
      </svg>
    `,
    points: markerPoints,
    resultTicks,
    minLabel: String(Math.round(minValue)),
    maxLabel: String(Math.round(maxValue)),
    baselineLabel: Number.isFinite(baselineValue) ? String(Math.round(baselineValue)) : "--",
    dense,
  };
}

function bindRatingProgressEvents() {
  el.ratingProgress.querySelectorAll("[data-progress-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ratingProgressRange = button.dataset.progressRange || "90";
      state.ratingProgressPointIndex = null;
      renderRatingProgress(state.payload?.profile?.rating_progress || null);
    });
  });
  el.ratingProgress.querySelectorAll("[data-progress-time-class]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ratingProgressTimeClass = button.dataset.progressTimeClass || "";
      state.ratingProgressPointIndex = null;
      renderRatingProgress(state.payload?.profile?.rating_progress || null);
    });
  });
  el.ratingProgress.querySelectorAll("[data-progress-index]").forEach((button) => {
    const update = () => {
      state.ratingProgressPointIndex = Number(button.dataset.progressIndex);
      renderRatingProgress(state.payload?.profile?.rating_progress || null);
    };
    button.addEventListener("click", update);
    button.addEventListener("focus", update);
    button.addEventListener("mouseenter", update);
  });
}

function formatRatingDelta(value) {
  if (value == null || !Number.isFinite(Number(value))) return "no rating change yet";
  const numeric = Number(value);
  if (numeric > 0) return `+${numeric} over range`;
  if (numeric < 0) return `${numeric} over range`;
  return "even over range";
}

function renderRatingProgressHighlight(point, range) {
  if (!point) {
    return "<strong>No day selected</strong><span>Hover a chart marker to inspect that day.</span>";
  }
  const opponents = Array.isArray(point.opponents) && point.opponents.length
    ? point.opponents.map((name) => escapeHtml(name)).join(", ")
    : "No opponent list for this day";
  const rating = point.rating ?? point.rating_graph ?? range.rating_end ?? "--";
  const gameLinks = renderRatingProgressGameLinks(point.game_links || []);
  const openGame = point.last_game_url
    ? `<a class="tiny-action" href="${escapeHtml(point.last_game_url)}" target="_blank" rel="noreferrer">Open latest game</a>`
    : "";
  return `
    <div>
      <span class="line-badge">${escapeHtml(point.label || point.date || "Selected day")}</span>
      <strong>${escapeHtml(point.summary || "No games imported for this day.")}</strong>
      <p>${Number(point.score_rate || 0).toFixed(1)}% score · ${Number(point.win_rate || 0).toFixed(1)}% wins · rating ${escapeHtml(rating)}</p>
    </div>
    <div class="progress-highlight-grid">
      <span><b>${Number(point.games || 0)}</b> games</span>
      <span><b>${Number(point.wins || 0)}</b> wins</span>
      <span><b>${Number(point.draws || 0)}</b> draws</span>
      <span><b>${Number(point.losses || 0)}</b> losses</span>
    </div>
    ${gameLinks}
    <small>${opponents}</small>
    ${openGame}
  `;
}

function renderRatingProgressGameLinks(items) {
  if (!Array.isArray(items) || !items.length) return "";
  return `
    <div class="progress-game-list">
      ${items.slice(-5).reverse().map((item) => {
        const tone = item.result || "idle";
        const label = item.opponent || "Unknown opponent";
        const rating = item.rating == null ? "" : ` · ${Number(item.rating)}`;
        const moves = item.move_count == null ? "" : ` · ${Number(item.move_count)} moves`;
        const opening = item.opening ? ` · ${item.opening}` : "";
        const detail = `${item.color || ""}${rating}${moves}${opening}`;
        const content = `<span class="progress-game-dot ${escapeHtml(tone)}"></span><b>${escapeHtml(label)}</b><small>${escapeHtml(detail)}</small>`;
        return item.url
          ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${content}</a>`
          : `<span>${content}</span>`;
      }).join("")}
    </div>
  `;
}

function renderRatingProgressInsight(label, item) {
  if (!item) {
    return `
      <article class="progress-insight">
        <span>${escapeHtml(label)}</span>
        <strong>Waiting for games</strong>
        <small>No day data in this range yet.</small>
      </article>
    `;
  }
  const score = item.score_rate == null ? "" : ` · ${Number(item.score_rate).toFixed(1)}% score`;
  return `
    <article class="progress-insight">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(item.label || item.date || "")}</strong>
      <small>${Number(item.games || 0)} games · ${escapeHtml(item.record || "")}${score}</small>
    </article>
  `;
}

function renderTimeClassBreakdown(items) {
  const top = items.slice(0, 3);
  return `
    <article class="progress-insight">
      <span>Time controls</span>
      <strong>${top.length ? escapeHtml(top.map((item) => item.label).join(" / ")) : "No split yet"}</strong>
      <small>${top.length ? escapeHtml(top.map((item) => `${item.label}: ${item.games}`).join(" · ")) : "Import games to see the mix."}</small>
    </article>
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
    const username = state.payload?.username || resolveConfiguredUsername();
    if (!username) {
      el.cacheDashboard.className = "stack empty";
      el.cacheDashboard.textContent = "Choose your main Chess.com username in Setup to load local cache stats.";
      return;
    }
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
  const section = el.transpositionList.closest("section") || el.transpositionList.parentElement;
  if (section) section.hidden = true;
  el.transpositionList.className = "stack empty";
  el.transpositionList.innerHTML = "";
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
    { key: "due", title: "Due", detail: "Ready now", items: schedule?.due_today || [] },
    { key: "later", title: "Later", detail: "Cooling down", items: schedule?.new_later || [] },
    { key: "known", title: "Known", detail: "Archive", items: schedule?.known_archive || [] },
  ];
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  if (!total) {
    el.reviewSchedule.className = "review-schedule compact-review-schedule empty";
    el.reviewSchedule.innerHTML = `<div class="compact-empty">Review schedule will show up here once lines enter your queues.</div>`;
    return;
  }
  el.reviewSchedule.className = "review-schedule compact-review-schedule";
  el.reviewSchedule.innerHTML = `
    <div class="review-summary-strip">
      ${groups.map((group) => `<span><strong>${group.items.length}</strong>${escapeHtml(group.title)}</span>`).join("")}
    </div>
    <div class="review-bucket-grid">
      ${groups.map((group) => `
        <article class="review-bucket ${escapeHtml(group.key)}">
          <div class="review-bucket-head">
            <div>
              <strong>${escapeHtml(group.title)}</strong>
              <span>${escapeHtml(group.detail)}</span>
            </div>
            <b>${group.items.length}</b>
          </div>
          <div class="review-row-list">
            ${group.items.length ? group.items.slice(0, 6).map((item) => `
              <button class="review-row" type="button" data-work-line="${escapeHtml(item.lesson_id || "")}">
                <span>${escapeHtml(item.line_label || item.opening_name || "Review line")}</span>
                <small>${escapeHtml(item.recommended_move || item.best_reply || item.move || item.interval || "")} · ${Math.round(Number(item.confidence || 0))}</small>
              </button>
            `).join("") : `<div class="review-row muted">Empty</div>`}
            ${group.items.length > 6 ? `<div class="review-more">+${group.items.length - 6} more</div>` : ""}
          </div>
        </article>
      `).join("")}
    </div>
  `;
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
  const counts = plan.counts || {};
  const countCards = [
    ["Due", counts.due],
    ["Repair", counts.repair],
    ["Replies", counts.database_replies],
    ["New", counts.new],
  ];
  const quickActions = (plan.quick_actions || []).filter((action) => action.lesson_id);
  el.studyPlanPanel.innerHTML = `
    <div class="study-plan-summary">
      <div>
        <strong>${Number(plan.estimated_minutes || 0)} min</strong>
        <span>${escapeHtml(plan.summary || "Today's training plan is ready.")}</span>
      </div>
      <div class="study-plan-counts">
        ${countCards.map(([label, value]) => `
          <span><b>${Number(value || 0)}</b>${escapeHtml(label)}</span>
        `).join("")}
      </div>
      ${quickActions.length ? `
        <div class="chip-row">
          ${quickActions.map((action) => `
            <button class="launch-btn compact" type="button" data-work-line="${escapeHtml(action.lesson_id)}">${escapeHtml(action.label || "Start")}</button>
          `).join("")}
        </div>
      ` : ""}
    </div>
    ${blocks.map((block) => `
      <article class="plan-block ${escapeHtml(block.kind || "")}">
        <div class="line-card-header">
          <div>
            <div class="line-title">${escapeHtml(block.title || "Study block")}</div>
            <div class="line-note">${escapeHtml(block.goal || "")}</div>
          </div>
          <span class="line-badge">${Number(block.minutes || 0)} min</span>
        </div>
        <div class="study-plan-items">
          ${(block.items || []).slice(0, 5).map((item) => {
            const title = item.line_label || item.opponent_reply || "Study item";
            const move = item.recommended_move || item.response || "";
            const classification = item.classification_label || item.classification?.label || "";
            const metric = item.popularity ? `${Number(item.popularity || 0)}% database` : `${Math.round(Number(item.confidence || 0))} confidence`;
            const note = item.note || item.reason || "";
            const body = `
              <div class="plan-item-main">
                <strong>${escapeHtml(title)}</strong>
                <span>${escapeHtml(move ? `Play ${move}` : "Open this line")}</span>
              </div>
              <div class="plan-item-meta">
                ${classification ? `<span class="classification-chip tiny">${escapeHtml(classification)}</span>` : ""}
                <span>${escapeHtml(metric)}</span>
                ${Number(item.repeat_mistake_count || 0) ? `<span>${Number(item.repeat_mistake_count || 0)} misses</span>` : ""}
              </div>
              ${note ? `<div class="plan-item-note">${escapeHtml(note)}</div>` : ""}
            `;
            return item.lesson_id ? `
              <button class="plan-item" type="button" data-work-line="${escapeHtml(item.lesson_id)}">
                ${body}
              </button>
            ` : `<div class="plan-item muted">${body}</div>`;
          }).join("") || `<div class="line-note">${escapeHtml(block.empty || "Nothing needed in this block yet.")}</div>`}
        </div>
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
    el.theoryPresetPanel.className = "theory-seed-grid empty";
    el.theoryPresetPanel.innerHTML = `<div class="compact-empty">Bookup will suggest theory seeds after import.</div>`;
    return;
  }
  el.theoryPresetPanel.className = "theory-seed-grid";
  el.theoryPresetPanel.innerHTML = seeds.slice(0, 10).map((seed) => `
    <button class="mini-card theory-seed compact" type="button" data-theory-seed="${escapeHtml(seed.move || "")}">
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
  const firstLayer = children.slice(0, 10);
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
        <details class="move-tree-deep">
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
  const hasChildren = children.length > 0 && depth < 5;
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
  const open = depth < 1 ? "open" : "";
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
  state.lastMoveReaction = null;
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
  state.lastMoveReaction = null;
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
  const reaction = line?.reaction?.headline ? `<div class="study-engine-reaction">${escapeHtml(line.reaction.headline)}</div>` : "";
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
      ${reaction}
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

function renderReactionMarkup(reaction) {
  if (!reaction) return "";
  const reasons = Array.isArray(reaction?.reasons) ? reaction.reasons.filter(Boolean).slice(0, 3) : [];
  const fallbackFeatures = Array.isArray(reaction?.features) ? reaction.features.filter(Boolean).slice(0, 4) : [];
  const motifs = Array.isArray(reaction?.motifs) ? reaction.motifs.filter(Boolean).slice(0, 6) : fallbackFeatures;
  const rawTone = String(reaction?.tone || reaction?.classification_key || "neutral").toLowerCase();
  const tone = rawTone.replace(/[^a-z0-9_-]/g, "") || "neutral";
  const summary = reaction?.summary || "";
  const nextStep = reaction?.next_step || "";
  const side = reaction?.side ? `${reaction.side} move` : "";
  return `
    <div class="coach-reaction-card tone-${escapeHtml(tone)}">
      <div class="coach-reaction-topline">
        <span class="coach-reaction-tone">${escapeHtml(reaction?.tone_label || reaction?.label || "Move note")}</span>
        ${side ? `<span class="coach-reaction-side">${escapeHtml(side)}</span>` : ""}
      </div>
      <div class="coach-reaction-head">${escapeHtml(reaction?.headline || "Coach reaction")}</div>
      ${summary ? `<div class="coach-reaction-summary">${escapeHtml(summary)}</div>` : ""}
      ${reasons.length ? `<div class="coach-reaction-reasons">${reasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}</div>` : ""}
      ${motifs.length ? `<div class="coach-reaction-features coach-reaction-motifs">${motifs.map((feature) => `<span>${escapeHtml(feature)}</span>`).join("")}</div>` : ""}
      ${nextStep ? `<div class="coach-reaction-next">${escapeHtml(nextStep)}</div>` : ""}
    </div>
  `;
}

function liveReactionFromInsight(insight) {
  return insight?.your_move_reaction
    || insight?.coach_reaction
    || insight?.recommended_reaction
    || null;
}

function renderTrainerInsightMarkup(insight) {
  const reaction = liveReactionFromInsight(insight);
  const topLine = Array.isArray(insight?.candidate_lines) ? insight.candidate_lines[0] : null;
  const databaseMoves = Array.isArray(insight?.database_moves) ? insight.database_moves.slice(0, 3) : [];
  if (!reaction && !topLine && !databaseMoves.length) {
    return "Blue arrows show top engine moves. Red arrows show threats or practical replies once the live position loads.";
  }
  const topCopy = topLine
    ? `<span>Engine: <strong>${escapeHtml(topLine.move || topLine.uci || "")}</strong>${classificationBadge(topLine.classification, "compact")}</span>`
    : "";
  const databaseCopy = databaseMoves.length
    ? `<span>Database: ${databaseMoves.map((item) => `${escapeHtml(item.san || item.uci || "")} ${escapeHtml(String(item.popularity || item.percent || 0))}%`).join(" / ")}</span>`
    : "";
  return `
    <div class="trainer-live-reaction">
      ${reaction ? renderReactionMarkup(reaction) : ""}
      <div class="trainer-live-facts">
        ${topCopy}
        ${databaseCopy}
      </div>
    </div>
  `;
}

function renderStudyReviewMarkup(lesson, playedMoveSan, playedClassification, recommendedMove, recommendedClassification, coachText = "", reaction = null) {
  if (!playedMoveSan) {
    const fallbackMove = recommendedMove || lesson?.best_reply || "No move yet";
    const fallbackCopy = coachText || "Bookup will classify the move you play here, then compare it with the current engine recommendation.";
    return `${renderStudyMoveCard("Recommended move", fallbackMove, recommendedClassification, fallbackCopy)}${renderReactionMarkup(reaction)}`;
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
      ${renderReactionMarkup(reaction)}
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
  state.lastMoveReaction = null;
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
      `Workers ${el.studyParallelWorkers?.value || el.parallelWorkers?.value || "--"}`,
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
      `Workers ${el.studyParallelWorkers?.value || el.parallelWorkers?.value || "--"}`,
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
      state.lastMoveReaction || insight?.your_move_reaction || insight?.coach_reaction || null,
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
      `Workers ${el.studyParallelWorkers?.value || el.parallelWorkers?.value || "--"}`,
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
      state.lastMoveReaction || insight?.your_move_reaction || insight?.coach_reaction || null,
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
  node.className = "stack compact-work-list";
  node.innerHTML = items
    .map((item) => {
      const candidatePreview = (item.candidate_lines || [])
        .slice(0, 5)
        .map((line) => renderCandidateLineSummary(line))
        .join("");
      const repeated = Number(item.repeat_mistake_count || 0);
      return `
      <article class="line-card compact-work-card">
        <div class="line-card-header">
          <div>
            <div class="line-title">${escapeHtml(item.line_label || item.opening_name)}</div>
            <div class="tree-meta">${escapeHtml(item.opening_name || "")}</div>
          </div>
          <div class="line-badge ${statusClass(item.line_status)}">${labelForStatus(item.line_status)}</div>
        </div>
        <div class="compact-line-summary">
          <span>Train <strong>${escapeHtml(item.best_reply)}</strong>${classificationBadge(item.recommended_classification, "inline")}</span>
          <span>${Number(item.frequency || 0)}x</span>
          <span>${Math.round(Number(item.priority || 0))} priority</span>
          <span>${describeEdge(item.value_lost_cp)}</span>
          ${repeated ? `<span>${repeated} misses</span>` : ""}
        </div>
        <div class="compact-candidate-row">${candidatePreview || "No candidate lines available."}</div>
        ${renderQueueExplainer(item, "compact")}
        <div class="line-preview compact">${escapeHtml(item.continuation_san || "")}</div>
        <div class="line-note compact">${escapeHtml(item.explanation || "")}</div>
        <div class="chip-row">
          <button class="launch-btn" type="button" data-work-line="${escapeHtml(item.lesson_id)}">Work on line</button>
          ${item.position_identifier ? `<a class="launch-btn" href="${escapeHtml(item.position_identifier)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.position_identifier_label || "Lichess analysis")}</a>` : ""}
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
      ...currentStudySettingsPayload(),
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
  el.theoryOutput.className = "theory-output theory-output-compact loading";
  el.theoryOutput.innerHTML = `<div class="line-note">Generating ${plies} best moves from the current board position...</div>`;
  try {
    const response = await fetch("/api/generate-theory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...currentStudySettingsPayload(),
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
    el.theoryOutput.className = "theory-output theory-output-compact empty";
    el.theoryOutput.textContent = error.message || "Could not generate theory.";
  } finally {
    el.generateTheory.disabled = false;
  }
}

function renderTheoryResult(result) {
  if (!el.theoryOutput) return;
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  if (!steps.length) {
    el.theoryOutput.className = "theory-output theory-output-compact empty";
    el.theoryOutput.textContent = "No engine theory line was generated from this position.";
    return;
  }
  el.theoryOutput.className = "theory-output theory-output-compact";
  const seed = result.seed_move
    ? `<div class="theory-seed compact">After ${escapeHtml(result.seed_move.san)} (${escapeHtml(result.seed_move.uci)})</div>`
    : `<div class="theory-seed compact">From the current board position</div>`;
  const line = steps.map((step) => step.san).join(" ");
  el.theoryOutput.innerHTML = `
    ${seed}
    <div class="theory-line theory-line-compact">${escapeHtml(line)}</div>
    <div class="theory-step-list compact">
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
  const dbMarkup = db.map((move) => `<span>${escapeHtml(move.san || move.uci || "")} ${Number(move.popularity || 0).toFixed(1)}%</span>`).join("");
  return `
    <article class="theory-step compact">
      <div class="theory-step-head">
        <div>
          <div class="theory-step-title">${Number(step?.ply || 0)}. ${escapeHtml(step?.san || "")} ${classificationBadge(step?.classification, "compact")}</div>
          <div class="tree-meta">${escapeHtml(step?.side || "")} to move | ${formatEval(step?.eval_cp_white ?? 0)}</div>
        </div>
        <span class="line-badge">${escapeHtml(step?.uci || "")}</span>
      </div>
      <div class="theory-mini-grid">
        <div>
          <span>Engine</span>
          <div class="theory-chip-line">${candidates.map((line) => renderCandidateLineSummary(line)).join("") || `<small class="theory-empty-chip">No alternatives</small>`}</div>
        </div>
        <div>
          <span>Database</span>
          <div class="theory-chip-line">${dbMarkup || `<small class="theory-empty-chip">No database data</small>`}</div>
        </div>
      </div>
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
  el.mistakeList.className = "stack compact-review-grid";
  el.mistakeList.innerHTML = repeatedItems
    .map((item, index) => `
      <article class="mistake-card compact-review-card">
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
    const completedCount = Number(review.completed_count || 0);
    const cleanCount = Number(review.clean_completed_count || 0);
    const mastered = review.line_state === "mastered" || Number(review.streak || 0) >= 3;
    const completed = completedCount > 0;
    const score = (overdue ? 1000 : 0) + lesson.priority + manualBoost - (review.streak || 0) * 10 + (review.last_result === "wrong" ? 120 : 0) - (mastered ? 500 : 0);
    return {
      ...lesson,
      review,
      dueSoon: overdue,
      queueScore: score,
      completed,
      mastered,
      cleanCount,
      completedCount,
      effectiveLineStatus: mastered ? "known" : (completed ? "completed" : lesson.line_status),
    };
  };
  state.queueDue = (state.payload?.profile?.trainer_queue_due || [])
    .map(enrich)
    .filter((lesson) => !lesson.mastered)
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
    .filter((lesson) => !lesson.mastered)
    .sort((a, b) => b.priority - a.priority || b.frequency - a.frequency);
  const learnedArchive = state.lessons
    .map(enrich)
    .filter((lesson) => lesson.mastered && !((state.payload?.profile?.known_line_archive || []).some((item) => item.lesson_id === lesson.lesson_id)))
    .map((lesson) => ({ ...lesson, line_status: "known", training_known: true }));
  state.knownArchive = [...(state.payload?.profile?.known_line_archive || []), ...learnedArchive];
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
    node.className = "stack compact-work-list";
    node.innerHTML = items
      .map((lesson, index) => `
        <button class="queue-card compact-work-card ${lesson.lesson_id === currentLessonId() ? "active" : ""}" type="button" data-lesson-launch="${escapeHtml(lesson.lesson_id)}">
        <div class="queue-card-header">
          <div>
            <div class="queue-title">${escapeHtml(lesson.line_label || lesson.opening_name)}</div>
            <div class="tree-meta">${escapeHtml(lesson.opening_name || "")} -> ${escapeHtml(lesson.best_reply)}</div>
          </div>
          <div class="line-badge ${statusClass(lesson.effectiveLineStatus || lesson.line_status)}">${index === 0 ? "Next" : labelForStatus(lesson.effectiveLineStatus || lesson.line_status)}</div>
        </div>
        <div class="chip-row">
          <span class="lesson-chip">Priority ${Math.round(lesson.priority)}</span>
          <span class="lesson-chip">Frequency ${lesson.frequency}</span>
          <span class="lesson-chip">Memory ${Math.round(Number(lesson.memory_score || 0))}</span>
          <span class="lesson-chip">Streak ${lesson.review.streak || 0}</span>
          ${lesson.completed ? `<span class="lesson-chip known">Completed ${lesson.completedCount}x</span>` : ""}
          ${lesson.mastered ? `<span class="lesson-chip known">Known from training</span>` : ""}
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
  if (!state.freeBranchMode && state.trainingCursor >= line.length) return "completed";
  if (state.freeBranchMode) {
    return isUsersTurn(lesson) ? "decision_point" : "free_autoplay";
  }
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
  return Boolean(lesson)
    && isUsersTurn(lesson)
    && phase !== "intro_autoplay"
    && phase !== "free_autoplay"
    && phase !== "completed";
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
      reaction: null,
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
    reaction: insight?.your_move_reaction || insight?.coach_reaction || null,
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

function applyResolvedMoveClassification(moveUci, classification, expectedFen = "", reaction = null) {
  if (!classification) return;
  const lastMoveUci = state.lastMove ? `${state.lastMove.from}${state.lastMove.to}` : "";
  if (lastMoveUci !== String(moveUci || "").slice(0, 4)) return;
  if (expectedFen && normalizeFen(state.boardFen) !== normalizeFen(expectedFen)) return;
  state.lastMoveClassification = classification;
  state.lastMoveReaction = reaction || state.lastMoveReaction;
  renderBoard(state.boardFen, { animate: false });
  renderStudyWorkspace();
}

function renderAutoMoveSummary(autoMoves = []) {
  if (!autoMoves.length) return "";
  return autoMoves
    .map((entry) => `${escapeHtml(entry.color)} played <strong>${escapeHtml(entry.san)}</strong>${classificationBadge(entry.classification, "inline")}.`)
    .join(" ");
}

function setTrainerFeedback(html, { empty = false } = {}) {
  if (!el.trainerFeedback) return;
  el.trainerFeedback.innerHTML = html || "";
  el.trainerFeedback.classList.toggle("empty", empty || !html);
}

function setTrainerFeedbackText(message, { empty = false } = {}) {
  if (!el.trainerFeedback) return;
  el.trainerFeedback.textContent = message || "";
  el.trainerFeedback.classList.toggle("empty", empty || !message);
}

function compactMoveStatus(moveSan, classification, message = "") {
  const movePart = moveSan ? `<strong>${escapeHtml(moveSan)}</strong>${classificationBadge(classification, "inline")}` : "";
  const textPart = message ? ` ${escapeHtml(message)}` : "";
  return `${movePart}${textPart}`.trim();
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
  if (phase === "free_autoplay") {
    el.trainerDecision.textContent = "Bookup is choosing a practical reply from the live position.";
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
  if (state.freeBranchMode) {
    const liveInsight = currentLiveInsight(lesson);
    const legalPreview = (state.legalMoves || [])
      .slice(0, 8)
      .map((item) => item.san || item.uci)
      .filter(Boolean)
      .join(" | ");
    const practicalMoves = (liveInsight?.database_moves || [])
      .slice(0, 5)
      .map((item) => `${escapeHtml(item.san || item.uci)} ${item.popularity || item.percent || 0}%`)
      .join(" | ");
    el.trainerDecision.classList.remove("empty");
    el.trainerDecision.innerHTML = `
      <div class="trainer-decision-copy">Your move from the live position. Bookup will classify it and keep the board moving.</div>
      <div class="line-note">Legal moves: ${escapeHtml(legalPreview || "loading...")}</div>
      <div class="line-note">Lichess moves: ${practicalMoves || "No explorer move data available."}</div>
    `;
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
  const lineCoachText = String(lesson?.coach_explanation || lesson?.explanation || "").trim();
  const recommendedLabel = recommended.classification?.label || lesson?.recommended_classification?.label || "Best";
  const progress = `${Math.min(state.trainingCursor, line.length)}/${line.length}`;
  const expectedText = state.freeBranchMode
    ? String(liveInsight?.recommended_move || "").trim()
    : (recommended.san || lesson.best_reply || "");
  const reaction = state.lastMoveReaction || liveReactionFromInsight(liveInsight);
  const coachText = String(reaction?.headline || "").trim()
    || (expectedText ? `Current recommendation: ${expectedText}.` : "")
    || (lineCoachText ? "Bookup has cached coaching for this position in the review panel." : "");
  if (phase === "free_autoplay") {
    renderTrainerDecision(lesson);
    el.boardTitle.textContent = "Bookup reply";
    el.boardSummary.textContent = "Bookup is choosing a practical reply from the live board, then it will hand the move back to you.";
    el.trainerCoach.textContent = "The stored line is paused. Bookup is replying from the actual board so the prompt stays synced.";
    el.trainerCoach.classList.remove("empty");
    el.boardLine.textContent = currentPlayedLineSan().join(" ") || "No played line yet.";
    el.boardLine.classList.toggle("empty", !currentPlayedLineSan().length);
    renderStudyWorkspace();
    return;
  }
  if (phase === "decision_point") {
    const atRootDecision = state.trainingCursor === lessonRootCursor(lesson);
    const discoveryPreview = atRootDecision
      ? (lesson.discovery_nodes || [])
        .slice(0, 4)
        .map((item) => `${item.san} ${item.count}x`)
        .join(" | ")
      : "";
    el.boardTitle.textContent = atRootDecision && !state.freeBranchMode ? "What would you play here?" : "Your move here";
    el.boardSummary.textContent = expectedText
      ? `Choose any legal move for your color. Recommended move: ${expectedText}.`
      : "Choose any legal move for your color. Bookup will follow repertoire branches and transpositions when they fit.";
    if (discoveryPreview) {
      el.trainerCoach.textContent = coachText
        ? `Your repeated moves here: ${discoveryPreview}. ${coachText}`
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
    el.trainerCoach.textContent = state.lessonMistakes === 0
      ? "Clean completion saved. This line can move toward Known after enough repeats."
      : "Completion saved with misses. Bookup will keep this line available for review.";
    el.trainerCoach.classList.remove("empty");
    el.boardLine.textContent = currentPlayedLineSan().join(" ") || lessonTrainingLineSan(lesson).join(" ") || lesson.continuation_san || "No line loaded yet.";
    el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
    renderStudyWorkspace();
    return;
  }
  if (phase === "intro_autoplay") {
    el.boardTitle.textContent = "Follow the lead-in";
    el.boardSummary.textContent = `Bookup is stepping through the practical setup. Step ${progress}.`;
    el.trainerCoach.textContent = "Watch the lead-in until the board reaches your next real decision point.";
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
      applyResolvedMoveClassification(expectedUci, moveMeta?.classification || moveMeta?.recommendedClassification || null, appliedFen, moveMeta?.reaction || null);
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

function choosePracticalReplyMove(lesson) {
  const legal = state.legalMoves || [];
  if (!legal.length) return null;
  const insight = currentLiveInsight(lesson);
  const candidateUci = [
    ...(insight?.database_moves || []).map((item) => item?.uci),
    insight?.recommended_move_uci,
    ...(insight?.candidate_lines || []).map((item) => item?.uci),
  ]
    .filter(Boolean)
    .map((uci) => String(uci));
  for (const uci of candidateUci) {
    const match = legal.find((move) => move.uci === uci);
    if (match) return match;
  }
  return legal[0] || null;
}

async function syncFreeBranchToPlayableTurn() {
  const lesson = currentLesson();
  if (!lesson || !state.freeBranchMode) return { autoMoves: [] };
  const runToken = lessonRunToken(lesson);
  const autoMoves = [];
  while (state.freeBranchMode && !isUsersTurn(lesson)) {
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return { autoMoves };
    await updateCurrentInsight();
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return { autoMoves };
    if (!state.legalMoves.length) {
      await refreshLegalMoves(state.boardFen);
      if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return { autoMoves };
    }
    const reply = choosePracticalReplyMove(lesson);
    if (!reply) break;
    const movingColor = moveColorLabel(sideToMove(state.boardFen));
    const preMoveFen = state.boardFen;
    const instantClassification = instantMoveClassification(lesson, reply);
    const moveMetaPromise = classifyMoveAtFen(
      preMoveFen,
      lesson,
      reply.uci,
      reply.san,
      moveRepeatedCount(lesson, reply.uci),
    );
    await applyMoveToBoard(reply.uci, instantClassification);
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return { autoMoves };
    const appliedFen = state.boardFen;
    moveMetaPromise.then((moveMeta) => {
      applyResolvedMoveClassification(reply.uci, moveMeta?.classification || moveMeta?.recommendedClassification || null, appliedFen, moveMeta?.reaction || null);
    });
    appendPlayedMove(reply.uci, state.lastMoveSan || reply.san);
    state.trainingCursor += 1;
    autoMoves.push({
      color: movingColor,
      san: state.lastMoveSan || reply.san,
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

function completeCurrentLesson(lesson, clean, feedbackHtml = "") {
  if (!lesson) return;
  const line = lessonTrainingLine(lesson);
  state.trainingCursor = line.length;
  state.trainerPhase = "completed";
  recordLessonCompletion(lesson.lesson_id, clean);
  rebuildQueue();
  renderQueue();
  renderKnownArchive(state.knownArchive);
  playMoveSound("", { complete: true });
  updateTrainerCopy();
  if (feedbackHtml) {
    el.trainerFeedback.innerHTML = feedbackHtml;
  } else {
    el.trainerFeedback.innerHTML = clean
      ? "Line complete. Clean run saved."
      : "Line complete. Saved as completed with mistakes, so Bookup will keep it available for review.";
  }
  el.trainerFeedback.classList.remove("empty");
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
  state.freeBranchMode = false;
  state.trainerPhase = "intro_autoplay";
  state.selectedSquare = "";
  state.dragFrom = "";
  state.dragPiece = "";
  clearDragState();
  state.lastMove = null;
  state.lastMoveClassification = null;
  state.lastMoveReaction = null;
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
    if (syncTrainerPhase(lesson) === "completed") {
      completeCurrentLesson(lesson, state.lessonMistakes === 0, "Line complete. Bookup reached the final planned position for this line.");
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
  state.lastMoveReaction = null;
  state.lastMoveSan = "";
  state.previousRenderedPieces = {};
  state.activeTrainingLine = [];
  state.activeTrainingLineSan = [];
  state.playedTrainingLine = [];
  state.playedTrainingLineSan = [];
  state.branchLocked = false;
  state.freeBranchMode = false;
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
    el.trainerInsight.innerHTML = renderTrainerInsightMarkup(cached);
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
    el.trainerInsight.innerHTML = renderTrainerInsightMarkup(insight);
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
    el.trainerInsight.innerHTML = state.currentInsight
      ? renderTrainerInsightMarkup(state.currentInsight)
      : "Live arrows are unavailable right now. Blue arrows show top engine moves and red arrows show threats when the current position insight loads.";
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
      state.freeBranchMode = false;
      state.activeTrainingLine = [...(lesson.intro_line_uci || []), ...(chosenBranch.line_uci || [])];
      state.activeTrainingLineSan = combineSanSegments(lesson.intro_line_san, chosenBranch.line_san);
      state.trainerPhase = "locked_line";
      playMoveSound(previewPayload.played_san);
      applyBoardState(previewPayload, { classification: playedClassification || recommendedClassification || null });
      appendPlayedMove(move.uci, previewPayload.played_san || move.san);
      renderBoard(state.boardFen, { animate: true });
      const appliedFen = state.boardFen;
      moveMetaPromise.then((moveMeta) => {
        applyResolvedMoveClassification(move.uci, moveMeta?.classification || null, appliedFen, moveMeta?.reaction || null);
      });
      state.trainingCursor = rootCursor + 1;
      syncTrainerPhase(lesson);
      let branchFeedback = "";
      if (chosenBranch.uci === lesson.preferred_branch_uci) {
        branchFeedback = `Correct. <strong>${escapeHtml(move.san)}</strong>${classificationBadge(playedClassification, "inline")} ${escapeHtml(lesson.explanation)}`;
      } else {
        const sourceLabel = move.uci === chosenBranch.uci
          ? (chosenBranch.source === "repertoire" ? "your repeated repertoire branch" : "a known branch in this position")
          : "a transposition back into your repertoire";
        branchFeedback = `<strong>${escapeHtml(move.san)}</strong>${classificationBadge(playedClassification, "inline")} matches ${escapeHtml(sourceLabel)}. Bookup will follow it, but the preferred move here is <strong>${escapeHtml(recommendedMoveLabel)}</strong>${classificationBadge(recommendedClassification, "inline")}.`;
      }
      const syncResult = await syncTrainerToPlayableTurn();
      if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;
      setTrainerFeedback(`${branchFeedback}${syncResult?.autoMoves?.length ? ` ${renderAutoMoveSummary(syncResult.autoMoves)}` : ""}`);
      updateTrainerCopy();
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
      applyResolvedMoveClassification(move.uci, moveMeta?.classification || null, appliedFen, moveMeta?.reaction || null);
    });
    state.trainingCursor += 1;
    state.branchLocked = false;
    state.freeBranchMode = true;
    syncTrainerPhase(lesson);
    setTrainerFeedback(compactMoveStatus(
      move.san,
      playedClassification,
      isUsersTurn(lesson)
        ? `is now your live branch. You can keep choosing moves from this position.`
        : `left the stored line. Bookup will reply from the actual board instead of forcing the old prompt.`
    ));
    updateTrainerCopy();
    await updateCurrentInsight();
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;
    const freeSyncResult = await syncFreeBranchToPlayableTurn();
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;
    if (freeSyncResult?.autoMoves?.length) {
      setTrainerFeedback(renderAutoMoveSummary(freeSyncResult.autoMoves));
    }
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
  if (!expectedUci) {
    completeCurrentLesson(
      lesson,
      state.lessonMistakes === 0,
      state.lessonMistakes === 0
        ? "Line complete. Clean run saved."
        : "Line complete. Saved with mistakes, so Bookup will keep it in review."
    );
    return;
  }
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
      applyResolvedMoveClassification(move.uci, moveMeta?.classification || null, appliedFen, moveMeta?.reaction || null);
    });
    appendPlayedMove(move.uci, state.lastMoveSan || move.san);
    state.trainingCursor += 1;
    state.branchLocked = false;
    state.freeBranchMode = true;
    syncTrainerPhase(lesson);
    el.boardLine.textContent = currentPlayedLineSan().join(" ") || lessonTrainingLineSan(lesson).join(" ") || lesson.continuation_san || "";
    el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
    updateTrainerCopy();
    await updateCurrentInsight();
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;
    const freeSyncResult = await syncFreeBranchToPlayableTurn();
    if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;
    if (freeSyncResult?.autoMoves?.length) {
      setTrainerFeedback(renderAutoMoveSummary(freeSyncResult.autoMoves));
    }
    return;
  }

  await applyMoveToBoard(move.uci, playedClassification || recommendedClassification || null);
  if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;
  const appliedFen = state.boardFen;
  moveMetaPromise.then((moveMeta) => {
    applyResolvedMoveClassification(move.uci, moveMeta?.classification || null, appliedFen, moveMeta?.reaction || null);
  });
  appendPlayedMove(move.uci, state.lastMoveSan || move.san);
  state.trainingCursor += 1;
  syncTrainerPhase(lesson);
  const syncResult = await syncTrainerToPlayableTurn();
  if (!isLessonRunCurrent(runToken, lesson.lesson_id)) return;

  const successExplanation =
    state.trainingCursor - 1 === (lesson.target_ply_index || 0)
      ? lesson.explanation
      : "That keeps the repertoire line on track.";
  const lineFinished = syncTrainerPhase(lesson) === "completed";
  if (lineFinished) {
    completeCurrentLesson(
      lesson,
      state.lessonMistakes === 0,
      state.lessonMistakes === 0
        ? `Line complete. <strong>${escapeHtml(move.san)}</strong>${classificationBadge(playedClassification || recommendedClassification, "inline")} ${escapeHtml(successExplanation)} Clean run saved.`
        : `Line complete. <strong>${escapeHtml(move.san)}</strong>${classificationBadge(playedClassification || recommendedClassification, "inline")} ${escapeHtml(successExplanation)} Saved with mistakes for review.`
    );
    return;
  }

  setTrainerFeedback(
    `Correct. <strong>${escapeHtml(move.san)}</strong>${classificationBadge(playedClassification || recommendedClassification, "inline")} ${escapeHtml(successExplanation)}${syncResult?.autoMoves?.length ? ` ${renderAutoMoveSummary(syncResult.autoMoves)}` : ""}`
  );
  updateTrainerCopy();
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
    .then((moveInsight) => ({
      classification: moveInsight?.your_move_classification || moveInsight?.played_classification || null,
      reaction: moveInsight?.your_move_reaction || moveInsight?.coach_reaction || null,
    }))
    .catch(() => null);

  try {
    const payload = await applyMoveToBoard(move.uci, playedClassification);
    const appliedFen = state.boardFen;
    classificationPromise.then((moveMeta) => {
      applyResolvedMoveClassification(move.uci, moveMeta?.classification || null, appliedFen, moveMeta?.reaction || null);
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
    completed_count: 0,
    clean_completed_count: 0,
    worked_on_count: 0,
    last_seen_at: 0,
    last_completed_at: 0,
    last_result: "",
    line_state: "",
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

function mergeReviewStats(serverStats = {}, localStats = {}) {
  const merged = { ...(localStats || {}) };
  Object.entries(serverStats || {}).forEach(([lessonId, serverItem]) => {
    const localItem = merged[lessonId] || {};
    const serverCompleted = Number(serverItem?.completed_count || 0);
    const localCompleted = Number(localItem?.completed_count || 0);
    const serverSeen = Number(serverItem?.seen || 0);
    const localSeen = Number(localItem?.seen || 0);
    merged[lessonId] = serverCompleted > localCompleted || serverSeen >= localSeen
      ? { ...localItem, ...serverItem }
      : { ...serverItem, ...localItem };
  });
  return merged;
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
    completed_count: Number(current.completed_count || 0),
    clean_completed_count: Number(current.clean_completed_count || 0),
    worked_on_count: Number(current.worked_on_count || 0) + 1,
    last_seen_at: Date.now(),
    last_completed_at: Number(current.last_completed_at || 0),
    due_at: dueAt,
    last_result: correct ? "right" : "wrong",
    line_state: correct ? (streak >= 3 ? "mastered" : "in_progress") : "needs_review",
  };
  if (state.payload?.username) {
    saveReviewStats(state.payload.username);
    renderMistakeTimeline(state.payload?.profile?.mistake_timeline || null);
    renderReviewSchedule(state.payload?.profile?.review_schedule || null);
    void persistReviewStats(state.payload.username);
  }
}

function recordLessonCompletion(lessonId, clean) {
  const current = state.reviewStats[lessonId] || defaultReviewState();
  const completed = Number(current.completed_count || 0) + 1;
  const cleanCompleted = Number(current.clean_completed_count || 0) + (clean ? 1 : 0);
  const streak = clean ? Math.min(Number(current.streak || 0) + 1, REVIEW_INTERVALS.length - 1) : 0;
  const nextDays = clean ? REVIEW_INTERVALS[streak] : 0;
  const dueAt = Date.now() + nextDays * 24 * 60 * 60 * 1000;
  state.reviewStats[lessonId] = {
    ...current,
    seen: Number(current.seen || 0) + 1,
    streak,
    correct_count: Number(current.correct_count || 0) + (clean ? 1 : 0),
    wrong_count: Number(current.wrong_count || 0),
    completed_count: completed,
    clean_completed_count: cleanCompleted,
    worked_on_count: Number(current.worked_on_count || 0) + 1,
    last_seen_at: Date.now(),
    last_completed_at: Date.now(),
    due_at: dueAt,
    last_result: clean ? "completed_clean" : "completed_with_mistakes",
    line_state: clean && streak >= 3 ? "mastered" : (clean ? "completed" : "completed_with_mistakes"),
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
  const completed = lessons.reduce((sum, item) => sum + Number(item.completed_count || 0), 0);
  const cleanCompleted = lessons.reduce((sum, item) => sum + Number(item.clean_completed_count || 0), 0);
  const mastered = lessons.filter((item) => item.line_state === "mastered" || Number(item.streak || 0) >= 3).length;
  const completedLessons = lessons.filter((item) => Number(item.completed_count || 0) > 0).length;
  return {
    lessons_tracked: lessons.length,
    lessons_completed: completedLessons,
    mastered_lines: mastered,
    attempts_seen: seen,
    correct_attempts: correct,
    wrong_attempts: wrong,
    completed_runs: completed,
    clean_completed_runs: cleanCompleted,
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

function smartTheoryPieceGlyph(piece) {
  const map = {
    P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔",
    p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
  };
  return map[piece] || "";
}

function renderSmartTheoryMiniBoard(fen) {
  if (!el.smartTheoryMiniBoard) return;
  const squares = parseFenBoard(fen || START_FEN);
  if (!Array.isArray(squares) || squares.length !== 64) {
    el.smartTheoryMiniBoard.className = "mini-board-grid empty";
    el.smartTheoryMiniBoard.textContent = "Invalid board.";
    return;
  }
  el.smartTheoryMiniBoard.className = "mini-board-grid";
  el.smartTheoryMiniBoard.innerHTML = squares.map((piece, idx) => {
    const rank = Math.floor(idx / 8);
    const file = idx % 8;
    const light = (rank + file) % 2 === 0 ? "light" : "dark";
    return `<div class="mini-board-square ${light}">${smartTheoryPieceGlyph(piece)}</div>`;
  }).join("");
}

function smartTheoryNodeMeta(node) {
  if (!node) return "No node selected.";
  const open = [node.openingName, node.ecoCode].filter(Boolean).join(" | ");
  return `${node.ply || 0}. ${node.san || "(root)"} · ${node.classification || ""} · Eval ${formatEval(node.evalAfter || 0)}${open ? ` · ${open}` : ""}`;
}

function smartTheoryMovePath(tree, node) {
  if (!tree || !Array.isArray(tree.nodes) || !node) return [];
  const byId = new Map(tree.nodes.map((item) => [String(item.id), item]));
  const path = [];
  let cursor = node;
  let guard = 0;
  while (cursor && String(cursor.id) !== "root" && guard < 300) {
    path.push(cursor);
    cursor = byId.get(String(cursor.parentId || ""));
    guard += 1;
  }
  path.reverse();
  return path;
}

function renderSmartTheoryTree() {
  if (!el.smartTheoryTree) return;
  const tree = state.smartTheoryTree;
  if (!tree || !Array.isArray(tree.nodes) || !tree.nodes.length) {
    el.smartTheoryTree.className = "stack empty";
    el.smartTheoryTree.textContent = "Generated moves will appear here.";
    return;
  }
  const rows = tree.nodes
    .filter((node) => node.id !== "root")
    .sort((a, b) => Number(a.ply || 0) - Number(b.ply || 0))
    .slice(0, 500);
  el.smartTheoryTree.className = "stack";
  el.smartTheoryTree.innerHTML = rows.map((node) => `
    <div class="smart-tree-row" data-smart-node="${escapeHtml(node.id)}">
      <strong>${escapeHtml(`${node.ply}. ${node.san || ""}`)}</strong>
      <div class="tree-meta">${escapeHtml(node.classification || "")} · ${escapeHtml(formatEval(node.evalAfter || 0))} · ${escapeHtml(node.openingName || "")}</div>
      <div class="line-note">${escapeHtml(node.theoryExplanation || "")}</div>
    </div>
  `).join("");
  el.smartTheoryTree.querySelectorAll("[data-smart-node]").forEach((item) => {
    item.addEventListener("click", () => {
      const nodeId = item.getAttribute("data-smart-node") || "";
      selectSmartTheoryNode(nodeId);
    });
  });
}

function selectSmartTheoryNode(nodeId) {
  const tree = state.smartTheoryTree;
  if (!tree || !Array.isArray(tree.nodes)) return;
  const node = tree.nodes.find((it) => String(it.id) === String(nodeId));
  if (!node) return;
  state.smartTheorySelectedNodeId = node.id;
  if (el.smartTheoryCurrentMeta) {
    el.smartTheoryCurrentMeta.className = "stack";
    el.smartTheoryCurrentMeta.textContent = smartTheoryNodeMeta(node);
  }
  if (el.smartTheoryMoveList) {
    const path = smartTheoryMovePath(tree, node);
    if (!path.length) {
      el.smartTheoryMoveList.className = "stack empty";
      el.smartTheoryMoveList.textContent = "Move list will show here.";
    } else {
      el.smartTheoryMoveList.className = "stack";
      el.smartTheoryMoveList.innerHTML = path
        .map((item, idx) => `${idx + 1}. ${escapeHtml(item.san || item.uci || "")} (${escapeHtml(item.classification || "")})`)
        .join("<br>");
    }
  }
  if (el.smartTheoryOpeningMeta) {
    el.smartTheoryOpeningMeta.className = "stack";
    el.smartTheoryOpeningMeta.innerHTML = `
      <div><strong>Opening</strong>: ${escapeHtml(node.openingName || "Unknown")}</div>
      <div><strong>ECO</strong>: ${escapeHtml(node.ecoCode || "N/A")}</div>
      <div><strong>FEN</strong>: <span class="mono-inline">${escapeHtml(node.fen || "")}</span></div>
    `;
  }
  if (el.smartTheoryRecommendation) {
    el.smartTheoryRecommendation.className = "stack";
    el.smartTheoryRecommendation.innerHTML = `
      <div><strong>Best move</strong>: ${escapeHtml(node.bestMoveSan || node.bestMoveUci || "N/A")}</div>
      <div><strong>Eval before</strong>: ${escapeHtml(formatEval(node.evalBefore || 0))}</div>
      <div><strong>Eval after</strong>: ${escapeHtml(formatEval(node.evalAfter || 0))}</div>
      <div><strong>Swing</strong>: ${escapeHtml(formatCp(node.evalSwing || 0))}</div>
      <div><strong>Classification</strong>: ${escapeHtml(node.classification || "")}</div>
    `;
  }
  if (el.smartTheoryOpponentReplies) {
    const dbMoves = Array.isArray(node.databaseMoves) ? node.databaseMoves.slice(0, 6) : [];
    const rows = dbMoves.map((item) => {
      const uci = String(item?.uci || "");
      const san = String(item?.san || item?.move || uci);
      const pop = Number(item?.popularity || item?.percent || 0).toFixed(1);
      const games = Number(item?.games || item?.play_count || item?.game_count || 0);
      return `<div>${escapeHtml(san)} (${escapeHtml(uci)}) · ${pop}% · ${games} games</div>`;
    }).join("");
    el.smartTheoryOpponentReplies.className = "stack";
    el.smartTheoryOpponentReplies.innerHTML = rows || "No database opponent replies for this node.";
  }
  if (el.smartTheoryExplanation) {
    el.smartTheoryExplanation.className = "stack";
    el.smartTheoryExplanation.innerHTML = `
      <div><strong>Theory</strong>: ${escapeHtml(node.theoryExplanation || "No explanation available.")}</div>
      <div><strong>Plan</strong>: ${escapeHtml(node.planForUser || "")}</div>
      <div><strong>Opponent idea</strong>: ${escapeHtml(node.opponentIdea || "")}</div>
      <div><strong>Best response</strong>: ${escapeHtml(node.bestMoveSan || node.bestMoveUci || "")}</div>
    `;
  }
  renderSmartTheoryMiniBoard(node.fen || START_FEN);
}

function clearSmartTheoryState() {
  if (state.smartTheoryPollTimer) {
    window.clearTimeout(state.smartTheoryPollTimer);
    state.smartTheoryPollTimer = 0;
  }
  state.smartTheoryJobId = "";
  state.smartTheoryTree = null;
  state.smartTheorySelectedNodeId = "";
  if (el.smartTheoryStatus) el.smartTheoryStatus.textContent = "Idle";
  if (el.smartTheoryProgress) el.smartTheoryProgress.textContent = "No generation in progress.";
  if (el.smartTheoryCurrentMeta) { el.smartTheoryCurrentMeta.className = "stack empty"; el.smartTheoryCurrentMeta.textContent = "No node selected."; }
  if (el.smartTheoryMoveList) { el.smartTheoryMoveList.className = "stack empty"; el.smartTheoryMoveList.textContent = "Move list will show here."; }
  if (el.smartTheoryOpeningMeta) { el.smartTheoryOpeningMeta.className = "stack empty"; el.smartTheoryOpeningMeta.textContent = "Opening name, ECO, and current FEN will show here."; }
  if (el.smartTheoryRecommendation) { el.smartTheoryRecommendation.className = "stack empty"; el.smartTheoryRecommendation.textContent = "Best response and continuation will show here."; }
  if (el.smartTheoryOpponentReplies) { el.smartTheoryOpponentReplies.className = "stack empty"; el.smartTheoryOpponentReplies.textContent = "Opponent candidate replies will show here."; }
  if (el.smartTheoryExplanation) { el.smartTheoryExplanation.className = "stack empty"; el.smartTheoryExplanation.textContent = "Click a generated move to see the explanation."; }
  if (el.smartTheoryTree) { el.smartTheoryTree.className = "stack empty"; el.smartTheoryTree.textContent = "Generated moves will appear here."; }
  renderSmartTheoryMiniBoard(START_FEN);
}

function smartTheoryStateLabel(status) {
  const value = String(status || "").toLowerCase();
  if (value === "analyzing") return "Analyzing position";
  if (value === "generating") return "Generating";
  if (value === "stopping") return "Stopping";
  if (value === "complete") return "Complete";
  if (value === "error") return "Error";
  if (value === "stopped") return "Stopped";
  return "Idle";
}

function setSmartTheoryStatus(status, message = "", done = 0, total = 0) {
  if (el.smartTheoryStatus) {
    el.smartTheoryStatus.textContent = smartTheoryStateLabel(status);
  }
  if (el.smartTheoryProgress) {
    if (String(status).toLowerCase() === "analyzing") {
      const safeTotal = Number(total || 0);
      const safeDone = Number(done || 0);
      el.smartTheoryProgress.textContent = `Analyzing position ${safeDone}${safeTotal ? ` of ${safeTotal}` : ""}.`;
      return;
    }
    if (message) {
      el.smartTheoryProgress.textContent = String(message);
      return;
    }
    if (String(status).toLowerCase() === "idle") {
      el.smartTheoryProgress.textContent = "No generation in progress.";
      return;
    }
    el.smartTheoryProgress.textContent = `${smartTheoryStateLabel(status)}.`;
  }
}

function scheduleSmartTheoryPoll(delayMs = 600) {
  if (!state.smartTheoryJobId) return;
  if (state.smartTheoryPollTimer) window.clearTimeout(state.smartTheoryPollTimer);
  state.smartTheoryPollTimer = window.setTimeout(() => {
    void pollSmartTheoryJob();
  }, delayMs);
}

async function pollSmartTheoryJob() {
  // Poll status frequently for lightweight progress updates; fetch the full
  // tree payload only once the backend marks the job complete/stopped.
  if (!state.smartTheoryJobId) return;
  try {
    const statusResponse = await fetch(`/api/smart-theory-status/${encodeURIComponent(state.smartTheoryJobId)}`);
    const statusPayload = await statusResponse.json();
    if (!statusResponse.ok) throw new Error(statusPayload.error || "Could not read smart theory status.");
    const status = String(statusPayload.status || "").toLowerCase();
    setSmartTheoryStatus(status, statusPayload.message || "", statusPayload.positions_done || 0, statusPayload.positions_total || 0);
    if (status === "complete" || status === "stopped") {
      const resultResponse = await fetch(`/api/smart-theory-result/${encodeURIComponent(state.smartTheoryJobId)}`);
      const resultPayload = await resultResponse.json();
      if (resultResponse.status === 202) {
        scheduleSmartTheoryPoll(350);
        return;
      }
      if (!resultResponse.ok) throw new Error(resultPayload.error || "Could not fetch smart theory result.");
      state.smartTheoryTree = resultPayload;
      renderSmartTheoryTree();
      const firstNodeId = resultPayload?.nodes?.find?.((node) => node.id !== "root")?.id || "root";
      selectSmartTheoryNode(firstNodeId);
      const warnCount = Array.isArray(resultPayload?.warnings) ? resultPayload.warnings.length : 0;
      if (el.smartTheoryProgress) {
        el.smartTheoryProgress.textContent = `Analyzed ${Number(resultPayload.positions_done || 0)} of ${Number(resultPayload.positions_total || 0)} positions.${warnCount ? ` Warnings: ${warnCount}.` : ""}`;
      }
      if (state.smartTheoryPollTimer) {
        window.clearTimeout(state.smartTheoryPollTimer);
        state.smartTheoryPollTimer = 0;
      }
      return;
    }
    if (status === "error") {
      if (state.smartTheoryPollTimer) {
        window.clearTimeout(state.smartTheoryPollTimer);
        state.smartTheoryPollTimer = 0;
      }
      return;
    }
    scheduleSmartTheoryPoll(500);
  } catch (error) {
    setSmartTheoryStatus("error", String(error?.message || "Smart theory polling failed."));
    if (state.smartTheoryPollTimer) {
      window.clearTimeout(state.smartTheoryPollTimer);
      state.smartTheoryPollTimer = 0;
    }
  }
}

async function runSmartTheoryGeneration() {
  if (state.smartTheoryPollTimer) {
    window.clearTimeout(state.smartTheoryPollTimer);
    state.smartTheoryPollTimer = 0;
  }
  setSmartTheoryStatus("generating", "Starting Smart Theory generation...");
  const jobId = `smart-${Date.now()}`;
  state.smartTheoryJobId = jobId;
  const fenInput = String(el.smartTheoryCustomFen?.value || "").trim();
  const startSource = String(el.smartTheoryStartingSource?.value || "current_board");
  let startFen = normalizeFen(state.boardFen || START_FEN);
  let startPlayUci = [];
  if (startSource === "starting_position") startFen = START_FEN;
  if (startSource === "custom_fen" && fenInput) startFen = fenInput;
  if (startSource === "saved_line" || startSource === "selected_move" || startSource === "imported_pgn") {
    const lesson = currentLesson();
    if (lesson?.position_fen) startFen = normalizeFen(lesson.position_fen);
    if (Array.isArray(lesson?.continuation_moves_uci) && lesson.continuation_moves_uci.length) {
      startPlayUci = lesson.continuation_moves_uci.slice(0, 24);
    }
  }
  const referenceUserMoveUci = (() => {
    const lesson = currentLesson();
    if (!lesson) return "";
    return String(
      lesson.your_top_move_uci
      || lesson.preferred_branch_uci
      || lesson.best_reply_uci
      || ""
    ).trim();
  })();
  const payload = {
    job_id: jobId,
    fen: startFen,
    starting_source: startSource,
    start_play_uci: startPlayUci,
    reference_user_move_uci: referenceUserMoveUci,
    my_color: String(el.smartTheoryMyColor?.value || "white"),
    opponent_accuracy: String(el.smartTheoryOpponentAccuracy?.value || "mixed"),
    depth: Number(el.smartTheoryDepth?.value || defaults.depth || 18),
    engine_movetime_sec: Number(el.smartTheoryMoveTime?.value || defaults.think_time_sec || 1.2),
    opponent_replies: Number(el.smartTheoryReplies?.value || 3),
    max_ply: Number(el.smartTheoryMaxPly?.value || 20),
    max_positions: Number(el.smartTheoryMaxPositions?.value || 300),
    include_rare_sidelines: Boolean(el.smartTheoryIncludeRare?.checked),
    include_opponent_mistakes: Boolean(el.smartTheoryIncludeMistakes?.checked),
    include_opponent_blunders: Boolean(el.smartTheoryIncludeBlunders?.checked),
    avoid_absurd_moves: Boolean(el.smartTheoryAvoidAbsurd?.checked),
    eco_only_mode: Boolean(el.smartTheoryEcoOnly?.checked),
    cache_evaluations: Boolean(el.smartTheoryCacheEvals?.checked),
  };
  try {
    const response = await fetch("/api/generate-smart-theory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not generate smart theory.");
    state.smartTheoryJobId = String(data.job_id || jobId);
    setSmartTheoryStatus(data.status || "generating", data.message || "Generating...");
    scheduleSmartTheoryPoll(250);
  } catch (error) {
    setSmartTheoryStatus("error", String(error.message || "Smart theory generation failed."));
  }
}

async function stopSmartTheoryGeneration() {
  if (!state.smartTheoryJobId) return;
  setSmartTheoryStatus("stopping", "Stopping generation...");
  try {
    await fetch("/api/stop-smart-theory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: state.smartTheoryJobId }),
    });
    scheduleSmartTheoryPoll(250);
  } catch (_error) {
    setSmartTheoryStatus("error", "Stop request failed.");
  }
}

function exportSmartTheoryJson() {
  if (!state.smartTheoryTree) return;
  const blob = new Blob([JSON.stringify(state.smartTheoryTree, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `bookup-smart-theory-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function importSmartTheoryJson(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.nodes)) throw new Error("Invalid smart theory JSON.");
    state.smartTheoryTree = parsed;
    renderSmartTheoryTree();
    selectSmartTheoryNode("root");
    if (el.smartTheoryStatus) el.smartTheoryStatus.textContent = "Imported";
    if (el.smartTheoryProgress) el.smartTheoryProgress.textContent = `Loaded ${parsed.nodes.length} nodes from JSON.`;
  } catch (error) {
    if (el.smartTheoryStatus) el.smartTheoryStatus.textContent = "Import error";
    if (el.smartTheoryProgress) el.smartTheoryProgress.textContent = String(error.message || "Could not import JSON.");
  } finally {
    if (el.smartTheoryImport) el.smartTheoryImport.value = "";
  }
}

async function saveSmartTheoryCorrection() {
  const tree = state.smartTheoryTree;
  if (!tree || !Array.isArray(tree.nodes) || !state.smartTheorySelectedNodeId) return;
  const node = tree.nodes.find((item) => String(item.id) === String(state.smartTheorySelectedNodeId));
  if (!node) return;
  const correctedMove = String(node.correctedMove || node.bestMoveUci || "").trim();
  if (!correctedMove) {
    if (el.smartTheoryProgress) el.smartTheoryProgress.textContent = "No corrected move available on this node.";
    return;
  }
  const positionKey = String(node.normalizedFen || node.fen || node.id);
  state.manualRepertoire[positionKey] = {
    lesson_id: `smart:${node.id}`,
    move_uci: correctedMove,
    move_san: String(node.bestMoveSan || correctedMove),
    line_label: String(node.openingName || "Smart theory line"),
    saved_at: new Date().toISOString(),
  };
  if (state.payload?.username) {
    saveReviewStats(state.payload.username);
    await persistReviewStats(state.payload.username);
  }
  if (el.smartTheoryProgress) el.smartTheoryProgress.textContent = `Saved corrected move ${correctedMove} for this position.`;
}

init();


