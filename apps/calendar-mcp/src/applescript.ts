import { esc, runOsa, type OsaExec } from "@llm-wiki/applescript";

export interface CreateArgs {
  calendar: string; summary: string; start: string; end: string;
  allDay?: boolean; location?: string; description?: string; url?: string; recurrence?: string;
}
export interface UpdateArgs {
  uid: string; summary?: string; start?: string; end?: string;
  location?: string; description?: string; url?: string; recurrence?: string;
}

export function mapCalendarError(stderr: string): string {
  if (/-1743\b|Not authorized/i.test(stderr)) {
    return "Automation permission for Calendar is not granted. Allow it in System Settings → Privacy & Security → Automation.";
  }
  if (/-1728\b/i.test(stderr)) {
    return "Calendar could not find the target calendar or event (it may have been moved or deleted).";
  }
  if (/-600\b|isn.t running/i.test(stderr)) {
    return "Calendar.app is not running. Open Calendar and try again.";
  }
  return stderr.trim() || "osascript failed";
}

/** AppleScript date literal from an ISO string, built field-by-field to avoid locale parsing. */
function dateExpr(varName: string, iso: string): string[] {
  const d = new Date(iso);
  return [
    `set ${varName} to current date`,
    `set year of ${varName} to ${d.getFullYear()}`,
    `set month of ${varName} to ${d.getMonth() + 1}`,
    `set day of ${varName} to ${d.getDate()}`,
    `set hours of ${varName} to ${d.getHours()}`,
    `set minutes of ${varName} to ${d.getMinutes()}`,
    `set seconds of ${varName} to ${d.getSeconds()}`,
  ];
}

export function buildCreate(a: CreateArgs): string {
  const props: string[] = [`summary:"${esc(a.summary)}"`, "start date:startD", "end date:endD"];
  if (a.allDay) props.push("allday event:true");
  if (a.location) props.push(`location:"${esc(a.location)}"`);
  if (a.description) props.push(`description:"${esc(a.description)}"`);
  const lines = [
    'tell application "Calendar"',
    ...dateExpr("startD", a.start),
    ...dateExpr("endD", a.end),
    `  tell calendar "${esc(a.calendar)}"`,
    `    set e to make new event with properties {${props.join(", ")}}`,
  ];
  if (a.url) lines.push(`    set url of e to "${esc(a.url)}"`);
  if (a.recurrence) lines.push(`    set recurrence of e to "${esc(a.recurrence)}"`);
  lines.push("    set theUID to uid of e", "  end tell", "  return theUID", "end tell");
  return lines.join("\n");
}

export function buildUpdate(a: UpdateArgs): string {
  const lines: string[] = ['tell application "Calendar"'];

  // Date-setup lines first (before the lookup loop)
  if (a.start) lines.push(...dateExpr("startD", a.start));
  if (a.end) lines.push(...dateExpr("endD", a.end));

  // Across-calendars lookup loop: find theEvent whose uid matches, exit on first match
  lines.push(
    "  set theEvent to missing value",
    "  repeat with c in calendars",
    "    try",
    `      set theEvent to (first event of c whose uid is "${esc(a.uid)}")`,
    "      exit repeat",
    "    end try",
    "  end repeat",
    `  if theEvent is missing value then error "-1728"`,
  );

  // Per-field setters for each provided field
  if (a.summary) lines.push(`  set summary of theEvent to "${esc(a.summary)}"`);
  if (a.start) lines.push("  set start date of theEvent to startD");
  if (a.end) lines.push("  set end date of theEvent to endD");
  if (a.location) lines.push(`  set location of theEvent to "${esc(a.location)}"`);
  if (a.description) lines.push(`  set description of theEvent to "${esc(a.description)}"`);
  if (a.url) lines.push(`  set url of theEvent to "${esc(a.url)}"`);
  if (a.recurrence) lines.push(`  set recurrence of theEvent to "${esc(a.recurrence)}"`);

  lines.push('  return "ok"', "end tell");
  return lines.join("\n");
}

export function buildDelete(uid: string): string {
  return [
    'tell application "Calendar"',
    "  repeat with c in calendars",
    "    try",
    `      delete (first event of c whose uid is "${esc(uid)}")`,
    '      return "ok"',
    "    end try",
    "  end repeat",
    '  error "-1728"',
    "end tell",
  ].join("\n");
}

const run = (script: string, exec?: OsaExec) => runOsa(script, { exec, mapError: mapCalendarError });

export async function createEvent(a: CreateArgs, exec?: OsaExec): Promise<string> {
  return (await run(buildCreate(a), exec)).trim();
}
export async function updateEvent(a: UpdateArgs, exec?: OsaExec): Promise<void> {
  await run(buildUpdate(a), exec);
}
export async function deleteEvent(uid: string, exec?: OsaExec): Promise<void> {
  await run(buildDelete(uid), exec);
}
