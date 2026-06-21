import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearchArgs, parseResolveArgs, parseCreateArgs } from "../src/args.ts";

test("parseSearchArgs requires query, clamps limit", () => {
  assert.throws(() => parseSearchArgs({}), /query/);
  const a = parseSearchArgs({ query: "anna", limit: 999 });
  assert.equal(a.query, "anna");
  assert.equal(a.limit, 50);
});

test("parseResolveArgs requires description, default limit 5", () => {
  assert.equal(parseResolveArgs({ description: "the accountant" }).limit, 5);
});

test("parseCreateArgs requires a name or organization", () => {
  assert.throws(() => parseCreateArgs({ note: "x" }), /name or organization/);
  const a = parseCreateArgs({ organization: "ACME", emails: [{ address: "x@y.com" }] });
  assert.equal(a.organization, "ACME");
  assert.equal(a.emails?.[0].address, "x@y.com");
});

test("parseCreateArgs rejects malformed emails", () => {
  assert.throws(() => parseCreateArgs({ firstName: "A", emails: [{ label: "Home" }] }), /emails/);
});
