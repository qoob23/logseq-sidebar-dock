# Sidebar Dock (`logseq-sidebar-dock`)

A Logseq **0.10.x** (Markdown/file graph) plugin that gives the **left sidebar** two faces, picked with a
segmented **Navigation / Plugins** control that sits in the app header, on the same row as the search
button:

- **Navigation** — the stock navigation, full height, exactly as Logseq ships it.
- **Plugins** — the stock navigation steps aside and a **dock** fills the whole sidebar, hosting **two
  user-selectable plugin views** with a **draggable divider** between them.

Switching faces is a stylesheet swap, so a docked view is only hidden, never unmounted — iframes keep
running (and keep their scroll position and state) while you are on the Navigation face.

## How a view gets into a slot

Two strategies, tried in order per plugin (the outcome is cached for the session and re-probed
whenever that plugin is installed, reloaded, enabled or disabled):

1. **Embed Protocol v1** (`docs/embed-protocol.md`) — we call the plugin's `embedMount` model and it
   injects its own view into our slot. Nothing is re-parented, so nothing reloads, and plugins whose
   view is not their main UI work too. Success is detected from the DOM (`data-embed-owner`), because
   the RPC has no reply channel.
2. **Main-UI adoption** — the legacy fallback: we re-parent `#<plugin-id>_lsp_main` into the slot.
   Chromium reloads a moved iframe, so the plugin reboots once. If its main UI is still empty after
   the reboot grace period, the slot shows a diagnosis over it (the view is left docked — moving it
   again would only cause another reload).

Nothing is destroyed: on unload, or when you change the selection, adopted nodes are handed back to the
host and providers get an `embedUnmount`.

**If the provider moves the view elsewhere** (its own sidebar or a popout — protocol providers with a
single-instance view are "last mount wins"), the slot shows *"View is open in another surface"* with a
**Reclaim** button. The dock never steals the view back on its own; clicking Reclaim does.

## Slot layout

The dock shows only the slots you configured:

| Top view | Bottom view | Dock |
|---|---|---|
| set | set | both slots, divider between them at **Divider position** |
| set | `none` | the top view fills the dock, no divider |
| `none` | set | the bottom view fills the dock, no divider |
| `none` | `none` | one slot with the "no view selected" hint |

**Divider position** is remembered while a single view fills the dock — it just does not apply, and
comes back as soon as both slots are configured again.

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

Click **Navigation** or **Plugins** in the segmented control in the header, next to the search button (it
is hidden while the left sidebar is closed — there is no face to switch then). The choice is persisted (it
survives restarts) and is also editable as the **Sidebar face** setting.

## Pick the two views

Plugins → **Sidebar Dock** → ⚙ **Settings**:

| Setting | Meaning |
|---|---|
| **Sidebar face** | `nav` or `views` — same thing the **Navigation** / **Plugins** control sets. |
| **Top view** | Plugin shown in the upper slot (`none` = unconfigured). |
| **Bottom view** | Plugin shown in the lower slot (`none` = unconfigured). |
| **Divider position (%)** | Share of the dock given to the top view (15–85), when both slots are configured. Dragging the divider writes this. |

The dropdowns list every registered plugin and refresh themselves when plugins are installed, enabled,
disabled, or reloaded (reopen the settings pane to see the updated list). A docked plugin that reloads is
re-mounted automatically.

Notes:

- A plugin's view is a single instance, so the same plugin cannot fill both slots — picking it twice
  leaves the bottom slot unconfigured.
- A plugin that supports neither the embed protocol nor main-UI adoption (shadow-mode plugins, or
  plugins that only add toolbar items) shows an explanatory placeholder.
