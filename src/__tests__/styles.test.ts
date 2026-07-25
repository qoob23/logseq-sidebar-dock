import { describe, expect, it } from 'vitest'

import { type ResolvedSlot, type ViewSpec, normalizeConfig, resolveLayoutSlots } from '../config'
// The floor and the viewport reserve the sheet emits are owned by `divider.ts` — one constant each,
// both sides.
import { SLOT_MIN_PX, VIEWPORT_RESERVE_PX } from '../divider'
import { EMBED_OWNER_ATTR } from '../embed'
import { WIDTH_FOLLOW_HOST } from '../settings'
// `TABS_PATH` and `WIDTH_VAR` are the two names `dock.ts` and this sheet MUST spell identically — the
// strip's `provideUI` path and the custom property a resize drag writes on <html>. They are imported
// here for the same reason `dock.ts` imports them: a test that spelled the literals out again would
// drift alongside the code it is meant to pin, and the failure only ever shows up in a live Logseq.
import {
  type DockCssOptions,
  type ResolvedLayout,
  TABS_PATH,
  WIDTH_VAR,
  buildDockCss,
  sheetMarker,
  slotWeightVar,
  widthVarFallback,
} from '../styles'

const NONE: ViewSpec = { kind: 'none' }
const plugin = (pid: string): ViewSpec => ({ kind: 'plugin', pid })
const macro = (raw: string, ...args: string[]): ViewSpec => ({ kind: 'macro', raw, args })

const slot = (id: string, weight: number, spec: ViewSpec = NONE): ResolvedSlot => ({ id, weight, spec })

const PLUGIN_A = 'logseq-plugin-a'
const PLUGIN_B = 'logseq-plugin-b'

/** Two layouts, so every test can check that an INACTIVE layout is served as well as the visible one. */
const LAYOUT_A: ResolvedLayout = {
  id: 'l_aaaaaa',
  axis: 'column',
  slots: [slot('s_111111', 2, plugin(PLUGIN_A)), slot('s_222222', 1, macro(':pomo', ':pomo'))],
}
const LAYOUT_B: ResolvedLayout = {
  id: 'l_bbbbbb',
  axis: 'row',
  slots: [slot('s_333333', 1.5, plugin(PLUGIN_B)), slot('s_444444', 1)],
}

/** The default width state: no override, so the host's own sidebar width stands. */
const NAV: DockCssOptions = {
  pluginId: 'logseq-sidebar-dock',
  activeTab: 'nav',
  layouts: [LAYOUT_A, LAYOUT_B],
  sidebarWidthPx: WIDTH_FOLLOW_HOST,
}
const ACTIVE_A: DockCssOptions = { ...NAV, activeTab: 'l_aaaaaa' }
const ACTIVE_B: DockCssOptions = { ...NAV, activeTab: 'l_bbbbbb' }

/** The three host-nav elements a layout tab hides. */
const HOST_NAV_SELECTORS = [
  '#left-sidebar .left-sidebar-inner > .wrap > nav.cp__menubar-repos',
  '#left-sidebar .left-sidebar-inner > .wrap > .nav-contents-container',
  '#left-sidebar .left-sidebar-inner > .wrap > footer.create',
]

/** Bodies of every rule whose selector list is exactly `selector`. */
function ruleBlocks(css: string, selector: string): string[] {
  const lines = css.split('\n')
  return lines
    .map((line, index) => (line.trim() === `${selector} {` ? index : -1))
    .filter((index) => index !== -1)
    .map((index) => {
      const rest = lines.slice(index + 1)
      return rest.slice(0, rest.indexOf('}')).join('\n')
    })
}

function block(css: string, selector: string): string {
  const blocks = ruleBlocks(css, selector)
  expect(blocks, `no rule for ${selector}`).toHaveLength(1)
  return blocks[0]
}

/** Every declaration a selector picks up, for the few that are legitimately split over two rules. */
function declarations(css: string, selector: string): string {
  const blocks = ruleBlocks(css, selector)
  expect(blocks.length, `no rule for ${selector}`).toBeGreaterThan(0)
  return blocks.join('\n')
}

