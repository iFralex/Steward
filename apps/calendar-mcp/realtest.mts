// Manual live check: reads the real Apple store + a create/delete round-trip.
// Run: node --import tsx apps/calendar-mcp/realtest.mts
import { AppleStore } from "./src/apple-store.ts";
import { applePath } from "./src/paths.ts";
import { createEvent, deleteEvent } from "./src/applescript.ts";

const store = AppleStore.openReadonly(applePath());
console.log("calendars:", store.listCalendars().length);
const soon = new Date(Date.now() + 3600_000).toISOString();
const later = new Date(Date.now() + 7200_000).toISOString();
const uid = await createEvent({ calendar: "Casa", summary: "calendar-mcp realtest (delete me)", start: soon, end: later, location: "Test" });
console.log("created:", uid);
await deleteEvent(uid);
console.log("deleted OK");
store.close();
