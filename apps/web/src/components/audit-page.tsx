import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { authFetch } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { currentLocale } from "@/lib/locale";

type AuditActor = "user" | "assistant" | "host" | "scheduler" | "tool" | "system";
type AuditRisk = "low" | "medium" | "high";

interface AuditEvent {
  id: number;
  ts: number;
  actor: AuditActor;
  eventType: string;
  risk: AuditRisk;
  summary: string;
  sessionId: string | null;
  chatId: string | null;
  actionId: number | null;
  toolName: string | null;
  toolCallId: string | null;
  correlationId: string | null;
  ok: boolean | null;
  durationMs: number | null;
  redactedPayloadJson: unknown;
  sourceRefs: { type: string; id?: string | number; url?: string; path?: string; label?: string }[];
}

interface AuditPagePayload {
  events: AuditEvent[];
  nextCursor: number | null;
  totals: { events: number; highRisk: number; failed: number };
  byType: { eventType: string; count: number }[];
  byActor: { actor: AuditActor; count: number }[];
}

const ACTORS: (AuditActor | "all")[] = ["all", "user", "assistant", "host", "tool", "system", "scheduler"];
const RISKS: (AuditRisk | "all")[] = ["all", "high", "medium", "low"];

export function AuditPage({ httpBase, token, onUnauthorized }: { httpBase: string; token: string | null; onUnauthorized: () => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<AuditPagePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [actor, setActor] = useState<AuditActor | "all">("all");
  const [risk, setRisk] = useState<AuditRisk | "all">("all");
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  const params = useMemo(() => {
    const p = new URLSearchParams({ limit: "150" });
    if (query.trim()) p.set("q", query.trim());
    if (actor !== "all") p.set("actor", actor);
    if (risk !== "all") p.set("risk", risk);
    return p;
  }, [actor, query, risk]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${httpBase}/audit?${params}`, token, onUnauthorized);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as AuditPagePayload;
      setData(body);
      setSelected((prev) => prev ? body.events.find((event) => event.id === prev.id) ?? body.events[0] ?? null : body.events[0] ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [httpBase, onUnauthorized, params, token]);

  useEffect(() => { void refresh(); }, [refresh]);

  const events = data?.events ?? [];
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("audit.title")}</h2>
          <p className="text-muted-foreground text-sm">{t("audit.subtitle")}</p>
        </div>
        <Button variant="outline" onClick={() => void refresh()} disabled={loading} title={t("audit.refreshTitle")}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          {t("audit.refresh")}
        </Button>
      </div>

      {error && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
          {t("audit.loadError", { error })}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <SummaryTile label={t("audit.stats.events")} value={data?.totals.events ?? 0} />
        <SummaryTile label={t("audit.stats.highRisk")} value={data?.totals.highRisk ?? 0} tone="high" />
        <SummaryTile label={t("audit.stats.failed")} value={data?.totals.failed ?? 0} tone="failed" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
          <Input className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("audit.search")} />
        </div>
        <Segmented values={ACTORS} value={actor} onChange={(v) => setActor(v as AuditActor | "all")} labelPrefix="audit.actors" />
        <Segmented values={RISKS} value={risk} onChange={(v) => setRisk(v as AuditRisk | "all")} labelPrefix="audit.risks" />
      </div>

      <div className="grid min-h-[30rem] gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Card className="min-h-0">
          <CardHeader>
            <CardTitle className="text-base">{t("audit.timeline")}</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 p-0">
            <div className="max-h-[65vh] overflow-y-auto p-2">
              {events.length === 0 ? (
                <p className="text-muted-foreground p-6 text-center text-sm">{loading ? t("audit.loading") : t("audit.empty")}</p>
              ) : events.map((event) => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => setSelected(event)}
                  className={cn(
                    "hover:bg-muted grid w-full grid-cols-[6.5rem_minmax(0,1fr)] gap-3 rounded-md px-3 py-2 text-left transition",
                    selected?.id === event.id && "bg-muted",
                  )}
                >
                  <div className="text-muted-foreground text-xs tabular-nums">{formatTime(event.ts)}</div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={event.risk === "high" ? "destructive" : event.risk === "medium" ? "secondary" : "outline"}>
                        {t(`audit.risks.${event.risk}`)}
                      </Badge>
                      <Badge variant="outline">{t(`audit.actors.${event.actor}`)}</Badge>
                      {event.ok === false && <Badge variant="destructive">{t("audit.failed")}</Badge>}
                      <span className="text-muted-foreground truncate text-xs">{event.eventType}</span>
                    </div>
                    <div className="mt-1 truncate text-sm font-medium">{event.summary}</div>
                    <div className="text-muted-foreground mt-0.5 truncate text-xs">
                      {event.toolName || event.chatId || (event.actionId != null ? `action ${event.actionId}` : event.correlationId)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="min-h-0">
          <CardHeader>
            <CardTitle className="text-base">{t("audit.detail")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {selected ? (
              <>
                <div className="space-y-1">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant={selected.risk === "high" ? "destructive" : selected.risk === "medium" ? "secondary" : "outline"}>{t(`audit.risks.${selected.risk}`)}</Badge>
                    <Badge variant="outline">{t(`audit.actors.${selected.actor}`)}</Badge>
                    {selected.ok === false && <Badge variant="destructive">{t("audit.failed")}</Badge>}
                  </div>
                  <h3 className="text-sm font-semibold">{selected.summary}</h3>
                  <p className="text-muted-foreground text-xs">{formatDateTime(selected.ts)} · {selected.eventType}</p>
                </div>
                <MetaGrid event={selected} />
                {selected.sourceRefs.length > 0 && (
                  <div>
                    <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{t("audit.sources")}</h4>
                    <div className="space-y-1">
                      {selected.sourceRefs.map((ref, i) => (
                        <div key={i} className="bg-muted/50 rounded px-2 py-1 text-xs">
                          <span className="font-medium">{ref.type}</span>{" "}
                          <span className="text-muted-foreground">{ref.label || ref.path || ref.url || ref.id}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{t("audit.payload")}</h4>
                  <pre className="bg-muted max-h-[24rem] overflow-auto rounded-md p-3 text-xs">
                    {JSON.stringify(selected.redactedPayloadJson, null, 2)}
                  </pre>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">{t("audit.noSelection")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone?: "high" | "failed" }) {
  return (
    <Card size="sm">
      <CardContent className="py-4">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "high" && "text-amber-600", tone === "failed" && "text-destructive")}>
          {value.toLocaleString(currentLocale())}
        </div>
      </CardContent>
    </Card>
  );
}

function Segmented({ values, value, onChange, labelPrefix }: { values: string[]; value: string; onChange: (value: string) => void; labelPrefix: string }) {
  const { t } = useTranslation();
  return (
    <div className="bg-muted flex rounded-md p-0.5">
      {values.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            "rounded px-2.5 py-1 text-xs transition",
            value === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`${labelPrefix}.${v}`)}
        </button>
      ))}
    </div>
  );
}

function MetaGrid({ event }: { event: AuditEvent }) {
  const rows = [
    ["session", event.sessionId],
    ["chat", event.chatId],
    ["action", event.actionId],
    ["tool", event.toolName],
    ["tool call", event.toolCallId],
    ["correlation", event.correlationId],
    ["duration", event.durationMs == null ? null : `${event.durationMs} ms`],
  ].filter(([, value]) => value != null && value !== "");
  if (!rows.length) return null;
  return (
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="truncate font-mono">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "medium" });
}
