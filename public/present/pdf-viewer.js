import { GlobalWorkerOptions, getDocument } from "/vendor/pdfjs/pdf.mjs";

GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";

const params = new URLSearchParams(location.search);
const english = params.get("lang") === "en";
const stage = document.querySelector("[data-pdf-stage]");
const canvasWrap = document.querySelector("[data-pdf-canvas-wrap]");
const canvas = document.querySelector("[data-pdf-canvas]");
const linkLayer = document.querySelector("[data-pdf-links]");
const status = document.querySelector("[data-pdf-status]");
const controls = document.querySelector("[data-pdf-controls]");
const previous = document.querySelector("[data-pdf-prev]");
const next = document.querySelector("[data-pdf-next]");
const currentLabel = document.querySelector("[data-pdf-current]");
const totalLabel = document.querySelector("[data-pdf-total]");
const labels = english
  ? { title: "Call-in PDF deck", stage: "PDF slides", loading: "Preparing slides…", error: "This PDF could not be displayed. Use “Open deck” in the presenter toolbar.", previous: "Previous page", next: "Next page", page: (page, total) => `Slide ${page} of ${total}`, internalLink: (page) => `Go to slide ${page}` }
  : { title: "Call-in PDF 簡報", stage: "PDF 簡報", loading: "正在準備簡報…", error: "這份 PDF 無法顯示，請使用講者工具列的「另開簡報」。", previous: "上一頁", next: "下一頁", page: (page, total) => `簡報第 ${page} 頁，共 ${total} 頁`, internalLink: (page) => `跳至第 ${page} 頁` };

let pdf;
let pageNumber = 1;
let renderTask;
let renderSequence = 0;
let resizeTimer;
let pointerStart;
let suppressLinkClick = false;

document.documentElement.lang = english ? "en" : "zh-Hant-TW";
document.title = labels.title;
stage.setAttribute("aria-label", labels.stage);
status.textContent = labels.loading;
previous.setAttribute("aria-label", labels.previous);
previous.title = `${labels.previous} (←)`;
next.setAttribute("aria-label", labels.next);
next.title = `${labels.next} (→ / Space)`;

previous.addEventListener("click", () => void goToPage(pageNumber - 1));
next.addEventListener("click", () => void goToPage(pageNumber + 1));
stage.addEventListener("keydown", (event) => {
  if (["ArrowRight", "PageDown", " "].includes(event.key)) {
    event.preventDefault();
    void goToPage(pageNumber + 1);
  } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
    event.preventDefault();
    void goToPage(pageNumber - 1);
  } else if (event.key === "Home") {
    event.preventDefault();
    void goToPage(1);
  } else if (event.key === "End" && pdf) {
    event.preventDefault();
    void goToPage(pdf.numPages);
  }
});
stage.addEventListener("pointerdown", (event) => {
  suppressLinkClick = false;
  pointerStart = { x: event.clientX, y: event.clientY };
});
stage.addEventListener("pointerup", (event) => {
  if (!pointerStart) return;
  const deltaX = event.clientX - pointerStart.x;
  const deltaY = event.clientY - pointerStart.y;
  pointerStart = null;
  if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY)) return;
  suppressLinkClick = true;
  void goToPage(pageNumber + (deltaX < 0 ? 1 : -1));
});
// A swipe that starts and ends on the same wide link would both flip the page and
// follow the link; swallow the click the swipe gesture produces.
linkLayer.addEventListener(
  "click",
  (event) => {
    if (!suppressLinkClick) return;
    suppressLinkClick = false;
    event.preventDefault();
    event.stopPropagation();
  },
  true,
);
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (pdf) void renderPage(); }, 120);
}).observe(stage);

void initialize();

