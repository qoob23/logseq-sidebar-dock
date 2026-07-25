# Sidebar Dock (`logseq-sidebar-dock`)

A Logseq **0.10.x** (Markdown/file graph) plugin that gives the **left sidebar** as many faces as you
want, picked from a tab strip that sits in the app header, on the same row as the search button:

- **Nav** — the stock navigation, full height, exactly as Logseq ships it. Always the first tab.
- **your layouts** — one tab each: the stock navigation steps aside and a **dock** fills the whole
  sidebar with that layout's **slots**, stacked in a column or laid out in a row, with a **draggable
  divider** between neighbours. Every slot holds a plugin view, a renderer macro, or nothing yet.

Layouts are built from the dock's own UI — a gear in the tab strip, no JSON editing — and the sidebar
itself can be dragged wider than Logseq's own limit allows.

Switching tabs is a stylesheet swap, so a docked view is only hidden, never unmounted — iframes keep
running (and keep their scroll position and state) while you are on another tab.

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

A slot can hold a **renderer macro** instead of a plugin view: give it something like
`{{renderer :my-macro, arg}}` and the dock asks the plugins the same way Logseq's own macro blocks do,
so whichever plugin answers renders into the slot. Nothing answers → the slot says so.

## Layouts and slots

A **layout** is a name (up to 12 characters — it is a tab label), an axis, and an ordered list of slots.
Add as many layouts as you like, up to 12 slots each; an unconfigured slot is a visible, clickable box
with a "pick a view" hint rather than nothing at all.

Slots are sized by **weight**, not percentages: dragging a divider moves weight between the two slots it
sits between and leaves every other slot exactly where it was, so adding or removing a slot never
reshuffles the sizes you already picked.

A layout's slots are filled the first time you open its tab and stay mounted for the rest of the
session — a graph full of layouts does not boot every docked plugin at startup.

The same plugin may appear in more than one layout, but most plugin views are a single instance:
switching between two tabs that both want it hands it over, which reloads it. The slot's editor says so.

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

## Switch tabs

Click a tab in the strip in the app header, next to the search button (it hides itself while the left
sidebar is closed — there is no face to switch then; and if that row cannot be found it falls back to the
top of the sidebar). The choice is persisted (it survives restarts) and is also editable as the **Active
tab** setting.

## Edit layouts

The two icon buttons at the end of the tab strip work whether or not you are editing: **+** adds a layout
and switches to it, **⚙** turns edit mode on and off. Adding a layout or a slot turns edit mode on by
itself — a tab or a slot you cannot immediately fill would be a dead end.

In edit mode the active layout gets a control bar under the tabs, and every slot gets a small panel over
its top edge:

| Control | What it does |
|---|---|
| name field | Renames the layout — that is its tab label. Commits on Enter or when it loses focus. |
| **↔** / **↕** | Flips the layout between a column of slots and a row. |
| **+ slot** | Appends a slot to the layout. |
| **Drop tab** | Removes the whole layout. |
| slot picker | `— none —`, any installed plugin, or `macro…`, which reveals a text field for the macro. |
| **↑ ↓** (**← →** in a row layout) | Moves the slot along the layout. |
| **✕** | Removes the slot. |

Removing something that holds a view asks first: the button relabels itself **Sure?** and a second click
within a few seconds does it. Removing an empty slot or an empty layout is a single click.

The plugin list refreshes itself when plugins are installed, enabled, disabled or reloaded, and a plugin
you configured stays in the list even while it is disabled, so its slot never silently reads as
`— none —`. A docked plugin that reloads is re-mounted automatically.

## Resize the sidebar

Drag the left sidebar's edge as usual — the dock takes the gesture over and ignores Logseq's own 460px
ceiling, so two plugin views can have a column wide enough to be readable. The width is one value for
every tab, Nav included (the dock's width *is* the sidebar's, so switching tabs never re-lays-out the
page behind it), and it never grows past the window minus 200px, so the drag handle stays reachable on a
smaller screen than the one you set it on.

## Settings

Plugins → **Sidebar Dock** → ⚙ **Settings** is the escape hatch, not the main editor:

| Setting | Meaning |
|---|---|
| **Layouts (raw JSON)** | The whole configuration — every tab, slot and weight. There to be read, copied between graphs, or repaired by hand. While the text does not parse the dock keeps showing the last version that did and refuses every edit, so a typo cannot cost you the configuration. |
| **Poke before docking** | For plugins that only build their view once toggled: `plugin-id = models.key; other-id = commands.key`. The listed model or command is invoked to coax the plugin into rendering, at most once every few seconds per plugin. |
| **Active tab** | `nav` or a layout id — the same thing the tab strip sets. |
| **Sidebar width (px)** | 180–1600, or `0` to follow Logseq's own width. Dragging the sidebar edge writes this. |

Notes:

- A plugin that supports neither the embed protocol nor main-UI adoption (shadow-mode plugins, or
  plugins that only add toolbar items) shows an explanatory placeholder.
