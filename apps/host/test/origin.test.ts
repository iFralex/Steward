import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin } from "../src/server.ts";

test("no Origin header (curl, native apps) is allowed", () => {
  assert.equal(isAllowedOrigin(undefined, 4317), true);
});

test("own origins are allowed", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:4317", 4317), true);
  assert.equal(isAllowedOrigin("http://localhost:4317", 4317), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:5173", 4317), true); // vite dev
  assert.equal(isAllowedOrigin("http://localhost:5173", 4317), true);
});

test("foreign web origins are rejected", () => {
  assert.equal(isAllowedOrigin("https://evil.example", 4317), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1.evil.example:4317", 4317), false);
  assert.equal(isAllowedOrigin("null", 4317), false);
});
