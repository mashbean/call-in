import rawConfig from "../public/event.config.json";
import type { PublicEventConfig, QuestionLens, ReactionKind } from "./types";

const questionLenses = new Set<QuestionLens>(["clarify", "chorus", "bridge", "keeper"]);
const reactionKinds = new Set<ReactionKind>(["applause", "insight", "resonate", "pause"]);

export const EVENT_CONFIG = validateEventConfig(rawConfig);
export const QUESTION_LENSES = questionLenses;
export const REACTION_KINDS = reactionKinds;

export function validateEventConfig(value: unknown): PublicEventConfig {
  if (!isRecord(value)) throw new Error("public/event.config.json must contain an object");
  const config = value as PublicEventConfig;
  if (!isSlug(config.eventId)) throw new Error("eventId must be a lowercase URL-safe slug");
  assertText(config.eyebrow, "eyebrow", 80);
  assertText(config.title, "title", 160);
  assertText(config.description, "description", 500);
  assertText(config.dashboardTitle, "dashboardTitle", 160);
  assertPublicUrl(config.deckUrl, "deckUrl");
  if (typeof config.locale !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(config.locale)) {
    throw new Error("locale must be a language tag");
  }
  if (!isRecord(config.theme)) throw new Error("theme is incomplete");
  for (const key of ["background", "panel", "accent", "highlight", "positive"] as const) {
    if (typeof config.theme[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(config.theme[key])) {
      throw new Error(`theme.${key} must be a six-digit hex color`);
    }
  }
  if (!Array.isArray(config.polls) || config.polls.length > 8) {
    throw new Error("polls must contain 0 to 8 questions");
  }
  const pollIds = new Set<string>();
  for (const poll of config.polls) {
    if (!isSlug(poll.id) || pollIds.has(poll.id)) throw new Error("poll ids must be unique slugs");
    if (!Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 6) {
      throw new Error(`poll ${poll.id} must have 2 to 6 options`);
    }
    assertText(poll.prompt, `poll ${poll.id} prompt`, 80);
    assertText(poll.question, `poll ${poll.id} question`, 240);
    for (const option of poll.options) assertText(option, `poll ${poll.id} option`, 120);
    pollIds.add(poll.id);
  }
  if (!isRecord(config.difficulty) || config.difficulty.labels?.length !== 5) {
    throw new Error("difficulty.labels must contain exactly 5 labels");
  }
  assertText(config.difficulty.title, "difficulty.title", 160);
  for (const label of config.difficulty.labels) assertText(label, "difficulty label", 60);
  if (!Array.isArray(config.question?.lenses) || config.question.lenses.length !== 4) {
    throw new Error("question.lenses must contain the four supported lenses");
  }
  assertText(config.question.title, "question.title", 160);
  assertText(config.question.placeholder, "question.placeholder", 280);
  const lensIds = new Set(config.question.lenses.map((lens) => lens.id));
  if (lensIds.size !== questionLenses.size || config.question.lenses.some((lens) => !questionLenses.has(lens.id))) {
    throw new Error("question lens id is unsupported");
  }
  for (const lens of config.question.lenses) {
    assertText(lens.label, `question lens ${lens.id} label`, 60);
    assertText(lens.description, `question lens ${lens.id} description`, 180);
  }
  if (!Array.isArray(config.reactions) || config.reactions.length !== 4) {
    throw new Error("reactions must contain the four supported reaction kinds");
  }
  const reactionIds = new Set(config.reactions.map((reaction) => reaction.id));
  if (reactionIds.size !== reactionKinds.size || config.reactions.some((reaction) => !reactionKinds.has(reaction.id))) {
    throw new Error("reaction id is unsupported");
  }
  for (const reaction of config.reactions) {
    assertText(reaction.emoji, `reaction ${reaction.id} emoji`, 24);
    assertText(reaction.label, `reaction ${reaction.id} label`, 60);
  }
  if (
    !Number.isInteger(config.question.maxPerDevice) ||
    config.question.maxPerDevice < 1 ||
    config.question.maxPerDevice > 100
  ) {
    throw new Error("question.maxPerDevice must be between 1 and 100");
  }
  if (config.moderation) {
    const moderation = config.moderation;
    if (typeof moderation.enabled !== "boolean") {
      throw new Error("moderation.enabled must be a boolean");
    }
    if (
      !Number.isInteger(moderation.presentationDelaySeconds) ||
      moderation.presentationDelaySeconds < 0 ||
      moderation.presentationDelaySeconds > 30
    ) {
      throw new Error("moderation.presentationDelaySeconds must be between 0 and 30");
    }
    if (
      !Number.isInteger(moderation.questionCooldownSeconds) ||
      moderation.questionCooldownSeconds < 0 ||
      moderation.questionCooldownSeconds > 300
    ) {
      throw new Error("moderation.questionCooldownSeconds must be between 0 and 300");
    }
    if (
      !Number.isInteger(moderation.questionsPerTenMinutes) ||
      moderation.questionsPerTenMinutes < 1 ||
      moderation.questionsPerTenMinutes > 100
    ) {
      throw new Error("moderation.questionsPerTenMinutes must be between 1 and 100");
    }
    if (
      !Number.isInteger(moderation.slowModeSeconds) ||
      moderation.slowModeSeconds < 10 ||
      moderation.slowModeSeconds > 600
    ) {
      throw new Error("moderation.slowModeSeconds must be between 10 and 600");
    }
    const flags = moderation.flags;
    if (!flags || typeof flags.enabled !== "boolean") {
      throw new Error("moderation.flags is incomplete");
    }
    if (!Number.isInteger(flags.maxPerDevice) || flags.maxPerDevice < 1 || flags.maxPerDevice > 30) {
      throw new Error("moderation.flags.maxPerDevice must be between 1 and 30");
    }
    if (!Number.isInteger(flags.autoHoldMin) || flags.autoHoldMin < 2 || flags.autoHoldMin > 10) {
      throw new Error("moderation.flags.autoHoldMin must be between 2 and 10");
    }
    if (
      !Number.isInteger(flags.autoHoldMax) ||
      flags.autoHoldMax < flags.autoHoldMin ||
      flags.autoHoldMax > 20
    ) {
      throw new Error("moderation.flags.autoHoldMax must be between autoHoldMin and 20");
    }
    if (
      typeof flags.autoHoldParticipantRatio !== "number" ||
      flags.autoHoldParticipantRatio < 0 ||
      flags.autoHoldParticipantRatio > 0.2
    ) {
      throw new Error("moderation.flags.autoHoldParticipantRatio must be between 0 and 0.2");
    }
    const coc = moderation.codeOfConduct;
    if (
      !coc ||
      typeof coc.version !== "string" ||
      !coc.version.trim() ||
      typeof coc.title !== "string" ||
      typeof coc.summary !== "string" ||
      !Array.isArray(coc.rules) ||
      coc.rules.length < 2 ||
      coc.rules.length > 8 ||
      coc.rules.some((rule) => typeof rule !== "string" || !rule.trim())
    ) {
      throw new Error("moderation.codeOfConduct is incomplete");
    }
    assertText(coc.version, "moderation.codeOfConduct.version", 80);
    assertText(coc.title, "moderation.codeOfConduct.title", 160);
    assertText(coc.summary, "moderation.codeOfConduct.summary", 600);
    for (const rule of coc.rules) assertText(rule, "moderation.codeOfConduct rule", 280);
  }
  return config;
}

function assertText(value: unknown, field: string, maxLength: number): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new Error(`${field} must contain 1 to ${maxLength} printable characters`);
  }
}

function assertPublicUrl(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    throw new Error(`${field} must be a web URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value, "https://call-in.invalid");
  } catch {
    throw new Error(`${field} must be a web URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${field} must use HTTP or HTTPS without embedded credentials`);
  }
}

function isSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
