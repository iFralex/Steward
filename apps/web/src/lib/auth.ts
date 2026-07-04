/**
 * Auth-token resolution for the host's WS + HTTP data routes (mobile-access
 * M0). The Mac's own browser is auto-paired (the host injects
 * `window.__STEWARD_TOKEN__` into index.html for localhost requests only);
 * a phone pairs by scanning the System page's QR, which links to
 * `?token=<t>` — that query param is consumed once, persisted, then stripped
 * from the address bar so it never lingers there or gets shared accidentally.
 */
const KEY = "steward-token";

/** Resolve the host auth token: ?token= in the URL (from a pairing QR) wins and
 *  is persisted; else the localhost-injected global; else localStorage. */
export function resolveToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    localStorage.setItem(KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString()); // don't leave the token in the address bar
    return fromUrl;
  }
  const injected = (window as unknown as { __STEWARD_TOKEN__?: string }).__STEWARD_TOKEN__;
  if (injected) {
    localStorage.setItem(KEY, injected);
    return injected;
  }
  return localStorage.getItem(KEY);
}

export function setToken(t: string) {
  localStorage.setItem(KEY, t);
}

export function clearToken() {
  localStorage.removeItem(KEY);
}

export const authTokenKey = KEY;

/**
 * `fetch` with the auth token attached as `Authorization: Bearer <token>`.
 * On a 401 (token missing/wrong/rotated) it clears the stored token and
 * calls `onUnauthorized` so the caller can fall back to the pairing screen.
 */
export async function authFetch(
  url: string,
  token: string | null,
  onUnauthorized: () => void,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    onUnauthorized();
  }
  return res;
}
