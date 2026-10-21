import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type MessageRow } from "../../mail-mirror/src/store.ts";
import { readDb } from "../src/db-read.ts";
import { parseEmlx } from "../../mail-mirror/src/emlx.ts";

const US = "\x1f";
function row(id: string, state: "full" | "none"): MessageRow {
  return {
    messageId: id, account: "Polimi", mailbox: "Posta in arrivo", fromName: "A", fromAddr: "a@x",
    to: ["me@x"], cc: [], subject: "Subj", date: 1750000000, bodyText: state === "full" ? "FULL BODY" : "",
    bodyState: state, source: "emlx", emlxPath: "/p/" + id, inReplyTo: null, references: [], gmThrid: null, size: 1,
    toNames: [], ccNames: [], unread: false, flagged: false, answered: false, junk: false, flagColor: null, appleThrid: null,
  };
}
// A live-read result: subject US sender US date US body (what parse.ts expects).
const liveOut = (body: string) => ["Subj", "A <a@x>", "2026", body].join(US);

test("readDb returns the DB body when full (no live read)", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("a@x", "full"));
  let ran = false;
  const d = await readDb(s, { messageId: "a@x" }, async () => { ran = true; return ""; });
  assert.equal(d.body, "FULL BODY");
  assert.equal(d.bodyState, "full");
  assert.equal(ran, false);
  assert.equal(d.mailUrl, "message://%3Ca@x%3E", "exposes a clickable Apple Mail link");
  s.close();
});

test("readDb repairs a full legacy body locally, persists provenance and avoids repeating extraction", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage({...row("legacy@x", "full"), bodyText:"Unknown fallback text"});
  const source=Buffer.from('Message-ID: <legacy@x>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Carica fattura e quietanza.</p>');
  const parsed=await parseEmlx(Buffer.concat([Buffer.from(`${source.length}\n`),source]));
  let localCalls=0;
  const live=async()=>{throw new Error("Must not call Mail.app");};
  const local=async()=>{localCalls++;return parsed;};
  const first=await readDb(s,{messageId:"legacy@x"},live,local);
  assert.match(first.body,/Carica fattura/);
  assert.equal(first.bodyExtraction?.source,"html");
  assert.equal(s.getMessage("legacy@x")?.bodyText,first.body);
  await readDb(s,{messageId:"legacy@x"},live,local);
  assert.equal(localCalls,1);
  // A legacy writer can change the body without clearing newer extraction metadata.
  s.raw.prepare("UPDATE messages SET body_text='Legacy writer fallback' WHERE message_id='legacy@x'").run();
  const repaired=await readDb(s,{messageId:"legacy@x"},live,local);
  assert.match(repaired.body,/Carica fattura/);
  assert.equal(localCalls,2);
  s.close();
});

test("readDb never adopts a source belonging to another Message-ID", async () => {
  const s=Store.open(":memory:");s.upsertMessage(row("right@x","full"));
  const source=Buffer.from('Message-ID: <wrong@x>\r\n\r\nWrong body');
  const parsed=await parseEmlx(Buffer.concat([Buffer.from(`${source.length}\n`),source]));
  const detail=await readDb(s,{messageId:"right@x"},async()=>{throw new Error("Must not call Mail.app");},async()=>parsed);
  assert.equal(detail.body,"FULL BODY");s.close();
});

test("readDb serves a substantial partial body straight from the mirror (no live read)", async () => {
  const s = Store.open(":memory:");
  const r: MessageRow = { ...row("p2@x", "none"), bodyState: "partial", bodyText: "This is the full extracted body text from the mirror." };
  s.upsertMessage(r);
  let ran = false;
  const d = await readDb(s, { messageId: "p2@x" }, async () => { ran = true; return ""; });
  assert.equal(ran, false, "must NOT do a live read when the mirror already has the body");
  assert.equal(d.body, "This is the full extracted body text from the mirror.");
  assert.equal(d.bodyState, "partial");
  s.close();
});

test("readDb completes a non-full body with a live read", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("b@x", "none"));
  const d = await readDb(s, { messageId: "b@x" }, async () => liveOut("DOWNLOADED"));
  assert.ok(d.body.includes("DOWNLOADED"));
  assert.equal(d.bodyState, "full");
  s.close();
});

test("a full download with an empty body still attempts recovery", async () => {
  const s=Store.open(":memory:");s.upsertMessage({...row("empty@x","full"),bodyText:""});
  const detail=await readDb(s,{messageId:"empty@x"},async()=>liveOut("Recovered complete text"));
  assert.equal(detail.body,"Recovered complete text");s.close();
});

