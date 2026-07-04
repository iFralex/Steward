/**
 * Pending tool-approval card. By default it shows the ACTION as a rich card
 * (the email/event being proposed) plus Approve / Reject / note. "Modifica"
 * opens a Dialog with a typed, prefilled form to edit every field — recipients,
 * subject, body, attachments (as file chips you can drop in), dates (date+time
 * pickers), alarms… Approving runs the tool with the edited values. Unknown
 * tools fall back to a raw-JSON editor.
 */
import { useState } from "react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FileChip } from "@/components/file-chip";
import { DateTimePicker } from "@/components/datetime-picker";
import { CardView, cardForApproval, type FileApi } from "@/components/cards";
import type { PendingApproval } from "@/lib/host-socket";
import type { ApprovalDecision } from "@steward/protocol";

type Kind = "text" | "textarea" | "csv" | "bool" | "numbers" | "datetime" | "files";
interface Field { key: string; label: string; kind: Kind }

const FORMS: Record<string, Field[]> = {
  send_email: [
    { key: "from", label: "Da", kind: "text" },
    { key: "to", label: "A", kind: "csv" },
    { key: "cc", label: "Cc", kind: "csv" },
    { key: "bcc", label: "Ccn", kind: "csv" },
    { key: "subject", label: "Oggetto", kind: "text" },
    { key: "body", label: "Corpo", kind: "textarea" },
    { key: "attachments", label: "Allegati", kind: "files" },
    { key: "sendAt", label: "Invio posticipato", kind: "datetime" },
  ],
  reply: [
    { key: "from", label: "Da", kind: "text" },
    { key: "body", label: "Corpo", kind: "textarea" },
    { key: "replyAll", label: "Rispondi a tutti", kind: "bool" },
    { key: "attachments", label: "Allegati", kind: "files" },
    { key: "sendAt", label: "Invio posticipato", kind: "datetime" },
  ],
  create_event: [
    { key: "calendar", label: "Calendario", kind: "text" },
    { key: "summary", label: "Titolo", kind: "text" },
    { key: "start", label: "Inizio", kind: "datetime" },
    { key: "end", label: "Fine", kind: "datetime" },
    { key: "location", label: "Luogo", kind: "text" },
    { key: "description", label: "Descrizione", kind: "textarea" },
    { key: "url", label: "URL", kind: "text" },
    { key: "alarms", label: "Avvisi (minuti prima, separati da virgola)", kind: "numbers" },
  ],
  update_event: [
    { key: "summary", label: "Titolo", kind: "text" },
    { key: "start", label: "Inizio", kind: "datetime" },
    { key: "end", label: "Fine", kind: "datetime" },
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
  if (kind === "numbers") return asArray(v).map(String).join(", ");
  if (kind === "files") return asArray(v).map(String).join("\n");
  return v == null ? "" : String(v);
}

function buildEdited(input: Record<string, unknown>, fields: Field[], vals: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const f of fields) {
    const raw = vals[f.key];
    if (f.kind === "bool") { out[f.key] = raw === true; continue; }
    if (f.kind === "csv") { out[f.key] = String(raw).split(",").map((s) => s.trim()).filter(Boolean); continue; }
    if (f.kind === "files") { out[f.key] = String(raw).split("\n").map((s) => s.trim()).filter(Boolean); continue; }
    if (f.kind === "numbers") { out[f.key] = String(raw).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)); continue; }
    const s = String(raw);
    if (s.trim() === "") delete out[f.key]; // empty text/datetime → omit (use the tool's default)
    else out[f.key] = s;
  }
  return out;
}

