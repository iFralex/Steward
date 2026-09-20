import assert from "node:assert/strict";
import test from "node:test";
import { parseRingbackFailure } from "../src/core/voice-diagnostics.ts";

test("parses Ringback structured SIP diagnostics", () => {
  assert.deepEqual(parseRingbackFailure(
    '[CALL FAILED] {"code":"rejected","message":"Call declined","retryable":false,"sipStatus":603,"sipReason":"Decline","dialDurationMs":1234}',
  ), {
    code: "rejected", message: "Call declined", retryable: false,
    sipStatus: 603, sipReason: "Decline", dialDurationMs: 1234,
  });
});

test("keeps compatibility with the old no-answer marker", () => {
  assert.deepEqual(parseRingbackFailure("[NO ANSWER] — old Ringback"), {
    code: "no_answer", message: "The phone did not answer.", retryable: true,
  });
});

test("classifies a SIP 503 connection reset as a network error", () => {
  const failure = parseRingbackFailure(
    '[CALL FAILED] {"code":"server_error","message":"Provider error","retryable":true,"sipStatus":503,"sipReason":"Connection reset by peer"}',
  );
  assert.equal(failure?.code, "network_error");
  assert.equal(failure?.sipStatus, 503);
  assert.equal(failure?.message, "The network prevented the SIP call from completing.");
});
