---
name: live-deck-kit
description: Add a realtime audience dashboard to an existing web slide deck. Use for live difficulty feedback, audience questions, emoji reactions, quick polls, QR entry, Cloudflare Workers deployment, or prompt-driven deck integration.
---

# Live Deck Kit

Use this skill when a user wants to add live audience interaction to a web presentation or deploy a reusable interaction service.

## Required reading

Read both files before making changes

- `references/configuration.md`
- `references/integration.md`

## Workflow

1. Inspect the target deck, its framework, its presentation root, mobile behavior, existing animation, and deployment setup. Preserve slide content and navigation unless the user explicitly requests changes.
2. Obtain Live Deck Kit from `https://github.com/mashbean/live-deck-kit`. Work in a standalone checkout. Do not nest a Git repository inside the target deck repository.
3. Edit `public/event.config.json` for the event. Keep `eventId` stable after production data exists.
4. Run `npm install`, `npm run types`, `npm run doctor`, and `npm run check`.
5. Run `npm run admin-token` before a production deployment. Keep `.live-deck-admin-token` out of Git and user-visible output.
6. Authenticate Wrangler and deploy. Capture the final HTTPS service URL from Wrangler output.
7. Integrate the deck with the CLI. Use overlay mode when the deck layout is unknown. Use split mode only after identifying a safe presentation root.
8. Test the audience page, dashboard, QR code, difficulty updates, question ordering, upvotes, polls, emoji bursts, collapse control, keyboard navigation, and reconnect behavior.
9. Test at 390 px, 1024 px, and a desktop presentation viewport. Respect `prefers-reduced-motion`.
10. Report the service URL, audience URL, dashboard URL, integration file, license, and any remaining deployment work.

## Safety limits

- Do not reset production data unless the user explicitly asks.
- Do not run a large load test by default. Use a short smoke test with at most five simulated participants unless the user explicitly authorizes a larger test.
- Do not commit tokens, `.dev.vars`, `.env`, or `.live-deck-admin-token`.
- Keep one event per Worker deployment by default. Do not create a shared multi-tenant service without a capacity and privacy review.
- Do not add patient, attendee, or other sensitive fields to the default schema.
- Treat a successful deployment as incomplete until the canonical audience and dashboard URLs have been checked.

## Prompt contract

When details are missing, choose reversible defaults and state them. The smallest useful prompt is

> Add Live Deck Kit to this web slide deck. The event is called “My Event.” Preserve the existing slides and animations, deploy the realtime service to my Cloudflare account, use a right-side 25% dashboard on desktop, and use a drawer on mobile.

The skill should turn that prompt into a configured service, a deployed Worker, an integrated deck, and a tested handoff.