test("a valid short reply in a partial file does not cause a live read", async () => {
  const s=Store.open(":memory:");
  const source=Buffer.from('Message-ID: <ok@x>\r\n\r\nOk');
  const parsed=await parseEmlx(Buffer.concat([Buffer.from(`${source.length}\n`),source]));
  s.upsertMessage({...row("ok@x","none"),bodyState:"partial",bodyText:parsed.bodyText,bodyExtraction:parsed.bodyExtraction});
  const detail=await readDb(s,{messageId:"ok@x"},async()=>{throw new Error("Unexpected live read");});
  assert.equal(detail.body,"Ok");s.close();
});

test("a known image-only body does not repeatedly trigger a live read that cannot do OCR", async () => {
  const s=Store.open(":memory:");
  const source=Buffer.from('Message-ID: <image@x>\r\nContent-Type: text/html\r\n\r\n<img src="cid:photo">');
  const parsed=await parseEmlx(Buffer.concat([Buffer.from(`${source.length}\n`),source]));
  s.upsertMessage({...row("image@x","none"),bodyState:"partial",bodyText:parsed.bodyText,bodyExtraction:parsed.bodyExtraction});
  let calls=0;
  const detail=await readDb(s,{messageId:"image@x"},async()=>{calls++;return liveOut("");});
  assert.equal(calls,0);
  assert.equal(detail.bodyExtraction?.quality,"limited");s.close();
});

test("readDb uses the INDEXED native id (whose id is) when an id is given", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("c@x", "none"));
  let script = "";
  await readDb(s, { id: "8821", messageId: "c@x" }, async (sc) => { script = sc; return liveOut("X"); });
  assert.match(script, /whose id is 8821/, "must use the fast indexed id lookup");
  assert.doesNotMatch(script, /name of mb is/, "must NOT scope by mailbox name (Gmail All Mail breaks that)");
  s.close();
});

test("readDb falls back to a GLOBAL message-id scan when no native id is given", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("d@x", "none"));
  let script = "";
  await readDb(s, { messageId: "d@x" }, async (sc) => { script = sc; return liveOut("X"); });
  assert.match(script, /whose message id is "d@x"/);
  assert.match(script, /repeat with acct in accounts/, "global scan across all accounts/mailboxes");
  assert.doesNotMatch(script, /name of mb is/, "no mailbox-name scoping");
  s.close();
});

test("readDb falls back to the partial mirror body when the live read fails", async () => {
  const s = Store.open(":memory:");
  const r: MessageRow = { ...row("p@x", "none"), bodyState: "partial", bodyText: "PARTIAL TICKET BODY" };
  s.upsertMessage(r);
  // Simulate the Gmail scoping failure: the live read throws.
  const d = await readDb(s, { messageId: "p@x" }, async () => { throw new Error("Message not found: id 123"); });
  assert.equal(d.body, "PARTIAL TICKET BODY", "must return the partial body, not fail");
  assert.equal(d.bodyState, "partial");
  s.close();
});

test("readDb keeps the richer mirror body when the live read is emptier (PDF-only ticket)", async () => {
  const s = Store.open(":memory:");
  const r: MessageRow = { ...row("rich@x", "none"), bodyState: "partial", bodyText: "A".repeat(4000) };
  s.upsertMessage(r);
  // Live content is basically empty (the real content is in PDF attachments).
  const d = await readDb(s, { messageId: "rich@x" }, async () => liveOut("   "));
  assert.equal(d.body.length, 4000, "must keep the richer mirror partial, not the empty live body");
  assert.equal(d.bodyState, "partial");
  s.close();
});

test("readDb keeps the partial body when the live read reports it unavailable", async () => {
  const s = Store.open(":memory:");
  const r: MessageRow = { ...row("u@x", "none"), bodyState: "partial", bodyText: "PARTIAL" };
  s.upsertMessage(r);
  const d = await readDb(s, { messageId: "u@x" }, async () => liveOut("[body unavailable: timeout]"));
  assert.equal(d.body, "PARTIAL");
  s.close();
});

test("readDb throws a clear error when the message is unknown", async () => {
  const s = Store.open(":memory:");
  await assert.rejects(() => readDb(s, { messageId: "missing@x" }), /not found/i);
  s.close();
});

test("readDb throws not-found for a soft-deleted message", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("del@x", "full"));
  s.softDelete("del@x");
  await assert.rejects(() => readDb(s, { messageId: "del@x" }), /not found/i);
  s.close();
});

test("readDb date field is ISO-8601", async () => {
  const s = Store.open(":memory:");
  s.upsertMessage(row("iso@x", "full"));
  const d = await readDb(s, { messageId: "iso@x" }, async () => "");
  assert.ok(!Number.isNaN(Date.parse(d.date)), `date should be ISO-8601, got: ${d.date}`);
  s.close();
});