describe('sheetMarker', () => {
  it('encodes the tab, the sidebar width, every layout, its axis and every baked weight', () => {
    expect(sheetMarker('l_aaaaaa', [LAYOUT_A, LAYOUT_B], 0)).toBe(
      '/* sdock-sig tab=l_aaaaaa w=0 | l_aaaaaa:c s_111111=2,s_222222=1 | l_bbbbbb:r s_333333=1.5,s_444444=1 */',
    )
    expect(sheetMarker('l_aaaaaa', [LAYOUT_A, LAYOUT_B], 620.5)).toContain('tab=l_aaaaaa w=620.5 |')
  })

  it('is the second line of the sheet, so the dock can poll the host for it', () => {
    // `provideStyle` is fire-and-forget over postMessage: a `<style>` containing this exact string is
    // the ONLY proof the new sheet has landed, and the drag's inline vars may not be dropped before it.
    for (const opts of [NAV, ACTIVE_A, ACTIVE_B, { ...ACTIVE_A, sidebarWidthPx: 620 }]) {
      const marker = sheetMarker(opts.activeTab, opts.layouts, opts.sidebarWidthPx)
      expect(buildDockCss(opts).split('\n')[1]).toBe(marker)
      expect(buildDockCss(opts)).toContain(marker)
    }
  })

  it('changes on everything a re-provide could change about the geometry', () => {
    const base = sheetMarker('l_aaaaaa', [LAYOUT_A, LAYOUT_B], 0)
    const variants = [
      sheetMarker('nav', [LAYOUT_A, LAYOUT_B], 0),
      sheetMarker('l_bbbbbb', [LAYOUT_A, LAYOUT_B], 0),
      sheetMarker('l_aaaaaa', [{ ...LAYOUT_A, axis: 'row' }, LAYOUT_B], 0),
      sheetMarker('l_aaaaaa', [{ ...LAYOUT_A, slots: [slot('s_111111', 2.5), slot('s_222222', 1)] }, LAYOUT_B], 0),
      sheetMarker('l_aaaaaa', [{ ...LAYOUT_A, slots: [slot('s_111111', 2)] }, LAYOUT_B], 0),
      sheetMarker('l_aaaaaa', [LAYOUT_A], 0),
      sheetMarker('l_aaaaaa', [], 0),
      // A resize changes NO weight, so without the width in here the dock would mistake the previous
      // sheet for the new one and snap the transient `--sdock-width` back for a frame.
      sheetMarker('l_aaaaaa', [LAYOUT_A, LAYOUT_B], 620),
      sheetMarker('l_aaaaaa', [LAYOUT_A, LAYOUT_B], 621),
    ]
    for (const variant of variants) expect(variant).not.toBe(base)
    expect(new Set(variants).size).toBe(variants.length)
  })

  it('is insensitive to nothing else — the same inputs give the same string', () => {
    expect(sheetMarker('l_aaaaaa', [LAYOUT_A], 620)).toBe(sheetMarker('l_aaaaaa', [{ ...LAYOUT_A }], 620))
  })

  it('strips a hostile tab, and never lets one truncate the sheet at a comment close', () => {
    const hostile: DockCssOptions = { ...NAV, activeTab: 'l_a*/ } body { display: none } /*' }
    const css = buildDockCss(hostile)
    expect(sheetMarker(hostile.activeTab, hostile.layouts, hostile.sidebarWidthPx)).toBe(
      `/* sdock-sig tab=l_abodydisplaynone w=0 | l_aaaaaa:c s_111111=2,s_222222=1 | l_bbbbbb:r s_333333=1.5,s_444444=1 */`,
    )
    expect(css).not.toContain('*/ } body')
    // Stripped identically in the marker and in the active-chip selector, so garbage matches nothing.
    expect(css).toContain(".sdock-tab[data-tab='l_abodydisplaynone']")
    expect(css.split('\n')[1]).toBe(sheetMarker(hostile.activeTab, hostile.layouts, hostile.sidebarWidthPx))
  })

  it('substitutes 1 for a non-finite weight, in the marker as in the rule', () => {
    // NaN in `flex-grow` is an invalid value and would collapse the slot.
    const broken: ResolvedLayout = { ...LAYOUT_A, slots: [slot('s_111111', Number.NaN)] }
    expect(sheetMarker('nav', [broken], 0)).toContain('s_111111=1')
    expect(buildDockCss({ ...NAV, layouts: [broken] })).toContain(`flex-grow: var(${slotWeightVar('s_111111')}, 1);`)
  })

  it('substitutes 0 for a non-finite width, so a poisoned value reads as "no override"', () => {
    // It reaches a `min()` argument as well as this comment; neither may be handed `NaNpx`.
    expect(sheetMarker('nav', [LAYOUT_A], Number.NaN)).toContain('w=0')
    expect(buildDockCss({ ...NAV, sidebarWidthPx: Number.NaN })).not.toContain('--ls-left-sidebar-width')
  })
})

describe('slotWeightVar', () => {
  it('spells the custom property the drag writes inline on the layout root', () => {
    expect(slotWeightVar('s_111111')).toBe('--sdock-w-s_111111')
  })

  it('is the exact property name the per-slot rule reads', () => {
    expect(buildDockCss(ACTIVE_A)).toContain(`var(${slotWeightVar('s_111111')}, 2)`)
    expect(buildDockCss(ACTIVE_A)).toContain(`var(${slotWeightVar('s_222222')}, 1)`)
  })
})

