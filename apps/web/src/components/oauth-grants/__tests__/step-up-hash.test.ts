import { describe, it, expect } from 'vitest';
import { readStepUpTokenFromHash, stripStepUpTokenFromHash, isNoPasskeyError } from '../step-up-hash';

describe('readStepUpTokenFromHash', () => {
  it('reads the token from a leading-# fragment', () => {
    expect(readStepUpTokenFromHash('#step_up_token=abc123')).toBe('abc123');
  });

  it('reads the token when other params are present', () => {
    expect(readStepUpTokenFromHash('#foo=bar&step_up_token=abc123')).toBe('abc123');
  });

  it('returns null when absent', () => {
    expect(readStepUpTokenFromHash('#foo=bar')).toBeNull();
    expect(readStepUpTokenFromHash('')).toBeNull();
  });
});

describe('stripStepUpTokenFromHash', () => {
  it('removes the token, leaving other params intact', () => {
    expect(stripStepUpTokenFromHash('#foo=bar&step_up_token=abc123')).toBe('#foo=bar');
  });

  it('returns an empty string when nothing is left', () => {
    expect(stripStepUpTokenFromHash('#step_up_token=abc123')).toBe('');
  });
});

describe('isNoPasskeyError', () => {
  it('recognizes the no_passkey signal error', () => {
    expect(isNoPasskeyError(new Error('no_passkey'))).toBe(true);
  });

  it('rejects any other error or non-error value', () => {
    expect(isNoPasskeyError(new Error('something_else'))).toBe(false);
    expect(isNoPasskeyError('no_passkey')).toBe(false);
    expect(isNoPasskeyError(null)).toBe(false);
  });
});
