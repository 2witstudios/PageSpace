import type { ControlActor } from './control-instruction.js';
import type { HumanControlMode } from './human-control-state.js';

export type ActionAdmissionRefusal = 'agent-control' | 'draining' | 'human-control' | 'hydrating' | 'not-holder';

export type ActionAdmission = { readonly admit: true } | { readonly admit: false; readonly reason: ActionAdmissionRefusal };

export type DecideActionAdmissionOptions = {
  readonly mode: HumanControlMode;
  readonly actor: ControlActor;
};

export const decideActionAdmission = (_options: DecideActionAdmissionOptions): ActionAdmission => {
  throw new Error('decideActionAdmission: not implemented (RED)');
};
