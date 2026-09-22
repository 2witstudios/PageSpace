/**
 * May this actor act on the page right now? — pure.
 *
 * Exactly one principal drives a session at a time. The agent's typed
 * operations run only in `agent-control`; a human's pane input runs only in
 * `human-control`, and only from the human who holds it. Nobody acts while
 * the agent drains or while a fresh context hydrates. A refusal names the
 * state that caused it, so the tool can tell the model a human has the page.
 */
import type { ControlActor } from './control-instruction.js';
import type { HumanControlMode } from './human-control-state.js';

export type ActionAdmissionRefusal = 'agent-control' | 'draining' | 'human-control' | 'hydrating' | 'not-holder';

export type ActionAdmission = { readonly admit: true } | { readonly admit: false; readonly reason: ActionAdmissionRefusal };

export type DecideActionAdmissionOptions = {
  readonly mode: HumanControlMode;
  readonly actor: ControlActor;
};

export const decideActionAdmission = ({ mode, actor }: DecideActionAdmissionOptions): ActionAdmission => {
  if (actor.kind === 'agent') {
    return mode.state === 'agent-control' ? { admit: true } : { admit: false, reason: mode.state };
  }
  if (mode.state !== 'human-control') return { admit: false, reason: mode.state };
  if (mode.heldBy?.userId !== actor.userId) return { admit: false, reason: 'not-holder' };
  return { admit: true };
};
