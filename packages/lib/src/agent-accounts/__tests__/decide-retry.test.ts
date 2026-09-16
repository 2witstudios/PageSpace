/**
 * Threat model §2.4 — replay protection is not idempotency.
 *
 * Written RED at G1b before `decide-retry.ts` existed. A one-use grant stops
 * a second AUTHORIZATION; it does nothing about a duplicate UPSTREAM WRITE
 * when a timeout follows a write that may have landed. So a retry is never a
 * re-presentation of the spent grant (that is `replayed` by construction),
 * and for a non-idempotent class after the request was sent it is never
 * automatic at all: the executor reports `unknown` and a human decides.
 */
import { describe, it, expect } from 'vitest';
import { decideRetry } from '../decide-retry';
import type { OperationClass } from '../grant';

const CLASSES: readonly OperationClass[] = ['read', 'write', 'irreversible', 'privilege', 'unknown'];

describe('decideRetry', () => {
  it.each(CLASSES)('given class %s and a failure BEFORE the request was sent, should allow a retry under a NEW grant (nothing reached upstream)', (operationClass) => {
    const actual = decideRetry({ operationClass, failure: { kind: 'before_send' }, attempt: 1, maxAttempts: 3 });
    expect(actual).toEqual({ action: 'retry_with_new_grant' });
  });

  it('given class read and a timeout AFTER send, should allow a retry under a new grant (idempotent class)', () => {
    const actual = decideRetry({ operationClass: 'read', failure: { kind: 'timeout_after_send' }, attempt: 1, maxAttempts: 3 });
    expect(actual).toEqual({ action: 'retry_with_new_grant' });
  });

  it.each(['write', 'irreversible', 'privilege', 'unknown'] as const)(
    'given class %s and a timeout AFTER send, should report outcome unknown and never retry automatically',
    (operationClass) => {
      const actual = decideRetry({ operationClass, failure: { kind: 'timeout_after_send' }, attempt: 1, maxAttempts: 3 });
      expect(actual).toEqual({ action: 'report', outcome: { kind: 'unknown' } });
    },
  );

  it('given an upstream status after send, should report upstream_failed with that status (the write is known to have been received)', () => {
    const actual = decideRetry({ operationClass: 'write', failure: { kind: 'upstream_status', status: 503 }, attempt: 1, maxAttempts: 3 });
    expect(actual).toEqual({ action: 'report', outcome: { kind: 'upstream_failed', upstreamStatus: 503 } });
  });

  it.each([502, 504])(
    'given a non-idempotent class and a gateway %i, should report unknown — a gateway lost the origin response, so the write may have landed',
    (status) => {
      const actual = (['write', 'irreversible', 'privilege', 'unknown'] as const).map((operationClass) =>
        decideRetry({ operationClass, failure: { kind: 'upstream_status', status }, attempt: 1, maxAttempts: 3 }),
      );
      const expected = [0, 1, 2, 3].map(() => ({ action: 'report', outcome: { kind: 'unknown' } }));
      expect(actual).toEqual(expected);
    },
  );

  it('given class read and a 5xx upstream status, should allow a retry under a new grant while attempts remain', () => {
    const actual = decideRetry({ operationClass: 'read', failure: { kind: 'upstream_status', status: 502 }, attempt: 1, maxAttempts: 3 });
    expect(actual).toEqual({ action: 'retry_with_new_grant' });
  });

  it('given class read and a 4xx upstream status, should report upstream_failed (a retry cannot change a client error)', () => {
    const actual = decideRetry({ operationClass: 'read', failure: { kind: 'upstream_status', status: 404 }, attempt: 1, maxAttempts: 3 });
    expect(actual).toEqual({ action: 'report', outcome: { kind: 'upstream_failed', upstreamStatus: 404 } });
  });

  it('given the attempt budget is exhausted, should report rather than retry even for a retryable failure', () => {
    const actual = decideRetry({ operationClass: 'read', failure: { kind: 'before_send' }, attempt: 3, maxAttempts: 3 });
    expect(actual).toEqual({ action: 'report', outcome: { kind: 'upstream_failed', upstreamStatus: null } });
  });

  it('given any decision, should never name the spent grant as reusable (the only retry shape is retry_with_new_grant)', () => {
    const decisions = CLASSES.flatMap((operationClass) =>
      (
        [
          { kind: 'before_send' },
          { kind: 'timeout_after_send' },
          { kind: 'upstream_status', status: 500 },
        ] as const
      ).map((failure) => decideRetry({ operationClass, failure, attempt: 1, maxAttempts: 3 })),
    );
    const actual = decisions.map((decision) => decision.action).filter((action) => action !== 'report' && action !== 'retry_with_new_grant');
    expect(actual).toEqual([]);
  });
});
