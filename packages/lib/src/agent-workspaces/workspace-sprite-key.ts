/**
 * Per-session Sprite identity (pure).
 *
 * Every agent session owns exactly ONE Sprite, and this derives its NAME: an
 * opaque HMAC over (tenant, session), namespaced so a (tenantId, workspaceId) pair
 * ALWAYS resolves to the same Sprite name — and, critically, two different
 * sessions ALWAYS resolve to two different names. `SandboxHost.provision`
 * auto-resumes "same name, same filesystem", so a stable name is what makes a
 * re-provision of a vanished Sprite land back on the session's own filesystem,
 * and a distinct name is what makes it impossible to hand two sessions the same
 * underlying VM.
 *
 * The fold is the SESSION's OWN id (`agent_workspaces.id`) — a server-minted
 * cuid2, NOT a conversation id. That is what makes sandbox sharing structural:
 * every conversation and shell in a session resolves the same Sprite because
 * they resolve the same session, not because anything threads a "shared" id
 * around. (v1 folded the conversation id, back when a session WAS a
 * conversation — the conflation this model removes.) A cuid is fine as HMAC
 * input: the key's unguessability comes from the server-held secret, not from
 * the id.
 *
 * The namespace is BUMPED (`agent-session-sprite:v2`), keeping the `pgs-ses-`
 * prefix: v1 folded conversation cuids and v2 folds session cuids, and the two
 * live in the SAME keyspace — same-namespace reuse could let a v2 session
 * derive the name of a v1 Sprite still awaiting reclaim. The bump makes every
 * v2 name fresh by construction, exactly as v1's fresh namespace protected it
 * from the legacy `pgs-agt-*`/`pgs-sbx-*` names.
 */

import { createHmac } from 'crypto';

export interface AgentSessionSpriteKeyInput {
  tenantId: string;
  /** The session's OWN id (`agent_workspaces.id`) — the identity fold. Never a conversation id. */
  workspaceId: string;
  /** The server-held `SANDBOX_SESSION_SECRET`; never user input. */
  secret: string;
}

const NAMESPACE_VERSION = 'agent-session-sprite:v2';

/**
 * The web env schema enforces >=32 chars, but the realtime service bypasses full
 * validation — so the floor is re-checked here rather than trusting the caller.
 * A too-short secret is treated as UNSET (throw), never as weak key material to
 * derive from: failing closed costs a denied sandbox, deriving from it would
 * silently weaken every Sprite name at once.
 */
const MIN_SECRET_LENGTH = 32;

export function deriveAgentSessionSpriteKey({ tenantId, workspaceId, secret }: AgentSessionSpriteKeyInput): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`deriveAgentSessionSpriteKey requires a secret of at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (tenantId.length === 0) {
    throw new Error('deriveAgentSessionSpriteKey requires a non-empty tenantId');
  }
  if (workspaceId.length === 0) {
    throw new Error('deriveAgentSessionSpriteKey requires a non-empty workspaceId');
  }
  // The NUL delimiter only makes the fold injective if neither component can
  // carry one — enforced, not assumed: without this, {tenant:'a\0b',
  // session:'c'} and {tenant:'a', session:'b\0c'} derive the SAME key. Both
  // ids are server-minted cuids today, but this function is the boundary.
  if (tenantId.includes('\0')) {
    throw new Error('deriveAgentSessionSpriteKey requires a tenantId without the NUL delimiter');
  }
  if (workspaceId.includes('\0')) {
    throw new Error('deriveAgentSessionSpriteKey requires a workspaceId without the NUL delimiter');
  }
  // NUL-delimited so no (tenant, session) pair can be re-spelled as another —
  // neither component can contain the delimiter (rejected above).
  const payload = [NAMESPACE_VERSION, tenantId, workspaceId].join('\0');
  // codeql[js/insufficient-password-hash] not a password hash — a keyed HMAC over SANDBOX_SESSION_SECRET (a >=32-char server secret, never user input) deriving a deterministic Sprite-name pseudonym, same as machine-session-manager.ts's deriveMachineSessionKey
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-ses-${digest}`;
}
