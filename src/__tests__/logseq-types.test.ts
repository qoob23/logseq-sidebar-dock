import { describe, expect, it } from 'vitest'

import { extractPluginId } from '../logseq-types'

/**
 * Argument shapes verified against the host bundle `resources/js/lsplugin.core.js`:
 * `emit("registered", pluginLocal)`, `emit("reloaded", this)` — the PluginLocal instance;
 * `emit("unregistered", id)`, `emit("enabled", id)`, `emit("disabled", id)`,
 * `emit("unlink-plugin", this.id)` — the bare id string.
 */
describe('extractPluginId', () => {
  it('reads the bare id string that unregistered/enabled/disabled/unlink-plugin emit', () => {
    expect(extractPluginId(['synapses'])).toBe('synapses')
  })

  it('reads the id off the PluginLocal that registered/reloaded emit', () => {
    const pluginLocal = { id: 'synapses', options: { url: '/x' }, settings: {}, caller: {} }
    expect(extractPluginId([pluginLocal])).toBe('synapses')
  })

  it('ignores blank and non-identifying arguments', () => {
    expect(extractPluginId([])).toBeNull()
    expect(extractPluginId(['   '])).toBeNull()
    expect(extractPluginId([{ id: '' }])).toBeNull()
    expect(extractPluginId([{ id: 42 }])).toBeNull()
    expect(extractPluginId([null, undefined, 7, true])).toBeNull()
  })

  it('takes the first identifying argument', () => {
    expect(extractPluginId([undefined, { id: 'a' }, 'b'])).toBe('a')
    expect(extractPluginId([{ noId: 1 }, 'b'])).toBe('b')
  })
})
