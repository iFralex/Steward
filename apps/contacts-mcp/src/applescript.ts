import { esc, runOsa, type OsaExec } from "@llm-wiki/applescript";

export interface CreateArgs {
  firstName?: string; lastName?: string; organization?: string; nickname?: string; note?: string;
  emails?: { address: string; label?: string }[];
  phones?: { number: string; label?: string }[];
}
export type UpdateArgs = { personId: string } & CreateArgs;

export function mapContactsError(stderr: string): string {
  if (/-1743\b|Not authorized/i.test(stderr)) {
    return "Automation permission for Contacts is not granted. Allow it in System Settings → Privacy & Security → Automation.";
  }
  if (/-1728\b/i.test(stderr)) return "Contacts could not find that contact (it may have been moved or deleted).";
  if (/-600\b|isn.t running/i.test(stderr)) return "Contacts.app is not running. Open Contacts and try again.";
  return stderr.trim() || "osascript failed";
}

function nameProps(a: CreateArgs): string {
  const p: string[] = [];
  if (a.firstName) p.push(`first name:"${esc(a.firstName)}"`);
  if (a.lastName) p.push(`last name:"${esc(a.lastName)}"`);
  if (a.organization) p.push(`organization:"${esc(a.organization)}"`);
  if (a.nickname) p.push(`nickname:"${esc(a.nickname)}"`);
  if (a.note) p.push(`note:"${esc(a.note)}"`);
  return p.join(", ");
}

function childLines(target: string, a: CreateArgs): string[] {
  const lines: string[] = [];
  for (const e of a.emails ?? []) {
    const lbl = e.label ? `label:"${esc(e.label)}", ` : "";
    lines.push(`  make new email at end of emails of ${target} with properties {${lbl}value:"${esc(e.address)}"}`);
  }
  for (const ph of a.phones ?? []) {
    const lbl = ph.label ? `label:"${esc(ph.label)}", ` : "";
    lines.push(`  make new phone at end of phones of ${target} with properties {${lbl}value:"${esc(ph.number)}"}`);
  }
  return lines;
}

export function buildCreate(a: CreateArgs): string {
  return [
    'tell application "Contacts"',
    `  set p to make new person with properties {${nameProps(a)}}`,
    ...childLines("p", a),
    "  save",
    "  return id of p",
    "end tell",
  ].join("\n");
}

export function buildUpdate(a: UpdateArgs): string {
  const lines = ['tell application "Contacts"', `  set p to (first person whose id is "${esc(a.personId)}")`];
  if (a.firstName) lines.push(`  set first name of p to "${esc(a.firstName)}"`);
  if (a.lastName) lines.push(`  set last name of p to "${esc(a.lastName)}"`);
  if (a.organization) lines.push(`  set organization of p to "${esc(a.organization)}"`);
  if (a.nickname) lines.push(`  set nickname of p to "${esc(a.nickname)}"`);
  if (a.note) lines.push(`  set note of p to "${esc(a.note)}"`);
  lines.push(...childLines("p", a), "  save", '  return "ok"', "end tell");
  return lines.join("\n");
}

const run = (script: string, exec?: OsaExec) => runOsa(script, { exec, mapError: mapContactsError });

export async function createContact(a: CreateArgs, exec?: OsaExec): Promise<string> {
  return (await run(buildCreate(a), exec)).trim();
}
export async function updateContact(a: UpdateArgs, exec?: OsaExec): Promise<void> {
  await run(buildUpdate(a), exec);
}
