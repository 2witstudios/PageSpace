import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
import { generateKeyPairSync, verify } from 'crypto';
import { getAppleSigningConfig, createAppleClientSecret } from '../apple-client-secret';
import { loggers } from '../../../logging/logger-config';

// A throwaway P-256 key, generated per run — never a real Sign in with Apple key.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const fullEnv = {
  APPLE_TEAM_ID: 'M96WTV3CKX',
  APPLE_SIGN_IN_KEY_ID: 'ABC123DEFG',
  APPLE_SIGN_IN_PRIVATE_KEY: privatePem,
};

describe('getAppleSigningConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given every variable is set and the key parses, should return the config', () => {
    const config = getAppleSigningConfig(fullEnv);
    expect(config).toEqual({ teamId: 'M96WTV3CKX', keyId: 'ABC123DEFG', privateKey: privatePem.trim() });
  });

  it.each(['APPLE_TEAM_ID', 'APPLE_SIGN_IN_KEY_ID', 'APPLE_SIGN_IN_PRIVATE_KEY'] as const)(
    'given %s is missing, should return null',
    (name) => {
      expect(getAppleSigningConfig({ ...fullEnv, [name]: undefined })).toBeNull();
    },
  );

  it('given a private key that is not a valid EC key, should return null', () => {
    expect(
      getAppleSigningConfig({ ...fullEnv, APPLE_SIGN_IN_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----' }),
    ).toBeNull();
  });

  it('given every variable is set but the key does not parse, should warn so the misconfiguration is not silent', () => {
    getAppleSigningConfig({ ...fullEnv, APPLE_SIGN_IN_PRIVATE_KEY: 'not a key' });

    expect(loggers.auth.warn).toHaveBeenCalledWith(expect.stringContaining('APPLE_SIGN_IN_PRIVATE_KEY'), expect.anything());
  });

  it('given the same unusable key is read on every sign-in, should warn only once', () => {
    const badKey = 'still not a key';
    getAppleSigningConfig({ ...fullEnv, APPLE_SIGN_IN_PRIVATE_KEY: badKey });
    getAppleSigningConfig({ ...fullEnv, APPLE_SIGN_IN_PRIVATE_KEY: badKey });

    expect(loggers.auth.warn).toHaveBeenCalledTimes(1);
  });

  it('given an EC key on a curve other than P-256, should return null (ES256 requires P-256)', () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    expect(getAppleSigningConfig({ ...fullEnv, APPLE_SIGN_IN_PRIVATE_KEY: p384 })).toBeNull();
  });

  it('given no Sign in with Apple key variables at all, should not warn (an unconfigured key is a supported state)', () => {
    getAppleSigningConfig({});

    expect(loggers.auth.warn).not.toHaveBeenCalled();
  });

  it('given a PEM with escaped \\n sequences, should normalise it to real newlines', () => {
    const escaped = privatePem.trim().replace(/\n/g, '\\n');
    const config = getAppleSigningConfig({ ...fullEnv, APPLE_SIGN_IN_PRIVATE_KEY: escaped });
    expect(config?.privateKey).toBe(privatePem.trim());
  });
});

describe('createAppleClientSecret', () => {
  it('given a config and client id, should mint an ES256 JWT Apple accepts as a client_secret', () => {
    const config = getAppleSigningConfig(fullEnv);
    if (!config) throw new Error('config expected');
    const now = new Date('2026-09-17T12:00:00Z');

    const secret = createAppleClientSecret(config, 'ai.pagespace.ios', now);

    const [headerB64, payloadB64, signatureB64] = secret.split('.');
    const signatureValid = verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: publicPem, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64, 'base64url'),
    );
    expect(signatureValid).toBe(true);
    const decoded = {
      header: JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')),
    };
    expect(decoded.header).toEqual({ alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
    const iat = Math.floor(now.getTime() / 1000);
    expect(decoded.payload).toEqual({
      iss: 'M96WTV3CKX',
      sub: 'ai.pagespace.ios',
      aud: 'https://appleid.apple.com',
      iat,
      exp: iat + 300,
    });
  });
});
