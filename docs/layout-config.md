# Layout configuration model (v2)

Reference for the dock's configuration: many named layouts, each with any number of slots, all
editable from the dock's own UI. Replaces the v1 fixed `top`/`bottom` pair.

There are no v1 users — **no migration**. Unknown legacy setting keys are simply ignored.

## Concepts

- **Tab strip** — `Nav` (always present, fixed label, the stock navigation) plus one tab per user
  layout. Wraps to more rows rather than overflowing into a menu.
- **Layout** — a short user-supplied name, an axis, and an ordered list of slots.
- **Slot** — a stable id, a weight, and a source (nothing / a plugin / a renderer macro).

## Storage

Three flat `useSettingsSchema` keys:

| key | type | meaning |
| --- | --- | --- |
| `activeTab` | string | `'nav'` or a layout id |
| `adoptPoke` | string | unchanged from v1 |
| `layouts` | string | canonical JSON of `DockConfig` |

`activeTab` stays OUT of the JSON blob deliberately: it is rewritten on every tab click, and
`SettingsStore`'s override layer is per key — keeping it separate stops a tab flip from clobbering a
config edit whose host echo has not arrived yet.

Gone: `mode`, `viewTop`, `viewBottom`, `macroTop`, `macroBottom`, `splitPct`.

## Types (`src/config.ts`)

```ts
export type SlotAxis = 'column' | 'row'

export type SlotSource =
  | { kind: 'none' }
  | { kind: 'plugin'; pid: string }
  | { kind: 'macro'; raw: string }

export interface SlotConfig { id: string; weight: number; source: SlotSource }
export interface Layout { id: string; name: string; axis: SlotAxis; slots: SlotConfig[] }
export interface DockConfig { version: 2; layouts: Layout[] }
```

**Ids** — `l_`/`s_` followed by 6 lowercase hex digits, generated once and never derived from
position. They must be valid CSS idents *and* stay stable across config edits: slot-element identity
is the wipe-vs-eviction discriminator (embed protocol host rule 4), the macro wrapper's
`getElementById` target, and the `slot` field of the protocol payload. Positional ids
(`slot-0`, `slot-1`) would make inserting a slot read as a wave of false remounts and evictions.

**Normalization** (`normalizeConfig`) — total, never throws:

