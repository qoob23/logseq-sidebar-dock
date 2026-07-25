# Design research — left-sidebar dock (Logseq 0.10.x host)

Research against the host source at `/Users/svetozar/personal/synapses/soft/og` (branch `version/file`,
codebase-memory project `synapses-og`) and the synapses plugin (`synapses-main`). Two parts: the left
sidebar itself, and the plugin UI-injection surface for building/hosting the dock pane.

## Synthesis — recommended architecture

1. **There is no left-sidebar plugin API in 0.10.x.** `registerUIItem` renders only `:toolbar`/`:pagebar`;
   registering any other type stores dead data. The pane must be DOM-injected.
2. **Build the pane with `logseq.provideUI({ path, key })` + keyed `logseq.provideStyle`.**
   Inject a container into `#left-sidebar > .left-sidebar-inner > .wrap` (append after `footer.px-2.create`).
   All layout/sizing CSS goes through the keyed `provideStyle` sheet (persistent, idempotently updatable in
   `document.head`); inline JS styles on host nodes are wiped by React re-renders.
3. **We own re-assertion.** The host has zero lifecycle management for `path`-injected UI — no observer, no
   re-injection. Run a MutationObserver (plus an `App.onRouteChanged` re-check) that re-calls `provideUI`
   when our container is gone. Re-calling with the same `key` is an in-place update; a destroyed node is
   re-created. Whole-subtree wipes happen on the `/draw` route and error-boundary trips.
4. **Divider**: our own vertical drag between the two hosted views, mirroring the host's own resizer pattern
   (interact.js is available as a host global, or plain pointer events): write a CSS var into our keyed
   provideStyle sheet + persist the ratio in plugin settings/localStorage. Never touch
   `--ls-left-sidebar-width` (that's the host's horizontal width var).
5. **Hosting the two plugin views**, ranked by reliability:
   - our own iframes (synapses pattern) — trivially reliable;
   - adopting another plugin's *float* `provideUI` container (re-parent, no iframe reload, owner updates keep landing);
   - re-parenting another plugin's main-UI iframe `#<pid>_lsp_main` — highest payoff but Chromium reloads a
     moved iframe and the owner's inline styles must be beaten with `!important` rules.
6. **View chooser**: enumerate installed plugins via `LSPluginCore.registeredPlugins` /
   `App.getStateFromStore('plugin/installed-ui-items')`; selection persisted in settings.

---

## Part 1 — Left sidebar internals

### 1. Implementation location & structure

**Primary file: `src/main/frontend/components/container.cljs`**

| Symbol | Kind | Lines |
|---|---|---|
| `nav-content-item` | `rum/defc < rum/reactive` | 55–67 |
| `page-name` | `rum/defc` | 80–161 |
| `favorite-item` | `rum/defcs` | 170–200 |
| `favorites` | `rum/defc < rum/reactive` | 202–227 |
| `recent-pages` | `rum/defc < rum/reactive db-mixins/query` | 229–256 |
| `flashcards` | `rum/defcs < db-mixins/query rum/reactive` | 258–275 |
| `sidebar-item` | plain `defn` | 288–299 |
| `create-dropdown` | `defn` | 306–332 |
| **`sidebar-nav`** | `rum/defc` (NOT reactive; hooks-based) | 334–495 |
| **`sidebar-resizer`** | `rum/defc` | 497–533 |
| **`left-sidebar`** | `rum/defcs < rum/reactive` | 535–579 |
| `main` | `rum/defc` (renders `left-sidebar` + main content) | 597–670 |
| `sidebar` | app shell | 870–997 |

Mount chain: `frontend.page/current-page` (`src/main/frontend/page.cljs:87-110`) →
`container/sidebar` → `theme/container` → `[:main.theme-inner]` → `[:div#app-container]` →
`[:div#left-container]` → `header/header` + `main` → `left-sidebar`.

### Exact DOM structure rendered

