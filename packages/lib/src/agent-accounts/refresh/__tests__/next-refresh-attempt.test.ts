/**
 * L3·G3 — `nextRefreshAttempt`: the attempt fact the refresh worker records
 * after a refresh, which `decideRefresh` reads next time (ADR 0003 §5 F4:
 * bounded retry with backoff, Retry-After honoured; F5: no retry loop).
 *
 * A success clears the record. A retryable failure counts one more and waits
 * the longer of the provider's Retry-After and an exponential backoff (capped),
 * so a provider cannot be hammered and a long Retry-After is never shortened.
 * A definitive failure leaves nothing to retry; a rotation replay is recorded
 * so `decideRefresh` answers `needs_reauth` from then on.
 */
import { describe, expect, it } from 'vitest';
import { nextRefreshAttempt, REFRESH_BACKOFF_BASE_MS, REFRESH_BACKOFF_MAX_MS } from '../next-refresh-attempt';
import { decideRefresh, REFRESH_MAX_CONSECUTIVE_FAILURES, type RefreshAttemptFact } from '../decide-refresh';

const NOW = 1_800_000_000_000;
const prior = (consecutiveFailures: number): RefreshAttemptFact => ({ at: NOW - 60_000, consecutiveFailures, retryAt: NOW - 1, rotationReplayed: false });

describe('nextRefreshAttempt', () => {
  it('given a successful refresh, should clear the attempt record', () => {
    const actual = nextRefreshAttempt({ previous: prior(3), outcome: { kind: 'refreshed' }, now: NOW });
    const expected = null;
    expect(actual).toEqual(expected);
  });

  it('given a first retryable failure without Retry-After, should wait the base backoff', () => {
    const actual = nextRefreshAttempt({ previous: null, outcome: { kind: 'retryable', retryAfterMs: null }, now: NOW });
    const expected = { at: NOW, consecutiveFailures: 1, retryAt: NOW + REFRESH_BACKOFF_BASE_MS, rotationReplayed: false };
    expect(actual).toEqual(expected);
  });

  it('given repeated retryable failures, should double the wait up to the cap', () => {
    const actual = [1, 2, 10].map((n) => nextRefreshAttempt({ previous: prior(n), outcome: { kind: 'retryable', retryAfterMs: null }, now: NOW })?.retryAt);
    const expected = [NOW + REFRESH_BACKOFF_BASE_MS * 2, NOW + REFRESH_BACKOFF_BASE_MS * 4, NOW + REFRESH_BACKOFF_MAX_MS];
    expect(actual).toEqual(expected);
  });

  it('given a Retry-After longer than the backoff, should wait the Retry-After; shorter, should keep the backoff', () => {
    const actual = [
      nextRefreshAttempt({ previous: null, outcome: { kind: 'retryable', retryAfterMs: REFRESH_BACKOFF_BASE_MS * 10 }, now: NOW })?.retryAt,
      nextRefreshAttempt({ previous: null, outcome: { kind: 'retryable', retryAfterMs: 1 }, now: NOW })?.retryAt,
    ];
    const expected = [NOW + REFRESH_BACKOFF_BASE_MS * 10, NOW + REFRESH_BACKOFF_BASE_MS];
    expect(actual).toEqual(expected);
  });

  it('given retryable failures up to the cap, should count them so decideRefresh stops at the cap', () => {
    const actual = nextRefreshAttempt({ previous: prior(REFRESH_MAX_CONSECUTIVE_FAILURES - 1), outcome: { kind: 'retryable', retryAfterMs: null }, now: NOW })?.consecutiveFailures;
    const expected = REFRESH_MAX_CONSECUTIVE_FAILURES;
    expect(actual).toEqual(expected);
  });

  it('given a rotation replay, should record it so every later decision requires reauthorization', () => {
    const actual = nextRefreshAttempt({ previous: prior(0), outcome: { kind: 'rotation_replayed' }, now: NOW });
    const expected = { at: NOW, consecutiveFailures: 0, retryAt: null, rotationReplayed: true };
    expect(actual).toEqual(expected);
  });

  it('given a definitive failure, should exhaust the attempt count, keep the replay flag it already had and schedule no retry', () => {
    const actual = [
      nextRefreshAttempt({ previous: prior(2), outcome: { kind: 'definitive' }, now: NOW }),
      nextRefreshAttempt({ previous: { ...prior(0), rotationReplayed: true }, outcome: { kind: 'definitive' }, now: NOW }),
    ];
    const expected = [
      { at: NOW, consecutiveFailures: REFRESH_MAX_CONSECUTIVE_FAILURES, retryAt: null, rotationReplayed: false },
      { at: NOW, consecutiveFailures: REFRESH_MAX_CONSECUTIVE_FAILURES, retryAt: null, rotationReplayed: true },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a definitive failure recorded, should make the next decision require reauthorization on its own — the worker never retry-loops on a dead grant', () => {
    const recorded = nextRefreshAttempt({ previous: null, outcome: { kind: 'definitive' }, now: NOW });
    const material = { accessToken: 'a', accessExpiresAt: NOW - 1, refreshToken: 'r', scopes: [], issuer: 'https://zoom.us', tokenEndpoint: 'https://zoom.us/oauth/token' };
    const actual = decideRefresh({ material, now: NOW + 86_400_000, marginMs: 60_000, lockHeld: false, lastAttempt: recorded });
    const expected = { action: 'needs_reauth', reason: 'exhausted' };
    expect(actual).toEqual(expected);
  });
});
