import {eventKitCanRepresent} from './eventkit-client.ts';

/** Resolve before any native/AppleScript write. Duplicate titles are safe only
 * through EventKit's identifier-based selection. */
export function calendarCreateRoute(
  args: {calendarId?:string;recurrence?:string},
  listCalendars:()=>{id:string;title:string}[],
  bridgeAvailable:boolean,
): {kind:'eventkit'}|{kind:'applescript';calendar:string} {
  if(bridgeAvailable && eventKitCanRepresent(args.recurrence))return {kind:'eventkit'};
  const calendars=listCalendars();
  const selected=calendars.find(calendar=>calendar.id===args.calendarId);
  if(!selected)throw new Error(`Calendar id "${args.calendarId}" was not found`);
  if(calendars.filter(calendar=>calendar.title===selected.title).length!==1) {
    if(!bridgeAvailable)throw new Error('[CALENDAR_EVENTKIT_UNAVAILABLE] The Steward EventKit bridge is not configured in this connector. '
      +`AppleScript cannot select calendarId "${args.calendarId}" because title "${selected.title}" is duplicated. `
      +'Check launcher-to-connector configuration and restart Steward. No write was executed.');
    throw new Error('[CALENDAR_RRULE_UNSUPPORTED] This recurrence is outside the EventKit-supported RRULE subset. '
      +`AppleScript cannot safely select calendarId "${args.calendarId}" because title "${selected.title}" is duplicated. `
      +'Use a supported recurrence or explicitly choose a uniquely named destination. No write was executed.');
  }
  return {kind:'applescript',calendar:selected.title};
}
