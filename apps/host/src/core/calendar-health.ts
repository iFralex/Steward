import type {CalendarDiagnostics} from '@steward/mcp-bridge/calendar-status';

/** Diagnostics stay separate from MCP catalog readiness and from write approval. */
export function calendarHealthChecks(status:CalendarDiagnostics) {
  const {appleStore,bridge}=status;
  return [
    {name:'Apple Calendar store (Full Disk Access)',nameKey:'system.permissions.calendarStore',ok:appleStore.readable,verified:true,
      detailKey:appleStore.readable?'system.permissions.calendarStoreReadable':'system.permissions.calendarStoreDenied',
      detail:appleStore.readable?'Calendar database is readable.':appleStore.error??'Calendar database is not readable. Check Full Disk Access.'},
    {name:'EventKit bridge',nameKey:'system.permissions.eventKitBridge',ok:bridge.configured&&bridge.reachable,verified:true,
      detailKey:bridge.reachable?'system.permissions.bridgeResponded':'system.permissions.bridgeUnavailable',
      detail:bridge.reachable?'Launcher bridge responded.':bridge.error??'EventKit bridge is unavailable.'},
    {name:'Calendar Full Access',nameKey:'system.permissions.calendarFullAccess',ok:bridge.reachable&&bridge.authorization==='fullAccess',verified:bridge.reachable,
      detailKey:!bridge.reachable?'system.permissions.calendarUnverified':bridge.authorization==='fullAccess'?'system.permissions.calendarGranted':`system.permissions.calendarAuthorization.${bridge.authorization??'unknown'}`,
      detail:bridge.reachable?(bridge.authorization==='fullAccess'
        ?'Granted. Individual calendars may still be read-only; writes require approval.'
        :`Authorization: ${bridge.authorization??'unknown'}. Allow Steward in System Settings → Privacy & Security → Calendars. Full Disk Access is a separate permission.`)
        :'Not verified because the EventKit bridge did not respond.'},
  ];
}
