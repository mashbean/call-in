import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("LiveSession reaction persistence", () => {
  it("records each reaction with a timestamp, exports them, and clears on reset", async () => {
    const stub = env.LIVE_SESSION.getByName("reactions-spec:default");
    const voter = crypto.randomUUID();

    await stub.react("applause", voter);
    await stub.react("insight", voter);

    const data = await stub.exportData();
    expect(data.reactions.map((row) => row.kind)).toEqual(["applause", "insight"]);
    for (const row of data.reactions) {
      expect(typeof row.created_at).toBe("number");
      expect(row).not.toHaveProperty("voter_id");
    }

    await stub.reset();
    const cleared = await stub.exportData();
    expect(cleared.reactions).toEqual([]);
  });
});
