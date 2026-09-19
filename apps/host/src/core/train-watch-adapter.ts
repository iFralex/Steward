import type { DomainEvent, WatchAdapter } from "@steward/watch-engine";
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
    return snapshot.arrived || snapshot.cancelled;
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
    platform: snapshot.platform, platformStatus: snapshot.platformStatus, lastUpdated: snapshot.lastUpdated,
  };
}
function platformData(snapshot: TrainSnapshot): Record<string, unknown> {
  return { ...trainData(snapshot), scheduledPlatform: snapshot.scheduledPlatform, actualPlatform: snapshot.actualPlatform };
}
function platformFallback(snapshot: TrainSnapshot, verb: string): string {
  return `Binario ${snapshot.platform} ${verb} per il treno ${snapshot.trainNumber}${snapshot.platformStatus === "confirmed" ? ", confermato" : ", non ancora confermato"}.`;
}
