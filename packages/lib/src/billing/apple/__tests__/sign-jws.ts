/**
 * Test-only: sign App Store-shaped JWS payloads with a throwaway chain, so tests exercise
 * Apple's real SignedDataVerifier (chain walk, OIDs, ES256 signature, bundle and
 * environment checks) instead of mocking it.
 *
 * The chain below is a self-signed root → intermediate → leaf generated with openssl. It
 * mimics Apple's StoreKit signing chain — ES256, the intermediate carries OID
 * 1.2.840.113635.100.6.2.1 and the leaf OID 1.2.840.113635.100.6.11.1 — and is trusted
 * nowhere outside these tests: production verification trusts only the embedded Apple Root
 * CA - G3 (../apple-root-certs.ts). The leaf key is not a secret.
 */
import { X509Certificate, createPrivateKey, sign } from 'crypto';

const TEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIB4TCCAYegAwIBAgIUachzHVxV+lle/Y2e1x86CzGjzlowCgYIKoZIzj0EAwIw
PTEiMCAGA1UEAwwZUGFnZVNwYWNlIFRlc3QgQXBwbGUgUm9vdDEXMBUGA1UECgwO
UGFnZVNwYWNlIFRlc3QwIBcNMjYxMDE5MDUyNDIyWhgPMjEyNjA5MjUwNTI0MjJa
MD0xIjAgBgNVBAMMGVBhZ2VTcGFjZSBUZXN0IEFwcGxlIFJvb3QxFzAVBgNVBAoM
DlBhZ2VTcGFjZSBUZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAErTTcEHNF
Y4pjdvKMcNRvFZcPaoh5Z2PITXBd8NFExawouOz38X9XF03KnySKa2NXUB+MhMS2
8tr1R9jCbrHfyKNjMGEwHQYDVR0OBBYEFGM0EE/zPwibX9vMRt21AgWUDImAMB8G
A1UdIwQYMBaAFGM0EE/zPwibX9vMRt21AgWUDImAMA8GA1UdEwEB/wQFMAMBAf8w
DgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCIGIrmfEUultf+UkfKbJ8
qNGJwhVocBBnv4egMU6NRdTJAiEAjULeQXxz1y8gSdZGkHZ2pLU/0Om2b4sqO6nx
yNdPpcc=
-----END CERTIFICATE-----`;

const TEST_INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIB/jCCAaSgAwIBAgIUVeL8KYqDMNIcvBEqzpopclPu2h4wCgYIKoZIzj0EAwIw
PTEiMCAGA1UEAwwZUGFnZVNwYWNlIFRlc3QgQXBwbGUgUm9vdDEXMBUGA1UECgwO
UGFnZVNwYWNlIFRlc3QwIBcNMjYxMDE5MDUyNDIyWhgPMjEyNTA1MTMwNTI0MjJa
MEUxKjAoBgNVBAMMIVBhZ2VTcGFjZSBUZXN0IEFwcGxlIEludGVybWVkaWF0ZTEX
MBUGA1UECgwOUGFnZVNwYWNlIFRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AATNBtNuQAMCG0IMFqhLCQ9s+089HQwiaNRIZUF7aAfX6vwSyqCuXl5ieg/UCCm1
2plWzhrazuh5l66I/khowjbyo3gwdjASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1Ud
DwEB/wQEAwIBBjAQBgoqhkiG92NkBgIBBAIFADAdBgNVHQ4EFgQU5Js3DEQHTJZK
5Q3qrvGKGo3LbSIwHwYDVR0jBBgwFoAUYzQQT/M/CJtf28xG3bUCBZQMiYAwCgYI
KoZIzj0EAwIDSAAwRQIgdCBMdqrDG6dUefwHoci8nGoDdG8mDEWAP+EqSN7cVvUC
IQDPgNomWgxx41gAwmJEwxtnqH7T0XHBg2vPDffaBFz9RA==
-----END CERTIFICATE-----`;

const TEST_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIB/jCCAaSgAwIBAgIUJvzs8PtWXNeNMOV/7ftXtys641MwCgYIKoZIzj0EAwIw
RTEqMCgGA1UEAwwhUGFnZVNwYWNlIFRlc3QgQXBwbGUgSW50ZXJtZWRpYXRlMRcw
FQYDVQQKDA5QYWdlU3BhY2UgVGVzdDAgFw0yNjEwMTkwNTI0MjJaGA8yMTI1MDIw
MjA1MjQyMlowQzEoMCYGA1UEAwwfUGFnZVNwYWNlIFRlc3QgU3RvcmVLaXQgU2ln
bmluZzEXMBUGA1UECgwOUGFnZVNwYWNlIFRlc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASB4CYwxM6jrET1qronZdr/knyFwhmaGD5KVwX7TeYcYzVu4UXAJHEP
L3EZILDetNK7VwEHxAOYGkSBFqXfwxzQo3IwcDAMBgNVHRMBAf8EAjAAMA4GA1Ud
DwEB/wQEAwIHgDAQBgoqhkiG92NkBgsBBAIFADAdBgNVHQ4EFgQUXTqBf4Gvri+Y
mj/kIBb31YLU2+IwHwYDVR0jBBgwFoAU5Js3DEQHTJZK5Q3qrvGKGo3LbSIwCgYI
KoZIzj0EAwIDSAAwRQIgUoLcN/IlJAxpKKd7XcS3mMn3qXimbu5WWUV5A6O6Z+sC
IQC/jOdrbKB7vIDT617BnlpQZ4TezqI7SSLEZLCmVGDESQ==
-----END CERTIFICATE-----`;

const TEST_LEAF_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgB4pOqyV31OyL89l6
bKKrpWCxxhXlvykVjVvcgjsvj0GhRANCAASB4CYwxM6jrET1qronZdr/knyFwhma
GD5KVwX7TeYcYzVu4UXAJHEPL3EZILDetNK7VwEHxAOYGkSBFqXfwxzQ
-----END PRIVATE KEY-----`;

const derBase64 = (pem: string) => Buffer.from(new X509Certificate(pem).raw).toString('base64');

export const TEST_ROOT_DER = Buffer.from(new X509Certificate(TEST_ROOT_PEM).raw);
const X5C = [derBase64(TEST_LEAF_PEM), derBase64(TEST_INTERMEDIATE_PEM), derBase64(TEST_ROOT_PEM)];
const LEAF_KEY = createPrivateKey(TEST_LEAF_KEY_PEM);

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Sign `payload` as an App Store JWS (ES256, x5c chain leaf → intermediate → root). */
export function signAppleJws(payload: Record<string, unknown>, options: { x5c?: string[] } = {}): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', x5c: options.x5c ?? X5C }));
  const body = b64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: LEAF_KEY, dsaEncoding: 'ieee-p1363' });
  return `${header}.${body}.${b64url(signature)}`;
}
