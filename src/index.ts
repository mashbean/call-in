import QRCode from "qrcode";
import { timingSafeEqual } from "node:crypto";
import { EVENT_CONFIG, QUESTION_LENSES, REACTION_KINDS, validateEventConfig } from "./config";
import { LiveSession } from "./live-session";
import type {
  FlagReason,
  ModerationReason,
  PublicEventConfig,
  QuestionLens,
  ReactionKind,
  SessionMode,
} from "./types";
import { isRecord, readSmallJsonRequest } from "./validation";

export { LiveSession } from "./live-session";

const hostedEventIdPattern = /^[a-f0-9]{32}$/;
const hostedEventLifetimeMs = 7 * 24 * 60 * 60 * 1000;

type SessionApiContext = {
  stub: DurableObjectStub<LiveSession>;
  hostedEventId?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    try {
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }), request, env);
      }

      if (!url.pathname.startsWith("/api/")) {
        const hostedPage = parseHostedPage(url.pathname);
        if (!hostedPage) return env.ASSETS.fetch(request);
        const stub = env.LIVE_SESSION.getByName(`hosted:${hostedPage.eventId}`);
        if (!(await stub.isHostedEvent())) return new Response("Event not found", { status: 404 });
        const assetUrl = new URL(hostedPage.assetPath, url.origin);
        return env.ASSETS.fetch(new Request(assetUrl, request));
      }

      if (url.pathname === "/api/events") {
        if (request.method !== "POST") return jsonError("method not allowed", 405);
        return withCors(await createHostedEvent(request, env), request, env);
      }

      const hostedApi = parseHostedApi(url.pathname);
      if (hostedApi) {
        const stub = env.LIVE_SESSION.getByName(`hosted:${hostedApi.eventId}`);
        if (!(await stub.isHostedEvent())) return withCors(jsonError("not found", 404), request, env);
        return await handleSessionApi(request, env, hostedApi.path, {
          stub,
          hostedEventId: hostedApi.eventId,
        });
      }

      const stub = env.LIVE_SESSION.getByName(`${EVENT_CONFIG.eventId}:${env.ROOM_ID}`);
      return await handleSessionApi(request, env, url.pathname.slice(4) || "/", { stub });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      const status =
        message.includes("limit") || message.includes("cooldown")
          ? 429
          : message.includes("too large")
            ? 413
            : 400;
      console.error(
        JSON.stringify({ message: "request failed", requestId, path: url.pathname, error: message }),
      );
      return withCors(jsonError(message, status), request, env);
    }
  },
} satisfies ExportedHandler<Env>;

async function createHostedEvent(request: Request, env: Env): Promise<Response> {
  const body = await readSmallJsonRequest(request);
  if (!isRecord(body)) return jsonError("invalid request", 400);
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const deckUrl = typeof body.deckUrl === "string" ? body.deckUrl.trim() : "";
  if (!title || !deckUrl) return jsonError("title and deck URL are required", 400);
  assertHostedDeckUrl(deckUrl, request);

  const createdAt = Date.now();
  const limiter = env.LIVE_SESSION.getByName("hosted:creation-limiter");
  await limiter.reserveHostedEvent(createdAt);

  const eventId = crypto.randomUUID().replaceAll("-", "");
  const adminToken = randomToken();
  const moderatorToken = randomToken();
  const config = hostedEventConfig(eventId, title, description, deckUrl, createdAt);
  const expiresAt = createdAt + hostedEventLifetimeMs;
  const stub = env.LIVE_SESSION.getByName(`hosted:${eventId}`);
  await stub.initializeHostedEvent(
    config,
    await hashToken(adminToken),
    await hashToken(moderatorToken),
    createdAt,
    expiresAt,
  );

  const base = `${new URL(request.url).origin}/e/${eventId}`;
  return noStore(
    Response.json(
      {
        eventId,
        title,
        expiresAt,
        audienceUrl: `${base}/`,
        presenterUrl: `${base}/present/`,
        setupUrl: `${base}/setup/#access=${adminToken}`,
        moderatorUrl: `${base}/moderate/#access=${moderatorToken}`,
      },
      { status: 201 },
    ),
  );
}

