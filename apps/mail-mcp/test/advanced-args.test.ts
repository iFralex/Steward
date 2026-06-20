import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { usesAdvancedFilters } from "../src/advanced-args.ts";

describe("usesAdvancedFilters", () => {
  it("returns false for empty args", () => {
    assert.equal(usesAdvancedFilters({}), false);
  });

  it("returns false for legacy-only args (query, subject)", () => {
    assert.equal(usesAdvancedFilters({ query: "x", subject: "y" }), false);
  });

  it("returns true when toName is set", () => {
    assert.equal(usesAdvancedFilters({ toName: "ristian" }), true);
  });

  it("returns true when answeredOnly is true", () => {
    assert.equal(usesAdvancedFilters({ answeredOnly: true }), true);
  });

  it("returns false when answeredOnly is false", () => {
    assert.equal(usesAdvancedFilters({ answeredOnly: false }), false);
  });

  it("returns false when cc is empty string", () => {
    assert.equal(usesAdvancedFilters({ cc: "" }), false);
  });
});
