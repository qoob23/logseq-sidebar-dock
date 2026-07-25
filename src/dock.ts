/**
 * Host-side machinery: injects the dock pane into the left sidebar and the tab strip into the app
 * header's left cell, keeps both alive, and fills the slots of every configured layout — through the
 * Embed Protocol v1 where the plugin supports it (`docs/embed-protocol.md`), and by adopting the
 * plugin's main-UI container where it does not.
 *
 * Runs inside our own (un-sandboxed, same-origin) plugin iframe and reaches into the host document
 * through `window.top`. The host has NO lifecycle management for `path`-injected UI, so re-assertion
 * is entirely ours: a debounced MutationObserver, an `App.onRouteChanged` re-check, and the
 * `LSPluginCore` plugin-registry events.
 *
 * TWO injections, in two host subtrees that belong to two different host components ({@link
 * DOCK_PATH}, {@link TABS_PATH}) — hence two independent health checks ({@link isHealthy}, {@link
 * isTabsHealthy}) and one observer that re-asserts when either goes down.
 *
 * What `provideUI` injects is only a one-child shell per container ({@link DOCK_TEMPLATE}, {@link
 * TABS_TEMPLATE}); the tabs, the layout roots, the slots, the dividers and every edit-mode control are
 * built and reconciled HERE with
 * `doc.createElement`, keyed by layout id and slot id (`docs/layout-config.md`, "DOM shape"). That is
 * not a style preference:
 *
 * - Slot-element identity is the protocol's wipe-vs-eviction discriminator (host rule 4), so a slot
 *   element re-created because a *sibling* was added would be read as the provider evicting its view.
 * - Re-inserting a node reboots any iframe inside it, so a config edit must move as few slot elements
 *   as it possibly can — {@link orderChildren} only touches the ones that actually changed place.
 * - Nothing here passes through the host's DOMPurify sanitiser, which is what makes `<select>` and
 *   `<input>` controls usable at all.
 */

import '@logseq/libs'

import {
  type DockConfig,
  type Layout,
  MAX_NAME_LENGTH,
  MAX_SLOTS_PER_LAYOUT,
  type ResolvedSlot,
  type SlotSource,
  type ViewSpec,
  // The edit operations are pure functions over a config, aliased where they would otherwise read like
  // a recursive call to the method that invokes them.
  addLayout as configAddLayout,
  addSlot as configAddSlot,
  createLayout,
  emptyConfig,
  fillOrder,
  findLayout,
  isSlotConfigured,
  layoutHasContent,
  moveSlot as configMoveSlot,
  normalizeConfig,
  parseConfig,
  removeLayout as configRemoveLayout,
  removeSlot as configRemoveSlot,
  renameLayout as configRenameLayout,
  resolveLayoutSlots,
  serializeConfig,
  setLayoutWeights,
  setSlotMacro,
  setSlotMacroMode,
  setSlotSource,
  sharedPluginIds,
  toggleLayoutAxis,
} from './config'
import { SLOT_MIN_PX, computeSidebarWidth, resizeWeights } from './divider'
import {
  type BodyLike,
  EMBED_HOST_ATTR,
  EMBED_OWNER_ATTR,
  type EmbedStrategy,
  PROBE_REPROBE_BUDGET_MS,
  type SlotId,
  StrategyCache,
  buildEmbedPayload,
  classifySlot,
  droppedByLifecycle,
  embedModelPath,
  embedOwnerSelector,
  hasMeaningfulContent,
  probeDelays,
  slotElementId,
  strategyFromProbe,
} from './embed'
import {
  type HostCleanup,
  emitHostAppHook,
  forceCleanInjectedUi,
  getHostDocument,
  getInstalledPluginIds,
  setHostCleanup,
  subscribeHostPluginLifecycle,
  takeHostCleanup,
} from './logseq-types'
import { MACRO_HOOK_TYPE, buildMacroHookPayload, macroSlotDomId } from './macro'
import {
  type DockSettings,
  NAV_TAB,
  type SettingsStore,
  WIDTH_FOLLOW_HOST,
  configSignature,
  parseAdoptPokes,
} from './settings'
// The container ids, the class names, the `provideUI` keys, the tab strip's injection path and the
// transient width property are all selectors in that sheet as much as they are DOM writes here, so they
// are DEFINED there and imported — see the block comment next to them.
import {
  CONTROLS_CLASS,
  DOCK_KEY,
  DRAGGING_CLASS,
  EDITING_CLASS,
  type ResolvedLayout,
  TABS_KEY,
  TABS_PATH,
  WIDTH_VAR,
  buildDockCss,
  dockContainerId,
  sheetMarker,
  slotWeightVar,
  tabsContainerId,
} from './styles'

/** `provideStyle` key — the host looks it up with an UNQUOTED attribute selector: bare ident only. */
const STYLE_KEY = 'sdock-layout'
/** The attribute `provideStyle` writes on the `<style>` element it creates for that key. */
const STYLE_ATTR = 'data-injected-style'
/** Append point: last child of the sidebar's flex column, after `footer.create`. */
const DOCK_PATH = '#left-sidebar .left-sidebar-inner > .wrap'
/** The host's own sidebar resizer handle, which we hijack outright (see {@link Dock.assertWidthResizer}). */
const WIDTH_RESIZER_SELECTOR = '#left-sidebar .left-sidebar-resizer'
/** The sidebar element the host resizes — and the parent of the handle above. */
const SIDEBAR_ID = 'left-sidebar'
/**
 * The host's OWN transient drag classes (`container.cljs`, `sidebar-resizer`): they suppress the
 * sidebar's width transition, without which every drag frame trails the pointer.
 */
const RESIZING_CLASS = 'is-resizing'
const RESIZING_BUF_CLASS = 'is-resizing-buf'
/**
 * Prefix of the per-slot `flex-grow` custom property, derived from the builder rather than re-typed:
 * the drag writes these inline on a layout root and the post-assert sweep has to find exactly those.
 */
const WEIGHT_VAR_PREFIX = slotWeightVar('')

const POLL_START_MS = 50
const POLL_MAX_MS = 500
const POLL_BUDGET_MS = 15_000
/** Settling time before a vanished embed subtree counts as an eviction. */
const EMBED_WATCH_DEBOUNCE_MS = 150
/** How long an adopted main UI may stay blank before we call it undockable (it reboots when moved). */
const ADOPT_CONTENT_GRACE_MS = 8_000
/** Cadence of the ongoing adopted-content check, which heals in both directions. */
const ADOPT_RECHECK_MS = 1_000
/** How long to keep watching for a selected plugin's main UI to appear (it may still be booting). */
const MISSING_VIEW_BUDGET_MS = 20_000
/** How long to wait for a provided stylesheet to actually land in the host document. */
const SHEET_BUDGET_MS = 3_000
const OBSERVER_DEBOUNCE_MS = 250
/**
 * How long to keep re-emitting a macro hook before giving up. Same rationale (and same shape) as the
 * embed probe: a broadcast that lands before the providing plugin installed its hook is dropped on
 * the floor, so re-emitting is the only way to survive a cold boot — and it is idempotent, since the
 * host itself re-emits on every block re-render.
 */
const MACRO_HOOK_BUDGET_MS = 6_000
/**
 * Shortened budget for a spec nobody has ever answered — the macro equivalent of the embed cache's
 * re-probe budget, and the same bargain: asserts are serialized, so a macro whose provider is simply
 * not installed would otherwise stall every single one of them for the full budget. Still worth
 * retrying (the provider may have arrived), just not at that price.
 */
const MACRO_REPROBE_BUDGET_MS = PROBE_REPROBE_BUDGET_MS
/**
 * Minimum gap between two pokes of the same plugin. The configured target is very often a TOGGLE, so
 * a burst of pokes would flap its view on and off instead of opening it once.
 */
const POKE_COOLDOWN_MS = 5_000
/**
 * How long an armed destructive button stays armed. Long enough to read the label and click again,
 * short enough that an armed button left alone can never be hit by a later, unrelated click.
 */
const ARM_TIMEOUT_MS = 4_000

/**
 * Suffix of the id the host gives a plugin's main-UI container (`PluginLocal`'s `_lsp_main`). Spelled
 * once because it is read in both directions: we look a container up by pid, and — when discarding a
 * subtree whose slots this module's scope knows nothing about — we recover the pid from the id.
 */
const MAIN_UI_SUFFIX = '_lsp_main'

const NO_SELECTION_TEXT = 'Empty slot — open the gear in the tab strip to pick a view.'
const EVICTED_TEXT = 'View is open in another surface (sidebar/popout).'
const INVALID_MACRO_TEXT = 'Invalid macro spec — expected something like {{renderer :my-macro, arg}}.'
const MACRO_UNANSWERED_TEXT = 'No plugin responded to this macro. Is its provider installed and enabled?'
const SHARED_PID_HINT = 'This plugin is also used by another tab — its view reloads when you switch between them.'
const CONFIG_ERROR_TEXT = 'The layout JSON does not parse, so editing is off until it is fixed in the plugin settings:'
/** Any element the host's `setupInjectedUI` created — the only acknowledgment a macro hook gets. */
const INJECTED_UI_SELECTOR = '[data-injected-ui]'

/**
 * Option values of the per-slot source picker that are not plugin ids. A plugin id can never collide
 * with either — the host derives ids from package names, which have no `__` sentinels in them.
 */
const PICK_NONE = '__sdock_none__'
const PICK_MACRO = '__sdock_macro__'

/**
 * Marks a button as arm-then-confirm and carries what it needs to be repainted in place: the identity
 * of the action ({@link armKey}) plus the label and title to go back to when it disarms. Written as
 * `data-*` on the button rather than kept in a map, because the button is a host-realm node that any
 * assert may replace — the element itself is the only handle that stays true.
 */
const ARM_KEY_ATTR = 'data-arm-key'
/** Label an armed button shows. The whole confirmation dialog: there is no prompt API to open. */
const ARM_LABEL = 'Sure?'

/**
 * Model names, spelled once. Each is both the `data-on-<event>` attribute value on a control we build
 * here and the key `main.ts` registers with `provideModel`; two spellings would drift into a control
 * that silently does nothing.
 */
export const MODELS = {
  selectTab: 'sdockSelectTab',
  reclaim: 'sdockReclaim',
  toggleEdit: 'sdockToggleEdit',
  addLayout: 'sdockAddLayout',
  removeLayout: 'sdockRemoveLayout',
  renameLayout: 'sdockRenameLayout',
  toggleAxis: 'sdockToggleAxis',
  addSlot: 'sdockAddSlot',
  removeSlot: 'sdockRemoveSlot',
  moveSlot: 'sdockMoveSlot',
  pickSource: 'sdockPickSource',
  setMacro: 'sdockSetMacro',
} as const

/** The `data-*` keys our controls carry. Same reason as {@link MODELS}: one spelling, both sides. */
export type DataKey = 'tab' | 'slotId' | 'layoutId' | 'dir'

/**
 * What a `provideModel` handler actually receives.
 *
 * The host builds it with `transformableEvent` (`libs/src/helpers.ts`): `type`, plus `value`, `id`,
 * `className` and a copy of `dataset` read off the element carrying the `data-on-<event>` attribute.
 * There is NO element reference in it, which is the whole reason every control has to carry its target
 * in `data-*` — with dynamic slots, one pre-registered model name per slot is not an option.
 *
 * Every field is optional because the host copies properties blindly: `value` is `undefined` on a
 * `<button>`, and a handler invoked from somewhere else entirely gets nothing at all.
 */
export interface ModelEvent {
  type?: string
  value?: string
  id?: string
  className?: string
  dataset?: Partial<Record<DataKey, string>>
}

/** Read one `data-*` value off a model event. */
export function eventData(event: ModelEvent, key: DataKey): string {
  return event.dataset?.[key] ?? ''
}

/** The `value` of the `<select>`/`<input>` that fired the event. */
export function eventValue(event: ModelEvent): string {
  return event.value ?? ''
}

/**
 * Why an adopted node is being handed back.
 *
 * The distinction matters when the host can no longer resolve `#<pid>_lsp_main`:
 * - `swap` — the node was sitting in our attached slot, so `getElementById` COULD see it. Not finding
 *   it means the host destroyed it (`PluginLocal.destroy()` on disable/uninstall, no replacement) and
 *   re-appending the husk would plant an invisible, click-blocking overlay on the body.
 * - `wipe` — our own container is going away, so the node may legitimately be detached-but-alive and
 *   genuinely invisible to `getElementById`. That is the one case worth rescuing.
 */
type ReleaseMode = 'swap' | 'wipe'

/** Why a slot is being emptied — decides whether the provider gets an `embedUnmount`. */
type ClearReason =
  /** The user picked a different view, or the slot itself is gone: protocol host rule 5 says unmount. */
  | 'deselect'
  /** Our container was wiped by a host re-render: the slot dies anyway, and rule 3 says re-mount. */
  | 'wipe'
  /** The plugin is unloading: unmount. */
  | 'dispose'

/**
 * How a slot is filled. The two embed-protocol outcomes plus `macro`, which belongs to no plugin at
 * all: it re-emits the host's macro hook and whichever plugin answers renders into our wrapper.
 */
type SlotStrategy = EmbedStrategy | 'macro'

interface SlotMount {
  /** The plugin this mount belongs to; empty for `macro`, where no single plugin owns the view. */
  pid: string
  strategy: SlotStrategy
  /** Identity of the slot element at mount time — the wipe-vs-eviction discriminator (host rule 4). */
  slotEl: HTMLElement
  /** `adopt`: the foreign node we re-parented. `macro`: our own wrapper element. */
  node: HTMLElement | null
  /** `macro` only: the raw spec being rendered — a different spec must re-mount. */
  macroSpec: string | null
  /** `adopt` only: whether this mount already spent its one poke (see {@link Dock.poke}). */
  poked: boolean
  /** `embed` only: watches the slot for the provider removing its subtree. */
  watcher: MutationObserver | null
  /** Debounce timer of {@link watcher}. */
  watchTimer: ReturnType<typeof setTimeout> | null
}

/**
 * One layout in both forms the dock needs at the same time: as configured (the edit controls have to
 * show the raw source, including a blank macro spec or a pid a duplicate suppressed) and as resolved
 * (what the stylesheet and the mounting code consume).
 */
interface LayoutView extends ResolvedLayout {
  config: Layout
}

