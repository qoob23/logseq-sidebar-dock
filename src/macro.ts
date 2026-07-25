/**
 * Macro slots — pure logic for filling a dock slot with a `{{renderer ...}}` macro.
 *
 * The trick this file encodes: when the host renders a renderer macro it drops an empty
 * `<div class="lsp-hook-ui-slot" id="slot__<rand8>">` into the page and, ~50ms later, broadcasts
 * `LSPluginCore.hookApp('macro-renderer-slotted', { type, slot, payload })` to every plugin that
 * installed the hook. A plugin answers with `logseq.provideUI({ slot, template, key })`, and the host's
 * `setupInjectedUI` resolves that slot with a plain `document.querySelector('#' + slot)` against the
 * HOST document — it never checks that the element is one of its own. So a slot element WE own, named
 * in a hook payload WE emit, gets the macro rendered into it, with the responder's `data-on-*` model
 * delegation bound as usual.
 *
 * The one thing we cannot fake is the block behind the macro: `uuid` is empty (there is no backing
 * block), so render-only macros work and macros that write back to their block may not. That is a
 * documented v1 limitation, not an oversight.
 *
 * No DOM and no `@logseq/libs` here — the parser, the ids and the payload are unit-testable; the
 * emission and the wrapper element live in `dock.ts`.
 */

import { type SlotName } from './embed'

/** The `hookApp` event the host itself uses for renderer macros; we re-emit it verbatim. */
export const MACRO_HOOK_TYPE = 'macro-renderer-slotted'

/** Every renderer macro's hook payload carries this as its `name`. */
const MACRO_HOOK_NAME = 'renderer'

/** The block-uuid slot of the payload. See the file header: we have no backing block. */
const MACRO_NO_BLOCK = ''

export interface MacroHookPayload {
  type: typeof MACRO_HOOK_TYPE
  /** DOM id of the element the responder is expected to render into. */
  slot: string
  payload: {
    name: typeof MACRO_HOOK_NAME
    /** The macro's comma-split arguments, first one being the renderer key (`:pomodoro`). */
    arguments: readonly string[]
    uuid: string
  }
}

/**
 * Parse a user-typed macro spec into the arguments the host would have handed the responder.
 *
 * Both the copy-pasted block form (`{{renderer :pomodoro, 25}}`) and the bare argument list
 * (`:pomodoro, 25`) are accepted, because both are what a user has at hand. Arguments containing
 * commas are out of scope — the host splits on commas too, with no quoting.
 *
 * Returns `null` for a spec that would produce no arguments at all: an empty argument list makes the
 * hook meaningless (no responder can match it), so the slot must say so rather than silently show
 * nothing.
 */
export function parseMacroSpec(raw: string): readonly string[] | null {
  let text = raw.trim()
  if (text.length >= 4 && text.startsWith('{{') && text.endsWith('}}')) {
    text = text.slice(2, -2).trim()
  }
  // Only the standalone leading word: `renderer-foo` is an argument, not the macro keyword.
  text = text.replace(/^renderer(?:\s+|$)/, '')

  const args = text
    .split(',')
    .map((arg) => arg.trim())
    .filter((arg) => arg !== '')
  return args.length === 0 ? null : args
}

/**
 * DOM id of the wrapper a macro slot renders into. Stable (so a re-emitted hook updates the same
 * injected element in place instead of stacking a second one) and a bare CSS ident for well-formed
 * plugin ids — same assumption as `slotElementId`.
 */
export function macroSlotDomId(hostPid: string, slot: SlotName): string {
  return `${hostPid}--macro-${slot}`
}

/** The `hookApp` payload, shaped exactly like the one the host emits for a real renderer macro. */
export function buildMacroHookPayload(domId: string, args: readonly string[]): MacroHookPayload {
  return {
    type: MACRO_HOOK_TYPE,
    slot: domId,
    payload: { name: MACRO_HOOK_NAME, arguments: args, uuid: MACRO_NO_BLOCK },
  }
}
