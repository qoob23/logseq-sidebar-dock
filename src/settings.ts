/**
 * Pure settings logic — no `@logseq/libs` import, fully unit-testable.
 *
 * `logseq.updateSettings` is fire-and-forget: the local `logseq.settings` object only mutates once the
 * host echoes `settings:changed` back (~0.5-1s later). {@link SettingsStore} therefore keeps the last
 * host-echoed values as a base plus an in-memory override layer that wins until the echo agrees.
 */

import { parseMacroSpec } from './macro'

/** Sentinel value for "no plugin view selected in this slot". */
export const NO_VIEW = 'none'

export const SPLIT_MIN = 15
export const SPLIT_MAX = 85

/** Bounds of the sidebar-width override, deliberately far wider than the host's own 240–460 clamp. */
export const WIDTH_MIN = 180
export const WIDTH_MAX = 1600
/**
 * "No override — the host's own width stands."
 *
 * Zero is not a width anyone could want, so it doubles as the off switch: no rule is emitted into the
 * stylesheet, so the sidebar simply keeps whatever width Logseq gives it — until a drag on the
 * resizer picks one, which is the moment an override is born (see `dock.ts`'s seeded width drag).
 */
export const WIDTH_FOLLOW_HOST = 0

/** Which of the two sidebar faces the segmented control has selected. */
export type DockMode = 'nav' | 'views'

export const DOCK_MODES: readonly DockMode[] = ['nav', 'views']

export interface DockSettings {
  /** `nav` = stock navigation full height; `views` = the two docked views full height. */
  mode: DockMode
  /** Plugin id hosted in the top slot, or {@link NO_VIEW}. */
  viewTop: string
  /** Plugin id hosted in the bottom slot, or {@link NO_VIEW}. */
  viewBottom: string
  /** Renderer macro filling the top slot; non-blank OVERRIDES {@link DockSettings.viewTop}. */
  macroTop: string
  /** Renderer macro filling the bottom slot; non-blank OVERRIDES {@link DockSettings.viewBottom}. */
  macroBottom: string
  /** `pid = models.key` entries, `;`/newline separated — see {@link parseAdoptPokes}. */
  adoptPoke: string
  /** Share (%) of the dock height given to the top slot. */
  splitPct: number
  /** Sidebar width (px) forced on both faces, or {@link WIDTH_FOLLOW_HOST}. */
  sidebarWidthPx: number
}

export const DEFAULT_SETTINGS: DockSettings = {
  mode: 'nav',
  viewTop: NO_VIEW,
  viewBottom: NO_VIEW,
  macroTop: '',
  macroBottom: '',
  adoptPoke: '',
  splitPct: 50,
  sidebarWidthPx: WIDTH_FOLLOW_HOST,
}

const SETTINGS_KEYS = [
  'mode',
  'viewTop',
  'viewBottom',
  'macroTop',
  'macroBottom',
  'adoptPoke',
  'splitPct',
  'sidebarWidthPx',
] as const

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

