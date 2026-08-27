# Call-in · 簡單叩應

<picture>
  <img src="./public/brand/call-in-mark.svg" width="128" alt="Call-in abstract bell-curve mark">
</picture>

**Call-in for your slides. 讓你的分享，可以即時叩應。**

[Start a hosted event](https://call-in.mashbean.net/#create) · [English](https://call-in.mashbean.net/en/) · [Source](https://github.com/mashbean/call-in) · [☕ Sponsor on Buy Me a Coffee](https://buymeacoffee.com/mashbean)

Call-in adds a live audience layer beside an existing slide deck. A speaker uploads a PDF (up to 20MB) or pastes a browser-playable deck URL, then immediately receives:

- a presenter view combining the deck and live response dashboard;
- an audience URL and QR code;
- private setup and moderation links;
- live difficulty feedback, questions, reactions, and polls.

No account, repository, or Cloudflare setup is required for the hosted flow.

## Start in one minute

1. Open [call-in.mashbean.net](https://call-in.mashbean.net/#try) and click the demo slide to replace it.
2. Upload a PDF or paste the deck URL, then name the event on the same page.
3. Open **Presenter view** and show the audience QR code.

No deck at hand? Open the [permanent presenter demo](https://call-in.mashbean.net/en/demo/) below the landing-page preview. It starts with 45 sample difficulty ratings and six clearly labeled demo questions, then records real audience interactions on top. Scan its QR code and watch difficulty, questions, and reactions sync to the dashboard. The shared public demo resets daily; do not enter personal, sensitive, or confidential information.

The presenter toolbar and response panel can both be hidden. Uploaded PDFs open in a focused one-page viewer that fits each slide to the available stage; use the on-screen controls, arrow/Page Up/Page Down keys, Space, Home/End, or a horizontal swipe to move through the deck. Uploaded decks, event data, and audience responses expire after seven days.

## One-prompt agent workflow

Give Claude, Codex, or another coding agent this prompt:

> Open https://call-in.mashbean.net/#create and use my attached PDF to create a Call-in event. Return the presenter, audience, and moderator links. Treat the moderator link as private.

The agent should prefer the hosted creator unless the user explicitly asks to self-host, needs a different retention policy, or requires source-level integration.

## Data boundary

On `call-in.mashbean.net`:

- uploaded PDFs are stored only to serve the event and are deleted after seven days;
- slide copyright remains with the uploader; Call-in does not use decks for model training;
- anonymous audience responses are recorded to operate and improve the project, then deleted with the event after seven days;
- the shared public demo uses a separate room, starts with labeled sample data, and clears added audience responses every day;
- speakers should not upload or enter sensitive or confidential material.

Hosted events must not contain illegal material, copyright or privacy infringement, fraud, hate or harassment, impersonation, malware, or content that threatens people or service security. mashbean may remove violating decks, events, and interaction pages immediately and without prior notice.

Each hosted event uses an isolated Durable Object. Private links carry access secrets in URL fragments and move them into tab-scoped session storage. Creating an event also sets a restricted HttpOnly cookie for that event's moderation API, so the creator can open **Moderate** from the presenter toolbar without entering a code. The cookie is not available to page scripts, is not sent to setup or admin routes, and expires with the event. No moderator credential is included in a public presenter URL.

## Self-host on Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mashbean/call-in)

Or use Wrangler:

```sh
gh repo clone mashbean/call-in
cd call-in
npm install
npm run doctor
npm run check
npm run deploy
```

Self-hosters should change or remove the `call-in.mashbean.net` custom-domain route in `wrangler.jsonc` before deploying. The Worker service name remains `live-deck-kit` for production Durable Object continuity; it is an internal deployment identifier, not the product name.

Or give a coding agent this prompt:

> Get the source from https://github.com/mashbean/call-in, read the README and wrangler.jsonc, and deploy an independent Call-in service to my Cloudflare account. Do not overwrite any existing Worker, Durable Object, or domain. Run the tests first, then return the public URL, required configuration, and update process. If login, API-token creation, or custom-domain changes require my action, stop and tell me exactly what I need to do.

## Add Call-in inside an HTML deck

The hosted presenter view does not change deck source. If deeper integration is needed:

```sh
npm run integrate -- --deck /absolute/path/index.html --service-url https://YOUR-WORKER.workers.dev --mode split
```

Or add the web component manually:

```html
<script type="module" src="https://YOUR-WORKER.workers.dev/embed/call-in-panel.js"></script>
<call-in-panel
  service-url="https://YOUR-WORKER.workers.dev"
  mode="split"
  target-selector=".deck-stage"
  desktop-width="25vw"
></call-in-panel>
```

The old `live-deck-panel` element and script entry point remain as compatibility aliases.

## Configuration and moderation

Hosted events use the private setup link returned by the creator on the landing page. The same creator browser is automatically authorized for moderation; share the complete private moderation link with a collaborator instead of extracting a token. Events created before this browser authorization was introduced still need their original private moderation link. Source-configured self-hosted events use [`public/event.config.json`](./public/event.config.json); see [`skills/call-in/references/configuration.md`](./skills/call-in/references/configuration.md).

```sh
npm run admin-token
npm run moderator-token
```

Plaintext tokens are stored only in Git-ignored `.call-in-admin-token` and `.call-in-moderator-token` files. Give assistants or live moderators only the moderator credential; it cannot export or reset event data.

## CLI and Codex skill

```sh
npm run doctor
npm run check
npx --yes github:mashbean/call-in install-skill
```

The skill installs to `$CODEX_HOME/skills/call-in` (or `~/.codex/skills/call-in`). Full integration guidance is in [`skills/call-in/references/integration.md`](./skills/call-in/references/integration.md).

## Support the project

Call-in is a solo-maintained open-source project. Stars, issue reports, documentation fixes, and pull requests are welcome. You can also support ongoing maintenance through [Buy Me a Coffee](https://buymeacoffee.com/mashbean).

## Development

```sh
npm install
npm run types
npm run doctor
npm run check
npm run dev
```

The test suite covers hosted-event isolation, role capabilities, moderation, reconnect behavior, creator and presenter contracts, and deployment packaging.

## License and provenance

Apache-2.0. See [`NOTICE`](./NOTICE) and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md). Call-in is an independent implementation for audience response beside web presentations; it does not include the quiz editor, authentication, scoring, or game lifecycle from `kahoot-cf`.
