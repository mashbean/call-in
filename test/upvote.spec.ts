import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("LiveSession.ask upvote seeding", () => {
  it("starts a new question at zero upvotes and counts only other devices", async () => {
    const stub = env.LIVE_SESSION.getByName("no-self-upvote-spec:default");
    const author = crypto.randomUUID();
    const fan = crypto.randomUUID();
    await stub.registerParticipant("Upvote Author", "2026-08-15", author);
    const submission = await stub.ask("A question for testing upvotes", "", "clarify", 3, author);
    await stub.moderateQuestion(submission.submission.id, "restore", "test");

    // the count means how many devices pressed "me too": the author is not one of them
    expect(submission.submission.upvotes).toBe(0);

    const liked = await stub.upvote(submission.submission.id, fan);
    const likedRow = liked.questions.find((question) => question.id === submission.submission.id);
    expect(likedRow?.upvotes).toBe(1);

    // a repeat press from the same device does not double-count
    const repeat = await stub.upvote(submission.submission.id, fan);
    const repeatRow = repeat.questions.find((question) => question.id === submission.submission.id);
    expect(repeatRow?.upvotes).toBe(1);
  });
});
