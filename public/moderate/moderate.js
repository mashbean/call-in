const tokenKey = "live-deck:moderator-token";
const config = await fetch("/event.config.json").then((response) => response.json());
const lensLabels = Object.fromEntries(config.question.lenses.map((lens) => [lens.id, lens.label]));
const loginPanel = document.querySelector("[data-login-panel]");
const loginForm = document.querySelector("[data-login-form]");
const loginMessage = document.querySelector("[data-login-message]");
const app = document.querySelector("[data-moderator-app]");
const statusEl = document.querySelector("[data-moderator-status]");
const questionsRoot = document.querySelector("[data-moderator-questions]");
const modeGrid = document.querySelector("[data-mode-grid]");
const actionFeedback = new Map();
let token = sessionStorage.getItem(tokenKey) || "";
let state = null;
let socket;
let refreshTimer;

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const nextToken = String(new FormData(loginForm).get("token") || "");
  token = nextToken;
  loginMessage.textContent = "正在驗證…";
  try {
    await loadState();
    sessionStorage.setItem(tokenKey, token);
    loginMessage.textContent = "";
  } catch {
    token = "";
    sessionStorage.removeItem(tokenKey);
    loginMessage.textContent = "管理權杖不正確，請再檢查一次";
  }
});

document.querySelector("[data-refresh]").addEventListener("click", (event) => {
  void runAction(event.currentTarget, "/api/moderator/state", null, "問題列表已更新");
});

modeGrid.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-mode]");
  if (!button) return;
  await runAction(
    button,
    "/api/moderator/session",
    { mode: button.dataset.mode },
    `場次模式已切換為「${sessionModeLabel(button.dataset.mode)}」`,
  );
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
    }, actionSuccessMessage(action));
    return;
  }
  await runAction(button, "/api/moderator/participant", {
    voterId: card.dataset.voterId,
    action,
    reason,
  }, actionSuccessMessage(action));
});

