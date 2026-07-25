import { describe, expect, it } from 'vitest'

import {
  CONFIG_VERSION,
  DEFAULT_WEIGHT,
  type DockConfig,
  type Layout,
  MAX_NAME_LENGTH,
  MAX_SLOTS_PER_LAYOUT,
  type ParseResult,
  type ResolvedSlot,
  type SlotConfig,
  WEIGHT_MAX,
  WEIGHT_MIN,
  addLayout,
  addSlot,
  createLayout,
  createSlot,
  defaultLayoutName,
  emptyConfig,
  fillOrder,
  findLayout,
  isSlotConfigured,
  layoutHasContent,
  moveSlot,
  newLayoutId,
  newSlotId,
  normalizeConfig,
  parseConfig,
  removeLayout,
  removeSlot,
  renameLayout,
  resolveLayoutSlots,
  serializeConfig,
  setLayoutWeights,
  setSlotMacro,
  setSlotMacroMode,
  setSlotSource,
  sharedPluginIds,
  specSignature,
  toggleLayoutAxis,
} from '../config'

const LAYOUT_ID = /^l_[0-9a-f]{6}$/
const SLOT_ID = /^s_[0-9a-f]{6}$/

/** `JSON.parse` returns `any`, which the lint policy forbids assigning; funnel it through `unknown`. */
function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown
}

function expectConfig(result: ParseResult): DockConfig {
  if (!result.ok) throw new Error(`expected a parsed config, got error: ${result.error}`)
  return result.config
}

function expectFailure(result: ParseResult): { raw: string; error: string } {
  if (result.ok) throw new Error(`expected a parse failure, got: ${serializeConfig(result.config)}`)
  return result
}

/** The only layout of a normalized config, for the many single-layout cases below. */
function only(raw: unknown): Layout {
  const config = normalizeConfig(raw)
  expect(config.layouts).toHaveLength(1)
  return config.layouts[0]
}

describe('normalizeConfig — totality', () => {
  it('turns anything at all into a complete config instead of throwing', () => {
    for (const raw of [undefined, null, 42, 'nonsense', true, [], [1, 2], {}, { layouts: 'nope' }]) {
      expect(normalizeConfig(raw)).toEqual({ version: CONFIG_VERSION, layouts: [] })
    }
  })

  it('always stamps the version this build writes, whatever the input claimed', () => {
    expect(normalizeConfig({ version: 99, layouts: [] }).version).toBe(CONFIG_VERSION)
    expect(normalizeConfig({ version: 'v2', layouts: [] }).version).toBe(CONFIG_VERSION)
  })

  it('drops malformed layout entries and keeps the good ones', () => {
    // `asRecord` rejects arrays too — a JSON array is not a layout object.
    const config = normalizeConfig({ layouts: [null, 7, 'x', [], { name: 'Kept' }, undefined] })
    expect(config.layouts.map((layout) => layout.name)).toEqual(['Kept'])
  })

  it('drops malformed slot entries and keeps the good ones', () => {
    const layout = only({ layouts: [{ slots: [null, 'x', [], { weight: 3 }] }] })
    expect(layout.slots).toHaveLength(1)
    expect(layout.slots[0].weight).toBe(3)
  })

  it('accepts zero layouts and a layout with zero slots — both are legal states', () => {
    expect(normalizeConfig({ layouts: [] }).layouts).toEqual([])
    expect(only({ layouts: [{ slots: [] }] }).slots).toEqual([])
  })
})

describe('normalizeConfig — names', () => {
  it('falls back to the positional default name for a blank or missing name', () => {
    const config = normalizeConfig({ layouts: [{}, { name: '   ' }, { name: null }] })
    expect(config.layouts.map((layout) => layout.name)).toEqual(['Layout 1', 'Layout 2', 'Layout 3'])
    expect(defaultLayoutName(0)).toBe('Layout 1')
  })

  it('numbers the fallback by FINAL position, after malformed entries have been dropped', () => {
    // The index is the position in the output, so a dropped entry does not leave a gap in the names.
    const config = normalizeConfig({ layouts: [null, {}, 'junk', {}] })
    expect(config.layouts.map((layout) => layout.name)).toEqual(['Layout 1', 'Layout 2'])
  })

  it('trims a name and truncates it to the tab strip budget', () => {
    expect(only({ layouts: [{ name: '  Notes  ' }] }).name).toBe('Notes')
    const long = only({ layouts: [{ name: 'ABCDEFGHIJKLMNOPQRST' }] }).name
    expect(long).toHaveLength(MAX_NAME_LENGTH)
    expect(long).toBe('ABCDEFGHIJKL')
  })
})

describe('normalizeConfig — weights', () => {
  it('defaults a missing or unreadable weight', () => {
    for (const weight of [undefined, null, 'abc', {}, Number.NaN, Number.POSITIVE_INFINITY, true]) {
      expect(only({ layouts: [{ slots: [{ weight }] }] }).slots[0].weight).toBe(DEFAULT_WEIGHT)
    }
  })

  it('clamps to the legal range', () => {
    expect(only({ layouts: [{ slots: [{ weight: -100 }] }] }).slots[0].weight).toBe(WEIGHT_MIN)
    expect(only({ layouts: [{ slots: [{ weight: 0 }] }] }).slots[0].weight).toBe(WEIGHT_MIN)
    expect(only({ layouts: [{ slots: [{ weight: 1e6 }] }] }).slots[0].weight).toBe(WEIGHT_MAX)
  })

  it('rounds to four decimals, the grid the drag handler also lands on', () => {
    expect(only({ layouts: [{ slots: [{ weight: 1 / 3 }] }] }).slots[0].weight).toBe(0.3333)
    expect(only({ layouts: [{ slots: [{ weight: 2.000_049 }] }] }).slots[0].weight).toBe(2)
  })

  it('accepts numeric strings — the raw-JSON escape hatch invites them', () => {
    expect(only({ layouts: [{ slots: [{ weight: '2' }] }] }).slots[0].weight).toBe(2)
    expect(only({ layouts: [{ slots: [{ weight: ' 2.5 ' }] }] }).slots[0].weight).toBe(2.5)
  })

  it('reads a blank string as the zero `Number("")` gives, so it clamps to the minimum', () => {
    // Documenting, not endorsing: `""` is a *readable* number as far as `Number` is concerned, so it
    // takes the clamp path (0 → WEIGHT_MIN) rather than the "unreadable → default" one.
    expect(only({ layouts: [{ slots: [{ weight: '' }] }] }).slots[0].weight).toBe(WEIGHT_MIN)
    expect(only({ layouts: [{ slots: [{ weight: '  ' }] }] }).slots[0].weight).toBe(WEIGHT_MIN)
  })
})

