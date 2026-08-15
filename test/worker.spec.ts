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
