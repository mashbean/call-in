import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardScript = await readFile(new URL("../public/dashboard/dashboard.js", import.meta.url), "utf8");
const dashboardStyles = await readFile(new URL("../public/dashboard/dashboard.css", import.meta.url), "utf8");

test("hides the redundant audience shortcut when the dashboard is embedded", () => {
  assert.match(
    dashboardScript,
    /classList\.toggle\("embedded-dashboard", window\.self !== window\.top\)/,
  );
  assert.match(
    dashboardStyles,
    /html\.embedded-dashboard \.dashboard-open\s*{[^}]*display:\s*none/s,
  );
  assert.match(
    dashboardStyles,
    /\.dashboard-open\s*{[^}]*right:\s*14px[^}]*bottom:\s*14px/s,
  );
});
