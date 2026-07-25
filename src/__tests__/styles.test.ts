import { describe, expect, it } from 'vitest'

import { EMBED_OWNER_ATTR } from '../embed'
import { NO_VIEW } from '../settings'
import { type DockCssOptions, buildDockCss, resolveLayout, splitVarFallback } from '../styles'

const OPTS: DockCssOptions = {
  pluginId: 'logseq-sidebar-dock',
  mode: 'nav',
  splitPct: 42,
  viewTop: 'logseq-plugin-a',
  viewBottom: 'logseq-plugin-b',
}

const HOSTED_PIDS = [OPTS.viewTop, OPTS.viewBottom]
const VIEWS: DockCssOptions = { ...OPTS, mode: 'views' }

/** The three host-nav elements views mode hides. */
const HOST_NAV_SELECTORS = [
  '#left-sidebar .left-sidebar-inner > .wrap > nav.cp__menubar-repos',
  '#left-sidebar .left-sidebar-inner > .wrap > .nav-contents-container',
  '#left-sidebar .left-sidebar-inner > .wrap > footer.create',
]

/** Bodies of every rule whose selector list is exactly `selector`. */
function ruleBlocks(css: string, selector: string): string[] {
  return css
    .split('\n')
    .map((line, index) => (line.trim() === `${selector} {` ? index : -1))
    .filter((index) => index !== -1)
    .map((index) => {
      const rest = css.split('\n').slice(index + 1)
      return rest.slice(0, rest.indexOf('}')).join('\n')
    })
}

/** The block that hides one slot plus the divider, or '' when the layout hides nothing. */
const HIDE_MARKER = '.sdock-divider {\n  display: none;\n}'
function hideBlock(css: string): string {
  const end = css.indexOf(HIDE_MARKER)
  if (end === -1) return ''
  return css.slice(css.lastIndexOf(".sdock-slot[data-slot='", end), end)
}

describe('resolveLayout', () => {
  it('maps the selection to the slots that are actually shown', () => {
    expect(resolveLayout('a', 'b')).toBe('both')
    expect(resolveLayout('a', NO_VIEW)).toBe('top-only')
    expect(resolveLayout(NO_VIEW, 'b')).toBe('bottom-only')
    expect(resolveLayout(NO_VIEW, NO_VIEW)).toBe('empty')
  })
})

