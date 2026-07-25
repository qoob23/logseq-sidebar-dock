/**
 * The dock's layout configuration — pure model, no DOM and no `@logseq/libs`. See
 * `docs/layout-config.md`.
 *
 * Many named layouts, each with any number of slots, all editable from the dock's own UI. The whole
 * thing lives in ONE settings key as canonical JSON (`layouts`), so this file owns three things the
 * rest of the plugin depends on being exact:
 *
 * 1. **Ids that never move.** Slot ids are the wipe-vs-eviction discriminator of the embed protocol
 *    (host rule 4), the `getElementById` target of a macro wrapper, the `slot` field of the protocol
 *    payload and the key of the dock's mount map. Positional ids (`slot-0`) would make inserting one
 *    slot read as a wave of false remounts and evictions, so ids are generated once and never derived
 *    from position.
 * 2. **Total normalization.** Anything the host (or a hand edit of the raw JSON) hands back becomes a
 *    complete, in-range {@link DockConfig} without throwing.
 * 3. **Canonical serialization.** `settingsDiffer` compares the settings strings with `!==`, so a
 *    non-deterministic key order would make every host echo read as a change and drive a
 *    self-sustaining assert loop.
 */

import { parseMacroSpec } from './macro'

/** Direction the slots of one layout are stacked in. */
export type SlotAxis = 'column' | 'row'

/** What the user picked for a slot, as stored. The resolved form is {@link ViewSpec}. */
export type SlotSource =
  /** Nothing picked yet — the slot still exists and shows the "pick a view" placeholder. */
  | { kind: 'none' }
  /** A plugin's view, mounted through the embed protocol or by adopting its main UI. */
  | { kind: 'plugin'; pid: string }
  /**
   * A `{{renderer …}}` macro. `raw` may be blank: picking "macro" in the editor has to persist before
   * a spec has been typed, or the text input would vanish on the round trip through the host.
   */
  | { kind: 'macro'; raw: string }

export interface SlotConfig {
  /** `s_` + 6 hex digits. Globally unique across ALL layouts — it keys the dock's mount map. */
  id: string
  /** `flex-grow` share of the layout, in `[WEIGHT_MIN, WEIGHT_MAX]`. */
  weight: number
  source: SlotSource
}

export interface Layout {
  /** `l_` + 6 hex digits. */
  id: string
  name: string
  axis: SlotAxis
  slots: SlotConfig[]
}

export interface DockConfig {
  version: 2
  layouts: Layout[]
}

/** The schema version this build reads and writes. There are no v1 users, so there is no migration. */
export const CONFIG_VERSION = 2

/** Tab strip budget — a longer name would wrap the strip into uselessness. */
export const MAX_NAME_LENGTH = 12
/** Sanity backstop, not a product limit. */
export const MAX_SLOTS_PER_LAYOUT = 12
export const WEIGHT_MIN = 0.05
export const WEIGHT_MAX = 20
export const DEFAULT_WEIGHT = 1

const LAYOUT_ID_PREFIX = 'l_'
const SLOT_ID_PREFIX = 's_'

/**
 * Ids we accept as-is. Anything else is regenerated, because an id reaches CSS unescaped: slot ids
 * become `--sdock-w-<id>` custom properties and `[data-slot-id="…"]` selectors, so a hand-edited id
 * with punctuation in it would silently break (or escape from) the stylesheet.
 */
const ID_BODY_PATTERN = /^[0-9a-f]{6}$/

function isWellFormedId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.startsWith(prefix) && ID_BODY_PATTERN.test(value.slice(prefix.length))
}

function randomId(prefix: string): string {
  return (
    prefix +
    Math.floor(Math.random() * 0x100_0000)
      .toString(16)
      .padStart(6, '0')
  )
}

export function newLayoutId(): string {
  return randomId(LAYOUT_ID_PREFIX)
}

export function newSlotId(): string {
  return randomId(SLOT_ID_PREFIX)
}

/** A fresh id of the given flavour that is not in `used`; the id is added to `used`. */
function freshId(prefix: string, used: Set<string>): string {
  let id = randomId(prefix)
  while (used.has(id)) id = randomId(prefix)
  used.add(id)
  return id
}

/** An empty configuration. A fresh object every call — {@link Layout.slots} is mutated in place. */
export function emptyConfig(): DockConfig {
  return { version: CONFIG_VERSION, layouts: [] }
}

