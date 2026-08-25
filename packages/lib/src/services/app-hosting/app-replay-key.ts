/**
 * Per-published-app fly-replay `state` key (pure).
 *
 * `fly-replay: app=<target>;state=<key>` carries an opaque string that Fly hands
 * to the target app verbatim in `fly-replay-src`. Its purpose is authentication
 * in ONE direction: a published app must be able to tell "this request was routed
 * by our router, which checked status and balance" from "this request reached me
 * some other way". Without it, anything inside the shared 6PN network could talk
 * straight to a published app and consume awake-seconds the balance gate would
 * have refused.
 *
 * So the key is PER APP, derived rather than stored: an HMAC over the Fly app
 * name under a server-held secret. Per app because one leaked key must not
 * authenticate traffic to a sibling app; derived because a stored column would
 * be one more secret to rotate, migrate and leak, and there is nothing to store
 * that the name plus the secret does not already determine.
 *
 * The unguessability comes from `APP_REPLAY_SECRET`, never from the app name —
 * `pgs-app-<cuid2>` is not secret (it is in our own logs, and Fly's). Rotation is
 * a secret change plus a redeploy of the router and the guest runtime; there is
 * deliberately no per-app rotation, because a per-app key that can be rotated
 * independently is a per-app key that has to be stored.
 *
 * Shape (namespace, NUL-delimited fold, sha3-256 HMAC, >=32-char secret floor) is
 * copied from `drive-envs/env-sprite-key.ts` and `agent-workspaces/
 * workspace-sprite-key.ts`. The namespace is FRESH and that is a requirement, not
 * a convention: a shared namespace would put replay keys and Sprite NAMES in one
 * keyspace, where a value minted as an authentication token also names a machine.
 */

import { createHmac } from 'crypto';
import { secureCompare } from '../../auth/secure-compare';

const NAMESPACE_VERSION = 'published-app-replay:v1';

/**
 * Re-checked here rather than trusted from the caller: the web env schema is not
 * the only reader (the guest runtime and the realtime service bypass full
 * validation), and a too-short secret must fail CLOSED — a denied route costs a
 * 503, deriving from weak material silently weakens every app's key at once.
 */
const MIN_SECRET_LENGTH = 32;

export interface PublishedAppReplayKeyInput {
  /** `published_apps.flyAppName` — the replay target, and the identity fold. */
  flyAppName: string;
  /** The server-held `APP_REPLAY_SECRET`; never user input. */
  secret: string;
}

/**
 * The `state=` value for this app's replays. Deterministic: the router and the
 * guest runtime derive the same string from the same two inputs, with nothing
 * exchanged between them.
 *
 * Hex, so the value is safe in the `fly-replay` header's `k=v;k=v` grammar —
 * a key containing `;` or `=` would let a crafted app name inject a second
 * directive into the header.
 */
export function derivePublishedAppReplayKey({ flyAppName, secret }: PublishedAppReplayKeyInput): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `derivePublishedAppReplayKey requires a secret of at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  if (flyAppName.length === 0) {
    throw new Error('derivePublishedAppReplayKey requires a non-empty flyAppName');
  }
  // The NUL delimiter only makes the fold injective if no component can carry
  // one. Fly app names cannot today, but this function is the boundary.
  if (flyAppName.includes('\0')) {
    throw new Error('derivePublishedAppReplayKey requires a flyAppName without the NUL delimiter');
  }
  const payload = [NAMESPACE_VERSION, flyAppName].join('\0');
  // codeql[js/insufficient-password-hash] not a password hash — a keyed HMAC over APP_REPLAY_SECRET (a >=32-char server secret, never user input) deriving a deterministic per-app preshared key, same as drive-envs/env-sprite-key.ts
  return createHmac('sha3-256', secret).update(payload).digest('hex');
}

/**
 * Validate a `fly-replay-src` state value against this app's derived key.
 *
 * For the GUEST side of the contract — the published app's own runtime — which is
 * not built in this task; it is exported here so the two halves can never drift
 * to two derivations. Comparison goes through {@link secureCompare} (SHA3-256
 * both sides, then `timingSafeEqual`): the key is a bearer credential, and a
 * naive `===` on it leaks a prefix oracle.
 *
 * A malformed or missing secret makes this return FALSE rather than throw — the
 * guest's answer to "was this router traffic?" must be "no" when it cannot tell,
 * and a throw at that boundary is an exception path that tends to become a
 * fail-open catch.
 */
export function verifyPublishedAppReplayKey(
  presented: string | null | undefined,
  input: PublishedAppReplayKeyInput,
): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  let expected: string;
  try {
    expected = derivePublishedAppReplayKey(input);
  } catch {
    return false;
  }
  return secureCompare(presented, expected);
}
