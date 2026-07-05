import { describe, it, expect } from 'vitest';
import {
  buildConsentActionBinding,
  readStepUpTokenFromSearch,
  stripStepUpTokenFromSearch,
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

describe('readStepUpTokenFromSearch', () => {
  it('returns null when step_up_token is absent', () => {
    expect(readStepUpTokenFromSearch('?client_id=x')).toBeNull();
  });

  it('returns the token when present', () => {
    expect(readStepUpTokenFromSearch('?client_id=x&step_up_token=ps_stepup_abc')).toBe('ps_stepup_abc');
  });
});

describe('stripStepUpTokenFromSearch', () => {
  it('removes step_up_token but keeps other params', () => {
    expect(stripStepUpTokenFromSearch('?client_id=x&step_up_token=ps_stepup_abc&scope=account')).toBe(
      '?client_id=x&scope=account',
    );
  });

  it('returns an empty string when step_up_token was the only param', () => {
    expect(stripStepUpTokenFromSearch('?step_up_token=ps_stepup_abc')).toBe('');
  });

  it('is a no-op when step_up_token is absent', () => {
    expect(stripStepUpTokenFromSearch('?client_id=x')).toBe('?client_id=x');
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
