import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const wrangler = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

test("keeps optional self-hosting deployable without adding setup steps to the hosted flow", () => {
  assert.match(
    readme,
    /\[!\[Deploy to Cloudflare\]\(https:\/\/deploy\.workers\.cloudflare\.com\/button\)\]\(https:\/\/deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/mashbean\/live-deck-kit\)/,
  );
  assert.equal(packageJson.scripts.deploy, "wrangler deploy");
  assert.match(readme, /\/new\//);
  assert.match(readme, /Self-host/);
  assert.equal(wrangler.assets.directory, "./public");
  assert.deepEqual(wrangler.durable_objects.bindings, [
    { name: "LIVE_SESSION", class_name: "LiveSession" },
  ]);
  assert.deepEqual(wrangler.migrations, [
    { tag: "v1", new_sqlite_classes: ["LiveSession"] },
  ]);
});