describe('buildDockCss — layouts', () => {
  it('gives every layout its rules, whether it is visible or not', () => {
    // Detaching a hidden layout would reboot its plugin iframes, so all of them stay mounted.
    const css = buildDockCss(ACTIVE_A)
    for (const layout of [LAYOUT_A, LAYOUT_B]) {
      expect(css).toContain(`.sdock-layout[data-layout='${layout.id}'] {`)
      for (const each of layout.slots) {
        expect(css).toContain(`.sdock-layout[data-layout='${layout.id}'] > .sdock-slot[data-slot-id='${each.id}'] {`)
      }
    }
  })

  it('displays the ACTIVE layout and nothing else', () => {
    const css = buildDockCss(ACTIVE_A)
    expect(block(css, `.sdock-layout[data-layout='l_aaaaaa']`)).toContain('display: flex;')
    expect(block(css, `.sdock-layout[data-layout='l_bbbbbb']`)).not.toContain('display:')
    // The generic rule hides them all; exactly one gets `display: flex` back.
    expect(block(css, '.sdock-layout')).toContain('display: none;')

    const flipped = buildDockCss(ACTIVE_B)
    expect(block(flipped, `.sdock-layout[data-layout='l_bbbbbb']`)).toContain('display: flex;')
    expect(block(flipped, `.sdock-layout[data-layout='l_aaaaaa']`)).not.toContain('display:')
  })

  it('shows no layout at all while the nav tab is active', () => {
    const css = buildDockCss(NAV)
    for (const layout of [LAYOUT_A, LAYOUT_B]) {
      expect(block(css, `.sdock-layout[data-layout='${layout.id}']`)).not.toContain('display:')
    }
  })

  it('lays each layout out along its own axis', () => {
    const css = buildDockCss(ACTIVE_A)
    expect(block(css, `.sdock-layout[data-layout='l_aaaaaa']`)).toContain('flex-direction: column;')
    expect(block(css, `.sdock-layout[data-layout='l_bbbbbb']`)).toContain('flex-direction: row;')
  })

  it('floors each slot along the layout axis only, so the cross axis can stay narrow', () => {
    const css = buildDockCss(ACTIVE_A)
    expect(block(css, `.sdock-layout[data-layout='l_aaaaaa'] > .sdock-slot[data-slot-id='s_111111']`)).toContain(
      `min-height: ${SLOT_MIN_PX}px;`,
    )
    expect(block(css, `.sdock-layout[data-layout='l_bbbbbb'] > .sdock-slot[data-slot-id='s_333333']`)).toContain(
      `min-width: ${SLOT_MIN_PX}px;`,
    )
  })

  it('turns the divider cursor sideways in a row layout only', () => {
    const css = buildDockCss(ACTIVE_A)
    expect(block(css, `.sdock-layout[data-layout='l_bbbbbb'] > .sdock-divider`)).toContain('cursor: col-resize;')
    expect(ruleBlocks(css, `.sdock-layout[data-layout='l_aaaaaa'] > .sdock-divider`)).toHaveLength(0)
    expect(block(css, '.sdock-divider')).toContain('cursor: row-resize;')
  })

  it('bakes each weight as the fallback of its own custom property', () => {
    const css = buildDockCss(ACTIVE_A)
    expect(block(css, `.sdock-layout[data-layout='l_aaaaaa'] > .sdock-slot[data-slot-id='s_111111']`)).toContain(
      'flex-grow: var(--sdock-w-s_111111, 2);',
    )
    expect(block(css, `.sdock-layout[data-layout='l_bbbbbb'] > .sdock-slot[data-slot-id='s_333333']`)).toContain(
      'flex-grow: var(--sdock-w-s_333333, 1.5);',
    )
    // `flex-basis: 0` is what makes the weights alone decide the split.
    expect(block(css, '.sdock-slot')).toContain('flex-basis: 0;')
  })

  it('survives a configuration with no layouts, and one with an empty layout', () => {
    const empty = buildDockCss({ ...NAV, layouts: [] })
    expect(empty).toContain('.sdock-layouts {')
    expect(empty).not.toContain('data-layout=')
    const bare = buildDockCss({ ...NAV, activeTab: 'l_cccccc', layouts: [{ id: 'l_cccccc', axis: 'column', slots: [] }] })
    expect(block(bare, `.sdock-layout[data-layout='l_cccccc']`)).toContain('display: flex;')
  })

  it('is a pure function of its options', () => {
    expect(buildDockCss(ACTIVE_A)).toBe(buildDockCss({ ...ACTIVE_A }))
    expect(buildDockCss(ACTIVE_A)).not.toBe(buildDockCss(ACTIVE_B))
  })
})

