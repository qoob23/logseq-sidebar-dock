/**
 * Host-side machinery: injects the dock pane into the left sidebar (and the segmented control into
 * the app header's left cell), keeps both alive, and fills the dock's two slots — through the Embed
 * Protocol v1 where the plugin supports it (`docs/embed-protocol.md`), and by adopting the plugin's
 * main-UI container where it does not.
 *
 * Runs inside our own (un-sandboxed, same-origin) plugin iframe and reaches into the host document
 * through `window.top`. The host has NO lifecycle management for `path`-injected UI, so re-assertion
 * is entirely ours: a debounced MutationObserver, an `App.onRouteChanged` re-check, and the
 * `LSPluginCore` plugin-registry events.
 */

import '@logseq/libs'

import { computeSidebarWidth, computeSplitPct } from './divider'
import {
  type BodyLike,
  EMBED_HOST_ATTR,
  EMBED_OWNER_ATTR,
  type EmbedStrategy,
  PROBE_REPROBE_BUDGET_MS,
  type SlotName,
  StrategyCache,
  buildEmbedPayload,
  classifySlot,
  droppedByLifecycle,
  embedModelPath,
  embedOwnerSelector,
  escapeAttribute,
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
  setHostCleanup,
  subscribeHostPluginLifecycle,
  takeHostCleanup,
} from './logseq-types'
import { MACRO_HOOK_TYPE, buildMacroHookPayload, macroSlotDomId } from './macro'
import {
  type SettingsStore,
  type SlotSpecs,
  type ViewSpec,
  WIDTH_FOLLOW_HOST,
  configSignature,
  parseAdoptPokes,
  resolveSlotSpecs,
} from './settings'
import { buildDockCss, splitVarFallback, widthVarFallback } from './styles'

/** `provideUI` key — becomes the container id `#<pid>--dock`, so it must be a bare CSS ident. */
const DOCK_KEY = 'dock'
/** `provideUI` key of the segmented control — a second, independent injection (`#<pid>--tabs`). */
const TABS_KEY = 'tabs'
/** `provideStyle` key — the host looks it up with an UNQUOTED attribute selector: bare ident only. */
const STYLE_KEY = 'sdock-layout'
/** Append point: last child of the sidebar's flex column, after `footer.create`. */
const DOCK_PATH = '#left-sidebar .left-sidebar-inner > .wrap'
/**
 * Preferred append point for the segmented control: the header's left cell, the row that already
 * carries the sidebar toggle and the search button. It belongs to a different host component than
 * the dock, hence a separate injection with its own health check — see {@link Dock.assertTabs}.
 */
const TABS_PATH = '.cp__header > .l'
/** Toggled on our own container while a drag is in flight (see {@link Dock.installDragPassthrough}). */
const DRAGGING_CLASS = 'sdock-dragging'
/** The host's own sidebar resizer handle, which we hijack outright (see {@link Dock.assertWidthResizer}). */
const WIDTH_RESIZER_SELECTOR = '#left-sidebar .left-sidebar-resizer'
/** The sidebar element the host resizes — and the parent of the handle above. */
const SIDEBAR_ID = 'left-sidebar'
/** Transient inline override of the sidebar width, read by the sheet's `widthVarFallback`. */
const WIDTH_VAR = '--sdock-width'
/**
 * The host's OWN transient drag classes (`container.cljs`, `sidebar-resizer`): they suppress the
 * sidebar's width transition, without which every drag frame trails the pointer.
 */
const RESIZING_CLASS = 'is-resizing'
const RESIZING_BUF_CLASS = 'is-resizing-buf'

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

const NO_SELECTION_TEXT = 'No view selected — pick one in the Sidebar Dock plugin settings.'
const EVICTED_TEXT = 'View is open in another surface (sidebar/popout).'
const INVALID_MACRO_TEXT = 'Invalid macro spec — expected something like {{renderer :my-macro, arg}}.'
const MACRO_UNANSWERED_TEXT = 'No plugin responded to this macro. Is its provider installed and enabled?'
/** Any element the host's `setupInjectedUI` created — the only acknowledgment a macro hook gets. */
const INJECTED_UI_SELECTOR = '[data-injected-ui]'

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
  /** The user picked a different view (or none): protocol host rule 5 says unmount. */
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

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

