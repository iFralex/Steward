/**
 * Rich cards for tool results AND inline in assistant text. The same CardView
 * renders a card from a typed payload, used both by ToolCard (per-tool views)
 * and by the markdown renderer for ```card fenced blocks the model emits.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { FileChip } from "@/components/file-chip";
import { safeHref } from "@/lib/utils";
import { currentLocale } from "@/lib/locale";
import type { ChannelFile } from "@steward/protocol";

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
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" });
}

type Dict = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const present = (v: unknown): boolean => v != null && (Array.isArray(v) ? v.length > 0 : String(v).trim().length > 0);
const joinAddr = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(", ") : str(v));

function formatAlarms(v: unknown, t: TFunction): string {
  return (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [])
    .map((m) => (m % 1440 === 0
      ? t("cards.alarms.days", { count: m / 1440 })
      : m % 60 === 0
        ? t("cards.alarms.hours", { count: m / 60 })
        : t("cards.alarms.minutes", { count: m })))
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
  const { t } = useTranslation();
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
      <div className="bg-muted/40 border-b px-3 py-2 font-medium">{str(data.subject) || t("cards.noSubject")}</div>
      {hasMeta && (
        <div className="space-y-0.5 border-b px-3 py-2">
          {present(data.from) && <Row label={t("cards.fields.from")}>{str(data.from)}</Row>}
          {present(data.to) && <Row label={t("cards.fields.to")}>{joinAddr(data.to)}</Row>}
          {present(data.cc) && <Row label={t("cards.fields.cc")}>{joinAddr(data.cc)}</Row>}
          {present(data.bcc) && <Row label={t("cards.fields.bcc")}>{joinAddr(data.bcc)}</Row>}
          {present(data.date) && <Row label={t("cards.fields.date")}>{fmtDate(data.date)}</Row>}
          {present(data.sendAt) && <Row label={t("cards.fields.scheduledSend")}>{fmtDate(data.sendAt)}</Row>}
          {data.replyAll === true && <Row>{t("cards.replyAll")}</Row>}
        </div>
      )}
      {present(data.body) && (
        <div className="max-h-64 overflow-auto px-3 py-2 leading-relaxed whitespace-pre-wrap">{str(data.body)}</div>
      )}
      {hasFooter && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          {mailUrl && (safeMailUrl
            ? <a href={safeMailUrl} className="text-primary underline">{t("cards.openInMail")}</a>
            : <span className="text-muted-foreground">{t("cards.openInMail")}</span>)}
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
  const { t } = useTranslation();
  return (
    <div className="bg-card my-1 space-y-0.5 rounded-md border px-3 py-2 text-xs">
      <div className="font-medium">📅 {str(data.summary) || t("cards.noEventTitle")}</div>
      {(present(data.start) || present(data.end)) && (
        <Row label={t("cards.eventFields.when")}>{fmtDate(data.start)}{data.end ? ` → ${fmtDate(data.end)}` : ""}</Row>
      )}
      {present(data.location) && <Row label={t("cards.eventFields.location")}>{str(data.location)}</Row>}
      {present(data.calendar) && <Row label={t("cards.eventFields.calendar")}>{str(data.calendar)}</Row>}
      {present(data.alarms) && <Row label={t("cards.eventFields.alerts")}>{formatAlarms(data.alarms, t)}</Row>}
      {present(data.url) && (
        <Row label={t("cards.eventFields.url")}>
          {safeHref(str(data.url))
            ? <a href={str(data.url)} className="text-primary break-all underline">{str(data.url)}</a>
            : <span className="break-all">{str(data.url)}</span>}
        </Row>
      )}
      {present(data.description) && <div className="mt-1 border-t pt-1 whitespace-pre-wrap">{str(data.description)}</div>}
    </div>
  );
}

function EventListCard({ data }: { data: unknown }) {
  const { t } = useTranslation();
  const events = Array.isArray(data)
    ? data
    : Array.isArray((data as Dict)?.events)
      ? ((data as Dict).events as unknown[])
      : [];
  if (!events.length) return <div className="text-muted-foreground text-xs">{t("cards.noEvents")}</div>;
  return <div className="my-1 space-y-1.5">{events.map((event, i) => <EventCard key={str((event as Dict)?.uid) || i} data={(event ?? {}) as Dict} />)}</div>;
}

function ContactCard({ data }: { data: Dict }) {
  const { t } = useTranslation();
  const name = [str(data.firstName), str(data.lastName)].filter(Boolean).join(" ") || str(data.nickname) || str(data.organization) || t("cards.noContactName");
  const emails = Array.isArray(data.emails) ? data.emails as Dict[] : [];
  const phones = Array.isArray(data.phones) ? data.phones as Dict[] : [];
  return (
    <div className="bg-card my-1 space-y-1 rounded-md border px-3 py-2 text-xs">
      <div className="font-medium">👤 {name}</div>
      {present(data.organization) && data.organization !== name && <Row label={t("cards.contactFields.organization")}>{str(data.organization)}</Row>}
      {emails.map((email, i) => <Row key={str(email.address) || i} label={str(email.label) || t("cards.contactFields.email")}>{str(email.address)}</Row>)}
      {phones.map((phone, i) => <Row key={str(phone.number) || i} label={str(phone.label) || t("cards.contactFields.phone")}>{str(phone.number)}</Row>)}
      {present(data.note) && <div className="mt-1 border-t pt-1 whitespace-pre-wrap">{str(data.note)}</div>}
    </div>
  );
}

function ContactListCard({ data }: { data: unknown }) {
  const { t } = useTranslation();
  const contacts = Array.isArray(data)
    ? data
    : Array.isArray((data as Dict)?.contacts)
      ? ((data as Dict).contacts as unknown[])
      : [];
  if (!contacts.length) return <div className="text-muted-foreground text-xs">{t("cards.noContacts")}</div>;
  return <div className="my-1 space-y-1.5">{contacts.map((contact, i) => <ContactCard key={str((contact as Dict)?.uid) || i} data={(contact ?? {}) as Dict} />)}</div>;
}

function CommandCard({ data }: { data: Dict }) {
  const { t } = useTranslation();
  return (
    <div className="bg-card my-1 overflow-hidden rounded-md border text-xs">
      <div className="bg-muted/40 border-b px-3 py-2 font-medium">⌨️ {t("cards.commandTitle")}</div>
      <pre className="overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono">{str(data.command)}</pre>
      {present(data.cwd) && <div className="border-t px-3 py-2"><Row label={t("cards.commandCwd")}>{str(data.cwd)}</Row></div>}
    </div>
  );
}

function ActionCard({ data }: { data: Dict }) {
  const { t } = useTranslation();
  return (
    <div className="bg-card my-1 space-y-1 rounded-md border px-3 py-2 text-xs">
      <div className="font-medium">✓ {str(data.title) || t("cards.actionTitle", { id: str(data.id) })}</div>
      {present(data.summary) && <div className="text-muted-foreground whitespace-pre-wrap">{str(data.summary)}</div>}
      {present(data.status) && <Row label={t("cards.actionStatus")}>{str(data.status)}</Row>}
    </div>
  );
}

function SourceWriteCard({ data }: { data: Dict }) {
  const { t } = useTranslation();
  const sources = Array.isArray(data.sources)
    ? data.sources as Dict[]
    : present(data.filename)
      ? [{ filename: data.filename, dir: data.dir, content: data.content }]
      : [];
  return (
    <div className="bg-card my-1 overflow-hidden rounded-md border text-xs">
      <div className="bg-muted/40 border-b px-3 py-2 font-medium">📚 {t("cards.sourceWriteTitle")}</div>
      <div className="space-y-2 px-3 py-2">
        {present(data.project_id) && <Row label={t("cards.sourceProject")}>{str(data.project_id)}</Row>}
        {present(data.dir) && !sources.length && <Row label={t("cards.sourceFolder")}>{str(data.dir)}</Row>}
        {sources.map((source, i) => (
          <div key={`${str(source.dir)}/${str(source.filename)}` || i} className="rounded border px-2 py-1.5">
            <div className="font-medium">{[str(source.dir), str(source.filename)].filter(Boolean).join("/")}</div>
            {present(source.content) && <div className="text-muted-foreground mt-1 line-clamp-3 whitespace-pre-wrap">{str(source.content)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function OperationCard({ data }: { data: Dict }) {
  const { t } = useTranslation();
  const operation = str(data.operation);
  return (
    <div className="bg-card my-1 rounded-md border px-3 py-2 text-xs">
      <div className="font-medium">⚙️ {t(`cards.operations.${operation}`, { defaultValue: operation })}</div>
    </div>
  );
}

function SearchResultsList({ results }: { results: Dict[] }) {
  const { t } = useTranslation();
  if (!results.length) return <div className="text-muted-foreground text-xs">{t("cards.noResults")}</div>;
  return (
    <div className="my-1 flex flex-col gap-1">
      {results.map((r, i) => {
        const url = safeHref(str(r.mailUrl));
        const inner = (
          <>
            <div className="truncate font-medium">{str(r.subject) || t("cards.noSubject")}</div>
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
  const outer = (data && typeof data === "object" ? data : {}) as Dict;
  // Accept both documented flat inline cards and the common envelope form
  // {type:"event", data:{...}} so a harmless model variation cannot produce
  // an empty card.
  const d = outer.data && typeof outer.data === "object" && !Array.isArray(outer.data)
    ? outer.data as Dict
    : outer;
  switch (type) {
    case "email": return <EmailCard data={d} files={files} fileApi={fileApi} />;
    case "event": return <EventCard data={d} />;
    case "events": return <EventListCard data={Array.isArray(data) ? data : d} />;
    case "contact": return <ContactCard data={d} />;
    case "contacts": return <ContactListCard data={Array.isArray(data) ? data : d} />;
    case "command": return <CommandCard data={d} />;
    case "action": return <ActionCard data={d} />;
    case "source-write": return <SourceWriteCard data={d} />;
    case "operation": return <OperationCard data={d} />;
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
  if (name === "cancel_scheduled") return { type: "email", data: input };
  if (name === "create_event" || name === "update_event" || name === "delete_event") return { type: "event", data: input };
  if (name === "create_contact" || name === "update_contact") return { type: "contact", data: input };
  if (name === "mark_action") return { type: "action", data: input };
  if (name === "run_write_command") return { type: "command", data: input };
  if (name === "llm_wiki_add_source" || name === "llm_wiki_create_folder" || name === "llm_wiki_rescan_sources") {
    return { type: "source-write", data: input };
  }
  if (name === "llm_wiki_show_window" || name === "llm_wiki_hide_window") return { type: "operation", data: { operation: name } };
  return null;
}

/** Pick a card for a tool result, or null to fall back to raw JSON. */
export function cardForTool(tool: string, input: unknown, output: unknown): { type: string; data: unknown } | null {
  const name = bareName(tool);
  if (output && typeof output === "object" && !Array.isArray(output) && (output as Dict).error) return null;
  if (name === "read_message" && output && typeof output === "object") return { type: "email", data: output };
  if (name === "read_event" && output && typeof output === "object") return { type: "event", data: output };
  if (name === "search_events" && output && typeof output === "object") return { type: "events", data: output };
  if (name === "read_contact" && output && typeof output === "object") return { type: "contact", data: output };
  if (name === "search_contacts" && output && typeof output === "object") return { type: "contacts", data: output };
  if (name === "search_messages" && output && typeof output === "object" && !Array.isArray(output)) {
    const messages = (output as Dict).messages;
    if (Array.isArray(messages)) return { type: "search", data: messages };
  }
  if (name === "get_thread" && output && typeof output === "object" && !Array.isArray(output)) {
    const messages = (output as Dict).messages;
    if (Array.isArray(messages)) return { type: "search", data: messages };
  }
  if ((name === "search_messages" || name === "get_thread") && Array.isArray(output)) return { type: "search", data: output };
  if ((name === "create_event" || name === "update_event") && input && typeof input === "object") {
    const uid = (output as Dict)?.uid;
    return { type: "event", data: { ...(input as Dict), ...(uid ? { uid } : {}) } };
  }
  return null;
}
