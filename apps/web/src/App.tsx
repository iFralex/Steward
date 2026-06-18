import { useEffect, useRef, useState, type FormEvent } from "react";
import { useHostSocket } from "@/lib/host-socket";
import { ApprovalCard } from "@/components/approval-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const HOST_URL = import.meta.env.VITE_HOST_URL ?? "ws://127.0.0.1:4317";

function summarizeInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 140 ? `${s.slice(0, 140)}…` : s;
  } catch {
    return String(input);
  }
}

function App() {
  const host = useHostSocket(HOST_URL);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const copyJson = async () => {
    const json = JSON.stringify(
      { messages: host.messages.map(({ role, text }) => ({ role, text })) },
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
  }, [host.messages, host.approvals]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    host.sendMessage(draft);
    setDraft("");
  };

  return (
    <div className="bg-background text-foreground mx-auto flex h-screen max-w-2xl flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h1 className="text-sm font-semibold">Personal Agent</h1>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs">
            {host.connected ? (host.state === "running" ? "thinking…" : "connected") : "disconnected"}
          </span>
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

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {host.messages.map((m) =>
          m.role === "tool" ? (
            <div key={m.id} className="text-muted-foreground flex items-center gap-2 text-xs">
              <span className="bg-muted shrink-0 rounded px-1.5 py-0.5 font-mono">🔧 {m.text}</span>
              {m.toolInput != null && (
                <span className="truncate font-mono opacity-70">{summarizeInput(m.toolInput)}</span>
              )}
            </div>
          ) : (
            <div key={m.id} className={m.role === "user" ? "text-right" : "text-left"}>
              <div
                className={cn(
                  "inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                  m.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {m.text || (m.open ? "…" : "")}
              </div>
            </div>
          ),
        )}
        {host.approvals.map((a) => (
          <ApprovalCard key={a.requestId} approval={a} onDecision={host.respondApproval} />
        ))}
      </div>

      <form onSubmit={submit} className="flex gap-2 border-t p-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message your agent…"
        />
        <Button type="submit" disabled={!host.connected}>
          Send
        </Button>
      </form>
    </div>
  );
}

export default App;
