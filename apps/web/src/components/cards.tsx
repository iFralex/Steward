/**
 * Rich cards for tool results AND inline in assistant text. The same CardView
 * renders a card from a typed payload, used both by ToolCard (per-tool views)
 * and by the markdown renderer for ```card fenced blocks the model emits.
 */
import { useEffect, useState, type ReactNode } from "react";
import { FileChip } from "@/components/file-chip";
import { safeHref } from "@/lib/utils";
import type { ChannelFile } from "@llm-wiki/protocol";

export interface FileApi {
  open: (token: string) => void;
  reveal: (token: string) => void;
  resolve: (key: string) => ChannelFile | undefined;
  /** Register a path/name on demand (host /resolve) so a card becomes actionable. */
  register?: (key: string) => Promise<ChannelFile | undefined>;
}

function fmtDate(v: unknown): string {
  if (v == null) return "";
  const d = typeof v === "number" ? new Date(v * (v < 1e12 ? 1000 : 1)) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" });
}

type Dict = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const present = (v: unknown): boolean => v != null && (Array.isArray(v) ? v.length > 0 : String(v).trim().length > 0);
const joinAddr = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(", ") : str(v));

function formatAlarms(v: unknown): string {
  return (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [])
    .map((m) => (m % 1440 === 0 ? `${m / 1440}g prima` : m % 60 === 0 ? `${m / 60}h prima` : `${m} min prima`))
    .join(", ");
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      {label ? <span className="text-muted-foreground shrink-0">{label}</span> : null}
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function EmailCard({ data, files, fileApi }: { data: Dict; files?: ChannelFile[]; fileApi: FileApi }) {
  const attachments = (Array.isArray(data.attachments) ? data.attachments : []).map((a) =>
    typeof a === "string" ? { name: a.split("/").pop() ?? a, path: a } : (a as Dict),
  );
  const mailUrl = str(data.mailUrl);
  const safeMailUrl = safeHref(mailUrl);
  const metaKeys = ["from", "to", "cc", "bcc", "date", "sendAt"] as const;
  const hasMeta = data.replyAll === true || metaKeys.some((k) => present(data[k]));
  const hasFooter = !!mailUrl || attachments.length > 0 || (files?.length ?? 0) > 0;
  return (
    <div className="bg-card my-1 overflow-hidden rounded-md border text-xs">
      <div className="bg-muted/40 border-b px-3 py-2 font-medium">{str(data.subject) || "(senza oggetto)"}</div>
      {hasMeta && (
        <div className="space-y-0.5 border-b px-3 py-2">
          {present(data.from) && <Row label="Da">{str(data.from)}</Row>}
          {present(data.to) && <Row label="A">{joinAddr(data.to)}</Row>}
          {present(data.cc) && <Row label="Cc">{joinAddr(data.cc)}</Row>}
          {present(data.bcc) && <Row label="Ccn">{joinAddr(data.bcc)}</Row>}
          {present(data.date) && <Row label="Data">{fmtDate(data.date)}</Row>}
          {present(data.sendAt) && <Row label="Invio posticipato">{fmtDate(data.sendAt)}</Row>}
          {data.replyAll === true && <Row>↩︎ Rispondi a tutti</Row>}
        </div>
      )}
      {present(data.body) && (
        <div className="max-h-64 overflow-auto px-3 py-2 leading-relaxed whitespace-pre-wrap">{str(data.body)}</div>
      )}
      {hasFooter && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          {mailUrl && (safeMailUrl
            ? <a href={safeMailUrl} className="text-primary underline">Apri in Mail</a>
            : <span className="text-muted-foreground">Apri in Mail</span>)}
          {attachments.map((a, i) => {
            const name = str(a.name);
            const f = fileApi.resolve(str(a.path)) ?? fileApi.resolve(name);
            return f
              ? <FileChip key={name + i} file={f} onOpen={fileApi.open} onReveal={fileApi.reveal} />
              : <span key={name + i} className="bg-muted/60 rounded border px-2 py-1">📎 {name}</span>;
          })}
          {(files ?? []).map((f) => <FileChip key={f.token} file={f} onOpen={fileApi.open} onReveal={fileApi.reveal} />)}
        </div>
      )}
    </div>
  );
}