/** Everything one assert and one repaint need, derived from the settings in exactly one place. */
interface DockView {
  /** The configuration in force — the last one that parsed, while {@link error} is set. */
  config: DockConfig
  /** JSON parse error of the `layouts` string. While non-null, NOTHING may write that key. */
  error: string | null
  layouts: readonly LayoutView[]
  /** {@link NAV_TAB}, or a layout id that really exists — a tab naming a deleted layout falls back. */
  activeTab: string
  /** The layout {@link activeTab} names, or `null` on the nav face. */
  activeLayout: Layout | null
  /**
   * The sidebar-width override in force, or `WIDTH_FOLLOW_HOST`. Read here with everything else so the
   * sheet and the marker `waitForSheet` polls for can never be built from two different values.
   */
  sidebarWidthPx: number
  /** Pids configured in more than one layout: the edit UI warns, because flipping tabs reloads them. */
  sharedPids: ReadonlySet<string>
  /** Plugin ids the source pickers offer. Read once per assert — the registry is a live host map. */
  pluginOptions: readonly string[]
}

/** The reconciled shell, so the mounting pass does not have to look its nodes up again. */
interface ShellNodes {
  roots: Map<string, HTMLElement>
  slots: Map<SlotId, HTMLElement>
}

/**
 * Everything a configuration mutation implies BESIDES the transform itself, declared so that
 * {@link Dock.edit} — the one place that can refuse to write — is the only thing that can perform it.
 * See that method for the two bugs this shape exists to make unrepresentable.
 */
interface EditEffects {
  /** Other settings keys to write in the same round trip, so one action is never two racing writes. */
  patch?: Partial<DockSettings>
  /** In-memory state that only makes sense once the edit really went through. */
  applied?: () => void
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

/**
 * The dock container counts as healthy only when it is attached AND still holds our shell. It
 * deliberately says NOTHING about the tab strip any more: that lives in another host subtree, under a
 * container of its own, and a header row that has not rendered yet must not condemn a perfectly good
 * dock to being torn down and re-injected (which would wipe every slot it holds).
 */
function isHealthy(el: HTMLElement | null): el is HTMLElement {
  if (el === null || !el.isConnected) return false
  return el.querySelector('.sdock-layouts') !== null
}

/**
 * Which row the tab strip goes in right now.
 *
 * {@link TABS_PATH} (the app header's left cell) is the home — a different host component than the
 * dock's, which is the whole reason the strip is a separate injection with its own health check (see
 * {@link Dock.assertTabs}). {@link DOCK_PATH} is the fallback, so a renamed host cell degrades the
 * PLACEMENT instead of losing the strip — and with it the only way to switch tabs — altogether.
 */
function tabsPath(doc: Document): string {
  return doc.querySelector(TABS_PATH) === null ? DOCK_PATH : TABS_PATH
}

/**
 * The strip inside the injected tab container — but only while that container is intact AND standing
 * in the row we want it in RIGHT NOW. Placement is part of the health check because the header cell
 * can arrive late: the first assert of a session may well land before it exists, in the fallback row,
 * and nothing else would ever move it back up.
 */
function tabsStrip(doc: Document, tabsId: string): HTMLElement | null {
  const el = doc.getElementById(tabsId)
  if (el === null || el.parentElement !== doc.querySelector(tabsPath(doc))) return null
  return el.querySelector<HTMLElement>('.sdock-tabs')
}

/** {@link tabsStrip} as the predicate the observer and {@link Dock.assertTabs} ask it as. */
function isTabsHealthy(doc: Document, tabsId: string): boolean {
  return tabsStrip(doc, tabsId) !== null
}

/**
 * The injected shells, and nothing else. `provideUI` with the same key rewrites the container's
 * innerHTML, so every node that owns state — every slot element — has to be built outside it: see the
 * file header for what re-creating a slot costs.
 */
const DOCK_TEMPLATE = '<div class="sdock-layouts"></div>'
/**
 * The tab strip's shell, injected on its own so it can live in the header row. The host binds its
 * `data-on-<event>` delegation PER injected container, so the tabs, the gear and the add-layout button
 * reach the same models from either placement.
 */
const TABS_TEMPLATE = '<div class="sdock-tabs"></div>'

export class Dock {
  private readonly pluginId: string
  private readonly store: SettingsStore
  private readonly onPluginsChanged: (() => void) | null
  private readonly containerId: string
  /** The tab strip's own injected container — a second, independent injection (see {@link TABS_PATH}). */
  private readonly tabsId: string
  /** Keyed on slot id, which {@link normalizeConfig} keeps unique across ALL layouts for this reason. */
  private readonly mounts = new Map<SlotId, SlotMount>()
  private readonly strategies = new StrategyCache()

  /**
   * Layouts whose slots have been filled at least once. A layout is filled on its first activation and
   * stays filled for the session; an assert only fills these plus the active one. Without it, four
   * layouts of three slots would boot twelve plugin iframes — and burn twelve 6 s embed probes — before
   * the sidebar is usable, for eleven views nobody can see.
   */
  private readonly mountedLayouts = new Set<string>()
  /** Last configuration that parsed; what we keep rendering while the stored JSON is broken. */
  private lastGoodConfig: DockConfig | null = null
  /** Marker of the sheet we last provided — the only proof `provideStyle` ever gives us. */
  private lastMarker = ''
  /** Edit mode is a mode, not a preference: in memory, never persisted. */
  private editing = false
  /**
   * The one destructive action currently armed ({@link armKey}), or `null`. In memory and deliberately
   * single-valued: two buttons armed at once would be two ways to lose something by accident.
   */
  private armedKey: string | null = null
  /** Disarms {@link armedKey} after {@link ARM_TIMEOUT_MS}. */
  private armTimer: ReturnType<typeof setTimeout> | null = null

  /** Aborts the delegated divider listeners bound to the current `.sdock-layouts`. */
  private dividerAbort: AbortController | null = null
  /** Aborts the host-document listeners bound for the duration of one divider drag. */
  private dragAbort: AbortController | null = null
  private dragging = false
  /** The host resizer handle our listeners are bound to — tracked by identity, never by marking it. */
  private widthResizerEl: HTMLElement | null = null
  /** Aborts the listeners bound to {@link widthResizerEl}. */
  private widthResizerAbort: AbortController | null = null
  /** Aborts the host-document listeners bound for the duration of one sidebar-width drag. */
  private widthDragAbort: AbortController | null = null
  private widthDragging = false
  /**
   * Takes back a seeded-but-never-persisted width override (see {@link startWidthDrag}); nulled the
   * moment a drag persists for real. Without it an aborted drag — or a plain click on the handle —
   * would leave a phantom override in the store that no settings echo can ever agree with, silently
   * masking even a hand-edited `sidebarWidthPx` until the plugin reloads.
   */
  private widthDragRevert: (() => void) | null = null
  private running = false
  private queued = false
  private disposed = false
  /** Bumped by every assert; a running missing-view watch whose generation is stale gives up. */
  private watchGeneration = 0
  /** Selected plugins whose view could not be resolved during the last assert. */
  private missingPids = new Set<string>()
  /** When each plugin was last poked — the {@link POKE_COOLDOWN_MS} anti-flapping ledger. */
  private readonly pokedAt = new Map<string, number>()
  /** Plugins already poked during the current missing-view episode (see {@link adoptMainUi}). */
  private readonly pokedWhileMissing = new Set<string>()
  /** Raw macro specs no plugin has answered yet — they get the shortened budget. */
  private readonly unansweredMacros = new Set<string>()
  /** {@link configSignature} as of the last assert; a change retires both memories above. */
  private configSig = ''

  constructor(pluginId: string, store: SettingsStore, onPluginsChanged?: () => void) {
    this.pluginId = pluginId
    this.store = store
    this.onPluginsChanged = onPluginsChanged ?? null
    this.containerId = dockContainerId(pluginId)
    this.tabsId = tabsContainerId(pluginId)
  }

  /** Install the re-assertion hooks and build the dock for the first time. */
  async start(): Promise<void> {
    this.installHostHooks()
    await this.assert()
  }

  /**
   * Make the live DOM match the current configuration: stylesheet, container, shell, slots.
   * Safe to call at any time; overlapping calls collapse into one trailing re-run.
   */
  async assert(): Promise<void> {
    if (this.disposed) return
    if (this.running) {
      this.queued = true
      return
    }
    this.running = true
    try {
      do {
        this.queued = false
        await this.runAssert()
      } while (this.queued && !this.disposed)
    } finally {
      this.running = false
    }
  }

  // ------------------------------------------------------------------ user actions

  /**
   * Show a tab: {@link NAV_TAB} or a layout id.
   *
   * The override repaints immediately; `updateSettings` only catches the persisted value up ~0.5–1 s
   * later, and its echo then agrees with the override and drops it.
   */
  selectTab(tab: string): void {
    this.disarm()
    const target = tab.trim() === '' ? NAV_TAB : tab.trim()
    if (this.store.current().activeTab === target) return
    this.store.override({ activeTab: target })
    this.refreshStyle()
    logseq.updateSettings({ activeTab: target })
    // Revealing a layout: re-assert so its slots get filled at all the first time round (see
    // `mountedLayouts`), and so a stale placeholder — missing-view watch expired, or the plugin turned
    // up without a lifecycle event — heals on the flip instead of staying wrong until the next reload.
    if (target !== NAV_TAB) void this.assert()
  }

  /**
   * Toggle the edit controls. Deliberately just a class flip on our own containers: every edit-mode
   * rule in the sheet is gated on {@link EDITING_CLASS}, so entering or leaving edit mode re-provides
   * nothing and cannot disturb a single mounted view. The controls themselves are always in the DOM.
   */
  toggleEdit(): void {
    // Leaving edit mode must not leave a live arm behind for the next visit; entering it starts clean.
    this.disarm()
    this.editing = !this.editing
    const doc = getHostDocument()
    if (doc === null) return
    this.applyEditingClass(doc)
  }

  /**
   * Push edit mode onto BOTH injected containers. A class only reaches its own subtree, and the mode's
   * two halves are now in different host subtrees: the gear that raises when it is on stands in the
   * header strip, while the editbar and the per-slot panels it reveals are in the dock container.
   */
  private applyEditingClass(doc: Document): void {
    runQuietly(() => {
      for (const id of [this.containerId, this.tabsId]) {
        doc.getElementById(id)?.classList.toggle(EDITING_CLASS, this.editing)
      }
    })
  }

  addLayout(): void {
    this.disarm()
    const layout = createLayout()
    this.edit((config) => configAddLayout(config, layout), {
      patch: { activeTab: layout.id },
      // A tab whose slot cannot be filled is a dead end, so creating one turns the controls on — but
      // only if the tab was actually created (see {@link edit}).
      applied: () => {
        this.editing = true
      },
    })
  }

  /** Drop a tab. Armed first (see {@link confirmDrop}) when it would take configured slots with it. */
  removeLayout(layoutId: string): void {
    if (layoutId === '') return
    if (!this.confirmDrop(armKey('layout', layoutId), this.layoutHoldsViews(layoutId))) return
    const patch: Partial<DockSettings> =
      this.store.current().activeTab === layoutId ? { activeTab: NAV_TAB } : {}
    // The mounts of its slots are released by the next assert, whose reconcile sees those slot ids
    // vanish from the configuration — the same path a single removed slot takes.
    this.edit((config) => configRemoveLayout(config, layoutId), {
      patch,
      // Forgetting a layout that is still configured would strand it: an assert fills the slots of
      // `mountedLayouts ∪ {active}` only, so a hidden one dropped from the set stops healing.
      applied: () => {
        this.mountedLayouts.delete(layoutId)
      },
    })
  }

  renameLayout(layoutId: string, name: string): void {
    this.disarm()
    this.edit((config) => configRenameLayout(config, layoutId, name))
  }

  toggleAxis(layoutId: string): void {
    this.disarm()
    this.edit((config) => toggleLayoutAxis(config, layoutId))
  }

  addSlot(layoutId: string): void {
    this.disarm()
    this.edit((config) => configAddSlot(config, layoutId), {
      // Same reason as {@link addLayout}: a new slot is only useful once you can pick a view for it.
      applied: () => {
        this.editing = true
      },
    })
  }

  /** Drop a slot. Armed first (see {@link confirmDrop}) when it holds a view. */
  removeSlot(slotId: SlotId): void {
    if (slotId === '') return
    if (!this.confirmDrop(armKey('slot', slotId), this.slotHoldsView(slotId))) return
    this.edit((config) => configRemoveSlot(config, slotId))
  }

  /**
   * Move a slot one place along the axis. Reordering re-inserts a slot element, which reboots any
   * iframe inside it — unavoidable, since the visual order IS the DOM order, and the reason
   * {@link orderChildren} moves the single node that changed place rather than rewriting the row.
   */
  moveSlot(slotId: SlotId, dir: string): void {
    this.disarm()
    this.edit((config) => configMoveSlot(config, slotId, dir === 'up' ? -1 : 1))
  }

  pickSource(slotId: SlotId, value: string): void {
    this.disarm()
    this.edit((config) => {
      if (value === PICK_NONE) return setSlotSource(config, slotId, { kind: 'none' })
      // Not `setSlotSource(…, { kind: 'macro', raw: '' })`: a spec already typed has to survive
      // re-picking "macro…", which the round trip through the host looks exactly like.
      if (value === PICK_MACRO) return setSlotMacroMode(config, slotId)
      return setSlotSource(config, slotId, { kind: 'plugin', pid: value })
    })
  }

  setMacro(slotId: SlotId, raw: string): void {
    this.disarm()
    this.edit((config) => setSlotMacro(config, slotId, raw))
  }

  /**
   * Explicit user intent to take an evicted view back (the Reclaim button). Re-invoking `embedMount`
   * here is the legitimate last-mount-wins steal the protocol allows; nothing else may auto-remount.
   */
  reclaim(slotId: SlotId): void {
    this.disarm()
    void this.runReclaim(slotId)
  }

  /** Empty every slot. `wipe` means our container is being re-created, so providers keep their mount. */
  undockAll(reason: Extract<ClearReason, 'wipe' | 'dispose'> = 'wipe'): void {
    const doc = getHostDocument()
    if (doc === null) {
      this.mounts.clear()
      return
    }
    for (const slotId of [...this.mounts.keys()]) this.clearSlot(doc, slotId, reason)
  }

