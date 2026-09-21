import test from "node:test";
import assert from "node:assert/strict";
import { stationSimilarity, TrainService } from "../src/service.ts";
import type { Station, TrainDataSource } from "../src/types.ts";

const now = Date.parse("2026-09-18T16:00:00+02:00");

class FakeSource implements TrainDataSource {
  searches: string[] = [];
  serviceDays: Array<number | undefined> = [];
  async searchStations(query: string): Promise<Station[]> {
    this.searches.push(query);
    if (query.toLowerCase().includes("milano")) return [
      { id: "S01820", name: "MILANO ROGOREDO", label: "Milano Rogoredo" },
      { id: "S01700", name: "MILANO CENTRALE", label: "Milano Centrale" },
    ];
    if (query.toLowerCase().includes("napoli")) return [{ id: "S09218", name: "NAPOLI CENTRALE", label: "Napoli Centrale" }];
    return [{ id: "S06421", name: "FIRENZE SANTA MARIA NOVELLA", label: "Firenze Santa Maria Novella" }];
  }
  async departures(): Promise<Record<string, unknown>[]> {
    return [{ numeroTreno: 9515, codOrigine: "S01700", dataPartenzaTreno: now - 16 * 60 * 60_000,
      orarioPartenza: now + 10 * 60_000, ritardo: 5,
      categoriaDescrizione: "FR", binarioProgrammatoPartenzaDescrizione: "4", binarioEffettivoPartenzaDescrizione: "7" }];
  }
  async trainStatus(_origin: string, _number: string, serviceDay?: number): Promise<Record<string, unknown>> {
    this.serviceDays.push(serviceDay);
    return {
      numeroTreno: 9515, categoria: "FR", origine: "MILANO CENTRALE", destinazione: "NAPOLI CENTRALE", ritardo: 5,
      fermate: [
        { id: "S01700", stazione: "MILANO CENTRALE", partenza_teorica: now - 10 * 60_000, partenzaReale: now - 5 * 60_000 },
        { id: "S01820", stazione: "MILANO ROGOREDO", partenza_teorica: now + 10 * 60_000,
          binarioProgrammatoPartenza: "4", binarioEffettivoPartenza: "7", ritardo: 5 },
        { id: "S06421", stazione: "FIRENZE SANTA MARIA NOVELLA", arrivo_teorico: now + 110 * 60_000 },
        { id: "S09218", stazione: "NAPOLI CENTRALE", arrivo_teorico: now + 250 * 60_000 },
      ],
    };
  }
}

test("stationSimilarity tolerates spacing and dictation errors", () => {
  assert.equal(stationSimilarity("Milano rogo redo", "Milano Rogoredo"), 1);
  assert.ok(stationSimilarity("Firenze santa maria novella", "FIRENZE SANTA MARIA NOVELLA") > 0.99);
  assert.ok(stationSimilarity("Milano rogo redo", "Milano Rogoredo") > stationSimilarity("Milano rogo redo", "Milano Centrale"));
});

test("findNextTrain resolves fuzzy station names and distinguishes confirmed platform", async () => {
  const source = new FakeSource();
  const service = new TrainService(source);
  const train = await service.findNextTrain("Milano rogo redo", "Firenze santa maria novella", new Date(now).toISOString());
  assert.equal(train.trainNumber, "9515");
  assert.equal(train.from, "Milano Rogoredo");
  assert.equal(train.to, "Firenze Santa Maria Novella");
  assert.equal(train.platform, "7");
  assert.equal(train.platformStatus, "confirmed");
  assert.equal(train.delayMinutes, 5);
  assert.equal(train.stops.at(-2)?.positionRelativeToDestination, 0);
  assert.match(train.trainRef, /^vt1_/);
  assert.equal(source.serviceDays[0], now - 16 * 60 * 60_000);
});

test("station resolution broadens a failed autocomplete query without personal history", async () => {
  const source = new FakeSource();
  const original = source.searchStations.bind(source);
  source.searchStations = async (query) => query === "Milano rogo redo" ? [] : original(query);
  const train = await new TrainService(source).findNextTrain("Milano rogo redo", "Firenze santa maria novella", new Date(now).toISOString());
  assert.equal(train.from, "Milano Rogoredo");
  assert.ok(source.searches.includes("milano"));
});

test("trainStatus keeps scheduled platform explicitly unconfirmed", async () => {
  const source = new FakeSource();
  source.departures = async () => [{ numeroTreno: 9515, codOrigine: "S01700", orarioPartenza: now + 10 * 60_000,
    categoriaDescrizione: "FR", binarioProgrammatoPartenzaDescrizione: "4" }];
  source.trainStatus = async () => ({
    categoria: "FR", fermate: [
      { id: "S01820", stazione: "MILANO ROGOREDO", partenza_teorica: now + 10 * 60_000, binarioProgrammatoPartenza: "4" },
      { id: "S06421", stazione: "FIRENZE SANTA MARIA NOVELLA", arrivo_teorico: now + 110 * 60_000 },
    ],
  });
  const train = await new TrainService(source).findNextTrain("Milano Rogoredo", "Firenze Santa Maria Novella", new Date(now).toISOString());
  assert.equal(train.platform, "4");
  assert.equal(train.platformStatus, "scheduled");
  assert.equal(train.actualPlatform, undefined);
  assert.equal((await new TrainService(source).status(train.trainRef)).departed, false);
});

test("retarget follows the same departed run to a later station", async () => {
  const source = new FakeSource();
  const service = new TrainService(source);
  const first = await service.findNextTrain("Milano Rogoredo", "Firenze Santa Maria Novella", new Date(now).toISOString());
  const retargeted = await service.retarget(first.trainRef, "Napoli Centrale");
  assert.equal(retargeted.trainNumber, first.trainNumber);
  assert.equal(retargeted.to, "Napoli Centrale");
  assert.equal(retargeted.stops.at(-1)?.positionRelativeToDestination, 0);
});

test("arrival variance and platform are separate from departure data", async () => {
  const source = new FakeSource();
  source.trainStatus = async () => ({
    categoria: "FR", fermate: [
      { id: "S01820", stazione: "MILANO ROGOREDO", partenza_teorica: now, partenzaReale: now + 60_000,
        binarioProgrammatoPartenza: "4", binarioEffettivoPartenza: "7" },
      { id: "S06421", stazione: "FIRENZE SANTA MARIA NOVELLA", arrivo_teorico: now + 60 * 60_000,
        arrivoReale: now + 62 * 60_000 + 30_000, binarioProgrammatoArrivo: "8", binarioEffettivoArrivo: "9" },
    ],
  });
  const train = await new TrainService(source).findNextTrain("Milano Rogoredo", "Firenze Santa Maria Novella", new Date(now - 60_000).toISOString());
  assert.equal(train.departureDelaySeconds, 60);
  assert.equal(train.arrivalDelaySeconds, 150);
  assert.equal(train.departurePlatform, "7");
  assert.equal(train.arrivalPlatform, "9");
  assert.equal(train.arrivalPlatformStatus, "confirmed");
});
