import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/seed-demo.mjs", import.meta.url));

test("rejects unsafe or invalid arguments before making a request", () => {
  const invalidUrl = spawnSync(process.execPath, [script, "questions", "ftp://example.com"], {
    encoding: "utf8",
  });
  assert.equal(invalidUrl.status, 1);
  assert.match(invalidUrl.stderr, /must use http or https/);

  const invalidCount = spawnSync(
    process.execPath,
    [script, "reactions", "https://example.com", "-1", "30"],
    { encoding: "utf8" },
  );
  assert.equal(invalidCount.status, 1);
  assert.match(invalidCount.stderr, /total must be an integer/);
});

test("registers demo participants before seeding moderated questions", async (t) => {
  const participants = new Set();
  const questionAuthors = new Map();
  let upvotes = 0;

  const server = http.createServer(async (request, response) => {
    const body = request.method === "POST" ? await readJson(request) : {};
    if (request.url === "/api/config") {
      return json(response, {
        moderation: {
          enabled: true,
          presentationDelaySeconds: 0,
          codeOfConduct: { version: "demo-v1" },
        },
      });
    }
    if (request.url === "/api/participant") {
      assert.equal(body.cocVersion, "demo-v1");
      participants.add(body.voterId);
      return json(response, { participant: { publicLabel: body.alias }, questions: [] });
    }
    if (request.url === "/api/question") {
      assert.ok(participants.has(body.voterId));
      const id = crypto.randomUUID();
      questionAuthors.set(id, body.voterId);
      return json(response, { submission: { id, visibility: "public" }, snapshot: {} });
    }
    if (request.url === "/api/upvote") {
      assert.ok(questionAuthors.has(body.questionId));
      assert.notEqual(questionAuthors.get(body.questionId), body.voterId);
      upvotes += 1;
      return json(response, { questions: [] });
    }
    return json(response, { error: "not found" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const child = spawn(process.execPath, [script, "questions", `http://127.0.0.1:${address.port}/`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [status] = await once(child, "close");

  assert.equal(status, 0, stderr);
  assert.match(stdout, /12 questions seeded/);
  assert.equal(participants.size, 12);
  assert.equal(questionAuthors.size, 12);
  assert.equal(upvotes, 46);
});

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, data, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}