describe('normalizeConfig — axis', () => {
  it("is 'row' only for exactly that string", () => {
    expect(only({ layouts: [{ axis: 'row' }] }).axis).toBe('row')
    for (const axis of [undefined, null, 'ROW', ' row ', 'horizontal', true, 1]) {
      expect(only({ layouts: [{ axis }] }).axis).toBe('column')
    }
  })
})

describe('normalizeConfig — sources', () => {
  it('keeps a plugin pick, trimmed', () => {
    expect(only({ layouts: [{ slots: [{ source: { kind: 'plugin', pid: '  synapses ' } }] }] }).slots[0].source).toEqual({
      kind: 'plugin',
      pid: 'synapses',
    })
  })

  it('keeps a macro pick, trimmed, INCLUDING a blank spec', () => {
    // "macro mode picked, nothing typed yet" has to survive the round trip through the host or the
    // editor's text input would vanish under the user.
    expect(only({ layouts: [{ slots: [{ source: { kind: 'macro', raw: ' :pomo ' } }] }] }).slots[0].source).toEqual({
      kind: 'macro',
      raw: ':pomo',
    })
    expect(only({ layouts: [{ slots: [{ source: { kind: 'macro' } }] }] }).slots[0].source).toEqual({
      kind: 'macro',
      raw: '',
    })
  })

  it('degrades an unreadable source to `none` rather than dropping the slot', () => {
    // The slot box is the only thing the edit UI can hang controls off — losing it leaves nothing to fix.
    for (const source of [undefined, null, 'plugin', [], { kind: 'weird' }, { kind: 'plugin' }, { kind: 'plugin', pid: '  ' }]) {
      expect(only({ layouts: [{ slots: [{ source }] }] }).slots[0].source).toEqual({ kind: 'none' })
    }
  })
})

describe('normalizeConfig — caps', () => {
  it('caps the slots of one layout, keeping the first ones', () => {
    const slots = Array.from({ length: MAX_SLOTS_PER_LAYOUT + 5 }, (_unused, index) => ({ weight: index + 1 }))
    const kept = only({ layouts: [{ slots }] }).slots
    expect(kept).toHaveLength(MAX_SLOTS_PER_LAYOUT)
    expect(kept[0].weight).toBe(1)
    expect(kept[MAX_SLOTS_PER_LAYOUT - 1].weight).toBe(MAX_SLOTS_PER_LAYOUT)
  })

  it('does not cap the number of layouts', () => {
    const layouts = Array.from({ length: 30 }, () => ({ slots: [] }))
    expect(normalizeConfig({ layouts }).layouts).toHaveLength(30)
  })
})

describe('normalizeConfig — ids', () => {
  it('keeps well-formed ids untouched', () => {
    const config = normalizeConfig({
      layouts: [{ id: 'l_00ff99', slots: [{ id: 's_abcdef' }] }],
    })
    expect(config.layouts[0].id).toBe('l_00ff99')
    expect(config.layouts[0].slots[0].id).toBe('s_abcdef')
  })

  it('regenerates a missing id', () => {
    const layout = only({ layouts: [{ slots: [{}] }] })
    expect(layout.id).toMatch(LAYOUT_ID)
    expect(layout.slots[0].id).toMatch(SLOT_ID)
  })

  it('regenerates an id that is not a bare CSS ident of the expected shape', () => {
    // Ids reach CSS unescaped (`--sdock-w-<id>`, `[data-slot-id='<id>']`), so anything else is a hazard.
    for (const id of ['', 'nope', 'l_00ff99', 'S_ABCDEF', 's_00ff9', 's_00ff999', 's_00ff9g', 's_00 ff9', 42, null]) {
      const slot = only({ layouts: [{ slots: [{ id }] }] }).slots[0]
      expect(slot.id).toMatch(SLOT_ID)
      if (typeof id === 'string') expect(slot.id).not.toBe(id)
    }
    expect(only({ layouts: [{ id: 's_abcdef' }] }).id).toMatch(LAYOUT_ID)
  })

  it('regenerates a duplicated layout id, keeping the first occurrence', () => {
    const config = normalizeConfig({ layouts: [{ id: 'l_aaaaaa' }, { id: 'l_aaaaaa' }] })
    expect(config.layouts[0].id).toBe('l_aaaaaa')
    expect(config.layouts[1].id).toMatch(LAYOUT_ID)
    expect(config.layouts[1].id).not.toBe('l_aaaaaa')
  })

  it('dedupes slot ids GLOBALLY, not per layout — the mount map keys on the bare slot id', () => {
    // Two layouts sharing a slot id would fight over a single mount record.
    const config = normalizeConfig({
      layouts: [
        { id: 'l_aaaaaa', slots: [{ id: 's_111111' }, { id: 's_111111' }] },
        { id: 'l_bbbbbb', slots: [{ id: 's_111111' }] },
      ],
    })
    const ids = config.layouts.flatMap((layout) => layout.slots.map((slot) => slot.id))
    expect(ids[0]).toBe('s_111111')
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).toMatch(SLOT_ID)
  })

  it('accepts the ids its own generators produce', () => {
    const config = normalizeConfig({ layouts: [{ id: newLayoutId(), slots: [{ id: newSlotId() }] }] })
    expect(config.layouts[0].id).toMatch(LAYOUT_ID)
    expect(config.layouts[0].slots[0].id).toMatch(SLOT_ID)
  })

  it('generates distinct ids often enough to be usable', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSlotId()))
    expect(ids.size).toBeGreaterThan(180)
    for (const id of ids) expect(id).toMatch(SLOT_ID)
  })
})

