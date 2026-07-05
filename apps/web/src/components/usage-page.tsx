/**
 * Usage page — the complete observability view over the shared LLM usage
 * ledger. Fetches the host's `/usage?days=` JSON (written by the gateway, one
 * row per LLM call, attributed per service/action) and renders totals, cost
 * by service / action / day / model, tool stats and recent calls. Hand-rolled
 * SVG, no charting dependency.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { authFetch } from "@/lib/auth";
import { cn } from "@/lib/utils";

interface Totals { calls: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }
interface ServiceRow { service: string; cost: number; calls: number; tokens: number }
interface ActionRow { service: string; action: string; calls: number; cost: number; tokens: number; avgCost: number }
interface DayRow { day: string; service: string; cost: number; calls: number; tokens: number }
interface ModelRow { model: string; cost: number; tokens: number; calls: number }
interface RecentRow {
  ts: number; service: string; action: string; model: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number; durationMs: number; ok: number;
}
interface ToolRow { tool: string; calls: number; errors: number; totalMs: number; avgMs: number; maxMs: number }
interface ToolTotals { calls: number; errors: number; totalMs: number }
interface CostByKind { input: number; output: number; cacheRead: number; cacheWrite: number }
interface UsageSummary {
  totals: Totals;
  byService: ServiceRow[];
  byAction: ActionRow[];
  byDay: DayRow[];
  byModel: ModelRow[];
  recent: RecentRow[];
  byTool: ToolRow[];
  toolTotals: ToolTotals;
  costByKind: CostByKind;
}

type Period = "7" | "30" | "all";
const PERIODS: { key: Period; label: string }[] = [
  { key: "7", label: "7 giorni" },
  { key: "30", label: "30 giorni" },
  { key: "all", label: "Tutto" },
];

/** The four token kinds, with display label and a stable color. */
const KINDS = [
  { key: "input", label: "Input", color: "#6366f1" },
  { key: "output", label: "Output", color: "#10b981" },
  { key: "cacheRead", label: "Cache read", color: "#f59e0b" },
  { key: "cacheWrite", label: "Cache write", color: "#ec4899" },
] as const;

