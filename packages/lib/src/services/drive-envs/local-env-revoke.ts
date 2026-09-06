/**
 * Revoke a LOCAL environment's machine — the service that makes "revoke"
 * mean all three of its legs, or it is not a revoke (Codex C4; epic
 * invariant 8):
 *
 *   1. stamp `revokedAt` on `drive_env_local` (compare-and-set), so every
 *      future challenge / redeem / bind refuses `revoked`;
 *   2. revoke EVERY session with `resourceType = 'drive_env' AND resourceId =
 *      envId` — the `env:bridge` socket tokens — so a token already minted
 *      dies now rather than at its TTL;
 *   3. tell the machine: push the server-signed `revoke` frame over the live
 *      socket (if one is held on this replica) and close it 1008, so the
 *      daemon deletes its key.
 *
 * The legs run in that order and ALL run even when leg 1 finds the row
 * already revoked: a crash between legs on an earlier attempt is exactly the
 * case a repeat has to finish. The stamp goes first so that nothing minted
 * during the call survives — `redeemLocalEnvChallenge` re-reads `revokedAt`
 * after its mint (t06b) and revokes what it just minted.
 *
 * Leg 3 is best-effort by nature (the socket may be on another replica, or
 * gone): a machine that misses the frame is closed within the 5-minute
 * session revalidation anyway, because leg 2 killed its token. IO is
 * injected; the apps/web adapter (`lib/env-bridge/revoke.ts`) binds the
 * store, the session service, the signer and the socket registry.
 */
import type { DriveEnvStore } from './drive-envs-store';

/** What leg 3 managed. Reported, never thrown: legs 1 and 2 are the revoke; this is the courtesy. */
export type RevokeMachineNotifyOutcome =
  /** Signed revoke frame sent, socket closed 1008. */
  | 'sent_and_closed'
  /** No socket for this env on this replica; nothing to send. */
  | 'no_live_socket'
  /** The key this enrollment pinned is no longer loaded: socket closed 1008 WITHOUT a frame (never signed under another key — Codex C10). */
  | 'closed_unsigned_key_unavailable'
  /** A socket was held but had not completed its signed hello: closed 1008, no frame (server→daemon frames go only to authorized sockets). */
  | 'closed_unauthorized_socket';

export interface RevokeLocalDriveEnvDeps {
  store: Pick<DriveEnvStore, 'findLocalByEnvId' | 'revokeLocal'>;
  now: () => Date;
  /** Leg 2: revoke every session bound to this env. @returns how many were live. */
  revokeSessions: (input: { envId: string; reason: string }) => Promise<number>;
  /** Leg 3: sign + push the revoke frame to the live socket and close it. */
  notifyMachine: (input: { envId: string; enrollmentId: string; serverKeyId: string | null; issuedAt: number; reason: string }) => Promise<RevokeMachineNotifyOutcome>;
}

export type RevokeLocalDriveEnvResult =
  | { ok: true; alreadyRevoked: boolean; revokedAt: Date; sessionsRevoked: number; machine: RevokeMachineNotifyOutcome }
  /** No `drive_env_local` row: not a local env, or already deleted. */
  | { ok: false; reason: 'not_found' };

export async function revokeLocalDriveEnv({
  envId,
  reason,
  deps,
}: {
  envId: string;
  /** Recorded on the sessions and sent to the machine (advisory). */
  reason: string;
  deps: RevokeLocalDriveEnvDeps;
}): Promise<RevokeLocalDriveEnvResult> {
  const row = await deps.store.findLocalByEnvId(envId);
  if (!row) return { ok: false, reason: 'not_found' };

  const now = deps.now();
  // Leg 1 — the stamp. False = already revoked; carry on regardless.
  const stamped = await deps.store.revokeLocal({ envId, now });
  const revokedAt = stamped ? now : (row.revokedAt ?? now);

  // Leg 2 — every env:bridge session for this env.
  const sessionsRevoked = await deps.revokeSessions({ envId, reason });

  // Leg 3 — the machine.
  const machine = await deps.notifyMachine({ envId, enrollmentId: row.enrollmentId, serverKeyId: row.serverKeyId, issuedAt: now.getTime(), reason });

  return { ok: true, alreadyRevoked: !stamped, revokedAt, sessionsRevoked, machine };
}