/** Our container counts as healthy only when it is attached AND still holds our whole markup. */
function isHealthy(el: HTMLElement | null): el is HTMLElement {
  if (el === null || !el.isConnected) return false
  return el.querySelector('.sdock-root') !== null
}

/**
 * Where the segmented control goes. The header row is the home; our own column is the fallback for
 * when the header markup shifts under us, so a renamed cell degrades the placement instead of
 * losing the control altogether (the face is then only switchable from the settings).
 */
function tabsPath(doc: Document): string {
  return doc.querySelector(TABS_PATH) === null ? DOCK_PATH : TABS_PATH
}

/** Intact AND standing in the row we want it in right now — the header cell may have arrived late. */
function isTabsHealthy(doc: Document, tabsId: string): boolean {
  const el = doc.getElementById(tabsId)
  if (el === null || el.querySelector('.sdock-tabs') === null) return false
  return el.parentElement === doc.querySelector(tabsPath(doc))
}

/**
 * `data-on-<event>` is `setupInjectedUI`'s own delegation: the host binds one listener on the container
 * and routes clicks to the model registered with `logseq.provideModel`. It is re-bound whenever the
 * container is re-created and covers nodes we add later, so we never bind clicks ourselves.
 *
 * The slots carry a stable id and `data-embed-host` — protocol host rule 1.
 */
function buildTemplate(pluginId: string): string {
  const host = escapeAttribute(pluginId)
  const slot = (name: SlotName): string =>
    `<div class="sdock-slot" data-slot="${name}" id="${escapeAttribute(slotElementId(pluginId, name))}" ${EMBED_HOST_ATTR}="${host}"></div>`

  return [
    '<div class="sdock-root">',
    slot('top'),
    '<div class="sdock-divider" title="Drag to resize"></div>',
    slot('bottom'),
    '</div>',
  ].join('')
}

/**
 * The segmented control, injected on its own so it can live in the header row (see {@link TABS_PATH}).
 * The host binds its `data-on-click` delegation per injected container, so these buttons reach the
 * same models from either placement.
 */
const TABS_TEMPLATE = [
  '<div class="sdock-tabs">',
  '<button class="sdock-tab" data-tab="nav" data-on-click="sdockShowNav">Navigation</button>',
  '<button class="sdock-tab" data-tab="views" data-on-click="sdockShowViews">Plugins</button>',
  '</div>',
].join('')

export class Dock {
  private readonly pluginId: string
  private readonly store: SettingsStore
  private readonly onPluginsChanged: (() => void) | null
  private readonly containerId: string
  private readonly tabsId: string
  private readonly template: string
  private readonly mounts = new Map<SlotName, SlotMount>()
  private readonly strategies = new StrategyCache()

