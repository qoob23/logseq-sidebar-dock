# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`logseq-sidebar-dock` — a **Logseq** plugin that gives the **LEFT sidebar** any number of faces, switched
by a tab strip: **`Nav`** (always present, fixed label — the stock navigation) plus one tab per
**user-defined layout**, each filling the sidebar with **any number of slots** holding plugin views or
renderer macros, separated by **user-adjustable dividers**. Layouts are configured **from the dock's own
UI** (see `docs/layout-config.md`). The sidebar's **width** is ours too — one global override past the
host's own 240–460px clamp, driven by hijacking the host's resizer. Plain **TypeScript**. Target is the
**0.10.x Markdown/file graph**, NOT the DB version.

**Two `provideUI` injections, two host subtrees.** The tab strip (`#<pid>--tabs`) lands in the app
header's left cell (`.cp__header > .l` — the row already carrying the sidebar toggle and the search
button), falling back to the top of the sidebar column when that cell cannot be resolved; the dock
(`#<pid>--dock`) is appended to the sidebar column. Each is health-checked and re-asserted on its own: a
header that has not rendered must never condemn a live dock to a re-injection that wipes every mounted
slot, and only the strip's check cares about placement.

## Source layout (implemented)

- `src/config.ts` — **pure** central model (`docs/layout-config.md`): layout/slot types, id generation,
  normalization, canonical serialization, parse-failure discrimination, slot resolution, and all eleven
  edit operations (add/remove/rename layout, add/remove/move slot, set source…) as pure config→config
  functions whose structural sharing is what keeps a surviving slot's id stable.
- `src/main.ts` — entry: settings schema (re-published on plugin-registry events), the `provideModel`
  handlers for every dock control, echo wiring, `beforeunload`.
- `src/dock.ts` — every host seam: both `provideUI` injections + their independent re-assertion (a
  misplaced container is force-cleaned AND removed by hand — `setupInjectedUI` never moves one),
  host-realm reconciliation of tabs/layouts/slots/dividers keyed by id, divider drag, capture-phase
  hijack of the host's sidebar resizer, drag passthrough, edit-mode controls, slot mounting (per-slot
  spec: macro conjuring, or embed protocol → main-UI adoption → placeholder; poke-then-adopt for lazy
  main UIs), host-document cleanup handle.
- `src/embed.ts` — **pure** Embed Protocol v1 host logic (see `docs/embed-protocol.md`): payloads,
  slot ids, wipe-vs-eviction discriminator, strategy cache, "is this main UI empty?" predicate.
