/**
 * Pure stylesheet builder for the keyed `logseq.provideStyle` sheet.
 *
 * Everything persistent lives here: the host wipes inline styles written onto its own nodes on every
 * React re-render, while the injected `<style data-injected-style=...>` element survives until unload.
 * That includes the tab switch — every layout's DOM stays mounted at all times and only the active one
 * is `display: flex`, so flipping tabs is a re-provide of this sheet and nothing ever unmounts (a
 * hidden docked iframe keeps running; detaching it would make Chromium reboot it).
 *
 * The layout geometry is weights, not percentages: each slot is `flex-grow: var(--sdock-w-<slotId>,
 * <baked weight>)` over `flex-basis: 0`. That indirection is what makes a live drag possible — the drag
 * writes the custom property inline on our own layout root (the one inline style the host gotchas
 * allow, because the node is ours), the settings write bakes the new weights into this sheet, and the
 * inline vars are dropped once {@link sheetMarker} proves the new sheet has landed.
 */

import { type ResolvedSlot, type SlotAxis } from './config'
// The per-slot floor and the viewport reserve belong to the drag geometry that has to honour them;
// this sheet only emits them.
import { SLOT_MIN_PX, VIEWPORT_RESERVE_PX } from './divider'

/** One layout as the stylesheet (and the dock's DOM reconciler) needs to see it. */
export interface ResolvedLayout {
  /** Layout id — the `data-layout` attribute of its root and the `data-tab` of its tab. */
  id: string
  axis: SlotAxis
  slots: readonly ResolvedSlot[]
}

export interface DockCssOptions {
  /** Our plugin id — the injected container is `#` + {@link dockContainerId}. */
  pluginId: string
  /** `'nav'` (or anything not naming a layout below) shows the stock navigation. */
  activeTab: string
  /** Every configured layout, in tab order. All of them get rules; one of them is visible. */
  layouts: readonly ResolvedLayout[]
  /**
   * Sidebar width (px) to force on EVERY tab, nav included; `0` leaves the host's own width alone.
   * Global rather than per layout: the dock's width is the sidebar's width, so one remembered value is
   * what keeps a tab flip from relayouting the main content behind it.
   */
  sidebarWidthPx: number
}

/** Thickness of a divider along the layout axis (its `flex-basis`). */
const DIVIDER_PX = 6

/* ------------------------------------------------------------------ names both sides must spell alike
 *
 * A selector in this sheet and a DOM write in `dock.ts` — or the `provideUI` path it injects into — are
 * the two halves of every one of these, with nothing in between that could notice them drifting apart:
 * renaming a class on one side while the other kept the old spelling typechecks, lints and passes every
 * test, and then fails only in a live Logseq — as sizing that stops applying, a nav face that will not
 * hide, a drag the iframes swallow, an edit chrome that never appears, or a tab strip whose buttons drag
 * the whole window.
 *
 * They live HERE, next to the rules that consume them, because `dock.ts` already imports this module
 * (for {@link buildDockCss}, {@link sheetMarker} and {@link slotWeightVar}); defining them there and
 * importing back would be an import cycle. Same reason, same shape as `SLOT_MIN_PX` in `divider.ts`.
 */

/**
 * `provideUI` key. The host derives the injected container's id from it ({@link dockContainerId}), and
 * looks the key up with an UNQUOTED attribute selector — bare CSS ident only.
 */
export const DOCK_KEY = 'dock'
/**
 * `provideUI` key of the tab strip — a SECOND, independent injection, so the strip can ride in the app
 * header's left cell while the dock stays in the sidebar column. Two host subtrees, two containers, two
 * health checks (`dock.ts`). Same constraint as {@link DOCK_KEY}: bare CSS ident only.
 */
export const TABS_KEY = 'tabs'
/**
 * The host row the tab strip belongs in: the app header's left cell, the one that already carries the
 * sidebar toggle and the search button.
 *
 * `dock.ts` hands this to `provideUI` as the injection `path` and this sheet spells it again in the
 * placement rule ({@link tabsPlacementRules}) — two halves of one placement, so it is one string. Drift
 * injects the strip into one row while the sheet styles the other: no flex line, the header's outsized
 * font-size left standing, and — the one that is not cosmetic — no `-webkit-app-region: no-drag`, so a
 * pointerdown anywhere on the strip starts a WINDOW DRAG instead of clicking a tab.
 *
 * Only the preferred row is shared. The fallback (the sidebar column) is deliberately NOT: `dock.ts`
 * injects into the dock's own append point, while the rule below matches the looser `#left-sidebar
 * <container>` — the strip has to stay styled wherever in that column it ends up.
 */