/** Stable per-service colors (fallback palette for services not listed). */
const SERVICE_COLORS: Record<string, string> = {
  host: "#6366f1",
  "mail-promoter": "#10b981",
  "action-center": "#f59e0b",
  "mail-mirror": "#ec4899",
  "llm-wiki": "#8b5cf6",
  "mail-mcp": "#06b6d4",
  "calendar-mcp": "#84cc16",
  "contacts-mcp": "#f97316",
  unknown: "#ef4444",
};
const FALLBACK_COLORS = ["#14b8a6", "#a855f7", "#eab308", "#64748b"];
function serviceColor(service: string, index: number): string {
  return SERVICE_COLORS[service] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

const usd = (n: number) => `$${n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(4) : n.toFixed(6)}`;
const intl = (n: number) => Math.round(n).toLocaleString("it-IT");
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(Math.round(n));
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s` : `${Math.round(n)}ms`);
/** Strip the `mcp__server__` prefix so tool names read cleanly. */
const bareTool = (name: string) => name.replace(/^mcp__[^_]+__/, "") || name;
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function UsagePage({ httpBase, token, onUnauthorized }: { httpBase: string; token: string | null; onUnauthorized: () => void }) {
  const [period, setPeriod] = useState<Period>("30");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${httpBase}/usage?days=${period}`, token, onUnauthorized);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as UsageSummary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [httpBase, token, onUnauthorized, period]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="p-6">
        <p className="text-destructive text-sm">Impossibile caricare i costi: {error}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
          Riprova
        </Button>
      </div>
    );
  }
  if (!data) {
    return <div className="text-muted-foreground p-6 text-sm">{loading ? "Caricamento…" : "—"}</div>;
  }

  const t = data.totals;
  const totalTokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  const costToday = data.byDay.filter((d) => d.day === todayKey()).reduce((s, d) => s + d.cost, 0);
  const hasUnknown = data.byService.some((s) => s.service === "unknown");
  const costByKind = KINDS.map((k) => ({ ...k, tokens: t[k.key], cost: data.costByKind[k.key] }));

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Usage</h2>
          <p className="text-muted-foreground text-sm">
            Ogni chiamata LLM, per servizio e azione · {intl(t.calls)} chiamate nel periodo
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border">
            {PERIODS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={period === p.key ? "secondary" : "ghost"}
                className="rounded-none first:rounded-l-md last:rounded-r-md"
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? "…" : "Refresh"}
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Costo totale" value={usd(t.cost)} />
        <Stat label="Costo oggi" value={usd(costToday)} />
        <Stat label="Chiamate LLM" value={intl(t.calls)} />
        <Stat label="Token totali" value={compact(totalTokens)} sub={`${intl(totalTokens)} token`} />
      </div>

      {/* Cost by service */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Costo per servizio</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {hasUnknown && (
            <p className="text-destructive text-xs">
              ⚠ Sono presenti chiamate «unknown»: un chiamante non manda gli header di attribuzione.
            </p>
          )}
          {data.byService.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessuna chiamata nel periodo.</p>
          ) : (
            <>
              <StackedBar
                segments={data.byService.map((s, i) => ({ label: s.service, color: serviceColor(s.service, i), value: s.cost }))}
                format={usd}
              />
              <div className="space-y-2">
                {(() => {
                  const max = Math.max(...data.byService.map((s) => s.cost), 1e-9);
                  return data.byService.map((s, i) => (
                    <div key={s.service} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5 font-medium">
                          <span className="size-2.5 rounded-sm" style={{ background: serviceColor(s.service, i) }} />
                          {s.service}
                          {s.service === "unknown" && <Badge variant="destructive">da etichettare</Badge>}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {usd(s.cost)} · {intl(s.calls)} chiamate · {compact(s.tokens)} tok
                        </span>
                      </div>
                      <div className="bg-muted h-2 overflow-hidden rounded-full">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${(s.cost / max) * 100}%`, background: serviceColor(s.service, i) }}
                        />
                      </div>
                    </div>
                  ));
                })()}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Cost by action — the per-piece price list */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Costo per azione</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byAction.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessuna azione nel periodo.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <Th>Servizio</Th>
                    <Th>Azione</Th>
                    <Th right>Chiamate</Th>
                    <Th right>Token</Th>
                    <Th right>Costo medio / pezzo</Th>
                    <Th right>Costo totale</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.byAction.map((a) => (
                    <tr key={`${a.service}/${a.action}`} className="border-border border-t">
                      <Td className="font-medium">{a.service}</Td>
                      <Td className="font-mono">{a.action}</Td>
                      <Td right>{intl(a.calls)}</Td>
                      <Td right>{compact(a.tokens)}</Td>
                      <Td right>{usd(a.avgCost)}</Td>
                      <Td right className="font-medium">{usd(a.cost)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cost per day, stacked by service */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Costo per giorno</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byDay.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessun dato.</p>
          ) : (
            <StackedDayBars rows={data.byDay} serviceOrder={data.byService.map((s) => s.service)} />
          )}
        </CardContent>
      </Card>

      {/* Cost by token kind */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Costo per tipo di token</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <StackedBar segments={costByKind.map((k) => ({ label: k.label, color: k.color, value: k.cost }))} format={usd} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {costByKind.map((k) => (
              <div key={k.key} className="space-y-0.5">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="size-2.5 rounded-sm" style={{ background: k.color }} />
                  <span className="text-muted-foreground">{k.label}</span>
                </div>
                <div className="text-sm font-semibold tabular-nums">{usd(k.cost)}</div>
                <div className="text-muted-foreground text-xs tabular-nums">{compact(k.tokens)} tok</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Cost by model */}
      {data.byModel.length > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Costo per modello</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(() => {
              const max = Math.max(...data.byModel.map((m) => m.cost), 1e-9);
              return data.byModel.map((m) => (
                <div key={m.model} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{m.model || "—"}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {usd(m.cost)} · {compact(m.tokens)} tok · {intl(m.calls)} chiamate
                    </span>
                  </div>
                  <div className="bg-muted h-2 overflow-hidden rounded-full">
                    <div className="bg-primary h-full rounded-full" style={{ width: `${(m.cost / max) * 100}%` }} />
                  </div>
                </div>
              ));
            })()}
          </CardContent>
        </Card>
      )}

      {/* Tool usage (unchanged data source: host tool_calls) */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Tool</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byTool.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessuna invocazione registrata.</p>
          ) : (
            <>
              <div className="text-muted-foreground mb-3 flex gap-4 text-xs">
                <span><span className="text-foreground font-semibold tabular-nums">{intl(data.toolTotals.calls)}</span> chiamate</span>
                <span><span className="text-foreground font-semibold tabular-nums">{intl(data.toolTotals.errors)}</span> errori</span>
                <span><span className="text-foreground font-semibold tabular-nums">{ms(data.toolTotals.totalMs)}</span> totali</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <Th>Tool</Th>
                      <Th right>Chiamate</Th>
                      <Th right>Errori</Th>
                      <Th right>Media</Th>
                      <Th right>Max</Th>
                      <Th right>Totale</Th>
                      <Th>Frequenza</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const maxCalls = Math.max(...data.byTool.map((x) => x.calls), 1);
                      return data.byTool.map((x) => (
                        <tr key={x.tool} className="border-border border-t">
                          <Td className="font-mono">{bareTool(x.tool)}</Td>
                          <Td right>{intl(x.calls)}</Td>
                          <Td right className={x.errors > 0 ? "text-destructive font-medium" : ""}>{intl(x.errors)}</Td>
                          <Td right>{ms(x.avgMs)}</Td>
                          <Td right>{ms(x.maxMs)}</Td>
                          <Td right>{ms(x.totalMs)}</Td>
                          <Td>
                            <div className="bg-muted h-1.5 w-24 overflow-hidden rounded-full">
                              <div className="bg-primary h-full rounded-full" style={{ width: `${(x.calls / maxCalls) * 100}%` }} />
                            </div>
                          </Td>
                        </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Recent calls */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Chiamate recenti</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessuna chiamata registrata.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <Th>Quando</Th>
                    <Th>Servizio</Th>
                    <Th>Azione</Th>
                    <Th>Modello</Th>
                    <Th right>In</Th>
                    <Th right>Out</Th>
                    <Th right>Durata</Th>
                    <Th right>Costo</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r, i) => (
                    <tr key={i} className={cn("border-border border-t", r.ok === 0 && "text-destructive")}>
                      <Td>{formatTs(r.ts)}</Td>
                      <Td className="font-medium">{r.service}</Td>
                      <Td className="font-mono">{r.action}</Td>
                      <Td>
                        <Badge variant="outline">{r.model || "—"}</Badge>
                      </Td>
                      <Td right>{compact(r.input + r.cacheRead)}</Td>
                      <Td right>{compact(r.output)}</Td>
                      <Td right>{ms(r.durationMs)}</Td>
                      <Td right className="font-medium">{r.ok === 0 ? "errore" : usd(r.cost)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card size="sm">
      <CardContent className="p-4">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="text-muted-foreground mt-0.5 text-xs tabular-nums">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** Horizontal proportional bar split into colored segments. */
function StackedBar({
  segments,
  format,
}: {
  segments: { label: string; color: string; value: number }[];
  format: (n: number) => string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return <div className="bg-muted h-3 rounded-full" />;
  return (
    <div className="flex h-3 overflow-hidden rounded-full">
      {segments.map((s) => (
        <div
          key={s.label}
          className="h-full first:rounded-l-full last:rounded-r-full"
          style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
          title={`${s.label}: ${format(s.value)} (${((s.value / total) * 100).toFixed(1)}%)`}
        />
      ))}
    </div>
  );
}

/** Vertical bar chart (SVG) of per-day cost, stacked by service. */
function StackedDayBars({ rows, serviceOrder }: { rows: DayRow[]; serviceOrder: string[] }) {
  // rows arrive day DESC with one row per (day, service); pivot to day → segments.
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const byDay = new Map<string, DayRow[]>();
  for (const r of rows) {
    const list = byDay.get(r.day) ?? [];
    list.push(r);
    byDay.set(r.day, list);
  }
  const dayTotal = (d: string) => (byDay.get(d) ?? []).reduce((s, r) => s + r.cost, 0);
  const max = Math.max(...days.map(dayTotal), 1e-9);
  const w = Math.max(days.length * 36, 240);
  const h = 160;
  const pad = 24;
  const bw = Math.min(28, (w - pad) / days.length - 8);
  const colorFor = (service: string) => serviceColor(service, Math.max(0, serviceOrder.indexOf(service)));
  return (
    <div className="overflow-x-auto">
      <svg width={w} height={h} className="block" role="img" aria-label="Costo per giorno per servizio">
        {days.map((day, i) => {
          const x = pad + i * ((w - pad) / days.length);
          let y = h - 16;
          const segs = (byDay.get(day) ?? []).slice().sort((a, b) => b.cost - a.cost);
          return (
            <g key={day}>
              {segs.map((seg) => {
                const bh = ((h - pad - 16) * seg.cost) / max;
                y -= bh;
                return (
                  <rect key={seg.service} x={x} y={y} width={bw} height={Math.max(bh, 0.5)} rx={1.5} fill={colorFor(seg.service)}>
                    <title>{`${day} · ${seg.service}: ${usd(seg.cost)} · ${compact(seg.tokens)} tok · ${seg.calls} chiamate`}</title>
                  </rect>
                );
              })}
              <text x={x + bw / 2} y={h - 4} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                {day.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={cn("px-2 py-1.5 font-medium", right && "text-right")}>{children}</th>;
}
function Td({ children, right, className }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cn("px-2 py-1.5 tabular-nums", right && "text-right", className)}>{children}</td>;
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString("it-IT", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
