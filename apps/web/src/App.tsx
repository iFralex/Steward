import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { BarChart3, ListChecks, Mic, Settings, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useHostSocket } from "@/lib/host-socket";
import { resolveToken, setToken } from "@/lib/auth";
import { hostWsUrl, hostHttpBase } from "@/lib/host-url";
import { currentLocale } from "@/lib/locale";
import { ApprovalCard } from "@/components/approval-card";
import { QuestionCard } from "@/components/question-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn, safeHref } from "@/lib/utils";
import { ToolCard } from "@/components/tool-card";
import { CardView, type FileApi } from "@/components/cards";
import { FileChip } from "@/components/file-chip";
import { UsagePage } from "@/components/usage-page";
import { AuditPage } from "@/components/audit-page";
import { SystemPage } from "@/components/system-page";
import { ActionDetail } from "@/components/action-detail";
import { UnifiedSidebar } from "@/components/sidebar";
import { useIsDesktop } from "@/lib/use-is-desktop";
import { useEdgeSwipeBack } from "@/lib/use-edge-swipe-back";
import type { ActionCenterItem, ChannelFile } from "@steward/protocol";

const HOST_URL = hostWsUrl();
const HTTP_BASE = hostHttpBase();

type Tab = "chat" | "actions" | "usage" | "audit" | "system";
type Pane = "chat" | "action" | "usage" | "audit" | "system";

function AppMark({ className }: { className?: string }) {
  return (
    <img
      src="/pwa-64x64.png"
      alt=""
      aria-hidden="true"
      className={cn("size-6 shrink-0 rounded-md", className)}
    />
  );
}

function ConnectionDot({ connected, state }: { connected: boolean; state: "idle" | "running" }) {
  const { t } = useTranslation();
  const label = connected ? (state === "running" ? t("app.connection.thinking") : t("app.connection.connected")) : t("app.connection.disconnected");
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-2.5 shrink-0 rounded-full ring-2 ring-background",
        !connected && "bg-red-500",
        connected && state === "running" && "animate-pulse bg-amber-400",
        connected && state !== "running" && "bg-emerald-500",
      )}
    />
  );
}

/** ?send=… deep link (iPhone Action button → Shortcut → "Apri URL"): consume
 *  the param once, stripping it from the address bar like ?token. */
function consumeSendParam(): { text: string; from?: string | null; created?: boolean } | null {
  const url = new URL(window.location.href);
  const text = url.searchParams.get("send")?.trim();
  if (!text) return null;
  url.searchParams.delete("send");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  return { text };
}

