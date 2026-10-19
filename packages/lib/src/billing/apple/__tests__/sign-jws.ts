/**
 * Test-only: sign App Store-shaped JWS payloads with the throwaway chain in ./fixtures,
 * so tests exercise Apple's real SignedDataVerifier (chain walk, OIDs, ES256 signature,
 * bundle and environment checks) instead of mocking it.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { X509Certificate, createPrivateKey, sign } from 'crypto';

const FIXTURES = join(__dirname, 'fixtures');
const pem = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

const derBase64 = (name: string) => Buffer.from(new X509Certificate(pem(name)).raw).toString('base64');

export const TEST_ROOT_DER = Buffer.from(new X509Certificate(pem('test-root.pem')).raw);
const X5C = [derBase64('test-leaf.pem'), derBase64('test-intermediate.pem'), derBase64('test-root.pem')];
const LEAF_KEY = createPrivateKey(pem('test-leaf.key.pem'));

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Sign `payload` as an App Store JWS (ES256, x5c chain leaf → intermediate → root). */
export function signAppleJws(payload: Record<string, unknown>, options: { x5c?: string[] } = {}): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', x5c: options.x5c ?? X5C }));
  const body = b64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: LEAF_KEY, dsaEncoding: 'ieee-p1363' });
  return `${header}.${body}.${b64url(signature)}`;
}
