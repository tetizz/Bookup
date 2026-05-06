const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const boardSize = 8;

// Legal demo position after:
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
    prompt: "Be3 is legal here, stays inside the imported repertoire, and is the top checked candidate in this demo.",
    review: "Be3 is Book because it is part of the imported branch before engine coaching takes over.",
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
    replies: ["...c6 45%", "...Nbd7 29%", "...e5 11%"],
    lines: [
      { eval: "+0.54", move: "Bg5", label: "Excellent", icon: "excellent", text: "Bg5 c6 a4 Nbd7 O-O e5" },
      { eval: "+0.56", move: "Be3", label: "Book", icon: "book", text: "Be3 e5 dxe5 dxe5" },
      { eval: "+0.53", move: "O-O", label: "Excellent", icon: "excellent", text: "O-O e5 dxe5 dxe5" },
    ],
  },
};

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

  const startInset = 0.32;
  const tipInset = 0.14;
  const shaftWidth = 0.1;
  const headLength = Math.min(0.36, length * 0.24);
  const headWidth = 0.32;

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
  const evalText = document.getElementById("webEval");
  const evalFill = document.getElementById("webEvalFill");
  const evalRail = evalText?.closest(".eval-rail");
  const replies = [document.getElementById("replyOne"), document.getElementById("replyTwo"), document.getElementById("replyThree")];

  if (prompt) prompt.textContent = state.prompt;
  if (review) review.textContent = state.review;
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
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.dataset.demoTab;
      buttons.forEach((item) => item.classList.toggle("active", item === button));
      panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === name));
    });
  });
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

renderBoard(document.getElementById("landingBoard"), "book");
updateStudy("book");
bindTabs();
bindChoices();
