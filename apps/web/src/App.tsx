import { useEffect, useRef, useState, type FormEvent } from "react";
import { useHostSocket } from "@/lib/host-socket";
import { ApprovalCard } from "@/components/approval-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ActionCenterItem } from "@llm-wiki/protocol";

const HOST_URL = import.meta.env.VITE_HOST_URL ?? "ws://127.0.0.1:4317";

function summarizeInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 140 ? `${s.slice(0, 140)}…` : s;
  } catch {
    return String(input);
  }
}

function App() {
  const host = useHostSocket(HOST_URL);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [selectedActionId, setSelectedActionId] = useState<number | null>(null);
  const [showDone, setShowDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedAction =
    host.actionCenter?.items.find((a) => a.id === selectedActionId)
    ?? host.actionCenter?.items[0]
    ?? null;

  const copyJson = async () => {
    const json = JSON.stringify(
      { messages: host.messages.map(({ role, text }) => ({ role, text })) },
      null,
      2,
    );
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [host.messages, host.approvals]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    host.sendMessage(draft);
    setDraft("");
  };

  const openActionInChat = (action: ActionCenterItem) => {
    setSelectedActionId(action.id);
    host.markAction(action.id, "read");
    host.sendMessage(`Apri l'action-center item ${action.id}. Leggilo con read_action, riassumimi il contesto e aiutami a decidere cosa fare.`);
  };

  return (
    <div className="bg-background text-foreground flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h1 className="text-sm font-semibold">Personal Agent</h1>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs">
            {host.connected ? (host.state === "running" ? "thinking…" : "connected") : "disconnected"}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={copyJson}
            disabled={host.messages.length === 0}
          >
            {copied ? "Copied" : "Copy JSON"}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)_minmax(360px,0.9fr)]">
        <aside className="min-h-0 border-r">
          <ActionCenterPanel
            items={host.actionCenter?.items ?? []}
            diagnostics={host.actionCenter?.diagnostics}
            selectedId={selectedAction?.id ?? null}
            showDone={showDone}
            onShowDone={(v) => {
              setShowDone(v);
              host.refreshActions(v);
            }}
            onRefresh={() => host.refreshActions(showDone)}
            onSelect={(a) => {
              setSelectedActionId(a.id);
              if (a.status === "new") host.markAction(a.id, "read");
            }}
          />
        </aside>

        <main className="flex min-h-0 flex-col">
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
            {host.messages.map((m) =>
              m.role === "tool" ? (
                <div key={m.id} className="text-muted-foreground flex items-center gap-2 text-xs">
                  <span className="bg-muted shrink-0 rounded px-1.5 py-0.5 font-mono">🔧 {m.text}</span>
                  {m.toolInput != null && (
                    <span className="truncate font-mono opacity-70">{summarizeInput(m.toolInput)}</span>
                  )}
                </div>
              ) : (
                <div key={m.id} className={m.role === "user" ? "text-right" : "text-left"}>
                  <div
                    className={cn(
                      "inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                      m.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground",
                    )}
                  >
                    {m.text || (m.open ? "…" : "")}
                  </div>
                </div>
              ),
            )}
            {host.approvals.map((a) => (
              <ApprovalCard key={a.requestId} approval={a} onDecision={host.respondApproval} />
            ))}
          </div>

          <form onSubmit={submit} className="flex gap-2 border-t p-3">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Message your agent…"
            />
            <Button type="submit" disabled={!host.connected}>
              Send
            </Button>
          </form>
        </main>

        <aside className="min-h-0 overflow-y-auto border-l p-4">
          <ActionDetail
            action={selectedAction}
            onOpenChat={openActionInChat}
            onMark={(status) => selectedAction && host.markAction(selectedAction.id, status)}
            onExecute={(proposalId) => selectedAction && host.executeProposal(selectedAction.id, proposalId)}
          />
        </aside>
      </div>
    </div>
  );
}

export default App;

