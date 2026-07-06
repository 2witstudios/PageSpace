import { describe, it, expect } from 'vitest';
import {
  buildConsentActionBinding,
  readStepUpTokenFromHash,
  stripStepUpTokenFromHash,
  isNoPasskeyError,
} from '../consent-step-up';

describe('buildConsentActionBinding', () => {
  it('maps the consent params to the exact binding parts the server recomputes', () => {
    expect(
      buildConsentActionBinding({ clientId: 'cli-1', redirectUri: 'http://127.0.0.1:1/cb', scope: 'account', state: 'xyz' }),
    ).toEqual({ clientId: 'cli-1', redirectUri: 'http://127.0.0.1:1/cb', scope: 'account', state: 'xyz' });
  });

  it('normalizes an absent state to an empty string (matches server-side `body.state ?? \'\'`)', () => {
    expect(
      buildConsentActionBinding({ clientId: 'cli-1', redirectUri: 'http://127.0.0.1:1/cb', scope: 'account', state: undefined }),
    ).toEqual({ clientId: 'cli-1', redirectUri: 'http://127.0.0.1:1/cb', scope: 'account', state: '' });
  });
});

describe('readStepUpTokenFromHash', () => {
  it('returns null when the fragment is empty', () => {
    expect(readStepUpTokenFromHash('')).toBeNull();
  });

  it('returns null when step_up_token is absent from the fragment', () => {
    expect(readStepUpTokenFromHash('#other=x')).toBeNull();
  });

  it('returns the token when present', () => {
    expect(readStepUpTokenFromHash('#step_up_token=ps_stepup_abc')).toBe('ps_stepup_abc');
  });

  it('reads the token alongside other fragment params', () => {
    expect(readStepUpTokenFromHash('#other=x&step_up_token=ps_stepup_abc')).toBe('ps_stepup_abc');
  });
});

describe('stripStepUpTokenFromHash', () => {
  it('removes step_up_token but keeps other fragment params', () => {
    expect(stripStepUpTokenFromHash('#other=x&step_up_token=ps_stepup_abc')).toBe('#other=x');
  });

  it('returns an empty string when step_up_token was the only fragment param', () => {
    expect(stripStepUpTokenFromHash('#step_up_token=ps_stepup_abc')).toBe('');
  });

  it('is a no-op on a fragment without the token', () => {
    expect(stripStepUpTokenFromHash('#other=x')).toBe('#other=x');
  });

  it('returns an empty string for an empty fragment', () => {
    expect(stripStepUpTokenFromHash('')).toBe('');
  });
});

describe('isNoPasskeyError', () => {
  it('is true for an Error whose message is exactly "no_passkey"', () => {
    expect(isNoPasskeyError(new Error('no_passkey'))).toBe(true);
  });

  it('is false for any other error message', () => {
    expect(isNoPasskeyError(new Error('step_up_invalid'))).toBe(false);
  });

  it('is false for a non-Error value', () => {
    expect(isNoPasskeyError('no_passkey')).toBe(false);
    expect(isNoPasskeyError(null)).toBe(false);
  });
});