  /** Aborts the listeners bound to the current `.sdock-root`. */
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
    this.containerId = `${pluginId}--${DOCK_KEY}`
    this.tabsId = `${pluginId}--${TABS_KEY}`
    this.template = buildTemplate(pluginId)
  }

  /** Install the re-assertion hooks and build the dock for the first time. */
  async start(): Promise<void> {
    this.installHostHooks()
    await this.assert()
  }

  /**
   * Make the live DOM match the current settings: stylesheet, injected container, divider, both views.
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

  /**
   * Explicit user intent to take an evicted view back (the Reclaim button). Re-invoking `embedMount`
   * here is the legitimate last-mount-wins steal the protocol allows; nothing else may auto-remount.
   */
  reclaim(slot: SlotName): void {
    void this.runReclaim(slot)
  }

  /**
   * Re-publish the stylesheet — the whole nav/views switch is a stylesheet swap, so this is all a mode
   * flip needs. Public so the segmented control can repaint instantly, ahead of the settings echo.
   */
  refreshStyle(): void {
    this.provideStyle()
  }

  /** Empty both slots. `wipe` means our container is being re-created, so providers keep their mount. */
  undockAll(reason: Extract<ClearReason, 'wipe' | 'dispose'> = 'wipe'): void {
    const doc = getHostDocument()
    if (doc === null) {
      this.mounts.clear()
      return
    }
    for (const slot of [...this.mounts.keys()]) this.clearSlot(doc, slot, reason)
  }

  /** Tear everything down — other plugins' live nodes go back to the host body untouched. */
  dispose(): void {
    this.disposed = true
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
    doc.getElementById(this.tabsId)?.remove()
  }

  private async runAssert(): Promise<void> {
    const doc = getHostDocument()
    if (doc === null) return

    // Any assert supersedes a pending missing-view watch and the split it was built for.
    const generation = ++this.watchGeneration
    this.provideStyle()
    this.assertTabs(doc)
    this.assertWidthResizer(doc)

    // Missing, detached, or emptied by a third party — all heal the same way. Re-calling `provideUI`
    // with the same key rewrites the container's innerHTML, so rescue adopted nodes first.
    if (!isHealthy(doc.getElementById(this.containerId))) {
      this.undockAll('wipe')
      this.inject()
    }

    const container = await this.waitForContainer(doc)
    if (container === null || this.disposed) return

    const root = container.querySelector<HTMLElement>('.sdock-root')
    if (root === null) return

    this.attachDivider(doc, container, root)

    this.missingPids.clear()
    const specs = this.specs()
    this.forgetStaleEpisodes(specs)
    await Promise.all([
      this.dockView(doc, root, 'top', specs.top),
      this.dockView(doc, root, 'bottom', specs.bottom),
    ])
    if (this.disposed || generation !== this.watchGeneration) return
    this.watchMissingViews(generation)

    // The stylesheet is what carries the split and the sidebar width from here on — but
    // `provideStyle` is fire-and-forget, so only drop the drag-time inline overrides once the new
    // sheet is provably in the host document. Clearing one earlier flashes the previous value for a
    // few frames. Either may be standing on its own, so neither can early-return over the other.
    const clearSplit = !this.dragging && root.style.getPropertyValue('--sdock-split') !== ''
    const clearWidth =
      !this.widthDragging && doc.documentElement.style.getPropertyValue(WIDTH_VAR) !== ''
    if (!clearSplit && !clearWidth) return
    if (!(await this.waitForSheet(doc, generation))) return
    if (generation !== this.watchGeneration) return
    if (clearSplit && !this.dragging) root.style.removeProperty('--sdock-split')
    if (clearWidth && !this.widthDragging) doc.documentElement.style.removeProperty(WIDTH_VAR)
  }

  /** True once the sheet standing in the host document carries the values we last provided. */
  private isSheetCurrent(doc: Document): boolean {
    const el = doc.querySelector(`[data-injected-style="${STYLE_KEY}-${this.pluginId}"]`)
    if (el === null) return false
    const css = el.textContent ?? ''
    const { splitPct, sidebarWidthPx } = this.store.current()
    // The width rule only exists while an override is actually in force — with none the sheet
    // legitimately carries no width rule at all, and demanding one anyway would strand the transient
    // var (and the width it carries) forever.
    if (sidebarWidthPx > 0 && !css.includes(widthVarFallback(sidebarWidthPx))) return false
    return css.includes(splitVarFallback(splitPct))
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
        if (pids.some((pid) => doc.getElementById(`${pid}_lsp_main`) !== null)) {
          void this.assert()
          return
        }
      }
    })()
  }

  /** What each slot is asked to show right now — the stylesheet and the mounting code share this. */
  private specs(): SlotSpecs {
    return resolveSlotSpecs(this.store.current())
  }

  /**
   * Retire the "we already tried that" memories when the configuration they were formed under is no
   * longer the one in force. Both are deliberately sticky — that is what stops a poke or a macro
   * hook from firing on every assert — so a user who edits the settings to fix exactly that problem
   * has to be able to clear them.
   */
  private forgetStaleEpisodes(specs: SlotSpecs): void {
    const signature = configSignature(this.store.current().adoptPoke, specs)
    if (signature === this.configSig) return
    this.configSig = signature
    this.pokedWhileMissing.clear()
    this.unansweredMacros.clear()
  }

  private provideStyle(): void {
    const { mode, splitPct, sidebarWidthPx } = this.store.current()
    const specs = this.specs()
    logseq.provideStyle({
      key: STYLE_KEY,
      style: buildDockCss({
        pluginId: this.pluginId,
        mode,
        splitPct,
        sidebarWidthPx,
        viewTop: specs.top,
        viewBottom: specs.bottom,
      }),
    })
  }

  private inject(): void {
    logseq.provideUI({ key: DOCK_KEY, path: DOCK_PATH, template: this.template })
  }

  /**
   * Keep the segmented control injected, in the row we currently want it in.
   *
   * Nothing waits on it — no view mounts here — so this stays synchronous; a header that has not
   * rendered yet is picked up by the container observer, which watches this too.
   *
   * `setupInjectedUI` only rewrites an EXISTING container's innerHTML and never moves it, so a
   * container left in the fallback row has to be torn down before the re-injection can place it in
   * the header cell. That is what makes the placement heal when the header turns up after our first
   * assert. The host's own teardown goes first (it also retires the libs-side effect), but its
   * verdict is about the CALL, not the node — and it removes the node from the parent it was created
   * under, which is exactly the parent that is wrong here — so the node itself is the only thing
   * worth believing: still standing means removing it by hand, or we would re-inject into a
   * container the host can neither move nor replace and never converge.
   */
  private assertTabs(doc: Document): void {
    if (isTabsHealthy(doc, this.tabsId)) return
    const path = tabsPath(doc)
    const target = doc.querySelector(path)
    if (target === null) return

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
  }

  /** `provideUI` is fire-and-forget over postMessage — poll for the node with a backoff. */
  private async waitForContainer(doc: Document): Promise<HTMLElement | null> {
    const deadline = Date.now() + POLL_BUDGET_MS
    let delay = POLL_START_MS
    for (;;) {
      if (this.disposed) return null
      const el = doc.getElementById(this.containerId)
      if (isHealthy(el)) return el
      if (Date.now() >= deadline) return null
      await sleep(delay)
      delay = Math.min(delay * 2, POLL_MAX_MS)
    }
  }

  // ------------------------------------------------------------------ slot filling

  /**
   * The slot element, with host rule 1 (stable id + `data-embed-host`) enforced rather than assumed —
   * the template goes through the host's DOMPurify pass before it ever reaches the DOM. These are our
   * own nodes, so writing the attributes back is ours to do.
   */
  private slotElement(root: HTMLElement, slot: SlotName): HTMLElement | null {
    const el = root.querySelector<HTMLElement>(`.sdock-slot[data-slot="${slot}"]`)
    if (el === null) return null
    const id = slotElementId(this.pluginId, slot)
    if (el.id !== id) el.id = id
    if (el.getAttribute(EMBED_HOST_ATTR) !== this.pluginId) el.setAttribute(EMBED_HOST_ATTR, this.pluginId)
    return el
  }

  /** Bring one slot in line with the selection: keep, re-mount, evict-notice, or mount fresh. */
  private async dockView(doc: Document, root: HTMLElement, slot: SlotName, spec: ViewSpec): Promise<void> {
    const slotEl = this.slotElement(root, slot)
    if (slotEl === null) return

    if (spec.kind === 'none' || spec.kind === 'invalid-macro') {
      this.clearSlot(doc, slot, 'deselect')
      renderPlaceholder(slotEl, spec.kind === 'none' ? NO_SELECTION_TEXT : INVALID_MACRO_TEXT)
      return
    }

    if (spec.kind === 'macro') {
      // Anything short of a live, same-spec wrapper with a responder in it re-mounts: that is what
      // heals a provider plugin reload, which drops its injected UI without telling us.
      if (this.isMacroHealthy(this.mounts.get(slot), slotEl, spec.raw)) return
      await this.mountMacro(doc, slotEl, slot, spec.raw, spec.args)
      return
    }

    const pid = spec.pid
    const current = this.mounts.get(slot)
    if (current !== undefined && current.strategy !== 'macro' && current.pid === pid) {
      if (current.strategy === 'embed') {
        const health = classifySlot({
          sameSlotElement: current.slotEl === slotEl,
          hasEmbedSubtree: this.hasEmbedSubtree(slotEl, pid),
        })
        if (health === 'healthy') return
        if (health === 'evicted') {
          // Host rule 4: the provider moved the view elsewhere. Only the user may take it back.
          this.takeMount(slot)
          renderPlaceholder(slotEl, EVICTED_TEXT, { label: 'Reclaim', model: reclaimModel(slot) })
          // Keep the record so repeated asserts stay on this branch instead of re-mounting.
          this.mounts.set(slot, { ...current, slotEl, watcher: null, watchTimer: null })
          return
        }
        // 'remount': our slot element was re-created, which is the provider's only recovery signal.
        // The old record points at a dead node, and rule 3 says re-mount rather than unmount.
        this.takeMount(slot)
      } else {
        // Adoption stays valid only while we hold the plugin's CURRENT main-UI node.
        const canonical = doc.getElementById(`${pid}_lsp_main`)
        if (current.node !== null && current.node === canonical && canonical.parentElement === slotEl) return
      }
    }

    await this.mountView(doc, slotEl, slot, pid)
  }

  /**
   * The adapter chain: protocol first, main-UI adoption second, placeholder last.
   *
   * The slot keeps showing whatever it showed until one of them actually succeeds — a dead probe
   * against a non-provider would otherwise blank the slot for its whole budget. Probing a populated
   * slot is safe: verification looks for `[data-embed-owner]`, which our own content never carries.
   */
  private async mountView(doc: Document, slotEl: HTMLElement, slot: SlotName, pid: string): Promise<void> {
    const previous = this.takeMount(slot)
    const action = this.strategies.action(pid)

    if (action !== 'use-adopt') {
      const mounted = await this.probeEmbed(slotEl, pid, this.strategies.budgetMs(pid))
      if (action === 'probe') this.strategies.set(pid, strategyFromProbe(mounted))
      if (mounted) {
        this.releaseMount(doc, previous, 'deselect')
        this.commitEmbed(doc, slotEl, slot, pid)
        return
      }
      // Cached as a provider but it did not come back — re-probe from scratch next time.
      if (action === 'use-embed') this.strategies.invalidate(pid)
    }

    this.releaseMount(doc, previous, 'deselect')
    this.adoptMainUi(doc, slotEl, slot, pid)
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
  private commitEmbed(doc: Document, slotEl: HTMLElement, slot: SlotName, pid: string): void {
    this.releaseMount(doc, this.takeMount(slot), 'deselect')
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
    this.mounts.set(slot, mount)
    this.watchEmbedSubtree(slot, mount)
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
    slot: SlotName,
    raw: string,
    args: readonly string[],
  ): Promise<void> {
    this.releaseMount(doc, this.takeMount(slot), 'deselect')

    // Our module scope resets on reload, the host document does not: an instance killed without
    // `beforeunload` leaves a wrapper carrying this very id behind. The host resolves the hook's
    // slot by `getElementById`, so a duplicate would hand our macro to the corpse — and we would
    // report "nobody answered" over a macro that answered perfectly well.
    const stale = doc.getElementById(macroSlotDomId(this.pluginId, slot))
    if (stale !== null) dropMacroWrapper(stale)

    // Built in the HOST realm — this node lives in the host document.
    const wrapper = doc.createElement('div')
    wrapper.className = 'sdock-macro'
    wrapper.id = macroSlotDomId(this.pluginId, slot)
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
    this.mounts.set(slot, mount)

    const payload = buildMacroHookPayload(wrapper.id, args)
    const budget = this.unansweredMacros.has(raw) ? MACRO_REPROBE_BUDGET_MS : MACRO_HOOK_BUDGET_MS
    for (const delay of probeDelays(budget)) {
      // A newer mount for this slot has taken over (and released this wrapper) — leave it to it.
      if (this.disposed || this.mounts.get(slot) !== mount) return
      // Unreachable bridge: nothing will ever answer, so stop burning the budget on it.
      if (!emitHostAppHook(MACRO_HOOK_TYPE, payload)) break
      await sleep(delay)
      if (this.disposed || this.mounts.get(slot) !== mount) return
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
    this.releaseMount(doc, this.takeMount(slot), 'deselect')
    renderPlaceholder(slotEl, MACRO_UNANSWERED_TEXT)
  }

  // ------------------------------------------------------------------ adoption

  /** Legacy strategy: re-parent the plugin's own main-UI container into the slot. */
  private adoptMainUi(doc: Document, slotEl: HTMLElement, slot: SlotName, pid: string): void {
    const canonical = doc.getElementById(`${pid}_lsp_main`)
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
    this.mounts.set(slot, mount)
    this.watchAdoptedContent(slot, mount)
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
  private watchEmbedSubtree(slot: SlotName, mount: SlotMount): void {
    const observer = new MutationObserver(() => {
      if (this.disposed || this.mounts.get(slot) !== mount || mount.watchTimer !== null) return
      mount.watchTimer = setTimeout(() => {
        mount.watchTimer = null
        if (this.disposed || this.mounts.get(slot) !== mount) return
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
  private watchAdoptedContent(slot: SlotName, mount: SlotMount): void {
    void (async (): Promise<void> => {
      const deadline = Date.now() + ADOPT_CONTENT_GRACE_MS
      let graced = false

      for (;;) {
        await sleep(ADOPT_RECHECK_MS)
        if (this.disposed || this.mounts.get(slot) !== mount) return
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

  private async runReclaim(slot: SlotName): Promise<void> {
    const doc = getHostDocument()
    if (doc === null || this.disposed) return
    const root = doc.getElementById(this.containerId)?.querySelector<HTMLElement>('.sdock-root') ?? null
    if (root === null) return
    const slotEl = this.slotElement(root, slot)
    if (slotEl === null) return

    // Reclaim only exists for evicted embed mounts, so anything but a plugin selection is a no-op.
    const spec = this.specs()[slot]
    if (spec.kind !== 'plugin') return
    const pid = spec.pid

    const previous = this.takeMount(slot)
    if (await this.probeEmbed(slotEl, pid, this.strategies.budgetMs(pid))) {
      this.commitEmbed(doc, slotEl, slot, pid)
      return
    }
    // Still gone: put the notice back rather than leaving an empty slot behind.
    if (previous !== undefined) this.mounts.set(slot, { ...previous, slotEl, watcher: null, watchTimer: null })
    renderPlaceholder(slotEl, EVICTED_TEXT, { label: 'Reclaim', model: reclaimModel(slot) })
  }

  /**
   * Detach a slot's mount record and silence its watchers, without touching the DOM yet. Dropping the
   * record first is what makes the watchers inert during our own teardown: they all bail as soon as
   * the record they were bound to is no longer the slot's.
   */
  private takeMount(slot: SlotName): SlotMount | undefined {
    const mount = this.mounts.get(slot)
    if (mount === undefined) return undefined
    this.mounts.delete(slot)
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
  private clearSlot(doc: Document, slot: SlotName, reason: ClearReason): void {
    this.releaseMount(doc, this.takeMount(slot), reason)
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
    for (const [slot, mount] of [...this.mounts]) {
      // Macro mounts belong to no plugin, so the protocol-pure rule below has nothing to say about
      // them; they heal through their own health check on the assert this event triggers anyway.
      const strategy = mount.strategy
      if (strategy === 'macro') continue
      if (!droppedByLifecycle({ pid: mount.pid, strategy }, changedPid)) continue
      // Record first: takeMount silences the slot watcher, so the purge below can never read as an
      // eviction. The purge only touches the dropped mount's own pid, keeping the scoping honest.
      this.takeMount(slot)
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
      const canonical = doc.getElementById(`${pid}_lsp_main`)
      const rescue = canonical === node || (canonical === null && mode === 'wipe' && !node.isConnected)
      if (rescue) {
        doc.body.appendChild(node)
      } else {
        node.remove()
      }
    })
  }

  // ------------------------------------------------------------------ divider

  private attachDivider(doc: Document, container: HTMLElement, root: HTMLElement): void {
    if (root.dataset.sdockDivider === '1') return
    const divider = root.querySelector<HTMLElement>('.sdock-divider')
    if (divider === null) return

    // A fresh root means the old listeners (and any drag they had in flight) belong to a dead node.
    this.endDrag()
    this.dividerAbort?.abort()
    const abort = new AbortController()
    this.dividerAbort = abort
    const signal = abort.signal

    divider.addEventListener(
      'pointerdown',
      (ev) => {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return
        ev.preventDefault()
        this.startDrag(doc, container, root, divider, ev)
      },
      { signal },
    )

    // The host's mobile drawer swipe handlers sit on #left-sidebar — keep our drag away from them.
    divider.addEventListener(
      'touchstart',
      (ev) => {
        ev.stopPropagation()
      },
      { signal, passive: true },
    )
    divider.addEventListener(
      'touchmove',
      (ev) => {
        ev.stopPropagation()
        ev.preventDefault()
      },
      { signal, passive: false },
    )

    root.dataset.sdockDivider = '1'
  }

  private startDrag(
    doc: Document,
    container: HTMLElement,
    root: HTMLElement,
    divider: HTMLElement,
    down: PointerEvent,
  ): void {
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

    let latest = this.store.current().splitPct

    doc.addEventListener(
      'pointermove',
      (ev) => {
        // A second finger must not yank the divider.
        if (ev.pointerId !== down.pointerId) return
        const rect = container.getBoundingClientRect()
        latest = computeSplitPct(ev.clientY, rect.top, rect.height)
        // The single allowed inline style: a transient CSS var on OUR OWN node.
        root.style.setProperty('--sdock-split', String(latest))
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
      this.store.override({ splitPct: latest })
      // Bake the ratio into the persistent sheet. The inline var stays until the next assert clears
      // it: `provideStyle` is fire-and-forget, so dropping it here snaps back for a few frames.
      this.provideStyle()
      logseq.updateSettings({ splitPct: this.store.current().splitPct })
      this.endDrag()
    }
    doc.addEventListener('pointerup', finish, { signal, capture: true })
    doc.addEventListener('pointercancel', finish, { signal, capture: true })
  }

  private endDrag(): void {
    this.dragging = false
    this.dragAbort?.abort()
    this.dragAbort = null
  }

  // ------------------------------------------------------------------ sidebar width

  /**
   * Hijack the host's own sidebar resizer — on both faces, whatever the mode.
   *
   * The host clamps its own drag to 240–460px — far too narrow for two docked plugin views — so the
   * handle drives OUR width instead. Unconditional, because the dock width IS the sidebar width: our
   * `!important` rule masks whatever the host's clamped drag would write anyway, so leaving that drag
   * live on the Navigation face would only make the handle feel broken there. Its handler is an
   * interact.js draggable bound on the DOCUMENT in the bubble phase, so a capture-phase listener on
   * the handle itself runs long before it and can stop the event from ever reaching it.
   *
   * Failure mode, should that stop holding (interact.js binding in capture, or directly on the
   * handle): both drags run, the host writes its clamped value into the inline
   * `--ls-left-sidebar-width` — and our `!important` rule simply masks it. Degraded to the host's
   * clamp, never broken.
   *
   * Bound by element IDENTITY rather than by marking the node: the handle is host-rendered markup,
   * so any attribute of ours would be wiped by the next re-render and we would re-bind on a node
   * that already carries our listeners.
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

    // interact.js may bind mouse events rather than pointer events, and swallowing `pointerdown`
    // does not suppress the compatibility `mousedown` that follows it.
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
   * Our replacement for the host's clamped drag: the same handle and the same transient feedback,
   * our own bounds.
   *
   * Writing `--sdock-width` inline on `documentElement` is not what the "never write inline styles
   * onto host nodes" rule is about: `<html>` is not host-RENDERED markup (no re-render wipes it) and
   * this is the host's own channel for exactly this value — `container.cljs` sets
   * `--ls-left-sidebar-width` there itself. The persistent value still goes through the sheet.
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
    // the transient var and the first drag frames would do nothing. Seed it with the width the
    // sidebar already has — the same value, so visually a no-op — to bring that rule into existence.
    // The seed is NOT a chosen width, so `widthDragRevert` stands ready to take it back until a real
    // move persists it (see the field's doc for the phantom-override failure it prevents).
    let latest = this.store.current().sidebarWidthPx
    let moved = false
    if (latest <= 0) {
      const seedRect = sidebar.getBoundingClientRect()
      latest = computeSidebarWidth(seedRect.right, seedRect.left, doc.documentElement.clientWidth)
      this.store.override({ sidebarWidthPx: latest })
      this.provideStyle()
      this.widthDragRevert = (): void => {
        if (this.disposed) return
        this.store.override({ sidebarWidthPx: WIDTH_FOLLOW_HOST })
        this.provideStyle()
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
        doc.documentElement.style.setProperty(WIDTH_VAR, `${latest}px`)
      },
      { signal, capture: true },
    )

    const finish = (ev: PointerEvent): void => {
      if (ev.pointerId !== down.pointerId) return
      if (!this.widthDragging) return
      // A click, not a drag: the user chose nothing, so nothing may persist — least of all the
      // seed, which would freeze "follow the host" into a fixed width. endWidthDrag reverts it.
      if (!moved) {
        this.endWidthDrag(doc)
        return
      }
      this.widthDragRevert = null
      this.store.override({ sidebarWidthPx: latest })
      // Bake the width into the persistent sheet. The inline var stays until the next assert clears
      // it: `provideStyle` is fire-and-forget, so dropping it here snaps back for a few frames.
      this.provideStyle()
      logseq.updateSettings({ sidebarWidthPx: this.store.current().sidebarWidthPx })
      this.endWidthDrag(doc)
    }
    doc.addEventListener('pointerup', finish, { signal, capture: true })
    doc.addEventListener('pointercancel', finish, { signal, capture: true })
  }

  private endWidthDrag(doc: Document): void {
    this.widthDragging = false
    this.widthDragAbort?.abort()
    this.widthDragAbort = null
    // An unfinished (aborted or never-moved) drag takes its seeded override back; a drag that
    // persisted cleared this first, so the persisted value stands.
    const revert = this.widthDragRevert
    this.widthDragRevert = null
    revert?.()
    // Idempotent, and safe when no drag ever ran: these are the host's classes and it removes them
    // on its own dragend the same way.
    doc.getElementById(SIDEBAR_ID)?.classList.remove(RESIZING_CLASS)
    doc.documentElement.classList.remove(RESIZING_BUF_CLASS)
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
        // Two independent injections in two different host subtrees: either one going down (or the
        // header cell finally showing up) is a reason to re-assert. So is the host re-rendering its
        // resizer handle, which would otherwise leave our hijack bound to a dead node until some
        // unrelated event came along.
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
    // settings dropdowns.
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
      // Usually run by a SUCCESSOR instance over a corpse of ours (kill without `beforeunload`), so
      // silence the pending async loops too; on the normal dispose path this is already true.
      this.disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      observer.disconnect()
      offRoute()
      offLifecycle?.()
      offPassthrough()
      // The width hijack binds capture listeners (with stopImmediatePropagation) to a HOST node that
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

/** Model name of the Reclaim button for a slot (registered in `main.ts`). */
export function reclaimModel(slot: SlotName): string {
  return slot === 'top' ? 'sdockReclaimTop' : 'sdockReclaimBottom'
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
 * previous instance of this plugin, which no record of ours describes.
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
 * Remove our own children from a slot, never anything a provider owns (host rule 6). `keep` spares
 * one node we are in the middle of filling — see {@link Dock.mountMacro}.
 */
function clearHostChildren(slotEl: HTMLElement, keep: Element | null = null): void {
  for (const child of [...slotEl.children]) {
    if (child === keep) continue
    if (child.hasAttribute(EMBED_OWNER_ATTR)) continue
    child.remove()
  }
}

interface PlaceholderAction {
  label: string
  model: string
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
    // Delegated by the host on our injected container, exactly like the template's own buttons.
    button.setAttribute('data-on-click', action.model)
    el.appendChild(button)
  }
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
