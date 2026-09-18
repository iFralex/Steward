import { Store } from "../../mail-mirror/src/store.ts";
import { dbPath as mailDbPath } from "../../mail-mirror/src/paths.ts";
import { fileURLToPath } from "node:url";
import { buildMcpBridge, type McpBridge, type McpServerSpec } from "@steward/mcp-bridge";
import { actionDbPath } from "./paths.ts";
import { ActionStore } from "./store.ts";
import { gatewayChat } from "./llm.ts";
import { scanMailForActions } from "./mail.ts";
import { scanCalendarForActions } from "./calendar.ts";
import type { ActionStatus } from "./types.ts";
import { isAllowedReadTool } from "./tool-context.ts";
import { executeObservedReadTool } from "./observed-read-tool.ts";

async function main(argv = process.argv.slice(2)): Promise<void> {
  const cmd = argv[0] ?? "status";
  const actions = ActionStore.open(actionDbPath());
  try {
    if (cmd === "scan") {
      const what = argv[1] ?? "all";
      const out: Record<string, unknown> = {};
      const automation = actions.getAutomationSettings();
      if (!automation.enabled) {
        out.disabled = true;
        actions.setMeta("lastScan", { at: Math.floor(Date.now() / 1000), what, result: out });
        console.log(JSON.stringify(out, null, 2));
        return;
      }
      let readBridge: McpBridge | null = null;
      if (what === "all" || what === "mail") {
        const mail = Store.openReadonly(mailDbPath());
        try {
          if (process.env.ACTION_CENTER_READ_TOOLS !== "0") {
            readBridge = await buildMcpBridge(defaultReadToolServers());
          }
          const userAddrs = (mail.raw.prepare("SELECT emails FROM accounts").all() as { emails: string | null }[])
            .flatMap((r) => (r.emails ?? "").split(/[,;\s]+/).filter(Boolean));
          const bridgeForReadTools = readBridge;
          const recentDays = Number(process.env.ACTION_CENTER_MAIL_DAYS ?? 14);
          out.mail = await scanMailForActions({
            mail,
            actions,
            chat: gatewayChat(),
            userAddrs,
            limit: Number(process.env.ACTION_CENTER_MAIL_LIMIT ?? 50),
            recentDays,
            seedIfEmpty: process.env.ACTION_CENTER_NO_SEED !== "1",
            threadId: process.env.ACTION_CENTER_THREAD_ID ? Number(process.env.ACTION_CENTER_THREAD_ID) : undefined,
            ingestedAfter: automation.enabledAt ?? undefined,
            readTool: bridgeForReadTools
              ? (tool, input) => {
                  if (!isAllowedReadTool(tool)) throw new Error(`read tool not allowed: ${tool}`);
                  return executeObservedReadTool(bridgeForReadTools.callTool, tool, input);
                }
              : undefined,
          });
          // Keep the seen-ledger bounded to a little beyond the scan window.
          actions.pruneSeen(Math.floor(Date.now() / 1000) - (recentDays + 14) * 86400);
        } finally {
          mail.close();
          await readBridge?.close();
        }
      }
      if (what === "all" || what === "calendar") {
        out.calendar = scanCalendarForActions({
          actions,
          horizonDays: Number(process.env.ACTION_CENTER_CALENDAR_DAYS ?? 3),
          modifiedAfter: automation.enabledAt ?? undefined,
        });
      }
      actions.setMeta("lastScan", { at: Math.floor(Date.now() / 1000), what, result: out });
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd === "list") {
      const includeDone = argv.includes("--all");
      console.log(JSON.stringify(actions.list({ includeDone, limit: Number(argv[1] ?? 50) }), null, 2));
    } else if (cmd === "mark") {
      const id = Number(argv[1]);
      const status = argv[2] as ActionStatus;
      if (!Number.isSafeInteger(id) || !["new", "read", "done", "dismissed"].includes(status)) {
        throw new Error("usage: action-center mark <id> <new|read|done|dismissed>");
      }
      console.log(JSON.stringify({ ok: actions.mark(id, status) }));
    } else if (cmd === "status") {
      console.log(JSON.stringify(actions.counts(), null, 2));
    } else {
      console.log("usage: action-center <scan [all|mail|calendar]|list [limit] [--all]|mark <id> <status>|status>");
      process.exitCode = 2;
    }
  } finally {
    actions.close();
  }
}

function defaultReadToolServers(): Record<string, McpServerSpec> {
  const bundled = process.env.LLM_WIKI_BUNDLED_SERVICES === "1";
  const node = process.env.LLM_WIKI_NODE ?? process.execPath;
  const nodeArgs = (entry: string) => bundled ? [entry] : ["--import", "tsx", entry];
  const llmWikiMcpEntry =
    process.env.LLM_WIKI_MCP_ENTRY ??
    fileURLToPath(new URL("../../llm-wiki/mcp-server/dist/src/index.js", import.meta.url));
  const mailMcpEntry =
    process.env.MAIL_MCP_ENTRY ?? fileURLToPath(new URL("../../mail-mcp/src/index.ts", import.meta.url));
  const calendarMcpEntry =
    process.env.CALENDAR_MCP_ENTRY ?? fileURLToPath(new URL("../../calendar-mcp/src/index.ts", import.meta.url));
  const contactsMcpEntry =
    process.env.CONTACTS_MCP_ENTRY ?? fileURLToPath(new URL("../../contacts-mcp/src/index.ts", import.meta.url));
  return {
    "llm-wiki": { command: node, args: [llmWikiMcpEntry] },
    mail: { command: node, args: nodeArgs(mailMcpEntry) },
    calendar: { command: node, args: nodeArgs(calendarMcpEntry) },
    contacts: { command: node, args: nodeArgs(contactsMcpEntry) },
  };
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
