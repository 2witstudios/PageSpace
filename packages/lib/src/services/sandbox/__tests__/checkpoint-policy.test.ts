import { describe, it, expect, vi } from 'vitest';
import { assert } from './riteway';
import {
  shouldCheckpoint,
  checkpointComment,
  resolveCheckpointFlag,
  getCheckpointState,
  recordCheckpoint,
  resetCheckpointState,
  coalesceCheckpointAttempt,
} from '../checkpoint-policy';

const NOW = new Date('2026-07-12T12:00:00.000Z');

describe('shouldCheckpoint (pure)', () => {
  it('creates a checkpoint on the first batch of a turn when the flag is on', () => {
    assert({
      given: 'flag on, never checkpointed before, a fresh turn',
      should: 'checkpoint',
      actual: shouldCheckpoint({
        flagEnabled: true,
        turnId: 'turn-1',
        lastCheckpointTurnId: null,
      }),
      expected: true,
    });
  });

  it('never checkpoints when the flag is off, regardless of turn state', () => {
    assert({
      given: 'flag off but otherwise a fresh turn',
      should: 'not checkpoint',
      actual: shouldCheckpoint({
        flagEnabled: false,
        turnId: 'turn-1',
        lastCheckpointTurnId: null,
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
        turnId: 'turn-1',
        lastCheckpointTurnId: 'turn-1',
      }),
      expected: false,
    });
  });

  // Regression test for a P2 finding on PR #2025 (chatgpt-codex-connector):
  // an earlier revision suppressed a NEW turn's first checkpoint if it fell
  // within a time-based throttle window of a PRIOR, different turn's
  // checkpoint. That silently defeated the safety net: two legitimate turns
  // close together would leave only the older turn's restore point on
  // record, so a restore after the newer turn's destructive work would
  // discard the newer turn's real work too. A different turnId must ALWAYS
  // checkpoint, no matter how recently the previous (different) turn's
  // checkpoint was taken.
  it('checkpoints a NEW turn immediately, even moments after a different turn was checkpointed', () => {
    assert({
      given: 'a different turnId than the last checkpoint, taken 1ms ago',
      should: 'checkpoint anyway — a new turn is never suppressed by how recent the prior one was',
      actual: shouldCheckpoint({
        flagEnabled: true,
        turnId: 'turn-2',
        lastCheckpointTurnId: 'turn-1',
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

  // Efficiency finding from code review: this in-process Map has no
  // symmetric acquire/release, so it needs an opportunistic sweep (mirroring
  // quota.ts's machineActivityByKey) or it grows by one entry per distinct
  // sandboxId ever seen for the life of the process.
  it('opportunistically evicts entries older than the TTL when a later checkpoint is recorded', () => {
    resetCheckpointState();
    const longAgo = new Date(NOW.getTime() - 25 * 60 * 60 * 1000); // 25h ago, past the 24h TTL
    recordCheckpoint('sbx-stale', { lastCheckpointAt: longAgo, lastCheckpointTurnId: 'turn-old' });
    // A fresh checkpoint on a DIFFERENT sandbox is the natural sweep trigger.
    recordCheckpoint('sbx-fresh', { lastCheckpointAt: NOW, lastCheckpointTurnId: 'turn-new' });

    expect(getCheckpointState('sbx-stale')).toEqual({ lastCheckpointAt: null, lastCheckpointTurnId: null });
    expect(getCheckpointState('sbx-fresh')).toEqual({ lastCheckpointAt: NOW, lastCheckpointTurnId: 'turn-new' });
  });

  it('does not evict an entry still within the TTL', () => {
    resetCheckpointState();
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h ago, well within the 24h TTL
    recordCheckpoint('sbx-recent', { lastCheckpointAt: recent, lastCheckpointTurnId: 'turn-a' });
    recordCheckpoint('sbx-other', { lastCheckpointAt: NOW, lastCheckpointTurnId: 'turn-b' });

    expect(getCheckpointState('sbx-recent')).toEqual({ lastCheckpointAt: recent, lastCheckpointTurnId: 'turn-a' });
  });
});

describe('coalesceCheckpointAttempt', () => {
  it('runs the attempt and resolves when there is no concurrent attempt in flight', async () => {
    resetCheckpointState();
    let calls = 0;
    await coalesceCheckpointAttempt('sbx-1', async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });

  // Regression test for a P2 finding on PR #2025 (2 independent review
  // agents): the AI SDK can execute multiple tool calls from one agent step
  // concurrently. Without coalescing, two callers checkpointing the SAME
  // sandbox at "the same time" would each start their own attempt.
  it('given two concurrent callers for the SAME sandbox, runs the attempt only once and both resolve together', async () => {
    resetCheckpointState();
    let starts = 0;
    let releaseAttempt: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    const attempt = async () => {
      starts += 1;
      await gate;
    };

    const first = coalesceCheckpointAttempt('sbx-1', attempt);
    const second = coalesceCheckpointAttempt('sbx-1', attempt);

    expect(starts).toBe(1); // the second caller reused the first's in-flight promise
    releaseAttempt?.();
    await Promise.all([first, second]);
  });

  it('given two DIFFERENT sandboxes, runs independent attempts for each', async () => {
    resetCheckpointState();
    const starts: string[] = [];
    await Promise.all([
      coalesceCheckpointAttempt('sbx-1', async () => {
        starts.push('sbx-1');
      }),
      coalesceCheckpointAttempt('sbx-2', async () => {
        starts.push('sbx-2');
      }),
    ]);
    expect(starts.sort()).toEqual(['sbx-1', 'sbx-2']);
  });

  it('removes the in-flight entry once the attempt settles, so a LATER (non-overlapping) call starts fresh', async () => {
    resetCheckpointState();
    let calls = 0;
    await coalesceCheckpointAttempt('sbx-1', async () => {
      calls += 1;
    });
    await coalesceCheckpointAttempt('sbx-1', async () => {
      calls += 1;
    });
    expect(calls).toBe(2);
  });

  it('propagates the attempt\'s rejection to every coalesced caller, and still cleans up the in-flight entry', async () => {
    resetCheckpointState();
    const failingAttempt = vi.fn(async () => {
      throw new Error('checkpoint failed');
    });

    const first = coalesceCheckpointAttempt('sbx-1', failingAttempt);
    const second = coalesceCheckpointAttempt('sbx-1', failingAttempt);

    await expect(first).rejects.toThrow('checkpoint failed');
    await expect(second).rejects.toThrow('checkpoint failed');
    expect(failingAttempt).toHaveBeenCalledTimes(1); // still coalesced onto one attempt

    // Cleaned up: a later call starts a fresh attempt rather than reusing the dead one.
    let calls = 0;
    await coalesceCheckpointAttempt('sbx-1', async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });
});