async function handleSessionApi(
  request: Request,
  env: Env,
  path: string,
  context: SessionApiContext,
): Promise<Response> {
  const { stub, hostedEventId } = context;
  const url = new URL(request.url);
  if (path === "/config" && request.method === "GET") {
    return withCors(Response.json(await stub.eventConfig()), request, env);
  }
  if (path === "/qr.svg" && request.method === "GET") {
    const target = hostedEventId ? `${url.origin}/e/${hostedEventId}/` : `${url.origin}/`;
    const svg = await QRCode.toString(target, {
      type: "svg",
      color: { dark: "#081225", light: "#f3eee4" },
      margin: 1,
      width: 320,
      errorCorrectionLevel: "M",
    });
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (path === "/live") return stub.fetch(request);
  if (path === "/state" && request.method === "GET") {
    return withCors(Response.json(await stub.snapshot()), request, env);
  }

  if (path === "/moderator/state" && request.method === "GET") {
    if (!(await isRoleAuthorized(request, env, context, "moderator"))) return jsonError("not found", 404);
    return noStore(Response.json(await stub.moderatorSnapshot()));
  }

  if (path === "/admin/export" && request.method === "GET") {
    if (!(await isRoleAuthorized(request, env, context, "admin"))) return jsonError("not found", 404);
    return noStore(Response.json(await stub.exportData()));
  }
  if (path === "/admin/reset" && request.method === "POST") {
    if (!(await isRoleAuthorized(request, env, context, "admin"))) return jsonError("not found", 404);
    return noStore(Response.json(await stub.reset()));
  }
  if (path === "/admin/config") {
    if (!(await isRoleAuthorized(request, env, context, "admin"))) return jsonError("not found", 404);
    if (request.method === "GET") {
      return noStore(Response.json({ config: await stub.eventConfig() }));
    }
    if (request.method === "POST") {
      const config = await readSmallJsonRequest(request, 16_384);
      return noStore(Response.json(await stub.updateEventConfig(config)));
    }
    return jsonError("method not allowed", 405);
  }

  if (request.method !== "POST") return withCors(jsonError("method not allowed", 405), request, env);
  const body = await readSmallJsonRequest(request);
  if (!isRecord(body)) return withCors(jsonError("invalid request", 400), request, env);

  if (path === "/participant") {
    if (
      typeof body.alias !== "string" ||
      typeof body.cocVersion !== "string" ||
      typeof body.voterId !== "string"
    ) {
      return withCors(jsonError("invalid participant", 400), request, env);
    }
    return withCors(
      Response.json(await stub.registerParticipant(body.alias, body.cocVersion, body.voterId)),
      request,
      env,
    );
  }

  if (path === "/me") {
    if (typeof body.voterId !== "string") {
      return withCors(jsonError("invalid participant", 400), request, env);
    }
    return withCors(Response.json(await stub.participantState(body.voterId)), request, env);
  }

  if (path.startsWith("/moderator/")) {
    if (!(await isRoleAuthorized(request, env, context, "moderator"))) return jsonError("not found", 404);
    if (path === "/moderator/question") {
      if (
        typeof body.questionId !== "string" ||
        !isQuestionAction(body.action) ||
        !isModerationReason(body.reason)
      ) {
        return jsonError("invalid moderation action", 400);
      }
      return noStore(Response.json(await stub.moderateQuestion(body.questionId, body.action, body.reason)));
    }
    if (path === "/moderator/participant") {
      if (
        typeof body.voterId !== "string" ||
        !isParticipantAction(body.action) ||
        !isModerationReason(body.reason)
      ) {
        return jsonError("invalid moderation action", 400);
      }
      return noStore(Response.json(await stub.moderateParticipant(body.voterId, body.action, body.reason)));
    }
    if (path === "/moderator/session") {
      if (!isSessionMode(body.mode)) return jsonError("invalid session mode", 400);
      return noStore(Response.json(await stub.setSessionMode(body.mode)));
    }
  }

  if (path === "/vote") {
    if (
      typeof body.pollId !== "string" ||
      typeof body.optionIndex !== "number" ||
      typeof body.voterId !== "string"
    ) {
      return withCors(jsonError("invalid vote", 400), request, env);
    }
    return withCors(Response.json(await stub.vote(body.pollId, body.optionIndex, body.voterId)), request, env);
  }

  if (path === "/question") {
    if (
      typeof body.text !== "string" ||
      (typeof body.nickname !== "string" && body.nickname !== undefined) ||
      typeof body.lens !== "string" ||
      typeof body.difficulty !== "number" ||
      typeof body.voterId !== "string" ||
      !QUESTION_LENSES.has(body.lens as QuestionLens)
    ) {
      return withCors(jsonError("invalid question", 400), request, env);
    }
    return withCors(
      Response.json(
        await stub.ask(
          body.text,
          typeof body.nickname === "string" ? body.nickname : "",
          body.lens as QuestionLens,
          body.difficulty,
          body.voterId,
        ),
      ),
      request,
      env,
    );
  }

  if (path === "/difficulty") {
    if (typeof body.score !== "number" || typeof body.voterId !== "string") {
      return withCors(jsonError("invalid difficulty", 400), request, env);
    }
    return withCors(Response.json(await stub.setDifficulty(body.score, body.voterId)), request, env);
  }

  if (path === "/upvote") {
    if (typeof body.questionId !== "string" || typeof body.voterId !== "string") {
      return withCors(jsonError("invalid upvote", 400), request, env);
    }
    return withCors(Response.json(await stub.upvote(body.questionId, body.voterId)), request, env);
  }

  if (path === "/flag") {
    if (
      typeof body.questionId !== "string" ||
      typeof body.voterId !== "string" ||
      !isFlagReason(body.reason)
    ) {
      return withCors(jsonError("invalid flag", 400), request, env);
    }
    return withCors(Response.json(await stub.flagQuestion(body.questionId, body.reason, body.voterId)), request, env);
  }

  if (path === "/reaction") {
    if (
      typeof body.kind !== "string" ||
      typeof body.voterId !== "string" ||
      !REACTION_KINDS.has(body.kind as ReactionKind)
    ) {
      return withCors(jsonError("invalid reaction", 400), request, env);
    }
    return withCors(Response.json(await stub.react(body.kind as ReactionKind, body.voterId)), request, env);
  }

  return withCors(jsonError("not found", 404), request, env);
}

async function isRoleAuthorized(
  request: Request,
  env: Env,
  context: SessionApiContext,
  role: "admin" | "moderator",
): Promise<boolean> {
  if (context.hostedEventId) return context.stub.isHostedAuthorized(role, bearerToken(request));
  return role === "admin"
    ? isAuthorized(request, env.ADMIN_TOKEN_SHA256, env.ADMIN_TOKEN)
    : isAuthorized(request, env.MODERATOR_TOKEN_SHA256, env.MODERATOR_TOKEN);
}

function hostedEventConfig(
  eventId: string,
  title: string,
  description: string,
  deckUrl: string,
  createdAt: number,
): PublicEventConfig {
  return validateEventConfig({
    ...structuredClone(EVENT_CONFIG),
    eventId,
    eyebrow: "LIVE DECK",
    title,
    description: description || "掃描 QR Code，回報理解程度、提出問題或送出即時反應。",
    dashboardTitle: `${title}・現場互動`,
    deckUrl,
    locale: "zh-Hant-TW",
    difficulty: {
      title: "現在的理解難度如何？",
      labels: ["太簡單", "容易", "剛剛好", "有點難", "跟丟了"],
    },
    question: {
      title: "隨時提問",
      placeholder: "寫下不清楚、想繼續追問，或值得一起討論的地方",
      maxPerDevice: 20,
      lenses: [
        { id: "clarify", label: "請講清楚", description: "幫我理解這個觀念或方法" },
        { id: "chorus", label: "我也想問", description: "看看還有誰關心同一個問題" },
        { id: "bridge", label: "連結兩邊", description: "一起釐清兩種方向之間的取捨" },
        { id: "keeper", label: "請留下來", description: "這個條件、風險或限制值得保留" },
      ],
    },
    moderation: {
      enabled: true,
      presentationDelaySeconds: 8,
      questionCooldownSeconds: 20,
      questionsPerTenMinutes: 5,
      slowModeSeconds: 90,
      flags: {
        enabled: true,
        maxPerDevice: 8,
        autoHoldMin: 3,
        autoHoldMax: 5,
        autoHoldParticipantRatio: 0.03,
      },
      codeOfConduct: {
        version: new Date(createdAt).toISOString().slice(0, 10),
        title: "一起維持有用的討論",
        summary: "直接討論觀點、方法與結論，讓問題能推進現場交流。",
        rules: [
          "不做人身攻擊、騷擾、威脅或揭露私人資訊。",
          "不洗版、冒充他人或刻意干擾討論。",
          "管理者可以暫緩或隱藏內容，並限制本場活動的提問權限。",
        ],
      },
    },
    reactions: [
      { id: "applause", emoji: "👏", label: "說得好" },
      { id: "insight", emoji: "💡", label: "有收穫" },
      { id: "resonate", emoji: "❤️", label: "有共鳴" },
      { id: "pause", emoji: "🤔", label: "等我一下" },
    ],
    polls: [],
  });
}

function parseHostedApi(pathname: string): { eventId: string; path: string } | null {
  const match = pathname.match(/^\/api\/events\/([a-f0-9]{32})(\/.*)$/);
  const eventId = match?.[1];
  const path = match?.[2];
  if (!eventId || !path || !hostedEventIdPattern.test(eventId)) return null;
  return { eventId, path };
}

function parseHostedPage(pathname: string): { eventId: string; assetPath: string } | null {
  const match = pathname.match(/^\/e\/([a-f0-9]{32})(?:\/(.*))?$/);
  const eventId = match?.[1];
  if (!eventId || !hostedEventIdPattern.test(eventId)) return null;
  const page = (match[2] || "").replace(/\/+$/, "");
  const assetPath = ({
    "": "/",
    dashboard: "/dashboard/",
    present: "/present/",
    setup: "/setup/",
    moderate: "/moderate/",
  } as Record<string, string>)[page];
  return assetPath ? { eventId, assetPath } : null;
}

function assertHostedDeckUrl(value: string, request: Request): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("deck URL must be a complete web address");
  }
  const requestHost = new URL(request.url).hostname;
  const localRequest = requestHost === "localhost" || requestHost === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(localRequest && parsed.protocol === "http:")) {
    throw new Error("deck URL must use HTTPS");
  }
  if (parsed.username || parsed.password) throw new Error("deck URL cannot contain credentials");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

