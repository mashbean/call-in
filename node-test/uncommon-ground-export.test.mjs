import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { exportUncommonGround } from "../scripts/uncommon-ground.mjs";

test("exports the Uncommon Ground schema without source UUIDs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "live-deck-uncommon-ground-"));
  const questionsPath = path.join(dir, "questions.json");
  const votesPath = path.join(dir, "votes.json");
  const classificationsPath = path.join(dir, "classifications.json");
  const outputPath = path.join(dir, "output.json");
  const questionId = "11111111-1111-4111-8111-111111111111";
  const voterId = "22222222-2222-4222-8222-222222222222";

  await writeFile(questionsPath, JSON.stringify([
    { id: questionId, voter_id: voterId, text: "如何定義 Agent？", nickname: "Dr. Lin", difficulty: 2, created_at: 1000 },
  ]));
  await writeFile(votesPath, JSON.stringify([
    { question_id: questionId, voter_id: voterId },
    { question_id: questionId, voter_id: "33333333-3333-4333-8333-333333333333" },
  ]));
  await writeFile(classificationsPath, JSON.stringify([
    { id: questionId, classification: "keep" },
  ]));

  const meta = await exportUncommonGround({
    questions: questionsPath,
    questionVotes: votesPath,
    classifications: classificationsPath,
    out: outputPath,
    event: "test-event",
  });
  const source = await readFile(outputPath, "utf8");
  const output = JSON.parse(source);

  assert.equal(meta.total, 1);
  assert.equal(meta.live, 1);
  assert.equal(output.questions[0].qid, "q001");
  assert.equal(output.questions[0].participant_id, "p001");
  assert.equal(output.questions[0].upvotes, 2);
  assert.equal(output.questions[0].lang, "zh");
  assert.equal(output.questions[0].status, "Live");
  assert.equal(output.questions[0].name, "");
  assert.doesNotMatch(source, new RegExp(questionId, "i"));
  assert.doesNotMatch(source, new RegExp(voterId, "i"));
});

test("keeps withdrawn rows for provenance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "live-deck-uncommon-ground-"));
  const questionsPath = path.join(dir, "questions.json");
  const classificationsPath = path.join(dir, "classifications.json");
  const outputPath = path.join(dir, "output.json");

  await writeFile(questionsPath, JSON.stringify([
    { id: "q-source", voter_id: "v-source", text: "蓄意破壞討論的留言", created_at: 1000 },
  ]));
  await writeFile(classificationsPath, JSON.stringify([
    { id: "q-source", classification: "provocative" },
  ]));

  const meta = await exportUncommonGround({
    questions: questionsPath,
    classifications: classificationsPath,
    out: outputPath,
  });
  const output = JSON.parse(await readFile(outputPath, "utf8"));

  assert.equal(meta.withdrawn, 1);
  assert.equal(output.questions[0].status, "Withdrawn");
});
