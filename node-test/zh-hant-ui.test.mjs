import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const publicFiles = [
  "public/index.html",
  "public/app.js",
  "public/difficulty.js",
  "public/dashboard/index.html",
  "public/dashboard/dashboard.js",
  "public/moderate/index.html",
  "public/moderate/moderate.js",
  "public/embed/live-deck-panel.js",
  "public/example/index.html",
];

const retiredEnglishCopy = [
  "Hide dashboard",
  "Live audience",
  "Restore question",
  "Slow 10 min",
  "Review future",
  "Mute questions",
  "Restore participant",
  "AUTHOR ONLY",
  "Moderator connected",
  "Poll results",
  "Waiting for the first response",
  "Quick polls",
  "Send question",
  "Connecting",
];

test("all public interfaces use Traditional Chinese copy", async () => {
  const sources = await Promise.all(publicFiles.map((file) => readFile(file, "utf8")));
  const combined = sources.join("\n");
  for (const phrase of retiredEnglishCopy) {
    assert.equal(combined.includes(phrase), false, `retired English copy remains: ${phrase}`);
  }
  for (const file of publicFiles.filter((path) => path.endsWith(".html"))) {
    const source = await readFile(file, "utf8");
    assert.match(source, /<html lang="zh-Hant-TW">/, `${file} must declare Traditional Chinese`);
  }
  assert.match(combined, /已將這名參與者限速 10 分鐘/);
  assert.match(combined, /後續提問將先經過審核/);
  assert.match(combined, /已暫停這名參與者的提問權限/);
  assert.match(combined, /已恢復這名參與者的提問權限/);
});
