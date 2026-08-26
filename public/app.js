import { difficultyLabels, renderDifficultyChart, setDifficultyLabels } from "./difficulty.js";

const apiBase = "/api";
const config = await fetch("/event.config.json").then((response) => response.json());
applyConfig(config);
const voterKey = `${config.eventId}:live-deck-voter`;
const voterId = localStorage.getItem(voterKey) || crypto.randomUUID();
localStorage.setItem(voterKey, voterId);
const moderationEnabled = Boolean(config.moderation?.enabled);

const pollsRoot = document.querySelector("#polls");
const questionsRoot = document.querySelector("#questions");
const form = document.querySelector("#question-form");
const statusEl = document.querySelector("[data-status]");
const messageEl = document.querySelector("[data-form-message]");
const difficultyInput = document.querySelector("#difficulty");
const difficultyValueEl = document.querySelector("[data-difficulty-value]");
const difficultyLabelEl = document.querySelector("[data-difficulty-label]");
const difficultyMessageEl = document.querySelector("[data-difficulty-message]");
const reactionMessageEl = document.querySelector("[data-reaction-message]");
const identityGate = document.querySelector("#identity-gate");
const identityForm = document.querySelector("#identity-form");
const identityMessageEl = document.querySelector("[data-identity-message]");
const participantProfileEl = document.querySelector("#participant-profile");
const participantLabelEl = document.querySelector("[data-participant-label]");
const mySubmissionsEl = document.querySelector("#my-submissions");
const ownQuestionsRoot = document.querySelector("[data-own-questions]");
let participantState = { participant: null, questions: [] };
let state = {
  session: { mode: "open" },
  polls: [],
  difficulty: { counts: [0, 0, 0, 0, 0], total: 0, average: null },
  questions: [],
};
let socket;
let difficultyTimer;
const savedDifficulty = Number(localStorage.getItem("difficulty:current"));
let currentDifficulty =
  Number.isInteger(savedDifficulty) && savedDifficulty >= 1 && savedDifficulty <= 5
    ? savedDifficulty
    : 3;
difficultyInput.value = String(currentDifficulty);
const lensLabels = Object.fromEntries(config.question.lenses.map((lens) => [lens.id, lens.label]));

identityForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(identityForm);
  const button = identityForm.querySelector("button[type=submit]");
  button.disabled = true;
  identityMessageEl.textContent = "正在儲存這次活動使用的名字…";
  try {
    participantState = await post("/api/participant", {
      alias: String(data.get("alias") || ""),
      cocVersion: config.moderation.codeOfConduct.version,
      voterId,
    });
    identityMessageEl.textContent = "已儲存本場次使用的名字";
    renderParticipant();
  } catch (error) {
    identityMessageEl.textContent = humanError(error);
  } finally {
    button.disabled = false;
  }
});

updateDifficultySelection(currentDifficulty);
difficultyInput.addEventListener("input", () => {
  currentDifficulty = Number(difficultyInput.value);
  localStorage.setItem("difficulty:current", String(currentDifficulty));
  updateDifficultySelection(currentDifficulty);
  difficultyMessageEl.textContent = "正在更新…";
  clearTimeout(difficultyTimer);
  difficultyTimer = setTimeout(() => {
    post("/api/difficulty", { score: currentDifficulty, voterId })
      .then((nextState) => {
        state = nextState;
        difficultyMessageEl.textContent = "已同步到講者畫面";
        render();
      })
      .catch(() => {
        difficultyMessageEl.textContent = "同步失敗，請再調整一次";
      });
  }, 220);
});

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    document
      .querySelectorAll("[data-tab]")
      .forEach((item) => item.classList.toggle("active", item === button));
    document
      .querySelectorAll("[data-panel]")
      .forEach((panel) =>
        panel.classList.toggle("active", panel.dataset.panel === button.dataset.tab),
      );
  });
});

document.querySelectorAll("[data-reaction]").forEach((button) => {
  button.addEventListener("click", async () => {
    const kind = button.dataset.reaction;
    button.disabled = true;
    try {
      await post("/api/reaction", { kind, voterId });
      reactionMessageEl.textContent = `${button.firstChild.textContent.trim()} 已送出`;
      button.classList.remove("sent");
      void button.offsetWidth;
      button.classList.add("sent");
      setTimeout(() => button.classList.remove("sent"), 700);
    } catch (error) {
      reactionMessageEl.textContent = String(error?.message || "").includes("rate limit")
        ? "反應送得有點快，請等幾秒"
        : "反應沒有送出，請再試一次";
    } finally {
      setTimeout(() => {
        button.disabled = false;
      }, 350);
    }
  });
});

