import type { DomainEvent, WatchAdapter, WatchDefinition, WatchRecord } from "@steward/watch-engine";
import { ViaggiaTrenoClient } from "../../../train-mcp/src/client.ts";
import { TrainService } from "../../../train-mcp/src/service.ts";
import type { TrainSnapshot, TrainStopSnapshot } from "../../../train-mcp/src/types.ts";

const TRAIN_NOTIFICATION = {
  title: { en: "Train update", it: "Aggiornamento treno" },
  guidance: {
    en: "For railway platforms, always distinguish confirmed, scheduled-only, and not announced. State the last update time when available.",
    it: "Per i binari distingui sempre confermato, soltanto programmato e non comunicato. Indica l'ora dell'ultimo aggiornamento se disponibile.",
  },
};

export class TrainWatchAdapter implements WatchAdapter {
  readonly source = "train";
  constructor(private readonly service: Pick<TrainService, "status"> = new TrainService(new ViaggiaTrenoClient())) {}

  snapshot(resourceRef: string): Promise<TrainSnapshot> { return this.service.status(resourceRef); }

  defaultExpiry(value: unknown): number {
    const snapshot = trainSnapshot(value);
    return (snapshot.scheduledArrivalMs ?? snapshot.scheduledDepartureMs ?? Date.now() + 6 * 60 * 60_000) + 2 * 60 * 60_000;
  }

  isTerminal(value: unknown): boolean {
    const snapshot = trainSnapshot(value);
    const finalStop = snapshot.stops.at(-1);
    return snapshot.cancelled || !!finalStop?.actualArrivalMs;
  }

  validate(definition: WatchDefinition, value: unknown): void {
    const snapshot = trainSnapshot(value);
    const supported = new Set([
      "train.platform_announced", "train.platform_confirmed", "train.platform_changed",
      "train.departed", "train.stop_arrived", "train.stop_departed", "train.delay_changed",
      "train.eta_changed", "train.cancelled", "train.arrived",
    ]);
    for (const rule of definition.rules) {
      if (!rule.event) continue;
      if (!supported.has(rule.event)) throw new Error(`Unsupported train event: ${rule.event}`);
      if (rule.event === "train.arrived" && (rule.where?.station || rule.where?.stationId)) {
        throw new Error("train.arrived refers only to the trainRef destination; use train.stop_arrived for a named station");
      }
      if (rule.event === "train.stop_arrived" || rule.event === "train.stop_departed") {
        const where = rule.where ?? {};
        const hasSelector = typeof where.station === "string" || typeof where.stationId === "string"
          || typeof where.positionRelativeToDestination === "number";
        if (!hasSelector) throw new Error(`${rule.event} requires where.station, where.stationId, or where.positionRelativeToDestination`);
        if (typeof where.station === "string" && !snapshot.stops.some((stop) => sameName(stop.name, where.station as string))) {
          throw new Error(`Station ${where.station} is not served by train ${snapshot.trainNumber}`);
        }
        if (typeof where.stationId === "string" && !snapshot.stops.some((stop) => stop.id === where.stationId)) {
          throw new Error(`Station id ${where.stationId} is not served by train ${snapshot.trainNumber}`);
        }
      }
    }
  }

  pollIntervalMs(watch: WatchRecord, now: number): number {
    const snapshot = trainSnapshot(watch.snapshot);
    const futureMilestones = snapshot.stops.flatMap((stop) => {
      if (stop.actualArrivalMs || stop.cancelled) return [];
      const value = stop.scheduledArrivalMs ?? stop.scheduledDepartureMs;
      return typeof value === "number" ? [value] : [];
    });
    if (snapshot.estimatedArrivalMs) futureMilestones.push(snapshot.estimatedArrivalMs);
    const distance = Math.min(...futureMilestones.map((value) => Math.max(0, value - now)));
    if (distance <= 10 * 60_000) return 10_000;
    if (distance <= 30 * 60_000) return 20_000;
    return 45_000;
  }

