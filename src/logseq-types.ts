/**
 * Local typed model of the host surfaces we reach for.
 *
 * Our code runs inside the plugin's own iframe, which the host creates WITHOUT a `sandbox` attribute —
 * so `window.top` is the same-origin host window and everything below is a plain property read.
 * Nothing here uses `any`: host values arrive as `unknown` and are narrowed by hand.
 *
 * Two host facts shape this file:
 * - `@logseq/libs` (dist/LSPlugin.core.d.ts) already declares the global `Window.LSPluginCore` with the
 *   real host-side type, so re-declaring it here would only collide with it. We runtime-verify the one
 *   member we consume and then use the SDK's typing.
 * - Host DOM nodes and host intrinsics live in a different realm than ours, so `instanceof` against our
 *   own constructors is meaningless — this module duck-types instead.
 */

/**
 * Note: no `import '@logseq/libs'` here on purpose. The package's global `Window` augmentation is in
 * the program because `dock.ts` and `main.ts` import it, and leaving the side-effect import out keeps
 * this module loadable outside a browser — which is what makes {@link extractPluginId} unit-testable.
 */

/** Teardown callback parked on the host document so it survives our plugin's module scope. */
export type HostCleanup = () => void

interface HostDocumentWithCleanup extends Document {
  __sdockCleanup?: HostCleanup
}

/**
 * The `on`/`off` surface of `LSPluginCore` (an `eventemitter3` instance).
 * The SDK types its event union without the names we need, so we duck-type our own narrow view.
 */
interface EmitterLike {
  on: (event: string, handler: (...args: unknown[]) => void) => unknown
  off: (event: string, handler: (...args: unknown[]) => void) => unknown
}

/**
 * Host events that can invalidate a docked view or the list of installed plugins.
 * Note `unloaded` is a `PluginLocal` event, not a core one — `disabled`/`unlink-plugin` are the
 * core-level equivalents.
 */
const PLUGIN_LIFECYCLE_EVENTS = [
  'registered',
  'unregistered',
  'reloaded',
  'unlink-plugin',
  'enabled',
  'disabled',
] as const

/**
 * Which plugin a registry event is about.
 *
 * Verified against the host bundle (`resources/js/lsplugin.core.js`) — the argument is either the
 * `PluginLocal` itself or the bare id string, depending on the event:
 * `registered` → `emit("registered", pluginLocal)`, `reloaded` → `emit("reloaded", this)`,
 * `unregistered` / `enabled` / `disabled` / `unlink-plugin` → `emit(..., id)`.
 *
 * Returns `null` when the shape is something we do not recognise, and callers must treat that as
 * "affects no specific plugin" rather than "affects all of them".
 */
export function extractPluginId(args: readonly unknown[]): string | null {
  for (const arg of args) {
    if (typeof arg === 'string') {
      if (arg.trim() !== '') return arg
      continue
    }
    if (typeof arg !== 'object' || arg === null) continue
    if ('id' in arg && typeof arg.id === 'string' && arg.id.trim() !== '') return arg.id
  }
  return null
}

/** Duck-typed `Map` check (a cross-realm `instanceof Map` would always be false). */
function isMapLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return 'keys' in value && typeof value.keys === 'function'
}

/** True when `LSPluginCore.registeredPlugins` is actually reachable on this window. */
function hasPluginRegistry(win: Window): boolean {
  const core: unknown = win.LSPluginCore
  if (typeof core !== 'object' || core === null) return false
  if (!('registeredPlugins' in core)) return false
  return isMapLike(core.registeredPlugins)
}

function asEmitter(value: unknown): EmitterLike | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('on' in value) || !('off' in value)) return null
  if (typeof value.on !== 'function' || typeof value.off !== 'function') return null
  return value as EmitterLike
}

/** The host `window` (with a usable `LSPluginCore`), or `null` when it is not reachable. */
function getHostWindow(): Window | null {
  try {
    const top: Window | null = window.top
    if (top === null) return null
    return hasPluginRegistry(top) ? top : null
  } catch {
    // Cross-origin access (should not happen for the un-sandboxed plugin iframe) throws.
    return null
  }
}

