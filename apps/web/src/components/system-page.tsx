import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Globe, ListChecks, PhoneCall, Power, RefreshCw, Smartphone, XCircle } from "lucide-react";
import QRCode from "qrcode";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authFetch } from "@/lib/auth";
import { enablePush, pushSubscribed, type EnablePushResult } from "@/lib/push";
import { cn } from "@/lib/utils";
import { currentLocale } from "@/lib/locale";
import i18n, { type Lang } from "@/i18n";

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

interface ActionAutomationSettings {
  enabled: boolean;
  enabledAt: number | null;
  updatedAt: number | null;
}

interface VoiceChannelStatus {
  enabled: boolean;
  transport: "disabled" | "ringback" | "streamcore";
  state: "disabled" | "idle" | "preflighting" | "starting" | "ringing" | "connected" | "speaking" | "listening" | "processing" | "ending" | "failed";
  chatId?: string;
  requestId?: string;
  startedAt?: number;
  updatedAt: number;
  detail?: string;
  retryable?: boolean;
  lastCall?: { chatId: string; requestId: string; startedAt: number; finishedAt: number; ok: boolean; error?: string };
}

interface VoiceSettings {
  rateWpm: number;
  voice: string;
  language: "en" | "it";
  availableVoices: Array<{ name: string; locale: string }>;
}

