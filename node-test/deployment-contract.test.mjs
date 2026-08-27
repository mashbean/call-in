import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const wrangler = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const devVarsExample = await readFile(new URL("../.dev.vars.example", import.meta.url), "utf8");

test("keeps the one-click Cloudflare deployment contract discoverable and deployable", () => {
  assert.match(
    readme.slice(0, 500),
    /\[!\[Deploy to Cloudflare\]\(https:\/\/deploy\.workers\.cloudflare\.com\/button\)\]\(https:\/\/deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/mashbean\/live-deck-kit\)/,
  );
  assert.equal(packageJson.scripts.deploy, "wrangler deploy");
  assert.match(devVarsExample, /^ADMIN_TOKEN=$/m);
  assert.match(devVarsExample, /^MODERATOR_TOKEN=$/m);
  assert.match(packageJson.cloudflare.bindings.ADMIN_TOKEN.description, /\/setup\//);
  assert.match(packageJson.cloudflare.bindings.MODERATOR_TOKEN.description, /\/moderate\//);
  assert.match(readme, /workers\.dev\/setup\//);
  assert.match(readme, /Present from `\/present\/`/);
  assert.equal(wrangler.assets.directory, "./public");
  assert.deepEqual(wrangler.durable_objects.bindings, [
    { name: "LIVE_SESSION", class_name: "LiveSession" },
  ]);
  assert.deepEqual(wrangler.migrations, [
    { tag: "v1", new_sqlite_classes: ["LiveSession"] },
  ]);
});
