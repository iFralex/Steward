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
