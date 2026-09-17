import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@pagespace/lib/repositories/account-repository', () => ({
  accountRepository: { findById: vi.fn() },
}));
vi.mock('@pagespace/lib/auth/apple/apple-token-store', () => ({
  appleTokenStore: { hasForUser: vi.fn() },
}));
vi.mock('@pagespace/lib/auth/apple/apple-client-secret', () => ({
  getAppleSigningConfig: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { GET } from '../route';
import { accountRepository } from '@pagespace/lib/repositories/account-repository';
import { appleTokenStore } from '@pagespace/lib/auth/apple/apple-token-store';
import { getAppleSigningConfig } from '@pagespace/lib/auth/apple/apple-client-secret';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const auth: SessionAuthResult = {
  userId: 'user-1',
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  adminRoleVersion: 0,
};

const account = (appleId: string | null) => ({ id: 'user-1', email: 'a@b.com', image: null, stripeCustomerId: null, appleId });
const request = () => new Request('https://example.com/api/account/apple-sign-in');
const config = { teamId: 'T', keyId: 'K', privateKey: 'P' };

describe('GET /api/account/apple-sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getAppleSigningConfig).mockReturnValue(config);
    vi.mocked(appleTokenStore.hasForUser).mockResolvedValue(false);
  });

  it('given an unauthenticated request, should return the auth error', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });

    expect((await GET(request())).status).toBe(401);
  });

  it('given a user who never signed in with Apple, should report not linked', async () => {
    vi.mocked(accountRepository.findById).mockResolvedValue(account(null));

    const res = await GET(request());

    expect(await res.json()).toEqual({ linked: false, revocation: 'none' });
    expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ eventType: 'data.read', userId: 'user-1' }));
  });

  it('given an Apple user with a stored token and a signing key, should report automatic revocation', async () => {
    vi.mocked(accountRepository.findById).mockResolvedValue(account('apple-sub-1'));
    vi.mocked(appleTokenStore.hasForUser).mockResolvedValue(true);

    expect(await (await GET(request())).json()).toEqual({ linked: true, revocation: 'automatic' });
  });

  it('given an Apple user with no stored token, should report manual revocation', async () => {
    vi.mocked(accountRepository.findById).mockResolvedValue(account('apple-sub-1'));

    expect(await (await GET(request())).json()).toEqual({ linked: true, revocation: 'manual' });
  });

  it('given a stored token but no signing key, should report manual revocation', async () => {
    vi.mocked(accountRepository.findById).mockResolvedValue(account('apple-sub-1'));
    vi.mocked(appleTokenStore.hasForUser).mockResolvedValue(true);
    vi.mocked(getAppleSigningConfig).mockReturnValue(null);

    expect(await (await GET(request())).json()).toEqual({ linked: true, revocation: 'manual' });
  });

  it('given the account is gone, should 404', async () => {
    vi.mocked(accountRepository.findById).mockResolvedValue(null);

    expect((await GET(request())).status).toBe(404);
  });
});
