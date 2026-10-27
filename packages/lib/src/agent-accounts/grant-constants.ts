/**
 * The frozen numbers and the issuer constant (ADR 0004 §2.2–2.3), as VALUES
 * of the literal types `grant.ts` froze. A grant is a bounded capability:
 * fifteen minutes is the aidd-jwt-security ceiling, thirty seconds the same
 * clock-skew allowance the env-bridge uses.
 */
import type { GrantIssuer, GrantLimits } from './grant';

export const GRANT_ISSUER: GrantIssuer = 'pagespace-account-authority';

export const GRANT_LIMITS: GrantLimits = {
  maxTtlMs: 900_000,
  maxClockSkewMs: 30_000,
};
