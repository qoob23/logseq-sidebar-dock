import { describe, expect, it } from 'vitest'

import { buildDockCss, splitVarFallback } from '../styles'

const OPTS = {
  pluginId: 'logseq-sidebar-dock',
  splitPct: 42,
  dockPct: 35,
  hostedPids: ['logseq-plugin-a', 'logseq-plugin-b'],
}

describe('buildDockCss', () => {
  it('frees the nav container so the dock gets a share of the column', () => {
    const css = buildDockCss(OPTS)
    expect(css).toContain('#left-sidebar .left-sidebar-inner > .wrap .nav-contents-container')
    expect(css).toContain('height: auto !important')
    expect(css).toContain('flex: 1 1 auto !important')
  })

  it('sizes the injected container by plugin id', () => {
    expect(buildDockCss(OPTS)).toContain('#logseq-sidebar-dock--dock {')
    expect(buildDockCss(OPTS)).toContain('flex: 0 0 35%')
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
    for (const pid of OPTS.hostedPids) {
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

  it('beats the ~300px inline-wrapper fallback for any iframe in a slot', () => {
    const css = buildDockCss(OPTS)
    const sel = '.sdock-slot iframe'
    const block = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)))
    expect(block).toContain('position: absolute')
    expect(block).toContain('width: 100% !important')
    expect(block).toContain('height: 100% !important')
  })

  it('deduplicates hosted plugin ids', () => {
    const css = buildDockCss({ ...OPTS, hostedPids: ['dup', 'dup'] })
    // One rule block (line-anchored) plus its single `.sdock-dragging` companion.
    expect(css.split('\n.sdock-slot #dup_lsp_main {').length - 1).toBe(1)
    expect(css.split('.sdock-dragging .sdock-slot #dup_lsp_main {').length - 1).toBe(1)
  })

  it('emits no hosted-view rules when both slots are empty', () => {
    const css = buildDockCss({ ...OPTS, hostedPids: [] })
    expect(css).not.toContain('_lsp_main')
    expect(css).toContain('.sdock-placeholder')
  })

  it('escapes characters that are not valid in a CSS identifier', () => {
    const css = buildDockCss({ ...OPTS, hostedPids: ['odd.id'] })
    expect(css).toContain('#odd\\.id_lsp_main')
  })

  it('escapes a leading digit with the CSS hex form, not a backslash', () => {
    // `#2do…` is an invalid selector and would silently drop the whole override block.
    const css = buildDockCss({ ...OPTS, hostedPids: ['2do-plugin'] })
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
    for (const pid of OPTS.hostedPids) {
      expect(css).toContain(`.sdock-dragging .sdock-slot #${pid}_lsp_main`)
    }
    expect(css).toContain('pointer-events: none !important')
  })
})