export async function isAuthorized(
  request: Request,
  expectedHash: string,
  expectedSecret?: string,
): Promise<boolean> {
  const token = bearerToken(request);
  if (token.length < 24 || token.length > 256) return false;
  const actual = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const expected = /^[0-9a-f]{64}$/i.test(expectedHash)
    ? hexToBytes(expectedHash)
    : expectedSecret && expectedSecret.length >= 24 && expectedSecret.length <= 256
      ? new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expectedSecret)))
      : null;
  if (!expected) return false;
  return timingSafeEqual(new Uint8Array(actual), expected);
}

function isQuestionAction(value: unknown): value is "hide" | "restore" {
  return value === "hide" || value === "restore";
}

function isParticipantAction(value: unknown): value is "slow" | "review" | "mute" | "restore" {
  return value === "slow" || value === "review" || value === "mute" || value === "restore";
}

function isModerationReason(value: unknown): value is ModerationReason {
  return ["harassment", "disruption", "off_topic", "privacy", "other"].includes(String(value));
}

function isFlagReason(value: unknown): value is FlagReason {
  return ["harassment", "disruption", "off_topic", "privacy"].includes(String(value));
}

function isSessionMode(value: unknown): value is SessionMode {
  return ["open", "slow", "approval", "paused", "closed"].includes(String(value));
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function jsonError(error: string, status: number): Response {
  return noStore(Response.json({ error }, { status }));
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get("origin");
  const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean);
  const allowed = origin !== null && (origin === new URL(request.url).origin || allowedOrigins.includes(origin));
  const secured = noStore(response);
  const headers = new Headers(secured.headers);
  if (allowed && origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Vary", "Origin");
  return new Response(secured.body, {
    status: secured.status,
    statusText: secured.statusText,
    headers,
  });
}
