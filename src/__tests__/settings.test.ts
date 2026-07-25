import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  NO_VIEW,
  SPLIT_MAX,
  SPLIT_MIN,
  type SlotSpecs,
  SettingsStore,
  type ViewSpec,
  configSignature,
  normalizeSettings,
  parseAdoptPokes,
  resolveSlotSpecs,
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
      mode: 17,
      viewTop: 17,
      viewBottom: '   ',
      splitPct: 'not a number',
    })
    expect(out).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps valid values and trims plugin ids', () => {
    expect(
      normalizeSettings({
        mode: 'views',
        viewTop: '  logseq-plugin-a  ',
        viewBottom: 'logseq-plugin-b',
        splitPct: 33,
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      mode: 'views',
      viewTop: 'logseq-plugin-a',
      viewBottom: 'logseq-plugin-b',
      splitPct: 33,
    })
  })

  it('falls back to nav for an unknown mode', () => {
    expect(normalizeSettings({ mode: 'nonsense' }).mode).toBe('nav')
    expect(normalizeSettings({ mode: '' }).mode).toBe('nav')
    expect(normalizeSettings({ mode: null }).mode).toBe('nav')
    expect(normalizeSettings({ mode: ' views ' }).mode).toBe('views')
  })

  it('accepts numeric strings', () => {
    expect(normalizeSettings({ splitPct: '61.5' }).splitPct).toBe(61.5)
  })

  it('clamps splitPct to its range', () => {
    expect(normalizeSettings({ splitPct: -100 }).splitPct).toBe(SPLIT_MIN)
    expect(normalizeSettings({ splitPct: 1000 }).splitPct).toBe(SPLIT_MAX)
  })

  it('ignores unrelated keys such as the host-managed `disabled` flag', () => {
    expect(normalizeSettings({ disabled: false })).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps the free-text fields, trimmed, and blanks them out when unset', () => {
    expect(
      normalizeSettings({
        macroTop: '  {{renderer :pomodoro}}  ',
        macroBottom: '   ',
        adoptPoke: 'plugin-a = models.toggle',
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      macroTop: '{{renderer :pomodoro}}',
      macroBottom: '',
      adoptPoke: 'plugin-a = models.toggle',
    })
  })
})

describe('settingsDiffer', () => {
  it('detects a change in any field', () => {
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toBe(false)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, mode: 'views' })).toBe(true)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, viewTop: 'x' })).toBe(true)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, splitPct: 60 })).toBe(true)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, macroTop: '{{renderer :a}}' })).toBe(true)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, macroBottom: ':a' })).toBe(true)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, adoptPoke: 'a = models.b' })).toBe(true)
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
    store.override({ splitPct: 999 })
    expect(store.current().splitPct).toBe(SPLIT_MAX)
  })

  it('ignores undefined and non-finite fields in a patch', () => {
    const store = new SettingsStore({ splitPct: 42 })
    store.override({ splitPct: Number.NaN })
    store.override({ splitPct: undefined })
    expect(store.current()).toEqual({ ...DEFAULT_SETTINGS, splitPct: 42 })
  })

  it('flips the mode instantly and keeps it until the echo catches up', () => {
    const store = new SettingsStore({ mode: 'nav' })
    store.override({ mode: 'views' })
    expect(store.current().mode).toBe('views')

    // The host is still echoing the pre-write value.
    store.applyEcho({ mode: 'nav' })
    expect(store.current().mode).toBe('views')

    store.applyEcho({ mode: 'views' })
    expect(store.current().mode).toBe('views')

    // Override dropped, so the settings UI can switch it back.
    store.applyEcho({ mode: 'nav' })
    expect(store.current().mode).toBe('nav')
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

  it('lets the user CLEAR a free-text field, unlike a plugin selection', () => {
    // A blank plugin id means "no change" (there is a `none` choice for deselecting), but a blank
    // macro or poke list is the only way to switch the feature off, so it must survive as ''.
    const store = new SettingsStore({ macroTop: '{{renderer :a}}', adoptPoke: 'a = models.b' })
    store.override({ macroTop: '  ', adoptPoke: '' })
    expect(store.current().macroTop).toBe('')
    expect(store.current().adoptPoke).toBe('')
  })

  it('trims an overridden macro spec so it matches the echoed one', () => {
    const store = new SettingsStore()
    store.override({ macroTop: '  {{renderer :a}}  ' })
    expect(store.current().macroTop).toBe('{{renderer :a}}')

    // ...which is what lets the echo drop the override instead of leaving it stuck.
    store.applyEcho({ macroTop: '{{renderer :a}}' })
    store.applyEcho({ macroTop: '{{renderer :b}}' })
    expect(store.current().macroTop).toBe('{{renderer :b}}')
  })
})

