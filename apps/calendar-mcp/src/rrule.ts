export type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface RecurrenceWeekday {
  day: "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
  ordinal?: number;
}

export interface EventKitRecurrenceSpec {
  frequency: RecurrenceFrequency;
  interval: number;
  count?: number;
  until?: string;
  daysOfWeek?: RecurrenceWeekday[];
  daysOfMonth?: number[];
  monthsOfYear?: number[];
  weeksOfYear?: number[];
  daysOfYear?: number[];
  setPositions?: number[];
}

const FREQUENCIES = new Set<RecurrenceFrequency>(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const WEEKDAYS = new Set<RecurrenceWeekday["day"]>(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
const SUPPORTED_KEYS = new Set([
  "FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY",
  "BYMONTH", "BYWEEKNO", "BYYEARDAY", "BYSETPOS",
]);

function integer(value: string, name: string, min: number, max: number, disallowZero = false): number {
  if (!/^[+-]?\d+$/.test(value)) throw new Error(`${name} must contain integers`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max || (disallowZero && parsed === 0)) {
    throw new Error(`${name} values must be between ${min} and ${max}${disallowZero ? " and cannot be zero" : ""}`);
  }
  return parsed;
}

function integerList(value: string, name: string, min: number, max: number, disallowZero = false): number[] {
  if (!value) throw new Error(`${name} cannot be empty`);
  return value.split(",").map((item) => integer(item, name, min, max, disallowZero));
}

function parseUntil(value: string): string {
  if (/^\d{8}$/.test(value)) return value;
  if (/^\d{8}T\d{6}Z$/.test(value)) return value;
  throw new Error("UNTIL must be YYYYMMDD or an RFC 5545 UTC date-time (YYYYMMDDTHHMMSSZ)");
}

/**
 * Parses the exact RFC 5545 subset representable by EKRecurrenceRule.
 * Unknown fields are rejected instead of being silently dropped.
 */
export function parseEventKitRecurrence(input: string): EventKitRecurrenceSpec {
  const source = input.trim().replace(/^RRULE:/i, "");
  if (!source) throw new Error("recurrence cannot be empty");
  const values = new Map<string, string>();
  for (const component of source.split(";")) {
    const separator = component.indexOf("=");
    if (separator <= 0 || separator === component.length - 1) throw new Error(`Invalid recurrence component: ${component}`);
    const key = component.slice(0, separator).toUpperCase();
    const value = component.slice(separator + 1).toUpperCase();
    if (!SUPPORTED_KEYS.has(key)) throw new Error(`${key} is not representable by EventKit`);
    if (values.has(key)) throw new Error(`Duplicate recurrence component: ${key}`);
    values.set(key, value);
  }

  const frequency = values.get("FREQ") as RecurrenceFrequency | undefined;
  if (!frequency || !FREQUENCIES.has(frequency)) throw new Error("FREQ must be DAILY, WEEKLY, MONTHLY, or YEARLY");
  if (values.has("COUNT") && values.has("UNTIL")) throw new Error("COUNT and UNTIL are mutually exclusive");

  const result: EventKitRecurrenceSpec = {
    frequency,
    interval: values.has("INTERVAL") ? integer(values.get("INTERVAL")!, "INTERVAL", 1, 999) : 1,
  };
  if (values.has("COUNT")) result.count = integer(values.get("COUNT")!, "COUNT", 1, 1_000_000);
  if (values.has("UNTIL")) result.until = parseUntil(values.get("UNTIL")!);
  if (values.has("BYDAY")) {
    result.daysOfWeek = values.get("BYDAY")!.split(",").map((item) => {
      const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
      if (!match || !WEEKDAYS.has(match[2] as RecurrenceWeekday["day"])) throw new Error(`Invalid BYDAY value: ${item}`);
      const ordinal = match[1] === undefined ? undefined : integer(match[1], "BYDAY ordinal", -53, 53, true);
      return { day: match[2] as RecurrenceWeekday["day"], ...(ordinal === undefined ? {} : { ordinal }) };
    });
  }
  if (values.has("BYMONTHDAY")) result.daysOfMonth = integerList(values.get("BYMONTHDAY")!, "BYMONTHDAY", -31, 31, true);
  if (values.has("BYMONTH")) result.monthsOfYear = integerList(values.get("BYMONTH")!, "BYMONTH", 1, 12);
  if (values.has("BYWEEKNO")) result.weeksOfYear = integerList(values.get("BYWEEKNO")!, "BYWEEKNO", -53, 53, true);
  if (values.has("BYYEARDAY")) result.daysOfYear = integerList(values.get("BYYEARDAY")!, "BYYEARDAY", -366, 366, true);
  if (values.has("BYSETPOS")) result.setPositions = integerList(values.get("BYSETPOS")!, "BYSETPOS", -366, 366, true);
  return result;
}

export function eventKitSupportsRecurrence(input: string): boolean {
  try {
    parseEventKitRecurrence(input);
    return true;
  } catch {
    return false;
  }
}
