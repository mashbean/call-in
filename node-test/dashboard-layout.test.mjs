import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardScript = await readFile(new URL("../public/dashboard/dashboard.js", import.meta.url), "utf8");
const dashboardStyles = await readFile(new URL("../public/dashboard/dashboard.css", import.meta.url), "utf8");

test("moves the audience shortcut above the panel toggle only when embedded", () => {
  assert.match(
    dashboardScript,
    /classList\.toggle\("embedded-dashboard", window\.self !== window\.top\)/,
  );
  assert.match(
    dashboardStyles,
    /html\.embedded-dashboard \.dashboard-open\s*{[^}]*bottom:\s*calc\(max\(14px, env\(safe-area-inset-bottom\)\) \+ 52px\)/s,
  );
  assert.match(
    dashboardStyles,
    /\.dashboard-open\s*{[^}]*right:\s*14px[^}]*bottom:\s*14px/s,
  );
});
