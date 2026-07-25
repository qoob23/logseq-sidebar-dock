import { describe, expect, it } from 'vitest'

import {
  type BodyLike,
  EMBED_OWNER_ATTR,
  type ElementLike,
  PROBE_BUDGET_MS,
  PROBE_REPROBE_BUDGET_MS,
  PROTOCOL_VERSION,
  StrategyCache,
  buildEmbedPayload,
  classifySlot,
  droppedByLifecycle,
  embedModelPath,
  embedOwnerSelector,
  hasMeaningfulContent,
  nextStrategyAction,
  probeBudgetMs,
  probeDelays,
  slotElementId,
  strategyFromProbe,
} from '../embed'

describe('protocol addressing', () => {
  it('builds stable slot element ids that are valid CSS idents', () => {
    expect(slotElementId('logseq-sidebar-dock', 's_aaaaaa')).toBe('logseq-sidebar-dock--slot-s_aaaaaa')
    expect(slotElementId('logseq-sidebar-dock', 's_bbbbbb')).toBe('logseq-sidebar-dock--slot-s_bbbbbb')
    expect(slotElementId('a', 's_aaaaaa')).toMatch(/^[a-zA-Z][\w-]*$/)
  })

  it('treats the slot id as an opaque token, so it survives reordering', () => {
    // Slot-element identity is the wipe-vs-eviction discriminator (host rule 4): nothing here may
    // parse or order the id, and two different slots must never share an element id.
    expect(slotElementId('dock', 's_111111')).not.toBe(slotElementId('dock', 's_222222'))
    expect(slotElementId('dock', 's_111111')).toBe(slotElementId('dock', 's_111111'))
  })

  it('addresses the provider models exactly as invokeExternalPlugin expects', () => {
    expect(embedModelPath('synapses', 'embedMount')).toBe('synapses.models.embedMount')
    expect(embedModelPath('synapses', 'embedUnmount')).toBe('synapses.models.embedUnmount')
  })

  it('builds a v1 payload carrying the slot element id and our own id as origin', () => {
    expect(buildEmbedPayload('logseq-sidebar-dock', 'logseq-sidebar-dock--slot-s_aaaaaa')).toEqual({
      slot: 'logseq-sidebar-dock--slot-s_aaaaaa',
      origin: 'logseq-sidebar-dock',
      protocolVersion: PROTOCOL_VERSION,
    })
    expect(PROTOCOL_VERSION).toBe(1)
  })

  it('matches the provider subtree by owner attribute, quoting hostile ids', () => {
    expect(embedOwnerSelector('synapses')).toBe(`[${EMBED_OWNER_ATTR}="synapses"]`)
    expect(embedOwnerSelector('we"ird')).toBe(`[${EMBED_OWNER_ATTR}="we\\"ird"]`)
    expect(embedOwnerSelector('back\\slash')).toBe(`[${EMBED_OWNER_ATTR}="back\\\\slash"]`)
  })
})

describe('classifySlot', () => {
  it('calls a live subtree healthy', () => {
    expect(classifySlot({ sameSlotElement: true, hasEmbedSubtree: true })).toBe('healthy')
  })

  it('treats a re-created slot element as a host wipe, which must be re-mounted', () => {
    expect(classifySlot({ sameSlotElement: false, hasEmbedSubtree: false })).toBe('remount')
    // Even with a subtree present: it belongs to the node we no longer own.
    expect(classifySlot({ sameSlotElement: false, hasEmbedSubtree: true })).toBe('remount')
  })

  it('treats a subtree vanishing from the SAME slot as a provider eviction', () => {
    expect(classifySlot({ sameSlotElement: true, hasEmbedSubtree: false })).toBe('evicted')
  })
})

describe('strategy selection', () => {
  it('probes when nothing is cached and uses the cached outcome afterwards', () => {
    expect(nextStrategyAction(null)).toBe('probe')
    expect(nextStrategyAction('embed')).toBe('use-embed')
    expect(nextStrategyAction('adopt')).toBe('use-adopt')
  })

  it('reads the probe as protocol support', () => {
    expect(strategyFromProbe(true)).toBe('embed')
    expect(strategyFromProbe(false)).toBe('adopt')
  })

  it('caches per plugin id for the session', () => {
    const cache = new StrategyCache()
    expect(cache.action('a')).toBe('probe')

    cache.set('a', strategyFromProbe(true))
    cache.set('b', strategyFromProbe(false))
    expect(cache.action('a')).toBe('use-embed')
    expect(cache.action('b')).toBe('use-adopt')
    expect(cache.get('a')).toBe('embed')
    expect(cache.get('c')).toBeNull()
  })

  it('re-probes one plugin after its lifecycle event, leaving the others cached', () => {
    const cache = new StrategyCache()
    cache.set('a', 'embed')
    cache.set('b', 'adopt')

    cache.invalidate('a')
    expect(cache.action('a')).toBe('probe')
    expect(cache.action('b')).toBe('use-adopt')
  })

  it('re-probes everything when the whole cache is invalidated', () => {
    const cache = new StrategyCache()
    cache.set('a', 'embed')
    cache.set('b', 'adopt')

    cache.invalidate()
    expect(cache.action('a')).toBe('probe')
    expect(cache.action('b')).toBe('probe')
  })
})

