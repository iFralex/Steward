// apps/mail-mirror/test/enrich.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { refreshIdentity, parseLocalizedTerms } from "../src/enrich.ts";

test("parseLocalizedTerms maps role<TAB>term lines, stripping unified suffix", () => {
  const out = "drafts\tBozze (tutte)\nsent\tInviate (tutte)\ntrash\tCestino (tutte)\njunk\tIndesiderata (tutte)\n";
  const t = parseLocalizedTerms(out);
  assert.deepEqual(t.drafts, ["bozze"]);
  assert.deepEqual(t.junk, ["indesiderata"]);
});

test("refreshIdentity populates accounts then discovers roles for each", async () => {
  const s = Store.open(":memory:");
  const exec = async (script: string) => {
    if (script.includes("email addresses")) return "U1\tGoogle\ta@x.com\n";
    return "drafts\tBozze\n"; // localized terms
  };
  // Inject a readMboxCache seam so the test does NOT touch the filesystem.
  const r = await refreshIdentity({
    store: s,
    mailRoot: "/x",
    exec,
    readMboxCache: async () => [{ name: "Bozze", attr: 0 }],
  });
  assert.equal(r.accounts, 1);
  assert.ok(s.hasAccount("U1"));
  assert.equal(s.roleForMailbox("U1", "Bozze"), "drafts");
  s.close();
});
