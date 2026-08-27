import { accessTokenKey, consumeAccessToken, eventContext } from "../event-context.js";
import { createLocale } from "../i18n.js";

const tokenKey = accessTokenKey("moderator");
const apiBase = eventContext.apiBase;
const config = await fetch(`${apiBase}/config`).then((response) => response.json());
const locale = createLocale(config);
const t = locale.text;
locale.apply();
document.title = t("Live Deck moderation", "Live Deck 主持工具");
const lensLabels = Object.fromEntries(config.question.lenses.map((lens) => [lens.id, lens.label]));
const loginPanel = document.querySelector("[data-login-panel]");
const loginForm = document.querySelector("[data-login-form]");
const loginMessage = document.querySelector("[data-login-message]");
const app = document.querySelector("[data-moderator-app]");
const statusEl = document.querySelector("[data-moderator-status]");
const questionsRoot = document.querySelector("[data-moderator-questions]");
const modeGrid = document.querySelector("[data-mode-grid]");
let token = consumeAccessToken("moderator");
let state = null;
let socket;
let refreshTimer;

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const nextToken = String(new FormData(loginForm).get("token") || "");
  token = nextToken;
  loginMessage.textContent = t("Checking", "驗證中");
  try {
    await loadState();
    sessionStorage.setItem(tokenKey, token);
    loginMessage.textContent = "";
  } catch {
    token = "";
    sessionStorage.removeItem(tokenKey);
    loginMessage.textContent = t(
      "The moderator token was not accepted",
      "主持存取碼不正確",
    );
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
  statusEl.textContent = t("Moderator connected", "主持控制台已連線");
  render();
  connect();
}

async function request(path, options = {}) {
  const requestPath = path.startsWith("/api/") ? `${apiBase}${path.slice(4)}` : path;
  const response = await fetch(requestPath, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? t("Moderator access required", "需要主持權限")
        : data.error || t("Request failed", "要求失敗"),
    );
  return data;
}

function render() {
  if (!state) return;
  modeGrid.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.session.mode);
  });
  questionsRoot.innerHTML = state.questions.length
    ? state.questions.map(questionCard).join("")
    : `<div class="empty">${t("No questions yet", "目前還沒有問題")}</div>`;
}

function questionCard(question) {
  const isPublic = question.visibility === "public";
  const isCommunityHold = question.visibility === "author_only" && question.flagCount > 0;
  const status =
    question.visibility === "pending"
      ? t("WAITING", "等待中")
      : isPublic
        ? t("PUBLIC", "已公開")
        : t("AUTHOR ONLY", "僅提問者可見");
  const flagReasons = Object.entries(question.flagReasons || {})
    .map(([reason, count]) => `${count} ${flagReasonLabel(reason)}`)
    .join(" · ");
  const selectedReason = defaultReason(question);
  return `<article class="moderator-card visibility-${escapeHtml(question.visibility)}" data-question-id="${escapeHtml(question.id)}" data-voter-id="${escapeHtml(question.voterId)}">
    <div class="moderator-card-head"><b>${status}</b><time>${formatTime(question.createdAt)}</time></div>
    ${question.flagCount ? `<div class="flag-summary"><b>${question.flagCount} ${t("reports", "次檢舉")}</b><span>${question.flagWeight} / ${question.flagThreshold} ${t("weighted threshold", "加權門檻")}</span><small>${escapeHtml(flagReasons)}</small></div>` : ""}
    <p>${escapeHtml(question.text)}</p>
    <div class="moderator-meta"><span>${escapeHtml(question.nickname)}</span><span>${question.difficulty} · ${escapeHtml(lensLabels[question.lens] || question.lens)}</span></div>
    <label>${t("Reason", "理由")}
      <select>
        <option value="disruption" ${selectedReason === "disruption" ? "selected" : ""}>${t("Flooding or deliberate disruption", "洗版或蓄意干擾")}</option>
        <option value="harassment" ${selectedReason === "harassment" ? "selected" : ""}>${t("Harassment or personal attack", "騷擾或人身攻擊")}</option>
        <option value="off_topic" ${selectedReason === "off_topic" ? "selected" : ""}>${t("Seriously off topic", "嚴重離題")}</option>
        <option value="privacy" ${selectedReason === "privacy" ? "selected" : ""}>${t("Private information", "私人資訊")}</option>
        <option value="other" ${selectedReason === "other" ? "selected" : ""}>${t("Other", "其他")}</option>
      </select>
    </label>
    <div class="moderator-actions">
      ${isPublic || question.visibility === "pending" ? `<button class="danger" data-action="hide">${t("Hide", "隱藏")}</button>` : isCommunityHold ? `<button class="danger" data-action="hide">${t("Confirm hidden", "確認隱藏")}</button><button data-action="restore-question">${t("Restore question", "恢復問題")}</button>` : `<button data-action="restore-question">${t("Restore question", "恢復問題")}</button>`}
      <button data-action="slow">${t("Slow 10 min", "慢速 10 分鐘")}</button>
      <button data-action="review">${t("Review future", "後續提問需審核")}</button>
      <button data-action="mute">${t("Mute questions", "暫停此人的提問")}</button>
      <button data-action="restore">${t("Restore participant", "恢復參與者")}</button>
    </div>
  </article>`;
}

function defaultReason(question) {
  const ranked = Object.entries(question.flagReasons || {}).sort((left, right) => right[1] - left[1]);
  return ranked[0]?.[0] || question.moderationReason || "disruption";
}

function flagReasonLabel(reason) {
  return ({
    harassment: t("harassment", "騷擾"),
    disruption: t("disruption", "干擾"),
    off_topic: t("off-topic", "離題"),
    privacy: t("privacy", "隱私"),
  })[reason] || reason;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void loadState().catch(() => {
    statusEl.textContent = t("Reconnecting", "重新連線中");
  }), 180);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}${apiBase}/live`);
  socket.addEventListener("open", () => {
    statusEl.textContent = t("Moderator connected", "主持控制台已連線");
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
    statusEl.textContent = t("Reconnecting", "重新連線中");
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