  /** Tear everything down — other plugins' live nodes go back to the host body untouched. */
  dispose(): void {
    this.disposed = true
    this.disarm()
    this.endDrag()
    this.dividerAbort?.abort()
    this.dividerAbort = null
    this.widthResizerAbort?.abort()
    this.widthResizerAbort = null
    this.widthResizerEl = null
    this.undockAll('dispose')

    const doc = getHostDocument()
    if (doc === null) return
    // The width override itself dies with the provided sheet; the transient var and the host's own
    // drag classes are ours to take back by hand.
    this.endWidthDrag(doc)
    doc.documentElement.style.removeProperty(WIDTH_VAR)

    const cleanup = takeHostCleanup(doc)
    if (cleanup !== null) runQuietly(cleanup)
    doc.getElementById(this.containerId)?.remove()
    // Two injections, two containers to take with us. The strip holds nothing but our own markup, so
    // unlike the dock container's slots there is nothing to hand back first.
    doc.getElementById(this.tabsId)?.remove()
  }

  // ------------------------------------------------------------------ arm-then-confirm

  /**
   * Gate on a destructive click: the first one ARMS the button, a second one within
   * {@link ARM_TIMEOUT_MS} performs the action. Returns whether the caller may proceed.
   *
   * A second click is the entire mechanism because there is nothing else to use — the plugin API has
   * no prompt or confirm, and `logseq.UI.showMsg` can only say things, not ask them. The armed button
   * relabels itself to {@link ARM_LABEL}, which is the feedback that makes the second click a decision
   * rather than a repetition.
   *
   * A harmless removal — an empty tab, a slot with nothing in it — passes straight through: the guard
   * exists for the clicks that lose something the user set up, and asking twice for the rest would
   * only train them to click twice.
   */
  private confirmDrop(key: string, destructive: boolean): boolean {
    if (!destructive || this.armedKey === key) {
      this.disarm()
      return true
    }
    this.arm(key)
    return false
  }

  private arm(key: string): void {
    if (this.armTimer !== null) clearTimeout(this.armTimer)
    this.armedKey = key
    this.armTimer = setTimeout(() => {
      this.armTimer = null
      this.disarm()
    }, ARM_TIMEOUT_MS)
    this.paintArmState()
  }

  /**
   * Called by every other edit-mode action as well as by the timeout: an arm is a statement about the
   * click that is about to happen, so anything else the user does instead retracts it.
   */
  private disarm(): void {
    if (this.armTimer !== null) {
      clearTimeout(this.armTimer)
      this.armTimer = null
    }
    if (this.armedKey === null) return
    this.armedKey = null
    this.paintArmState()
  }

  /**
   * Push the arm state onto the buttons already standing, rather than rebuilding the panels that hold
   * them: {@link syncSlotControls} rebuilds mean a half-typed macro spec is lost, and an arm is a
   * label flip on a node that is ours. Panels rebuilt later pick the state up at build time instead
   * ({@link markArmable}), so the two paths cannot disagree.
   *
   * The dock container only: every armable button is a destructive edit control (drop tab, drop slot),
   * and those live in the editbar and the per-slot panels. The tab strip carries none — its two icon
   * buttons add things.
   */
  private paintArmState(): void {
    const doc = getHostDocument()
    if (doc === null) return
    const container = doc.getElementById(this.containerId)
    if (container === null) return
    runQuietly(() => {
      for (const el of container.querySelectorAll<HTMLElement>(`[${ARM_KEY_ATTR}]`)) {
        applyArmState(el, el.dataset.armKey === this.armedKey)
      }
    })
  }

  /**
   * Would dropping this layout throw away something the user configured — or something that is on
   * screen right now? A live mount counts on its own: a slot whose configuration was hand-edited to
   * `none` while its view is still docked is exactly as surprising to lose.
   */
  private layoutHoldsViews(layoutId: string): boolean {
    const config = this.parsedConfig()
    const layout = config === null ? null : findLayout(config, layoutId)
    if (layout === null) return false
    return layoutHasContent(layout) || layout.slots.some((slot) => this.mounts.has(slot.id))
  }

  /** The single-slot half of {@link layoutHoldsViews}. */
  private slotHoldsView(slotId: SlotId): boolean {
    if (this.mounts.has(slotId)) return true
    const config = this.parsedConfig()
    if (config === null) return false
    for (const layout of config.layouts) {
      const slot = layout.slots.find((candidate) => candidate.id === slotId)
      if (slot !== undefined) return isSlotConfigured(slot)
    }
    return false
  }

  /** The stored configuration, or `null` while its JSON does not parse (no edit can proceed then). */
  private parsedConfig(): DockConfig | null {
    const parsed = parseConfig(this.store.current().layouts)
    return parsed.ok ? parsed.config : null
  }

  // ------------------------------------------------------------------ settings

  /**
   * The whole state one assert works from, read once so the stylesheet, the reconciler and the
   * mounting pass cannot disagree with each other mid-flight.
   *
   * A broken hand edit of the raw JSON must not cost the user their views, so the last configuration
   * that parsed keeps rendering and {@link edit} refuses to write until the text is valid again.
   */
  private resolveView(): DockView {
    const settings = this.store.current()
    const parsed = parseConfig(settings.layouts)
    if (parsed.ok) this.lastGoodConfig = parsed.config
    const config = parsed.ok ? parsed.config : (this.lastGoodConfig ?? emptyConfig())
    const layouts: LayoutView[] = config.layouts.map((layout) => ({
      id: layout.id,
      axis: layout.axis,
      slots: resolveLayoutSlots(layout),
      config: layout,
    }))
    const activeLayout = findLayout(config, settings.activeTab)
    return {
      config,
      error: parsed.ok ? null : parsed.error,
      layouts,
      // `activeTab` is not validated against the config when it is stored, so a tab naming a deleted
      // layout lands here and falls back to nav rather than showing nothing at all.
      activeTab: activeLayout?.id ?? NAV_TAB,
      activeLayout,
      // Deliberately NOT validated against anything: the width belongs to no layout, so it survives
      // every configuration edit, including one that leaves no layouts at all.
      sidebarWidthPx: settings.sidebarWidthPx,
      sharedPids: sharedPluginIds(layouts),
      pluginOptions: getInstalledPluginIds(this.pluginId),
    }
  }

  /**
   * The one write path for the `layouts` key: run a pure transform over a freshly parsed config, then
   * persist what it returned. Every transform lives in `config.ts` and is unit-tested there — this
   * module cannot be, so nothing that decides what the configuration becomes belongs in it.
   *
   * Refuses to write while the stored JSON does not parse. That is exactly why parse failure is kept
   * distinct from normalization — writing here would replace the user's broken text with our reading of
   * a configuration we could not read, i.e. throw the whole thing away over one typo.
   *
   * That refusal is the reason for {@link EditEffects.applied}: it is the ONLY gate, and a caller that
   * touched its own state before calling this would be changing it for an edit that never happened.
   * Both ways of getting that wrong were real bugs — `editing = true` set by the add buttons stayed set
   * with nothing written, so the next unrelated assert popped the whole edit chrome up over every
   * mounted view with no user action; and `mountedLayouts.delete` run by {@link removeLayout} demoted a
   * still-configured, already-mounted layout to lazily-unmounted, after which every assert skipped
   * filling its slots and an evicted view in it stopped healing. So: nothing a mutation implies may be
   * done AROUND this call — it goes in `applied`, which only the successful path reaches.
   *
   * The write order is the one the host's echo lag forces: override first (so the next read is right),
   * re-provide the sheet (an instant repaint, ahead of the echo), `updateSettings` (fire-and-forget),
   * re-assert. {@link EditEffects.patch} rides along so a single action that also changes the tab is
   * one settings write, not two racing ones.
   */
  private edit(transform: (config: DockConfig) => DockConfig, effects: EditEffects = {}): void {
    const parsed = parseConfig(this.store.current().layouts)
    if (!parsed.ok) return
    // Before the write, not after: the assert this ends with is what paints the consequences (the
    // edit-mode class, the slots of the layouts still worth filling), and it has to see the new state.
    effects.applied?.()
    // Normalized on the way out: a layout created here carries a blank name that only normalization
    // turns into `Layout <n>`, and a hand-typed name or weight still has to land in range.
    const raw = serializeConfig(normalizeConfig(transform(parsed.config)))
    const next: Partial<DockSettings> = { ...effects.patch, layouts: raw }
    this.store.override(next)
    this.refreshStyle()
    logseq.updateSettings(next)
    void this.assert()
  }

  /**
   * Re-publish the stylesheet. The tab switch and the baked slot weights are both nothing but this
   * sheet, so a repaint ahead of the settings echo is all a flip needs.
   */
  private refreshStyle(): void {
    this.provideStyle(this.resolveView())
  }

  private provideStyle(view: DockView): void {
    // Remembered, not recomputed later: `waitForSheet` has to look for the marker of the sheet we
    // actually provided, and the settings may well have moved on by the time it runs.
    this.lastMarker = sheetMarker(view.activeTab, view.layouts, view.sidebarWidthPx)
    logseq.provideStyle({
      key: STYLE_KEY,
      style: buildDockCss({
        pluginId: this.pluginId,
        activeTab: view.activeTab,
        layouts: view.layouts,
        sidebarWidthPx: view.sidebarWidthPx,
      }),
    })
  }

  private inject(): void {
    logseq.provideUI({ key: DOCK_KEY, path: DOCK_PATH, template: DOCK_TEMPLATE })
  }

  /**
   * Keep the tab strip injected, in the row we currently want it in. Returns whether a strip is to be
   * expected at all — false only when NEITHER row exists (the app shell is not rendered), so the
   * caller can skip waiting for something nobody asked the host for.
   *
   * `setupInjectedUI` only rewrites an EXISTING container's innerHTML and never moves it, so a
   * container left in the fallback row has to be torn down before the re-injection can place it in the
   * header cell. That is what makes the placement heal when the header turns up after our first
   * assert. The host's own teardown goes first (it also retires the libs-side effect), but its verdict
   * is about the CALL, not the node — and it removes the node from the parent it was created under,
   * which is exactly the parent that is wrong here — so the node itself is the only thing worth
   * believing: still standing means removing it by hand, or we would re-inject into a container the
   * host can neither move nor replace and the observer would re-assert forever.
   */
  private assertTabs(doc: Document): boolean {
    if (isTabsHealthy(doc, this.tabsId)) return true
    const path = tabsPath(doc)
    const target = doc.querySelector(path)
    if (target === null) return false

    const el = doc.getElementById(this.tabsId)
    if (el !== null && el.parentElement !== target) {
      forceCleanInjectedUi(this.tabsId)
      if (doc.getElementById(this.tabsId) !== null) {
        runQuietly(() => {
          el.remove()
        })
      }
    }
    logseq.provideUI({ key: TABS_KEY, path, template: TABS_TEMPLATE })
    return true
  }

  /** `provideUI` is fire-and-forget over postMessage — poll for what it should have produced. */
  private async pollForNode(get: () => HTMLElement | null): Promise<HTMLElement | null> {
    const deadline = Date.now() + POLL_BUDGET_MS
    let delay = POLL_START_MS
    for (;;) {
      if (this.disposed) return null
      const el = get()
      if (el !== null) return el
      if (Date.now() >= deadline) return null
      await sleep(delay)
      delay = Math.min(delay * 2, POLL_MAX_MS)
    }
  }

  private waitForContainer(doc: Document): Promise<HTMLElement | null> {
    return this.pollForNode(() => {
      const el = doc.getElementById(this.containerId)
      return isHealthy(el) ? el : null
    })
  }

  /**
   * The tab strip, once its own injection has landed.
   *
   * Deliberately weaker than {@link isTabsHealthy}: placement is NOT waited on. The row we want can
   * change while this is polling (the header cell rendering at last is exactly that), and holding out
   * for it would burn the whole budget and then hand back nothing — leaving a strip that is standing
   * but was never reconciled, i.e. empty, with no un-healthy state left for the observer to react to.
   * Reconcile whatever landed; the assert the observer triggers is what moves it.
   */
  private waitForTabs(doc: Document): Promise<HTMLElement | null> {
    return this.pollForNode(
      () => doc.getElementById(this.tabsId)?.querySelector<HTMLElement>('.sdock-tabs') ?? null,
    )
  }

  // ------------------------------------------------------------------ assert

