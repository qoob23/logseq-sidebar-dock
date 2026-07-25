# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`logseq-sidebar-dock` — a **Logseq** plugin that restructures the **LEFT sidebar** into two vertical sections:
the default navigation on top, and a **dock pane** below hosting **two user-selectable plugin views**, with a
**user-adjustable vertical divider between those two hosted views**. Plain **TypeScript**. Target is the
**0.10.x Markdown/file graph**, NOT the DB version. The repo is **empty** — nothing below describes existing
code except where marked as such.

## Commands

> Tooling is **not scaffolded yet** — this is the intended setup (single package, no monorepo).

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
**`/Users/svetozar/personal/synapses/soft/og`** and is indexed in **codebase-memory-mcp as project
`synapses-og`**. Explore it through **codebase-memory-mcp first**, not grep.

Key files (under `src/main/frontend|logseq`):

- **`frontend/components/container.cljs`** — the **left sidebar** lives here (the container component); this is
  the primary read for this plugin.
- `logseq/api.cljs` — the plugin API surface (what's actually callable from `@logseq/libs`).
- `frontend/state.cljs` — app/sidebar/block state ops.
- `components/right_sidebar.cljs` — right-sidebar markup (useful as the sibling-pane reference).
- `modules/outliner/pipeline.cljs` — the hook pipeline (which txs reach plugins).

Grep `node_modules/@logseq/libs/dist/LSPlugin.d.ts` for exact SDK types instead of guessing the API — until
this repo is scaffolded there is no local copy, so read
**`/Users/svetozar/personal/synapses/node_modules/@logseq/libs/dist/LSPlugin.d.ts`**.

## Host gotchas

- **Target is 0.10.x Markdown/file graph, NOT the DB version** — different properties + datascript schema.
- **JS DOM mutations into host-rendered markup are wiped on re-render.** Persistent styling/layout must go
  through **keyed `logseq.provideStyle` CSS** (`:has()` tricks to reach host containers), never inline styles set
  from JS. Same reason the resizable divider should drive a CSS variable in a re-provided stylesheet rather than
  write sizes onto host nodes.
- **`logseq.updateSettings` is fire-and-forget** — local `logseq.settings` mutates only on the host's
  `settings:changed` echo (~0.5–1s), so a read right after a write is one stale frame. Back settings-driven
  state (selected views, divider position) with an in-memory override.
- **If a hosted view is an iframe: an iframe in an inline wrapper falls back to ~300px width**, ignoring
  `width:100%` — fix with persistent `:has()` CSS, not JS.
- **Driving host UI the plugin API doesn't expose** = reach into the host DOM (same-origin) and dispatch a real
  `.click()`. Match controls by **tabler icon class** (`.ui__icon.ti.ls-icon-x` / `.ti.ti-x`), NEVER by
  `title`/text — those are localized. Always keep a fallback for when the markup shifts.