/** The host `document`, or `null` when it is not reachable. */
export function getHostDocument(): Document | null {
  try {
    return window.top?.document ?? null
  } catch {
    return null
  }
}

/**
 * Take the teardown handle a previous instance of this plugin parked on the host document.
 * Module scope resets on plugin reload; the host document does not — so observers and listeners
 * would otherwise stack up one set per reload.
 */
export function takeHostCleanup(doc: Document): HostCleanup | null {
  const host = doc as HostDocumentWithCleanup
  const cleanup = host.__sdockCleanup
  delete host.__sdockCleanup
  return cleanup ?? null
}

/** Park the teardown handle on the host document. {@link takeHostCleanup} removes it again. */
export function setHostCleanup(doc: Document, cleanup: HostCleanup): void {
  const host = doc as HostDocumentWithCleanup
  host.__sdockCleanup = cleanup
}

/**
 * Subscribe to the host plugin-registry lifecycle (install/reload/enable/disable of ANY plugin).
 * The handler receives the id of the plugin the event is about, or `null` if it cannot be read.
 * Returns an unsubscribe function, or `null` when the registry is not reachable.
 */
export function subscribeHostPluginLifecycle(
  handler: (pid: string | null) => void,
): HostCleanup | null {
  const host = getHostWindow()
  if (host === null) return null
  const emitter = asEmitter(host.LSPluginCore)
  if (emitter === null) return null

  const listener = (...args: unknown[]): void => {
    handler(extractPluginId(args))
  }
  for (const event of PLUGIN_LIFECYCLE_EVENTS) emitter.on(event, listener)
  return () => {
    for (const event of PLUGIN_LIFECYCLE_EVENTS) emitter.off(event, listener)
  }
}

/**
 * `LSPluginCore.hookApp` — the host's own plugin-hook broadcast. With no `pid` it goes to every
 * enabled plugin that installed the hook, which is exactly what a real macro render does.
 */
interface HookAppLike {
  hookApp: (type: string, payload?: unknown, pid?: string) => unknown
}

function asHookApp(value: unknown): HookAppLike | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('hookApp' in value) || typeof value.hookApp !== 'function') return null
  return value as HookAppLike
}

/**
 * Emit a host app hook. Used to re-emit `macro-renderer-slotted` for a slot we own (see `macro.ts`).
 *
 * Returns whether the call was actually made — a `false` means the bridge is unreachable and no
 * amount of retrying will help. The call itself is async with no useful result: like every other
 * plugin RPC here, the DOM is the only acknowledgment channel, so the promise is swallowed rather
 * than left to float.
 */
export function emitHostAppHook(type: string, payload: unknown): boolean {
  const host = getHostWindow()
  if (host === null) return false
  try {
    const core = asHookApp(host.LSPluginCore)
    if (core === null) return false
    const result: unknown = core.hookApp(type, payload)
    void Promise.resolve(result).catch(() => {
      // Nothing to do: a hook nobody handles is indistinguishable from one that succeeded.
    })
    return true
  } catch {
    return false
  }
}

/**
 * `LSPluginCore._forceCleanInjectedUI` — the host's own teardown for one injected-UI element.
 *
 * The host runs exactly this for every `[data-injected-ui]` descendant when it unmounts a macro slot.
 * Removing our wrapper without it would leave the libs-side `injectedUIEffects` teardown closure
 * behind for good, so we mirror the host instead of just detaching the node.
 */
export function forceCleanInjectedUi(id: string): boolean {
  if (id === '') return false
  const host = getHostWindow()
  if (host === null) return false
  try {
    const core: unknown = host.LSPluginCore
    if (typeof core !== 'object' || core === null) return false
    if (!('_forceCleanInjectedUI' in core) || typeof core._forceCleanInjectedUI !== 'function') return false
    const clean = core as { _forceCleanInjectedUI: (id: string) => unknown }
    clean._forceCleanInjectedUI(id)
    return true
  } catch {
    return false
  }
}

/** Ids of every plugin the host has registered, excluding `selfId`. */
export function getInstalledPluginIds(selfId: string): string[] {
  const host = getHostWindow()
  if (host === null) return []
  return [...host.LSPluginCore.registeredPlugins.keys()].filter((id) => id !== selfId).sort()
}
