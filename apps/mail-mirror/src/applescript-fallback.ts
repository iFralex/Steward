import { readScript } from "../../mail-mcp/src/applescript.ts";
import { parseDetail } from "../../mail-mcp/src/parse.ts";
import { runOsa } from "../../mail-mcp/src/osascript.ts";
import type { Store } from "./store.ts";

export async function fillBody(
  store: Store,
  messageId: string,
  run: (script: string) => Promise<string> = (s) => runOsa(s, { timeoutMs: 90_000 }),
): Promise<boolean> {
  const row = store.getMessage(messageId);
  if (!row || row.bodyState === "full") return false;
  const out = await run(readScript({ messageId }));
  const detail = parseDetail(out);
  if (!detail.body || detail.body.startsWith("[body unavailable")) return false;
  store.upsertMessage({ ...row, bodyText: detail.body, bodyState: "full", source: "applescript" });
  return true;
}