  private async runAssert(): Promise<void> {
    const doc = getHostDocument()
    if (doc === null) return

    // Any assert supersedes a pending missing-view watch and the sheet it was built for.
    const generation = ++this.watchGeneration
    const view = this.resolveView()
    this.provideStyle(view)
    this.assertWidthResizer(doc)
    const expectTabs = this.assertTabs(doc)

    // Missing, detached, or emptied by a third party — all heal the same way. Re-calling `provideUI`
    // with the same key rewrites the container's innerHTML, so rescue adopted nodes first. Scoped to
    // the DOCK container alone: the strip going down is a reason to re-inject the strip, never to
    // wipe and re-mount every docked view.
    if (!isHealthy(doc.getElementById(this.containerId))) {
      this.undockAll('wipe')
      this.inject()
    }

    // Both injections are fire-and-forget and land independently, so they are awaited together — one
    // after the other would make a host that never answers cost two full budgets per assert.
    const [container, tabsEl] = await Promise.all([
      this.waitForContainer(doc),
      expectTabs ? this.waitForTabs(doc) : Promise.resolve(null),
    ])
    if (container === null || this.disposed) return

    const layoutsEl = container.querySelector<HTMLElement>('.sdock-layouts')
    if (layoutsEl === null) return

    this.attachDividers(doc, layoutsEl)
    this.applyEditingClass(doc)

    // One `runQuietly` around the whole host-realm rebuild: if the markup shifted underneath us the
    // shell is simply incomplete for this pass, and the slots we did reconcile still get filled. The
    // strip is reconciled inside its own container, which it may or may not have; a dock whose strip
    // is missing for this pass still fills its slots.
    let nodes: ShellNodes = { roots: new Map(), slots: new Map() }
    runQuietly(() => {
      nodes = this.syncLayouts(doc, layoutsEl, view)
      if (tabsEl !== null) this.syncTabs(doc, tabsEl, view)
      this.syncEditbar(doc, container, layoutsEl, view)
      this.syncConfigError(doc, container, view)
    })

    this.missingPids.clear()
    this.forgetStaleEpisodes(view)
    if (view.activeLayout !== null) this.mountedLayouts.add(view.activeLayout.id)

    // Active layout first, and one layout at a time: a plugin's main UI is a single node, so whichever
    // slot adopts a pid first keeps it, and the visible layout has to get its turn before any hidden
    // one can claim the same plugin. Slots WITHIN a layout run together — `resolveLayoutSlots` already
    // guarantees they want different pids, and a serial run would add up their probe budgets.
    for (const lv of fillOrder(view.layouts, view.activeTab)) {
      if (!this.mountedLayouts.has(lv.id)) continue
      const active = lv.id === view.activeTab
      await Promise.all(
        lv.slots.map((slot) => {
          const slotEl = nodes.slots.get(slot.id)
          return slotEl === undefined ? Promise.resolve() : this.dockSlot(doc, slotEl, slot, active)
        }),
      )
      if (this.disposed || generation !== this.watchGeneration) return
    }
    if (this.disposed || generation !== this.watchGeneration) return

    this.watchMissingViews(generation)

    // The stylesheet is what carries the weights and the sidebar width from here on — but
    // `provideStyle` is fire-and-forget, so only drop a drag's inline overrides once the new sheet is
    // provably in the host document. Clearing one earlier flashes the previous value for a few frames.
    //
    // The two live on different nodes and either may be standing on its own (a resize changes no
    // weight, a divider drag changes no width), so neither may early-return over the other — and both
    // are re-checked after the wait, because a drag can start while it is running.
    const dirty = this.dragging ? [] : [...nodes.roots.values()].filter((root) => inlineWeightVars(root).length > 0)
    const clearWidth = !this.widthDragging && doc.documentElement.style.getPropertyValue(WIDTH_VAR) !== ''
    if (dirty.length === 0 && !clearWidth) return
    if (!(await this.waitForSheet(doc, generation))) return
    if (generation !== this.watchGeneration) return
    runQuietly(() => {
      if (!this.dragging) {
        for (const root of dirty) {
          for (const name of inlineWeightVars(root)) root.style.removeProperty(name)
        }
      }
      if (clearWidth && !this.widthDragging) doc.documentElement.style.removeProperty(WIDTH_VAR)
    })
  }

  /** True once the sheet standing in the host document is the one we last provided. */
  private isSheetCurrent(doc: Document): boolean {
    if (this.lastMarker === '') return false
    const el = doc.querySelector(`[${STYLE_ATTR}="${STYLE_KEY}-${this.pluginId}"]`)
    if (el === null) return false
    return el.textContent?.includes(this.lastMarker) ?? false
  }

  private async waitForSheet(doc: Document, generation: number): Promise<boolean> {
    const deadline = Date.now() + SHEET_BUDGET_MS
    let delay = POLL_START_MS
    for (;;) {
      if (this.disposed || generation !== this.watchGeneration) return false
      if (this.isSheetCurrent(doc)) return true
      if (Date.now() >= deadline) return false
      await sleep(delay)
      delay = Math.min(delay * 2, POLL_MAX_MS)
    }
  }

  /**
   * A selected plugin can still be booting when a lifecycle event (or our own startup) triggers an
   * assert — nothing to embed or adopt exists yet, and our MutationObserver only watches our own
   * container, so nothing would ever retry. Watch for it with a bounded backoff instead.
   */
  private watchMissingViews(generation: number): void {
    if (this.missingPids.size === 0) return
    const pids = [...this.missingPids]

    void (async (): Promise<void> => {
      const deadline = Date.now() + MISSING_VIEW_BUDGET_MS
      let delay = POLL_START_MS
      while (Date.now() < deadline) {
        await sleep(delay)
        delay = Math.min(delay * 2, POLL_MAX_MS)
        if (this.disposed || generation !== this.watchGeneration) return
        const doc = getHostDocument()
        if (doc === null) return
        if (pids.some((pid) => doc.getElementById(mainUiId(pid)) !== null)) {
          void this.assert()
          return
        }
      }
    })()
  }

  /**
   * Retire the "we already tried that" memories when the configuration they were formed under is no
   * longer the one in force. Both are deliberately sticky — that is what stops a poke or a macro
   * hook from firing on every assert — so a user who edits the configuration to fix exactly that
   * problem has to be able to clear them.
   */
  private forgetStaleEpisodes(view: DockView): void {
    const signature = configSignature(this.store.current().adoptPoke, view.config)
    if (signature === this.configSig) return
    this.configSig = signature
    this.pokedWhileMissing.clear()
    this.unansweredMacros.clear()
  }

  // ------------------------------------------------------------------ shell reconciliation

  /**
   * Bring the layout roots, their slots and their dividers in line with the configuration, reusing
   * every element that survives. Keyed by id and reconciled in place — the file header says why a
   * gratuitously re-created (or re-inserted) slot element is not a cosmetic issue.
   */
  private syncLayouts(doc: Document, layoutsEl: HTMLElement, view: DockView): ShellNodes {
    const nodes: ShellNodes = { roots: new Map(), slots: new Map() }

    // A slot that is gone from the configuration takes its mount with it: `deselect`, because the slot
    // is not coming back and the provider is genuinely losing this surface (host rule 5).
    const live = new Set<SlotId>()
    for (const lv of view.layouts) for (const slot of lv.slots) live.add(slot.id)
    for (const slotId of [...this.mounts.keys()]) {
      if (!live.has(slotId)) this.clearSlot(doc, slotId, 'deselect')
    }
    for (const layoutId of [...this.mountedLayouts]) {
      if (!view.layouts.some((lv) => lv.id === layoutId)) this.mountedLayouts.delete(layoutId)
    }

    // Never a bare `remove()`: a layout root that is dropped from the configuration — or an unkeyed
    // husk left by a crashed previous life — can still CONTAIN another plugin's live view.
    const discard = (el: HTMLElement): void => {
      this.discardSubtree(doc, el)
    }
    const existing = keyedChildren(layoutsEl, '.sdock-layout', (el) => el.dataset.layout ?? '', discard)
    const ordered: HTMLElement[] = []
    for (const lv of view.layouts) {
      let root = existing.get(lv.id)
      existing.delete(lv.id)
      if (root === undefined) {
        root = doc.createElement('div')
        root.className = 'sdock-layout'
        root.dataset.layout = lv.id
      }
      this.syncSlots(doc, root, lv, view, nodes.slots)
      nodes.roots.set(lv.id, root)
      ordered.push(root)
    }
    for (const orphan of existing.values()) discard(orphan)
    orderChildren(layoutsEl, ordered)
    return nodes
  }

  /** The slots and dividers of one layout: `slot (divider slot)*`, reusing what is already there. */
  private syncSlots(
    doc: Document,
    root: HTMLElement,
    lv: LayoutView,
    view: DockView,
    out: Map<SlotId, HTMLElement>,
  ): void {
    // Same hole a discarded layout root has, and then some: the slot ids that reach here are the ones
    // the sweep above did NOT clear, so an orphan element can hold a mount that is still very much
    // live — a slot hand-moved to another layout in the raw JSON keeps its id and its view.
    const discard = (el: HTMLElement): void => {
      this.discardSubtree(doc, el)
    }
    const existing = keyedChildren(root, '.sdock-slot', (el) => el.dataset.slotId ?? '', discard)
    const dividers = [...root.querySelectorAll<HTMLElement>(':scope > .sdock-divider')]
    const ordered: HTMLElement[] = []

    for (const [index, slot] of lv.slots.entries()) {
      if (index > 0) {
        const at = index - 1
        const reuse: HTMLElement | undefined = dividers[at]
        const divider = reuse ?? createDivider(doc)
        // The index is what the drag reads to know which pair of weights it is moving.
        if (divider.dataset.dividerIndex !== String(at)) divider.dataset.dividerIndex = String(at)
        ordered.push(divider)
      }

      let slotEl = existing.get(slot.id)
      existing.delete(slot.id)
      if (slotEl === undefined) slotEl = doc.createElement('div')
      this.applySlotAttributes(slotEl, slot.id)
      this.syncSlotControls(doc, slotEl, lv, index, view)
      ordered.push(slotEl)
      out.set(slot.id, slotEl)
    }

    for (const orphan of existing.values()) discard(orphan)
    // Dividers are bare 6px bars of our own — nothing is ever mounted into one.
    for (const extra of dividers.slice(Math.max(0, lv.slots.length - 1))) extra.remove()
    orderChildren(root, ordered)
  }

  /**
   * Take one of our own subtrees — a layout root or a single slot element — out of the document.
   *
   * Never a bare `remove()`, because what is being discarded is not ours all the way down. An adopted
   * `#<pid>_lsp_main` inside it is the host's ONLY copy of that plugin's view: destroying it leaves the
   * plugin with nothing to dock for the rest of the session. A macro wrapper inside it holds injected
   * UI whose libs-side teardown closure is stranded unless `_forceCleanInjectedUI` runs first.
   *
   * Two populations arrive here, and only one of them has mount records:
   *
   * - Elements being replaced while their slot id is still configured — a duplicate, or a slot moved
   *   between layouts by a hand edit of the raw JSON. {@link syncLayouts} only clears the mounts of
   *   slot ids that VANISHED from the configuration, so these still hold a live mount; it is released
   *   through the ordinary path, which hands adopted nodes back and unmounts embed providers.
   * - Husks left by a crashed previous life of this plugin, whose slot ids this module's fresh scope
   *   has never heard of. Nothing describes them, hence the id sweep — the case a bare `.remove()`
   *   gets wrong precisely because there is no record to consult.
   */
  private discardSubtree(doc: Document, el: HTMLElement): void {
    // Records first: dropping a record silences its watchers before the DOM moves underneath them.
    // `Node.contains` is reflexive, so this covers `el` being the slot element itself.
    for (const [slotId, mount] of [...this.mounts]) {
      if (el.contains(mount.slotEl)) this.clearSlot(doc, slotId, 'deselect')
    }
    // Whatever no record described. `release` applies the same staleness rules as everywhere else, so
    // a plugin's live container goes back to the host body and a husk of a reloaded plugin is dropped.
    runQuietly(() => {
      for (const node of el.querySelectorAll<HTMLElement>(`[id$="${MAIN_UI_SUFFIX}"]`)) {
        this.release(doc, node.id.slice(0, -MAIN_UI_SUFFIX.length), node, 'swap')
      }
    })
    // Removes `el`, running the host's `_forceCleanInjectedUI` for every injected-UI descendant on the
    // way out — the same teardown a macro wrapper gets, for the same reason.
    dropMacroWrapper(el)
  }

  /**
   * Host rule 1 (stable id + `data-embed-host`) is enforced rather than assumed. These are our own
   * nodes now, so nothing strips the attributes — but a slot element inherited from a previous life of
   * this plugin, or from a build that spelled the id differently, would otherwise stay unmountable.
   */
  private applySlotAttributes(el: HTMLElement, slotId: SlotId): void {
    if (el.className !== 'sdock-slot') el.className = 'sdock-slot'
    if (el.dataset.slotId !== slotId) el.dataset.slotId = slotId
    const id = slotElementId(this.pluginId, slotId)
    if (el.id !== id) el.id = id
    if (el.getAttribute(EMBED_HOST_ATTR) !== this.pluginId) el.setAttribute(EMBED_HOST_ATTR, this.pluginId)
  }

  /**
   * The tab strip: one chip per layout plus the fixed nav tab, and the two icon buttons.
   *
   * Everything here is scoped to `tabsEl` and nothing else — no lookup climbs to a shared parent —
   * which is what lets the strip live in the header while the layout roots it switches between stay in
   * the sidebar column, two host subtrees away.
   */
  private syncTabs(doc: Document, tabsEl: HTMLElement, view: DockView): void {
    const existing = keyedChildren(tabsEl, '.sdock-tab', (el) => el.dataset.tab ?? '')
    const ordered: HTMLElement[] = []

    // Nav first and always, with a fixed label; then one tab per layout, in configuration order.
    const wanted: { tab: string; label: string }[] = [
      { tab: NAV_TAB, label: 'Nav' },
      ...view.layouts.map((lv) => ({ tab: lv.id, label: lv.config.name })),
    ]
    for (const { tab, label } of wanted) {
      let el = existing.get(tab)
      existing.delete(tab)
      if (el === undefined) {
        el = doc.createElement('button')
        el.className = 'sdock-tab'
        el.dataset.tab = tab
        el.setAttribute('data-on-click', MODELS.selectTab)
      }
      // A rename must not re-create the node: the active-tab rule matches on `data-tab`, and replacing
      // the chip under the pointer loses the click that is still in flight.
      if (el.textContent !== label) el.textContent = label
      ordered.push(el)
    }
    for (const orphan of existing.values()) orphan.remove()

    // The icon buttons are not tabs (no `data-tab`, so the active-chip rule cannot match them) and
    // always sit after the last one. Both stay usable outside edit mode on purpose: creating a first
    // layout must not require finding a control that only appears once you already have one.
    ordered.push(
      ensureTabButton(doc, tabsEl, MODELS.toggleEdit, 'sdock-tab-btn sdock-gear', '\u2699', 'Edit layouts'),
      ensureTabButton(doc, tabsEl, MODELS.addLayout, 'sdock-tab-btn', '+', 'Add a layout'),
    )
    orderChildren(tabsEl, ordered)
  }

