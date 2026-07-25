/** Pure divider geometry — no DOM, no host access, fully unit-testable. */

import { SPLIT_MAX, SPLIT_MIN } from './settings'

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
