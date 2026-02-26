import { describe, it, expect } from 'vitest';
import { isContextLengthError } from '../error-messages';

describe('isContextLengthError', () => {
  it('returns false for undefined', () => {
    expect(isContextLengthError(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isContextLengthError('')).toBe(false);
  });

  it('detects context_length_exceeded API key', () => {
    expect(isContextLengthError('context_length_exceeded')).toBe(true);
  });

  it('detects "context length" human-readable phrasing', () => {
    expect(isContextLengthError('The context length is too long')).toBe(true);
  });

  it('detects "context window" phrasing', () => {
    expect(isContextLengthError('Exceeds model context window')).toBe(true);
  });

  it('detects "maximum context" phrasing', () => {
    expect(isContextLengthError('maximum context size exceeded')).toBe(true);
  });

  it('detects "token limit" phrasing', () => {
    expect(isContextLengthError('token limit exceeded')).toBe(true);
  });

  it('detects "tokens exceeds" phrasing', () => {
    expect(isContextLengthError('number of tokens exceeds the maximum')).toBe(true);
  });

  it('detects "too many tokens" phrasing', () => {
    expect(isContextLengthError('too many tokens in request')).toBe(true);
  });

  it('detects OpenRouter "maximum" + "tokens" combination', () => {
    expect(isContextLengthError('maximum number of tokens allowed')).toBe(true);
  });

  // Issue #5: 413 alone should NOT match (could be body-size 413)
  it('does NOT match bare "413" without context/token keywords', () => {
    expect(isContextLengthError('Request body too large (max 25MB)')).toBe(false);
    expect(isContextLengthError('HTTP 413')).toBe(false);
    expect(isContextLengthError('413 Payload Too Large')).toBe(false);
  });

  it('matches 413 when combined with "context" keyword', () => {
    expect(isContextLengthError('413 context length exceeded')).toBe(true);
  });

  it('matches 413 when combined with "token" keyword', () => {
    expect(isContextLengthError('413 token limit')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isContextLengthError('rate limit exceeded')).toBe(false);
    expect(isContextLengthError('network timeout')).toBe(false);
    expect(isContextLengthError('invalid API key')).toBe(false);
  });
});
