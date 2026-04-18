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

const el = {
  username: document.getElementById("usernameInput"),
  timeClasses: document.getElementById("timeClassesInput"),
  maxGames: document.getElementById("maxGamesInput"),
  importAllGames: document.getElementById("importAllGamesInput"),
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
  firstMoveLead: document.getElementById("firstMoveLead"),
  firstMoveList: document.getElementById("firstMoveList"),
  openingListWhite: document.getElementById("openingListWhite"),
  openingListBlack: document.getElementById("openingListBlack"),
  prepList: document.getElementById("prepList"),
  tabButtons: Array.from(document.querySelectorAll("[data-tab-target]")),
  tabPanels: Array.from(document.querySelectorAll("[data-tab-panel]")),
  lessonList: document.getElementById("lessonList"),
  board: document.getElementById("board"),
  rankLabels: document.getElementById("rankLabels"),
  fileLabels: document.getElementById("fileLabels"),
  boardTitle: document.getElementById("boardTitle"),
  boardSummary: document.getElementById("boardSummary"),
  boardLine: document.getElementById("boardLine"),
  trainerFeedback: document.getElementById("trainerFeedback"),
  trainerReset: document.getElementById("trainerResetBtn"),
  trainerNext: document.getElementById("trainerNextBtn"),
};

const state = {
  payload: null,
  lessons: [],
  lessonIndex: -1,
  boardFen: "startpos",
  startFen: "startpos",
  legalMoves: [],
  legalByFrom: {},
  selectedSquare: "",
  dragFrom: "",
  lastMove: null,
};

function init() {
  el.username.value = defaults.username || "trixize1234";
  el.timeClasses.value = defaults.time_classes || "all";
  el.maxGames.value = defaults.max_games ?? 0;
  el.importAllGames.checked = Number(defaults.max_games ?? 0) === 0;
  el.enginePath.value = defaults.engine_path || "";
  el.depth.value = defaults.depth || 13;
  el.threads.value = defaults.threads || 8;
  el.hash.value = defaults.hash_mb || 2048;
  el.analyze.addEventListener("click", runAnalysis);
  el.importAllGames?.addEventListener("change", syncImportScope);
  el.tabButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tabTarget || "overview"));
  });
  el.trainerReset?.addEventListener("click", resetTrainerLesson);
  el.trainerNext?.addEventListener("click", nextLesson);
  syncImportScope();
  setActiveTab("overview");
  renderCoords();
  renderBoard("startpos");
}

function syncImportScope() {
  if (!el.importAllGames || !el.maxGames) return;
  if (el.importAllGames.checked) {
    el.maxGames.value = 0;
    el.maxGames.setAttribute("disabled", "disabled");
  } else {
    el.maxGames.removeAttribute("disabled");
    if (Number(el.maxGames.value) === 0) {
      el.maxGames.value = 200;
    }
  }
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
    renderProfile(payload);
    setStatus(
      `Imported ${payload.games_imported} games from ${payload.archives_found} archive months. Repertoire tree is ready.`
    );
  } catch (error) {
    setStatus(error.message || "Prep build failed.");
  } finally {
    el.analyze.disabled = false;
  }
}

async function fetchProfilePayload(username) {
  const response = await fetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildProfileRequest(username)),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Prep build failed.");
  return payload;
}

function buildProfileRequest(username) {
  return {
    username,
    time_classes: el.timeClasses.value.trim(),
    max_games: el.importAllGames?.checked ? 0 : Number(el.maxGames.value),
    engine_path: el.enginePath.value.trim(),
    depth: Number(el.depth.value),
    threads: Number(el.threads.value),
    hash_mb: Number(el.hash.value),
  };
}

