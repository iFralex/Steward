import { decodeTrainRef, encodeTrainRef } from "./ref.ts";
import type { PlatformStatus, Station, TrainDataSource, TrainRefData, TrainSnapshot, TrainStopSnapshot } from "./types.ts";

export class AmbiguousStationError extends Error {
  constructor(readonly query: string, readonly candidates: Station[]) {
    super(`Station "${query}" is ambiguous.`);
  }
}

export class TrainService {
  constructor(private readonly source: TrainDataSource) {}

  async findNextTrain(fromQuery: string, toQuery: string, departureAfter?: string): Promise<TrainSnapshot> {
    const [from, to] = await Promise.all([this.resolveStation(fromQuery), this.resolveStation(toQuery)]);
    if (from.id === to.id) throw new Error("Departure and arrival stations must be different.");
    const after = parseDate(departureAfter) ?? new Date();
    const rows = await this.source.departures(from.id, after);
    const candidates = rows
      .map((row) => ({ row, time: millis(row.orarioPartenza) ?? millis(row.orarioPartenzaZero) }))
      .filter(({ time }) => time === undefined || time >= after.getTime() - 2 * 60_000)
      .sort((a, b) => (a.time ?? Number.MAX_SAFE_INTEGER) - (b.time ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 10);

    const checked = await Promise.all(candidates.map(async ({ row }) => {
      const trainNumber = text(row.numeroTreno);
      const originId = text(row.codOrigine) ?? text(row.idOrigine);
      if (!trainNumber || !originId) return null;
      try {
        const serviceDay = firstMillis(row.dataPartenzaTreno, row.millisDataPartenza, row.dataPartenza);
        const raw = await this.source.trainStatus(originId, trainNumber, serviceDay);
        if (!Object.keys(raw).length) return null;
        const ref: TrainRefData = {
          version: 1, trainNumber, originId, serviceDay,
          fromId: from.id, toId: to.id, fromName: displayName(from), toName: displayName(to),
        };
        const snapshot = normalizeStatus(raw, ref, row);
        return snapshot.routeMatches ? snapshot.value : null;
      } catch {
        return null;
      }
    }));
    const matching = checked.filter((item): item is TrainSnapshot => !!item)
      .sort((a, b) => (a.scheduledDepartureMs ?? Number.MAX_SAFE_INTEGER) - (b.scheduledDepartureMs ?? Number.MAX_SAFE_INTEGER));
    if (!matching.length) {
      throw new Error(`No direct live train found from ${displayName(from)} to ${displayName(to)} in the current departure-board window.`);
    }
    return matching[0];
  }

  async status(trainRef: string): Promise<TrainSnapshot> {
    const ref = decodeTrainRef(trainRef);
    const raw = await this.source.trainStatus(ref.originId, ref.trainNumber, ref.serviceDay);
    if (!Object.keys(raw).length) throw new Error("No current live data is available for this train.");
    return normalizeStatus(raw, ref).value;
  }

  private async resolveStation(query: string): Promise<Station> {
    let candidates = await this.source.searchStations(query);
    if (!candidates.length) {
      // ViaggiaTreno autocomplete is prefix-based and returns nothing for many
      // otherwise recognisable dictation errors. Broaden only after the exact
      // query failed; this stays stateless and never consults personal memory.
      const tokens = normalizeName(query).split(" ").filter((token) => token.length >= 3);
      const fallbacks = [...new Set(tokens.flatMap((token) => [token, token.slice(0, 3)]))]
        .filter((value) => value !== normalizeName(query));
      const groups = await Promise.all(fallbacks.map((value) => this.source.searchStations(value).catch(() => [])));
      const unique = new Map<string, Station>();
      for (const station of groups.flat()) unique.set(station.id, station);
      candidates = [...unique.values()];
    }
    if (!candidates.length) throw new Error(`Station "${query}" was not found.`);
    const wanted = normalizeName(query);
    const canonicalExact = candidates.filter((station) => [station.name, station.shortName].filter((name): name is string => !!name)
      .some((name) => normalizeName(name) === wanted || compactName(name) === compactName(query)));
    if (canonicalExact.length === 1) return canonicalExact[0];
    const labelExact = candidates.filter((station) => station.label
      && (normalizeName(station.label) === wanted || compactName(station.label) === compactName(query)));
    if (!canonicalExact.length && labelExact.length === 1) return labelExact[0];
    const ranked = candidates
      .map((station) => ({ station, score: Math.max(...stationNames(station).map((name) => stationSimilarity(query, name))) }))
      .sort((a, b) => b.score - a.score);
    if (ranked.length === 1 && ranked[0].score >= 0.68) return ranked[0].station;
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (best && best.score >= 0.86 && (!runnerUp || best.score - runnerUp.score >= 0.08)) return best.station;
    throw new AmbiguousStationError(query, ranked.slice(0, 8).map(({ station }) => station));
  }
}

function normalizeStatus(raw: Record<string, unknown>, ref: TrainRefData, departureRow?: Record<string, unknown>): { value: TrainSnapshot; routeMatches: boolean } {
  const stops = Array.isArray(raw.fermate) ? raw.fermate.map(object) : [];
  const fromIndex = ref.fromId ? stops.findIndex((stop) => stationId(stop) === ref.fromId) : 0;
  const toIndex = ref.toId ? stops.findIndex((stop) => stationId(stop) === ref.toId) : stops.length - 1;
  const routeMatches = fromIndex >= 0 && toIndex > fromIndex;
  const fromStop = stops[fromIndex] ?? {};
  const toStop = stops[toIndex] ?? {};
  const delayMinutes = integer(fromStop.ritardoPartenza) ?? integer(fromStop.ritardo) ?? integer(raw.ritardo) ?? integer(departureRow?.ritardo) ?? 0;
  const scheduledDepartureMs = firstMillis(fromStop.partenza_teorica, fromStop.programmata, departureRow?.orarioPartenza, raw.orarioPartenza);
  const scheduledArrivalMs = firstMillis(toStop.arrivo_teorico, toStop.programmata, raw.orarioArrivo);
  const actualDepartureMs = firstMillis(fromStop.partenzaReale, fromStop.effettiva);
  const actualArrivalMs = firstMillis(toStop.arrivoReale, toStop.effettiva);
  const departureDelaySeconds = varianceSeconds(actualDepartureMs, scheduledDepartureMs);
  const arrivalDelaySeconds = varianceSeconds(actualArrivalMs, scheduledArrivalMs);
  const normalizedStops: TrainStopSnapshot[] = stops.map((stop, index) => {
    const scheduledArrivalMs = firstMillis(stop.arrivo_teorico, stop.programmata);
    const actualArrivalMs = firstMillis(stop.arrivoReale, stop.partenza_teorica ? undefined : stop.effettiva);
    const scheduledDepartureMs = firstMillis(stop.partenza_teorica, stop.programmata);
    const actualDepartureMs = firstMillis(stop.partenzaReale, stop.arrivo_teorico ? undefined : stop.effettiva);
    const scheduledArrivalPlatform = firstText(stop.binarioProgrammatoArrivoDescrizione, stop.binarioProgrammatoArrivo);
    const actualArrivalPlatform = firstText(stop.binarioEffettivoArrivoDescrizione, stop.binarioEffettivoArrivo);
    const scheduledDeparturePlatform = firstText(stop.binarioProgrammatoPartenzaDescrizione, stop.binarioProgrammatoPartenza);
    const actualDeparturePlatform = firstText(stop.binarioEffettivoPartenzaDescrizione, stop.binarioEffettivoPartenza);
    return compact({
      id: stationId(stop), name: firstText(stop.stazione) ?? `Fermata ${index + 1}`, index,
      scheduledArrival: formatRome(scheduledArrivalMs), actualArrival: formatRome(actualArrivalMs),
      scheduledDeparture: formatRome(scheduledDepartureMs), actualDeparture: formatRome(actualDepartureMs),
      scheduledArrivalMs, actualArrivalMs, scheduledDepartureMs, actualDepartureMs,
      cancelled: integer(stop.actualFermataType) === 3 || bool(stop.soppressa),
      scheduledArrivalPlatform, actualArrivalPlatform,
      arrivalPlatformStatus: platformConfidence(actualArrivalPlatform, scheduledArrivalPlatform),
      scheduledDeparturePlatform, actualDeparturePlatform,
      departurePlatformStatus: platformConfidence(actualDeparturePlatform, scheduledDeparturePlatform),
      ...(toIndex >= 0 ? { positionRelativeToDestination: index - toIndex } : {}),
    });
  });
  const scheduledPlatform = firstText(
    fromStop.binarioProgrammatoPartenzaDescrizione, fromStop.binarioProgrammatoPartenza,
    departureRow?.binarioProgrammatoPartenzaDescrizione, departureRow?.binarioPartenza,
  );
  const actualPlatform = firstText(
    fromStop.binarioEffettivoPartenzaDescrizione, fromStop.binarioEffettivoPartenza,
    departureRow?.binarioEffettivoPartenzaDescrizione,
  );
  const platformStatus: PlatformStatus = actualPlatform ? "confirmed" : scheduledPlatform ? "scheduled" : "unknown";
  const scheduledArrivalPlatform = firstText(toStop.binarioProgrammatoArrivoDescrizione, toStop.binarioProgrammatoArrivo);
  const actualArrivalPlatform = firstText(toStop.binarioEffettivoArrivoDescrizione, toStop.binarioEffettivoArrivo);
  const arrivalPlatformStatus = platformConfidence(actualArrivalPlatform, scheduledArrivalPlatform);
  const cancelled = ["ST", "SI", "SF"].includes(text(raw.tipoTreno) ?? "") || bool(raw.provvedimento) || integer(fromStop.actualFermataType) === 3 || bool(fromStop.soppressa);
  const departed = departureRow?.nonPartito === false || actualDepartureMs !== undefined || (fromIndex >= 0 && lastDetectedIndex(raw, stops) > fromIndex);
  const arrived = bool(raw.arrivato) || actualArrivalMs !== undefined;
  const trainRef = encodeTrainRef({
    trainNumber: ref.trainNumber, originId: ref.originId, serviceDay: ref.serviceDay,
    fromId: ref.fromId, toId: ref.toId, fromName: ref.fromName, toName: ref.toName,
  });
  return {
    routeMatches,
    value: compact({
      trainRef,
      trainNumber: ref.trainNumber,
      category: firstText(raw.categoria, departureRow?.categoriaDescrizione, departureRow?.categoria),
      origin: firstText(raw.origine), destination: firstText(raw.destinazione),
      from: ref.fromName ?? firstText(fromStop.stazione), to: ref.toName ?? firstText(toStop.stazione),
      scheduledDeparture: formatRome(scheduledDepartureMs),
      estimatedDeparture: formatRome(actualDepartureMs ?? addMinutes(scheduledDepartureMs, delayMinutes)),
      scheduledArrival: formatRome(scheduledArrivalMs),
      estimatedArrival: formatRome(actualArrivalMs ?? addMinutes(scheduledArrivalMs, delayMinutes)),
      estimatedArrivalMs: actualArrivalMs ?? addMinutes(scheduledArrivalMs, delayMinutes),
      scheduledDepartureMs, scheduledArrivalMs,
      delayMinutes, departureDelaySeconds, arrivalDelaySeconds,
      departureDelayMinutes: minutesFromSeconds(departureDelaySeconds),
      arrivalDelayMinutes: minutesFromSeconds(arrivalDelaySeconds),
      platform: actualPlatform ?? scheduledPlatform, scheduledPlatform, actualPlatform, platformStatus,
      departurePlatform: actualPlatform ?? scheduledPlatform,
      scheduledDeparturePlatform: scheduledPlatform, actualDeparturePlatform: actualPlatform,
      departurePlatformStatus: platformStatus,
      arrivalPlatform: actualArrivalPlatform ?? scheduledArrivalPlatform,
      scheduledArrivalPlatform, actualArrivalPlatform, arrivalPlatformStatus,
      cancelled, departed, arrived,
      lastDetectedStation: firstText(raw.stazioneUltimoRilevamento),
      stops: normalizedStops,
      lastUpdated: new Date().toISOString(), source: "ViaggiaTreno" as const,
    }),
  };
}

function lastDetectedIndex(raw: Record<string, unknown>, stops: Record<string, unknown>[]): number {
  const name = normalizeName(firstText(raw.stazioneUltimoRilevamento) ?? "");
  return name ? stops.findIndex((stop) => normalizeName(firstText(stop.stazione) ?? "") === name) : -1;
}

function stationId(stop: Record<string, unknown>): string | undefined { return firstText(stop.id, stop.codiceStazione); }
function displayName(station: Station): string {
  return station.label && compactName(station.label) === compactName(station.name) ? station.label : station.name;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" || typeof value === "number" ? String(value).trim() || undefined : undefined; }
function firstText(...values: unknown[]): string | undefined { for (const value of values) { const found = text(value); if (found && found !== "--") return found; } return undefined; }
function integer(value: unknown): number | undefined { const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN; return Number.isFinite(n) ? Math.trunc(n) : undefined; }
function bool(value: unknown): boolean { return value === true || value === 1 || value === "1" || value === "true"; }
function millis(value: unknown): number | undefined { const n = integer(value); return n !== undefined && n > 10_000_000_000 ? n : undefined; }
function firstMillis(...values: unknown[]): number | undefined { for (const value of values) { const found = millis(value); if (found !== undefined) return found; } return undefined; }
function addMinutes(value: number | undefined, minutes: number): number | undefined { return value === undefined ? undefined : value + minutes * 60_000; }
function varianceSeconds(actual: number | undefined, scheduled: number | undefined): number | undefined {
  return actual === undefined || scheduled === undefined ? undefined : Math.round((actual - scheduled) / 1_000);
}
function minutesFromSeconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value / 60);
}
function platformConfidence(actual?: string, scheduled?: string): PlatformStatus {
  return actual ? "confirmed" : scheduled ? "scheduled" : "unknown";
}
function parseDate(value?: string): Date | undefined { if (!value) return undefined; const date = new Date(value); if (Number.isNaN(date.getTime())) throw new Error("departureAfter must be an ISO 8601 date-time with timezone."); return date; }
function normalizeName(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, " ").trim().toLowerCase(); }
function compactName(value: string): string { return normalizeName(value).replace(/\s+/g, ""); }
function stationNames(station: Station): string[] { return [station.name, station.shortName, station.label].filter((name): name is string => !!name); }
export function stationSimilarity(query: string, candidate: string): number {
  const a = compactName(query);
  const b = compactName(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const edit = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  const dice = trigramDice(a, b);
  const queryTokens = new Set(normalizeName(query).split(" ").filter(Boolean));
  const candidateTokens = new Set(normalizeName(candidate).split(" ").filter(Boolean));
  const overlap = queryTokens.size
    ? [...queryTokens].filter((token) => candidateTokens.has(token)).length / queryTokens.size
    : 0;
  const containment = a.includes(b) || b.includes(a) ? Math.min(a.length, b.length) / Math.max(a.length, b.length) : 0;
  return Math.max(edit * 0.55 + dice * 0.35 + overlap * 0.1, containment * 0.92);
}
function trigramDice(a: string, b: string): number {
  const grams = (value: string) => {
    const padded = `  ${value}  `;
    const result: string[] = [];
    for (let i = 0; i <= padded.length - 3; i++) result.push(padded.slice(i, i + 3));
    return result;
  };
  const left = grams(a);
  const right = grams(b);
  const counts = new Map<string, number>();
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let common = 0;
  for (const gram of right) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) { common++; counts.set(gram, count - 1); }
  }
  return (2 * common) / (left.length + right.length);
}
function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}
function formatRome(value?: number): string | undefined { return value === undefined ? undefined : new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
function compact<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