/** Trim a plugin id; empty/blank is not a selection. */
function cleanId(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function readString(source: Record<string, unknown> | null, key: string, fallback: string): string {
  const value = source?.[key]
  if (typeof value !== 'string') return fallback
  return cleanId(value) ?? fallback
}

function readNumber(
  source: Record<string, unknown> | null,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = source?.[key]
  let parsed: number
  if (typeof value === 'number') {
    parsed = value
  } else if (typeof value === 'string' && value.trim() !== '') {
    parsed = Number(value)
  } else {
    return fallback
  }
  if (!Number.isFinite(parsed)) return fallback
  return round2(clamp(parsed, min, max))
}

/**
 * The sidebar-width override: a clamped px value, or {@link WIDTH_FOLLOW_HOST} for "not overriding".
 *
 * {@link readNumber} cannot express this shape — it would clamp the zero sentinel up to
 * {@link WIDTH_MIN} and silently turn "follow the host" into a 180px sidebar.
 */
function normalizeWidth(value: unknown): number {
  let parsed: number
  if (typeof value === 'number') {
    parsed = value
  } else if (typeof value === 'string' && value.trim() !== '') {
    parsed = Number(value)
  } else {
    return WIDTH_FOLLOW_HOST
  }
  if (!Number.isFinite(parsed) || parsed === 0) return WIDTH_FOLLOW_HOST
  return round2(clamp(parsed, WIDTH_MIN, WIDTH_MAX))
}

/** Anything that is not exactly a known mode falls back to the default (`nav`). */
function readMode(source: Record<string, unknown> | null): DockMode {
  const value = source?.['mode']
  if (typeof value !== 'string') return DEFAULT_SETTINGS.mode
  const mode = value.trim()
  return DOCK_MODES.find((known) => known === mode) ?? DEFAULT_SETTINGS.mode
}

/** Coerce anything the host hands back into a complete, in-range {@link DockSettings}. */
export function normalizeSettings(raw: unknown): DockSettings {
  const source = asRecord(raw)
  return {
    mode: readMode(source),
    viewTop: readString(source, 'viewTop', DEFAULT_SETTINGS.viewTop),
    viewBottom: readString(source, 'viewBottom', DEFAULT_SETTINGS.viewBottom),
    macroTop: readString(source, 'macroTop', DEFAULT_SETTINGS.macroTop),
    macroBottom: readString(source, 'macroBottom', DEFAULT_SETTINGS.macroBottom),
    adoptPoke: readString(source, 'adoptPoke', DEFAULT_SETTINGS.adoptPoke),
    splitPct: readNumber(source, 'splitPct', DEFAULT_SETTINGS.splitPct, SPLIT_MIN, SPLIT_MAX),
    sidebarWidthPx: normalizeWidth(source?.['sidebarWidthPx']),
  }
}

/** Clean a partial patch exactly the way {@link normalizeSettings} cleans a full settings object. */
function normalizePatch(patch: Partial<DockSettings>): Partial<DockSettings> {
  const out: Partial<DockSettings> = {}
  if (patch.mode !== undefined) {
    out.mode = DOCK_MODES.find((known) => known === patch.mode) ?? DEFAULT_SETTINGS.mode
  }
  if (patch.viewTop !== undefined) {
    const id = cleanId(patch.viewTop)
    if (id !== null) out.viewTop = id
  }
  if (patch.viewBottom !== undefined) {
    const id = cleanId(patch.viewBottom)
    if (id !== null) out.viewBottom = id
  }
  // Free-text fields, unlike the plugin selections above: blank is a legitimate value ("no macro",
  // "no pokes"), so a cleared field must survive as '' instead of being dropped as "no change".
  if (patch.macroTop !== undefined) out.macroTop = patch.macroTop.trim()
  if (patch.macroBottom !== undefined) out.macroBottom = patch.macroBottom.trim()
  if (patch.adoptPoke !== undefined) out.adoptPoke = patch.adoptPoke.trim()
  if (patch.splitPct !== undefined && Number.isFinite(patch.splitPct)) {
    out.splitPct = round2(clamp(patch.splitPct, SPLIT_MIN, SPLIT_MAX))
  }
  // Like the free-text fields above and unlike `splitPct`: zero is the legitimate "stop overriding"
  // value, so it must survive the patch instead of being clamped up or dropped as "no change".
  if (patch.sidebarWidthPx !== undefined) out.sidebarWidthPx = normalizeWidth(patch.sidebarWidthPx)
  return out
}

/** True when the two settings objects differ in any field. */
export function settingsDiffer(a: DockSettings, b: DockSettings): boolean {
  return SETTINGS_KEYS.some((key) => a[key] !== b[key])
}

/** What one slot is asked to show, after the macro/plugin precedence has been applied. */
export type ViewSpec =
  /** Nothing configured — the slot carries the "pick a view" placeholder. */
  | { kind: 'none' }
  /** A plugin's view, mounted through the embed protocol or by adopting its main UI. */
  | { kind: 'plugin'; pid: string }
  /** A renderer macro, mounted by re-emitting the host's own macro hook. */
  | { kind: 'macro'; raw: string; args: readonly string[] }
  /**
   * A non-blank macro spec that parses to nothing. Kept distinct from `none` on purpose: silently
   * falling back to the plugin selection would hide the typo the user needs to see.
   */
  | { kind: 'invalid-macro'; raw: string }

/** The resolved spec of each slot. Indexable by `SlotName`. */
export interface SlotSpecs {
  top: ViewSpec
  bottom: ViewSpec
}

/** A configured macro wins over the slot's plugin selection; nothing configured is `none`. */
function resolveSlot(macro: string, pid: string): ViewSpec {
  const raw = macro.trim()
  if (raw !== '') {
    const args = parseMacroSpec(raw)
    return args === null ? { kind: 'invalid-macro', raw } : { kind: 'macro', raw, args }
  }
  return pid === NO_VIEW ? { kind: 'none' } : { kind: 'plugin', pid }
}

/**
 * The selections as the DOM will actually realise them.
 *
 * One plugin's view is a single instance, so the same pid picked twice only fills the top slot — the
 * stylesheet and the mounting code have to agree on that, or the layout would keep a slot open for a
 * view that can never arrive. Macros carry no such restriction: two slots may render the same macro,
 * since each gets its own injected copy.
 */
export function resolveSlotSpecs(settings: DockSettings): SlotSpecs {
  const top = resolveSlot(settings.macroTop, settings.viewTop)
  const bottom = resolveSlot(settings.macroBottom, settings.viewBottom)
  if (top.kind === 'plugin' && bottom.kind === 'plugin' && top.pid === bottom.pid) {
    return { top, bottom: { kind: 'none' } }
  }
  return { top, bottom }
}

function specSignature(spec: ViewSpec): string {
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

/**
 * Signature of everything that decides what each slot renders and which plugin may be poked.
 *
 * The dock remembers per-episode verdicts — "already poked this plugin while its view was missing",
 * "nobody ever answered this macro" — that must not outlive the configuration they were formed
 * under. Comparing this signature drops them exactly when they stop being trustworthy and no more
 * often: it is built from the PARSED poke map, so reformatting that field (or deleting a junk entry
 * that never parsed anyway) changes nothing, and it is order-independent for the same reason.
 */
export function configSignature(adoptPoke: string, specs: SlotSpecs): string {
  const pokes = [...parseAdoptPokes(adoptPoke)].map(([pid, target]) => `${pid}=${target}`).sort()
  return [specSignature(specs.top), specSignature(specs.bottom), ...pokes].join('|')
}

/** Model/command groups `invokeExternalPlugin` can address. */
const POKE_GROUPS: readonly string[] = ['models', 'commands']

/**
 * Parse the adopt-poke configuration: `pid = models.someKey; other-pid = commands.some-key`,
 * separated by `;` or newlines.
 *
 * Some plugins only build their main UI once their toggle model or command has run, so there is
 * nothing to adopt until something invokes it. The value is the `invokeExternalPlugin` path suffix,
 * so only the two groups it understands are accepted — a malformed entry is dropped rather than
 * guessed at, since a wrong invocation lands in someone else's plugin.
 */
export function parseAdoptPokes(raw: string): ReadonlyMap<string, string> {
  const pokes = new Map<string, string>()
  for (const entry of raw.split(/[;\n]/)) {
    const eq = entry.indexOf('=')
    if (eq === -1) continue
    const pid = entry.slice(0, eq).trim()
    const target = entry.slice(eq + 1).trim()
    const dot = target.indexOf('.')
    if (pid === '' || dot === -1) continue

    const group = target.slice(0, dot)
    const key = target.slice(dot + 1).trim()
    if (!POKE_GROUPS.includes(group) || key === '') continue
    pokes.set(pid, `${group}.${key}`)
  }
  return pokes
}

/**
 * Last host-echoed settings plus an in-memory override layer that masks the host's echo lag.
 */
export class SettingsStore {
  private base: DockSettings
  private overrides: Partial<DockSettings> = {}

  constructor(raw?: unknown) {
    this.base = normalizeSettings(raw)
  }

  /** Replace the base with a fresh host echo, dropping every override the echo now agrees with. */
  applyEcho(raw: unknown): void {
    this.base = normalizeSettings(raw)
    for (const key of SETTINGS_KEYS) {
      if (this.overrides[key] === this.base[key]) delete this.overrides[key]
    }
  }

  /** Record a local value that wins over the base until the host echoes the same value back. */
  override(patch: Partial<DockSettings>): void {
    this.overrides = { ...this.overrides, ...normalizePatch(patch) }
  }

  /** The effective settings: base merged with the pending overrides. */
  current(): DockSettings {
    return { ...this.base, ...this.overrides }
  }
}