describe('factories', () => {
  it('hands out a FRESH object every call — the edit path mutates these in place', () => {
    expect(emptyConfig()).not.toBe(emptyConfig())
    expect(createSlot()).not.toBe(createSlot())
    const layout = createLayout()
    layout.slots.push(createSlot())
    expect(createLayout().slots).toHaveLength(1)
  })

  it('gives a new layout one empty slot and a deliberately blank name', () => {
    const layout = createLayout()
    expect(layout.id).toMatch(LAYOUT_ID)
    expect(layout.name).toBe('')
    expect(layout.axis).toBe('column')
    expect(layout.slots).toHaveLength(1)
    expect(layout.slots[0].source).toEqual({ kind: 'none' })
    // Blank is not a bug: normalization names it for whatever position it ends up in.
    expect(normalizeConfig({ layouts: [{}, layout] }).layouts[1].name).toBe('Layout 2')
  })

  it('keeps an explicitly given name', () => {
    expect(createLayout('Notes').name).toBe('Notes')
  })

  it('creates a slot with the default weight and the given source', () => {
    expect(createSlot().weight).toBe(DEFAULT_WEIGHT)
    expect(createSlot().source).toEqual({ kind: 'none' })
    expect(createSlot({ kind: 'plugin', pid: 'a' }).source).toEqual({ kind: 'plugin', pid: 'a' })
  })

  it('finds a layout by id and reports a deleted one as null', () => {
    const config = normalizeConfig({ layouts: [{ id: 'l_aaaaaa' }, { id: 'l_bbbbbb' }] })
    expect(findLayout(config, 'l_bbbbbb')?.id).toBe('l_bbbbbb')
    // An `activeTab` naming a layout that no longer exists must be detectable, so the dock can
    // fall back to the nav face instead of showing nothing.
    expect(findLayout(config, 'l_cccccc')).toBeNull()
    expect(findLayout(config, 'nav')).toBeNull()
  })
})

describe('parseConfig', () => {
  it('reads blank as the initial state, not as an error', () => {
    for (const raw of ['', '   ', '\n\t']) {
      expect(expectConfig(parseConfig(raw))).toEqual(emptyConfig())
    }
  })

  it('reads a real configuration back', () => {
    const config = expectConfig(parseConfig('{"version":2,"layouts":[{"id":"l_aaaaaa","name":"A","axis":"row","slots":[]}]}'))
    expect(config.layouts[0]).toEqual({ id: 'l_aaaaaa', name: 'A', axis: 'row', slots: [] })
  })

  it('reports a JSON syntax error and preserves the raw text VERBATIM', () => {
    // The dock must be able to show the user exactly what it could not read, and must not write the
    // `layouts` key while in that state — one typo in the escape hatch would destroy the whole config.
    const raw = '  {"layouts": [oops]  '
    const failure = expectFailure(parseConfig(raw))
    expect(failure.raw).toBe(raw)
    expect(failure.error).not.toBe('')
  })

  it('treats every kind of syntax garbage as a failure, never as an empty config', () => {
    for (const raw of ['{', '}', 'nonsense', "{'single':1}", '{"a":1,}', '[1,]']) {
      expect(parseConfig(raw).ok).toBe(false)
    }
  })

  it('treats JSON that parses to junk as success, and normalizes it', () => {
    // A hand edit that is *valid* JSON but nonsense is repairable; refusing to write would strand the user.
    for (const raw of ['42', '"text"', 'null', 'true', '[]', '{}', '[{"id":"l_aaaaaa"}]']) {
      expect(expectConfig(parseConfig(raw))).toEqual(emptyConfig())
    }
    const repaired = expectConfig(parseConfig('{"layouts":[{"name":"","axis":"nope","slots":[{"weight":"99"}]}]}'))
    expect(repaired.version).toBe(CONFIG_VERSION)
    expect(repaired.layouts).toHaveLength(1)
    const layout = repaired.layouts[0]
    expect(layout.id).toMatch(LAYOUT_ID)
    expect(layout.name).toBe('Layout 1')
    expect(layout.axis).toBe('column')
    expect(layout.slots[0].id).toMatch(SLOT_ID)
    expect(layout.slots[0].weight).toBe(WEIGHT_MAX)
    expect(layout.slots[0].source).toEqual({ kind: 'none' })
  })
})

describe('serializeConfig', () => {
  const CONFIG: DockConfig = {
    version: 2,
    layouts: [
      {
        id: 'l_aaaaaa',
        name: 'Views',
        axis: 'row',
        slots: [
          { id: 's_111111', weight: 1.5, source: { kind: 'plugin', pid: 'synapses' } },
          { id: 's_222222', weight: 1, source: { kind: 'macro', raw: ':pomo, 25' } },
          { id: 's_333333', weight: 0.05, source: { kind: 'none' } },
        ],
      },
      { id: 'l_bbbbbb', name: 'Empty', axis: 'column', slots: [] },
    ],
  }

  const CANONICAL =
    '{"version":2,"layouts":[' +
    '{"id":"l_aaaaaa","name":"Views","axis":"row","slots":[' +
    '{"id":"s_111111","weight":1.5,"source":{"kind":"plugin","pid":"synapses"}},' +
    '{"id":"s_222222","weight":1,"source":{"kind":"macro","raw":":pomo, 25"}},' +
    '{"id":"s_333333","weight":0.05,"source":{"kind":"none"}}]},' +
    '{"id":"l_bbbbbb","name":"Empty","axis":"column","slots":[]}]}'

  it('emits the documented key order with no whitespace', () => {
    expect(serializeConfig(CONFIG)).toBe(CANONICAL)
  })

  it('is valid JSON that reads back as the same object', () => {
    expect(parseJson(serializeConfig(CONFIG))).toEqual(CONFIG)
  })

  it('ignores the key order of the input object', () => {
    // `settingsDiffer` compares these strings with `!==`: a key order that followed the input would
    // make an echo of an unchanged config read as a change and drive a self-sustaining assert loop.
    const shuffled: DockConfig = {
      layouts: [
        {
          slots: [
            { source: { pid: 'synapses', kind: 'plugin' }, weight: 1.5, id: 's_111111' },
            { source: { raw: ':pomo, 25', kind: 'macro' }, id: 's_222222', weight: 1 },
            { weight: 0.05, source: { kind: 'none' }, id: 's_333333' },
          ],
          axis: 'row',
          name: 'Views',
          id: 'l_aaaaaa',
        },
        { slots: [], name: 'Empty', axis: 'column', id: 'l_bbbbbb' },
      ],
      version: 2,
    }
    expect(serializeConfig(shuffled)).toBe(CANONICAL)
  })

  it('escapes hostile text so the blob survives the round trip through the host', () => {
    const config: DockConfig = {
      version: 2,
      layouts: [
        {
          id: 'l_aaaaaa',
          name: 'a"b\\c',
          axis: 'column',
          slots: [
            { id: 's_111111', weight: 1, source: { kind: 'plugin', pid: 'we"ird\\pid' } },
            { id: 's_222222', weight: 1, source: { kind: 'macro', raw: '{{renderer :a}}\n"x"' } },
          ],
        },
      ],
    }
    expect(parseJson(serializeConfig(config))).toEqual(config)
    expect(serializeConfig(expectConfig(parseConfig(serializeConfig(config))))).toBe(serializeConfig(config))
  })

  it('substitutes the default for a non-finite weight instead of emitting invalid JSON', () => {
    const config: DockConfig = {
      version: 2,
      layouts: [{ id: 'l_aaaaaa', name: 'A', axis: 'column', slots: [{ id: 's_111111', weight: Number.NaN, source: { kind: 'none' } }] }],
    }
    expect(serializeConfig(config)).toContain('"weight":1')
    expect(parseJson(serializeConfig(config))).toBeTypeOf('object')
  })

  it('rounds a weight the edit path left with float noise', () => {
    const config: DockConfig = {
      version: 2,
      layouts: [{ id: 'l_aaaaaa', name: 'A', axis: 'column', slots: [{ id: 's_111111', weight: 1.234_567_8, source: { kind: 'none' } }] }],
    }
    expect(serializeConfig(config)).toContain('"weight":1.2346')
  })

  it('round-trips a normalized config to a byte-identical string, repeatedly', () => {
    // This is the assert-loop guard: write → host echo → parse → normalize → write must reach a fixed
    // point on the FIRST pass, or the dock keeps writing the same configuration forever.
    const inputs: unknown[] = [
      {},
      { layouts: [] },
      { layouts: [{}, {}, {}] },
      { layouts: [{ id: 'l_aaaaaa', name: 'Notes', axis: 'row', slots: [{ id: 's_111111', weight: 1 / 3, source: { kind: 'plugin', pid: 'synapses' } }] }] },
      {
        layouts: [
          { name: '  spaced  ', axis: 'nope', slots: [{ weight: '99' }, { source: { kind: 'macro', raw: '' } }, { source: { kind: 'macro', raw: '{{renderer :a, 2}}' } }] },
          { id: 'l_aaaaaa', slots: [{ id: 's_111111', source: { kind: 'plugin', pid: 'dup' } }, { source: { kind: 'plugin', pid: 'dup' } }] },
          { name: 'unicode ✓', slots: [{ source: { kind: 'plugin', pid: 'we"ird' } }] },
        ],
      },
      { layouts: [{ slots: Array.from({ length: 20 }, () => ({ weight: -1 })) }] },
    ]

    for (const input of inputs) {
      const first = serializeConfig(normalizeConfig(input))
      const second = serializeConfig(expectConfig(parseConfig(first)))
      expect(second).toBe(first)
      expect(serializeConfig(expectConfig(parseConfig(second)))).toBe(first)
      // Re-normalizing an already normalized config is a no-op too.
      expect(serializeConfig(normalizeConfig(parseJson(first)))).toBe(first)
    }
  })
})

