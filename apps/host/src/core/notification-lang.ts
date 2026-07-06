/**
 * Persisted language for server-generated push notification copy (mobile-access
 * M2/M3). Steward is single-user/multi-device, so this is one shared setting —
 * not per-subscription — kept in sync from whichever device last changed the
 * language in the web UI's System page.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stewardConfigDir } from "../config.ts";

export type NotificationLang = "en" | "it";

function filePath(): string {
  return join(stewardConfigDir(), "notification-lang.json");
}

export function getNotificationLang(): NotificationLang {
  try {
    if (!existsSync(filePath())) return "en";
    const raw = JSON.parse(readFileSync(filePath(), "utf8")) as { lang?: string };
    return raw.lang === "it" ? "it" : "en";
  } catch {
    return "en";
  }
}

export function setNotificationLang(lang: NotificationLang): void {
  writeFileSync(filePath(), JSON.stringify({ lang }));
}