function FilesField({ value, onChange, fileApi }: { value: string; onChange: (v: string) => void; fileApi: FileApi }) {
  const paths = value.split("\n").map((s) => s.trim()).filter(Boolean);
  const setPaths = (ps: string[]) => onChange(ps.join("\n"));
  const [draft, setDraft] = useState("");
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { const p = e.dataTransfer.getData("application/x-llmwiki-path"); if (p) { e.preventDefault(); setPaths([...paths, p]); } }}
      className="border-input bg-muted/40 flex flex-col gap-1.5 rounded-md border p-2"
    >
      {paths.map((p, i) => {
        const f = fileApi.resolve(p);
        return (
          <div key={p + i} className="flex items-center gap-1">
            {f
              ? <div className="min-w-0 flex-1"><FileChip file={f} onOpen={fileApi.open} onReveal={fileApi.reveal} /></div>
              : <span className="bg-muted/60 min-w-0 flex-1 truncate rounded border px-2 py-1 text-xs">📎 {p.split("/").pop()}</span>}
            <button type="button" onClick={() => setPaths(paths.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive px-1">×</button>
          </div>
        );
      })}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { e.preventDefault(); setPaths([...paths, draft.trim()]); setDraft(""); } }}
        placeholder="Trascina un file dalla chat, o incolla un percorso + Invio"
        className="bg-background/60 rounded border px-2 py-1 text-xs outline-none"
      />
    </div>
  );
}

export function ApprovalCard({
  approval,
  onDecision,
  fileApi,
}: {
  approval: PendingApproval;
  onDecision: (requestId: string, decision: ApprovalDecision, note?: string, editedInput?: Record<string, unknown>) => void;
  fileApi: FileApi;
}) {
  const input = (approval.input ?? {}) as Record<string, unknown>;
  const fields = FORMS[bareName(approval.tool)];
  const [editing, setEditing] = useState(false);
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

  const edited = fields ? buildEdited(input, fields, vals) : input;
  const card = fields ? cardForApproval(approval.tool, edited) : null;
  const set = (key: string, value: string | boolean) => setVals((p) => ({ ...p, [key]: value }));

  const approve = () => {
    if (fields) {
      const changed = JSON.stringify(edited) !== JSON.stringify(input);
      onDecision(approval.requestId, "allow", note || undefined, changed ? edited : undefined);
    } else {
      const changed = jsonDraft.trim() !== original.trim();
      onDecision(approval.requestId, "allow", note || undefined, changed && jsonParsed ? jsonParsed : undefined);
    }
  };

  return (
    <Card className="border-amber-500/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Badge variant="outline" className="border-amber-500/60 text-amber-600">approvazione richiesta</Badge>
          <span className="font-mono">{approval.tool}</span>
          {fields && (
            <button type="button" className="text-muted-foreground hover:text-foreground ml-auto text-xs underline" onClick={() => setEditing(true)}>
              Modifica
            </button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {card ? (
          <CardView type={card.type} data={card.data} fileApi={fileApi} />
        ) : (
          <textarea
            className="border-input bg-muted h-40 w-full resize-y rounded-md border p-3 font-mono text-xs outline-none"
            value={jsonDraft}
            onChange={(e) => setJsonDraft(e.target.value)}
            spellCheck={false}
          />
        )}
        {jsonError && <p className="text-xs text-red-500">{jsonError}</p>}
        <Input placeholder="Nota opzionale (inviata all'agente)" value={note} onChange={(e) => setNote(e.target.value)} />
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" onClick={approve} disabled={!fields && jsonError !== undefined}>Approva</Button>
        <Button size="sm" variant="destructive" onClick={() => onDecision(approval.requestId, "deny", note || undefined)}>Rifiuta</Button>
      </CardFooter>

      {fields && (
        <Dialog open={editing} onOpenChange={setEditing}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Modifica · {bareName(approval.tool)}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {fields.map((f) => (
                <label key={f.key} className="block">
                  <span className="text-muted-foreground mb-1 block text-xs font-medium">{f.label}</span>
                  {f.kind === "bool" ? (
                    <input type="checkbox" checked={vals[f.key] === true} onChange={(e) => set(f.key, e.target.checked)} className="size-4" />
                  ) : f.kind === "datetime" ? (
                    <DateTimePicker value={String(vals[f.key] ?? "")} onChange={(iso) => set(f.key, iso)} />
                  ) : f.kind === "files" ? (
                    <FilesField value={String(vals[f.key] ?? "")} onChange={(v) => set(f.key, v)} fileApi={fileApi} />
                  ) : f.kind === "textarea" ? (
                    <textarea
                      value={String(vals[f.key] ?? "")}
                      onChange={(e) => set(f.key, e.target.value)}
                      className="border-input bg-muted/40 min-h-32 w-full resize-y rounded-md border p-2 text-sm outline-none"
                    />
                  ) : (
                    <Input value={String(vals[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />
                  )}
                </label>
              ))}
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setEditing(false)}>Fatto</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
