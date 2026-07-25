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

import '@logseq/libs'

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
  on: (event: string, handler: () => void) => unknown
  off: (event: string, handler: () => void) => unknown
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
 * Returns an unsubscribe function, or `null` when the registry is not reachable.
 */
export function subscribeHostPluginLifecycle(handler: () => void): HostCleanup | null {
  const host = getHostWindow()
  if (host === null) return null
  const emitter = asEmitter(host.LSPluginCore)
  if (emitter === null) return null
  for (const event of PLUGIN_LIFECYCLE_EVENTS) emitter.on(event, handler)
  return () => {
    for (const event of PLUGIN_LIFECYCLE_EVENTS) emitter.off(event, handler)
  }
}

/** Ids of every plugin the host has registered, excluding `selfId`. */
export function getInstalledPluginIds(selfId: string): string[] {
  const host = getHostWindow()
  if (host === null) return []
  return [...host.LSPluginCore.registeredPlugins.keys()].filter((id) => id !== selfId).sort()
}
