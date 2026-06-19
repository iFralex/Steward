// apps/mail-mcp/src/capabilities.ts
import type { Store } from "../../mail-mirror/src/store.ts";

/** True when the mirror has been enriched/migrated (Plan A): messages.to_names + messages_trig exist. */
export function enrichmentReady(store: Store): boolean {
  const cols = (store.raw.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((r) => r.name);
  if (!cols.includes("to_names")) return false;
  const trig = store.raw
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_trig'")
    .get();
  return trig !== undefined;
}
