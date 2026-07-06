# Web UI i18n (English + Italian)

## Goal

`apps/web` (the Steward PWA) is currently hardcoded in Italian across every
component. Add English + Italian support with a language selector on the
System page, so the user can switch the static UI language at will. Language
choice persists per-device in `localStorage`.

## Scope

**In scope**: all static UI text — labels, buttons, placeholders, tooltips,
`aria-label`s, empty states, error/status messages, the keyboard-shortcuts
overlay, date/time/number formatting of that static UI.

**Out of scope**: dynamic content produced by the backend/assistant at
runtime — chat messages, Action Center titles/summaries, tool call
inputs/outputs, mail/event card field values pulled from real data. That
content is generated server-side (by the LLM or by connectors) and is not a
frontend i18n concern.

## Library

`i18next` + `react-i18next` (two new deps in `apps/web/package.json`). No
`i18next-browser-languagedetector`: the default language is fixed (English)
rather than browser-detected, so a language is resolved once at init from
`localStorage`, falling back to `"en"`.

## New files

- `src/i18n/index.ts` — creates and configures the `i18next` instance:
  ```ts
  export type Lang = "en" | "it";
  export const LANG_STORAGE_KEY = "steward-lang";
  ```
  Reads `localStorage[LANG_STORAGE_KEY]` for the initial `lng` (falls back to
  `"en"` if missing/invalid), registers `en`/`it` resources, sets
  `fallbackLng: "en"`, `interpolation.escapeValue: false`. Subscribes to
  `i18n.on("languageChanged", lng => localStorage.setItem(LANG_STORAGE_KEY, lng))`
  so persistence lives in one place, not scattered in the selector UI.
  Default-exports the configured `i18n` instance.
- `src/i18n/locales/en.json`, `src/i18n/locales/it.json` — flat-ish
  namespaced translation dictionaries. Namespaces mirror the components that
  consume them: `app`, `pairing`, `chat`, `sidebar`, `system`, `usage`,
  `actionDetail`, `approval`, `question`, `toolCard`, `fileChip`, `shortcuts`,
  `common` (shared bits like "Cancel"/"Refresh"). Pluralized strings (e.g.
  "1 messaggio" / "2 messaggi") use i18next's `_one`/`_other` plural key
  suffixes instead of hand-rolled ternaries.
- `src/lib/locale.ts` — small helper, no React dependency:
  ```ts
  export function currentLocale(): "it-IT" | "en-US"   // reads i18n.language
  export function dateFnsLocale(): Locale               // it | enUS from date-fns/locale
  ```
  Utility functions that format dates today (`formatWhen`, `fmtTime`,
  `fmtDay`, `formatDateLabel`, `formatTs`, the inline `toLocaleString` calls)
  read `currentLocale()` at call time instead of hardcoding `"it-IT"`. This
  works without prop-drilling a locale because every caller sits inside a
  component that already calls `useTranslation()` and therefore re-renders on
  `languageChanged`.

## Call sites needing locale-aware date/number formatting

(Currently hardcoded to `"it-IT"` — switch to `currentLocale()`.)

- `src/lib/format.ts:formatWhen`
- `src/App.tsx`: `fmtTime`, `fmtDay`, the usage-cost tooltip `toLocaleString` calls
- `src/components/system-page.tsx`: "last updated" timestamp
- `src/components/action-detail.tsx`: `formatDateLabel`
- `src/components/cards.tsx`: `fmtDate`
- `src/components/usage-page.tsx`: `intl`, `formatTs`
- `src/components/datetime-picker.tsx`: swap the hardcoded `date-fns/locale` `it`
  import for `dateFnsLocale()`; also pass `locale={dateFnsLocale()}` into
  `<Calendar>` (it already accepts an optional `locale` prop, currently
  unset here — `ui/calendar.tsx` supports it).

## Language selector

A new small `Card` in `system-page.tsx` (near the top, alongside the
existing summary tiles) with a two-button EN/IT toggle. `onClick` calls
`i18n.changeLanguage("en" | "it")` — persistence happens automatically via
the `languageChanged` listener registered in `src/i18n/index.ts`.

## Wiring

- `src/main.tsx` imports `"@/i18n"` once (side-effecting init) before
  rendering `<App />`.
- Every component with user-facing text imports `useTranslation` from
  `react-i18next` and replaces hardcoded strings with `t(...)` calls.
- `index.html`'s `<title>Steward</title>` and the PWA manifest
  (`name`/`short_name`/`description` in `vite.config.ts`) stay as-is — app
  branding, not translatable UI copy, and changing the manifest requires a
  rebuild anyway (it can't react to a runtime language switch).

## Testing

No existing test suite for `apps/web` beyond `tsc -b`/`eslint`. Verification
is manual: `npm run dev`, exercise each page (chat empty state, chat with
approval/question/tool cards, sidebar chat+actions tabs, action detail,
usage page, system page) in both languages, confirm no leftover Italian
strings in English mode and vice versa, confirm date/number formatting
follows the selected language, confirm the language persists across a
reload.
