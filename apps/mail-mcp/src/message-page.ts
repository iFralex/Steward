import type { MailDetail } from "./db-read.ts";

export const DEFAULT_BODY_PAGE_CHARS = 5_000;
export const MAX_BODY_PAGE_CHARS = 12_000;

export type MessagePageArgs = {
  bodyOffset?: number;
  bodyLimit?: number;
};

export type MessagePage = Omit<MailDetail, "body"> & {
  body: string;
  bodyPage: {
    totalChars: number;
    offset: number;
    returnedChars: number;
    hasEarlier: boolean;
    earlierOffset?: number;
    hasMore: boolean;
    nextOffset?: number;
  };
};

function boundedInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(0, Math.trunc(parsed)));
}

export function buildMessagePage(detail: MailDetail, args: MessagePageArgs = {}): MessagePage {
  const bodyLimit = Math.max(1, boundedInteger(args.bodyLimit, DEFAULT_BODY_PAGE_CHARS, MAX_BODY_PAGE_CHARS));
  const bodyOffset = boundedInteger(args.bodyOffset, 0, Number.MAX_SAFE_INTEGER);
  const body = detail.body.slice(bodyOffset, bodyOffset + bodyLimit);
  const returnedChars = body.length;
  const hasEarlier = bodyOffset > 0;
  const hasMore = bodyOffset + returnedChars < detail.body.length;
  return {
    ...detail,
    body,
    bodyPage: {
      totalChars: detail.body.length,
      offset: bodyOffset,
      returnedChars,
      hasEarlier,
      ...(hasEarlier ? { earlierOffset: Math.max(0, bodyOffset - bodyLimit) } : {}),
      hasMore,
      ...(hasMore ? { nextOffset: bodyOffset + returnedChars } : {}),
    },
  };
}
