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
  identityMessageEl.textContent = "Saving your event name";
  try {
    participantState = await post("/api/participant", {
      alias: String(data.get("alias") || ""),
      cocVersion: config.moderation.codeOfConduct.version,
      voterId,
    });
    identityMessageEl.textContent = "Saved for this event";
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
  difficultyMessageEl.textContent = "Updating";
  clearTimeout(difficultyTimer);
  difficultyTimer = setTimeout(() => {
    post("/api/difficulty", { score: currentDifficulty, voterId })
      .then((nextState) => {
        state = nextState;
        difficultyMessageEl.textContent = "Synced with the presenter";
        render();
      })
      .catch(() => {
        difficultyMessageEl.textContent = "Sync failed. Please adjust it again";
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
      reactionMessageEl.textContent = `${button.firstChild.textContent.trim()} sent`;
      button.classList.remove("sent");
      void button.offsetWidth;
      button.classList.add("sent");
      setTimeout(() => button.classList.remove("sent"), 700);
    } catch {
      reactionMessageEl.textContent = "The reaction was not sent. Please try again";
    } finally {
      setTimeout(() => {
        button.disabled = false;
      }, 350);
    }
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  messageEl.textContent = "Sending";
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
        ? "Added to the question pool"
        : "Received. It is waiting before public display";
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
  localStorage.setItem(`upvote:${questionId}`, "1");
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
        <div class="poll-meta"><span>${escapeHtml(poll.prompt)}</span><span>${poll.total} votes</span></div>
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
              <span class="percent">${poll.counts[optionIndex]} votes</span>
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
    el.textContent = `${state.questions.length} questions`;
  });
  questionsRoot.innerHTML = state.questions.length
    ? state.questions
        .map(
          (question, index) => `
    <article class="question-card">
      <div class="question-rank">${String(index + 1).padStart(2, "0")}</div>
      <div><div class="question-tags"><span class="question-lens">${escapeHtml(lensLabels[question.lens] || lensLabels.clarify)}</span><span class="question-difficulty difficulty-${question.difficulty}">${question.difficulty} · ${escapeHtml(difficultyLabels[question.difficulty - 1] || difficultyLabels[2])}</span></div><p>${escapeHtml(question.text)}</p><span>${escapeHtml(question.nickname)}</span></div>
      <div class="question-actions">
        <button class="upvote ${localStorage.getItem(`upvote:${question.id}`) ? "selected" : ""}" data-upvote="${question.id}" aria-label="I have this question too">Me too <b>${question.upvotes}</b></button>
        ${renderFlagControl(question)}
      </div>
    </article>`,
        )
        .join("")
    : `<div class="empty">The first question can change the Q&amp;A route</div>`;
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
  if (reported) return `<span class="flagged-label">Reported</span>`;
  return `<details class="flag-control">
    <summary>Report</summary>
    <div class="flag-menu" role="group" aria-label="Report this question">
      <button type="button" data-question-id="${question.id}" data-flag-reason="harassment">Harassment or attack</button>
      <button type="button" data-question-id="${question.id}" data-flag-reason="disruption">Deliberate disruption</button>
      <button type="button" data-question-id="${question.id}" data-flag-reason="off_topic">Seriously off topic</button>
      <button type="button" data-question-id="${question.id}" data-flag-reason="privacy">Private information</button>
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
  if (held.length === 0 && messageEl.textContent.includes("waiting before public display")) {
    messageEl.textContent = "Published to the question pool";
  }
  ownQuestionsRoot.innerHTML = held
    .map(
      (question) => `<article class="question-card own-question">
        <div class="question-rank">${escapeHtml(question.visibility === "pending" ? "WAIT" : "HELD")}</div>
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
  const blockedByModerator = participant?.questionState === "muted";
  const button = form.querySelector("button[type=submit]");
  if (button) button.disabled = blockedBySession || blockedByModerator;
  if (blockedBySession) {
    messageEl.textContent = mode === "closed" ? "This session is closed" : "Questions are temporarily paused";
  }
  if (blockedByModerator) messageEl.textContent = "Question access is limited for this event";
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
  statusEl.lastChild.textContent = online ? "Live" : "Reconnecting";
}

function humanError(error) {
  const message = String(error?.message || error);
  if (message.includes("limit")) return "This device has reached the question limit";
  if (message.includes("cooldown")) return "Please wait before sending another question";
  if (message.includes("paused")) return "Questions are temporarily paused";
  if (message.includes("closed")) return "This session is closed";
  if (message.includes("code of conduct")) return "Please accept the code of conduct first";
  if (message.includes("own question")) return "You cannot report your own question";
  if (message.includes("flag limit")) return "This device has reached the report limit";
  if (message.includes("question not found")) return "This question is no longer public";
  if (message.includes("access is limited")) return "Question access is limited for this event";
  if (message.includes("alias")) return "Choose an event name with at least two characters";
  return "Sending failed. Please try again later";
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
    difficultyMessageEl.textContent = "Synced with the presenter";
    render();
  })
  .catch(() => {
    difficultyMessageEl.textContent = "Drag to update automatically";
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
