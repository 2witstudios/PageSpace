/**
 * Apple's Sign in with Apple REST endpoints — /auth/token (validate an
 * authorization code) and /auth/revoke (TN3194: the only programmatic way to
 * invalidate a user's tokens).
 *
 * Both calls are bounded by a timeout and NEVER throw: a caller on the sign-in
 * path or the account-deletion path must be able to carry on whatever Apple
 * does. Results carry a short reason code only — token values are never logged
 * or echoed.
 */
import { createAppleClientSecret, type AppleSigningConfig } from './apple-client-secret';

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const APPLE_REQUEST_TIMEOUT_MS = 10_000;

export type AppleTokenExchangeResult =
  | { ok: true; refreshToken: string; idToken: string | null }
  | { ok: false; reason: string };

export type AppleRevokeResult = { ok: true } | { ok: false; reason: string };

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown_error');

async function readAppleError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : `http_${response.status}`;
}

function postForm(url: string, form: URLSearchParams): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(APPLE_REQUEST_TIMEOUT_MS),
  });
}

/**
 * Validate an authorization code and obtain the refresh token. `clientId` must
 * be the client that issued the code (bundle id natively, Services ID on web);
 * `redirectUri` is sent only when the authorization request carried one.
 */
export async function exchangeAppleAuthorizationCode(args: {
  code: string;
  clientId: string;
  redirectUri?: string;
  config: AppleSigningConfig;
}): Promise<AppleTokenExchangeResult> {
  try {
    const form = new URLSearchParams({
      client_id: args.clientId,
      client_secret: createAppleClientSecret(args.config, args.clientId),
      code: args.code,
      grant_type: 'authorization_code',
    });
    if (args.redirectUri) form.set('redirect_uri', args.redirectUri);

    const response = await postForm(APPLE_TOKEN_URL, form);
    if (!response.ok) return { ok: false, reason: await readAppleError(response) };

    const body = (await response.json()) as { refresh_token?: unknown; id_token?: unknown };
    if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) {
      return { ok: false, reason: 'missing_refresh_token' };
    }
    return {
      ok: true,
      refreshToken: body.refresh_token,
      idToken: typeof body.id_token === 'string' ? body.id_token : null,
    };
  } catch (error) {
    return { ok: false, reason: errorName(error) };
  }
}

/** Revoke a refresh token with the client it was issued for. 200 also covers an already-invalid token. */
export async function revokeAppleRefreshToken(args: {
  refreshToken: string;
  clientId: string;
  config: AppleSigningConfig;
}): Promise<AppleRevokeResult> {
  try {
    const form = new URLSearchParams({
      client_id: args.clientId,
      client_secret: createAppleClientSecret(args.config, args.clientId),
      token: args.refreshToken,
      token_type_hint: 'refresh_token',
    });
    const response = await postForm(APPLE_REVOKE_URL, form);
    if (!response.ok) return { ok: false, reason: await readAppleError(response) };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorName(error) };
  }
}