export const TABS_PATH = '.cp__header > .l'
/**
 * Toggled on our own container for the duration of any drag started outside the docked views. The
 * pointer-events passthrough this sheet emits is gated on it.
 */
export const DRAGGING_CLASS = 'sdock-dragging'
/**
 * Toggled on BOTH our containers by the gear; every edit-mode rule in this sheet is gated on it. Both,
 * because the gear that flips it now stands in the header strip while the controls it reveals — the
 * editbar and the per-slot panels — live in the dock container, and a class only reaches its own
 * subtree.
 */
export const EDITING_CLASS = 'sdock-editing'
/** The per-slot edit panel — our own node, but one that slot-clearing has to spare. */
export const CONTROLS_CLASS = 'sdock-slot-controls'

/**
 * DOM id of the injected dock container, as the host builds it from the `provideUI` key. Spelled once
 * because the dock looks the element up by this id and the sheet targets it with `#…`.
 */
export function dockContainerId(pluginId: string): string {
  return `${pluginId}--${DOCK_KEY}`
}

/** DOM id of the injected tab-strip container. Same dual role as {@link dockContainerId}. */
export function tabsContainerId(pluginId: string): string {
  return `${pluginId}--${TABS_KEY}`
}

/**
 * The custom property one slot's `flex-grow` reads.
 *
 * Exported because the divider drag sets it inline on the layout root for the duration of the drag —
 * both sides must spell it identically. Slot ids are `s_` + 6 hex digits (`normalizeConfig` regenerates
 * anything else precisely because ids reach CSS unescaped), so no escaping is needed here.
 */
export function slotWeightVar(slotId: string): string {
  return `--sdock-w-${slotId}`
}

/**
 * Transient inline override of the sidebar width.
 *
 * Same dual role as {@link slotWeightVar}, and the same reason it is defined here: the width drag sets
 * this property inline on `<html>` for the duration of the gesture, and the `!important` rule this
 * sheet emits reads it ({@link widthVarFallback}) with the baked width as its fallback. Drift is
 * silent and half-broken rather than broken — the rule keeps reading a property nobody writes, so the
 * sidebar stops tracking the pointer mid-drag and only jumps to the final width once the re-provided
 * sheet lands.
 *
 * Distinct from the `--sdock-w-<slotId>` family despite the near-miss prefix: this one lives on
 * `<html>`, those live on our own layout roots, and nothing ever scans for both at once.
 */
export const WIDTH_VAR = '--sdock-width'

/**
 * The `var()` reference the sidebar-width override is built from — {@link WIDTH_VAR} over the baked
 * width, so a drag in flight wins and a dropped inline value falls back to what the sheet says.
 */
export function widthVarFallback(px: number): string {
  return `var(${WIDTH_VAR}, ${formatWidth(px)}px)`
}

/** Non-finite would substitute into `flex-grow` as an invalid value, collapsing the slot to zero. */
function formatWeight(weight: number): string {
  return Number.isFinite(weight) ? String(weight) : '1'
}

/** Non-finite reaches both a `min()` argument and the marker comment; treat it as "no override". */
function formatWidth(px: number): string {
  return Number.isFinite(px) ? String(px) : '0'
}

/**
 * `activeTab` is free text out of the settings (the host echoes back whatever is in the JSON), and it
 * reaches both a CSS comment and an attribute selector here. A comment terminator would close the
 * marker comment and truncate the rest of the sheet; a quote would break the selector. Legitimate
 * values are `nav` and `l_<hex>`, so stripping to ident characters loses nothing and a garbage tab
 * simply matches nothing.
 */
function safeTabToken(activeTab: string): string {
  return activeTab.replace(/[^a-zA-Z0-9_-]/g, '')
}

