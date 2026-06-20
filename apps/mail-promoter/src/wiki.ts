// apps/mail-promoter/src/wiki.ts
export interface WikiPromoter {
  addSources(projectId: string, sources: { filename: string; content: string }[], rescan?: boolean): Promise<unknown>;
}

/** Add a distilled note to the wiki as a source. `LlmWikiApiClient` from the wiki mcp-server satisfies WikiPromoter. */
export async function promote(note: { filename: string; content: string }, client: WikiPromoter, projectId = "current"): Promise<void> {
  await client.addSources(projectId, [note], true);
}
