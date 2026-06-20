import type { SearchArgs } from "./types.ts";

/** Keys whose use requires the enriched/migrated mirror (Plan A columns/tables). */
const ADVANCED_KEYS: (keyof SearchArgs)[] = [
  "cc", "senderDomain", "answeredOnly", "junkOnly", "attachmentType", "attachmentName",
  "minSize", "maxSize", "anyMailbox", "sort", "sortDir",
  "fromName", "fromAddr", "toName", "subjectContains", "bodyContains",
];

/** True when the search args use any filter/param that needs the enriched mirror. */
export function usesAdvancedFilters(args: SearchArgs): boolean {
  return ADVANCED_KEYS.some((k) => {
    const v = args[k];
    return typeof v === "boolean" ? v : v !== undefined && v !== null && v !== "";
  });
}
