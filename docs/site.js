const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const boardSize = 8;

// Legal study position after:
// 1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3 Bg7 5. Be2 O-O
const basePosition = {
  a8: "bR", b8: "bN", c8: "bB", d8: "bQ", f8: "bR", g8: "bK",
  a7: "bP", b7: "bP", c7: "bP", e7: "bP", f7: "bP", g7: "bB", h7: "bP",
  d6: "bP", f6: "bN", g6: "bP",
  d4: "wP", e4: "wP",
  c3: "wN", f3: "wN",
  a2: "wP", b2: "wP", c2: "wP", e2: "wB", f2: "wP", g2: "wP", h2: "wP",
  a1: "wR", c1: "wB", d1: "wQ", e1: "wK", h1: "wR",
};

const demoStates = {
  book: {
    from: "c1",
    to: "e3",
    move: "Be3",
    icon: "book",
    eval: "+0.56",
    fill: "56%",
    prompt: "Be3 is legal here, stays inside the imported repertoire, and is the top checked candidate.",
    review: "Be3 is Book because it is part of the imported branch before engine coaching takes over.",
    bookState: "Book mode is active. Be3 is trusted because it is in your imported repertoire before engine coaching takes over.",
    replies: ["...e5 41%", "...c6 23%", "...a6 18%"],
    lines: [
      { eval: "+0.56", move: "Be3", label: "Book", icon: "book", text: "Be3 e5 dxe5 dxe5 Nxe5 Nxe4" },
      { eval: "+0.54", move: "Bg5", label: "Excellent", icon: "excellent", text: "Bg5 c6 a4 Nbd7 O-O e5" },
      { eval: "+0.53", move: "O-O", label: "Excellent", icon: "excellent", text: "O-O e5 dxe5 dxe5 Qxd8 Rxd8" },
    ],
  },
  castle: {
    from: "e1",
    to: "g1",
    move: "O-O",
    icon: "excellent",
    eval: "+0.53",
    fill: "55%",
    prompt: "O-O is legal because the bishop has already moved from f1. It keeps the position close to the top line.",
    review: "O-O is Excellent here: legal, safe, and nearly tied with the top candidate.",
    bookState: "This branch is still inside your repertoire, but Bookup marks it Excellent because it is being compared as an engine candidate.",
    replies: ["...e5 38%", "...c6 22%", "...Nbd7 15%"],
    lines: [
      { eval: "+0.53", move: "O-O", label: "Excellent", icon: "excellent", text: "O-O e5 dxe5 dxe5 Qxd8 Rxd8" },
      { eval: "+0.56", move: "Be3", label: "Book", icon: "book", text: "Be3 e5 dxe5 dxe5" },
      { eval: "+0.54", move: "Bg5", label: "Excellent", icon: "excellent", text: "Bg5 c6 a4 Nbd7" },
    ],
  },
  bg5: {
    from: "c1",
    to: "g5",
    move: "Bg5",
    icon: "excellent",
    eval: "+0.54",
    fill: "54%",
    prompt: "Bg5 is a legal developing move from c1 to g5 and stays in the same practical setup.",
    review: "Bg5 is Excellent because it is very close to the top engine line in this validated position.",
    bookState: "Bookup would keep following Bg5 if your imported games repeatedly transpose here; otherwise it becomes an engine-coached branch.",
    replies: ["...c6 45%", "...Nbd7 29%", "...e5 11%"],
    lines: [
      { eval: "+0.54", move: "Bg5", label: "Excellent", icon: "excellent", text: "Bg5 c6 a4 Nbd7 O-O e5" },
      { eval: "+0.56", move: "Be3", label: "Book", icon: "book", text: "Be3 e5 dxe5 dxe5" },
      { eval: "+0.53", move: "O-O", label: "Excellent", icon: "excellent", text: "O-O e5 dxe5 dxe5" },
    ],
  },
};

const ratingRangeLabels = {
  "7": "Last 7 days",
  "30": "Last 30 days",
  "90": "Last 90 days",
  "365": "Last year",
  all: "All time",
};