describe('resolveLayoutSlots', () => {
  const resolve = (slots: unknown[]): readonly { id: string; weight: number; spec: unknown }[] =>
    resolveLayoutSlots(only({ layouts: [{ slots }] }))

  it('returns one slot box per configured slot — `none` included', () => {
    // With N slots the v1 `both | top-only | bottom-only | empty` collapse is meaningless, and the
    // edit UI needs empty slots to be visible and clickable.
    const resolved = resolve([{}, { source: { kind: 'plugin', pid: 'a' } }, {}])
    expect(resolved).toHaveLength(3)
    expect(resolved.map((slot) => slot.spec)).toEqual([{ kind: 'none' }, { kind: 'plugin', pid: 'a' }, { kind: 'none' }])
  })

  it('carries the slot id and weight through untouched', () => {
    const layout = only({ layouts: [{ slots: [{ id: 's_111111', weight: 2.5 }] }] })
    expect(resolveLayoutSlots(layout)[0]).toEqual({ id: 's_111111', weight: 2.5, spec: { kind: 'none' } })
  })

  it('parses a macro spec in either of the forms a user has at hand', () => {
    expect(resolve([{ source: { kind: 'macro', raw: '{{renderer :pomo, 25}}' } }])[0].spec).toEqual({
      kind: 'macro',
      raw: '{{renderer :pomo, 25}}',
      args: [':pomo', '25'],
    })
    expect(resolve([{ source: { kind: 'macro', raw: ':pomo' } }])[0].spec).toEqual({
      kind: 'macro',
      raw: ':pomo',
      args: [':pomo'],
    })
  })

  it('reports an unparseable non-blank macro rather than showing an empty slot', () => {
    for (const raw of ['{{renderer}}', '{{}}', ', ,']) {
      expect(resolve([{ source: { kind: 'macro', raw } }])[0].spec).toEqual({ kind: 'invalid-macro', raw })
    }
  })

  it('maps a BLANK macro pick to `none` — nothing has been typed yet, nothing is wrong', () => {
    expect(resolve([{ source: { kind: 'macro', raw: '   ' } }])[0].spec).toEqual({ kind: 'none' })
  })

  it('lets the same macro fill several slots: each gets its own injected copy', () => {
    const specs = resolve([{ source: { kind: 'macro', raw: ':pomo' } }, { source: { kind: 'macro', raw: ':pomo' } }]).map(
      (slot) => slot.spec,
    )
    expect(specs[0]).toEqual(specs[1])
    expect(specs[1]).toEqual({ kind: 'macro', raw: ':pomo', args: [':pomo'] })
  })

  it('collapses a pid repeated in ONE layout to `none`, first slot winning', () => {
    // A plugin's view is a single DOM node; two simultaneously visible slots cannot both hold it.
    const specs = resolve([
      { source: { kind: 'plugin', pid: 'dup' } },
      { source: { kind: 'plugin', pid: 'dup' } },
      { source: { kind: 'plugin', pid: 'other' } },
      { source: { kind: 'plugin', pid: 'dup' } },
    ]).map((slot) => slot.spec)
    expect(specs).toEqual([
      { kind: 'plugin', pid: 'dup' },
      { kind: 'none' },
      { kind: 'plugin', pid: 'other' },
      { kind: 'none' },
    ])
  })

  it('does NOT suppress a pid reused in a DIFFERENT layout — only one layout is visible at a time', () => {
    const config = normalizeConfig({
      layouts: [{ slots: [{ source: { kind: 'plugin', pid: 'dup' } }] }, { slots: [{ source: { kind: 'plugin', pid: 'dup' } }] }],
    })
    for (const layout of config.layouts) {
      expect(resolveLayoutSlots(layout)[0].spec).toEqual({ kind: 'plugin', pid: 'dup' })
    }
  })

  it('does not dedup a plugin against a macro of the same name', () => {
    const specs = resolve([{ source: { kind: 'macro', raw: 'dup' } }, { source: { kind: 'plugin', pid: 'dup' } }]).map(
      (slot) => slot.spec,
    )
    expect(specs[0]).toEqual({ kind: 'macro', raw: 'dup', args: ['dup'] })
    expect(specs[1]).toEqual({ kind: 'plugin', pid: 'dup' })
  })
})