  /**
   * The active layout's own controls. A child of the container, NOT of `.sdock-layout`: that element's
   * `flex-direction` is the user's axis, so a control row inside a row layout would be laid out as one
   * more column beside the slots.
   */
  private syncEditbar(doc: Document, container: HTMLElement, layoutsEl: HTMLElement, view: DockView): void {
    const existing = container.querySelector<HTMLElement>(':scope > .sdock-editbar')
    const active = view.activeLayout
    if (active === null) {
      existing?.remove()
      return
    }

    const key = `${active.id}|${active.name}|${active.axis}|${String(active.slots.length)}`
    // Rebuilt only when what it shows actually changed — see `syncSlotControls`.
    if (existing !== null && existing.dataset.sdockKey === key) return

    const bar = doc.createElement('div')
    bar.className = 'sdock-editbar'
    bar.dataset.sdockKey = key

    const name = doc.createElement('input')
    name.className = 'sdock-input'
    name.type = 'text'
    name.value = active.name
    name.maxLength = MAX_NAME_LENGTH
    name.title = 'Layout name'
    name.dataset.layoutId = active.id
    // `change` (blur/Enter), never `input`: an assert can re-render this bar, and a per-keystroke
    // commit would fight it on every keystroke. Losing a half-typed name to a concurrent assert is the
    // accepted failure mode.
    name.setAttribute('data-on-change', MODELS.renameLayout)
    bar.appendChild(name)

    const row = active.axis === 'row'
    bar.appendChild(
      miniButton(doc, row ? '\u2195' : '\u2194', row ? 'Stack slots vertically' : 'Lay slots out in a row', MODELS.toggleAxis, {
        layoutId: active.id,
      }),
    )
    if (active.slots.length < MAX_SLOTS_PER_LAYOUT) {
      bar.appendChild(miniButton(doc, '+ slot', 'Add a slot', MODELS.addSlot, { layoutId: active.id }))
    }
    const drop = miniButton(doc, 'Drop tab', 'Remove this layout', MODELS.removeLayout, { layoutId: active.id }, true)
    markArmable(drop, armKey('layout', active.id), this.armedKey)
    bar.appendChild(drop)

    if (existing === null) container.insertBefore(bar, layoutsEl)
    else container.replaceChild(bar, existing)
  }

  /**
   * The per-slot edit panel. Always in the DOM (the sheet hides it outside edit mode) and rebuilt only
   * when something it displays changed: asserts are triggered by everything from a route change to an
   * unrelated plugin reloading, and re-creating the panel on each one would eat a half-typed macro
   * spec. It is an absolutely positioned overlay, so its presence never resizes a mounted view.
   */
  private syncSlotControls(doc: Document, slotEl: HTMLElement, lv: LayoutView, index: number, view: DockView): void {
    const slot = lv.slots[index]
    const source = lv.config.slots[index].source
    const shared = source.kind === 'plugin' && view.sharedPids.has(source.pid)
    const key = [
      lv.id,
      slot.id,
      String(index),
      String(lv.slots.length),
      sourceKey(source),
      shared ? 'shared' : '',
      view.pluginOptions.join(','),
    ].join('|')

    const existing = slotEl.querySelector<HTMLElement>(`:scope > .${CONTROLS_CLASS}`)
    if (existing !== null && existing.dataset.sdockKey === key) return

    const panel = doc.createElement('div')
    panel.className = CONTROLS_CLASS
    panel.dataset.sdockKey = key
    panel.appendChild(buildSourcePicker(doc, slot.id, source, view.pluginOptions))
    if (source.kind === 'macro') panel.appendChild(buildMacroInput(doc, slot.id, source.raw))
    panel.appendChild(buildSlotButtons(doc, lv, index, this.armedKey))
    // Worth saying in place rather than in a doc: the reload it costs is the accepted price of letting
    // two layouts share a plugin, but only if the user knows about it.
    if (shared) panel.appendChild(buildHint(doc, SHARED_PID_HINT))

    if (existing === null) slotEl.appendChild(panel)
    else slotEl.replaceChild(panel, existing)
  }

  /**
   * The parse-error diagnostic, at the top of the dock container — above the editbar and the layout
   * roots, both of which the nav face hides. This is precisely the state the user has to be told about
   * wherever they are (while it is showing, every edit is refused), and the nav face hides the whole
   * container now that the strip has left it, so the sheet carries a `:has(.sdock-config-error)`
   * carve-out that keeps the container on screen for exactly this child.
   */
  private syncConfigError(doc: Document, container: HTMLElement, view: DockView): void {
    const existing = container.querySelector<HTMLElement>(':scope > .sdock-config-error')
    if (view.error === null) {
      existing?.remove()
      return
    }
    const text = `${CONFIG_ERROR_TEXT} ${view.error}`
    if (existing !== null && existing.dataset.sdockKey === text) return
    const hint = buildHint(doc, text)
    hint.classList.add('sdock-config-error')
    if (existing === null) container.insertBefore(hint, container.firstChild)
    else container.replaceChild(hint, existing)
  }

  // ------------------------------------------------------------------ slot filling

  /** Bring one slot in line with its spec: keep, re-mount, evict-notice, or mount fresh. */
  private async dockSlot(doc: Document, slotEl: HTMLElement, slot: ResolvedSlot, active: boolean): Promise<void> {
    const slotId = slot.id
    const spec = slot.spec

    if (spec.kind === 'none' || spec.kind === 'invalid-macro') {
      this.clearSlot(doc, slotId, 'deselect')
      renderPlaceholder(slotEl, spec.kind === 'none' ? NO_SELECTION_TEXT : INVALID_MACRO_TEXT)
      return
    }

    if (spec.kind === 'macro') {
      // Anything short of a live, same-spec wrapper with a responder in it re-mounts: that is what
      // heals a provider plugin reload, which drops its injected UI without telling us.
      if (this.isMacroHealthy(this.mounts.get(slotId), slotEl, spec.raw)) return
      await this.mountMacro(doc, slotEl, slotId, spec.raw, spec.args)
      return
    }

    const pid = spec.pid
    const current = this.mounts.get(slotId)
    if (current !== undefined && current.strategy !== 'macro' && current.pid === pid) {
      if (current.strategy === 'embed') {
        const health = classifySlot({
          sameSlotElement: current.slotEl === slotEl,
          hasEmbedSubtree: this.hasEmbedSubtree(slotEl, pid),
        })
        if (health === 'healthy') return
        if (health === 'evicted') {
          // Host rule 4: the provider moved the view elsewhere. Only the user may take it back.
          this.takeMount(slotId)
          renderPlaceholder(slotEl, EVICTED_TEXT, reclaimAction(slotId))
          // Keep the record so repeated asserts stay on this branch instead of re-mounting.
          this.mounts.set(slotId, { ...current, slotEl, watcher: null, watchTimer: null })
          return
        }
        // 'remount': our slot element was re-created, which is the provider's only recovery signal.
        // The old record points at a dead node, and rule 3 says re-mount rather than unmount.
        this.takeMount(slotId)
      } else {
        // Adoption stays valid only while we hold the plugin's CURRENT main-UI node.
        const canonical = doc.getElementById(mainUiId(pid))
        if (current.node !== null && current.node === canonical && canonical.parentElement === slotEl) return
      }
    }

    // A plugin's main UI is ONE node, so at most one slot can adopt it. The visible layout wins: a slot
    // in a hidden layout leaves the node where it is and steals it back when its own tab is activated
    // (spec, "Mounting"). Without this the two slots would re-adopt in turn on every single assert and
    // reload the plugin each time.
    if (!active && this.adoptedElsewhere(slotId, pid)) return

    await this.mountView(doc, slotEl, slotId, pid)
  }

  /** Is this pid's one adoptable node already held by a DIFFERENT slot? */
  private adoptedElsewhere(slotId: SlotId, pid: string): boolean {
    for (const [id, mount] of this.mounts) {
      if (id !== slotId && mount.strategy === 'adopt' && mount.pid === pid) return true
    }
    return false
  }

  /**
   * The adapter chain: protocol first, main-UI adoption second, placeholder last.
   *
   * The slot keeps showing whatever it showed until one of them actually succeeds — a dead probe
   * against a non-provider would otherwise blank the slot for its whole budget. Probing a populated
   * slot is safe: verification looks for `[data-embed-owner]`, which our own content never carries.
   */
  private async mountView(doc: Document, slotEl: HTMLElement, slotId: SlotId, pid: string): Promise<void> {
    const previous = this.takeMount(slotId)
    const action = this.strategies.action(pid)

    if (action !== 'use-adopt') {
      const mounted = await this.probeEmbed(slotEl, pid, this.strategies.budgetMs(pid))
      if (action === 'probe') this.strategies.set(pid, strategyFromProbe(mounted))
      if (mounted) {
        this.releaseMount(doc, previous, 'deselect')
        this.commitEmbed(doc, slotEl, slotId, pid)
        return
      }
      // Cached as a provider but it did not come back — re-probe from scratch next time.
      if (action === 'use-embed') this.strategies.invalidate(pid)
    }

    this.releaseMount(doc, previous, 'deselect')
    this.adoptMainUi(doc, slotEl, slotId, pid)
  }

  private hasEmbedSubtree(slotEl: HTMLElement, pid: string): boolean {
    const el = slotEl.querySelector(embedOwnerSelector(pid))
    return el !== null && el.isConnected
  }

  /**
   * Invoke `embedMount` until a subtree shows up or the budget runs out.
   *
   * Every iteration re-invokes on purpose: the host dispatches `callUserModel` directly, with no
   * queueing, so a call that lands before the provider registered its models is silently dropped and
   * polling alone would wait out the whole budget for a provider that is merely booting. `embedMount`
   * is idempotent (provider rule 3), so repeating it costs nothing. Verification is DOM-only — host
   * rule 7 — because `invokeExternalPlugin` resolves `undefined` either way.
   */
  private async probeEmbed(slotEl: HTMLElement, pid: string, budgetMs: number): Promise<boolean> {
    for (const delay of probeDelays(budgetMs)) {
      if (this.disposed) return false
      invokeEmbedModel(pid, 'embedMount', slotEl.id, this.pluginId)
      await sleep(delay)
      if (this.disposed) return false
      if (this.hasEmbedSubtree(slotEl, pid)) return true
    }
    return false
  }

  /**
   * Take ownership of the slot now that the provider's subtree is in it.
   *
   * Claims the slot first: a Reclaim click and an assert can both reach here for the same slot, and
   * without this the loser's record would survive as a detached, identity-dead MutationObserver (and
   * `clearHostChildren` below would destroy an adopted node instead of handing it back).
   */
  private commitEmbed(doc: Document, slotEl: HTMLElement, slotId: SlotId, pid: string): void {
    this.releaseMount(doc, this.takeMount(slotId), 'deselect')
    clearHostChildren(slotEl)
    const mount: SlotMount = {
      pid,
      strategy: 'embed',
      slotEl,
      node: null,
      macroSpec: null,
      poked: false,
      watcher: null,
      watchTimer: null,
    }
    this.mounts.set(slotId, mount)
    this.watchEmbedSubtree(slotId, mount)
  }

  // ------------------------------------------------------------------ macro slots

  /** A macro mount survives an assert only while its own wrapper is still standing and answered. */
  private isMacroHealthy(mount: SlotMount | undefined, slotEl: HTMLElement, raw: string): boolean {
    if (mount === undefined || mount.strategy !== 'macro' || mount.macroSpec !== raw) return false
    const wrapper = mount.node
    if (wrapper === null || !wrapper.isConnected || wrapper.parentElement !== slotEl) return false
    return wrapper.querySelector(INJECTED_UI_SELECTOR) !== null
  }

  /**
   * Fill the slot by impersonating the host's own macro render: park a wrapper with a stable id in
   * the slot, then broadcast `macro-renderer-slotted` naming it until some plugin injects into it
   * (see `macro.ts` for why the host accepts an element it did not create).
   *
   * The record goes in before the first emission so that a responder arriving between two ticks is
   * never orphaned, and so the usual teardown paths own the wrapper from the start — `releaseMount`
   * is what runs the host's `_forceCleanInjectedUI` before the wrapper is removed.
   *
   * Whatever the slot showed before stays until a responder actually turns up (the wrapper is
   * positioned over it): a macro nobody answers must not blank its own diagnosis for six seconds on
   * every single assert.
   */
  private async mountMacro(
    doc: Document,
    slotEl: HTMLElement,
    slotId: SlotId,
    raw: string,
    args: readonly string[],
  ): Promise<void> {
    this.releaseMount(doc, this.takeMount(slotId), 'deselect')

    // Our module scope resets on reload, the host document does not: an instance killed without
    // `beforeunload` leaves a wrapper carrying this very id behind. The host resolves the hook's
    // slot by `getElementById`, so a duplicate would hand our macro to the corpse — and we would
    // report "nobody answered" over a macro that answered perfectly well.
    const stale = doc.getElementById(macroSlotDomId(this.pluginId, slotId))
    if (stale !== null) dropMacroWrapper(stale)

    // Built in the HOST realm — this node lives in the host document.
    const wrapper = doc.createElement('div')
    wrapper.className = 'sdock-macro'
    wrapper.id = macroSlotDomId(this.pluginId, slotId)
    slotEl.appendChild(wrapper)

    const mount: SlotMount = {
      pid: '',
      strategy: 'macro',
      slotEl,
      node: wrapper,
      macroSpec: raw,
      poked: false,
      watcher: null,
      watchTimer: null,
    }
    this.mounts.set(slotId, mount)

    const payload = buildMacroHookPayload(wrapper.id, args)
    const budget = this.unansweredMacros.has(raw) ? MACRO_REPROBE_BUDGET_MS : MACRO_HOOK_BUDGET_MS
    for (const delay of probeDelays(budget)) {
      // A newer mount for this slot has taken over (and released this wrapper) — leave it to it.
      if (this.disposed || this.mounts.get(slotId) !== mount) return
      // Unreachable bridge: nothing will ever answer, so stop burning the budget on it.
      if (!emitHostAppHook(MACRO_HOOK_TYPE, payload)) break
      await sleep(delay)
      if (this.disposed || this.mounts.get(slotId) !== mount) return
      if (wrapper.querySelector(INJECTED_UI_SELECTOR) !== null) {
        // Answered: only now is it safe to drop whatever the slot was showing before.
        clearHostChildren(slotEl, wrapper)
        this.unansweredMacros.delete(raw)
        return
      }
    }

    // Nobody answered: drop the empty wrapper and say so. The next assert retries from scratch, but
    // on the short budget — this spec has now proven it can stall an assert for nothing.
    this.unansweredMacros.add(raw)
    this.releaseMount(doc, this.takeMount(slotId), 'deselect')
    renderPlaceholder(slotEl, MACRO_UNANSWERED_TEXT)
  }

  // ------------------------------------------------------------------ adoption

