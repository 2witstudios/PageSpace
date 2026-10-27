/**
 * L3·G3 — `classifyRefreshFailure`: what the refresh worker does after a
 * refresh at the provider's token endpoint did not produce new material
 * (ADR 0003 §5 F4/F5 mirrored for providers; RFC 6749 §5.2; RFC 9700).
 *
 * Three outcomes, and the point is the one that must NOT happen: a grant the
 * provider has killed is never retried. `revoked` (the user's grant is dead
 * upstream: `invalid_grant`, or a 401 about the token) marks the connection
 * and stops; `purge_and_reauth` (a definitive rejection that is not the
 * grant's death — our client, the request, or a success we could not read)
 * also stops; `retryable` (network, timeout, 408, 429, 5xx) is the only
 * outcome that may be tried again, honouring Retry-After.
 */
import { describe, expect, it } from 'vitest';
import { classifyRefreshFailure } from '../classify-refresh-failure';

describe('classifyRefreshFailure', () => {
  it('given the provider rejecting the refresh token as invalid_grant, should classify the grant as revoked', () => {
    const actual = [400, 401].map((status) => classifyRefreshFailure({ failure: { kind: 'status', status, oauthError: 'invalid_grant', retryAfterMs: null } }));
    const expected = [
      { class: 'revoked', reason: 'invalid_grant' },
      { class: 'revoked', reason: 'invalid_grant' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a 401 that is not about our client, should classify the grant as revoked — never a retry loop', () => {
    const actual = [null, 'invalid_token', 'access_denied'].map((oauthError) => classifyRefreshFailure({ failure: { kind: 'status', status: 401, oauthError, retryAfterMs: null } }));
    const expected = [
      { class: 'revoked', reason: 'unauthorized' },
      { class: 'revoked', reason: 'unauthorized' },
      { class: 'revoked', reason: 'unauthorized' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given the provider refusing our client credentials, should purge and reauthorize rather than blame the grant', () => {
    const actual = [400, 401].map((status) => classifyRefreshFailure({ failure: { kind: 'status', status, oauthError: 'invalid_client', retryAfterMs: null } }));
    const expected = [
      { class: 'purge_and_reauth', reason: 'invalid_client' },
      { class: 'purge_and_reauth', reason: 'invalid_client' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given any other definitive 4xx rejection, should purge and reauthorize', () => {
    const actual = [
      classifyRefreshFailure({ failure: { kind: 'status', status: 400, oauthError: 'invalid_scope', retryAfterMs: null } }),
      classifyRefreshFailure({ failure: { kind: 'status', status: 400, oauthError: null, retryAfterMs: null } }),
      classifyRefreshFailure({ failure: { kind: 'status', status: 403, oauthError: null, retryAfterMs: null } }),
      classifyRefreshFailure({ failure: { kind: 'status', status: 404, oauthError: null, retryAfterMs: null } }),
    ];
    const expected = [
      { class: 'purge_and_reauth', reason: 'rejected' },
      { class: 'purge_and_reauth', reason: 'rejected' },
      { class: 'purge_and_reauth', reason: 'rejected' },
      { class: 'purge_and_reauth', reason: 'rejected' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a transient failure, should classify it retryable with no imposed delay', () => {
    const actual = [
      classifyRefreshFailure({ failure: { kind: 'network' } }),
      classifyRefreshFailure({ failure: { kind: 'timeout' } }),
      classifyRefreshFailure({ failure: { kind: 'status', status: 408, oauthError: null, retryAfterMs: null } }),
      classifyRefreshFailure({ failure: { kind: 'status', status: 503, oauthError: null, retryAfterMs: null } }),
    ];
    const expected = [
      { class: 'retryable', retryAfterMs: null },
      { class: 'retryable', retryAfterMs: null },
      { class: 'retryable', retryAfterMs: null },
      { class: 'retryable', retryAfterMs: null },
    ];
    expect(actual).toEqual(expected);
  });

  it('given rate limiting or a 5xx carrying Retry-After, should keep the provider-imposed delay', () => {
    const actual = [
      classifyRefreshFailure({ failure: { kind: 'status', status: 429, oauthError: null, retryAfterMs: 30_000 } }),
      classifyRefreshFailure({ failure: { kind: 'status', status: 502, oauthError: null, retryAfterMs: 5_000 } }),
    ];
    const expected = [
      { class: 'retryable', retryAfterMs: 30_000 },
      { class: 'retryable', retryAfterMs: 5_000 },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a Retry-After that is negative or not a finite number, should drop it rather than schedule nonsense', () => {
    const actual = [-1, Number.NaN, Number.POSITIVE_INFINITY].map((retryAfterMs) => classifyRefreshFailure({ failure: { kind: 'status', status: 429, oauthError: null, retryAfterMs } }));
    const expected = [
      { class: 'retryable', retryAfterMs: null },
      { class: 'retryable', retryAfterMs: null },
      { class: 'retryable', retryAfterMs: null },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a success response the worker could not read, should purge and reauthorize — the provider may already have rotated the refresh token', () => {
    const actual = classifyRefreshFailure({ failure: { kind: 'malformed_response' } });
    const expected = { class: 'purge_and_reauth', reason: 'malformed_response' };
    expect(actual).toEqual(expected);
  });

  it('given a redirect or other non-error status from the token endpoint, should purge and reauthorize rather than follow or retry', () => {
    const actual = [200, 302].map((status) => classifyRefreshFailure({ failure: { kind: 'status', status, oauthError: null, retryAfterMs: null } }));
    const expected = [
      { class: 'purge_and_reauth', reason: 'unexpected_status' },
      { class: 'purge_and_reauth', reason: 'unexpected_status' },
    ];
    expect(actual).toEqual(expected);
  });
});
