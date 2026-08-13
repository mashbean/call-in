import { difficultyLabels, renderDifficultyChart, setDifficultyLabels } from "../difficulty.js";

const apiBase = "/api";
const config = await fetch(`${apiBase}/config`).then((response) => response.json());
applyConfig(config);
const pollsRoot = document.querySelector("#dashboard-polls");
const questionsRoot = document.querySelector("#dashboard-questions");
const statusEl = document.querySelector("[data-status]");
const reactionStage = document.querySelector("[data-reaction-stage]");
const tabButtons = [...document.querySelectorAll("[data-dashboard-tab]")];
const tabPanels = [...document.querySelectorAll("[data-dashboard-panel]")];
const lensLabels = Object.fromEntries(config.question.lenses.map((lens) => [lens.id, lens.label]));

function render(state) {
  renderDifficultyChart(document.querySelector(".dashboard-difficulty"), state.difficulty);
  document.querySelector("[data-poll-total]").textContent = `${state.polls.length} 題`;
  pollsRoot.innerHTML = state.polls
    .map(
      (poll, index) => `
        <article class="dashboard-poll">
          <div class="dashboard-poll-head"><b>${String(index + 1).padStart(2, "0")}</b><span>${poll.total} 票</span></div>
          <h3>${escapeHtml(poll.question)}</h3>
          ${poll.options
            .map((option, optionIndex) => {
              const percent = poll.total
                ? Math.round((poll.counts[optionIndex] / poll.total) * 100)
                : 0;
              return `<div class="dashboard-result-row"><span>${escapeHtml(option)}</span><div><i style="--pct:${percent}%"></i></div><b>${poll.counts[optionIndex]} 票</b></div>`;
            })
            .join("")}
        </article>`,
    )
    .join("");

  document.querySelector("[data-question-count]").textContent = `${state.questions.length} 題`;
  const latestQuestions = [...state.questions].sort(
    (first, second) => Number(second.createdAt) - Number(first.createdAt),
  );
  questionsRoot.innerHTML = latestQuestions.length
    ? latestQuestions
        .map(
          (question, index) => `
            <article>
              <div class="dashboard-question-head"><b>${index === 0 ? "NEW" : String(index + 1).padStart(2, "0")}</b><span><time>${formatTime(question.createdAt)}</time> · 我也想問 ${question.upvotes}</span></div>
              <div class="question-tags"><span class="question-lens">${escapeHtml(lensLabels[question.lens] || lensLabels.clarify)}</span><span class="question-difficulty difficulty-${question.difficulty}">${question.difficulty} · ${escapeHtml(difficultyLabels[question.difficulty - 1] || difficultyLabels[2])}</span></div>
              <p>${escapeHtml(question.text)}</p>
              <small>${escapeHtml(question.nickname)}</small>
            </article>`,
        )
        .join("")
    : `<div class="empty">等待第一個問題</div>`;
}

function setDashboardTab(name) {
  const next = name === "polls" ? "polls" : "live";
  tabButtons.forEach((button) => {
    const active = button.dataset.dashboardTab === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  tabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.dashboardPanel !== next;
  });
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const next = button.dataset.dashboardTab;
    setDashboardTab(next);
    history.replaceState(null, "", next === "polls" ? "#polls" : "#live");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});

function formatTime(value) {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-TW", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
    : "剛剛";
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}${apiBase}/live`);
  socket.addEventListener("open", () => setStatus(true));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "snapshot") render(message.data);
    if (message.type === "reaction") showReaction(message.data);
  });
  socket.addEventListener("close", () => {
    setStatus(false);
    setTimeout(connect, 1500);
  });
}

function showReaction(reaction) {
  const emoji = config.reactions.find((item) => item.id === reaction?.kind)?.emoji;
  if (!emoji) return;
  const burst = document.createElement("div");
  burst.className = `reaction-popup reaction-${reaction.kind}`;
  burst.textContent = emoji;
  burst.style.setProperty("--reaction-x", `${12 + Math.random() * 72}%`);
  burst.style.setProperty("--reaction-drift", `${-30 + Math.random() * 60}px`);
  burst.style.setProperty("--reaction-rotate", `${-16 + Math.random() * 32}deg`);
  reactionStage.append(burst);
  setTimeout(() => burst.remove(), 2600);
}

function setStatus(online) {
  statusEl.classList.toggle("online", online);
  statusEl.lastChild.textContent = online ? "即時連線" : "重新連線中";
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char],
  );
}

window.addEventListener("keydown", (event) => {
  if (
    event.target instanceof HTMLElement &&
    event.target.closest("button, a, input, select, textarea")
  ) {
    return;
  }
  if (["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
    event.preventDefault();
    window.parent.postMessage({ type: "live-deck-key", key: event.key }, "*");
  }
});

fetch(`${apiBase}/state`)
  .then((response) => response.json())
  .then(render)
  .catch(() => {});
setDashboardTab(location.hash === "#polls" ? "polls" : "live");
connect();

function applyConfig(nextConfig) {
  document.title = `${nextConfig.dashboardTitle} · Live Deck`;
  setDifficultyLabels(nextConfig.difficulty.labels);
  const values = {
    eyebrow: nextConfig.eyebrow,
    dashboardTitle: nextConfig.dashboardTitle,
    "question.title": nextConfig.question.title,
  };
  document.querySelectorAll("[data-config]").forEach((element) => {
    const value = values[element.dataset.config];
    if (typeof value === "string") element.textContent = value;
  });
  document.documentElement.style.setProperty("--forest", nextConfig.theme.background);
  document.documentElement.style.setProperty("--clay", nextConfig.theme.highlight);
  document.documentElement.style.setProperty("--sage", nextConfig.theme.accent);
  document.documentElement.style.setProperty("--panel", nextConfig.theme.panel);
  document.documentElement.style.setProperty("--positive", nextConfig.theme.positive);
  document.querySelector("[data-reaction-legend]").innerHTML = nextConfig.reactions
    .map((reaction) => `<b>${escapeHtml(reaction.emoji)}</b>`)
    .join("");
}
