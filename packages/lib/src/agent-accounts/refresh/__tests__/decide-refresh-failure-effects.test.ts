/**
 * L3·G3 — `decideRefreshFailureEffects`: what the refresh worker records and
 * marks after a classified failure. The requirement it carries: a provider
 * revocation marks the account `needs_reauth` and schedules no retry, so the
 * worker can never retry-loop on a dead grant (task requirement 3).
 */
import { describe, expect, it } from 'vitest';
import { decideRefreshFailureEffects } from '../decide-refresh-failure-effects';

describe('decideRefreshFailureEffects', () => {
  it('given a provider revocation, should mark the account for reauthorization and schedule no retry', () => {
    const actual = [
      decideRefreshFailureEffects({ failure: { class: 'revoked', reason: 'invalid_grant' } }),
      decideRefreshFailureEffects({ failure: { class: 'revoked', reason: 'unauthorized' } }),
    ];
    const expected = [
      { attempt: { kind: 'definitive' }, accountStatus: 'needs_reauth' },
      { attempt: { kind: 'definitive' }, accountStatus: 'needs_reauth' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a definitive rejection that is not a revocation, should also mark the account for reauthorization', () => {
    const actual = decideRefreshFailureEffects({ failure: { class: 'purge_and_reauth', reason: 'malformed_response' } });
    const expected = { attempt: { kind: 'definitive' }, accountStatus: 'needs_reauth' };
    expect(actual).toEqual(expected);
  });

  it('given a retryable failure, should record a retry and leave the account status alone', () => {
    const actual = decideRefreshFailureEffects({ failure: { class: 'retryable', retryAfterMs: 5_000 } });
    const expected = { attempt: { kind: 'retryable', retryAfterMs: 5_000 }, accountStatus: null };
    expect(actual).toEqual(expected);
  });
});