describe('buildDockCss', () => {
  it('keeps the nav container unlocked in both modes', () => {
    for (const css of [buildDockCss(OPTS), buildDockCss(VIEWS)]) {
      expect(css).toContain('#left-sidebar .left-sidebar-inner > .wrap .nav-contents-container')
      expect(css).toContain('height: auto !important')
      expect(css).toContain('flex: 1 1 auto !important')
    }
  })

  it('addresses the injected container by plugin id', () => {
    expect(buildDockCss(OPTS)).toContain('#logseq-sidebar-dock--dock {')
  })

  it('lifts the container to the top of the column despite being appended last', () => {
    expect(buildDockCss(OPTS)).toContain('order: -1')
    expect(buildDockCss(VIEWS)).toContain('order: -1')
  })

  it('drives the split through a CSS var so a drag can override it inline', () => {
    expect(buildDockCss(OPTS)).toContain('calc(var(--sdock-split, 42) * 1%)')
  })

  it('emits the exact split probe used to detect a landed stylesheet', () => {
    // The dock waits for this substring to show up in the host's <style> before dropping the
    // drag-time inline override, so the two must never drift apart.
    expect(splitVarFallback(42)).toBe('var(--sdock-split, 42)')
    expect(buildDockCss(OPTS)).toContain(splitVarFallback(OPTS.splitPct))
    expect(buildDockCss({ ...OPTS, splitPct: 61.5 })).not.toContain(splitVarFallback(OPTS.splitPct))
  })

  it('emits the !important overrides for every hosted plugin main UI', () => {
    const css = buildDockCss(OPTS)
    for (const pid of HOSTED_PIDS) {
      const sel = `.sdock-slot #${pid}_lsp_main`
      expect(css).toContain(sel)
      const block = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)))
      expect(block).toContain('position: relative !important')
      expect(block).toContain('inset: auto !important')
      expect(block).toContain('width: 100% !important')
      expect(block).toContain('height: 100% !important')
      expect(block).toContain('visibility: visible !important')
      expect(block).toContain('display: block !important')
      expect(block).toContain('z-index: 1 !important')
    }
  })

  it('beats the ~300px inline-wrapper fallback for an ADOPTED iframe', () => {
    const css = buildDockCss(OPTS)
    for (const pid of HOSTED_PIDS) {
      const sel = `.sdock-slot #${pid}_lsp_main iframe`
      expect(css).toContain(sel)
      const block = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)))
      expect(block).toContain('position: absolute')
      expect(block).toContain('width: 100% !important')
      expect(block).toContain('height: 100% !important')
    }
  })

  it('never restyles the geometry of an iframe a provider owns (protocol host rule 6)', () => {
    const css = buildDockCss(OPTS)
    // The only unscoped `.sdock-slot iframe` rule left is the transient drag passthrough, which
    // suspends pointer events and touches no geometry.
    for (const block of ruleBlocks(css, '.sdock-slot iframe')) {
      expect(block).toContain('pointer-events: none !important')
      expect(block).not.toContain('position:')
      expect(block).not.toContain('width:')
      expect(block).not.toContain('height:')
      expect(block).not.toContain('inset:')
    }
    // ...and no selector anywhere in the sheet reaches for a provider-owned subtree.
    const selectorLines = css
      .split('\n')
      .filter((line) => line.trim().endsWith('{') || line.trim().endsWith(','))
    expect(selectorLines.some((line) => line.includes(EMBED_OWNER_ATTR))).toBe(false)
  })

  it('deduplicates hosted plugin ids', () => {
    const css = buildDockCss({ ...OPTS, viewTop: 'dup', viewBottom: 'dup' })
    // One rule block (line-anchored) plus its single `.sdock-dragging` companion.
    expect(css.split('\n.sdock-slot #dup_lsp_main {').length - 1).toBe(1)
    expect(css.split('.sdock-dragging .sdock-slot #dup_lsp_main {').length - 1).toBe(1)
  })

  it('emits no hosted-view rules when both slots are empty', () => {
    const css = buildDockCss({ ...OPTS, viewTop: NO_VIEW, viewBottom: NO_VIEW })
    expect(css).not.toContain('_lsp_main')
    expect(css).toContain('.sdock-placeholder')
  })

  it('escapes characters that are not valid in a CSS identifier', () => {
    const css = buildDockCss({ ...OPTS, viewTop: 'odd.id' })
    expect(css).toContain('#odd\\.id_lsp_main')
  })

  it('escapes a leading digit with the CSS hex form, not a backslash', () => {
    // `#2do…` is an invalid selector and would silently drop the whole override block.
    const css = buildDockCss({ ...OPTS, viewTop: '2do-plugin' })
    expect(css).toContain('#\\32 do-plugin_lsp_main')
    expect(css).not.toContain('#2do-plugin_lsp_main')
  })

  it('escapes a leading digit in our own plugin id too', () => {
    const css = buildDockCss({ ...OPTS, pluginId: '9dock' })
    expect(css).toContain('#\\39 dock--dock {')
  })

  it('disables pointer events on docked views while a drag is in flight', () => {
    const css = buildDockCss(OPTS)
    expect(css).toContain('.sdock-dragging .sdock-slot iframe')
    for (const pid of HOSTED_PIDS) {
      expect(css).toContain(`.sdock-dragging .sdock-slot #${pid}_lsp_main`)
    }
    expect(css).toContain('pointer-events: none !important')
  })

  it('styles the diagnostic overlay above the adopted view, and its action button', () => {
    const css = buildDockCss(OPTS)
    expect(css).toContain('.sdock-overlay {')
    expect(css).toContain('z-index: 2')
    expect(css).toContain('.sdock-action {')
  })
})