function ActionCenterPanel({
  items,
  diagnostics,
  selectedId,
  showDone,
  onShowDone,
  onRefresh,
  onSelect,
}: {
  items: ActionCenterItem[];
  diagnostics: NonNullable<ReturnType<typeof useHostSocket>["actionCenter"]>["diagnostics"] | undefined;
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

function ActionDetail({
  action,
  onOpenChat,
  onMark,
  onExecute,
}: {
  action: ActionCenterItem | null;
  onOpenChat: (action: ActionCenterItem) => void;
  onMark: (status: "new" | "read" | "done" | "dismissed") => void;
  onExecute: (proposalId: string) => void;
}) {
  if (!action) return <p className="text-muted-foreground text-sm">Seleziona una action.</p>;
  const proposals = Array.isArray(action.payload.proposedActions) ? action.payload.proposedActions as ProposedActionView[] : [];
  const deadline = readDeadline(action);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Badge variant={priorityVariant(action.priority)}>{action.priority}</Badge>
          <Badge variant="outline">{action.status}</Badge>
          <Badge variant="outline">{action.kind}</Badge>
        </div>
        <h2 className="text-lg font-semibold">{action.title}</h2>
        <p className="text-muted-foreground text-sm">{action.summary}</p>
        <p className="text-muted-foreground text-xs">
          Updated {formatWhen(action.updatedAt)} · Due {action.dueAt ? formatWhen(action.dueAt) : "—"}
        </p>
        <div className="rounded-md border p-2 text-sm">
          <span className="font-medium">Deadline: </span>
          <span>{deadline.label}</span>
          {deadline.estimated && <span className="text-muted-foreground"> · estimated</span>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onOpenChat(action)}>Open in chat</Button>
        <Button size="sm" variant="outline" onClick={() => onMark("done")}>Done</Button>
        <Button size="sm" variant="outline" onClick={() => onMark("dismissed")}>Dismiss</Button>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Proposed actions</h3>
        {proposals.length === 0 ? <p className="text-muted-foreground text-sm">Nessuna proposta salvata.</p> : proposals.map((proposal) => (
          <Card key={proposal.id} size="sm">
            <CardHeader>
              <CardTitle>{proposal.label ?? proposal.id}</CardTitle>
              <CardDescription>{proposal.summary}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ol className="text-muted-foreground list-inside list-decimal space-y-1 text-xs">
                {(proposal.steps ?? []).map((step) => (
                  <li key={step.id}>
                    <span className="font-mono">{step.tool}</span> — {step.label}
                  </li>
                ))}
              </ol>
              <Button size="sm" onClick={() => onExecute(proposal.id)}>Execute proposal</Button>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card size="sm">
        <CardHeader>
          <CardTitle>Context</CardTitle>
          <CardDescription>Snapshot salvato dall’Action Center.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted max-h-72 overflow-auto rounded-md p-2 text-xs">
            {JSON.stringify(action.payload.contextSnapshot ?? action.payload, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

function readDeadline(action: ActionCenterItem): { label: string; estimated: boolean } {
  const raw = action.payload.deadline;
  if (raw && typeof raw === "object") {
    const d = raw as Record<string, unknown>;
    const dueAt = typeof d.dueAt === "number" ? d.dueAt : null;
    const iso = typeof d.iso === "string" ? d.iso : null;
    const estimated = d.estimated !== false;
    if (dueAt) return { label: formatWhen(dueAt), estimated };
    if (iso && Number.isFinite(Date.parse(iso))) {
      return { label: formatWhen(Math.floor(Date.parse(iso) / 1000)), estimated };
    }
  }
  return action.dueAt ? { label: formatWhen(action.dueAt), estimated: true } : { label: "None", estimated: false };
}

interface ProposedActionView {
  id: string;
  label?: string;
  summary?: string;
  steps?: { id: string; label?: string; tool: string }[];
}

function priorityVariant(priority: ActionCenterItem["priority"]): "default" | "secondary" | "destructive" | "outline" {
  if (priority === "high") return "destructive";
  if (priority === "low") return "secondary";
  return "default";
}

function formatWhen(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("it-IT", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
