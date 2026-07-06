/**
 * Renders one tool invocation in the chat: a collapsed-by-default accordion row
 * showing icon · namespace · tool, a one-line summary, duration and status;
 * expanded it shows the Input and Output (markdown for text, pretty JSON for
 * objects). The summary is derived client-side from the output — no token cost.
 */
import { type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import { FileChip } from "@/components/file-chip";
import { CardView, cardForTool, type FileApi } from "@/components/cards";
import type { ChatMessage } from "@/lib/host-socket";

const NS_ICON: Record<string, string> = { mail: "✉️", calendar: "📅", contacts: "👤", "llm-wiki": "📚" };

function parseToolName(raw: string): { icon: string; label: string } {
  const parts = raw.split("__");
  if (parts[0] === "mcp" && parts.length >= 3) {
    const ns = parts[1];
    return { icon: NS_ICON[ns] ?? "🔧", label: `${ns} · ${parts.slice(2).join("__")}` };
  }
  if (raw === "ask_user") return { icon: "❓", label: "ask_user" };
  return { icon: "🔧", label: raw };
}

function bareName(raw: string): string {
  const parts = raw.split("__");
  return parts[0] === "mcp" && parts.length >= 3 ? parts.slice(2).join("__") : raw;
}

/** One-line summary derived client-side from the tool output (no extra tokens). */
function toolSummary(rawTool: string, output: unknown, t: TFunction): string {
  if (output == null) return "";
  if (Array.isArray(output)) return t("toolCard.results", { count: output.length });
  if (typeof output !== "object") return "";
  const o = output as Record<string, unknown>;
  const name = bareName(rawTool);
  if (o.error) return t("toolCard.error");
  if (name.includes("reply") || name.includes("send")) return o.sent ? t("toolCard.sent") : "";
  if (name === "create_event") return o.uid ? t("toolCard.eventCreated") : "";
  if (name === "update_event") return t("toolCard.eventUpdated");
  if (name === "delete_event") return t("toolCard.eventDeleted");
  if (name === "read_message" && typeof o.subject === "string") return o.subject;
  if (typeof o.path === "string") return o.path.split("/").pop() ?? "";
  if (typeof o.uid === "string") return o.uid;
  return "";
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function StatusDot({ status }: { status?: ChatMessage["toolStatus"] }) {
  const { t } = useTranslation();
  if (status === "running") {
    return <span className="border-muted-foreground/40 border-t-foreground size-3 animate-spin rounded-full border-2" aria-label={t("toolCard.statusRunning")} />;
  }
  if (status === "error") return <span className="text-destructive" aria-label={t("toolCard.statusError")}>✗</span>;
  return <span className="text-emerald-600 dark:text-emerald-400" aria-label={t("toolCard.statusOk")}>✓</span>;
}

function JsonBlock({ value, tone }: { value: unknown; tone?: "error" }) {
  let text: string;
  try { text = typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch { text = String(value); }
  return (
    <pre className={cn("bg-background/70 max-h-72 overflow-auto rounded-md p-2 text-xs", tone === "error" && "text-destructive")}>
      {text}
    </pre>
  );
}

function OutputBlock({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return (
      <div className="text-xs leading-relaxed [&_p]:mb-1 [&_p:last-child]:mb-0">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
      </div>
    );
  }
  return <JsonBlock value={value} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-muted-foreground mb-1 text-[10px] font-semibold tracking-wide uppercase">{title}</div>
      {children}
    </div>
  );
}

export function ToolCard({ m, fileApi }: { m: ChatMessage; fileApi: FileApi }) {
  const { t } = useTranslation();
  const { icon, label } = parseToolName(m.text);
  const running = m.toolStatus === "running";
  const error = m.toolStatus === "error";
  const summary = error ? (m.toolError ? m.toolError.slice(0, 80) : t("toolCard.error")) : toolSummary(m.text, m.toolOutput, t);
  const duration = m.toolDurationMs != null ? formatDuration(m.toolDurationMs) : null;

  return (
    <div className={cn("rounded-md border text-xs", error ? "border-destructive/40" : "border-border")}>
      <Accordion>
        <AccordionItem value={m.id} className="border-0">
          <AccordionTrigger className="px-2 py-1.5 no-underline hover:no-underline">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0">{icon}</span>
              <span className="truncate font-mono font-medium">{label}</span>
              <span className="text-muted-foreground ml-auto flex items-center gap-2 pr-1 font-normal">
                {summary && <span className="max-w-[180px] truncate">{summary}</span>}
                {duration && <span className="tabular-nums">{duration}</span>}
                <StatusDot status={m.toolStatus} />
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-2 pb-2">
            <div className="space-y-2">
              <Section title={t("toolCard.input")}><JsonBlock value={m.toolInput} /></Section>
              {!running && (
                <Section title={error ? t("toolCard.error") : t("toolCard.output")}>
                  {error ? (
                    <JsonBlock value={m.toolError} tone="error" />
                  ) : (() => {
                    const card = cardForTool(m.text, m.toolInput, m.toolOutput);
                    return card
                      ? <CardView type={card.type} data={card.data} files={m.toolFiles} fileApi={fileApi} />
                      : <OutputBlock value={m.toolOutput} />;
                  })()}
                </Section>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      {m.toolFiles && m.toolFiles.length > 0 && (
        <div className="flex flex-col gap-1 border-t px-2 py-2">
          {m.toolFiles.map((f) => (
            <FileChip key={f.token} file={f} onOpen={fileApi.open} onReveal={fileApi.reveal} />
          ))}
        </div>
      )}
    </div>
  );
}