  /** Legacy strategy: re-parent the plugin's own main-UI container into the slot. */
  private adoptMainUi(doc: Document, slotEl: HTMLElement, slotId: SlotId, pid: string): void {
    const canonical = doc.getElementById(mainUiId(pid))
    if (canonical === null) {
      // Either there is nothing to dock, or the plugin has not finished booting — the missing-view
      // watch keeps looking for a while before we settle on the placeholder. A configured poke is
      // the third possibility: the plugin builds its main UI only once its toggle has run.
      this.missingPids.add(pid)
      // Once per missing-view EPISODE, not once per assert. A poke target that toggles something
      // which never becomes a main UI (a modal, a right-sidebar item) would otherwise be re-invoked
      // forever — every route change and lifecycle event lands here, and they are easily more than
      // the cooldown apart. The episode ends when this plugin's lifecycle fires or the settings
      // change; the cooldown is only the backstop for a burst.
      if (!this.pokedWhileMissing.has(pid) && this.poke(pid)) this.pokedWhileMissing.add(pid)
      renderPlaceholder(slotEl, `"${pid}" has no view to dock. Is the plugin installed and enabled?`)
      return
    }

    // The view turned up, so the missing-view episode is over: if it ever goes missing again that is
    // a NEW episode and worth one more poke. The flapping case this guards against is exactly the
    // one that never reaches here, because its poke target never produces a main UI.
    this.pokedWhileMissing.delete(pid)

    clearHostChildren(slotEl)
    slotEl.appendChild(canonical)
    // Appending MOVED the node out of whatever slot held it before, so any other record describing it
    // is now a lie — and a dangerous one: its `watchAdoptedContent` would diagnose a slot it does not
    // own, and releasing it later would see the node as canonical and hand it back to the host body,
    // yanking it out of the slot that legitimately holds it.
    this.dropOtherAdoptions(pid, slotId)
    const mount: SlotMount = {
      pid,
      strategy: 'adopt',
      slotEl,
      node: canonical,
      macroSpec: null,
      poked: false,
      watcher: null,
      watchTimer: null,
    }
    this.mounts.set(slotId, mount)
    this.watchAdoptedContent(slotId, mount)
  }

  /**
   * Forget every OTHER slot's adopt record for this pid — record only, no DOM: the node has already
   * moved, and the slot it left keeps whatever else was in it until its own layout is asserted again.
   * Embed mounts are deliberately untouched, since the protocol passes the slot id and one provider
   * may legitimately serve several slots at once.
   */
  private dropOtherAdoptions(pid: string, keep: SlotId): void {
    for (const [slotId, mount] of [...this.mounts]) {
      if (slotId === keep) continue
      if (mount.strategy === 'adopt' && mount.pid === pid) this.takeMount(slotId)
    }
  }

  /**
   * Nudge a plugin into rendering its main UI, if the user configured a way to do it.
   *
   * Some plugins only build `#<pid>_lsp_main` when their toggle model or command runs, so there is
   * nothing to adopt until something invokes it. That same toggle is why this is rate-limited rather
   * than retried: poking twice in a row would close the view we just opened.
   *
   * Returns whether the invocation actually went out, so a caller tracking "already tried" does not
   * burn its one attempt on a call the cooldown swallowed.
   */
  private poke(pid: string): boolean {
    const target = parseAdoptPokes(this.store.current().adoptPoke).get(pid)
    if (target === undefined) return false

    const now = Date.now()
    const last = this.pokedAt.get(pid)
    if (last !== undefined && now - last < POKE_COOLDOWN_MS) return false
    this.pokedAt.set(pid, now)

    void logseq.App.invokeExternalPlugin(`${pid}.${target}`).catch(() => {
      // No error channel: a missing model or command resolves exactly like a present one, and the
      // main UI showing up (or not) is the only answer we get.
    })
    return true
  }

  /**
   * Eviction detection. Our container-health observer says nothing about what happens INSIDE a slot,
   * so a provider that hands its view to another surface (provider rule 6, "remove the subtree") would
   * go unnoticed until some unrelated assert came along. Watch the slot itself instead.
   *
   * The watcher is bound to the mount record's identity and dies with it, so our own teardown paths —
   * which drop the record before touching the DOM — can never trigger it.
   */
  private watchEmbedSubtree(slotId: SlotId, mount: SlotMount): void {
    const observer = new MutationObserver(() => {
      if (this.disposed || this.mounts.get(slotId) !== mount || mount.watchTimer !== null) return
      mount.watchTimer = setTimeout(() => {
        mount.watchTimer = null
        if (this.disposed || this.mounts.get(slotId) !== mount) return
        // A provider swapping its own root is not an eviction — only a lasting absence is.
        if (this.hasEmbedSubtree(mount.slotEl, mount.pid)) return
        void this.assert()
      }, EMBED_WATCH_DEBOUNCE_MS)
    })
    observer.observe(mount.slotEl, { childList: true, subtree: true })
    mount.watcher = observer
  }

  /**
   * An adopted iframe reloads when it is moved, and some plugins have no main UI to show at all — both
   * end as a silently empty box. Watch the iframe's document (same-origin) and, once the reboot grace
   * has passed with nothing in it, overlay a diagnosis. Undocking instead would only cause one more
   * reload, so the node stays put and the overlay comes and goes with the content.
   */
  private watchAdoptedContent(slotId: SlotId, mount: SlotMount): void {
    void (async (): Promise<void> => {
      const deadline = Date.now() + ADOPT_CONTENT_GRACE_MS
      let graced = false

      for (;;) {
        await sleep(ADOPT_RECHECK_MS)
        if (this.disposed || this.mounts.get(slotId) !== mount) return
        if (mount.node === null || !mount.node.isConnected) return

        const probe = readIframeBody(mount.node)
        if (hasMeaningfulContent(probe.body)) {
          clearOverlay(mount.slotEl)
          graced = true
          continue
        }
        if (!graced && Date.now() < deadline) continue

        // Empty past the reboot grace: a plugin that only renders once toggled looks exactly like
        // this, so spend the mount's single poke here before settling on the diagnosis. If it works,
        // the next tick sees content and clears the overlay again. The flag is consumed only when
        // the invocation actually went out — a poke the cooldown swallowed was never an attempt, and
        // burning the mount's one chance on it would strand the view for as long as it stays docked.
        if (!mount.poked && this.poke(mount.pid)) mount.poked = true

        graced = true
        renderOverlay(
          mount.slotEl,
          `"${mount.pid}" has no dockable view — its main UI is empty; it may not support docking.`,
          probe.error,
        )
      }
    })()
  }

  private async runReclaim(slotId: SlotId): Promise<void> {
    const doc = getHostDocument()
    if (doc === null || this.disposed) return
    const container = doc.getElementById(this.containerId)
    if (container === null) return
    // By id rather than by selector: slot ids are generated, and a dataset selector would have to be
    // escaped for a value we did not build.
    const slotEl = doc.getElementById(slotElementId(this.pluginId, slotId))
    if (slotEl === null || !container.contains(slotEl)) return

    // Reclaim only exists for evicted embed mounts, so anything but a plugin selection is a no-op.
    const spec = this.specFor(slotId)
    if (spec === null || spec.kind !== 'plugin') return
    const pid = spec.pid

    const previous = this.takeMount(slotId)
    if (await this.probeEmbed(slotEl, pid, this.strategies.budgetMs(pid))) {
      this.commitEmbed(doc, slotEl, slotId, pid)
      return
    }
    // Still gone: put the notice back rather than leaving an empty slot behind.
    if (previous !== undefined) this.mounts.set(slotId, { ...previous, slotEl, watcher: null, watchTimer: null })
    renderPlaceholder(slotEl, EVICTED_TEXT, reclaimAction(slotId))
  }

  /** What this slot is configured to show, across every layout. */
  private specFor(slotId: SlotId): ViewSpec | null {
    for (const lv of this.resolveView().layouts) {
      for (const slot of lv.slots) {
        if (slot.id === slotId) return slot.spec
      }
    }
    return null
  }

  /**
   * Detach a slot's mount record and silence its watchers, without touching the DOM yet. Dropping the
   * record first is what makes the watchers inert during our own teardown: they all bail as soon as
   * the record they were bound to is no longer the slot's.
   */
  private takeMount(slotId: SlotId): SlotMount | undefined {
    const mount = this.mounts.get(slotId)
    if (mount === undefined) return undefined
    this.mounts.delete(slotId)
    if (mount.watchTimer !== null) {
      clearTimeout(mount.watchTimer)
      mount.watchTimer = null
    }
    mount.watcher?.disconnect()
    mount.watcher = null
    return mount
  }

  /** Hand a detached mount back: adopted nodes to the host body, providers an `embedUnmount`. */
  private releaseMount(doc: Document, mount: SlotMount | undefined, reason: ClearReason): void {
    if (mount === undefined) return
    if (mount.strategy === 'macro') {
      // Deliberately unlike the embed branch's wipe exception: injected UI cannot outlive the
      // element it was injected into, so there is no "keep it mounted" case to preserve.
      if (mount.node !== null) dropMacroWrapper(mount.node)
      return
    }
    if (mount.strategy === 'embed') {
      // Host rule 5, and rule 3's exception: a wiped slot is coming back, so keep the provider mounted.
      if (reason !== 'wipe') invokeEmbedModel(mount.pid, 'embedUnmount', mount.slotEl.id, this.pluginId)
      return
    }
    if (mount.node !== null) this.release(doc, mount.pid, mount.node, reason === 'wipe' ? 'wipe' : 'swap')
  }

  /** Empty one slot, telling the provider only when the view is genuinely being given up. */
  private clearSlot(doc: Document, slotId: SlotId, reason: ClearReason): void {
    this.releaseMount(doc, this.takeMount(slotId), reason)
  }

  /**
   * Forget the embed mounts belonging to the plugin a registry event was about, and purge any dead
   * subtree it left in the slot. A well-behaved provider sweeps its own subtrees in `beforeunload`,
   * but a crashed or killed one cannot — and its husk would satisfy the next probe's
   * `hasEmbedSubtree` check, committing a dead pane we would then believe healthy and never re-probe.
   * With record and husk both gone, the next assert re-establishes the view through the normal
   * probing path against a live provider only. No `embedUnmount`: the provider may be gone, and if it
   * is not, `embedMount` is idempotent, so a live provider simply mounts fresh on the probe's first
   * invoke.
   *
   * Strictly scoped by pid — see {@link droppedByLifecycle} for why an unrelated plugin's event must
   * never reach an evicted record.
   */
  private dropInvalidatedMounts(changedPid: string | null): void {
    for (const [slotId, mount] of [...this.mounts]) {
      // Macro mounts belong to no plugin, so the protocol-pure rule below has nothing to say about
      // them; they heal through their own health check on the assert this event triggers anyway.
      const strategy = mount.strategy
      if (strategy === 'macro') continue
      if (!droppedByLifecycle({ pid: mount.pid, strategy }, changedPid)) continue
      // Record first: takeMount silences the slot watcher, so the purge below can never read as an
      // eviction. The purge only touches the dropped mount's own pid, keeping the scoping honest.
      this.takeMount(slotId)
      runQuietly(() => {
        for (const husk of mount.slotEl.querySelectorAll(embedOwnerSelector(mount.pid))) husk.remove()
      })
    }
  }

  /**
   * Give a foreign node back to the host — but only if it is still that plugin's live container.
   *
   * Two ways it can be stale: the plugin reloaded (the host built a fresh `#<pid>_lsp_main`, ours is a
   * husk) or the plugin was disabled/uninstalled (the host destroyed it and built nothing). Either way
   * re-appending our copy would plant a duplicate-id `.lsp-iframe-sandbox-container.visible` zombie
   * over the whole viewport. Stale nodes are dropped; see {@link ReleaseMode} for the one rescue case.
   */
  private release(doc: Document, pid: string, node: HTMLElement, mode: ReleaseMode): void {
    runQuietly(() => {
      const canonical = doc.getElementById(mainUiId(pid))
      const rescue = canonical === node || (canonical === null && mode === 'wipe' && !node.isConnected)
      if (rescue) {
        doc.body.appendChild(node)
      } else {
        node.remove()
      }
    })
  }

  // ------------------------------------------------------------------ divider

  /**
   * One delegated listener set on `.sdock-layouts`, not one per divider: dividers come and go with
   * every slot the user adds, and re-binding per node would either leak listeners or need a
   * per-element bookkeeping map. Only a fresh `.sdock-layouts` (i.e. a re-injected container) re-binds.
   */
  private attachDividers(doc: Document, layoutsEl: HTMLElement): void {
    if (layoutsEl.dataset.sdockDividers === '1') return

    // A fresh element means the old listeners (and any drag they had in flight) belong to a dead node.
    this.endDrag()
    this.dividerAbort?.abort()
    const abort = new AbortController()
    this.dividerAbort = abort
    const signal = abort.signal

    layoutsEl.addEventListener(
      'pointerdown',
      (ev) => {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return
        const divider = closestElement(ev.target, '.sdock-divider')
        if (divider === null) return
        ev.preventDefault()
        this.startDrag(doc, divider, ev)
      },
      { signal },
    )

    // The host's mobile drawer swipe handlers sit on #left-sidebar — keep our drag away from them.
    layoutsEl.addEventListener(
      'touchstart',
      (ev) => {
        if (closestElement(ev.target, '.sdock-divider') !== null) ev.stopPropagation()
      },
      { signal, passive: true },
    )
    layoutsEl.addEventListener(
      'touchmove',
      (ev) => {
        if (closestElement(ev.target, '.sdock-divider') === null) return
        ev.stopPropagation()
        ev.preventDefault()
      },
      { signal, passive: false },
    )

    layoutsEl.dataset.sdockDividers = '1'
  }

