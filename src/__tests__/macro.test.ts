import { describe, expect, it } from 'vitest'

import { slotElementId } from '../embed'
import { MACRO_HOOK_TYPE, buildMacroHookPayload, macroSlotDomId, parseMacroSpec } from '../macro'

describe('parseMacroSpec', () => {
  it('accepts the block form a user copies straight out of a page', () => {
    expect(parseMacroSpec('{{renderer :pomodoro}}')).toEqual([':pomodoro'])
    expect(parseMacroSpec('{{renderer :pomodoro, 25, work}}')).toEqual([':pomodoro', '25', 'work'])
  })

  it('accepts the bare argument list just as well', () => {
    expect(parseMacroSpec(':pomodoro')).toEqual([':pomodoro'])
    expect(parseMacroSpec(':pomodoro, 25')).toEqual([':pomodoro', '25'])
  })

  it('trims the wrapper, the keyword and every argument', () => {
    expect(parseMacroSpec('  {{  renderer   :pomodoro ,  25  }}  ')).toEqual([':pomodoro', '25'])
  })

  it('drops empty arguments left by stray commas', () => {
    expect(parseMacroSpec(':pomodoro,,25,')).toEqual([':pomodoro', '25'])
  })

  it('only strips `renderer` as a standalone keyword', () => {
    // A renderer key that merely starts with the word is an argument, not the keyword.
    expect(parseMacroSpec('renderer-thing')).toEqual(['renderer-thing'])
    expect(parseMacroSpec(':renderer')).toEqual([':renderer'])
  })

  it('rejects a spec that carries no arguments at all', () => {
    expect(parseMacroSpec('')).toBeNull()
    expect(parseMacroSpec('   ')).toBeNull()
    expect(parseMacroSpec('{{}}')).toBeNull()
    expect(parseMacroSpec('{{renderer}}')).toBeNull()
    expect(parseMacroSpec('renderer')).toBeNull()
    expect(parseMacroSpec(', ,')).toBeNull()
  })

  it('leaves an unbalanced wrapper in place rather than mangling it', () => {
    expect(parseMacroSpec('{{renderer :pomodoro')).toEqual(['{{renderer :pomodoro'])
  })
})

describe('macroSlotDomId', () => {
  it('builds a stable id per slot, so a re-emitted hook updates in place', () => {
    // Stable across config edits because it is built from the slot's own id, never its position: a
    // second injected element would otherwise stack up beside the first on every re-emission.
    expect(macroSlotDomId('logseq-sidebar-dock', 's_aaaaaa')).toBe('logseq-sidebar-dock--macro-s_aaaaaa')
    expect(macroSlotDomId('logseq-sidebar-dock', 's_bbbbbb')).toBe('logseq-sidebar-dock--macro-s_bbbbbb')
  })

  it('stays a bare CSS ident for a well-formed plugin id', () => {
    expect(macroSlotDomId('a', 's_aaaaaa')).toMatch(/^[a-zA-Z][\w-]*$/)
  })

  it('never collides with the embed slot element id of the same slot', () => {
    expect(macroSlotDomId('dock', 's_aaaaaa')).not.toBe(slotElementId('dock', 's_aaaaaa'))
  })

  it('gives distinct slots distinct wrappers', () => {
    expect(macroSlotDomId('dock', 's_111111')).not.toBe(macroSlotDomId('dock', 's_222222'))
  })
})

describe('buildMacroHookPayload', () => {
  it('mirrors the payload the host emits for a real renderer macro', () => {
    expect(buildMacroHookPayload('dock--macro-s_aaaaaa', [':pomodoro', '25'])).toEqual({
      type: 'macro-renderer-slotted',
      slot: 'dock--macro-s_aaaaaa',
      payload: { name: 'renderer', arguments: [':pomodoro', '25'], uuid: '' },
    })
  })

  it('names the hook the host itself uses', () => {
    expect(MACRO_HOOK_TYPE).toBe('macro-renderer-slotted')
  })

  it('carries an empty uuid: there is no block behind our macro (documented limitation)', () => {
    expect(buildMacroHookPayload('dock--macro-s_aaaaaa', [':x']).payload.uuid).toBe('')
  })
})
