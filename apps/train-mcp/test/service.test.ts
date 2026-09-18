import test from "node:test";
import assert from "node:assert/strict";
import { stationSimilarity, TrainService } from "../src/service.ts";
import type { Station, TrainDataSource } from "../src/types.ts";

const now = Date.parse("2026-09-18T16:00:00+02:00");

class FakeSource implements TrainDataSource {
  searches: string[] = [];
  async searchStations(query: string): Promise<Station[]> {
    this.searches.push(query);
    if (query.toLowerCase().includes("milano")) return [
      { id: "S01820", name: "MILANO ROGOREDO", label: "Milano Rogoredo" },
      { id: "S01700", name: "MILANO CENTRALE", label: "Milano Centrale" },
    ];
    return [{ id: "S06421", name: "FIRENZE SANTA MARIA NOVELLA", label: "Firenze Santa Maria Novella" }];
  }
  async departures(): Promise<Record<string, unknown>[]> {
    return [{ numeroTreno: 9515, codOrigine: "S01700", orarioPartenza: now + 10 * 60_000, ritardo: 5,
      categoriaDescrizione: "FR", binarioProgrammatoPartenzaDescrizione: "4", binarioEffettivoPartenzaDescrizione: "7" }];
  }
  async trainStatus(): Promise<Record<string, unknown>> {
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
  const service = new TrainService(new FakeSource());
  const train = await service.findNextTrain("Milano rogo redo", "Firenze santa maria novella", new Date(now).toISOString());
  assert.equal(train.trainNumber, "9515");
  assert.equal(train.from, "Milano Rogoredo");
  assert.equal(train.to, "Firenze Santa Maria Novella");
  assert.equal(train.platform, "7");
  assert.equal(train.platformStatus, "confirmed");
  assert.equal(train.delayMinutes, 5);
  assert.equal(train.stops.at(-2)?.positionRelativeToDestination, 0);
  assert.match(train.trainRef, /^vt1_/);
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
});
