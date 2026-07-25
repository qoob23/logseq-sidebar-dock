import { describe, expect, it } from 'vitest'

import { type DockConfig, normalizeConfig, serializeConfig } from '../config'
import {
  DEFAULT_SETTINGS,
  type DockSettings,
  NAV_TAB,
  SettingsStore,
  WIDTH_FOLLOW_HOST,
  WIDTH_MAX,
  WIDTH_MIN,
  configSignature,
  normalizeSettings,
  parseAdoptPokes,
  settingsDiffer,
} from '../settings'

/** Shorthand for the layout blobs the signature tests compare. */
function config(raw: unknown): DockConfig {
  return normalizeConfig(raw)
}

describe('normalizeSettings', () => {
  it('returns the defaults for missing or unusable input', () => {
    for (const raw of [undefined, null, 'nonsense', 42, [1, 2, 3], true]) {
      expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('ignores every v1 key — there are no v1 users, so there is nothing to migrate', () => {
    expect(
      normalizeSettings({
        mode: 'views',
        viewTop: 'plugin-a',
        viewBottom: 'plugin-b',
        macroTop: '{{renderer :a}}',
        macroBottom: ':b',
        splitPct: 42,
        dockPct: 30,
      }),
    ).toEqual(DEFAULT_SETTINGS)
  })

  it('ignores the host-managed keys it gets handed along the way', () => {
    expect(normalizeSettings({ disabled: false })).toEqual(DEFAULT_SETTINGS)
  })

  it('ignores fields of the wrong type', () => {
    expect(normalizeSettings({ activeTab: 17, adoptPoke: [], layouts: {} })).toEqual(DEFAULT_SETTINGS)
  })

  it('trims the active tab and falls back to nav when it is blank', () => {
    expect(normalizeSettings({ activeTab: '  l_aaaaaa  ' }).activeTab).toBe('l_aaaaaa')
    expect(normalizeSettings({ activeTab: '   ' }).activeTab).toBe(NAV_TAB)
    expect(DEFAULT_SETTINGS.activeTab).toBe(NAV_TAB)
  })

  it('does NOT validate the active tab against the configuration', () => {
    // A tab naming a deleted layout survives here on purpose: the store has no config to check it
    // against, so the fallback is the dock's job (`findLayout(...) === null`).
    expect(normalizeSettings({ activeTab: 'l_deadbe', layouts: '' }).activeTab).toBe('l_deadbe')
    expect(normalizeSettings({ activeTab: 'garbage' }).activeTab).toBe('garbage')
  })

  it('keeps the free-text keys trimmed, with blank as a legitimate value', () => {
    expect(
      normalizeSettings({ adoptPoke: '  a = models.x  ', layouts: '  {"version":2,"layouts":[]}  ' }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      activeTab: NAV_TAB,
      adoptPoke: 'a = models.x',
      layouts: '{"version":2,"layouts":[]}',
    })
    expect(normalizeSettings({ adoptPoke: '   ', layouts: '   ' })).toEqual(DEFAULT_SETTINGS)
  })

  it('reads the sidebar width override, zero meaning "follow the host"', () => {
    // The sentinel sits OUTSIDE the valid range, so a generic clamped-number reader would raise it to
    // WIDTH_MIN and silently turn "follow the host" into a 180px sidebar nobody asked for.
    expect(DEFAULT_SETTINGS.sidebarWidthPx).toBe(WIDTH_FOLLOW_HOST)
    for (const raw of [{}, { sidebarWidthPx: 0 }, { sidebarWidthPx: '0' }, { sidebarWidthPx: '   ' }]) {
      expect(normalizeSettings(raw).sidebarWidthPx).toBe(WIDTH_FOLLOW_HOST)
    }
    // Anything unreadable lands on the sentinel too — never on an arbitrary width.
    for (const bad of ['not a number', Number.NaN, Number.POSITIVE_INFINITY, null, {}, []]) {
      expect(normalizeSettings({ sidebarWidthPx: bad }).sidebarWidthPx).toBe(WIDTH_FOLLOW_HOST)
    }
  })

  it('clamps a real sidebar width to its range and rounds it, strings included', () => {
    // The host's own settings panel hands numbers back as strings.
    expect(normalizeSettings({ sidebarWidthPx: 620 }).sidebarWidthPx).toBe(620)
    expect(normalizeSettings({ sidebarWidthPx: '620' }).sidebarWidthPx).toBe(620)
    expect(normalizeSettings({ sidebarWidthPx: '620.456' }).sidebarWidthPx).toBe(620.46)
    expect(normalizeSettings({ sidebarWidthPx: 1 }).sidebarWidthPx).toBe(WIDTH_MIN)
    expect(normalizeSettings({ sidebarWidthPx: -400 }).sidebarWidthPx).toBe(WIDTH_MIN)
    expect(normalizeSettings({ sidebarWidthPx: 99_999 }).sidebarWidthPx).toBe(WIDTH_MAX)
    // Far wider than the host's own 240–460 clamp, which is the point of the setting.
    expect(WIDTH_MAX).toBeGreaterThan(460)
  })
})

describe('settingsDiffer', () => {
  it('detects a change in any of the four keys, and nothing otherwise', () => {
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toBe(false)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, activeTab: 'l_aaaaaa' })).toBe(true)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, adoptPoke: 'a = models.b' })).toBe(true)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, layouts: '{"version":2,"layouts":[]}' })).toBe(true)
    expect(settingsDiffer(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, sidebarWidthPx: 620 })).toBe(true)
  })

  it('is symmetric, so it can gate a write in either direction', () => {
    const a: DockSettings = { ...DEFAULT_SETTINGS, activeTab: 'l_aaaaaa' }
    expect(settingsDiffer(a, DEFAULT_SETTINGS)).toBe(settingsDiffer(DEFAULT_SETTINGS, a))
  })
})

