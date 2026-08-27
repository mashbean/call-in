import {
  difficultyLabels,
  renderDifficultyChart,
  setDifficultyCopy,
  setDifficultyLabels,
} from "../difficulty.js";
import { eventApi, eventContext, eventPage } from "../event-context.js";
import { createLocale } from "../i18n.js";

document.documentElement.classList.toggle("embedded-dashboard", window.self !== window.top);

const apiBase = eventContext.apiBase;
const config = await fetch(eventApi("/config")).then((response) => response.json());
const locale = createLocale(config);
const t = locale.text;
const reactionTimes = new Map();
locale.apply();
if (locale.zhHant) {
  setDifficultyCopy({ responses: "筆回覆", average: "平均", waiting: "等待第一筆回覆" });
}
applyConfig(config);
document.querySelectorAll("[data-qr-image]").forEach((image) => {
  image.src = eventApi("/qr.svg");
});
document.querySelectorAll("[data-audience-url]").forEach((link) => {
  link.href = eventPage("/");
});
const pollsRoot = document.querySelector("#dashboard-polls");
const questionsRoot = document.querySelector("#dashboard-questions");
const statusEl = document.querySelector("[data-status]");
const reactionStage = document.querySelector("[data-reaction-stage]");
const tabButtons = [...document.querySelectorAll("[data-dashboard-tab]")];
const tabPanels = [...document.querySelectorAll("[data-dashboard-panel]")];
const lensLabels = Object.fromEntries(config.question.lenses.map((lens) => [lens.id, lens.label]));

function render(state) {
  const mode = state.session?.mode || "open";
  const modeEl = document.querySelector("[data-session-mode]");
  modeEl.textContent = locale.zhHant
    ? ({ open: "開放", slow: "慢速", approval: "需審核", paused: "暫停", closed: "關閉" })[
        mode
      ] || mode
    : mode.toUpperCase();
  modeEl.dataset.mode = mode;
  renderDifficultyChart(document.querySelector(".dashboard-difficulty"), state.difficulty);
  document.querySelector("[data-poll-total]").textContent = t(
    `${state.polls.length} polls`,
    `${state.polls.length} 場`,
  );
  pollsRoot.innerHTML = state.polls
    .map(
      (poll, index) => `
        <article class="dashboard-poll">
          <div class="dashboard-poll-head"><b>${String(index + 1).padStart(2, "0")}</b><span>${poll.total} ${t("votes", "票")}</span></div>
          <h3>${escapeHtml(poll.question)}</h3>
          ${poll.options
            .map((option, optionIndex) => {
              const percent = poll.total
                ? Math.round((poll.counts[optionIndex] / poll.total) * 100)
                : 0;
              return `<div class="dashboard-result-row"><span>${escapeHtml(option)}</span><div><i style="--pct:${percent}%"></i></div><b>${poll.counts[optionIndex]} ${t("votes", "票")}</b></div>`;
            })
            .join("")}
        </article>`,
    )
    .join("");

  document.querySelector("[data-question-count]").textContent = t(
    `${state.questions.length} questions`,
    `${state.questions.length} 個問題`,
  );
  const rankedQuestions = [...state.questions].sort(
    (first, second) =>
      second.upvotes - first.upvotes || Number(second.createdAt) - Number(first.createdAt),
  );
  const newestId = state.questions.reduce(
    (newest, question) =>
      !newest || Number(question.createdAt) > Number(newest.createdAt) ? question : newest,
    null,
  )?.id;
  questionsRoot.innerHTML = rankedQuestions.length
    ? rankedQuestions
        .map(
          (question, index) => `
            <article>
              <div class="dashboard-question-head"><b>${question.id === newestId ? t("NEW", "最新") : String(index + 1).padStart(2, "0")}</b><span><time>${formatTime(question.createdAt)}</time> · ${t("Me too", "我也想問")} ${question.upvotes}</span></div>
              <div class="question-tags"><span class="question-lens">${escapeHtml(lensLabels[question.lens] || lensLabels.clarify)}</span><span class="question-difficulty difficulty-${question.difficulty}">${question.difficulty} · ${escapeHtml(difficultyLabels[question.difficulty - 1] || difficultyLabels[2])}</span></div>
              <p>${escapeHtml(question.text)}</p>
              <small>${escapeHtml(question.nickname)}</small>
            </article>`,
        )
        .join("")
    : `<div class="empty">${t("Waiting for the first question", "等待第一個問題")}</div>`;
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
    : t("just now", "剛剛");
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

function renderReactionLegend() {
  const legend = document.querySelector("[data-reaction-legend]");
  const now = Date.now();
  legend.innerHTML = config.reactions
    .map((reaction) => {
      const times = (reactionTimes.get(reaction.id) || []).filter((time) => now - time < 60_000);
      reactionTimes.set(reaction.id, times);
      return `<span class="reaction-legend-item"><b>${escapeHtml(reaction.emoji)}</b>${escapeHtml(reaction.label)}<i>${times.length || ""}</i></span>`;
    })
    .join("");
}
setInterval(renderReactionLegend, 5000);

function showReaction(reaction) {
  if (config.reactions.some((item) => item.id === reaction?.kind)) {
    const times = reactionTimes.get(reaction.kind) || [];
    times.push(Date.now());
    reactionTimes.set(reaction.kind, times);
    renderReactionLegend();
  }
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
  statusEl.lastChild.textContent = online
    ? t("Live", "即時連線")
    : t("Reconnecting", "重新連線中");
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
  document.title = `${nextConfig.dashboardTitle} · Call-in`;
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
  renderReactionLegend();
}

const qrModal = document.querySelector("[data-qr-modal]");
const qrOpenButton = document.querySelector("[data-qr-open]");
if (qrModal && qrOpenButton) {
  const qrCloseButton = qrModal.querySelector("[data-qr-close]");
  const modalBackground = [...document.body.children].filter(
    (element) => element !== qrModal && element.tagName !== "SCRIPT",
  );
  let previousFocus = null;

  function closeQrModal() {
    if (qrModal.hidden) return;
    qrModal.hidden = true;
    qrOpenButton.setAttribute("aria-expanded", "false");
    modalBackground.forEach((element) => {
      element.inert = false;
    });
    previousFocus?.focus();
  }

  const audienceUrl = `${location.origin}${eventPage("/")}`;
  const qrUrl = qrModal.querySelector("[data-qr-url]");
  qrUrl.textContent = audienceUrl.replace(/^https?:\/\//, "");
  qrUrl.href = eventPage("/");
  qrOpenButton.addEventListener("click", () => {
    previousFocus = document.activeElement;
    modalBackground.forEach((element) => {
      element.inert = true;
    });
    qrModal.hidden = false;
    qrOpenButton.setAttribute("aria-expanded", "true");
    qrCloseButton?.focus();
  });
  qrCloseButton?.addEventListener("click", closeQrModal);
  qrModal.addEventListener("click", (event) => {
    if (event.target === qrModal) closeQrModal();
  });
  document.addEventListener("keydown", (event) => {
    if (qrModal.hidden) return;
    if (event.key === "Escape") {
      closeQrModal();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...qrModal.querySelectorAll("a[href], button:not([disabled])")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
}
