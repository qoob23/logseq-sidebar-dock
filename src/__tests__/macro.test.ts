import { describe, expect, it } from 'vitest'

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
    expect(macroSlotDomId('logseq-sidebar-dock', 'top')).toBe('logseq-sidebar-dock--macro-top')
    expect(macroSlotDomId('logseq-sidebar-dock', 'bottom')).toBe('logseq-sidebar-dock--macro-bottom')
  })

  it('stays a bare CSS ident for a well-formed plugin id', () => {
    expect(macroSlotDomId('a', 'top')).toMatch(/^[a-zA-Z][\w-]*$/)
  })

  it('never collides with the embed slot ids', () => {
    expect(macroSlotDomId('dock', 'top')).not.toBe('dock--slot-top')
  })
})

describe('buildMacroHookPayload', () => {
  it('mirrors the payload the host emits for a real renderer macro', () => {
    expect(buildMacroHookPayload('dock--macro-top', [':pomodoro', '25'])).toEqual({
      type: 'macro-renderer-slotted',
      slot: 'dock--macro-top',
      payload: { name: 'renderer', arguments: [':pomodoro', '25'], uuid: '' },
    })
  })

  it('names the hook the host itself uses', () => {
    expect(MACRO_HOOK_TYPE).toBe('macro-renderer-slotted')
  })

  it('carries an empty uuid: there is no block behind our macro (documented v1 limitation)', () => {
    expect(buildMacroHookPayload('dock--macro-top', [':x']).payload.uuid).toBe('')
  })
})
