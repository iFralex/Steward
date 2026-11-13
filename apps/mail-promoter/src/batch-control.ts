import { GatewayChatError, type Chat } from "./llm.ts";
import type { PromoteState } from "./state.ts";

interface Backoff { until: number; failures: number; status: number }
export class DeferredChatError extends Error {}

export class BatchControl {
  readonly counters: Record<string, number> = {};
  constructor(private state: PromoteState, private options: {
    maxGateScores: number; maxGatewayCalls: number; gatewayKey: string; now?: () => number;
  }) {}
  count(key: string): void { this.counters[key] = (this.counters[key] ?? 0) + 1; }
  takeGate(): boolean {
    if ((this.counters.gteChecks ?? 0) >= this.options.maxGateScores) { this.count("gteBudgetDeferred"); return false; }
    this.count("gteChecks"); return true;
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  get backoff(): Backoff | undefined { return this.state.runtime<Backoff>(this.options.gatewayKey); }
  wrap(chat: Chat): Chat {
    return async (system, user) => {
      if ((this.backoff?.until ?? 0) > this.now()) { this.count("gatewayBackoffDeferred"); throw new DeferredChatError("gateway backoff"); }
      if ((this.counters.gatewayCalls ?? 0) >= this.options.maxGatewayCalls) { this.count("gatewayBudgetDeferred"); throw new DeferredChatError("gateway batch limit"); }
      this.count("gatewayCalls");
      try {
        const answer = await chat(system, user);
        this.state.setRuntime(this.options.gatewayKey, { until: 0, failures: 0, status: 200 });
        return answer;
      } catch (error) {
        this.count("gatewayFailures");
        const status = error instanceof GatewayChatError ? error.status : 502;
        if ([401, 402, 403, 429].includes(status) || status >= 500) {
          const old = this.backoff;
          if (!old || old.until <= this.now()) {
            const failures = (old?.failures ?? 0) + 1;
            this.state.setRuntime(this.options.gatewayKey, { until: this.now() + Math.min(6*3600_000, 15*60_000 * 2**Math.min(failures-1, 5)), failures, status });
          }
        }
        throw error;
      }
    };
  }
}
