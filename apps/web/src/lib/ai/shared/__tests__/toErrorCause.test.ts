import { describe, it, expect } from 'vitest';
import { toErrorCause } from '../toErrorCause';

describe('toErrorCause', () => {
  it('given the out_of_credits code (402), should classify as out_of_credits, non-retryable', () => {
    const cause = toErrorCause(402, { error: 'out_of_credits', message: 'balance too low' });
    expect(cause).toEqual({ code: 'out_of_credits', httpStatus: 402, message: 'balance too low', retryable: false });
  });

  it('given the too_many_in_flight code (429), should classify as too_many_in_flight, retryable', () => {
    const cause = toErrorCause(429, { error: 'too_many_in_flight', message: 'wait for one to finish' });
    expect(cause).toEqual({ code: 'too_many_in_flight', httpStatus: 429, message: 'wait for one to finish', retryable: true });
  });

  it('given the daily_cap_exceeded code (429), should classify as daily_cap_exceeded, non-retryable', () => {
    const cause = toErrorCause(429, { error: 'daily_cap_exceeded', message: 'try again tomorrow' });
    expect(cause).toEqual({ code: 'daily_cap_exceeded', httpStatus: 429, message: 'try again tomorrow', retryable: false });
  });

  it('given a known code, should use the SERVER message when present', () => {
    const cause = toErrorCause(402, { error: 'out_of_credits', message: 'custom server copy' });
    expect(cause.message).toBe('custom server copy');
  });

  it('given a known code with NO server message, should fall back to friendly default copy', () => {
    const cause = toErrorCause(402, { error: 'out_of_credits' });
    expect(cause.message).toMatch(/credits/i);
  });

  it('given httpStatus 401 with an unrecognized/absent code, should classify as auth', () => {
    const cause = toErrorCause(401, {});
    expect(cause).toMatchObject({ code: 'auth', httpStatus: 401, retryable: false });
  });

  it('given httpStatus 429 with an unrecognized code, should classify as rate_limit', () => {
    const cause = toErrorCause(429, { error: 'something_else' });
    expect(cause).toMatchObject({ code: 'rate_limit', httpStatus: 429, retryable: true });
  });

  it('given a 5xx status with no recognizable code, should classify as unknown and retryable', () => {
    const cause = toErrorCause(503, {});
    expect(cause).toMatchObject({ code: 'unknown', httpStatus: 503, retryable: true });
  });

  it('given an unrecognized 4xx status with no code, should classify as unknown and non-retryable', () => {
    const cause = toErrorCause(418, {});
    expect(cause).toMatchObject({ code: 'unknown', httpStatus: 418, retryable: false });
  });

  it('given a malformed body (not an object), should classify as unknown, never crash', () => {
    expect(() => toErrorCause(500, 'not json')).not.toThrow();
    expect(toErrorCause(500, 'not json')).toMatchObject({ code: 'unknown', httpStatus: 500 });
  });

  it('given a null body, should classify as unknown, never crash', () => {
    expect(() => toErrorCause(500, null)).not.toThrow();
    expect(toErrorCause(500, null).code).toBe('unknown');
  });

  it('given an undefined body, should classify as unknown, never crash', () => {
    expect(toErrorCause(500, undefined).code).toBe('unknown');
  });

  it('given a body whose "error" field is not a string, should ignore it and fall through to status-based classification', () => {
    const cause = toErrorCause(401, { error: 123 });
    expect(cause.code).toBe('auth');
  });

  it('given a body whose "message" field is not a string, should ignore it and use default copy', () => {
    const cause = toErrorCause(402, { error: 'out_of_credits', message: 123 });
    expect(cause.message).toMatch(/credits/i);
  });

  it('should never let raw JSON reach the message (always a friendly string)', () => {
    const cause = toErrorCause(402, { error: 'out_of_credits' });
    expect(cause.message).not.toMatch(/[{}]/);
  });

  // PR 6 review (CodeRabbit, security): body.message is only trusted for KNOWN_CODES —
  // that shape comes exclusively from our own credit-gate-response.ts. Every
  // status-classified fallback branch (401/429-generic/5xx/default) can be fed by an
  // arbitrary upstream provider error, so it must never surface body.message verbatim.
  it('given a 5xx status with an unrecognized code, should ignore an arbitrary server message and use the local default', () => {
    const cause = toErrorCause(503, { error: 'upstream_boom', message: '<script>internal stack trace leaked here</script>' });
    expect(cause.message).not.toContain('internal stack trace');
    expect(cause.message).toMatch(/wrong/i);
  });

  it('given a 401 with an arbitrary server message, should ignore it and use the local auth default', () => {
    const cause = toErrorCause(401, { message: 'some provider-specific internal detail' });
    expect(cause.message).not.toBe('some provider-specific internal detail');
  });

  it('given a 429 with an unrecognized code and an arbitrary server message, should ignore it and use the local rate_limit default', () => {
    const cause = toErrorCause(429, { error: 'unrecognized', message: 'raw upstream body' });
    expect(cause.message).not.toBe('raw upstream body');
  });
});
