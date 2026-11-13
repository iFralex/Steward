import { parentPort } from "node:worker_threads";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { UsageLedger } from "@steward/usage-ledger";

parentPort!.on("message", ({ days }) => {
  let db: Database.Database | undefined;
  try {
    const dir = process.env.USAGE_DIR ?? join(homedir(), "Library", "Application Support", "steward-usage");
    db = new Database(join(dir, "usage.db"), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    db.exec("BEGIN");
    const summary = UsageLedger.prototype.summary.call({ raw: db } as UsageLedger, days);
    db.exec("COMMIT");
    parentPort!.postMessage({ summary });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    db?.close();
  }
});
