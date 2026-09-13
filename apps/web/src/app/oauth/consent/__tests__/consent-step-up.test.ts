import { describe, it, expect } from 'vitest';
import { buildConsentActionBinding, consentRequiresStepUp } from '../consent-step-up';

// Hash-parsing and no-passkey-detection helpers are covered once, against
// the single shared implementation, in `lib/auth/__tests__/step-up-ceremony.test.ts`.
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

describe('consentRequiresStepUp', () => {
  it('is false for identity alone', () => {
    expect(consentRequiresStepUp('profile')).toBe(false);
    expect(consentRequiresStepUp('profile offline_access')).toBe(false);
  });

  it('is true for anything that reaches content or key management', () => {
    expect(consentRequiresStepUp('account')).toBe(true);
    expect(consentRequiresStepUp('manage_keys offline_access')).toBe(true);
    expect(consentRequiresStepUp('profile drive:abc123:member')).toBe(true);
  });

  it('fails closed (true) on a scope string that does not parse', () => {
    expect(consentRequiresStepUp('not a scope!!')).toBe(true);
  });
});
