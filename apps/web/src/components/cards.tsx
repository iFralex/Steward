/**
 * Rich cards for tool results AND inline in assistant text. The same CardView
 * renders a card from a typed payload, used both by ToolCard (per-tool views)
 * and by the markdown renderer for ```card fenced blocks the model emits.
 */
import { FileChip } from "@/components/file-chip";
import type { ChannelFile } from "@llm-wiki/protocol";

export interface FileApi {
  open: (token: string) => void;
  reveal: (token: string) => void;
  resolve: (key: string) => ChannelFile | undefined;
}

function fmtDate(v: unknown): string {
  if (v == null) return "";
  const d = typeof v === "number" ? new Date(v * (v < 1e12 ? 1000 : 1)) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" });
}

type Dict = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

function EmailCard({ data, files, fileApi }: { data: Dict; files?: ChannelFile[]; fileApi: FileApi }) {
  const attachments = Array.isArray(data.attachments) ? (data.attachments as Dict[]) : [];
  const mailUrl = str(data.mailUrl);
  return (
    <div className="bg-card my-1 overflow-hidden rounded-md border text-xs">
      <div className="bg-muted/40 border-b px-3 py-2">
        <div className="font-medium">{str(data.subject) || "(senza oggetto)"}</div>
        <div className="text-muted-foreground">{str(data.from)}{data.date ? ` · ${fmtDate(data.date)}` : ""}</div>
      </div>
      {data.body ? (
        <div className="max-h-64 overflow-auto px-3 py-2 leading-relaxed whitespace-pre-wrap">{str(data.body)}</div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
        {mailUrl && <a href={mailUrl} className="text-primary underline">Apri in Mail</a>}
        {attachments.map((a, i) => {
          const name = str(a.name);
          const f = fileApi.resolve(name);
          return f
            ? <FileChip key={name + i} file={f} onOpen={fileApi.open} onReveal={fileApi.reveal} />
            : <span key={name + i} className="bg-muted/60 rounded border px-2 py-1">📎 {name}</span>;
        })}
        {(files ?? []).map((f) => <FileChip key={f.token} file={f} onOpen={fileApi.open} onReveal={fileApi.reveal} />)}
      </div>
    </div>
  );
}

function EventCard({ data }: { data: Dict }) {
  return (
    <div className="bg-card my-1 rounded-md border px-3 py-2 text-xs">
      <div className="font-medium">📅 {str(data.summary) || "(evento)"}</div>
      <div className="text-muted-foreground">{fmtDate(data.start)}{data.end ? ` → ${fmtDate(data.end)}` : ""}</div>
      {data.location ? <div>📍 {str(data.location)}</div> : null}
      {data.calendar ? <div className="text-muted-foreground">{str(data.calendar)}</div> : null}
      {data.url ? <a href={str(data.url)} className="text-primary break-all underline">{str(data.url)}</a> : null}
    </div>
  );
}

function SearchResultsList({ results }: { results: Dict[] }) {
  if (!results.length) return <div className="text-muted-foreground text-xs">Nessun risultato.</div>;
  return (
    <div className="my-1 flex flex-col gap-1">
      {results.map((r, i) => {
        const url = str(r.mailUrl);
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
  const f = fileApi.resolve(str(data.path)) ?? fileApi.resolve(str(data.name));
  if (f) return <div className="my-1"><FileChip file={f} onOpen={fileApi.open} onReveal={fileApi.reveal} /></div>;
  return <div className="bg-muted/60 my-1 rounded-md border px-2 py-1.5 text-xs">📎 {str(data.name) || str(data.path)}</div>;
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

/** Pick a card for a tool result, or null to fall back to raw JSON. */
export function cardForTool(tool: string, input: unknown, output: unknown): { type: string; data: unknown } | null {
  const name = tool.split("__").slice(2).join("__") || tool;
  if (name === "read_message" && output && typeof output === "object") return { type: "email", data: output };
  if ((name === "search_messages" || name === "get_thread") && Array.isArray(output)) return { type: "search", data: output };
  if ((name === "create_event" || name === "update_event") && input && typeof input === "object") {
    const uid = (output as Dict)?.uid;
    return { type: "event", data: { ...(input as Dict), ...(uid ? { uid } : {}) } };
  }
  return null;
}
