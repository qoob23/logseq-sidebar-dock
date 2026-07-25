# Sidebar Dock (`logseq-sidebar-dock`)

A Logseq **0.10.x** (Markdown/file graph) plugin that restructures the **left sidebar**: the default
navigation stays on top, and a **dock pane** below it hosts **two user-selectable plugin views** with a
**draggable divider** between them.

The dock adopts another plugin's main UI (`#<plugin-id>_lsp_main`) into a slot — the plugin keeps running,
it just renders inside the sidebar. Nothing is destroyed: on unload, or when you change the selection,
every adopted node is handed back to the host.

## Build

```bash
npm install
npm run build      # → dist/index.html + dist/assets/*  (npm run dev watches)
```

Other scripts: `npm run typecheck`, `npm run lint` (`lint:fix`), `npm test`.

## Load it in Logseq

1. **Build first** — the unpacked plugin loads `dist/`, not `src/` (`logseq.main` → `dist/index.html`).
2. Logseq → **Settings → Advanced → Developer mode** (enable).
3. Plugins → **Load unpacked plugin** → select the **plugin directory**, i.e. this repository root (the
   folder containing `package.json`) — *not* `dist/`.

> **Reload the plugin after every rebuild.** Toggle it off/on, or use the plugin card's **⟳ reload**
> control (shown for unpacked + enabled plugins). A stale bundle otherwise runs silently.

## Pick the two views

Plugins → **Sidebar Dock** → ⚙ **Settings**:

| Setting | Meaning |
|---|---|
| **Top view** | Plugin whose main UI is docked in the upper slot (`none` = empty). |
| **Bottom view** | Plugin whose main UI is docked in the lower slot (`none` = empty). |
| **Divider position (%)** | Share of the dock given to the top view (15–85). Dragging the divider writes this. |
| **Dock height (%)** | Share of the left sidebar column given to the whole dock (20–70). |

The dropdowns list every registered plugin and refresh themselves when plugins are installed, enabled,
disabled, or reloaded (reopen the settings pane to see the updated list). A docked plugin that reloads is
re-adopted automatically.

Notes:

- A plugin's main UI is a single DOM node, so the same plugin cannot fill both slots — the bottom slot
  falls back to a placeholder if you pick the same one twice.
- Plugins without an iframe main UI (shadow-mode plugins, or plugins that only add toolbar items) show a
  placeholder instead. Docking a plugin moves its iframe, which makes Chromium reload it once.
