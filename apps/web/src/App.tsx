import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useHostSocket } from "@/lib/host-socket";
import { ApprovalCard } from "@/components/approval-card";
import { QuestionCard } from "@/components/question-card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ToolCard } from "@/components/tool-card";
import { CardView, type FileApi } from "@/components/cards";
import type { ActionCenterItem } from "@llm-wiki/protocol";

const HOST_URL = import.meta.env.VITE_HOST_URL ?? "ws://127.0.0.1:4317";

function App() {
  const host = useHostSocket(HOST_URL);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [selectedActionId, setSelectedActionId] = useState<number | null>(null);
  const [showDone, setShowDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileApi: FileApi = { open: host.openFile, reveal: host.revealFile, resolve: host.resolveFile };
  const selectedAction =
    host.actionCenter?.items.find((a) => a.id === selectedActionId)
    ?? host.actionCenter?.items[0]
    ?? null;

  const copyJson = async () => {
    const json = JSON.stringify(
      {
        messages: host.messages.map((m) =>
          m.role === "tool"
            ? {
                role: "tool",
                tool: m.text,
                input: m.toolInput,
                output: m.toolOutput,
                durationMs: m.toolDurationMs,
                status: m.toolStatus,
                ...(m.toolError ? { error: m.toolError } : {}),
              }
            : { role: m.role, text: m.text },
        ),
      },
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
  }, [host.messages, host.approvals, host.questions]);

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
                <ToolCard key={m.id} m={m} fileApi={fileApi} />
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
                    {m.role === "assistant" ? (
                      m.text ? <MarkdownMessage text={m.text} fileApi={fileApi} /> : (m.open ? "…" : "")
                    ) : (
                      m.text || (m.open ? "…" : "")
                    )}
                  </div>
                </div>
              ),
            )}
            {host.approvals.map((a) => (
              <ApprovalCard key={a.requestId} approval={a} onDecision={host.respondApproval} fileApi={fileApi} />
            ))}
            {host.questions.map((q) => (
              <QuestionCard key={q.requestId} question={q} onRespond={host.respondQuestion} />
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
            onRevise={(proposalId, instruction) => selectedAction && host.reviseProposal(selectedAction.id, proposalId, instruction)}
          />
        </aside>
      </div>
    </div>
  );
}

export default App;

function MarkdownMessage({ text, fileApi }: { text: string; fileApi: FileApi }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="mb-3 mt-1 text-xl font-semibold leading-tight first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2.5 mt-4 text-lg font-semibold leading-snug first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold leading-snug first:mt-0">{children}</h3>,
        h4: ({ children }) => <h4 className="mb-1.5 mt-3 text-sm font-semibold leading-snug first:mt-0">{children}</h4>,
        h5: ({ children }) => <h5 className="mb-1.5 mt-2 text-sm font-medium leading-snug first:mt-0">{children}</h5>,
        h6: ({ children }) => <h6 className="text-muted-foreground mb-1.5 mt-2 text-xs font-semibold uppercase tracking-wide first:mt-0">{children}</h6>,
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li>{children}</li>,
        hr: () => <hr className="border-border my-3" />,
        blockquote: ({ children }) => (
          <blockquote className="border-border text-muted-foreground my-2 border-l-2 pl-3 italic">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-background/60">{children}</thead>,
        th: ({ children }) => <th className="border-border border px-2 py-1.5 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border-border border px-2 py-1.5 align-top">{children}</td>,
        code: ({ className, children }) => {
          if (className === "language-card") {
            try {
              const obj = JSON.parse(String(children).trim()) as { type?: unknown } & Record<string, unknown>;
              const { type, ...data } = obj;
              if (type) return <CardView type={String(type)} data={data} fileApi={fileApi} />;
            } catch { /* not valid card JSON → render as a normal code block */ }
          }
          return <code className="bg-background/70 rounded px-1 py-0.5 font-mono text-[0.85em]">{children}</code>;
        },
        pre: ({ children }) => {
          const child = Array.isArray(children) ? children[0] : children;
          const cls = (child as { props?: { className?: string } } | undefined)?.props?.className;
          if (cls === "language-card") return <>{children}</>; // the card replaces the code block; no <pre> wrapper
          return <pre className="bg-background/70 mb-2 overflow-auto rounded-md p-2 text-xs last:mb-0">{children}</pre>;
        },
        a: ({ children, href }) => (
          <a className="text-primary underline underline-offset-2" href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

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
  onRevise,
}: {
  action: ActionCenterItem | null;
  onOpenChat: (action: ActionCenterItem) => void;
  onMark: (status: "new" | "read" | "done" | "dismissed") => void;
  onExecute: (proposalId: string) => void;
  onRevise: (proposalId: string, instruction: string) => void;
}) {
  if (!action) return <p className="text-muted-foreground text-sm">Seleziona una action.</p>;
  const proposals = Array.isArray(action.payload.proposedActions) ? action.payload.proposedActions as ProposedActionView[] : [];
  const deadline = readDeadline(action);
  const mailGroups = collectRelatedMailGroups(action);
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
      {mailGroups.length > 0 && (
        <Card size="sm" className="overflow-hidden">
          <CardContent className="p-0">
            <Accordion>
              <AccordionItem value="related-mail" className="border-0">
                <AccordionTrigger className="px-4 py-3 no-underline hover:no-underline">
                  <div className="text-left">
                    <div className="text-sm font-semibold">Related mail</div>
                    <div className="text-muted-foreground text-xs">
                      {mailGroups.length} {mailGroups.length === 1 ? "contesto" : "contesti"} deduplicati
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4">
                  <div className="space-y-4 border-t pt-4">
                    {mailGroups.map((group) => (
                      <div key={group.key} className="space-y-2 rounded-lg border p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">{group.kind}</Badge>
                              <span className="truncate text-sm font-medium">{group.title}</span>
                            </div>
                            <div className="text-muted-foreground mt-1 text-xs">
                              {[group.countLabel, group.dateLabel].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                          <Button className="shrink-0" size="sm" variant="outline" onClick={() => { window.location.href = group.url; }}>
                            {group.kind === "Main thread" ? "Open representative mail" : "Open in Mail"}
                          </Button>
                        </div>
                        {group.description && <p className="text-muted-foreground text-xs leading-relaxed">{group.description}</p>}
                        {group.snippet && (
                          <p className="bg-muted rounded-md p-2 text-xs leading-relaxed">
                            {group.snippet}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      )}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Proposed actions</h3>
        {proposals.length === 0 ? <p className="text-muted-foreground text-sm">Nessuna proposta salvata.</p> : proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            actionUpdatedAt={action.updatedAt}
            revisionCount={Array.isArray(action.payload.proposalRevisions) ? action.payload.proposalRevisions.length : 0}
            onExecute={onExecute}
            onRevise={onRevise}
          />
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

function ProposalCard({
  proposal,
  actionUpdatedAt,
  revisionCount,
  onExecute,
  onRevise,
}: {
  proposal: ProposedActionView;
  actionUpdatedAt: number;
  revisionCount: number;
  onExecute: (proposalId: string) => void;
  onRevise: (proposalId: string, instruction: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [pendingRevision, setPendingRevision] = useState<{ revisionCount: number; updatedAt: number } | null>(null);
  const canRevise = instruction.trim().length > 0;
  const closeAndClear = () => {
    setOpen(false);
    setInstruction("");
    setPendingRevision(null);
  };
  useEffect(() => {
    if (!pendingRevision) return;
    if (revisionCount !== pendingRevision.revisionCount || actionUpdatedAt !== pendingRevision.updatedAt) {
      closeAndClear();
    }
  }, [actionUpdatedAt, pendingRevision, revisionCount]);
  return (
    <Card size="sm">
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
        <div className="flex flex-wrap gap-2">
          <Popover
            open={open}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) closeAndClear();
              else setOpen(true);
            }}
          >
            <PopoverTrigger className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
              Revise proposal
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-80">
              <PopoverHeader>
                <PopoverTitle>Revise this proposal</PopoverTitle>
                <PopoverDescription>
                  Describe only how this saved proposal should change.
                </PopoverDescription>
              </PopoverHeader>
              <textarea
                className="border-input bg-muted h-24 w-full resize-y rounded-md border p-2 text-xs outline-none"
                placeholder="Es. “usa ferie e scusati per il ritardo”"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                disabled={pendingRevision != null}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={closeAndClear} disabled={pendingRevision != null}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!canRevise || pendingRevision != null}
                  onClick={() => {
                    setPendingRevision({ revisionCount, updatedAt: actionUpdatedAt });
                    onRevise(proposal.id, instruction);
                  }}
                >
                  {pendingRevision ? "Updating…" : "Confirm revision"}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Button size="sm" onClick={() => onExecute(proposal.id)}>Execute proposal</Button>
        </div>
      </CardContent>
    </Card>
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
  steps?: { id: string; label?: string; tool: string; input?: Record<string, unknown> }[];
}

interface RelatedMailGroup {
  key: string;
  kind: "Main thread" | "Related fact" | "Referenced mail";
  url: string;
  title: string;
  description?: string;
  snippet?: string;
  countLabel?: string;
  dateLabel?: string;
  date?: string;
}

function collectRelatedMailGroups(action: ActionCenterItem): RelatedMailGroup[] {
  const groups = new Map<string, RelatedMailGroup>();
  const actionThreadId = typeof action.payload.threadId === "number" ? action.payload.threadId : null;
  const context = action.payload.contextSnapshot as Record<string, unknown> | undefined;
  const mail = context?.mail as Record<string, unknown> | undefined;
  const relatedFacts = Array.isArray(mail?.relatedMailFacts) ? mail.relatedMailFacts as Record<string, unknown>[] : [];

  const addGroup = (group: RelatedMailGroup) => {
    const existing = groups.get(group.key);
    if (!existing) {
      groups.set(group.key, group);
      return;
    }
    groups.set(group.key, {
      ...existing,
      title: preferTitle(existing.title, group.title),
      description: existing.description ?? group.description,
      snippet: existing.snippet ?? group.snippet,
      date: maxDate(existing.date, group.date),
      dateLabel: formatDateLabel(maxDate(existing.date, group.date)),
      countLabel: existing.countLabel ?? group.countLabel,
      url: existing.kind === "Main thread" ? existing.url : group.url,
    });
  };

  for (const fact of relatedFacts) {
    const normalized = normalizeMailUrl(typeof fact.mailUrl === "string" ? fact.mailUrl : "");
    if (!normalized) continue;
    const threadId = typeof fact.threadId === "number" ? fact.threadId : normalized.key;
    const date = typeof fact.date === "string" ? fact.date : undefined;
    addGroup({
      key: `fact:${threadId}`,
      kind: "Related fact",
      url: normalized.url,
      title: typeof fact.subject === "string" ? cleanSubject(fact.subject) : "Related mail",
      description: typeof fact.meaning === "string"
        ? fact.meaning.replace(/^Alessio already told the recipient/i, "Alessio ha già comunicato a Giulia")
        : "Informazione correlata trovata in un altro thread.",
      snippet: typeof fact.snippet === "string" ? fact.snippet.slice(0, 240) : undefined,
      date,
      dateLabel: formatDateLabel(date),
    });
  }

  const mainThreadRecords = extractMainThreadRecords(action);
  if (mainThreadRecords.length > 0) {
    const latest = [...mainThreadRecords].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))[0];
    const representativeUrl = typeof action.payload.messageId === "string"
      ? mailUrlFromMessageId(action.payload.messageId)
      : normalizeMailUrl(String(latest.mailUrl ?? ""))?.url;
    if (representativeUrl) {
      const date = typeof latest.date === "string" ? latest.date : undefined;
      addGroup({
        key: `thread:${actionThreadId ?? "main"}`,
        kind: "Main thread",
        url: representativeUrl,
        title: cleanSubject(String(action.payload.subject ?? latest.subject ?? "Thread principale")),
        description: "Thread da cui nasce questa action.",
        countLabel: `${mainThreadRecords.length} email`,
        date,
        dateLabel: formatDateLabel(date),
      });
    }
  } else if (typeof action.payload.messageId === "string") {
    const date = typeof action.payload.date === "number" ? new Date(action.payload.date * 1000).toISOString() : undefined;
    addGroup({
      key: `mail:${action.payload.messageId}`,
      kind: "Referenced mail",
      url: mailUrlFromMessageId(action.payload.messageId),
      title: cleanSubject(String(action.payload.subject ?? shortMessageId(action.payload.messageId))),
      description: "Email principale associata all'action.",
      date,
      dateLabel: formatDateLabel(date),
    });
  }

  return [...groups.values()]
    .sort((a, b) => {
      const rank = { "Main thread": 0, "Related fact": 1, "Referenced mail": 2 } as const;
      return rank[a.kind] - rank[b.kind] || (b.date ?? "").localeCompare(a.date ?? "");
    })
    .slice(0, 5);
}

function extractMainThreadRecords(action: ActionCenterItem): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (value == null) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          visit(JSON.parse(trimmed));
          return;
        } catch {
          // Not JSON; fall through to URL extraction.
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.messageId === "string" || typeof obj.mailUrl === "string") records.push(obj);
      for (const item of Object.values(obj)) visit(item);
    }
  };

  const snapshot = action.payload.contextSnapshot as Record<string, unknown> | undefined;
  const toolContext = snapshot?.toolContext as Record<string, unknown> | undefined;
  const observations = Array.isArray(toolContext?.observations) ? toolContext.observations : [];
  for (const raw of observations) {
    if (!raw || typeof raw !== "object") continue;
    const obs = raw as Record<string, unknown>;
    const input = obs.input && typeof obs.input === "object" ? obs.input as Record<string, unknown> : {};
    if (obs.tool === "mcp__mail__get_thread" && input.threadId === action.payload.threadId) {
      visit(obs.result);
    }
  }
  return dedupeMailRecords(records);
}

function mailUrlFromMessageId(messageId: string): string {
  const trimmed = messageId.trim().replace(/^<|>$/g, "");
  return `message://%3C${encodeURIComponent(trimmed)}%3E`;
}

function normalizeMailUrl(url: string): { key: string; url: string } | null {
  const match = url.match(/^message:\/\/(.+)$/);
  if (!match) return null;
  const raw = match[1].replace(/\\+$/, "");
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep raw if it is not a valid percent-encoded string.
  }
  const messageId = decoded.replace(/^<|>$/g, "").trim();
  if (!messageId || !messageId.includes("@")) return null;
  return { key: messageId.toLowerCase(), url: mailUrlFromMessageId(messageId) };
}

function shortMessageId(messageId: string): string {
  const trimmed = messageId.trim().replace(/^<|>$/g, "");
  return trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed;
}

function dedupeMailRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const record of records) {
    const key = String(record.messageId ?? record.mailUrl ?? record.id ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

function cleanSubject(subject: string): string {
  return subject.replace(/^(\s*(re|r|fw|fwd)\s*:\s*)+/i, "").trim() || subject;
}

function preferTitle(a: string, b: string): string {
  const ca = cleanSubject(a);
  const cb = cleanSubject(b);
  return ca.length <= cb.length ? ca : cb;
}

function maxDate(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.localeCompare(a) > 0 ? b : a;
}

function formatDateLabel(date?: string): string | undefined {
  if (!date || !Number.isFinite(Date.parse(date))) return undefined;
  return new Date(date).toLocaleString("it-IT", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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
