import { describe, it, expect } from 'vitest';
import {
  getAIErrorMessage,
  isContextLengthError,
  isRateLimitError,
  isAuthenticationError,
} from '../error-messages';

describe('isContextLengthError', () => {
  it('returns false for undefined/empty input', () => {
    expect(isContextLengthError(undefined)).toBe(false);
    expect(isContextLengthError('')).toBe(false);
  });

  it('detects context_length_exceeded API key', () => {
    expect(isContextLengthError('context_length_exceeded')).toBe(true);
    expect(isContextLengthError('Error: context_length_exceeded for model gpt-4o')).toBe(true);
  });

  it('detects human-readable context length variants', () => {
    expect(isContextLengthError('context length exceeded')).toBe(true);
    expect(isContextLengthError('exceeds the context window')).toBe(true);
    expect(isContextLengthError('maximum context length is 128000 tokens')).toBe(true);
  });

  it('detects token limit errors', () => {
    expect(isContextLengthError('token limit exceeded')).toBe(true);
    expect(isContextLengthError('number of tokens exceeds the maximum')).toBe(true);
    expect(isContextLengthError('too many tokens in the request')).toBe(true);
  });

  it('detects provider-specific "maximum tokens" phrasing', () => {
    expect(isContextLengthError('maximum number of tokens allowed is 200000')).toBe(true);
  });

  it('detects HTTP 413 in status-code patterns only', () => {
    expect(isContextLengthError('HTTP 413')).toBe(true);
    expect(isContextLengthError('status 413')).toBe(true);
    expect(isContextLengthError('error 413: payload too large')).toBe(true);
    expect(isContextLengthError('code 413')).toBe(true);
  });

  it('does NOT false-positive on bare "413" in other contexts', () => {
    expect(isContextLengthError('processed 413 items successfully')).toBe(false);
    expect(isContextLengthError('user ID 4130 not found')).toBe(false);
    expect(isContextLengthError('port 4135 is in use')).toBe(false);
  });

  it('does NOT match unrelated error messages', () => {
    expect(isContextLengthError('rate limit exceeded')).toBe(false);
    expect(isContextLengthError('Unauthorized')).toBe(false);
    expect(isContextLengthError('Internal server error')).toBe(false);
    expect(isContextLengthError('Provider returned error')).toBe(false);
  });
});

describe('isRateLimitError', () => {
  it('returns false for undefined/empty input', () => {
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError('')).toBe(false);
  });

  it('detects rate limit errors', () => {
    expect(isRateLimitError('rate limit exceeded')).toBe(true);
    expect(isRateLimitError('429 Too Many Requests')).toBe(true);
    expect(isRateLimitError('402 Payment Required')).toBe(true);
    expect(isRateLimitError('Failed after 3 retries')).toBe(true);
    expect(isRateLimitError('Provider returned error')).toBe(true);
  });

  it('excludes context-length errors that contain "limit"', () => {
    expect(isRateLimitError('token limit exceeded')).toBe(false);
    expect(isRateLimitError('context_length_exceeded')).toBe(false);
    expect(isRateLimitError('maximum context length limit')).toBe(false);
  });
});

describe('isAuthenticationError', () => {
  it('detects auth errors', () => {
    expect(isAuthenticationError('Unauthorized')).toBe(true);
    expect(isAuthenticationError('401 Unauthorized')).toBe(true);
  });

  it('returns false for non-auth errors', () => {
    expect(isAuthenticationError(undefined)).toBe(false);
    expect(isAuthenticationError('rate limit exceeded')).toBe(false);
  });
});

describe('getAIErrorMessage', () => {
  it('returns generic message for undefined input', () => {
    expect(getAIErrorMessage(undefined)).toBe('Something went wrong. Please try again.');
  });

  it('returns auth message for Unauthorized errors', () => {
    expect(getAIErrorMessage('Unauthorized')).toBe(
      'Authentication failed. Please refresh the page and try again.'
    );
  });

  it('returns context-length message for context errors', () => {
    const msg = getAIErrorMessage('context_length_exceeded');
    expect(msg).toContain('context window');
    expect(msg).not.toContain('trimmed');
  });

  it('returns rate-limit message for rate errors', () => {
    const msg = getAIErrorMessage('429 Too Many Requests');
    expect(msg).toContain('rate limit');
  });

  it('returns generic message for unknown errors', () => {
    expect(getAIErrorMessage('some random error')).toBe(
      'Something went wrong. Please try again.'
    );
  });
});
