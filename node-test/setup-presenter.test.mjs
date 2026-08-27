import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const setupHtml = await readFile(new URL("../public/setup/index.html", import.meta.url), "utf8");
const setupJs = await readFile(new URL("../public/setup/setup.js", import.meta.url), "utf8");
const setupCss = await readFile(new URL("../public/setup/setup.css", import.meta.url), "utf8");
const presentHtml = await readFile(new URL("../public/present/index.html", import.meta.url), "utf8");
const presentJs = await readFile(new URL("../public/present/present.js", import.meta.url), "utf8");
const presentCss = await readFile(new URL("../public/present/present.css", import.meta.url), "utf8");
const eventContextJs = await readFile(new URL("../public/event-context.js", import.meta.url), "utf8");
const landingHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const englishLandingHtml = await readFile(new URL("../public/en/index.html", import.meta.url), "utf8");
const landingJs = await readFile(new URL("../public/landing/landing.js", import.meta.url), "utf8");
const landingCss = await readFile(new URL("../public/landing/landing.css", import.meta.url), "utf8");
const creatorJs = await readFile(new URL("../public/new/new.js", import.meta.url), "utf8");

test("setup wizard keeps the admin token session-scoped and writes protected config", () => {
  assert.match(setupHtml, /lang="zh-Hant-TW"/);
  assert.match(setupHtml, /data-config-form/);
  assert.match(setupHtml, /href="\/present\/"/);
  assert.match(setupJs, /consumeAccessToken\("admin"\)/);
  assert.match(eventContextJs, /sessionStorage\.setItem\(key, access\)/);
  assert.doesNotMatch(setupJs, /localStorage/);
  assert.match(setupJs, /eventContext\.apiBase}\/admin\/config/);
  assert.match(setupJs, /method: "POST"/);
  assert.match(setupCss, /@media \(max-width: 820px\)/);
  assert.match(setupCss, /@media \(max-width: 560px\)/);
});

test("presenter view loads a safe deck URL and exposes responsive dashboard controls", () => {
  assert.match(presentHtml, /lang="zh-Hant-TW"/);
  assert.match(presentHtml, /data-deck-frame/);
  assert.match(presentHtml, /data-dashboard-toggle/);
  assert.match(presentHtml, /data-toolbar-toggle/);
  assert.match(presentHtml, /data-toolbar-peek/);
  assert.match(presentHtml, /src="\/dashboard\/"/);
  assert.match(presentJs, /eventContext\.apiBase}\/config/);
  assert.match(presentJs, /\["http:", "https:"\]/);
  assert.match(presentJs, /!parsed\.username && !parsed\.password/);
  assert.match(presentJs, /toolbar-collapsed/);
  assert.match(presentCss, /@media \(max-width: 1024px\)/);
  assert.match(presentCss, /@media \(max-width: 720px\)/);
});

test("hosted creator replaces the landing-page demo and returns public and private links", () => {
  assert.match(landingHtml, /lang="zh-Hant-TW"/);
  assert.match(landingHtml, /點一下，換成你的簡報/);
  assert.match(landingHtml, /data-open-creator/);
  assert.match(landingHtml, /data-create-form/);
  assert.match(landingHtml, /上傳 PDF/);
  assert.match(landingHtml, /最大 20MB/);
  assert.match(landingHtml, /data-presenter-link/);
  assert.match(landingHtml, /data-audience-qr/);
  assert.match(landingHtml, /data-setup-link/);
  assert.match(landingHtml, /data-moderator-link/);
  assert.match(englishLandingHtml, /Click to use your slides/);
  assert.doesNotMatch(landingHtml, /Call-in 只保留完成本場活動所需的資料/);
  assert.doesNotMatch(landingHtml, />CALL-IN</);
  assert.match(landingHtml, /https:\/\/buymeacoffee\.com\/mashbean/);
  assert.match(landingHtml, /請作者喝杯咖啡/);
  assert.match(englishLandingHtml, /https:\/\/buymeacoffee\.com\/mashbean/);
  assert.match(englishLandingHtml, /Buy me a coffee/);
  assert.doesNotMatch(landingHtml, /Sponsors 即將開放|GitHub Sponsors 收款通道正在準備/);
  assert.doesNotMatch(englishLandingHtml, /Sponsors coming soon|GitHub Sponsors payment channel is being prepared/);
  assert.match(landingJs, /openCreator/);
  assert.match(creatorJs, /fetch\("\/api\/events"/);
  assert.match(creatorJs, /new FormData\(form\)/);
  assert.match(creatorJs, /result\.presenterUrl/);
  assert.match(creatorJs, /result\.setupUrl/);
  assert.match(creatorJs, /result\.moderatorUrl/);
  assert.match(landingCss, /@media \(max-width: 620px\)/);
});
