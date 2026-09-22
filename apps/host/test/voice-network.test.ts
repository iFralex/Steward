import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceNetworkFallback } from "../src/core/voice-network.ts";

function fixture(probe: () => Promise<boolean>) {
  const journalFile = join(mkdtempSync(join(tmpdir(), "voice-network-")), "route.json");
  let selected = "";
  const changes: string[] = [];
  const peers = {
    phone: { ID: "phone", HostName: "iPhone", Online: true, ExitNodeOption: true, TailscaleIPs: ["100.100.100.10"] },
    prior: { ID: "prior", HostName: "Home", Online: true, ExitNodeOption: true, TailscaleIPs: ["100.100.100.20"] },
  };
  const deps = {
    journalFile, probe,
    settings: () => ({ enabled: true, exitNodeId: "phone" }),
    status: async () => ({ Peer: peers, ExitNodeStatus: selected ? { ID: selected } : undefined }),
    select: async (ip: string) => {
      changes.push(ip);
      selected = ip === "100.100.100.10" ? "phone" : ip === "100.100.100.20" ? "prior" : "";
    },
  };
  return { deps, changes, journalFile, selected: () => selected, setSelected: (id: string) => { selected = id; } };
}

test("direct SIP leaves the route untouched", async () => {
  const f = fixture(async () => true);
  const network = new VoiceNetworkFallback(f.deps);
  const lease = await network.acquire();
  await lease.release();
  assert.deepEqual(f.changes, []);
  assert.equal(existsSync(f.journalFile), false);
});

test("blocked SIP uses selected exit node for the call and restores prior route", async () => {
  let probes = 0;
  const f = fixture(async () => ++probes > 1);
  f.setSelected("prior");
  const network = new VoiceNetworkFallback(f.deps);
  const lease = await network.acquire();
  assert.equal(f.selected(), "phone");
  assert.deepEqual(JSON.parse(readFileSync(f.journalFile, "utf8")), { selectedId: "phone", previousId: "prior" });
  await lease.release();
  assert.equal(f.selected(), "prior");
  assert.deepEqual(f.changes, ["100.100.100.10", "100.100.100.20"]);
  assert.equal(existsSync(f.journalFile), false);
});

test("startup restores a crashed call, but never overrides a manual route change", async () => {
  const f = fixture(async () => true);
  f.setSelected("phone");
  writeFileSync(f.journalFile, JSON.stringify({ selectedId: "phone", previousId: "prior" }));
  const restored = new VoiceNetworkFallback(f.deps);
  await (await restored.acquire()).release();
  assert.equal(f.selected(), "prior");
  assert.equal(existsSync(f.journalFile), false);

  f.setSelected("prior");
  writeFileSync(f.journalFile, JSON.stringify({ selectedId: "phone", previousId: "" }));
  const changed = new VoiceNetworkFallback(f.deps);
  await (await changed.acquire()).release();
  assert.equal(f.selected(), "prior");
  assert.equal(existsSync(f.journalFile), false);
});

test("a failed route change leaves no new call lease or stale journal", async () => {
  const f = fixture(async () => false);
  const network = new VoiceNetworkFallback({ ...f.deps, select: async () => { throw new Error("set failed"); } });
  await assert.rejects(network.acquire(), /set failed/);
  assert.equal(existsSync(f.journalFile), false);
});
