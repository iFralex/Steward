# Web UI Unified-Inbox Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `apps/web` from a 4-column fixed grid into a 2-column "unified inbox" layout (single sidebar with Chat/Azioni tabs + wide content area), with per-tab stack navigation on mobile, per spec `docs/superpowers/specs/2026-07-04-web-ui-inbox-layout-design.md`.

**Architecture:** Pure client-side re-layout of `apps/web` (Vite + React 19 + Tailwind v4 + shadcn/base-ui). First extract the components that currently live inside the 1220-line `App.tsx` (ActionDetail + mail helpers, ChatSidebar, ActionCenterPanel) into their own files verbatim; then build the `UnifiedSidebar` and rewrite `App.tsx`'s state model + layout; finally add the contextual chat|action split. Rendering branches on desktop vs mobile via a `matchMedia` hook (breakpoint `lg` = 1024px, same as the current Tailwind classes).

**Tech Stack:** React 19, TypeScript, Tailwind v4, existing shadcn-style UI components (`Button`, `Badge`, `Popover`, `Card`, `Accordion`), `lucide-react` icons.

## Global Constraints

- **No new dependencies.** Reuse the UI components already in `src/components/ui/`.
- **Moved code moves verbatim** — no logic edits during extraction (Task 1). Behavior changes only in Tasks 2–3.
- **UI copy is Italian**, matching existing strings ("Nessuna chat.", "Nessuna action.", "Rinomina", …).
- **Unchanged:** all cards (`ToolCard`, `ApprovalCard`, `QuestionCard`, `CardView`, `FileChip`), composer drag&drop/attachments, `MarkdownMessage`, `UsagePage`/`SystemPage` internals, `host-socket`, auth/pairing, push subscription (`lib/push.ts`), service worker.
- **All existing keyboard shortcuts keep working** (Invio, Esc, `/`, `c`, `j`/`k`, `u`, `?`); one new: `a` toggles the sidebar tab.
- **No automated tests exist for `apps/web` and none are added.** Every task verifies with `npm run typecheck -w @steward/web`, `npm run lint -w @steward/web`, and (final task) a visual walkthrough with `npm run dev`.
- Work happens on the current branch `feat/mobile-access`. Commit after every task with the exact messages given. All commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/format.ts` (new) | Shared formatters used by both sidebar and action detail: `formatWhen`, `priorityVariant`. |
| `src/lib/use-is-desktop.ts` (new) | `useIsDesktop()` hook — `matchMedia("(min-width: 1024px)")` via `useSyncExternalStore`. |
| `src/components/action-detail.tsx` (new) | `ActionDetail`, `ProposalCard`, `readDeadline`, related-mail helpers (moved from App.tsx). |
| `src/components/sidebar.tsx` (new) | `UnifiedSidebar` (tabs Chat/Azioni + badge, chat list, action list with compressed diagnostics + filter popover, footer nav Usage/System). |
| `src/App.tsx` (rewrite of layout parts) | State model (`tab`/`pane`/`mobileDrill`/`morePane`/`selectedActionId`/`splitActionId`), slim header, 2-column grid, content area, bottom nav, push mapping, shortcuts. Keeps: chat thread rendering, composer, `MarkdownMessage`, `ShortcutsOverlay`, `PairingScreen`, `ThinkingIndicator`, date helpers. |

Line references below are to `App.tsx` **at commit `9aee18a`** (before any task starts). Task 1 shifts everything; later tasks reference code by name, not line.

---

### Task 1: Extract action-detail, sidebar lists, and shared helpers out of App.tsx (pure move)

**Files:**
- Create: `apps/web/src/lib/format.ts`
- Create: `apps/web/src/lib/use-is-desktop.ts`
- Create: `apps/web/src/components/action-detail.tsx`
- Create: `apps/web/src/components/sidebar.tsx`
- Modify: `apps/web/src/App.tsx` (delete moved code, fix imports)

**Interfaces:**
- Consumes: current `App.tsx` definitions (verbatim).
- Produces (later tasks rely on these exact exports):
  - `format.ts`: `formatWhen(unixSeconds: number): string`, `priorityVariant(priority: ActionCenterItem["priority"]): "default" | "secondary" | "destructive" | "outline"`.
  - `use-is-desktop.ts`: `useIsDesktop(): boolean`.
  - `action-detail.tsx`: `ActionDetail(props: { action: ActionCenterItem | null; onOpenChat: (action: ActionCenterItem) => void; onMark: (status: "new" | "read" | "done" | "dismissed") => void; onExecute: (proposalId: string) => void; onRevise: (proposalId: string, instruction: string) => void })` — same signature as today.
  - `sidebar.tsx`: `ChatSidebar` and `ActionCenterPanel` with today's exact prop signatures, plus `export type ActionDiagnostics = NonNullable<ReturnType<typeof useHostSocket>["actionCenter"]>["diagnostics"];`.

- [ ] **Step 1: Create `src/lib/format.ts`**

```ts
import type { ActionCenterItem } from "@steward/protocol";

