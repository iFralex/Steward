import assert from "node:assert/strict";
import { test } from "node:test";
import { watchAgentPrompt, watchTitle } from "../src/core/watch-notification-service.ts";

test("generic watch prompt resumes the chat with read-only tools and contains no train policy", () => {
  const prompt = watchAgentPrompt({
    id: "e", watchId: "w", chatId: "c", attempts: 0, resourceRef: "sensor-1", authorizedTools: [],
    instruction: "Notify me when the value changes",
    rule: { id: "changed", event: "sensor.changed" },
    event: { type: "sensor.changed", key: "42", timestamp: 1, data: { value: 42 }, currentState: {}, fallbackText: "42" },
  }, "en");
  assert.match(prompt, /Notify me when the value changes/);
  assert.match(prompt, /Continue the original conversation/);
  assert.match(prompt, /read-only tools/);
  assert.match(prompt, /Do not perform actions or call the user/);
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
  const prompt = watchAgentPrompt({
    id: "e", watchId: "w", chatId: "c", attempts: 0, resourceRef: "train", authorizedTools: [],
    instruction: "Avvisami quando devo prepararmi a scendere",
    rule: { id: "before", event: "train.stop_arrived", where: { positionRelativeToDestination: -1 } },
    event: { ...event, key: "stop", timestamp: 1, currentState: {}, fallbackText: "Fermata" },
  }, "it");
  assert.match(prompt, /Avvisami quando devo prepararmi a scendere/);
  assert.match(prompt, /positionRelativeToDestination/);
  assert.match(prompt, /Indicazioni del dominio: Distingui i binari confermati/);
  assert.match(prompt, /stessa chat/);
  assert.equal(watchTitle(event, "it"), "Aggiornamento treno");
});

test("agent watch prompt resumes the chat and authorizes a conversational call", () => {
  const prompt = watchAgentPrompt({
    id: "event-1", watchId: "watch-1", chatId: "chat-1", attempts: 0,
    instruction: "Chiamami alla fermata precedente",
    resourceRef: "vt1_train",
    authorizedTools: ["mcp__voice__call_start"],
    rule: { id: "before", event: "train.stop_arrived", where: { positionRelativeToDestination: -1 }, once: true },
    event: {
      type: "train.stop_arrived", key: "station:1", timestamp: 1,
      data: { station: "Modena", positionRelativeToDestination: -1 },
      currentState: {}, fallbackText: "Il treno è arrivato a Modena.",
    },
  }, "it");
  assert.match(prompt, /Continua la conversazione originale/);
  assert.match(prompt, /train_status/);
  assert.match(prompt, /chiama ora l.utente/i);
  assert.match(prompt, /vt1_train/);
});
