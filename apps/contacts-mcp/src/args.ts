import type { CreateArgs, UpdateArgs } from "./applescript.ts";

type Raw = Record<string, unknown>;

export function requireString(raw: Raw, field: string): string {
  const v = raw[field];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`"${field}" is required and must be a non-empty string`);
  return v;
}
function optString(raw: Raw, field: string): string | undefined {
  const v = raw[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`"${field}" must be a string`);
  return v;
}
function clampLimit(raw: Raw, def: number): number {
  const v = raw.limit;
  return typeof v === "number" && v >= 1 ? Math.min(Math.floor(v), 50) : def;
}

export function parseSearchArgs(raw: Raw): { query: string; limit: number } {
  return { query: requireString(raw, "query"), limit: clampLimit(raw, 20) };
}
export function parseResolveArgs(raw: Raw): { description: string; limit: number } {
  return { description: requireString(raw, "description"), limit: clampLimit(raw, 5) };
}

function parseEmails(raw: Raw): { address: string; label?: string }[] | undefined {
  const v = raw.emails;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error(`"emails" must be an array`);
  return v.map((e) => {
    if (!e || typeof e !== "object" || typeof (e as Raw).address !== "string") throw new Error(`each of "emails" needs a string "address"`);
    const o = e as Raw;
    return { address: o.address as string, ...(typeof o.label === "string" ? { label: o.label } : {}) };
  });
}
function parsePhones(raw: Raw): { number: string; label?: string }[] | undefined {
  const v = raw.phones;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error(`"phones" must be an array`);
  return v.map((p) => {
    if (!p || typeof p !== "object" || typeof (p as Raw).number !== "string") throw new Error(`each of "phones" needs a string "number"`);
    const o = p as Raw;
    return { number: o.number as string, ...(typeof o.label === "string" ? { label: o.label } : {}) };
  });
}

function nameFields(raw: Raw): CreateArgs {
  return {
    firstName: optString(raw, "firstName"),
    lastName: optString(raw, "lastName"),
    organization: optString(raw, "organization"),
    nickname: optString(raw, "nickname"),
    note: optString(raw, "note"),
    emails: parseEmails(raw),
    phones: parsePhones(raw),
  };
}

export function parseCreateArgs(raw: Raw): CreateArgs {
  const a = nameFields(raw);
  if (!a.firstName && !a.lastName && !a.organization) throw new Error("a contact needs at least a name or organization");
  return a;
}
export function parseUpdateArgs(raw: Raw): UpdateArgs {
  return { personId: requireString(raw, "personId"), ...nameFields(raw) };
}
