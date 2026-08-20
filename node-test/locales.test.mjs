import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const localesDir = path.join(publicDir, "locales");
const FALLBACK = "en";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function localeFiles() {
  const entries = await readdir(localesDir);
  return entries.filter((entry) => entry.endsWith(".json"));
}

function flatten(pack) {
  return Object.entries(pack).map(([key, value]) => [key, value]);
}

test("the fallback pack exists and holds only strings or plural objects", async () => {
  const pack = await readJson(path.join(localesDir, `${FALLBACK}.json`));
  assert.ok(Object.keys(pack).length > 0);
  for (const [key, value] of flatten(pack)) {
    if (typeof value === "string") continue;
    assert.equal(typeof value, "object", `${key} must be a string or a plural object`);
    assert.equal(typeof value.other, "string", `${key} needs an "other" form`);
    if ("one" in value) assert.equal(typeof value.one, "string");
  }
});

test("every translation only defines keys the fallback pack knows", async () => {
  const fallback = await readJson(path.join(localesDir, `${FALLBACK}.json`));
  for (const file of await localeFiles()) {
    if (file === `${FALLBACK}.json`) continue;
    const pack = await readJson(path.join(localesDir, file));
    for (const key of Object.keys(pack)) {
      assert.ok(key in fallback, `${file} defines "${key}", which ${FALLBACK}.json does not`);
    }
  }
});

test("every placeholder in a translation also appears in the fallback text", async () => {
  const placeholders = (value) => {
    const text = typeof value === "string" ? value : [value?.one, value?.other].join(" ");
    return new Set([...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
  };
  const fallback = await readJson(path.join(localesDir, `${FALLBACK}.json`));
  for (const file of await localeFiles()) {
    if (file === `${FALLBACK}.json`) continue;
    const pack = await readJson(path.join(localesDir, file));
    for (const [key, value] of Object.entries(pack)) {
      const expected = placeholders(fallback[key]);
      for (const name of placeholders(value)) {
        assert.ok(expected.has(name), `${file}: "${key}" uses {${name}}, which ${FALLBACK} does not`);
      }
    }
  }
});

test("every key referenced by the shipped pages is defined in the fallback pack", async () => {
  const sources = [
    "app.js",
    "difficulty.js",
    "index.html",
    "dashboard/index.html",
    "dashboard/dashboard.js",
    "moderate/index.html",
    "moderate/moderate.js",
  ];
  const fallback = await readJson(path.join(localesDir, `${FALLBACK}.json`));
  const missing = [];
  for (const source of sources) {
    const text = await readFile(path.join(publicDir, source), "utf8");
    const keys = [
      ...text.matchAll(/\bt\(\s*"([a-z][\w.]*)"/g),
      ...text.matchAll(/data-i18n(?:-[a-z-]+)?="([a-z][\w.]*)"/g),
    ]
      .map((match) => match[1])
      // A dotted name is an i18n key. Bare words are lookalikes such as
      // `data.get("alias")`, which happen to end in `t(`.
      .filter((key) => key.includes("."));
    for (const key of keys) {
      if (!(key in fallback)) missing.push(`${source}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});