function renderProfile(payload) {
  const profile = payload.profile || {};
  const topWhite = profile.top_openings_by_color?.white?.[0];
  const topBlack = profile.top_openings_by_color?.black?.[0];
  const lessons = flattenLessons(profile.prep_repertoire || []);

  state.lessons = lessons;
  state.lessonIndex = lessons.length ? 0 : -1;

  el.heroTitle.textContent = `${payload.username} repertoire prep`;
  el.heroSummary.textContent =
    "Bookup turns the openings this player actually repeats into a trainable prep tree: named variations, practical counters, and board drills for the positions that matter.";
  el.badgeWinRate.textContent = `${payload.games_imported || 0}`;
  el.badgeChaos.textContent = topWhite?.opening || "--";
  el.badgeColor.textContent = topBlack?.opening || `${lessons.length} lessons`;

  renderFirstMove(profile.first_move_repertoire || {});
  renderOpenings(profile.top_openings_by_color || {});
  renderPrepCards(profile.prep_repertoire || []);
  renderLessonList();

  if (state.lessonIndex >= 0) {
    loadLesson(state.lessonIndex);
  } else {
    clearTrainer();
  }
}

function flattenLessons(items) {
  return items.flatMap((item) =>
    (item.lessons || []).map((lesson, index) => ({
      ...lesson,
      opening: item.opening,
      opening_code: item.opening_code,
      color: item.color,
      parent_index: index,
      sample_line: item.sample_line,
    }))
  );
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
    <div class="first-move-title">${escapeHtml(top.move)}</div>
    <div class="first-move-meta">${top.pct}% · ${top.count}x</div>
    <div class="first-move-scale">
      <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
    </div>
    <div class="bar-track"><div class="bar-fill" style="width:${top.pct}%"></div></div>
  `;
  el.firstMoveList.className = "stack";
  el.firstMoveList.innerHTML = (data.items || [])
    .map(
      (item, index) => `
        <div class="item">
          <div class="item-title">${index + 1}. ${escapeHtml(item.move)}</div>
          <div class="item-sub">${item.pct}% · ${item.count} games</div>
          <div class="bar-track"><div class="bar-fill" style="width:${item.pct}%"></div></div>
        </div>
      `
    )
    .join("");
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
  node.innerHTML = items
    .map(
      (item, index) => `
        <div class="item">
          <div class="item-title">${index + 1}. ${escapeHtml(item.opening)}</div>
          <div class="item-sub">${item.count}x · ${item.win_rate}% win rate${item.opening_code ? ` · ${escapeHtml(item.opening_code)}` : ""}</div>
          ${
            item.position_identifier
              ? `<div class="item-note"><a href="${item.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.position_identifier_label || "Lichess analysis")}</a></div>`
              : ""
          }
          <div class="record-line">
            <span class="record-win">${item.record.wins}W</span>
            <span class="record-draw">${item.record.draws}D</span>
            <span class="record-loss">${item.record.losses}L</span>
          </div>
        </div>
      `
    )
    .join("");
}

function renderPrepCards(items) {
  if (!items.length) {
    el.prepList.className = "stack empty";
    el.prepList.textContent = "No prep lines yet.";
    return;
  }

  el.prepList.className = "stack";
  el.prepList.innerHTML = items
    .map((item) => {
      const lessons = item.lessons || [];
      const linePreview = item.sample_line || buildLinePreview(item.steps || []);
      return `
        <article class="item prep-item">
          <div class="item-title">${escapeHtml(item.opening)}${item.opening_code ? ` <span class="prep-code">${escapeHtml(item.opening_code)}</span>` : ""}</div>
          <div class="item-sub">They play this as ${escapeHtml(item.color)}. Use these lesson branches to prepare the best continuation against what they actually repeat.</div>
          ${
            item.position_identifier
              ? `<div class="item-note"><a href="${item.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.position_identifier_label || "Lichess analysis")}</a></div>`
              : ""
          }
          ${linePreview ? `<div class="prep-line-preview">${escapeHtml(linePreview)}</div>` : ""}
          <div class="prep-lesson-stack">
            ${lessons
              .map(
                (lesson) => `
                  <div class="prep-lesson ${lesson.lesson_type === "repeat" ? "repeat" : "fix"}">
                    <div class="prep-lesson-head">
                      <span class="prep-ply">${lesson.ply}${lesson.ply % 2 === 0 ? "..." : "."}</span>
                      <span class="prep-trigger">After ${escapeHtml(lesson.trigger_move)}</span>
                    </div>
                    <div class="prep-best">${lesson.lesson_type === "repeat" ? "You already know" : "Best continuation"} <strong>${escapeHtml(lesson.best_reply)}</strong></div>
                    <div class="prep-meta">${escapeHtml(lesson.explanation)}</div>
                    ${
                      lesson.your_played
                        ? `<div class="prep-meta">Your sample move: <strong>${escapeHtml(lesson.your_played)}</strong>${lesson.repeated_count ? ` · repeated ${lesson.repeated_count}x` : ""}</div>`
                        : ""
                    }
                    <div class="item-note">Engine line: ${escapeHtml(lesson.continuation)}</div>
                  </div>
                `
              )
              .join("")}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderLessonList() {
  if (!state.lessons.length) {
    el.lessonList.className = "stack empty";
    el.lessonList.textContent = "No training lessons yet.";
    return;
  }

  el.lessonList.className = "stack";
  el.lessonList.innerHTML = state.lessons
    .map(
      (lesson, index) => `
        <button class="item clickable lesson-item ${index === state.lessonIndex ? "active" : ""}" type="button" data-lesson-index="${index}">
          <div class="item-title">${escapeHtml(lesson.opening)}</div>
          <div class="item-sub">After ${escapeHtml(lesson.trigger_move)}, play ${escapeHtml(lesson.best_reply)}</div>
          <div class="coach-item-meta">${lesson.lesson_type === "repeat" ? "Known line" : "Needs prep"} · ${escapeHtml(lesson.color)} repertoire</div>
        </button>
      `
    )
    .join("");

  el.lessonList.querySelectorAll("[data-lesson-index]").forEach((node) => {
    node.addEventListener("click", () => loadLesson(Number(node.dataset.lessonIndex)));
  });
}

async function loadLesson(index) {
  const lesson = state.lessons[index];
  if (!lesson) return;

  state.lessonIndex = index;
  state.startFen = lesson.position_fen;
  state.boardFen = lesson.position_fen;
  state.selectedSquare = "";
  state.lastMove = null;

  el.boardTitle.textContent = `${lesson.opening}${lesson.opening_code ? ` · ${lesson.opening_code}` : ""}`;
  el.boardSummary.textContent = `They reach this branch as ${lesson.color}. After ${lesson.trigger_move}, the move you need is ${lesson.best_reply}.`;
  el.boardLine.textContent = lesson.continuation || "No engine line yet.";
  el.boardLine.classList.remove("empty");
  el.trainerFeedback.textContent =
    lesson.lesson_type === "repeat"
      ? "You already play the engine move here. Use this drill to keep the line sharp."
      : `Your target in this position is ${lesson.best_reply}.`;
  el.trainerFeedback.classList.remove("empty");

  await refreshLegalMoves(lesson.position_fen);
  renderBoard(lesson.position_fen);
  renderLessonList();
  setActiveTab("trainer");
}

function clearTrainer() {
  el.boardTitle.textContent = "No lesson loaded";
  el.boardSummary.textContent = "Build a prep report, then choose a lesson to train.";
  el.boardLine.textContent = "No line loaded yet.";
  el.boardLine.classList.add("empty");
  el.trainerFeedback.textContent = "Choose a lesson from the list to start training.";
  el.trainerFeedback.classList.remove("empty");
  state.boardFen = "startpos";
  state.startFen = "startpos";
  state.legalMoves = [];
  state.legalByFrom = {};
  state.selectedSquare = "";
  state.lastMove = null;
  renderBoard("startpos");
}

function nextLesson() {
  if (!state.lessons.length) return;
  const next = (state.lessonIndex + 1) % state.lessons.length;
  loadLesson(next);
}

function resetTrainerLesson() {
  if (state.lessonIndex < 0) return;
  loadLesson(state.lessonIndex);
}

function renderCoords() {
  if (!el.rankLabels || !el.fileLabels) return;
  el.rankLabels.innerHTML = ranks.map((rank) => `<span>${rank}</span>`).join("");
  el.fileLabels.innerHTML = files.map((file) => `<span>${file}</span>`).join("");
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
  state.legalByFrom = {};
  state.legalMoves.forEach((move) => {
    if (!state.legalByFrom[move.from]) state.legalByFrom[move.from] = [];
    state.legalByFrom[move.from].push(move);
  });
}

function renderBoard(fen) {
  if (!el.board) return;
  state.boardFen = fen || state.boardFen;
  const squares = parseFenBoard(state.boardFen);
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

    const legalTargets = state.selectedSquare ? state.legalByFrom[state.selectedSquare] || [] : [];
    const targetMove = legalTargets.find((item) => item.to === squareName);
    if (targetMove) {
      square.classList.add(targetMove.capture ? "legal-capture" : "legal-target");
      const dot = document.createElement("div");
      dot.className = "move-dot";
      square.appendChild(dot);
    }

    square.addEventListener("click", () => handleSquareClick(squareName));
    square.addEventListener("pointerup", async () => {
      if (!state.dragFrom) return;
      const from = state.dragFrom;
      state.dragFrom = "";
      await submitTrainerMove(from, squareName);
    });

    if (piece) {
      const img = document.createElement("img");
      img.className = "piece";
      img.src = PIECE_ASSETS[piece];
      img.alt = piece;
      img.addEventListener("pointerdown", () => {
        if (pieceSide(piece) !== sideToMove(state.boardFen)) return;
        state.dragFrom = squareName;
        state.selectedSquare = squareName;
        renderBoard(state.boardFen);
      });
      square.appendChild(img);
    }

    el.board.appendChild(square);
  });
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

  const lesson = state.lessons[state.lessonIndex];
  if (!lesson) return;

  const response = await fetch("/api/trainer-attempt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fen: state.boardFen,
      move_uci: move.uci,
      lesson,
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    el.trainerFeedback.textContent = payload.error || "Could not validate move.";
    el.trainerFeedback.classList.remove("empty");
    return;
  }

  if (!payload.ok) {
    el.trainerFeedback.textContent = `${payload.played_san} is not the prep move here. ${payload.explanation} Best move: ${payload.best_san}.`;
    el.trainerFeedback.classList.remove("empty");
    el.boardLine.textContent = payload.continuation || lesson.continuation || "";
    el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
    state.lastMove = null;
    return;
  }

  state.boardFen = payload.fen;
  state.lastMove = payload.last_move || null;
  el.trainerFeedback.textContent = `Correct. ${payload.explanation}`;
  el.trainerFeedback.classList.remove("empty");
  el.boardLine.textContent = payload.line || lesson.continuation || "";
  el.boardLine.classList.toggle("empty", !el.boardLine.textContent);
  state.selectedSquare = "";
  state.legalMoves = payload.legal_moves || [];
  state.legalByFrom = {};
  state.legalMoves.forEach((legalMove) => {
    if (!state.legalByFrom[legalMove.from]) state.legalByFrom[legalMove.from] = [];
    state.legalByFrom[legalMove.from].push(legalMove);
  });
  renderBoard(state.boardFen);
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

function buildLinePreview(steps) {
  return steps
    .map((step) => {
      if (step.kind === "user") return step.san || "";
      if (step.kind === "opponent") return step.played || "";
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function pieceSide(piece) {
  return piece === piece.toUpperCase() ? "w" : "b";
}

function sideToMove(fen) {
  const parts = String(fen || "").split(" ");
  return parts[1] === "b" ? "b" : "w";
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
