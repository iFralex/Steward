/// <reference lib="webworker" />
/**
 * Steward service worker (injectManifest). Precaches the app shell and handles
 * Web Push: shows a notification on `push`, and on `notificationclick` focuses
 * (or opens) the app and forwards the payload so it can route to the chat/action.
 */
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { clientsClaim } from "workbox-core";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// injectManifest mode: registerType "autoUpdate" does NOT inject these — without
// them a new SW sits in "waiting" forever and clients keep the old precache.
self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("push", (event: PushEvent) => {
  let data: { title?: string; body?: string; tag?: string; [k: string]: unknown } = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    /* non-JSON payload — fall back to a bare notification */
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Steward", {
      body: data.body,
      icon: "/pwa-192x192.png",
      badge: "/pwa-192x192.png",
      tag: data.tag,
      data,
    }),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = event.notification.data as Record<string, unknown> | undefined;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        await client.focus();
        client.postMessage({ type: "notification-click", data });
        return;
      }
      await self.clients.openWindow("/");
    })(),
  );
});