export function formatWhen(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("it-IT", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function priorityVariant(priority: ActionCenterItem["priority"]): "default" | "secondary" | "destructive" | "outline" {
  if (priority === "high") return "destructive";
  if (priority === "low") return "secondary";
  return "default";
}
```

(Bodies are the current `App.tsx:1207-1220` verbatim.)

- [ ] **Step 2: Create `src/lib/use-is-desktop.ts`**

```ts
import { useSyncExternalStore } from "react";

/** Matches Tailwind's `lg` breakpoint — the same threshold the layout classes use. */
const QUERY = "(min-width: 1024px)";

export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(QUERY);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(QUERY).matches,
  );
}
```

- [ ] **Step 3: Create `src/components/action-detail.tsx`**

File header + imports:

```tsx
/**
 * Action detail view: badges/deadline header, related-mail groups, proposal
 * cards with revise-popover, and the raw context snapshot. Moved verbatim
 * from App.tsx; helpers below are only used here.
 */
import { useEffect, useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatWhen, priorityVariant } from "@/lib/format";
import type { ActionCenterItem } from "@steward/protocol";
```

Then move from `App.tsx`, **verbatim and in this order**, adding `export` only to `ActionDetail`:

- `ActionDetail` (lines 778–891) → `export function ActionDetail`
- `ProposalCard` (893–983)
- `readDeadline` (985–998)
- `interface ProposedActionView` (1000–1005)
- `interface RelatedMailGroup` (1007–1017)
- `collectRelatedMailGroups` (1019–1101)
- `extractMainThreadRecords` (1103–1142)
- `mailUrlFromMessageId`, `normalizeMailUrl`, `shortMessageId`, `dedupeMailRecords`, `cleanSubject`, `preferTitle`, `maxDate`, `formatDateLabel` (1144–1205)

`formatWhen`/`priorityVariant` calls now resolve to the `@/lib/format` import.

- [ ] **Step 4: Create `src/components/sidebar.tsx`**

File header + imports:

```tsx
/**
 * Sidebar lists: the chat list and the Action Center list. Moved verbatim
 * from App.tsx (Task 2 of the inbox-layout plan turns these into the tabs
 * of a single UnifiedSidebar).
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatWhen, priorityVariant } from "@/lib/format";
import type { useHostSocket } from "@/lib/host-socket";
import type { ActionCenterItem, ChatSummary } from "@steward/protocol";

export type ActionDiagnostics = NonNullable<ReturnType<typeof useHostSocket>["actionCenter"]>["diagnostics"];
```

Move verbatim, exported:

- `ChatSidebar` (App.tsx lines 485–569) → `export function ChatSidebar`
- `ActionCenterPanel` (702–776) → `export function ActionCenterPanel`; change its `diagnostics` prop type from the inline `NonNullable<ReturnType<typeof useHostSocket>["actionCenter"]>["diagnostics"] | undefined` to `ActionDiagnostics | undefined`.

- [ ] **Step 5: Update `App.tsx`**

1. Delete the moved blocks: lines 485–569 (`ChatSidebar`), 702–776 (`ActionCenterPanel`), 778–1220 (everything from `ActionDetail` to `formatWhen` — the file now ends after `MarkdownMessage`).
2. Add imports:

```tsx
import { ActionDetail } from "@/components/action-detail";
import { ChatSidebar, ActionCenterPanel } from "@/components/sidebar";
```

3. Prune now-unused imports from App.tsx: `Accordion`/`AccordionContent`/`AccordionItem`/`AccordionTrigger`, `Badge`, `buttonVariants`, `Card`/`CardContent`/`CardDescription`/`CardHeader`/`CardTitle`, `Popover`* — keep `Button`, `Input`, `cn`, `safeHref` and everything the chat/composer/markdown code still uses. Let `npm run lint` be the arbiter.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck -w @steward/web && npm run lint -w @steward/web`
Expected: both exit 0. Fix only import/reference fallout — no logic changes.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): extract action-detail, sidebar lists, format helpers from App.tsx

Pure moves, no behavior change. Adds useIsDesktop hook for the upcoming
layout rework.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: UnifiedSidebar + new App layout (desktop 2-column, mobile stacks, slim header)

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx` (turn the two lists into tabs of one `UnifiedSidebar`)
- Modify: `apps/web/src/App.tsx` (state model, layout, header, bottom nav, push mapping, shortcuts)

**Interfaces:**
- Consumes: Task 1 exports (`ActionDetail`, `ActionDiagnostics`, `formatWhen`, `priorityVariant`, `useIsDesktop`).
- Produces: `sidebar.tsx` exports exactly:

```ts
export type SidebarTab = "chat" | "actions";
export type ActionDiagnostics = /* unchanged from Task 1 */;
export function UnifiedSidebar(props: {
  tab: SidebarTab;
  onTab: (tab: SidebarTab) => void;
  chats: ChatSummary[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onCreateChat: () => void;
  onRenameChat: (id: string, title: string) => void;
  onDeleteChat: (id: string) => void;
  onSaveChat: (id: string) => void;
  actions: ActionCenterItem[];
  diagnostics: ActionDiagnostics | undefined;
  selectedActionId: number | null;
  onSelectAction: (item: ActionCenterItem) => void;
  showDone: boolean;
  onShowDone: (value: boolean) => void;
  onRefreshActions: () => void;
  pane: "chat" | "action" | "usage" | "system";
  onOpenUsage: () => void;
  onOpenSystem: () => void;
}): JSX.Element;
```

`ChatSidebar` and `ActionCenterPanel` exports are **removed** (App.tsx stops using them in this same task).

- [ ] **Step 1: Rewrite `sidebar.tsx` around `UnifiedSidebar`**

Keep the Task 1 imports and add:

```tsx
import { BarChart3, Filter, RefreshCw, Settings } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
```

New top-level component (full code):

```tsx
export type SidebarTab = "chat" | "actions";

export function UnifiedSidebar({
  tab, onTab,
  chats, activeChatId, onSelectChat, onCreateChat, onRenameChat, onDeleteChat, onSaveChat,
  actions, diagnostics, selectedActionId, onSelectAction, showDone, onShowDone, onRefreshActions,
  pane, onOpenUsage, onOpenSystem,
}: { /* the props type from the Interfaces block above, inline */ }) {
  const newCount = diagnostics?.counts.new ?? 0;
  return (
    <div className="flex h-full flex-col">
      {/* Tabs: desktop only — on mobile the bottom nav selects the tab. */}
      <div className="hidden grid-cols-2 gap-1 border-b p-2 lg:grid">
        <TabButton active={tab === "chat"} onClick={() => onTab("chat")}>Chat</TabButton>
        <TabButton active={tab === "actions"} onClick={() => onTab("actions")}>
          Azioni
          {newCount > 0 && (
            <span className="bg-primary text-primary-foreground ml-1.5 rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums">
              {newCount}
            </span>
          )}
        </TabButton>
      </div>
      {tab === "chat" ? (
        <ChatList
          chats={chats}
          activeChatId={activeChatId}
          onSelect={onSelectChat}
          onCreate={onCreateChat}
          onRename={onRenameChat}
          onDelete={onDeleteChat}
          onSave={onSaveChat}
        />
      ) : (
        <ActionList
          items={actions}
          diagnostics={diagnostics}
          selectedId={selectedActionId}
          showDone={showDone}
          onShowDone={onShowDone}
          onRefresh={onRefreshActions}
          onSelect={onSelectAction}
        />
      )}
      {/* Footer nav: desktop only — on mobile Usage/System live under the "Altro" tab. */}
      <div className="hidden gap-1 border-t p-2 lg:flex lg:flex-col">
        <FooterButton icon={<BarChart3 className="size-4" />} label="Usage" active={pane === "usage"} onClick={onOpenUsage} />
        <FooterButton icon={<Settings className="size-4" />} label="System" active={pane === "system"} onClick={onOpenSystem} />
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-center rounded-md px-2 py-1.5 text-sm transition",
        active ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:bg-muted/50",
      )}
    >
      {children}
    </button>
  );
}

function FooterButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition",
        active ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:bg-muted/50",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
```

- [ ] **Step 2: Adapt the two lists**

1. Rename `ChatSidebar` → `ChatList` (not exported). Its only markup change: the header row loses the `<h2>Chat</h2>` (redundant under the tab) —

```tsx
<div className="flex items-center justify-end border-b p-2">
  <Button size="sm" onClick={onCreate} title="Nuova chat">+ Nuova</Button>
</div>
```

Everything else (list items, temp badge, rename/delete/save hover buttons) stays verbatim.

2. Replace `ActionCenterPanel` with `ActionList` (not exported): the scrollable list part stays **verbatim** (the `items.length === 0 ? … : items.map(…)` block including the priority/kind badges), but the old diagnostics header block (heading + Refresh button + 4-counter grid + stale/next-due row + deferred box + checkbox) is replaced by one compact row:

```tsx
function ActionList({
  items, diagnostics, selectedId, showDone, onShowDone, onRefresh, onSelect,
}: {
  items: ActionCenterItem[];
  diagnostics: ActionDiagnostics | undefined;
  selectedId: number | null;
  showDone: boolean;
  onShowDone: (value: boolean) => void;
  onRefresh: () => void;
  onSelect: (item: ActionCenterItem) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="text-muted-foreground flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
        <span className="truncate tabular-nums">
          {diagnostics?.counts.new ?? 0} new · {diagnostics?.staleNew ?? 0} stale · next{" "}
          {diagnostics?.nextDueAt ? formatWhen(diagnostics.nextDueAt) : "—"}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" title="Refresh" className="hover:bg-muted hover:text-foreground rounded p-1" onClick={onRefresh}>
            <RefreshCw className="size-3.5" />
          </button>
          <Popover>
            <PopoverTrigger className="hover:bg-muted hover:text-foreground rounded p-1" title="Filtri e diagnostica">
              <Filter className="size-3.5" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-3">
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                {(["new", "read", "done", "dismissed"] as const).map((key) => (
                  <div key={key} className="bg-muted rounded-md p-2">
                    <div className="font-semibold">{diagnostics?.counts[key] ?? 0}</div>
                    <div className="text-muted-foreground">{key}</div>
                  </div>
                ))}
              </div>
              {diagnostics?.deferredReasons && Object.keys(diagnostics.deferredReasons).length > 0 && (
                <div className="text-muted-foreground rounded-md border p-2 text-xs">
                  Deferred: {Object.entries(diagnostics.deferredReasons).map(([k, v]) => `${v}× ${k}`).join(", ")}
                </div>
              )}
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={showDone} onChange={(e) => onShowDone(e.currentTarget.checked)} />
                Show done/dismissed
              </label>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {/* the existing items.length === 0 / items.map(...) block, verbatim */}
      </div>
    </div>
  );
}
```

3. Delete the `ChatSidebar` and `ActionCenterPanel` exports (they no longer exist under those names).

- [ ] **Step 3: Rewrite `App.tsx` state model and handlers**

Replace the old `view` + `mobilePanel` states with (full code — this replaces the current state block at the top of `App()`):

```tsx
type Tab = "chat" | "actions" | "more";
type Pane = "chat" | "action" | "usage" | "system";
```

Inside `App()` (keeping `authToken`, `host`, `draft`, `copied`, `showDone`, `attachments`, `uploading`, `dragOver`, `showShortcuts`, refs, `fileApi` as they are; removing `view`, `mobilePanel`):

```tsx
const [tab, setTab] = useState<Tab>("chat");          // sidebar tab (desktop) / bottom-nav tab (mobile)
const [pane, setPane] = useState<Pane>("chat");       // what the desktop content area shows
const [mobileDrill, setMobileDrill] = useState(false); // mobile: list screen (false) vs content screen (true)
const [morePane, setMorePane] = useState<"usage" | "system">("usage");
const [selectedActionId, setSelectedActionId] = useState<number | null>(null);
const isDesktop = useIsDesktop();