const ratingDemoProfiles = {
  rapid: {
    label: "Rapid",
    base: 1328,
    current: 1494,
    records: {
      "7": { games: 21, wins: 13, draws: 1, losses: 7, delta: 18 },
      "30": { games: 74, wins: 43, draws: 5, losses: 26, delta: 61 },
      "90": { games: 227, wins: 121, draws: 14, losses: 92, delta: 166 },
      "365": { games: 612, wins: 337, draws: 31, losses: 244, delta: 241 },
      all: { games: 1167, wins: 620, draws: 57, losses: 490, delta: 327 },
    },
  },
  blitz: {
    label: "Blitz",
    base: 1184,
    current: 1276,
    records: {
      "7": { games: 16, wins: 8, draws: 1, losses: 7, delta: 7 },
      "30": { games: 58, wins: 31, draws: 2, losses: 25, delta: 36 },
      "90": { games: 181, wins: 96, draws: 7, losses: 78, delta: 92 },
      "365": { games: 496, wins: 257, draws: 18, losses: 221, delta: 133 },
      all: { games: 842, wins: 434, draws: 31, losses: 377, delta: 188 },
    },
  },
  bullet: {
    label: "Bullet",
    base: 1002,
    current: 1098,
    records: {
      "7": { games: 33, wins: 17, draws: 0, losses: 16, delta: 4 },
      "30": { games: 122, wins: 66, draws: 2, losses: 54, delta: 28 },
      "90": { games: 298, wins: 159, draws: 4, losses: 135, delta: 96 },
      "365": { games: 708, wins: 371, draws: 9, losses: 328, delta: 118 },
      all: { games: 1044, wins: 545, draws: 11, losses: 488, delta: 142 },
    },
  },
};

function formatCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString("en-US") : "0";
}

function readChessComMode(stats, key) {
  const mode = stats?.[`chess_${key}`];
  if (!mode?.last) {
    return { available: false };
  }
  const record = mode.record || {};
  const wins = Number(record.win || 0);
  const draws = Number(record.draw || 0);
  const losses = Number(record.loss || 0);
  const games = wins + draws + losses;
  return {
    available: true,
    rating: Number(mode.last.rating || 0),
    wins,
    draws,
    losses,
    games,
  };
}

function renderLiveMode(key, mode) {
  const ratingNode = document.querySelector(`[data-live-rating="${key}"]`);
  const recordNode = document.querySelector(`[data-live-record="${key}"]`);
  if (!ratingNode || !recordNode) return;

  if (!mode.available) {
    ratingNode.textContent = "-";
    recordNode.textContent = "No public games found";
    return;
  }

  ratingNode.textContent = String(mode.rating || "-");
  recordNode.textContent = `${formatCount(mode.games)} games · ${formatCount(mode.wins)}W ${formatCount(mode.draws)}D ${formatCount(mode.losses)}L`;
}

function setLiveLookupStatus(message, isError = false) {
  const card = document.querySelector(".live-lookup-card");
  const status = document.getElementById("liveLookupStatus");
  if (card) card.classList.toggle("error", isError);
  if (status) status.textContent = message;
}

