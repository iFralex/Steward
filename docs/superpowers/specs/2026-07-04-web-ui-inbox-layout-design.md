# Web UI restructure: unified-inbox layout (desktop + mobile)

**Date:** 2026-07-04
**Status:** Design — approved in conversation; pending implementation plan.
**Scope:** `apps/web` only. Layout/structure change; individual cards and section internals stay as they are.

## 1. Context & goal

The web app (`apps/web`, "Steward") currently renders its main view as a **4-column fixed grid** at `lg+`: chat list (210px) | Action Center list + diagnostics (330px) | chat thread (1fr) | action detail (330px+). Problems, all structural:

1. **Permanent columns**: the two Action Center columns consume ~660px even when unused; the chat — the app's core surface — is squeezed in the middle.
2. **Cramped action detail**: `ActionDetail` (badges, deadline, Related mail accordion, ProposalCards, Context) lives in a ~330px column; proposals and mail groups don't have reading width.
3. **Split navigation**: mobile has a 3-tab bottom nav (Chat / Agente / Azioni) driving the columns, but Usage/System are only reachable from a separate header segmented control — two unrelated navigation systems. The mobile tabs "Chat" and "Agente" are confusingly two tabs for list vs thread of the same thing.
4. **Diagnostics above the fold**: the Action Center panel's diagnostics block (4-counter grid, stale, deferred, show-done checkbox) permanently pushes the actual action list down.

**Goal:** restructure to a **2-column "unified inbox"** layout that reuses all existing cards/sections, gives both chat and action detail full-width treatment, and unifies navigation across desktop and mobile.

Design chosen over two alternatives (icon rail + chat-central à la Slack; triage-first dashboard) because it fixes all three structural problems and yields the most natural mobile pattern.

## 2. Desktop layout (`lg+`)

```
┌──────────────────────────────────────────────────────┐
│ Steward                    $0.42 · ● connected · [⋯] │  slim header
├───────────┬──────────────────────────────────────────┤
│ [Chat|Az³]│                                          │
│───────────│         CONTENT AREA                     │
│ ▸ chat 1  │   (chat thread + composer, OR            │
│ ▸ chat 2  │    action detail at reading width, OR    │
│ ▸ az. 1   │    Usage / System page)                  │
│ ▸ az. 2   │                                          │
│───────────│                                          │
│ 📊 Usage  │                                          │
│ ⚙ System  │                                          │
└───────────┴──────────────────────────────────────────┘
```

- **Sidebar (~300px)**, single, with two tabs at the top: **Chat** and **Azioni** (badge = count of `new` actions). Fixed footer entries: Usage, System. The header view-switcher is removed — navigation lives in one place.
- **Content area** renders the current selection. Internal state: `center: {type:"chat"} | {type:"action"} | {type:"usage"} | {type:"system"}` replacing today's `view` + `mobilePanel` pair (plus the existing `selectedActionId`).

### Sidebar — Azioni tab

- Today's diagnostics block compresses to **one summary row** ("3 new · 1 stale · next due 15:00") plus a filter icon opening a **Popover** (component already in use) containing: full status counters, deferred reasons, "show done/dismissed" toggle, Refresh button.
- Action list items unchanged (priority/kind badges, title, summary, due).

### Sidebar — Chat tab

Current `ChatSidebar` as-is (new / rename / delete / save behaviors unchanged).

## 3. Content area

- **Chat selected** → thread + composer as today, full width; thread content centered at **max-width ~52rem** to avoid over-long lines; message bubbles keep `max-w-[85%]`.
- **Action selected** → current `ActionDetail` rendered as a **centered column at max-width ~48rem**. Same cards, reading width.
- **Contextual split**: `openActionChat` ("Open in chat" button, or a push-notification tap on an action) puts the content area in a split `chat (1fr) | action detail (400px)` while that temporary chat is active; the detail pane has a ✕ to close. This is the *only* case with two side-by-side panes — it preserves the one real benefit of the old 4-column layout (chat + proposals visible together) without paying for it permanently.

## 4. Header

Slims down: title left; right side keeps the cost pill (click → Usage) and connection status, and gains a **⋯ menu** collecting Copy JSON and the keyboard-shortcuts overlay trigger. All existing shortcuts stay; `u` still toggles Usage; new: `a` toggles the sidebar between Chat and Azioni tabs.

## 5. Mobile (`< lg`)

Bottom nav with 3 tabs, each an independent **navigable stack** (list → tap → full-screen content → "←" back):

- **💬 Chat**: chat list → thread. Replaces the current separate "Chat"/"Agente" tabs.
- **⚡ Azioni** (badge): action list (with the same summary row + filter popover) → action detail.
- **⚙ Altro**: two entries — Usage and System (current pages, unchanged).

"Open in chat" on mobile navigates to the Chat stack on the temporary chat (no split). Push-notification taps land on the action detail inside the Azioni stack, or on the chat inside the Chat stack — the service-worker message handler logic stays, only its mapping onto the new state changes.

## 6. Contextual refactor

`App.tsx` is ~1220 lines and contains `ChatSidebar`, `ActionCenterPanel`, `ActionDetail`, `ProposalCard`, and all the related-mail helpers. The re-layout touches them anyway, so they move to their own files:

- `src/components/sidebar.tsx` — unified sidebar (tabs, both lists, footer nav).
- `src/components/action-detail.tsx` — `ActionDetail` + `ProposalCard` + the related-mail helper functions (`collectRelatedMailGroups`, `extractMainThreadRecords`, mail-URL utils, `readDeadline`, …).

`App.tsx` keeps layout, state, and routing only. **No logic changes** in the moved code.

## 7. Out of scope / unchanged

All cards (`ToolCard`, `ApprovalCard`, `QuestionCard`, `CardView`, `FileChip`), the composer (drag & drop, attachments), `MarkdownMessage`, the internals of the Usage and System pages, `host-socket`, auth/pairing flow, push subscription logic.

## 8. Verification

- `npm run dev` in `apps/web`; visual check on desktop and in the browser's mobile viewport (chat flow, action triage flow, contextual split, push-tap mapping, pairing screen untouched).
- `tsc` and lint clean. No new automated tests (the web app has none).
