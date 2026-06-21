const OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01 (UTC)

export function coreDataToUnix(v: number): number { return v + OFFSET; }
export function unixToCoreData(u: number): number { return u - OFFSET; }
export function coreDataToISO(v: number): string { return new Date(coreDataToUnix(v) * 1000).toISOString(); }
export function isoToUnix(s: string): number { return Math.floor(new Date(s).getTime() / 1000); }
