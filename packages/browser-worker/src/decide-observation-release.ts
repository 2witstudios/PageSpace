import type { HumanControlState } from './human-control-state.js';
import type { ObservationAudience, ObservationKind, ObservationRelease } from './observation-kind.js';

export type DecideObservationReleaseOptions = {
  readonly mode: HumanControlState;
  readonly kind: ObservationKind;
  readonly audience: ObservationAudience;
};

export const decideObservationRelease = (_options: DecideObservationReleaseOptions): ObservationRelease => {
  throw new Error('decideObservationRelease: not implemented (RED)');
};
