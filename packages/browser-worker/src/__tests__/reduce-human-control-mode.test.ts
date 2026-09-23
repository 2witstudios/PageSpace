import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { reduceHumanControlMode } from '../reduce-human-control-mode.js';
import type { HumanControlMode } from '../human-control-state.js';

const T0 = 1_700_000_000_000;
const T1 = T0 + 5_000;
const ALICE = { userId: 'user-alice' };
const BOB = { userId: 'user-bob' };
const AGENT_VISIBLE = ['screenshot', 'accessibility-snapshot', 'page-event', 'tab-list', 'action-result'];

const agentControl: HumanControlMode = { state: 'agent-control', since: T0, heldBy: null };
const draining: HumanControlMode = { state: 'draining', since: T0, heldBy: ALICE };
const humanControl: HumanControlMode = { state: 'human-control', since: T0, heldBy: ALICE };
const hydrating: HumanControlMode = { state: 'hydrating', since: T0, heldBy: null };

describe('reduceHumanControlMode', () => {
  describe('taking over', () => {
    it('cuts the agent off at once and drains its actions when a human takes over', () => {
      assert({
        given: 'agent-control and a take-over by a human',
        should: 'enter draining held by that human, close agent observation, cancel queued agent actions, and permit the agent nothing',
        actual: reduceHumanControlMode({ mode: agentControl, event: { type: 'take-over', by: ALICE }, now: T1 }),
        expected: {
          mode: { state: 'draining', since: T1, heldBy: ALICE },
          effects: ['close-agent-observation', 'cancel-agent-actions'],
          permittedObservations: [],
          rejected: null,
        },
      });
    });

    it('treats a repeated take-over by the holder as a no-op', () => {
      assert({
        given: 'draining or human-control held by Alice, and another take-over by Alice',
        should: 'leave the mode as it is, with no effects and no rejection',
        actual: [draining, humanControl].map((mode) => reduceHumanControlMode({ mode, event: { type: 'take-over', by: ALICE }, now: T1 })),
        expected: [draining, humanControl].map((mode) => ({ mode, effects: [], permittedObservations: [], rejected: null })),
      });
    });

    it('refuses a second human while one holds the session', () => {
      assert({
        given: 'draining or human-control held by Alice, and a take-over by Bob',
        should: 'reject as already held and change nothing',
        actual: [draining, humanControl].map((mode) => reduceHumanControlMode({ mode, event: { type: 'take-over', by: BOB }, now: T1 })),
        expected: [draining, humanControl].map((mode) => ({ mode, effects: [], permittedObservations: [], rejected: 'already-held' })),
      });
    });

    it('lets a human take over while a fresh context is still hydrating', () => {
      assert({
        given: 'hydrating and a take-over',
        should: 'enter draining held by that human with the agent still cut off',
        actual: reduceHumanControlMode({ mode: hydrating, event: { type: 'take-over', by: BOB }, now: T1 }),
        expected: {
          mode: { state: 'draining', since: T1, heldBy: BOB },
          effects: ['close-agent-observation', 'cancel-agent-actions'],
          permittedObservations: [],
          rejected: null,
        },
      });
    });
  });

  describe('draining', () => {
    it('hands the page to the human only once the agent has drained', () => {
      assert({
        given: 'draining and the drained signal',
        should: 'enter human-control, open the human channel, and still permit the agent nothing',
        actual: reduceHumanControlMode({ mode: draining, event: { type: 'drained' }, now: T1 }),
        expected: {
          mode: { state: 'human-control', since: T1, heldBy: ALICE },
          effects: ['open-human-control'],
          permittedObservations: [],
          rejected: null,
        },
      });
    });

    it('ignores a drained signal outside draining', () => {
      assert({
        given: 'agent-control, human-control or hydrating and a drained signal',
        should: 'reject as not draining and change nothing',
        actual: [agentControl, humanControl, hydrating].map((mode) => reduceHumanControlMode({ mode, event: { type: 'drained' }, now: T1 }).rejected),
        expected: ['not-draining', 'not-draining', 'not-draining'],
      });
    });
  });

  describe('releasing', () => {
    it('destroys the human context before the agent sees anything again', () => {
      assert({
        given: 'human-control held by Alice and a release by Alice',
        should: 'enter hydrating, restart the browser, and still permit the agent nothing',
        actual: reduceHumanControlMode({ mode: humanControl, event: { type: 'release', by: ALICE }, now: T1 }),
        expected: {
          mode: { state: 'hydrating', since: T1, heldBy: null },
          effects: ['restart-browser'],
          permittedObservations: [],
          rejected: null,
        },
      });
    });

    it('lets the holder cancel a take-over that is still draining, through the same restart', () => {
      assert({
        given: 'draining held by Alice and a release by Alice',
        should: 'enter hydrating and restart the browser',
        actual: reduceHumanControlMode({ mode: draining, event: { type: 'release', by: ALICE }, now: T1 }),
        expected: {
          mode: { state: 'hydrating', since: T1, heldBy: null },
          effects: ['restart-browser'],
          permittedObservations: [],
          rejected: null,
        },
      });
    });

    it('refuses a release by anyone but the holder', () => {
      assert({
        given: 'human-control held by Alice and a release by Bob',
        should: 'reject as not the holder and keep the agent cut off',
        actual: reduceHumanControlMode({ mode: humanControl, event: { type: 'release', by: BOB }, now: T1 }),
        expected: { mode: humanControl, effects: [], permittedObservations: [], rejected: 'not-holder' },
      });
    });

    it('refuses a release when nobody holds the session', () => {
      assert({
        given: 'agent-control or hydrating and a release',
        should: 'reject as not held',
        actual: [agentControl, hydrating].map((mode) => reduceHumanControlMode({ mode, event: { type: 'release', by: ALICE }, now: T1 }).rejected),
        expected: ['not-held', 'not-held'],
      });
    });
  });

  describe('hydrating', () => {
    it('returns control and observation to the agent only after the fresh context is up', () => {
      assert({
        given: 'hydrating and the hydrated signal',
        should: 'enter agent-control, open agent observation, and permit the agent-visible kinds',
        actual: reduceHumanControlMode({ mode: hydrating, event: { type: 'hydrated' }, now: T1 }),
        expected: {
          mode: { state: 'agent-control', since: T1, heldBy: null },
          effects: ['open-agent-observation'],
          permittedObservations: AGENT_VISIBLE,
          rejected: null,
        },
      });
    });

    it('ignores a hydrated signal outside hydrating', () => {
      assert({
        given: 'agent-control, draining or human-control and a hydrated signal',
        should: 'reject as not hydrating and never reopen agent observation',
        actual: [agentControl, draining, humanControl].map((mode) => reduceHumanControlMode({ mode, event: { type: 'hydrated' }, now: T1 })),
        expected: [agentControl, draining, humanControl].map((mode) => ({
          mode,
          effects: [],
          permittedObservations: mode.state === 'agent-control' ? AGENT_VISIBLE : [],
          rejected: 'not-hydrating',
        })),
      });
    });
  });
});
