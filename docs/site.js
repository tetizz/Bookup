const heroBoard = document.getElementById("heroBoard");

const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const boardSize = 8;
const position = {
  a8: "bR", b8: "bN", c8: "bB", d8: "bQ", e8: "bK", f8: "bB", h8: "bR",
  a7: "bP", b7: "bP", c7: "bP", e7: "bP", f7: "bP", g7: "bB", h7: "bP",
  d6: "bP", f6: "bN", g6: "bP",
  d4: "wP", e4: "wP",
  c3: "wN", f3: "wN",
  a2: "wP", b2: "wP", c2: "wP", f2: "wP", g2: "wP", h2: "wP",
  a1: "wR", c1: "wB", d1: "wQ", e1: "wK", f1: "wB", h1: "wR",
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

  // Board-unit proportions inspired by SVG chessboard annotations:
  // small enough to show the move without swallowing the pieces.
  const startInset = 0.32;
  const tipInset = 0.14;
  const shaftWidth = 0.16;
  const headLength = Math.min(0.46, length * 0.28);
  const headWidth = 0.52;

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

function renderBoard() {
  if (!heroBoard) return;
  heroBoard.innerHTML = "";
  for (let rank = 8; rank >= 1; rank -= 1) {
    files.forEach((file, fileIndex) => {
      const squareName = `${file}${rank}`;
      const square = document.createElement("div");
      square.className = `square ${((8 - rank) + fileIndex) % 2 === 0 ? "light" : "dark"}`;
      square.dataset.square = squareName;
      if (squareName === "e3") square.classList.add("best-to");
      if (squareName === "c1") square.classList.add("best-from");
      const piece = position[squareName];
      if (piece) {
        const image = document.createElement("img");
        image.className = "piece";
        image.alt = `${piece[0] === "w" ? "White" : "Black"} ${piece[1]}`;
        image.src = `assets/pieces/cburnett/${piece}.svg`;
        square.appendChild(image);
      }
      if (squareName === "e3") {
        const icon = document.createElement("img");
        icon.className = "class-icon";
        icon.alt = "Book move";
        icon.src = "assets/move-classifications/book.png";
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
      heroBoard.appendChild(square);
    });
  }
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.setAttribute("class", "board-arrow-svg");
  arrow.setAttribute("viewBox", "0 0 8 8");
  arrow.setAttribute("aria-hidden", "true");
  arrow.innerHTML = `
    <defs>
      <filter id="heroArrowShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="0.045" stdDeviation="0.035" flood-color="#0a1c36" flood-opacity="0.32"></feDropShadow>
      </filter>
    </defs>
    <path class="board-arrow-path" d="${arrowPath("c1", "e3")}"></path>
  `;
  heroBoard.appendChild(arrow);
}

renderBoard();
