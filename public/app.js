import { difficultyLabels, renderDifficultyChart, setDifficultyLabels } from "./difficulty.js";
import { initI18n, t } from "./i18n.js";

const apiBase = "/api";
const config = await fetch("/event.config.json").then((response) => response.json());
await initI18n(config.locale);
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
let awaitingPublicDisplay = false;
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
  identityMessageEl.textContent = t("audience.identity.saving");
  try {
    participantState = await post("/api/participant", {
      alias: String(data.get("alias") || ""),
      cocVersion: config.moderation.codeOfConduct.version,
      voterId,
    });
    identityMessageEl.textContent = t("audience.identity.saved");
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
  difficultyMessageEl.textContent = t("audience.difficulty.updating");
  clearTimeout(difficultyTimer);
  difficultyTimer = setTimeout(() => {
    post("/api/difficulty", { score: currentDifficulty, voterId })
      .then((nextState) => {
        state = nextState;
        difficultyMessageEl.textContent = t("audience.difficulty.synced");
        render();
      })
      .catch(() => {
        difficultyMessageEl.textContent = t("audience.difficulty.syncFailed");
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
      reactionMessageEl.textContent = t("audience.reactions.sent", {
        label: button.firstChild.textContent.trim(),
      });
      button.classList.remove("sent");
      void button.offsetWidth;
      button.classList.add("sent");
      setTimeout(() => button.classList.remove("sent"), 700);
    } catch (error) {
      reactionMessageEl.textContent = String(error?.message || "").includes("rate limit")
        ? t("audience.reactions.tooFast")
        : t("audience.reactions.failed");
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
  messageEl.textContent = t("audience.ask.sending");
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
    awaitingPublicDisplay = result.submission.visibility !== "public";
    messageEl.textContent = awaitingPublicDisplay
      ? t("audience.ask.buffered")
      : t("audience.ask.added");
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
        <div class="poll-meta"><span>${escapeHtml(poll.prompt)}</span><span>${escapeHtml(t("common.voteCount", { count: poll.total }))}</span></div>
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
              <span class="percent">${escapeHtml(t("common.voteCount", { count: poll.counts[optionIndex] }))}</span>
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
    el.textContent = t("common.questionCount", { count: state.questions.length });
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
          ? `<span class="flagged-label">${escapeHtml(t("audience.pool.yourQuestion"))}</span>`
          : `<button class="upvote ${localStorage.getItem(`upvote:${question.id}`) ? "selected" : ""}" data-upvote="${question.id}" aria-label="${escapeHtml(t("audience.pool.upvoteLabel"))}">${escapeHtml(t("audience.pool.upvote"))} <b>${question.upvotes}</b></button>`}
        ${renderFlagControl(question)}
      </div>
    </article>`,
        )
        .join("")
    : `<div class="empty">${escapeHtml(t("audience.pool.empty"))}</div>`;
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
  if (reported) return `<span class="flagged-label">${escapeHtml(t("audience.flag.reported"))}</span>`;
  return `<details class="flag-control">
    <summary>${escapeHtml(t("audience.flag.open"))}</summary>
    <div class="flag-menu" role="group" aria-label="${escapeHtml(t("audience.flag.menuLabel"))}">
      <button type="button" data-question-id="${question.id}" data-flag-reason="harassment">${escapeHtml(t("audience.flag.reason.harassment"))}</button>
      <button type="button" data-question-id="${question.id}" data-flag-reason="disruption">${escapeHtml(t("audience.flag.reason.disruption"))}</button>
      <button type="button" data-question-id="${question.id}" data-flag-reason="off_topic">${escapeHtml(t("audience.flag.reason.offTopic"))}</button>
      <button type="button" data-question-id="${question.id}" data-flag-reason="privacy">${escapeHtml(t("audience.flag.reason.privacy"))}</button>
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
  if (held.length === 0 && awaitingPublicDisplay) {
    awaitingPublicDisplay = false;
    messageEl.textContent = t("audience.ask.published");
  }
  ownQuestionsRoot.innerHTML = held
    .map(
      (question) => `<article class="question-card own-question">
        <div class="question-rank">${escapeHtml(t(question.visibility === "pending" ? "audience.mine.wait" : "audience.mine.held"))}</div>
        <div><div class="question-tags"><span class="question-status">${escapeHtml(ownStatusLabel(question))}</span></div><p>${escapeHtml(question.text)}</p><span>${escapeHtml(question.nickname)}</span></div>
      </article>`,
    )
    .join("");
  syncQuestionAvailability();
}

function syncQuestionAvailability() {
  const mode = state.session?.mode || "open";
  const participant = participantState.participant;
  const blockedBySession = mode === "paused" || mode === "closed";
  const blockedByModerator = participant?.questionState === "muted";
  const button = form.querySelector("button[type=submit]");
  if (button) button.disabled = blockedBySession || blockedByModerator;
  if (blockedBySession) {
    messageEl.textContent = t(mode === "closed" ? "errors.sessionClosed" : "errors.sessionPaused");
  }
  if (blockedByModerator) messageEl.textContent = t("errors.accessLimited");
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
  statusEl.lastChild.textContent = t(online ? "status.live" : "status.reconnecting");
}

function ownStatusLabel(question) {
  const key = `audience.mine.status.${question.visibility}`;
  const label = t(key);
  return label === key ? question.statusLabel : label;
}

function humanError(error) {
  const message = String(error?.message || error);
  if (message.includes("limit")) return t("errors.questionLimit");
  if (message.includes("cooldown")) return t("errors.cooldown");
  if (message.includes("paused")) return t("errors.sessionPaused");
  if (message.includes("closed")) return t("errors.sessionClosed");
  if (message.includes("code of conduct")) return t("errors.needCodeOfConduct");
  if (message.includes("upvote your own question")) return t("errors.upvoteOwn");
  if (message.includes("flag your own question")) return t("errors.flagOwn");
  if (message.includes("flag limit")) return t("errors.flagLimit");
  if (message.includes("question not found")) return t("errors.questionGone");
  if (message.includes("access is limited")) return t("errors.accessLimited");
  if (message.includes("question too short")) return t("errors.questionTooShort");
  if (message.includes("alias")) return t("errors.alias");
  return t("errors.generic");
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
    difficultyMessageEl.textContent = t("audience.difficulty.synced");
    render();
  })
  .catch(() => {
    difficultyMessageEl.textContent = t("audience.difficulty.hint");
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
