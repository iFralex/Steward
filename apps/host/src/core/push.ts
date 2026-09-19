/**
 * Web Push registry (mobile-access M2/M3). Stores browser `PushSubscription`s
 * (persisted to `<Steward config dir>/push-subscriptions.json` so they survive
 * host restarts) and delivers best-effort notifications via `web-push`.
 *
 * Dependency-light + unit-testable: the actual `web-push.sendNotification` call
 * is injected (`SendFn`) so tests never touch the network.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import webpush, { type PushSubscription } from "web-push";

export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body?: string;
  tag?: string;
  [key: string]: unknown;
}

export interface PushDeliveryReport {
  attempted: number;
  delivered: number;
  failed: number;
  pruned: number;
}

/** Sends one push message to one subscription; rejects on delivery failure. */
export type SendFn = (sub: PushSubscriptionJSON, payload: string) => Promise<unknown>;

// Urgency: high (RFC 8030) → Apple/FCM deliver immediately and wake the device
// instead of batching for battery. iOS "time-sensitive"/"critical" interruption
// levels are native-app entitlements — this header is the web-push maximum.
const defaultSend: SendFn = (sub, payload) =>
  webpush.sendNotification(sub as unknown as PushSubscription, payload, { urgency: "high" });

/** HTTP status meaning "this subscription is gone" — prune it instead of retrying forever. */
function isGoneStatus(err: unknown): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  return status === 404 || status === 410;
}

export class PushRegistry {
  private readonly subs = new Map<string, PushSubscriptionJSON>();

  constructor(
    private readonly filePath: string,
    private readonly send: SendFn = defaultSend,
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as PushSubscriptionJSON[];
      if (Array.isArray(raw)) {
        for (const s of raw) if (s && typeof s.endpoint === "string") this.subs.set(s.endpoint, s);
      }
    } catch {
      /* corrupt file — start empty rather than crash the host */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify([...this.subs.values()], null, 2));
    } catch {
      /* best-effort — a failed write must never break the push/subscribe flow */
    }
  }

  subscribe(sub: PushSubscriptionJSON): void {
    if (!sub?.endpoint) return;
    this.subs.set(sub.endpoint, sub);
    this.persist();
  }

  unsubscribe(endpoint: string): void {
    if (this.subs.delete(endpoint)) this.persist();
  }

  list(): PushSubscriptionJSON[] {
    return [...this.subs.values()];
  }

  get size(): number {
    return this.subs.size;
  }

  /**
   * Best-effort fan-out to every subscription. Never throws: a per-subscription
   * failure is swallowed (and, on a 404/410 "gone" response, prunes that
   * subscription); a failing push must never break the caller's flow.
   */
  async sendAll(payload: PushPayload): Promise<PushDeliveryReport> {
    const body = JSON.stringify(payload);
    const subs = [...this.subs.values()];
    const report: PushDeliveryReport = { attempted: subs.length, delivered: 0, failed: 0, pruned: 0 };
    if (subs.length === 0) return report;
    let changed = false;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await this.send(sub, body);
          report.delivered++;
        } catch (err) {
          report.failed++;
          if (isGoneStatus(err) && this.subs.delete(sub.endpoint)) {
            changed = true;
            report.pruned++;
          }
        }
      }),
    );
    if (changed) this.persist();
    return report;
  }
}
