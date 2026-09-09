/**
 * Per-environment Sprite identity (pure).
 *
 * A drive environment that runs on the Sprite substrate owns exactly ONE Sprite,
 * and this derives its NAME: an opaque HMAC over (tenant, env), namespaced so a
 * (tenantId, envId) pair ALWAYS resolves to the same Sprite name — and two
 * different environments ALWAYS resolve to two different names.
 * `SandboxHost.provision` auto-resumes "same name, same filesystem", which is
 * what makes an environment PERSISTENT: every session spawned inside it lands on
 * the same VM and the same disk, because they all resolve the same environment,
 * not because anything threads a "shared" id around.
 *
 * The fold is the ENVIRONMENT's own id (`drive_envs.id`) — a server-minted cuid2.
 * A cuid is fine as HMAC input: the key's unguessability comes from the
 * server-held secret, not from the id.
 *
 * The namespace is FRESH (`drive-env-sprite:v1`) with its own `pgs-env-` prefix,
 * and that is a requirement rather than a convention. Session keys
 * (`agent-workspaces/workspace-sprite-key.ts`) fold cuid2s too, so a shared
 * namespace would put environment names and session names in ONE keyspace —
 * where an environment could derive the name of a session Sprite still awaiting
 * reclaim, and provision straight onto a VM the reclaim outbox is about to kill.
 * That module's own v1→v2 bump is the same hazard answered the same way: a fresh
 * namespace makes every name in it fresh by construction.
 *
 * Everything else — the >=32-char secret floor, the NUL-delimited injective fold,
 * the sha3-256 HMAC — is copied verbatim from the session derivation. Note what
 * that copy does and does not buy: it does NOT protect against a weakness being
 * fixed in one file and missed in the other. Copying is the form that failure
 * takes. It is here because `workspace-sprite-key.ts` is not free to change —
 * `packages/db/src/__tests__/agent-workspaces-rename-migration.test.ts` asserts
 * on that file's literal source text (its namespace constant and its
 * ``return `pgs-ses-${digest}` ``) to catch a Sprite-name drift that would orphan
 * billed VMs. Factoring both onto a shared helper deletes the line that guard
 * reads, so the extraction has to come with a rethink of the guard, and that is
 * not a thing to bundle into a refactor that claims to change no behavior.
 *
 * When a third holder kind appears, extract then, guard first: the shared helper
 * wants a mandatory `{ namespace, prefix }` and both key modules already pin
 * known-answer digests, so the extraction is verifiable — it just is not free.
 */

import { createHmac } from 'crypto';

export interface DriveEnvSpriteKeyInput {
  tenantId: string;
  /** The environment's OWN id (`drive_envs.id`) — the identity fold. */
  envId: string;
  /** The server-held `SANDBOX_SESSION_SECRET`; never user input. */
  secret: string;
}

const NAMESPACE_VERSION = 'drive-env-sprite:v1';

/**
 * The web env schema enforces >=32 chars, but the realtime service bypasses full
 * validation — so the floor is re-checked here rather than trusting the caller.
 * A too-short secret is treated as UNSET (throw), never as weak key material to
 * derive from: failing closed costs a denied sandbox, deriving from it would
 * silently weaken every Sprite name at once.
 */
const MIN_SECRET_LENGTH = 32;

export function deriveDriveEnvSpriteKey({ tenantId, envId, secret }: DriveEnvSpriteKeyInput): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`deriveDriveEnvSpriteKey requires a secret of at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (tenantId.length === 0) {
    throw new Error('deriveDriveEnvSpriteKey requires a non-empty tenantId');
  }
  if (envId.length === 0) {
    throw new Error('deriveDriveEnvSpriteKey requires a non-empty envId');
  }
  // The NUL delimiter only makes the fold injective if neither component can
  // carry one — enforced, not assumed: without this, {tenant:'a\0b', env:'c'}
  // and {tenant:'a', env:'b\0c'} derive the SAME key. Both ids are server-minted
  // cuids today, but this function is the boundary.
  if (tenantId.includes('\0')) {
    throw new Error('deriveDriveEnvSpriteKey requires a tenantId without the NUL delimiter');
  }
  if (envId.includes('\0')) {
    throw new Error('deriveDriveEnvSpriteKey requires an envId without the NUL delimiter');
  }
  // NUL-delimited so no (tenant, env) pair can be re-spelled as another —
  // neither component can contain the delimiter (rejected above).
  const payload = [NAMESPACE_VERSION, tenantId, envId].join('\0');
  // codeql[js/insufficient-password-hash] not a password hash — a keyed HMAC over SANDBOX_SESSION_SECRET (a >=32-char server secret, never user input) deriving a deterministic Sprite-name pseudonym, same as workspace-sprite-key.ts's deriveAgentSessionSpriteKey
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-env-${digest}`;
}
