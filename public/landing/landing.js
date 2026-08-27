const root = document.documentElement;
const themeButton = document.querySelector("[data-theme-toggle]");
const savedTheme = localStorage.getItem("call-in-theme");
const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;

setTheme(savedTheme === "dark" || savedTheme === "light" ? savedTheme : systemDark ? "dark" : "light");

themeButton?.addEventListener("click", () => {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  setTheme(next);
  localStorage.setItem("call-in-theme", next);
});

document.querySelectorAll("[data-copy-prompt]").forEach((button) => {
  button.addEventListener("click", async () => {
    const prompt = document.querySelector("[data-prompt]")?.textContent?.trim();
    if (!prompt) return;
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(prompt);
      button.textContent = button.dataset.copied || "Copied";
    } catch {
      button.textContent = button.dataset.failed || "Select the prompt to copy";
    }
    setTimeout(() => { button.textContent = original; }, 1800);
  });
});

function setTheme(theme) {
  root.dataset.theme = theme;
  if (!themeButton) return;
  const dark = theme === "dark";
  themeButton.textContent = dark ? "☀" : "☾";
  themeButton.setAttribute("aria-label", dark ? (themeButton.dataset.lightLabel || "Use light theme") : (themeButton.dataset.darkLabel || "Use dark theme"));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#080a15" : "#f7f7fb");
}
