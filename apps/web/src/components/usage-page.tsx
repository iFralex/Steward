/**
 * Usage page — granular cost & token analytics for the agent. Fetches the
 * host's `/usage` JSON (persistent per-turn ledger) and renders summary cards,
 * SVG charts (cost/day, token + cost split by type, cost by model), and a
 * recent-turns table. No charting dependency — hand-rolled SVG (disk-friendly).
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Totals {
  turns: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
interface DayRow {
  day: string;
  cost: number;
  tokens: number;
  turns: number;
}
interface ModelRow {
  model: string;
  cost: number;
  tokens: number;
  turns: number;
}
interface TurnRow {
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
interface UsageSummary {
  totals: Totals;
  byDay: DayRow[];
  byModel: ModelRow[];
  recent: TurnRow[];
  rates: Rates;
}

/** The four token kinds, with display label and a stable color. */
const KINDS = [
  { key: "input", label: "Input", color: "#6366f1" },
  { key: "output", label: "Output", color: "#10b981" },
  { key: "cacheRead", label: "Cache read", color: "#f59e0b" },
  { key: "cacheWrite", label: "Cache write", color: "#ec4899" },
] as const;

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const intl = (n: number) => Math.round(n).toLocaleString("it-IT");
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(Math.round(n));

export function UsagePage({ httpBase }: { httpBase: string }) {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${httpBase}/usage`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as UsageSummary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [httpBase]);

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
  const avgCost = t.turns ? t.cost / t.turns : 0;
  // Cost attributed to each token kind = tokens / 1e6 × rate (rates are per 1M tokens).
  const costByKind = KINDS.map((k) => ({
    ...k,
    tokens: t[k.key],
    cost: (t[k.key] / 1_000_000) * data.rates[k.key],
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Usage</h2>
          <p className="text-muted-foreground text-sm">
            Costi e token per turno · {intl(t.turns)} turni registrati
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? "…" : "Refresh"}
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Costo totale" value={usd(t.cost)} />
        <Stat label="Token totali" value={compact(totalTokens)} sub={`${intl(totalTokens)} token`} />
        <Stat label="Turni" value={intl(t.turns)} />
        <Stat label="Costo medio / turno" value={usd(avgCost)} />
      </div>

      {/* Cost by token type */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Costo per tipo di token</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <StackedBar
            segments={costByKind.map((k) => ({ label: k.label, color: k.color, value: k.cost }))}
            format={usd}
          />
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

      {/* Cost per day */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Costo per giorno</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byDay.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessun dato.</p>
          ) : (
            <DayBars rows={[...data.byDay].reverse()} />
          )}
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
                    <span className="font-medium">{m.model}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {usd(m.cost)} · {compact(m.tokens)} tok · {intl(m.turns)} turni
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

      {/* Recent turns */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Turni recenti</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nessun turno registrato.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <Th>Quando</Th>
                    <Th>Modello</Th>
                    <Th right>In</Th>
                    <Th right>Out</Th>
                    <Th right>Cache R</Th>
                    <Th right>Cache W</Th>
                    <Th right>Costo</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r, i) => (
                    <tr key={i} className="border-border border-t">
                      <Td>{formatTs(r.ts)}</Td>
                      <Td>
                        <Badge variant="outline">{r.model}</Badge>
                      </Td>
                      <Td right>{compact(r.input)}</Td>
                      <Td right>{compact(r.output)}</Td>
                      <Td right>{compact(r.cacheRead)}</Td>
                      <Td right>{compact(r.cacheWrite)}</Td>
                      <Td right className="font-medium">{usd(r.cost)}</Td>
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

/** Vertical bar chart of per-day cost (SVG), with token-split stacking. */
function DayBars({ rows }: { rows: DayRow[] }) {
  const max = Math.max(...rows.map((r) => r.cost), 1e-9);
  const w = Math.max(rows.length * 36, 240);
  const h = 160;
  const pad = 24;
  const bw = Math.min(28, (w - pad) / rows.length - 8);
  return (
    <div className="overflow-x-auto">
      <svg width={w} height={h} className="block" role="img" aria-label="Costo per giorno">
        {rows.map((r, i) => {
          const x = pad + i * ((w - pad) / rows.length);
          const bh = ((h - pad - 16) * r.cost) / max;
          const y = h - 16 - bh;
          return (
            <g key={r.day}>
              <rect x={x} y={y} width={bw} height={Math.max(bh, 1)} rx={3} className="fill-primary">
                <title>{`${r.day}: ${usd(r.cost)} · ${compact(r.tokens)} tok · ${r.turns} turni`}</title>
              </rect>
              <text x={x + bw / 2} y={h - 4} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                {r.day.slice(5)}
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