describe('resolveSlotSpecs', () => {
  const settings = (patch: Partial<typeof DEFAULT_SETTINGS>): typeof DEFAULT_SETTINGS => ({
    ...DEFAULT_SETTINGS,
    ...patch,
  })

  it('maps an unset slot to `none` and a selected plugin to `plugin`', () => {
    expect(resolveSlotSpecs(settings({ viewTop: 'plugin-a' }))).toEqual({
      top: { kind: 'plugin', pid: 'plugin-a' },
      bottom: { kind: 'none' },
    })
  })

  it('lets a macro override the slot’s plugin selection', () => {
    expect(resolveSlotSpecs(settings({ viewTop: 'plugin-a', macroTop: '{{renderer :pomo, 25}}' }))).toEqual({
      top: { kind: 'macro', raw: '{{renderer :pomo, 25}}', args: [':pomo', '25'] },
      bottom: { kind: 'none' },
    })
  })

  it('overrides each slot independently', () => {
    const specs = resolveSlotSpecs(settings({ viewTop: 'plugin-a', viewBottom: 'plugin-b', macroBottom: ':pomo' }))
    expect(specs.top).toEqual({ kind: 'plugin', pid: 'plugin-a' })
    expect(specs.bottom).toEqual({ kind: 'macro', raw: ':pomo', args: [':pomo'] })
  })

  it('reports an unparseable non-blank macro instead of falling back to the plugin', () => {
    // Silently docking the plugin would hide the typo the user has to fix.
    expect(resolveSlotSpecs(settings({ viewTop: 'plugin-a', macroTop: '{{renderer}}' })).top).toEqual({
      kind: 'invalid-macro',
      raw: '{{renderer}}',
    })
  })

  it('drops the bottom slot when the same plugin is picked twice — one view, one instance', () => {
    expect(resolveSlotSpecs(settings({ viewTop: 'dup', viewBottom: 'dup' }))).toEqual({
      top: { kind: 'plugin', pid: 'dup' },
      bottom: { kind: 'none' },
    })
  })

  it('lets the same macro fill both slots: each gets its own injected copy', () => {
    const specs = resolveSlotSpecs(settings({ macroTop: ':pomo', macroBottom: ':pomo' }))
    expect(specs.top).toEqual({ kind: 'macro', raw: ':pomo', args: [':pomo'] })
    expect(specs.bottom).toEqual({ kind: 'macro', raw: ':pomo', args: [':pomo'] })
  })

  it('does not dedup a plugin against a macro slot', () => {
    const specs = resolveSlotSpecs(settings({ viewTop: 'dup', viewBottom: 'dup', macroTop: ':pomo' }))
    expect(specs.top.kind).toBe('macro')
    expect(specs.bottom).toEqual({ kind: 'plugin', pid: 'dup' })
  })
})

