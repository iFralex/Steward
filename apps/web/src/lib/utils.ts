import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Schemes we'll render as a clickable link — everything else (javascript:, data:, etc.) is stripped. */
const SAFE_HREF = /^(https?:|mailto:|message:)/i;
export function safeHref(href: string | undefined): string | undefined {
  return href && SAFE_HREF.test(href.trim()) ? href : undefined;
}
