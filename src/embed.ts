/**
 * Embed Protocol v1 (`lsp-embed`) — pure host-side logic. See `docs/embed-protocol.md`.
 *
 * No DOM, no `@logseq/libs`: everything here is a decision function or a string builder, so the
 * protocol's tricky parts (wipe vs eviction, strategy caching, "is this main UI actually empty?")
 * are unit-testable without a live Logseq. The DOM seams live in `dock.ts`.
 */

/** The version this host speaks. Providers treat unknown versions as unsupported. */
export const PROTOCOL_VERSION = 1

/** Marks a host-owned slot element. Providers refuse to mount into anything without it. */
export const EMBED_HOST_ATTR = 'data-embed-host'
/** Marks the root of a provider-injected subtree; its presence is the only mount acknowledgment. */
export const EMBED_OWNER_ATTR = 'data-embed-owner'

export type SlotName = 'top' | 'bottom'

/** How a plugin's view gets into a slot. */
export type EmbedStrategy =
  /** The provider mounts its own view through the protocol — nothing is ever re-parented. */
  | 'embed'
  /** Legacy fallback: we re-parent the plugin's `#<pid>_lsp_main` container ourselves. */
  | 'adopt'

/** What to do about a slot that already holds an embed mount. */
export type SlotHealth =
  /** The provider's subtree is still there. */
  | 'healthy'
  /** Our slot element was re-created (host re-render wiped it) — re-invoke `embedMount`. */
  | 'remount'
  /** Same slot, subtree gone: the provider moved the view to another surface. Never auto-remount. */
  | 'evicted'

/** What the strategy cache says to do next for a plugin id. */
export type StrategyAction = 'use-embed' | 'use-adopt' | 'probe'

/** Full grace period: the provider may still be booting. The spec asks for ≥ 5 s. */
export const PROBE_BUDGET_MS = 6_000
/**
 * Shortened budget for a plugin we already know is not a provider. Re-probing after a lifecycle event
 * is worth doing (it may have gained the models), but it must not stall the fallback for six seconds.
 */
export const PROBE_REPROBE_BUDGET_MS = 1_500

const PROBE_START_MS = 50
const PROBE_MAX_MS = 500

/**
 * Delays between successive `embedMount` attempts inside one probe.
 *
 * Every attempt re-invokes: the host dispatches `callUserModel` directly with NO queueing, so an
 * invocation that lands before the provider called `provideModel` is dropped on the floor and no
 * amount of polling would ever see a subtree. `embedMount` is idempotent per provider rule 3, which
 * is exactly what makes repeating it safe.
 */
export function probeDelays(
  budgetMs: number,
  startMs: number = PROBE_START_MS,
  maxMs: number = PROBE_MAX_MS,
): number[] {
  const delays: number[] = []
  let elapsed = 0
  let delay = Math.max(1, startMs)
  while (elapsed < budgetMs) {
    const next = Math.min(delay, budgetMs - elapsed)
    delays.push(next)
    elapsed += next
    delay = Math.min(delay * 2, Math.max(1, maxMs))
  }
  return delays
}

/** How long to keep trying, given what this plugin was last known to be. */
export function probeBudgetMs(lastKnown: EmbedStrategy | null): number {
  return lastKnown === 'adopt' ? PROBE_REPROBE_BUDGET_MS : PROBE_BUDGET_MS
}

/**
 * Which mount records a plugin-registry event invalidates.
 *
 * A reloaded or unloaded provider either sweeps its subtree on the way out (a removal that would be
 * misread as an eviction — "open in another surface") or, when killed outright, leaves a dead husk
 * behind (which would satisfy the next probe and be committed as a healthy mount). Either way ITS
 * embed mounts are dropped — and the husk purged, see `Dock.dropInvalidatedMounts` — then
 * re-established through the normal probing path: invalidation, not the
 * auto-remount-after-eviction host rule 4 forbids.
 *
 * Scoping to the plugin the event is about is what keeps that distinction honest: dropping every embed
 * record on any plugin's event would turn an unrelated install into a silent steal of a view the user
 * had deliberately moved to another surface. An event we cannot attribute (`changedPid === null`)
 * therefore drops nothing. Adoption heals through its own canonical-node check, so those records stay.
 */
export function droppedByLifecycle(
  mount: { pid: string; strategy: EmbedStrategy },
  changedPid: string | null,
): boolean {
  if (mount.strategy !== 'embed') return false
  return changedPid !== null && mount.pid === changedPid
}

/** DOM id of a slot element. Stable, and a valid CSS ident for well-formed plugin ids. */
export function slotElementId(hostPid: string, slot: SlotName): string {
  return `${hostPid}--slot-${slot}`
}

