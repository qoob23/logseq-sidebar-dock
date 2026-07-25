# Sidebar Dock (`logseq-sidebar-dock`)

A Logseq **0.10.x** (Markdown/file graph) plugin that gives the **left sidebar** two faces, picked with a
segmented **Nav / Views** control pinned at the top of the sidebar:

- **Nav** — the stock navigation, full height, exactly as Logseq ships it.
- **Views** — the stock navigation steps aside and a **dock** fills the whole sidebar, hosting **two
  user-selectable plugin views** with a **draggable divider** between them.

Switching faces is a stylesheet swap, so a docked view is only hidden, never unmounted — iframes keep
running (and keep their scroll position and state) while you are on the Nav face.

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

## Switch faces

Click **Nav** or **Views** in the segmented control at the top of the left sidebar. The choice is
persisted (it survives restarts) and is also editable as the **Sidebar face** setting.

## Pick the two views

Plugins → **Sidebar Dock** → ⚙ **Settings**:

| Setting | Meaning |
|---|---|
| **Sidebar face** | `nav` or `views` — same thing the segmented control sets. |
| **Top view** | Plugin whose main UI is docked in the upper slot (`none` = empty). |
| **Bottom view** | Plugin whose main UI is docked in the lower slot (`none` = empty). |
| **Divider position (%)** | Share of the dock given to the top view (15–85). Dragging the divider writes this. |

The dropdowns list every registered plugin and refresh themselves when plugins are installed, enabled,
disabled, or reloaded (reopen the settings pane to see the updated list). A docked plugin that reloads is
re-adopted automatically.

Notes:

- A plugin's main UI is a single DOM node, so the same plugin cannot fill both slots — the bottom slot
  falls back to a placeholder if you pick the same one twice.
- Plugins without an iframe main UI (shadow-mode plugins, or plugins that only add toolbar items) show a
  placeholder instead. Docking a plugin moves its iframe, which makes Chromium reload it once.
