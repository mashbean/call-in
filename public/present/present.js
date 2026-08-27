const config = await fetch("/api/config").then((response) => {
  if (!response.ok) throw new Error("config unavailable");
  return response.json();
});
const params = new URLSearchParams(location.search);
const requestedDeck = params.get("deck");
const deckUrl = validDeckUrl(requestedDeck) ? requestedDeck : config.deckUrl;
const deckFrame = document.querySelector("[data-deck-frame]");
const openDeck = document.querySelector("[data-open-deck]");
const status = document.querySelector("[data-present-status]");
const toggle = document.querySelector("[data-dashboard-toggle]");

document.title = `${config.title} · 講者頁`;
document.querySelector("[data-event-title]").textContent = config.title;
deckFrame.src = deckUrl;
openDeck.href = deckUrl;
deckFrame.addEventListener("load", () => {
  status.textContent = "簡報已載入";
});

toggle.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("dashboard-collapsed");
  toggle.textContent = collapsed ? "顯示互動" : "隱藏互動";
  toggle.setAttribute("aria-pressed", String(collapsed));
});

document.querySelector("[data-fullscreen]").addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
});

function validDeckUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value, location.origin);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