  private startDrag(doc: Document, divider: HTMLElement, down: PointerEvent): void {
    // Grabbing a divider is an edit-mode interaction like any other: it retracts a pending arm.
    this.disarm()
    const root = divider.parentElement
    if (root === null) return
    const index = Number(divider.dataset.dividerIndex)
    if (!Number.isInteger(index)) return
    const layout = findLayout(this.resolveView().config, root.dataset.layout ?? '')
    if (layout === null || index + 1 >= layout.slots.length) return

    this.endDrag()
    const abort = new AbortController()
    this.dragAbort = abort
    const signal = abort.signal
    this.dragging = true
    divider.classList.add('is-dragging')
    // Best effort only: the 6px divider loses the pointer immediately, so the real guarantee below is
    // the capture-phase listeners on the host document, not this call.
    runQuietly(() => {
      divider.setPointerCapture(down.pointerId)
    })

    // The drag-START weights and extent, measured once: `resizeWeights` takes an ABSOLUTE delta, so
    // feeding it its own previous result would integrate the rounding error and let the pair creep.
    const start = layout.slots.map((slot) => slot.weight)
    const row = layout.axis === 'row'
    const rect = root.getBoundingClientRect()
    const containerPx = row ? rect.width : rect.height
    const origin = row ? down.clientX : down.clientY
    let latest = start

    doc.addEventListener(
      'pointermove',
      (ev) => {
        // A second finger must not yank the divider.
        if (ev.pointerId !== down.pointerId) return
        const deltaPx = (row ? ev.clientX : ev.clientY) - origin
        latest = resizeWeights(start, index, deltaPx, containerPx, SLOT_MIN_PX)
        // The one inline style the host gotchas allow, because the node is OURS: the custom properties
        // the sheet's `flex-grow` reads, on the layout root they are scoped to. Only the two slots the
        // divider is between can have changed.
        runQuietly(() => {
          for (const at of [index, index + 1]) {
            root.style.setProperty(slotWeightVar(layout.slots[at].id), String(latest[at]))
          }
        })
      },
      { signal, capture: true },
    )

    const finish = (ev: PointerEvent): void => {
      if (ev.pointerId !== down.pointerId) return
      if (!this.dragging) return
      divider.classList.remove('is-dragging')
      runQuietly(() => {
        divider.releasePointerCapture(down.pointerId)
      })
      this.endDrag()
      // Bake the weights into the persistent sheet. The inline vars stay until the assert this
      // triggers proves the new sheet has landed: `provideStyle` is fire-and-forget, so dropping them
      // here snaps back to the old ratio for a few frames.
      this.commitWeights(layout.id, latest)
    }
    doc.addEventListener('pointerup', finish, { signal, capture: true })
    doc.addEventListener('pointercancel', finish, { signal, capture: true })
  }

  /** Persist the weights a finished drag produced (a no-op unless the layout still has that many). */
  private commitWeights(layoutId: string, weights: readonly number[]): void {
    this.edit((config) => setLayoutWeights(config, layoutId, weights))
  }

  private endDrag(): void {
    this.dragging = false
    this.dragAbort?.abort()
    this.dragAbort = null
  }

  // ------------------------------------------------------------------ sidebar width

  /**
   * Hijack the host's own sidebar resizer — on every tab, the stock navigation included.
   *
   * The host clamps its own drag to 240-460px, far too narrow for a column of docked plugin views, so
   * the handle drives OUR width instead. Unconditional, because the dock width IS the sidebar width:
   * our `!important` rule masks whatever the host's clamped drag would write anyway, so leaving that
   * drag live on the Nav tab would only make the handle feel broken there. Its handler is an
   * interact.js draggable bound on the DOCUMENT in the bubble phase, so a capture-phase listener on the
   * handle itself runs long before it and can stop the event from ever reaching it.
   *
   * Failure mode, should that stop holding (interact.js binding in capture, or directly on the handle):
   * both drags run, the host writes its clamped value into the inline `--ls-left-sidebar-width` — and
   * our `!important` rule simply masks it. Degraded to the host's clamp, never broken.
   *
   * Bound by element IDENTITY rather than by marking the node the way `attachDividers` marks our own
   * `.sdock-layouts`: the handle is host-rendered markup, so any attribute of ours would be wiped by
   * the next re-render and we would re-bind on a node that already carries our listeners.
   */
  private assertWidthResizer(doc: Document): void {
    const el = doc.querySelector<HTMLElement>(WIDTH_RESIZER_SELECTOR)
    if (el === this.widthResizerEl) return

    // A fresh handle means the old listeners (and any drag they had in flight) belong to a dead node.
    this.endWidthDrag(doc)
    this.widthResizerAbort?.abort()
    this.widthResizerAbort = null
    this.widthResizerEl = el
    if (el === null) return

    const abort = new AbortController()
    this.widthResizerAbort = abort
    const signal = abort.signal

    el.addEventListener(
      'pointerdown',
      (ev) => {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return
        ev.stopPropagation()
        ev.stopImmediatePropagation()
        ev.preventDefault()
        this.startWidthDrag(doc, ev)
      },
      { signal, capture: true },
    )

    // interact.js may bind mouse events rather than pointer events, and swallowing `pointerdown` does
    // not suppress the compatibility `mousedown` that follows it.
    el.addEventListener(
      'mousedown',
      (ev) => {
        if (!this.widthDragging) return
        ev.stopPropagation()
        ev.stopImmediatePropagation()
        ev.preventDefault()
      },
      { signal, capture: true },
    )
  }

  /**
   * Our replacement for the host's clamped drag: the same handle and the same transient feedback, our
   * own bounds.
   *
   * Writing {@link WIDTH_VAR} inline on `documentElement` is not what the "never write inline styles onto
   * host nodes" rule is about: `<html>` is not host-RENDERED markup (no re-render wipes it) and this is
   * the host's own channel for exactly this value — `container.cljs` sets `--ls-left-sidebar-width`
   * there itself. The persistent value still goes through the sheet.
   *
   * The iframe pointer-events suspension every drag needs is already handled: {@link
   * installDragPassthrough} binds its own capture-phase `pointerdown` on the host DOCUMENT, which runs
   * BEFORE the handle-level listener above (capture descends root → target), so the class is on our
   * container before this method is even entered.
   *
   * No `setPointerCapture` on the handle: it belongs to the host, and the capture-phase listeners on
   * the host document are the real guarantee anyway (the divider's own capture call is best-effort).
   */
  private startWidthDrag(doc: Document, down: PointerEvent): void {
    this.endWidthDrag(doc)
    const sidebar = doc.getElementById(SIDEBAR_ID)
    if (sidebar === null) return

    const abort = new AbortController()
    this.widthDragAbort = abort
    const signal = abort.signal
    this.widthDragging = true

    // The host's own transient classes, set the way the host sets them (see RESIZING_CLASS).
    sidebar.classList.add(RESIZING_CLASS)
    doc.documentElement.classList.add(RESIZING_BUF_CLASS)

    // With no override in force the sheet carries no `!important` rule at all, so nothing would read
    // the transient var and the first drag frames would do nothing. Seed it with the width the sidebar
    // already has — the same value, so visually a no-op — to bring that rule into existence. The seed
    // is NOT a chosen width, so `widthDragRevert` stands ready to take it back until a real move
    // persists it (see the field's doc for the phantom-override failure it prevents).
    let latest = this.store.current().sidebarWidthPx
    let moved = false
    if (latest <= 0) {
      const seed = sidebar.getBoundingClientRect()
      latest = computeSidebarWidth(seed.right, seed.left, doc.documentElement.clientWidth)
      this.store.override({ sidebarWidthPx: latest })
      this.refreshStyle()
      this.widthDragRevert = (): void => {
        if (this.disposed) return
        this.store.override({ sidebarWidthPx: WIDTH_FOLLOW_HOST })
        this.refreshStyle()
      }
    }

    doc.addEventListener(
      'pointermove',
      (ev) => {
        // A second finger must not yank the sidebar.
        if (ev.pointerId !== down.pointerId) return
        if (ev.clientX !== down.clientX) moved = true
        const rect = sidebar.getBoundingClientRect()
        latest = computeSidebarWidth(ev.clientX, rect.left, doc.documentElement.clientWidth)
        runQuietly(() => {
          doc.documentElement.style.setProperty(WIDTH_VAR, `${String(latest)}px`)
        })
      },
      { signal, capture: true },
    )

    const finish = (ev: PointerEvent): void => {
      if (ev.pointerId !== down.pointerId) return
      if (!this.widthDragging) return
      // A click, not a drag: the user chose nothing, so nothing may persist — least of all the seed,
      // which would freeze "follow the host" into a fixed width. `endWidthDrag` reverts it.
      if (!moved) {
        this.endWidthDrag(doc)
        return
      }
      this.widthDragRevert = null
      this.store.override({ sidebarWidthPx: latest })
      // Bake the width into the persistent sheet. The inline var stays until the next assert clears
      // it: `provideStyle` is fire-and-forget, so dropping it here snaps back for a few frames.
      this.refreshStyle()
      // NOT through `edit()`: that gate is the `layouts` write path and refuses while the stored JSON
      // does not parse. The width belongs to no layout, so a typo in the raw config must not also cost
      // the user the ability to resize their sidebar.
      logseq.updateSettings({ sidebarWidthPx: this.store.current().sidebarWidthPx })
      this.endWidthDrag(doc)
      // Nothing about the DOM changed, but the assert is what proves the new sheet landed and drops
      // the transient var again.
      void this.assert()
    }
    doc.addEventListener('pointerup', finish, { signal, capture: true })
    doc.addEventListener('pointercancel', finish, { signal, capture: true })
  }

  private endWidthDrag(doc: Document): void {
    this.widthDragging = false
    this.widthDragAbort?.abort()
    this.widthDragAbort = null
    // An unfinished (aborted or never-moved) drag takes its seeded override back; a drag that persisted
    // cleared this first, so the persisted value stands.
    const revert = this.widthDragRevert
    this.widthDragRevert = null
    revert?.()
    // Idempotent, and safe when no drag ever ran: these are the host's classes and it removes them on
    // its own dragend the same way.
    runQuietly(() => {
      doc.getElementById(SIDEBAR_ID)?.classList.remove(RESIZING_CLASS)
      doc.documentElement.classList.remove(RESIZING_BUF_CLASS)
    })
  }

  // ------------------------------------------------------------------ host hooks

  private installHostHooks(): void {
    const doc = getHostDocument()
    if (doc === null) return

    // Module scope resets on plugin reload, the host document does not: run the previous instance's
    // teardown before installing ours, or observers/listeners stack up one set per reload.
    const stale = takeHostCleanup(doc)
    if (stale !== null) runQuietly(stale)

    const target: Node = doc.getElementById('app-container') ?? doc.body
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new MutationObserver(() => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        if (this.disposed) return
        // Three independent stakes in three host subtrees, any one of which is a reason to re-assert:
        // the dock container going down; the tab strip going down OR the header cell it belongs in
        // finally turning up under it (both read as "unhealthy", since placement is part of that
        // check); and the host re-rendering its own resizer handle, which would otherwise leave the
        // width hijack bound to a dead node until some unrelated event came along.
        if (
          !isHealthy(doc.getElementById(this.containerId)) ||
          !isTabsHealthy(doc, this.tabsId) ||
          doc.querySelector<HTMLElement>(WIDTH_RESIZER_SELECTOR) !== this.widthResizerEl
        ) {
          void this.assert()
        }
      }, OBSERVER_DEBOUNCE_MS)
    })
    observer.observe(target, { childList: true, subtree: true })

    // The whole app shell is replaced on some routes (e.g. /draw), which can strand the observer.
    const offRoute = logseq.App.onRouteChanged(() => {
      void this.assert()
    })

    // A hosted plugin that reloads gets a brand new main-UI container and may have gained or lost the
    // protocol models, so cached probe outcomes go stale; a newly installed one belongs in the
    // per-slot source picker.
    const offLifecycle = subscribeHostPluginLifecycle((changedPid) => {
      if (this.disposed) return
      // Cache invalidation only causes a re-probe, so an unattributable event may clear all of it.
      // Dropping mounts is the dangerous half and stays scoped to the plugin that actually changed.
      this.strategies.invalidate(changedPid ?? undefined)
      this.dropInvalidatedMounts(changedPid)
      // A plugin that just arrived may answer a macro nobody answered before; macro responders are
      // anonymous to us, so every such verdict goes. The poke episode is attributable, so only the
      // plugin the event is about gets another attempt at building its main UI.
      this.unansweredMacros.clear()
      if (changedPid !== null) this.pokedWhileMissing.delete(changedPid)
      this.onPluginsChanged?.()
      void this.assert()
    })

    const offPassthrough = this.installDragPassthrough(doc)

    setHostCleanup(doc, () => {
      // Usually run by a SUCCESSOR instance over a corpse of ours (a kill without `beforeunload`), so
      // silence the pending async loops too; on the normal dispose path this is already true. It also
      // has to be set BEFORE `endWidthDrag`, whose revert closure is a no-op once disposed — a corpse
      // must not re-provide a stylesheet under the successor that has already replaced it.
      this.disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      observer.disconnect()
      offRoute()
      offLifecycle?.()
      offPassthrough()
      // The width hijack binds capture listeners (with `stopImmediatePropagation`) to a HOST node that
      // outlives our module scope. Left standing after a kill-without-`beforeunload`, the stale
      // listener would fire first and block both the successor's hijack and the host's own resizer.
      this.endWidthDrag(doc)
      this.widthResizerAbort?.abort()
      this.widthResizerAbort = null
      this.widthResizerEl = null
      doc.documentElement.style.removeProperty(WIDTH_VAR)
    })
  }

  /**
   * Drag passthrough (mandatory next to any iframe adjacent to a divider — our own and the host's
   * `.left-sidebar-resizer` alike): while a drag is in flight, the docked iframes must not swallow
   * the pointer stream. Any pointer event we can observe on the host document started OUTSIDE those
   * iframes by construction — events raised inside an iframe never cross the boundary.
   */
  private installDragPassthrough(doc: Document): HostCleanup {
    const abort = new AbortController()
    const signal = abort.signal
    const setDragging = (active: boolean): void => {
      // Our own injected container: a classList toggle here is ours to make, unlike host nodes.
      doc.getElementById(this.containerId)?.classList.toggle(DRAGGING_CLASS, active)
    }

    doc.addEventListener(
      'pointerdown',
      () => {
        setDragging(true)
      },
      { signal, capture: true },
    )
    const end = (): void => {
      setDragging(false)
    }
    doc.addEventListener('pointerup', end, { signal, capture: true })
    doc.addEventListener('pointercancel', end, { signal, capture: true })

    return () => {
      setDragging(false)
      abort.abort()
    }
  }
}

// ---------------------------------------------------------------------- pure helpers

/** DOM id of a plugin's main-UI container in the host document. */
function mainUiId(pid: string): string {
  return `${pid}${MAIN_UI_SUFFIX}`
}

/**
 * Identity of one destructive action, kind included: layout ids and slot ids are drawn from different
 * alphabets today, but the arm state is a safety mechanism and must not depend on that staying true.
 */
function armKey(kind: 'layout' | 'slot', id: string): string {
  return `${kind}:${id}`
}

