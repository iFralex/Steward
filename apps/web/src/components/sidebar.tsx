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

export function ChatSidebar({
  chats,
  activeChatId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onSave,
}: {
  chats: ChatSummary[];
  activeChatId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onSave: (id: string) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b p-3">
        <h2 className="text-sm font-semibold">Chat</h2>
        <Button size="sm" onClick={onCreate} title="Nuova chat">+ Nuova</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {chats.length === 0 ? (
          <p className="text-muted-foreground p-3 text-xs">Nessuna chat.</p>
        ) : (
          chats.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group hover:bg-muted relative rounded-lg p-2.5 transition",
                activeChatId === c.id && "bg-muted",
                c.temporary && "border-primary/30 border border-dashed",
              )}
            >
              <button type="button" onClick={() => onSelect(c.id)} className="block w-full text-left">
                <div className="flex items-center gap-1.5 pr-10">
                  {c.temporary && <span className="bg-primary/15 text-primary rounded px-1 py-px text-[10px] font-medium uppercase">temp</span>}
                  <span className="truncate text-sm font-medium">{c.title}</span>
                </div>
                <div className="text-muted-foreground mt-0.5 text-xs">
                  {c.messageCount} {c.messageCount === 1 ? "messaggio" : "messaggi"} · {formatWhen(Math.floor(c.updatedAt / 1000))}
                </div>
              </button>
              <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition group-hover:opacity-100">
                {c.temporary && (
                  <button
                    type="button"
                    title="Salva questa chat (rendila permanente)"
                    className="hover:bg-background text-muted-foreground hover:text-primary rounded p-1 text-xs"
                    onClick={() => onSave(c.id)}
                  >
                    💾
                  </button>
                )}
                <button
                  type="button"
                  title="Rinomina"
                  className="hover:bg-background text-muted-foreground rounded p-1 text-xs"
                  onClick={() => {
                    const title = window.prompt("Rinomina chat", c.title);
                    if (title != null) onRename(c.id, title);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  title="Elimina"
                  className="hover:bg-background text-muted-foreground hover:text-destructive rounded p-1 text-xs"
                  onClick={() => {
                    if (window.confirm(`Eliminare la chat "${c.title}"? L'azione è irreversibile.`)) onDelete(c.id);
                  }}
                >
                  🗑
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function ActionCenterPanel({
  items,
  diagnostics,
  selectedId,
  showDone,
  onShowDone,
  onRefresh,
  onSelect,
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
    <div className="flex h-full flex-col">
      <div className="space-y-3 border-b p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Action Center</h2>
            <p className="text-muted-foreground text-xs">Mail, scadenze e promemoria actionable.</p>
          </div>
          <Button size="sm" variant="outline" onClick={onRefresh}>Refresh</Button>
        </div>
        <div className="grid grid-cols-4 gap-2 text-center text-xs">
          {(["new", "read", "done", "dismissed"] as const).map((key) => (
            <div key={key} className="bg-muted rounded-md p-2">
              <div className="font-semibold">{diagnostics?.counts[key] ?? 0}</div>
              <div className="text-muted-foreground">{key}</div>
            </div>
          ))}
        </div>
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>Stale: {diagnostics?.staleNew ?? 0}</span>
          <span>Next due: {diagnostics?.nextDueAt ? formatWhen(diagnostics.nextDueAt) : "—"}</span>
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
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="text-muted-foreground p-3 text-sm">Nessuna action.</p>
        ) : items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item)}
            className={cn(
              "hover:bg-muted w-full rounded-lg p-3 text-left transition",
              selectedId === item.id && "bg-muted",
            )}
          >
            <div className="flex items-center gap-2">
              <Badge variant={priorityVariant(item.priority)}>{item.priority}</Badge>
              <Badge variant="outline">{item.kind}</Badge>
              <span className="text-muted-foreground ml-auto text-xs">{item.dueAt ? formatWhen(item.dueAt) : ""}</span>
            </div>
            <div className="mt-2 line-clamp-2 text-sm font-medium">{item.title}</div>
            <div className="text-muted-foreground mt-1 line-clamp-2 text-xs">{item.summary}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
