const heroBoard = document.getElementById("heroBoard");

const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const position = {
  a8: "bR", b8: "bN", c8: "bB", d8: "bQ", f8: "bR", g8: "bK",
  a7: "bP", b7: "bP", c7: "bP", e7: "bP", f7: "bP", g7: "bB", h7: "bP",
  a6: "bP", d6: "bP", f6: "bN", g6: "bP",
  d4: "wP", e4: "wP",
  c3: "wN", e3: "wB", f3: "wN",
  a2: "wP", b2: "wP", c2: "wP", f2: "wP", g2: "wP", h2: "wP",
  a1: "wR", d2: "wQ", e1: "wK", f1: "wB", h1: "wR",
};

function renderBoard() {
  if (!heroBoard) return;
  heroBoard.innerHTML = "";
  for (let rank = 8; rank >= 1; rank -= 1) {
    files.forEach((file, fileIndex) => {
      const squareName = `${file}${rank}`;
      const square = document.createElement("div");
      square.className = `square ${((8 - rank) + fileIndex) % 2 === 0 ? "light" : "dark"}`;
      square.dataset.square = squareName;
      if (squareName === "h3") square.classList.add("best-to");
      if (squareName === "h2") square.classList.add("best-from");
      const piece = position[squareName];
      if (piece) {
        const image = document.createElement("img");
        image.className = "piece";
        image.alt = `${piece[0] === "w" ? "White" : "Black"} ${piece[1]}`;
        image.src = `assets/pieces/cburnett/${piece}.svg`;
        square.appendChild(image);
      }
      if (squareName === "h3") {
        const icon = document.createElement("img");
        icon.className = "class-icon";
        icon.alt = "Best move";
        icon.src = "assets/move-classifications/best.png";
        square.appendChild(icon);
      }
      heroBoard.appendChild(square);
    });
  }
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.setAttribute("class", "board-arrow-svg");
  arrow.setAttribute("viewBox", "0 0 100 100");
  arrow.setAttribute("aria-hidden", "true");
  arrow.innerHTML = `
    <defs>
      <marker id="heroArrowHead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L8,4 L0,8 Z" fill="rgba(72, 151, 255, 0.7)"></path>
      </marker>
    </defs>
    <line x1="93.75" y1="81.25" x2="93.75" y2="69.8" marker-end="url(#heroArrowHead)"></line>
  `;
  heroBoard.appendChild(arrow);
}

renderBoard();