/** Escape a value for interpolation into a double-quoted HTML attribute. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Selector matching one provider's embed subtree root (quoted — no CSS ident escaping needed). */
export function embedOwnerSelector(pid: string): string {
  return `[${EMBED_OWNER_ATTR}="${pid.replace(/["\\]/g, '\\$&')}"]`
}

/** `invokeExternalPlugin` target for one of the provider's protocol models. */
export function embedModelPath(pid: string, model: 'embedMount' | 'embedUnmount'): string {
  return `${pid}.models.${model}`
}

export interface EmbedPayload {
  slot: string
  origin: string
  protocolVersion: number
}

export function buildEmbedPayload(hostPid: string, slotId: string): EmbedPayload {
  return { slot: slotId, origin: hostPid, protocolVersion: PROTOCOL_VERSION }
}

/**
 * Host contract rules 3 & 4: slot-element identity is what tells a host wipe apart from a provider
 * eviction, and the two get opposite treatment.
 */
export function classifySlot(state: { sameSlotElement: boolean; hasEmbedSubtree: boolean }): SlotHealth {
  if (!state.sameSlotElement) return 'remount'
  return state.hasEmbedSubtree ? 'healthy' : 'evicted'
}

/** Discovery is try-and-verify: a subtree within the grace period means the plugin is a provider. */
export function strategyFromProbe(mounted: boolean): EmbedStrategy {
  return mounted ? 'embed' : 'adopt'
}

/** Cache hit decides; a miss (never probed, or invalidated by a lifecycle event) re-probes. */
export function nextStrategyAction(cached: EmbedStrategy | null): StrategyAction {
  if (cached === 'embed') return 'use-embed'
  if (cached === 'adopt') return 'use-adopt'
  return 'probe'
}

/**
 * Per-plugin probe outcomes for this session. A plugin that reloads may have gained (or lost) the
 * protocol models, so its lifecycle events invalidate the entry and the next mount probes again.
 */
export class StrategyCache {
  /** Outcomes we still trust. */
  private readonly fresh = new Map<string, EmbedStrategy>()
  /** Outcomes we no longer trust but still remember — they set the re-probe budget. */
  private readonly lastKnown = new Map<string, EmbedStrategy>()

  get(pid: string): EmbedStrategy | null {
    return this.fresh.get(pid) ?? null
  }

  /** What this plugin was last seen to be, even after invalidation. */
  lastStrategy(pid: string): EmbedStrategy | null {
    return this.lastKnown.get(pid) ?? null
  }

  set(pid: string, strategy: EmbedStrategy): void {
    this.fresh.set(pid, strategy)
    this.lastKnown.set(pid, strategy)
  }

  /** Forget one plugin's outcome, or every outcome when no id is given. History is kept. */
  invalidate(pid?: string): void {
    if (pid === undefined) {
      this.fresh.clear()
    } else {
      this.fresh.delete(pid)
    }
  }

  /** What to do next for this plugin id. */
  action(pid: string): StrategyAction {
    return nextStrategyAction(this.get(pid))
  }

  /** How long the next probe for this plugin id may take. */
  budgetMs(pid: string): number {
    return probeBudgetMs(this.lastStrategy(pid))
  }
}

/** Minimal shape of a DOM element, so the emptiness check stays free of the DOM. */
export interface ElementLike {
  tagName: string
  childElementCount: number
  textContent: string | null
}

/** Minimal shape of a document body. */
export interface BodyLike {
  children: readonly ElementLike[]
}

/** Tags that say nothing about whether a view actually rendered. */
const INERT_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'TITLE'])

/** Elements that are visible in themselves even with no children and no text. */
const VISUAL_LEAF_TAGS = new Set([
  'CANVAS',
  'IMG',
  'SVG',
  'VIDEO',
  'AUDIO',
  'IFRAME',
  'INPUT',
  'BUTTON',
  'TEXTAREA',
  'SELECT',
  'HR',
])

/**
 * Did this plugin's main UI actually render anything?
 *
 * A booted-but-blank plugin leaves an empty mount point (`<div id="app"></div>` plus scripts), which
 * is indistinguishable from a working view unless you look inside — that is exactly the
 * "plugin has no dockable view" case we want to report instead of showing an empty box.
 */
export function hasMeaningfulContent(body: BodyLike | null): boolean {
  if (body === null) return false
  return body.children.some((child) => {
    const tag = child.tagName.toUpperCase()
    if (INERT_TAGS.has(tag)) return false
    if (VISUAL_LEAF_TAGS.has(tag)) return true
    if (child.childElementCount > 0) return true
    return (child.textContent ?? '').trim() !== ''
  })
}
