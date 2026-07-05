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

export function ActionDetail({
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
