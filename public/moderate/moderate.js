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
  loginMessage.textContent = "Checking";
  try {
    await loadState();
    sessionStorage.setItem(tokenKey, token);
    loginMessage.textContent = "";
  } catch {
    token = "";
    sessionStorage.removeItem(tokenKey);
    loginMessage.textContent = "The moderator token was not accepted";
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
  statusEl.textContent = "Moderator connected";
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
    : `<div class="empty">No questions yet</div>`;
}

function questionCard(question) {
  const isPublic = question.visibility === "public";
  const status = question.visibility === "pending" ? "WAITING" : isPublic ? "PUBLIC" : "AUTHOR ONLY";
  return `<article class="moderator-card visibility-${escapeHtml(question.visibility)}" data-question-id="${escapeHtml(question.id)}" data-voter-id="${escapeHtml(question.voterId)}">
    <div class="moderator-card-head"><b>${status}</b><time>${formatTime(question.createdAt)}</time></div>
    <p>${escapeHtml(question.text)}</p>
    <div class="moderator-meta"><span>${escapeHtml(question.nickname)}</span><span>${question.difficulty} · ${escapeHtml(question.lens)}</span></div>
    <label>Reason
      <select>
        <option value="disruption">Flooding or deliberate disruption</option>
        <option value="harassment">Harassment or personal attack</option>
        <option value="off_topic">Seriously off topic</option>
        <option value="privacy">Private information</option>
        <option value="other">Other</option>
      </select>
    </label>
    <div class="moderator-actions">
      ${isPublic || question.visibility === "pending" ? `<button class="danger" data-action="hide">Hide</button>` : `<button data-action="restore-question">Restore question</button>`}
      <button data-action="slow">Slow 10 min</button>
      <button data-action="review">Review future</button>
      <button data-action="mute">Mute questions</button>
      <button data-action="restore">Restore participant</button>
    </div>
  </article>`;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void loadState().catch(() => {
    statusEl.textContent = "Reconnecting";
  }), 180);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/api/live`);
  socket.addEventListener("open", () => {
    statusEl.textContent = "Moderator connected";
  });
  socket.addEventListener("message", (event) => {
    if (!token || document.visibilityState !== "visible") return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === "snapshot") scheduleRefresh();
    } catch {
      // ping/pong and malformed messages do not require a moderator refresh.
    }
  });
  socket.addEventListener("close", () => {
    statusEl.textContent = "Reconnecting";
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
