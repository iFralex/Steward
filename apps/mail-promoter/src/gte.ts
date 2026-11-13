import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

export interface GateDecision {
  route: "llm" | "discard";
  reason: string;
  score?: number;
  tokens?: number;
  threshold?: number;
}
export interface MailGate {
  readonly modelId: string;
  check(text: string, policyHash: string): Promise<GateDecision>;
  close(): void;
}

/** One local model per batch, serialized inference, bounded waits, fail open. */
export class GteGate implements MailGate {
  readonly modelId: string;
  private readonly manifest: { threshold: number; policyHash: string; maxTokens: number };
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private sequence: Promise<unknown> = Promise.resolve();
  private disabled = false;
  private failureReason = "worker_unavailable";
  private nextId = 0;
  private pending?: { id: number; resolve: (r: GateDecision) => void; timer: NodeJS.Timeout };
  private onFailure?: () => void;

  constructor(private options: { python: string; worker: string; manifest: string; timeoutMs?: number; startupMs?: number }) {
    const bytes = readFileSync(options.manifest);
    this.modelId = createHash("sha256").update(bytes).digest("hex");
    this.manifest = JSON.parse(bytes.toString());
    if (!Number.isFinite(this.manifest.threshold) || this.manifest.threshold <= 0 || this.manifest.threshold >= 1
      || this.manifest.maxTokens !== 8192 || !/^[a-f0-9]{64}$/.test(this.manifest.policyHash)) throw new Error("Invalid GTE manifest");
  }

  private fail(reason = "worker_unavailable"): void {
    if (this.disabled) return;
    console.error(`[mail-gte] ${reason}; forwarding to normal triage`);
    this.disabled = true;
    this.failureReason = reason;
    this.onFailure?.();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve({ route: "llm", reason });
      this.pending = undefined;
    }
    this.child?.kill();
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail("worker_startup_timeout"), this.options.startupMs ?? 90_000);
      this.onFailure = () => { clearTimeout(timer); reject(new Error("GTE worker unavailable")); };
      const child = this.child = spawn(this.options.python, [this.options.worker, "--manifest", this.options.manifest], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1", TOKENIZERS_PARALLELISM: "false" },
      });
      child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
      child.on("error", () => this.fail("worker_start_failed")); child.on("exit", () => this.fail("worker_exit"));
      child.stdin.on("error", () => this.fail("worker_pipe_error"));
      createInterface({ input: child.stdout }).on("line", line => {
        try {
          const value = JSON.parse(line);
          if (value.ready === true && value.modelId === this.modelId) {
            clearTimeout(timer); this.onFailure = undefined; resolve(); return;
          }
          const p = this.pending;
          if (!p || value.id !== p.id || value.modelId !== this.modelId || !["llm", "discard"].includes(value.route)) throw new Error("Invalid GTE response");
          if (value.route === "discard" && (value.reason !== "scored" || !Number.isFinite(value.score) || value.score < 0 || value.score >= this.manifest.threshold
            || value.threshold !== this.manifest.threshold || !Number.isInteger(value.tokens) || value.tokens < 1 || value.tokens > this.manifest.maxTokens)) throw new Error("Invalid discard");
          clearTimeout(p.timer); this.pending = undefined;
          p.resolve(value as GateDecision);
        } catch { this.fail("worker_protocol_error"); }
      });
    });
    return this.ready;
  }

  check(text: string, policyHash: string): Promise<GateDecision> {
    const task = this.sequence.then(async (): Promise<GateDecision> => {
      if (policyHash !== this.manifest.policyHash) return { route: "llm", reason: "policy_changed" };
      if (this.disabled) return { route: "llm", reason: this.failureReason };
      if (Buffer.byteLength(text) > 2_000_000) return { route: "llm", reason: "input_too_large" };
      try {
        await this.start();
        if (this.disabled) return { route: "llm", reason: this.failureReason };
        return await new Promise<GateDecision>(resolve => {
          const id = ++this.nextId;
          this.pending = { id, resolve, timer: setTimeout(() => this.fail("worker_request_timeout"), this.options.timeoutMs ?? 15_000) };
          this.child!.stdin.write(JSON.stringify({ id, text, policyHash }) + "\n");
        });
      } catch { return { route: "llm", reason: this.failureReason }; }
    });
    this.sequence = task.catch(() => {});
    return task;
  }

  close(): void {
    this.disabled = true; this.child?.stdin.end(); this.child?.kill();
  }
}