describe('buildDockCss — faces', () => {
  it('keeps the nav container unlocked whichever face is up', () => {
    for (const css of [buildDockCss(NAV), buildDockCss(ACTIVE_A)]) {
      const rules = block(css, '#left-sidebar .left-sidebar-inner > .wrap .nav-contents-container')
      expect(rules).toContain('height: auto !important;')
      expect(rules).toContain('flex: 1 1 auto !important;')
    }
  })

  it('nav face: the dock leaves the column entirely and the stock navigation is untouched', () => {
    // The tab strip is its own injection in the header row now, so nothing in this container has to
    // stay on screen to keep the faces switchable.
    const css = buildDockCss(NAV)
    // Two rules address the container: the always-on one (we are appended last but belong at the top
    // of the column) and the face rule that sizes it.
    expect(declarations(css, `#logseq-sidebar-dock--dock`)).toContain('order: -1;')
    expect(declarations(css, `#logseq-sidebar-dock--dock`)).toContain('flex: 0 0 auto;')
    expect(declarations(buildDockCss(ACTIVE_A), `#logseq-sidebar-dock--dock`)).toContain('flex: 1 1 auto;')
    expect(block(css, '#logseq-sidebar-dock--dock:not(:has(.sdock-config-error))')).toBe('  display: none;')
    expect(css).toContain('#logseq-sidebar-dock--dock .sdock-layouts,\n#logseq-sidebar-dock--dock .sdock-editbar {\n  display: none;\n}')
    for (const selector of HOST_NAV_SELECTORS) expect(css).not.toContain(selector)
  })

  it('keeps a parse-error diagnostic on screen even on the nav face', () => {
    // While the stored JSON does not parse every edit is refused — and the tab a user would flip to in
    // order to read why is named by that very configuration. Hence a selector, not a builder flag:
    // the error state never has to be re-provided into this sheet.
    const css = buildDockCss(NAV)
    expect(ruleBlocks(css, '#logseq-sidebar-dock--dock')).not.toContain('  display: none;')
    // Hidden is never unmounted: a docked iframe under this container keeps running on the nav face.
    expect(css).not.toContain('.sdock-layouts {\n  display: none;')
  })

  it('takes the dock out of hiding as soon as a layout tab is up', () => {
    expect(ruleBlocks(buildDockCss(ACTIVE_A), '#logseq-sidebar-dock--dock:not(:has(.sdock-config-error))')).toEqual([])
  })

  it('falls back to the nav face for a tab that names no layout', () => {
    // A deleted layout, a hand-edited settings file, a garbage token: all land on nav.
    for (const activeTab of ['nav', 'l_deadbe', 'views', '???']) {
      const css = buildDockCss({ ...NAV, activeTab })
      expect(css).toContain('.sdock-layouts,\n#logseq-sidebar-dock--dock .sdock-editbar {\n  display: none;\n}')
      for (const selector of HOST_NAV_SELECTORS) expect(css).not.toContain(selector)
    }
  })

  it('layout face: the dock takes the column and every stock nav section steps aside', () => {
    const css = buildDockCss(ACTIVE_A)
    expect(css).not.toContain('.sdock-layouts,\n#logseq-sidebar-dock--dock .sdock-editbar {\n  display: none;\n}')
    for (const selector of HOST_NAV_SELECTORS) expect(css).toContain(selector)
    const hidden = css.slice(css.indexOf(HOST_NAV_SELECTORS[0]))
    expect(hidden.slice(0, hidden.indexOf('}'))).toContain('display: none !important;')
  })

  it('raises the active chip, and the gear only while edit mode is on', () => {
    expect(buildDockCss(ACTIVE_A)).toContain(".sdock-tab[data-tab='l_aaaaaa'],\n.sdock-editing .sdock-gear {")
    expect(buildDockCss(NAV)).toContain(".sdock-tab[data-tab='nav'],\n.sdock-editing .sdock-gear {")
    expect(buildDockCss(ACTIVE_A)).not.toContain(".sdock-tab[data-tab='nav'],")
  })

  it('content-sizes the tabs so a wide sidebar does not stretch two of them absurdly', () => {
    // Shrinkable too (`0 1`), which is what lets them ellipsize in the header row instead of spilling
    // over the search button — that row cannot gain a line the way the sidebar column can.
    const css = buildDockCss(NAV)
    expect(css).toContain('flex: 0 1 auto;')
    const tabRule = css.slice(css.indexOf('.sdock-tab,\n.sdock-tab-btn {'))
    expect(tabRule.slice(0, tabRule.indexOf('}'))).toContain('text-overflow: ellipsis;')
  })

  it('exempts the icon buttons from that shrink — clipped, they take edit mode with them', () => {
    // Ellipsizing a tab leaves it readable; ellipsizing a one-glyph button leaves nothing. The gear
    // and the add-layout button are the only way into edit mode (and, with no layouts configured, to
    // a first tab), so the tabs give up width in a narrow header row and these two never do.
    const picked = declarations(buildDockCss(NAV), '.sdock-tab-btn')
    expect(picked).toContain('flex: 0 1 auto;')
    expect(picked).toContain('flex: 0 0 auto;')
    // Both rules are one class deep, so SOURCE ORDER is the whole mechanism: the exemption has to come
    // after the shared rule or the shrinkable declaration stands and the fix is inert.
    expect(picked.indexOf('flex: 0 0 auto;')).toBeGreaterThan(picked.indexOf('flex: 0 1 auto;'))
  })
})

