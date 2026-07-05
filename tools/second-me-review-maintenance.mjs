import fs from "node:fs"
import path from "node:path"

const projectRoot = "/Users/alessioantonucci/Second Me"
const wikiRoot = path.join(projectRoot, "wiki")
const reviewPath = path.join(projectRoot, ".llm-wiki", "review.json")
const lintPath = path.join(projectRoot, ".llm-wiki", "lint.json")
const apply = process.argv.includes("--apply")

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function walkMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkMarkdown(full, out)
    if (entry.isFile() && entry.name.endsWith(".md")) out.push(full)
  }
  return out
}

function lintLinkTarget(target) {
  return target
    .replace(/^wiki\//i, "")
    .replace(/\.md$/i, "")
    .trim()
}

function normalizedLintLinkTarget(target) {
  return lintLinkTarget(target).toLowerCase()
}

function rewriteWikilinkTarget(content, brokenTarget, suggestedTarget) {
  const broken = normalizedLintLinkTarget(brokenTarget)
  const replacement = lintLinkTarget(suggestedTarget)
  let count = 0
  const next = content.replace(
    /\[\[([^\]|]+?)(\|[^\]]+?)?\]\]/g,
    (match, rawTarget, rawAlias = "") => {
      if (normalizedLintLinkTarget(rawTarget) !== broken) return match
      count += 1
      return `[[${replacement}${rawAlias}]]`
    },
  )
  return { content: next, count }
}

function existingWikiRelPaths() {
  const files = walkMarkdown(wikiRoot)
  const rels = new Set()
  for (const file of files) {
    const rel = path.relative(wikiRoot, file).replaceAll(path.sep, "/")
    rels.add(rel)
    rels.add(rel.replace(/\.md$/i, ""))
  }
  return rels
}

function hasExistingTarget(existing, target) {
  const normalized = lintLinkTarget(target)
  return existing.has(normalized) || existing.has(`${normalized}.md`)
}

function slugify(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function isSafeAliasRewrite(brokenTarget, suggestedTarget) {
  const suggested = lintLinkTarget(suggestedTarget)
  const category = suggested.split("/")[0] ?? ""
  if (category === "sources") return false
  if (category === "skills" && suggested === "skills/d3") return false
  const suggestedBase = path.basename(suggested)
  const brokenSlug = slugify(brokenTarget)
  if (!brokenSlug || brokenSlug.length < 4) return false
  if (suggestedBase === brokenSlug) return true

  const manualAliases = new Map([
    ["st-engineering-antycip", "st-engineering-anticyp"],
    ["st-engineering-anticyp", "st-engineering-antycip"],
    ["intesa-san-paolo", "intesa-sanpaolo"],
    ["google-cloud-platform-gcp", "google-cloud-platform"],
    ["professor-lucini", "lucini"],
  ])
  return manualAliases.get(brokenSlug) === suggestedBase
}

const review = readJson(reviewPath)
const lint = readJson(lintPath)
const existing = existingWikiRelPaths()

const resolvedReviewIds = new Set([
  "review-81",
  "review-197",
  "review-262",
  "review-510",
  "review-590",
])

const changedReviews = []
for (const item of review) {
  if (resolvedReviewIds.has(item.id) && !item.resolved) {
    item.resolved = true
    item.resolvedAt = item.resolvedAt ?? Date.now()
    item.resolution = item.resolution ?? "Resolved during manual maintenance: item was already corrected or determined to need no action."
    changedReviews.push(item.id)
  }
}

const markdownByRel = new Map()
for (const file of walkMarkdown(wikiRoot)) {
  markdownByRel.set(path.relative(wikiRoot, file).replaceAll(path.sep, "/"), file)
}

const blockedBadSuggestions = new Set([
  "skills/d3.md",
  "skills/d3",
])

const linkEdits = []
for (const item of lint) {
  if (item.type !== "broken-link") continue
  if (!item.page || !item.brokenTarget || !item.suggestedTarget) continue
  if (blockedBadSuggestions.has(lintLinkTarget(item.suggestedTarget))) continue
  if (!hasExistingTarget(existing, item.suggestedTarget)) continue
  if (!isSafeAliasRewrite(item.brokenTarget, item.suggestedTarget)) continue

  const rel = item.page.replace(/^wiki\//i, "")
  const file = markdownByRel.get(rel)
  if (!file) continue

  const before = fs.readFileSync(file, "utf8")
  const { content: after, count } = rewriteWikilinkTarget(
    before,
    item.brokenTarget,
    item.suggestedTarget,
  )
  if (count === 0 || after === before) continue

  linkEdits.push({
    lintId: item.id,
    page: rel,
    brokenTarget: item.brokenTarget,
    suggestedTarget: lintLinkTarget(item.suggestedTarget),
    count,
    before,
    after,
    file,
  })
}

const editsByFile = new Map()
for (const edit of linkEdits) {
  const current = editsByFile.get(edit.file) ?? edit.before
  const { content: after } = rewriteWikilinkTarget(
    current,
    edit.brokenTarget,
    edit.suggestedTarget,
  )
  editsByFile.set(edit.file, after)
}

function hasWikilinkToTarget(content, target) {
  const normalized = normalizedLintLinkTarget(target)
  return Array.from(content.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g))
    .some((match) => normalizedLintLinkTarget(match[1]) === normalized)
}

function contentAfterPendingEdits(file) {
  return editsByFile.get(file) ?? fs.readFileSync(file, "utf8")
}

const lintItemsToRemove = new Set()
for (const item of lint) {
  if (item.type !== "broken-link" || !item.page || !item.brokenTarget) continue
  const rel = item.page.replace(/^wiki\//i, "")
  const file = markdownByRel.get(rel)
  if (!file) continue
  const content = contentAfterPendingEdits(file)
  if (!hasWikilinkToTarget(content, item.brokenTarget)) {
    lintItemsToRemove.add(item.id)
  }
}

const nextLint = lint.filter((item) => !lintItemsToRemove.has(item.id))

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  reviewItemsToResolve: changedReviews,
  rawLinkEdits: linkEdits.length,
  filesToRewrite: editsByFile.size,
  lintItemsToRemove: lintItemsToRemove.size,
  sampleLinkEdits: linkEdits.slice(0, 25).map((edit) => ({
    lintId: edit.lintId,
    page: edit.page,
    from: edit.brokenTarget,
    to: edit.suggestedTarget,
    count: edit.count,
  })),
}, null, 2))

if (apply) {
  for (const [file, content] of editsByFile) {
    fs.writeFileSync(file, content)
  }
  writeJson(reviewPath, review)
  writeJson(lintPath, nextLint)
}
