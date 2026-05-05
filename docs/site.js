const copy = {
  train: "Choose any legal move from your side. Bookup follows your repertoire branch, classifies the move, then replies from the live position.",
  review: "Needs Work focuses on repeated repertoire problems, not one-off losses or positions where you already play the best move.",
  theory: "Theory turns imported games into a move tree, then lets Stockfish generate concrete next-move continuations from any position.",
};

const output = document.getElementById("demoOutput");
document.querySelectorAll("[data-demo-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-demo-tab]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    output.textContent = copy[button.dataset.demoTab] || copy.train;
  });
});
