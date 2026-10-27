import { describe, it, expect } from 'vitest';
import { parseLegacyErrorMessage } from '../parseLegacyErrorMessage';

describe('parseLegacyErrorMessage', () => {
  it('given a JSON-shaped message carrying a known code, should delegate to toErrorCause via the parsed body', () => {
    const cause = parseLegacyErrorMessage('{"error":"out_of_credits","message":"balance too low"}');
    expect(cause).toEqual({ code: 'out_of_credits', httpStatus: null, message: 'balance too low', retryable: false });
  });

  it('given a plain "401 Unauthorized" string, should classify as auth', () => {
    expect(parseLegacyErrorMessage('Request failed with 401').code).toBe('auth');
  });

  it('given human phrasing "out of credits", should classify as out_of_credits', () => {
    expect(parseLegacyErrorMessage('You have run out of credits.').code).toBe('out_of_credits');
  });

  it('given "too many in flight" phrasing, should classify as too_many_in_flight', () => {
    expect(parseLegacyErrorMessage('Too many AI requests in flight at once.').code).toBe('too_many_in_flight');
  });

  it('given rate-limit phrasing, should classify as rate_limit', () => {
    expect(parseLegacyErrorMessage('rate limit exceeded').code).toBe('rate_limit');
  });

  it('given an unrecognized plain string, should classify as unknown', () => {
    expect(parseLegacyErrorMessage('something exploded').code).toBe('unknown');
  });

  it('given undefined, should classify as unknown, never crash', () => {
    expect(() => parseLegacyErrorMessage(undefined)).not.toThrow();
    expect(parseLegacyErrorMessage(undefined).code).toBe('unknown');
  });

  it('given an empty string, should classify as unknown', () => {
    expect(parseLegacyErrorMessage('').code).toBe('unknown');
  });

  it('httpStatus should always be null (legacy path never has a real status)', () => {
    expect(parseLegacyErrorMessage('out_of_credits').httpStatus).toBeNull();
  });

  it('should never surface the raw message as-is (always friendly copy)', () => {
    const raw = '{"error":"out_of_credits","message":"raw json leaking through"}';
    // The JSON path DOES surface the server's own message field (still friendly, not raw JSON) —
    // this pins that we never fall back to printing the whole raw string itself.
    expect(parseLegacyErrorMessage(raw).message).not.toBe(raw);
  });
});
