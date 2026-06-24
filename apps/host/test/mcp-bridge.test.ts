import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildMcpBridge } from "../src/core/mcp-bridge.ts";

const echo = fileURLToPath(new URL("./fixtures/echo-mcp-server.mts", import.meta.url));

test("bridges MCP tools with mcp__<server>__<tool> names and routes calls", async () => {
  const bridge = await buildMcpBridge({ echo: { command: process.execPath, args: ["--import", "tsx", echo] } });
  try {
    const names = bridge.tools.map((t) => t.name);
    assert.ok(names.includes("mcp__echo__echo"), `got ${names.join(",")}`);
    const tool = bridge.tools.find((t) => t.name === "mcp__echo__echo")!;
    const res: any = await tool.execute("call-1", { msg: "hi" });
    assert.match(res.content[0].text, /hi/);
  } finally {
    await bridge.close();
  }
});
