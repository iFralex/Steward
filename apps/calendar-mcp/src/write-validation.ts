import type { CalEvent } from './types.ts';
import type { UpdateArgs } from './applescript.ts';

/** Validate effective boundaries, including a one-sided edit against the live event. */
export function validateEventUpdate(args: UpdateArgs, current: CalEvent | undefined): void {
  if (!current) throw new Error('Calendar event was not found; refresh it before updating');
  const start = args.start ?? current.start;
  const end = args.end ?? current.end;
  if (Date.parse(end) <= Date.parse(start)) throw new Error('"end" must be after start, including unchanged boundaries');
}

export function requireCompatibleScope(args: { scope?: string }, useEventKit: boolean, recurring: boolean): void {
  if (!useEventKit && (args.scope === 'futureEvents' || recurring)) {
    throw new Error('Recurring occurrence updates and futureEvents require the EventKit bridge; no compatibility write was executed');
  }
}

export function filterEventText(events: CalEvent[], query?: string): CalEvent[] {
  if (!query?.trim()) return events;
  const normalize = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return events.filter(e => {
    const text = normalize([e.summary, e.description, e.location].filter(Boolean).join('\n'));
    return terms.every(term => text.includes(term));
  });
}
