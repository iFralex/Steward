import type { Store } from "./store.ts";
import { runOsa } from "./osascript.ts";

/** Emit one TAB-separated line per account: id<TAB>name<TAB>comma-joined emails. */
export function accountsScript(): string {
  return [
    "set TT to (ASCII character 9)",
    "set savedTID to AppleScript's text item delimiters",
    'set AppleScript\'s text item delimiters to ","',
    'set out to ""',
    'tell application "Mail"',
    "  repeat with a in accounts",
    '    set em to ""',
    "    try",
    "      set em to ((email addresses of a) as string)",
    "    end try",
    "    set out to out & (id of a) & TT & (name of a) & TT & em & linefeed",
    "  end repeat",
    "end tell",
    "set AppleScript's text item delimiters to savedTID",
    "return out",
  ].join("\n");
}

export function parseAccounts(out: string): { uuid: string; name: string; emails: string[] }[] {
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => {
      const [uuid, name, emails] = l.split("\t");
      return {
        uuid: (uuid ?? "").trim(),
        name: (name ?? "").trim(),
        emails: (emails ?? "").split(",").map((e) => e.trim()).filter(Boolean),
      };
    })
    .filter((a) => a.uuid);
}

/** Refresh the accounts table from Mail. Best-effort: returns 0 (and changes nothing) on any AppleScript error. */
export async function refreshAccounts(store: Store, exec: (script: string) => Promise<string> = (s) => runOsa(s)): Promise<number> {
  let out: string;
  try {
    out = await exec(accountsScript());
  } catch {
    return 0;
  }
  const accts = parseAccounts(out);
  for (const a of accts) store.upsertAccount(a.uuid, a.name, a.emails);
  return accts.length;
}
