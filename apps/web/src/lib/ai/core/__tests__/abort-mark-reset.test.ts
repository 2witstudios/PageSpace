import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert } from './riteway';

/**
 * A source-level tripwire, in the same spirit as `disconnect-immunity.test.ts` — and for the same
 * reason: the thing being protected is the ABSENCE of a failure that no behavioural test would
 * naturally reach.
 *
 * `createStreamLifecycle`'s INSERT ... ON CONFLICT DO UPDATE reuses a row when a messageId
 * re-registers. Every column that carries state from the previous generation must be reset in that
 * `set` block, and `abortRequestedAt` is the newest and least obvious of them.
 *
 * If it is ever dropped, an abort request aimed at the PREVIOUS generation is inherited by the new
 * one, and the abort watcher kills the fresh stream within a second of it starting — a generation
 * cancelled by a Stop the user pressed on something else entirely. There would be no error, no
 * log, and no failing test; it would simply look like the model gave up.
 *
 * The watcher's streamId epoch check is the other half of this defence. This asserts the first
 * half is still here.
 */

const LIFECYCLE_SOURCE = readFileSync(
  join(process.cwd(), 'src/lib/ai/core/stream-lifecycle.ts'),
  'utf8',
);

// The `set` block of the onConflictDoUpdate — i.e. what a REUSED row is reset to.
const conflictSetBlock = (source: string): string => {
  const start = source.indexOf('.onConflictDoUpdate(');
  const setStart = source.indexOf('set: {', start);
  const setEnd = source.indexOf('},', setStart);
  return source.slice(setStart, setEnd);
};

describe('stream re-registration must not inherit the previous generation\'s abort request', () => {
  it('clears abortRequestedAt when a row is reused', () => {
    assert({
      given: 'the onConflictDoUpdate that reuses an existing stream row',
      should: 'reset abortRequestedAt, so a stale Stop cannot kill the new generation',
      actual: /abortRequestedAt:\s*null/.test(conflictSetBlock(LIFECYCLE_SOURCE)),
      expected: true,
    });
  });

  // The epoch. Without it the reset above is the ONLY thing standing between a stale mark and a
  // freshly-started generation, and a single edit to that set block would remove it silently.
  it('records the streamId that the row now belongs to', () => {
    assert({
      given: 'the onConflictDoUpdate that reuses an existing stream row',
      should: 'record the new streamId, so the watcher can tell which generation a mark names',
      actual: /streamId,/.test(conflictSetBlock(LIFECYCLE_SOURCE)),
      expected: true,
    });
  });
});