```
div#left-sidebar.cp__sidebar-left-layout            ← left-sidebar (container.cljs:553)
│   class toggles: .is-open .is-closing .is-touching  (+ .is-resizing added imperatively)
│   handlers: onTouchStart/Move/End  (mobile swipe open/close)
│
├── div.left-sidebar-inner.flex-1.flex.flex-col.min-h-0        ← sidebar-nav (:386)
│   │   ref=ref-el; inline style.transform during touch drag; onTransitionEnd; onClick
│   └── div.flex.flex-col.wrap.gap-1.relative                  (:406)   ← ".wrap" in CSS
│       ├── nav.px-4.flex.flex-col.gap-1.cp__menubar-repos     (:414) aria-label="Navigation menu"
│       │   ├── (repo/repos-dropdown)  → contains span#repo-switch
│       │   └── div.nav-header.flex.flex-col.mt-2              (:418)
│       │       ├── div.home-nav OR div.journals-nav
│       │       ├── div.whiteboard      (when enable-whiteboards?)
│       │       ├── div.flashcards-nav  (when enable-flashcards?)
│       │       ├── div.graph-view-nav
│       │       └── div.all-pages-nav
│       ├── div.nav-contents-container.flex.flex-col.gap-1.pt-1   (:472)
│       │   │   onScroll → imperatively adds/removes class "is-scrolled" on itself
│       │   ├── div.nav-content-item.favorites[.is-expand][.has-children]   ← (favorites)
│       │   │   └── div.nav-content-item-inner > div.header / div.bd > ul.favorites > li.favorite-item[data-ref]
│       │   └── div.nav-content-item.recent[…]                              ← (recent-pages)
│       │       └── … > ul > li.recent-item[data-ref]
│       └── footer.px-2.create                                   (:479)
│           └── button#create-button  OR  a.item.new-page-link
├── span.shade-mask                                             (:490)  mobile scrim
└── span.left-sidebar-resizer                                   (:533)  ← sidebar-resizer
```

`sidebar-nav` returns a fragment `[:<> .left-sidebar-inner span.shade-mask]`; `left-sidebar` appends
`(sidebar-resizer)` as third child of `#left-sidebar`.

`nav-content-item` (`:55-67`), signature `[name {:keys [class count]} child]`, is the reusable
"collapsible section" primitive to mimic visually. (`favorites` passes an `:edit-fn` it ignores — dead.)

### 2. State, toggling, resize

State keys (`src/main/frontend/state.cljs`):

| Key | Line | Notes |
|---|---|---|
| `:ui/left-sidebar-open?` | 89 | init from localStorage `"ls-left-sidebar-open?"` |
| `:ui/navigation-item-collapsed?` | 80 | map keyed by section `class` (`"favorites"`, `"recent"`) |
| `:ui/sidebar-open?` | 87 | **right** sidebar |

Accessors: `get-left-sidebar-open?` (1473), `set-left-sidebar-open!` (1477 — writes localStorage + state),
`toggle-left-sidebar!` (1482), `toggle-navigation-item-collapsed!` (1105–1107).

Toggle paths: `frontend.handler.ui/close-left-sidebar!` (`handler/ui.cljs:33-36`); shortcut
`:ui/toggle-left-sidebar` = **`t l`** (`modules/shortcut/config.cljs:481-482`); header hamburger
(`components/header.cljs:56-63`); plugin API `App.invokeExternalCommand('logseq.ui/toggle-left-sidebar')`
and `api.cljs:438-443 set_left_sidebar_visible`. iOS keyboard events mutate `#left-sidebar` style.bottom
directly (`handler/events.cljs:477,505`).

**Resize — the left sidebar IS resizable.** `sidebar-resizer` (`container.cljs:497-533`):
`span.left-sidebar-resizer` (3px strip, `right:-2px`, `cursor:col-resize`), driven by **interact.js**
(`js/window.interact`). Width clamped **240 ≤ w ≤ 460 px**; applied via
`document.documentElement.style.setProperty("--ls-left-sidebar-width", w+"px")`; persisted to localStorage
key **`ls-left-sidebar-width`** (EDN string, e.g. `"300.00px"`); restored in `use-layout-effect!` on mount.
Drag start/end toggle `.is-resizing` on `#left-sidebar` and `.is-resizing-buf` on `<html>`.

