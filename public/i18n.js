const FALLBACK_LOCALE = "en";
const TRANSLATABLE_ATTRIBUTES = ["aria-label", "placeholder", "title", "alt"];
const loaded = new Map();

let activeLocale = FALLBACK_LOCALE;
let strings = {};

async function fetchPack(locale) {
  if (loaded.has(locale)) return loaded.get(locale);
  let pack = null;
  try {
    const response = await fetch(`/locales/${encodeURIComponent(locale)}.json`);
    if (response.ok) pack = await response.json();
  } catch {
    pack = null;
  }
  loaded.set(locale, pack);
  return pack;
}

/**
 * Load the fallback pack, then merge the requested locale over it so a partial
 * translation shows translated keys and English for the rest.
 */
export async function initI18n(locale, root = document) {
  const requested = typeof locale === "string" && locale.trim() ? locale.trim() : FALLBACK_LOCALE;
  const base = (await fetchPack(FALLBACK_LOCALE)) || {};
  if (requested === FALLBACK_LOCALE) {
    strings = base;
    activeLocale = FALLBACK_LOCALE;
  } else {
    const pack = await fetchPack(requested);
    if (pack) {
      strings = { ...base, ...pack };
      activeLocale = requested;
    } else {
      console.warn(`live-deck-kit: no locale pack for "${requested}", using ${FALLBACK_LOCALE}`);
      strings = base;
      activeLocale = FALLBACK_LOCALE;
    }
  }
  document.documentElement.lang = activeLocale;
  applyTranslations(root);
  return activeLocale;
}

export function locale() {
  return activeLocale;
}

/**
 * Look up one key. Values are strings, or `{ one, other }` when the English
 * source needs a singular form. `{name}` placeholders are filled from `vars`.
 * An unknown key returns the key itself so a gap is visible instead of blank.
 */
export function t(key, vars) {
  let value = strings[key];
  if (value && typeof value === "object") {
    value = Number(vars?.count) === 1 && typeof value.one === "string" ? value.one : value.other;
  }
  if (typeof value !== "string") return key;
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

export function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.getAttribute("data-i18n"));
  });
  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    root.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    });
  }
}
