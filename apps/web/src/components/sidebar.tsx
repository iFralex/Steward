/**
 * Unified sidebar: a single Chat/Azioni tab switcher over the chat list and
 * the Action Center list, plus a footer nav to Usage/System (desktop). Task 2
 * of the inbox-layout plan collapses the old two standalone sidebar panels
 * (ChatSidebar, ActionCenterPanel) into this.
 */
import { BarChart3, Filter, RefreshCw, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatWhen, priorityVariant } from "@/lib/format";
import type { useHostSocket } from "@/lib/host-socket";
import type { ActionCenterItem, ChatSummary } from "@steward/protocol";

export type ActionDiagnostics = NonNullable<ReturnType<typeof useHostSocket>["actionCenter"]>["diagnostics"];

export type SidebarTab = "chat" | "actions";

export function UnifiedSidebar({
  tab, onTab,
  chats, activeChatId, onSelectChat, onCreateChat, onRenameChat, onDeleteChat, onSaveChat,
  actions, diagnostics, selectedActionId, onSelectAction, showDone, onShowDone, onRefreshActions,
  pane, onOpenUsage, onOpenSystem,
}: {
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
}) {
  const { t } = useTranslation();
  const newCount = diagnostics?.counts.new ?? 0;
  return (
    <div className="flex h-full flex-col">
      {/* Tabs: desktop only — on mobile the bottom nav selects the tab. */}
      <div className="hidden grid-cols-2 gap-1 border-b p-2 lg:grid">
        <TabButton active={tab === "chat"} onClick={() => onTab("chat")}>{t("sidebar.tabs.chat")}</TabButton>
        <TabButton active={tab === "actions"} onClick={() => onTab("actions")}>
          {t("sidebar.tabs.actions")}
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
        <FooterButton icon={<BarChart3 className="size-4" />} label={t("sidebar.footer.usage")} active={pane === "usage"} onClick={onOpenUsage} />
        <FooterButton icon={<Settings className="size-4" />} label={t("sidebar.footer.system")} active={pane === "system"} onClick={onOpenSystem} />
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

function ChatList({
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
  const { t } = useTranslation();
  const titleOf = (c: ChatSummary) => c.title || t("sidebar.chatList.untitled");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end border-b p-2">
        <Button size="sm" onClick={onCreate} title={t("sidebar.chatList.newTitle")}>{t("sidebar.chatList.new")}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {chats.length === 0 ? (
          <p className="text-muted-foreground p-3 text-xs">{t("sidebar.chatList.empty")}</p>
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
                  {c.temporary && <span className="bg-primary/15 text-primary rounded px-1 py-px text-[10px] font-medium uppercase">{t("sidebar.chatList.temp")}</span>}
                  <span className="truncate text-sm font-medium">{titleOf(c)}</span>
                </div>
                <div className="text-muted-foreground mt-0.5 text-xs">
                  {t("sidebar.chatList.messageCount", { count: c.messageCount })} · {formatWhen(Math.floor(c.updatedAt / 1000))}
                </div>
              </button>
              {/* Always visible on touch screens (no hover there); desktop keeps the hover reveal. */}
              <div className="absolute right-1.5 top-1.5 flex gap-0.5 transition lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
                {c.temporary && (
                  <button
                    type="button"
                    title={t("sidebar.chatList.saveTitle")}
                    aria-label={t("sidebar.chatList.saveAria", { title: titleOf(c) })}
                    className="hover:bg-background text-muted-foreground hover:text-primary rounded p-1.5 text-xs"
                    onClick={() => onSave(c.id)}
                  >
                    <span aria-hidden>💾</span>
                  </button>
                )}
                <button
                  type="button"
                  title={t("sidebar.chatList.renameTitle")}
                  aria-label={t("sidebar.chatList.renameAria", { title: titleOf(c) })}
                  className="hover:bg-background text-muted-foreground rounded p-1.5 text-xs"
                  onClick={() => {
                    const title = window.prompt(t("sidebar.chatList.renamePrompt"), c.title);
                    if (title != null) onRename(c.id, title);
                  }}
                >
                  <span aria-hidden>✎</span>
                </button>
                <button
                  type="button"
                  title={t("sidebar.chatList.deleteTitle")}
                  aria-label={t("sidebar.chatList.deleteAria", { title: titleOf(c) })}
                  className="hover:bg-background text-muted-foreground hover:text-destructive rounded p-1.5 text-xs"
                  onClick={() => {
                    if (window.confirm(t("sidebar.chatList.deleteConfirm", { title: titleOf(c) }))) onDelete(c.id);
                  }}
                >
                  <span aria-hidden>🗑</span>
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

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
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="text-muted-foreground flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
        <span className="truncate tabular-nums">
          {t("sidebar.actionList.diagnostics", {
            new: diagnostics?.counts.new ?? 0,
            stale: diagnostics?.staleNew ?? 0,
            next: diagnostics?.nextDueAt ? formatWhen(diagnostics.nextDueAt) : "—",
          })}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" title={t("sidebar.actionList.refreshTitle")} className="hover:bg-muted hover:text-foreground rounded p-1" onClick={onRefresh}>
            <RefreshCw className="size-3.5" />
          </button>
          <Popover>
            <PopoverTrigger className="hover:bg-muted hover:text-foreground rounded p-1" title={t("sidebar.actionList.filtersTitle")}>
              <Filter className="size-3.5" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-3">
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                {(["new", "read", "done", "dismissed"] as const).map((key) => (
                  <div key={key} className="bg-muted rounded-md p-2">
                    <div className="font-semibold">{diagnostics?.counts[key] ?? 0}</div>
                    <div className="text-muted-foreground">{t(`sidebar.actionList.status.${key}`)}</div>
                  </div>
                ))}
              </div>
              {diagnostics?.deferredReasons && Object.keys(diagnostics.deferredReasons).length > 0 && (
                <div className="text-muted-foreground rounded-md border p-2 text-xs">
                  {t("sidebar.actionList.deferred", {
                    list: Object.entries(diagnostics.deferredReasons).map(([k, v]) => `${v}× ${k}`).join(", "),
                  })}
                </div>
              )}
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={showDone} onChange={(e) => onShowDone(e.currentTarget.checked)} />
                {t("sidebar.actionList.showDone")}
              </label>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="text-muted-foreground p-3 text-sm">{t("sidebar.actionList.empty")}</p>
        ) : items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item)}
            className={cn(
              "hover:bg-muted block w-full rounded-lg p-3 text-left transition",
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
