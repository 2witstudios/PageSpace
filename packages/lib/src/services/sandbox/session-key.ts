/**
 * Sandbox session-key derivation (pure).
 *
 * A conversation's warm sandbox is addressed by `Sandbox.getOrCreate({ name })`,
 * so the name IS the access boundary: anyone who can name a sandbox can resume
 * it (subject to the resume re-authz gate in the lifecycle layer). The key must
 * therefore be both:
 *
 *  - **Namespaced** by `tenant + drive + conversation`, so two different
 *    conversations — or the same conversation id reused across drives/tenants —
 *    never collide onto one shared sandbox.
 *  - **Unguessable**, so an actor who knows (or guesses) a conversation id cannot
 *    reconstruct the sandbox name and probe for another session's warm VM.
 *
 * A bare hash of the tuple would be namespaced but NOT unguessable — the inputs
 * are values the client already holds. We therefore key the digest with a
 * server-held secret (HMAC): without the secret the name cannot be derived from
 * the public tuple, and the output never embeds the raw ids.
 *
 * Digest is **SHA3-256**, matching the repo convention for security tokens hashed
 * at rest (auth/token-utils.ts). HMAC adds the keying that token-utils omits —
 * an opaque token is high-entropy and unguessable on its own, but this key's
 * inputs are low-entropy, so the secret is what makes it unguessable.
 *
 * Pure by construction: the secret is injected (sourced from validated env by
 * the effect layer), so this function reads no globals and is trivially testable.
 */

import { createHmac } from 'crypto';

export interface SessionKeyInput {
  tenantId: string;
  driveId: string;
  conversationId: string;
  /** Server-held secret; sourced from validated env by the caller. */
  secret: string;
}

// Versioned, '\0'-delimited so the three components are unambiguous — without a
// delimiter ("ab" + "c" vs "a" + "bc") distinct tuples could hash identically.
// The version prefix lets the scheme rotate without silently aliasing old keys.
const NAMESPACE_VERSION = 'sandbox-session:v1';

export function deriveSessionKey({
  tenantId,
  driveId,
  conversationId,
  secret,
}: SessionKeyInput): string {
  const payload = [NAMESPACE_VERSION, tenantId, driveId, conversationId].join('\0');
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-sbx-${digest}`;
}
