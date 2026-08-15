#!/usr/bin/env node
// Seed realistic demo data into YOUR OWN deployment, so the dashboard has
// something to show when you pitch or rehearse. Reset before the real event:
// curl -X POST -H "Authorization: Bearer $LIVE_DECK_ADMIN_TOKEN" https://SERVICE/api/admin/reset
//
// Usage:
//   node scripts/seed-demo.mjs questions <service-url>
//     Inserts a batch of realistic questions from distinct fake devices with a
//     skewed upvote distribution (a few hot questions, a long quiet tail).
//     Run it again for another batch.
//
//   node scripts/seed-demo.mjs reactions <service-url> [total] [seconds]
//     Drips reactions (default 30 over 30s). Stretch the seconds to cover a
//     whole rehearsal. The "mood" shifts every 45-90s so the four kinds ebb
//     and flow like a real room instead of a fixed-ratio bot.

const [, , command, url, arg3, arg4] = process.argv;

if (!command || !url || !["questions", "reactions"].includes(command)) {
  console.error("usage: node scripts/seed-demo.mjs questions <service-url>");
  console.error("       node scripts/seed-demo.mjs reactions <service-url> [total] [seconds]");
  process.exit(1);
}

const headers = {
  "content-type": "application/json",
  "user-agent": "Mozilla/5.0 live-deck-seed-demo",
};

async function post(path, body) {
  const response = await fetch(url + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${data.error || response.status}`);
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

if (command === "questions") {
  const QUESTIONS = [
    ["Will the slides be shared afterwards?", "clarify"],
    ["Can you show that last step once more, slower?", "clarify"],
    ["How does this compare with what we already use day to day?", "bridge"],
    ["What does the pricing look like for a small team?", "chorus"],
    ["Does this work offline, or does it need a stable connection?", "keeper"],
    ["Who maintains the templates once we adopt this?", "chorus"],
    ["What happens to our existing data if we migrate?", "bridge"],
    ["Is there a mobile version, or is it desktop only?", "clarify"],
    ["What are the known limitations we should plan around?", "keeper"],
    ["How steep is the learning curve for non-technical colleagues?", "chorus"],
    ["Can external partners get restricted access?", "keeper"],
    ["Which part of the workflow saves the most time in practice?", "bridge"],
  ];
  // A few hot questions, a long quiet tail
  const UPVOTE_DISTRIBUTION = [0, 0, 1, 1, 2, 2, 3, 4, 5, 7, 9, 12];

  const ids = [];
  for (const [text, lens] of QUESTIONS) {
    const result = await post("/api/question", {
      text,
      lens,
      difficulty: 1 + Math.floor(Math.random() * 5),
      voterId: crypto.randomUUID(),
    });
    ids.push(result.submission.id);
  }
  const fans = Array.from({ length: 14 }, () => crypto.randomUUID());
  for (const questionId of ids) {
    const count = Math.min(pick(UPVOTE_DISTRIBUTION), fans.length);
    for (const voterId of [...fans].sort(() => Math.random() - 0.5).slice(0, count)) {
      await post("/api/upvote", { questionId, voterId });
    }
  }
  console.log(`${ids.length} questions seeded against ${url}`);
} else {
  const total = Number(arg3) || 30;
  const seconds = Number(arg4) || 30;

  // Mood weights over [applause, insight, resonate, pause]
  const MOODS = {
    calm: [3, 2, 1, 1],
    applause: [8, 3, 1, 1],
    insight: [2, 8, 2, 1],
    resonance: [2, 2, 8, 1],
    doubt: [1, 1, 2, 5],
  };
  const KIND_IDS = ["applause", "insight", "resonate", "pause"];
  // Rotate fake devices to stay under the per-device rate limit
  const devices = Array.from({ length: 6 }, () => crypto.randomUUID());

  function weightedKind(weights) {
    const sum = weights.reduce((acc, w) => acc + w, 0);
    let roll = Math.random() * sum;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return KIND_IDS[i];
    }
    return KIND_IDS[0];
  }

  let mood = "calm";
  let moodUntil = 0;
  let sent = 0;
  let limited = 0;
  for (let i = 0; i < total; i++) {
    const now = Date.now();
    if (now >= moodUntil) {
      mood = pick(Object.keys(MOODS));
      moodUntil = now + (45 + Math.random() * 45) * 1000;
      console.log(`mood -> ${mood}`);
    }
    try {
      await post("/api/reaction", {
        kind: weightedKind(MOODS[mood]),
        voterId: devices[i % devices.length],
      });
      sent += 1;
    } catch (error) {
      if (String(error.message).includes("rate limit")) limited += 1;
      else throw error;
    }
    if (sent && sent % 25 === 0) console.log(`  ${sent}/${total} sent`);
    const base = (seconds * 1000) / total;
    await sleep(base * (0.4 + Math.random() * 1.2)); // jitter reads as human
  }
  console.log(`reactions sent: ${sent}${limited ? ` (rate-limited: ${limited})` : ""}`);
}
