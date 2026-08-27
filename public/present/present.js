import { eventContext, eventPage } from "../event-context.js";

const config = await fetch(`${eventContext.apiBase}/config`).then((response) => {
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

document.querySelector("[data-audience-link]").href = eventPage("/");
document.querySelector("[data-moderator-link]").href = eventPage("/moderate/");
document.querySelector("[data-audience-qr]").src = `${eventContext.apiBase}/qr.svg`;
document.querySelector("[data-dashboard-frame]").src = eventPage("/dashboard/");

document.title = `${config.title} · 講者頁`;
document.querySelector("[data-event-title]").textContent = config.title;
deckFrame.src = deckUrl;
openDeck.href = deckUrl;
deckFrame.addEventListener("load", () => {
  status.textContent = "已送出簡報載入要求";
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
