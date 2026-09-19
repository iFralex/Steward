import assert from "node:assert/strict";
import { test } from "node:test";
import { watchEventPrompt, watchTitle } from "../src/core/watch-notification-service.ts";

test("generic watch prompt follows the selected language and contains no train policy", () => {
  const prompt = watchEventPrompt(
    "Notify me when the value changes",
    { id: "changed", event: "sensor.changed" },
    { type: "sensor.changed", data: { value: 42 } },
    "en",
  );
  assert.match(prompt, /Notify me when the value changes/);
  assert.match(prompt, /Do not perform actions, call tools/);
  assert.match(prompt, /at most 180 characters/);
  assert.doesNotMatch(prompt, /platform|binari|railway/i);
  assert.equal(watchTitle({ type: "sensor.changed" }, "en"), "Steward update");
});

test("an adapter can add domain guidance and localized titles", () => {
  const event = {
    type: "train.stop_arrived",
    data: { station: "Sesto San Giovanni" },
    notification: {
      title: { en: "Train update", it: "Aggiornamento treno" },
      guidance: {
        en: "Distinguish confirmed and scheduled-only platforms.",
        it: "Distingui i binari confermati da quelli soltanto programmati.",
      },
    },
  };
  const prompt = watchEventPrompt(
    "Avvisami quando devo prepararmi a scendere",
    { id: "before", event: "train.stop_arrived", where: { positionRelativeToDestination: -1 } },
    event,
    "it",
  );
  assert.match(prompt, /Avvisami quando devo prepararmi a scendere/);
  assert.match(prompt, /positionRelativeToDestination/);
  assert.match(prompt, /Indicazioni del dominio: Distingui i binari confermati/);
  assert.match(prompt, /massimo 180 caratteri/);
  assert.equal(watchTitle(event, "it"), "Aggiornamento treno");
});
