/**
 * Pure settings logic — no `@logseq/libs` import, fully unit-testable.
 *
 * `logseq.updateSettings` is fire-and-forget: the local `logseq.settings` object only mutates once the
 * host echoes `settings:changed` back (~0.5-1s later). {@link SettingsStore} therefore keeps the last
 * host-echoed values as a base plus an in-memory override layer that wins until the echo agrees.
 */

/** Sentinel value for "no plugin view selected in this slot". */
export const NO_VIEW = 'none'

export const SPLIT_MIN = 15
export const SPLIT_MAX = 85

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
  /** Share (%) of the dock height given to the top slot. */
  splitPct: number
}

export const DEFAULT_SETTINGS: DockSettings = {
  mode: 'nav',
  viewTop: NO_VIEW,
  viewBottom: NO_VIEW,
  splitPct: 50,
}

const SETTINGS_KEYS = ['mode', 'viewTop', 'viewBottom', 'splitPct'] as const

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
    splitPct: readNumber(source, 'splitPct', DEFAULT_SETTINGS.splitPct, SPLIT_MIN, SPLIT_MAX),
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
  if (patch.splitPct !== undefined && Number.isFinite(patch.splitPct)) {
    out.splitPct = round2(clamp(patch.splitPct, SPLIT_MIN, SPLIT_MAX))
  }
  return out
}

/** True when the two settings objects differ in any field. */
export function settingsDiffer(a: DockSettings, b: DockSettings): boolean {
  return SETTINGS_KEYS.some((key) => a[key] !== b[key])
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
