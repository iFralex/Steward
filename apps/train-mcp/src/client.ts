import type { Station, TrainDataSource } from "./types.ts";

type FetchLike = typeof fetch;

const DEFAULT_BASE = "http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno";

export class ViaggiaTrenoClient implements TrainDataSource {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = process.env.VIAGGIATRENO_BASE_URL ?? DEFAULT_BASE,
  ) {}

  async searchStations(query: string): Promise<Station[]> {
    const text = query.trim();
    if (!text) return [];
    const response = await this.request(`/cercaStazione/${encodeURIComponent(text)}`);
    const raw = await response.text();
    try {
      const data = JSON.parse(raw) as unknown;
      if (Array.isArray(data)) {
        return data.flatMap((item) => {
          const row = record(item);
          const id = string(row.id);
          const name = string(row.nomeLungo) || string(row.nomeBreve) || string(row.label);
          return id && name ? [{ id, name, shortName: string(row.nomeBreve), label: string(row.label) }] : [];
        });
      }
    } catch {
      // Some deployments return the same pipe-separated format as autocomplete.
    }
    return raw.split(/\r?\n/).flatMap((line) => {
      const [name, id] = line.split("|", 2).map((part) => part?.trim());
      return name && id ? [{ id, name }] : [];
    });
  }

  async departures(stationId: string, at: Date): Promise<Record<string, unknown>[]> {
    const response = await this.request(`/partenze/${encodeURIComponent(stationId)}/${encodeURIComponent(romeDateString(at))}`);
    if (response.status === 204) return [];
    const data = await response.json() as unknown;
    return Array.isArray(data) ? data.map(record) : [];
  }

  async trainStatus(originId: string, trainNumber: string, serviceDay?: number): Promise<Record<string, unknown>> {
    const suffix = serviceDay ? `/${Math.trunc(serviceDay)}` : "";
    let response = await this.request(`/andamentoTreno/${encodeURIComponent(originId)}/${encodeURIComponent(trainNumber)}${suffix}`, true);
    // The live service currently accepts both the documented three-component
    // key and a two-component current-day form. Fall back only on 404/204.
    if ((response.status === 404 || response.status === 204) && serviceDay) {
      response = await this.request(`/andamentoTreno/${encodeURIComponent(originId)}/${encodeURIComponent(trainNumber)}`, true);
    }
    if (response.status === 204) return {};
    if (!response.ok) throw new Error(`ViaggiaTreno status request failed (${response.status})`);
    return record(await response.json());
  }

  private async request(path: string, acceptMissing = false): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          headers: { "Accept": "application/json", "User-Agent": "Steward/1.0 train-assistant" },
          signal: controller.signal,
        });
        if (response.ok || (acceptMissing && (response.status === 404 || response.status === 204))) return response;
        if (response.status < 500 || attempt === 1) throw new Error(`ViaggiaTreno request failed (${response.status})`);
      } catch (error) {
        lastError = error;
        if (attempt === 1) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`ViaggiaTreno is not reachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

function romeDateString(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome", weekday: "short", month: "short", day: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  const offset = (parts.timeZoneName ?? "GMT+00:00").replace(":", "");
  return `${parts.weekday} ${parts.month} ${parts.day} ${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
