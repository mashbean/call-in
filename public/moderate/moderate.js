import { initI18n, t } from "../i18n.js";

const eventConfig = await fetch("/event.config.json")
  .then((response) => response.json())
  .catch(() => ({}));
await initI18n(eventConfig.locale);

const tokenKey = "live-deck:moderator-token";
const loginPanel = document.querySelector("[data-login-panel]");
const loginForm = document.querySelector("[data-login-form]");
const loginMessage = document.querySelector("[data-login-message]");
const app = document.querySelector("[data-moderator-app]");
const statusEl = document.querySelector("[data-moderator-status]");
const questionsRoot = document.querySelector("[data-moderator-questions]");
const modeGrid = document.querySelector("[data-mode-grid]");
let token = sessionStorage.getItem(tokenKey) || "";
let state = null;
let socket;
let refreshTimer;

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const nextToken = String(new FormData(loginForm).get("token") || "");
  token = nextToken;
  loginMessage.textContent = t("moderate.checking");
  try {
    await loadState();
    sessionStorage.setItem(tokenKey, token);
    loginMessage.textContent = "";
  } catch {
    token = "";
    sessionStorage.removeItem(tokenKey);
    loginMessage.textContent = t("moderate.tokenRejected");
  }
});

document.querySelector("[data-refresh]").addEventListener("click", () => void loadState());

modeGrid.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-mode]");
  if (!button) return;
  await runAction(button, "/api/moderator/session", { mode: button.dataset.mode });
});

questionsRoot.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest("[data-question-id]");
  const reason = card.querySelector("select").value;
  const action = button.dataset.action;
  if (action === "hide" || action === "restore-question") {
    await runAction(button, "/api/moderator/question", {
      questionId: card.dataset.questionId,
      action: action === "hide" ? "hide" : "restore",
      reason,
    });
    return;
  }
  await runAction(button, "/api/moderator/participant", {
    voterId: card.dataset.voterId,
    action,
    reason,
  });
});

async function runAction(button, path, body) {
  button.disabled = true;
  try {
    state = await request(path, { method: "POST", body: JSON.stringify(body) });
    render();
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loadState() {
  if (!token) return;
  state = await request("/api/moderator/state");
  loginPanel.hidden = true;
  app.hidden = false;
  statusEl.textContent = t("moderate.connected");
  render();
  connect();
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 404 ? "Moderator access required" : data.error || "Request failed");
  return data;
}

function render() {
  if (!state) return;
  modeGrid.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.session.mode);
  });
  questionsRoot.innerHTML = state.questions.length
    ? state.questions.map(questionCard).join("")
    : `<div class="empty">${escapeHtml(t("moderate.empty"))}</div>`;
}

function questionCard(question) {
  const isPublic = question.visibility === "public";
  const isCommunityHold = question.visibility === "author_only" && question.flagCount > 0;
  const status = t(
    question.visibility === "pending"
      ? "moderate.status.waiting"
      : isPublic
        ? "moderate.status.public"
        : "moderate.status.authorOnly",
  );
  const flagReasons = Object.entries(question.flagReasons || {})
    .map(([reason, count]) => `${count} ${flagReasonLabel(reason)}`)
    .join(" · ");
  const selectedReason = defaultReason(question);
  return `<article class="moderator-card visibility-${escapeHtml(question.visibility)}" data-question-id="${escapeHtml(question.id)}" data-voter-id="${escapeHtml(question.voterId)}">
    <div class="moderator-card-head"><b>${escapeHtml(status)}</b><time>${formatTime(question.createdAt)}</time></div>
    ${question.flagCount ? `<div class="flag-summary"><b>${escapeHtml(t("moderate.flags.reports", { count: question.flagCount }))}</b><span>${escapeHtml(t("moderate.flags.threshold", { weight: question.flagWeight, threshold: question.flagThreshold }))}</span><small>${escapeHtml(flagReasons)}</small></div>` : ""}
    <p>${escapeHtml(question.text)}</p>
    <div class="moderator-meta"><span>${escapeHtml(question.nickname)}</span><span>${question.difficulty} · ${escapeHtml(question.lens)}</span></div>
    <label>${escapeHtml(t("moderate.reasonLabel"))}
      <select>
        <option value="disruption" ${selectedReason === "disruption" ? "selected" : ""}>${escapeHtml(t("moderate.reason.disruption"))}</option>
        <option value="harassment" ${selectedReason === "harassment" ? "selected" : ""}>${escapeHtml(t("moderate.reason.harassment"))}</option>
        <option value="off_topic" ${selectedReason === "off_topic" ? "selected" : ""}>${escapeHtml(t("moderate.reason.offTopic"))}</option>
        <option value="privacy" ${selectedReason === "privacy" ? "selected" : ""}>${escapeHtml(t("moderate.reason.privacy"))}</option>
        <option value="other" ${selectedReason === "other" ? "selected" : ""}>${escapeHtml(t("moderate.reason.other"))}</option>
      </select>
    </label>
    <div class="moderator-actions">
      ${isPublic || question.visibility === "pending" ? `<button class="danger" data-action="hide">${escapeHtml(t("moderate.action.hide"))}</button>` : isCommunityHold ? `<button class="danger" data-action="hide">${escapeHtml(t("moderate.action.confirmHidden"))}</button><button data-action="restore-question">${escapeHtml(t("moderate.action.restoreQuestion"))}</button>` : `<button data-action="restore-question">${escapeHtml(t("moderate.action.restoreQuestion"))}</button>`}
      <button data-action="slow">${escapeHtml(t("moderate.action.slow"))}</button>
      <button data-action="review">${escapeHtml(t("moderate.action.review"))}</button>
      <button data-action="mute">${escapeHtml(t("moderate.action.mute"))}</button>
      <button data-action="restore">${escapeHtml(t("moderate.action.restoreParticipant"))}</button>
    </div>
  </article>`;
}

function defaultReason(question) {
  const ranked = Object.entries(question.flagReasons || {}).sort((left, right) => right[1] - left[1]);
  return ranked[0]?.[0] || question.moderationReason || "disruption";
}

function flagReasonLabel(reason) {
  const key = `moderate.flagReason.${reason === "off_topic" ? "offTopic" : reason}`;
  const label = t(key);
  return label === key ? reason : label;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void loadState().catch(() => {
    statusEl.textContent = t("status.reconnecting");
  }), 180);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/api/live`);
  socket.addEventListener("open", () => {
    statusEl.textContent = t("moderate.connected");
  });
  socket.addEventListener("message", (event) => {
    if (!token || document.visibilityState !== "visible") return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === "snapshot" || message.type === "moderation-activity") scheduleRefresh();
    } catch {
      // ping/pong and malformed messages do not require a moderator refresh.
    }
  });
  socket.addEventListener("close", () => {
    statusEl.textContent = t("status.reconnecting");
    setTimeout(connect, 1500);
  });
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character],
  );
}

if (token) void loadState().catch(() => {
  token = "";
  sessionStorage.removeItem(tokenKey);
});