describe('buildDockCss — tab strip placement', () => {
  const css = buildDockCss(NAV)
  const TABS = '#logseq-sidebar-dock--tabs'

  it('styles the strip by its OWN injected-container id, not the dock container', () => {
    // Two provideUI injections in two host subtrees: nothing may reach the strip through the dock.
    expect(block(css, TABS)).toContain('display: flex;')
    expect(css).not.toContain(`#logseq-sidebar-dock--dock ${TABS}`)
  })

  it('escapes a leading digit in the container id, exactly like the dock container', () => {
    expect(buildDockCss({ ...NAV, pluginId: '9dock' })).toContain('#\\39 dock--tabs {')
  })

  it('sits in the header row without widening it, and outside the window drag region', () => {
    // Basis 0 takes the room the header cell has left over; growing that cell would push the search
    // button across the header. The header is a window drag region and the host exempts only
    // a/svg/button, so a pointerdown on our track would start a window drag instead of a click.
    expect(block(css, `${TABS_PATH} > ${TABS}`)).toContain('flex: 1 1 0;')
    expect(block(css, TABS)).toContain('-webkit-app-region: no-drag;')
    // The header sets an outsized font-size on its own children.
    expect(block(css, TABS)).toContain('font-size: 12px;')
  })

  it('keeps a placement for the fallback row inside our own column', () => {
    // dock.ts injects into the sidebar column when the header cell cannot be resolved; -2 puts the
    // strip above the dock container's own order: -1.
    const fallback = block(css, `#left-sidebar ${TABS}`)
    expect(fallback).toContain('order: -2;')
    expect(fallback).toContain('flex: 0 0 auto;')
  })

  it('wraps in the column and never in the header row', () => {
    // An extra row is free in a sidebar column and would grow the app header; there the tabs
    // ellipsize instead.
    expect(block(css, `#left-sidebar ${TABS} .sdock-tabs`)).toBe('  flex-wrap: wrap;')
    expect(block(css, '.sdock-tabs')).not.toContain('flex-wrap:')
  })

  it('hides itself while the sidebar whose face it switches is closed', () => {
    expect(block(css, `main:not(.ls-left-sidebar-open) ${TABS}`)).toBe('  display: none;')
  })

  it('describes both placements unconditionally, on every tab', () => {
    // Which row is in force is a fact about the host DOM the dock discovers at assert time; a strip
    // that just moved rows must not wait for a re-provide to be styled for its new home.
    for (const opts of [NAV, ACTIVE_A, ACTIVE_B]) {
      const each = buildDockCss(opts)
      for (const selector of [TABS, `${TABS_PATH} > ${TABS}`, `#left-sidebar ${TABS}`]) {
        expect(ruleBlocks(each, selector)).toHaveLength(1)
      }
    }
  })

  it('places the header rule at the exact path dock.ts injects the strip into', () => {
    // The two halves of one placement: `dock.ts` passes TABS_PATH to `provideUI` and this sheet spells
    // it into the rule below. Were they to drift, the strip would land in the new row while the sheet
    // still styled the old one — no flex line, the header's outsized font-size left standing, and no
    // `-webkit-app-region: no-drag`, so a pointerdown on a tab would drag the WINDOW instead of
    // switching tabs. Asserted through the constant so this test cannot drift with the builder: the
    // literal appears in the sheet exactly once, and only underneath TABS_PATH.
    expect(ruleBlocks(css, `${TABS_PATH} > ${TABS}`)).toHaveLength(1)
    expect(css.split(TABS_PATH)).toHaveLength(2)
    // The no-drag opt-out itself is on the bare container rule, so it survives EITHER placement.
    expect(block(css, TABS)).toContain('-webkit-app-region: no-drag;')
  })

  it('highlights the active tab wherever the strip ended up', () => {
    // Selector on the button alone — never scoped to a container, or the fallback row would lose it.
    expect(css).toContain(".sdock-tab[data-tab='nav'],")
    expect(css).not.toContain(`${TABS} .sdock-tab[data-tab=`)
    // Same for the edit-mode chrome: the gear is in the strip, the controls it reveals are in the dock,
    // so `dock.ts` puts the class on BOTH containers and no rule may assume either one.
    expect(css).not.toContain(`${TABS}.sdock-editing`)
    expect(css).toContain('.sdock-editing .sdock-gear {')
  })
})