/**
 * The marker line the sheet carries, and the exact text the dock polls the host document for.
 *
 * `provideStyle` is fire-and-forget over postMessage, so the dock has no completion signal: it drops
 * the inline overrides a drag left behind — `--sdock-w-*` on a layout root, {@link WIDTH_VAR} on `<html>`
 * — only once a `<style>` element containing THIS string has appeared. It therefore has to encode
 * everything a re-provide could have changed about the geometry — which tab is active, which slots
 * exist, their axis, their baked weights AND the baked sidebar width — or the dock would mistake the
 * previous sheet for the new one and snap the drag back for one frame. The width is in here rather than
 * probed separately precisely because it can be the ONLY thing that changed: a resize of the sidebar
 * leaves every weight exactly where it was.
 *
 * Both sides must agree on the exact text, hence one function rather than two format strings.
 */
export function sheetMarker(
  activeTab: string,
  layouts: readonly ResolvedLayout[],
  sidebarWidthPx: number,
): string {
  const parts = layouts.map((layout) => {
    const slots = layout.slots.map((slot) => `${slot.id}=${formatWeight(slot.weight)}`).join(',')
    return `${layout.id}:${layout.axis === 'row' ? 'r' : 'c'} ${slots}`
  })
  return `/* sdock-sig tab=${safeTabToken(activeTab)} w=${formatWidth(sidebarWidthPx)} | ${parts.join(' | ')} */`
}

/**
 * Escape a plugin id for use inside a CSS id selector.
 *
 * A leading digit cannot be backslash-escaped literally — CSS needs the hex form (`\32 ` for `2`,
 * with the terminating space) or the whole selector is invalid and the rule block is dropped.
 */
