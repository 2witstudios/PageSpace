import { describe, it, expect } from 'vitest';
import { assert } from './riteway';
import {
  shouldCheckpoint,
  checkpointComment,
  resolveCheckpointFlag,
  CHECKPOINT_MIN_INTERVAL_MS,
  getCheckpointState,
  recordCheckpoint,
  resetCheckpointState,
} from '../checkpoint-policy';

const NOW = new Date('2026-07-12T12:00:00.000Z');

describe('shouldCheckpoint (pure)', () => {
  it('creates a checkpoint on the first batch of a turn when the flag is on', () => {
    assert({
      given: 'flag on, never checkpointed before, a fresh turn',
      should: 'checkpoint',
      actual: shouldCheckpoint({
        flagEnabled: true,
        lastCheckpointAt: null,
        turnId: 'turn-1',
        lastCheckpointTurnId: null,
        now: NOW,
      }),
      expected: true,
    });
  });

  it('never checkpoints when the flag is off, regardless of turn/throttle state', () => {
    assert({
      given: 'flag off but otherwise a fresh turn',
      should: 'not checkpoint',
      actual: shouldCheckpoint({
        flagEnabled: false,
        lastCheckpointAt: null,
        turnId: 'turn-1',
        lastCheckpointTurnId: null,
        now: NOW,
      }),
      expected: false,
    });
  });

  it('does not checkpoint again within the SAME turn (at most once per agent turn)', () => {
    assert({
      given: 'a turn that already produced a checkpoint',
      should: 'skip a second checkpoint for a later batch in the same turn',
      actual: shouldCheckpoint({
        flagEnabled: true,
        lastCheckpointAt: new Date(NOW.getTime() - CHECKPOINT_MIN_INTERVAL_MS * 10),
        turnId: 'turn-1',
        lastCheckpointTurnId: 'turn-1',
        now: NOW,
      }),
      expected: false,
    });
  });

  it('checkpoints again for a NEW turn once the throttle window has elapsed', () => {
    assert({
      given: 'a new turnId and a last checkpoint well outside the throttle window',
      should: 'checkpoint',
      actual: shouldCheckpoint({
        flagEnabled: true,
        lastCheckpointAt: new Date(NOW.getTime() - CHECKPOINT_MIN_INTERVAL_MS - 1),
        turnId: 'turn-2',
        lastCheckpointTurnId: 'turn-1',
        now: NOW,
      }),
      expected: true,
    });
  });

  it('throttles across rapid batches even when the turnId changed (safety net)', () => {
    assert({
      given: 'a new turnId but the last checkpoint was inside the throttle window',
      should: 'skip (throttled)',
      actual: shouldCheckpoint({
        flagEnabled: true,
        lastCheckpointAt: new Date(NOW.getTime() - 1_000),
        turnId: 'turn-2',
        lastCheckpointTurnId: 'turn-1',
        now: NOW,
      }),
      expected: false,
    });
  });

  it('checkpoints exactly at the throttle boundary (>= throttle, not >)', () => {
    assert({
      given: 'a last checkpoint exactly CHECKPOINT_MIN_INTERVAL_MS ago',
      should: 'checkpoint',
      actual: shouldCheckpoint({
        flagEnabled: true,
        lastCheckpointAt: new Date(NOW.getTime() - CHECKPOINT_MIN_INTERVAL_MS),
        turnId: 'turn-2',
        lastCheckpointTurnId: 'turn-1',
        now: NOW,
      }),
      expected: true,
    });
  });
});

describe('resolveCheckpointFlag (pure)', () => {
  it('is ON by default outside production', () => {
    assert({
      given: 'no explicit env value, nodeEnv "development"',
      should: 'default ON',
      actual: resolveCheckpointFlag({ rawEnvValue: undefined, nodeEnv: 'development' }),
      expected: true,
    });
  });

  it('is ON by default in test', () => {
    assert({
      given: 'no explicit env value, nodeEnv "test"',
      should: 'default ON',
      actual: resolveCheckpointFlag({ rawEnvValue: undefined, nodeEnv: 'test' }),
      expected: true,
    });
  });

  it('is OFF by default in production (prod default deferred to PR discussion)', () => {
    assert({
      given: 'no explicit env value, nodeEnv "production"',
      should: 'default OFF',
      actual: resolveCheckpointFlag({ rawEnvValue: undefined, nodeEnv: 'production' }),
      expected: false,
    });
  });

  it('an explicit "true" always wins, even in production', () => {
    assert({
      given: 'rawEnvValue "true", nodeEnv "production"',
      should: 'be ON',
      actual: resolveCheckpointFlag({ rawEnvValue: 'true', nodeEnv: 'production' }),
      expected: true,
    });
  });

  it('an explicit "false" always wins, even outside production', () => {
    assert({
      given: 'rawEnvValue "false", nodeEnv "development"',
      should: 'be OFF',
      actual: resolveCheckpointFlag({ rawEnvValue: 'false', nodeEnv: 'development' }),
      expected: false,
    });
  });

  it('an unrecognized raw value falls back to the NODE_ENV default', () => {
    assert({
      given: 'rawEnvValue "yes" (not the literal "true"), nodeEnv "production"',
      should: 'fall back to the production default (OFF)',
      actual: resolveCheckpointFlag({ rawEnvValue: 'yes', nodeEnv: 'production' }),
      expected: false,
    });
  });
});

describe('checkpointComment (pure)', () => {
  it('tags the checkpoint with a recognizable, turn-scoped comment', () => {
    assert({
      given: 'turnId "abc123"',
      should: 'produce the pagespace-pre-agent-<turnId> comment',
      actual: checkpointComment('abc123'),
      expected: 'pagespace-pre-agent-abc123',
    });
  });
});

describe('checkpoint state (in-process, per sandbox)', () => {
  it('reports null state for a sandbox that has never been checkpointed', () => {
    resetCheckpointState();
    assert({
      given: 'an unknown sandboxId',
      should: 'return null lastCheckpointAt/lastCheckpointTurnId',
      actual: getCheckpointState('sbx-never-seen'),
      expected: { lastCheckpointAt: null, lastCheckpointTurnId: null },
    });
  });

  it('remembers the last recorded checkpoint per sandboxId', () => {
    resetCheckpointState();
    recordCheckpoint('sbx-1', { lastCheckpointAt: NOW, lastCheckpointTurnId: 'turn-1' });
    expect(getCheckpointState('sbx-1')).toEqual({ lastCheckpointAt: NOW, lastCheckpointTurnId: 'turn-1' });
    // A different sandbox is unaffected.
    expect(getCheckpointState('sbx-2')).toEqual({ lastCheckpointAt: null, lastCheckpointTurnId: null });
  });

  it('resetCheckpointState clears all recorded state (test-only seam)', () => {
    recordCheckpoint('sbx-1', { lastCheckpointAt: NOW, lastCheckpointTurnId: 'turn-1' });
    resetCheckpointState();
    expect(getCheckpointState('sbx-1')).toEqual({ lastCheckpointAt: null, lastCheckpointTurnId: null });
  });
});
