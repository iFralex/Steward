#!/usr/bin/env node

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const INGESTABLE = new Set([
  "md", "mdx", "txt", "pdf", "doc", "docx", "pptx", "xlsx",
  "odt", "odp", "ods", "xls", "csv", "json", "html", "htm",
  "rtf", "xml", "yaml", "yml",
])

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1])
}

const projectPath = args.get("--project")
const projectId = args.get("--project-id")
const appStatePath = args.get("--app-state")
const mode = args.get("--mode") ?? "pilot"
const apply = process.argv.includes("--apply")

if (!projectPath || !projectId || !appStatePath || !["pilot", "global"].includes(mode)) {
  console.error(
    "Usage: node prepare-second-me-ingest.mjs --project PATH --project-id UUID " +
    "--app-state PATH --mode pilot|global [--apply yes]",
  )
  process.exit(2)
}

async function collectFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const rel = path.join(relative, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, rel))
      continue
    }
    const ext = path.extname(entry.name).slice(1).toLowerCase()
    if (INGESTABLE.has(ext)) files.push(rel.split(path.sep).join("/"))
  }
  return files
}

function folderContext(sourcePath) {
  const parts = sourcePath.replace(/^raw\/sources\//, "").split("/")
  parts.pop()
  return parts.join(" > ")
}

const sourceRoot = path.join(projectPath, "raw", "sources")
const allSources = (await collectFiles(sourceRoot))
  .map((rel) => `raw/sources/${rel}`)
  .sort()

const pilotSources = [
  "raw/sources/progetti/project-candidai.md",
  "raw/sources/carriera/cv/CV_antonucci.pdf",
  "raw/sources/carriera/lettere/Google Cover letter.pdf",
  "raw/sources/mail-thread-766.md",
]

const selected = mode === "pilot" ? pilotSources : allSources
const missing = selected.filter((rel) => !allSources.includes(rel))
if (missing.length > 0) {
  console.error(`Missing selected sources:\n${missing.join("\n")}`)
  process.exit(1)
}

const categoryCounts = {}
for (const source of allSources) {
  const rel = source.replace(/^raw\/sources\//, "")
  const category = rel.includes("/") ? rel.split("/")[0] : "mail-threads"
  categoryCounts[category] = (categoryCounts[category] ?? 0) + 1
}

console.log(JSON.stringify({
  mode,
  projectPath,
  totalSources: allSources.length,
  selectedSources: selected.length,
  categoryCounts,
  selected,
  apply,
}, null, 2))

if (!apply) process.exit(0)

const now = Date.now()
const queue = selected.map((sourcePath, index) => ({
  id: `ingest-rebuild-${now}-${index + 1}`,
  projectId,
  sourcePath,
  folderContext: folderContext(sourcePath),
  status: "pending",
  addedAt: now + index,
  error: null,
  retryCount: 0,
}))

const statePath = path.join(projectPath, ".llm-wiki")
const wikiPath = path.join(projectPath, "wiki")

await mkdir(statePath, { recursive: true })

if (mode === "pilot") {
  await rm(wikiPath, { recursive: true, force: true })
  await rm(path.join(statePath, "lancedb"), { recursive: true, force: true })
  await mkdir(wikiPath, { recursive: true })

  await writeFile(path.join(wikiPath, "index.md"), `# Wiki Index

## People

## Organizations

## Projects

## Experiences

## Skills

## Events

## Topics

## Sources

## Synthesis

## Queries
`)

  await writeFile(path.join(wikiPath, "log.md"), `# Knowledge Base Log

## 2026-06-26

- Clean rebuild prepared from canonical sources
`)

  await writeFile(path.join(wikiPath, "overview.md"), `---
type: overview
title: Second Me Overview
tags: []
related: []
sources: []
created: 2026-06-26
updated: 2026-06-26
---

# Second Me

This knowledge base is being rebuilt from its canonical sources.
`)

  await writeFile(path.join(statePath, "ingest-cache.json"), JSON.stringify({ entries: {} }, null, 2))
  await writeFile(path.join(statePath, "review.json"), "[]\n")
}

await writeFile(path.join(statePath, "ingest-queue.json"), JSON.stringify(queue, null, 2))
await writeFile(path.join(statePath, "file-change-queue.json"), JSON.stringify({ version: 1, tasks: [] }, null, 2))
await writeFile(path.join(statePath, "file-snapshot.json"), JSON.stringify({
  version: 1,
  updatedAt: now,
  files: {},
}, null, 2))

const appState = JSON.parse(await readFile(appStatePath, "utf8"))
const watchConfig = appState.sourceWatchConfig?.[projectId]
if (!watchConfig) {
  throw new Error(`No sourceWatchConfig found for project ${projectId}`)
}
appState.sourceWatchConfig[projectId] = {
  ...watchConfig,
  enabled: mode === "global",
  autoIngest: mode === "global",
}
await writeFile(appStatePath, `${JSON.stringify(appState, null, 2)}\n`)

console.log(`Prepared ${mode} ingest with ${queue.length} queued source(s).`)