describe('fillOrder', () => {
  const layouts = [{ id: 'l_aaaaaa' }, { id: 'l_bbbbbb' }, { id: 'l_cccccc' }]

  it('puts the active layout first and leaves the rest in configuration order', () => {
    // The order IS the adopt-steal rule: a plugin's main UI is one node, so whichever slot reaches it
    // first keeps it, and the layout the user can see has to get its turn before any hidden one.
    expect(fillOrder(layouts, 'l_bbbbbb').map((layout) => layout.id)).toEqual(['l_bbbbbb', 'l_aaaaaa', 'l_cccccc'])
    expect(fillOrder(layouts, 'l_cccccc').map((layout) => layout.id)).toEqual(['l_cccccc', 'l_aaaaaa', 'l_bbbbbb'])
  })

  it('is a no-op when the active layout already leads', () => {
    expect(fillOrder(layouts, 'l_aaaaaa').map((layout) => layout.id)).toEqual(['l_aaaaaa', 'l_bbbbbb', 'l_cccccc'])
  })

  it('keeps every layout exactly once when the active tab names no layout at all', () => {
    // The nav face, and an `activeTab` left pointing at a deleted layout, both land here.
    for (const tab of ['nav', '', 'l_zzzzzz']) {
      expect(fillOrder(layouts, tab).map((layout) => layout.id)).toEqual(['l_aaaaaa', 'l_bbbbbb', 'l_cccccc'])
    }
  })

  it('hands back the very same objects, and never mutates the input', () => {
    const ordered = fillOrder(layouts, 'l_cccccc')
    expect(ordered[0]).toBe(layouts[2])
    expect(ordered[1]).toBe(layouts[0])
    expect(layouts.map((layout) => layout.id)).toEqual(['l_aaaaaa', 'l_bbbbbb', 'l_cccccc'])
  })

  it('survives an empty configuration', () => {
    expect(fillOrder([], 'nav')).toEqual([])
  })
})

describe('sharedPluginIds', () => {
  /** Layouts in the shape the dock passes: resolved slots, so the duplicate rule has already applied. */
  const resolved = (raw: unknown): { slots: readonly ResolvedSlot[] }[] =>
    normalizeConfig(raw).layouts.map((layout) => ({ slots: resolveLayoutSlots(layout) }))

  const pluginSlot = (pid: string): unknown => ({ source: { kind: 'plugin', pid } })

  it('flags a pid configured in two different layouts', () => {
    // The warning it drives is user-facing: switching between those tabs steals the plugin's one view
    // back and forth, reloading it each time.
    const shared = sharedPluginIds(
      resolved({ layouts: [{ slots: [pluginSlot('dup')] }, { slots: [pluginSlot('dup')] }] }),
    )
    expect([...shared]).toEqual(['dup'])
  })

  it('does NOT flag a pid repeated inside ONE layout — the repeat already resolved to `none`', () => {
    // Two slots of the same layout cannot both hold one node, so `resolveLayoutSlots` collapses the
    // second to `none`: there is exactly one live mount and nothing to switch between.
    expect([...sharedPluginIds(resolved({ layouts: [{ slots: [pluginSlot('dup'), pluginSlot('dup')] }] }))]).toEqual([])
    expect(
      [...sharedPluginIds(resolved({ layouts: [{ slots: [pluginSlot('dup'), pluginSlot('x'), pluginSlot('dup')] }] }))],
    ).toEqual([])
  })

  it('counts a layout ONCE per pid even when handed one twice, rather than reading it as sharing', () => {
    // Belt and braces for the case above: `resolveLayoutSlots` cannot currently produce two `plugin`
    // specs for one pid in one layout, so the per-layout dedupe is what would have to fail first for a
    // single layout to look like two. Fed that shape directly, it still must not warn.
    const slot = (pid: string): ResolvedSlot => ({ id: `s_${pid}`, weight: 1, spec: { kind: 'plugin', pid } })
    expect([...sharedPluginIds([{ slots: [slot('dup'), slot('dup'), slot('dup')] }])]).toEqual([])
  })

  it('still flags a pid that a second layout wants, however often the first repeats it', () => {
    const shared = sharedPluginIds(
      resolved({ layouts: [{ slots: [pluginSlot('dup'), pluginSlot('dup')] }, { slots: [pluginSlot('dup')] }] }),
    )
    expect([...shared]).toEqual(['dup'])
  })

  it('leaves a pid used by a single layout alone', () => {
    const shared = sharedPluginIds(
      resolved({ layouts: [{ slots: [pluginSlot('a'), pluginSlot('b')] }, { slots: [pluginSlot('c')] }] }),
    )
    expect([...shared]).toEqual([])
  })

  it('counts only plugin specs — macros get their own injected copy per slot', () => {
    const shared = sharedPluginIds(
      resolved({
        layouts: [
          { slots: [{ source: { kind: 'macro', raw: ':pomo' } }, { source: { kind: 'macro', raw: '{{renderer}}' } }, {}] },
          { slots: [{ source: { kind: 'macro', raw: ':pomo' } }, { source: { kind: 'macro', raw: '{{renderer}}' } }, {}] },
        ],
      }),
    )
    expect([...shared]).toEqual([])
  })

  it('reports every shared pid across three layouts, and nothing else', () => {
    const shared = sharedPluginIds(
      resolved({
        layouts: [
          { slots: [pluginSlot('a'), pluginSlot('b')] },
          { slots: [pluginSlot('b'), pluginSlot('c')] },
          { slots: [pluginSlot('c'), pluginSlot('d')] },
        ],
      }),
    )
    expect([...shared].sort()).toEqual(['b', 'c'])
  })

  it('survives layouts with no slots and no layouts at all', () => {
    expect([...sharedPluginIds([])]).toEqual([])
    expect([...sharedPluginIds(resolved({ layouts: [{ slots: [] }, { slots: [] }] }))]).toEqual([])
  })
})

