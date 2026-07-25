import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  DOCK_MAX,
  DOCK_MIN,
  NO_VIEW,
  SPLIT_MAX,
  SPLIT_MIN,
  SettingsStore,
  normalizeSettings,
  settingsDiffer,
} from '../settings'

describe('normalizeSettings', () => {
  it('returns the defaults for missing input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it('returns the defaults for garbage input', () => {
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS)
  })

  it('ignores fields of the wrong type and empty strings', () => {
    const out = normalizeSettings({
      viewTop: 17,
      viewBottom: '   ',
      splitPct: 'not a number',
      dockPct: Number.NaN,
    })
    expect(out).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps valid values and trims plugin ids', () => {
    expect(
      normalizeSettings({
        viewTop: '  logseq-plugin-a  ',
        viewBottom: 'logseq-plugin-b',
        splitPct: 33,
        dockPct: 55,
      }),
    ).toEqual({
      viewTop: 'logseq-plugin-a',
      viewBottom: 'logseq-plugin-b',
      splitPct: 33,
      dockPct: 55,
    })
  })

  it('accepts numeric strings', () => {
    const out = normalizeSettings({ splitPct: '61.5', dockPct: '25' })
    expect(out.splitPct).toBe(61.5)
    expect(out.dockPct).toBe(25)
  })

  it('clamps splitPct to its range', () => {
    expect(normalizeSettings({ splitPct: -100 }).splitPct).toBe(SPLIT_MIN)
    expect(normalizeSettings({ splitPct: 1000 }).splitPct).toBe(SPLIT_MAX)
  })

  it('clamps dockPct to its range', () => {
    expect(normalizeSettings({ dockPct: 0 }).dockPct).toBe(DOCK_MIN)
    expect(normalizeSettings({ dockPct: 99 }).dockPct).toBe(DOCK_MAX)
  })

  it('ignores unrelated keys such as the host-managed `disabled` flag', () => {
    expect(normalizeSettings({ disabled: false })).toEqual(DEFAULT_SETTINGS)
  })
})

describe('settingsDiffer', () => {
  it('detects a change in any field', () => {
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toBe(false)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, viewTop: 'x' })).toBe(true)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, splitPct: 60 })).toBe(true)
  })
})

describe('SettingsStore', () => {
  it('starts from the normalized host settings', () => {
    const store = new SettingsStore({ viewTop: 'plugin-a', splitPct: 200 })
    expect(store.current()).toEqual({
      ...DEFAULT_SETTINGS,
      viewTop: 'plugin-a',
      splitPct: SPLIT_MAX,
    })
  })

  it('starts from the defaults when the host has no settings yet', () => {
    expect(new SettingsStore().current()).toEqual(DEFAULT_SETTINGS)
  })

  it('lets an override win over the base until the echo agrees', () => {
    const store = new SettingsStore({ splitPct: 50 })
    store.override({ splitPct: 70 })
    expect(store.current().splitPct).toBe(70)

    // A stale echo (the host has not applied our write yet) must not undo the override.
    store.applyEcho({ splitPct: 50 })
    expect(store.current().splitPct).toBe(70)

    // Once the echo agrees the override is dropped...
    store.applyEcho({ splitPct: 70 })
    expect(store.current().splitPct).toBe(70)

    // ...so a later host-side change now takes effect.
    store.applyEcho({ splitPct: 40 })
    expect(store.current().splitPct).toBe(40)
  })

  it('clamps overridden numbers', () => {
    const store = new SettingsStore()
    store.override({ splitPct: 999, dockPct: -5 })
    expect(store.current().splitPct).toBe(SPLIT_MAX)
    expect(store.current().dockPct).toBe(DOCK_MIN)
  })

  it('ignores undefined and non-finite fields in a patch', () => {
    const store = new SettingsStore({ splitPct: 42 })
    store.override({ splitPct: undefined, dockPct: Number.NaN })
    expect(store.current()).toEqual({ ...DEFAULT_SETTINGS, splitPct: 42 })
  })

  it('trims overridden plugin ids and ignores blank ones, like the echo path', () => {
    const store = new SettingsStore({ viewTop: 'plugin-a' })
    store.override({ viewTop: '  plugin-b  ', viewBottom: '   ' })
    expect(store.current().viewTop).toBe('plugin-b')
    expect(store.current().viewBottom).toBe(NO_VIEW)
  })

  it('merges successive overrides across fields', () => {
    const store = new SettingsStore()
    store.override({ viewTop: 'plugin-a' })
    store.override({ viewBottom: 'plugin-b' })
    expect(store.current()).toEqual({
      ...DEFAULT_SETTINGS,
      viewTop: 'plugin-a',
      viewBottom: 'plugin-b',
    })
  })

  it('applies unrelated echoed fields while an override is pending', () => {
    const store = new SettingsStore()
    store.override({ splitPct: 70 })
    store.applyEcho({ viewTop: 'plugin-a', splitPct: 50 })
    expect(store.current()).toEqual({
      ...DEFAULT_SETTINGS,
      viewTop: 'plugin-a',
      splitPct: 70,
    })
  })

  it('falls back to the defaults when the echo is garbage', () => {
    const store = new SettingsStore({ viewTop: 'plugin-a' })
    store.applyEcho('boom')
    expect(store.current()).toEqual(DEFAULT_SETTINGS)
    expect(store.current().viewTop).toBe(NO_VIEW)
  })
})