async function initialize() {
  try {
    const fileUrl = hostedPdfUrl(params.get("file"));
    pdf = await getDocument({ url: fileUrl.href, isEvalSupported: false }).promise;
    totalLabel.textContent = String(pdf.numPages);
    controls.hidden = false;
    stage.focus({ preventScroll: true });
    await renderPage();
    parent.postMessage({ type: "call-in:pdf-ready", pages: pdf.numPages }, location.origin);
  } catch (error) {
    console.error("PDF viewer failed", error);
    canvasWrap.hidden = true;
    controls.hidden = true;
    status.hidden = false;
    status.classList.add("is-error");
    status.textContent = labels.error;
  }
}

async function goToPage(nextPage) {
  if (!pdf) return;
  const bounded = Math.min(pdf.numPages, Math.max(1, nextPage));
  if (bounded === pageNumber) return;
  pageNumber = bounded;
  await renderPage();
}

async function renderPage() {
  const sequence = ++renderSequence;
  renderTask?.cancel();
  linkLayer.replaceChildren();
  const page = await pdf.getPage(pageNumber);
  if (sequence !== renderSequence) return;
  const initialViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.max(1, stage.clientWidth - 24);
  const availableHeight = Math.max(1, stage.clientHeight - 24);
  const scale = Math.min(availableWidth / initialViewport.width, availableHeight / initialViewport.height);
  const viewport = page.getViewport({ scale });
  const outputScale = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
  canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const context = canvas.getContext("2d", { alpha: false });
  renderTask = page.render({ canvasContext: context, viewport, transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0] });
  try {
    await renderTask.promise;
  } catch (error) {
    if (error?.name === "RenderingCancelledException") return;
    throw error;
  }
  if (sequence !== renderSequence) return;
  canvasWrap.hidden = false;
  status.hidden = true;
  currentLabel.textContent = String(pageNumber);
  previous.disabled = pageNumber === 1;
  next.disabled = pageNumber === pdf.numPages;
  const pageLabel = labels.page(pageNumber, pdf.numPages);
  canvas.setAttribute("aria-label", pageLabel);
  await renderLinks(page, viewport, sequence);
  parent.postMessage({ type: "call-in:pdf-page", page: pageNumber, pages: pdf.numPages }, location.origin);
}

const allowedLinkProtocols = ["http:", "https:", "mailto:"];

async function renderLinks(page, viewport, sequence) {
  let annotations;
  try {
    annotations = await page.getAnnotations({ intent: "display" });
  } catch {
    return;
  }
  if (sequence !== renderSequence) return;
  const links = [];
  for (const annotation of annotations) {
    if (annotation.subtype !== "Link") continue;
    const anchor = annotation.url
      ? externalLink(annotation.url)
      : annotation.dest
        ? await internalLink(annotation.dest)
        : null;
    if (sequence !== renderSequence) return;
    if (!anchor) continue;
    const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
    const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
    anchor.style.left = `${Math.min(x1, x2)}px`;
    anchor.style.top = `${Math.min(y1, y2)}px`;
    anchor.style.width = `${Math.abs(x2 - x1)}px`;
    anchor.style.height = `${Math.abs(y2 - y1)}px`;
    links.push(anchor);
  }
  linkLayer.replaceChildren(...links);
}

function externalLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!allowedLinkProtocols.includes(parsed.protocol)) return null;
  const anchor = document.createElement("a");
  anchor.href = parsed.href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.title = parsed.href;
  return anchor;
}

async function internalLink(dest) {
  try {
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit[0]) return null;
    const targetPage = (await pdf.getPageIndex(explicit[0])) + 1;
    const anchor = document.createElement("a");
    anchor.href = "#";
    anchor.title = labels.internalLink(targetPage);
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      void goToPage(targetPage);
    });
    return anchor;
  } catch {
    return null;
  }
}

function hostedPdfUrl(value) {
  if (!value) throw new Error("missing PDF URL");
  const parsed = new URL(value, location.origin);
  if (parsed.origin !== location.origin || !/^\/api\/events\/[a-f0-9]{32}\/deck\.pdf$/.test(parsed.pathname)) {
    throw new Error("unsupported PDF URL");
  }
  return parsed;
}
