import QRCode from "qrcode";
import { timingSafeEqual } from "node:crypto";
import { EVENT_CONFIG, QUESTION_LENSES, REACTION_KINDS } from "./config";
import { LiveSession } from "./live-session";
import type {
  FlagReason,
  ModerationReason,
  QuestionLens,
  ReactionKind,
  SessionMode,
} from "./types";
import { isRecord, readSmallJsonRequest } from "./validation";

export { LiveSession } from "./live-session";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    try {
      if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), request, env);
      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

      if (url.pathname === "/api/config" && request.method === "GET") {
        return withCors(Response.json(EVENT_CONFIG), request, env);
      }
      if (url.pathname === "/api/qr.svg" && request.method === "GET") {
        const target = `${url.origin}/`;
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

      const stub = env.LIVE_SESSION.getByName(`${EVENT_CONFIG.eventId}:${env.ROOM_ID}`);
      if (url.pathname === "/api/live") return stub.fetch(request);
      if (url.pathname === "/api/state" && request.method === "GET") {
        return withCors(Response.json(await stub.snapshot()), request, env);
      }

      if (url.pathname === "/api/moderator/state" && request.method === "GET") {
        if (!(await isAuthorized(request, env.MODERATOR_TOKEN_SHA256))) {
          return jsonError("not found", 404);
        }
        return noStore(Response.json(await stub.moderatorSnapshot()));
      }

      if (url.pathname === "/api/admin/export" && request.method === "GET") {
        if (!(await isAuthorized(request, env.ADMIN_TOKEN_SHA256))) return jsonError("not found", 404);
        return noStore(Response.json(await stub.exportData()));
      }
      if (url.pathname === "/api/admin/reset" && request.method === "POST") {
        if (!(await isAuthorized(request, env.ADMIN_TOKEN_SHA256))) return jsonError("not found", 404);
        return noStore(Response.json(await stub.reset()));
      }

      if (request.method !== "POST") return withCors(jsonError("method not allowed", 405), request, env);
      const body = await readSmallJsonRequest(request);
      if (!isRecord(body)) return withCors(jsonError("invalid request", 400), request, env);

      if (url.pathname === "/api/participant") {
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

      if (url.pathname === "/api/me") {
        if (typeof body.voterId !== "string") {
          return withCors(jsonError("invalid participant", 400), request, env);
        }
        return withCors(Response.json(await stub.participantState(body.voterId)), request, env);
      }

      if (url.pathname.startsWith("/api/moderator/")) {
        if (!(await isAuthorized(request, env.MODERATOR_TOKEN_SHA256))) {
          return jsonError("not found", 404);
        }
        if (url.pathname === "/api/moderator/question") {
          if (
            typeof body.questionId !== "string" ||
            !isQuestionAction(body.action) ||
            !isModerationReason(body.reason)
          ) {
            return jsonError("invalid moderation action", 400);
          }
          return noStore(
            Response.json(await stub.moderateQuestion(body.questionId, body.action, body.reason)),
          );
        }
        if (url.pathname === "/api/moderator/participant") {
          if (
            typeof body.voterId !== "string" ||
            !isParticipantAction(body.action) ||
            !isModerationReason(body.reason)
          ) {
            return jsonError("invalid moderation action", 400);
          }
          return noStore(
            Response.json(await stub.moderateParticipant(body.voterId, body.action, body.reason)),
          );
        }
        if (url.pathname === "/api/moderator/session") {
          if (!isSessionMode(body.mode)) return jsonError("invalid session mode", 400);
          return noStore(Response.json(await stub.setSessionMode(body.mode)));
        }
      }

      if (url.pathname === "/api/vote") {
        if (
          typeof body.pollId !== "string" ||
          typeof body.optionIndex !== "number" ||
          typeof body.voterId !== "string"
        ) {
          return withCors(jsonError("invalid vote", 400), request, env);
        }
        return withCors(Response.json(await stub.vote(body.pollId, body.optionIndex, body.voterId)), request, env);
      }

      if (url.pathname === "/api/question") {
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

      if (url.pathname === "/api/difficulty") {
        if (typeof body.score !== "number" || typeof body.voterId !== "string") {
          return withCors(jsonError("invalid difficulty", 400), request, env);
        }
        return withCors(Response.json(await stub.setDifficulty(body.score, body.voterId)), request, env);
      }

      if (url.pathname === "/api/upvote") {
        if (typeof body.questionId !== "string" || typeof body.voterId !== "string") {
          return withCors(jsonError("invalid upvote", 400), request, env);
        }
        return withCors(Response.json(await stub.upvote(body.questionId, body.voterId)), request, env);
      }

      if (url.pathname === "/api/flag") {
        if (
          typeof body.questionId !== "string" ||
          typeof body.voterId !== "string" ||
          !isFlagReason(body.reason)
        ) {
          return withCors(jsonError("invalid flag", 400), request, env);
        }
        return withCors(
          Response.json(await stub.flagQuestion(body.questionId, body.reason, body.voterId)),
          request,
          env,
        );
      }

      if (url.pathname === "/api/reaction") {
        if (
          typeof body.kind !== "string" ||
          typeof body.voterId !== "string" ||
          !REACTION_KINDS.has(body.kind as ReactionKind)
        ) {
          return withCors(jsonError("invalid reaction", 400), request, env);
        }
        return withCors(
          Response.json(await stub.react(body.kind as ReactionKind, body.voterId)),
          request,
          env,
        );
      }

      return withCors(jsonError("not found", 404), request, env);
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

async function isAuthorized(request: Request, expectedHash: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(expectedHash)) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (token.length < 24 || token.length > 256) return false;
  const actual = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const expected = hexToBytes(expectedHash);
  return timingSafeEqual(new Uint8Array(actual), expected);
}

function isQuestionAction(value: unknown): value is "hide" | "restore" {
  return value === "hide" || value === "restore";
}

function isParticipantAction(
  value: unknown,
): value is "slow" | "review" | "mute" | "restore" {
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
