import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanBody } from "../src/clean-body.ts";

test("strips HTML tags and decodes entities", () => {
  const out = cleanBody("<p>Ciao <b>Alessio</b>&nbsp;&amp; tutti</p><style>.x{}</style>");
  assert.ok(!out.includes("<"));
  assert.match(out, /Ciao Alessio & tutti/);
  assert.ok(!/\.x\{\}/.test(out)); // style content dropped
});

test("cuts the quoted reply history (EN + IT markers)", () => {
  const en = "Sounds good, thanks!\n\nOn Mon, 1 Jan 2024 at 10:00, Mario <m@x.it> wrote:\n> old stuff\n> more old";
  assert.equal(cleanBody(en).trim(), "Sounds good, thanks!");
  const it = "Perfetto, a domani.\nIl giorno 2 nov 2023, alle 12:17, Multichance <m@polimi.it> ha scritto:\n> vecchio";
  assert.equal(cleanBody(it).trim(), "Perfetto, a domani.");
});

test("collapses tracking URLs to their domain", () => {
  const out = cleanBody("Apri qui https://www.vinted.it/crm/campaign_track?id=very-long-tracking-token-12345 grazie");
  assert.match(out, /\[vinted\.it\]/);
  assert.ok(!out.includes("campaign_track"));
});

test("keeps a useful link's destination but drops its tracking query", () => {
  const out = cleanBody("Doc: https://docs.google.com/document/d/ABC123/edit?usp=sharing&utm_source=mail ok");
  assert.match(out, /docs\.google\.com\/document\/d\/ABC123\/edit/); // destination preserved
  assert.ok(!out.includes("utm_source")); // tracking query dropped
});

test("keeps a short clean query (e.g. a video id)", () => {
  const out = cleanBody("Guarda https://www.youtube.com/watch?v=abc123 qui");
  assert.match(out, /youtube\.com\/watch\?v=abc123/);
});

test("removes signature and boilerplate footer lines", () => {
  const out = cleanBody("Il contenuto vero.\n-- \nMario Rossi\nInviato da iPhone\nClicca per annullare l'iscrizione");
  assert.match(out, /Il contenuto vero\./);
  assert.ok(!/Mario Rossi/.test(out));
  assert.ok(!/iPhone/.test(out));
});

test("collapses whitespace and is much shorter on noisy input", () => {
  const noisy = "<div>Testo    importante.</div>\n\n\n\n<a href='https://t.co/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'>link</a>\n> quote\n> quote";
  const out = cleanBody(noisy);
  assert.match(out, /Testo importante\./);
  assert.ok(out.length < noisy.length);
  assert.ok(!/\n{3,}/.test(out));
});

test("leaves clean plain text essentially intact", () => {
  const plain = "Ciao, ci vediamo domani alle 10 per il progetto. Grazie!";
  assert.equal(cleanBody(plain).trim(), plain);
});
