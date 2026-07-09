/**
 * Regression guard for the on-prem setup-link token format.
 *
 * The verify route (`magic-link-service.verifyMagicLinkToken`) rejects any token
 * that does not start with `ps_magic_`. A bare `createVerificationToken` hex
 * token therefore always fails with `invalid_token`, which would leave
 * credential-less on-prem users unable to bootstrap a passkey. These tests lock
 * the helper to the `ps_magic_` mint + `verificationTokens` persistence used by
 * the real magic-link send flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertValues = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValues })),
  },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  verificationTokens: {
    id: 'id',
    userId: 'userId',
    tokenHash: 'tokenHash',
    tokenPrefix: 'tokenPrefix',
    type: 'type',
    expiresAt: 'expiresAt',
  },
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

import { generateOnPremSetupLink } from '../onprem-setup-link';

describe('generateOnPremSetupLink', () => {
  beforeEach(() => {
    insertValues.mockReset().mockResolvedValue(undefined);
    vi.stubEnv('WEB_APP_URL', 'https://onprem.local');
  });

  it('mints a ps_magic_-prefixed token so the verify route accepts it', async () => {
    const link = await generateOnPremSetupLink('user-1');

    const url = new URL(link);
    const token = url.searchParams.get('token')!;
    expect(token.startsWith('ps_magic_')).toBe(true);
  });

  it('persists the token as a magic_link verificationTokens row for the user', async () => {
    await generateOnPremSetupLink('user-1');

    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0][0];
    expect(row).toMatchObject({ userId: 'user-1', type: 'magic_link' });
    // Stores the HASH, never the plaintext token.
    expect(typeof row.tokenHash).toBe('string');
    expect(row.tokenHash.startsWith('ps_magic_')).toBe(false);
    expect(row.expiresAt).toBeInstanceOf(Date);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('points the link at the web app verify endpoint', async () => {
    const link = await generateOnPremSetupLink('user-1');
    expect(link.startsWith('https://onprem.local/api/auth/magic-link/verify?token=')).toBe(true);
  });
});
