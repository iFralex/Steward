import assert from "node:assert/strict";
import { test } from "node:test";
import { watchEventPrompt } from "../src/core/watch-notification-service.ts";

test("watch event prompt delegates wording to the LLM without delegating actions", () => {
  const prompt = watchEventPrompt(
    "Avvisami quando devo prepararmi a scendere",
    { id: "before", event: "train.stop_arrived", where: { positionRelativeToDestination: -1 } },
    { type: "train.stop_arrived", data: { station: "Sesto San Giovanni" } },
  );
  assert.match(prompt, /Avvisami quando devo prepararmi a scendere/);
  assert.match(prompt, /positionRelativeToDestination/);
  assert.match(prompt, /non chiamare tool di scrittura/);
  assert.match(prompt, /confermato, soltanto programmato e non comunicato/);
});
