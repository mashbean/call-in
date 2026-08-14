#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function integrateDeck(options) {
  const deckPath = path.resolve(options.deck);
  const source = await readFile(deckPath, "utf8");
  if (!/<\/body\s*>/i.test(source)) throw new Error("Could not find </body>. Provide a complete HTML slide deck file");

  const serviceUrl = normalizeServiceUrl(options.serviceUrl);
  const scriptUrl = serviceUrl ? `${serviceUrl}/embed/live-deck-panel.js` : "/embed/live-deck-panel.js";
  const attributes = [
    `service-url="${escapeAttribute(serviceUrl || "/")}"`,
    `mode="${options.mode === "split" ? "split" : "overlay"}"`,
  ];
  if (options.targetSelector) attributes.push(`target-selector="${escapeAttribute(options.targetSelector)}"`);
  if (options.desktopWidth) attributes.push(`desktop-width="${escapeAttribute(options.desktopWidth)}"`);

  const block = [
    "<!-- live-deck-kit:start -->",
    `<script type="module" src="${escapeAttribute(scriptUrl)}"></script>`,
    `<live-deck-panel ${attributes.join(" ")}></live-deck-panel>`,
    "<!-- live-deck-kit:end -->",
  ].join("\n");
  const marker = /<!-- live-deck-kit:start -->[\s\S]*?<!-- live-deck-kit:end -->/;
  if (!marker.test(source) && /<live-deck-panel\b/i.test(source)) {
    throw new Error("The deck already contains an unmanaged <live-deck-panel>. Review and remove the old snippet first");
  }
  const next = marker.test(source) ? source.replace(marker, block) : source.replace(/<\/body\s*>/i, `${block}\n</body>`);
  await writeFile(deckPath, next);
  return { deckPath, serviceUrl: serviceUrl || "same-origin", mode: options.mode };
}

export async function configureAdminToken(tokenInput) {
  const token = tokenInput || randomBytes(32).toString("base64url");
  if (token.length < 24) throw new Error("The admin token must contain at least 24 characters");
  const hash = createHash("sha256").update(token).digest("hex");
  const wranglerPath = path.join(packageRoot, "wrangler.jsonc");
  const source = await readFile(wranglerPath, "utf8");
  const next = source.replace(
    /("ADMIN_TOKEN_SHA256"\s*:\s*")[0-9a-f]*(")/i,
    `$1${hash}$2`,
  );
  if (next === source) throw new Error("wrangler.jsonc is missing ADMIN_TOKEN_SHA256");
  await writeFile(wranglerPath, next);
  await writeFile(path.join(packageRoot, ".live-deck-admin-token"), `${token}\n`, { mode: 0o600 });
  return { hash, tokenPath: path.join(packageRoot, ".live-deck-admin-token") };
}

export async function doctor() {
  const requiredFiles = [
    "public/event.config.json",
    "wrangler.jsonc",
    "src/index.ts",
    "src/live-session.ts",
    "public/index.html",
    "public/dashboard/index.html",
    "public/embed/live-deck-panel.js",
    "skills/live-deck-kit/SKILL.md",
  ];
  const missing = [];
  for (const file of requiredFiles) {
    try {
      await stat(path.join(packageRoot, file));
    } catch {
      missing.push(file);
    }
  }
  const config = JSON.parse(await readFile(path.join(packageRoot, "public", "event.config.json"), "utf8"));
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.eventId || "")) errors.push("eventId must be a lowercase slug");
  if (!Array.isArray(config.polls) || config.polls.length > 8) errors.push("polls must contain zero to eight polls");
  if (config.difficulty?.labels?.length !== 5) errors.push("difficulty.labels must contain exactly five labels");
  if (missing.length) errors.push(`Missing files: ${missing.join(", ")}`);
  return { ok: errors.length === 0, errors, eventId: config.eventId, pollCount: config.polls?.length ?? 0 };
}

export async function installSkill(options = {}) {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const target = path.join(codexHome, "skills", "live-deck-kit");
  try {
    await stat(target);
    if (!options.force) throw new Error(`${target} already exists. Add --force to overwrite it`);
  } catch (error) {
    if (error instanceof Error && !error.message.includes("ENOENT") && !error.message.includes("already exists")) throw error;
    if (error instanceof Error && error.message.includes("already exists")) throw error;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(packageRoot, "skills", "live-deck-kit"), target, { recursive: true, force: Boolean(options.force) });
  return { target };
}

async function main(argv) {
  const command = argv[2] || "help";
  const args = parseArgs(argv.slice(3));
  if (command === "integrate") {
    if (!args.deck || !args["service-url"]) throw new Error("Usage: live-deck-kit integrate --deck <index.html> --service-url <https://...>");
    const result = await integrateDeck({
      deck: args.deck,
      serviceUrl: args["service-url"],
      mode: args.mode || "overlay",
      targetSelector: args["target-selector"],
      desktopWidth: args["desktop-width"],
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  if (command === "admin-token") {
    const result = await configureAdminToken(args.token);
    console.log(JSON.stringify({ ok: true, tokenPath: result.tokenPath, hash: result.hash }, null, 2));
    return;
  }
  if (command === "doctor") {
    const result = await doctor();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "install-skill") {
    const result = await installSkill({ force: Boolean(args.force) });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  console.log(`Live Deck Kit

Commands
  doctor
  integrate --deck <index.html> --service-url <https://...> [--mode overlay|split]
  admin-token [--token <24+ chars>]
  install-skill [--force]`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function normalizeServiceUrl(value) {
  if (value === "/") return "";
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("service-url must use HTTPS, except for localhost");
  }
  return value.replace(/\/+$/, "");
}

function escapeAttribute(value) {
  return String(value).replace(/[&"<>]/g, (character) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[character]);
}

const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
  : "";

if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