Reactive derefs: `main` subs `:ui/left-sidebar-open?` → drives `#main-container.is-left-sidebar-open` and
the `left-sidebar` prop. `sidebar-nav` is **not** reactive (re-renders only via parent props / own hooks).
`favorites` subs config `:favorites`; `recent-pages` subs `:recent/pages`; `flashcards` subs
`:srs/cards-due-count`; `nav-content-item` subs `[:ui/navigation-item-collapsed? class]`.

### 3. Re-render / DOM-replacement behaviour (critical for injection)

No component in this subtree has a changing React key → React **reconciles in place**.

**Stable (never remounted in normal use):** `#left-container`, `#main-container`,
`#main-content-container`, `#left-sidebar` (only class/handlers patched), `.left-sidebar-inner`
(style.transform patched during touch drag), `.wrap`, `nav.cp__menubar-repos`,
`.nav-contents-container`, `footer.create`, `span.left-sidebar-resizer`.

**Churny (do NOT anchor inside):** `.nav-header` children (home/journals swap, whiteboard/flashcards
appear/disappear with feature flags); `.nav-content-item .bd` (unmounts when list empties);
`li.favorite-item`/`li.recent-item` lists; `footer.create` content (swaps on whiteboards toggle).

**Whole-subtree unmount cases:** the `:draw` route (`page.cljs:106-110` renders `(view route-match)`
*instead of* the shell); nil route-match; the `ui/catch-error-and-notify` error boundary
(`page.cljs:104`); dev hot-reload.

**React sibling-insertion hazard:** append as the **last** child of a React-managed parent. The two
lowest-risk spots: after `span.left-sidebar-resizer` inside `#left-sidebar`, or after `footer.create`
inside `.wrap`.

**Imperative host mutations that will fight you:** `.nav-contents-container` class `is-scrolled`;
`#left-sidebar` class `is-resizing`; `<html>` `--ls-left-sidebar-width` written every resize frame;
iOS `#left-sidebar.style.bottom`.

### 4. CSS

`src/main/frontend/components/container.css`:

| Selector | Lines | Key facts |
|---|---|---|
| `#main-container` | 35–50 | `transition: padding-left .3s`; `&.is-left-sidebar-open { @screen sm { padding-left: var(--ls-left-sidebar-width) } }` ← how main content offsets |
| `.left-sidebar-inner` | 69–367 | `height:100%; width: var(--ls-left-sidebar-sm-width); overflow-y:auto; overflow-x:hidden; background: var(--left-sidebar-bg-color); transform: translate3d(-100%,0,0); z-index:3`; at `@screen sm` (353–366): `width: var(--ls-left-sidebar-width)` |
| `.left-sidebar-inner > .wrap` | 84–95 | **`height: calc(100vh - var(--ls-headbar-inner-top-padding) - 50px)`**; `margin-top:30px` → `52px` at sm |
| `.nav-contents-container` | 175–181 | `relative h-full flex-grow-0 overflow-x-hidden overflow-y-auto`; `.is-scrolled` top border |
| `.cp__sidebar-left-layout` | 369–493 | `fixed top-0 left-0 w-[10px]`; `@screen sm`: `width:0; transition: width .3s; &.is-open{ width: var(--ls-left-sidebar-width) }` |
| `.left-sidebar-resizer` | 457–468 | `absolute w-[3px] top-0 right-[-2px] bottom-0 cursor-col-resize z-10` |

CSS vars (`packages/ui/src/vars-classic.css`): `--ls-left-sidebar-width: 246px` (L14, overridden on
`<html>` by the resizer), `--ls-left-sidebar-sm-width: 74vw` (mobile drawer), `--ls-left-sidebar-nav-btn-size`,
`--ls-left-sidebar-text-color`, `--left-sidebar-bg-color` (local to `.left-sidebar-inner`).
Body-level scope classes on `main.theme-inner`: `ls-left-sidebar-open` etc. (`container.cljs:936-942`).
Other consumers of the width var: `header.css:22`, `theme.css`, `mobile/index.css`, `extensions/pdf/pdf.css`.

### 5. Extension points

**None for the left sidebar.** `plugins/hook-ui-items` renders only at `header.cljs:258` (`:toolbar`) and
`page.cljs:484` (`:pagebar`). `register-plugin-ui-item` accepts any type keyword but nothing renders
others — silent no-op. `:favorites` (config.edn) is the only user-controllable content channel, page names
only. `#left-sidebar` is a stable, host-e2e-verified selector (`e2e-tests/utils.ts:118,137,143,144`;
`gdom/getElement "left-sidebar"` in `handler/events.cljs`).

