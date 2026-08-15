import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const jsonHeaders = { "Content-Type": "application/json" };

describe("Live Deck Kit Worker", () => {
  it("serves the public event configuration", async () => {
    const response = await SELF.fetch("https://example.com/api/config");
    expect(response.status).toBe(200);
    const config = await response.json<{ eventId: string; difficulty: { labels: string[] } }>();
    expect(config.eventId).toBe("my-live-deck");
    expect(config.difficulty.labels).toHaveLength(5);
  });

  it("records difficulty and keeps only the latest score per device", async () => {
    const voterId = crypto.randomUUID();
    await post("/api/difficulty", { voterId, score: 2 });
    const state = await post("/api/difficulty", { voterId, score: 4 });
    expect(state.difficulty.total).toBe(1);
    expect(state.difficulty.counts).toEqual([0, 0, 0, 1, 0]);
    expect(state.difficulty.average).toBe(4);
  });

  it("records questions with their current difficulty and orders newest first", async () => {
    const firstVoter = crypto.randomUUID();
    const secondVoter = crypto.randomUUID();
    await register(firstVoter, "First clinician");
    await register(secondVoter, "Second clinician");
    const first = await postQuestion({
      voterId: firstVoter,
      text: "First test question",
      lens: "clarify",
      difficulty: 2,
    });
    const second = await postQuestion({
      voterId: secondVoter,
      text: "Second test question",
      lens: "keeper",
      difficulty: 5,
    });
    expect(first.submission.visibility).toBe("pending");
    expect(second.submission.visibility).toBe("pending");
    expect(second.snapshot.questions).toHaveLength(0);

    const stub = env.LIVE_SESSION.getByName("my-live-deck:default");
    await stub.moderateQuestion(first.submission.id, "restore", "other");
    const state = await stub.moderateQuestion(second.submission.id, "restore", "other");
    expect(state.questions).toHaveLength(2);
    expect(state.questions[0]?.text).toBe("Second test question");
    expect(state.questions[0]?.difficulty).toBe(5);
  });

  it("locks the event alias after the first code-of-conduct acceptance", async () => {
    const voterId = crypto.randomUUID();
    const first = await register(voterId, "Night shift");
    const second = await register(voterId, "Changed name");
    expect(first.participant?.publicLabel).toMatch(/^Night shift #[0-9A-F]{4}$/);
    expect(second.participant?.publicLabel).toBe(first.participant?.publicLabel);
  });

  it("requires code-of-conduct acceptance before a free-text question", async () => {
    const response = await SELF.fetch("https://example.com/api/question", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        voterId: crypto.randomUUID(),
        text: "Can I ask before accepting the rules?",
        lens: "clarify",
        difficulty: 3,
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json<{ error: string }>()).toEqual({
      error: "code of conduct must be accepted",
    });
  });

  it("rate limits a rapid second question from the same device", async () => {
    const voterId = crypto.randomUUID();
    await register(voterId, "Fast sender");
    await postQuestion({
      voterId,
      text: "This is the first rapid question",
      lens: "clarify",
      difficulty: 3,
    });
    const response = await SELF.fetch("https://example.com/api/question", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        voterId,
        text: "This is the second rapid question",
        lens: "clarify",
        difficulty: 3,
      }),
    });
    expect(response.status).toBe(429);
  });

  it("keeps a hidden question visible only in the author's submission state", async () => {
    const voterId = crypto.randomUUID();
    await register(voterId, "Careful critic");
    const question = await postQuestion({
      voterId,
      text: "Please clarify the evidence for this step",
      lens: "clarify",
      difficulty: 4,
    });
    const stub = env.LIVE_SESSION.getByName("my-live-deck:default");
    await stub.moderateQuestion(question.submission.id, "hide", "harassment");
    const publicState = await stub.snapshot();
    const ownState = await stub.participantState(voterId);
    expect(publicState.questions.some((item) => item.id === question.submission.id)).toBe(false);
    const ownQuestion = ownState.questions.find((item) => item.id === question.submission.id);
    expect(ownQuestion?.visibility).toBe("author_only");
    expect(ownQuestion?.statusLabel).toBe("Not public");
  });

  it("temporarily holds a question after trusted reports and lets the moderator restore it", async () => {
    const author = crypto.randomUUID();
    const flaggers = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await register(author, "Question author");
    for (const [index, voterId] of flaggers.entries()) {
      await register(voterId, `Reporter ${index + 1}`);
    }
    const question = await postQuestion({
      voterId: author,
      text: "A question that needs community review",
      lens: "bridge",
      difficulty: 3,
    });
    const stub = env.LIVE_SESSION.getByName("my-live-deck:default");
    await stub.moderateQuestion(question.submission.id, "restore", "other");

    const selfFlag = await SELF.fetch("https://example.com/api/flag", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ questionId: question.submission.id, reason: "disruption", voterId: author }),
    });
    expect(selfFlag.status).toBe(400);
    expect(await selfFlag.json<{ error: string }>()).toEqual({
      error: "cannot flag your own question",
    });
    expect((await stub.flagQuestion(question.submission.id, "off_topic", flaggers[0])).held).toBe(false);
    expect((await stub.flagQuestion(question.submission.id, "harassment", flaggers[0])).held).toBe(false);
    const afterDuplicate = (await stub.moderatorSnapshot()).questions.find(
      (item) => item.id === question.submission.id,
    );
    expect(afterDuplicate?.flagCount).toBe(1);
    expect((await stub.flagQuestion(question.submission.id, "disruption", flaggers[1])).held).toBe(false);
    expect((await stub.flagQuestion(question.submission.id, "harassment", flaggers[2])).held).toBe(true);

    expect((await stub.snapshot()).questions.some((item) => item.id === question.submission.id)).toBe(false);
    const held = (await stub.participantState(author)).questions.find(
      (item) => item.id === question.submission.id,
    );
    expect(held?.visibility).toBe("author_only");
    const moderatorQuestion = (await stub.moderatorSnapshot()).questions.find(
      (item) => item.id === question.submission.id,
    );
    expect(moderatorQuestion).toMatchObject({
      flagCount: 3,
      flagWeight: 3,
      flagThreshold: 3,
      flagReasons: { off_topic: 1, disruption: 1, harassment: 1 },
    });

    await stub.moderateQuestion(question.submission.id, "restore", "other");
    expect((await stub.snapshot()).questions.some((item) => item.id === question.submission.id)).toBe(true);
    const exported = await stub.exportData();
    const rejected = exported.participants.filter((item) => flaggers.includes(item.voter_id));
    expect(rejected.every((item) => item.flags_rejected === 1 && item.flags_agreed === 0)).toBe(true);
    expect(
      exported.questionFlags.filter((item) => item.question_id === question.submission.id),
    ).toHaveLength(3);
    expect(
      exported.questionFlags
        .filter((item) => item.question_id === question.submission.id)
        .every((item) => item.status === "rejected" && item.resolved_at !== null),
    ).toBe(true);

    const nextAuthor = crypto.randomUUID();
    await register(nextAuthor, "Next author");
    const nextQuestion = await postQuestion({
      voterId: nextAuthor,
      text: "A second question for trust weighting",
      lens: "clarify",
      difficulty: 2,
    });
    await stub.moderateQuestion(nextQuestion.submission.id, "restore", "other");
    await stub.flagQuestion(nextQuestion.submission.id, "off_topic", flaggers[0]);
    const weighted = (await stub.moderatorSnapshot()).questions.find(
      (item) => item.id === nextQuestion.submission.id,
    );
    expect(weighted?.flagWeight).toBe(0.5);
  });

  it("updates a quick poll vote without increasing the voter total", async () => {
    const voterId = crypto.randomUUID();
    await post("/api/vote", { voterId, pollId: "starting-point", optionIndex: 0 });
    const state = await post("/api/vote", { voterId, pollId: "starting-point", optionIndex: 3 });
    const poll = state.polls.find((item) => item.id === "starting-point");
    expect(poll?.total).toBe(1);
    expect(poll?.counts).toEqual([0, 0, 0, 1]);
  });

  it("keeps admin routes closed until a token hash is configured", async () => {
    const response = await SELF.fetch("https://example.com/api/admin/reset", { method: "POST" });
    expect(response.status).toBe(404);
    const moderator = await SELF.fetch("https://example.com/api/moderator/state");
    expect(moderator.status).toBe(404);
  });

  it("rejects oversized interaction payloads before parsing them", async () => {
    const response = await SELF.fetch("https://example.com/api/question", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ text: "x".repeat(5000) }),
    });
    expect(response.status).toBe(413);
  });
});

type State = {
  session: { mode: string };
  difficulty: { counts: number[]; total: number; average: number | null };
  polls: Array<{ id: string; counts: number[]; total: number }>;
  questions: Array<{ id: string; text: string; difficulty: number }>;
};

type ParticipantState = {
  participant: { publicLabel: string } | null;
  questions: Array<{ id: string; visibility: string }>;
};

type QuestionResponse = {
  snapshot: State;
  submission: { id: string; visibility: string };
};

async function post(path: string, body: Record<string, unknown>): Promise<State> {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json<State>();
}

async function register(voterId: string, alias: string): Promise<ParticipantState> {
  const response = await SELF.fetch("https://example.com/api/participant", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ voterId, alias, cocVersion: "2026-08-15" }),
  });
  expect(response.status).toBe(200);
  return response.json<ParticipantState>();
}

async function postQuestion(body: Record<string, unknown>): Promise<QuestionResponse> {
  const response = await SELF.fetch("https://example.com/api/question", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json<QuestionResponse>();
}
