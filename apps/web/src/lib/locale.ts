/**
 * Locale helpers for date/number formatting that follows the selected UI
 * language. Plain functions (not hooks) so they can be called from render-time
 * helpers outside components too — they read the live i18next language, and
 * every caller sits inside a component that re-renders on languageChanged
 * (via useTranslation), so the value is always current.
 */
import { enUS, it } from "date-fns/locale";
import type { Locale } from "date-fns";
import i18n from "@/i18n";

export function currentLocale(): "it-IT" | "en-US" {
  return i18n.language === "it" ? "it-IT" : "en-US";
}

export function dateFnsLocale(): Locale {
  return i18n.language === "it" ? it : enUS;
}