### 6. Implications

**Safe anchors (descending preference):**
1. `#left-sidebar` — append after `span.left-sidebar-resizer`.
2. `#left-sidebar > .left-sidebar-inner > .wrap` — append after `footer.create`; participates in the
   existing flex column naturally. **Preferred for the dock pane.**
3. `.nav-contents-container` — stable but scrolls with favorites/recents; not a peer section.

**Layout constraint:** `.wrap` has a **fixed height** and `.nav-contents-container` is `h-full flex-grow-0`.
To give the dock pane a real share of the column, override via provideStyle:
`#left-sidebar .nav-contents-container { height:auto !important; flex:1 1 auto !important; min-height:0 }`
plus `flex:0 0 var(--dock-pane-h); min-height:0; overflow:hidden; position:relative` on our pane.

**Divider constraints:** own CSS var + own localStorage key; never `--ls-left-sidebar-width`. Mobile:
touch handlers live on `#left-sidebar` (drawer swipe) — the divider must `stopPropagation` on touch
events. `.left-sidebar-inner` is `overflow-y:auto` (`overflow:hidden` while `.is-open` on mobile) —
popups inside will be clipped on mobile. The pane must be hidden when the sidebar is closed
(`#left-sidebar` is `width:0` unless `.is-open`) — observe its `class` attribute or poll
`App.getStateFromStore('ui/left-sidebar-open?')`.

The `onClick` on `.left-sidebar-inner` (`container.cljs:401-404`) auto-closes the mobile drawer for
clicks under `.favorites .bd`, `.recent .bd`, `.dropdown-wrapper`, `.nav-header` — avoid those selectors.

**Verify at runtime:** `container.cljs:950` writes the anomalous hiccup `[:div.#app-container]` — don't
use `#app-container` as an anchor without checking the live DOM. All other ids (`#left-sidebar`,
`#left-container`, `#main-container`, `#create-button`, `#repo-switch`) are certain.

---

## Part 2 — Plugin UI injection surface

Host-bundled plugin runtime (minified but authoritative): `resources/js/lsplugin.core.js` (loaded by
`resources/index.html:57`) — contains both host-side `PluginLocal` and user-side `LSPluginUser`.
SDK types: `node_modules/@logseq/libs/dist/LSPlugin.d.ts` (in the synapses repo).

### 1. `logseq.provideUI` pipeline

Client → host: `caller.call('provider:ui', ui)`. No host cljs involved — injection is pure JS in
`lsplugin.core.js` (`setupInjectedUI`, exported as `window.LSPlugin.pluginHelpers.setupInjectedUI`).
`_onHostMounted` queues until host mount, so early calls are safe.

| Discriminator | Target |
|---|---|
| `'slot' in ui` | `document.querySelector('#'+ui.slot)` |
| `'path' in ui` | `document.querySelector(ui.path)` (arbitrary CSS selector); not found → `console.error` + return false, **no retry** |
| neither | **float mode**: appended to `document.body` as `.lsp-ui-float-container.visible`, interact.js drag/resize |

Mechanics:
- Container `div#<pluginId>--<key>` with `dataset.injectedUi`, `data-ref=<pid>`, `ui.attrs`, `ui.style`
  inline.
- Template DOMPurified: `{ADD_TAGS:['iframe'], ALLOW_UNKNOWN_PROTOCOLS:true, ADD_ATTR:['allow','src','allowfullscreen','frameborder','scrolling','target']}`.
  **`src` IS allowed in this build** — synapses' set-src-via-DOM trick is belt-and-braces for older builds.
- **Idempotent update path:** if `#<containerId>` exists anywhere, only `innerHTML`/attrs/style are
  rewritten (skipping position keys if `dataset.dx` set, i.e. user-dragged). Re-calling with the same
  `key` = in-place update; if the host destroyed the node it is re-created and re-appended.