async function fetchChessComStats(username) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/stats`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 404) {
      throw new Error(`Chess.com user "${username}" was not found.`);
    }
    if (response.status === 429) {
      throw new Error("Chess.com is rate limiting public requests right now. Try again in a bit.");
    }
    if (!response.ok) {
      throw new Error(`Chess.com returned HTTP ${response.status}.`);
    }
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function refreshLiveLookup(username) {
  const cleanUsername = String(username || "").trim();
  const form = document.getElementById("liveLookupForm");
  const button = form?.querySelector("button");
  if (!cleanUsername) {
    setLiveLookupStatus("Enter a Chess.com username to refresh public stats.", true);
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = "Loading";
  }
  setLiveLookupStatus(`Fetching real public stats for ${cleanUsername}...`);

  try {
    const stats = await fetchChessComStats(cleanUsername);
    ["rapid", "blitz", "bullet"].forEach((key) => renderLiveMode(key, readChessComMode(stats, key)));
    setLiveLookupStatus(`Showing live Chess.com public stats for ${cleanUsername}.`);
  } catch (error) {
    ["rapid", "blitz", "bullet"].forEach((key) => renderLiveMode(key, { available: false }));
    const message = error?.name === "AbortError"
      ? "Chess.com took too long to respond. Check your connection and try again."
      : error?.message || "Could not load Chess.com public stats.";
    setLiveLookupStatus(message, true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Refresh";
    }
  }
}

function bindLiveLookup() {
  const form = document.getElementById("liveLookupForm");
  const input = document.getElementById("liveUsername");
  if (!form || !input) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void refreshLiveLookup(input.value);
  });

  void refreshLiveLookup(input.value);
}

function squareCenter(square) {
  const file = square[0];
  const rank = Number(square[1]);
  return {
    x: files.indexOf(file) + 0.5,
    y: boardSize - rank + 0.5,
  };
}

function arrowPath(fromSquare, toSquare) {
  const from = squareCenter(fromSquare);
  const to = squareCenter(toSquare);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0.01) return "";

  const unitX = dx / length;
  const unitY = dy / length;
  const normalX = -unitY;
  const normalY = unitX;

  const startInset = 0.42;
  const tipInset = 0.22;
  const shaftWidth = 0.07;
  const headLength = Math.min(0.3, length * 0.2);
  const headWidth = 0.22;

  const start = {
    x: from.x + unitX * startInset,
    y: from.y + unitY * startInset,
  };
  const tip = {
    x: to.x - unitX * tipInset,
    y: to.y - unitY * tipInset,
  };
  const neck = {
    x: tip.x - unitX * headLength,
    y: tip.y - unitY * headLength,
  };

  const points = [
    [start.x + normalX * shaftWidth, start.y + normalY * shaftWidth],
    [neck.x + normalX * shaftWidth, neck.y + normalY * shaftWidth],
    [neck.x + normalX * headWidth, neck.y + normalY * headWidth],
    [tip.x, tip.y],
    [neck.x - normalX * headWidth, neck.y - normalY * headWidth],
    [neck.x - normalX * shaftWidth, neck.y - normalY * shaftWidth],
    [start.x - normalX * shaftWidth, start.y - normalY * shaftWidth],
  ];

  return points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x.toFixed(3)} ${y.toFixed(3)}`)
    .join(" ") + " Z";
}

function renderBoard(board, stateKey = "book") {
  if (!board) return;
  const state = demoStates[stateKey] || demoStates.book;
  board.innerHTML = "";

  for (let rank = 8; rank >= 1; rank -= 1) {
    files.forEach((file, fileIndex) => {
      const squareName = `${file}${rank}`;
      const square = document.createElement("div");
      square.className = `square ${((8 - rank) + fileIndex) % 2 === 0 ? "light" : "dark"}`;
      square.dataset.square = squareName;

      if (squareName === state.from) {
        square.classList.add("best-from", "classified-source", `classification-${state.icon}`);
        const overlay = document.createElement("div");
        overlay.className = "square-classification-overlay";
        square.appendChild(overlay);
      }
      if (squareName === state.to) {
        square.classList.add("best-to", "classified-target", `classification-${state.icon}`);
        const overlay = document.createElement("div");
        overlay.className = "square-classification-overlay";
        square.appendChild(overlay);
      }

      const piece = basePosition[squareName];
      if (piece) {
        const image = document.createElement("img");
        image.className = "piece";
        image.alt = `${piece[0] === "w" ? "White" : "Black"} ${piece[1]}`;
        image.src = `assets/pieces/cburnett/${piece}.svg`;
        square.appendChild(image);
      }

      if (squareName === state.to) {
        const icon = document.createElement("img");
        icon.className = "class-icon";
        icon.alt = `${state.move} ${state.icon} classification`;
        icon.src = `assets/move-classifications/${state.icon}.png`;
        square.appendChild(icon);
      }

      if (file === "a") {
        const rankLabel = document.createElement("span");
        rankLabel.className = "coord rank-label";
        rankLabel.textContent = rank;
        square.appendChild(rankLabel);
      }

      if (rank === 1) {
        const fileLabel = document.createElement("span");
        fileLabel.className = "coord file-label";
        fileLabel.textContent = file;
        square.appendChild(fileLabel);
      }

      board.appendChild(square);
    });
  }

  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.setAttribute("class", "board-arrow-svg");
  arrow.setAttribute("viewBox", "0 0 8 8");
  arrow.setAttribute("aria-hidden", "true");
  arrow.innerHTML = `
    <defs>
      <filter id="boardArrowShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="0.045" stdDeviation="0.035" flood-color="#0a1c36" flood-opacity="0.32"></feDropShadow>
      </filter>
    </defs>
    <path class="board-arrow-path" d="${arrowPath(state.from, state.to)}"></path>
  `;
  board.appendChild(arrow);
}

