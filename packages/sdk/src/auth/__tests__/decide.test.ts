import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  NetworkError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from '../../errors.js';
import { classifyRefreshFailure, decideTokenAction, type OAuthTokenState } from '../decide.js';

function authenticated(accessExpiresAt: number): OAuthTokenState {
  return { status: 'authenticated', accessExpiresAt };
}

describe('decideTokenAction', () => {
  it('returns use-cached when well inside the skew window', () => {
    expect(decideTokenAction(authenticated(100_000), 0, 60_000)).toBe('use-cached');
  });

  it('returns use-cached with exactly one ms of margin beyond the skew boundary', () => {
    expect(decideTokenAction(authenticated(60_001), 0, 60_000)).toBe('use-cached');
  });

  it('returns refresh exactly at the skew boundary (now + skew === expiry)', () => {
    expect(decideTokenAction(authenticated(60_000), 0, 60_000)).toBe('refresh');
  });

  it('returns refresh once already inside the skew window', () => {
    expect(decideTokenAction(authenticated(59_999), 0, 60_000)).toBe('refresh');
  });

  it('returns refresh for an already-expired access token', () => {
    expect(decideTokenAction(authenticated(-1), 0, 60_000)).toBe('refresh');
  });

  it('returns unauthenticated regardless of the recorded expiry once terminal', () => {
    const state: OAuthTokenState = { status: 'unauthenticated', accessExpiresAt: Number.MAX_SAFE_INTEGER };
    expect(decideTokenAction(state, 0, 60_000)).toBe('unauthenticated');
  });

  it('honors a caller-configured skew window rather than a hardcoded constant', () => {
    expect(decideTokenAction(authenticated(5_000), 0, 1_000)).toBe('use-cached');
    expect(decideTokenAction(authenticated(5_000), 4_000, 1_000)).toBe('refresh');
  });
});

describe('classifyRefreshFailure', () => {
  it('classifies a network failure as retryable', () => {
    expect(classifyRefreshFailure(new NetworkError('offline'))).toBe('retryable');
  });

  it('classifies a timeout as retryable', () => {
    expect(classifyRefreshFailure(new TimeoutError('slow'))).toBe('retryable');
  });

  it('classifies a 429 rate limit as retryable', () => {
    expect(classifyRefreshFailure(new RateLimitError('slow down', 1000))).toBe('retryable');
  });

  it('classifies a 5xx server error as retryable', () => {
    expect(classifyRefreshFailure(new ServerError('boom', 500))).toBe('retryable');
    expect(classifyRefreshFailure(new ServerError('boom', 503))).toBe('retryable');
  });

  it('classifies a definitive invalid_grant-shaped 400 as terminal', () => {
    expect(classifyRefreshFailure(new ValidationError('invalid_grant', []))).toBe('terminal');
  });

  it('classifies 401 invalid_client as terminal', () => {
    expect(classifyRefreshFailure(new AuthenticationError('invalid_client'))).toBe('terminal');
  });

  it('classifies other definitive rejections as terminal', () => {
    expect(classifyRefreshFailure(new PermissionDeniedError('forbidden'))).toBe('terminal');
    expect(classifyRefreshFailure(new NotFoundError('gone'))).toBe('terminal');
  });

  it('fails closed (terminal) for an unrecognized error shape rather than retry-looping forever', () => {
    expect(classifyRefreshFailure(new Error('mystery'))).toBe('terminal');
    expect(classifyRefreshFailure('not an error')).toBe('terminal');
    expect(classifyRefreshFailure(undefined)).toBe('terminal');
  });
});
