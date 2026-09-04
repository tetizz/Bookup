(() => {
  "use strict";

  const WORKSPACES = [
    { target: "setup", label: "Setup", mobileLabel: "Setup", hint: "Import and build a plan" },
    { target: "repertoire-map", label: "Repertoire", mobileLabel: "Lines", hint: "Review lines and coverage" },
    { target: "trainer", label: "Train", mobileLabel: "Train", hint: "Practice the next position" },
    { target: "stats", label: "Progress", mobileLabel: "Progress", hint: "Turn results into work" },
    { target: "smart-theory", label: "Smart Theory", mobileLabel: "Theory", hint: "Build a legal variation tree" },
  ];
  const HOME_URL = "https://tetizz.github.io/Home/";
  let boardFrame = 0;

  function byId(id) {
    return document.getElementById(id);
  }

  function compactHeader() {
    const header = document.querySelector(".topbar");
    if (!header || header.querySelector(".product-header")) return;

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
            <span class="product-kicker">Opening study desk</span>
            <h1>Bookup</h1>
            <p>Your games, one repertoire, one training plan</p>
          </div>
        </div>
        <div class="product-header-actions">
          <dl class="product-header-stats" aria-label="Workspace summary">
            <div class="product-header-stat"><dt>Positions</dt><dd data-summary-slot="summaryPositions">--</dd></div>
            <div class="product-header-stat"><dt>Needs work</dt><dd data-summary-slot="summaryNeedsWork">--</dd></div>
            <div class="product-header-stat"><dt>Queue</dt><dd data-summary-slot="summaryQueue">--</dd></div>
          </dl>
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

    WORKSPACES.forEach(({ target, label, mobileLabel, hint }, index) => {
      const button = buttons.get(target);
      if (!button) return;
      button.setAttribute("aria-label", `${label}: ${hint}`);
      button.innerHTML = `
        <span class="workspace-tab__index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
        <span class="workspace-tab__copy"><strong>${label}</strong><small>${hint}</small></span>
        <span class="workspace-tab__mobile" aria-hidden="true">${mobileLabel}</span>`;
      nav.appendChild(button);
    });

    [...nav.querySelectorAll("[data-tab-target]")].forEach((button) => {
      if (!WORKSPACES.some(({ target }) => target === button.dataset.tabTarget)) button.remove();
    });

    document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      if (!WORKSPACES.some(({ target }) => target === panel.dataset.tabPanel)) panel.hidden = true;
    });
  }

  function setNavigationOrientation() {
    const nav = document.querySelector(".workspace-tabs");
    if (!nav) return;
    nav.setAttribute("aria-orientation", window.matchMedia("(max-width: 1180px)").matches ? "horizontal" : "vertical");
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

    const compact = window.innerWidth <= 620;
    const viewportAllowance = Math.max(180, window.innerHeight - (compact ? 210 : 176));
    const panelWidth = panel.getBoundingClientRect().width;
    const sidePanelAllowance = window.innerWidth > 1180 ? 452 : 0;
    const available = Math.max(180, panelWidth - sidePanelAllowance - (compact ? 18 : 28));
    const size = Math.floor(Math.min(720, viewportAllowance, available));
    document.documentElement.style.setProperty("--bookup-board-size", `${size}px`);
  }

  function scheduleBoardSize() {
    if (boardFrame) cancelAnimationFrame(boardFrame);
    boardFrame = requestAnimationFrame(() => {
      boardFrame = 0;
      setBoardSize();
      labelHonestAccuracy();
    });
  }

  function repairLegacyTab() {
    const active = document.querySelector(".workspace-tab.active");
    if (active && !WORKSPACES.some(({ target }) => target === active.dataset.tabTarget)) {
      document.querySelector('[data-tab-target="trainer"]')?.click();
    }
  }

  function annotateEdition() {
    const isWeb = Boolean(document.querySelector('script[src*="web-app"]'));
    document.documentElement.dataset.bookupEdition = isWeb ? "web" : "desktop";
    document.documentElement.dataset.bookupUi = "astra-study-desk-v10";
  }

  function observeLayout() {
    const shell = document.querySelector(".app-shell");
    if ("ResizeObserver" in window && shell) {
      const observer = new ResizeObserver(scheduleBoardSize);
      observer.observe(shell);
    } else {
      window.addEventListener("resize", scheduleBoardSize, { passive: true });
    }

    const orientationQuery = window.matchMedia("(max-width: 1180px)");
    orientationQuery.addEventListener?.("change", () => {
      setNavigationOrientation();
      scheduleBoardSize();
    });

    const nav = document.querySelector(".workspace-tabs");
    nav?.addEventListener("click", scheduleBoardSize);
    nav?.addEventListener("keydown", (event) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        scheduleBoardSize();
      }
    });
  }

  function init() {
    annotateEdition();
    compactHeader();
    consolidateNavigation();
    repairLegacyTab();
    setNavigationOrientation();
    setBoardSize();
    labelHonestAccuracy();
    observeLayout();
    document.documentElement.dataset.shellReady = "true";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
