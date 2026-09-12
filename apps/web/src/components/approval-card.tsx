/**
 * Pending tool-approval card. By default it shows the ACTION as a rich card
 * (the email/event being proposed) plus Approve / Reject / note. "Modifica"
 * opens a Dialog with a typed, prefilled form to edit every field — recipients,
 * subject, body, attachments (as file chips you can drop in), dates (date+time
 * pickers), alarms… Approving runs the tool with the edited values. Unknown
 * tools fall back to a raw-JSON editor.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
/** labelKey indexes approval.fields.* in the translation dictionaries. */
interface Field { key: string; labelKey: string; kind: Kind }

const FORMS: Record<string, Field[]> = {
  copy_to_clipboard: [
    { key: "label", labelKey: "label", kind: "text" },
    { key: "text", labelKey: "text", kind: "textarea" },
  ],
  send_email: [
    { key: "from", labelKey: "from", kind: "text" },
    { key: "to", labelKey: "to", kind: "csv" },
    { key: "cc", labelKey: "cc", kind: "csv" },
    { key: "bcc", labelKey: "bcc", kind: "csv" },
    { key: "subject", labelKey: "subject", kind: "text" },
    { key: "body", labelKey: "body", kind: "textarea" },
    { key: "attachments", labelKey: "attachments", kind: "files" },
    { key: "sendAt", labelKey: "scheduledSend", kind: "datetime" },
  ],
  reply: [
    { key: "from", labelKey: "from", kind: "text" },
    { key: "body", labelKey: "body", kind: "textarea" },
    { key: "replyAll", labelKey: "replyAll", kind: "bool" },
    { key: "attachments", labelKey: "attachments", kind: "files" },
    { key: "sendAt", labelKey: "scheduledSend", kind: "datetime" },
  ],
  create_event: [
    { key: "calendar", labelKey: "calendar", kind: "text" },
    { key: "summary", labelKey: "title", kind: "text" },
    { key: "start", labelKey: "start", kind: "datetime" },
    { key: "end", labelKey: "end", kind: "datetime" },
    { key: "allDay", labelKey: "allDay", kind: "bool" },
    { key: "location", labelKey: "location", kind: "text" },
    { key: "description", labelKey: "description", kind: "textarea" },
    { key: "url", labelKey: "url", kind: "text" },
    { key: "recurrence", labelKey: "recurrence", kind: "text" },
    { key: "alarms", labelKey: "alarms", kind: "numbers" },
  ],
  update_event: [
    { key: "summary", labelKey: "title", kind: "text" },
    { key: "start", labelKey: "start", kind: "datetime" },
    { key: "end", labelKey: "end", kind: "datetime" },
    { key: "location", labelKey: "location", kind: "text" },
    { key: "description", labelKey: "description", kind: "textarea" },
    { key: "url", labelKey: "url", kind: "text" },
    { key: "recurrence", labelKey: "recurrence", kind: "text" },
    { key: "alarms", labelKey: "alarms", kind: "numbers" },
  ],
  create_flow: [
    { key: "name", labelKey: "flowName", kind: "text" },
    { key: "when", labelKey: "flowWhen", kind: "textarea" },
    { key: "guidance", labelKey: "flowGuidance", kind: "textarea" },
    { key: "exclusions", labelKey: "flowExclusions", kind: "textarea" },
    { key: "enabled", labelKey: "flowEnabled", kind: "bool" },
  ],
  update_flow: [
    { key: "name", labelKey: "flowName", kind: "text" },
    { key: "when", labelKey: "flowWhen", kind: "textarea" },
    { key: "guidance", labelKey: "flowGuidance", kind: "textarea" },
    { key: "exclusions", labelKey: "flowExclusions", kind: "textarea" },
    { key: "enabled", labelKey: "flowEnabled", kind: "bool" },
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

function clipboardText(input: Record<string, unknown>): string {
  return typeof input.text === "string" ? input.text : "";
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "true");
  el.style.position = "fixed";
  el.style.left = "-9999px";
  el.style.top = "0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  if (!ok) throw new Error("Clipboard write was blocked");
}

function ClipboardApprovalPreview({ input }: { input: Record<string, unknown> }) {
  const { t } = useTranslation();
  const text = clipboardText(input);
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : t("approval.clipboard.defaultLabel");
  return (
    <div className="bg-muted/40 rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground tabular-nums">{t("approval.clipboard.chars", { count: text.length })}</span>
      </div>
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-xs">{text}</pre>
    </div>
  );
}

function FlowApprovalPreview({ input }: { input: Record<string, unknown> }) {
  const { t } = useTranslation();
  return (
    <div className="bg-muted/40 space-y-3 rounded-md border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{String(input.name ?? t("approval.flow.untitled"))}</span>
        <Badge variant="outline">{input.enabled === false ? t("approval.flow.disabled") : t("approval.flow.enabled")}</Badge>
      </div>
      <div><div className="text-muted-foreground text-xs font-medium">{t("approval.fields.flowWhen")}</div><div className="whitespace-pre-wrap">{String(input.when ?? "")}</div></div>
      <div><div className="text-muted-foreground text-xs font-medium">{t("approval.fields.flowGuidance")}</div><div className="whitespace-pre-wrap">{String(input.guidance ?? "")}</div></div>
      {input.exclusions ? <div><div className="text-muted-foreground text-xs font-medium">{t("approval.fields.flowExclusions")}</div><div className="whitespace-pre-wrap">{String(input.exclusions)}</div></div> : null}
    </div>
  );
}

function FilesField({ value, onChange, fileApi }: { value: string; onChange: (v: string) => void; fileApi: FileApi }) {
  const { t } = useTranslation();
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
        placeholder={t("approval.filesPlaceholder")}
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
  const { t } = useTranslation();
  const input = (approval.input ?? {}) as Record<string, unknown>;
  const fields = FORMS[bareName(approval.tool)];
  const isClipboardApproval = bareName(approval.tool) === "copy_to_clipboard";
  const isFlowApproval = ["create_flow", "update_flow"].includes(bareName(approval.tool));
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [vals, setVals] = useState<Record<string, string | boolean>>(
    () => Object.fromEntries((fields ?? []).map((f) => [f.key,
      isFlowApproval && f.key === "enabled" && input.enabled === undefined ? true : toEditable(f.kind, input[f.key]),
    ])),
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
      else jsonError = t("approval.argsMustBeObject");
    } catch (e) { jsonError = e instanceof Error ? e.message : t("approval.invalidJson"); }
  }

  const edited = fields ? buildEdited(input, fields, vals) : input;
  const card = fields ? cardForApproval(approval.tool, edited) : null;
  const set = (key: string, value: string | boolean) => setVals((p) => ({ ...p, [key]: value }));

  const approve = async () => {
    setLocalError(null);
    if (fields) {
      const changed = JSON.stringify(edited) !== JSON.stringify(input);
      if (isClipboardApproval) {
        const text = clipboardText(edited);
        if (!text) {
          setLocalError(t("approval.clipboard.empty"));
          return;
        }
        setApproving(true);
        try {
          await writeClipboardText(text);
        } catch (err) {
          setApproving(false);
          setLocalError(err instanceof Error ? err.message : t("approval.clipboard.failed"));
          return;
        }
        setApproving(false);
      }
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
          <Badge variant="outline" className="border-amber-500/60 text-amber-600 shrink-0">{t("approval.approvalRequested")}</Badge>
          <span className="min-w-0 flex-1 truncate font-mono">{approval.tool}</span>
          {fields && (
            <button type="button" className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline" onClick={() => setEditing(true)}>
              {t("approval.edit")}
            </button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isClipboardApproval ? (
          <ClipboardApprovalPreview input={edited} />
        ) : isFlowApproval ? (
          <FlowApprovalPreview input={edited} />
        ) : card ? (
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
        {localError && <p className="text-xs text-red-500">{localError}</p>}
        <Input placeholder={t("approval.notePlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} />
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" onClick={approve} disabled={approving || (!fields && jsonError !== undefined)}>
          {isClipboardApproval ? t("approval.clipboard.approve") : t("approval.approve")}
        </Button>
        <Button size="sm" variant="destructive" onClick={() => onDecision(approval.requestId, "deny", note || undefined)}>{t("approval.reject")}</Button>
      </CardFooter>

      {fields && (
        <Dialog open={editing} onOpenChange={setEditing}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("approval.editDialogTitle", { name: bareName(approval.tool) })}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {fields.map((f) => (
                <label key={f.key} className="block">
                  <span className="text-muted-foreground mb-1 block text-xs font-medium">{t(`approval.fields.${f.labelKey}`)}</span>
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
              <Button size="sm" onClick={() => setEditing(false)}>{t("approval.confirmDone")}</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
