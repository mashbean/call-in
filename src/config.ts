import rawConfig from "../public/event.config.json";
import type { PublicEventConfig, QuestionLens, ReactionKind } from "./types";

const questionLenses = new Set<QuestionLens>(["clarify", "chorus", "bridge", "keeper"]);
const reactionKinds = new Set<ReactionKind>(["applause", "insight", "resonate", "pause"]);

export const EVENT_CONFIG = validateEventConfig(rawConfig);
export const QUESTION_LENSES = questionLenses;
export const REACTION_KINDS = reactionKinds;

function validateEventConfig(value: unknown): PublicEventConfig {
  if (!isRecord(value)) throw new Error("public/event.config.json must contain an object");
  const config = value as PublicEventConfig;
  if (!isSlug(config.eventId)) throw new Error("eventId must be a lowercase URL-safe slug");
  if (!Array.isArray(config.polls) || config.polls.length > 8) {
    throw new Error("polls must contain 0 to 8 questions");
  }
  const pollIds = new Set<string>();
  for (const poll of config.polls) {
    if (!isSlug(poll.id) || pollIds.has(poll.id)) throw new Error("poll ids must be unique slugs");
    if (!Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 6) {
      throw new Error(`poll ${poll.id} must have 2 to 6 options`);
    }
    pollIds.add(poll.id);
  }
  if (config.difficulty?.labels?.length !== 5) {
    throw new Error("difficulty.labels must contain exactly 5 labels");
  }
  if (!Array.isArray(config.question?.lenses) || config.question.lenses.length !== 4) {
    throw new Error("question.lenses must contain the four supported lenses");
  }
  if (config.question.lenses.some((lens) => !questionLenses.has(lens.id))) {
    throw new Error("question lens id is unsupported");
  }
  if (!Array.isArray(config.reactions) || config.reactions.length !== 4) {
    throw new Error("reactions must contain the four supported reaction kinds");
  }
  if (config.reactions.some((reaction) => !reactionKinds.has(reaction.id))) {
    throw new Error("reaction id is unsupported");
  }
  if (
    !Number.isInteger(config.question.maxPerDevice) ||
    config.question.maxPerDevice < 1 ||
    config.question.maxPerDevice > 100
  ) {
    throw new Error("question.maxPerDevice must be between 1 and 100");
  }
  return config;
}

function isSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