/** A new slot, unweighted and unassigned. */
export function createSlot(source: SlotSource = { kind: 'none' }): SlotConfig {
  return { id: newSlotId(), weight: DEFAULT_WEIGHT, source }
}

/**
 * A new layout carrying one empty slot — a tab with nothing in it at all cannot be filled from the
 * edit UI, since every control hangs off a slot box.
 *
 * A blank `name` is intentional and useful: {@link normalizeConfig} then fills in `Layout <n>` for
 * whatever position the layout ends up in.
 */
export function createLayout(name = ''): Layout {
  return { id: newLayoutId(), name, axis: 'column', slots: [createSlot()] }
}

/** Fallback name for a layout the user never named, `n` being its 0-based position. */
export function defaultLayoutName(index: number): string {
  return `Layout ${index + 1}`
}

/** The layout with this id, or `null` — an `activeTab` naming a deleted layout must fall back to nav. */
export function findLayout(config: DockConfig, layoutId: string): Layout | null {
  return config.layouts.find((layout) => layout.id === layoutId) ?? null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

function asArray(raw: unknown): readonly unknown[] {
  return Array.isArray(raw) ? (raw as readonly unknown[]) : []
}

function readId(source: Record<string, unknown>, prefix: string, used: Set<string>): string {
  const value = source['id']
  if (isWellFormedId(value, prefix) && !used.has(value)) {
    used.add(value)
    return value
  }
  return freshId(prefix, used)
}

/**
 * Bring any number onto the stored weight grid: finite, in range, four decimals. The one place the
 * weight rules are applied, so normalization and the edit operations cannot drift apart.
 */
function cleanWeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WEIGHT
  return round4(clamp(value, WEIGHT_MIN, WEIGHT_MAX))
}

/** Numeric strings are accepted too — the raw-JSON escape hatch invites `"weight": "2"`. */
function readWeight(source: Record<string, unknown>): number {
  const value = source['weight']
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  return cleanWeight(parsed)
}

/**
 * Anything that is not exactly `row` is a column — the axis is a two-value enum with a safe default,
 * and guessing at `'horizontal'`/`true`/`1` would just be a different way of being wrong.
 */
function readAxis(source: Record<string, unknown>): SlotAxis {
  return source['axis'] === 'row' ? 'row' : 'column'
}

/**
 * A source we cannot make sense of degrades to `none` rather than dropping the slot: the slot box is
 * the only thing the edit UI can hang controls off, so losing it would leave the user nothing to fix.
 */
function readSource(raw: unknown): SlotSource {
  const source = asRecord(raw)
  if (source === null) return { kind: 'none' }
  const kind = source['kind']
  if (kind === 'plugin') {
    const pid = source['pid']
    const trimmed = typeof pid === 'string' ? pid.trim() : ''
    return trimmed === '' ? { kind: 'none' } : { kind: 'plugin', pid: trimmed }
  }
  if (kind === 'macro') {
    const raw2 = source['raw']
    return { kind: 'macro', raw: typeof raw2 === 'string' ? raw2.trim() : '' }
  }
  return { kind: 'none' }
}

function normalizeSlots(raw: unknown, usedSlotIds: Set<string>): SlotConfig[] {
  const slots: SlotConfig[] = []
  for (const entry of asArray(raw)) {
    if (slots.length >= MAX_SLOTS_PER_LAYOUT) break
    const source = asRecord(entry)
    if (source === null) continue
    slots.push({
      id: readId(source, SLOT_ID_PREFIX, usedSlotIds),
      weight: readWeight(source),
      source: readSource(source['source']),
    })
  }
  return slots
}

function normalizeName(raw: unknown, index: number): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  const name = trimmed === '' ? defaultLayoutName(index) : trimmed
  return name.slice(0, MAX_NAME_LENGTH)
}

/**
 * Coerce anything into a complete {@link DockConfig}. Total: never throws, never rejects.
 *
 * Malformed layout/slot entries are dropped, everything else is repaired in place. Slot ids are made
 * unique across the WHOLE config, not per layout, because the dock's mount map is keyed on the bare
 * slot id — two layouts sharing one would fight over a single mount record.
 */