describe('probeDelays', () => {
  it('re-invokes several times inside the budget instead of polling a single call', () => {
    // The cold-boot race is the point: one invoke can land before the provider registered its models
    // and is dropped silently, so a probe that only polls would time out on a healthy provider.
    expect(probeDelays(PROBE_BUDGET_MS).length).toBeGreaterThan(5)
  })

  it('backs off from the start delay up to the cap', () => {
    expect(probeDelays(2000, 50, 400)).toEqual([50, 100, 200, 400, 400, 400, 400, 50])
  })

  it('never overruns the budget', () => {
    for (const budget of [1, 137, 1_500, 6_000]) {
      const delays = probeDelays(budget)
      expect(delays.reduce((sum, ms) => sum + ms, 0)).toBe(budget)
      expect(delays.every((ms) => ms > 0)).toBe(true)
    }
  })

  it('gives up immediately on a non-positive budget', () => {
    expect(probeDelays(0)).toEqual([])
    expect(probeDelays(-100)).toEqual([])
  })
})

describe('probe budget', () => {
  it('gives an unknown plugin the full grace period', () => {
    expect(probeBudgetMs(null)).toBe(PROBE_BUDGET_MS)
    expect(PROBE_BUDGET_MS).toBeGreaterThanOrEqual(5_000)
  })

  it('keeps the full budget for a known provider', () => {
    expect(probeBudgetMs('embed')).toBe(PROBE_BUDGET_MS)
  })

  it('shortens the re-probe of a plugin last seen without the protocol', () => {
    // Asserts serialize: a missing provider must not stall each slot for six seconds.
    expect(probeBudgetMs('adopt')).toBe(PROBE_REPROBE_BUDGET_MS)
    expect(PROBE_REPROBE_BUDGET_MS).toBeLessThan(PROBE_BUDGET_MS)
  })

  it('remembers the last known strategy across invalidation, so re-probes stay short', () => {
    const cache = new StrategyCache()
    expect(cache.budgetMs('a')).toBe(PROBE_BUDGET_MS)

    cache.set('a', 'adopt')
    cache.invalidate()
    expect(cache.action('a')).toBe('probe')
    expect(cache.lastStrategy('a')).toBe('adopt')
    expect(cache.budgetMs('a')).toBe(PROBE_REPROBE_BUDGET_MS)
  })
})

describe('droppedByLifecycle', () => {
  const embedMount = { pid: 'provider', strategy: 'embed' } as const
  const adoptMount = { pid: 'provider', strategy: 'adopt' } as const

  it("drops the changed plugin's embed mount, whose dead subtree would read as an eviction", () => {
    expect(droppedByLifecycle(embedMount, 'provider')).toBe(true)
  })

  it('keeps adopt mounts, which heal through their own canonical-node check', () => {
    expect(droppedByLifecycle(adoptMount, 'provider')).toBe(false)
  })

  it('leaves other plugins alone — an unrelated install must not steal an evicted view back', () => {
    expect(droppedByLifecycle(embedMount, 'some-other-plugin')).toBe(false)
    expect(droppedByLifecycle(adoptMount, 'some-other-plugin')).toBe(false)
  })

  it('drops nothing when the event cannot be attributed to a plugin', () => {
    // Host rule 4: never auto-remount after an eviction. An anonymous event is not evidence.
    expect(droppedByLifecycle(embedMount, null)).toBe(false)
    expect(droppedByLifecycle(adoptMount, null)).toBe(false)
  })
})

describe('hasMeaningfulContent', () => {
  const el = (tagName: string, extra: Partial<ElementLike> = {}): ElementLike => ({
    tagName,
    childElementCount: 0,
    textContent: '',
    ...extra,
  })
  const body = (...children: ElementLike[]): BodyLike => ({ children })

  it('is false for an unreadable or empty body', () => {
    expect(hasMeaningfulContent(null)).toBe(false)
    expect(hasMeaningfulContent(body())).toBe(false)
  })

  it('is false for a booted-but-blank plugin: scripts plus an empty mount point', () => {
    expect(hasMeaningfulContent(body(el('SCRIPT', { textContent: 'var x = 1' }), el('DIV')))).toBe(false)
    expect(hasMeaningfulContent(body(el('STYLE', { textContent: '.a{}' }), el('LINK'), el('META')))).toBe(false)
  })

  it('is true once the mount point actually has children or text', () => {
    expect(hasMeaningfulContent(body(el('DIV', { childElementCount: 3 })))).toBe(true)
    expect(hasMeaningfulContent(body(el('DIV', { textContent: '  Hello  ' })))).toBe(true)
  })

  it('ignores whitespace-only text', () => {
    expect(hasMeaningfulContent(body(el('DIV', { textContent: '   \n\t ' })))).toBe(false)
  })

  it('counts self-contained visual leaves that have neither children nor text', () => {
    expect(hasMeaningfulContent(body(el('CANVAS')))).toBe(true)
    expect(hasMeaningfulContent(body(el('iframe')))).toBe(true)
    expect(hasMeaningfulContent(body(el('BUTTON')))).toBe(true)
  })
})
