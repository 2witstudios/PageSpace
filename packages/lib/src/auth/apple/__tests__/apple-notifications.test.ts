import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import { createAppleKeyProvider } from '../apple-jwks';
import { verifyAppleServerNotification, handleAppleServerNotification, type AppleNotificationDeps } from '../apple-notifications';

vi.mock('../../../logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

// Throwaway RSA key standing in for Apple's, served through the key provider's fetch seam.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const KID = 'test-kid';
const fetchJwks = vi.fn(async () => new Response(JSON.stringify({ keys: [{ kty: 'RSA', kid: KID, use: 'sig', alg: 'RS256', n: jwk.n, e: jwk.e }] })));
const keys = createAppleKeyProvider({ fetchJwks });

const env = { APPLE_CLIENT_ID: 'ai.pagespace.ios', APPLE_SERVICE_ID: 'ai.pagespace.web' };

function signNotification(claims: Record<string, unknown>, keyId = KID, key = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

const now = () => Math.floor(Date.now() / 1000);
const validClaims = (events: unknown, overrides: Record<string, unknown> = {}) => ({
  iss: 'https://appleid.apple.com',
  aud: 'ai.pagespace.ios',
  iat: now(),
  exp: now() + 300,
  jti: 'jti-1',
  events,
  ...overrides,
});


describe('verifyAppleServerNotification', () => {
  it('given a notification signed by Apple for our client with events as a JSON string, should return the event', async () => {
    const payload = signNotification(validClaims(JSON.stringify({ type: 'consent-revoked', sub: 'apple-sub-1', event_time: 1 })));

    const result = await verifyAppleServerNotification(payload, env, keys);

    expect(result).toEqual({ ok: true, event: { type: 'consent-revoked', sub: 'apple-sub-1', eventTimeMs: 1000 } });
  });

  it('given events as an object (the shape Apple documents), should return the event', async () => {
    const payload = signNotification(validClaims({ type: 'account-deleted', sub: 'apple-sub-2', event_time: 1 }, { aud: 'ai.pagespace.web' }));

    expect(await verifyAppleServerNotification(payload, env, keys)).toEqual({ ok: true, event: { type: 'account-deleted', sub: 'apple-sub-2', eventTimeMs: 1000 } });
  });

  it('given a notification for another app, should reject it', async () => {
    const payload = signNotification(validClaims({ type: 'consent-revoked', sub: 's' }, { aud: 'com.someone.else' }));

    expect((await verifyAppleServerNotification(payload, env, keys)).ok).toBe(false);
  });

  it('given a notification not issued by Apple, should reject it', async () => {
    const payload = signNotification(validClaims({ type: 'consent-revoked', sub: 's' }, { iss: 'https://evil.example' }));

    expect((await verifyAppleServerNotification(payload, env, keys)).ok).toBe(false);
  });

  it('given an expired notification, should reject it', async () => {
    const payload = signNotification(validClaims({ type: 'consent-revoked', sub: 's' }, { iat: now() - 900, exp: now() - 600 }));

    expect((await verifyAppleServerNotification(payload, env, keys)).ok).toBe(false);
  });

  it('given a notification signed with a key that is not Apple\'s, should reject it', async () => {
    const forger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const payload = signNotification(validClaims({ type: 'consent-revoked', sub: 's' }), KID, forger);

    expect((await verifyAppleServerNotification(payload, env, keys)).ok).toBe(false);
  });

  it('given event_time in milliseconds (as Apple sends in practice), should keep it as milliseconds', async () => {
    const payload = signNotification(validClaims({ type: 'consent-revoked', sub: 's', event_time: 1_758_100_000_000 }));

    expect(await verifyAppleServerNotification(payload, env, keys)).toEqual({
      ok: true,
      event: { type: 'consent-revoked', sub: 's', eventTimeMs: 1_758_100_000_000 },
    });
  });

  it('given a notification with no expiry claim, should reject it so a captured one cannot be replayed forever', async () => {
    const claims: Record<string, unknown> = validClaims({ type: 'consent-revoked', sub: 's' });
    delete claims.exp;

    expect(await verifyAppleServerNotification(signNotification(claims), env, keys)).toEqual({ ok: false, reason: 'missing_exp' });
  });

  it('given an unsigned (alg none) token, should reject it', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: KID })).toString('base64url');
    const body = Buffer.from(JSON.stringify(validClaims({ type: 'consent-revoked', sub: 's' }))).toString('base64url');

    expect((await verifyAppleServerNotification(`${header}.${body}.`, env, keys)).ok).toBe(false);
  });

  it('given a flood of forged notifications with random kids, should not fetch Apple\'s keys for each one', async () => {
    await verifyAppleServerNotification(signNotification(validClaims({ type: 'consent-revoked', sub: 's' })), env, keys);
    fetchJwks.mockClear();

    for (let i = 0; i < 20; i++) {
      const forged = signNotification(validClaims({ type: 'consent-revoked', sub: 's' }), `random-kid-${i}`);
      expect(await verifyAppleServerNotification(forged, env, keys)).toEqual({ ok: false, reason: 'unknown_kid' });
    }

    expect(fetchJwks).toHaveBeenCalledTimes(0);
  });

  it('given no Apple client is configured, should reject every notification', async () => {
    const payload = signNotification(validClaims({ type: 'consent-revoked', sub: 's' }));

    expect(await verifyAppleServerNotification(payload, {}, keys)).toEqual({ ok: false, reason: 'apple_not_configured' });
  });

  it('given a verified token whose events lack a subject, should reject it', async () => {
    const payload = signNotification(validClaims({ type: 'consent-revoked' }));

    expect(await verifyAppleServerNotification(payload, env, keys)).toEqual({ ok: false, reason: 'invalid_events' });
  });
});

