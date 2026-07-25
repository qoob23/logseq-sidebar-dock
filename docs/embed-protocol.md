# Embed Protocol v1 (`lsp-embed`)

A caller-agnostic convention letting one Logseq plugin (the **host**) embed another plugin's (the
**provider**) view into a host-owned DOM container (a **slot**). Designed for Logseq 0.10.x
(file graph), where all plugin iframes are same-origin and `App.invokeExternalPlugin` is the only
cross-plugin RPC. Nothing here is specific to sidebar-dock or synapses — any pair of plugins can
speak it.

Motivation: adopting a plugin's main-UI container (`#<pid>_lsp_main`) fails for plugins whose view
is not their main UI (headless-backend plugins), and physically re-parenting a live iframe makes
Chromium reload it, rebooting the provider. Under this protocol the **provider owns iframe
creation** — nothing is ever re-parented, so nothing ever reloads.

## Terms

- **Host** — plugin owning the slot element and calling the provider's models.
- **Provider** — plugin implementing the mount/unmount models and injecting its own view.
- **Slot** — a host-owned element in the host document (`parent.document`) with a stable `id` and
  the attribute `data-embed-host="<host-pid>"`.
- **Embed subtree** — everything the provider injects into the slot; its root element carries
  `data-embed-owner="<provider-pid>"`.

## Provider contract

A provider registers two models via `logseq.provideModel`:

```ts
embedMount(payload: {
  slot: string          // DOM id of the slot element in parent.document
  view?: string         // provider-defined view id; omitted = provider's default view
  origin: string        // caller plugin id (diagnostics only; no authorization semantics)
  protocolVersion: 1
}): void

embedUnmount(payload: {
  slot: string
  origin: string
  protocolVersion: 1
}): void
```

Rules:

1. **Guard**: resolve `parent.document.getElementById(slot)`; mount only if the element exists AND
   carries `data-embed-host`. Otherwise no-op (do not throw — RPC has no error channel).
2. **Own the iframe**: the provider creates its view (iframe or DOM) itself and appends it to the
   slot. The root injected element MUST carry `data-embed-owner="<provider-pid>"`. Never expect the
   host to move existing nodes.
3. **Idempotent per slot**: `embedMount` for a slot that already contains a live, connected embed
   subtree from this provider is a no-op. If the previous subtree is dead (element gone,
   `!isConnected`, or the internal connection is broken), tear down remnants and mount fresh.
   Providers MUST NOT rely on host-side render hooks (e.g. `onMacroRendererSlotted`) refiring —
   the host re-invokes `embedMount` instead.
4. **Tolerate hidden slots**: the host may `display:none` the slot (or any ancestor) at any time
   without notice. Stay mounted; do not treat hidden as unmounted.
5. **Fill the slot**: size to 100% × 100% of the slot; the host guarantees the slot is positioned
   (`position: relative` or equivalent) and has real bounds when visible. Do not set inline styles
   outside the embed subtree.
6. **Single-instance / multi-surface arbitration** (providers with exclusive views, e.g. a
   single-peer RPC bridge): **last mount wins across all surfaces** (own sidebar/popout/embeds).
   When another surface takes the view, the provider MUST **remove its embed subtree from the
   slot** (not merely blank or freeze it) — subtree removal is how the host detects eviction.
7. **Unknown fields** in payloads are ignored; unknown `protocolVersion` values are treated as
   unsupported (no-op).
8. **`embedUnmount`**: remove the embed subtree for that slot (if any) and release resources.
   Must tolerate the slot element already being gone.

## Host contract

1. **Slot lifetime**: stable `id`, `data-embed-host="<host-pid>"`, positioned and sized before the
   first `embedMount`. The `id` must be a valid CSS ident.
2. **Invoke**: `logseq.App.invokeExternalPlugin('<provider-pid>.models.embedMount', payload)`.
3. **Re-invoke after slot re-creation**: whenever the host re-creates the slot element (host-app
   re-render wiped the host's UI), it MUST re-invoke `embedMount`. This is the provider's only
   recovery signal.
4. **Do not auto-remount after provider eviction.** Distinguish the two disappearance cases by
   slot-element identity:
   - slot element was destroyed/re-created → host wipe → re-invoke `embedMount` (rule 3);
   - slot element is the SAME node but the embed subtree is gone → the provider evicted the view
     to another surface (provider rule 6) → show an informational state ("view is open
     elsewhere"); re-invoke `embedMount` only on explicit user intent (that re-mount is a
     legitimate last-mount-wins steal).
5. **Unmount best-effort**: call `embedUnmount` when the user deselects the view or the host
   unloads. Providers must survive missing this call (host crash, forced reload).
6. **Hands off the subtree**: never move, edit, or restyle anything inside
   `[data-embed-owner]`. Hiding via the slot/ancestors is allowed.
7. **Success detection** (discovery doubles as this): after `embedMount`, poll the slot for a
   `[data-embed-owner="<provider-pid>"]` child with backoff. `invokeExternalPlugin` resolves
   `undefined` regardless of outcome, so the DOM is the only acknowledgment channel.

## Discovery

Try-and-verify: call `embedMount` and watch the slot (host rule 7). No subtree within the grace
period → the plugin is not a provider → fall back (for sidebar-dock: legacy main-UI adoption, then
placeholder). Calling a nonexistent model is a silent no-op on the provider side — harmless.

Grace-period guidance: first verification ≥ 5 s with re-checks (a provider may be mid-boot);
cache the per-plugin outcome for the session, invalidated by that plugin's lifecycle events
(`registered` / `reloaded` / …), after which the protocol is probed again.

Optional (v1.1, not required): providers MAY additionally advertise named views declaratively by
registering a custom-type UI item (`registerUIItem('embeddable-view', { key, ... })`); hosts can
read these via `App.getStateFromStore('plugin/installed-ui-items')` to list views by name. The
registry entry renders nowhere in the 0.10.x host — it is pure metadata.

## Versioning

`protocolVersion` is a monotonically increasing integer; this document specifies `1`. Additive
fields do not bump the version. Behavioral changes do.
