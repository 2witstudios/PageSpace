/**
 * What the call chrome SAYS, as a pure function of what the session is doing.
 *
 * Two surfaces render this — the nav-bar trigger, which is on every route, and
 * the call header on the chat surface — and they must never disagree about
 * whether a call is live. Deriving both from one function is what makes that
 * structural rather than a matter of keeping two `cn(...)` ladders in step.
 *
 * THE DISTINCTION THIS FILE REFUSES TO FLATTEN. "Voice didn't start" is not one
 * outcome. A refused permission prompt is fixable by the user in about four
 * seconds; an absent capture device is not fixable at all until they plug
 * something in, and a browser with no `getUserMedia` is not fixable by them
 * ever. `classifyMicFailure` already draws those lines and `connect.ts` already
 * carries the classification out as `mic-denied` / `mic-missing` /
 * `mic-unsupported` / `mic-busy`; this module is where that reaches the screen,
 * as the difference between a Try again button and no Try again button. A retry
 * affordance offered for a missing microphone is a button that is guaranteed to
 * fail, which teaches the user that voice is broken rather than that their
 * hardware is absent.
 *
 * THE OTHER DISTINCTION: `attached` false is a WORKING audio call. The model
 * hears you and answers. What it has not got is tools, transcript persistence
 * and metering — so nothing said in it will be in the thread afterwards, which
 * is the one promise voice makes. That earns its own state and its own
 * sentence, never a silent downgrade dressed as a normal call.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

import type { ConnectionStatus } from './session-state';
import type { VoiceConnectFailure } from './connect';

export type CallChromeState =
  /** Nothing running. The trigger is an invitation. */
  | 'idle'
  /** Negotiating. The microphone may already be open. */
  | 'connecting'
  /** Live, attached, fully capable. */
  | 'live'
  /** Live audio, but the server never joined: no tools, no transcript, no metering. */
  | 'degraded'
  | 'error';

export type CallChrome = {
  readonly state: CallChromeState;
  /** Short enough for an icon button's accessible name. */
  readonly label: string;
  /** The sentence a header shows under the label. `null` when there is nothing to add. */
  readonly detail: string | null;
  /**
   * Whether offering "Try again" is honest. False when the failure is the
   * absence of a capability rather than the refusal of one — retrying cannot
   * conjure a microphone or a `getUserMedia`.
   */
  readonly canRetry: boolean;
};

export type CallChromeFacts = {
  readonly status: ConnectionStatus;
  readonly error: string | undefined;
  /** The classified reason behind `error`, when the session carried one out. */
  readonly failure: VoiceConnectFailure | undefined;
  readonly attached: boolean;
  /** True while the session is bound to a conversation, even before it connects. */
  readonly bound: boolean;
};

/**
 * The failures no retry can fix. Named as a set rather than tested inline so
 * adding a case is one edit in one place, and so the test can assert the
 * membership directly.
 *
 * `no-credit` sits here for the same reason the two microphone cases do: it is
 * the absence of something a retry cannot conjure. Its sibling `call-limit` is
 * deliberately NOT here — a concurrency cap clears on its own, so trying again
 * in a moment is exactly the right advice.
 */
const UNRETRYABLE: ReadonlySet<VoiceConnectFailure> = new Set<VoiceConnectFailure>([
  'mic-missing',
  'mic-unsupported',
  'no-credit',
]);

const DEGRADED_DETAIL =
  'Connected, but the transcript service did not join — nothing said here will be saved to the thread.';

export const describeCall = (facts: CallChromeFacts): CallChrome => {
  if (facts.status === 'error') {
    return {
      state: 'error',
      label: 'Voice failed',
      // The sentence `connect.ts` wrote for this exact failure. Never replaced
      // with a generic one here: the specific advice is the entire point.
      detail: facts.error ?? 'Voice mode could not start.',
      canRetry: facts.failure === undefined || !UNRETRYABLE.has(facts.failure),
    };
  }

  if (facts.status === 'connecting') {
    return {
      state: 'connecting',
      label: 'Connecting voice',
      detail: null,
      canRetry: false,
    };
  }

  if (facts.status === 'connected') {
    return facts.attached
      ? { state: 'live', label: 'Voice call is live', detail: null, canRetry: false }
      : {
          state: 'degraded',
          label: 'Voice call is live, without transcript',
          detail: DEGRADED_DETAIL,
          canRetry: false,
        };
  }

  return {
    state: 'idle',
    label: facts.bound ? 'Talk to this conversation' : 'Start a voice call',
    detail: null,
    canRetry: false,
  };
};

/** Whether a call is up in any capability. Used to decide reveal-vs-start. */
export const isCallLive = (state: CallChromeState): boolean =>
  state === 'connecting' || state === 'live' || state === 'degraded';
