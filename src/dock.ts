/**
 * Host-side machinery: injects the dock pane into the left sidebar, keeps it alive, and adopts other
 * plugins' main-UI containers into its two slots.
 *
 * Runs inside our own (un-sandboxed, same-origin) plugin iframe and reaches into the host document
 * through `window.top`. The host has NO lifecycle management for `path`-injected UI, so re-assertion
 * is entirely ours: a debounced MutationObserver, an `App.onRouteChanged` re-check, and the
 * `LSPluginCore` plugin-registry events.
 */

import '@logseq/libs'

import { computeSplitPct } from './divider'
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

/**
 * `data-on-<event>` is `setupInjectedUI`'s own delegation: the host binds one listener on the container
 * and routes clicks to the model registered with `logseq.provideModel`. It is re-bound whenever the
 * container is re-created and survives the idempotent innerHTML rewrite, so we never bind clicks here.
 */
const TEMPLATE = [
  '<div class="sdock-tabs">',
  '<button class="sdock-tab" data-tab="nav" data-on-click="sdockShowNav">Nav</button>',
  '<button class="sdock-tab" data-tab="views" data-on-click="sdockShowViews">Views</button>',
  '</div>',
  '<div class="sdock-root">',
  '<div class="sdock-slot" data-slot="top"></div>',
  '<div class="sdock-divider" title="Drag to resize"></div>',
  '<div class="sdock-slot" data-slot="bottom"></div>',
  '</div>',
].join('')

const POLL_START_MS = 50
const POLL_MAX_MS = 500
const POLL_BUDGET_MS = 15_000
/** How long to keep watching for a selected plugin's main UI to appear (it may still be booting). */
const MISSING_VIEW_BUDGET_MS = 20_000
/** How long to wait for a provided stylesheet to actually land in the host document. */
const SHEET_BUDGET_MS = 3_000
const OBSERVER_DEBOUNCE_MS = 250

type SlotName = 'top' | 'bottom'

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

interface AdoptedView {
  pid: string
  node: HTMLElement
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

export class Dock {
  private readonly pluginId: string
  private readonly store: SettingsStore
  private readonly onPluginsChanged: (() => void) | null
  private readonly containerId: string
  private readonly adopted = new Map<SlotName, AdoptedView>()

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
  /** Selected plugins whose main UI did not exist during the last assert. */
  private missingPids = new Set<string>()

  constructor(pluginId: string, store: SettingsStore, onPluginsChanged?: () => void) {
    this.pluginId = pluginId
    this.store = store
    this.onPluginsChanged = onPluginsChanged ?? null
    this.containerId = `${pluginId}--${DOCK_KEY}`
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

  /** Return every adopted node to the host `<body>` and drop our bookkeeping. */
  undockAll(): void {
    const doc = getHostDocument()
    if (doc !== null) {
      for (const entry of this.adopted.values()) {
        this.release(doc, entry.pid, entry.node, 'wipe')
      }
    }
    this.adopted.clear()
  }

  /** Tear everything down — other plugins' live nodes go back to the host body untouched. */
  dispose(): void {
    this.disposed = true
    this.endDrag()
    this.dividerAbort?.abort()
    this.dividerAbort = null
    this.undockAll()

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
      this.undockAll()
      this.inject()
    }

    const container = await this.waitForContainer(doc)
    if (container === null || this.disposed) return

    const root = container.querySelector<HTMLElement>('.sdock-root')
    if (root === null) return

    this.attachDivider(doc, container, root)

    this.missingPids.clear()
    const { viewTop, viewBottom } = this.store.current()
    this.dockView(doc, root, 'top', viewTop)
    // One plugin's main UI is a single DOM node: it cannot live in both slots at once.
    this.dockView(doc, root, 'bottom', viewBottom === viewTop ? NO_VIEW : viewBottom)
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
   * assert — its `#<pid>_lsp_main` simply does not exist yet, and our MutationObserver only watches
   * our own container, so nothing would ever retry. Watch for it with a bounded backoff instead.
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

  /** Views currently meant to be hosted, for the `!important` overrides in the stylesheet. */
  private hostedPids(): string[] {
    const { viewTop, viewBottom } = this.store.current()
    return [viewTop, viewBottom].filter((pid) => pid !== NO_VIEW)
  }

  /**
   * Re-publish the stylesheet — the whole nav/views switch is a stylesheet swap, so this is all a mode
   * flip needs. Public so the segmented control can repaint instantly, ahead of the settings echo.
   */
  refreshStyle(): void {
    this.provideStyle()
  }

  private provideStyle(): void {
    const { mode, splitPct } = this.store.current()
    logseq.provideStyle({
      key: STYLE_KEY,
      style: buildDockCss({
        pluginId: this.pluginId,
        mode,
        splitPct,
        hostedPids: this.hostedPids(),
      }),
    })
  }

  private inject(): void {
    logseq.provideUI({ key: DOCK_KEY, path: DOCK_PATH, template: TEMPLATE })
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

  /** Adopt `pid`'s main-UI container into a slot (or show a placeholder when there is nothing to dock). */
  private dockView(doc: Document, root: HTMLElement, slot: SlotName, pid: string): void {
    const slotEl = root.querySelector<HTMLElement>(`.sdock-slot[data-slot="${slot}"]`)
    if (slotEl === null) return

    const current = this.adopted.get(slot)

    if (pid === NO_VIEW) {
      this.dropCurrent(doc, slot, current)
      renderPlaceholder(slotEl, 'No view selected — pick one in the Sidebar Dock plugin settings.')
      return
    }

    // Always re-resolve: if the plugin reloaded, the host built a FRESH container and whatever we hold
    // is a superseded husk.
    const canonical = doc.getElementById(`${pid}_lsp_main`)
    if (
      current !== undefined &&
      current.pid === pid &&
      current.node === canonical &&
      canonical.parentElement === slotEl
    ) {
      return
    }

    this.dropCurrent(doc, slot, current)

    if (canonical === null) {
      // Either there is nothing to dock, or the plugin has not finished booting — {@link
      // watchMissingViews} keeps looking for a while before we settle on the placeholder.
      this.missingPids.add(pid)
      renderPlaceholder(slotEl, `"${pid}" has no main UI to dock. Is the plugin installed and enabled?`)
      return
    }

    slotEl.replaceChildren(canonical)
    this.adopted.set(slot, { pid, node: canonical })
  }

  private dropCurrent(doc: Document, slot: SlotName, current: AdoptedView | undefined): void {
    if (current === undefined) return
    this.adopted.delete(slot)
    this.release(doc, current.pid, current.node, 'swap')
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

    // A hosted plugin that reloads gets a brand new main-UI container; a newly installed one belongs
    // in the settings dropdowns.
    const offLifecycle = subscribeHostPluginLifecycle(() => {
      if (this.disposed) return
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

function renderPlaceholder(slotEl: HTMLElement, text: string): void {
  const existing = slotEl.querySelector<HTMLElement>('.sdock-placeholder')
  // Idempotent: pointless rewrites would only feed our own MutationObserver.
  if (existing !== null && existing.textContent === text && slotEl.childElementCount === 1) return

  // Build in the HOST realm — the node lives in the host document.
  const el = slotEl.ownerDocument.createElement('div')
  el.className = 'sdock-placeholder'
  el.textContent = text
  slotEl.replaceChildren(el)
}

/** Run host-realm DOM work that may throw if the markup or the owning realm shifted underneath us. */
function runQuietly(fn: () => void): void {
  try {
    fn()
  } catch (err: unknown) {
    console.warn('[sidebar-dock] host operation failed', err)
  }
}
