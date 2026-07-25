import { describe, expect, it } from 'vitest'

import { SLOT_MIN_PX, VIEWPORT_RESERVE_PX, computeSidebarWidth, resizeWeights } from '../divider'
import { WIDTH_MAX, WIDTH_MIN } from '../settings'

const sum = (weights: readonly number[]): number => weights.reduce((total, weight) => total + weight, 0)

describe('resizeWeights — the normal drag', () => {
  it('moves weight across the dragged divider only', () => {
    // perPx = 3/400, so +100px is 0.75 of weight taken from the slot below.
    expect(resizeWeights([1, 1, 1], 0, 100, 400, 10)).toEqual([1.75, 0.25, 1])
    expect(resizeWeights([1, 1, 1], 1, 100, 400, 10)).toEqual([1, 1.75, 0.25])
  })

  it('is symmetric: a negative delta hands the weight back the other way', () => {
    expect(resizeWeights([1, 1, 1], 0, -100, 400, 10)).toEqual([0.25, 1.75, 1])
  })

  it('preserves the total, so no other slot has to be renormalized', () => {
    const start = [1, 2, 0.5, 4]
    for (const [index, delta] of [
      [0, 37],
      [1, -80],
      [2, 5],
      [0, -1],
    ] as const) {
      const out = resizeWeights(start, index, delta, 600, 10)
      expect(sum(out)).toBeCloseTo(sum(start), 10)
    }
  })

  it('leaves every non-adjacent weight byte-identical', () => {
    const start = [1, 2, 3, 4, 5]
    const out = resizeWeights(start, 2, 120, 500, 10)
    expect(out[0]).toBe(start[0])
    expect(out[1]).toBe(start[1])
    expect(out[4]).toBe(start[4])
    expect(out[2]).not.toBe(start[2])
    expect(out[3]).not.toBe(start[3])
  })

  it('scales by the layout total, not by a fixed 0..1 range', () => {
    // Same pixel drag, ten times the total weight: ten times the weight moved.
    expect(resizeWeights([10, 10], 0, 50, 100, 0)).toEqual([20, 0])
    expect(resizeWeights([1, 1], 0, 50, 100, 0)).toEqual([2, 0])
  })

  it('rounds the moving edge to four decimals and derives its partner by subtraction', () => {
    // Rounding both edges independently would shift the pair sum by up to 1e-4 per drag, which
    // accumulates into visible drift over a session.
    const out = resizeWeights([1, 1], 0, 1, 3, 0)
    expect(out).toEqual([1.6667, 0.3333])
    expect(sum(out)).toBe(2)
  })

  it('always hands back a fresh array', () => {
    const start = [1, 1]
    const out = resizeWeights(start, 0, 10, 100, 0)
    expect(out).not.toBe(start)
    out[0] = 99
    expect(start[0]).toBe(1)
  })
})

describe('resizeWeights — floors', () => {
  it('saturates at the floor instead of overshooting, in both directions', () => {
    // floor = 48 * 3/400 = 0.36, pair sum 2.
    expect(resizeWeights([1, 1, 1], 0, 9999, 400, 48)).toEqual([1.64, 0.36, 1])
    expect(resizeWeights([1, 1, 1], 0, -9999, 400, 48)).toEqual([0.36, 1.64, 1])
  })

  it('never produces a negative weight, whatever the drag', () => {
    for (const delta of [-1e9, -500, 500, 1e9]) {
      for (const out of [resizeWeights([1, 1, 1], 0, delta, 400, 48), resizeWeights([1, 1, 1], 1, delta, 400, 0)]) {
        expect(out.every((weight) => weight >= 0)).toBe(true)
        expect(sum(out)).toBeCloseTo(3, 10)
      }
    }
  })

  it('releases immediately when the pointer comes back, because the delta is absolute', () => {
    // Each pointermove re-applies the drag-START weights, so a saturated gesture carries no offset to
    // unwind — feeding the previous result back in is what would make the pair creep.
    const start = [1, 1, 1]
    expect(resizeWeights(start, 0, 9999, 400, 48)).toEqual([1.64, 0.36, 1])
    expect(resizeWeights(start, 0, 40, 400, 48)).toEqual([1.3, 0.7, 1])
  })

  it('lets a slot reach exactly zero when the caller asks for no floor', () => {
    expect(resizeWeights([1, 1], 0, 9999, 100, 0)).toEqual([2, 0])
  })

  it('treats a negative floor as no floor rather than widening the range past zero', () => {
    expect(resizeWeights([1, 1], 0, -9999, 100, -100)).toEqual([0, 2])
  })

  it('leaves an over-subscribed pair alone: no split of it could honour both floors', () => {
    // The CSS floors decide what is on screen; persisting a weight the layout engine then ignores
    // would make the config drift away from what the user sees.
    expect(resizeWeights([0.1, 0.1, 10], 0, 20, 300, 48)).toEqual([0.1, 0.1, 10])
    expect(resizeWeights([0.1, 0.1, 10], 0, -20, 300, 48)).toEqual([0.1, 0.1, 10])
  })

  it('defaults the floor to the shared per-slot minimum', () => {
    expect(resizeWeights([1, 1, 1], 0, 9999, 400)).toEqual(resizeWeights([1, 1, 1], 0, 9999, 400, SLOT_MIN_PX))
    expect(SLOT_MIN_PX).toBeGreaterThan(0)
  })
})