async function runAction(button, path, body, successMessage) {
  const card = button.closest("[data-question-id]");
  setActionFeedback(card, "正在處理…", "pending");
  button.disabled = true;
  try {
    state = await request(path, body ? { method: "POST", body: JSON.stringify(body) } : {});
    render();
    if (card) {
      const nextCard = questionsRoot.querySelector(`[data-question-id="${CSS.escape(card.dataset.questionId)}"]`);
      setActionFeedback(nextCard, successMessage, "success");
    } else {
      statusEl.textContent = successMessage;
    }
  } catch (error) {
    const message = humanError(error);
    setActionFeedback(card, message, "error");
    statusEl.textContent = message;
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function loadState() {
  if (!token) return;
  state = await request("/api/moderator/state");
  loginPanel.hidden = true;
  app.hidden = false;
  statusEl.textContent = "管理頁已連線";
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
  if (!response.ok) {
    const error = new Error(data.error || "request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

function render() {
  if (!state) return;
  modeGrid.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.session.mode);
  });
  questionsRoot.innerHTML = state.questions.length
    ? state.questions.map(questionCard).join("")
    : `<div class="empty">目前還沒有問題</div>`;
}

function questionCard(question) {
  const isPublic = question.visibility === "public";
  const isCommunityHold = question.visibility === "author_only" && question.flagCount > 0;
  const status = question.visibility === "pending" ? "等待審核" : isPublic ? "公開" : "僅作者可見";
  const slowActive = Number(question.slowUntil) > Date.now();
  const participantStatus = participantStateLabel(question, slowActive);
  const flagReasons = Object.entries(question.flagReasons || {})
    .map(([reason, count]) => `${count} ${flagReasonLabel(reason)}`)
    .join(" · ");
  const selectedReason = defaultReason(question);
  const feedback = actionFeedback.get(question.id) || { message: "", status: "" };
  return `<article class="moderator-card visibility-${escapeHtml(question.visibility)}" data-question-id="${escapeHtml(question.id)}" data-voter-id="${escapeHtml(question.voterId)}">
    <div class="moderator-card-head"><b>${status}</b><time>${formatTime(question.createdAt)}</time></div>
    ${question.flagCount ? `<div class="flag-summary"><b>${question.flagCount} 次檢舉</b><span>加權門檻 ${question.flagWeight} / ${question.flagThreshold}</span><small>${escapeHtml(flagReasons)}</small></div>` : ""}
    <p>${escapeHtml(question.text)}</p>
    <div class="moderator-meta"><span>${escapeHtml(question.nickname)}</span><span>${question.difficulty} · ${escapeHtml(lensLabels[question.lens] || question.lens)}</span></div>
    <div class="participant-state" data-state="${escapeHtml(question.questionState)}">${escapeHtml(participantStatus)}</div>
    <label>處理原因
      <select>
        <option value="disruption" ${selectedReason === "disruption" ? "selected" : ""}>洗版或刻意干擾</option>
        <option value="harassment" ${selectedReason === "harassment" ? "selected" : ""}>騷擾或人身攻擊</option>
        <option value="off_topic" ${selectedReason === "off_topic" ? "selected" : ""}>嚴重離題</option>
        <option value="privacy" ${selectedReason === "privacy" ? "selected" : ""}>私密資料</option>
        <option value="other" ${selectedReason === "other" ? "selected" : ""}>其他</option>
      </select>
    </label>
    <div class="moderator-actions">
      ${isPublic || question.visibility === "pending" ? `<button class="danger" data-action="hide">隱藏問題</button>` : isCommunityHold ? `<button class="danger" data-action="hide">確認隱藏</button><button data-action="restore-question">恢復公開</button>` : `<button data-action="restore-question">恢復公開</button>`}
      <button data-action="slow" ${slowActive ? "disabled" : ""}>${slowActive ? "限速中" : "限速 10 分鐘"}</button>
      <button data-action="review" ${question.questionState === "review" ? "disabled" : ""}>${question.questionState === "review" ? "後續提問審核中" : "審核後續提問"}</button>
      <button data-action="mute" ${question.questionState === "muted" ? "disabled" : ""}>${question.questionState === "muted" ? "提問已暫停" : "暫停提問權限"}</button>
      <button data-action="restore" ${question.questionState === "normal" && !slowActive ? "disabled" : ""}>${question.questionState === "normal" && !slowActive ? "提問權限正常" : "恢復提問權限"}</button>
    </div>
    <div class="action-feedback" data-action-feedback data-status="${escapeHtml(feedback.status)}" aria-live="polite">${escapeHtml(feedback.message)}</div>
  </article>`;
}

function participantStateLabel(question, slowActive) {
  if (question.questionState === "muted") return "目前狀態　已暫停提問";
  if (question.questionState === "review") return "目前狀態　後續提問需先審核";
  if (slowActive) return `目前狀態　限速至 ${formatTime(question.slowUntil)}`;
  return "目前狀態　提問權限正常";
}

function actionSuccessMessage(action) {
  return ({
    hide: "問題已隱藏，只有原作者看得到",
    "restore-question": "問題已恢復公開",
    slow: "已將這名參與者限速 10 分鐘",
    review: "這名參與者的後續提問將先經過審核",
    mute: "已暫停這名參與者的提問權限",
    restore: "已恢復這名參與者的提問權限",
  })[action] || "操作已完成";
}

function sessionModeLabel(mode) {
  return ({ open: "開放", slow: "慢速", approval: "先審後發", paused: "暫停", closed: "關閉" })[mode] || mode;
}

function setActionFeedback(card, message, status) {
  if (card?.dataset.questionId) actionFeedback.set(card.dataset.questionId, { message, status });
  const feedback = card?.querySelector("[data-action-feedback]");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.dataset.status = status;
}

function defaultReason(question) {
  const ranked = Object.entries(question.flagReasons || {}).sort((left, right) => right[1] - left[1]);
  return ranked[0]?.[0] || question.moderationReason || "disruption";
}

function flagReasonLabel(reason) {
  return ({
    harassment: "騷擾或人身攻擊",
    disruption: "洗版或刻意干擾",
    off_topic: "嚴重離題",
    privacy: "私密資料",
  })[reason] || reason;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void loadState().catch(() => {
    statusEl.textContent = "正在重新連線…";
  }), 180);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/api/live`);
  socket.addEventListener("open", () => {
    statusEl.textContent = "管理頁已連線";
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
    statusEl.textContent = "正在重新連線…";
    setTimeout(connect, 1500);
  });
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function humanError(error) {
  if (error?.status === 404) return "需要有效的管理權杖";
  const message = String(error?.message || error);
  if (message.includes("participant not found")) return "找不到這名參與者，請重新整理後再試";
  if (message.includes("question not found")) return "找不到這個問題，可能已經被移除";
  if (message.includes("invalid")) return "操作內容無效，請重新整理後再試";
  return "操作失敗，請稍後再試";
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
