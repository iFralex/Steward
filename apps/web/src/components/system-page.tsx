import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Power, RefreshCw, Smartphone, XCircle } from "lucide-react";
import QRCode from "qrcode";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authFetch } from "@/lib/auth";
import { enablePush, pushSubscribed, type EnablePushResult } from "@/lib/push";
import { cn } from "@/lib/utils";

type ServiceState = "ok" | "warning" | "error" | "unknown";

interface SystemServiceStatus {
  id: string;
  label: string;
  state: ServiceState;
  detail?: string;
  checks?: SystemServiceCheck[];
  tools?: number;
  updatedAt: number;
}

interface SystemServiceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  label: string;
  plistPath: string;
  appPath: string | null;
  detail?: string;
}

interface SystemStatus {
  generatedAt: number;
  bundled: boolean;
  autostart: AutostartStatus;
  services: SystemServiceStatus[];
}

export function SystemPage({ httpBase, token, onUnauthorized }: { httpBase: string; token: string | null; onUnauthorized: () => void }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingAutostart, setSavingAutostart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairToken, setPairToken] = useState<string | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<EnablePushResult | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${httpBase}/system/status`, token, onUnauthorized);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json() as SystemStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [httpBase, token, onUnauthorized]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // /pair is localhost-only (403 from a phone/Tailscale caller) — that's expected,
  // it just means the "Connetti il telefono" section stays hidden there.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`${httpBase}/pair`);
        if (res.ok && alive) {
          const body = (await res.json()) as { token: string };
          setPairToken(body.token);
        }
      } catch {
        /* host unreachable — leave the pairing section hidden */
      }
    })();
    return () => { alive = false; };
  }, [httpBase]);

  useEffect(() => { void pushSubscribed().then(setPushOn); }, []);

  const turnOnNotifications = async () => {
    setPushBusy(true);
    setPushMsg(null);
    const r = await enablePush(httpBase, token, onUnauthorized);
    setPushMsg(r);
    if (r === "ok") setPushOn(true);
    setPushBusy(false);
  };

  const setAutostart = async (enabled: boolean) => {
    setSavingAutostart(true);
    setError(null);
    try {
      const res = await authFetch(`${httpBase}/system/autostart`, token, onUnauthorized, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = await res.json() as AutostartStatus | { error?: string };
      if (!res.ok) throw new Error("error" in body && body.error ? body.error : `HTTP ${res.status}`);
      setStatus((prev) => prev ? { ...prev, autostart: body as AutostartStatus } : prev);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAutostart(false);
    }
  };

  const counts = countStates(status?.services ?? []);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">System</h2>
          <p className="text-muted-foreground text-sm">Servizi locali, tool MCP e avvio al login.</p>
        </div>
        <Button variant="outline" onClick={() => void refresh()} disabled={loading} title="Aggiorna stato">
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_1.35fr]">
        <SummaryTile label="OK" value={counts.ok} state="ok" />
        <SummaryTile label="Warning" value={counts.warning} state="warning" />
        <SummaryTile label="Error" value={counts.error} state="error" />
        <AutostartPanel
          autostart={status?.autostart ?? null}
          bundled={status?.bundled ?? false}
          busy={savingAutostart}
          onToggle={setAutostart}
        />
      </div>

      {pairToken && <PairingPanel token={pairToken} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Smartphone className="size-4" /> Notifiche push
          </CardTitle>
          <CardDescription>
            Ricevi una notifica quando c'è una proposta da approvare, anche ad app chiusa. Su iPhone: aggiungi prima Steward alla schermata Home.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void turnOnNotifications()} disabled={pushBusy || pushOn}>
            {pushOn ? "Notifiche attive ✓" : pushBusy ? "Attivazione…" : "Attiva notifiche"}
          </Button>
          {pushMsg && pushMsg !== "ok" && (
            <span className="text-muted-foreground text-sm">
              {pushMsg === "denied"
                ? "Permesso negato — abilitalo nelle impostazioni del browser."
                : pushMsg === "unsupported"
                  ? "Questo browser non supporta le notifiche push (su iPhone serve iOS 16.4+ e l'app in Home)."
                  : "Attivazione non riuscita — riprova."}
            </span>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(status?.services ?? []).map((service) => (
          <ServiceRow key={service.id} service={service} />
        ))}
        {!status && !error && (
          <Card className="md:col-span-2 xl:col-span-3">
            <CardContent className="text-muted-foreground py-8 text-center text-sm">
              Caricamento stato servizi...
            </CardContent>
          </Card>
        )}
      </div>

      {status && (
        <p className="text-muted-foreground text-xs">
          Ultimo aggiornamento: {new Date(status.generatedAt).toLocaleTimeString("it-IT")}.
        </p>
      )}
    </div>
  );
}

function SummaryTile({ label, value, state }: { label: string; value: number; state: ServiceState }) {
  return (
    <Card size="sm">
      <CardContent className="flex items-center justify-between">
        <div>
          <div className="text-muted-foreground text-xs">{label}</div>
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
        </div>
        <StateIcon state={state} />
      </CardContent>
    </Card>
  );
}

/** Pairing QR for a phone: /pair (localhost-only) hands us the token; the QR
 *  encodes this page's own origin (works over Tailscale too — it's whatever
 *  origin served this page) with ?token= so the phone auto-pairs on scan. */
function PairingPanel({ token }: { token: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const pairUrl = `${window.location.origin}/?token=${encodeURIComponent(token)}`;
  const canceledRef = useRef(false);

  useEffect(() => {
    canceledRef.current = false;
    void QRCode.toDataURL(pairUrl, { margin: 1, width: 220 }).then((dataUrl) => {
      if (!canceledRef.current) setQr(dataUrl);
    }).catch(() => setQr(null));
    return () => { canceledRef.current = true; };
  }, [pairUrl]);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-4" />
          Connetti il telefono
        </CardTitle>
        <CardDescription>Scansiona dal telefono (stessa rete Tailscale) per collegarlo.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        {qr && <img src={qr} alt="QR di pairing" className="size-[110px] rounded-md border bg-white p-1" />}
        <p className="text-muted-foreground min-w-0 flex-1 break-all font-mono text-xs">{pairUrl}</p>
      </CardContent>
    </Card>
  );
}

function AutostartPanel({
  autostart,
  bundled,
  busy,
  onToggle,
}: {
  autostart: AutostartStatus | null;
  bundled: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void | Promise<void>;
}) {
  const enabled = autostart?.enabled ?? false;
  const canToggle = !!autostart?.supported && !!autostart?.appPath;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Power className="size-4" />
          Avvio al login
        </CardTitle>
        <CardDescription>{bundled ? "Bundle production" : "Ambiente dev"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Badge variant={enabled ? "default" : "outline"}>{enabled ? "attivo" : "disattivo"}</Badge>
          <Button
            size="sm"
            variant={enabled ? "outline" : "default"}
            disabled={!canToggle || busy}
            onClick={() => void onToggle(!enabled)}
          >
            {busy ? "Salvo..." : enabled ? "Disattiva" : "Attiva"}
          </Button>
        </div>
        <p className="text-muted-foreground break-words text-xs">
          {autostart?.appPath ?? "Path app non disponibile."}
        </p>
        {autostart?.detail && <p className="text-destructive text-xs">{autostart.detail}</p>}
      </CardContent>
    </Card>
  );
}

function ServiceRow({ service }: { service: SystemServiceStatus }) {
  return (
    <Card size="sm">
      <CardHeader className="grid-cols-[auto_1fr_auto]">
        <StateIcon state={service.state} />
        <div className="min-w-0">
          <CardTitle className="truncate">{service.label}</CardTitle>
          <CardDescription className="truncate">{service.detail ?? "No detail"}</CardDescription>
        </div>
        <Badge variant={badgeVariant(service.state)}>{service.state}</Badge>
      </CardHeader>
      {service.checks && service.checks.length > 0 && (
        <CardContent className="space-y-1.5 pt-0">
          {service.checks.map((check) => (
            <div key={check.name} className="flex items-center gap-2 text-xs">
              {check.ok ? (
                <CheckCircle2 className="text-emerald-600 size-3.5 shrink-0" />
              ) : (
                <XCircle className="text-destructive size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{check.name}</span>
              {check.detail && <span className="text-muted-foreground max-w-[45%] truncate text-right">{check.detail}</span>}
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function StateIcon({ state }: { state: ServiceState }) {
  if (state === "ok") return <CheckCircle2 className="text-emerald-600 size-4" />;
  if (state === "warning") return <AlertTriangle className="text-amber-600 size-4" />;
  if (state === "error") return <XCircle className="text-destructive size-4" />;
  return <AlertTriangle className="text-muted-foreground size-4" />;
}

function badgeVariant(state: ServiceState): "default" | "destructive" | "outline" | "secondary" {
  if (state === "ok") return "default";
  if (state === "error") return "destructive";
  if (state === "warning") return "secondary";
  return "outline";
}

function countStates(services: SystemServiceStatus[]) {
  return services.reduce(
    (acc, service) => {
      if (service.state === "ok") acc.ok++;
      else if (service.state === "error") acc.error++;
      else acc.warning++;
      return acc;
    },
    { ok: 0, warning: 0, error: 0 },
  );
}
