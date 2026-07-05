import { useSyncExternalStore } from "react";

/** Matches Tailwind's `lg` breakpoint — the same threshold the layout classes use. */
const QUERY = "(min-width: 1024px)";

export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(QUERY);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(QUERY).matches,
  );
}
