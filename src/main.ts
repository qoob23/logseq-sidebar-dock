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
  WIDTH_FOLLOW_HOST,
  WIDTH_MAX,
  WIDTH_MIN,
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
        description:
          'Which face the sidebar shows. The Navigation/Plugins control next to the search button sets this too.',
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
        key: 'macroTop',
        type: 'string',
        default: settings.macroTop,
        title: 'Top macro',
        description:
          'Renderer macro to show in the upper slot, e.g. `{{renderer :pomodoro-timer}}` (the bare ' +
          '`:pomodoro-timer` works too). OVERRIDES "Top view" while it is set. Macros that only ' +
          'render are supported; ones that write back to their block are not, as there is no block. ' +
          'The same macro in both slots only works if its plugin keys its UI by slot.',
      },
      {
        key: 'macroBottom',
        type: 'string',
        default: settings.macroBottom,
        title: 'Bottom macro',
        description:
          'Renderer macro to show in the lower slot, e.g. `{{renderer :pomodoro-timer}}`. OVERRIDES ' +
          '"Bottom view" while it is set. Same limitations: render-only macros, no block writes, and ' +
          'the same macro in both slots only works if its plugin keys its UI by slot.',
      },
      {
        key: 'adoptPoke',
        type: 'string',
        default: settings.adoptPoke,
        title: 'Poke before docking',
        description:
          'For plugins that build their view only when toggled: `plugin-id = models.key; other-id = ' +
          'commands.key` (`;` or newline separated). The listed model/command is invoked to coax the ' +
          'plugin into rendering its main UI, at most once every few seconds per plugin.',
      },
      {
        key: 'splitPct',
        type: 'number',
        default: settings.splitPct,
        title: 'Divider position (%)',
        description: `Share of the dock given to the top view (${SPLIT_MIN}–${SPLIT_MAX}). Also set by dragging the divider.`,
      },
      {
        key: 'sidebarWidthPx',
        type: 'number',
        default: settings.sidebarWidthPx,
        title: 'Sidebar width (px)',
        description:
          `How wide the left sidebar is, on both faces (${WIDTH_MIN}–${WIDTH_MAX}); ` +
          `${WIDTH_FOLLOW_HOST} follows Logseq's own width. Also set by dragging Logseq's sidebar ` +
          "resizer, which ignores Logseq's own 460px limit.",
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
