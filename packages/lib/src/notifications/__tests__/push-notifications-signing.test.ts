import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as realCrypto from 'crypto';

// ---------------------------------------------------------------------------
// Every test in push-notifications.test.ts mocks `crypto.createSign`, which
// means none of them can tell whether the assertion we build is actually
// signed correctly — only that *something* was passed to a fake signer. This
// file deliberately does NOT mock crypto: it generates a real RSA keypair,
// lets the real signing path run, and then verifies the resulting JWT with the
// matching public key. If the PEM handling, the signing input, or the
// base64url encoding were wrong, the signature would not verify.
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { pushNotificationTokens: { findFirst: vi.fn(), findMany: vi.fn() } },
    insert: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('@pagespace/db/schema/push-notifications', () => ({
  pushNotificationTokens: { id: 'id', userId: 'userId', isActive: 'isActive' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(() => 'eq'),
  and: vi.fn((...a) => ({ and: a })),
}));
vi.mock('@paralleldrive/cuid2', () => ({ createId: vi.fn(() => 'id'), init: vi.fn(() => vi.fn()) }));
vi.mock('node:http2', () => {
  const connect = vi.fn(() => { throw new Error('APNs not used in this file'); });
  const constants = { NGHTTP2_CANCEL: 8 };
  return { connect, constants, default: { connect, constants } };
});

import { sendPushNotification } from '../push-notifications';
import { db } from '@pagespace/db/db';

const { privateKey, publicKey } = realCrypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// The access-token cache is keyed on the exact credential string, so tests that
// must each mint their own token need distinct project ids — otherwise the
// first one warms the cache and the next never reaches the token endpoint.
function serviceAccount(pem: string, projectId = 'real-crypto-project') {
  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    client_email: `push@${projectId}.iam.gserviceaccount.com`,
    private_key: pem,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

describe('FCM assertion signing (real crypto, no mock)', () => {
  const originalFetch = globalThis.fetch;
  let captured: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    captured = null;
    const whereFn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.update).mockReturnValue({ set: vi.fn().mockReturnValue({ where: whereFn }) } as never);
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([
      { id: 't1', userId: 'u1', token: 'fcm-token-DEVICESECRET', platform: 'android', isActive: true, failedAttempts: '0' },
    ] as never);
    globalThis.fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        captured = new URLSearchParams(String(init.body)).get('assertion');
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.OUTERSECRET', expires_in: 3600 }) };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  });

  // Verifies the signature cryptographically — the one thing a mocked signer
  // can never tell us.
  function expectVerifiableAssertion(assertion: string) {
    const [headerB64, claimsB64, signatureB64] = assertion.split('.');
    expect(signatureB64).toBeTruthy();

    // Node's base64url decoder also accepts standard base64, so verification
    // alone cannot tell the two apart — assert the alphabet explicitly rather
    // than relying on the decode to reject `+`, `/` or padding.
    expect(signatureB64).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(headerB64).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(claimsB64).toMatch(/^[A-Za-z0-9_-]+$/);

    const verify = realCrypto.createVerify('RSA-SHA256');
    verify.update(`${headerB64}.${claimsB64}`);
    verify.end();
    expect(verify.verify(publicKey, Buffer.from(signatureB64, 'base64url'))).toBe(true);

    expect(JSON.parse(Buffer.from(headerB64, 'base64url').toString()))
      .toEqual({ alg: 'RS256', typ: 'JWT' });
  }

  // The PR description claims no log call carries credential material. That was
  // established by reading the code, which is exactly the kind of claim that
  // stops being true without anyone noticing. Assert it against a real PEM, a
  // real assertion and a real access token, across every path that logs.
  it('never writes credential material to the console, on any path', async () => {
    const raw = serviceAccount(privateKey, 'log-hygiene-project');
    const captured: string[] = [];
    const sink = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(sink),
      vi.spyOn(console, 'warn').mockImplementation(sink),
      vi.spyOn(console, 'error').mockImplementation(sink),
    ];

    try {
      // A success, an FCM rejection, a 401 that re-mints and retries, an OAuth
      // refusal, and a transport throw — every branch that reaches a logger.
      process.env.FCM_SERVICE_ACCOUNT_JSON = raw;
      await sendPushNotification('u1', { title: 'T', body: 'B' });

      let n = 0;
      globalThis.fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        if (String(url).includes('oauth2.googleapis.com')) {
          captured.push('');
          return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.SUPERSECRET', expires_in: 3600 }) };
        }
        n += 1;
        if (n === 1) return { ok: false, status: 401, text: async () => '{"error":{"status":"UNAUTHENTICATED"}}' };
        if (n === 2) return { ok: false, status: 503, text: async () => '{"error":{"status":"UNAVAILABLE"}}' };
        throw new Error('socket closed');
      }) as unknown as typeof fetch;
      await sendPushNotification('u1', { title: 'T', body: 'B' });
      await sendPushNotification('u1', { silent: true });

      process.env.FCM_SERVICE_ACCOUNT_JSON = '{"project_id":"p"}';
      await sendPushNotification('u1', { title: 'T', body: 'B' });

      const all = captured.join('\n');
      expect(all.length).toBeGreaterThan(0);

      // The private key, in either newline form.
      expect(all).not.toContain('PRIVATE KEY');
      expect(all).not.toContain(privateKey.split('\n')[1]);
      // The whole service account blob.
      expect(all).not.toContain(raw);
      // The minted bearer token.
      expect(all).not.toContain('SUPERSECRET');
      // And the signed assertion, which is a bearer credential in its own right.
      expect(all).not.toMatch(/eyJhbGciOiJSUzI1NiI/);
      // The access token actually in use on each path, not just the one minted
      // last — a generic placeholder here would hide a leak of the other.
      expect(all).not.toContain('OUTERSECRET');
      // The registration token is bearer-ish too: only its prefix may appear.
      expect(all).not.toContain('DEVICESECRET');
    } finally {
      spies.forEach((sp) => sp.mockRestore());
    }
  });

  it('produces a signature that verifies against the matching public key', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccount(privateKey);

    const result = await sendPushNotification('u1', { title: 'T', body: 'B' });

    expect(result.sent).toBe(1);
    expect(captured).toBeTruthy();
    expectVerifiableAssertion(captured!);
  });

  // The same key as a secret store hands it back: real newlines replaced with
  // the two characters backslash and n. The unescaping is what makes this work,
  // and with a mocked signer it could be wrong without anything noticing.
  it('still verifies when the PEM arrives with escaped newlines', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccount(privateKey.replace(/\n/g, '\\n'));

    const result = await sendPushNotification('u1', { title: 'T', body: 'B' });

    expect(result.sent).toBe(1);
    expect(captured).toBeTruthy();
    expectVerifiableAssertion(captured!);
  });
});
