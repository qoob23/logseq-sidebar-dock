import { describe, expect, it } from 'vitest'

import { computeSplitPct } from '../divider'
import { SPLIT_MAX, SPLIT_MIN } from '../settings'

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