describe('buildDockCss — sidebar width override', () => {
  const WIDTH_SEL = 'html:has(main.ls-left-sidebar-open)'
  // The viewport cap mirrors VIEWPORT_RESERVE_PX: a width persisted on a wide monitor must not swallow
  // a narrower window later, where the handle to drag it back would itself sit off-screen.
  const WIDTH_RULE = `--ls-left-sidebar-width: min(${widthVarFallback(620)}, calc(100vw - ${String(VIEWPORT_RESERVE_PX)}px)) !important;`

  /** Every base fixture with a width forced on it — the rule must not depend on which tab is up. */
  const WIDENED = [NAV, ACTIVE_A, ACTIVE_B].map((opts) => ({ ...opts, sidebarWidthPx: 620 }))

  it('emits the exact width probe the transient inline var is handed off through', () => {
    // The drag writes WIDTH_VAR on <html>; this is the fallback it masks until it is dropped. Built
    // FROM the constant `dock.ts` writes, and asserted through it here for the same reason: spelling
    // the property out again on either side buys a rule that reads what nothing writes, so the sidebar
    // stops tracking the pointer mid-drag and only jumps once the re-provided sheet lands — and no test
    // that hardcoded the name could tell.
    expect(widthVarFallback(620)).toBe(`var(${WIDTH_VAR}, 620px)`)
    expect(declarations(buildDockCss({ ...ACTIVE_A, sidebarWidthPx: 620 }), WIDTH_SEL)).toContain(
      `var(${WIDTH_VAR}, 620px)`,
    )
    for (const opts of WIDENED) {
      expect(buildDockCss(opts)).toContain(`${WIDTH_SEL} {\n  ${WIDTH_RULE}`)
      expect(buildDockCss({ ...opts, sidebarWidthPx: 621 })).not.toContain(widthVarFallback(620))
    }
  })

  it('overrides the host variable with !important — the only way past its inline value', () => {
    // The host clamps its own resizer to 240-460px and writes the result as a NON-important inline
    // custom property on <html>; an !important author declaration outranking it is the whole feature.
    for (const opts of WIDENED) {
      expect(ruleBlocks(buildDockCss(opts), WIDTH_SEL)[0] ?? '').toContain(WIDTH_RULE)
    }
  })

  it('applies on EVERY tab — one width, so a tab flip never relayouts the main content', () => {
    // The Nav tab is widened too: the host's own resizer is superseded, not half-masked.
    const blocks = WIDENED.map((opts) => ruleBlocks(buildDockCss(opts), WIDTH_SEL))
    for (const each of blocks) expect(each).toEqual(blocks[0])
    expect(buildDockCss({ ...ACTIVE_A, sidebarWidthPx: 1200 })).toContain(widthVarFallback(1200))
  })

  it('applies only while the sidebar is open — the header cell reserves this width unconditionally', () => {
    // Ungated, a closed sidebar would keep the widened min-width on `.cp__header > .l` and push the
    // search button (and everything right of it) across the header for a column nobody can see.
    for (const opts of WIDENED) {
      const css = buildDockCss(opts)
      expect(ruleBlocks(css, 'html')).toEqual([])
      expect(css.split('\n').some((line) => line.trim() === 'html {')).toBe(false)
    }
  })

  it('emits nothing at all with no override in force, whatever the tab or the layout', () => {
    for (const base of [NAV, ACTIVE_A, ACTIVE_B]) {
      for (const layouts of [base.layouts, [LAYOUT_A], []]) {
        const css = buildDockCss({ ...base, layouts, sidebarWidthPx: WIDTH_FOLLOW_HOST })
        expect(css).not.toContain('--ls-left-sidebar-width')
        expect(css).not.toContain(WIDTH_VAR)
      }
    }
    // Negative is not a width either — normalization never produces one, but the builder is total.
    expect(buildDockCss({ ...ACTIVE_A, sidebarWidthPx: -50 })).not.toContain('--ls-left-sidebar-width')
  })
})

