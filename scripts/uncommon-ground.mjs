#!/usr/bin/env node
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function exportUncommonGround(options) {
  if (!options.questions) throw new Error("--questions is required");
  if (!options.out) throw new Error("--out is required");

  const questionSource = await readJson(options.questions);
  const questions = unwrapRows(questionSource, ["questions"]);
  const voteRows = options.questionVotes
    ? unwrapRows(await readJson(options.questionVotes), ["question_votes", "questionVotes", "votes"])
    : [];
  const classificationRows = options.classifications
    ? unwrapRows(await readJson(options.classifications), ["questions", "classifications"])
    : [];
  const withdrawLabels = new Set(
    String(options.withdrawLabels || "negative,provocative")
      .split(",")
      .map((label) => label.trim().toLowerCase())
      .filter(Boolean),
  );

  const classifications = new Map(
    classificationRows
      .map((row) => [row.id ?? row.question_id ?? row.questionId, row])
      .filter(([id]) => typeof id === "string"),
  );
  const upvotes = countQuestionVotes(voteRows);
  const sorted = [...questions].sort((left, right) => {
    const byTime = timestampOf(left) - timestampOf(right);
    return byTime || String(idOf(left)).localeCompare(String(idOf(right)));
  });

  const participantCodes = new Map();
  const languageCounts = new Map();
  let withdrawn = 0;
  let named = 0;

  const outputQuestions = sorted.map((row, index) => {
    const sourceId = idOf(row);
    const voterId = voterIdOf(row);
    const classification = classifications.get(sourceId) ?? row;
    const label = String(classification.classification ?? classification.sentiment ?? "").trim();
    const status = withdrawLabels.has(label.toLowerCase()) ? "Withdrawn" : "Live";
    if (status === "Withdrawn") withdrawn += 1;

    const participantId = voterId ? pseudonymFor(participantCodes, voterId) : "";
    const text = cleanText(row.text ?? row.question ?? row.question_text);
    const lang = detectLanguage(text);
    languageCounts.set(lang, (languageCounts.get(lang) ?? 0) + 1);
    const nickname = options.keepNames
      ? cleanName(row.nickname ?? row.name ?? row.participant_name)
      : "";
    if (nickname) named += 1;
    const qid = `q${String(index + 1).padStart(3, "0")}`;
    const createdAt = timestampOf(row);

    return {
      qid,
      participant_id: participantId,
      code: `${lang.toUpperCase()}-${String(index + 1).padStart(3, "0")}`,
      name: nickname,
      text,
      lang,
      upvotes: upvotes.get(sourceId) ?? numberOrZero(classification.upvotes ?? row.upvotes),
      score: numberOrZero(row.difficulty ?? row.score),
      highlighted: Boolean(row.highlighted),
      status,
      sentiment: label,
      submitted_at: createdAt ? new Date(createdAt).toISOString() : "",
      dup_group: "",
      source_lens: String(row.lens ?? ""),
    };
  });

  const result = {
    meta: {
      source: options.sourceLabel || path.basename(options.questions),
      event: options.event || "live-deck-event",
      total: outputQuestions.length,
      live: outputQuestions.length - withdrawn,
      withdrawn,
      languages: Object.fromEntries(languageCounts),
      named,
      participants: participantCodes.size,
      duplicate_clusters: 0,
      privacy: "Source identifiers replaced with event-local sequential codes.",
    },
    questions: outputQuestions,
  };

  await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result.meta;
}

async function main(argv) {
  const args = parseArgs(argv.slice(2));
  const meta = await exportUncommonGround({
    questions: args.questions,
    questionVotes: args["question-votes"],
    classifications: args.classifications,
    withdrawLabels: args["withdraw-labels"],
    keepNames: Boolean(args["keep-names"]),
    sourceLabel: args["source-label"],
    event: args.event,
    out: args.out,
  });
  console.log(JSON.stringify({ ok: true, ...meta }, null, 2));
}

function unwrapRows(value, keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  throw new Error("Expected a JSON array or an object containing an array of rows");
}

function countQuestionVotes(rows) {
  const votersByQuestion = new Map();
  for (const row of rows) {
    const questionId = row.question_id ?? row.questionId;
    if (typeof questionId !== "string") continue;
    const voterId = row.voter_id ?? row.voterId ?? `${questionId}:${votersByQuestion.size}`;
    if (!votersByQuestion.has(questionId)) votersByQuestion.set(questionId, new Set());
    votersByQuestion.get(questionId).add(String(voterId));
  }
  return new Map([...votersByQuestion].map(([questionId, voters]) => [questionId, voters.size]));
}

function pseudonymFor(codes, sourceId) {
  if (!codes.has(sourceId)) codes.set(sourceId, `p${String(codes.size + 1).padStart(3, "0")}`);
  return codes.get(sourceId);
}

function idOf(row) {
  return String(row.id ?? row.question_id ?? row.questionId ?? "");
}

function voterIdOf(row) {
  const value = row.voter_id ?? row.voterId ?? row.participant_id ?? row.participantId;
  return typeof value === "string" ? value : "";
}

function timestampOf(row) {
  const value = row.created_at ?? row.createdAt ?? row.submitted_at ?? row.submittedAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanName(value) {
  const name = cleanText(value);
  if (!name || /^(匿名|anonymous)$/i.test(name)) return "";
  return name.slice(0, 80);
}

function detectLanguage(text) {
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[\uac00-\ud7af]/u.test(text)) return "ko";
  if (/[\u4e00-\u9fff]/u.test(text)) return "zh";
  return "en";
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[item.slice(2)] = next;
      index += 1;
    } else {
      result[item.slice(2)] = true;
    }
  }
  return result;
}

const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
  : "";

if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
