/**
 * Web Push client (mobile-access M3): subscribe this device to push and register
 * the subscription with the host, so action-center proposals ping the phone.
 * No Apple Developer account — standard Web Push (VAPID), iOS 16.4+ home-screen PWA.
 */
import { authFetch } from "./auth";

/** VAPID public keys are base64url; PushManager wants a BufferSource. Build from
 *  an explicit ArrayBuffer so the type is `Uint8Array<ArrayBuffer>` (assignable
 *  to `applicationServerKey`). */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type EnablePushResult = "ok" | "denied" | "unsupported" | "error";

/** Request permission, subscribe via the SW, and register with the host. Must be
 *  called from a user gesture (iOS requires it). */
export async function enablePush(httpBase: string, token: string | null, onUnauthorized: () => void): Promise<EnablePushResult> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  try {
    const reg = await navigator.serviceWorker.ready;
    const vapidRes = await authFetch(`${httpBase}/push/vapid`, token, onUnauthorized);
    if (!vapidRes.ok) return "error";
    const { publicKey } = (await vapidRes.json()) as { publicKey: string };
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));
    const post = await authFetch(`${httpBase}/push/subscribe`, token, onUnauthorized, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    return post.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}

/** Is this device already subscribed to push? */
export async function pushSubscribed(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return !!(await reg.pushManager.getSubscription());
  } catch {
    return false;
  }
}
