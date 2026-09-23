import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { decideActionAdmission } from '../decide-action-admission.js';
import { HUMAN_CONTROL_STATES } from '../human-control-state.js';

const ALICE = { userId: 'user-alice' };

describe('decideActionAdmission', () => {
  it('admits the agent only while it controls the session', () => {
    assert({
      given: 'each state and an agent action',
      should: 'admit in agent-control and refuse with the current state everywhere else',
      actual: HUMAN_CONTROL_STATES.map((state) =>
        decideActionAdmission({ mode: { state, since: 0, heldBy: state === 'draining' || state === 'human-control' ? ALICE : null }, actor: { kind: 'agent', agentId: 'agent-1' } }),
      ),
      expected: [
        { admit: true },
        { admit: false, reason: 'draining' },
        { admit: false, reason: 'human-control' },
        { admit: false, reason: 'hydrating' },
      ],
    });
  });

  it('admits human input only from the holder, and only in human-control', () => {
    assert({
      given: 'human input from the holder in each state',
      should: 'admit only in human-control — never while the agent still drains, and never while the agent controls',
      actual: HUMAN_CONTROL_STATES.map((state) =>
        decideActionAdmission({ mode: { state, since: 0, heldBy: state === 'draining' || state === 'human-control' ? ALICE : null }, actor: { kind: 'human', userId: ALICE.userId } }),
      ),
      expected: [
        { admit: false, reason: 'agent-control' },
        { admit: false, reason: 'draining' },
        { admit: true },
        { admit: false, reason: 'hydrating' },
      ],
    });
  });

  it('refuses human input from anyone but the holder', () => {
    assert({
      given: 'human-control held by Alice and input from Bob',
      should: 'refuse as not the holder',
      actual: decideActionAdmission({ mode: { state: 'human-control', since: 0, heldBy: ALICE }, actor: { kind: 'human', userId: 'user-bob' } }),
      expected: { admit: false, reason: 'not-holder' },
    });
  });
});
