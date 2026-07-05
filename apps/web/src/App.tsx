import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useHostSocket } from "@/lib/host-socket";
import { resolveToken, setToken } from "@/lib/auth";
import { hostWsUrl, hostHttpBase } from "@/lib/host-url";
import { ApprovalCard } from "@/components/approval-card";
import { QuestionCard } from "@/components/question-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, safeHref } from "@/lib/utils";
import { ToolCard } from "@/components/tool-card";
import { CardView, type FileApi } from "@/components/cards";
import { FileChip } from "@/components/file-chip";
import { UsagePage } from "@/components/usage-page";
import { SystemPage } from "@/components/system-page";
import { ActionDetail } from "@/components/action-detail";
import { ChatSidebar, ActionCenterPanel } from "@/components/sidebar";
import type { ActionCenterItem, ChannelFile } from "@steward/protocol";

const HOST_URL = hostWsUrl();
const HTTP_BASE = hostHttpBase();

function App() {
  // Localhost (the Mac) auto-pairs via the host-injected global; a phone pairs
  // by scanning the System page's QR (?token=…, consumed once then stripped
  // from the address bar). No token yet → show the pairing screen instead of
  // the app; a 401 from any data route (wrong/rotated token) drops back to it.
  const [authToken, setAuthToken] = useState<string | null>(() => resolveToken());
  const onUnauthorized = () => setAuthToken(null);
  const host = useHostSocket(HOST_URL, authToken, onUnauthorized);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"chat" | "usage" | "system">("chat");
  // On phones the 4-column layout shows one panel at a time (bottom nav switches).
  // Ignored at lg+ where all columns render side by side.
  const [mobilePanel, setMobilePanel] = useState<"chats" | "chat" | "actions">("chat");
  const [selectedActionId, setSelectedActionId] = useState<number | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [attachments, setAttachments] = useState<ChannelFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusComposer = () => document.getElementById("composer-input")?.focus();
  const fileApi: FileApi = { open: host.openFile, reveal: host.revealFile, resolve: host.resolveFile, register: host.registerPath };
  const selectedAction =
    host.actionCenter?.items.find((a) => a.id === selectedActionId)
    ?? host.actionCenter?.items[0]
    ?? null;

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
      setView("chat");
      if (typeof p.actionId === "number") {
        setMobilePanel("actions");
        setSelectedActionId(p.actionId);
      } else if (typeof p.chatId === "string") {
        setMobilePanel("chat");
        host.selectChat(p.chatId);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [host]);

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

  // Move focus between chats relative to the active one.
  const stepChat = (delta: number) => {
    const list = host.chats;
    if (list.length === 0) return;
    const idx = list.findIndex((c) => c.id === host.activeChatId);
    const next = list[Math.min(Math.max((idx < 0 ? 0 : idx) + delta, 0), list.length - 1)];
    if (next && next.id !== host.activeChatId) host.selectChat(next.id);
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
        case "c": host.createChat(); e.preventDefault(); break;
        case "j": stepChat(1); e.preventDefault(); break;
        case "k": stepChat(-1); e.preventDefault(); break;
        case "u": setView((v) => (v === "usage" ? "chat" : "usage")); e.preventDefault(); break;
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

  return (
    <div className="bg-background text-foreground flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">Steward</h1>
          <div className="bg-muted flex rounded-md p-0.5 text-xs">
            {(["chat", "usage", "system"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  "rounded px-2.5 py-1 capitalize transition",
                  view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {host.usage && (
            <button
              type="button"
              onClick={() => setView("usage")}
              className="text-muted-foreground border-border hover:bg-muted rounded-md border px-2 py-0.5 text-xs tabular-nums transition"
              title={`Ultimo turno: $${host.usage.turnCostUsd.toFixed(4)} · ${host.usage.tokens.total.toLocaleString("it-IT")} token (in ${host.usage.tokens.input.toLocaleString("it-IT")} / out ${host.usage.tokens.output.toLocaleString("it-IT")} / cache ${host.usage.tokens.cacheRead.toLocaleString("it-IT")}) — apri Usage`}
            >
              ${host.usage.costUsd.toFixed(4)}
            </button>
          )}
          <span className="text-muted-foreground text-xs">
            {host.connected ? (host.state === "running" ? "thinking…" : "connected") : "disconnected"}
          </span>
          <Button size="sm" variant="ghost" className="px-2" title="Scorciatoie da tastiera (?)" onClick={() => setShowShortcuts(true)}>
            ⌨
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={copyJson}
            disabled={host.messages.length === 0}
          >
            {copied ? "Copied" : "Copy JSON"}
          </Button>
        </div>
      </header>

      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}

      {view === "usage" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <UsagePage httpBase={HTTP_BASE} token={authToken} onUnauthorized={onUnauthorized} />
        </div>
      ) : view === "system" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SystemPage httpBase={HTTP_BASE} token={authToken} onUnauthorized={onUnauthorized} />
        </div>
      ) : (
      <>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[210px_330px_minmax(0,1fr)_minmax(330px,0.85fr)]">
        <aside className={cn("min-h-0 border-r lg:block", mobilePanel === "chats" ? "block" : "hidden")}>
          <ChatSidebar
            chats={host.chats}
            activeChatId={host.activeChatId}
            onSelect={(id) => { host.selectChat(id); setMobilePanel("chat"); }}
            onCreate={host.createChat}
            onRename={host.renameChat}
            onDelete={host.deleteChat}
            onSave={host.saveChat}
          />
        </aside>
        <aside className={cn("min-h-0 border-r lg:block", mobilePanel === "actions" && !selectedAction ? "block" : "hidden")}>
          <ActionCenterPanel
            items={host.actionCenter?.items ?? []}
            diagnostics={host.actionCenter?.diagnostics}
            selectedId={selectedAction?.id ?? null}
            showDone={showDone}
            onShowDone={(v) => {
              setShowDone(v);
              host.refreshActions(v);
            }}
            onRefresh={() => host.refreshActions(showDone)}
            onSelect={(a) => {
              setSelectedActionId(a.id);
              if (a.status === "new") host.markAction(a.id, "read");
            }}
          />
        </aside>

        <main className={cn("min-h-0 flex-col lg:flex", mobilePanel === "chat" ? "flex" : "hidden")}>
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
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

          <form
            onSubmit={submit}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onComposerDrop}
            className={cn("border-t p-3", dragOver && "bg-primary/5 ring-primary/40 ring-2 ring-inset")}
          >
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-col gap-1.5">
                {attachments.map((f) => (
                  <div key={f.token} className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <FileChip file={f} onOpen={host.openFile} onReveal={host.revealFile} />
                    </div>
                    <button
                      type="button"
                      title="Rimuovi allegato"
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
                title="Allega file"
                disabled={!host.connected || uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? "…" : "📎"}
              </Button>
              <Input
                id="composer-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={dragOver ? "Rilascia i file qui…" : "Message your agent…  (/ per focus, trascina file per allegarli)"}
              />
              {host.state === "running" ? (
                <Button type="button" variant="destructive" onClick={host.stop} title="Stop generazione (Esc)">
                  ■ Stop
                </Button>
              ) : (
                <Button type="submit" title="Invia (Invio / ⌘↵)" disabled={!host.connected || (!draft.trim() && attachments.length === 0)}>
                  Send
                </Button>
              )}
            </div>
          </form>
        </main>

        <aside className={cn("min-h-0 overflow-y-auto border-l p-4 lg:block", mobilePanel === "actions" && selectedAction ? "block" : "hidden")}>
          <button type="button" className="text-muted-foreground mb-2 text-xs lg:hidden" onClick={() => setSelectedActionId(null)}>
            ← Azioni
          </button>
          <ActionDetail
            action={selectedAction}
            onOpenChat={openActionInChat}
            onMark={(status) => selectedAction && host.markAction(selectedAction.id, status)}
            onExecute={(proposalId) => selectedAction && host.executeProposal(selectedAction.id, proposalId)}
            onRevise={(proposalId, instruction) => selectedAction && host.reviseProposal(selectedAction.id, proposalId, instruction)}
          />
        </aside>
      </div>
      <nav className="flex border-t lg:hidden">
        {([["chats", "💬 Chat"], ["chat", "🗨 Agente"], ["actions", "⚡ Azioni"]] as const).map(([p, label]) => (
          <button
            key={p}
            type="button"
            onClick={() => setMobilePanel(p)}
            className={cn(
              "flex-1 py-2.5 text-center text-xs transition",
              mobilePanel === p ? "text-foreground font-medium" : "text-muted-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </nav>
      </>
      )}
    </div>
  );
}

export default App;

/**
 * Shown instead of the app when no auth token is known yet — a phone landing
 * on the host over Tailscale for the first time. Paste the token from the
 * Mac's System page (either read off the QR pairing URL, or typed by hand).
 */
function PairingScreen({ onPaired }: { onPaired: (token: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onPaired(trimmed);
  };
  return (
    <div className="bg-background text-foreground flex h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-lg border p-5">
        <h1 className="text-sm font-semibold">Steward</h1>
        <p className="text-muted-foreground text-sm">
          Incolla il token dal tuo Mac (pagina System).
        </p>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Token di pairing"
        />
        <Button type="submit" className="w-full" disabled={!value.trim()}>
          Salva
        </Button>
      </form>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="text-left">
      <div className="bg-muted text-muted-foreground inline-flex items-center gap-1.5 rounded-lg px-3 py-3" aria-label="sta ragionando">
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
  return new Date(ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}

function fmtDay(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const today = sameDay(now.getTime(), ts);
  const yesterday = sameDay(now.getTime() - 86400_000, ts);
  if (today) return "Oggi";
  if (yesterday) return "Ieri";
  return d.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
}

function DateDivider({ ts }: { ts: number }) {
  return (
    <div className="my-2 flex items-center gap-3">
      <div className="border-border flex-1 border-t" />
      <span className="text-muted-foreground text-[10px] uppercase tracking-wide">{fmtDay(ts)}</span>
      <div className="border-border flex-1 border-t" />
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Invio", "Invia messaggio"],
  ["Esc", "Ferma la generazione (o esci dal campo)"],
  ["/", "Vai al campo messaggio"],
  ["c", "Nuova chat"],
  ["j / k", "Chat successiva / precedente"],
  ["u", "Chat ⇄ Usage"],
  ["?", "Mostra/nascondi questa guida"],
];

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-background w-full max-w-sm rounded-lg border p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Scorciatoie da tastiera</h2>
          <button type="button" className="text-muted-foreground hover:text-foreground text-sm" onClick={onClose}>✕</button>
        </div>
        <dl className="space-y-1.5">
          {SHORTCUTS.map(([keys, desc]) => (
            <div key={keys} className="flex items-center justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">{desc}</dt>
              <dd className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs tabular-nums">{keys}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground mt-3 text-[11px]">⌘ = Ctrl su Windows/Linux.</p>
      </div>
    </div>
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
