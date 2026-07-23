(() => {
  "use strict";

  const WORKSPACES = [
    ["setup", "Setup"],
    ["repertoire-map", "Repertoire"],
    ["trainer", "Train"],
    ["stats", "Progress"],
    ["smart-theory", "Smart Theory"],
  ];
  const HOME_URL = "https://tetizz.github.io/Home/";

  function byId(id) {
    return document.getElementById(id);
  }

  function compactHeader() {
    const header = document.querySelector(".topbar");
    if (!header) return;
    const liveSummary = {
      summaryPositions: byId("summaryPositions"),
      summaryNeedsWork: byId("summaryNeedsWork"),
      summaryQueue: byId("summaryQueue"),
    };
    header.innerHTML = `
      <div class="product-header">
        <div class="product-brand">
          <div class="product-mark" aria-hidden="true">B</div>
          <div class="product-brand-copy">
            <strong>Bookup</strong>
            <span>Your games, one repertoire, one training plan</span>
          </div>
        </div>
        <div class="product-header-actions">
          <div class="product-header-stats" aria-label="Workspace summary">
            <div class="product-header-stat"><span>Positions</span><strong data-summary-slot="summaryPositions">--</strong></div>
            <div class="product-header-stat"><span>Needs work</span><strong data-summary-slot="summaryNeedsWork">--</strong></div>
            <div class="product-header-stat"><span>Queue</span><strong data-summary-slot="summaryQueue">--</strong></div>
          </div>
          <a class="product-home-button" href="${HOME_URL}" aria-label="Open tetizz chess projects home">
            <span class="product-home-button__spark" aria-hidden="true"></span>
            <span>Home</span>
          </a>
        </div>
      </div>`;
    Object.entries(liveSummary).forEach(([id, node]) => {
      const slot = header.querySelector(`[data-summary-slot="${id}"]`);
      if (slot && node) slot.replaceWith(node);
    });
  }

  function consolidateNavigation() {
    const nav = document.querySelector(".workspace-tabs");
    if (!nav) return;
    const buttons = new Map(
      [...nav.querySelectorAll("[data-tab-target]")].map((button) => [button.dataset.tabTarget, button])
    );
    WORKSPACES.forEach(([target, label]) => {
      const button = buttons.get(target);
      if (!button) return;
      button.textContent = label;
      button.setAttribute("aria-label", label);
      nav.appendChild(button);
    });
    [...nav.querySelectorAll("[data-tab-target]")].forEach((button) => {
      if (!WORKSPACES.some(([target]) => target === button.dataset.tabTarget)) button.remove();
    });
    document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      if (!WORKSPACES.some(([target]) => target === panel.dataset.tabPanel)) panel.hidden = true;
    });
  }

  function labelHonestAccuracy() {
    document.querySelectorAll(".progress-stat-card span, .progress-metric-grid article span").forEach((label) => {
      if (label.textContent.trim() === "Accuracy") label.textContent = "Bookup local accuracy";
    });
    const status = byId("progressStatus");
    if (status && /fallback values/i.test(status.textContent)) {
      status.textContent = status.textContent.replace(/fallback values/i, "manual fallback values");
    }
  }

  function setBoardSize() {
    const panel = document.querySelector('[data-tab-panel="trainer"].active')
      || document.querySelector('[data-tab-panel="smart-theory"].active')
      || document.querySelector(".workspace-panel.active");
    if (!panel) return;
    const viewportAllowance = Math.max(260, window.innerHeight - (window.innerWidth <= 620 ? 230 : 190));
    const available = Math.max(260, panel.getBoundingClientRect().width - (window.innerWidth > 1180 ? 460 : 24));
    const size = Math.floor(Math.min(760, viewportAllowance, available));
    document.documentElement.style.setProperty("--bookup-board-size", `${size}px`);
  }

  function repairLegacyTab() {
    const active = document.querySelector(".workspace-tab.active");
    if (active && !WORKSPACES.some(([target]) => target === active.dataset.tabTarget)) {
      document.querySelector('[data-tab-target="trainer"]')?.click();
    }
  }

  function annotateEdition() {
    const desktop = location.protocol.startsWith("http") && !/github\.io$/i.test(location.hostname);
    document.documentElement.dataset.bookupEdition = desktop ? "desktop" : "web";
    document.documentElement.dataset.bookupUi = "unified-product-v9";
  }

  function observeDynamicContent() {
    const observer = new MutationObserver(() => {
      labelHonestAccuracy();
      setBoardSize();
    });
    observer.observe(document.body, { subtree: true, childList: true });
  }

  function init() {
    annotateEdition();
    compactHeader();
    consolidateNavigation();
    repairLegacyTab();
    labelHonestAccuracy();
    setBoardSize();
    observeDynamicContent();
    window.addEventListener("resize", setBoardSize, { passive: true });
    document.querySelector(".workspace-tabs")?.addEventListener("click", () => requestAnimationFrame(setBoardSize));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
