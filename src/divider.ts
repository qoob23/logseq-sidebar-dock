/** Pure divider geometry — no DOM, no host access, fully unit-testable. */

import { SPLIT_MAX, SPLIT_MIN, WIDTH_MAX, WIDTH_MIN } from './settings'

/**
 * Room the sidebar may never take from the window. Our width bounds are wide enough to cover the
 * whole viewport on a small screen, and a sidebar that has swallowed the editor leaves the user
 * nothing to grab but the resizer itself.
 *
 * Exported because the stylesheet enforces the same reserve at render time (`styles.ts`): the
 * drag-time clamp here cannot protect a width persisted on a wide window from a narrower one later.
 */
export const VIEWPORT_RESERVE_PX = 200

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Share (%) of the dock height that sits above `pointerY`, clamped to `[min, max]`.
 *
 * Degenerate input (non-finite numbers, zero/negative height) yields the midpoint of the clamp range
 * so a drag against a collapsed dock cannot persist a nonsense ratio.
 */
export function computeSplitPct(
  pointerY: number,
  dockTop: number,
  dockHeight: number,
  min: number = SPLIT_MIN,
  max: number = SPLIT_MAX,
): number {
  const mid = (min + max) / 2
  if (!Number.isFinite(pointerY) || !Number.isFinite(dockTop) || !Number.isFinite(dockHeight)) return mid
  if (dockHeight <= 0) return mid
  const pct = ((pointerY - dockTop) / dockHeight) * 100
  return Math.round(clamp(pct, min, max) * 100) / 100
}

/**
 * Sidebar width (px) for a pointer at `pointerX`, clamped to `[min, max]` and to what the viewport
 * can spare ({@link VIEWPORT_RESERVE_PX}).
 *
 * Degenerate input (non-finite numbers) yields `min` so a drag against geometry we cannot measure
 * never persists a nonsense width. A viewport too small to honour the reserve falls back to `min`
 * as well — the clamp range would otherwise be inverted.
 */
export function computeSidebarWidth(
  pointerX: number,
  sidebarLeft: number,
  viewportWidth: number,
  min: number = WIDTH_MIN,
  max: number = WIDTH_MAX,
): number {
  if (!Number.isFinite(pointerX) || !Number.isFinite(sidebarLeft)) return min
  const capped =
    Number.isFinite(viewportWidth) && viewportWidth > 0
      ? Math.min(max, viewportWidth - VIEWPORT_RESERVE_PX)
      : max
  if (capped < min) return min
  return Math.round(clamp(pointerX - sidebarLeft, min, capped) * 100) / 100
}