- `name`: trimmed; empty falls back to `Layout <n>`; truncated to 12 chars (the tab strip's budget).
- `weight`: finite, clamped to `[0.05, 20]`, rounded to 4 decimals, default `1`.
- `axis`: `'row'` only when exactly that; otherwise `'column'`.
- `slots`: malformed entries dropped; ids missing/duplicated are regenerated. Cap 12 per layout
  (sanity backstop, not a product limit). A layout may legitimately have zero slots.
- `layouts`: malformed entries dropped; ids missing/duplicated regenerated. Zero layouts is legal.

**Parse failure is not normalization.** `parseConfig(raw: string)` returns
`{ ok: true; config } | { ok: false; raw; error }`. A non-blank string that is not valid JSON is a
failure: the dock shows a diagnostic and **must not write the `layouts` key while in that state**, or
a typo in the raw-JSON escape hatch destroys the whole configuration. A string that parses but holds
junk is *not* a failure — it goes through normalization.

While the stored JSON is broken the dock **keeps rendering the last configuration that parsed**
(`Dock.lastGoodConfig`) rather than blanking. Editing the raw JSON is the one place a user is
guaranteed to produce a transient syntax error — mid-keystroke — and tearing every mounted view down
and back up on each of those frames would reload every docked plugin. Only when nothing has ever
parsed does it fall back to an empty config.

**Canonical serialization** — `serializeConfig` emits a fixed key order (`version`, then per layout
`id, name, axis, slots`, then per slot `id, weight, source`, then `kind` before its payload) with no
whitespace. `settingsDiffer` compares settings per key with `!==`, so non-deterministic key order
would make every host echo read as a change and drive a self-sustaining assert loop.

## Resolution

`ViewSpec` keeps its v1 shape (`none | plugin | macro | invalid-macro`) and moves to `config.ts`.

`resolveLayoutSlots(layout)` → `readonly ResolvedSlot[]`, `ResolvedSlot = { id, weight, spec }`:

- `macro` raw goes through `parseMacroSpec`; unparseable becomes `invalid-macro` (never a silent
  fall-through — the user needs to see the typo).
- **Duplicate pid within one layout**: first slot wins, later ones resolve to `none`. A plugin's main
  UI is one DOM node, so two visible slots cannot both hold it.
- Every configured slot always renders as a slot box. A `none` slot shows the "pick a view"
  placeholder. The v1 `SlotLayout` four-way `both|top-only|bottom-only|empty` collapse is **deleted**
  — with N slots it is meaningless, and the edit UI needs empty slots to be visible and clickable.

## DOM shape

The `provideUI` template shrinks to a static shell:

```html
<div class="sdock-tabs"></div>
<div class="sdock-layouts"></div>
```

Everything below it — tabs, layout roots, slots, dividers, edit controls — is **built and reconciled
in the host realm with `doc.createElement`**, the pattern already used for placeholders, overlays and
macro wrappers. Three things follow:

1. No DOMPurify exposure, so `<select>`/`<input>` controls are safe to use.
2. A config change never re-injects the template, so **adding or removing a slot cannot disturb the
   mounts of the slots that stayed** — reconcile children in place, keyed by slot id.
3. `isHealthy` checks for the two shell children (plus that they are still ours).

Host delegation reaches these nodes: `setupInjectedUI` binds one listener per event type on the
injected container and dispatches via `target.closest('[data-on-<type>]')`, so nodes added later are
covered. It is bound for `click`, `change`, `input`, `keydown`, `contextmenu` and more — **not click
only** — and the model receives `{ type, value, id, className, dataset }` built from the trigger
element by `transformableEvent`. That `{ value, dataset }` pair is the entire channel: models get no
element reference, so every control carries its target in `data-*` (e.g. `data-slot-id`).

Per-slot structure:

```html
<div class="sdock-layout" data-layout="l_xxxxxx">
  <div class="sdock-slot" data-slot-id="s_xxxxxx" id="<pid>--slot-s_xxxxxx" data-embed-host="<pid>">…</div>
  <div class="sdock-divider" data-divider-index="0"></div>
  <div class="sdock-slot" …></div>
</div>
```

## Mounting (`dock.ts`)

- Mount records key on **slot id** (globally unique across layouts): `mounts: Map<string, SlotMount>`.
- `slotElementId(hostPid, slotId)` and `macroSlotDomId(pluginId, slotId)` take the slot id.
- **Every layout's DOM exists**; only the active one is visible. Hiding is `display: none`, never
  detaching — a detached plugin iframe reboots.
- **Lazy mount**: a layout's slots are filled on its first activation and stay mounted for the rest of
  the session. Track `mountedLayouts: Set<string>`; an assert fills the slots of
  `mountedLayouts ∪ {active}` only. Without this, four layouts of three slots boot twelve plugin
  iframes at startup and burn several 6 s embed probes before the sidebar is usable.
- **Duplicate pid across layouts is allowed.** An embed-protocol provider can mount into several slots
  (the protocol already passes the slot id). An `adopt` plugin has exactly one node, so only slots in
  the **active** layout may hold an adopt mount for a pid; a slot in an inactive layout that wants a
  pid held elsewhere is left showing whatever it had and steals the node back when its own layout is
  activated. The reload that costs is the accepted price, and the edit UI should say so on a pid used
  by more than one layout.
- **Reclaim**: one model, `sdockReclaim`; the button carries `data-slot-id` and the model reads
  `e.dataset.slotId`. The v1 pair of pre-registered per-slot model names cannot work with dynamic
  slots.

## Geometry (`divider.ts`)

Weights, not percentages. Dragging divider *i* moves weight between slots *i* and *i+1* and leaves
every other slot pinned; adding or removing a slot never renormalizes its siblings.

```ts
export function resizeWeights(
  weights: readonly number[],
  index: number,        // divider between slot `index` and `index + 1`
  deltaPx: number,      // pointer movement along the layout axis since drag start
  containerPx: number,  // layout root extent along that axis
  minPx: number,        // per-slot floor
): number[]
```

Sum-preserving, only the two neighbours change, both kept at or above `minPx` worth of weight,
results rounded to 4 decimals. Degenerate input (`containerPx <= 0`, non-finite anything, total
weight `<= 0`) returns the input unchanged — a drag against a collapsed dock must not persist
nonsense. The v1 `SPLIT_MIN`/`SPLIT_MAX` percentage clamp is replaced by this px floor.

## Styles (`src/styles.ts`)

Still one keyed `provideStyle` sheet, still the only place persistent layout may live.

- `.sdock-layout[data-layout="<id>"]` — `display: flex`, `flex-direction` from the axis, hidden unless
  it is the active tab.
- Each slot: `flex-grow: var(--sdock-w-<slotId>, <weight>)`, plus `flex-basis: 0`. The px floor is
  `min-height` on a column layout and `min-width` on a row layout.
- **Live drag** generalizes the v1 `--sdock-split` trick: the drag writes `--sdock-w-<slotId>` inline
  on our own layout root (the one inline style the host gotchas allow, because the node is ours), then
  `provideStyle` bakes the new weights and the inline vars are dropped once the sheet has provably
  landed. The v1 `splitVarFallback` probe becomes a marker line the builder emits and the dock checks
  for, e.g. `/* sdock-sig: <canonical weights + activeTab> */` — both sides must agree on the exact
  text, so it stays one exported function.
- `hostedViewRules(pid)` is emitted for every pid across **all** layouts.
- Tab strip: `flex-wrap: wrap`, tabs content-sized (`flex: 0 1 auto` — v1's `flex: 1 1 0` stretches
  absurdly once the sidebar can be widened), active tab matched on `[data-tab="<activeTab>"]`.
- Keep unchanged: the `.nav-contents-container` height override, nav hiding while a layout tab is
  active, the `:where(iframe) { margin: 0 }` neutral-environment carve-out, and both drag-passthrough
  rules.
- Edit mode adds rules under a `.sdock-editing` class on our container.

## Edit mode

A gear in the tab strip toggles it. State is in-memory on `Dock` (not persisted) — it is a mode, not
a preference. Every control is a host-realm node carrying its target in `data-*`:

| control | event attr | model | payload |
| --- | --- | --- | --- |
| add layout | `data-on-click` | `sdockAddLayout` | — |
| remove layout | `data-on-click` | `sdockRemoveLayout` | `data-layout-id` |
| rename layout | `data-on-change` | `sdockRenameLayout` | `data-layout-id`, `value` |
| toggle axis | `data-on-click` | `sdockToggleAxis` | `data-layout-id` |
| add slot | `data-on-click` | `sdockAddSlot` | `data-layout-id` |
| remove slot | `data-on-click` | `sdockRemoveSlot` | `data-slot-id` |
| move slot up/down | `data-on-click` | `sdockMoveSlot` | `data-slot-id`, `data-dir` |
| pick source | `data-on-change` | `sdockPickSource` | `data-slot-id`, `value` |
| set macro spec | `data-on-change` | `sdockSetMacro` | `data-slot-id`, `value` |

The source picker is a `<select>` listing `— none —`, every installed plugin id (via
`getInstalledPluginIds`), and a `macro…` entry that reveals the macro text input for that slot. A pid
that is configured but no longer installed is kept in the list, so a disabled plugin's slot does not
silently read as `— none —` and re-enabling the plugin does not cost the user the pick.

Adding a layout or a slot turns edit mode **on** — both are only reachable from a control that implies
the user is configuring, and landing in read-only mode next to a slot you just created is a dead end.

Text inputs commit on `change` (blur/Enter), never `input`: an assert can re-render the panel and a
per-keystroke commit would fight it. Losing a half-typed name to a concurrent assert is the accepted
failure mode.

**Destructive removes arm first.** Dropping a layout that holds configured slots, or a slot that holds
a view, relabels the button to `Sure?`; a second click within a few seconds performs it. It disarms on
a timeout, on any other edit-mode interaction (including a divider drag), and on leaving edit mode.
There is no prompt API and `logseq.UI.showMsg` is message-only, so the second click is the whole
mechanism. Arm state is in-memory on `Dock`, single-valued and never persisted, and the armed look is
pushed onto the button in place rather than by rebuilding the panel (a rebuild eats a half-typed macro
spec). Removing an empty layout or an unconfigured slot stays one click — asking twice for the
harmless cases only trains the user to click twice.

**The mutations themselves are pure** (`config.ts`): `addLayout`, `removeLayout`, `renameLayout`,
`toggleLayoutAxis`, `addSlot`, `removeSlot`, `moveSlot`, `setSlotSource`, `setSlotMacroMode`,
`setSlotMacro`, `setLayoutWeights` — each takes the config in force and returns a new one, sharing
everything that did not change *by reference*, which is what guarantees a surviving slot keeps its id.
`dock.ts` only sequences them (parse → transform → normalize → override → repaint → `updateSettings` →
re-assert). A new slot's weight is the mean of its siblings', not a flat `1`: weights are absolute
shares nothing renormalizes.

Every mutation follows the v1 write path — mutate config, `store.override(...)`, re-provide the
stylesheet for an instant repaint, `logseq.updateSettings(...)`, re-assert — because
`updateSettings` is fire-and-forget and reading `logseq.settings` straight after a write is one stale
frame.

**In-memory side effects belong to the gate, not the caller.** `Dock.edit()` is the single write path
and the single place that can refuse (the parse-failure state above), so it also owns the state a
mutation changes locally: callers pass an `applied` callback that only the successful path runs, next
to the optional settings `patch` that rides along. Doing it around the call instead is what produced
two real bugs — edit mode flipping on while nothing was written, so the whole edit chrome erupted over
the mounted views on some later unrelated assert; and a refused layout removal still evicting the
layout from `mountedLayouts`, quietly demoting a live hidden layout to never-filled-again. A boolean
return would have left both spellings available to the next helper; passing the effect into the gate
does not.