export function normalizeConfig(raw: unknown): DockConfig {
  const source = asRecord(raw)
  const usedLayoutIds = new Set<string>()
  const usedSlotIds = new Set<string>()
  const layouts: Layout[] = []

  for (const entry of asArray(source?.['layouts'])) {
    const record = asRecord(entry)
    if (record === null) continue
    layouts.push({
      id: readId(record, LAYOUT_ID_PREFIX, usedLayoutIds),
      name: normalizeName(record['name'], layouts.length),
      axis: readAxis(record),
      slots: normalizeSlots(record['slots'], usedSlotIds),
    })
  }
  return { version: CONFIG_VERSION, layouts }
}

/** Outcome of reading the `layouts` settings string. */
export type ParseResult =
  | { ok: true; config: DockConfig }
  | { ok: false; raw: string; error: string }

/**
 * Read the stored JSON blob.
 *
 * Parse failure is NOT normalization: a non-blank string that is not valid JSON leaves the dock in a
 * diagnostic state in which it **must not write the `layouts` key**, or one typo in the raw-JSON
 * escape hatch destroys the user's whole configuration. A string that parses but holds junk is not a
 * failure — it goes through {@link normalizeConfig} like anything else. Blank is the initial state and
 * means "no layouts yet".
 */
export function parseConfig(raw: string): ParseResult {
  if (raw.trim() === '') return { ok: true, config: emptyConfig() }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, raw, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, config: normalizeConfig(parsed) }
}

function serializeSource(source: SlotSource): string {
  switch (source.kind) {
    case 'plugin':
      return `{"kind":"plugin","pid":${JSON.stringify(source.pid)}}`
    case 'macro':
      return `{"kind":"macro","raw":${JSON.stringify(source.raw)}}`
    case 'none':
      return '{"kind":"none"}'
  }
}

function serializeSlot(slot: SlotConfig): string {
  const weight = Number.isFinite(slot.weight) ? round4(slot.weight) : DEFAULT_WEIGHT
  return `{"id":${JSON.stringify(slot.id)},"weight":${weight},"source":${serializeSource(slot.source)}}`
}

function serializeLayout(layout: Layout): string {
  const slots = layout.slots.map(serializeSlot).join(',')
  return [
    `{"id":${JSON.stringify(layout.id)}`,
    `"name":${JSON.stringify(layout.name)}`,
    `"axis":${JSON.stringify(layout.axis)}`,
    `"slots":[${slots}]}`,
  ].join(',')
}

/**
 * Canonical JSON: fixed key order, no whitespace, hand-rolled rather than `JSON.stringify` because
 * key order is load-bearing, not cosmetic. `settingsDiffer` compares these strings with `!==`, so any
 * reordering between two writes of the same configuration would look like a change and re-trigger the
 * assert that produced it.
 */
export function serializeConfig(config: DockConfig): string {
  const layouts = config.layouts.map(serializeLayout).join(',')
  return `{"version":${CONFIG_VERSION},"layouts":[${layouts}]}`
}

/* ---------------------------------------------------------------------- edit operations
 *
 * Everything the dock's edit mode does to the configuration, as pure functions: each one takes the
 * configuration in force and returns a NEW one, never touching the input.
 *
 * Everything that did not change is carried over BY REFERENCE, and that structural sharing is the
 * point rather than an optimization detail. A slot that survives an edit is literally the same object,
 * so its id survives too — and a slot id is not cosmetic: it is the key of the dock's mount map, the
 * `id` of the slot element, the `getElementById` target of a macro wrapper and the `slot` field of the
 * embed payload. Renaming a surviving slot (which is what positional ids, or a rebuild-everything
 * edit, would amount to) tears down a live plugin view and remounts it.
 *
 * An operation with nothing to do — an id that names nothing, a move off the end of the list, a layout
 * already at the slot cap — returns the input configuration itself, unchanged and identical.
 *
 * Caps and clamps are NOT re-stated here: names go through the same {@link normalizeName} the
 * normalizer uses, weights through the same weight grid, and the slot cap through
 * {@link MAX_SLOTS_PER_LAYOUT}. The dock normalizes on the way out regardless, so these calls are
 * about the returned value being immediately correct, not about being the last line of defence.
 */

