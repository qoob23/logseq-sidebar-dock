/** Plugin entry: settings schema, host-echo wiring, dock lifecycle. */

import '@logseq/libs'

import { Dock } from './dock'
import { getInstalledPluginIds } from './logseq-types'
import {
  DOCK_MAX,
  DOCK_MIN,
  NO_VIEW,
  SPLIT_MAX,
  SPLIT_MIN,
  SettingsStore,
  settingsDiffer,
} from './settings'

function main(): void {
  const pluginId = logseq.baseInfo.id
  const store = new SettingsStore(logseq.settings)

  /**
   * (Re)publish the settings schema. The plugin list is only complete once every other plugin has
   * registered, which races our own startup — so this re-runs on host plugin-registry events. Every
   * `default` is the CURRENT effective value, so re-publishing can never reset a selection, and the
   * current selections stay in `enumChoices` even if their plugin went away.
   */
  const applySchema = (): void => {
    const settings = store.current()
    const choices = [
      ...new Set([NO_VIEW, ...getInstalledPluginIds(pluginId), settings.viewTop, settings.viewBottom]),
    ]

    logseq.useSettingsSchema([
      {
        key: 'viewTop',
        type: 'enum',
        default: settings.viewTop,
        title: 'Top view',
        description: "Plugin whose main UI is docked in the dock's upper slot.",
        enumChoices: choices,
        enumPicker: 'select',
      },
      {
        key: 'viewBottom',
        type: 'enum',
        default: settings.viewBottom,
        title: 'Bottom view',
        description: "Plugin whose main UI is docked in the dock's lower slot.",
        enumChoices: choices,
        enumPicker: 'select',
      },
      {
        key: 'splitPct',
        type: 'number',
        default: settings.splitPct,
        title: 'Divider position (%)',
        description: `Share of the dock given to the top view (${SPLIT_MIN}–${SPLIT_MAX}). Also set by dragging the divider.`,
      },
      {
        key: 'dockPct',
        type: 'number',
        default: settings.dockPct,
        title: 'Dock height (%)',
        description: `Share of the left sidebar given to the whole dock (${DOCK_MIN}–${DOCK_MAX}).`,
      },
    ])
  }

  applySchema()

  const dock = new Dock(pluginId, store, applySchema)

  // `updateSettings` is fire-and-forget; this echo (~0.5–1s later) is the authoritative base.
  logseq.onSettingsChanged<unknown>((next) => {
    const before = store.current()
    store.applyEcho(next)
    if (settingsDiffer(before, store.current())) void dock.assert()
  })

  logseq.beforeunload(() => {
    dock.dispose()
    return Promise.resolve()
  })

  void dock.start()
}

logseq.ready(main).catch((err: unknown) => {
  console.error('[sidebar-dock] failed to start', err)
})
