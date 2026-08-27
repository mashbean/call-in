const form = document.querySelector("[data-create-form]");
const createPanel = document.querySelector("[data-create-panel]");
const message = document.querySelector("[data-create-message]");
const receipt = document.querySelector("[data-receipt]");
const receiptLinks = {};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button[type=submit]");
  const data = new FormData(form);
  const deckUrl = normalizeDeckUrl(String(data.get("deckUrl") || ""));
  button.disabled = true;
  message.textContent = "正在建立活動…";
  try {
    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: String(data.get("title") || "").trim(),
        deckUrl,
        description: String(data.get("description") || "").trim(),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "活動沒有建立成功");
    showReceipt(result);
  } catch (error) {
    message.textContent = humanError(error);
    button.disabled = false;
  }
});

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const value = receiptLinks[button.dataset.copy];
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      const original = button.textContent;
      button.textContent = "已複製";
      setTimeout(() => {
        button.textContent = original;
      }, 1600);
    } catch {
      button.textContent = "請長按上方連結複製";
    }
  });
});

function showReceipt(result) {
  receiptLinks.audience = result.audienceUrl;
  receiptLinks.setup = result.setupUrl;
  receiptLinks.moderator = result.moderatorUrl;
  document.querySelector("[data-receipt-title]").textContent = `${result.title} 已建立`;
  setLink("[data-presenter-link]", result.presenterUrl);
  setLink("[data-audience-link]", result.audienceUrl, shortUrl(result.audienceUrl));
  setLink("[data-setup-link]", result.setupUrl);
  setLink("[data-moderator-link]", result.moderatorUrl);
  document.querySelector("[data-audience-qr]").src = `/api/events/${result.eventId}/qr.svg`;
  document.querySelector("[data-expiry]").textContent = `這場測試活動會在 ${new Intl.DateTimeFormat("zh-TW", { dateStyle: "long", timeStyle: "short" }).format(new Date(result.expiresAt))} 自動刪除。`;
  createPanel.hidden = true;
  receipt.hidden = false;
  receipt.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setLink(selector, href, label) {
  const link = document.querySelector(selector);
  link.href = href;
  if (label) link.textContent = label;
}

function normalizeDeckUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const slides = parsed.pathname.match(/^\/presentation\/d\/([^/]+)/);
  if (parsed.hostname === "docs.google.com" && slides?.[1]) {
    return `https://docs.google.com/presentation/d/${slides[1]}/embed?start=false&loop=false&delayms=3000`;
  }
  return parsed.toString();
}

function shortUrl(value) {
  return value.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function humanError(error) {
  const text = String(error?.message || error);
  if (text.includes("HTTPS")) return "簡報網址需要使用 https://";
  if (text.includes("complete web address")) return "請貼上完整的簡報網址，例如 https://…";
  if (text.includes("creation limit")) return "目前建立活動的人比較多，請稍後再試。";
  if (text.includes("title")) return "請填寫活動名稱與簡報網址。";
  return "活動沒有建立成功，請檢查網址後再試一次。";
}
