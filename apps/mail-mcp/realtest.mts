// Real-data smoke of the Plan B advanced search surface against the populated mirror.
// Read-only; no embeddings needed (lexical/trigram/filters/flags/roles only).
import { Store } from "../mail-mirror/src/store.ts";
import { dbPath } from "../mail-mirror/src/paths.ts";
import { searchDb } from "./src/db-search.ts";
import { resolveScope } from "./src/scope.ts";
import { getThread } from "./src/db-thread.ts";

const store = Store.openReadonly(dbPath());

function show(title: string, rows: { subject: string; from: string; mailbox: string; account: string; date: string }[]) {
  console.log(`\n### ${title}  -> ${rows.length} hit`);
  for (const r of rows.slice(0, 5)) {
    console.log(`  · [${r.mailbox}] ${(r.subject || "(no subj)").slice(0, 48).padEnd(48)} <- ${r.from.slice(0, 34)}`);
  }
}

// 1) Field-scoped trigram: people with "cristian" in the SENDER name
show("fromName contains 'cristian'", await searchDb(store, { fromName: "cristian", perMessage: true, limit: 5 }));

// 2) Field-scoped trigram on recipient names
show("toName contains 'cristian'", await searchDb(store, { toName: "cristian", perMessage: true, limit: 5 }));

// 3) Mailbox role resolution for a specific account (friendly email -> UUID, role -> mailbox names)
const acctEmail = "ifralex.business@gmail.com";
const scope = resolveScope(store, { account: acctEmail, mailbox: "drafts" });
console.log(`\n### resolveScope(${acctEmail}, mailbox:"drafts") =>`, JSON.stringify(scope));
show(`${acctEmail} / role:drafts`, await searchDb(store, { account: acctEmail, mailbox: "drafts", perMessage: true, limit: 5 }));
show(`${acctEmail} / role:sent`, await searchDb(store, { account: acctEmail, mailbox: "sent", perMessage: true, limit: 5 }));

// 4) Flag filters
show("flaggedOnly", await searchDb(store, { flaggedOnly: true, perMessage: true, limit: 5 }));
show("unreadOnly + subjectContains 'fattura'", await searchDb(store, { unreadOnly: true, subjectContains: "fattura", perMessage: true, limit: 5 }));

// 5) Rich filters: sender domain + sort by size desc
show("senderDomain trenitalia.it, sort=date", await searchDb(store, { senderDomain: "trenitalia.it", sort: "date", sortDir: "desc", perMessage: true, limit: 5 }));
show("hasAttachments, sort=size desc", await searchDb(store, { hasAttachments: true, sort: "size", sortDir: "desc", perMessage: true, limit: 5 }));

// 6) get_thread: expand the conversation of the first hit of a broad query
const seed = await searchDb(store, { query: "trenitalia", perMessage: true, limit: 1 });
if (seed.length) {
  const thread = getThread(store, { messageId: seed[0].messageId });
  show(`get_thread for "${seed[0].subject.slice(0, 30)}"`, thread);
}

// 7) bodyContains trigram (substring inside body)
show("bodyContains 'frecciarossa'", await searchDb(store, { bodyContains: "frecciarossa", perMessage: true, limit: 5 }));

store.close();
console.log("\n(done)");
