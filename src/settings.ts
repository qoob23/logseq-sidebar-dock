/**
 * Pure settings logic — no `@logseq/libs` import, fully unit-testable.
 *
 * `logseq.updateSettings` is fire-and-forget: the local `logseq.settings` object only mutates once the
 * host echoes `settings:changed` back (~0.5-1s later). {@link SettingsStore} therefore keeps the last
 * host-echoed values as a base plus an in-memory override layer that wins until the echo agrees. In-dock
 * editing makes that layer load-bearing rather than a nicety — every gear-menu action writes.
 *
 * Four flat keys, and {@link DockSettings.activeTab} stays OUT of the {@link DockSettings.layouts} JSON
 * blob deliberately: it is rewritten on every tab click and the override layer is per key, so keeping it
 * separate stops a tab flip from clobbering a config edit whose echo has not arrived yet.
 * {@link DockSettings.sidebarWidthPx} is flat for the same reason and one more: the width is GLOBAL, not
 * a property of any layout — the dock's width is the sidebar's width, so a tab flip must never relayout
 * the main content behind it.
 */

import { type DockConfig, resolveLayoutSlots, specSignature } from './config'

/** {@link DockSettings.activeTab} value for the stock navigation; anything else is a layout id. */
export const NAV_TAB = 'nav'

/**
 * Bounds of the sidebar-width override, deliberately far wider than the host's own 240-460 clamp — two
 * docked plugin views in a 460px column is precisely the thing this plugin exists to make possible.
 */
export const WIDTH_MIN = 180
export const WIDTH_MAX = 1600
/**
 * "No override — the host's own width stands."
 *
 * Zero is not a width anyone could want, so it doubles as the off switch: no rule is emitted into the
 * stylesheet, so the sidebar simply keeps whatever width Logseq gives it — until a drag on the host's
 * resizer picks one, which is the moment an override is born (see `dock.ts`'s seeded width drag).
 */
export const WIDTH_FOLLOW_HOST = 0

export interface DockSettings {
  /** {@link NAV_TAB}, or the id of the layout whose tab is selected. */
  activeTab: string
  /** `pid = models.key` entries, `;`/newline separated — see {@link parseAdoptPokes}. */
  adoptPoke: string
  /** Canonical JSON of the {@link DockConfig}; blank means "no layouts yet". */
  layouts: string
  /** Sidebar width (px) forced on every tab including nav, or {@link WIDTH_FOLLOW_HOST}. */
  sidebarWidthPx: number
}

export const DEFAULT_SETTINGS: DockSettings = {
  activeTab: NAV_TAB,
  adoptPoke: '',
  layouts: '',
  sidebarWidthPx: WIDTH_FOLLOW_HOST,
}

const SETTINGS_KEYS = ['activeTab', 'adoptPoke', 'layouts', 'sidebarWidthPx'] as const

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

/** Trimmed string, with blank treated as "unset" — for keys where blank is not a legal value. */
function readSelection(source: Record<string, unknown> | null, key: string, fallback: string): string {
  const value = source?.[key]
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

/** Trimmed string where blank IS a legal value ("no pokes", "no layouts"). */
function readText(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The sidebar-width override: a clamped px value, or {@link WIDTH_FOLLOW_HOST} for "not overriding".
 *
 * This shape needs its own reader rather than a generic clamped-number one, because the sentinel sits
 * OUTSIDE the valid range: a plain clamp would raise `0` to {@link WIDTH_MIN} and silently turn "follow
 * the host" into a 180px sidebar the user never asked for and cannot switch off again.
 *
 * The host's settings panel hands numbers back as strings, and a cleared number field arrives as a
 * blank one — which is the user saying "no override", not "garbage", so it lands on the sentinel like
 * every other unreadable value.
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
  // Two decimals: the drag produces sub-pixel values and the sheet renders them verbatim.
  return Math.round(clamp(parsed, WIDTH_MIN, WIDTH_MAX) * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Coerce anything the host hands back into a complete {@link DockSettings}.
 *
 * Unknown keys — including every v1 key (`mode`, `viewTop`, `macroBottom`, `splitPct`, …) — are simply
 * ignored: there are no v1 users, so there is nothing to migrate.
 */
export function normalizeSettings(raw: unknown): DockSettings {
  const source = asRecord(raw)
  return {
    activeTab: readSelection(source, 'activeTab', DEFAULT_SETTINGS.activeTab),
    adoptPoke: readText(source, 'adoptPoke'),
    layouts: readText(source, 'layouts'),
    sidebarWidthPx: normalizeWidth(source?.['sidebarWidthPx']),
  }
}

/** Clean a partial patch exactly the way {@link normalizeSettings} cleans a full settings object. */
function normalizePatch(patch: Partial<DockSettings>): Partial<DockSettings> {
  const out: Partial<DockSettings> = {}
  if (patch.activeTab !== undefined) {
    const trimmed = patch.activeTab.trim()
    out.activeTab = trimmed === '' ? DEFAULT_SETTINGS.activeTab : trimmed
  }
  // Free-text fields, unlike the tab selection above: blank is a legitimate value ("no pokes", "no
  // layouts"), so a cleared field must survive as '' instead of being dropped as "no change".
  if (patch.adoptPoke !== undefined) out.adoptPoke = patch.adoptPoke.trim()
  if (patch.layouts !== undefined) out.layouts = patch.layouts.trim()
  // Same care as the free-text fields: {@link WIDTH_FOLLOW_HOST} is the legitimate "stop overriding"
  // value, so it has to survive the patch instead of being clamped up to {@link WIDTH_MIN} or dropped
  // as "no change" — and an override no echo can ever agree with would mask every later hand edit of
  // the setting, since `settingsDiffer` compares the post-override values.
  if (patch.sidebarWidthPx !== undefined) out.sidebarWidthPx = normalizeWidth(patch.sidebarWidthPx)
  return out
}

/** True when the two settings objects differ in any field. */
export function settingsDiffer(a: DockSettings, b: DockSettings): boolean {
  return SETTINGS_KEYS.some((key) => a[key] !== b[key])
}

/**
 * Signature of everything that decides what gets rendered and which plugin may be poked.
 *
 * The dock remembers per-episode verdicts — "already poked this plugin while its view was missing",
 * "nobody ever answered this macro" — that must not outlive the configuration they were formed under.
 * Comparing this signature drops them exactly when they stop being trustworthy and no more often:
 *
 * - It is built from the PARSED config and the PARSED poke map, so reformatting a field (or deleting a
 *   junk poke entry that never parsed anyway) changes nothing.
 * - It is sorted, hence order-insensitive: those verdicts are keyed by plugin id and by raw macro spec,
 *   never by slot or layout, so moving a slot — or moving a whole layout — cannot invalidate one.
 * - Weights and layout names are absent for the same reason: resizing a divider is not a config change
 *   as far as mounting is concerned.
 */
export function configSignature(adoptPoke: string, config: DockConfig): string {
  const specs = config.layouts.flatMap((layout) =>
    resolveLayoutSlots(layout).map((slot) => specSignature(slot.spec)),
  )
  const pokes = [...parseAdoptPokes(adoptPoke)].map(([pid, target]) => `poke:${pid}=${target}`)
  return [...specs, ...pokes].sort().join('|')
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
