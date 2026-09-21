import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(new URL("../../../tools/run-ringback-managed.sh", import.meta.url));
const hangupPatchPath = fileURLToPath(new URL("../../../tools/ringback-steward-hangup.patch", import.meta.url));

test("managed Ringback preserves stdin for its asynchronous MCP child", () => {
  const launcher = readFileSync(launcherPath, "utf8");
  assert.match(
    launcher,
    /"\$PYTHON_BIN" "\$APP\/voice_mcp\.py" <&0 &/,
    "an async Bash child otherwise receives /dev/null and the stdio MCP server exits at startup",
  );
});

test("Ringback confirms SIP teardown instead of reporting a local-only hangup", () => {
  const patch = readFileSync(hangupPatchPath, "utf8");
  assert.match(patch, /while requested and not self\.disconnected/);
  assert.match(patch, /hangupAllCalls/);
  assert.match(patch, /SIP hangup was not confirmed/);
});

test("managed Ringback bounds the detailed SIP diagnostic log", () => {
  const launcher = readFileSync(launcherPath, "utf8");
  assert.match(launcher, /5242880/);
  assert.match(launcher, /VOICE_LOG_FILE\.previous/);
});
