/**
 * Pure stylesheet builder for the keyed `logseq.provideStyle` sheet.
 *
 * Everything persistent lives here: the host wipes inline styles written onto its own nodes on every
 * React re-render, while the injected `<style data-injected-style=...>` element survives until unload.
 * That includes the nav/views mode switch — the two faces of the sidebar are shown and hidden purely
 * by re-providing this sheet, so nothing ever unmounts (a hidden docked iframe keeps running).
 */

import { type DockMode } from './settings'

export interface DockCssOptions {
  /** Our plugin id — the injected container is `#<pluginId>--dock`. */
  pluginId: string
  /** Which face of the sidebar the segmented control has selected. */
  mode: DockMode
  /** Share (%) of the dock height given to the top slot. */
  splitPct: number
  /** Plugin ids whose `#<pid>_lsp_main` container we adopt into a slot. */
  hostedPids: string[]
}

/**
 * The `var()` reference the top slot's flex-basis is built from.
 *
 * Doubles as the probe that tells whether a freshly provided sheet has actually landed in the host
 * document (`provideStyle` is fire-and-forget over postMessage), so both sides must agree on the exact
 * text — hence one function.
 */
export function splitVarFallback(splitPct: number): string {
  return `var(--sdock-split, ${splitPct})`
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

/* Drag passthrough: an outside-started drag must not be swallowed by the docked iframe. */
.sdock-dragging ${sel} {
  pointer-events: none !important;
}`
}

/**
 * The nav/views switch. Both faces stay mounted at all times — `display: none` keeps a docked plugin's
 * iframe alive, whereas removing it from the DOM would make Chromium reload it.
 */
function modeRules(dockId: string, mode: DockMode): string {
  if (mode === 'nav') {
    return `/* nav mode: the stock navigation owns the column, the dock shrinks to its tabs. */
${dockId} {
  flex: 0 0 auto;
}

${dockId} .sdock-root {
  display: none;
}`
  }

  return `/* views mode: the dock takes the whole column and the stock navigation steps aside. */
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

/** The complete stylesheet for the keyed `provideStyle` sheet. */
export function buildDockCss(opts: DockCssOptions): string {
  const dockId = `#${escapeIdent(opts.pluginId)}--dock`
  const hosted = [...new Set(opts.hostedPids)].map(hostedViewRules).join('\n')

  return `/* logseq-sidebar-dock — generated, do not edit by hand */

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
}

${modeRules(dockId, opts.mode)}

/* Segmented control: rounded track, active segment raised as a chip. */
.sdock-tabs {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  margin: 2px 8px 6px;
  padding: 2px;
  border-radius: var(--ls-border-radius-medium, 8px);
  background: var(--ls-tertiary-background-color, rgba(127, 127, 127, 0.14));
}

.sdock-tab {
  flex: 1 1 0;
  min-width: 0;
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
  cursor: pointer;
  user-select: none;
  opacity: 0.75;
  transition: background 0.15s ease, opacity 0.15s ease;
}

.sdock-tab:hover {
  opacity: 1;
}

.sdock-tab[data-tab='${opts.mode}'] {
  background: var(--ls-secondary-background-color, rgba(255, 255, 255, 0.9));
  color: var(--ls-primary-text-color, inherit);
  opacity: 1;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16);
}

/* Sits below the tabs and takes whatever height the mode left for it. */
.sdock-root {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
}

.sdock-slot {
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.sdock-slot[data-slot='top'] {
  flex: 0 0 calc(${splitVarFallback(opts.splitPct)} * 1%);
}

.sdock-slot[data-slot='bottom'] {
  flex: 1 1 auto;
}

/* Any iframe parked in a slot: an iframe inside an inline wrapper otherwise falls back to ~300px. */
.sdock-slot iframe {
  position: absolute;
  inset: 0;
  width: 100% !important;
  height: 100% !important;
  border: 0;
}

/* Set while a drag started outside the docked views is in flight (our divider, the host's resizer,
   anything else): the iframes must not eat the pointer stream mid-drag. */
.sdock-dragging .sdock-slot iframe {
  pointer-events: none !important;
}

.sdock-divider {
  flex: 0 0 6px;
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

.sdock-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 0 12px;
  text-align: center;
  font-size: 11px;
  line-height: 1.4;
  opacity: 0.6;
  color: var(--ls-secondary-text-color, var(--ls-primary-text-color, inherit));
  user-select: none;
}
${hosted}
`
}
