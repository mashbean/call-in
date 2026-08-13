import { SELF } from "cloudflare:test";
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
    await post("/api/question", {
      voterId: firstVoter,
      text: "第一個測試問題",
      nickname: "A",
      lens: "clarify",
      difficulty: 2,
    });
    const state = await post("/api/question", {
      voterId: secondVoter,
      text: "第二個測試問題",
      nickname: "B",
      lens: "keeper",
      difficulty: 5,
    });
    expect(state.questions).toHaveLength(2);
    expect(state.questions[0]?.text).toBe("第二個測試問題");
    expect(state.questions[0]?.difficulty).toBe(5);
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
  difficulty: { counts: number[]; total: number; average: number | null };
  polls: Array<{ id: string; counts: number[]; total: number }>;
  questions: Array<{ text: string; difficulty: number }>;
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
