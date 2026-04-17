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
  enginePath: document.getElementById("enginePathInput"),
  depth: document.getElementById("depthInput"),
  threads: document.getElementById("threadsInput"),
  hash: document.getElementById("hashInput"),
  analyze: document.getElementById("analyzeBtn"),
  status: document.getElementById("status"),
  heroTitle: document.getElementById("heroTitle"),
  heroSummary: document.getElementById("heroSummary"),
  styleMetrics: document.getElementById("styleMetrics"),
  styleSummary: document.getElementById("styleSummary"),
  openingList: document.getElementById("openingList"),
  improvementList: document.getElementById("improvementList"),
  adviceList: document.getElementById("adviceList"),
  board: document.getElementById("board"),
  rankLabels: document.getElementById("rankLabels"),
  fileLabels: document.getElementById("fileLabels"),
  boardTitle: document.getElementById("boardTitle"),
  boardSummary: document.getElementById("boardSummary"),
  boardLine: document.getElementById("boardLine"),
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
  renderCoords();
  renderBoard("startpos");
}

async function runAnalysis() {
  setStatus("Importing games and building profile...");
  el.analyze.disabled = true;
  try {
    const response = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: el.username.value.trim(),
        time_classes: el.timeClasses.value.trim(),
        max_games: Number(el.maxGames.value),
        engine_path: el.enginePath.value.trim(),
        depth: Number(el.depth.value),
        threads: Number(el.threads.value),
        hash_mb: Number(el.hash.value),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Profile build failed.");
    }
    renderProfile(payload);
    setStatus(`Analyzed ${payload.profile.games_analyzed} games for ${payload.username}.`);
  } catch (error) {
    setStatus(error.message || "Profile build failed.");
  } finally {
    el.analyze.disabled = false;
  }
}

function renderProfile(payload) {
  const profile = payload.profile;
  el.heroTitle.textContent = `${payload.username}'s profile`;
  el.heroSummary.textContent = `Imported ${payload.games_imported} games across ${payload.archives_found} archive months for ${payload.time_classes.join(", ")}. Focused on recurring openings, where you lose the most value, and what the engine wants in your most common positions.`;

  const metrics = [
    ["Castle rate", `${profile.style_metrics.castle_rate}%`],
    ["Early queen rate", `${profile.style_metrics.early_queen_rate}%`],
    ["Capture rate", `${profile.style_metrics.capture_rate}%`],
    ["Checks / game", `${profile.style_metrics.checks_per_game}`],
  ];
  el.styleMetrics.innerHTML = metrics.map(([label, value]) => `
    <div class="metric">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
    </div>
  `).join("");
  el.styleSummary.textContent = profile.style_summary;

  renderOpenings(profile.top_openings || []);
  renderImprovements(profile.improvements || []);
  renderAdvice(profile.opening_advice || []);
}

function renderOpenings(openings) {
  if (!openings.length) {
    el.openingList.className = "stack empty";
    el.openingList.textContent = "No opening profile yet.";
    return;
  }
  el.openingList.className = "stack";
  el.openingList.innerHTML = openings.map((item) => `
    <div class="item">
      <div class="item-title">${item.opening}</div>
      <div class="item-sub">You reached this as ${item.color} in ${item.count} games.</div>
    </div>
  `).join("");
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
        renderBoard(item.example.position_fen);
        el.boardTitle.textContent = item.headline;
        el.boardSummary.textContent = item.detail || "Engine improvement example.";
        el.boardLine.textContent = item.example.line || `${item.example.played} -> ${item.example.best}`;
        el.boardLine.classList.remove("empty");
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
        renderBoard(item.position_fen);
        el.boardTitle.textContent = item.opening;
        el.boardSummary.textContent = item.explanation;
        el.boardLine.textContent = item.example_line || item.recommendation;
        el.boardLine.classList.remove("empty");
      }
    });
  });
}

function renderCoords() {
  el.rankLabels.innerHTML = ranks.map((r) => `<span>${r}</span>`).join("");
  el.fileLabels.innerHTML = files.map((f) => `<span>${f}</span>`).join("");
}

function renderBoard(fen) {
  const squares = parseFenBoard(fen);
  el.board.innerHTML = "";
  squares.forEach((piece, index) => {
    const square = document.createElement("div");
    const file = index % 8;
    const rank = Math.floor(index / 8);
    square.className = `square ${(file + rank) % 2 === 0 ? "light" : "dark"}`;
    if (piece) {
      const img = document.createElement("img");
      img.className = "piece";
      img.src = PIECE_ASSETS[piece];
      img.alt = piece;
      square.appendChild(img);
    }
    el.board.appendChild(square);
  });
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

function setStatus(message) {
  el.status.textContent = message;
}

init();
