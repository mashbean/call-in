# Deck integration

## Standalone presenter view

Use `https://SERVICE/present/` when the speaker already has a public, browser-playable deck URL and does not want to edit its source. Configure the URL in `/setup/`. The presenter view places the deck and dashboard side by side, provides fullscreen and collapse controls, and links to the audience and moderator pages.

Some presentation hosts send headers that prohibit iframe embedding. In that case use **Open deck separately**, or use one of the HTML integration modes below when the deck source is available. A local PowerPoint or Keynote file must first be published to a browser-playable URL.

## Overlay mode

Use for unknown layouts, Reveal.js, full-screen canvases, or decks that already control the viewport.

```bash
npm run integrate -- --deck /absolute/path/index.html --service-url https://SERVICE --mode overlay
```

The dashboard overlays the right side on desktop. It is collapsed by default on mobile.

## Split mode

Use after identifying a deck root whose `right` property can be adjusted safely.

```bash
npm run integrate -- --deck /absolute/path/index.html --service-url https://SERVICE --mode split --target-selector '.deck-stage' --desktop-width '25vw'
```

The component updates only the selected root and restores the original inline value when collapsed. If no target selector is supplied, it uses body padding.

## Manual snippet

```html
<script type="module" src="https://SERVICE/embed/live-deck-panel.js"></script>
<live-deck-panel
  service-url="https://SERVICE"
  mode="split"
  target-selector=".deck-stage"
  desktop-width="25vw"
></live-deck-panel>
```

## Verification

- The `/setup/` token disappears when its browser session is cleared and is never saved in local storage.
- The `/present/` deck, dashboard, collapse control, fullscreen control, and fallback link work at the presentation viewport.
- The component marker appears once in the deck HTML.
- Desktop open and collapsed states do not hide slide controls.
- Mobile drawer can be opened, scrolled, and closed by touch.
- Arrow keys pressed inside the dashboard still reach the deck.
- The dashboard QR opens the same audience service origin.
- A fresh browser profile receives live snapshots and reconnects after a network interruption.
- A participant must accept the current code of conduct once, and the chosen event alias stays fixed.
- A new question appears in the author status area before the presentation delay expires.
- A moderator can move a question to author-only visibility and restore it from `/moderate/`.
- Pause and approval modes update the audience page without a reload.
