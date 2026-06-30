/**
 * Pending tool-approval card. For known gated tools (send/reply/events) it shows
 * a typed FORM prefilled from the model's proposed arguments — the user can edit
 * every field (recipients, subject, body, attachments, …) before approving;
 * approving runs the tool with the edited values. Unknown tools fall back to a
 * raw-JSON editor. Reject sends the action back with an optional note.
 */
import { useState } from "react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PendingApproval } from "@/lib/host-socket";
import type { ApprovalDecision } from "@llm-wiki/protocol";

type Kind = "text" | "textarea" | "csv" | "lines" | "bool" | "numbers";
interface Field { key: string; label: string; kind: Kind }

const FORMS: Record<string, Field[]> = {
  send_email: [
    { key: "from", label: "Da", kind: "text" },
    { key: "to", label: "A", kind: "csv" },
    { key: "cc", label: "Cc", kind: "csv" },
    { key: "bcc", label: "Ccn", kind: "csv" },
    { key: "subject", label: "Oggetto", kind: "text" },
    { key: "body", label: "Corpo", kind: "textarea" },
    { key: "attachments", label: "Allegati (un percorso per riga)", kind: "lines" },
    { key: "sendAt", label: "Invio posticipato (ISO, opzionale)", kind: "text" },
  ],
  reply: [
    { key: "from", label: "Da", kind: "text" },
    { key: "body", label: "Corpo", kind: "textarea" },
    { key: "replyAll", label: "Rispondi a tutti", kind: "bool" },
    { key: "attachments", label: "Allegati (un percorso per riga)", kind: "lines" },
    { key: "sendAt", label: "Invio posticipato (ISO, opzionale)", kind: "text" },
  ],
  create_event: [
    { key: "calendar", label: "Calendario", kind: "text" },
    { key: "summary", label: "Titolo", kind: "text" },
    { key: "start", label: "Inizio (ISO)", kind: "text" },
    { key: "end", label: "Fine (ISO)", kind: "text" },
    { key: "location", label: "Luogo", kind: "text" },
    { key: "description", label: "Descrizione", kind: "textarea" },
    { key: "url", label: "URL", kind: "text" },
    { key: "alarms", label: "Avvisi (minuti prima, separati da virgola)", kind: "numbers" },
  ],
  update_event: [
    { key: "summary", label: "Titolo", kind: "text" },
    { key: "start", label: "Inizio (ISO)", kind: "text" },
    { key: "end", label: "Fine (ISO)", kind: "text" },
    { key: "location", label: "Luogo", kind: "text" },
    { key: "description", label: "Descrizione", kind: "textarea" },
    { key: "url", label: "URL", kind: "text" },
    { key: "alarms", label: "Avvisi (minuti prima, separati da virgola)", kind: "numbers" },
  ],
};

const bareName = (tool: string): string => {
  const p = tool.split("__");
  return p[0] === "mcp" && p.length >= 3 ? p.slice(2).join("__") : tool;
};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

function toEditable(kind: Kind, v: unknown): string | boolean {
  if (kind === "bool") return v === true;
  if (kind === "csv") return asArray(v).map(String).join(", ");
  if (kind === "lines" || kind === "numbers") return asArray(v).map(String).join(kind === "lines" ? "\n" : ", ");
  return v == null ? "" : String(v);
}

function buildEdited(input: Record<string, unknown>, fields: Field[], vals: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const f of fields) {
    const raw = vals[f.key];
    if (f.kind === "bool") { out[f.key] = raw === true; continue; }
    if (f.kind === "csv" || f.kind === "lines") {
      const arr = String(raw).split(f.kind === "csv" ? "," : "\n").map((s) => s.trim()).filter(Boolean);
      out[f.key] = arr;
      continue;
    }
    if (f.kind === "numbers") {
      const arr = String(raw).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
      out[f.key] = arr;
      continue;
    }
    const s = String(raw);
    if (s.trim() === "") delete out[f.key]; // empty text → omit (use the tool's default)
    else out[f.key] = s;
  }
  return out;
}

