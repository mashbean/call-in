import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const setupHtml = await readFile(new URL("../public/setup/index.html", import.meta.url), "utf8");
const setupJs = await readFile(new URL("../public/setup/setup.js", import.meta.url), "utf8");
const setupCss = await readFile(new URL("../public/setup/setup.css", import.meta.url), "utf8");
const presentHtml = await readFile(new URL("../public/present/index.html", import.meta.url), "utf8");
const presentJs = await readFile(new URL("../public/present/present.js", import.meta.url), "utf8");
const presentCss = await readFile(new URL("../public/present/present.css", import.meta.url), "utf8");

test("setup wizard keeps the admin token session-scoped and writes protected config", () => {
  assert.match(setupHtml, /lang="zh-Hant-TW"/);
  assert.match(setupHtml, /data-config-form/);
  assert.match(setupHtml, /href="\/present\/"/);
  assert.match(setupJs, /sessionStorage\.setItem\(tokenKey, token\)/);
  assert.doesNotMatch(setupJs, /localStorage/);
  assert.match(setupJs, /request\("\/api\/admin\/config"/);
  assert.match(setupJs, /method: "POST"/);
  assert.match(setupCss, /@media \(max-width: 820px\)/);
  assert.match(setupCss, /@media \(max-width: 560px\)/);
});

test("presenter view loads a safe deck URL and exposes responsive dashboard controls", () => {
  assert.match(presentHtml, /lang="zh-Hant-TW"/);
  assert.match(presentHtml, /data-deck-frame/);
  assert.match(presentHtml, /data-dashboard-toggle/);
  assert.match(presentHtml, /src="\/dashboard\/"/);
  assert.match(presentJs, /fetch\("\/api\/config"\)/);
  assert.match(presentJs, /\["http:", "https:"\]/);
  assert.match(presentJs, /!parsed\.username && !parsed\.password/);
  assert.match(presentCss, /@media \(max-width: 1024px\)/);
  assert.match(presentCss, /@media \(max-width: 720px\)/);
});