- `ui.reset === true` works **only in slot mode** (removes existing `[data-injected-ui]` in the slot).
- `template: null/''` → uninject (runs stored cleanup from `window.__injectedUIEffects`).
- Event delegation on the container for click/focus/keyboard/input/contextmenu events:
  `target.closest('[data-on-<event>]')` → `plugin.caller.callUserModel(name, payload)`; payload is
  `{type, value, id, className, dataset, rect}` only. `data-prevent-default="true"` honoured.
- `LSPluginCore._forceCleanInjectedUI(id)` runs the stored cleanup.

**Re-render behaviour — the critical answer: there is NO MutationObserver, NO re-injection, NO watchdog
anywhere in the host.** The only lifecycle hook is slot-mode-only: `hook-ui-slot`
(`frontend/components/plugins.cljs:975-1000`) force-cleans injected UI when the slot unmounts (slot ids
are random per mount — why `onMacroRendererSlotted` refires with new ids). For `path` injections, the
node survives until plugin unload — unless React re-creates the target subtree, which removes it with no
notification. **We own re-assertion**: MutationObserver / interval re-calling `provideUI` (cheap, same
key). Container id `<pid>--<key>` is looked up with `querySelector('#'+id)` — **`key` must be a valid CSS
ident** (no dots/colons/leading digits) or it throws.

### 2. `provideStyle`, main-UI iframe, docking

**`provideStyle`** (`provider:style` handler): keyed lookup
`document.querySelector('[data-injected-style=<key>-<pid>]')` (**unquoted attr value → key+pid must be a
bare CSS ident**); found → replace `textContent` only; else create `<style>` in `document.head`.
**Persistent across every host re-render; removed only on plugin unload. The most durable host-side
lever** — all our layout CSS goes here.

**Main-UI iframe** (`LSPluginCaller._setupIframeSandbox()`): creates
`div#<pid>_lsp_main.lsp-iframe-sandbox-container` (with `data-pid`) appended to `document.body`, Postmate
iframe inside with class `.lsp-iframe-sandbox`. **No `sandbox` attribute** → full same-origin
`parent`/`top` access (this is what makes all `parent.document` work). CSS
(`components/plugins.css:676-800`): container hidden by default; `.visible` → `z-index:
var(--ls-z-index-level-2); width:100%; height:100%`. Inner iframe `position:absolute; inset:0; 100%/100%`.
- `main-ui:style` handler **silently drops `left/top/bottom/right/width/height` when
  `dataset.inited_layout === 'true'`** (persisted layout was restored) — a once-dragged plugin can never
  re-position itself via `setMainUIInlineStyle`.
- **No docking API** — but the container is absolutely-positioned and fills its parent when `.visible`,
  and the host never re-appends it after creation. So
  `pane.appendChild(top.document.getElementById(pid + '_lsp_main'))` is a stable one-shot dock for any
  plugin's main UI — invalidated only on that plugin's reload.

### 3. Hosting OTHER plugins' views — mechanism inventory

SDK surface: `invokeExternalPlugin(type, ...args)` (`'pid.models.key' | 'pid.commands.key'`, d.ts:303),
`getExternalPlugin(pid)` (:308 — returns `PluginLocal.toJSON()` **metadata only**, no callable handle),
`registerUIItem` (:353, toolbar/pagebar only), `onMacroRendererSlotted` (:404), `checkSlotValid` (:669).
Host bindings: `api.cljs:480 get_external_plugin`, `:485 invoke_external_plugin_cmd` →
`handler/plugin.cljs:155 call-plugin-user-model!` / `:161 call-plugin-user-command!`.

- **(a) `invokeExternalPlugin` — RPC only, no UI.** Triggers another plugin's model/command
  (e.g. "open your panel"); returns undefined in practice; needs the other plugin's private keys.
- **(b) `{{renderer :xxx}}` of another plugin — not feasible in our container.** No API renders block
  content into a plugin-owned node; only reachable by having the host render the block elsewhere and
  re-parenting — collapses into (c) but worse (slot unmount force-cleans, slot ids churn).
