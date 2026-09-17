/**
 * PageSpace-owned cache of Apple's Sign in with Apple signing keys
 * (https://appleid.apple.com/auth/keys).
 *
 * Replaces apple-signin-auth's key fetching, which refetched on EVERY unknown
 * `kid` with no timeout and no single-flight, and cleared its shared cache
 * before parsing the response. The notification endpoint is unauthenticated,
 * so forged tokens with random kids could drive unbounded fetches to Apple and,
 * once Apple throttled us, empty the cache that real sign-ins verify against.
 *
 * Here:
 *  - a refresh has a timeout, and concurrent lookups share one in-flight fetch;
 *  - an unknown kid triggers at most one refresh per REFRESH_INTERVAL_MS;
 *  - a failed, throttled or malformed refresh keeps the last good key set —
 *    the cache is replaced only by a response with at least one usable key.
 */
import { createPublicKey, type KeyObject } from 'crypto';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const REFRESH_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export interface AppleKeyProvider {
  /** Apple's public key for `kid`, or null when Apple does not (currently) publish it. */
  getKey: (kid: string) => Promise<KeyObject | null>;
}

interface AppleKeyProviderOptions {
  fetchJwks?: () => Promise<Response>;
  now?: () => number;
}

function parseKeySet(body: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const entries = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(entries)) return keys;
  for (const entry of entries) {
    const jwk = entry as { kty?: unknown; kid?: unknown; n?: unknown; e?: unknown };
    if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
    } catch {
      // Skip a key that does not parse; keep the rest.
    }
  }
  return keys;
}

export function createAppleKeyProvider(options: AppleKeyProviderOptions = {}): AppleKeyProvider {
  const fetchJwks =
    options.fetchJwks ?? (() => fetch(APPLE_JWKS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
  const now = options.now ?? Date.now;

  let keys = new Map<string, KeyObject>();
  let lastRefreshAt: number | null = null;
  let inFlight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    try {
      const response = await fetchJwks();
      if (!response.ok) return;
      const fresh = parseKeySet(await response.json());
      if (fresh.size > 0) keys = fresh;
    } catch {
      // Keep the last good key set.
    }
  };

  return {
    async getKey(kid) {
      const cached = keys.get(kid);
      if (cached) return cached;

      if (!inFlight) {
        if (lastRefreshAt !== null && now() - lastRefreshAt < REFRESH_INTERVAL_MS) return null;
        lastRefreshAt = now();
        inFlight = refresh().finally(() => {
          inFlight = null;
        });
      }
      await inFlight;
      return keys.get(kid) ?? null;
    },
  };
}

/** The process-wide provider every Apple JWT verification shares. */
export const appleKeyProvider = createAppleKeyProvider();