describe('buildDockCss — nav mode', () => {
  const css = buildDockCss(OPTS)

  it('collapses the dock to its tabs and hides the slots', () => {
    expect(css).toContain('#logseq-sidebar-dock--dock .sdock-root {\n  display: none;\n}')
    expect(css).toContain('flex: 0 0 auto')
  })

  it('leaves the stock navigation alone', () => {
    for (const sel of HOST_NAV_SELECTORS) expect(css).not.toContain(sel)
  })

  it('highlights the Nav segment only', () => {
    expect(css).toContain(".sdock-tab[data-tab='nav'] {")
    expect(css).not.toContain(".sdock-tab[data-tab='views'] {")
  })
})

describe('buildDockCss — views mode', () => {
  const css = buildDockCss(VIEWS)

  it('gives the dock the whole column', () => {
    expect(css).toContain('flex: 1 1 auto;\n  min-height: 0;')
    expect(css).not.toContain('#logseq-sidebar-dock--dock .sdock-root {\n  display: none;\n}')
  })

  it('hides every stock navigation section', () => {
    for (const sel of HOST_NAV_SELECTORS) expect(css).toContain(sel)
    const block = css.slice(css.indexOf(HOST_NAV_SELECTORS[0] ?? ''))
    expect(block.slice(0, block.indexOf('}'))).toContain('display: none !important')
  })

  it('highlights the Views segment only', () => {
    expect(css).toContain(".sdock-tab[data-tab='views'] {")
    expect(css).not.toContain(".sdock-tab[data-tab='nav'] {")
  })

  it('keeps the slot rules so hidden views stay mounted, never unmounted', () => {
    expect(css).toContain(".sdock-slot[data-slot='top']")
    expect(css).toContain(".sdock-slot[data-slot='bottom']")
  })
})

describe('buildDockCss — slot layouts', () => {
  it('both configured: two slots split by the divider, nothing hidden', () => {
    const css = buildDockCss(VIEWS)
    expect(css).not.toContain(HIDE_MARKER)
    expect(css).toContain(`flex: 0 0 calc(${splitVarFallback(VIEWS.splitPct)} * 1%)`)
    expect(css).toContain(".sdock-slot[data-slot='bottom'] {\n  flex: 1 1 auto;\n}")
  })

  it('top only: the top slot takes the dock, the bottom slot and the divider are hidden', () => {
    const css = buildDockCss({ ...VIEWS, viewBottom: NO_VIEW })
    expect(css).toContain(".sdock-slot[data-slot='top'] {\n  flex: 1 1 auto;\n}")
    expect(css).toContain(HIDE_MARKER)
    expect(hideBlock(css)).toContain("[data-slot='bottom']")
    expect(hideBlock(css)).not.toContain("[data-slot='top']")
  })

  it('bottom only: the bottom slot takes the dock, the top slot and the divider are hidden', () => {
    const css = buildDockCss({ ...VIEWS, viewTop: NO_VIEW })
    expect(css).toContain(".sdock-slot[data-slot='bottom'] {\n  flex: 1 1 auto;\n}")
    expect(css).toContain(HIDE_MARKER)
    expect(hideBlock(css)).toContain("[data-slot='top']")
    expect(hideBlock(css)).not.toContain("[data-slot='bottom']")
  })

  it('neither configured: exactly one slot remains, carrying the placeholder', () => {
    const css = buildDockCss({ ...VIEWS, viewTop: NO_VIEW, viewBottom: NO_VIEW })
    expect(css).toContain(".sdock-slot[data-slot='top'] {\n  flex: 1 1 auto;\n}")
    expect(css).toContain(HIDE_MARKER)
    expect(hideBlock(css)).toContain("[data-slot='bottom']")
    expect(css).toContain('.sdock-placeholder')
  })

  it('keeps splitPct in the sheet in every layout, so it is ignored but never lost', () => {
    for (const views of [
      { viewTop: 'a', viewBottom: NO_VIEW },
      { viewTop: NO_VIEW, viewBottom: 'b' },
      { viewTop: NO_VIEW, viewBottom: NO_VIEW },
    ]) {
      expect(buildDockCss({ ...VIEWS, ...views })).toContain(splitVarFallback(VIEWS.splitPct))
    }
  })
})
