# Live Deck Kit

Add realtime difficulty feedback, audience questions, emoji reactions, quick polls, and a QR entry point to any web slide deck.

Audience members join from their phones. The presenter sees a live dashboard beside the deck and can collapse it at any time. Desktop layouts can use a 75/25 split, while phones and tablets get a touch-friendly drawer.

![Live Deck Kit running on a presenter laptop and an audience phone](./docs/hero-mockup-v2.jpg)

## Start with one prompt

Install the bundled Codex skill, then use a prompt like this

> Add Live Deck Kit to this web slide deck. The event is called “My Event.” Preserve the existing slides and animations, deploy the realtime service to my Cloudflare account, use a right-side 25% dashboard on desktop, and use a drawer on mobile.

The skill configures the event, deploys the realtime service, embeds the dashboard, tests desktop and mobile behavior, and hands back the audience and presenter URLs.

## Features

- Realtime 1–5 difficulty feedback with a distribution curve
- Newest-first audience questions, question lenses, difficulty-at-submission, and “I have this question too” upvotes
- Four configurable emoji reactions with presenter-side popup animations
- Up to eight quick polls with vote counts
- An always-available dashboard QR code that points to the audience page
- Hibernation WebSockets so the Durable Object can sleep while idle
- A configurable per-device question limit, defaulting to 20
- Token-protected export and reset endpoints
- An idempotent HTML integration CLI
- Overlay mode and a desktop 75/25 split mode

## Architecture

```text
Web slide deck ── live-deck-panel ── iframe ── presenter dashboard
                                                   │
Audience phones ── audience page ──────────────────┤
                                                   ▼
                                      Cloudflare Worker API
                                                   │
                                      Durable Object + SQLite
                                                   │
                                      Hibernation WebSockets
```

Each event uses one Worker deployment and one Durable Object by default. Events do not share state, which keeps failures isolated and makes free-tier capacity easier to reason about.

## Quick start

Requirements are Node.js 22 or later and a Cloudflare account.

```bash
gh repo clone mashbean/live-deck-kit
cd live-deck-kit
npm install
npm run types
```

Edit [`public/event.config.json`](./public/event.config.json), then create an admin token and check the project.

```bash
npm run admin-token
npm run check
npx wrangler login
npm run deploy
```

`npm run admin-token` writes the token's SHA-256 hash to `wrangler.jsonc`. The plaintext token is stored only in the Git-ignored `.live-deck-admin-token` file.

After Wrangler returns the HTTPS service URL, add the dashboard to an existing deck.

```bash
npm run integrate -- \
  --deck /absolute/path/to/deck/index.html \
  --service-url https://YOUR-WORKER.workers.dev \
  --mode split \
  --target-selector '.deck-stage' \
  --desktop-width '25vw'
```

Use `--mode overlay` when the deck's main presentation container is unknown. The CLI only manages the block between `live-deck-kit:start` and `live-deck-kit:end`, so rerunning it updates the existing integration instead of inserting a duplicate.

## Manual embed

```html
<script type="module" src="https://YOUR-WORKER.workers.dev/embed/live-deck-panel.js"></script>
<live-deck-panel
  service-url="https://YOUR-WORKER.workers.dev"
  mode="split"
  target-selector=".deck-stage"
  desktop-width="25vw"
></live-deck-panel>
```

## Install the Codex skill

Install directly from GitHub

```bash
npx --yes github:mashbean/live-deck-kit install-skill
```

Or install from a local clone

```bash
npm run install-skill
```

The skill is installed to `$CODEX_HOME/skills/live-deck-kit`. When `CODEX_HOME` is unset, it uses `~/.codex/skills/live-deck-kit`.

## Event configuration

Public copy, colors, difficulty labels, reactions, question lenses, and polls live in [`public/event.config.json`](./public/event.config.json). The complete field reference is in [`skills/live-deck-kit/references/configuration.md`](./skills/live-deck-kit/references/configuration.md).

`eventId` participates in the Durable Object name. Keep it stable after a production event begins collecting data unless you intentionally want a new, empty event.

## Admin API

Load `.live-deck-admin-token` into a temporary shell variable, then unset it when finished.

```bash
LIVE_DECK_ADMIN_TOKEN="$(tr -d '\n' < .live-deck-admin-token)"

curl -H "Authorization: Bearer $LIVE_DECK_ADMIN_TOKEN" \
  https://YOUR-WORKER.workers.dev/api/admin/export

curl -X POST -H "Authorization: Bearer $LIVE_DECK_ADMIN_TOKEN" \
  https://YOUR-WORKER.workers.dev/api/admin/reset

unset LIVE_DECK_ADMIN_TOKEN
```

Resetting state cannot be undone by the service. Export first and verify the exact event URL before resetting anything.

## Testing

```bash
npm run doctor
npm run typecheck
npm test
npm run deploy:dry
```

Tests use Cloudflare's official Vitest Workers integration and exercise a real Durable Object binding inside the Workers runtime. The default suite creates only a few participants and does not include a load test.

## Inspirations and dependencies

- Realtime interaction and Durable Objects routing were informed by [`htlin222/kahoot-cf`](https://github.com/htlin222/kahoot-cf), licensed under MIT
- The four question lenses borrow vocabulary from [`audreyt/uncommon-ground`](https://github.com/audreyt/uncommon-ground), licensed under CC0-1.0. Live Deck Kit does not include its post-event clustering or loopback pipeline
- Realtime state uses Cloudflare Workers, Durable Objects, SQLite, and Hibernation WebSockets
- QR code generation uses [`soldair/node-qrcode`](https://github.com/soldair/node-qrcode)
- The repository device mockup uses [`picturepan2/devices.css`](https://github.com/picturepan2/devices.css), licensed under MIT

Live Deck Kit is a separate implementation designed for live feedback beside a web presentation. It does not include the quiz editor, authentication, scoring, or game lifecycle from `kahoot-cf`.

## License

[Apache License 2.0](./LICENSE). Modification, distribution, and commercial use are permitted, with an explicit patent grant. See [`NOTICE`](./NOTICE) and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for attribution details.
