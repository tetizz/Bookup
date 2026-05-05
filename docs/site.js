const heroBoard = document.getElementById("heroBoard");

const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const position = {
  a8: "bR", b8: "bN", c8: "bB", d8: "bQ", e8: "bK", f8: "bB", h8: "bR",
  a7: "bP", b7: "bP", c7: "bP", e7: "bP", f7: "bP", g7: "bB", h7: "bP",
  d6: "bP", f6: "bN", g6: "bP",
  d4: "wP", e4: "wP",
  c3: "wN", f3: "wN",
  a2: "wP", b2: "wP", c2: "wP", f2: "wP", g2: "wP", h2: "wP",
  a1: "wR", c1: "wB", d1: "wQ", e1: "wK", f1: "wB", h1: "wR",
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
  arrow.setAttribute("viewBox", "0 0 100 100");
  arrow.setAttribute("aria-hidden", "true");
  arrow.innerHTML = `
    <defs>
      <marker id="heroArrowHead" markerWidth="6" markerHeight="6" refX="4.7" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L6,3 L0,6 Z" fill="rgba(72, 151, 255, 0.74)"></path>
      </marker>
    </defs>
    <line x1="31.25" y1="93.75" x2="54.8" y2="70.2" marker-end="url(#heroArrowHead)"></line>
  `;
  heroBoard.appendChild(arrow);
}

renderBoard();
