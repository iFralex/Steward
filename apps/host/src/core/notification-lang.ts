/**
 * Persisted language for all server-generated user-facing copy, including
 * voice and push notifications. Steward is single-user/multi-device, so this
 * is one shared setting kept in sync by the PWA.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stewardConfigDir } from "../config.ts";

export type NotificationLang = "en" | "it";
/** The setting is shared by every host-generated user-facing message. */
export type UserLang = NotificationLang;

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

/** Semantic alias for non-notification channels such as voice calls. */
export const getUserLang = getNotificationLang;

export function setNotificationLang(lang: NotificationLang): void {
  writeFileSync(filePath(), JSON.stringify({ lang }));
}
