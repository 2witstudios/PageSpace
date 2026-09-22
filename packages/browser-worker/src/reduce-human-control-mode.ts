/**
 * The human-control-mode state machine (S3 §3.3, R7, R9) — pure. The G6b
 * login flow is built on this primitive; G6a ships the switch and its
 * guarantees without any credential.
 *
 *   agent-control ──take-over──▶ draining ──drained──▶ human-control
 *         ▲                        │  ▲                      │
 *         │                 release│  └──────take-over───────┤ (hydrating)
 *         └───hydrated─── hydrating ◀────────release─────────┘
 *
 * What each transition guarantees, as effects the worker carries out:
 *  - take-over: agent observation closes AT ONCE (`close-agent-observation`)
 *    and every queued or in-flight agent action is cancelled and refused
 *    (`cancel-agent-actions`). The human does not act until the agent has
 *    drained, so two principals never drive the page together.
 *  - release: the browser restarts (`restart-browser`): the context the human
 *    typed into is destroyed, never handed back to the agent (R9).
 *  - hydrated: only now does the agent see the page again.
 *
 * Only the holder may release; a second human cannot take over a held
 * session; an event that does not fit the current state is rejected as data
 * and changes nothing. `permittedObservations` is what the agent may see in
 * the resulting state, read from `decideObservationRelease` so the two can
 * never disagree.
 */
import type { HumanControlMode, HumanControlState, HumanPrincipal } from './human-control-state.js';
import { OBSERVATION_KINDS, type ObservationKind } from './observation-kind.js';
import { decideObservationRelease } from './decide-observation-release.js';

export type HumanControlEvent =
  | { readonly type: 'take-over'; readonly by: HumanPrincipal }
  | { readonly type: 'drained' }
  | { readonly type: 'release'; readonly by: HumanPrincipal }
  | { readonly type: 'hydrated' };

export type HumanControlEffect =
  | 'close-agent-observation'
  | 'cancel-agent-actions'
  | 'open-human-control'
  | 'restart-browser'
  | 'open-agent-observation';

export type HumanControlRejection = 'already-held' | 'not-draining' | 'not-holder' | 'not-held' | 'not-hydrating';

export type HumanControlTransition = {
  readonly mode: HumanControlMode;
  readonly effects: readonly HumanControlEffect[];
  readonly permittedObservations: readonly ObservationKind[];
  readonly rejected: HumanControlRejection | null;
};

export type ReduceHumanControlModeOptions = {
  readonly mode: HumanControlMode;
  readonly event: HumanControlEvent;
  readonly now: number;
};

const agentPermitted = (state: HumanControlState): readonly ObservationKind[] =>
  OBSERVATION_KINDS.filter((kind) => decideObservationRelease({ mode: state, kind, audience: 'agent' }) === 'release');

const moveTo = (
  state: HumanControlState,
  heldBy: HumanPrincipal | null,
  now: number,
  effects: readonly HumanControlEffect[],
): HumanControlTransition => ({
  mode: { state, since: now, heldBy },
  effects,
  permittedObservations: agentPermitted(state),
  rejected: null,
});

const stay = (mode: HumanControlMode, rejected: HumanControlRejection | null): HumanControlTransition => ({
  mode,
  effects: [],
  permittedObservations: agentPermitted(mode.state),
  rejected,
});

const isHeld = (mode: HumanControlMode): boolean => mode.state === 'draining' || mode.state === 'human-control';

export const reduceHumanControlMode = ({ mode, event, now }: ReduceHumanControlModeOptions): HumanControlTransition => {
  switch (event.type) {
    case 'take-over': {
      if (isHeld(mode)) return stay(mode, mode.heldBy?.userId === event.by.userId ? null : 'already-held');
      return moveTo('draining', event.by, now, ['close-agent-observation', 'cancel-agent-actions']);
    }
    case 'drained': {
      if (mode.state !== 'draining') return stay(mode, 'not-draining');
      return moveTo('human-control', mode.heldBy, now, ['open-human-control']);
    }
    case 'release': {
      if (!isHeld(mode)) return stay(mode, 'not-held');
      if (mode.heldBy?.userId !== event.by.userId) return stay(mode, 'not-holder');
      return moveTo('hydrating', null, now, ['restart-browser']);
    }
    case 'hydrated': {
      if (mode.state !== 'hydrating') return stay(mode, 'not-hydrating');
      return moveTo('agent-control', null, now, ['open-agent-observation']);
    }
  }
};
