// Manual live check: reads the real AddressBook stores + a create/delete round-trip.
// Run: node --import tsx apps/contacts-mcp/realtest.mts
import { AddressBookStore } from "./src/addressbook-store.ts";
import { sourceDbPaths } from "./src/paths.ts";
import { createContact } from "./src/applescript.ts";
import { runOsa, esc } from "@llm-wiki/applescript";

const store = AddressBookStore.load(sourceDbPaths());
console.log("contacts:", store.listContacts().length);
const id = await createContact({ firstName: "LLMWiki", lastName: "Realtest", organization: "delete me", emails: [{ address: "realtest@example.com", label: "Home" }] });
console.log("created id:", id);
await runOsa(`tell application "Contacts"\n  delete (first person whose id is "${esc(id)}")\n  save\nend tell`, {});
console.log("deleted OK");