- **(c) DOM re-parenting via `parent.document`/`top` — the real mechanism.** Three variants:
  1. **Re-parent another plugin's main-UI container** `#<pid>_lsp_main` into our `position:relative`
     pane; force `.visible` or invoke its model to show itself. **Chromium reloads a re-inserted
     `<iframe>`** — the plugin re-initializes (most tolerate it; move once at dock time). The owner's
     `setMainUIInlineStyle` can fight back — counter with `!important` rules keyed on `#<pid>_lsp_main`
     in our provideStyle (beats inline). Re-dock on `LSPluginCore` events (`registered`, `unregistered`,
     `reloaded`, `unlink-plugin`, `unloaded`, `ready`). One dock per plugin max.
  2. **Adopt another plugin's float UI** — `.lsp-ui-float-container[data-ref="<pid>"]` re-parented.
     **Cleanest**: pure DOM, no iframe reload, and the owner's subsequent `provideUI(key)` updates still
     land (lookup is by `#id`, document-wide). Strip `[draggable]`/inline `left/top` via our provideStyle.
  3. **Re-inject another plugin's toolbar/pagebar template** exactly as the host's `ui-item-renderer`
     (`plugins.cljs:1006-1025`) does:
     `top.LSPlugin.pluginHelpers.setupInjectedUI.call(top.LSPluginCore.registeredPlugins.get(pid), {slot: ourDivId, key, template}, {})`
     — `.call` with the other `PluginLocal` as `this` routes `data-on-click` to the owner. Enumerate via
     `App.getStateFromStore('plugin/installed-ui-items')` (state key `frontend/state.cljs:209`, shape
     `{pid [[type opts pid]…]}`). These are buttons, not panels — good for a chooser strip.
- **(d) `logseq.Experiments.ensureHostScope()`** is the officially-typed door to the host `window`
  (`top.LSPluginCore`, `top.LSPlugin.pluginHelpers`, `top.logseq.api.*`, `top.React`, `top.interact`,
  `top.__injectedUIEffects`). Caveat in the d.ts: plugins using these APIs are temporarily not accepted
  on the Marketplace. Host `exper_*` endpoints (api.cljs:921-951) offer nothing UI-docking.

### 4. Synapses' right-sidebar patterns to reuse

(Files: `packages/logseq-plugin/src/{sidebar,index,theme,popout}.ts`; doc: synapses CLAUDE.md.)
- `provideUI` is **fire-and-forget over postMessage** — poll for the injected node (50ms→500ms backoff,
  ~15s budget) before touching it (e.g. setting `iframe.src` via DOM).
- Keyed `provideStyle` with `:has()` ancestor chains defeats the inline-wrapper ~300px iframe fallback;
  never inline JS styles (wiped on re-render).
- `installDragPassthrough`: capture-phase `pointerdown` on `parent.document` sets `pointer-events:none`
  on our iframes during outside-started drags (mandatory next to any iframe adjacent to a divider or the
  host's `.left-sidebar-resizer`).
- **Store host-document teardown handles on `parent.document`** (e.g.
  `__dockDragPassthroughCleanup`), not module scope — plugin reload resets module scope but not the host
  document; otherwise observers/listeners stack per reload.
- Drive host UI by tabler icon class (`.ui__icon.ti.ls-icon-x` / `.ti.ti-x`), never localized
  `title`/text; always keep a fallback.
- `logseq.updateSettings` is fire-and-forget (~0.5–1s echo) — back settings-driven toggles with an
  in-memory override.
- Theme vars return raw token text (hsl/oklch/color-mix) — parse colors via a canvas probe.

### 5. Feasibility ranking (dock design)

**Tier 1 — the pane:** `provideUI({path: '#left-sidebar .left-sidebar-inner > .wrap', key, template})`
+ keyed provideStyle for ALL layout + our own MutationObserver re-assert loop. Split ratio persisted in
settings; written as a CSS var into the keyed style sheet (regenerable), never inline on host nodes.

**Tier 2 — filling the pane:** (1) own iframes; (2) adopt float `provideUI` containers; (3) re-parent
main-UI iframes (reload + style-fight caveats); (4) re-inject toolbar/pagebar items as a chooser strip.

**Tier 3 — not viable:** renderer macros in our container; `getExternalPlugin` as a view handle;
`registerUIItem` with a custom type (registers, renders nowhere — though the registry IS readable via
`getStateFromStore`, usable as a private handshake channel between cooperating plugins).