/**
 * Make a freshly built button arm-then-confirm, and give it the state it should be in right now.
 *
 * The label and title it reverts to are read off the button itself and stashed in `data-*`, so the
 * one place they are spelled stays the `miniButton` call — and so {@link applyArmState} can restore a
 * button it knows nothing else about.
 */
function markArmable(el: HTMLElement, key: string, armedKey: string | null): void {
  el.dataset.armKey = key
  el.dataset.armLabel = el.textContent ?? ''
  el.dataset.armTitle = el.title
  applyArmState(el, armedKey === key)
}

/** Flip one armable button between its normal face and {@link ARM_LABEL}. */
function applyArmState(el: HTMLElement, armed: boolean): void {
  const label = el.dataset.armLabel ?? ''
  const title = el.dataset.armTitle ?? ''
  el.textContent = armed ? ARM_LABEL : label
  el.title = armed ? `${title} — click again to confirm` : title
  el.classList.toggle('is-armed', armed)
}

/** Identity of a configured source, for the control panel's rebuild key. */
function sourceKey(source: SlotSource): string {
  switch (source.kind) {
    case 'plugin':
      return `plugin:${source.pid}`
    case 'macro':
      return `macro:${source.raw}`
    case 'none':
      return 'none'
  }
}

/**
 * Index the direct children matching `selector` by a key read off each one, dropping unkeyed and
 * duplicate nodes as it goes — a husk left by a crashed life of this plugin would otherwise be
 * reused as if it were the real thing, and two nodes with the same key cannot both be reconciled.
 *
 * `discard` is how those nodes go. It defaults to a plain removal, which is right for the callers
 * whose children hold nothing but their own markup (the tab strip); callers whose children may
 * contain another plugin's live DOM pass {@link Dock.discardSubtree} instead.
 */
function keyedChildren(
  parent: HTMLElement,
  selector: string,
  keyOf: (el: HTMLElement) => string,
  discard: (el: HTMLElement) => void = (el) => {
    el.remove()
  },
): Map<string, HTMLElement> {
  const found = new Map<string, HTMLElement>()
  for (const el of parent.querySelectorAll<HTMLElement>(`:scope > ${selector}`)) {
    const key = keyOf(el)
    if (key === '' || found.has(key)) {
      discard(el)
      continue
    }
    found.set(key, el)
  }
  return found
}

/**
 * Put `children` in this order under `parent`, moving ONLY the nodes that are out of place.
 *
 * Minimality is the whole point: `insertBefore` on an attached node detaches and re-inserts it, which
 * reboots every iframe inside it. Adding or removing a slot must therefore leave its siblings exactly
 * where they are — and it does, since the walk only ever inserts the node it is looking at.
 */
function orderChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
  let anchor: ChildNode | null = parent.firstChild
  for (const child of children) {
    if (child === anchor) {
      anchor = anchor.nextSibling
      continue
    }
    parent.insertBefore(child, anchor)
  }
}

/** Escape a value for interpolation into a double-quoted CSS attribute selector. */
function cssAttrValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

/**
 * Cross-realm-safe `closest`. Host DOM nodes come from another realm, so `instanceof Element` against
 * our own constructor is always false — duck-type the one method we need instead.
 */
function closestElement(target: EventTarget | null, selector: string): HTMLElement | null {
  if (target === null) return null
  const node = target as { closest?: (sel: string) => Element | null }
  if (typeof node.closest !== 'function') return null
  return node.closest(selector) as HTMLElement | null
}

/** The inline `--sdock-w-*` overrides a drag left on a layout root. */
function inlineWeightVars(root: HTMLElement): string[] {
  const names: string[] = []
  for (let i = 0; i < root.style.length; i += 1) {
    const name = root.style.item(i)
    if (name.startsWith(WEIGHT_VAR_PREFIX)) names.push(name)
  }
  return names
}

/**
 * Fire a protocol model. The RPC has no error channel — a missing model is a silent no-op on the
 * provider side — so a rejection here is exactly as uninformative as a resolution.
 */
function invokeEmbedModel(
  pid: string,
  model: 'embedMount' | 'embedUnmount',
  slotId: string,
  hostPid: string,
): void {
  const payload = buildEmbedPayload(hostPid, slotId)
  void logseq.App.invokeExternalPlugin(embedModelPath(pid, model), payload).catch(() => {
    // Nothing to do: the DOM is the only acknowledgment channel (host rule 7).
  })
}

/**
 * Take a macro wrapper down the way the host takes its own macro slots down: every injected-UI
 * descendant is handed to `_forceCleanInjectedUI` before the element goes. Detaching the node alone
 * would strand the libs-side teardown closure for the rest of the session.
 *
 * Takes a bare element rather than a mount record so it can also reap a wrapper left behind by a
 * previous instance of this plugin, which no record of ours describes — and, for the same reason, any
 * subtree that may CONTAIN such wrappers: {@link Dock.discardSubtree} hands it whole layout roots.
 */
function dropMacroWrapper(wrapper: Element): void {
  runQuietly(() => {
    for (const el of wrapper.querySelectorAll<HTMLElement>(INJECTED_UI_SELECTOR)) {
      forceCleanInjectedUi(el.dataset.injectedUi ?? '')
    }
    wrapper.remove()
  })
}

/**
 * Remove our own content from a slot, never anything a provider owns (host rule 6) — and never the
 * edit-mode panel, which is ours but is not content: rebuilding it on every mount would drop a
 * half-typed macro spec. `keep` spares one node we are in the middle of filling.
 *
 * Through {@link dropMacroWrapper} rather than a bare `remove()`, because one of the things that can be
 * standing in a slot is a macro wrapper this scope has no record of — a husk left by a crashed previous
 * life of this plugin, holding a responder's `[data-injected-ui]`. It is neither `[data-embed-owner]`
 * nor the controls panel, so it lands squarely on this path, and detaching it alone would strand the
 * responder's libs-side teardown closure for the rest of the session. Every other route out of a slot
 * ({@link Dock.discardSubtree}, {@link Dock.mountMacro}, {@link Dock.releaseMount}) already goes
 * through that helper; this was the one that did not.
 */
function clearHostChildren(slotEl: HTMLElement, keep: Element | null = null): void {
  for (const child of [...slotEl.children]) {
    if (child === keep) continue
    if (child.hasAttribute(EMBED_OWNER_ATTR)) continue
    if (child.classList.contains(CONTROLS_CLASS)) continue
    dropMacroWrapper(child)
  }
}

// ---------------------------------------------------------------------- host-realm builders

interface PlaceholderAction {
  label: string
  model: string
  /** The slot the button acts on — models get a dataset copy and no element reference. */
  slotId: SlotId
}

/** One Reclaim model for every slot; the slot travels in `data-slot-id`. */
function reclaimAction(slotId: SlotId): PlaceholderAction {
  return { label: 'Reclaim', model: MODELS.reclaim, slotId }
}

function renderPlaceholder(slotEl: HTMLElement, text: string, action?: PlaceholderAction): void {
  const key = `${text} ${action?.label ?? ''}`
  const existing = slotEl.querySelector<HTMLElement>('.sdock-placeholder')
  // Idempotent: pointless rewrites would only feed our own MutationObserver.
  if (existing !== null && existing.dataset.sdockKey === key) return

  clearHostChildren(slotEl)
  slotEl.appendChild(buildNotice(slotEl.ownerDocument, 'sdock-placeholder', key, text, action))
}

/**
 * Cover an adopted view with a diagnosis instead of undocking it (moving it would reload it again).
 * The adopted node stays where it is, underneath.
 */
function renderOverlay(slotEl: HTMLElement, text: string, error: string | null): void {
  const message = error === null ? text : `${text} (${error})`
  const existing = slotEl.querySelector<HTMLElement>('.sdock-overlay')
  if (existing !== null && existing.dataset.sdockKey === message) return
  existing?.remove()
  slotEl.appendChild(buildNotice(slotEl.ownerDocument, 'sdock-overlay', message, message))
}

function clearOverlay(slotEl: HTMLElement): void {
  slotEl.querySelector<HTMLElement>('.sdock-overlay')?.remove()
}

function buildNotice(
  doc: Document,
  className: string,
  key: string,
  text: string,
  action?: PlaceholderAction,
): HTMLElement {
  // Built in the HOST realm — these nodes live in the host document.
  const el = doc.createElement('div')
  el.className = className
  el.dataset.sdockKey = key

  const label = doc.createElement('div')
  label.className = 'sdock-notice-text'
  label.textContent = text
  el.appendChild(label)

  if (action !== undefined) {
    const button = doc.createElement('button')
    button.className = 'sdock-action'
    button.textContent = action.label
    // Delegated by the host on our injected container, exactly like every other control we build.
    button.setAttribute('data-on-click', action.model)
    button.dataset.slotId = action.slotId
    el.appendChild(button)
  }
  return el
}

function createDivider(doc: Document): HTMLElement {
  const el = doc.createElement('div')
  el.className = 'sdock-divider'
  el.title = 'Drag to resize'
  return el
}

/**
 * The gear and the add-layout button, matched on the model they invoke: they carry no `data-tab`, so
 * the sheet's active-chip rule can never light one up.
 */
function ensureTabButton(
  doc: Document,
  tabsEl: HTMLElement,
  model: string,
  className: string,
  label: string,
  title: string,
): HTMLElement {
  const existing = tabsEl.querySelector<HTMLElement>(`:scope > [data-on-click="${cssAttrValue(model)}"]`)
  if (existing !== null) return existing
  const el = doc.createElement('button')
  el.className = className
  el.textContent = label
  el.title = title
  el.setAttribute('data-on-click', model)
  return el
}

function miniButton(
  doc: Document,
  label: string,
  title: string,
  model: string,
  data: Partial<Record<DataKey, string>>,
  danger = false,
): HTMLElement {
  const el = doc.createElement('button')
  el.className = danger ? 'sdock-mini is-danger' : 'sdock-mini'
  el.textContent = label
  el.title = title
  el.setAttribute('data-on-click', model)
  for (const [key, value] of Object.entries(data)) el.dataset[key] = value
  return el
}

/**
 * The slot's source picker: nothing, every installed plugin, or a macro. A `<select>` is only possible
 * because these nodes never go through the host's DOMPurify pass (see the file header).
 */
function buildSourcePicker(
  doc: Document,
  slotId: SlotId,
  source: SlotSource,
  installed: readonly string[],
): HTMLElement {
  const select = doc.createElement('select')
  select.className = 'sdock-select'
  select.title = 'What this slot shows'
  select.dataset.slotId = slotId
  select.setAttribute('data-on-change', MODELS.pickSource)

  // A configured pid stays in the list even when its plugin is gone, so a disabled plugin's slot does
  // not silently read as "— none —" (and re-enabling the plugin does not need the pick again).
  const pids =
    source.kind === 'plugin' && !installed.includes(source.pid) ? [...installed, source.pid] : installed
  addOption(doc, select, PICK_NONE, '\u2014 none \u2014')
  for (const pid of pids) addOption(doc, select, pid, pid)
  addOption(doc, select, PICK_MACRO, 'macro\u2026')

  select.value = source.kind === 'plugin' ? source.pid : source.kind === 'macro' ? PICK_MACRO : PICK_NONE
  return select
}

function addOption(doc: Document, select: HTMLSelectElement, value: string, label: string): void {
  const option = doc.createElement('option')
  option.value = value
  option.textContent = label
  select.appendChild(option)
}

function buildMacroInput(doc: Document, slotId: SlotId, raw: string): HTMLElement {
  const input = doc.createElement('input')
  input.className = 'sdock-input'
  input.type = 'text'
  input.value = raw
  input.placeholder = '{{renderer :my-macro}}'
  input.title = 'Renderer macro to show in this slot'
  input.dataset.slotId = slotId
  // `change` (blur/Enter), never `input` — see `syncEditbar`.
  input.setAttribute('data-on-change', MODELS.setMacro)
  return input
}

function buildSlotButtons(doc: Document, lv: LayoutView, index: number, armedKey: string | null): HTMLElement {
  const row = doc.createElement('div')
  row.className = 'sdock-btn-row'
  const slotId = lv.slots[index].id
  const along = lv.axis === 'row' ? ['\u2190', '\u2192'] : ['\u2191', '\u2193']

  if (index > 0) row.appendChild(miniButton(doc, along[0], 'Move earlier', MODELS.moveSlot, { slotId, dir: 'up' }))
  if (index + 1 < lv.slots.length) {
    row.appendChild(miniButton(doc, along[1], 'Move later', MODELS.moveSlot, { slotId, dir: 'down' }))
  }
  if (lv.slots.length < MAX_SLOTS_PER_LAYOUT) {
    row.appendChild(miniButton(doc, '+', 'Add a slot', MODELS.addSlot, { layoutId: lv.id }))
  }
  const drop = miniButton(doc, '\u2715', 'Remove this slot', MODELS.removeSlot, { slotId }, true)
  // A panel rebuilt while this very slot is armed must come back armed, or the second click would
  // land on a button that has silently reverted to its innocent label.
  markArmable(drop, armKey('slot', slotId), armedKey)
  row.appendChild(drop)
  return row
}

function buildHint(doc: Document, text: string): HTMLElement {
  const el = doc.createElement('div')
  el.className = 'sdock-hint'
  el.dataset.sdockKey = text
  el.textContent = text
  return el
}

interface BodyProbe {
  body: BodyLike | null
  error: string | null
}

/** Read an adopted plugin iframe's body into the pure {@link BodyLike} shape (same-origin). */
function readIframeBody(node: HTMLElement): BodyProbe {
  try {
    const iframe = node.querySelector<HTMLIFrameElement>('iframe')
    if (iframe === null) return { body: null, error: 'no iframe in the plugin container' }
    const body = iframe.contentDocument?.body ?? null
    if (body === null) return { body: null, error: null }
    return {
      body: {
        children: [...body.children].map((child) => ({
          tagName: child.tagName,
          childElementCount: child.childElementCount,
          textContent: child.textContent,
        })),
      },
      error: null,
    }
  } catch (err: unknown) {
    return { body: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Run host-realm DOM work that may throw if the markup or the owning realm shifted underneath us. */
function runQuietly(fn: () => void): void {
  try {
    fn()
  } catch (err: unknown) {
    console.warn('[sidebar-dock] host operation failed', err)
  }
}