describe('handleAppleServerNotification', () => {
  const deps: AppleNotificationDeps = {
    findUserIdByAppleId: vi.fn(),
    discardAppleTokens: vi.fn(),
    endAllSessions: vi.fn(),
    latestAppleTokenCaptureAt: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deps.findUserIdByAppleId).mockResolvedValue('user-1');
    vi.mocked(deps.latestAppleTokenCaptureAt).mockResolvedValue(null);
  });

  it('given a consent-revoked Apple resends from before the user signed in with Apple again, should ignore it', async () => {
    vi.mocked(deps.latestAppleTokenCaptureAt).mockResolvedValue(new Date('2026-09-17T12:00:00Z'));

    const action = await handleAppleServerNotification(
      { type: 'consent-revoked', sub: 'apple-sub-1', eventTimeMs: Date.parse('2026-09-10T12:00:00Z') },
      deps,
    );

    expect(action).toEqual({ action: 'stale_event', userId: 'user-1' });
    expect(deps.endAllSessions).not.toHaveBeenCalled();
    expect(deps.discardAppleTokens).not.toHaveBeenCalled();
  });

  it('given a consent-revoked from after the latest Apple sign-in, should end the sessions', async () => {
    vi.mocked(deps.latestAppleTokenCaptureAt).mockResolvedValue(new Date('2026-09-10T12:00:00Z'));

    const action = await handleAppleServerNotification(
      { type: 'consent-revoked', sub: 'apple-sub-1', eventTimeMs: Date.parse('2026-09-17T12:00:00Z') },
      deps,
    );

    expect(action).toEqual({ action: 'sessions_ended', userId: 'user-1' });
  });

  it('given a notification without event_time, should act on it (it cannot be shown to be stale)', async () => {
    vi.mocked(deps.latestAppleTokenCaptureAt).mockResolvedValue(new Date('2026-09-17T12:00:00Z'));

    const action = await handleAppleServerNotification({ type: 'account-deleted', sub: 'apple-sub-1' }, deps);

    expect(action).toEqual({ action: 'sessions_ended', userId: 'user-1' });
  });

  it.each(['consent-revoked', 'account-delete', 'account-deleted'])(
    'given %s for a known user, should discard their Apple tokens and end their sessions',
    async (type) => {
      const action = await handleAppleServerNotification({ type, sub: 'apple-sub-1' }, deps);

      expect(deps.findUserIdByAppleId).toHaveBeenCalledWith('apple-sub-1');
      expect(deps.discardAppleTokens).toHaveBeenCalledWith('user-1');
      expect(deps.endAllSessions).toHaveBeenCalledWith('user-1');
      expect(action).toEqual({ action: 'sessions_ended', userId: 'user-1' });
    },
  );

  it('given consent-revoked for an Apple user PageSpace does not know, should do nothing', async () => {
    vi.mocked(deps.findUserIdByAppleId).mockResolvedValue(null);

    const action = await handleAppleServerNotification({ type: 'consent-revoked', sub: 'ghost' }, deps);

    expect(action).toEqual({ action: 'unknown_user' });
    expect(deps.discardAppleTokens).not.toHaveBeenCalled();
    expect(deps.endAllSessions).not.toHaveBeenCalled();
  });

  it.each(['email-disabled', 'email-enabled', 'something-new'])('given %s, should acknowledge without touching the account', async (type) => {
    const action = await handleAppleServerNotification({ type, sub: 'apple-sub-1' }, deps);

    expect(action).toEqual({ action: 'ignored' });
    expect(deps.findUserIdByAppleId).not.toHaveBeenCalled();
    expect(deps.endAllSessions).not.toHaveBeenCalled();
  });
});
