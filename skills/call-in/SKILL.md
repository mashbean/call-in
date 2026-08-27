---
name: call-in
description: Add Call-in realtime audience response to an existing slide deck and close the loop after an event. Use for hosted PDF or web decks, live difficulty feedback, audience questions, emoji reactions, quick polls, QR entry, optional Cloudflare Workers self-hosting, prompt-driven deck integration, or an Uncommon Ground question-pool receipt.
---

# Call-in

Use this skill when a user wants to add live audience interaction to a web presentation or deploy a reusable interaction service.

## Required reading

Read both files before making changes

- `references/configuration.md`
- `references/integration.md`

## Workflow

1. Inspect the target deck and confirm that it has a browser-playable URL. Preserve slide content and navigation unless the user explicitly requests changes.
2. Prefer the hosted `https://call-in.mashbean.net/new/` flow. Enter the event title, upload a PDF up to 20MB or paste a deck URL, create the event, and preserve the returned private setup and moderation links without printing their fragments in logs or chat.
3. Open the private setup link when event copy, reactions, or polls need editing. Keep the generated `eventId` stable.
4. Use the hosted presenter view when the speaker wants no source edits. If the deck host blocks iframe embedding, use **Open deck separately** or move to the deeper HTML integration path.
5. Test the creator, presenter view, audience page, dashboard, moderator page, QR code, event isolation, capability separation, presentation delay, moderation, difficulty updates, polls, reactions, collapse control, and reconnect behavior.
6. Test at 390 px, 1024 px, and a desktop presentation viewport. Respect `prefers-reduced-motion`.
7. Report the public presenter and audience URLs, but identify the private setup and moderation links without exposing their access fragments.
8. Use self-hosting only when the user explicitly needs their own infrastructure, longer retention, custom policies, or source integration. Work in a standalone checkout, run `npm install`, `npm run types`, `npm run doctor`, and `npm run check`, then use Deploy to Cloudflare or Wrangler. Do not nest the service repository inside the deck repository.
9. For a source-configured permanent self-hosted event, run `npm run admin-token` and `npm run moderator-token`, keep plaintext token files out of Git, and give assistants only the moderator credential.

## Post-event Uncommon Ground loopback

Export the event first and preserve the original archive. Run `npm run uncommon-ground` against a
private copy to create the upstream `questions.json` contract. Remove source UUIDs from the derived
file. Keep moderated rows as `Withdrawn` for provenance. Run clustering, arc, loopback, assembly,
and verification from a separate `audreyt/uncommon-ground` checkout.

## Safety limits

- Do not reset production data unless the user explicitly asks.
- Do not run a large load test by default. Use a short smoke test with at most five simulated participants unless the user explicitly authorizes a larger test.
- Do not commit tokens, `.dev.vars`, `.env`, `.call-in-admin-token`, legacy `.live-deck-admin-token`, or hosted capability fragments.
- Hosted multi-event mode requires one Durable Object per event, separate access hashes, a global creation limit, automatic expiry, and no raw IP storage. Review capacity and privacy again before increasing limits or retention.
- Do not add patient, attendee, or other sensitive fields to the default schema.
- Do not give the admin token to a live moderator. Moderator access must not expose export or reset operations.
- Do not store raw IP addresses or claim that a browser UUID proves a human identity.
- Do not use a general dislike flag or let one participant hide content. Crowd reports may only create a reversible hold; the moderator remains authoritative.
- Treat a successful deployment as incomplete until the canonical setup, presenter, audience, and dashboard URLs have been checked.

## Prompt contract

When details are missing, choose reversible defaults and state them. The smallest useful prompt is

> Use Call-in to add live audience responses to this slide deck. Keep the original slides and return the presenter, audience QR, and moderator links.

The skill should turn that prompt into an isolated hosted event, a usable presenter view, and a tested handoff. Do not introduce cloud deployment unless the user asks to self-host.
