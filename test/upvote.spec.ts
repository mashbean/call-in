import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("LiveSession.upvote", () => {
  it("toggles a device's upvote on and off", async () => {
    const stub = env.LIVE_SESSION.getByName("upvote-toggle-spec:default");
    const author = crypto.randomUUID();
    const fan = crypto.randomUUID();
    await stub.registerParticipant("Upvote Author", "2026-08-15", author);
    const submission = await stub.ask("A question for testing upvotes", "", "clarify", 3, author);
    await stub.moderateQuestion(submission.submission.id, "restore", "test");

    // ask() seeds the author's own vote, so the question starts at one
    expect(submission.submission.upvotes).toBe(1);

    const liked = await stub.upvote(submission.submission.id, fan);
    const likedRow = liked.questions.find((question) => question.id === submission.submission.id);
    expect(likedRow?.upvotes).toBe(2);

    const unliked = await stub.upvote(submission.submission.id, fan);
    const unlikedRow = unliked.questions.find((question) => question.id === submission.submission.id);
    expect(unlikedRow?.upvotes).toBe(1);
  });
});
