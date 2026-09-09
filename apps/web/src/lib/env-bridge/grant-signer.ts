/**
 * Grant signer — the server end of invariant 3. Builds the `Grant` a
 * `grant_*` frame carries and signs the canonical bytes `verifyGrant` (the
 * daemon's gate, pure core) checks.
 *
 * Two things are settled here and nowhere else:
 *
 * - **What is hashed (Codex C7).** `argsHash = hash(canonicalizeArgs(
 *   grantArgsForFrame(frame)))` — the per-op projection from `grant-args.ts`,
 *   the SAME function the daemon's gate calls before verifying. The signer
 *   never hashes "the frame" or its own idea of the args; it asks the
 *   projection. A field the projection covers cannot be altered in flight; a
 *   field it does not cover is, by definition, not part of the request.
 * - **Which key signs (Codex C10).** The key the ENROLLMENT pinned
 *   (`drive_env_local.serverKeyId`), looked up in the loaded ring. A pinned
 *   key that is no longer loaded is a typed `signing_key_unavailable` — never a
 *   signature under a different key, which the daemon could not verify anyway
 *   and which would teach an operator that rotation "works" when it strands.
 *
 * Pure apart from the injected id source: the byte layout comes from
 * `encodeGrant` (never re-implemented here), the clock is a parameter.
 */
import { canonicalizeArgs, encodeGrant, GRANT_MAX_TTL_MS, type Grant, type GrantPrincipal, type HashBytes } from '@pagespace/lib/env-bridge/grant';
import { grantRequestForFrame, type GrantFrame, type UnsignedGrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import type { ServerSigningKeyring } from '@pagespace/lib/env-bridge/server-signing-key';
import { envBridgeHash } from './crypto';

export interface GrantIdSource {
  grantId(): string;
  nonce(): string;
}

export interface SignGrantFrameInput {
  readonly frame: UnsignedGrantFrame;
  readonly envId: string;
  readonly principal: GrantPrincipal;
  /** `drive_env_local.serverKeyId` — the key this enrollment pinned. `null` = never enrolled. */
  readonly serverKeyId: string | null;
  readonly keyring: Pick<ServerSigningKeyring, 'get'>;
  /** ms since epoch. */
  readonly now: number;
  /** Defaults to GRANT_MAX_TTL_MS; anything longer is refused (the gate would too). */
  readonly ttlMs?: number;
  readonly ids: GrantIdSource;
  /** Defaults to the bridge's SHA-256; injectable for tests that pair the signer with a differently-hashing gate. */
  readonly hash?: HashBytes;
}

export type SignGrantFrameResult =
  | { readonly ok: true; readonly frame: GrantFrame; readonly grant: Grant; readonly keyId: string }
  | { readonly ok: false; readonly reason: 'signing_key_unavailable' | 'ttl_too_long' };

export function signGrantFrame(input: SignGrantFrameInput): SignGrantFrameResult {
  const key = input.serverKeyId === null ? null : input.keyring.get(input.serverKeyId);
  if (!key) return { ok: false, reason: 'signing_key_unavailable' };

  const ttlMs = input.ttlMs ?? GRANT_MAX_TTL_MS;
  if (ttlMs > GRANT_MAX_TTL_MS || ttlMs <= 0) return { ok: false, reason: 'ttl_too_long' };

  // The projection is computed on the frame AS IT WILL BE SENT (grant/sig are
  // envelope, not args, so placeholders change nothing) — the daemon's gate
  // calls the same function on the frame as received.
  const provisional = { ...input.frame, grant: {}, sig: '' } as GrantFrame;
  const request = grantRequestForFrame(provisional);
  const hash = input.hash ?? envBridgeHash;
  const argsHash = hash(canonicalizeArgs(request.args));

  const grant: Grant = {
    grantId: input.ids.grantId(),
    envId: input.envId,
    principal: {
      userId: input.principal.userId,
      sessionId: input.principal.sessionId,
      conversationId: input.principal.conversationId,
    },
    op: request.op,
    argsHash,
    iat: input.now,
    exp: input.now + ttlMs,
    nonce: input.ids.nonce(),
  };
  const sig = Buffer.from(key.sign(encodeGrant(grant))).toString('base64');

  // The grant travels opaque on the wire (frame-codec keeps it a record); the
  // strict parser on the daemon is the one that types it again.
  const wireGrant: Record<string, unknown> = {
    grantId: grant.grantId,
    envId: grant.envId,
    principal: { ...grant.principal },
    op: grant.op,
    argsHash: grant.argsHash,
    iat: grant.iat,
    exp: grant.exp,
    nonce: grant.nonce,
  };
  return { ok: true, frame: { ...input.frame, grant: wireGrant, sig } as GrantFrame, grant, keyId: key.keyId };
}