describe('edit operations', () => {
  /** Two layouts, four slots, every source kind — the shapes every operation below has to survive. */
  function fixture(): DockConfig {
    return normalizeConfig({
      layouts: [
        {
          id: 'l_aaaaaa',
          name: 'One',
          axis: 'column',
          slots: [
            { id: 's_111111', weight: 1, source: { kind: 'plugin', pid: 'alpha' } },
            { id: 's_222222', weight: 2, source: { kind: 'macro', raw: ':pomo' } },
            { id: 's_333333', weight: 3, source: { kind: 'none' } },
          ],
        },
        {
          id: 'l_bbbbbb',
          name: 'Two',
          axis: 'row',
          slots: [{ id: 's_444444', weight: 1, source: { kind: 'none' } }],
        },
      ],
    })
  }

  const layoutOf = (config: DockConfig, layoutId: string): Layout => {
    const layout = findLayout(config, layoutId)
    if (layout === null) throw new Error(`no layout ${layoutId} in ${serializeConfig(config)}`)
    return layout
  }
  const slotsOf = (config: DockConfig, layoutId: string): SlotConfig[] => layoutOf(config, layoutId).slots
  const idsOf = (config: DockConfig, layoutId: string): string[] => slotsOf(config, layoutId).map((slot) => slot.id)

  /**
   * Every operation is a pure function over the configuration in force: the input must come back
   * byte-identical, and the result must be a fixed point of normalization (the dock normalizes on the
   * way out, and an operation whose output normalization would *change* is one that cannot be trusted
   * to preserve ids).
   */
  function applyPure(config: DockConfig, op: (input: DockConfig) => DockConfig): DockConfig {
    const before = serializeConfig(config)
    const result = op(config)
    expect(serializeConfig(config)).toBe(before)
    expect(serializeConfig(normalizeConfig(result))).toBe(serializeConfig(result))
    return result
  }

  describe('addLayout', () => {
    it('appends a layout and leaves every existing one exactly as it was', () => {
      const config = fixture()
      const layout = createLayout('New')
      const next = applyPure(config, (input) => addLayout(input, layout))
      expect(next.layouts).toHaveLength(3)
      expect(next.layouts[2]).toBe(layout)
      // Identity, not equality: the surviving layouts are the same objects, so no slot id can move.
      expect(next.layouts[0]).toBe(config.layouts[0])
      expect(next.layouts[1]).toBe(config.layouts[1])
    })
  })

  describe('removeLayout', () => {
    it('drops the named layout and nothing else', () => {
      const config = fixture()
      const next = applyPure(config, (input) => removeLayout(input, 'l_aaaaaa'))
      expect(next.layouts.map((layout) => layout.id)).toEqual(['l_bbbbbb'])
      expect(next.layouts[0]).toBe(config.layouts[1])
    })

    it('keeps the ids of every slot in the layouts that stay', () => {
      // The dock releases the mounts of the ids that VANISHED; an id that moved instead would be read
      // as one slot dying and an unrelated one appearing, remounting a view that never had to move.
      const config = fixture()
      const next = removeLayout(config, 'l_aaaaaa')
      expect(idsOf(next, 'l_bbbbbb')).toEqual(['s_444444'])
    })

    it('returns the configuration itself when the id names nothing', () => {
      const config = fixture()
      expect(removeLayout(config, 'l_cccccc')).toBe(config)
      expect(removeLayout(config, '')).toBe(config)
    })
  })

  describe('renameLayout', () => {
    it('trims the name and truncates it to the tab strip budget', () => {
      const config = fixture()
      expect(layoutOf(applyPure(config, (input) => renameLayout(input, 'l_aaaaaa', '  Notes  ')), 'l_aaaaaa').name).toBe('Notes')
      const long = layoutOf(renameLayout(config, 'l_aaaaaa', 'ABCDEFGHIJKLMNOPQRST'), 'l_aaaaaa').name
      expect(long).toHaveLength(MAX_NAME_LENGTH)
    })

    it('falls back to the positional default for a blank name, by the layout’s own position', () => {
      const config = fixture()
      expect(layoutOf(renameLayout(config, 'l_bbbbbb', '   '), 'l_bbbbbb').name).toBe(defaultLayoutName(1))
    })

    it('touches neither the slots nor the other layouts', () => {
      const config = fixture()
      const next = renameLayout(config, 'l_aaaaaa', 'Renamed')
      expect(layoutOf(next, 'l_aaaaaa').slots).toBe(config.layouts[0].slots)
      expect(next.layouts[1]).toBe(config.layouts[1])
    })

    it('returns the configuration itself when the id names nothing', () => {
      const config = fixture()
      expect(renameLayout(config, 'l_cccccc', 'x')).toBe(config)
    })
  })

  describe('toggleLayoutAxis', () => {
    it('flips in both directions and back', () => {
      const config = fixture()
      const flipped = applyPure(config, (input) => toggleLayoutAxis(input, 'l_aaaaaa'))
      expect(layoutOf(flipped, 'l_aaaaaa').axis).toBe('row')
      expect(layoutOf(toggleLayoutAxis(flipped, 'l_aaaaaa'), 'l_aaaaaa').axis).toBe('column')
      expect(layoutOf(toggleLayoutAxis(config, 'l_bbbbbb'), 'l_bbbbbb').axis).toBe('column')
    })

    it('keeps the slots of the layout it flips', () => {
      const config = fixture()
      expect(idsOf(toggleLayoutAxis(config, 'l_aaaaaa'), 'l_aaaaaa')).toEqual(idsOf(config, 'l_aaaaaa'))
    })

    it('returns the configuration itself when the id names nothing', () => {
      const config = fixture()
      expect(toggleLayoutAxis(config, 'l_cccccc')).toBe(config)
    })
  })

  describe('addSlot', () => {
    it('appends a slot with a fresh id, leaving its siblings untouched', () => {
      const config = fixture()
      const next = applyPure(config, (input) => addSlot(input, 'l_aaaaaa'))
      const slots = slotsOf(next, 'l_aaaaaa')
      expect(slots).toHaveLength(4)
      expect(slots.slice(0, 3)).toEqual(config.layouts[0].slots)
      expect(slots[3].id).toMatch(SLOT_ID)
      expect(idsOf(next, 'l_aaaaaa').slice(0, 3)).toEqual(['s_111111', 's_222222', 's_333333'])
      expect(slots[3].source).toEqual({ kind: 'none' })
    })

    it('gives the newcomer the MEAN of its siblings, not a flat default', () => {
      // Weights are absolute shares nothing renormalizes: a weight-1 newcomer among 0.2s would take
      // five times the room and squeeze every existing view onto its px floor.
      expect(slotsOf(addSlot(fixture(), 'l_aaaaaa'), 'l_aaaaaa')[3].weight).toBe(2)
      const squeezed = normalizeConfig({ layouts: [{ id: 'l_aaaaaa', slots: [{ weight: 0.2 }, { weight: 0.2 }] }] })
      expect(slotsOf(addSlot(squeezed, 'l_aaaaaa'), 'l_aaaaaa')[2].weight).toBe(0.2)
    })

    it('gives the first slot of an empty layout the default weight', () => {
      const config = normalizeConfig({ layouts: [{ id: 'l_aaaaaa', slots: [] }] })
      expect(slotsOf(addSlot(config, 'l_aaaaaa'), 'l_aaaaaa')[0].weight).toBe(DEFAULT_WEIGHT)
    })

    it('keeps the derived weight on the stored grid', () => {
      const config = normalizeConfig({ layouts: [{ id: 'l_aaaaaa', slots: [{ weight: 1 }, { weight: 2 }] }] })
      // (1 + 2) / 2 is exact, but 1/3-style means are not — the value still has to be a stored weight.
      const thirds = normalizeConfig({ layouts: [{ id: 'l_aaaaaa', slots: [{ weight: 1 }, { weight: 0.3333 }] }] })
      expect(slotsOf(addSlot(config, 'l_aaaaaa'), 'l_aaaaaa')[2].weight).toBe(1.5)
      expect(slotsOf(addSlot(thirds, 'l_aaaaaa'), 'l_aaaaaa')[2].weight).toBe(0.6667)
    })

    it('takes an initial source', () => {
      const next = addSlot(fixture(), 'l_bbbbbb', { kind: 'plugin', pid: 'beta' })
      expect(slotsOf(next, 'l_bbbbbb')[1].source).toEqual({ kind: 'plugin', pid: 'beta' })
    })

    it('refuses to go past the cap, and returns the configuration itself', () => {
      const config = normalizeConfig({
        layouts: [{ id: 'l_aaaaaa', slots: Array.from({ length: MAX_SLOTS_PER_LAYOUT }, () => ({})) }],
      })
      expect(addSlot(config, 'l_aaaaaa')).toBe(config)
    })

    it('returns the configuration itself when the id names nothing', () => {
      const config = fixture()
      expect(addSlot(config, 'l_cccccc')).toBe(config)
    })
  })

  describe('removeSlot', () => {
    it('drops one slot and preserves the ids of the ones that stay', () => {
      // A surviving slot whose id changed would be torn down and remounted: the id is the mount key,
      // the slot element’s DOM id, the macro wrapper’s getElementById target and the embed `slot`.
      const config = fixture()
      const next = applyPure(config, (input) => removeSlot(input, 's_222222'))
      expect(idsOf(next, 'l_aaaaaa')).toEqual(['s_111111', 's_333333'])
      expect(slotsOf(next, 'l_aaaaaa')[0]).toBe(config.layouts[0].slots[0])
      expect(slotsOf(next, 'l_aaaaaa')[1]).toBe(config.layouts[0].slots[2])
      expect(slotsOf(next, 'l_aaaaaa').map((slot) => slot.weight)).toEqual([1, 3])
    })

    it('finds a slot in any layout, and leaves the others alone', () => {
      const config = fixture()
      const next = removeSlot(config, 's_444444')
      expect(idsOf(next, 'l_bbbbbb')).toEqual([])
      expect(next.layouts[0]).toBe(config.layouts[0])
    })

    it('returns the configuration itself when the id names nothing', () => {
      const config = fixture()
      expect(removeSlot(config, 's_999999')).toBe(config)
      expect(removeSlot(config, '')).toBe(config)
    })
  })

  describe('moveSlot', () => {
    it('swaps two slots without rebuilding either of them', () => {
      const config = fixture()
      const next = applyPure(config, (input) => moveSlot(input, 's_222222', -1))
      expect(idsOf(next, 'l_aaaaaa')).toEqual(['s_222222', 's_111111', 's_333333'])
      expect(slotsOf(next, 'l_aaaaaa')[0]).toBe(config.layouts[0].slots[1])
      expect(slotsOf(next, 'l_aaaaaa')[1]).toBe(config.layouts[0].slots[0])
    })

    it('moves later as well as earlier', () => {
      expect(idsOf(moveSlot(fixture(), 's_222222', 1), 'l_aaaaaa')).toEqual(['s_111111', 's_333333', 's_222222'])
    })

    it('carries each slot’s own weight and source with it', () => {
      const moved = slotsOf(moveSlot(fixture(), 's_333333', -1), 'l_aaaaaa')
      expect(moved.map((slot) => slot.weight)).toEqual([1, 3, 2])
      expect(moved[1].source).toEqual({ kind: 'none' })
      expect(moved[2].source).toEqual({ kind: 'macro', raw: ':pomo' })
    })

    it('is a no-op at either end of the list', () => {
      const config = fixture()
      expect(moveSlot(config, 's_111111', -1)).toBe(config)
      expect(moveSlot(config, 's_333333', 1)).toBe(config)
      expect(moveSlot(config, 's_444444', -1)).toBe(config)
      expect(moveSlot(config, 's_444444', 1)).toBe(config)
    })

    it('is a no-op for a step that goes nowhere or is not a whole number of places', () => {
      const config = fixture()
      expect(moveSlot(config, 's_222222', 0)).toBe(config)
      expect(moveSlot(config, 's_222222', 0.5)).toBe(config)
      expect(moveSlot(config, 's_222222', Number.NaN)).toBe(config)
    })

    it('never reaches out of the slot’s own layout, however far the step goes', () => {
      const config = fixture()
      expect(moveSlot(config, 's_111111', 5)).toBe(config)
      expect(moveSlot(config, 's_999999', 1)).toBe(config)
    })
  })

  describe('setSlotSource', () => {
    it('repoints a slot while keeping its id and weight', () => {
      const config = fixture()
      const next = applyPure(config, (input) => setSlotSource(input, 's_222222', { kind: 'plugin', pid: 'beta' }))
      expect(slotsOf(next, 'l_aaaaaa')[1]).toEqual({ id: 's_222222', weight: 2, source: { kind: 'plugin', pid: 'beta' } })
      expect(idsOf(next, 'l_aaaaaa')).toEqual(idsOf(config, 'l_aaaaaa'))
    })

    it('clears a slot to `none`', () => {
      expect(slotsOf(setSlotSource(fixture(), 's_111111', { kind: 'none' }), 'l_aaaaaa')[0].source).toEqual({ kind: 'none' })
    })

    it('returns the configuration itself when the id names nothing', () => {
      const config = fixture()
      expect(setSlotSource(config, 's_999999', { kind: 'none' })).toBe(config)
    })
  })

  describe('setSlotMacroMode', () => {
    it('keeps a spec that was already typed — re-picking "macro…" is not "clear it"', () => {
      // The picker’s value round-trips through the host on every assert, so selecting the entry that
      // is already selected is an ordinary thing for a user to do.
      const config = fixture()
      const next = applyPure(config, (input) => setSlotMacroMode(input, 's_222222'))
      expect(slotsOf(next, 'l_aaaaaa')[1].source).toEqual({ kind: 'macro', raw: ':pomo' })
    })

    it('starts blank when the slot was showing something else', () => {
      for (const slotId of ['s_111111', 's_333333']) {
        expect(slotsOf(setSlotMacroMode(fixture(), slotId), 'l_aaaaaa')[slotId === 's_111111' ? 0 : 2].source).toEqual({
          kind: 'macro',
          raw: '',
        })
      }
    })

    it('returns the configuration itself when the id names nothing', () => {
      const config = fixture()
      expect(setSlotMacroMode(config, 's_999999')).toBe(config)
    })
  })

  describe('setSlotMacro', () => {
    it('stores the spec, blank included — that is "macro picked, nothing typed yet"', () => {
      const config = fixture()
      const next = applyPure(config, (input) => setSlotMacro(input, 's_333333', '{{renderer :a, 2}}'))
      expect(slotsOf(next, 'l_aaaaaa')[2].source).toEqual({ kind: 'macro', raw: '{{renderer :a, 2}}' })
      expect(slotsOf(setSlotMacro(config, 's_222222', ''), 'l_aaaaaa')[1].source).toEqual({ kind: 'macro', raw: '' })
    })

    it('returns the configuration itself when the id names nothing', () => {
      const config = fixture()
      expect(setSlotMacro(config, 's_999999', ':a')).toBe(config)
    })
  })

  describe('setLayoutWeights', () => {
    it('bakes a finished drag, keeping ids and sources', () => {
      const config = fixture()
      const next = applyPure(config, (input) => setLayoutWeights(input, 'l_aaaaaa', [1.25, 2.5, 2.25]))
      expect(slotsOf(next, 'l_aaaaaa').map((slot) => slot.weight)).toEqual([1.25, 2.5, 2.25])
      expect(idsOf(next, 'l_aaaaaa')).toEqual(['s_111111', 's_222222', 's_333333'])
      expect(slotsOf(next, 'l_aaaaaa')[0].source).toEqual({ kind: 'plugin', pid: 'alpha' })
    })

    it('brings every weight onto the stored grid', () => {
      const next = setLayoutWeights(fixture(), 'l_aaaaaa', [-5, 1 / 3, 1e6])
      expect(slotsOf(next, 'l_aaaaaa').map((slot) => slot.weight)).toEqual([WEIGHT_MIN, 0.3333, WEIGHT_MAX])
    })

    it('refuses a positional array that no longer matches the layout', () => {
      // An assert (or another surface) can add or remove a slot while the pointer is still down.
      const config = fixture()
      expect(setLayoutWeights(config, 'l_aaaaaa', [1, 2])).toBe(config)
      expect(setLayoutWeights(config, 'l_aaaaaa', [1, 2, 3, 4])).toBe(config)
      expect(setLayoutWeights(config, 'l_cccccc', [1])).toBe(config)
    })
  })

  describe('isSlotConfigured / layoutHasContent', () => {
    it('counts a plugin pick and a typed macro, but not an empty slot or a bare macro mode', () => {
      const slot = (source: SlotConfig['source']): SlotConfig => ({ ...createSlot(source) })
      expect(isSlotConfigured(slot({ kind: 'plugin', pid: 'a' }))).toBe(true)
      expect(isSlotConfigured(slot({ kind: 'macro', raw: ':pomo' }))).toBe(true)
      expect(isSlotConfigured(slot({ kind: 'none' }))).toBe(false)
      // "macro picked, nothing typed yet" renders as an empty slot, so dropping it costs nothing.
      expect(isSlotConfigured(slot({ kind: 'macro', raw: '' }))).toBe(false)
      expect(isSlotConfigured(slot({ kind: 'macro', raw: '   ' }))).toBe(false)
    })

    it('reports a layout as holding content when any one of its slots does', () => {
      const config = fixture()
      expect(layoutHasContent(layoutOf(config, 'l_aaaaaa'))).toBe(true)
      expect(layoutHasContent(layoutOf(config, 'l_bbbbbb'))).toBe(false)
      expect(layoutHasContent(createLayout())).toBe(false)
      expect(layoutHasContent(layoutOf(normalizeConfig({ layouts: [{ id: 'l_aaaaaa', slots: [] }] }), 'l_aaaaaa'))).toBe(false)
    })
  })

  describe('id stability across a session of edits', () => {
    it('never renames a slot that survives a reorder, an insertion or a removal', () => {
      let config = fixture()
      config = addSlot(config, 'l_aaaaaa')
      const added = idsOf(config, 'l_aaaaaa')[3]
      config = moveSlot(config, added, -1)
      config = removeSlot(config, 's_111111')
      config = moveSlot(config, 's_333333', -1)
      config = setSlotSource(config, 's_222222', { kind: 'plugin', pid: 'gamma' })
      expect(idsOf(config, 'l_aaaaaa')).toEqual(['s_222222', 's_333333', added])
      // And the other layout has not so much as been copied.
      expect(idsOf(config, 'l_bbbbbb')).toEqual(['s_444444'])
    })

    it('survives the write path the dock actually uses — serialize, echo, parse, normalize', () => {
      const config = removeSlot(addSlot(fixture(), 'l_bbbbbb'), 's_222222')
      const stored = serializeConfig(normalizeConfig(config))
      const echoed = parseConfig(stored)
      expect(serializeConfig(expectConfig(echoed))).toBe(stored)
      expect(idsOf(expectConfig(echoed), 'l_aaaaaa')).toEqual(['s_111111', 's_333333'])
    })
  })
})

describe('specSignature', () => {
  it('tells the four kinds apart even when they carry the same text', () => {
    const signatures = [
      specSignature({ kind: 'none' }),
      specSignature({ kind: 'plugin', pid: 'x' }),
      specSignature({ kind: 'macro', raw: 'x', args: ['x'] }),
      specSignature({ kind: 'invalid-macro', raw: 'x' }),
    ]
    expect(new Set(signatures).size).toBe(4)
  })

  it('ignores the parsed arguments, which are a function of the raw spec', () => {
    expect(specSignature({ kind: 'macro', raw: ':a', args: [':a'] })).toBe(specSignature({ kind: 'macro', raw: ':a', args: [] }))
    expect(specSignature({ kind: 'macro', raw: ':a' , args: [] })).not.toBe(specSignature({ kind: 'macro', raw: ':b', args: [] }))
  })
})