describe('SettingsStore', () => {
  it('starts from the normalized host settings, or the defaults when there are none', () => {
    expect(new SettingsStore({ activeTab: ' l_aaaaaa ' }).current()).toEqual({
      ...DEFAULT_SETTINGS,
      activeTab: 'l_aaaaaa',
    })
    expect(new SettingsStore().current()).toEqual(DEFAULT_SETTINGS)
  })

  it('lets an override win over the base until the echo agrees, then drops it', () => {
    const store = new SettingsStore({ activeTab: NAV_TAB })
    store.override({ activeTab: 'l_aaaaaa' })
    expect(store.current().activeTab).toBe('l_aaaaaa')

    // The host is still echoing the pre-write value (`updateSettings` is fire-and-forget).
    store.applyEcho({ activeTab: NAV_TAB })
    expect(store.current().activeTab).toBe('l_aaaaaa')

    // Once the echo agrees the override is retired...
    store.applyEcho({ activeTab: 'l_aaaaaa' })
    expect(store.current().activeTab).toBe('l_aaaaaa')

    // ...so a later host-side change (another window, the settings file) now takes effect.
    store.applyEcho({ activeTab: 'l_bbbbbb' })
    expect(store.current().activeTab).toBe('l_bbbbbb')
  })

  it('applies unrelated echoed keys while an override is still pending', () => {
    const store = new SettingsStore()
    store.override({ activeTab: 'l_aaaaaa' })
    store.applyEcho({ activeTab: NAV_TAB, adoptPoke: 'a = models.x' })
    expect(store.current()).toEqual({ ...DEFAULT_SETTINGS, activeTab: 'l_aaaaaa', adoptPoke: 'a = models.x' })
  })

  it('keeps the tab override and the config override independent of each other', () => {
    // This is why `activeTab` is not inside the layouts blob: a tab flip whose echo is still in flight
    // must not clobber a config edit, or vice versa.
    const store = new SettingsStore()
    const blob = serializeConfig(config({ layouts: [{ name: 'A' }] }))
    store.override({ layouts: blob })
    store.override({ activeTab: 'l_aaaaaa' })
    store.applyEcho({ layouts: blob })
    expect(store.current()).toEqual({ ...DEFAULT_SETTINGS, activeTab: 'l_aaaaaa', layouts: blob })
  })

  it('merges successive overrides across keys', () => {
    const store = new SettingsStore()
    store.override({ adoptPoke: 'a = models.x' })
    store.override({ layouts: '{"version":2,"layouts":[]}' })
    expect(store.current()).toEqual({
      ...DEFAULT_SETTINGS,
      adoptPoke: 'a = models.x',
      layouts: '{"version":2,"layouts":[]}',
    })
  })

  it('ignores an undefined key in a patch instead of unsetting it', () => {
    const store = new SettingsStore({ activeTab: 'l_aaaaaa' })
    store.override({ activeTab: undefined, layouts: undefined })
    expect(store.current()).toEqual({ ...DEFAULT_SETTINGS, activeTab: 'l_aaaaaa' })
  })

  it('normalizes an override exactly like the echo path, so the echo can retire it', () => {
    const store = new SettingsStore()
    store.override({ layouts: '  {"version":2,"layouts":[]}  ', activeTab: '  l_aaaaaa  ' })
    expect(store.current().layouts).toBe('{"version":2,"layouts":[]}')
    expect(store.current().activeTab).toBe('l_aaaaaa')

    // Untrimmed, the override would never equal the echoed value and would stay stuck forever.
    store.applyEcho({ layouts: '{"version":2,"layouts":[]}', activeTab: 'l_aaaaaa' })
    store.applyEcho({ layouts: '{"version":2,"layouts":[{"id":"l_bbbbbb","name":"B","axis":"column","slots":[]}]}' })
    expect(store.current().layouts).toContain('l_bbbbbb')
    expect(store.current().activeTab).toBe(NAV_TAB)
  })

  it('lets the user CLEAR the free-text keys, unlike the tab selection', () => {
    // Blanking `layouts` (or `adoptPoke`) is the only way to reset the feature, so '' must survive as
    // a value rather than being dropped as "no change"; a blank tab, by contrast, means nav.
    const store = new SettingsStore({ adoptPoke: 'a = models.b', layouts: '{"version":2,"layouts":[]}', activeTab: 'l_aaaaaa' })
    store.override({ adoptPoke: '', layouts: '  ', activeTab: '  ' })
    expect(store.current()).toEqual(DEFAULT_SETTINGS)
  })

  it('carries a dragged sidebar width until the echo agrees, clamping it like the echo path', () => {
    const store = new SettingsStore({ sidebarWidthPx: WIDTH_FOLLOW_HOST })
    store.override({ sidebarWidthPx: 620 })
    expect(store.current().sidebarWidthPx).toBe(620)

    // Still the pre-write value on the host side (`updateSettings` is fire-and-forget).
    store.applyEcho({ sidebarWidthPx: WIDTH_FOLLOW_HOST })
    expect(store.current().sidebarWidthPx).toBe(620)

    // Once the echo agrees the override retires, so a later host-side change takes effect...
    store.applyEcho({ sidebarWidthPx: 620 })
    store.applyEcho({ sidebarWidthPx: 99_999 })
    expect(store.current().sidebarWidthPx).toBe(WIDTH_MAX)

    // ...and an override is clamped exactly like an echo, or it could never equal one.
    store.override({ sidebarWidthPx: 5 })
    expect(store.current().sidebarWidthPx).toBe(WIDTH_MIN)
  })

  it('lets the user switch the width override OFF — zero is a value, not "no change"', () => {
    // A dropped zero would leave the seeded width standing with no way back to the host's own; a zero
    // clamped up to WIDTH_MIN would be a phantom override no echo can ever agree with, masking every
    // later hand edit of the setting until the plugin reloads.
    const store = new SettingsStore({ sidebarWidthPx: 620 })
    store.override({ sidebarWidthPx: WIDTH_FOLLOW_HOST })
    expect(store.current().sidebarWidthPx).toBe(WIDTH_FOLLOW_HOST)

    store.applyEcho({ sidebarWidthPx: WIDTH_FOLLOW_HOST })
    store.applyEcho({ sidebarWidthPx: 800 })
    expect(store.current().sidebarWidthPx).toBe(800)
  })

  it('keeps the width override independent of a pending config edit', () => {
    // The width belongs to no layout, so resizing while a config write is in flight must clobber
    // neither — the same per-key isolation that keeps `activeTab` out of the layouts blob.
    const store = new SettingsStore()
    const blob = serializeConfig(config({ layouts: [{ name: 'A' }] }))
    store.override({ layouts: blob })
    store.override({ sidebarWidthPx: 620 })
    store.applyEcho({ sidebarWidthPx: 620 })
    expect(store.current()).toEqual({ ...DEFAULT_SETTINGS, layouts: blob, sidebarWidthPx: 620 })
  })

  it('falls back to the defaults when the echo itself is garbage', () => {
    const store = new SettingsStore({ activeTab: 'l_aaaaaa' })
    store.applyEcho('boom')
    expect(store.current()).toEqual(DEFAULT_SETTINGS)
  })

  it('hands out a snapshot, not its own state', () => {
    const store = new SettingsStore()
    const snapshot = store.current()
    snapshot.activeTab = 'mutated'
    expect(store.current().activeTab).toBe(NAV_TAB)
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
  const PLUGINS = config({
    layouts: [
      { id: 'l_aaaaaa', name: 'A', axis: 'column', slots: [{ id: 's_111111', weight: 1, source: { kind: 'plugin', pid: 'alpha' } }] },
      { id: 'l_bbbbbb', name: 'B', axis: 'row', slots: [{ id: 's_222222', weight: 2, source: { kind: 'macro', raw: ':pomo' } }] },
    ],
  })

  it('is stable for an unchanged configuration', () => {
    expect(configSignature('a = models.x', PLUGINS)).toBe(configSignature('a = models.x', PLUGINS))
  })

  it('ignores everything the episode memories are NOT keyed by', () => {
    // Those verdicts ("already poked this plugin", "nobody answered this macro") are keyed by pid and
    // by raw macro spec, so renaming a layout, retitling a tab, flipping an axis, dragging a divider,
    // regenerating ids or reordering slots and layouts must not retire a single one of them.
    const shuffled = config({
      layouts: [
        { id: 'l_cccccc', name: 'renamed', axis: 'column', slots: [{ id: 's_444444', weight: 7, source: { kind: 'macro', raw: ':pomo' } }] },
        { id: 'l_dddddd', name: 'also', axis: 'row', slots: [{ id: 's_333333', weight: 0.5, source: { kind: 'plugin', pid: 'alpha' } }] },
      ],
    })
    expect(configSignature('', shuffled)).toBe(configSignature('', PLUGINS))
  })

  it('ignores where in the configuration a spec sits — one layout or two', () => {
    const merged = config({
      layouts: [
        {
          slots: [{ source: { kind: 'macro', raw: ':pomo' } }, { source: { kind: 'plugin', pid: 'alpha' } }],
        },
      ],
    })
    expect(configSignature('', merged)).toBe(configSignature('', PLUGINS))
  })

  it('changes when a slot changes what it renders', () => {
    expect(configSignature('', PLUGINS)).not.toBe(
      configSignature('', config({ layouts: [{ slots: [{ source: { kind: 'plugin', pid: 'beta' } }, { source: { kind: 'macro', raw: ':pomo' } }] }] })),
    )
  })

  it('changes when a macro spec is edited, so its "unanswered" verdict is retired', () => {
    const before = config({ layouts: [{ slots: [{ source: { kind: 'macro', raw: ':pomo' } }] }] })
    const after = config({ layouts: [{ slots: [{ source: { kind: 'macro', raw: ':pomo, 25' } }] }] })
    expect(configSignature('', before)).not.toBe(configSignature('', after))
  })

  it('changes when a slot is added or removed', () => {
    const one = config({ layouts: [{ slots: [{ source: { kind: 'plugin', pid: 'alpha' } }] }] })
    const two = config({
      layouts: [{ slots: [{ source: { kind: 'plugin', pid: 'alpha' } }, { source: { kind: 'plugin', pid: 'beta' } }] }],
    })
    expect(configSignature('', one)).not.toBe(configSignature('', two))
  })

  it('tells a macro apart from a plugin (and from an invalid spec) of the same name', () => {
    const macro = config({ layouts: [{ slots: [{ source: { kind: 'macro', raw: 'x' } }] }] })
    const plugin = config({ layouts: [{ slots: [{ source: { kind: 'plugin', pid: 'x' } }] }] })
    const invalid = config({ layouts: [{ slots: [{ source: { kind: 'macro', raw: '{{renderer}}' } }] }] })
    const signatures = [macro, plugin, invalid].map((cfg) => configSignature('', cfg))
    expect(new Set(signatures).size).toBe(3)
  })

  it('sees a pid collapsed to `none` by the duplicate rule as what it resolves to', () => {
    // The signature is built from RESOLVED specs, which is what mounting acts on.
    const duplicated = config({
      layouts: [{ slots: [{ source: { kind: 'plugin', pid: 'dup' } }, { source: { kind: 'plugin', pid: 'dup' } }] }],
    })
    const single = config({ layouts: [{ slots: [{ source: { kind: 'plugin', pid: 'dup' } }, {}] }] })
    expect(configSignature('', duplicated)).toBe(configSignature('', single))
  })

  it('changes when a poke target is added, retargeted or removed', () => {
    expect(configSignature('', PLUGINS)).not.toBe(configSignature('a = models.x', PLUGINS))
    expect(configSignature('a = models.x', PLUGINS)).not.toBe(configSignature('a = commands.x', PLUGINS))
    expect(configSignature('a = models.x', PLUGINS)).not.toBe(configSignature('a = models.x; b = models.y', PLUGINS))
  })

  it('ignores poke edits the parser throws away — reformatting must not retire a verdict', () => {
    expect(configSignature('a = models.x; b = commands.y', PLUGINS)).toBe(
      configSignature(' b=commands.y \n a = models.x ', PLUGINS),
    )
    expect(configSignature('a = models.x', PLUGINS)).toBe(
      configSignature('a = models.x; garbage; c = settings.nope', PLUGINS),
    )
  })
})