describe('parseAdoptPokes', () => {
  it('parses both groups invokeExternalPlugin understands', () => {
    expect([...parseAdoptPokes('a = models.toggleMain; b = commands.open-view')]).toEqual([
      ['a', 'models.toggleMain'],
      ['b', 'commands.open-view'],
    ])
  })

  it('accepts newlines as well as semicolons, and tolerates loose whitespace', () => {
    expect([...parseAdoptPokes('  a=models.x  \n b = commands.y ;\n')]).toEqual([
      ['a', 'models.x'],
      ['b', 'commands.y'],
    ])
  })

  it('drops junk rather than guessing — a wrong invocation lands in someone else’s plugin', () => {
    expect(parseAdoptPokes('').size).toBe(0)
    expect(parseAdoptPokes('nonsense').size).toBe(0)
    expect(parseAdoptPokes('a = toggleMain').size).toBe(0)
    expect(parseAdoptPokes('a = settings.key').size).toBe(0)
    expect(parseAdoptPokes('a = models.').size).toBe(0)
    expect(parseAdoptPokes(' = models.x').size).toBe(0)
  })

  it('keeps the good entries of a partly broken list', () => {
    expect([...parseAdoptPokes('a = nope; b = models.x')]).toEqual([['b', 'models.x']])
  })

  it('lets a later entry win over an earlier one for the same plugin', () => {
    expect(parseAdoptPokes('a = models.x; a = commands.y').get('a')).toBe('commands.y')
  })
})

describe('configSignature', () => {
  const specs = (top: ViewSpec, bottom: ViewSpec): SlotSpecs => ({ top, bottom })
  const PLUGINS = specs({ kind: 'plugin', pid: 'a' }, { kind: 'none' })
  const sig = (adoptPoke: string, slots: SlotSpecs = PLUGINS): string => configSignature(adoptPoke, slots)

  it('is stable for an unchanged configuration', () => {
    expect(sig('a = models.x')).toBe(sig('a = models.x'))
  })

  it('changes when a slot changes what it renders', () => {
    expect(sig('', PLUGINS)).not.toBe(sig('', specs({ kind: 'plugin', pid: 'b' }, { kind: 'none' })))
    expect(sig('', PLUGINS)).not.toBe(sig('', specs({ kind: 'plugin', pid: 'a' }, { kind: 'plugin', pid: 'b' })))
  })

  it('changes when a macro spec is edited, so its "unanswered" verdict is retired', () => {
    const before = specs({ kind: 'macro', raw: ':pomo', args: [':pomo'] }, { kind: 'none' })
    const after = specs({ kind: 'macro', raw: ':pomo, 25', args: [':pomo', '25'] }, { kind: 'none' })
    expect(sig('', before)).not.toBe(sig('', after))
  })

  it('tells a macro apart from a plugin (and from an invalid spec) of the same name', () => {
    expect(sig('', specs({ kind: 'macro', raw: 'x', args: ['x'] }, { kind: 'none' }))).not.toBe(
      sig('', specs({ kind: 'plugin', pid: 'x' }, { kind: 'none' })),
    )
    expect(sig('', specs({ kind: 'macro', raw: 'x', args: ['x'] }, { kind: 'none' }))).not.toBe(
      sig('', specs({ kind: 'invalid-macro', raw: 'x' }, { kind: 'none' })),
    )
  })

  it('changes when a poke target is added, retargeted or removed', () => {
    expect(sig('')).not.toBe(sig('a = models.x'))
    expect(sig('a = models.x')).not.toBe(sig('a = commands.x'))
    expect(sig('a = models.x')).not.toBe(sig('a = models.x; b = models.y'))
  })

  it('ignores edits the poke parser throws away — reformatting must not retire a verdict', () => {
    // Whitespace, separator style, entry order and junk entries all parse to the same map, so the
    // dock has no reason to forget that it already poked someone.
    expect(sig('a = models.x; b = commands.y')).toBe(sig(' b=commands.y \n a = models.x '))
    expect(sig('a = models.x')).toBe(sig('a = models.x; garbage; c = settings.nope'))
  })
})
