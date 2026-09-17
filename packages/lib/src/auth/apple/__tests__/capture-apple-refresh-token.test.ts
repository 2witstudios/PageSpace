import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../apple-token-api', () => ({
  exchangeAppleAuthorizationCode: vi.fn(),
}));
vi.mock('../apple-token-store', () => ({
  appleTokenStore: { upsert: vi.fn() },
}));
vi.mock('../../../logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { captureAppleRefreshToken } from '../capture-apple-refresh-token';
import { exchangeAppleAuthorizationCode } from '../apple-token-api';
import { appleTokenStore } from '../apple-token-store';
import { loggers } from '../../../logging/logger-config';
import { decryptField, looksEncrypted } from '../../../encryption/field-crypto';
import type { AppleSigningConfig } from '../apple-client-secret';

const config: AppleSigningConfig = { teamId: 'T', keyId: 'K', privateKey: 'unused-by-mocked-api' };

// An unsigned id_token is enough here: it came back from Apple's /auth/token
// over TLS, so only its `sub` is read, to bind the code to the verified user.
const idTokenFor = (sub: string) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;

const baseArgs = { userId: 'user-1', code: 'code-1', clientId: 'ai.pagespace.ios', expectedSub: 'apple-sub-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('captureAppleRefreshToken', () => {
  it('given the signing key is not configured, should skip without calling Apple or storing anything', async () => {
    const outcome = await captureAppleRefreshToken(baseArgs, null);

    expect(outcome).toBe('skipped');
    expect(exchangeAppleAuthorizationCode).not.toHaveBeenCalled();
    expect(appleTokenStore.upsert).not.toHaveBeenCalled();
  });

  it('given a successful exchange for the verified user, should store the refresh token encrypted, keyed by user and client', async () => {
    vi.mocked(exchangeAppleAuthorizationCode).mockResolvedValue({ ok: true, refreshToken: 'rt-plain', idToken: idTokenFor('apple-sub-1') });

    const outcome = await captureAppleRefreshToken({ ...baseArgs, redirectUri: 'https://pagespace.ai/cb' }, config);

    expect(outcome).toBe('stored');
    expect(exchangeAppleAuthorizationCode).toHaveBeenCalledWith({
      code: 'code-1',
      clientId: 'ai.pagespace.ios',
      redirectUri: 'https://pagespace.ai/cb',
      config,
    });
    const stored = vi.mocked(appleTokenStore.upsert).mock.calls[0][0];
    expect(stored.userId).toBe('user-1');
    expect(stored.clientId).toBe('ai.pagespace.ios');
    expect(stored.encryptedRefreshToken).not.toContain('rt-plain');
    expect(looksEncrypted(stored.encryptedRefreshToken)).toBe(true);
    expect(await decryptField(stored.encryptedRefreshToken)).toBe('rt-plain');
  });

  it('given the exchanged token belongs to a different Apple user, should refuse to store it', async () => {
    vi.mocked(exchangeAppleAuthorizationCode).mockResolvedValue({ ok: true, refreshToken: 'rt', idToken: idTokenFor('someone-else') });

    const outcome = await captureAppleRefreshToken(baseArgs, config);

    expect(outcome).toBe('failed');
    expect(appleTokenStore.upsert).not.toHaveBeenCalled();
  });

  it('given the exchange returns no id_token, should refuse to store it', async () => {
    vi.mocked(exchangeAppleAuthorizationCode).mockResolvedValue({ ok: true, refreshToken: 'rt', idToken: null });

    expect(await captureAppleRefreshToken(baseArgs, config)).toBe('failed');
    expect(appleTokenStore.upsert).not.toHaveBeenCalled();
  });

  it('given Apple rejects the code, should report failure without throwing and log only the reason', async () => {
    vi.mocked(exchangeAppleAuthorizationCode).mockResolvedValue({ ok: false, reason: 'invalid_grant' });

    expect(await captureAppleRefreshToken(baseArgs, config)).toBe('failed');
    expect(loggers.auth.warn).toHaveBeenCalledWith(
      'Apple refresh token capture failed',
      expect.objectContaining({ userId: 'user-1', clientId: 'ai.pagespace.ios', reason: 'invalid_grant' }),
    );
    expect(JSON.stringify(vi.mocked(loggers.auth.warn).mock.calls)).not.toContain('code-1');
  });

  it('given the store throws, should report failure without throwing', async () => {
    vi.mocked(exchangeAppleAuthorizationCode).mockResolvedValue({ ok: true, refreshToken: 'rt', idToken: idTokenFor('apple-sub-1') });
    vi.mocked(appleTokenStore.upsert).mockRejectedValue(new Error('db down'));

    await expect(captureAppleRefreshToken(baseArgs, config)).resolves.toBe('failed');
  });
});
