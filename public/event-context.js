const hostedMatch = location.pathname.match(/^\/e\/([a-f0-9]{32})(?:\/|$)/);
const demoMatch = location.pathname.match(/^\/(en\/)?demo(?:\/|$)/);
const demoEnglish = Boolean(demoMatch?.[1]);
const demoBase = demoMatch ? `/${demoEnglish ? "en/" : ""}demo` : "";

export const eventContext = {
  hosted: Boolean(hostedMatch),
  demo: Boolean(demoMatch),
  demoEnglish,
  eventId: hostedMatch?.[1] || (demoMatch ? "permanent-demo" : null),
  eventBase: hostedMatch ? `/e/${hostedMatch[1]}` : demoBase,
  apiBase: hostedMatch
    ? `/api/events/${hostedMatch[1]}`
    : demoMatch
      ? `/api/demo/${demoEnglish ? "en" : "zh"}`
      : "/api",
};

export function eventPage(path = "/") {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (eventContext.demo && normalized === "/") return `${demoBase}/audience/`;
  return `${eventContext.eventBase}${normalized}`;
}

export function eventApi(path = "/") {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${eventContext.apiBase}${normalized}`;
}

export function accessTokenKey(role) {
  return `live-deck:${eventContext.eventId || "self-hosted"}:${role}-token`;
}

export function consumeAccessToken(role) {
  const key = accessTokenKey(role);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const access = fragment.get("access");
  if (access && access.length >= 24 && access.length <= 256) {
    sessionStorage.setItem(key, access);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  return sessionStorage.getItem(key) || "";
}
