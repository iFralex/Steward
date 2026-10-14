import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildMcpBridge } from "@steward/mcp-bridge";

const echo = fileURLToPath(new URL("./fixtures/echo-mcp-server.mts", import.meta.url));

test("bridges MCP tools with mcp__<server>__<tool> names and routes calls", async () => {
  const bridge = await buildMcpBridge({ echo: { command: process.execPath, args: ["--import", "tsx", echo] } });
  try {
    const names = bridge.tools.map((t) => t.name);
    assert.ok(names.includes("mcp__echo__echo"), `got ${names.join(",")}`);
    const tool = bridge.tools.find((t) => t.name === "mcp__echo__echo")!;
    const res: any = await tool.execute("call-1", { msg: "hi" }, undefined, undefined, {} as any);
    assert.match(res.content[0].text, /hi/);
    const direct: any = await bridge.callTool("mcp__echo__echo", { msg: "direct" });
    assert.match(direct[0].text, /direct/);
    assert.match((await bridge.prepareSearch!("echo")).skipped!, /does not support/);
  } finally {
    await bridge.close();
  }
});

test('ready connectors serve calls before a slow peer publishes its tools', async()=>{
  const {startMcpBridge}=await import('@steward/mcp-bridge');
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'mcp-preparation-')),gate=join(dir,'ready');
  const fixture=fileURLToPath(new URL('./fixtures/preparing-mcp-server.mts',import.meta.url));
  const bridge=startMcpBridge({slow:{command:process.execPath,args:['--import','tsx',fixture,gate]},fast:{command:process.execPath,args:['--import','tsx',fixture]}});
  try {
    await bridge.firstReady;
    assert.equal(bridge.connectorStates!().slow.state,'connecting');
    const result:any=await bridge.callTool('mcp__fast__echo',{});
    assert.equal(result[0].text,'fixture response');
    assert.ok(!bridge.tools.some(tool=>tool.name==='mcp__slow__echo'));
    writeFileSync(gate,'ready');await bridge.settled;
    assert.ok(bridge.tools.some(tool=>tool.name==='mcp__slow__echo'));
    assert.deepEqual(await bridge.prepareSearch!('slow'),{});
  } finally {await bridge.close();rmSync(dir,{recursive:true,force:true});}
});

test('a failed connector does not prevent a healthy peer from becoming ready',async()=>{
  const {startMcpBridge}=await import('@steward/mcp-bridge');
  const bridge=startMcpBridge({failed:{command:process.execPath,args:['-e','process.exit(1)']},echo:{command:process.execPath,args:['--import','tsx',echo]}});
  try {await bridge.firstReady;await bridge.settled;assert.equal(bridge.connectorStates!().failed.state,'error');assert.equal(bridge.connectorStates!().echo.state,'ready');}
  finally {await bridge.close();}
});

test('closing a still-starting bridge cancels its pending connectors',async()=>{
  const {startMcpBridge}=await import('@steward/mcp-bridge');
  const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'mcp-cancel-'));
  const fixture=fileURLToPath(new URL('./fixtures/preparing-mcp-server.mts',import.meta.url));
  const bridge=startMcpBridge({slow:{command:process.execPath,args:['--import','tsx',fixture,join(dir,'never-ready')]}});
  try {await bridge.close();await bridge.firstReady;assert.equal(bridge.connectorStates!().slow.state,'closed');}
  finally{rmSync(dir,{recursive:true,force:true});}
});
