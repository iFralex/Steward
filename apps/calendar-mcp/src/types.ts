export interface CalEvent {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string; // ISO
  end: string;   // ISO
  allDay: boolean;
  calendar: string;
  account: string;
  status: number;
  url: string | null;
  lastModified: number; // core data seconds
}

export interface CalendarInfo { id: string; title: string; account: string; type: number }
