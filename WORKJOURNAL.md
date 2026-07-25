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
- Two render paths for non-protocol plugins, host mechanics verified against the og source first:
    - **Macro slots** (`macroTop`/`macroBottom`, override the slot's plugin pick): impersonate the host's
      `hook-ui-slot` — own wrapper div, `LSPluginCore.hookApp('macro-renderer-slotted')` re-emitted with backoff
      (a broadcast before the provider installs its hook is dropped; the host itself re-emits every render).
    - Wrapper teardown mirrors the host: `_forceCleanInjectedUI` per injected element before removal (plain
      removal leaks the libs-side teardown closure); stale same-id wrappers from a crashed life reaped pre-mount.
    - Specs nobody answered re-probe on the short budget (asserts serialize — a missing provider must not stall
      each one 6s); hook `uuid` sent empty: render-only macros work, block-writing ones are out of scope.
    - **Poke-then-adopt** (`adoptPoke`: `pid = models.key` / `commands.key`): `invokeExternalPlugin` coaxes
      plugins that only build `_lsp_main` once toggled. Flap-proof: once per missing episode + once per adopted
      mount + 5s cooldown, counting only pokes that fired; `configSignature` over the PARSED config (order- and
      format-insensitive) retires both memories on real edits only.
    - Slot specs resolve macro > plugin > none; an invalid macro keeps its slot (own placeholder), never a
      silent fallback; blank patches must clear the new string settings (unlike the view enums).
- Debugged "synapses shifted 16px down, clipped at bottom" in the full-height slot: dock geometry measured
  exact; culprit is Logseq's own `iframe { width:100%; margin:1rem 0 }` (common.css) bleeding into the frame.
    - **Decision — the dock neutralizes host-app bleed; provider CSS stays theirs**: `.sdock-slot
      :where(iframe) { margin: 0 }` at bare slot specificity, so any scoped provider rule outranks it and
      wanted margins survive. Protocol host rule 6 gains the matching neutral-environment carve-out.
- Segmented control moved out of the dock container into the app header's left cell (`.cp__header > .l` — the
  row already carrying the sidebar toggle and search button), as its own `provideUI` key `tabs`.
    - **Decision — a second injection, not CSS repositioning**: the two rows belong to different host components,
      so each gets its own health check and re-assert; a missing header cell falls back to the sidebar column.
    - `setupInjectedUI` only rewrites an existing `#<id>`'s innerHTML and never moves it, so a misplaced container
      is force-cleaned AND then removed by hand — its host teardown targets the creation-time parent and its
      return value describes the call, not the node; believing it would leave the placement stuck forever.
    - Nav mode hides the whole dock container now that the tabs left it; `-webkit-app-region: no-drag` is
      load-bearing (the header is a drag region, host exempts only `a`/`svg`/`button`), and the control hides
      itself via `main:not(.ls-left-sidebar-open)` — a closed sidebar has no face to switch.
- Tab labels renamed Nav → Navigation, Views → Plugins (labels only: persisted mode values stay `nav`/`views`);
  they ellipsize, since the header cell is only as wide as the user's sidebar.
- Lifecycle drops now also purge the changed pid's `[data-embed-owner]` husk from the slot (record taken first,
  so the silenced watcher cannot misread the purge as an eviction): a crashed provider's husk would satisfy the
  next probe and be committed as a healthy dead pane never re-probed. Well-behaved providers sweep themselves on
  `beforeunload` (tag-cloud does); this covers the killed-outright case. Scoping unchanged — only the event's pid.