/** Replace the layout with this id, sharing every other layout (and all their slots). */
function withLayout(config: DockConfig, layoutId: string, fn: (layout: Layout) => Layout): DockConfig {
  const at = config.layouts.findIndex((layout) => layout.id === layoutId)
  if (at === -1) return config
  const next = fn(config.layouts[at])
  if (next === config.layouts[at]) return config
  const layouts = [...config.layouts]
  layouts[at] = next
  return { version: CONFIG_VERSION, layouts }
}

/** Replace the layout that HOLDS this slot, handing `fn` the slot's index in it. */
function withSlotLayout(
  config: DockConfig,
  slotId: string,
  fn: (layout: Layout, index: number) => Layout,
): DockConfig {
  for (const layout of config.layouts) {
    const at = layout.slots.findIndex((slot) => slot.id === slotId)
    if (at !== -1) return withLayout(config, layout.id, (found) => fn(found, at))
  }
  return config
}

/** Replace one slot of a layout, keeping every sibling object — and therefore every sibling id. */
function withSlot(layout: Layout, index: number, fn: (slot: SlotConfig) => SlotConfig): Layout {
  const next = fn(layout.slots[index])
  if (next === layout.slots[index]) return layout
  const slots = [...layout.slots]
  slots[index] = next
  return { ...layout, slots }
}

/** Append a layout, e.g. one straight out of {@link createLayout}. */
export function addLayout(config: DockConfig, layout: Layout): DockConfig {
  return { version: CONFIG_VERSION, layouts: [...config.layouts, layout] }
}

/**
 * Drop a layout and everything in it. The dock releases the mounts of its slots through its own
 * teardown paths — the slot ids simply vanish from the configuration, which is the signal it acts on.
 */
export function removeLayout(config: DockConfig, layoutId: string): DockConfig {
  const layouts = config.layouts.filter((layout) => layout.id !== layoutId)
  return layouts.length === config.layouts.length ? config : { version: CONFIG_VERSION, layouts }
}

/**
 * Rename a layout. A blank name is not rejected — it falls back to `Layout <n>` for the layout's own
 * position, exactly as it would on the next normalization pass, so the tab never loses its label.
 */
export function renameLayout(config: DockConfig, layoutId: string, name: string): DockConfig {
  const index = config.layouts.findIndex((layout) => layout.id === layoutId)
  if (index === -1) return config
  return withLayout(config, layoutId, (layout) => ({ ...layout, name: normalizeName(name, index) }))
}

/** Flip a layout between stacking its slots and laying them out side by side. */
export function toggleLayoutAxis(config: DockConfig, layoutId: string): DockConfig {
  return withLayout(config, layoutId, (layout) => ({
    ...layout,
    axis: layout.axis === 'row' ? 'column' : 'row',
  }))
}

/**
 * The weight a slot added to `slots` should carry: the MEAN of what is already there.
 *
 * Not a flat {@link DEFAULT_WEIGHT}, because weights are absolute `flex-grow` shares that nothing ever
 * renormalizes (see `divider.ts`): in a layout whose slots have been dragged down to 0.2 each, a
 * newcomer at 1 would take five times the room of every existing view and squeeze them onto their px
 * floor. The mean gives it an equal share of what its siblings hold, whatever scale they are on.
 */
function siblingWeight(slots: readonly SlotConfig[]): number {
  if (slots.length === 0) return DEFAULT_WEIGHT
  const total = slots.reduce((sum, slot) => sum + (Number.isFinite(slot.weight) ? slot.weight : DEFAULT_WEIGHT), 0)
  return cleanWeight(total / slots.length)
}

/** Append a slot to a layout, or return the configuration untouched if it is already at the cap. */
export function addSlot(config: DockConfig, layoutId: string, source: SlotSource = { kind: 'none' }): DockConfig {
  return withLayout(config, layoutId, (layout) => {
    if (layout.slots.length >= MAX_SLOTS_PER_LAYOUT) return layout
    const slot = { ...createSlot(source), weight: siblingWeight(layout.slots) }
    return { ...layout, slots: [...layout.slots, slot] }
  })
}

/** Drop one slot, wherever it lives. Its siblings keep their objects, their ids and their weights. */
export function removeSlot(config: DockConfig, slotId: string): DockConfig {
  return withSlotLayout(config, slotId, (layout, index) => ({
    ...layout,
    slots: layout.slots.filter((_unused, at) => at !== index),
  }))
}