function renderAnalysisLines(stateKey = "book") {
  const target = document.getElementById("webLines");
  if (!target) return;
  const state = demoStates[stateKey] || demoStates.book;
  target.innerHTML = state.lines
    .map((line) => `
      <div class="engine-line">
        <span class="eval">${line.eval}</span>
        <strong>${line.move}</strong>
        <span class="class ${line.icon}">
          <img src="assets/move-classifications/${line.icon}.png" alt="">${line.label}
        </span>
        <small>${line.text}</small>
      </div>
    `)
    .join("");
}

function updateStudy(stateKey = "book") {
  const state = demoStates[stateKey] || demoStates.book;
  renderBoard(document.getElementById("webBoard"), stateKey);
  renderAnalysisLines(stateKey);

  const prompt = document.getElementById("studyPrompt");
  const review = document.getElementById("moveReview");
  const bookStateCopy = document.getElementById("bookStateCopy");
  const evalText = document.getElementById("webEval");
  const evalFill = document.getElementById("webEvalFill");
  const evalRail = evalText?.closest(".eval-rail");
  const replies = [document.getElementById("replyOne"), document.getElementById("replyTwo"), document.getElementById("replyThree")];

  if (prompt) prompt.textContent = state.prompt;
  if (review) review.textContent = state.review;
  if (bookStateCopy) bookStateCopy.textContent = state.bookState;
  if (evalText) evalText.textContent = state.eval;
  if (evalRail) evalRail.setAttribute("aria-label", `Evaluation ${state.eval}`);
  if (evalFill) evalFill.style.height = state.fill;
  replies.forEach((node, index) => {
    if (node) node.textContent = state.replies[index];
  });
}

function bindTabs() {
  const buttons = document.querySelectorAll("[data-demo-tab]");
  const panels = document.querySelectorAll("[data-panel]");
  const activate = (name) => {
    buttons.forEach((item) => item.classList.toggle("active", item.dataset.demoTab === name));
    panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === name));
  };

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      activate(button.dataset.demoTab);
    });
  });

  document.querySelectorAll("[data-nav-tab]").forEach((link) => {
    link.addEventListener("click", () => activate(link.dataset.navTab));
  });

  const initialTab = window.location.hash.replace("#", "");
  if (initialTab && document.querySelector(`[data-panel="${initialTab}"]`)) {
    activate(initialTab);
  }
}

function bindChoices() {
  document.querySelectorAll("[data-demo-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const stateKey = button.dataset.demoChoice;
      updateStudy(stateKey);
      const studyButton = document.querySelector("[data-demo-tab='study']");
      if (studyButton) studyButton.click();
    });
  });
}

function makeRatingPoints(profile, record, count) {
  const points = [];
  const usableCount = Math.max(6, count);
  const start = profile.current - record.delta;
  const volatility = profile.label === "Bullet" ? 9 : profile.label === "Blitz" ? 7 : 5;
  for (let index = 0; index < usableCount; index += 1) {
    const progress = index / Math.max(1, usableCount - 1);
    const wave = Math.sin(progress * Math.PI * 4.2) * volatility;
    const noise = Math.cos(progress * Math.PI * 8.5) * (volatility * 0.42);
    const recovery = Math.sin(progress * Math.PI) * Math.max(10, record.delta * 0.08);
    const value = Math.round(start + record.delta * progress + wave + noise + recovery);
    const result = index % 9 === 0 ? "loss" : index % 5 === 0 ? "draw" : "win";
    points.push({ value, result, index });
  }
  points[points.length - 1].value = profile.current;
  return points;
}

