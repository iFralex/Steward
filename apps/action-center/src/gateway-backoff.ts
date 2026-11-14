import { createHash } from "node:crypto";
import { GatewayChatError, type Chat } from "./llm.ts";

interface Backoff { until: number; failures: number; status: number }
interface Metadata { getMeta<T>(key: string): T | null; setMeta(key: string, value: unknown): void }

/** Persist transient gateway failures across scheduler processes without storing credentials. */
export class GatewayBackoff {
  private readonly key: string;
  constructor(private readonly store: Metadata, private readonly now: () => number = Date.now) {
    const target = `${process.env.ACTION_CENTER_LLM_ENDPOINT ?? "http://127.0.0.1:4000/v1/chat/completions"}\n${process.env.ACTION_CENTER_LLM_MODEL ?? "tier-5"}`;
    this.key = `gatewayBackoff:${createHash("sha256").update(target).digest("hex").slice(0, 16)}`;
  }
  get state(): Backoff | null { return this.store.getMeta<Backoff>(this.key); }
  get active(): boolean { return (this.state?.until ?? 0) > this.now(); }
  wrap(chat: Chat): Chat {
    return async (system, user) => {
      if (this.active) throw new Error("gateway-backoff");
      try {
        const answer = await chat(system, user);
        if (this.state) this.store.setMeta(this.key, { until: 0, failures: 0, status: 200 });
        return answer;
      } catch (error) {
        if (error instanceof GatewayChatError && (error.status === 0 || [401, 402, 403, 429].includes(error.status) || error.status >= 500)) {
          const failures = Math.min((this.state?.failures ?? 0) + 1, 32);
          const delay = Math.min(6 * 3600_000, 15 * 60_000 * 2 ** Math.min(failures - 1, 5));
          this.store.setMeta(this.key, { until: this.now() + delay, failures, status: error.status });
        }
        throw error;
      }
    };
  }
}
