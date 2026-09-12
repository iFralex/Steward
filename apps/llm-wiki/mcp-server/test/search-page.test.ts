import assert from "node:assert/strict"
import test from "node:test"
import { buildWikiSearchPage, normalizeWikiSearchPage } from "../src/search-page.js"
import type { ApiSearchResult } from "../src/api-client.js"

const rows = (count: number): ApiSearchResult[] => Array.from({ length: count }, (_, index) => ({
  path: `wiki/result-${index}.md`,
  title: `Result ${index}`,
  snippet: `Snippet ${index}`,
  score: 1 - index / 100,
}))

test("defaults to five visible results and fetches one look-ahead result", () => {
  assert.deepEqual(normalizeWikiSearchPage(), { limit: 5, offset: 0, fetchTopK: 6 })
})

test("caps a page at ten and retrieval at the API maximum", () => {
  assert.deepEqual(normalizeWikiSearchPage(999, 999), { limit: 10, offset: 49, fetchTopK: 50 })
})

test("returns page metadata and preserves ranking", () => {
  const page = buildWikiSearchPage({ results: rows(11), mode: "hybrid", tokenHits: 20, vectorHits: 10 }, 5, 5)
  assert.deepEqual(page.results.map((row) => row.title), ["Result 5", "Result 6", "Result 7", "Result 8", "Result 9"])
  assert.deepEqual(page.page, { offset: 5, returned: 5, hasMore: true, nextOffset: 10 })
  assert.equal(page.mode, "hybrid")
  assert.equal(page.tokenHits, 20)
  assert.equal(page.vectorHits, 10)
})

test("omits nextOffset on the final page", () => {
  const page = buildWikiSearchPage({ results: rows(8) }, 5, 5)
  assert.deepEqual(page.page, { offset: 5, returned: 3, hasMore: false })
})