const questionInput = form.querySelector("#question");
const questionHintEl = form.querySelector("[data-question-hint]");
questionInput.addEventListener("input", () => {
  questionInput.classList.remove("input-warning");
  questionHintEl.hidden = true;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (questionInput.value.trim().length < 4) {
    questionInput.classList.add("input-warning");
    questionHintEl.hidden = false;
    questionInput.focus();
    questionInput.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  const data = new FormData(form);
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  messageEl.textContent = "正在送出…";
  try {
    const result = await post("/api/question", {
      text: String(data.get("question") || ""),
      lens: String(data.get("lens") || "clarify"),
      difficulty: currentDifficulty,
      voterId,
    });
    state = result.snapshot;
    participantState.questions = [
      result.submission,
      ...participantState.questions.filter((question) => question.id !== result.submission.id),
    ].slice(0, 20);
    form.querySelector("textarea").value = "";
    messageEl.textContent =
      result.submission.visibility === "public"
        ? "已加入問題池"
        : "已收到，公開前會先等待審核";
    render();
    renderParticipant();
  } catch (error) {
    messageEl.textContent = humanError(error);
  } finally {
    button.disabled = false;
  }
});

async function vote(pollId, optionIndex) {
  state = await post("/api/vote", { pollId, optionIndex, voterId });
  localStorage.setItem(`vote:${pollId}`, String(optionIndex));
  render();
}

async function upvote(questionId) {
  state = await post("/api/upvote", { questionId, voterId });
  if (localStorage.getItem(`upvote:${questionId}`)) {
    localStorage.removeItem(`upvote:${questionId}`);
  } else {
    localStorage.setItem(`upvote:${questionId}`, "1");
  }
  render();
}

async function flagQuestion(questionId, reason) {
  if (!participantState.participant) throw new Error("code of conduct must be accepted");
  const result = await post("/api/flag", { questionId, reason, voterId });
  localStorage.setItem(`flag:${questionId}`, reason);
  if (result.held) state.questions = state.questions.filter((question) => question.id !== questionId);
  render();
}

async function post(path, body) {
  const response = await fetch(`${apiBase}${path.slice(4)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "request failed");
  return data;
}

function render() {
  renderDifficultyChart(document.querySelector(".difficulty-card"), state.difficulty);
  pollsRoot.innerHTML = state.polls
    .map((poll, index) => {
      const selected = Number(localStorage.getItem(`vote:${poll.id}`));
      const hasVote = Number.isInteger(selected) && selected >= 0;
      return `
      <article class="poll-card">
        <div class="poll-meta"><span>${escapeHtml(poll.prompt)}</span><span>${poll.total} 票</span></div>
        <h2><span>${String(index + 1).padStart(2, "0")}</span>${escapeHtml(poll.question)}</h2>
        <div class="options">
          ${poll.options
            .map((option, optionIndex) => {
              const percent = poll.total
                ? Math.round((poll.counts[optionIndex] / poll.total) * 100)
                : 0;
              return `<button class="option ${hasVote && selected === optionIndex ? "selected" : ""}" data-poll="${poll.id}" data-option="${optionIndex}">
              <span class="bar" style="--pct:${percent}%"></span>
              <span class="option-copy"><b>${String.fromCharCode(65 + optionIndex)}</b>${escapeHtml(option)}</span>
              <span class="percent">${poll.counts[optionIndex]} 票</span>
            </button>`;
            })
            .join("")}
        </div>
      </article>`;
    })
    .join("");

  pollsRoot.querySelectorAll("[data-poll]").forEach((button) => {
    button.addEventListener("click", () =>
      vote(button.dataset.poll, Number(button.dataset.option)).catch((error) =>
        alert(humanError(error)),
      ),
    );
  });

  document.querySelectorAll("[data-question-count]").forEach((el) => {
    el.textContent = `${state.questions.length} 個問題`;
  });
  const rankedQuestions = [...state.questions].sort(
    (first, second) =>
      second.upvotes - first.upvotes || Number(second.createdAt) - Number(first.createdAt),
  );
  questionsRoot.innerHTML = rankedQuestions.length
    ? rankedQuestions
        .map(
          (question, index) => `
    <article class="question-card">
      <div class="question-rank">${String(index + 1).padStart(2, "0")}</div>
      <div><div class="question-tags"><span class="question-lens">${escapeHtml(lensLabels[question.lens] || lensLabels.clarify)}</span><span class="question-difficulty difficulty-${question.difficulty}">${question.difficulty} · ${escapeHtml(difficultyLabels[question.difficulty - 1] || difficultyLabels[2])}</span></div><p>${escapeHtml(question.text)}</p><span>${escapeHtml(question.nickname)}</span></div>
      <div class="question-actions">
        ${participantState.questions.some((item) => item.id === question.id)
          ? `<span class="flagged-label">你的問題</span>`
          : `<button class="upvote ${localStorage.getItem(`upvote:${question.id}`) ? "selected" : ""}" data-upvote="${question.id}" aria-label="我也想問這個問題">我也想問 <b>${question.upvotes}</b></button>`}
        ${renderFlagControl(question)}
      </div>
    </article>`,
        )
        .join("")
    : `<div class="empty">第一個問題，也可能改變接下來的討論方向</div>`;
  questionsRoot.querySelectorAll("[data-upvote]").forEach((button) => {
    button.addEventListener("click", () =>
      upvote(button.dataset.upvote).catch((error) => alert(humanError(error))),
    );
  });
  questionsRoot.querySelectorAll("[data-flag-reason]").forEach((button) => {
    button.addEventListener("click", () => {
      const details = button.closest("details");
      details.open = false;
      flagQuestion(button.dataset.questionId, button.dataset.flagReason).catch((error) =>
        alert(humanError(error)),
      );
    });
  });
  syncQuestionAvailability();
}

function renderFlagControl(question) {
  if (!config.moderation?.flags?.enabled) return "";
  if (participantState.questions.some((item) => item.id === question.id)) return "";
  const reported = localStorage.getItem(`flag:${question.id}`);
  if (reported) return `<span class="flagged-label">已檢舉</span>`;
  return `<details class="flag-control">
    <summary>檢舉</summary>
    <div class="flag-menu" role="group" aria-label="檢舉這個問題">
      <button type="button" data-question-id="${question.id}" data-flag-reason="harassment">騷擾或人身攻擊</button>
      <button type="button" data-question-id="${question.id}" data-flag-reason="disruption">刻意干擾討論</button>
      <button type="button" data-question-id="${question.id}" data-flag-reason="off_topic">嚴重離題</button>
      <button type="button" data-question-id="${question.id}" data-flag-reason="privacy">私密資料</button>
    </div>
  </details>`;
}

function renderParticipant() {
  if (!moderationEnabled) {
    identityGate.hidden = true;
    participantProfileEl.hidden = true;
    form.hidden = false;
    mySubmissionsEl.hidden = true;
    return;
  }
  const participant = participantState.participant;
  identityGate.hidden = Boolean(participant);
  participantProfileEl.hidden = !participant;
  form.hidden = !participant;
  if (participant) participantLabelEl.textContent = participant.publicLabel;
  const held = participantState.questions.filter((question) => question.visibility !== "public");
  mySubmissionsEl.hidden = held.length === 0;
  if (held.length === 0 && messageEl.textContent.includes("公開前會先等待審核")) {
    messageEl.textContent = "已公開到問題池";
  }
  ownQuestionsRoot.innerHTML = held
    .map(
      (question) => `<article class="question-card own-question">
        <div class="question-rank">${escapeHtml(question.visibility === "pending" ? "待審" : "暫緩")}</div>
        <div><div class="question-tags"><span class="question-status">${escapeHtml(question.statusLabel)}</span></div><p>${escapeHtml(question.text)}</p><span>${escapeHtml(question.nickname)}</span></div>
      </article>`,
    )
    .join("");
  syncQuestionAvailability();
}

function syncQuestionAvailability() {
  const mode = state.session?.mode || "open";
  const participant = participantState.participant;
  const blockedBySession = mode === "paused" || mode === "closed";
  const interactionClosed = mode === "closed";
  const blockedByModerator = participant?.questionState === "muted";
  const button = form.querySelector("button[type=submit]");
  if (button) button.disabled = blockedBySession || blockedByModerator;
  difficultyInput.disabled = interactionClosed;
  document.querySelectorAll("[data-reaction], [data-poll], [data-upvote], [data-flag-reason]").forEach((control) => {
    control.disabled = interactionClosed;
  });
  if (blockedBySession) {
    messageEl.textContent = mode === "closed" ? "本場次已關閉提問" : "目前暫停接受問題";
  }
  if (interactionClosed) {
    difficultyMessageEl.textContent = "本場次互動已結束";
    reactionMessageEl.textContent = "本場次互動已結束";
  }
  if (blockedByModerator) messageEl.textContent = "你在本場次的提問權限目前受到限制";
}

function updateDifficultySelection(score) {
  difficultyValueEl.textContent = String(score);
  difficultyLabelEl.textContent = difficultyLabels[score - 1];
  difficultyInput.style.setProperty("--difficulty-position", `${((score - 1) / 4) * 100}%`);
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}${apiBase}/live`);
  socket.addEventListener("open", () => {
    setStatus(true);
    socket.send(JSON.stringify({ type: "identify", voterId }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "snapshot") {
      state = message.data;
      render();
    }
    if (message.type === "participant") {
      participantState = message.data;
      renderParticipant();
    }
  });
  socket.addEventListener("close", () => {
    setStatus(false);
    setTimeout(connect, 1500);
  });
}

function setStatus(online) {
  statusEl.classList.toggle("online", online);
  statusEl.lastChild.textContent = online ? "即時連線" : "正在重新連線…";
}

function humanError(error) {
  const message = String(error?.message || error);
  if (message.includes("flag limit")) return "這台裝置已達本場次的檢舉上限";
  if (message.includes("reaction rate limit")) return "反應送得有點快，請等幾秒";
  if (message.includes("question rate limit")) return "短時間內送出的問題太多，請稍後再試";
  if (message.includes("limit")) return "這台裝置已達本場次的提問上限";
  if (message.includes("cooldown")) return "請稍等一下再送出下一個問題";
  if (message.includes("paused")) return "目前暫停接受問題";
  if (message.includes("closed")) return "本場次已關閉提問";
  if (message.includes("code of conduct")) return "請先同意討論守則";
  if (message.includes("upvote your own question")) return "不能替自己的問題按「我也想問」";
  if (message.includes("flag your own question")) return "不能檢舉自己的問題";
  if (message.includes("question not found")) return "這個問題已經不在公開問題池中";
  if (message.includes("access is limited")) return "你在本場次的提問權限目前受到限制";
  if (message.includes("question too short"))
    return "問題至少要有 4 個字，大家才看得懂你想問什麼";
  if (message.includes("alias")) return "本場次使用的名字至少要有 2 個字";
  return "送出失敗，請稍後再試";
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char],
  );
}