describe('buildDockCss — hosted views', () => {
  it('emits the !important cage for every pid in EVERY layout, active or not', () => {
    const css = buildDockCss(ACTIVE_A)
    for (const pid of [PLUGIN_A, PLUGIN_B]) {
      const rules = block(css, `.sdock-slot #${pid}_lsp_main`)
      expect(rules).toContain('position: relative !important;')
      expect(rules).toContain('inset: auto !important;')
      expect(rules).toContain('width: 100% !important;')
      expect(rules).toContain('height: 100% !important;')
      expect(rules).toContain('visibility: visible !important;')
      expect(rules).toContain('display: block !important;')
      expect(rules).toContain('z-index: 1 !important;')
      expect(block(css, `.sdock-slot #${pid}_lsp_main iframe`)).toContain('height: 100% !important;')
      expect(block(css, `.sdock-dragging .sdock-slot #${pid}_lsp_main`)).toContain('pointer-events: none !important;')
    }
  })

  it('deduplicates a pid used by more than one layout', () => {
    const css = buildDockCss({ ...ACTIVE_A, layouts: [LAYOUT_A, { ...LAYOUT_B, slots: [slot('s_333333', 1, plugin(PLUGIN_A))] }] })
    expect(ruleBlocks(css, `.sdock-slot #${PLUGIN_A}_lsp_main`)).toHaveLength(1)
    expect(ruleBlocks(css, `.sdock-dragging .sdock-slot #${PLUGIN_A}_lsp_main`)).toHaveLength(1)
  })

  it('orders the pids, so the sheet text is a function of the configuration alone', () => {
    const forwards = buildDockCss({ ...ACTIVE_A, layouts: [LAYOUT_A, LAYOUT_B] })
    const backwards = buildDockCss({ ...ACTIVE_A, layouts: [LAYOUT_B, LAYOUT_A] })
    const pidOrder = (css: string): number[] => [css.indexOf(`#${PLUGIN_A}_lsp_main`), css.indexOf(`#${PLUGIN_B}_lsp_main`)]
    expect(pidOrder(forwards)[0]).toBeLessThan(pidOrder(forwards)[1])
    expect(pidOrder(backwards)[0]).toBeLessThan(pidOrder(backwards)[1])
  })

  it('emits nothing hosted for macro-only or empty configurations', () => {
    const css = buildDockCss({
      ...ACTIVE_A,
      layouts: [{ id: 'l_aaaaaa', axis: 'column', slots: [slot('s_111111', 1, macro(':pomo', ':pomo')), slot('s_222222', 1)] }],
    })
    expect(css).not.toContain('_lsp_main')
    // Both slots still get their box and its placeholder styling.
    expect(css).toContain('.sdock-placeholder')
  })

  it('escapes an id that is not a bare CSS identifier', () => {
    expect(buildDockCss({ ...ACTIVE_A, layouts: [{ ...LAYOUT_A, slots: [slot('s_111111', 1, plugin('odd.id'))] }] })).toContain(
      '#odd\\.id_lsp_main',
    )
  })

  it('escapes a leading digit with the CSS hex form, not a backslash', () => {
    // `#2do…` is an invalid selector and would silently drop the whole override block.
    const css = buildDockCss({ ...ACTIVE_A, layouts: [{ ...LAYOUT_A, slots: [slot('s_111111', 1, plugin('2do-plugin'))] }] })
    expect(css).toContain('#\\32 do-plugin_lsp_main')
    expect(css).not.toContain('#2do-plugin_lsp_main')
    expect(buildDockCss({ ...NAV, pluginId: '9dock' })).toContain('#\\39 dock--dock {')
  })

  it('never restyles the geometry of an iframe a provider owns (protocol host rule 6)', () => {
    const css = buildDockCss(ACTIVE_A)
    // The only unscoped iframe rules left are the transient drag passthrough and the neutral-margin
    // carve-out, which undoes the Logseq app's own `iframe { margin: 1rem 0 }` bleed.
    for (const rules of ruleBlocks(css, '.sdock-slot iframe')) {
      expect(rules).toContain('pointer-events: none !important;')
    }
    expect(block(css, '.sdock-slot :where(iframe)')).toBe('  margin: 0;')
    const selectorLines = css.split('\n').filter((line) => line.trim().endsWith('{') || line.trim().endsWith(','))
    expect(selectorLines.some((line) => line.includes(EMBED_OWNER_ATTR))).toBe(false)
  })

  it('suspends pointer events on every docked iframe while a drag is in flight', () => {
    expect(buildDockCss(ACTIVE_A)).toContain('.sdock-dragging .sdock-slot iframe {')
  })

  it('styles the macro wrapper, the placeholder, the diagnostic overlay and its button', () => {
    const css = buildDockCss(ACTIVE_A)
    expect(block(css, '.sdock-slot .sdock-macro')).toContain('overflow-y: auto;')
    expect(block(css, '.sdock-macro [data-injected-ui]')).toContain('width: 100%;')
    expect(block(css, '.sdock-macro iframe')).toContain('width: 100% !important;')
    // Shares the placeholder's centred-column look, then adds its own overlay geometry.
    expect(declarations(css, '.sdock-overlay')).toContain('z-index: 2;')
    expect(declarations(css, '.sdock-overlay')).toContain('justify-content: center;')
    expect(css).toContain('.sdock-action {')
  })
})

