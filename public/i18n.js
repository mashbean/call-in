export function createLocale(config) {
  const zhHant = String(config?.locale || "").toLowerCase().startsWith("zh");
  return {
    zhHant,
    text(english, traditionalChinese) {
      return zhHant ? traditionalChinese : english;
    },
    apply(root = document) {
      if (!zhHant) return;
      document.documentElement.lang = "zh-Hant-TW";
      root.querySelectorAll("[data-zh]").forEach((element) => {
        element.textContent = element.dataset.zh;
      });
      root.querySelectorAll("[data-zh-tail]").forEach((element) => {
        element.lastChild.textContent = element.dataset.zhTail;
      });
      for (const [selector, attribute, dataKey] of [
        ["[data-zh-aria]", "aria-label", "zhAria"],
        ["[data-zh-title]", "title", "zhTitle"],
        ["[data-zh-placeholder]", "placeholder", "zhPlaceholder"],
      ]) {
        root.querySelectorAll(selector).forEach((element) => {
          element.setAttribute(attribute, element.dataset[dataKey]);
          if (dataKey === "zhAria" && element instanceof HTMLImageElement) {
            element.alt = element.dataset[dataKey];
          }
        });
      }
    },
  };
}
