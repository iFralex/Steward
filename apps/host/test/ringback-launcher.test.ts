import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(new URL("../../../tools/run-ringback-managed.sh", import.meta.url));

test("managed Ringback preserves stdin for its asynchronous MCP child", () => {
  const launcher = readFileSync(launcherPath, "utf8");
  assert.match(
    launcher,
    /"\$PYTHON_BIN" "\$APP\/voice_mcp\.py" <&0 &/,
    "an async Bash child otherwise receives /dev/null and the stdio MCP server exits at startup",
  );
});
