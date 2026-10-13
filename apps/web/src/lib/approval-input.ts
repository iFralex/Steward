export type ApprovalFieldKind = "text" | "textarea" | "csv" | "bool" | "numbers" | "datetime" | "files";

export interface ApprovalField {
  key: string;
  labelKey: string;
  kind: ApprovalFieldKind;
}

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value];

export function toEditable(kind: ApprovalFieldKind, value: unknown): string | boolean {
  if (kind === "bool") return value === true;
  if (kind === "csv" || kind === "numbers") return asArray(value).map(String).join(", ");
  if (kind === "files") return asArray(value).map(String).join("\n");
  return value == null ? "" : String(value);
}

/**
 * Build the effective approval input without manufacturing optional values.
 * In particular, an absent boolean must not become `false`, and an absent
 * array must not become `[]`: both can carry destructive update semantics.
 */
export function buildEditedApprovalInput(
  input: Record<string, unknown>,
  fields: ApprovalField[],
  values: Record<string, string | boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const field of fields) {
    const raw = values[field.key];
    const wasPresent = Object.prototype.hasOwnProperty.call(input, field.key);
    if (field.kind === "bool") {
      if (!wasPresent && raw !== true) delete out[field.key];
      else out[field.key] = raw === true;
      continue;
    }
    if (field.kind === "csv" || field.kind === "files" || field.kind === "numbers") {
      const separator = field.kind === "files" ? "\n" : ",";
      const items = String(raw).split(separator).map((item) => item.trim()).filter(Boolean);
      const parsed = field.kind === "numbers"
        ? items.map(Number).filter((item) => Number.isFinite(item))
        : items;
      if (!wasPresent && parsed.length === 0) delete out[field.key];
      else out[field.key] = parsed;
      continue;
    }
    const text = String(raw);
    if (text.trim() === "") delete out[field.key];
    else out[field.key] = text;
  }
  return out;
}
