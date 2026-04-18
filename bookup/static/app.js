const defaults = window.APP_DEFAULTS || {};

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
    button.addEventListener("click", () => setActiveTab(button.dataset.tabTarget || "report"));
  });
  syncImportScope();
  setActiveTab("report");
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
  setStatus("Importing games and building your prep robot report...");
  el.analyze.disabled = true;
  try {
    const payload = await fetchProfilePayload(el.username.value.trim());
    renderProfile(payload);
    setStatus(
      `Imported ${payload.games_imported} games from ${payload.archives_found} archive months. Prep report is ready.`
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
  const lessons = (profile.prep_repertoire || []).reduce(
    (count, item) => count + Number(item.lesson_count || 0),
    0
  );

  el.heroTitle.textContent = `${payload.username} prep robot report`;
  el.heroSummary.textContent =
    "This report is built from the openings they actually repeat on Chess.com. Use the prep tab to see what they play, which branches matter, and the engine continuation you should know before the game starts.";
  el.badgeWinRate.textContent = `${payload.games_imported || 0}`;
  el.badgeChaos.textContent = topWhite?.opening || "--";
  el.badgeColor.textContent = topBlack?.opening || `${lessons} lessons`;

  renderFirstMove(profile.first_move_repertoire || {});
  renderOpenings(profile.top_openings_by_color || {});
  renderPrepLines(profile.prep_repertoire || []);
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

function renderPrepLines(items) {
  if (!items.length) {
    el.prepList.className = "stack empty";
    el.prepList.textContent = "No prep lines yet.";
    return;
  }

  el.prepList.className = "stack";
  el.prepList.innerHTML = items
    .map((item) => {
      const lessons = item.lessons || [];
      const linePreview = buildLinePreview(item.steps || []);
      const lessonHtml = lessons.length
        ? lessons
            .map(
              (lesson) => `
                <div class="prep-lesson ${lesson.lesson_type === "repeat" ? "repeat" : "fix"}">
                  <div class="prep-lesson-head">
                    <span class="prep-ply">${lesson.ply}${lesson.ply % 2 === 0 ? "..." : "."}</span>
                    <span class="prep-trigger">After ${escapeHtml(lesson.trigger_move)}</span>
                  </div>
                  <div class="prep-best">
                    ${lesson.lesson_type === "repeat" ? "You already know:" : "Best continuation:"}
                    <strong>${escapeHtml(lesson.best_reply)}</strong>
                  </div>
                  <div class="prep-meta">${escapeHtml(lesson.explanation)}</div>
                  ${
                    lesson.your_played
                      ? `<div class="prep-meta">Your sample game move: <strong>${escapeHtml(lesson.your_played)}</strong>${lesson.repeated_count ? ` · repeated ${lesson.repeated_count}x` : ""}</div>`
                      : ""
                  }
                  <div class="item-note">Engine line: ${escapeHtml(lesson.continuation)}</div>
                  ${
                    lesson.position_identifier
                      ? `<div class="item-note"><a href="${lesson.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(lesson.position_identifier_label || "Lichess analysis")}</a></div>`
                      : ""
                  }
                  ${
                    lesson.options?.length
                      ? `<div class="prep-options">${lesson.options
                          .map(
                            (option) =>
                              `<span class="prep-option">${escapeHtml(option.san)} · ${option.popularity || 0}% · ${option.games || 0} games</span>`
                          )
                          .join("")}</div>`
                      : ""
                  }
                </div>
              `
            )
            .join("")
        : `<div class="item-note">You already match the engine on the main sample line for this opening, so there are no extra correction notes right now.</div>`;

      return `
        <article class="item prep-item">
          <div class="item-title">${escapeHtml(item.opening)}${item.opening_code ? ` <span class="prep-code">${escapeHtml(item.opening_code)}</span>` : ""}</div>
          <div class="item-sub">They play this as ${escapeHtml(item.color)}. Learn the branches they repeat and the cleanest continuation against each one.</div>
          ${
            item.position_identifier
              ? `<div class="item-note"><a href="${item.position_identifier}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.position_identifier_label || "Lichess analysis")}</a></div>`
              : ""
          }
          ${linePreview ? `<div class="prep-line-preview">${linePreview}</div>` : ""}
          <div class="prep-lesson-stack">${lessonHtml}</div>
        </article>
      `;
    })
    .join("");
}

function buildLinePreview(steps) {
  const moves = steps
    .map((step) => {
      if (step.kind === "user") return step.san || "";
      if (step.kind === "opponent") return step.played || "";
      return "";
    })
    .filter(Boolean);
  return moves.join(" ");
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
