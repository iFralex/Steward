// apps/mail-promoter/src/wiki.ts
export interface WikiPromoter {
  addSources(projectId: string, sources: { filename: string; content: string }[], rescan?: boolean): Promise<unknown>;
}

/**
 * Add a distilled note to the wiki as a source. `LlmWikiApiClient` from the wiki
 * mcp-server satisfies WikiPromoter. Pass `rescan: false` during a bulk backfill
 * (re-indexing + wiki-page regeneration per note is hugely redundant) and run a
 * single rescan at the end instead.
 */
export async function promote(note: { filename: string; content: string }, client: WikiPromoter, projectId = "current", rescan = true): Promise<void> {
  await client.addSources(projectId, [note], rescan);
}
