import { useRef, useState } from "react";
import type { CSSProperties, TouchEvent } from "react";

const EDGE_PX = 28; // gesture must start this close to the left edge
const COMMIT_PX = 80; // drag distance that commits the back navigation
const LOCK_PX = 12; // movement needed before deciding horizontal vs vertical

/**
 * iOS-style edge-swipe back: drag from the left edge to return to the parent
 * screen. Starting at the edge (not anywhere) avoids fighting horizontally
 * scrollable content; a vertical-first move cancels the gesture so normal
 * scrolling wins. Returns touch handlers plus a style that translates the
 * panel while dragging for visual feedback.
 */
export function useEdgeSwipeBack(enabled: boolean, onBack: () => void) {
  const [dragX, setDragX] = useState(0);
  const gesture = useRef<{ x: number; y: number; state: "idle" | "pending" | "dragging" | "cancelled" }>({
    x: 0,
    y: 0,
    state: "idle",
  });

  const onTouchStart = (e: TouchEvent) => {
    if (!enabled || e.touches.length !== 1) return;
    const t = e.touches[0];
    gesture.current = { x: t.clientX, y: t.clientY, state: t.clientX <= EDGE_PX ? "pending" : "idle" };
  };

  const onTouchMove = (e: TouchEvent) => {
    const g = gesture.current;
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
    setDragX(Math.max(0, dx));
  };

  const endGesture = () => {
    if (gesture.current.state === "dragging" && dragX >= COMMIT_PX) onBack();
    gesture.current.state = "idle";
    setDragX(0);
  };

  const style: CSSProperties =
    dragX > 0
      ? { transform: `translateX(${dragX}px)`, transition: "none", boxShadow: "-8px 0 24px rgba(0,0,0,0.35)" }
      : { transform: "translateX(0)", transition: "transform 150ms ease-out" };

  return {
    handlers: { onTouchStart, onTouchMove, onTouchEnd: endGesture, onTouchCancel: endGesture },
    style,
  };
}