const selectedAction =
  host.actionCenter?.items.find((a) => a.id === selectedActionId)
  ?? host.actionCenter?.items[0]
  ?? null;
const newActionCount = host.actionCenter?.diagnostics?.counts.new ?? 0;

// Mobile derives content from the tab stack; desktop from pane.
const shown: Pane = isDesktop
  ? pane
  : tab === "chat" ? "chat"
  : tab === "actions" ? "action"
  : morePane;

const selectChat = (id: string) => {
  host.selectChat(id);
  setPane("chat");
  setMobileDrill(true);
};
const selectAction = (a: ActionCenterItem) => {
  setSelectedActionId(a.id);
  if (a.status === "new") host.markAction(a.id, "read");
  setPane("action");
  setMobileDrill(true);
};
const openUsage = () => { setPane("usage"); setTab("more"); setMorePane("usage"); setMobileDrill(true); };
const openSystem = () => { setPane("system"); setTab("more"); setMorePane("system"); setMobileDrill(true); };
```

`openActionInChat` for now (split comes in Task 3):

```tsx
const openActionInChat = (action: ActionCenterItem) => {
  setSelectedActionId(action.id);
  host.markAction(action.id, "read");
  host.openActionChat(action.id);
  setTab("chat");
  setPane("chat");
  setMobileDrill(true);
};
```

Push-notification handler — replace the body of the `onMsg` mapping (keep the listener wiring):

```tsx
if (typeof p.actionId === "number") {
  setTab("actions");
  setSelectedActionId(p.actionId);
  setPane("action");
  setMobileDrill(true);
} else if (typeof p.chatId === "string") {
  setTab("chat");
  setPane("chat");
  setMobileDrill(true);
  host.selectChat(p.chatId);
}
```

Keyboard shortcuts — in the existing `switch (e.key)`, change `u` and add `a`:

```tsx
case "u": setPane((p) => (p === "usage" ? "chat" : "usage")); e.preventDefault(); break;
case "a": setTab((t) => (t === "actions" ? "chat" : "actions")); e.preventDefault(); break;
```

And extend the `SHORTCUTS` list: `["a", "Sidebar: Chat ⇄ Azioni"],` after the `j / k` row; update the `u` row description to `"Contenuto ⇄ Usage"`.

- [ ] **Step 4: Rewrite the `App.tsx` layout JSX**

Header (replaces the current `<header>`; view-switcher removed; Copy JSON + shortcuts move into a ⋯ popover):

```tsx
<header className="flex items-center justify-between border-b px-4 py-3">
  <h1 className="text-sm font-semibold">Steward</h1>
  <div className="flex items-center gap-3">
    {host.usage && (
      <button
        type="button"
        onClick={openUsage}
        className="text-muted-foreground border-border hover:bg-muted rounded-md border px-2 py-0.5 text-xs tabular-nums transition"
        title={`Ultimo turno: $${host.usage.turnCostUsd.toFixed(4)} · ${host.usage.tokens.total.toLocaleString("it-IT")} token (in ${host.usage.tokens.input.toLocaleString("it-IT")} / out ${host.usage.tokens.output.toLocaleString("it-IT")} / cache ${host.usage.tokens.cacheRead.toLocaleString("it-IT")}) — apri Usage`}
      >
        ${host.usage.costUsd.toFixed(4)}
      </button>
    )}
    <span className="text-muted-foreground text-xs">
      {host.connected ? (host.state === "running" ? "thinking…" : "connected") : "disconnected"}
    </span>
    <Popover>
      <PopoverTrigger className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md px-2 py-1 text-sm" title="Menu">
        ⋯
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 space-y-1 p-1">
        <button
          type="button"
          className="hover:bg-muted w-full rounded px-2 py-1.5 text-left text-sm disabled:opacity-50"
          disabled={host.messages.length === 0}
          onClick={copyJson}
        >
          {copied ? "Copied ✓" : "Copy JSON"}
        </button>
        <button
          type="button"
          className="hover:bg-muted w-full rounded px-2 py-1.5 text-left text-sm"
          onClick={() => setShowShortcuts(true)}
        >
          Scorciatoie ⌨
        </button>
      </PopoverContent>
    </Popover>
  </div>
