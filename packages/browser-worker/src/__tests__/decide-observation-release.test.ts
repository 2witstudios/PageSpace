import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { decideObservationRelease } from '../decide-observation-release.js';
import { OBSERVATION_KINDS, type ObservationKind } from '../observation-kind.js';
import { HUMAN_CONTROL_STATES } from '../human-control-state.js';

const AGENT_VISIBLE: readonly ObservationKind[] = ['screenshot', 'accessibility-snapshot', 'page-event', 'tab-list', 'action-result'];

describe('decideObservationRelease', () => {
  it('releases everything but the clipboard to the agent while the agent controls the session', () => {
    assert({
      given: 'agent-control and each observation kind, for the agent',
      should: 'release every kind except the clipboard',
      actual: OBSERVATION_KINDS.map((kind) => [kind, decideObservationRelease({ mode: 'agent-control', kind, audience: 'agent' })]),
      expected: OBSERVATION_KINDS.map((kind) => [kind, kind === 'clipboard' ? 'suppress' : 'release']),
    });
  });

  it('suppresses every observation to the agent in every state but agent-control', () => {
    const cut = HUMAN_CONTROL_STATES.filter((mode) => mode !== 'agent-control');
    assert({
      given: 'draining, human-control and hydrating, for the agent',
      should: 'suppress every observation kind (the observation cut)',
      actual: cut.flatMap((mode) => OBSERVATION_KINDS.map((kind) => decideObservationRelease({ mode, kind, audience: 'agent' }))),
      expected: cut.flatMap(() => OBSERVATION_KINDS.map(() => 'suppress')),
    });
  });

  it('never releases the clipboard to anyone', () => {
    assert({
      given: 'the clipboard in every state, for both audiences',
      should: 'suppress it',
      actual: HUMAN_CONTROL_STATES.flatMap((mode) => (['agent', 'human'] as const).map((audience) => decideObservationRelease({ mode, kind: 'clipboard', audience }))),
      expected: HUMAN_CONTROL_STATES.flatMap(() => ['suppress', 'suppress']),
    });
  });

  it('shows the human the pane — pixels, page events and tabs — in every state', () => {
    const paneKinds: readonly ObservationKind[] = ['screenshot', 'page-event', 'tab-list'];
    assert({
      given: 'the live-pane kinds in every state, for the human',
      should: 'release them, so the human can watch the agent and drive during human control',
      actual: HUMAN_CONTROL_STATES.flatMap((mode) => paneKinds.map((kind) => decideObservationRelease({ mode, kind, audience: 'human' }))),
      expected: HUMAN_CONTROL_STATES.flatMap(() => paneKinds.map(() => 'release')),
    });
  });

  it('gives the human no agent-shaped surfaces', () => {
    const agentOnly: readonly ObservationKind[] = ['accessibility-snapshot', 'action-result'];
    assert({
      given: 'the accessibility snapshot and action results, for the human',
      should: 'suppress them — the pane is pixels, not a second tool channel',
      actual: HUMAN_CONTROL_STATES.flatMap((mode) => agentOnly.map((kind) => decideObservationRelease({ mode, kind, audience: 'human' }))),
      expected: HUMAN_CONTROL_STATES.flatMap(() => agentOnly.map(() => 'suppress')),
    });
  });

  it('keeps the agent-visible kinds list honest', () => {
    assert({
      given: 'agent-control',
      should: 'release exactly the agent-visible kinds',
      actual: OBSERVATION_KINDS.filter((kind) => decideObservationRelease({ mode: 'agent-control', kind, audience: 'agent' }) === 'release'),
      expected: AGENT_VISIBLE,
    });
  });
});
