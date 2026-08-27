const root = document.documentElement;
const themeButton = document.querySelector("[data-theme-toggle]");
const savedTheme = localStorage.getItem("call-in-theme");
const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
const demoShell = document.querySelector("[data-demo-shell]");
const creatorPanel = document.querySelector("[data-create-panel]");
const creatorTitle = creatorPanel?.querySelector('input[name="title"]');

setTheme(savedTheme === "dark" || savedTheme === "light" ? savedTheme : systemDark ? "dark" : "light");

themeButton?.addEventListener("click", () => {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  setTheme(next);
  localStorage.setItem("call-in-theme", next);
});

document.querySelectorAll("[data-copy-text]").forEach((button) => {
  button.addEventListener("click", async () => {
    const copyValue = button.closest("[data-copy-scope]")?.querySelector("[data-copy-value]")?.textContent?.trim();
    if (!copyValue) return;
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(copyValue);
      button.textContent = button.dataset.copied || "Copied";
    } catch {
      button.textContent = button.dataset.failed || "Select the prompt to copy";
    }
    setTimeout(() => { button.textContent = original; }, 1800);
  });
});

document.querySelectorAll("[data-open-creator]").forEach((button) => {
  button.addEventListener("click", () => openCreator(true));
});

document.querySelectorAll('a[href="#create"]:not([data-create-another])').forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openCreator(true);
  });
});

document.querySelectorAll("[data-close-creator]").forEach((button) => {
  button.addEventListener("click", () => {
    creatorPanel.hidden = true;
    demoShell.hidden = false;
    history.pushState(null, "", "#try");
    demoShell.scrollIntoView({ behavior: "smooth", block: "center" });
  });
});

window.addEventListener("hashchange", () => {
  if (location.hash === "#create") openCreator(false);
});

if (location.hash === "#create") requestAnimationFrame(() => openCreator(false));

function setTheme(theme) {
  root.dataset.theme = theme;
  if (!themeButton) return;
  const dark = theme === "dark";
  themeButton.textContent = dark ? "☀" : "☾";
  themeButton.setAttribute("aria-label", dark ? (themeButton.dataset.lightLabel || "Use light theme") : (themeButton.dataset.darkLabel || "Use dark theme"));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#080a15" : "#f7f7fb");
}

function openCreator(updateHash) {
  if (!demoShell || !creatorPanel) return;
  demoShell.hidden = true;
  creatorPanel.hidden = false;
  if (updateHash) history.pushState(null, "", "#create");
  creatorPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => creatorTitle?.focus({ preventScroll: true }), 350);
}
