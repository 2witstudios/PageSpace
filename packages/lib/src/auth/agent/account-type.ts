/**
 * The one discriminator between humans and agents (ADR 0005 Decision 1).
 * Mirrors the `users.accountType` pgEnum Phase 1 adds: `human` first because
 * it is the column default, so every existing row is a human.
 *
 * @module @pagespace/lib/auth/agent/account-type
 */

export const ACCOUNT_TYPES = ['human', 'agent'] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export function isAccountType(value: unknown): value is AccountType {
  return typeof value === 'string' && (ACCOUNT_TYPES as readonly string[]).includes(value);
}
