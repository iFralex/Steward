export interface CalEvent {
  uid: string;
  /** Server-provided identity; more durable than uid but not necessarily unique. */
  externalId?: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  start: string; // ISO
  end: string;   // ISO
  allDay: boolean;
  calendarId: string;
  calendar: string;
  account: string;
  /** Explicit per-event display alarms, in minutes before the event. */
  alarms: number[];
  /** Whether Calendar stores one or more recurrence rules for this event. */
  hasRecurrence: boolean;
  status: number;
  url: string | null;
  lastModified: number; // core data seconds
}

export interface CalendarInfo { id: string; title: string; account: string; type: number }
