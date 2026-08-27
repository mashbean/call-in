---
name: live-deck-kit
description: Add a realtime audience dashboard to an existing web slide deck and close the loop after an event. Use for live difficulty feedback, audience questions, emoji reactions, quick polls, QR entry, Cloudflare Workers deployment, prompt-driven deck integration, or an Uncommon Ground question-pool receipt.
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
3. Keep the default `eventId` stable after production data exists. For a no-code deployment, configure public event copy, the deck URL, reactions, and polls from the deployed `/setup/` wizard. For a fully configured source deployment, edit `public/event.config.json` before deploying.
4. Run `npm install`, `npm run types`, `npm run doctor`, and `npm run check`.
5. Choose the deployment path. Use the README's Deploy to Cloudflare button for a starter deployment in the user's own Git provider and Cloudflare account. Use Wrangler when the event must be fully configured before its first deployment.
6. For Deploy to Cloudflare, require separate `ADMIN_TOKEN` and `MODERATOR_TOKEN` secrets during the deployment form. For Wrangler, run `npm run admin-token` and `npm run moderator-token` before protected production controls are needed. Keep plaintext tokens out of Git and user-visible output. Give a live assistant only the moderator token.
7. Authenticate and deploy. Capture the final HTTPS service URL. For the no-code path, open `/setup/`, enter the admin token, save the event configuration, and open `/present/`.
8. Prefer `/present/` when the speaker has a public, browser-playable deck URL and wants no source edits. If the deck host blocks iframe embedding, use its **Open deck separately** fallback or integrate the deck with the CLI. Use overlay mode when the deck layout is unknown. Use split mode only after identifying a safe presentation root.
9. Test the setup wizard, presenter view, audience page, dashboard, moderator page, QR code, fixed event alias, code-of-conduct acceptance, presentation delay, reason-based reports, adaptive community holds, moderator reversal, author-only holds, session modes, difficulty updates, question ordering, upvotes, polls, emoji bursts, collapse control, keyboard navigation, and reconnect behavior.
10. Test at 390 px, 1024 px, and a desktop presentation viewport. Respect `prefers-reduced-motion`.
11. Report the service URL, audience URL, dashboard URL, integration file, license, and any remaining deployment work.

## Post-event Uncommon Ground loopback

Export the event first and preserve the original archive. Run `npm run uncommon-ground` against a
private copy to create the upstream `questions.json` contract. Remove source UUIDs from the derived
file. Keep moderated rows as `Withdrawn` for provenance. Run clustering, arc, loopback, assembly,
and verification from a separate `audreyt/uncommon-ground` checkout.

## Safety limits

- Do not reset production data unless the user explicitly asks.
- Do not run a large load test by default. Use a short smoke test with at most five simulated participants unless the user explicitly authorizes a larger test.
- Do not commit tokens, `.dev.vars`, `.env`, or `.live-deck-admin-token`.
- Keep one event per Worker deployment by default. Do not create a shared multi-tenant service without a capacity and privacy review.
- Do not add patient, attendee, or other sensitive fields to the default schema.
- Do not give the admin token to a live moderator. Moderator access must not expose export or reset operations.
- Do not store raw IP addresses or claim that a browser UUID proves a human identity.
- Do not use a general dislike flag or let one participant hide content. Crowd reports may only create a reversible hold; the moderator remains authoritative.
- Treat a successful deployment as incomplete until the canonical setup, presenter, audience, and dashboard URLs have been checked.

## Prompt contract

When details are missing, choose reversible defaults and state them. The smallest useful prompt is

> Add Live Deck Kit to this web slide deck. The event is called “My Event.” Preserve the existing slides and animations, deploy the realtime service to my Cloudflare account, use a right-side 25% dashboard on desktop, and use a drawer on mobile.

The skill should turn that prompt into a configured service, a deployed Worker, a usable presenter view or integrated deck, and a tested handoff.
