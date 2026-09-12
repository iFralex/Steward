export const DEFAULT_CONTENT_PAGE_CHARS = 5_000
export const MAX_CONTENT_PAGE_CHARS = 12_000

export interface ContentPageArgs {
  contentOffset?: number
  contentLimit?: number
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(0, Math.trunc(parsed)))
}

export function formatContentPage(path: string, content: string, args: ContentPageArgs = {}): string {
  const limit = Math.max(1, boundedInteger(args.contentLimit, DEFAULT_CONTENT_PAGE_CHARS, MAX_CONTENT_PAGE_CHARS))
  const offset = boundedInteger(args.contentOffset, 0, Number.MAX_SAFE_INTEGER)
  const page = content.slice(offset, offset + limit)
  const returned = page.length
  const hasEarlier = offset > 0
  const hasMore = offset + returned < content.length
  const navigation = [
    `offset: ${offset}`,
    `returned: ${returned}`,
    `total: ${content.length}`,
    hasEarlier ? `earlierOffset: ${Math.max(0, offset - limit)}` : null,
    hasMore ? `nextOffset: ${offset + returned}` : "final page",
  ].filter(Boolean).join(" | ")
  return `# ${path}\n[Content page | ${navigation}]\n\n${page}`
}
