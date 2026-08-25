import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import eventConfig from "../public/event.config.json";

describe("LiveSession.upvote", () => {
  it("starts at zero and lets another device toggle its upvote", async () => {
    const stub = env.LIVE_SESSION.getByName("upvote-toggle-spec:default");
    const author = crypto.randomUUID();
    const fan = crypto.randomUUID();
    await stub.registerParticipant(
      "Upvote Author",
      eventConfig.moderation.codeOfConduct.version,
      author,
    );
    const submission = await stub.ask("A question for testing upvotes", "", "clarify", 3, author);
    await stub.moderateQuestion(submission.submission.id, "restore", "test");

    // the count means how many devices pressed "me too": the author is not one of them
    expect(submission.submission.upvotes).toBe(0);

    const liked = await stub.upvote(submission.submission.id, fan);
    const likedRow = liked.questions.find((question) => question.id === submission.submission.id);
    expect(likedRow?.upvotes).toBe(1);

    const unliked = await stub.upvote(submission.submission.id, fan);
    const unlikedRow = unliked.questions.find((question) => question.id === submission.submission.id);
    expect(unlikedRow?.upvotes).toBe(0);
  });
});
