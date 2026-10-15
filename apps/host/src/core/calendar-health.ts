import type {CalendarDiagnostics} from '@steward/mcp-bridge/calendar-status';

/** Diagnostics stay separate from MCP catalog readiness and from write approval. */
export function calendarHealthChecks(status:CalendarDiagnostics) {
  const {appleStore,bridge}=status;
  return [
    {name:'Apple Calendar store (Full Disk Access)',ok:appleStore.readable,verified:true,
      detail:appleStore.readable?'Calendar database is readable.':appleStore.error??'Calendar database is not readable. Check Full Disk Access.'},
    {name:'EventKit bridge',ok:bridge.configured&&bridge.reachable,verified:true,
      detail:bridge.reachable?'Launcher bridge responded.':bridge.error??'EventKit bridge is unavailable.'},
    {name:'Calendar Full Access',ok:bridge.reachable&&bridge.authorization==='fullAccess',verified:bridge.reachable,
      detail:bridge.reachable?(bridge.authorization==='fullAccess'
        ?'Granted. Individual calendars may still be read-only; writes require approval.'
        :`Authorization: ${bridge.authorization??'unknown'}. Allow Steward in System Settings → Privacy & Security → Calendars. Full Disk Access is a separate permission.`)
        :'Not verified because the EventKit bridge did not respond.'},
  ];
}
