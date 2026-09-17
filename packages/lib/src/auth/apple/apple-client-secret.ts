/**
 * Sign in with Apple client authentication.
 *
 * Apple's /auth/token and /auth/revoke endpoints authenticate the caller with a
 * `client_secret` that is an ES256 JWT signed by the team's Sign in with Apple
 * private key (the `.p8` downloaded from the developer portal). Nothing else in
 * PageSpace needs that key, so its absence is a supported state: every caller
 * treats `null` from `getAppleSigningConfig` as "skip the token exchange" and
 * sign-in keeps working on the id_token alone.
 */
import { createPrivateKey, sign } from 'crypto';

export interface AppleSigningConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
}

/** Deliberately loose: `process.env` is passed straight in. */
export type AppleSigningEnv = Readonly<Record<string, string | undefined>>;

const APPLE_AUDIENCE = 'https://appleid.apple.com';

/** Apple allows up to six months; a per-call secret only needs to outlive one request. */
const CLIENT_SECRET_TTL_SECONDS = 300;

/**
 * Read the signing key from the environment. `null` when any part is missing or
 * the key does not parse as an EC private key — the exchange is then skipped
 * rather than failing sign-in.
 */
export function getAppleSigningConfig(env: AppleSigningEnv = process.env): AppleSigningConfig | null {
  const teamId = env.APPLE_TEAM_ID?.trim();
  const keyId = env.APPLE_SIGN_IN_KEY_ID?.trim();
  // Secret stores often flatten the PEM's newlines to literal `\n`.
  const privateKey = env.APPLE_SIGN_IN_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  if (!teamId || !keyId || !privateKey) return null;

  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ec') return null;
  } catch {
    return null;
  }

  return { teamId, keyId, privateKey };
}

const base64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Mint the ES256 client_secret JWT for `clientId` (the App ID or Services ID that issued the token). */
export function createAppleClientSecret(config: AppleSigningConfig, clientId: string, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url({ alg: 'ES256', kid: config.keyId, typ: 'JWT' });
  const payload = base64url({
    iss: config.teamId,
    sub: clientId,
    aud: APPLE_AUDIENCE,
    iat,
    exp: iat + CLIENT_SECRET_TTL_SECONDS,
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: config.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${payload}.${signature.toString('base64url')}`;
}
