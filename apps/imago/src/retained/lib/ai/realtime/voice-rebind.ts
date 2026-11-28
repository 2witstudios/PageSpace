/**
 * How the agent switcher moves a LIVE call to a different agent.
 *
 * THE WHOLE PROBLEM IN ONE PARAGRAPH. Two things change the target the UI would
 * compute: walking to another page, and choosing another agent. They must have
 * opposite effects — navigating leaves the call alone (it only updates
 * `locationContext`), switching rebinds it — and yet a naive "watch the derived
 * target and call `start` when it changes" cannot tell them apart, because both
 * arrive as the same state change. That effect is the single most likely wrong
 * implementation of this feature, and it hangs up the user's call every time
 * they open a page.
 *
 * So a rebind is driven by the SWITCH EVENT, never by the derived target. The
 * switcher records an INTENT — "this call should be talking to agent X" — and
 * this module decides, on each subsequent render, whether the app has caught up
 * enough to act on it. Navigation records no intent, so navigation can never
 * produce a rebind no matter what it does to the derived target.
 *
 * WHY THE INTENT HAS TO WAIT AT ALL. `selectAgent` clears the conversation id
 * and re-resolves it asynchronously (`usePageAgentSidebarState` loads the most
 * recent conversation, or creates one). There is no target to rebind to at the
 * moment of the click, so acting immediately would either bind to the OLD
 * conversation or bind to nothing. The intent is what carries the user's
 * decision across that gap.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

import type { VoiceTarget } from './voice-target';
import type { VoiceBinding } from './voice-binding';

/**
 * `agentPageId: null` is a real intent, not the absence of one — it is "switch
 * this call to the global assistant", which the switcher expresses by selecting
 * no agent. The absence of an intent is `{ kind: 'none' }`.
 */
export type RebindIntent =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly agentPageId: string | null };

export const NO_REBIND_INTENT: RebindIntent = { kind: 'none' };

export type RebindAction =
  /** Nothing to do yet — either no intent, or the app has not caught up. */
  | { readonly kind: 'wait' }
  /** Drop the intent: there is no live call for it to move. */
  | { readonly kind: 'clear' }
  /** Bind the live session to this target, then drop the intent. */
  | { readonly kind: 'rebind'; readonly target: VoiceTarget };

const WAIT: RebindAction = { kind: 'wait' };
const CLEAR: RebindAction = { kind: 'clear' };

/** Which agent a target addresses; `null` for the global assistant. */
const agentOf = (target: VoiceTarget): string | null => target.agentPageId ?? null;

export const rebindAction = (
  intent: RebindIntent,
  binding: VoiceBinding,
  callIsLive: boolean,
): RebindAction => {
  if (intent.kind === 'none') return WAIT;

  // A switch made with nothing running needs no rebind: the next press of the
  // trigger binds to the new selection by the ordinary path. Holding the intent
  // would make a later, unrelated press behave as though the user had asked for
  // something they asked for minutes ago.
  if (!callIsLive) return CLEAR;

  // The conversation for the newly chosen agent has not resolved yet. Waiting
  // is correct and self-healing; guessing is not.
  if (binding.kind === 'resolving') return WAIT;

  // The surface is showing someone other than who was chosen — the user
  // navigated before the switch resolved. Still pending, still not a reason to
  // move the call somewhere nobody asked for.
  if (agentOf(binding.target) !== intent.agentPageId) return WAIT;

  return { kind: 'rebind', target: binding.target };
};