/**
 * Move a slot `step` places along its layout's axis (negative moves it earlier).
 *
 * A swap of two existing slot OBJECTS, never a rebuild: reordering already costs an iframe reboot for
 * the slots whose DOM position changes, and regenerating ids would add a full unmount/remount of every
 * slot in the layout on top of it. A move that would run off either end is a no-op.
 */
export function moveSlot(config: DockConfig, slotId: string, step: number): DockConfig {
  return withSlotLayout(config, slotId, (layout, index) => {
    const target = index + step
    if (!Number.isInteger(target) || target === index) return layout
    if (target < 0 || target >= layout.slots.length) return layout
    const slots = [...layout.slots]
    slots[index] = layout.slots[target]
    slots[target] = layout.slots[index]
    return { ...layout, slots }
  })
}

/** Point a slot at a different source. The slot keeps its id and its weight. */
export function setSlotSource(config: DockConfig, slotId: string, source: SlotSource): DockConfig {
  return withSlotLayout(config, slotId, (layout, index) =>
    withSlot(layout, index, (slot) => ({ ...slot, source })),
  )
}

/**
 * Switch a slot to macro mode, keeping any spec already typed into it.
 *
 * Re-picking `macro…` in the source `<select>` must not read as "clear the spec": the picker's value
 * round-trips through the host on every assert, so the user re-selecting the entry that is already
 * selected is an ordinary thing to happen.
 */
export function setSlotMacroMode(config: DockConfig, slotId: string): DockConfig {
  return withSlotLayout(config, slotId, (layout, index) =>
    withSlot(layout, index, (slot) => ({
      ...slot,
      source: { kind: 'macro', raw: slot.source.kind === 'macro' ? slot.source.raw : '' },
    })),
  )
}

/** Set a slot's macro spec. Blank is legal — it is "macro mode picked, nothing typed yet". */
export function setSlotMacro(config: DockConfig, slotId: string, raw: string): DockConfig {
  return setSlotSource(config, slotId, { kind: 'macro', raw })
}

/**
 * Bake the weights a finished divider drag produced.
 *
 * Positional, so it applies only while the layout still has exactly that many slots: an assert (or
 * another surface's edit) can have added or removed one while the pointer was down, and writing a
 * mismatched array would silently re-weight the wrong slots.
 */
export function setLayoutWeights(
  config: DockConfig,
  layoutId: string,
  weights: readonly number[],
): DockConfig {
  return withLayout(config, layoutId, (layout) => {
    if (layout.slots.length !== weights.length) return layout
    return { ...layout, slots: layout.slots.map((slot, at) => ({ ...slot, weight: cleanWeight(weights[at]) })) }
  })
}

/**
 * Has the user actually put something in this slot?
 *
 * A macro pick with nothing typed yet is a MODE, not content — {@link resolveLayoutSlots} renders it
 * as an empty slot — so it does not count. The dock asks this to decide which removals are destructive
 * enough to need confirming: dropping an empty slot costs nothing, dropping a filled one is a click
 * away from losing a view the user configured and cannot get back with an undo.
 */
export function isSlotConfigured(slot: SlotConfig): boolean {
  switch (slot.source.kind) {
    case 'none':
      return false
    case 'plugin':
      return true
    case 'macro':
      return slot.source.raw.trim() !== ''
  }
}

/** Would dropping this layout throw configured slots away? See {@link isSlotConfigured}. */
export function layoutHasContent(layout: Layout): boolean {
  return layout.slots.some(isSlotConfigured)
}

/** What one slot is asked to show, after the source has been resolved. */
export type ViewSpec =
  /** Nothing to show — the slot carries the "pick a view" placeholder. */
  | { kind: 'none' }
  /** A plugin's view, mounted through the embed protocol or by adopting its main UI. */
  | { kind: 'plugin'; pid: string }
  /** A renderer macro, mounted by re-emitting the host's own macro hook. */
  | { kind: 'macro'; raw: string; args: readonly string[] }
  /**
   * A non-blank macro spec that parses to nothing. Kept distinct from `none` on purpose: silently
   * showing an empty slot would hide the typo the user needs to see.
   */
  | { kind: 'invalid-macro'; raw: string }

export interface ResolvedSlot {
  id: string
  weight: number
  spec: ViewSpec
}

