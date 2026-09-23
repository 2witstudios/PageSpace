/**
 * L3·G3 — `decideRefreshRefusal`: what the refresh worker reports when it
 * refuses before sending anything (Control Board §7.1: the adapter holds no
 * decision logic). A resolve refusal because the version moved is
 * `version_conflict` (the caller re-issues with the current version); every
 * other resolve refusal is `store_unavailable`. A stored endpoint that
 * disagrees with the pinned registry is tampering: the account is marked
 * `needs_reauth`. A generic or unknown provider is simply `not_refreshable`.
 */
import { describe, expect, it } from 'vitest';
import { decideRefreshRefusal } from '../decide-refresh-refusal';

describe('decideRefreshRefusal', () => {
  it('given a resolve refusal because the version moved, should report a version conflict without marking the account', () => {
    const actual = (['version_mismatch', 'bindings_stale'] as const).map((reason) => decideRefreshRefusal({ refusal: { from: 'resolve', reason } }));
    const expected = [
      { outcome: 'version_conflict', markNeedsReauth: false },
      { outcome: 'version_conflict', markNeedsReauth: false },
    ];
    expect(actual).toEqual(expected);
  });

  it('given any other resolve refusal, should report the store unavailable', () => {
    const actual = (['binding_mismatch', 'kind_not_resolvable', 'identity_refused', 'revoked', 'not_found', 'store_unavailable'] as const).map((reason) => decideRefreshRefusal({ refusal: { from: 'resolve', reason } }).outcome);
    const expected = Array.from({ length: 6 }, () => 'store_unavailable');
    expect(actual).toEqual(expected);
  });

  it('given a stored endpoint that disagrees with the pinned registry, should mark the account for reauthorization', () => {
    const actual = decideRefreshRefusal({ refusal: { from: 'endpoint', reason: 'endpoint_mismatch' } });
    const expected = { outcome: 'needs_reauth', markNeedsReauth: true };
    expect(actual).toEqual(expected);
  });

  it('given a generic or unknown provider, should report it not refreshable and leave the account alone', () => {
    const actual = decideRefreshRefusal({ refusal: { from: 'endpoint', reason: 'unknown_provider' } });
    const expected = { outcome: 'not_refreshable', markNeedsReauth: false };
    expect(actual).toEqual(expected);
  });
});
