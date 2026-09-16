/**
 * Agent synthetic email + reserved-domain predicate (ADR 0007 Decision 2).
 *
 * An agent is a real `users` row, and `users.email` is unique NOT NULL, so
 * every agent gets a synthetic address under an RFC 2606 `.invalid` domain
 * that can never resolve or receive mail. The predicate below is the ONE
 * definition every inbound auth path (the five denylist sites, Phase 1) and
 * the outbound email choke point key on — so they can never disagree about
 * what "reserved" means.
 *
 * Pure: no env, no I/O. Normalization matches `normalizeEmail` (trim +
 * lowercase) so case/whitespace variants of a reserved address are still
 * reserved.
 *
 * @module @pagespace/lib/auth/agent/reserved-email
 */

import { normalizeEmail } from '../../encryption/blind-index';

/** RFC 2606 reserved domain — never resolves, never delivered, never registrable elsewhere. */
export const AGENT_EMAIL_DOMAIN = 'agents.pagespace.invalid';

/** `agent-<userId>@agents.pagespace.invalid` — unique per user id, always reserved. */
export function agentSyntheticEmail(userId: string): string {
  return `agent-${userId}@${AGENT_EMAIL_DOMAIN}`;
}

/**
 * True iff `email` is an address under the agent reserved domain (the domain
 * itself or any subdomain of it), after `normalizeEmail`. Deliberately NOT a
 * substring match: the system users' `pagespace.invalid` / `pagespace.local`
 * addresses, and look-alikes such as `evilagents.pagespace.invalid` or
 * `agents.pagespace.invalid.evil.com`, are not reserved.
 */
export function isAgentReservedEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  const at = normalized.indexOf('@');
  if (at <= 0) return false;
  if (normalized.indexOf('@', at + 1) !== -1) return false;
  const domain = normalized.slice(at + 1);
  return domain === AGENT_EMAIL_DOMAIN || domain.endsWith(`.${AGENT_EMAIL_DOMAIN}`);
}

/**
 * Zod refinement for every inbound email input: `z.string().email().refine(notAgentReservedEmail, …)`.
 * Callers attach the ordinary "invalid email" message so a reserved address is
 * indistinguishable from a malformed one on the wire (no oracle).
 */
export const notAgentReservedEmail = (email: string): boolean => !isAgentReservedEmail(email);
