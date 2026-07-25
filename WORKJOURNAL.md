# Work journal

## 2026-07-25

- Scaffolded (vite, strict TS + verbatimModuleSyntax, type-aware eslint, vitest) and shipped the MVP: dock pane
  injected into the left sidebar `.wrap` via keyed `provideUI`; ALL persistent layout in one keyed `provideStyle`
  sheet (host re-renders wipe everything else); MutationObserver + route + plugin-lifecycle re-assertion; hosted
  views by adopting `#<pid>_lsp_main`; drag divider persisting `--sdock-split` to settings.
    - **Decision — adopted nodes are released by mode (`swap`/`wipe`)**: a superseded or host-destroyed container
      is dropped, never re-appended — re-appending a `.visible` husk creates an invisible click-blocking overlay.
    - Capture-phase drag passthrough (class-toggled `pointer-events` rules) — mandatory next to hosted iframes.
- Replaced the squeezed nav+dock layout with a Nav/Views segmented control: tabs render first via `order:-1`
  (single injection point), clicks via `provideModel` + the host's container-level delegation, `mode` persisted
  behind the settings echo-lag override store; hosted iframes stay mounted across flips (`display:none` only).
  Dropped the obsolete `dockPct` setting.
- Specified **Embed Protocol v1** (`docs/embed-protocol.md`) and implemented the host side: per-plugin strategy
  chain — `embedMount` probe → main-UI adoption → placeholder.
    - **Decision — providers own iframe creation**; nothing is ever re-parented, so provider backends never
      reload (re-parenting a live iframe reboots it — fatal for stateful providers like synapses).
    - `embedMount` is re-invoked on every poll tick — host model dispatch has no queueing, so a one-shot invoke
      loses the provider cold-boot race and mis-caches the strategy as `adopt`.
    - Wipe vs eviction split on slot-element identity; evicted → Reclaim placeholder (steal-back requires user
      intent); lifecycle drops/invalidations scoped to the emitting pid — anonymous events drop nothing.
    - Adopted plugins with an empty main document get a reversible diagnostic overlay (no undock → no reload).
- Slot layout now derives from configured views: one view → full-height slot, none → lone placeholder slot;
  divider hidden (inert) outside the two-view layout; `splitPct` preserved untouched.
