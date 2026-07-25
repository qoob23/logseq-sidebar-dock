/**
 * Pure drag geometry — no DOM, no host access, fully unit-testable.
 *
 * Two independent drags live here and never interact: {@link resizeWeights} moves weight between two
 * neighbouring slots INSIDE a layout, and {@link computeSidebarWidth} sizes the whole sidebar column
 * the layouts sit in. The second one is global — the dock's width IS the sidebar's width, so it belongs
 * to no layout and switching tabs never touches it.
 */

import { WIDTH_MAX, WIDTH_MIN } from './settings'

/**
 * Room the sidebar may never take from the window. {@link WIDTH_MAX} is wide enough to cover a small
 * screen entirely, and a sidebar that has swallowed the editor leaves the user nothing to grab but the
 * resizer it just pushed off the far edge.
 *
 * Exported because the stylesheet enforces the same reserve at render time (`styles.ts`): the drag-time
 * clamp here cannot protect a width persisted on a wide monitor from a narrower window opened later.
 */
export const VIEWPORT_RESERVE_PX = 200

/**
 * Per-slot floor in CSS px — defined HERE and imported by `styles.ts`, because both sides must agree
 * on the exact number and two constants of the same name would drift silently.
 *
 * The sheet emits it as `min-height` (column axis) / `min-width` (row axis) so the browser refuses to
 * squash a slot below it, and the drag converts it into a weight floor so a drag cannot *persist* a
 * weight the layout engine would then ignore. Disagree and the config drifts away from what is on
 * screen: a slot pinned at its CSS floor while its stored weight says 0.01 would give the whole rest
 * of the drag range back to its neighbour on the next repaint.
 *
 * The size is set by what a squeezed slot still has to afford: a hit area for the divider to be
 * dragged back off it, and room for its own control row in edit mode.
 */
export const SLOT_MIN_PX = 40

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Weights are stored 4-decimal-rounded (`normalizeConfig`), so all arithmetic lands back on that grid. */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4
}

/**
 * Move weight across divider `index` (between slots `index` and `index + 1`) by a pointer delta.
 *
 * Weights, not percentages: `flex-grow` shares are relative to the layout's total, so dragging one
 * divider must be a *local* transaction — the pair's sum is preserved and every other slot keeps the
 * exact number it had. That is what makes adding, removing or reordering a slot free of renormalization
 * (spec "Geometry"): nothing in the config encodes a global budget that would have to be rebalanced.
 *
 * `deltaPx` is measured from the drag START, so the caller must pass the drag-start weights on every
 * pointermove — feeding back the previous result would integrate the rounding error and let the pair
 * creep. The px→weight scale is `total / containerPx`, i.e. we assume the layout root's extent is
 * shared out by `flex-grow` with `flex-basis: 0`; the few px the dividers themselves occupy are not
 * discounted, which makes the drag lag the pointer by well under a percent and is not worth the
 * measurement plumbing.
 *
 * Clamping is done on the pair, never on the array: the moving edge saturates at either slot's floor
 * (`minPx` converted through the same scale) instead of overshooting into negative weight or clawing
 * space out of non-adjacent slots. Dragging far past a floor therefore parks the divider *at* the
 * floor and stays there for the rest of the gesture — and because `deltaPx` is absolute, dragging back
 * releases it immediately, with no accumulated offset to unwind.
 *
 * Returns a fresh mutable array (never the input reference). Degenerate input — a non-finite number
 * anywhere, an out-of-range divider index, `containerPx <= 0`, total weight `<= 0`, or a pair too small
 * to hold both floors at once — yields a copy of the input untouched: a drag against a collapsed or
 * over-subscribed dock must not persist nonsense.
 */
export function resizeWeights(
  weights: readonly number[],
  index: number,
  deltaPx: number,
  containerPx: number,
  minPx: number = SLOT_MIN_PX,
): number[] {
  const out = [...weights]

  if (!Number.isInteger(index) || index < 0 || index + 1 >= out.length) return out
  if (!Number.isFinite(deltaPx) || !Number.isFinite(containerPx) || !Number.isFinite(minPx)) return out
  if (containerPx <= 0) return out
  if (!out.every((w) => Number.isFinite(w))) return out

  const total = out.reduce((sum, w) => sum + w, 0)
  if (total <= 0) return out

  // One scale for both directions: weight units per px, from the layout's own total.
  const perPx = total / containerPx
  const pairSum = out[index] + out[index + 1]
  // A negative floor would widen the clamp range past zero and let a slot reach negative weight.
  const floor = Math.max(0, minPx) * perPx

  // Not enough room for both neighbours to clear the floor: any split we could pick would violate it,
  // so leave the config alone and let the CSS floors decide what the user sees.
  if (pairSum < floor * 2) return out

  const first = clamp(out[index] + deltaPx * perPx, floor, pairSum - floor)

  // Round the moving edge, then derive its partner by subtraction: rounding both independently could
  // shift the pair sum by up to 1e-4 per drag, which accumulates into a visible drift over a session.
  out[index] = round4(first)
  out[index + 1] = round4(pairSum - out[index])

  return out
}

/**
 * Sidebar width (px) for a pointer at `pointerX`, clamped to `[min, max]` and to what the viewport can
 * spare ({@link VIEWPORT_RESERVE_PX}).
 *
 * Measured from the sidebar's own left edge rather than from the window's, so a host that ever inset
 * the column (or a right-to-left layout) does not shift the whole range. `[min, max]` defaults to the
 * setting's bounds, which sit far outside the host's own 240-460px clamp — the entire point of hijacking
 * its resizer is that our geometry is not clamped the way its is.
 *
 * Degenerate input (a non-finite pointer or edge) yields `min`: a drag against geometry we cannot
 * measure must never persist a nonsense width, and `min` is the one value that is certainly usable. An
 * UNMEASURABLE viewport is different from a small one — a zero or non-finite `viewportWidth` means we
 * learned nothing, so the reserve simply does not apply. A viewport genuinely too small to honour the
 * reserve also falls back to `min`, because the clamp range would otherwise be inverted (`max < min`)
 * and `clamp` would hand back the smaller of two wrong answers.
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
  // Two decimals, matching `normalizeWidth`: an override that survived a drag must equal the value the
  // host echoes back, or the override layer never retires.
  return Math.round(clamp(pointerX - sidebarLeft, min, capped) * 100) / 100
}