describe('buildDockCss — edit mode', () => {
  // Edit mode is not an input to the builder: every rule is gated on the `.sdock-editing` class, so
  // toggling the mode is a class flip on our container and never a re-provide of this sheet.
  const css = buildDockCss(ACTIVE_A)

  it('is present in the sheet unconditionally, with no build-time flag', () => {
    expect(buildDockCss(NAV)).toContain('.sdock-editing .sdock-slot-controls {')
    expect(css).toContain('.sdock-editing .sdock-slot-controls {')
  })

  it('hides the per-slot controls until the class is set', () => {
    expect(block(css, '.sdock-slot-controls')).toBe('  display: none;')
  })

  it('lays the controls OVER the top of the slot, above the diagnostic overlay', () => {
    // In-flow controls would change every mounted view's height the moment edit mode is entered or
    // left, and re-laying out a provider iframe is exactly what the dock exists to avoid.
    const rules = block(css, '.sdock-editing .sdock-slot-controls')
    expect(rules).toContain('position: absolute;')
    expect(rules).toContain('inset: 0 0 auto 0;')
    expect(rules).toContain('z-index: 3;')
  })

  it('keeps the layout-level editbar gated too, and outside the layout roots', () => {
    expect(block(css, '.sdock-editbar')).toBe('  display: none;')
    expect(block(css, '.sdock-editing .sdock-editbar')).toContain('display: flex;')
    // It is a sibling of `.sdock-layouts`, never a child of a layout root — a row-axis layout would
    // otherwise lay the control row out as another column beside the slots.
    expect(css).not.toContain('.sdock-layout .sdock-editbar')
  })

  it('outlines the slot boxes so an empty one can be aimed at', () => {
    expect(block(css, '.sdock-editing .sdock-slot')).toContain('outline: 1px dashed')
  })

  it('styles the controls the panel is built from', () => {
    expect(css).toContain('.sdock-select,\n.sdock-input {')
    expect(block(css, '.sdock-btn-row')).toContain('flex-wrap: wrap;')
    expect(block(css, '.sdock-mini')).toContain('cursor: pointer;')
    // Destructive actions only colour on hover: a red button per slot reads as an error state.
    expect(block(css, '.sdock-mini.is-danger:hover')).toContain('color: #fff;')
    expect(block(css, '.sdock-hint')).toContain('overflow-wrap: anywhere;')
  })
})

describe('buildDockCss — fed from a real configuration', () => {
  it('takes resolved slots straight out of config.ts', () => {
    const config = normalizeConfig({
      layouts: [
        {
          id: 'l_aaaaaa',
          name: 'A',
          axis: 'row',
          slots: [
            { id: 's_111111', weight: 3, source: { kind: 'plugin', pid: PLUGIN_A } },
            { id: 's_222222', weight: '0.5', source: { kind: 'plugin', pid: PLUGIN_A } },
          ],
        },
      ],
    })
    const layouts: readonly ResolvedLayout[] = config.layouts.map((layout) => ({
      id: layout.id,
      axis: layout.axis,
      slots: resolveLayoutSlots(layout),
    }))
    const css = buildDockCss({
      pluginId: 'logseq-sidebar-dock',
      activeTab: 'l_aaaaaa',
      layouts,
      sidebarWidthPx: WIDTH_FOLLOW_HOST,
    })

    expect(css).toContain('flex-grow: var(--sdock-w-s_111111, 3);')
    expect(css).toContain('flex-grow: var(--sdock-w-s_222222, 0.5);')
    // The second slot resolved to `none` (a plugin's view is one node), so the pid appears once.
    expect(ruleBlocks(css, `.sdock-slot #${PLUGIN_A}_lsp_main`)).toHaveLength(1)
    expect(sheetMarker('l_aaaaaa', layouts, WIDTH_FOLLOW_HOST)).toBe(
      '/* sdock-sig tab=l_aaaaaa w=0 | l_aaaaaa:r s_111111=3,s_222222=0.5 */',
    )
  })
})