</header>
```

(Re-add the `Popover, PopoverContent, PopoverTrigger` import to App.tsx.)

Main area (replaces the whole 4-column grid AND the old `view === "usage"/"system"` top-level branch — Usage/System now render inside the content area):

```tsx
<div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
  {/* List layer: unified sidebar (or the "Altro" list on mobile). Hidden on mobile when drilled in. */}
  <aside className={cn("min-h-0 lg:block lg:border-r", mobileDrill ? "hidden" : "block")}>
    {!isDesktop && tab === "more" ? (
      <MoreList onOpen={(p) => { setMorePane(p); setPane(p); setMobileDrill(true); }} />
    ) : (
      <UnifiedSidebar
        tab={tab === "actions" ? "actions" : "chat"}
        onTab={(t) => setTab(t)}
        chats={host.chats}
        activeChatId={host.activeChatId}
        onSelectChat={selectChat}
        onCreateChat={host.createChat}
        onRenameChat={host.renameChat}
        onDeleteChat={host.deleteChat}
        onSaveChat={host.saveChat}
        actions={host.actionCenter?.items ?? []}
        diagnostics={host.actionCenter?.diagnostics}
        selectedActionId={selectedAction?.id ?? null}
        onSelectAction={selectAction}
        showDone={showDone}
        onShowDone={(v) => { setShowDone(v); host.refreshActions(v); }}
        onRefreshActions={() => host.refreshActions(showDone)}
        pane={pane}
        onOpenUsage={openUsage}
        onOpenSystem={openSystem}
      />
    )}
  </aside>

  {/* Content layer. Hidden on mobile until drilled in. */}
  <main className={cn("min-h-0 flex-col lg:flex", mobileDrill ? "flex" : "hidden")}>
    <div className="flex items-center gap-2 border-b px-3 py-2 lg:hidden">
      <button type="button" className="text-muted-foreground text-sm" onClick={() => setMobileDrill(false)}>←</button>
      <span className="truncate text-sm font-medium">
        {tab === "chat" ? (host.chats.find((c) => c.id === host.activeChatId)?.title ?? "Chat")
          : tab === "actions" ? "Azioni"
          : morePane === "usage" ? "Usage" : "System"}
      </span>
    </div>
    {shown === "usage" ? (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <UsagePage httpBase={HTTP_BASE} token={authToken} onUnauthorized={onUnauthorized} />
      </div>
    ) : shown === "system" ? (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SystemPage httpBase={HTTP_BASE} token={authToken} onUnauthorized={onUnauthorized} />
      </div>
    ) : shown === "action" ? (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto w-full max-w-3xl">
          <ActionDetail
            action={selectedAction}
            onOpenChat={openActionInChat}
            onMark={(status) => selectedAction && host.markAction(selectedAction.id, status)}
            onExecute={(proposalId) => selectedAction && host.executeProposal(selectedAction.id, proposalId)}
            onRevise={(proposalId, instruction) => selectedAction && host.reviseProposal(selectedAction.id, proposalId, instruction)}
          />
        </div>
      </div>
    ) : (
      chatPane  /* see below — the existing thread + composer JSX, held in a local variable */
    )}
  </main>