function escapeIdent(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`).replace(/^[0-9]/, (digit) => `\\3${digit} `)
}

/** Rules that make one adopted `#<pid>_lsp_main` container behave like a docked pane. */
function hostedViewRules(pid: string): string {
  const sel = `.sdock-slot #${escapeIdent(pid)}_lsp_main`
  return `
${sel} {
  position: relative !important;
  inset: auto !important;
  top: auto !important;
  left: auto !important;
  right: auto !important;
  bottom: auto !important;
  margin: 0 !important;
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  max-height: none !important;
  visibility: visible !important;
  display: block !important;
  opacity: 1 !important;
  z-index: 1 !important;
  pointer-events: auto !important;
}

/* The adopted container's own iframe: inside an inline wrapper it otherwise falls back to ~300px.
   Scoped to the adopted container on purpose — geometry inside a provider's [data-embed-owner]
   subtree is the provider's business (protocol host rule 6). */
${sel} iframe {
  position: absolute;
  inset: 0;
  width: 100% !important;
  height: 100% !important;
  border: 0;
}

/* Drag passthrough: an outside-started drag must not be swallowed by the docked iframe. */
.${DRAGGING_CLASS} ${sel} {
  pointer-events: none !important;
}`
}

/**
 * The nav/layout switch. Both faces stay mounted at all times — `display: none` keeps a docked plugin's
 * iframe alive, whereas removing it from the DOM would make Chromium reload it.
 */
function faceRules(dockId: string, hasActiveLayout: boolean): string {
  if (!hasActiveLayout) {
    return `/* nav face: the stock navigation owns the column and the dock leaves it entirely — the tab strip
   that used to keep the container on screen is its own injection in the header row now. Hidden is
   still not unmounted: every docked iframe inside keeps running and keeps its state.
   The carve-out is the parse-error diagnostic. While the stored JSON does not parse every edit is
   refused, and the tab a user would have to flip to in order to read WHY is itself named by that
   broken configuration — so the one child worth keeping on screen keeps its container on screen with
   it. As a selector rather than a build-time flag, so the error state never becomes an input to this
   sheet (it would then have to be re-provided on every parse transition). */
${dockId}:not(:has(.sdock-config-error)) {
  display: none;
}

/* The two rules below look superseded by the one above and are not: they are what the carve-out state
   looks like. A container kept on screen for the diagnostic must show the diagnostic and NOTHING else
   — the layout roots and the editbar belong to a face the user is not on — and it must claim only the
   room that message needs, instead of the whole column the layout face gives it. */
${dockId} {
  flex: 0 0 auto;
}

${dockId} .sdock-layouts,
${dockId} .sdock-editbar {
  display: none;
}`
  }

  return `/* layout face: the dock takes the whole column and the stock navigation steps aside. */
${dockId} {
  flex: 1 1 auto;
  min-height: 0;
}

#left-sidebar .left-sidebar-inner > .wrap > nav.cp__menubar-repos,
#left-sidebar .left-sidebar-inner > .wrap > .nav-contents-container,
#left-sidebar .left-sidebar-inner > .wrap > footer.create {
  display: none !important;
}`
}

/**
 * Where the tab strip's own injected container sits — in BOTH the rows it can land in.
 *
 * Its home is the app header's left cell, the row that already carries the sidebar toggle and the
 * search button; it falls back to the top of the sidebar column when that cell cannot be resolved, so a
 * renamed host cell degrades the placement instead of losing the strip altogether (`dock.ts`). Both
 * placements are emitted unconditionally: which one is in force is a fact about the host DOM that the
 * dock discovers at assert time, not an input to this sheet, and a strip that has just been moved from
 * one row to the other must not have to wait for a re-provide to be styled for its new home.
 */
function tabsPlacementRules(tabsId: string): string {
  return `/* The strip rides in a host row it does not own, so it has to sit in that row's flex line, opt out
   of the window drag region the header sets on ITSELF (the host exempts only a/svg/button, and a
   pointerdown that starts a window drag never reaches our buttons), and ignore the outsized
   font-size the header applies to its own children. */
${tabsId} {
  display: flex;
  align-items: center;
  min-width: 0;
  font-size: 12px;
  -webkit-app-region: no-drag;
}

${TABS_PATH} > ${tabsId} {
  /* Basis 0: take the room the header cell has left over rather than widening the cell — that cell's
     width is the sidebar's, and growing it would push the search button across the header. */
  flex: 1 1 0;
  padding: 0 8px 0 6px;
}

/* Fallback placement: the top of our own column. Order -2 puts it above the dock container's -1 —
   both are appended last, after footer.create. */
#left-sidebar ${tabsId} {
  order: -2;
  flex: 0 0 auto;
  padding: 2px 8px 6px;
}

/* Wrapping is placement-dependent. In a column the strip may wrap to more rows rather than overflow
   — there is no menu to hide tabs behind and the sidebar can be narrow — but in the header row an
   extra row would grow the app header itself, so there the tabs shrink and ellipsize instead (see
   .sdock-tab). */
#left-sidebar ${tabsId} .sdock-tabs {
  flex-wrap: wrap;
}

/* It switches the LEFT SIDEBAR's face; with the sidebar closed there is no face to switch. */
main:not(.ls-left-sidebar-open) ${tabsId} {
  display: none;
}`
}

/**
 * The sidebar-width override — tab-independent, unlike everything in {@link faceRules}.
 *
 * Zero (the settings module's `WIDTH_FOLLOW_HOST`) means "no override": the sheet then says nothing
 * about the width at all, and the marker simply carries `w=0`.
 */
function widthRules(sidebarWidthPx: number): string {
  if (!Number.isFinite(sidebarWidthPx) || sidebarWidthPx <= 0) return ''

  return `

/* The sidebar is widened past the limit the host imposes on ITSELF: its resizer clamps to 240-460px
   and writes the result as an INLINE custom property on <html>. An !important author declaration
   outranks a non-important inline one — that is the entire mechanism — and since every downstream
   rule (#left-sidebar's width, main's padding-left, the header cell's min-width) reads this one var,
   the whole layout follows coherently.
   Unconditional across every tab on purpose: the dock width IS the sidebar width, so there is one
   remembered value and flipping to another tab (or back to the stock navigation) never relayouts the
   main content behind it. It also supersedes the host's own resizer outright instead of half-masking
   it — left live on the Nav tab, that resizer could only write a clamped value this very rule masks.
   Gated on the sidebar being OPEN, because not every downstream rule is: main's padding-left is
   scoped to .is-left-sidebar-open, but the header's left cell takes
   \`min-width: var(--ls-left-sidebar-width)\` unconditionally (header.css). Ungated, a closed
   sidebar would still reserve our widened value in that cell and shove the search button and
   everything right of it across the header — room held for a column nothing is showing.
   Capped to the viewport reserve, mirroring the drag-time clamp in divider.ts: a width persisted on a
   wide monitor must never swallow a narrower window later — the handle to drag it back would itself
   sit past the viewport edge, and with the override on every tab there is no tab left to escape to. */
html:has(main.ls-left-sidebar-open) {
  --ls-left-sidebar-width: min(${widthVarFallback(sidebarWidthPx)}, calc(100vw - ${VIEWPORT_RESERVE_PX}px)) !important;
}`
}

/**
 * Axis, visibility and per-slot growth for one layout.
 *
 * The per-slot selector is qualified by the layout root even though slot ids are unique across the
 * whole configuration: it keeps the `--sdock-w-*` scope legible (the drag sets the var on that root)
 * and a leftover same-id node from a crashed life outside the tree cannot pick the rule up.
 */
function layoutRules(layout: ResolvedLayout, active: boolean): string {
  const root = `.sdock-layout[data-layout='${layout.id}']`
  const row = layout.axis === 'row'
  // Only the axis direction gets a floor; the cross axis stays at the generic `min-*: 0` so a slot can
  // always be narrower than its content instead of forcing the sidebar to scroll.
  const floor = row ? 'min-width' : 'min-height'

  const slots = layout.slots.map(
    (slot) => `${root} > .sdock-slot[data-slot-id='${slot.id}'] {
  flex-grow: var(${slotWeightVar(slot.id)}, ${formatWeight(slot.weight)});
  ${floor}: ${SLOT_MIN_PX}px;
}`,
  )

  // A row layout's dividers move horizontally; `flex-basis` already means width in a row container.
  if (row) {
    slots.push(`${root} > .sdock-divider {
  cursor: col-resize;
}`)
  }

  return `/* ${layout.id}${active ? ' (active)' : ''} */
${root} {
  flex-direction: ${row ? 'row' : 'column'};${active ? '\n  display: flex;' : ''}
}

${slots.join('\n\n')}`
}

/** The complete stylesheet for the keyed `provideStyle` sheet. */
export function buildDockCss(opts: DockCssOptions): string {
  const dockId = `#${escapeIdent(dockContainerId(opts.pluginId))}`
  const tabsId = `#${escapeIdent(tabsContainerId(opts.pluginId))}`
  const active = opts.layouts.find((layout) => layout.id === opts.activeTab) ?? null

  // Every layout's DOM exists at all times, so a hosted pid needs its `!important` cage whether or not
  // its layout is the visible one. Only an adopted plugin main UI needs it — a macro renders into our
  // own wrapper. Sorted so the sheet text is a function of the configuration alone.
  const pids = new Set(
    opts.layouts.flatMap((layout) =>
      layout.slots.flatMap((slot) => (slot.spec.kind === 'plugin' ? [slot.spec.pid] : [])),
    ),
  )
  const hosted = [...pids].sort().map(hostedViewRules).join('\n')
  const layouts = opts.layouts.map((layout) => layoutRules(layout, layout.id === active?.id)).join('\n\n')

  return `/* logseq-sidebar-dock — generated, do not edit by hand */
${sheetMarker(opts.activeTab, opts.layouts, opts.sidebarWidthPx)}

/* The host gives .nav-contents-container the whole (fixed height) column; hand the leftover to us. */
#left-sidebar .left-sidebar-inner > .wrap .nav-contents-container {
  height: auto !important;
  flex: 1 1 auto !important;
  min-height: 0;
}

${dockId} {
  /* We are appended last (after footer.create) but belong at the top of the column. */
  order: -1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}${widthRules(opts.sidebarWidthPx)}

${faceRules(dockId, active !== null)}

${tabsPlacementRules(tabsId)}

/* Tab strip: rounded track, active tab raised as a chip. It fills whichever container it was injected
   into, and the spacing around it is that container's padding — the two placements want different
   ones (see tabsPlacementRules), and a margin here would have to be undone in one of them. */
.sdock-tabs {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--ls-border-radius-medium, 8px);
  background: var(--ls-tertiary-background-color, rgba(127, 127, 127, 0.14));
}

.sdock-tab,
.sdock-tab-btn {
  /* Content-sized but shrinkable, NOT an equal share: with a resizable sidebar \`flex: 1 1 0\` stretches
     two tabs to absurd widths, and once the strip wraps an equal share is meaningless anyway. The
     shrink half is what the header placement needs — that row is only as wide as the user's sidebar
     and cannot wrap, so the tabs give up width and ellipsize (below) rather than spill over the
     search button. */
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  padding: 3px 6px;
  border: 0;
  border-radius: calc(var(--ls-border-radius-medium, 8px) - 2px);
  background: transparent;
  color: var(--ls-secondary-text-color, inherit);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  user-select: none;
  opacity: 0.75;
  transition: background 0.15s ease, opacity 0.15s ease;
}

/* The two icon buttons are not tabs, and the shrink half above is wrong for them. A tab that gives up
   width ellipsizes and stays readable; a one-glyph button that gives up width is clipped to nothing by
   the same \`overflow: hidden\` — and these two are the ONLY way into edit mode and, with no layouts
   configured, the only way to a first tab, so losing them in a narrow header row loses every edit
   control in the dock with them. They keep their width; the tabs beside them give up theirs. */
.sdock-tab-btn {
  flex: 0 0 auto;
}

.sdock-tab:hover,
.sdock-tab-btn:hover {
  opacity: 1;
}

.sdock-tab[data-tab='${safeTabToken(opts.activeTab)}'],
.${EDITING_CLASS} .sdock-gear {
  background: var(--ls-secondary-background-color, rgba(255, 255, 255, 0.9));
  color: var(--ls-primary-text-color, inherit);
  opacity: 1;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16);
}

/* Layout-level edit controls (rename, axis, add slot, drop layout) for the ACTIVE layout only. They
   live here, between the strip and the layout roots, rather than inside .sdock-layout: that element's
   flex-direction is the user's axis, so a control row placed inside a row layout would be laid out as
   another column beside the slots. */
.sdock-editbar {
  display: none;
}

.${EDITING_CLASS} .sdock-editbar {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 0 8px 6px;
}

/* Holds every layout root; only the active one is displayed, so its own axis governs from there down. */
.sdock-layouts {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
}

.sdock-layout {
  /* Hidden by default: exactly one layout gets \`display: flex\` back, from its own rule below. */
  display: none;
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
}

.sdock-slot {
  /* flex-basis 0 so the weights alone decide the split; the axis floor comes from the per-slot rule. */
  flex-basis: 0;
  flex-shrink: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

/* Neutral-environment guarantee (protocol host rule 6): the Logseq app styles bare iframes —
   \`iframe { width: 100%; margin: 1rem 0 }\` in common.css — and that 1rem top margin shifts a
   provider's 100%-height frame down and clips its bottom against the slot's overflow. Undoing the
   app's own bleed inside our slots is host hygiene, not restyling the provider: :where() keeps this
   at bare .sdock-slot specificity, so ANY scoped rule a provider writes (class, attribute) wins and
   a provider that wants margins keeps them. */
.sdock-slot :where(iframe) {
  margin: 0;
}

${layouts}

/* Macro slot: our own wrapper owns the slot box, and the responding plugin's injected UI — appended
   into it by the host's setupInjectedUI — is laid out inside. Macros are content of unknown height,
   so this is the one scrolling surface in the dock. */
.sdock-slot .sdock-macro {
  position: absolute;
  inset: 0;
  overflow-y: auto;
}

.sdock-macro [data-injected-ui] {
  width: 100%;
}

/* Same ~300px inline-wrapper fallback an adopted iframe hits; the drag passthrough below already
   covers these iframes too, since the wrapper sits inside .sdock-slot. */
.sdock-macro iframe {
  width: 100% !important;
  border: 0;
}

/* Set while a drag started outside the docked views is in flight (our divider, the host's resizer,
   anything else): the iframes must not eat the pointer stream mid-drag. This one deliberately reaches
   into provider subtrees too — a transient pointer-events suspension is the only way the host's own
   divider can work next to any iframe, and it changes nothing about how the view renders. */
.${DRAGGING_CLASS} .sdock-slot iframe {
  pointer-events: none !important;
}

.sdock-divider {
  flex: 0 0 ${DIVIDER_PX}px;
  cursor: row-resize;
  position: relative;
  background: var(--ls-border-color, rgba(127, 127, 127, 0.3));
  touch-action: none;
  transition: background 0.15s ease;
}

.sdock-divider:hover,
.sdock-divider.is-dragging {
  background: var(--ls-active-primary-color, var(--ls-link-text-color, #5b8ff9));
}

.sdock-placeholder,
.sdock-overlay {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  padding: 0 12px;
  text-align: center;
  font-size: 11px;
  line-height: 1.4;
  color: var(--ls-secondary-text-color, var(--ls-primary-text-color, inherit));
  user-select: none;
}

.sdock-placeholder {
  opacity: 0.6;
}

/* Diagnosis laid OVER an adopted view: undocking it to say this would only reload it again. */
.sdock-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: var(--ls-secondary-background-color, rgba(127, 127, 127, 0.12));
  opacity: 0.95;
}

.sdock-action {
  padding: 3px 10px;
  border: 0;
  border-radius: calc(var(--ls-border-radius-medium, 8px) - 2px);
  background: var(--ls-tertiary-background-color, rgba(127, 127, 127, 0.18));
  color: var(--ls-primary-text-color, inherit);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.sdock-action:hover {
  background: var(--ls-quaternary-background-color, rgba(127, 127, 127, 0.28));
}

/* --- Edit mode ------------------------------------------------------------------------------------
   Gated on the editing class on our container, so toggling the mode is a class flip and never a
   re-provide of this sheet. */

.${CONTROLS_CLASS} {
  display: none;
}

/* Laid OVER the top of the slot instead of inside its flow: an in-flow control row would change every
   mounted view's height the moment edit mode is entered or left, and re-laying out a provider iframe is
   exactly what the dock exists to avoid. z-index clears .sdock-overlay (2) so a diagnosed slot stays
   editable. */
.${EDITING_CLASS} .${CONTROLS_CLASS} {
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: absolute;
  inset: 0 0 auto 0;
  z-index: 3;
  padding: 4px;
  background: var(--ls-secondary-background-color, rgba(127, 127, 127, 0.92));
  border-bottom: 1px solid var(--ls-border-color, rgba(127, 127, 127, 0.3));
}

/* Slot boundaries are invisible while a view fills them, and an empty slot is the thing you have to
   aim at to fill it. */
.${EDITING_CLASS} .sdock-slot {
  outline: 1px dashed var(--ls-border-color, rgba(127, 127, 127, 0.45));
  outline-offset: -1px;
}

/* A narrow sidebar column is the design constraint: controls stack full-width, and the only row is the
   strip of icon-sized buttons. */
.sdock-select,
.sdock-input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 2px 4px;
  border: 1px solid var(--ls-border-color, rgba(127, 127, 127, 0.35));
  border-radius: 4px;
  background: var(--ls-primary-background-color, transparent);
  color: var(--ls-primary-text-color, inherit);
  font: inherit;
  font-size: 11px;
  line-height: 16px;
}

.sdock-select:focus,
.sdock-input:focus {
  outline: 1px solid var(--ls-active-primary-color, var(--ls-link-text-color, #5b8ff9));
  outline-offset: -1px;
}

/* In the editbar the name field shares its row with the buttons instead of owning one. */
.sdock-editbar .sdock-input {
  flex: 1 1 72px;
  width: auto;
}

.sdock-btn-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.sdock-mini {
  flex: 0 0 auto;
  min-width: 20px;
  padding: 0 5px;
  border: 0;
  border-radius: 4px;
  background: var(--ls-tertiary-background-color, rgba(127, 127, 127, 0.22));
  color: var(--ls-primary-text-color, inherit);
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  cursor: pointer;
  opacity: 0.85;
}

.sdock-mini:hover {
  opacity: 1;
  background: var(--ls-quaternary-background-color, rgba(127, 127, 127, 0.34));
}

/* Destructive actions (drop slot, drop layout) only colour on hover — a red button per slot would make
   the panel read as an error state. */
.sdock-mini.is-danger:hover {
  background: var(--ls-error-color, rgba(214, 69, 69, 0.85));
  color: #fff;
}

/* Armed: the first click on a destructive button relabels it to "Sure?" and a second one within a few
   seconds performs the action. There is no confirm dialog to open — the host has no prompt API and
   showMsg can only say things — so this styling IS the warning, and it has to hold its colour without
   the pointer on it (the button is not necessarily where the second click starts from). */
.sdock-mini.is-armed,
.sdock-mini.is-armed:hover {
  background: var(--ls-error-color, rgba(214, 69, 69, 0.85));
  color: #fff;
  opacity: 1;
  font-weight: 600;
}

/* Warnings the edit UI has to be able to say in place: "this pid is used by another layout too, so
   activating this tab reloads it", or the JSON parse error of a hand-edited config. */
.sdock-hint {
  font-size: 10px;
  line-height: 1.35;
  opacity: 0.7;
  overflow-wrap: anywhere;
}
${hosted}
`
}
