/**
 * Per-session Sprite identity (pure).
 *
 * Every agent session owns exactly ONE Sprite, and this derives its NAME: an
 * opaque HMAC over (tenant, session), namespaced so a (tenantId, sessionId) pair
 * ALWAYS resolves to the same Sprite name — and, critically, two different
 * sessions ALWAYS resolve to two different names. `SandboxHost.provision`
 * auto-resumes "same name, same filesystem", so a stable name is what makes a
 * re-provision of a vanished Sprite land back on the session's own filesystem,
 * and a distinct name is what makes it impossible to hand two sessions the same
 * underlying VM.
 *
 * The fold is the SESSION id — which IS the conversation id (see `contract.ts`):
 * one id addresses the tool target, the `?c=` URL, the chat anchor, and this
 * Sprite. It is a client-minted cuid2, which is fine as HMAC input: the key's
 * unguessability comes from the server-held secret, not from the id.
 *
 * The namespace is FRESH (`agent-session-sprite:v1`, prefix `pgs-ses-`), so no
 * derivation can collide with the legacy `pgs-agt-*` (per-terminal) or
 * `pgs-sbx-*` (per-machine-page) names still in the wild — even for inputs that
 * happen to coincide.
 */

import { createHmac } from 'crypto';

export interface AgentSessionSpriteKeyInput {
  tenantId: string;
  /** ≡ the conversation id — the per-session identity fold. */
  sessionId: string;
  /** The server-held `SANDBOX_SESSION_SECRET`; never user input. */
  secret: string;
}

const NAMESPACE_VERSION = 'agent-session-sprite:v1';

/**
 * The web env schema enforces >=32 chars, but the realtime service bypasses full
 * validation — so the floor is re-checked here rather than trusting the caller.
 * A too-short secret is treated as UNSET (throw), never as weak key material to
 * derive from: failing closed costs a denied sandbox, deriving from it would
 * silently weaken every Sprite name at once.
 */
const MIN_SECRET_LENGTH = 32;

export function deriveAgentSessionSpriteKey({ tenantId, sessionId, secret }: AgentSessionSpriteKeyInput): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`deriveAgentSessionSpriteKey requires a secret of at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (tenantId.length === 0) {
    throw new Error('deriveAgentSessionSpriteKey requires a non-empty tenantId');
  }
  if (sessionId.length === 0) {
    throw new Error('deriveAgentSessionSpriteKey requires a non-empty sessionId');
  }
  // NUL-delimited so no (tenant, session) pair can be re-spelled as another —
  // neither component can contain the delimiter.
  const payload = [NAMESPACE_VERSION, tenantId, sessionId].join('\0');
  // codeql[js/insufficient-password-hash] not a password hash — a keyed HMAC over SANDBOX_SESSION_SECRET (a >=32-char server secret, never user input) deriving a deterministic Sprite-name pseudonym, same as machine-session-manager.ts's deriveMachineSessionKey
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-ses-${digest}`;
}
