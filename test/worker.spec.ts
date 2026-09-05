import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateEventConfig } from "../src/config";
import { isAuthorized } from "../src/index";

const jsonHeaders = { "Content-Type": "application/json" };

describe("Call-in Worker", () => {
  it("redirects the retired creator URLs into the landing-page creator", async () => {
    const zh = await SELF.fetch("https://example.com/new/", { redirect: "manual" });
    const en = await SELF.fetch("https://example.com/en/new/", { redirect: "manual" });
    expect(zh.status).toBe(308);
    expect(zh.headers.get("location")).toBe("https://example.com/#create");
    expect(en.status).toBe(308);
    expect(en.headers.get("location")).toBe("https://example.com/en/#create");
  });

  it("serves the public event configuration", async () => {
    const response = await SELF.fetch("https://example.com/api/config");
    expect(response.status).toBe(200);
    const config = await response.json<{ eventId: string; difficulty: { labels: string[] } }>();
    expect(config.eventId).toBe("my-call-in");
    expect(config.difficulty.labels).toHaveLength(5);
  });

  it("runs the permanent demo as a real isolated audience session with a scannable dashboard", async () => {
    const audiencePage = await SELF.fetch("https://example.com/demo/audience/");
    const dashboardPage = await SELF.fetch("https://example.com/demo/dashboard/");
    expect(audiencePage.status).toBe(200);
    expect(await audiencePage.text()).toContain("Call-in 簡單叩應");
    expect(dashboardPage.status).toBe(200);
    expect(await dashboardPage.text()).toContain("data-qr-open");

    const zhConfigResponse = await SELF.fetch("https://example.com/api/demo/zh/config");
    const enConfigResponse = await SELF.fetch("https://example.com/api/demo/en/config");
    const zhConfig = await zhConfigResponse.json<{
      eventId: string;
      title: string;
      locale: string;
      moderation: { codeOfConduct: { version: string } };
    }>();
    const enConfig = await enConfigResponse.json<{ eventId: string; title: string; locale: string }>();
    expect(zhConfig).toMatchObject({ title: "Call-in 常駐 Demo", locale: "zh-Hant-TW" });
    expect(enConfig).toMatchObject({ eventId: zhConfig.eventId, title: "Call-in permanent demo", locale: "en" });

    const voterId = crypto.randomUUID();
    const initialZhState = await SELF.fetch("https://example.com/api/demo/zh/state").then((response) =>
      response.json<{ difficulty: { counts: number[]; total: number }; questions: Array<{ nickname: string }> }>(),
    );
    const initialEnState = await SELF.fetch("https://example.com/api/demo/en/state").then((response) =>
      response.json<{ difficulty: { total: number }; questions: Array<{ nickname: string }> }>(),
    );
    expect(initialZhState.difficulty).toMatchObject({ counts: [2, 5, 29, 7, 2], total: 45 });
    expect(initialZhState.questions).toHaveLength(6);
    expect(initialZhState.questions.every((question) => question.nickname.startsWith("示範聽眾 #"))).toBe(true);
    expect(initialEnState.difficulty.total).toBe(45);
    expect(initialEnState.questions).toHaveLength(6);
    expect(initialEnState.questions.every((question) => question.nickname.startsWith("Demo guest #"))).toBe(true);

    const difficulty = await SELF.fetch("https://example.com/api/demo/zh/difficulty", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ score: 4, voterId }),
    });
    expect(difficulty.status).toBe(200);
    const state = await SELF.fetch("https://example.com/api/demo/zh/state").then((response) =>
      response.json<{ difficulty: { counts: number[]; total: number }; questions: unknown[] }>(),
    );
    expect(state.difficulty.total).toBe(46);
    expect(state.difficulty.counts[3]).toBe(8);
    expect(state.questions).toHaveLength(6);

    const reaction = await SELF.fetch("https://example.com/api/demo/zh/reaction", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ kind: "applause", voterId }),
    });
    expect(reaction.status).toBe(200);

    const participant = await SELF.fetch("https://example.com/api/demo/zh/participant", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ alias: "真人測試", cocVersion: zhConfig.moderation.codeOfConduct.version, voterId }),
    });
    expect(participant.status).toBe(200);
    const question = await SELF.fetch("https://example.com/api/demo/zh/question", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ text: "這是真人新增的問題嗎？", lens: "clarify", difficulty: 4, voterId }),
    });
    expect(question.status).toBe(200);
    expect((await question.json<{ submission: { text: string } }>()).submission.text).toBe("這是真人新增的問題嗎？");

    const qr = await SELF.fetch("https://example.com/api/demo/zh/qr.svg");
    expect(qr.status).toBe(200);
    expect(qr.headers.get("content-type")).toContain("image/svg+xml");
    expect(await qr.text()).toContain("<svg");
  });

  it("stores a validated event configuration without changing the event data key", async () => {
    const stub = env.LIVE_SESSION.getByName("my-call-in:default");
    const current = await stub.eventConfig();
    const next = structuredClone(current);
    next.title = "A configured event";
    next.deckUrl = "https://example.com/my-slides";
    next.polls = [
      {
        id: "opening-question",
        prompt: "Warm-up",
        question: "What should we discuss first?",
        options: ["Safety", "Workflow"],
      },
    ];

    const saved = await stub.updateEventConfig(next);
    expect(saved.config.title).toBe("A configured event");
    const response = await SELF.fetch("https://example.com/api/config");
    const publicConfig = await response.json<typeof next>();
    expect(publicConfig.deckUrl).toBe("https://example.com/my-slides");
    expect(publicConfig.polls.map((poll) => poll.id)).toEqual(["opening-question"]);
    await stub.updateEventConfig(current);

    expect(() => validateEventConfig({ ...next, deckUrl: "javascript:alert(1)" })).toThrow(
      "deckUrl must use HTTP or HTTPS",
    );
  });

  it("accepts either a token hash or a Worker secret without exposing a default credential", async () => {
    const token = "a-secure-test-token-that-is-long-enough";
    const request = new Request("https://example.com/api/admin/config", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    await expect(isAuthorized(request, hash)).resolves.toBe(true);
    await expect(isAuthorized(request, "", token)).resolves.toBe(true);
    await expect(isAuthorized(request, "", "")).resolves.toBe(false);
    await expect(
      isAuthorized(
        new Request("https://example.com/api/admin/config", {
          headers: { Authorization: "Bearer the-wrong-token-that-is-long-enough" },
        }),
        "",
        token,
      ),
    ).resolves.toBe(false);
  });

  it("creates an isolated hosted event and protects its private links", async () => {
    const createdResponse = await SELF.fetch("https://example.com/api/events", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        title: "第一次公開測試",
        deckUrl: "https://example.com/slides",
        description: "不用部署就開始互動。",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const moderatorCookie = createdResponse.headers.get("set-cookie");
    expect(moderatorCookie).toContain("call_in_moderator=");
    expect(moderatorCookie).toContain("HttpOnly");
    expect(moderatorCookie).toContain("Secure");
    expect(moderatorCookie).toContain("SameSite=Strict");
    const created = await createdResponse.json<{
      eventId: string;
      audienceUrl: string;
      presenterUrl: string;
      setupUrl: string;
      moderatorUrl: string;
      expiresAt: number;
    }>();
    expect(created.eventId).toMatch(/^[a-f0-9]{32}$/);
    expect(created.audienceUrl).toBe(`https://example.com/e/${created.eventId}/`);
    expect(created.presenterUrl).toBe(`https://example.com/e/${created.eventId}/present/`);
    expect(created.expiresAt).toBeGreaterThan(Date.now());

    const audiencePage = await SELF.fetch(created.audienceUrl);
    const presenterPage = await SELF.fetch(created.presenterUrl);
    expect(audiencePage.status).toBe(200);
    expect(await audiencePage.text()).toContain("Call-in 簡單叩應");
    expect(presenterPage.status).toBe(200);
    expect(await presenterPage.text()).toContain("Call-in 講者頁");

    const apiBase = `https://example.com/api/events/${created.eventId}`;
    const publicConfigResponse = await SELF.fetch(`${apiBase}/config`);
    const publicConfig = await publicConfigResponse.json<{
      eventId: string;
      title: string;
      locale: string;
      polls: unknown[];
    }>();
    expect(publicConfig).toMatchObject({
      eventId: created.eventId,
      title: "第一次公開測試",
      locale: "zh-Hant-TW",
      polls: [],
    });

    const setupToken = new URLSearchParams(new URL(created.setupUrl).hash.slice(1)).get("access");
    const moderatorToken = new URLSearchParams(new URL(created.moderatorUrl).hash.slice(1)).get("access");
    expect(setupToken).toMatch(/^[a-f0-9]{64}$/);
    expect(moderatorToken).toMatch(/^[a-f0-9]{64}$/);
    expect(setupToken).not.toBe(moderatorToken);

    expect((await SELF.fetch(`${apiBase}/admin/config`)).status).toBe(404);
    const adminResponse = await SELF.fetch(`${apiBase}/admin/config`, {
      headers: { Authorization: `Bearer ${setupToken}` },
    });
    expect(adminResponse.status).toBe(200);
    expect((await adminResponse.json<{ config: { title: string } }>()).config.title).toBe("第一次公開測試");

    const moderatorResponse = await SELF.fetch(`${apiBase}/moderator/state`, {
      headers: { Authorization: `Bearer ${moderatorToken}` },
    });
    expect(moderatorResponse.status).toBe(200);
    const moderatorCookiePair = moderatorCookie?.split(";")[0] || "";
    expect(moderatorCookie).toContain(`Path=/api/events/${created.eventId}/moderator`);
    expect((await SELF.fetch(`${apiBase}/moderator/state`, {
      headers: { Cookie: moderatorCookiePair },
    })).status).toBe(200);
    expect((await SELF.fetch(`${apiBase}/admin/config`, {
      headers: { Cookie: moderatorCookiePair },
    })).status).toBe(404);
    expect((await SELF.fetch(`${apiBase}/moderator/state`, {
      headers: { Authorization: `Bearer ${setupToken}` },
    })).status).toBe(404);

    const qrResponse = await SELF.fetch(`${apiBase}/qr.svg`);
    expect(qrResponse.status).toBe(200);
    expect(qrResponse.headers.get("content-type")).toContain("image/svg+xml");
    expect(await qrResponse.text()).toContain("<svg");
    expect((await SELF.fetch("https://example.com/e/00000000000000000000000000000000/")).status).toBe(404);
  });

  it("stores an uploaded PDF inside the event and serves it until expiry", async () => {
    const form = new FormData();
    form.set("title", "Uploaded deck");
    form.set("locale", "en");
    form.set("deckFile", new File(["%PDF-1.7\ncall-in-test"], "speaker deck.pdf", { type: "application/pdf" }));
    const createdResponse = await SELF.fetch("https://example.com/api/events", {
      method: "POST",
      body: form,
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ eventId: string; deckMode: string }>();
    expect(created.deckMode).toBe("upload");

    const configResponse = await SELF.fetch(`https://example.com/api/events/${created.eventId}/config`);
    const config = await configResponse.json<{ deckUrl: string; locale: string }>();
    expect(config.deckUrl).toBe(`https://example.com/api/events/${created.eventId}/deck.pdf`);
    expect(config.locale).toBe("en");

    const deck = await SELF.fetch(config.deckUrl);
    expect(deck.status).toBe(200);
    expect(deck.headers.get("content-type")).toBe("application/pdf");
    expect(deck.headers.get("cache-control")).toBe("private, no-store");
    expect(deck.headers.get("content-disposition")).toContain("speaker%20deck.pdf");
    expect(new TextDecoder().decode(await deck.arrayBuffer())).toBe("%PDF-1.7\ncall-in-test");
  });

  it("rejects a file that is named PDF but has no PDF signature", async () => {
    const form = new FormData();
    form.set("title", "Invalid upload");
    form.set("deckFile", new File(["not actually a pdf"], "fake.pdf", { type: "application/pdf" }));
    const response = await SELF.fetch("https://example.com/api/events", { method: "POST", body: form });
    expect(response.status).toBe(400);
    expect(await response.json<{ error: string }>()).toEqual({ error: "File is not a valid PDF" });
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

    const stub = env.LIVE_SESSION.getByName("my-call-in:default");
    await stub.moderateQuestion(first.submission.id, "restore", "other");
    const state = await stub.moderateQuestion(second.submission.id, "restore", "other");
    expect(state.questions).toHaveLength(2);
    expect(state.questions[0]?.text).toBe("Second test question");
    expect(state.questions[0]?.difficulty).toBe(5);

    // Talk to the City 匯入格式：與 /state 同一份公開問題，無需權杖，依提出順序
    const csvResponse = await SELF.fetch("https://example.com/api/export/tttc.csv");
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get("content-type")).toContain("text/csv");
    expect(csvResponse.headers.get("cache-control")).toBe("no-store");
    const csv = await csvResponse.text();
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("id,interview,comment");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('"Second test question"');
    expect(lines[1]).toMatch(/^question-[^,]+,"[^"]+ · (clarify|chorus|bridge|keeper)",/);
    expect(csv).not.toContain("voter");
  });

  it("does not let an author upvote their own question", async () => {
    const author = crypto.randomUUID();
    await register(author, "Question author");
    const question = await postQuestion({
      voterId: author,
      text: "A question should not count its author",
      lens: "clarify",
      difficulty: 3,
    });
    const stub = env.LIVE_SESSION.getByName("my-call-in:default");
    await stub.moderateQuestion(question.submission.id, "restore", "other");

    const response = await SELF.fetch("https://example.com/api/upvote", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ questionId: question.submission.id, voterId: author }),
    });
    expect(response.status).toBe(400);
    expect(await response.json<{ error: string }>()).toEqual({
      error: "cannot upvote your own question",
    });
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
    const stub = env.LIVE_SESSION.getByName("my-call-in:default");
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
    const stub = env.LIVE_SESSION.getByName("my-call-in:default");
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
