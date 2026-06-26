import { Store } from "../../mail-mirror/src/store.ts";
import { dbPath as mailDbPath } from "../../mail-mirror/src/paths.ts";
import { actionDbPath } from "./paths.ts";
import { ActionStore } from "./store.ts";
import { gatewayChat } from "./llm.ts";
import { scanMailForActions } from "./mail.ts";
import { scanCalendarForActions } from "./calendar.ts";
import type { ActionStatus } from "./types.ts";

async function main(argv = process.argv.slice(2)): Promise<void> {
  const cmd = argv[0] ?? "status";
  const actions = ActionStore.open(actionDbPath());
  try {
    if (cmd === "scan") {
      const what = argv[1] ?? "all";
      const out: Record<string, unknown> = {};
      if (what === "all" || what === "mail") {
        const mail = Store.openReadonly(mailDbPath());
        try {
          const userAddrs = (mail.raw.prepare("SELECT emails FROM accounts").all() as { emails: string | null }[])
            .flatMap((r) => (r.emails ?? "").split(/[,;\s]+/).filter(Boolean));
          out.mail = await scanMailForActions({
            mail,
            actions,
            chat: gatewayChat(),
            userAddrs,
            limit: Number(process.env.ACTION_CENTER_MAIL_LIMIT ?? 50),
            recentDays: Number(process.env.ACTION_CENTER_MAIL_DAYS ?? 14),
          });
        } finally {
          mail.close();
        }
      }
      if (what === "all" || what === "calendar") {
        out.calendar = scanCalendarForActions({
          actions,
          horizonDays: Number(process.env.ACTION_CENTER_CALENDAR_DAYS ?? 3),
        });
      }
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

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