fetch(`${apiBase}/state`)
  .then((response) => response.json())
  .then((data) => {
    state = data;
    render();
  })
  .catch(() => {});
post("/api/me", { voterId })
  .then((data) => {
    participantState = data;
    renderParticipant();
  })
  .catch(() => renderParticipant());
post("/api/difficulty", { score: currentDifficulty, voterId })
  .then((data) => {
    state = data;
    difficultyMessageEl.textContent = "已同步到講者畫面";
    render();
  })
  .catch(() => {
    difficultyMessageEl.textContent = "拖曳後會自動更新";
  });
connect();

function applyConfig(nextConfig) {
  document.title = nextConfig.title;
  setDifficultyLabels(nextConfig.difficulty.labels);
  const values = {
    eyebrow: nextConfig.eyebrow,
    title: nextConfig.title,
    description: nextConfig.description,
    dashboardTitle: nextConfig.dashboardTitle,
    "difficulty.title": nextConfig.difficulty.title,
    "question.title": nextConfig.question.title,
  };
  document.querySelectorAll("[data-config]").forEach((element) => {
    const value = values[element.dataset.config];
    if (typeof value === "string") element.textContent = value;
  });
  document.querySelectorAll("[data-config-placeholder]").forEach((element) => {
    const value = nextConfig.question.placeholder;
    if (typeof value === "string") element.setAttribute("placeholder", value);
  });
  document.querySelectorAll("[data-config-href='deckUrl']").forEach((element) => {
    element.href = nextConfig.deckUrl;
  });
  document.documentElement.style.setProperty("--forest", nextConfig.theme.background);
  document.documentElement.style.setProperty("--clay", nextConfig.theme.highlight);
  document.documentElement.style.setProperty("--sage", nextConfig.theme.accent);
  document.documentElement.style.setProperty("--panel", nextConfig.theme.panel);
  document.documentElement.style.setProperty("--positive", nextConfig.theme.positive);
  document.querySelector("[data-difficulty-scale]").innerHTML = nextConfig.difficulty.labels
    .map((label) => `<span>${escapeHtml(label)}</span>`)
    .join("");
  document.querySelector("[data-reactions]").innerHTML = nextConfig.reactions
    .map(
      (reaction) =>
        `<button type="button" data-reaction="${escapeHtml(reaction.id)}" aria-label="${escapeHtml(reaction.label)}">${escapeHtml(reaction.emoji)}<span>${escapeHtml(reaction.label)}</span></button>`,
    )
    .join("");
  document.querySelector("[data-lenses]").innerHTML = nextConfig.question.lenses
    .map(
      (lens, index) => `<label class="intent-option">
        <input type="radio" name="lens" value="${escapeHtml(lens.id)}" ${index === 0 ? "checked" : ""} />
        <span><b>${escapeHtml(lens.label)}</b><small>${escapeHtml(lens.description)}</small></span>
      </label>`,
    )
    .join("");
  if (nextConfig.moderation?.enabled) {
    document.querySelector("[data-coc-title]").textContent = nextConfig.moderation.codeOfConduct.title;
    document.querySelector("[data-coc-summary]").textContent = nextConfig.moderation.codeOfConduct.summary;
    document.querySelector("[data-coc-rules]").innerHTML = nextConfig.moderation.codeOfConduct.rules
      .map((rule) => `<li>${escapeHtml(rule)}</li>`)
      .join("");
  }
}
