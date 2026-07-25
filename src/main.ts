/** Plugin entry: settings schema, host-echo wiring, dock lifecycle. */

import '@logseq/libs'

import { Dock, reclaimModel } from './dock'
import { getInstalledPluginIds } from './logseq-types'
import {
  DOCK_MODES,
  type DockMode,
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
        key: 'mode',
        type: 'enum',
        default: settings.mode,
        title: 'Sidebar face',
        description: 'Which face the sidebar shows. The Nav/Views control at the top of the sidebar sets this too.',
        enumChoices: [...DOCK_MODES],
        enumPicker: 'radio',
      },
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
    ])
  }

  applySchema()

  const dock = new Dock(pluginId, store, applySchema)

  /**
   * Flip the sidebar face. The override repaints immediately; `updateSettings` only catches the
   * persisted value up ~0.5–1s later, and its echo then agrees with the override and drops it.
   */
  const setMode = (mode: DockMode): void => {
    if (store.current().mode === mode) return
    store.override({ mode })
    dock.refreshStyle()
    logseq.updateSettings({ mode })
    // Revealing the views: re-assert so a stale placeholder (missing-view watch expired, or the plugin
    // showed up without a lifecycle event) heals on the flip instead of staying wrong until reload.
    if (mode === 'views') void dock.assert()
  }

  // Registered BEFORE the container is injected: `provideUI`'s delegation resolves `data-on-click`
  // against this model.
  logseq.provideModel({
    sdockShowNav: () => {
      setMode('nav')
    },
    sdockShowViews: () => {
      setMode('views')
    },
    // Explicit user intent to take an evicted embed back — the only re-mount the protocol allows
    // after a provider moved the view to another surface.
    [reclaimModel('top')]: () => {
      dock.reclaim('top')
    },
    [reclaimModel('bottom')]: () => {
      dock.reclaim('bottom')
    },
  })

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
