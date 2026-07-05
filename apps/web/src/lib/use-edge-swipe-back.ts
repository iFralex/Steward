import { useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";

const EDGE_PX = 28; // gesture must start this close to the left edge
const COMMIT_PX = 80; // drag distance that commits the back navigation
const LOCK_PX = 12; // movement needed before deciding horizontal vs vertical

/**
 * iOS-style edge-swipe back: drag from the left edge to return to the parent
 * screen. Starting at the edge (not anywhere) avoids fighting horizontally
 * scrollable content; a vertical-first move cancels the gesture so normal
 * scrolling wins. Attach `ref` to the panel to drag; `style` translates it
 * while dragging.
 *
 * Uses native non-passive listeners (React's synthetic touch events are
 * passive) so an active drag can preventDefault — otherwise iOS pans and
 * rubber-bands the whole viewport, visibly dragging the layer underneath too.
 *
 * The caller owns the ref (create it with useRef and put it on the panel
 * element); the hook only returns the drag style.
 */
export function useEdgeSwipeBack(
  targetRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onBack: () => void,
): CSSProperties {
  const [dragX, setDragX] = useState(0);
  const latest = useRef({ enabled, onBack, dragX: 0 });

  useEffect(() => {
    latest.current.enabled = enabled;
    latest.current.onBack = onBack;
  }, [enabled, onBack]);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    const g = { x: 0, y: 0, state: "idle" as "idle" | "pending" | "dragging" | "cancelled" };
    const setDrag = (px: number) => {
      latest.current.dragX = px;
      setDragX(px);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (!latest.current.enabled || e.touches.length !== 1) return;
      const t = e.touches[0];
      g.x = t.clientX;
      g.y = t.clientY;
      g.state = t.clientX <= EDGE_PX ? "pending" : "idle";
    };

    const onTouchMove = (e: TouchEvent) => {
      if (g.state === "idle" || g.state === "cancelled") return;
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      const dy = Math.abs(t.clientY - g.y);
      if (g.state === "pending") {
        if (dy > LOCK_PX && dy >= dx) {
          g.state = "cancelled";
          return;
        }
        if (dx > LOCK_PX && dx > dy) g.state = "dragging";
        else return;
      }
      // The gesture owns this touch: stop the browser's own horizontal pan /
      // rubber-band, which would drag the underlying layer and bounce back.
      e.preventDefault();
      setDrag(Math.max(0, dx));
    };

    const onTouchEnd = () => {
      if (g.state === "dragging" && latest.current.dragX >= COMMIT_PX) latest.current.onBack();
      g.state = "idle";
      setDrag(0);
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [targetRef]);

  return dragX > 0
    ? { transform: `translateX(${dragX}px)`, transition: "none", boxShadow: "-8px 0 24px rgba(0,0,0,0.35)" }
    : { transform: "translateX(0)", transition: "transform 150ms ease-out" };
}
