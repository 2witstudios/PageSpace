/**
 * L3·G3 — `decideRefresh`, the refresh worker's per-account lifecycle decision
 * (ADR 0005 §5.1, §9, testable assertion 12; mirrors ADR 0003 §5 F2–F5).
 *
 * The worker holds the only identity that can read an `oauth2` refresh token.
 * Before it spends one at the provider it asks this function whether to: use
 * the access token it already has (`skip: fresh`), leave the work to the
 * refresher that holds the per-account lock (`skip: locked`), wait out a
 * provider-imposed or backoff delay (`skip: backoff`), refresh, or stop and
 * ask the human to reconnect (`needs_reauth`). A rotated refresh token that
 * was presented again is the RFC 9700 §4.14.2 theft signal: the family is
 * dead whatever else is true.
 */
import { describe, expect, it } from 'vitest';
import { decideRefresh, REFRESH_MAX_CONSECUTIVE_FAILURES, type RefreshAttemptFact } from '../decide-refresh';
import type { SecretMaterialByKind } from '../../store/store-adapter';

const NOW = 1_800_000_000_000;
const MARGIN_MS = 60_000;

const material = (overrides: Partial<SecretMaterialByKind['oauth2']> = {}): SecretMaterialByKind['oauth2'] => ({
  accessToken: 'synthetic-access',
  accessExpiresAt: NOW + 10 * 60_000,
  refreshToken: 'synthetic-refresh',
  scopes: ['calendar.readonly'],
  issuer: 'https://accounts.google.com',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  ...overrides,
});

const attempt = (overrides: Partial<RefreshAttemptFact> = {}): RefreshAttemptFact => ({
  at: NOW - 5_000,
  consecutiveFailures: 1,
  retryAt: null,
  rotationReplayed: false,
  ...overrides,
});

describe('decideRefresh', () => {
  it('given an access token that stays valid beyond the margin, should use it without spending the refresh token', () => {
    const actual = decideRefresh({ material: material(), now: NOW, marginMs: MARGIN_MS, lockHeld: false, lastAttempt: null });
    const expected = { action: 'skip', reason: 'fresh' };
    expect(actual).toEqual(expected);
  });

  it('given an access token inside the margin or already expired, should refresh', () => {
    const actual = [
      decideRefresh({ material: material({ accessExpiresAt: NOW + MARGIN_MS }), now: NOW, marginMs: MARGIN_MS, lockHeld: false, lastAttempt: null }),
      decideRefresh({ material: material({ accessExpiresAt: NOW - 1 }), now: NOW, marginMs: MARGIN_MS, lockHeld: false, lastAttempt: null }),
    ];
    const expected = [{ action: 'refresh' }, { action: 'refresh' }];
    expect(actual).toEqual(expected);
  });

  it('given an expiry that is not a finite number, should refresh rather than trust the access token', () => {
    const actual = [Number.NaN, Number.POSITIVE_INFINITY].map((accessExpiresAt) =>
      decideRefresh({ material: material({ accessExpiresAt }), now: NOW, marginMs: MARGIN_MS, lockHeld: false, lastAttempt: null }),
    );
    const expected = [{ action: 'refresh' }, { action: 'refresh' }];
    expect(actual).toEqual(expected);
  });

  it('given a rotated refresh token presented a second time, should require reauthorization even while the access token looks fresh', () => {
    const actual = decideRefresh({ material: material(), now: NOW, marginMs: MARGIN_MS, lockHeld: false, lastAttempt: attempt({ rotationReplayed: true }) });
    const expected = { action: 'needs_reauth', reason: 'rotation_replay' };
    expect(actual).toEqual(expected);
  });

  it('given an expiring access token and no refresh token, should require reauthorization', () => {
    const actual = decideRefresh({ material: material({ accessExpiresAt: NOW - 1, refreshToken: null }), now: NOW, marginMs: MARGIN_MS, lockHeld: false, lastAttempt: null });
    const expected = { action: 'needs_reauth', reason: 'no_refresh_token' };
    expect(actual).toEqual(expected);
  });

  it('given another refresher holding the per-account lock, should not refresh a second time', () => {
    const actual = decideRefresh({ material: material({ accessExpiresAt: NOW - 1 }), now: NOW, marginMs: MARGIN_MS, lockHeld: true, lastAttempt: null });
    const expected = { action: 'skip', reason: 'locked' };
    expect(actual).toEqual(expected);
  });

  it('given a retry time the last failure set that has not yet passed, should back off', () => {
    const actual = decideRefresh({ material: material({ accessExpiresAt: NOW - 1 }), now: NOW, marginMs: MARGIN_MS, lockHeld: false, lastAttempt: attempt({ retryAt: NOW + 1 }) });
    const expected = { action: 'skip', reason: 'backoff' };
    expect(actual).toEqual(expected);
  });

  it('given a retry time that has passed, should refresh', () => {
    const actual = decideRefresh({ material: material({ accessExpiresAt: NOW - 1 }), now: NOW, marginMs: MARGIN_MS, lockHeld: false, lastAttempt: attempt({ retryAt: NOW }) });
    const expected = { action: 'refresh' };
    expect(actual).toEqual(expected);
  });

  it('given the consecutive-failure cap reached, should stop retrying and require reauthorization', () => {
    const actual = [
      decideRefresh({ material: material({ accessExpiresAt: NOW - 1 }), now: NOW, marginMs: MARGIN_MS, lockHeld: false, lastAttempt: attempt({ consecutiveFailures: REFRESH_MAX_CONSECUTIVE_FAILURES }) }),
      decideRefresh({ material: material({ accessExpiresAt: NOW - 1 }), now: NOW, marginMs: MARGIN_MS, lockHeld: false, lastAttempt: attempt({ consecutiveFailures: REFRESH_MAX_CONSECUTIVE_FAILURES - 1 }) }),
    ];
    const expected = [{ action: 'needs_reauth', reason: 'exhausted' }, { action: 'refresh' }];
    expect(actual).toEqual(expected);
  });

  it('given the same inputs twice, should return the same decision', () => {
    const input = { material: material({ accessExpiresAt: NOW - 1 }), now: NOW, marginMs: MARGIN_MS, lockHeld: false, lastAttempt: attempt() } as const;
    const actual = decideRefresh(input);
    const expected = decideRefresh(input);
    expect(actual).toEqual(expected);
  });
});