</div>

{/* Bottom nav (mobile only) */}
<nav className="flex border-t lg:hidden">
  {([["chat", "💬 Chat"], ["actions", "⚡ Azioni"], ["more", "⚙ Altro"]] as const).map(([t, label]) => (
    <button
      key={t}
      type="button"
      onClick={() => { setTab(t); setMobileDrill(false); }}
      className={cn(
        "relative flex-1 py-2.5 text-center text-xs transition",
        tab === t ? "text-foreground font-medium" : "text-muted-foreground",
      )}
    >
      {label}
      {t === "actions" && newActionCount > 0 && (
        <span className="bg-primary text-primary-foreground absolute -mt-1 ml-0.5 rounded-full px-1 text-[9px] font-semibold tabular-nums">
          {newActionCount}
        </span>
      )}
    </button>
  ))}
</nav>
```

**chatPane**: not a component — define `const chatPane = (<> …thread + composer JSX… </>)` just above `App()`'s `return`, holding the existing messages block (`<div ref={scrollRef} …>`) and composer `<form onSubmit={submit} …>` unchanged except two wrapper additions for reading width (a plain variable avoids remounting/focus loss and keeps `scrollRef` handling identical):

- messages scroller: `<div ref={scrollRef} className="flex-1 overflow-y-auto p-4"><div className="mx-auto w-full max-w-[52rem] space-y-3"> …existing messages/approvals/questions/thinking… </div></div>` (the `space-y-3` moves from the scroller onto the inner wrapper);
- composer: inside the existing `<form>`, wrap the attachments block + input row in `<div className="mx-auto w-full max-w-[52rem]">…</div>`.

**MoreList** — new small component at the bottom of App.tsx:

```tsx
function MoreList({ onOpen }: { onOpen: (pane: "usage" | "system") => void }) {
  return (
    <div className="p-2">
      {([["usage", "📊 Usage"], ["system", "⚙ System"]] as const).map(([p, label]) => (
        <button
          key={p}
          type="button"
          onClick={() => onOpen(p)}
          className="hover:bg-muted block w-full rounded-lg p-3 text-left text-sm font-medium"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
```

Remove the now-dead pieces: the header view-switcher, the standalone Copy JSON / ⌨ header buttons, the old `view === "usage"/"system"` branch, both old `<aside>` columns, the old `mobilePanel`-based nav, and the `ChatSidebar`/`ActionCenterPanel` imports. `UsagePage`/`SystemPage` imports stay. Add imports: `UnifiedSidebar` from `@/components/sidebar`, `useIsDesktop` from `@/lib/use-is-desktop`.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck -w @steward/web && npm run lint -w @steward/web`
Expected: exit 0 (watch for unused imports the rewrite leaves behind).

- [ ] **Step 6: Quick smoke in dev**

Run: `npm run dev -w @steward/web` and open the printed localhost URL.
Check (desktop width): sidebar tabs switch Chat/Azioni; selecting a chat/action fills the content area; Usage/System open from the footer; header ⋯ menu shows Copy JSON + Scorciatoie; `a` and `u` shortcuts work. Narrow the window below 1024px: bottom nav shows 3 tabs; each tab shows its list; tapping an item drills in; ← goes back. Stop the server.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): unified-inbox layout — single sidebar with Chat/Azioni tabs, wide content area, mobile stacks

Replaces the 4-column grid with sidebar+content. Action Center diagnostics
compress into a summary row + filter popover; Usage/System move into the
sidebar footer (desktop) and an Altro tab (mobile); header slims down to
cost/status + overflow menu.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Contextual chat | action-detail split

**Files:**
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 2's state model and `ActionDetail`.
- Produces: `splitActionId: number | null` state; no new exports.

- [ ] **Step 1: Add split state and wire `openActionInChat`**

```tsx
const [splitActionId, setSplitActionId] = useState<number | null>(null);
const splitAction = host.actionCenter?.items.find((a) => a.id === splitActionId) ?? null;
```

In `openActionInChat`, add `setSplitActionId(action.id);` after `host.openActionChat(action.id);`. Opening a *different* action's chat replaces the split; nothing else sets it.

- [ ] **Step 2: Render the split**

In the content area, replace the plain `chatPane` branch with:

```tsx
) : splitAction && isDesktop ? (
  <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_400px]">
    <div className="flex min-h-0 flex-col">
      {chatPane}
    </div>
    <aside className="min-h-0 overflow-y-auto border-l p-4">
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          title="Chiudi pannello azione"
          className="text-muted-foreground hover:text-foreground rounded p-1 text-sm"
          onClick={() => setSplitActionId(null)}
        >
          ✕
        </button>
      </div>
      <ActionDetail
        action={splitAction}
        onOpenChat={openActionInChat}
        onMark={(status) => host.markAction(splitAction.id, status)}
        onExecute={(proposalId) => host.executeProposal(splitAction.id, proposalId)}
        onRevise={(proposalId, instruction) => host.reviseProposal(splitAction.id, proposalId, instruction)}
      />
    </aside>
  </div>
) : (
  chatPane
)
```

`chatPane` is the local variable Task 2 already defined — both branches reuse it, so the thread + composer JSX exists once.

On mobile (`!isDesktop`) the split never renders — `openActionInChat` already lands on the chat stack, and the action stays reachable from the ⚡ tab.

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck -w @steward/web && npm run lint -w @steward/web`
Expected: exit 0.

- [ ] **Step 4: Smoke test**

Run: `npm run dev -w @steward/web`. Desktop: select an action → "Open in chat" → content shows chat + 400px detail pane; ✕ closes it; sending messages in the temp chat works. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): contextual chat|action split when opening an action in chat

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Full verification pass

**Files:**
- Modify: only what the walkthrough flags.

**Interfaces:** none.

- [ ] **Step 1: Build**

Run: `npm run build -w @steward/web`
Expected: exit 0 (tsc -b + vite build, PWA assets generated).

- [ ] **Step 2: Visual walkthrough**

Run: `npm run dev -w @steward/web`. With the host running (`apps/host`), verify against the spec's §8 checklist:

Desktop (≥1024px):
- Chat flow: create/select/rename/delete/save chats from the Chat tab; thread centered at reading width; composer drag&drop + attachments; Esc stops generation; `/`, `c`, `j`/`k`, `u`, `a`, `?` shortcuts.
- Action flow: Azioni tab badge count; summary row numbers; filter popover (counters, deferred, show-done toggles the list, refresh); selecting an action renders the detail at reading width (badges, deadline, Related mail accordion, proposals with revise-popover, context snapshot).
- Split: "Open in chat" → split; ✕ closes; temp chat appears with dashed border in the Chat tab.
- Usage/System from the sidebar footer; cost pill → Usage; ⋯ menu Copy JSON + Scorciatoie.

Mobile (device-mode viewport <1024px):
- Three tabs; per-tab list → drill-in → ← back; Azioni badge; Altro → Usage/System.
- "Open in chat" lands on the chat stack (no split).
- Push mapping: if a push can be triggered, tapping lands on the action detail (Azioni stack) or chat; otherwise verify by re-reading the `onMsg` handler wiring.
- Pairing screen still renders when no token (open a private window on the phone/host URL, or temporarily clear the token).

- [ ] **Step 3: Fix anything the walkthrough flags** (each fix: edit → typecheck → re-check in the browser).

- [ ] **Step 4: Final commit (if fixes were made)**

```bash
git add apps/web/src
git commit -m "fix(web): polish from inbox-layout verification pass

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
