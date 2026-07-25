import { describe, expect, it } from 'vitest'

import { type ResolvedSlot, type ViewSpec, normalizeConfig, resolveLayoutSlots } from '../config'
// The floor the sheet emits is owned by `divider.ts` — one constant, both sides.
import { SLOT_MIN_PX } from '../divider'
import { EMBED_OWNER_ATTR } from '../embed'
import { type DockCssOptions, type ResolvedLayout, buildDockCss, sheetMarker, slotWeightVar } from '../styles'

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

const NAV: DockCssOptions = { pluginId: 'logseq-sidebar-dock', activeTab: 'nav', layouts: [LAYOUT_A, LAYOUT_B] }
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
  it('encodes the tab, every layout, its axis and every baked weight', () => {
    expect(sheetMarker('l_aaaaaa', [LAYOUT_A, LAYOUT_B])).toBe(
      '/* sdock-sig tab=l_aaaaaa | l_aaaaaa:c s_111111=2,s_222222=1 | l_bbbbbb:r s_333333=1.5,s_444444=1 */',
    )
  })

  it('is the second line of the sheet, so the dock can poll the host for it', () => {
    // `provideStyle` is fire-and-forget over postMessage: a `<style>` containing this exact string is
    // the ONLY proof the new sheet has landed, and the drag's inline vars may not be dropped before it.
    for (const opts of [NAV, ACTIVE_A, ACTIVE_B]) {
      const marker = sheetMarker(opts.activeTab, opts.layouts)
      expect(buildDockCss(opts).split('\n')[1]).toBe(marker)
      expect(buildDockCss(opts)).toContain(marker)
    }
  })

  it('changes on everything a re-provide could change about the geometry', () => {
    const base = sheetMarker('l_aaaaaa', [LAYOUT_A, LAYOUT_B])
    const variants = [
      sheetMarker('nav', [LAYOUT_A, LAYOUT_B]),
      sheetMarker('l_bbbbbb', [LAYOUT_A, LAYOUT_B]),
      sheetMarker('l_aaaaaa', [{ ...LAYOUT_A, axis: 'row' }, LAYOUT_B]),
      sheetMarker('l_aaaaaa', [{ ...LAYOUT_A, slots: [slot('s_111111', 2.5), slot('s_222222', 1)] }, LAYOUT_B]),
      sheetMarker('l_aaaaaa', [{ ...LAYOUT_A, slots: [slot('s_111111', 2)] }, LAYOUT_B]),
      sheetMarker('l_aaaaaa', [LAYOUT_A]),
      sheetMarker('l_aaaaaa', []),
    ]
    for (const variant of variants) expect(variant).not.toBe(base)
    expect(new Set(variants).size).toBe(variants.length)
  })

  it('is insensitive to nothing else — the same inputs give the same string', () => {
    expect(sheetMarker('l_aaaaaa', [LAYOUT_A])).toBe(sheetMarker('l_aaaaaa', [{ ...LAYOUT_A }]))
  })

  it('strips a hostile tab, and never lets one truncate the sheet at a comment close', () => {
    const hostile: DockCssOptions = { ...NAV, activeTab: 'l_a*/ } body { display: none } /*' }
    const css = buildDockCss(hostile)
    expect(sheetMarker(hostile.activeTab, hostile.layouts)).toBe(
      `/* sdock-sig tab=l_abodydisplaynone | l_aaaaaa:c s_111111=2,s_222222=1 | l_bbbbbb:r s_333333=1.5,s_444444=1 */`,
    )
    expect(css).not.toContain('*/ } body')
    // Stripped identically in the marker and in the active-chip selector, so garbage matches nothing.
    expect(css).toContain(".sdock-tab[data-tab='l_abodydisplaynone']")
    expect(css.split('\n')[1]).toBe(sheetMarker(hostile.activeTab, hostile.layouts))
  })

  it('substitutes 1 for a non-finite weight, in the marker as in the rule', () => {
    // NaN in `flex-grow` is an invalid value and would collapse the slot.
    const broken: ResolvedLayout = { ...LAYOUT_A, slots: [slot('s_111111', Number.NaN)] }
    expect(sheetMarker('nav', [broken])).toContain('s_111111=1')
    expect(buildDockCss({ ...NAV, layouts: [broken] })).toContain(`flex-grow: var(${slotWeightVar('s_111111')}, 1);`)
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

  it('nav face: the dock shrinks to its tab strip and the stock navigation is untouched', () => {
    const css = buildDockCss(NAV)
    // Two rules address the container: the always-on one (we are appended last but belong at the top
    // of the column) and the face rule that sizes it.
    expect(declarations(css, `#logseq-sidebar-dock--dock`)).toContain('order: -1;')
    expect(declarations(css, `#logseq-sidebar-dock--dock`)).toContain('flex: 0 0 auto;')
    expect(declarations(buildDockCss(ACTIVE_A), `#logseq-sidebar-dock--dock`)).toContain('flex: 1 1 auto;')
    expect(css).toContain('#logseq-sidebar-dock--dock .sdock-layouts,\n#logseq-sidebar-dock--dock .sdock-editbar {\n  display: none;\n}')
    for (const selector of HOST_NAV_SELECTORS) expect(css).not.toContain(selector)
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
    expect(buildDockCss(NAV)).toContain('flex: 0 1 auto;')
    expect(block(buildDockCss(NAV), '.sdock-tabs')).toContain('flex-wrap: wrap;')
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
    const css = buildDockCss({ pluginId: 'logseq-sidebar-dock', activeTab: 'l_aaaaaa', layouts })

    expect(css).toContain('flex-grow: var(--sdock-w-s_111111, 3);')
    expect(css).toContain('flex-grow: var(--sdock-w-s_222222, 0.5);')
    // The second slot resolved to `none` (a plugin's view is one node), so the pid appears once.
    expect(ruleBlocks(css, `.sdock-slot #${PLUGIN_A}_lsp_main`)).toHaveLength(1)
    expect(sheetMarker('l_aaaaaa', layouts)).toBe('/* sdock-sig tab=l_aaaaaa | l_aaaaaa:r s_111111=3,s_222222=0.5 */')
  })
})