/**
 * The slots of one layout as the DOM will actually realise them.
 *
 * Every configured slot always comes back as a slot box, `none` included — with N slots the v1
 * `both | top-only | bottom-only | empty` collapse is meaningless, and the edit UI needs empty slots
 * to be visible and clickable.
 *
 * A pid used twice in the SAME layout only fills the first of them: a plugin's view is a single DOM
 * node, so two simultaneously visible slots cannot both hold it, and leaving the second one open for
 * a view that can never arrive would just look broken. Across layouts the restriction does not apply
 * (only one layout is visible at a time), and macros carry no restriction at all — each slot gets its
 * own injected copy.
 */
export function resolveLayoutSlots(layout: Layout): readonly ResolvedSlot[] {
  const claimed = new Set<string>()
  return layout.slots.map((slot) => ({
    id: slot.id,
    weight: slot.weight,
    spec: resolveSource(slot.source, claimed),
  }))
}

function resolveSource(source: SlotSource, claimed: Set<string>): ViewSpec {
  switch (source.kind) {
    case 'none':
      return { kind: 'none' }
    case 'plugin': {
      if (claimed.has(source.pid)) return { kind: 'none' }
      claimed.add(source.pid)
      return { kind: 'plugin', pid: source.pid }
    }
    case 'macro': {
      const raw = source.raw.trim()
      // Blank is "macro mode picked, nothing typed yet" — an empty slot, not a mistake to report.
      if (raw === '') return { kind: 'none' }
      const args = parseMacroSpec(raw)
      return args === null ? { kind: 'invalid-macro', raw } : { kind: 'macro', raw, args }
    }
  }
}

/**
 * Just enough of a resolved layout for the two rules below.
 *
 * Structural on purpose: the dock's own `LayoutView` and the stylesheet's `ResolvedLayout` both satisfy
 * it, and neither type can be named here — `styles.ts` imports THIS module, so importing back would be
 * a cycle. Both rules are pure functions over resolved layouts and belong next to
 * {@link resolveLayoutSlots}, whose duplicate-pid rule is the very thing {@link sharedPluginIds}
 * has to agree with; `dock.ts` cannot be unit-tested, so nothing that decides a user-visible rule
 * belongs in it.
 */
export interface ResolvedLayoutSlots {
  readonly slots: readonly ResolvedSlot[]
}

/**
 * The order the dock fills layouts in: the active one first, then the rest as configured.
 *
 * A plugin's main UI is a single DOM node, so whichever slot adopts a pid first keeps it — and the
 * layout the user can actually see has to get its turn before any hidden one can claim the same
 * plugin. Generic over the layout shape so the caller keeps its own richer type.
 */
export function fillOrder<T extends { readonly id: string }>(
  layouts: readonly T[],
  activeTab: string,
): readonly T[] {
  const active = layouts.filter((layout) => layout.id === activeTab)
  return [...active, ...layouts.filter((layout) => layout.id !== activeTab)]
}

/**
 * Pids the user has put in more than ONE layout — the edit UI warns about them, because a plugin's one
 * view is stolen back and forth (and reloaded) every time the two tabs are switched between.
 *
 * Counted per layout rather than per slot: a pid repeated inside a single layout is NOT shared, because
 * {@link resolveLayoutSlots} already resolved the repeat to `none` and there is only ever one live
 * mount to fight over. Reading the RESOLVED specs is what makes that fall out — a suppressed duplicate
 * simply is not a `plugin` spec any more.
 */
export function sharedPluginIds(layouts: readonly ResolvedLayoutSlots[]): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const layout of layouts) {
    const own = new Set<string>()
    for (const slot of layout.slots) {
      if (slot.spec.kind === 'plugin') own.add(slot.spec.pid)
    }
    for (const pid of own) counts.set(pid, (counts.get(pid) ?? 0) + 1)
  }
  const shared = new Set<string>()
  for (const [pid, count] of counts) {
    if (count > 1) shared.add(pid)
  }
  return shared
}

/** Stable identity of a resolved spec — see `configSignature`. */
export function specSignature(spec: ViewSpec): string {
  switch (spec.kind) {
    case 'none':
      return 'none'
    case 'plugin':
      return `plugin:${spec.pid}`
    case 'macro':
      return `macro:${spec.raw}`
    case 'invalid-macro':
      return `invalid-macro:${spec.raw}`
  }
}
