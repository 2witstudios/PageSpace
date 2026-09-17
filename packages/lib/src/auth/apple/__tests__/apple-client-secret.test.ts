import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, verify } from 'crypto';
import { getAppleSigningConfig, createAppleClientSecret } from '../apple-client-secret';

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
