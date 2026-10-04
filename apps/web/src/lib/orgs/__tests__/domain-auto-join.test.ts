/**
 * The sign-in seam of verified-domain auto-join (SEC-1): the helper never fails a sign-in, and every path
 * that creates an account or verifies an address calls it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/organizations/domains', () => ({ autoJoinVerifiedDomainOrg: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { auth: { error: vi.fn() } } }));
vi.mock('@/lib/org-billing/seat-billing', () => ({ defaultSeatBilling: () => ({ port: 'stripe' }) }));

import { autoJoinVerifiedDomainOrg } from '@pagespace/lib/organizations/domains';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { autoJoinVerifiedDomainAfterSignIn } from '../domain-auto-join';

beforeEach(() => vi.clearAllMocks());

describe('autoJoinVerifiedDomainAfterSignIn', () => {
  it('SEC-1 (partial) joins through the lib service with the Stripe seat port, so a full org with auto-add can raise a seat', async () => {
    vi.mocked(autoJoinVerifiedDomainOrg).mockResolvedValue({ kind: 'joined', orgId: 'org_1', seatRaised: false });
    await autoJoinVerifiedDomainAfterSignIn('user_lena');
    expect(autoJoinVerifiedDomainOrg).toHaveBeenCalledWith({ userId: 'user_lena', now: expect.any(Date), seatBilling: { port: 'stripe' } });
  });

  it('SEC-1 (partial) never fails a sign-in: an error is logged and swallowed', async () => {
    vi.mocked(autoJoinVerifiedDomainOrg).mockRejectedValue(new Error('db down'));
    await expect(autoJoinVerifiedDomainAfterSignIn('user_lena')).resolves.toBeUndefined();
    expect(loggers.auth.error).toHaveBeenCalled();
  });
});

describe('the sign-in seam', () => {
  const API = path.resolve(__dirname, '../../../app/api');
  /** Every route that provisions a signed-in account or marks an address verified. */
  const SIGN_IN_PATHS = [
    'auth/google/callback/route.ts',
    'auth/google/one-tap/route.ts',
    'auth/google/native/route.ts',
    'auth/mobile/oauth/google/exchange/route.ts',
    'auth/apple/callback/route.ts',
    'auth/apple/native/route.ts',
    'auth/magic-link/verify/route.ts',
    'auth/signup-passkey/route.ts',
    'auth/verify-email/route.ts',
  ];

  it('SEC-1 (partial) every signup, sign-in and email-verification path calls the auto-join seam', () => {
    for (const rel of SIGN_IN_PATHS) {
      const source = fs.readFileSync(path.join(API, rel), 'utf8');
      expect(source, rel).toMatch(/await autoJoinVerifiedDomainAfterSignIn\(/);
    }
  });

  /**
   * What makes a route a sign-in seam: it provisions an account's Home drive, marks an address
   * verified, or CREATES an account (directly or through the lib helpers that do). A new route with any
   * of these must call the hook, or be exempted here with the reason it needs no join.
   */
  const SEAM_MARKERS = /provisionHomeDriveIfNeeded\(|markEmailVerified(ForAddress)?\(|createUser\(|insert\(users\)|createOrLinkOAuthUser\(|verifySignupRegistration\(|buildMagicLinkPorts\(/;
  const EXEMPT: Record<string, string> = {
    'auth/magic-link/send/route.ts': 'creates an UNVERIFIED account and emails the link; the join runs when the link is redeemed (auth/magic-link/verify)',
  };

  it('SEC-1 (partial) no route creates an account, provisions one or verifies an address without the seam (or a stated exemption)', () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (entry.name === 'route.ts') {
          if (SEAM_MARKERS.test(fs.readFileSync(full, 'utf8'))) found.push(path.relative(API, full));
        }
      }
    };
    walk(API);
    expect(found.filter((rel) => !(rel in EXEMPT)).sort()).toEqual([...SIGN_IN_PATHS].sort());
    for (const rel of Object.keys(EXEMPT)) expect(found).toContain(rel);
  });
});
