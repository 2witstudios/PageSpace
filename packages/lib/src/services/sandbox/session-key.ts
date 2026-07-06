/**
 * Sandbox session-key derivation (pure).
 *
 * "A drive is a computer": every shell into a drive — agent chat turns, terminal
 * pages, concurrent tabs — addresses the SAME Sprite, keyed only by
 * `(tenantId, driveId)`. There is exactly one derivation; conversation and page
 * identity no longer participate in sandbox addressing (they stay in audit
 * logging only).
 *
 * The drive's warm sandbox is addressed by `getOrCreate({ name })`, so the name
 * IS the access boundary: anyone who can name a sandbox can resume it (subject
 * to the resume re-authz gate in the lifecycle layer). The key must therefore be
 * both:
 *
 *  - **Namespaced** by `tenant + drive`, so two different drives — or the same
 *    drive id reused across tenants — never collide onto one shared sandbox.
 *  - **Unguessable**, so an actor who knows (or guesses) a drive id cannot
 *    reconstruct the sandbox name and probe for another drive's warm VM.
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
  /** Server-held secret; sourced from validated env by the caller. */
  secret: string;
}

// Versioned, '\0'-delimited so the two components are unambiguous — without a
// delimiter ("ab" + "c" vs "a" + "bc") distinct tuples could hash identically.
// The version prefix lets the scheme rotate without silently aliasing old keys.
// This namespace supersedes the two retired per-conversation and per-page
// namespaces by construction: bumping the namespace orphans every Sprite named
// under the old schemes (swept separately by the cutover migration task).
const NAMESPACE_VERSION = 'drive-sandbox:v1';

export function deriveSessionKey({ tenantId, driveId, secret }: SessionKeyInput): string {
  // Fail closed at the boundary: an empty secret collapses the HMAC into a plain
  // digest of public ids, making the sandbox name guessable. Don't rely solely on
  // upstream env validation — refuse to derive a non-secret key here.
  if (secret.length === 0) {
    throw new Error('deriveSessionKey requires a non-empty secret');
  }
  // A drive is the entire addressing scope now — there is no drive-less
  // fallback (the old global no-drive path is retired). Refuse rather than
  // silently deriving a key that would collide across every drive-less caller.
  if (!driveId) {
    throw new Error('deriveSessionKey requires a non-empty driveId');
  }
  if (!tenantId) {
    throw new Error('deriveSessionKey requires a non-empty tenantId');
  }
  const payload = [NAMESPACE_VERSION, tenantId, driveId].join('\0');
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-sbx-${digest}`;
}
