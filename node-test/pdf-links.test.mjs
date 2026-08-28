import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewer = await readFile(new URL("../public/present/pdf-viewer.js", import.meta.url), "utf8");
const viewerHtml = await readFile(new URL("../public/present/pdf-viewer.html", import.meta.url), "utf8");
const viewerCss = await readFile(new URL("../public/present/pdf-viewer.css", import.meta.url), "utf8");
const presenter = await readFile(new URL("../public/present/present.js", import.meta.url), "utf8");
const presenterHtml = await readFile(new URL("../public/present/index.html", import.meta.url), "utf8");

test("renders PDF link annotations behind a protocol whitelist with safe new-tab attributes", () => {
  assert.match(viewer, /getAnnotations\(/);
  assert.match(viewer, /\["http:", "https:", "mailto:"\]/);
  assert.match(viewer, /rel = "noopener noreferrer"/);
  assert.match(viewer, /convertToViewportPoint/);
  assert.match(viewerHtml, /data-pdf-links/);
  assert.match(viewerCss, /\.pdf-link-layer \{[^}]*pointer-events: none/);
});

test("clears stale links before rendering and swallows the click a swipe produces", () => {
  assert.match(viewer, /linkLayer\.replaceChildren\(\)/);
  assert.match(viewer, /suppressLinkClick = true/);
});

test("lets only the same-origin PDF viewer escape the deck sandbox for popups", () => {
  assert.match(presenter, /if \(hostedPdf\) deckFrame\.sandbox\.add\("allow-popups-to-escape-sandbox"\)/);
  assert.doesNotMatch(presenterHtml, /allow-popups-to-escape-sandbox/);
  assert.match(presenterHtml, /sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"/);
});