describe('resizeWeights — degenerate input', () => {
  const START = [1, 2, 3]

  const unchanged = (out: number[]): void => {
    expect(out).toEqual(START)
    expect(out).not.toBe(START)
  }

  it('ignores a divider index that names no pair', () => {
    for (const index of [-1, 2, 3, 99, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      unchanged(resizeWeights(START, index, 50, 300, 10))
    }
  })

  it('is a no-op for arrays too short to have a divider', () => {
    expect(resizeWeights([], 0, 50, 300, 10)).toEqual([])
    expect(resizeWeights([1], 0, 50, 300, 10)).toEqual([1])
  })

  it('ignores a non-finite delta, container or floor', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      unchanged(resizeWeights(START, 0, bad, 300, 10))
      unchanged(resizeWeights(START, 0, 50, bad, 10))
      unchanged(resizeWeights(START, 0, 50, 300, bad))
    }
  })

  it('ignores a drag against a collapsed dock', () => {
    unchanged(resizeWeights(START, 0, 50, 0, 10))
    unchanged(resizeWeights(START, 0, 50, -300, 10))
  })

  it('ignores a weight array carrying a non-finite entry', () => {
    // One poisoned weight would otherwise spread through `total` into every result.
    expect(resizeWeights([1, Number.NaN, 3], 0, 50, 300, 10)).toEqual([1, Number.NaN, 3])
    expect(resizeWeights([1, 2, Number.POSITIVE_INFINITY], 0, 50, 300, 10)).toEqual([1, 2, Number.POSITIVE_INFINITY])
  })

  it('ignores a layout whose weights carry no total to share out', () => {
    expect(resizeWeights([0, 0], 0, 50, 300, 0)).toEqual([0, 0])
    expect(resizeWeights([-1, 1], 0, 50, 300, 0)).toEqual([-1, 1])
  })

  it('is a no-op for a zero delta, down to the exact numbers it was given', () => {
    expect(resizeWeights([1.2345, 2.5], 0, 0, 300, 10)).toEqual([1.2345, 2.5])
  })
})

describe('computeSidebarWidth', () => {
  /** Wide enough that the viewport cap never binds. */
  const WIDE = 4000

  it('measures from the sidebar’s own left edge to the pointer', () => {
    expect(computeSidebarWidth(500, 0, WIDE)).toBe(500)
    expect(computeSidebarWidth(700, 60, WIDE)).toBe(640)
  })

  it('clamps to the default range — far past the host’s own 240–460 limit', () => {
    // Getting past that clamp is the entire reason the host's resizer is hijacked.
    expect(computeSidebarWidth(900, 0, WIDE)).toBe(900)
    expect(computeSidebarWidth(10, 0, WIDE)).toBe(WIDTH_MIN)
    expect(computeSidebarWidth(-500, 0, WIDE)).toBe(WIDTH_MIN)
    expect(computeSidebarWidth(999_999, 0, WIDE)).toBe(WIDTH_MAX)
  })

  it('honours a custom clamp range', () => {
    expect(computeSidebarWidth(100, 0, WIDE, 300, 700)).toBe(300)
    expect(computeSidebarWidth(1200, 0, WIDE, 300, 700)).toBe(700)
    expect(computeSidebarWidth(500, 0, WIDE, 300, 700)).toBe(500)
  })

  it('never lets the sidebar swallow the window', () => {
    expect(computeSidebarWidth(1500, 0, 1000)).toBe(1000 - VIEWPORT_RESERVE_PX)
    // The reserve only bites when it is tighter than the configured maximum.
    expect(computeSidebarWidth(999_999, 0, 999_999)).toBe(WIDTH_MAX)
  })

  it('ignores an unmeasurable viewport instead of collapsing to the minimum', () => {
    // "We learned nothing" is not "the window is tiny": a zero clientWidth must not shrink the drag.
    for (const viewport of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(computeSidebarWidth(900, 0, viewport)).toBe(900)
    }
  })

  it('falls back to the minimum in a window too small to honour the reserve', () => {
    // The clamp range would be inverted (max < min), and `clamp` would hand back the wrong end of it.
    expect(computeSidebarWidth(300, 0, WIDTH_MIN + VIEWPORT_RESERVE_PX - 1)).toBe(WIDTH_MIN)
    expect(computeSidebarWidth(300, 0, 100)).toBe(WIDTH_MIN)
    expect(computeSidebarWidth(9999, 0, 100)).toBe(WIDTH_MIN)
  })

  it('rounds to two decimals, the grid the settings normalizer rounds to', () => {
    // An override that does not equal the value the host echoes back would never be retired.
    expect(computeSidebarWidth(500.567, 0.1, WIDE)).toBe(500.47)
  })

  it('returns the minimum for non-finite geometry rather than a nonsense width', () => {
    expect(computeSidebarWidth(Number.NaN, 0, WIDE)).toBe(WIDTH_MIN)
    expect(computeSidebarWidth(500, Number.POSITIVE_INFINITY, WIDE)).toBe(WIDTH_MIN)
    expect(computeSidebarWidth(Number.NEGATIVE_INFINITY, Number.NaN, WIDE, 300, 700)).toBe(300)
  })

  it('does not interact with the weight geometry — it sizes the column they live in', () => {
    expect(WIDTH_MIN).toBeGreaterThan(SLOT_MIN_PX)
    expect(VIEWPORT_RESERVE_PX).toBeGreaterThan(0)
  })
})
