const form = document.querySelector("[data-create-form]");
const createPanel = document.querySelector("[data-create-panel]");
const message = document.querySelector("[data-create-message]");
const receipt = document.querySelector("[data-receipt]");
const fileInput = form.querySelector('input[name="deckFile"]');
const urlInput = form.querySelector('input[name="deckUrl"]');
const fileLabel = document.querySelector("[data-file-label]");
const fileLabelDefault = fileLabel.textContent;
const dropZone = document.querySelector("[data-drop-zone]");
const english = document.documentElement.lang.startsWith("en");
const receiptLinks = {};
const copyDefault = new Map();
let sourceMode = "upload";

document.querySelectorAll("[data-source-tab]").forEach((tab) => {
  tab.addEventListener("click", () => setSourceMode(tab.dataset.sourceTab));
});

fileInput.addEventListener("change", () => updateFileLabel(fileInput.files?.[0]));
for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add("is-dragging"); });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove("is-dragging"); });
}
dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  updateFileLabel(file);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button[type=submit]");
  const data = new FormData(form);
  const file = fileInput.files?.[0];
  if (sourceMode === "upload") {
    data.delete("deckUrl");
    if (!file) return showError(english ? "Choose a PDF to upload." : "請選擇要上傳的 PDF。");
    if (file.size > 20 * 1024 * 1024) return showError(english ? "The PDF must be 20MB or smaller." : "PDF 不能超過 20MB。");
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") return showError(english ? "Choose a PDF file." : "請選擇 PDF 檔案。");
  } else {
    data.delete("deckFile");
    const deckUrl = normalizeDeckUrl(String(data.get("deckUrl") || ""));
    if (!deckUrl) return showError(english ? "Paste your deck URL." : "請貼上簡報網址。");
    data.set("deckUrl", deckUrl);
  }
  button.disabled = true;
  message.textContent = english ? (sourceMode === "upload" ? "Uploading your PDF and creating the event…" : "Creating your event…") : (sourceMode === "upload" ? "正在上傳 PDF 並建立叩應…" : "正在建立叩應…");
  try {
    const response = await fetch("/api/events", { method: "POST", body: data });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || (english ? "The event was not created" : "叩應沒有建立成功"));
    showReceipt(result);
  } catch (error) {
    message.textContent = humanError(error);
    button.disabled = false;
  }
});

document.querySelectorAll("[data-copy]").forEach((button) => {
  copyDefault.set(button, button.textContent);
  button.addEventListener("click", async () => {
    const value = receiptLinks[button.dataset.copy];
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = english ? "Copied" : "已複製";
      setTimeout(() => { button.textContent = copyDefault.get(button); }, 1600);
    } catch {
      button.textContent = english ? "Copy the link above" : "請長按上方連結複製";
    }
  });
});

document.querySelectorAll("[data-create-another]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    form.reset();
    fileLabel.textContent = fileLabelDefault;
    message.textContent = "";
    setSourceMode("upload");
    receipt.hidden = true;
    createPanel.hidden = false;
    history.pushState(null, "", "#create");
    createPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    form.querySelector('input[name="title"]')?.focus({ preventScroll: true });
  });
});

function setSourceMode(mode) {
  sourceMode = mode === "url" ? "url" : "upload";
  document.querySelectorAll("[data-source-tab]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.sourceTab === sourceMode)));
  document.querySelectorAll("[data-source-panel]").forEach((panel) => { panel.hidden = panel.dataset.sourcePanel !== sourceMode; });
  fileInput.disabled = sourceMode !== "upload";
  urlInput.disabled = sourceMode !== "url";
}

function updateFileLabel(file) {
  if (!file) return;
  fileLabel.textContent = `${file.name} · ${formatBytes(file.size)}`;
}

function showReceipt(result) {
  receiptLinks.audience = result.audienceUrl;
  receiptLinks.setup = result.setupUrl;
  receiptLinks.moderator = result.moderatorUrl;
  document.querySelector("[data-receipt-title]").textContent = english ? `${result.title} is ready` : `${result.title} 已建立`;
  setLink("[data-presenter-link]", result.presenterUrl);
  setLink("[data-audience-link]", result.audienceUrl, shortUrl(result.audienceUrl));
  setLink("[data-setup-link]", result.setupUrl);
  setLink("[data-moderator-link]", result.moderatorUrl);
  document.querySelector("[data-audience-qr]").src = `/api/events/${result.eventId}/qr.svg`;
  document.querySelector("[data-expiry]").textContent = english
    ? `This event and its uploaded deck will be deleted automatically on ${new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short" }).format(new Date(result.expiresAt))}.`
    : `這場叩應與上傳的簡報會在 ${new Intl.DateTimeFormat("zh-TW", { dateStyle: "long", timeStyle: "short" }).format(new Date(result.expiresAt))} 自動刪除。`;
  createPanel.hidden = true;
  receipt.hidden = false;
  receipt.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setLink(selector, href, label) { const link = document.querySelector(selector); link.href = href; if (label) link.textContent = label; }
function showError(value) { message.textContent = value; }
function normalizeDeckUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let parsed;
  try { parsed = new URL(trimmed); } catch { return trimmed; }
  const slides = parsed.pathname.match(/^\/presentation\/d\/([^/]+)/);
  if (parsed.hostname === "docs.google.com" && slides?.[1]) return `https://docs.google.com/presentation/d/${slides[1]}/embed?start=false&loop=false&delayms=3000`;
  return parsed.toString();
}
function shortUrl(value) { return value.replace(/^https?:\/\//, "").replace(/\/$/, ""); }
function formatBytes(value) { return value < 1024 * 1024 ? `${Math.ceil(value / 1024)}KB` : `${(value / 1024 / 1024).toFixed(1)}MB`; }
function humanError(error) {
  const text = String(error?.message || error);
  if (text.includes("20 MB") || text.includes("too large")) return english ? "The PDF must be 20MB or smaller." : "PDF 不能超過 20MB。";
  if (text.includes("valid PDF") || text.includes("must be a PDF")) return english ? "That file is not a valid PDF." : "這個檔案不是有效的 PDF。";
  if (text.includes("HTTPS")) return english ? "The deck URL must use https://" : "簡報網址需要使用 https://";
  if (text.includes("complete web address")) return english ? "Paste a complete URL, such as https://…" : "請貼上完整的簡報網址，例如 https://…";
  if (text.includes("creation limit") || text.includes("upload limit")) return english ? "Call-in is busy right now. Try again later." : "目前建立叩應的人比較多，請稍後再試。";
  if (text.includes("title")) return english ? "Add an event title and a deck." : "請填寫活動名稱並放入簡報。";
  return english ? "The event was not created. Check the deck and try again." : "叩應沒有建立成功，請檢查簡報後再試一次。";
}

setSourceMode("upload");
