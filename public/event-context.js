const hostedMatch = location.pathname.match(/^\/e\/([a-f0-9]{32})(?:\/|$)/);

export const eventContext = {
  hosted: Boolean(hostedMatch),
  eventId: hostedMatch?.[1] || null,
  eventBase: hostedMatch ? `/e/${hostedMatch[1]}` : "",
  apiBase: hostedMatch ? `/api/events/${hostedMatch[1]}` : "/api",
};

export function eventPage(path = "/") {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${eventContext.eventBase}${normalized}`;
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