function EventCard({ data }: { data: Dict }) {
  return (
    <div className="bg-card my-1 space-y-0.5 rounded-md border px-3 py-2 text-xs">
      <div className="font-medium">📅 {str(data.summary) || "(evento)"}</div>
      {(present(data.start) || present(data.end)) && (
        <Row label="Quando">{fmtDate(data.start)}{data.end ? ` → ${fmtDate(data.end)}` : ""}</Row>
      )}
      {present(data.location) && <Row label="Luogo">{str(data.location)}</Row>}
      {present(data.calendar) && <Row label="Calendario">{str(data.calendar)}</Row>}
      {present(data.alarms) && <Row label="Avvisi">{formatAlarms(data.alarms)}</Row>}
      {present(data.url) && (
        <Row label="URL">
          {safeHref(str(data.url))
            ? <a href={str(data.url)} className="text-primary break-all underline">{str(data.url)}</a>
            : <span className="break-all">{str(data.url)}</span>}
        </Row>
      )}
      {present(data.description) && <div className="mt-1 border-t pt-1 whitespace-pre-wrap">{str(data.description)}</div>}
    </div>
  );
}

function SearchResultsList({ results }: { results: Dict[] }) {
  if (!results.length) return <div className="text-muted-foreground text-xs">Nessun risultato.</div>;
  return (
    <div className="my-1 flex flex-col gap-1">
      {results.map((r, i) => {
        const url = safeHref(str(r.mailUrl));
        const inner = (
          <>
            <div className="truncate font-medium">{str(r.subject) || "(senza oggetto)"}</div>
            <div className="text-muted-foreground truncate">{str(r.from)}{r.date ? ` · ${fmtDate(r.date)}` : ""}</div>
            {r.snippet ? <div className="text-muted-foreground truncate opacity-70">{str(r.snippet).replace(/\s+/g, " ").trim()}</div> : null}
          </>
        );
        return url
          ? <a key={str(r.id) || i} href={url} className="hover:bg-muted block rounded-md border px-2 py-1.5 text-xs">{inner}</a>
          : <div key={str(r.id) || i} className="rounded-md border px-2 py-1.5 text-xs">{inner}</div>;
      })}
    </div>
  );
}

function FileCardInline({ data, fileApi }: { data: Dict; fileApi: FileApi }) {
  const path = str(data.path);
  const name = str(data.name);
  const local = fileApi.resolve(path) ?? fileApi.resolve(name);
  const [file, setFile] = useState<ChannelFile | undefined>(local);

  // If the path wasn't surfaced by a tool, register it on demand so the card
  // gets buttons + drag (not just a static chip).
  useEffect(() => {
    if (file || !fileApi.register) return;
    let alive = true;
    void (async () => {
      const r = (path ? await fileApi.register!(path) : undefined) ?? (name ? await fileApi.register!(name) : undefined);
      if (alive && r) setFile(r);
    })();
    return () => { alive = false; };
  }, [path, name, file, fileApi]);

  if (file) return <div className="my-1"><FileChip file={file} onOpen={fileApi.open} onReveal={fileApi.reveal} /></div>;
  return <div className="bg-muted/60 my-1 rounded-md border px-2 py-1.5 text-xs">📎 {name || path}</div>;
}

export function CardView({ type, data, files, fileApi }: { type: string; data: unknown; files?: ChannelFile[]; fileApi: FileApi }) {
  const d = (data && typeof data === "object" ? data : {}) as Dict;
  switch (type) {
    case "email": return <EmailCard data={d} files={files} fileApi={fileApi} />;
    case "event": return <EventCard data={d} />;
    case "search": return <SearchResultsList results={Array.isArray(data) ? (data as Dict[]) : (Array.isArray(d.results) ? (d.results as Dict[]) : [])} />;
    case "file": return <FileCardInline data={d} fileApi={fileApi} />;
    default: return null;
  }
}

const bareName = (tool: string): string => {
  const p = tool.split("__");
  return p[0] === "mcp" && p.length >= 3 ? p.slice(2).join("__") : tool;
};

/** Pick a card to PREVIEW a pending gated action (from its proposed input). */
export function cardForApproval(tool: string, input: unknown): { type: string; data: unknown } | null {
  const name = bareName(tool);
  if (name === "send_email" || name === "reply") return { type: "email", data: input };
  if (name === "create_event" || name === "update_event") return { type: "event", data: input };
  return null;
}

/** Pick a card for a tool result, or null to fall back to raw JSON. */
export function cardForTool(tool: string, input: unknown, output: unknown): { type: string; data: unknown } | null {
  const name = bareName(tool);
  if (name === "read_message" && output && typeof output === "object") return { type: "email", data: output };
  if ((name === "search_messages" || name === "get_thread") && Array.isArray(output)) return { type: "search", data: output };
  if ((name === "create_event" || name === "update_event") && input && typeof input === "object") {
    const uid = (output as Dict)?.uid;
    return { type: "event", data: { ...(input as Dict), ...(uid ? { uid } : {}) } };
  }
  return null;
}
