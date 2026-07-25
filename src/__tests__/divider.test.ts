import { describe, expect, it } from 'vitest'

import { VIEWPORT_RESERVE_PX, computeSidebarWidth, computeSplitPct } from '../divider'
import { SPLIT_MAX, SPLIT_MIN, WIDTH_MAX, WIDTH_MIN } from '../settings'

/** Kept free for the rest of the window. */
const RESERVE = VIEWPORT_RESERVE_PX
/** Wide enough that the viewport cap never binds. */
const WIDE = 4000

const MID = (SPLIT_MIN + SPLIT_MAX) / 2

describe('computeSplitPct', () => {
  it('maps the pointer to the share of the dock above it', () => {
    expect(computeSplitPct(150, 100, 200)).toBe(25)
    expect(computeSplitPct(200, 100, 200)).toBe(50)
    expect(computeSplitPct(250, 100, 200)).toBe(75)
  })

  it('clamps to the default range', () => {
    expect(computeSplitPct(100, 100, 200)).toBe(SPLIT_MIN)
    expect(computeSplitPct(-500, 100, 200)).toBe(SPLIT_MIN)
    expect(computeSplitPct(300, 100, 200)).toBe(SPLIT_MAX)
    expect(computeSplitPct(9999, 100, 200)).toBe(SPLIT_MAX)
  })

  it('honours a custom clamp range', () => {
    expect(computeSplitPct(105, 100, 200, 30, 70)).toBe(30)
    expect(computeSplitPct(295, 100, 200, 30, 70)).toBe(70)
    expect(computeSplitPct(220, 100, 200, 30, 70)).toBe(60)
  })

  it('rounds to two decimals', () => {
    expect(computeSplitPct(101, 100, 300)).toBe(SPLIT_MIN)
    expect(computeSplitPct(200, 100, 300)).toBe(33.33)
  })

  it('returns the midpoint for a degenerate dock height', () => {
    expect(computeSplitPct(150, 100, 0)).toBe(MID)
    expect(computeSplitPct(150, 100, -10)).toBe(MID)
    expect(computeSplitPct(150, 100, 0, 30, 70)).toBe(50)
  })

  it('returns the midpoint for non-finite input', () => {
    expect(computeSplitPct(Number.NaN, 100, 200)).toBe(MID)
    expect(computeSplitPct(150, Number.NaN, 200)).toBe(MID)
    expect(computeSplitPct(150, 100, Number.POSITIVE_INFINITY)).toBe(MID)
  })
})

describe('computeSidebarWidth', () => {
  it('measures from the sidebar’s left edge to the pointer', () => {
    expect(computeSidebarWidth(500, 0, WIDE)).toBe(500)
    expect(computeSidebarWidth(700, 60, WIDE)).toBe(640)
  })

  it('clamps to the default range — far past the host’s own 240–460 limit', () => {
    expect(computeSidebarWidth(10, 0, WIDE)).toBe(WIDTH_MIN)
    expect(computeSidebarWidth(-500, 0, WIDE)).toBe(WIDTH_MIN)
    expect(computeSidebarWidth(999_999, 0, WIDE)).toBe(WIDTH_MAX)
    // Well beyond what the host would ever allow itself.
    expect(computeSidebarWidth(900, 0, WIDE)).toBe(900)
  })

  it('honours a custom clamp range', () => {
    expect(computeSidebarWidth(100, 0, WIDE, 300, 700)).toBe(300)
    expect(computeSidebarWidth(1200, 0, WIDE, 300, 700)).toBe(700)
    expect(computeSidebarWidth(500, 0, WIDE, 300, 700)).toBe(500)
  })

  it('never lets the sidebar swallow the window', () => {
    expect(computeSidebarWidth(1500, 0, 1000)).toBe(1000 - RESERVE)
    // The reserve only bites when it is tighter than the configured maximum.
    expect(computeSidebarWidth(999_999, 0, 999_999)).toBe(WIDTH_MAX)
  })

  it('ignores an unmeasurable viewport instead of collapsing to the minimum', () => {
    expect(computeSidebarWidth(900, 0, Number.NaN)).toBe(900)
    expect(computeSidebarWidth(900, 0, 0)).toBe(900)
    expect(computeSidebarWidth(900, 0, -1)).toBe(900)
  })

  it('falls back to the minimum in a window too small to honour the reserve', () => {
    expect(computeSidebarWidth(300, 0, WIDTH_MIN + RESERVE - 1)).toBe(WIDTH_MIN)
    expect(computeSidebarWidth(300, 0, 100)).toBe(WIDTH_MIN)
  })

  it('rounds to two decimals', () => {
    expect(computeSidebarWidth(500.567, 0.1, WIDE)).toBe(500.47)
  })

  it('returns the minimum for non-finite input', () => {
    expect(computeSidebarWidth(Number.NaN, 0, WIDE)).toBe(WIDTH_MIN)
    expect(computeSidebarWidth(500, Number.POSITIVE_INFINITY, WIDE)).toBe(WIDTH_MIN)
  })
})
