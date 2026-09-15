/**
 * The agent secret (ADR 0005 Decision 4).
 *
 * The auth.md `identity_assertion` IS this opaque secret — Neon's durable-
 * secret model, no JWT. It is minted through the house `generateToken` so it
 * has the same CSPRNG-seeded CUID2 entropy as every other `ps_*` token, and
 * it is stored SHA3-256 hashed (`hash`) with a 12-character `prefix` for
 * support identification. The plaintext exists only in the signup/rotate
 * response and the agent's own store.
 *
 * @module @pagespace/lib/auth/agent/secret
 */

import { generateToken } from '../token-utils';

export const AGENT_SECRET_PREFIX = 'ps_agent';

/** `generateToken` body: CUID2 at length 32 — lowercase letters and digits only. */
const AGENT_SECRET_BODY_LENGTH = 32;

export interface MintedAgentSecret {
  /** Raw secret — return to the agent ONCE, never store. */
  secret: string;
  /** SHA3-256 hex of `secret` — the only thing stored at rest. */
  hash: string;
  /** First 12 characters of `secret` — for identification, never for lookup. */
  prefix: string;
}

export function mintAgentSecret(): MintedAgentSecret {
  const generated = generateToken(AGENT_SECRET_PREFIX);
  return { secret: generated.token, hash: generated.hash, prefix: generated.tokenPrefix };
}

/**
 * Shape guard run BEFORE any hash lookup: exactly `ps_agent_` followed by 32
 * lowercase alphanumerics. Anything else is refused without touching the DB,
 * so a malformed presentation costs nothing and leaks nothing.
 */
export function isAgentSecretShape(value: string): boolean {
  const head = `${AGENT_SECRET_PREFIX}_`;
  if (value.length !== head.length + AGENT_SECRET_BODY_LENGTH) return false;
  if (!value.startsWith(head)) return false;
  for (let i = head.length; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57;
    const isLower = c >= 97 && c <= 122;
    if (!isDigit && !isLower) return false;
  }
  return true;
}
