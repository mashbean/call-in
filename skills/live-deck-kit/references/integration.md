# Deck integration

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

- The component marker appears once in the deck HTML.
- Desktop open and collapsed states do not hide slide controls.
- Mobile drawer can be opened, scrolled, and closed by touch.
- Arrow keys pressed inside the dashboard still reach the deck.
- The dashboard QR opens the same audience service origin.
- A fresh browser profile receives live snapshots and reconnects after a network interruption.
