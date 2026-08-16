import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ANONYMOUS_ANIMALS, anonymousLabelFor } from "../src/anon-labels";

describe("anonymousLabelFor", () => {
  it("walks the animal list and stays unique across cycles", () => {
    const labels = Array.from({ length: ANONYMOUS_ANIMALS.length * 2 }, (_, index) =>
      anonymousLabelFor(index),
    );
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toBe("Anonymous Rainbow Pony");
    expect(labels[1]).toBe("Anonymous Panda");
    expect(labels[ANONYMOUS_ANIMALS.length]).toBe("Anonymous Rainbow Pony 2");
    for (const label of labels) expect(label).toMatch(/^Anonymous /);
  });

  it("rejects invalid indices", () => {
    expect(() => anonymousLabelFor(-1)).toThrow();
    expect(() => anonymousLabelFor(1.5)).toThrow();
  });
});

describe("LiveSession.anonymousLabel", () => {
  it("gives each device a stable label and different devices different labels", async () => {
    const stub = env.LIVE_SESSION.getByName("anon-label-spec:default");
    const voterA = crypto.randomUUID();
    const voterB = crypto.randomUUID();

    const first = await stub.anonymousLabel(voterA);
    const again = await stub.anonymousLabel(voterA);
    const other = await stub.anonymousLabel(voterB);

    expect(first).toMatch(/^Anonymous /);
    expect(again).toBe(first);
    expect(other).toMatch(/^Anonymous /);
    expect(other).not.toBe(first);
  });
});
