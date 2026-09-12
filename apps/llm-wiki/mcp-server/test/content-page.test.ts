import assert from "node:assert/strict"
import test from "node:test"
import { formatContentPage } from "../src/content-page.js"

test("returns a complete short file with its path", () => {
  assert.equal(
    formatContentPage("wiki/note.md", "Exact content"),
    "# wiki/note.md\n[Content page | offset: 0 | returned: 13 | total: 13 | final page]\n\nExact content",
  )
})

test("returns the first 5000 exact characters with a next offset", () => {
  const content = `${"a".repeat(5_000)}important tail`
  const page = formatContentPage("wiki/large.md", content)
  assert.match(page, /offset: 0 \| returned: 5000 \| total: 5014 \| nextOffset: 5000/)
  assert.equal(page.split("\n\n")[1], content.slice(0, 5_000))
})

test("continues at an exact offset and exposes backward navigation", () => {
  const content = `${"a".repeat(5_000)}important tail`
  const page = formatContentPage("wiki/large.md", content, { contentOffset: 5_000, contentLimit: 100 })
  assert.match(page, /offset: 5000 \| returned: 14 \| total: 5014 \| earlierOffset: 4900 \| final page/)
  assert.equal(page.split("\n\n")[1], "important tail")
})

test("caps oversized page requests at 12000 characters", () => {
  const content = "x".repeat(20_000)
  const page = formatContentPage("wiki/large.md", content, { contentLimit: 99_999 })
  assert.match(page, /returned: 12000/)
  assert.equal(page.split("\n\n")[1].length, 12_000)
})
