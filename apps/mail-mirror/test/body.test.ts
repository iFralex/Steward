import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBody, looksLikeHtml } from "../src/body.ts";
import { parseEmlx } from "../src/emlx.ts";

const html = '<html><head><style>.hidden { color: red }</style><script>alert(1)</script></head><body><p>Ciao &amp; grazie.</p><p>Carica fattura e quietanza.</p><a href="https://example.com/spese">Apri spese</a></body></html>';
function emlx(rfc: string): Buffer {
  const bytes = Buffer.from(rfc);
  return Buffer.concat([Buffer.from(`${bytes.length}\n`), bytes]);
}
function alternative(plain: string, rich: string, sender = "sender@example.com") {
  return emlx(`From: ${sender}\r\nMessage-ID: <html@example.com>\r\nContent-Type: multipart/alternative; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${plain}\r\n--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${rich}\r\n--B--\r\n`);
}

test("unknown placeholders and sender changes cannot hide substantive HTML", async () => {
  for (const sender of ["sender@example.com", "unknown@new-domain.test"]) {
    for (const placeholder of ["Please see this email with a client that supports HTML.", "ZQX-917 — représentation indisponible", "この表示は利用できません", "Versione provvisoria XYZ"]) {
      const m = await parseEmlx(alternative(placeholder, html, sender));
      assert.match(m.bodyText, /Ciao & grazie\./);
      assert.match(m.bodyText, /Carica fattura e quietanza\./);
      assert.match(m.bodyText, /https:\/\/example.com\/spese/);
      assert.match(m.bodyText, new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(m.bodyExtraction?.source, "both");
      assert.equal(m.bodyExtraction?.quality, "ambiguous");
      assert.doesNotMatch(m.bodyText, /alert|color: red/);
    }
  }
});

test("a short valid plain message survives unrelated longer HTML", () => {
  const result = extractBody("Pagamento ricevuto.", html);
  assert.match(result.text, /Pagamento ricevuto\./);
  assert.match(result.text, /Carica fattura/);
  assert.equal(result.extraction.quality, "ambiguous");
  const plain=result.extraction.alternatives?.find(range=>range.source==='plain');
  const rich=result.extraction.alternatives?.find(range=>range.source==='html');
  assert.ok(plain && rich);
  assert.equal(result.text.slice(plain.offset,plain.offset+plain.chars),"Pagamento ricevuto.");
  assert.match(result.text.slice(rich.offset,rich.offset+rich.chars),/Carica fattura/);
  assert.equal(extractBody("Ok", false).text, "Ok");
});

test("equivalent versions deduplicate; a real HTML superset preserves new paragraphs and links", () => {
  assert.equal(extractBody("Ok", "<p>Ok</p>").text, "Ok");
  const result = extractBody("Pagamento ricevuto.", '<p>Pagamento ricevuto.</p><p>Scarica la ricevuta.</p><a href="https://example.com/r">Ricevuta</a>');
  assert.equal(result.extraction.source, "html");
  assert.equal(result.extraction.quality, "usable");
  assert.match(result.text, /Scarica la ricevuta/);
  assert.match(result.text, /https:\/\/example.com\/r/);
  assert.doesNotMatch(result.text, /Versione testuale/);
});

test("plain-only content absent from HTML is preserved", () => {
  const result = extractBody("Pagamento ricevuto.\n\nCodice pratica: AB-943.", "<p>Pagamento ricevuto.</p>");
  assert.equal(result.extraction.source, "plain");
  assert.match(result.text, /AB-943/);
});

test("amounts, dates, negations, codes, paragraph order and multiplicity are never smoothed away", () => {
  for (const [plain, rich] of [
    ["Totale: 100 EUR", "<p>Totale: 1000 EUR</p>"],
    ["Scadenza: 15/10/2026", "<p>Scadenza: 16/10/2026</p>"],
    ["La detrazione è ammessa.", "<p>La detrazione non è ammessa.</p>"],
    ["Codice: AB-123", "<p>Codice: AB-124</p>"],
    ["Prima\n\nDopo", "<p>Dopo</p><p>Prima</p>"],
  ]) {
    const result = extractBody(plain, rich);
    assert.equal(result.extraction.source, "both", plain);
    assert.equal(result.extraction.quality, "ambiguous", plain);
    assert.ok(result.text.includes(plain));
  }
  assert.equal(extractBody("Paga.\n\nPaga.", "<p>Paga.</p>").extraction.source, "plain");
});

test("different link destinations are retained even if the visible wording is identical", () => {
  const result = extractBody("Paga https://example.com/a", '<p>Paga <a href="https://example.com/b">https://example.com/b</a></p>');
  assert.equal(result.extraction.source, "both");
  assert.match(result.text, /example.com\/a/);
  assert.match(result.text, /example.com\/b/);
});

test("empty plain text, HTML-only mail and mislabeled fragments use the same renderer", async () => {
  for (const source of [html, "<div><p>Fattura &amp; quietanza</p></div>"]) {
    const result = extractBody(" ", source);
    assert.equal(result.extraction.source, "html");
    assert.equal(result.extraction.quality, "usable");
    assert.equal(looksLikeHtml(source), true);
    const m = await parseEmlx(emlx('Content-Type: text/plain; charset=utf-8\r\n\r\n' + source));
    assert.equal(m.bodyExtraction?.reason, "mislabeled-html");
    assert.doesNotMatch(m.bodyText, /<html|<div|alert/);
  }
  const onlyHtml = await parseEmlx(emlx('Content-Type: text/html; charset=utf-8\r\n\r\n' + html));
  assert.equal(onlyHtml.bodyExtraction?.plainChars, 0, "do not mistake synthesized text for a MIME plain part");
  assert.match(onlyHtml.bodyExtraction?.sourceHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(looksLikeHtml("Please review the HTML invoice attached."), false);
});

test("tracking, scripts and hidden content do not become the main body", () => {
  const result = extractBody(undefined, '<div style=" display : none !important">SECRET PREHEADER</div><script>bad()</script><p>Corpo visibile &amp; completo.</p><img width="1" src="https://tracker.example/open"><p hidden>NASCOSTO</p>');
  assert.equal(result.text, "Corpo visibile & completo.");
  assert.doesNotMatch(result.text, /SECRET|bad\(|tracker|NASCOSTO/);
  assert.ok(result.extraction.issues.includes("hidden-content"));
});

test("embedded data URI is not expanded and following text remains readable", () => {
  const result = extractBody(undefined, '<p>Prima del documento.</p><img role="presentation" src="data:image/png;base64,SGVsbG8="><p>Dopo il documento.</p>');
  assert.match(result.text, /Prima del documento/);
  assert.match(result.text, /Dopo il documento/);
  assert.doesNotMatch(result.text, /base64|SGVsbG8/);
});

test("image-only content is explicitly limited rather than pretending OCR happened", () => {
  const result = extractBody(undefined, '<img src="cid:document" alt="Dettagli della fattura">');
  assert.equal(result.extraction.quality, "limited");
  assert.ok(result.extraction.issues.includes("image-content-not-extracted"));
  assert.match(result.text, /Immagine: Dettagli/);
});

test("data tables keep headers, values and row order; malformed markup is tolerated", () => {
  const result = extractBody(undefined, '<table role="table"><tr><th>Voce</th><th>Importo</th></tr><tr><td>Prima</td><td>100 EUR</td></tr><tr><td>Seconda</td><td>200 EUR</td></tr></table>');
  assert.match(result.text, /Voce[\s\S]*Importo[\s\S]*Prima[\s\S]*100 EUR[\s\S]*Seconda[\s\S]*200 EUR/);
  assert.match(extractBody(undefined, "<div><p>Testo <strong>malformato").text, /Testo malformato/);
});

test("multilingual exact containment does not require whitespace tokenization", () => {
  for (const plain of ["支払いが完了しました。", "ชำระเงินเรียบร้อยแล้ว", "تم الدفع بنجاح."]) {
    const result = extractBody(plain, `<p>${plain}</p><p>ABC-123</p>`);
    assert.equal(result.extraction.source, "html");
    assert.match(result.text, /ABC-123/);
  }
});

test("every resource limit is explicit and no readable content is fabricated", () => {
  for (const limits of [{inputChars: 10}, {outputChars: 10}, {depth: 2}, {nodes: 2}]) {
    const result = extractBody(undefined, "<div><div><p>Testo prima e dopo il limite.</p></div></div>", limits);
    assert.equal(result.extraction.quality, "limited", JSON.stringify(limits));
    assert.ok(result.extraction.issues.some(issue=>issue.endsWith("-limit")));
  }
  assert.equal(extractBody(undefined, "<html><body></body></html>").extraction.quality, "unavailable");
  assert.equal(extractBody("Testo valido", "<html><body></body></html>").text, "Testo valido");
});

test("mixed MIME content preserves plain and HTML sections", async () => {
  const bytes = emlx('Message-ID: <mixed@example.com>\r\nContent-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nIntroduzione originale.\r\n--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Seconda sezione HTML.</p>\r\n--B--\r\n');
  const result = await parseEmlx(bytes);
  assert.match(result.bodyText, /Introduzione originale/);
  assert.match(result.bodyText, /Seconda sezione HTML/);
});

test("SVG labels survive while executable SVG content is excluded", () => {
  const result=extractBody(undefined,'<svg><title>Gross Domestic Product</title><text>1950</text><text>2000</text><script>bad()</script></svg>');
  assert.match(result.text,/Gross Domestic Product[\s\S]*1950[\s\S]*2000/);
  assert.doesNotMatch(result.text,/bad\(/);
});

test("layout-only CID and link wrappers do not create a false divergence", () => {
  const result=extractBody('Ciao.\n\nwww.example.com<https://www.example.com/>\n\n[cid:logo123]', '<p>Ciao.</p><p><a href="https://www.example.com/">www.example.com</a></p><img src="cid:logo123">');
  assert.equal(result.extraction.source,"plain");
  assert.equal(result.extraction.quality,"usable");
});

test("preformatted whitespace and compatibility characters do not erase alternative codes", () => {
  assert.equal(extractBody("abc def", "<pre>abc  def</pre>").extraction.source,"both");
  assert.equal(extractBody("Codice: Ａ123", "<p>Codice: A123</p>").extraction.source,"both");
  assert.equal(extractBody(undefined,"<h1>Codice: Abc-123</h1>").text,"Codice: Abc-123");
});
