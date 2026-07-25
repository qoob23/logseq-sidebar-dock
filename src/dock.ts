/**
 * Host-side machinery: injects the dock pane into the left sidebar, keeps it alive, and fills its two
 * slots — through the Embed Protocol v1 where the plugin supports it (`docs/embed-protocol.md`), and
 * by adopting the plugin's main-UI container where it does not.
 *
 * Runs inside our own (un-sandboxed, same-origin) plugin iframe and reaches into the host document
 * through `window.top`. The host has NO lifecycle management for `path`-injected UI, so re-assertion
 * is entirely ours: a debounced MutationObserver, an `App.onRouteChanged` re-check, and the
 * `LSPluginCore` plugin-registry events.
 */

import '@logseq/libs'

import { computeSplitPct } from './divider'
import {
  type BodyLike,
  EMBED_HOST_ATTR,
  EMBED_OWNER_ATTR,
  type EmbedStrategy,
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
  getHostDocument,
  setHostCleanup,
  subscribeHostPluginLifecycle,
  takeHostCleanup,
} from './logseq-types'
import { NO_VIEW, type SettingsStore } from './settings'
import { buildDockCss, splitVarFallback } from './styles'

/** `provideUI` key — becomes the container id `#<pid>--dock`, so it must be a bare CSS ident. */
const DOCK_KEY = 'dock'
/** `provideStyle` key — the host looks it up with an UNQUOTED attribute selector: bare ident only. */
const STYLE_KEY = 'sdock-layout'
/** Append point: last child of the sidebar's flex column, after `footer.create`. */
const DOCK_PATH = '#left-sidebar .left-sidebar-inner > .wrap'
/** Toggled on our own container while a drag is in flight (see {@link Dock.installDragPassthrough}). */
const DRAGGING_CLASS = 'sdock-dragging'

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

const NO_SELECTION_TEXT = 'No view selected — pick one in the Sidebar Dock plugin settings.'
const EVICTED_TEXT = 'View is open in another surface (sidebar/popout).'

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

interface SlotMount {
  pid: string
  strategy: EmbedStrategy
  /** Identity of the slot element at mount time — the wipe-vs-eviction discriminator (host rule 4). */
  slotEl: HTMLElement
  /** `adopt` only: the foreign node we re-parented. */
  node: HTMLElement | null
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
  return el.querySelector('.sdock-tabs') !== null && el.querySelector('.sdock-root') !== null
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
    '<div class="sdock-tabs">',
    '<button class="sdock-tab" data-tab="nav" data-on-click="sdockShowNav">Nav</button>',
    '<button class="sdock-tab" data-tab="views" data-on-click="sdockShowViews">Views</button>',
    '</div>',
    '<div class="sdock-root">',
    slot('top'),
    '<div class="sdock-divider" title="Drag to resize"></div>',
    slot('bottom'),
    '</div>',
  ].join('')
}

export class Dock {
  private readonly pluginId: string
  private readonly store: SettingsStore
  private readonly onPluginsChanged: (() => void) | null
  private readonly containerId: string
  private readonly template: string
  private readonly mounts = new Map<SlotName, SlotMount>()
  private readonly strategies = new StrategyCache()

  /** Aborts the listeners bound to the current `.sdock-root`. */
  private dividerAbort: AbortController | null = null
  /** Aborts the host-document listeners bound for the duration of one divider drag. */
  private dragAbort: AbortController | null = null
  private dragging = false
  private running = false
  private queued = false
  private disposed = false
  /** Bumped by every assert; a running missing-view watch whose generation is stale gives up. */
  private watchGeneration = 0
  /** Selected plugins whose view could not be resolved during the last assert. */
  private missingPids = new Set<string>()

  constructor(pluginId: string, store: SettingsStore, onPluginsChanged?: () => void) {
    this.pluginId = pluginId
    this.store = store
    this.onPluginsChanged = onPluginsChanged ?? null
    this.containerId = `${pluginId}--${DOCK_KEY}`
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
    this.undockAll('dispose')

    const doc = getHostDocument()
    if (doc === null) return
    const cleanup = takeHostCleanup(doc)
    if (cleanup !== null) runQuietly(cleanup)
    doc.getElementById(this.containerId)?.remove()
  }

  private async runAssert(): Promise<void> {
    const doc = getHostDocument()
    if (doc === null) return

    // Any assert supersedes a pending missing-view watch and the split it was built for.
    const generation = ++this.watchGeneration
    this.provideStyle()

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
    const { viewTop, viewBottom } = this.effectiveViews()
    await Promise.all([
      this.dockView(doc, root, 'top', viewTop),
      this.dockView(doc, root, 'bottom', viewBottom),
    ])
    if (this.disposed || generation !== this.watchGeneration) return
    this.watchMissingViews(generation)

    // The stylesheet is what carries the split from here on — but `provideStyle` is fire-and-forget,
    // so only drop the drag-time inline override once the new sheet is provably in the host document.
    // Clearing it earlier flashes the previous ratio for a few frames.
    if (this.dragging || root.style.getPropertyValue('--sdock-split') === '') return
    if (await this.waitForSheet(doc, generation)) {
      if (!this.dragging && generation === this.watchGeneration) root.style.removeProperty('--sdock-split')
    }
  }

