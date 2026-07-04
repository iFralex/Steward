/**
 * Where to reach the host, resolved from the page's own origin so it works both
 * on the Mac (localhost) and on the phone over Tailscale. `VITE_HOST_URL`
 * overrides for vite dev (:5173 pointing at the host on :4317).
 */
export function hostWsUrl(): string {
  if (import.meta.env.VITE_HOST_URL) return import.meta.env.VITE_HOST_URL as string;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

/** The host's HTTP origin (for /file, /upload, /usage, …). */
export function hostHttpBase(): string {
  return hostWsUrl().replace(/^ws/, "http");
}
