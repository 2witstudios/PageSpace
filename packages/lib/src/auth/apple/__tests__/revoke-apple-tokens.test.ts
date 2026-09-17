import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../apple-token-api', () => ({
  revokeAppleRefreshToken: vi.fn(),
}));
vi.mock('../apple-token-store', () => ({
  appleTokenStore: { listForUser: vi.fn(), deleteForUser: vi.fn() },
}));
vi.mock('../../../logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { revokeAndDiscardAppleTokens, appleSignInDeletionOutcome } from '../revoke-apple-tokens';
import { revokeAppleRefreshToken } from '../apple-token-api';
import { appleTokenStore } from '../apple-token-store';
import { encryptField } from '../../../encryption/field-crypto';
import type { AppleSigningConfig } from '../apple-client-secret';

const config: AppleSigningConfig = { teamId: 'T', keyId: 'K', privateKey: 'unused-by-mocked-api' };

async function storedRows() {
  return [
    { clientId: 'ai.pagespace.ios', refreshToken: await encryptField('rt-native') },
    { clientId: 'ai.pagespace.web', refreshToken: await encryptField('rt-web') },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(appleTokenStore.deleteForUser).mockResolvedValue(2);
});

describe('revokeAndDiscardAppleTokens', () => {
  it('given stored tokens, should revoke each decrypted token with the client it was issued to, then delete them', async () => {
    vi.mocked(appleTokenStore.listForUser).mockResolvedValue(await storedRows());
    vi.mocked(revokeAppleRefreshToken).mockResolvedValue({ ok: true });

    const summary = await revokeAndDiscardAppleTokens('user-1', config);

    expect(revokeAppleRefreshToken).toHaveBeenCalledWith({ refreshToken: 'rt-native', clientId: 'ai.pagespace.ios', config });
    expect(revokeAppleRefreshToken).toHaveBeenCalledWith({ refreshToken: 'rt-web', clientId: 'ai.pagespace.web', config });
    expect(appleTokenStore.deleteForUser).toHaveBeenCalledWith('user-1');
    expect(summary).toEqual({ hadTokens: true, revoked: 2, failed: 0, unconfigured: false });
  });

  it('given Apple fails to revoke one token, should still delete every stored token and count the failure', async () => {
    vi.mocked(appleTokenStore.listForUser).mockResolvedValue(await storedRows());
    vi.mocked(revokeAppleRefreshToken)
      .mockResolvedValueOnce({ ok: false, reason: 'TimeoutError' })
      .mockResolvedValueOnce({ ok: true });

    const summary = await revokeAndDiscardAppleTokens('user-1', config);

    expect(appleTokenStore.deleteForUser).toHaveBeenCalledWith('user-1');
    expect(summary).toEqual({ hadTokens: true, revoked: 1, failed: 1, unconfigured: false });
  });

  it('given a stored token that cannot be decrypted, should count it as failed and still delete it', async () => {
    vi.mocked(appleTokenStore.listForUser).mockResolvedValue([
      { clientId: 'ai.pagespace.ios', refreshToken: `${'0'.repeat(32)}:${'0'.repeat(32)}:abcd` },
    ]);

    const summary = await revokeAndDiscardAppleTokens('user-1', config);

    expect(revokeAppleRefreshToken).not.toHaveBeenCalled();
    expect(appleTokenStore.deleteForUser).toHaveBeenCalledWith('user-1');
    expect(summary).toEqual({ hadTokens: true, revoked: 0, failed: 1, unconfigured: false });
  });

  it('given the signing key is not configured, should discard stored tokens without calling Apple', async () => {
    vi.mocked(appleTokenStore.listForUser).mockResolvedValue(await storedRows());

    const summary = await revokeAndDiscardAppleTokens('user-1', null);

    expect(revokeAppleRefreshToken).not.toHaveBeenCalled();
    expect(appleTokenStore.deleteForUser).toHaveBeenCalledWith('user-1');
    expect(summary).toEqual({ hadTokens: true, revoked: 0, failed: 0, unconfigured: true });
  });

  it('given no stored tokens, should report none and call nothing upstream', async () => {
    vi.mocked(appleTokenStore.listForUser).mockResolvedValue([]);

    const summary = await revokeAndDiscardAppleTokens('user-1', config);

    expect(revokeAppleRefreshToken).not.toHaveBeenCalled();
    expect(summary).toEqual({ hadTokens: false, revoked: 0, failed: 0, unconfigured: false });
  });

  it('given the delete fails, should throw so the caller records the step as failed', async () => {
    vi.mocked(appleTokenStore.listForUser).mockResolvedValue([]);
    vi.mocked(appleTokenStore.deleteForUser).mockRejectedValue(new Error('db down'));

    await expect(revokeAndDiscardAppleTokens('user-1', config)).rejects.toThrow('db down');
  });
});

describe('appleSignInDeletionOutcome', () => {
  const summary = { hadTokens: true, revoked: 1, failed: 0, unconfigured: false };

  it('given every stored token was revoked, should be revoked', () => {
    expect(appleSignInDeletionOutcome({ appleLinked: true, summary })).toBe('revoked');
  });

  it('given an Apple-linked user whose tokens could not all be revoked, should be manual', () => {
    expect(appleSignInDeletionOutcome({ appleLinked: true, summary: { ...summary, failed: 1 } })).toBe('manual');
  });

  it('given an Apple-linked user with no stored token, should be manual', () => {
    expect(appleSignInDeletionOutcome({ appleLinked: true, summary: { hadTokens: false, revoked: 0, failed: 0, unconfigured: false } })).toBe('manual');
  });

  it('given stored tokens but no signing key, should be manual', () => {
    expect(appleSignInDeletionOutcome({ appleLinked: true, summary: { hadTokens: true, revoked: 0, failed: 0, unconfigured: true } })).toBe('manual');
  });

  it('given the revocation step itself failed, should be manual for an Apple-linked user', () => {
    expect(appleSignInDeletionOutcome({ appleLinked: true, summary: null })).toBe('manual');
  });

  it('given a user who never used Sign in with Apple, should be none', () => {
    expect(appleSignInDeletionOutcome({ appleLinked: false, summary: { hadTokens: false, revoked: 0, failed: 0, unconfigured: false } })).toBe('none');
  });
});
