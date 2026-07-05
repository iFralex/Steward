import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin, originMatchesHost } from "../src/server.ts";

test("originMatchesHost accepts same-origin (page calling back to its own host, e.g. Tailscale)", () => {
  assert.equal(originMatchesHost("http://mac.tailnet.ts.net:4317", "mac.tailnet.ts.net:4317"), true);
  assert.equal(originMatchesHost("http://100.101.102.103:4317", "100.101.102.103:4317"), true);
  assert.equal(originMatchesHost("http://localhost:4317", "localhost:4317"), true);
});

test("originMatchesHost rejects a cross-site origin (Origin != Host) and bad input", () => {
  assert.equal(originMatchesHost("https://evil.example", "mac.tailnet.ts.net:4317"), false);
  assert.equal(originMatchesHost("http://mac.tailnet.ts.net:9999", "mac.tailnet.ts.net:4317"), false); // wrong port
  assert.equal(originMatchesHost(undefined, "mac.tailnet.ts.net:4317"), false);
  assert.equal(originMatchesHost("http://x", undefined), false);
  assert.equal(originMatchesHost("not-a-url", "not-a-url"), false);
});

test("no Origin header (curl, native apps) is allowed", () => {
  assert.equal(isAllowedOrigin(undefined, 4317), true);
});

test("own origins are allowed", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:4317", 4317), true);
  assert.equal(isAllowedOrigin("http://localhost:4317", 4317), true);
});

test("vite dev origins are allowed outside production but rejected in production", () => {
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    assert.equal(isAllowedOrigin("http://127.0.0.1:5173", 4317), true);
    assert.equal(isAllowedOrigin("http://localhost:5173", 4317), true);
    process.env.NODE_ENV = "production";
    assert.equal(isAllowedOrigin("http://127.0.0.1:5173", 4317), false);
    assert.equal(isAllowedOrigin("http://localhost:5173", 4317), false);
    // the shipped UI's own origin still works in production
    assert.equal(isAllowedOrigin("http://127.0.0.1:4317", 4317), true);
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});

test("foreign web origins are rejected", () => {
  assert.equal(isAllowedOrigin("https://evil.example", 4317), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1.evil.example:4317", 4317), false);
  assert.equal(isAllowedOrigin("null", 4317), false);
});

test("HOST_ALLOWED_ORIGINS extra entries work even in production", () => {
  const prevEnv = process.env.NODE_ENV;
  const prevExtra = process.env.HOST_ALLOWED_ORIGINS;
  try {
    process.env.NODE_ENV = "production";
    process.env.HOST_ALLOWED_ORIGINS = "https://my.app";
    assert.equal(isAllowedOrigin("https://my.app", 4317), true);
    assert.equal(isAllowedOrigin("http://localhost:5173", 4317), false);
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    if (prevExtra === undefined) delete process.env.HOST_ALLOWED_ORIGINS; else process.env.HOST_ALLOWED_ORIGINS = prevExtra;
  }
});
