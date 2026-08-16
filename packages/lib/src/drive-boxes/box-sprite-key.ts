/**
 * Per-box Sprite identity (pure).
 *
 * A drive box that runs on the Sprite substrate owns exactly ONE Sprite, and this
 * derives its NAME: an opaque HMAC over (tenant, box), namespaced so a
 * (tenantId, boxId) pair ALWAYS resolves to the same Sprite name — and two
 * different boxes ALWAYS resolve to two different names. `SandboxHost.provision`
 * auto-resumes "same name, same filesystem", which is what makes a box a
 * PERSISTENT environment: every session spawned inside it lands on the same VM
 * and the same disk, because they all resolve the same box, not because anything
 * threads a "shared" id around.
 *
 * The fold is the BOX's own id (`drive_boxes.id`) — a server-minted cuid2. A cuid
 * is fine as HMAC input: the key's unguessability comes from the server-held
 * secret, not from the id.
 *
 * The namespace is FRESH (`drive-box-sprite:v1`) with its own `pgs-box-` prefix,
 * and that is a requirement rather than a convention. Session keys
 * (`agent-workspaces/workspace-sprite-key.ts`) fold cuid2s too, so a shared
 * namespace would put box names and session names in ONE keyspace — where a box
 * could derive the name of a session Sprite still awaiting reclaim, and provision
 * straight onto a VM the reclaim outbox is about to kill. That module's own
 * v1→v2 bump is the same hazard answered the same way: a fresh namespace makes
 * every name in it fresh by construction.
 *
 * Everything else — the >=32-char secret floor, the NUL-delimited injective fold,
 * the sha3-256 HMAC — is copied from the session derivation deliberately: two
 * derivations with one discipline, so a weakness cannot be fixed in one and
 * missed in the other.
 */

import { createHmac } from 'crypto';

export interface DriveBoxSpriteKeyInput {
  tenantId: string;
  /** The box's OWN id (`drive_boxes.id`) — the identity fold. */
  boxId: string;
  /** The server-held `SANDBOX_SESSION_SECRET`; never user input. */
  secret: string;
}

const NAMESPACE_VERSION = 'drive-box-sprite:v1';

/**
 * The web env schema enforces >=32 chars, but the realtime service bypasses full
 * validation — so the floor is re-checked here rather than trusting the caller.
 * A too-short secret is treated as UNSET (throw), never as weak key material to
 * derive from: failing closed costs a denied sandbox, deriving from it would
 * silently weaken every Sprite name at once.
 */
const MIN_SECRET_LENGTH = 32;

export function deriveDriveBoxSpriteKey({ tenantId, boxId, secret }: DriveBoxSpriteKeyInput): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`deriveDriveBoxSpriteKey requires a secret of at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (tenantId.length === 0) {
    throw new Error('deriveDriveBoxSpriteKey requires a non-empty tenantId');
  }
  if (boxId.length === 0) {
    throw new Error('deriveDriveBoxSpriteKey requires a non-empty boxId');
  }
  // The NUL delimiter only makes the fold injective if neither component can
  // carry one — enforced, not assumed: without this, {tenant:'a\0b', box:'c'}
  // and {tenant:'a', box:'b\0c'} derive the SAME key. Both ids are server-minted
  // cuids today, but this function is the boundary.
  if (tenantId.includes('\0')) {
    throw new Error('deriveDriveBoxSpriteKey requires a tenantId without the NUL delimiter');
  }
  if (boxId.includes('\0')) {
    throw new Error('deriveDriveBoxSpriteKey requires a boxId without the NUL delimiter');
  }
  // NUL-delimited so no (tenant, box) pair can be re-spelled as another —
  // neither component can contain the delimiter (rejected above).
  const payload = [NAMESPACE_VERSION, tenantId, boxId].join('\0');
  // codeql[js/insufficient-password-hash] not a password hash — a keyed HMAC over SANDBOX_SESSION_SECRET (a >=32-char server secret, never user input) deriving a deterministic Sprite-name pseudonym, same as workspace-sprite-key.ts's deriveAgentSessionSpriteKey
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-box-${digest}`;
}