export function ApprovalCard({
  approval,
  onDecision,
}: {
  approval: PendingApproval;
  onDecision: (requestId: string, decision: ApprovalDecision, note?: string, editedInput?: Record<string, unknown>) => void;
}) {
  const input = (approval.input ?? {}) as Record<string, unknown>;
  const fields = FORMS[bareName(approval.tool)];
  const [note, setNote] = useState("");
  const [vals, setVals] = useState<Record<string, string | boolean>>(
    () => Object.fromEntries((fields ?? []).map((f) => [f.key, toEditable(f.kind, input[f.key])])),
  );

  // JSON fallback (unknown tools).
  const original = JSON.stringify(input, null, 2);
  const [jsonDraft, setJsonDraft] = useState(original);
  let jsonParsed: Record<string, unknown> | undefined;
  let jsonError: string | undefined;
  if (!fields) {
    try {
      const v: unknown = JSON.parse(jsonDraft);
      if (v && typeof v === "object" && !Array.isArray(v)) jsonParsed = v as Record<string, unknown>;
      else jsonError = "Gli argomenti devono essere un oggetto JSON";
    } catch (e) { jsonError = e instanceof Error ? e.message : "JSON non valido"; }
  }

  const approve = () => {
    if (fields) {
      const edited = buildEdited(input, fields, vals);
      const changed = JSON.stringify(edited) !== JSON.stringify(input);
      onDecision(approval.requestId, "allow", note || undefined, changed ? edited : undefined);
    } else {
      const changed = jsonDraft.trim() !== original.trim();
      onDecision(approval.requestId, "allow", note || undefined, changed && jsonParsed ? jsonParsed : undefined);
    }
  };

  const set = (key: string, value: string | boolean) => setVals((p) => ({ ...p, [key]: value }));

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Badge variant="outline" className="border-amber-500/60 text-amber-600">approvazione richiesta</Badge>
          <span className="font-mono text-sm">{approval.tool}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {fields ? (
          <div className="space-y-2.5">
            {fields.map((f) => (
              <label key={f.key} className="block">
                <span className="text-muted-foreground mb-1 block text-xs font-medium">{f.label}</span>
                {f.kind === "bool" ? (
                  <input type="checkbox" checked={vals[f.key] === true} onChange={(e) => set(f.key, e.target.checked)} className="size-4" />
                ) : f.kind === "textarea" ? (
                  <textarea
                    value={String(vals[f.key] ?? "")}
                    onChange={(e) => set(f.key, e.target.value)}
                    className="border-input bg-muted/40 min-h-28 w-full resize-y rounded-md border p-2 text-sm outline-none"
                  />
                ) : (
                  <textarea
                    rows={f.kind === "lines" ? 2 : 1}
                    value={String(vals[f.key] ?? "")}
                    onChange={(e) => set(f.key, e.target.value)}
                    onDrop={f.kind === "lines" ? (e) => {
                      const p = e.dataTransfer.getData("application/x-llmwiki-path");
                      if (p) {
                        e.preventDefault();
                        const cur = String(vals[f.key] ?? "").trim();
                        set(f.key, cur ? `${cur}\n${p}` : p);
                      }
                    } : undefined}
                    className={cn(
                      "border-input bg-muted/40 w-full resize-y rounded-md border px-2 py-1.5 text-sm outline-none",
                      f.kind === "lines" && "font-mono text-xs",
                    )}
                    placeholder={f.kind === "lines" ? "Trascina qui un file dalla chat, o incolla un percorso" : undefined}
                  />
                )}
              </label>
            ))}
          </div>
        ) : (
          <>
            <textarea
              className="border-input bg-muted h-40 w-full resize-y rounded-md border p-3 font-mono text-xs outline-none"
              value={jsonDraft}
              onChange={(e) => setJsonDraft(e.target.value)}
              spellCheck={false}
            />
            {jsonError && <p className="text-xs text-red-500">{jsonError}</p>}
          </>
        )}
        <input
          className="border-input w-full rounded-md border bg-transparent px-3 py-1.5 text-sm outline-none"
          placeholder="Nota opzionale (inviata all'agente)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" onClick={approve} disabled={!fields && jsonError !== undefined}>Approva</Button>
        <Button size="sm" variant="destructive" onClick={() => onDecision(approval.requestId, "deny", note || undefined)}>Rifiuta</Button>
      </CardFooter>
    </Card>
  );
}