  /** True once the sheet standing in the host document carries the split we last provided. */
  private isSheetCurrent(doc: Document): boolean {
    const el = doc.querySelector(`[data-injected-style="${STYLE_KEY}-${this.pluginId}"]`)
    if (el === null) return false
    return el.textContent?.includes(splitVarFallback(this.store.current().splitPct)) ?? false
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

  /**
   * The selections as the DOM will actually realise them. One plugin's view is a single instance, so
   * the same pid picked twice only fills the top slot — the stylesheet and the mounting code have to
   * agree on that, or the layout would keep a slot open for a view that can never arrive.
   */
  private effectiveViews(): { viewTop: string; viewBottom: string } {
    const { viewTop, viewBottom } = this.store.current()
    return { viewTop, viewBottom: viewBottom === viewTop ? NO_VIEW : viewBottom }
  }

  private provideStyle(): void {
    const { mode, splitPct } = this.store.current()
    const { viewTop, viewBottom } = this.effectiveViews()
    logseq.provideStyle({
      key: STYLE_KEY,
      style: buildDockCss({ pluginId: this.pluginId, mode, splitPct, viewTop, viewBottom }),
    })
  }

  private inject(): void {
    logseq.provideUI({ key: DOCK_KEY, path: DOCK_PATH, template: this.template })
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
  private async dockView(doc: Document, root: HTMLElement, slot: SlotName, pid: string): Promise<void> {
    const slotEl = this.slotElement(root, slot)
    if (slotEl === null) return

    if (pid === NO_VIEW) {
      this.clearSlot(doc, slot, 'deselect')
      renderPlaceholder(slotEl, NO_SELECTION_TEXT)
      return
    }

    const current = this.mounts.get(slot)
    if (current !== undefined && current.pid === pid) {
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
    const mount: SlotMount = { pid, strategy: 'embed', slotEl, node: null, watcher: null, watchTimer: null }
    this.mounts.set(slot, mount)
    this.watchEmbedSubtree(slot, mount)
  }

  /** Legacy strategy: re-parent the plugin's own main-UI container into the slot. */
  private adoptMainUi(doc: Document, slotEl: HTMLElement, slot: SlotName, pid: string): void {
    const canonical = doc.getElementById(`${pid}_lsp_main`)
    if (canonical === null) {
      // Either there is nothing to dock, or the plugin has not finished booting — the missing-view
      // watch keeps looking for a while before we settle on the placeholder.
      this.missingPids.add(pid)
      renderPlaceholder(slotEl, `"${pid}" has no view to dock. Is the plugin installed and enabled?`)
      return
    }

    clearHostChildren(slotEl)
    slotEl.appendChild(canonical)
    const mount: SlotMount = {
      pid,
      strategy: 'adopt',
      slotEl,
      node: canonical,
      watcher: null,
      watchTimer: null,
    }
    this.mounts.set(slot, mount)
    this.watchAdoptedContent(slot, mount)
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

    const views = this.effectiveViews()
    const pid = slot === 'top' ? views.viewTop : views.viewBottom
    if (pid === NO_VIEW) return

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
   * Forget the embed mounts belonging to the plugin a registry event was about. That provider left a
   * dead subtree behind, which would otherwise read as an eviction ("open in another surface" plus a
   * Reclaim button the user should not have to press); the next assert re-establishes it through the
   * normal probing path. No `embedUnmount`: the provider may be gone, and if it is not, `embedMount`
   * is idempotent, so a live subtree is re-adopted on the probe's first check.
   *
   * Strictly scoped by pid — see {@link droppedByLifecycle} for why an unrelated plugin's event must
   * never reach an evicted record.
   */
  private dropInvalidatedMounts(changedPid: string | null): void {
    for (const [slot, mount] of [...this.mounts]) {
      if (droppedByLifecycle(mount, changedPid)) this.takeMount(slot)
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
        if (!isHealthy(doc.getElementById(this.containerId))) void this.assert()
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
      this.onPluginsChanged?.()
      void this.assert()
    })

    const offPassthrough = this.installDragPassthrough(doc)

    setHostCleanup(doc, () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      observer.disconnect()
      offRoute()
      offLifecycle?.()
      offPassthrough()
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

/** Remove our own children from a slot, never anything a provider owns (host rule 6). */
function clearHostChildren(slotEl: HTMLElement): void {
  for (const child of [...slotEl.children]) {
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
