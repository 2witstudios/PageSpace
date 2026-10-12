/** Server-verified ceremony evidence, carried unchanged by derived credentials. */
export interface VerifiedAuthentication {
  readonly authenticatedAtMs: number;
  readonly assurance: 'single_factor' | 'user_verified_passkey';
}

/** Missing or corrupt evidence never acquires assurance from token creation time. */
export function parseVerifiedAuthentication(raw: unknown, nowMs: number): VerifiedAuthentication | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const { authenticatedAtMs, assurance } = value;
  if (typeof authenticatedAtMs !== 'number' || !Number.isSafeInteger(authenticatedAtMs) || authenticatedAtMs < 0 ||
    !Number.isSafeInteger(nowMs) || authenticatedAtMs > nowMs ||
    (assurance !== 'single_factor' && assurance !== 'user_verified_passkey')) return null;
  return { authenticatedAtMs, assurance };
}