- `src/macro.ts` — **pure** macro-slot logic: `{{renderer …}}` spec parsing, wrapper slot ids, the
  `macro-renderer-slotted` hook payload (emitted host-side via `LSPluginCore.hookApp`, mirroring the
  host's own `hook-ui-slot`).
- `src/styles.ts` — **pure** builder for the whole keyed `provideStyle` sheet: per-layout visibility and
  axis, per-slot weights, both tab-strip placements (emitted unconditionally — which row is in force is a
  host-DOM fact discovered at assert time), the sidebar-width `!important` rule, edit chrome, hosted-view
  `!important` overrides. Also the single definition of the strings most likely to drift — `DOCK_KEY`,
  `TABS_KEY`, `dockContainerId`/`tabsContainerId`, the `sdock-dragging`/`sdock-editing`
  /`sdock-slot-controls` state classes, `slotWeightVar`, `widthVarFallback`, `sheetMarker`. The structural
  `sdock-*` class names are still spelled independently on both sides; **any** such divergence
  typechecks, lints and tests clean and fails only in a live Logseq, so share a new one rather than
  adding a second literal.
- `src/settings.ts` / `src/divider.ts` — **pure** settings store (four flat keys; base + override layer
  masking the host's echo lag; `sidebarWidthPx` needs its own normalizer because its `0` "follow the
  host" sentinel sits OUTSIDE the valid range) and drag geometry: weight-based dividers plus the
  unclamped sidebar width. `src/logseq-types.ts` — typed model of the untyped host surfaces.

Everything pure is unit-tested in `src/__tests__/`; the host seams need a live Logseq.

## Commands

- **`npm run build`** — `vite` → `dist/` (must contain the `index.html` referenced by `logseq.main`).
  `npm run dev` watches; **reload the plugin after every rebuild** (see below).
- **`npm run typecheck`** — `tsc --noEmit` (strict; with `verbatimModuleSyntax` on, type-only imports must use
  `import { type X }`).
- **`npm test`** — vitest (single file `npx vitest run <file>`, or `-t "<substring>"`). Only the pure logic
  (divider geometry, dock state, settings parsing) is unit-testable — the host seams need a live Logseq.
- **`npm run lint`** (`lint:fix`) — type-aware ESLint (typescript-eslint `recommendedTypeChecked` via
  `projectService`). **Policy:** no-floating/misused-promises and the whole `any` cascade are ERROR; model
  `@logseq/libs` through a local `logseq-types.ts` instead of reaching for `any`.

## Loading & dev loop (no headless harness)

- **Logseq 0.10.x** → Settings → **Advanced** → enable **Developer mode** → **Load unpacked plugin** → select the
  **plugin directory** (`logseq.main` in `package.json` → `dist/index.html`).
- **Build first** — the unpacked plugin loads `dist/`, not `src/`.
- **RELOAD the plugin after every build** — toggle it off/on, or hit the plugin card's **⟳ reload** control
  (shown for unpacked+enabled plugins only). A stale bundle otherwise runs silently.

## Logseq host source & research

The **Logseq 0.10.x host source** (the `logseq/og` file-graph codebase — NOT `logseq/logseq`) is checked out at
**`~/soft/logseq/og`** (sibling of the main checkout; `../og` from it, but NOT from a worktree) and is
indexed in **codebase-memory-mcp as project `logseq-og`**. Explore it through **codebase-memory-mcp first**, not grep.

Key files (under `src/main/frontend|logseq`):

- **`frontend/components/container.cljs`** (+ `container.css`) — the **left sidebar** lives here (the container
  component), including `.left-sidebar-resizer`; this is the primary read for this plugin.
- `components/header.cljs` (+ `header.css`) — the app header, i.e. `.cp__header > .l`: the tab strip's home, its
  window drag region, and the `min-width: var(--ls-left-sidebar-width)` that forces the width rule's open gate.
- `logseq/api.cljs` — the plugin API surface (what's actually callable from `@logseq/libs`).
- `frontend/state.cljs` — app/sidebar/block state ops.
- `components/right_sidebar.cljs` — right-sidebar markup (useful as the sibling-pane reference).
- `modules/outliner/pipeline.cljs` — the hook pipeline (which txs reach plugins).

Grep **`node_modules/@logseq/libs/dist/LSPlugin.d.ts`** (this repo has its own copy) for exact SDK types
instead of guessing the API.

## Host gotchas

- **Target is 0.10.x Markdown/file graph, NOT the DB version** — different properties + datascript schema.
- **JS DOM mutations into host-rendered markup are wiped on re-render.** Persistent styling/layout must go
  through **keyed `logseq.provideStyle` CSS** (`:has()` tricks to reach host containers), never inline styles set
  from JS. Same reason the resizable divider should drive a CSS variable in a re-provided stylesheet rather than
  write sizes onto host nodes.
- **`logseq.updateSettings` is fire-and-forget** — local `logseq.settings` mutates only on the host's
  `settings:changed` echo (~0.5–1s), so a read right after a write is one stale frame. Back settings-driven
  state (active tab, slot weights, sidebar width) with an in-memory override — and never leave an override the
  echo can never agree with (a clamped-up or phantom value), since it masks every later hand edit of that key.
- **`provideUI` never MOVES an existing container** — `setupInjectedUI` only rewrites `#<id>`'s innerHTML. A
  container standing in the wrong host row must be `_forceCleanInjectedUI`'d **and then** removed by hand: that
  teardown targets the node's creation-time parent and its return value describes the call, not the node.
- **Beating the host at its own gesture**: the host's `--ls-left-sidebar-width` is a NON-important inline
  property on `<html>`, so an `!important` author rule in our keyed sheet outranks it and every consumer
  follows. Its resizer is an interact.js draggable bound on the *document* in the bubble phase, so a
  capture-phase listener on the handle itself pre-empts it (`stopImmediatePropagation` + `preventDefault`), and
  the compatibility `mousedown` has to be swallowed too. Listeners on host nodes outlive our module scope —
  put them in the host-cleanup handle, or a corpse's capture listener blocks the successor AND the host.
- **If a hosted view is an iframe: an iframe in an inline wrapper falls back to ~300px width**, ignoring
  `width:100%` — fix with persistent `:has()` CSS, not JS.
- **Driving host UI the plugin API doesn't expose** = reach into the host DOM (same-origin) and dispatch a real
  `.click()`. Match controls by **tabler icon class** (`.ui__icon.ti.ls-icon-x` / `.ti.ti-x`), NEVER by
  `title`/text — those are localized. Always keep a fallback for when the markup shifts.

## Work journal

- @WORKJOURNAL.md — dated build log. **Writing entries:** dense, one line per session (nested list only when
  needed; **no line > 120 chars**); capture changes + decisions, not behaviour-walkthroughs or code; omit
  state readable from code (paddings, counts) and process (worktrees, agents) but keep decisions even when
  they name a value/tool. **Write only on explicit request**; otherwise remind + print a work summary.
