import type { HumanControlMode, HumanPrincipal } from './human-control-state.js';
import type { ObservationKind } from './observation-kind.js';

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

export const reduceHumanControlMode = (_options: ReduceHumanControlModeOptions): HumanControlTransition => {
  throw new Error('reduceHumanControlMode: not implemented (RED)');
};
