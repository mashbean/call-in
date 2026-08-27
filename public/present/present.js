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
const toolbarToggle = document.querySelector("[data-toolbar-toggle]");
const toolbarPeek = document.querySelector("[data-toolbar-peek]");
const english = config.locale?.toLowerCase().startsWith("en");
const labels = english
  ? { presenter: "Presenter", loading: "Loading slides…", loaded: "Slide load requested", open: "Open deck", audience: "Audience", moderate: "Moderate", hideDashboard: "Hide responses", showDashboard: "Show responses", fullscreen: "Fullscreen", hideToolbar: "Hide toolbar", showToolbar: "Show presenter toolbar" }
  : { presenter: "講者頁", loading: "正在載入簡報…", loaded: "已送出簡報載入要求", open: "另開簡報", audience: "觀眾頁", moderate: "管理", hideDashboard: "隱藏互動", showDashboard: "顯示互動", fullscreen: "全螢幕", hideToolbar: "收起工具列", showToolbar: "顯示講者工具列" };

document.querySelector("[data-audience-link]").href = eventPage("/");
document.querySelector("[data-moderator-link]").href = eventPage("/moderate/");
document.querySelector("[data-audience-qr]").src = `${eventContext.apiBase}/qr.svg`;
document.querySelector("[data-dashboard-frame]").src = eventPage("/dashboard/");

document.documentElement.lang = english ? "en" : "zh-Hant-TW";
document.title = `${config.title} · ${labels.presenter}`;
document.querySelector("[data-event-title]").textContent = config.title;
status.textContent = labels.loading;
openDeck.textContent = labels.open;
document.querySelector("[data-audience-link]").textContent = labels.audience;
document.querySelector("[data-moderator-link]").textContent = labels.moderate;
toggle.textContent = labels.hideDashboard;
document.querySelector("[data-fullscreen]").textContent = labels.fullscreen;
toolbarToggle.textContent = labels.hideToolbar;
toolbarPeek.setAttribute("aria-label", labels.showToolbar);
toolbarPeek.title = labels.showToolbar;
deckFrame.src = deckUrl;
openDeck.href = deckUrl;
deckFrame.addEventListener("load", () => {
  status.textContent = labels.loaded;
});

toggle.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("dashboard-collapsed");
  toggle.textContent = collapsed ? labels.showDashboard : labels.hideDashboard;
  toggle.setAttribute("aria-pressed", String(collapsed));
});

toolbarToggle.addEventListener("click", () => setToolbarCollapsed(true, true));
toolbarPeek.addEventListener("click", () => setToolbarCollapsed(false, true));

function setToolbarCollapsed(collapsed, moveFocus = false) {
  document.body.classList.toggle("toolbar-collapsed", collapsed);
  toolbarToggle.setAttribute("aria-expanded", String(!collapsed));
  sessionStorage.setItem("call-in-toolbar-collapsed", String(collapsed));
  if (moveFocus) (collapsed ? toolbarPeek : toolbarToggle).focus();
}

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

setToolbarCollapsed(sessionStorage.getItem("call-in-toolbar-collapsed") === "true");
