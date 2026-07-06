import { describe, it, expect } from 'vitest';
import {
  classifyAIError,
  getAIErrorMessage,
  isAuthenticationError,
  isOutOfCreditsError,
  isInFlightCapError,
  isRateLimitError,
} from '../error-messages';

describe('classifyAIError', () => {
  it('classifies auth failures', () => {
    expect(classifyAIError('Unauthorized')).toBe('auth');
    expect(classifyAIError('Request failed with 401')).toBe('auth');
  });

  it('classifies out-of-credits (402 / error code / human phrasing)', () => {
    expect(classifyAIError('{"error":"out_of_credits"}')).toBe('out_of_credits');
    expect(classifyAIError('Request failed: 402')).toBe('out_of_credits');
    expect(classifyAIError('You have run out of credits.')).toBe('out_of_credits');
  });

  it('classifies the in-flight concurrency cap (429 too_many_in_flight)', () => {
    expect(classifyAIError('{"error":"too_many_in_flight"}')).toBe('too_many_in_flight');
    expect(classifyAIError('Too many AI requests in flight at once.')).toBe('too_many_in_flight');
  });

  it('classifies provider rate limits / transient failures', () => {
    expect(classifyAIError('rate limit exceeded')).toBe('rate_limit');
    expect(classifyAIError('Provider returned error')).toBe('rate_limit');
    expect(classifyAIError('Failed after 3 retries')).toBe('rate_limit');
  });

  it('falls back to generic', () => {
    expect(classifyAIError(undefined)).toBe('generic');
    expect(classifyAIError('something exploded')).toBe('generic');
  });
});

describe('getAIErrorMessage', () => {
  it('returns distinct, actionable copy per kind', () => {
    expect(getAIErrorMessage('out_of_credits')).toMatch(/credits/i);
    expect(getAIErrorMessage('too_many_in_flight')).toMatch(/wait/i);
    expect(getAIErrorMessage('401')).toMatch(/authentication/i);
    expect(getAIErrorMessage('rate limit')).toMatch(/busy|try again/i);
    expect(getAIErrorMessage(undefined)).toMatch(/something went wrong/i);
  });

  it('does not mislabel an out-of-credits denial as a free-tier rate limit', () => {
    expect(getAIErrorMessage('out_of_credits')).not.toMatch(/rate limit/i);
  });
});

describe('predicate helpers', () => {
  it('isAuthenticationError', () => {
    expect(isAuthenticationError('401 Unauthorized')).toBe(true);
    expect(isAuthenticationError('out_of_credits')).toBe(false);
  });

  it('isOutOfCreditsError', () => {
    expect(isOutOfCreditsError('out_of_credits')).toBe(true);
    expect(isOutOfCreditsError('too_many_in_flight')).toBe(false);
  });

  it('isInFlightCapError', () => {
    expect(isInFlightCapError('too_many_in_flight')).toBe(true);
    expect(isInFlightCapError('402')).toBe(false);
  });

  it('isRateLimitError covers waitable/buyable denials', () => {
    expect(isRateLimitError('rate limit')).toBe(true);
    expect(isRateLimitError('out_of_credits')).toBe(true);
    expect(isRateLimitError('too_many_in_flight')).toBe(true);
    expect(isRateLimitError('boom')).toBe(false);
  });
});