  events(previousValue: unknown, currentValue: unknown): DomainEvent[] {
    const previous = trainSnapshot(previousValue);
    const current = trainSnapshot(currentValue);
    const events: DomainEvent[] = [];
    const add = (type: string, key: string, data: Record<string, unknown>, fallbackText: string) => events.push({
      type, key, data, fallbackText, notification: TRAIN_NOTIFICATION,
      timestamp: Date.now(), previousState: previous, currentState: current,
    });

    if (!previous.platform && current.platform) {
      add("train.platform_announced", `platform-announced:${current.platform}:${current.platformStatus}`,
        platformData(current), platformFallback(current, "comunicato"));
    }
    if (!previous.actualPlatform && current.actualPlatform) {
      add("train.platform_confirmed", `platform-confirmed:${current.actualPlatform}`,
        platformData(current), `Binario ${current.actualPlatform} confermato per il treno ${current.trainNumber}.`);
    }
    if (previous.platform && current.platform && previous.platform !== current.platform) {
      add("train.platform_changed", `platform-changed:${previous.platform}:${current.platform}:${current.platformStatus}`,
        { ...platformData(current), previousPlatform: previous.platform },
        `Binario cambiato da ${previous.platform} a ${current.platform}${current.platformStatus === "confirmed" ? ", confermato" : ", non ancora confermato"}.`);
    }
    if (!previous.cancelled && current.cancelled) {
      add("train.cancelled", "cancelled", trainData(current), `Il treno ${current.trainNumber} risulta cancellato.`);
    }
    if (!previous.departed && current.departed) {
      add("train.departed", "departed", trainData(current), `Il treno ${current.trainNumber} risulta partito.`);
    }
    if (!previous.arrived && current.arrived) {
      add("train.arrived", "arrived", trainData(current), `Il treno ${current.trainNumber} risulta arrivato a ${current.to ?? "destinazione"}.`);
    }
    if (previous.delayMinutes !== current.delayMinutes) {
      add("train.delay_changed", `delay:${current.delayMinutes}`,
        { ...trainData(current), previousDelayMinutes: previous.delayMinutes, delayMinutes: current.delayMinutes },
        current.delayMinutes > 0 ? `Ritardo aggiornato a ${current.delayMinutes} minuti.` : "Il treno risulta ora in orario.");
    }
    if (previous.estimatedArrivalMs !== current.estimatedArrivalMs && current.estimatedArrivalMs) {
      add("train.eta_changed", `eta:${current.estimatedArrivalMs}`,
        { ...trainData(current), previousEstimatedArrivalMs: previous.estimatedArrivalMs },
        `Arrivo stimato aggiornato alle ${current.estimatedArrival ?? "nuovo orario"}.`);
    }

    const previousStops = new Map(previous.stops.map((stop) => [stopKey(stop), stop]));
    for (const stop of current.stops) {
      const before = previousStops.get(stopKey(stop));
      if (!before?.actualArrivalMs && stop.actualArrivalMs) {
        add("train.stop_arrived", `stop-arrived:${stopKey(stop)}:${stop.actualArrivalMs}`, {
          ...trainData(current), station: stop.name, stationId: stop.id, stationIndex: stop.index,
          positionRelativeToDestination: stop.positionRelativeToDestination,
          nextStop: current.stops[stop.index + 1]?.name,
        }, stop.positionRelativeToDestination === 0
          ? `Sei arrivato a ${stop.name}: questa è la fermata in cui devi scendere.`
          : `Il treno è arrivato a ${stop.name}${current.stops[stop.index + 1] ? `. Prossima fermata: ${current.stops[stop.index + 1].name}.` : "."}`);
      }
      if (!before?.actualDepartureMs && stop.actualDepartureMs) {
        add("train.stop_departed", `stop-departed:${stopKey(stop)}:${stop.actualDepartureMs}`, {
          ...trainData(current), station: stop.name, stationId: stop.id, stationIndex: stop.index,
          positionRelativeToDestination: stop.positionRelativeToDestination,
          nextStop: current.stops[stop.index + 1]?.name,
        }, `Il treno è partito da ${stop.name}${current.stops[stop.index + 1] ? `. Prossima fermata: ${current.stops[stop.index + 1].name}.` : "."}`);
      }
    }
    return events;
  }
}

function trainSnapshot(value: unknown): TrainSnapshot {
  if (!value || typeof value !== "object" || !Array.isArray((value as TrainSnapshot).stops)) throw new Error("Invalid train watch snapshot");
  return value as TrainSnapshot;
}
function stopKey(stop: TrainStopSnapshot): string { return stop.id ?? `${stop.index}:${stop.name}`; }
function trainData(snapshot: TrainSnapshot): Record<string, unknown> {
  return {
    trainRef: snapshot.trainRef, trainNumber: snapshot.trainNumber, category: snapshot.category,
    from: snapshot.from, to: snapshot.to, delayMinutes: snapshot.delayMinutes,
    departureDelaySeconds: snapshot.departureDelaySeconds, arrivalDelaySeconds: snapshot.arrivalDelaySeconds,
    departureDelayMinutes: snapshot.departureDelayMinutes, arrivalDelayMinutes: snapshot.arrivalDelayMinutes,
    departurePlatform: snapshot.departurePlatform, departurePlatformStatus: snapshot.departurePlatformStatus,
    arrivalPlatform: snapshot.arrivalPlatform, arrivalPlatformStatus: snapshot.arrivalPlatformStatus,
    estimatedArrival: snapshot.estimatedArrival, estimatedArrivalMs: snapshot.estimatedArrivalMs,
    scheduledArrival: snapshot.scheduledArrival, scheduledArrivalMs: snapshot.scheduledArrivalMs,
    platform: snapshot.platform, platformStatus: snapshot.platformStatus, lastUpdated: snapshot.lastUpdated,
  };
}
function platformData(snapshot: TrainSnapshot): Record<string, unknown> {
  return { ...trainData(snapshot), scheduledPlatform: snapshot.scheduledPlatform, actualPlatform: snapshot.actualPlatform };
}
function platformFallback(snapshot: TrainSnapshot, verb: string): string {
  return `Binario di partenza ${snapshot.platform} ${verb} a ${snapshot.from ?? "origine"} per il treno ${snapshot.trainNumber}${snapshot.platformStatus === "confirmed" ? ", confermato" : ", non ancora confermato"}.`;
}
function sameName(left: string, right: string): boolean {
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, " ").trim().toLowerCase();
  return normalize(left) === normalize(right);
}
