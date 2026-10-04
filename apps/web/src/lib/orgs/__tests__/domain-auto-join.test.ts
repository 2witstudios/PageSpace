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

  it('SEC-1 (partial) no other route provisions an account or verifies an address without being listed here', () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (entry.name === 'route.ts') {
          const source = fs.readFileSync(full, 'utf8');
          if (/provisionHomeDriveIfNeeded\(|markEmailVerified(ForAddress)?\(/.test(source)) found.push(path.relative(API, full));
        }
      }
    };
    walk(API);
    expect(found.sort()).toEqual([...SIGN_IN_PATHS].sort());
  });
});
