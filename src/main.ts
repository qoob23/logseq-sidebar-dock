/** Plugin entry: settings schema, model registration, host-echo wiring, dock lifecycle. */

import '@logseq/libs'

import { Dock, MODELS, type ModelEvent, eventData, eventValue } from './dock'
import { SettingsStore, settingsDiffer } from './settings'

function main(): void {
  const pluginId = logseq.baseInfo.id
  const store = new SettingsStore(logseq.settings)

  /**
   * (Re)publish the settings schema.
   *
   * Three flat keys, all of them strings: the layout model is far too structured for
   * `useSettingsSchema` (which has no array or nested-object input), so the whole configuration lives
   * in `layouts` as canonical JSON and the dock's own edit mode is the editor. This panel is the
   * escape hatch — for reading the JSON, copying it between graphs, or fixing something the UI cannot.
   *
   * Every `default` is the CURRENT effective value, so re-publishing can never reset a setting. It
   * re-runs on host plugin-registry events because the schema is published once per session otherwise
   * and would go on showing the values our own startup happened to see.
   */
  const applySchema = (): void => {
    const settings = store.current()

    logseq.useSettingsSchema([
      {
        key: 'layouts',
        type: 'string',
        default: settings.layouts,
        title: 'Layouts (raw JSON)',
        description:
          'Canonical JSON of every tab, slot and weight. **Edit this from the sidebar instead** — the ' +
          'gear in the dock\'s tab strip adds tabs and slots, picks views and renames things, and the ' +
          'divider between slots is draggable. Kept here to be read, copied between graphs or repaired ' +
          'by hand. While the text does not parse, the dock keeps showing the last version that did ' +
          'and refuses every edit, so a typo cannot cost you the configuration.',
        inputAs: 'textarea',
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
        key: 'activeTab',
        type: 'string',
        default: settings.activeTab,
        title: 'Active tab',
        description:
          '`nav` for the stock navigation, or a layout id. Set by clicking a tab at the top of the ' +
          'sidebar; a value naming no layout falls back to the navigation.',
      },
    ])
  }

  applySchema()

  const dock = new Dock(pluginId, store, applySchema)

  /**
   * Every control the dock builds carries its target in `data-*` and reaches us through the host's own
   * `setupInjectedUI` delegation, which hands the model `{ type, value, id, className, dataset }` and
   * NO element reference (`transformableEvent`, `libs/src/helpers.ts`). Hence one model per action with
   * the slot or layout id in its dataset, rather than one pre-registered model name per slot — with
   * slots created at runtime the latter is not expressible.
   *
   * Registered BEFORE the container is injected: the delegation resolves `data-on-<event>` against
   * these names at event time, but a click on a freshly injected control must not find nothing.
   */
  logseq.provideModel({
    [MODELS.selectTab]: (e: ModelEvent) => {
      dock.selectTab(eventData(e, 'tab'))
    },
    // Explicit user intent to take an evicted embed back — the only re-mount the protocol allows
    // after a provider moved the view to another surface.
    [MODELS.reclaim]: (e: ModelEvent) => {
      dock.reclaim(eventData(e, 'slotId'))
    },
    [MODELS.toggleEdit]: () => {
      dock.toggleEdit()
    },
    [MODELS.addLayout]: () => {
      dock.addLayout()
    },
    [MODELS.removeLayout]: (e: ModelEvent) => {
      dock.removeLayout(eventData(e, 'layoutId'))
    },
    [MODELS.renameLayout]: (e: ModelEvent) => {
      dock.renameLayout(eventData(e, 'layoutId'), eventValue(e))
    },
    [MODELS.toggleAxis]: (e: ModelEvent) => {
      dock.toggleAxis(eventData(e, 'layoutId'))
    },
    [MODELS.addSlot]: (e: ModelEvent) => {
      dock.addSlot(eventData(e, 'layoutId'))
    },
    [MODELS.removeSlot]: (e: ModelEvent) => {
      dock.removeSlot(eventData(e, 'slotId'))
    },
    [MODELS.moveSlot]: (e: ModelEvent) => {
      dock.moveSlot(eventData(e, 'slotId'), eventData(e, 'dir'))
    },
    [MODELS.pickSource]: (e: ModelEvent) => {
      dock.pickSource(eventData(e, 'slotId'), eventValue(e))
    },
    [MODELS.setMacro]: (e: ModelEvent) => {
      dock.setMacro(eventData(e, 'slotId'), eventValue(e))
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