function renderRatingDemo(rangeKey = "90", timeKey = "rapid") {
  const profile = ratingDemoProfiles[timeKey] || ratingDemoProfiles.rapid;
  const record = profile.records[rangeKey] || profile.records["90"];
  const svg = document.getElementById("ratingDemoSvg");
  if (!svg) return;

  const pointCount = rangeKey === "7" ? 12 : rangeKey === "30" ? 22 : rangeKey === "90" ? 34 : rangeKey === "365" ? 48 : 58;
  const points = makeRatingPoints(profile, record, pointCount);
  const values = points.map((point) => point.value);
  const minValue = Math.min(...values) - 18;
  const maxValue = Math.max(...values) + 18;
  const width = 720;
  const height = 260;
  const padX = 34;
  const padY = 28;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;
  const toX = (index) => padX + (index / Math.max(1, points.length - 1)) * chartW;
  const toY = (value) => padY + ((maxValue - value) / Math.max(1, maxValue - minValue)) * chartH;
  const lineD = points.map((point, index) => `${index === 0 ? "M" : "L"} ${toX(index).toFixed(1)} ${toY(point.value).toFixed(1)}`).join(" ");
  const areaD = `${lineD} L ${toX(points.length - 1).toFixed(1)} ${height - padY} L ${padX} ${height - padY} Z`;
  const yTicks = [maxValue, Math.round((maxValue + minValue) / 2), minValue];

  svg.innerHTML = `
    <defs>
      <linearGradient id="ratingAreaGradient" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#7da2ff" stop-opacity="0.42"></stop>
        <stop offset="100%" stop-color="#7da2ff" stop-opacity="0.04"></stop>
      </linearGradient>
      <filter id="ratingGlow" x="-10%" y="-30%" width="120%" height="160%">
        <feGaussianBlur stdDeviation="3.2" result="blur"></feGaussianBlur>
        <feMerge>
          <feMergeNode in="blur"></feMergeNode>
          <feMergeNode in="SourceGraphic"></feMergeNode>
        </feMerge>
      </filter>
    </defs>
    ${yTicks.map((tick) => `<g class="rating-gridline"><line x1="${padX}" x2="${width - padX}" y1="${toY(tick).toFixed(1)}" y2="${toY(tick).toFixed(1)}"></line><text x="8" y="${(toY(tick) + 4).toFixed(1)}">${tick}</text></g>`).join("")}
    <path class="rating-demo-area" d="${areaD}"></path>
    <path class="rating-demo-line" d="${lineD}" filter="url(#ratingGlow)"></path>
    ${points.map((point, index) => {
      const x = toX(index).toFixed(1);
      const y = toY(point.value).toFixed(1);
      return `<circle class="rating-demo-point ${point.result}" cx="${x}" cy="${y}" r="4.8"><title>${profile.label} ${point.value} · ${point.result}</title></circle>`;
    }).join("")}
  `;

  const winrate = record.games ? ((record.wins / record.games) * 100).toFixed(1) : "0.0";
  const title = document.getElementById("ratingDemoTitle");
  const copy = document.getElementById("ratingDemoCopy");
  const rating = document.getElementById("ratingDemoRating");
  const recordNode = document.getElementById("ratingDemoRecord");
  const winrateNode = document.getElementById("ratingDemoWinrate");
  const highlight = document.getElementById("ratingDemoHighlight");
  if (title) title.textContent = `${profile.label} · ${ratingRangeLabels[rangeKey] || ratingRangeLabels["90"]}`;
  if (copy) copy.textContent = `${profile.current} current rating, ${record.delta >= 0 ? "+" : ""}${record.delta} over the selected range, and ${record.games} games tracked.`;
  if (rating) rating.textContent = profile.current;
  if (recordNode) recordNode.textContent = `${record.wins}W ${record.draws}D ${record.losses}L`;
  if (winrateNode) winrateNode.textContent = `${winrate}%`;
  if (highlight) highlight.textContent = `${profile.label} had ${record.wins} wins, ${record.draws} draws, and ${record.losses} losses across ${record.games} games.`;
}

function bindRatingDemo() {
  const rangeButtons = document.querySelectorAll("[data-rating-range]");
  const timeButtons = document.querySelectorAll("[data-rating-time]");
  const current = { range: "7", time: "rapid" };
  const refresh = () => renderRatingDemo(current.range, current.time);

  rangeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      current.range = button.dataset.ratingRange || "90";
      rangeButtons.forEach((item) => item.classList.toggle("active", item === button));
      refresh();
    });
  });

  timeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      current.time = button.dataset.ratingTime || "rapid";
      timeButtons.forEach((item) => item.classList.toggle("active", item === button));
      refresh();
    });
  });

  refresh();
}

renderBoard(document.getElementById("landingBoard"), "book");
updateStudy("book");
bindTabs();
bindChoices();
bindRatingDemo();
bindLiveLookup();