export function SystemPage({ httpBase, token, onUnauthorized }: { httpBase: string; token: string | null; onUnauthorized: () => void }) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingAutostart, setSavingAutostart] = useState(false);
  const [actionAutomation, setActionAutomation] = useState<ActionAutomationSettings | null>(null);
  const [savingActionAutomation, setSavingActionAutomation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairToken, setPairToken] = useState<string | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<EnablePushResult | null>(null);
  const [pushTest, setPushTest] = useState<"idle" | "scheduled" | "error">("idle");
  const [voice, setVoice] = useState<VoiceChannelStatus | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);
  const [voiceSettings, setVoiceSettingsState] = useState<VoiceSettings | null>(null);
  const [voiceRate, setVoiceRate] = useState(175);
  const [voiceName, setVoiceName] = useState<VoiceSettings["voice"]>("auto");
  const [voiceSettingsBusy, setVoiceSettingsBusy] = useState(false);
  const voiceRequestId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, actionsRes, voiceRes, voiceSettingsRes] = await Promise.all([
        authFetch(`${httpBase}/system/status`, token, onUnauthorized),
        authFetch(`${httpBase}/settings/actions`, token, onUnauthorized),
        authFetch(`${httpBase}/voice/status`, token, onUnauthorized),
        authFetch(`${httpBase}/settings/voice`, token, onUnauthorized),
      ]);
      if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
      if (!actionsRes.ok) throw new Error(`HTTP ${actionsRes.status}`);
      if (!voiceRes.ok) throw new Error(`HTTP ${voiceRes.status}`);
      if (!voiceSettingsRes.ok) throw new Error(`HTTP ${voiceSettingsRes.status}`);
      setStatus(await statusRes.json() as SystemStatus);
      setActionAutomation(await actionsRes.json() as ActionAutomationSettings);
      setVoice(await voiceRes.json() as VoiceChannelStatus);
      const speech = await voiceSettingsRes.json() as VoiceSettings;
      setVoiceSettingsState(speech);
      setVoiceRate(speech.rateWpm);
      setVoiceName(speech.voice);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [httpBase, token, onUnauthorized, i18n.resolvedLanguage]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // A call changes phase much faster than the general 30-second system poll.
  // Poll only while a call is moving so the PWA shows ringing/listening/etc.
  useEffect(() => {
    if (!voice?.enabled || voice.state === "idle" || voice.state === "disabled") return;
    const poll = async () => {
      try {
        const res = await authFetch(`${httpBase}/voice/status`, token, onUnauthorized);
        if (res.ok) setVoice(await res.json() as VoiceChannelStatus);
      } catch { /* the general refresh will surface persistent host errors */ }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => window.clearInterval(timer);
  }, [httpBase, token, onUnauthorized, voice?.enabled, voice?.state]);

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

  const sendTestPush = async () => {
    try {
      const res = await authFetch(`${httpBase}/push/test`, token, onUnauthorized, { method: "POST" });
      setPushTest(res.ok ? "scheduled" : "error");
    } catch {
      setPushTest("error");
    }
    // Let the state be re-triggered after the notification should have landed.
    window.setTimeout(() => setPushTest("idle"), 20_000);
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

  const setActionsEnabled = async (enabled: boolean) => {
    setSavingActionAutomation(true);
    setError(null);
    try {
      const res = await authFetch(`${httpBase}/settings/actions`, token, onUnauthorized, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = await res.json() as ActionAutomationSettings | { error?: string };
      if (!res.ok) throw new Error("error" in body && body.error ? body.error : `HTTP ${res.status}`);
      setActionAutomation(body as ActionAutomationSettings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingActionAutomation(false);
    }
  };

  const startVoiceCall = async () => {
    setVoiceBusy(true);
    setVoiceMessage(null);
    const requestId = voiceRequestId.current ?? crypto.randomUUID();
    voiceRequestId.current = requestId;
    try {
      const res = await authFetch(`${httpBase}/voice/call`, token, onUnauthorized, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      voiceRequestId.current = null;
      setVoiceMessage(t("system.voice.started"));
      void refresh();
    } catch (err) {
      setVoiceMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setVoiceBusy(false);
    }
  };

  const saveVoiceSettings = async () => {
    setVoiceSettingsBusy(true);
    setVoiceMessage(null);
    try {
      const res = await authFetch(`${httpBase}/settings/voice`, token, onUnauthorized, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rateWpm: voiceRate, voice: voiceName }),
      });
      const body = await res.json() as VoiceSettings | { error?: string };
      if (!res.ok) throw new Error("error" in body && body.error ? body.error : `HTTP ${res.status}`);
      setVoiceSettingsState(body as VoiceSettings);
      setVoiceMessage(t("system.voice.settingsSaved"));
    } catch (err) {
      setVoiceMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setVoiceSettingsBusy(false);
    }
  };

  const counts = countStates(status?.services ?? []);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("system.title")}</h2>
          <p className="text-muted-foreground text-sm">{t("system.subtitle")}</p>
        </div>
        <Button variant="outline" onClick={() => void refresh()} disabled={loading} title={t("system.refreshTitle")}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          {t("system.refresh")}
        </Button>
      </div>

      {error && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_1.35fr]">
        <SummaryTile label={t("system.summary.ok")} value={counts.ok} state="ok" />
        <SummaryTile label={t("system.summary.warning")} value={counts.warning} state="warning" />
        <SummaryTile label={t("system.summary.error")} value={counts.error} state="error" />
        <AutostartPanel
          autostart={status?.autostart ?? null}
          bundled={status?.bundled ?? false}
          busy={savingAutostart}
          onToggle={setAutostart}
        />
      </div>

      <LanguageCard httpBase={httpBase} token={token} onUnauthorized={onUnauthorized} />

      <ActionsAutomationCard
        settings={actionAutomation}
        busy={savingActionAutomation}
        onToggle={setActionsEnabled}
      />

      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PhoneCall className="size-4" />
            {t("system.voice.title")}
          </CardTitle>
          <CardDescription>{t("system.voice.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={voice?.enabled ? "default" : "outline"}>
              {voice?.transport ?? "disabled"} · {t(`system.voice.states.${voice?.state ?? "disabled"}`)}
            </Badge>
            <Button
              size="sm"
              disabled={!voice?.enabled || voice.state !== "idle" || voiceBusy}
              onClick={() => void startVoiceCall()}
            >
              {voiceBusy ? t("system.voice.starting") : t("system.voice.call")}
            </Button>
            {(voiceMessage || voice?.detail) && (
              <span className="text-muted-foreground text-sm">{voiceMessage ?? voice?.detail}</span>
            )}
          </div>
          <div className="grid gap-3 border-t pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{t("system.voice.rate")}</span>
              <input
                className="border-input bg-background h-9 rounded-md border px-3"
                type="number" min={100} max={300} step={5} value={voiceRate}
                onChange={(event) => setVoiceRate(Number(event.target.value))}
              />
              <span className="text-muted-foreground text-xs">{t("system.voice.rateHint")}</span>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{t("system.voice.defaultVoice")}</span>
              <select
                className="border-input bg-background h-9 rounded-md border px-3"
                value={voiceName}
                onChange={(event) => setVoiceName(event.target.value)}
              >
                <option value="auto">{t("system.voice.voiceAuto")}</option>
                {voiceSettings?.availableVoices.map((systemVoice) => (
                  <option key={`${systemVoice.locale}:${systemVoice.name}`} value={systemVoice.name}>
                    {systemVoice.name} · {systemVoice.locale.replace("_", "-")}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground text-xs">{t("system.voice.voiceHint")}</span>
            </label>
            <Button
              size="sm" disabled={!voiceSettings || voiceSettingsBusy || voiceRate < 100 || voiceRate > 300}
              onClick={() => void saveVoiceSettings()}
            >
              {voiceSettingsBusy ? t("system.voice.saving") : t("system.voice.saveSettings")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {pairToken && <PairingPanel token={pairToken} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Smartphone className="size-4" /> {t("system.push.title")}
          </CardTitle>
          <CardDescription>
            {t("system.push.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void turnOnNotifications()} disabled={pushBusy || pushOn}>
            {pushOn ? t("system.push.on") : pushBusy ? t("system.push.enabling") : t("system.push.enable")}
          </Button>
          {pushOn && (
            <Button variant="outline" onClick={() => void sendTestPush()} disabled={pushTest === "scheduled"}>
              {pushTest === "scheduled" ? t("system.push.testArriving") : t("system.push.testSend")}
            </Button>
          )}
          {pushTest === "scheduled" && (
            <span className="text-muted-foreground text-sm">{t("system.push.testHint")}</span>
          )}
          {pushTest === "error" && (
            <span className="text-destructive text-sm">{t("system.push.testError")}</span>
          )}
          {pushMsg && pushMsg !== "ok" && (
            <span className="text-muted-foreground text-sm">
              {pushMsg === "denied"
                ? t("system.push.msgDenied")
                : pushMsg === "insecure-context"
                  ? t("system.push.msgInsecure")
                  : pushMsg === "needs-home-screen"
                    ? t("system.push.msgNeedsHomeScreen")
                    : pushMsg === "unsupported"
                      ? t("system.push.msgUnsupported")
                      : t("system.push.msgError")}
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
              {t("system.servicesLoading")}
            </CardContent>
          </Card>
        )}
      </div>

      {status && (
        <p className="text-muted-foreground text-xs">
          {t("system.lastUpdated", { time: new Date(status.generatedAt).toLocaleTimeString(currentLocale()) })}
        </p>
      )}
    </div>
  );
}

function ActionsAutomationCard({
  settings,
  busy,
  onToggle,
}: {
  settings: ActionAutomationSettings | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = settings?.enabled ?? true;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="size-4" />
          {t("system.actionsAutomation.title")}
        </CardTitle>
        <CardDescription>{t("system.actionsAutomation.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-3">
        <Badge variant={enabled ? "default" : "outline"}>
          {enabled ? t("system.actionsAutomation.on") : t("system.actionsAutomation.off")}
        </Badge>
        <Button
          size="sm"
          variant={enabled ? "outline" : "default"}
          disabled={!settings || busy}
          onClick={() => void onToggle(!enabled)}
        >
          {busy
            ? t("system.actionsAutomation.saving")
            : enabled
              ? t("system.actionsAutomation.disable")
              : t("system.actionsAutomation.enable")}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Also pushes the choice to the host so server-generated push-notification
 *  copy (test/new-chat/reply) follows it — best-effort, the UI language switch
 *  itself doesn't depend on the host being reachable. */
function LanguageCard({ httpBase, token, onUnauthorized }: { httpBase: string; token: string | null; onUnauthorized: () => void }) {
  const { t, i18n: i18nInstance } = useTranslation();
  const current = i18nInstance.language === "it" ? "it" : "en";
  const setLang = (lang: Lang) => {
    void i18n.changeLanguage(lang);
    void authFetch(`${httpBase}/settings/user-lang`, token, onUnauthorized, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lang }),
    }).catch(() => { /* best-effort — UI language switch doesn't depend on the host */ });
  };
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-4" />
          {t("system.language.title")}
        </CardTitle>
        <CardDescription>{t("system.language.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button size="sm" variant={current === "en" ? "default" : "outline"} onClick={() => setLang("en")}>
          English
        </Button>
        <Button size="sm" variant={current === "it" ? "default" : "outline"} onClick={() => setLang("it")}>
          Italiano
        </Button>
      </CardContent>
    </Card>
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
  const { t } = useTranslation();
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
          {t("system.pairing.title")}
        </CardTitle>
        <CardDescription>{t("system.pairing.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        {qr && <img src={qr} alt={t("system.pairing.qrAlt")} className="size-[110px] rounded-md border bg-white p-1" />}
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
  const { t } = useTranslation();
  const enabled = autostart?.enabled ?? false;
  const canToggle = !!autostart?.supported && !!autostart?.appPath;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Power className="size-4" />
          {t("system.autostart.title")}
        </CardTitle>
        <CardDescription>{bundled ? t("system.autostart.bundled") : t("system.autostart.dev")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Badge variant={enabled ? "default" : "outline"}>{enabled ? t("system.autostart.on") : t("system.autostart.off")}</Badge>
          <Button
            size="sm"
            variant={enabled ? "outline" : "default"}
            disabled={!canToggle || busy}
            onClick={() => void onToggle(!enabled)}
          >
            {busy ? t("system.autostart.saving") : enabled ? t("system.autostart.disable") : t("system.autostart.enable")}
          </Button>
        </div>
        <p className="text-muted-foreground break-words text-xs">
          {autostart?.appPath ?? t("system.autostart.pathUnavailable")}
        </p>
        {autostart?.detail && <p className="text-destructive text-xs">{autostart.detail}</p>}
      </CardContent>
    </Card>
  );
}

function ServiceRow({ service }: { service: SystemServiceStatus }) {
  const { t } = useTranslation();
  return (
    <Card size="sm">
      <CardHeader className="grid-cols-[auto_1fr_auto]">
        <StateIcon state={service.state} />
        <div className="min-w-0">
          <CardTitle className="truncate">{service.label}</CardTitle>
          <CardDescription className="truncate">{service.detail ?? t("system.serviceNoDetail")}</CardDescription>
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