function App() {
  const { t } = useTranslation();
  // Localhost (the Mac) auto-pairs via the host-injected global; a phone pairs
  // by scanning the System page's QR (?token=…, consumed once then stripped
  // from the address bar). No token yet → show the pairing screen instead of
  // the app; a 401 from any data route (wrong/rotated token) drops back to it.
  const [authToken, setAuthToken] = useState<string | null>(() => resolveToken());
  const onUnauthorized = () => setAuthToken(null);
  const host = useHostSocket(HOST_URL, authToken, onUnauthorized);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");          // sidebar tab (desktop) / bottom-nav tab (mobile)
  const [pane, setPane] = useState<Pane>("chat");       // what the desktop content area shows
  const [mobileDrill, setMobileDrill] = useState(false); // mobile: list screen (false) vs content screen (true)
  const [selectedActionId, setSelectedActionId] = useState<number | null>(null);
  const [splitActionId, setSplitActionId] = useState<number | null>(null);
  const isDesktop = useIsDesktop();
  const swipePanelRef = useRef<HTMLElement | null>(null);
  const canNavigateBack = !isDesktop && mobileDrill && (tab === "chat" || tab === "actions");
  const swipeStyle = useEdgeSwipeBack(swipePanelRef, canNavigateBack, () => setMobileDrill(false));
  const splitAction = host.actionCenter?.items.find((a) => a.id === splitActionId) ?? null;
  const [showDone, setShowDone] = useState(false);
  const [attachments, setAttachments] = useState<ChannelFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false); // mobile bottom-nav "Altro" overflow sheet
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stable callback ref: scrolls to the bottom only when the scroller actually
  // (re)mounts. An inline ref re-attaches on every render and would re-scroll
  // on each swipe touchmove / keystroke (one of the two yank mechanisms; the
  // other was the auto-scroll effect firing on unmemoized approvals/questions).
  const attachChatScroller = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => () => streamSafeStop(recorderRef.current), []);
  const focusComposer = () => document.getElementById("composer-input")?.focus();
  const fileApi: FileApi = { open: host.openFile, reveal: host.revealFile, resolve: host.resolveFile, register: host.registerPath };

  const selectedAction =
    host.actionCenter?.items.find((a) => a.id === selectedActionId)
    ?? host.actionCenter?.items[0]
    ?? null;
  const newActionCount = host.actionCenter?.diagnostics?.counts.new ?? 0;

  // Mobile derives content from the tab stack; desktop from pane.
  const shown: Pane = isDesktop
    ? pane
    : tab === "chat" ? "chat"
    : tab === "actions" ? "action"
    : tab;

  // flushSync commits the pane switch before .focus(): the composer may not be
  // in the DOM yet (action/usage pane, or mobile list screen), and iOS only
  // opens the keyboard for a focus that happens inside the user's tap.
  const selectChat = (id: string, opts?: { focus?: boolean }) => {
    if (id !== host.activeChatId) setSplitActionId(null);
    flushSync(() => {
      setPane("chat");
      setMobileDrill(true);
    });
    host.selectChat(id);
    if (isDesktop && opts?.focus !== false) focusComposer();
  };
  const createChat = () => {
    flushSync(() => {
      setSplitActionId(null);
      setPane("chat");
      setMobileDrill(true);
    });
    host.createChat();
    focusComposer();
  };
  const selectAction = (a: ActionCenterItem) => {
    setSelectedActionId(a.id);
    if (a.status === "new") host.markAction(a.id, "read");
    setPane("action");
    setMobileDrill(true);
  };
  const openUsage = () => { setPane("usage"); if (!isDesktop) setTab("usage"); setMobileDrill(true); };
  const openAudit = () => { setPane("audit"); if (!isDesktop) setTab("audit"); setMobileDrill(true); };
  const openSystem = () => { setPane("system"); if (!isDesktop) setTab("system"); setMobileDrill(true); };
  const openMobileTab = (nextTab: Tab) => {
    setMoreOpen(false); // any nav destination change dismisses the "Altro" overflow sheet
    setTab(nextTab);
    if (nextTab === "usage") {
      setPane("usage");
      setMobileDrill(true);
      return;
    }
    if (nextTab === "audit") {
      setPane("audit");
      setMobileDrill(true);
      return;
    }
    if (nextTab === "system") {
      setPane("system");
      setMobileDrill(true);
      return;
    }
    setMobileDrill(false);
  };

  const copyJson = async () => {
    const json = JSON.stringify(
      {
        messages: host.messages.map((m) =>
          m.role === "tool"
            ? {
                role: "tool",
                tool: m.text,
                input: m.toolInput,
                output: m.toolOutput,
                durationMs: m.toolDurationMs,
                status: m.toolStatus,
                ...(m.toolError ? { error: m.toolError } : {}),
              }
            : { role: m.role, text: m.text },
        ),
      },
      null,
      2,
    );
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [host.messages, host.approvals, host.questions, host.state]);

  // Tapping a push notification: the service worker forwards the payload here so
  // we jump to the relevant action proposal (or chat).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const msg = (e.data ?? {}) as { type?: string; data?: { actionId?: number; chatId?: string } };
      if (msg.type !== "notification-click") return;
      const p = msg.data ?? {};
      if (typeof p.actionId === "number") {
        setTab("actions");
        setSelectedActionId(p.actionId);
        setPane("action");
        setMobileDrill(true);
      } else if (typeof p.chatId === "string") {
        setTab("chat");
        selectChat(p.chatId);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [host]);

  // ?send=… deep link: once connected and settled on a chat, create a fresh
  // chat, wait for the server to make it active, then send the text there.
  const pendingSendRef = useRef(consumeSendParam());
  useEffect(() => {
    const p = pendingSendRef.current;
    if (!p || !host.connected || !host.activeChatId) return;
    if (!p.created) {
      p.from = host.activeChatId;
      p.created = true;
      host.createChat();
      return;
    }
    if (host.activeChatId !== p.from) {
      pendingSendRef.current = null;
      host.sendMessage(p.text);
      setTab("chat");
      setPane("chat");
      setMobileDrill(true);
    }
  }, [host, host.connected, host.activeChatId]);

  // Action Center auto-refresh: every 2 minutes while connected, plus whenever
  // the app returns to the foreground (PWA reopened / tab refocused).
  const { connected: hostConnected, refreshActions } = host;
  useEffect(() => {
    if (!hostConnected) return;
    const tick = () => refreshActions(showDone);
    const id = window.setInterval(tick, 120_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hostConnected, refreshActions, showDone]);

  const doSend = () => {
    if (!draft.trim() && attachments.length === 0) return;
    host.sendMessage(draft, attachments);
    setDraft("");
    setAttachments([]);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    doSend();
  };

  const sendRecordedAudio = async (blob: Blob) => {
    setTranscribing(true);
    try {
      const text = await host.transcribeAudio(blob);
      host.sendMessage(text, attachments);
      setDraft("");
      setAttachments([]);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscribing(false);
    }
  };

  const startRecording = async () => {
    if (recording || transcribing || host.state === "running") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      window.alert(t("app.audioNotSupported"));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        recordingChunksRef.current = [];
        setRecording(false);
        if (blob.size > 0) void sendRecordedAudio(blob);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      streamSafeStop(recorderRef.current);
      recorderRef.current = null;
      setRecording(false);
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  };

  // Move focus between chats relative to the active one.
  const stepChat = (delta: number) => {
    const list = host.chats;
    if (list.length === 0) return;
    const idx = list.findIndex((c) => c.id === host.activeChatId);
    const next = list[Math.min(Math.max((idx < 0 ? 0 : idx) + delta, 0), list.length - 1)];
    // No composer focus here: j/k are for stepping through chats, and focusing
    // the input would swallow the next keypress as text.
    if (next && next.id !== host.activeChatId) selectChat(next.id, { focus: false });
  };

  // Global keyboard shortcuts. Single-key (no Cmd/Ctrl) so they don't clash with
  // the browser's reserved combos (⌘N, ⌘⇧N, ⌘1-9, …). Plain keys only fire when
  // you are NOT typing; Esc works everywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      if (e.key === "Escape") {
        if (host.state === "running") { host.stop(); e.preventDefault(); }
        else if (typing) (el as HTMLElement).blur();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return; // don't hijack typing or browser combos

      switch (e.key) {
        case "/": focusComposer(); e.preventDefault(); break;
        case "c": createChat(); e.preventDefault(); break;
        case "j": stepChat(1); e.preventDefault(); break;
        case "k": stepChat(-1); e.preventDefault(); break;
        case "u":
          if (!isDesktop) {
            setTab("usage");
            setPane("usage");
            setMobileDrill(true);
          } else {
            setPane((p) => (p === "usage" ? "chat" : "usage"));
          }
          e.preventDefault();
          break;
        case "a": setTab((t) => (t === "actions" ? "chat" : "actions")); e.preventDefault(); break;
        case "?": setShowShortcuts((s) => !s); e.preventDefault(); break;
      }
    };
    // Capture phase: reach the handler before an input/component can swallow the
    // key (e.g. base-ui Input stopping Escape) — this is why Esc "didn't work".
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      const refs = await Promise.all(list.map((f) => host.uploadFile(f)));
      setAttachments((prev) => [...prev, ...refs]);
    } catch {
      /* upload failed — surface nothing loud; the chip just won't appear */
    } finally {
      setUploading(false);
    }
  };

  const onComposerDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // A file dragged from an existing chat chip → already on the host, no re-upload.
    const internal = e.dataTransfer.getData("application/x-llmwiki-file");
    if (internal) {
      try {
        const file = JSON.parse(internal) as ChannelFile;
        setAttachments((prev) => (prev.some((p) => p.token === file.token) ? prev : [...prev, file]));
        return;
      } catch { /* fall through to OS files */ }
    }
    if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
  };

  const openActionInChat = (action: ActionCenterItem) => {
    setSelectedActionId(action.id);
    host.markAction(action.id, "read");
    // Runs in a temporary chat dedicated to this action (server-side).
    host.openActionChat(action.id);
    setSplitActionId(action.id);
    setTab("chat");
    setPane("chat");
    setMobileDrill(true);
  };

  // Execute also runs in a temporary action chat (server-side, same as
  // openActionInChat) — follow the user there so they see it happen live.
  const executeProposalInChat = (actionId: number, proposalId: string) => {
    host.executeProposal(actionId, proposalId);
    setSplitActionId(actionId);
    setTab("chat");
    setPane("chat");
    setMobileDrill(true);
  };

  if (!authToken) {
    return (
      <PairingScreen
        onPaired={(t) => {
          setToken(t);
          window.location.reload();
        }}
      />
    );
  }

  // Existing thread-scroller + composer JSX, held in a local variable (not a
  // component) so it can be dropped into the content area without remounting
  // or losing composer focus.
  const chatEmpty =
    !host.historyLoading &&
    host.messages.length === 0 &&
    host.approvals.length === 0 &&
    host.questions.length === 0;

  const chatPane = (
    <>
      <div ref={attachChatScroller} className="flex-1 overflow-y-auto p-4">
        {chatEmpty ? (
          <EmptyChat
            newActionCount={newActionCount}
            onSuggestion={(text) => {
              setDraft(text);
              focusComposer();
            }}
            onOpenActions={() => {
              setTab("actions");
              setMobileDrill(false);
            }}
          />
        ) : (
        <div className="mx-auto w-full max-w-[52rem] space-y-3">
          {host.historyLoading && host.messages.length === 0 && (
            <div className="flex justify-center py-10" aria-label={t("app.loadingChat")}>
              <span className="border-muted-foreground/40 border-t-foreground size-5 animate-spin rounded-full border-2" />
            </div>
          )}
          {host.messages.map((m, i) => {
            const prev = host.messages[i - 1];
            const divider = m.ts && (!prev?.ts || !sameDay(prev.ts, m.ts)) ? <DateDivider ts={m.ts} /> : null;
            return (
              <div key={m.id}>
                {divider}
                {m.role === "tool" ? (
                  <ToolCard m={m} fileApi={fileApi} />
                ) : (
                  <div className={m.role === "user" ? "text-right" : "text-left"}>
                    <div
                      className={cn(
                        "inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                        m.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground",
                      )}
                    >
                      {m.role === "assistant" ? (
                        m.text ? <MarkdownMessage text={m.text} fileApi={fileApi} /> : (m.open ? "…" : "")
                      ) : (
                        m.text || (m.open ? "…" : "")
                      )}
                    </div>
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="mt-1.5 flex flex-col items-end gap-1.5 text-xs">
                        {m.attachments.map((f) => (
                          <FileChip key={f.token} file={f} onOpen={host.openFile} onReveal={host.revealFile} />
                        ))}
                      </div>
                    )}
                    {m.ts && <div className="text-muted-foreground mt-0.5 text-[10px] tabular-nums">{fmtTime(m.ts)}</div>}
                  </div>
                )}
              </div>
            );
          })}
          {host.approvals.map((a) => (
            <ApprovalCard key={a.requestId} approval={a} onDecision={host.respondApproval} fileApi={fileApi} />
          ))}
          {host.questions.map((q) => (
            <QuestionCard key={q.requestId} question={q} onRespond={host.respondQuestion} />
          ))}
          {(() => {
            const last = host.messages[host.messages.length - 1];
            const streaming = last?.role === "assistant" && last.open && !!last.text;
            return host.state === "running" && !streaming ? <ThinkingIndicator /> : null;
          })()}
        </div>
        )}
      </div>

      <form
        onSubmit={submit}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onComposerDrop}
        className={cn("border-t p-3", dragOver && "bg-primary/5 ring-primary/40 ring-2 ring-inset")}
      >
        <div className="mx-auto w-full max-w-[52rem]">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-col gap-1.5">
              {attachments.map((f) => (
                <div key={f.token} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <FileChip file={f} onOpen={host.openFile} onReveal={host.revealFile} />
                  </div>
                  <button
                    type="button"
                    title={t("app.composer.removeAttachment")}
                    className="text-muted-foreground hover:text-destructive shrink-0 rounded p-1"
                    onClick={() => setAttachments((prev) => prev.filter((p) => p.token !== f.token))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); e.target.value = ""; }}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              title={t("app.composer.attachFile")}
              disabled={!host.connected || uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? "…" : "📎"}
            </Button>
            <Input
              id="composer-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                transcribing ? t("app.composer.transcribing")
                  : recording ? t("app.composer.recording")
                  : dragOver ? t("app.composer.dropFiles")
                  : t("app.composer.placeholder")
              }
            />
            <Button
              type="button"
              variant={recording ? "destructive" : "outline"}
              size="icon"
              title={recording ? t("app.composer.stopRecording") : t("app.composer.startRecording")}
              disabled={!host.connected || transcribing || host.state === "running"}
              onClick={recording ? stopRecording : startRecording}
            >
              {recording ? <Square className="size-4" /> : transcribing ? "…" : <Mic className="size-4" />}
            </Button>
            {host.state === "running" ? (
              <Button type="button" variant="destructive" onClick={host.stop} title={t("app.composer.stopGeneration")}>
                {t("app.composer.stop")}
              </Button>
            ) : (
              <Button type="submit" title={t("app.composer.sendTitle")} disabled={!host.connected || (!draft.trim() && attachments.length === 0)}>
                {t("app.composer.send")}
              </Button>
            )}
          </div>
        </div>
      </form>
    </>
  );

  return (
    <div className="bg-background text-foreground flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <h1 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <AppMark />
          <span className="truncate">{t("app.appName")}</span>
        </h1>
        <div className="flex items-center gap-3">
          {host.usage && (
            <button
              type="button"
              onClick={openUsage}
              className="text-muted-foreground border-border hover:bg-muted rounded-md border px-2 py-0.5 text-xs tabular-nums transition"
              title={t("app.usageButtonTitle", {
                cost: host.usage.turnCostUsd.toFixed(4),
                total: host.usage.tokens.total.toLocaleString(currentLocale()),
                input: host.usage.tokens.input.toLocaleString(currentLocale()),
                output: host.usage.tokens.output.toLocaleString(currentLocale()),
                cache: host.usage.tokens.cacheRead.toLocaleString(currentLocale()),
              })}
            >
              ${host.usage.costUsd.toFixed(4)}
            </button>
          )}
          <ConnectionDot connected={host.connected} state={host.state} />
          <Popover>
            <PopoverTrigger className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md px-2 py-1 text-sm" title={t("app.menu.title")}>
              ⋯
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 space-y-1 p-1">
              <button
                type="button"
                className="hover:bg-muted w-full rounded px-2 py-1.5 text-left text-sm disabled:opacity-50"
                disabled={host.messages.length === 0}
                onClick={copyJson}
              >
                {copied ? t("app.menu.copied") : t("app.menu.copyJson")}
              </button>
              <button
                type="button"
                className="hover:bg-muted w-full rounded px-2 py-1.5 text-left text-sm"
                onClick={() => setShowShortcuts(true)}
              >
                {t("app.menu.shortcuts")}
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </header>

      <ShortcutsDialog open={showShortcuts} onOpenChange={setShowShortcuts} />

      <div className="relative grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* List layer. On mobile it stays
            mounted UNDER the drilled-in content, so the swipe-back gesture reveals it. */}
        <aside className="min-h-0 lg:border-r" aria-hidden={!isDesktop && mobileDrill}>
          <UnifiedSidebar
            tab={tab === "actions" ? "actions" : "chat"}
            onTab={(t) => setTab(t)}
            chats={host.chats}
            activeChatId={host.activeChatId}
            onSelectChat={selectChat}
            onCreateChat={createChat}
            onRenameChat={host.renameChat}
            onDeleteChat={host.deleteChat}
            onSaveChat={host.saveChat}
            actions={host.actionCenter?.items ?? []}
            diagnostics={host.actionCenter?.diagnostics}
            selectedActionId={selectedAction?.id ?? null}
            onSelectAction={selectAction}
            showDone={showDone}
            onShowDone={(v) => { setShowDone(v); host.refreshActions(v); }}
            onRefreshActions={() => host.refreshActions(showDone)}
            pane={pane}
            onOpenUsage={openUsage}
            onOpenAudit={openAudit}
            onOpenSystem={openSystem}
          />
        </aside>

        {/* Content layer. On mobile it overlays the list (absolute) so dragging it
            right reveals the parent screen underneath. */}
        <main
          className={cn(
            "min-h-0 flex-col lg:static lg:z-auto lg:flex lg:bg-transparent",
            mobileDrill ? "bg-background absolute inset-0 z-10 flex" : "hidden",
          )}
          ref={swipePanelRef}
          style={isDesktop ? undefined : swipeStyle}
        >
          <div className="flex items-center gap-2 border-b px-3 py-2 lg:hidden">
            {canNavigateBack && (
              <button type="button" aria-label={t("app.back")} className="text-muted-foreground text-sm" onClick={() => setMobileDrill(false)}>←</button>
            )}
            <span className="truncate text-sm font-medium">
              {tab === "chat" ? (host.chats.find((c) => c.id === host.activeChatId)?.title || t("app.mobileHeader.chatFallback"))
                : tab === "actions" ? (selectedAction?.title ?? t("app.mobileHeader.actionsFallback"))
                : tab === "usage" ? t("app.mobileHeader.usage")
                : tab === "audit" ? t("app.mobileHeader.audit") : t("app.mobileHeader.system")}
            </span>
          </div>
          {shown === "usage" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <UsagePage httpBase={HTTP_BASE} token={authToken} onUnauthorized={onUnauthorized} />
            </div>
          ) : shown === "audit" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <AuditPage httpBase={HTTP_BASE} token={authToken} onUnauthorized={onUnauthorized} />
            </div>
          ) : shown === "system" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SystemPage httpBase={HTTP_BASE} token={authToken} onUnauthorized={onUnauthorized} />
            </div>
          ) : shown === "action" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mx-auto w-full max-w-3xl">
                <ActionDetail
                  action={selectedAction}
                  onOpenChat={openActionInChat}
                  onMark={(status) => selectedAction && host.markAction(selectedAction.id, status)}
                  onExecute={(proposalId) => selectedAction && executeProposalInChat(selectedAction.id, proposalId)}
                  onRevise={(proposalId, instruction) => selectedAction && host.reviseProposal(selectedAction.id, proposalId, instruction)}
                />
              </div>
            </div>
          ) : splitAction && isDesktop ? (
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_400px]">
              <div className="flex min-h-0 flex-col">
                {chatPane}
              </div>
              <aside className="min-h-0 overflow-y-auto border-l p-4">
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    title={t("actionDetail.closePanel")}
                    className="text-muted-foreground hover:text-foreground rounded p-1 text-sm"
                    onClick={() => setSplitActionId(null)}
                  >
                    ✕
                  </button>
                </div>
                <ActionDetail
                  action={splitAction}
                  onOpenChat={openActionInChat}
                  onMark={(status) => { host.markAction(splitAction.id, status); if (status === "done" || status === "dismissed") setSplitActionId(null); }}
                  onExecute={(proposalId) => executeProposalInChat(splitAction.id, proposalId)}
                  onRevise={(proposalId, instruction) => host.reviseProposal(splitAction.id, proposalId, instruction)}
                />
              </aside>
            </div>
          ) : (
            chatPane
          )}
        </main>
      </div>

      {/* Bottom nav (mobile only) */}
      <div className="relative lg:hidden">
        {moreOpen && (
          <MoreNavSheet
            activeTab={tab}
            onSelect={openMobileTab}
            onClose={() => setMoreOpen(false)}
          />
        )}
        <nav className="bg-background relative z-50 flex border-t pb-[env(safe-area-inset-bottom)]">
          {([
            ["chat", t("app.bottomNav.chat"), "flex-1"],
            ["actions", t("app.bottomNav.actions"), "flex-1"],
          ] as const).map(([tabKey, label, widthClass]) => (
            <button
              key={tabKey}
              type="button"
              onClick={() => openMobileTab(tabKey)}
              aria-current={tab === tabKey ? "page" : undefined}
              className={cn(
                "relative py-4 text-center text-xs transition",
                widthClass,
                tab === tabKey ? "text-foreground font-medium" : "text-muted-foreground",
              )}
            >
              {label}
              {tabKey === "actions" && newActionCount > 0 && (
                <span className="bg-primary text-primary-foreground absolute -mt-1 ml-0.5 rounded-full px-1 text-[9px] font-semibold tabular-nums">
                  {newActionCount}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-current={MORE_TABS.includes(tab) ? "page" : undefined}
            className={cn(
              "flex-1 py-4 text-center text-xs transition",
              MORE_TABS.includes(tab) ? "text-foreground font-medium" : "text-muted-foreground",
            )}
          >
            {t("app.bottomNav.more")}
          </button>
        </nav>
      </div>
    </div>
  );
}

export default App;

/** Tabs collapsed under the mobile bottom-nav's "Altro" overflow button. */
const MORE_TABS: readonly Tab[] = ["usage", "audit", "system"];

function MoreNavSheet({
  activeTab,
  onSelect,
  onClose,
}: {
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const items: { tab: Tab; label: string; icon: ReactNode }[] = [
    { tab: "usage", label: t("app.bottomNav.usage"), icon: <BarChart3 className="size-4" /> },
    { tab: "audit", label: t("app.bottomNav.audit"), icon: <ListChecks className="size-4" /> },
    { tab: "system", label: t("app.bottomNav.system"), icon: <Settings className="size-4" /> },
  ];
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div role="menu" className="bg-background absolute inset-x-0 bottom-full z-50 border-t shadow-lg">
        {items.map((item) => (
          <button
            key={item.tab}
            type="button"
            role="menuitem"
            onClick={() => onSelect(item.tab)}
            className={cn(
              "flex w-full items-center gap-2 border-b px-4 py-3 text-left text-sm transition last:border-b-0",
              activeTab === item.tab ? "text-foreground font-medium" : "text-muted-foreground",
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * Shown instead of the app when no auth token is known yet — a phone landing
 * on the host over Tailscale for the first time. Paste the token from the
 * Mac's System page (either read off the QR pairing URL, or typed by hand).
 */
function PairingScreen({ onPaired }: { onPaired: (token: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onPaired(trimmed);
  };
  return (
    <div className="bg-background text-foreground flex h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-lg border p-5">
        <h1 className="flex items-center gap-2 text-sm font-semibold">
          <AppMark />
          <span>{t("app.appName")}</span>
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("app.pairing.instructions")}
        </p>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("app.pairing.placeholder")}
        />
        <Button type="submit" className="w-full" disabled={!value.trim()}>
          {t("app.pairing.save")}
        </Button>
      </form>
    </div>
  );
}

function ThinkingIndicator() {
  const { t } = useTranslation();
  return (
    <div className="text-left">
      <div className="bg-muted text-muted-foreground inline-flex items-center gap-1.5 rounded-lg px-3 py-3" aria-label={t("app.thinking")}>
        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-current" />
      </div>
    </div>
  );
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
}

function fmtDay(ts: number, t: TFunction): string {
  const now = new Date();
  const d = new Date(ts);
  const today = sameDay(now.getTime(), ts);
  const yesterday = sameDay(now.getTime() - 86400_000, ts);
  if (today) return t("app.today");
  if (yesterday) return t("app.yesterday");
  return d.toLocaleDateString(currentLocale(), { weekday: "long", day: "numeric", month: "long" });
}

function DateDivider({ ts }: { ts: number }) {
  const { t } = useTranslation();
  return (
    <div className="my-2 flex items-center gap-3">
      <div className="border-border flex-1 border-t" />
      <span className="text-muted-foreground text-[10px] uppercase tracking-wide">{fmtDay(ts, t)}</span>
      <div className="border-border flex-1 border-t" />
    </div>
  );
}

/** [physical key label (untranslated literal, or "enterKey" for the one that
 *  reads differently per language), translation key under app.shortcuts]. */
const SHORTCUT_ROWS: [string, string][] = [
  ["enterKey", "enter"],
  ["Esc", "esc"],
  ["/", "slash"],
  ["c", "c"],
  ["j / k", "jk"],
  ["a", "a"],
  ["u", "u"],
  ["?", "question"],
];

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("app.shortcuts.title")}</DialogTitle>
        </DialogHeader>
        <dl className="space-y-1.5">
          {SHORTCUT_ROWS.map(([keys, descKey]) => (
            <div key={descKey} className="flex items-center justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">{t(`app.shortcuts.${descKey}`)}</dt>
              <dd className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs tabular-nums">
                {keys === "enterKey" ? t("app.shortcuts.enterKey") : keys}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground text-[11px]">{t("app.shortcuts.footer")}</p>
      </DialogContent>
    </Dialog>
  );
}

function MarkdownMessage({ text, fileApi }: { text: string; fileApi: FileApi }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="mb-3 mt-1 text-xl font-semibold leading-tight first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2.5 mt-4 text-lg font-semibold leading-snug first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold leading-snug first:mt-0">{children}</h3>,
        h4: ({ children }) => <h4 className="mb-1.5 mt-3 text-sm font-semibold leading-snug first:mt-0">{children}</h4>,
        h5: ({ children }) => <h5 className="mb-1.5 mt-2 text-sm font-medium leading-snug first:mt-0">{children}</h5>,
        h6: ({ children }) => <h6 className="text-muted-foreground mb-1.5 mt-2 text-xs font-semibold uppercase tracking-wide first:mt-0">{children}</h6>,
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li>{children}</li>,
        hr: () => <hr className="border-border my-3" />,
        blockquote: ({ children }) => (
          <blockquote className="border-border text-muted-foreground my-2 border-l-2 pl-3 italic">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-background/60">{children}</thead>,
        th: ({ children }) => <th className="border-border border px-2 py-1.5 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border-border border px-2 py-1.5 align-top">{children}</td>,
        code: ({ className, children }) => {
          if (className === "language-card") {
            try {
              const obj = JSON.parse(String(children).trim()) as { type?: unknown } & Record<string, unknown>;
              const { type, ...data } = obj;
              if (type) return <CardView type={String(type)} data={data} fileApi={fileApi} />;
            } catch { /* not valid card JSON → render as a normal code block */ }
          }
          return <code className="bg-background/70 rounded px-1 py-0.5 font-mono text-[0.85em]">{children}</code>;
        },
        pre: ({ children }) => {
          const child = Array.isArray(children) ? children[0] : children;
          const cls = (child as { props?: { className?: string } } | undefined)?.props?.className;
          if (cls === "language-card") return <>{children}</>; // the card replaces the code block; no <pre> wrapper
          return <pre className="bg-background/70 mb-2 overflow-auto rounded-md p-2 text-xs last:mb-0">{children}</pre>;
        },
        a: ({ children, href }) => (
          <a className="text-primary underline underline-offset-2" href={safeHref(href)} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/** Suggestion chips for the empty chat: label is what you see, draft is what
 *  lands in the composer (open-ended ones leave a trailing space to finish). */
/** Suggestion chip content lives in app.suggestions.<key>.{label,draft} so it
 *  follows the selected UI language like the rest of the empty-chat copy. */
const SUGGESTIONS: { icon: string; tint: string; key: string }[] = [
  { icon: "✉️", tint: "border-indigo-500/25 bg-indigo-500/10", key: "summarizeMail" },
  { icon: "📅", tint: "border-violet-500/25 bg-violet-500/10", key: "weekEvents" },
  { icon: "↩️", tint: "border-amber-500/25 bg-amber-500/10", key: "replyLast" },
  { icon: "📚", tint: "border-pink-500/25 bg-pink-500/10", key: "knowAbout" },
];

function greetingKey(): "night" | "morning" | "afternoon" | "evening" {
  const h = new Date().getHours();
  if (h < 6) return "night";
  if (h < 13) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

/** Empty-state of a fresh chat: breathing aurora behind a gradient greeting,
 *  actionable suggestion chips, pending-actions pill, desktop shortcut hints. */
function EmptyChat({
  newActionCount,
  onSuggestion,
  onOpenActions,
}: {
  newActionCount: number;
  onSuggestion: (draft: string) => void;
  onOpenActions: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-7 overflow-hidden px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 size-72 -translate-x-1/2 -translate-y-[80%] rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.55),rgba(139,92,246,0.35),rgba(245,158,11,0.18),transparent)] blur-3xl motion-reduce:animate-none"
        style={{ animation: "steward-breathe 7s ease-in-out infinite" }}
      />
      <div className="relative text-center motion-reduce:animate-none" style={{ animation: "steward-rise 0.5s ease-out both" }}>
        <h2 className="bg-gradient-to-r from-indigo-500 via-violet-500 to-amber-500 bg-clip-text text-3xl font-semibold text-transparent">
          {t(`app.greeting.${greetingKey()}`)}, Alessio
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">{t("app.emptyChatSubtitle")}</p>
      </div>
      <div className="relative grid w-full max-w-md gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onSuggestion(t(`app.suggestions.${s.key}.draft`))}
            className="bg-card hover:border-violet-500/40 group flex items-center gap-3 rounded-xl border p-3 text-left text-sm transition hover:-translate-y-0.5 hover:shadow-md motion-reduce:animate-none"
            style={{ animation: "steward-rise 0.5s ease-out both", animationDelay: `${120 + i * 70}ms` }}
          >
            <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border text-base", s.tint)}>
              {s.icon}
            </span>
            <span className="text-foreground/90">{t(`app.suggestions.${s.key}.label`)}</span>
          </button>
        ))}
      </div>
      {newActionCount > 0 && (
        <button
          type="button"
          onClick={onOpenActions}
          className="relative flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-500 transition hover:bg-amber-500/20 motion-reduce:animate-none"
          style={{ animation: "steward-rise 0.5s ease-out both", animationDelay: "430ms" }}
        >
          {t("app.pendingActions", { count: newActionCount })}
        </button>
      )}
      <div
        className="text-muted-foreground/70 relative hidden items-center gap-3 text-[11px] lg:flex motion-reduce:animate-none"
        style={{ animation: "steward-rise 0.5s ease-out both", animationDelay: "500ms" }}
      >
        <span><Kbd>/</Kbd> {t("app.kbdType")}</span>
        <span><Kbd>c</Kbd> {t("app.kbdNewChat")}</span>
        <span><Kbd>?</Kbd> {t("app.kbdShortcuts")}</span>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">{children}</kbd>;
}

function streamSafeStop(recorder: MediaRecorder | null): void {
  recorder?.stream.getTracks().forEach((track) => track.stop());
}

function preferredRecordingMimeType(): string | undefined {
  for (const mimeType of ["audio/mp4", "audio/aac", "audio/webm;codecs=opus", "audio/webm"]) {
    if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }
  return undefined;
}
