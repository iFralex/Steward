export interface Station {
  id: string;
  name: string;
  shortName?: string;
  label?: string;
}

export interface TrainRefData {
  version: 1;
  trainNumber: string;
  originId: string;
  serviceDay?: number;
  fromId?: string;
  toId?: string;
  fromName?: string;
  toName?: string;
}

export type PlatformStatus = "confirmed" | "scheduled" | "unknown";

export interface TrainSnapshot {
  trainRef: string;
  trainNumber: string;
  category?: string;
  origin?: string;
  destination?: string;
  from?: string;
  to?: string;
  scheduledDeparture?: string;
  estimatedDeparture?: string;
  scheduledArrival?: string;
  estimatedArrival?: string;
  estimatedArrivalMs?: number;
  scheduledDepartureMs?: number;
  scheduledArrivalMs?: number;
  delayMinutes: number;
  /** Exact schedule variance when live timestamps are available. */
  departureDelaySeconds?: number;
  arrivalDelaySeconds?: number;
  departureDelayMinutes?: number;
  arrivalDelayMinutes?: number;
  /** Legacy platform fields refer to the departure station. */
  platform?: string;
  scheduledPlatform?: string;
  actualPlatform?: string;
  platformStatus: PlatformStatus;
  departurePlatform?: string;
  scheduledDeparturePlatform?: string;
  actualDeparturePlatform?: string;
  departurePlatformStatus?: PlatformStatus;
  arrivalPlatform?: string;
  scheduledArrivalPlatform?: string;
  actualArrivalPlatform?: string;
  arrivalPlatformStatus?: PlatformStatus;
  cancelled: boolean;
  departed: boolean;
  arrived: boolean;
  lastDetectedStation?: string;
  stops: TrainStopSnapshot[];
  lastUpdated: string;
  source: "ViaggiaTreno";
}

export interface TrainStopSnapshot {
  id?: string;
  name: string;
  index: number;
  scheduledArrival?: string;
  actualArrival?: string;
  scheduledDeparture?: string;
  actualDeparture?: string;
  scheduledArrivalMs?: number;
  actualArrivalMs?: number;
  scheduledDepartureMs?: number;
  actualDepartureMs?: number;
  cancelled: boolean;
  positionRelativeToDestination?: number;
  scheduledArrivalPlatform?: string;
  actualArrivalPlatform?: string;
  arrivalPlatformStatus?: PlatformStatus;
  scheduledDeparturePlatform?: string;
  actualDeparturePlatform?: string;
  departurePlatformStatus?: PlatformStatus;
}

export interface TrainDataSource {
  searchStations(query: string): Promise<Station[]>;
  departures(stationId: string, at: Date): Promise<Record<string, unknown>[]>;
  trainStatus(originId: string, trainNumber: string, serviceDay?: number): Promise<Record<string, unknown>>;
}
