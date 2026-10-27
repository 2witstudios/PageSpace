import { describe, it, expect } from 'vitest';
import { resolveOAuthMatch, type OAuthMatchDecision } from '../oauth-account-match';

/**
 * Decision matrix for the OAuth account-match rule that closes audit finding M5
 * (pre-account takeover via an unverified provider email). The provider subject
 * id (googleId/appleId) is the strong identity and may always match; matching an
 * EXISTING account by raw email is only allowed when the provider asserts the
 * email is verified.
 */
describe('resolveOAuthMatch', () => {
  // Every combination of (providerSubMatch, emailMatch, emailVerified) is pinned
  // so the security rule cannot silently drift.
  const cases: Array<{
    providerSubMatch: boolean;
    emailMatch: boolean;
    emailVerified: boolean;
    expected: OAuthMatchDecision;
    why: string;
  }> = [
    // Subject-id match is authoritative — it wins regardless of email/verification.
    { providerSubMatch: true, emailMatch: true, emailVerified: true, expected: 'use-sub', why: 'returning user, verified' },
    { providerSubMatch: true, emailMatch: true, emailVerified: false, expected: 'use-sub', why: 'returning user, unverified email still ok via sub' },
    { providerSubMatch: true, emailMatch: false, emailVerified: true, expected: 'use-sub', why: 'sub match, email changed/absent' },
    { providerSubMatch: true, emailMatch: false, emailVerified: false, expected: 'use-sub', why: 'sub match dominates even unverified' },

    // No subject match: link by email ONLY when verified.
    { providerSubMatch: false, emailMatch: true, emailVerified: true, expected: 'use-email', why: 'verified email links to existing account' },
    // THE FIX: unverified email that collides with an existing account => takeover guard.
    { providerSubMatch: false, emailMatch: true, emailVerified: false, expected: 'reject', why: 'unverified email must NOT link to existing account' },

    // No subject match, no email collision => fresh signup.
    { providerSubMatch: false, emailMatch: false, emailVerified: true, expected: 'create-new', why: 'brand new verified user' },
    { providerSubMatch: false, emailMatch: false, emailVerified: false, expected: 'create-new', why: 'brand new unverified user (no collision)' },
  ];

  it.each(cases)(
    'sub=$providerSubMatch email=$emailMatch verified=$emailVerified -> $expected ($why)',
    ({ providerSubMatch, emailMatch, emailVerified, expected }) => {
      expect(resolveOAuthMatch({ providerSubMatch, emailMatch, emailVerified })).toBe(expected);
    },
  );

  it('never links by email when the email is unverified and there is no sub match', () => {
    // Property: the only takeover path (unverified email-only) is always refused.
    expect(resolveOAuthMatch({ providerSubMatch: false, emailMatch: true, emailVerified: false })).not.toBe('use-email');
  });
});
