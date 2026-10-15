import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CalEvent } from "./types.ts";
import { parseEventKitRecurrence } from "./rrule.ts";
import type { CreateArgs, UpdateArgs } from "./applescript.ts";

interface BridgeResponse {
  ok: boolean;
  result?: { uid?: string; event?: CalEvent | null; events?: CalEvent[] };
  error?: string;
  outcomeUnknown?: boolean;
}

export function eventKitBridgeAvailable(): boolean {
  return typeof process.env.STEWARD_CALENDAR_BRIDGE_DIR === "string" && process.env.STEWARD_CALENDAR_BRIDGE_DIR.length > 0;
}

export function eventKitCanRepresent(recurrence: string | undefined): boolean {
  if (!recurrence) return true;
  try { parseEventKitRecurrence(recurrence); return true; } catch { return false; }
}

async function callBridge(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<NonNullable<BridgeResponse["result"]>> {
  const root = process.env.STEWARD_CALENDAR_BRIDGE_DIR;
  if (!root) throw new Error("[CALENDAR_EVENTKIT_UNAVAILABLE] Steward Calendar EventKit bridge is not configured in this connector. Check launcher-to-connector configuration.");
  const requests = join(root, "requests");
  const responses = join(root, "responses");
  await mkdir(requests, { recursive: true, mode: 0o700 });
  await mkdir(responses, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const temporary = join(requests, `.${id}.tmp`);
  const requestPath = join(requests, `${id}.json`);
  const responsePath = join(responses, `${id}.json`);
  await writeFile(temporary, JSON.stringify({ id, method, params, expiresAtMs: Date.now() + timeoutMs }), { mode: 0o600, flag: "wx" });
  await rename(temporary, requestPath);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await readFile(responsePath, "utf8")) as BridgeResponse;
      await unlink(responsePath).catch(() => undefined);
      if (!response.ok) {
        const suffix = response.outcomeUnknown ? " (outcome unknown; reconciliation required)" : "";
        throw new Error(`${response.error ?? "EventKit bridge failed"}${suffix}`);
      }
      return response.result ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    await unlink(requestPath);
    throw new Error('Calendar request expired before processing; no write was executed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  throw new Error(`Calendar EventKit bridge timed out after ${timeoutMs}ms; outcome unknown; do not repeat without verification`);
}

function eventKitParams(args: CreateArgs | UpdateArgs): Record<string, unknown> {
  const { recurrence, ...params } = args;
  return {
    ...params,
    ...(recurrence ? { recurrenceSpec: parseEventKitRecurrence(recurrence) } : recurrence === "" ? { clearRecurrence: true } : {}),
  };
}

export async function createEventKit(args: CreateArgs): Promise<string> {
  const result = await callBridge("create", eventKitParams(args));
  if (!result.uid) throw new Error("EventKit bridge created an event without returning its identifier");
  return result.uid;
}

export async function updateEventKit(args: UpdateArgs & { scope?: "thisEvent" | "futureEvents" }): Promise<void> {
  await callBridge("update", eventKitParams(args));
}

export async function deleteEventKit(uid: string, scope: "thisEvent" | "futureEvents" = "thisEvent", occurrenceStart?: string): Promise<void> {
  await callBridge("delete", { uid, scope, ...(occurrenceStart ? { occurrenceStart } : {}) });
}

export async function pingEventKitBridge(timeoutMs = 3_000): Promise<boolean> {
  try { await callBridge("ping", {}, timeoutMs); return true; } catch { return false; }
}

export async function searchEventKit(params: { start: string; end: string; account?: string; calendar?: string }): Promise<CalEvent[]> {
  return (await callBridge('search', params)).events ?? [];
}

export async function readEventKit(uid: string, occurrenceStart?: string): Promise<CalEvent | null> {
  return (await callBridge('read', { uid, ...(occurrenceStart ? { occurrenceStart } : {}) })).event ?? null;
}
