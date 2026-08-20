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
- A code-of-conduct gate with a fixed event alias and stable participant badge
- An eight-second presentation buffer, author-only holds, slow mode, approval mode, pause, and event close controls
- A mobile-first moderator console with hide, restore, review, and mute actions
- Token-protected export and reset endpoints
- A privacy-preserving Uncommon Ground post-event export
- An idempotent HTML integration CLI
- Overlay mode and a desktop 75/25 split mode
- Interface locale packs with an English fallback, shipping English and Traditional Chinese

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

Edit [`public/event.config.json`](./public/event.config.json), then create separate admin and moderator tokens and check the project.

```bash
npm run admin-token
npm run moderator-token
npm run check
npx wrangler login
npm run deploy
```

The token commands write SHA-256 hashes to `wrangler.jsonc`. Plaintext tokens are stored only in the Git-ignored `.live-deck-admin-token` and `.live-deck-moderator-token` files. Give assistants only the moderator token. It cannot export or reset event data.

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

## Interface language

`locale` in `public/event.config.json` selects the interface language. Packs live in
[`public/locales/`](./public/locales/) as flat JSON files named after the locale, and `en.json`
is the fallback. The audience page, the presenter dashboard, and the moderator console all read
the same pack, and `<html lang>` follows the active locale.

```json
{ "locale": "zh-Hant-TW" }
```

Event copy stays in `event.config.json`. The locale packs cover interface text only, so the same
pack works for a Mandarin event and an English one without touching the wording of your event.

To add a language, copy `public/locales/en.json`, translate the values, and save it as
`public/locales/<locale>.json`. A pack may be partial: any key it omits falls back to English,
and an unknown `locale` falls back to English with a console warning. `npm test` checks that
every pack only defines keys the fallback knows, that plural forms are well formed, and that no
page references a key the fallback is missing.

Some strings need a count. Give those a plural object; languages without a singular form can
provide `other` alone.

```json
{
  "common.questionCount": { "one": "{count} question", "other": "{count} questions" }
}
```

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

## Live moderation

When moderation is enabled in `public/event.config.json`, a participant accepts the event code of conduct and chooses one event alias before asking a question. The server keeps that alias fixed and adds a short event-local badge. Questions enter a configurable presentation buffer before becoming public.

Participants can report a public question for harassment, deliberate disruption, serious off-topic content, or private information. There is no general dislike reason. One event identity can report a question once and cannot report its own question. The adaptive threshold requires several independent identities before the question is temporarily removed from public view. Report counts and reasons remain moderator-only.

Open the mobile-first console at `https://YOUR-WORKER.workers.dev/moderate/` and enter the separate moderator token. Moderators can confirm or reverse a community hold, hide or restore one question, slow a participant, require review for future questions, mute free-text questions, or restore access. The presenter dashboard and public API only receive public questions. A held question remains visible on its author's device with a truthful `Not public` status.

Confirmed reports increase the reporter's future trust weight. Restored questions reduce the weight of reporters whose flags were rejected. Crowd reports never mute a participant automatically, and moderator judgment always wins.

Session controls provide five modes

- `open` publishes questions after the configured buffer
- `slow` applies the longer event cooldown
- `approval` holds every new question for moderator review
- `paused` temporarily stops new questions while polls, reactions, and difficulty remain available
- `closed` ends free-text questions for the event

All moderation actions, original question rows, report reasons, resolution outcomes, and event-local reporter IDs remain available to the admin export. The default schema does not store IP addresses or legal names.

## Close the loop with Uncommon Ground

Live Deck Kit can convert its post-event JSON export into the `questions.json` contract used by
[`audreyt/uncommon-ground`](https://github.com/audreyt/uncommon-ground). Source question IDs and
browser voter IDs are replaced with event-local sequential codes. Display names are removed unless
you explicitly pass `--keep-names`. Moderated rows remain in the private working file as
`Withdrawn`, while Uncommon Ground excludes them from the published page.

```bash
npm run uncommon-ground -- \
  --questions /path/to/questions.json \
  --question-votes /path/to/question-votes.json \
  --classifications /path/to/moderation-review.json \
  --event my-event \
  --out /private/workdir/questions.json
```

The default withdrawn labels are `negative` and `provocative`. Override them only after a human
moderation review.

Then run the upstream pipeline from its own checkout. Do not nest that repository inside a deck
or Live Deck Kit checkout.

```bash
gh repo clone audreyt/uncommon-ground
cd uncommon-ground
python3 assemble.py /private/workdir templates/uncommon-ground.html /private/workdir/uncommon-ground.html
node domcheck.js /private/workdir/uncommon-ground.html
python3 verify.py /private/workdir --expected=N
```

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
- The four question lenses and the post-event export contract interoperate with [`audreyt/uncommon-ground`](https://github.com/audreyt/uncommon-ground), licensed under CC0-1.0. The clustering and loopback pipeline remains in its upstream repository
- Realtime state uses Cloudflare Workers, Durable Objects, SQLite, and Hibernation WebSockets
- QR code generation uses [`soldair/node-qrcode`](https://github.com/soldair/node-qrcode)
- The repository device mockup uses [`picturepan2/devices.css`](https://github.com/picturepan2/devices.css), licensed under MIT

Live Deck Kit is a separate implementation designed for live feedback beside a web presentation. It does not include the quiz editor, authentication, scoring, or game lifecycle from `kahoot-cf`.

## License

[Apache License 2.0](./LICENSE). Modification, distribution, and commercial use are permitted, with an explicit patent grant. See [`NOTICE`](./NOTICE) and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for attribution details.
