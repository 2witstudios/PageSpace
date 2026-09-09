/**
 * Revoke a local environment's machine — the apps/web adapter for
 * `revokeLocalDriveEnv` (Codex C4: all three legs, or it is not a revoke):
 *
 *   1. `drive_env_local.revokedAt` stamped (store CAS);
 *   2. every session with `resourceType = 'drive_env' AND resourceId = envId`
 *      revoked (`sessionService.revokeResourceSessions`) — the `env:bridge`
 *      socket tokens die now, not at their TTL;
 *   3. the machine told: a server-signed `revoke` frame — signed by the key
 *      this ENROLLMENT pinned, binding `{envId, enrollmentId, keyId, issuedAt}`
 *      (`encodeRevokeForSigning`, the bytes the daemon verifies) — pushed over
 *      the live socket on this replica, then the socket closed 1008 and
 *      unregistered so its in-flight requests fail `disconnected` at once.
 *
 * Leg 3 is best-effort and reported, never thrown: a socket on another
 * replica is closed by the 5-minute revalidation once leg 2 killed its
 * token; a socket that has not completed its hello is closed WITHOUT a
 * frame (nothing is ever sent to an unauthorized socket); a pinned key that
 * is no longer loaded closes WITHOUT a frame rather than signing under
 * another key (Codex C10).
 */
import type { WebSocket } from 'ws';
import { encodeFrame } from '@pagespace/lib/env-bridge/frame-codec';
import { encodeApprovalRevokeForSigning, encodeRevokeForSigning, type RevokeFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import type { ServerSigningKeyring } from '@pagespace/lib/env-bridge/server-signing-key';
import { loadServerSigningKeyring } from '@pagespace/lib/auth/env-bridge-signing-key';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { revokeLocalDriveEnv, type RevokeLocalDriveEnvResult, type RevokeMachineNotifyOutcome } from '@pagespace/lib/services/drive-envs/local-env-revoke';
import { logger } from '@pagespace/lib/logging/logger-config';
import { getEnvConnection, isEnvAuthorized, unregisterEnvConnection } from '@/lib/websocket/ws-env-connections';
import { getDriveEnvStore } from '@/lib/drive-envs/drive-envs-runtime';

export const ENV_REVOKED_CLOSE_CODE = 1008;
export const ENV_REVOKED_CLOSE_REASON = 'Environment revoked';

/** Built on first use, never at import (see ws-env-connections.ts for why). */
let revokeLogger: ReturnType<typeof logger.child> | null = null;
function log(): ReturnType<typeof logger.child> {
  revokeLogger ??= logger.child({ component: 'env-bridge-revoke' });
  return revokeLogger;
}

export interface RevokeFrameInput {
  envId: string;
  enrollmentId: string;
  /** `drive_env_local.serverKeyId` — the ONLY key that may sign this revoke. */
  serverKeyId: string | null;
  issuedAt: number;
  reason: string;
}

/** The signed revoke frame for this enrollment, or `signing_key_unavailable` — never a signature under another key. */
export function buildRevokeFrame(input: RevokeFrameInput, keyring: Pick<ServerSigningKeyring, 'get'>): { ok: true; frame: RevokeFrame; keyId: string } | { ok: false; reason: 'signing_key_unavailable' } {
  const key = input.serverKeyId === null ? null : keyring.get(input.serverKeyId);
  if (!key) return { ok: false, reason: 'signing_key_unavailable' };
  const sig = Buffer.from(key.sign(encodeRevokeForSigning({ envId: input.envId, enrollmentId: input.enrollmentId, keyId: key.keyId, issuedAt: input.issuedAt }))).toString('base64');
  return { ok: true, frame: { type: 'revoke', sig, issuedAt: input.issuedAt, reason: input.reason }, keyId: key.keyId };
}

export interface NotifyMachineDeps {
  getConnection: (envId: string) => WebSocket | undefined;
  isAuthorized: (ws: WebSocket) => boolean;
  unregister: (envId: string, ws: WebSocket) => boolean;
  keyring: () => Pick<ServerSigningKeyring, 'get'>;
}

/** Leg 3 against injected socket/registry/keyring seams. Never throws. */
export async function notifyMachineOfRevoke(input: RevokeFrameInput, deps: NotifyMachineDeps): Promise<RevokeMachineNotifyOutcome> {
  const ws = deps.getConnection(input.envId);
  if (!ws || (ws.readyState !== 0 && ws.readyState !== 1)) return 'no_live_socket';

  let outcome: RevokeMachineNotifyOutcome;
  if (!deps.isAuthorized(ws)) {
    outcome = 'closed_unauthorized_socket';
  } else {
    const built = buildRevokeFrame(input, deps.keyring());
    if (built.ok) {
      try {
        ws.send(encodeFrame(built.frame));
        outcome = 'sent_and_closed';
      } catch (error) {
        log().warn('Revoke frame send failed; closing anyway', { envId: input.envId, error: error instanceof Error ? error.message : String(error), action: 'revoke_send_failed' });
        outcome = 'closed_unsigned_key_unavailable';
      }
    } else {
      log().error('Enrollment pinned a signing key that is no longer loaded; closing without a revoke frame', { envId: input.envId, serverKeyId: input.serverKeyId, action: 'revoke_key_unavailable' });
      outcome = 'closed_unsigned_key_unavailable';
    }
  }
  try {
    ws.close(ENV_REVOKED_CLOSE_CODE, ENV_REVOKED_CLOSE_REASON);
  } catch (error) {
    log().warn('Error closing revoked socket', { envId: input.envId, error: error instanceof Error ? error.message : String(error), action: 'revoke_close_error' });
  }
  // Through the CAS: fails this env's in-flight requests now rather than on the close event.
  deps.unregister(input.envId, ws);
  return outcome;
}

/** Revokes are rare: read the ring each time so a rotation is honoured without a restart. */
function loadKeyring(): ServerSigningKeyring {
  return loadServerSigningKeyring();
}

/** Revoke through the production seams. `reason` is recorded on the sessions (prefixed) and sent to the machine. */
export async function revokeLocalEnv(input: { envId: string; reason: string }): Promise<RevokeLocalDriveEnvResult> {
  const store = await getDriveEnvStore();
  return revokeLocalDriveEnv({
    envId: input.envId,
    reason: input.reason,
    deps: {
      store,
      now: () => new Date(),
      revokeSessions: ({ envId, reason }) => sessionService.revokeResourceSessions('drive_env', envId, `env_bridge_${reason}`),
      notifyMachine: (machine) =>
        notifyMachineOfRevoke(machine, {
          getConnection: getEnvConnection,
          isAuthorized: isEnvAuthorized,
          unregister: unregisterEnvConnection,
          keyring: () => {
            try {
              return loadKeyring();
            } catch (error) {
              // No key configured at all: nothing can sign; the socket still closes.
              log().error('Signing key ring unavailable during revoke', { envId: machine.envId, error: error instanceof Error ? error.message : String(error), action: 'revoke_keyring_error' });
              return { get: () => null };
            }
          },
        }),
    },
  });
}

// ---- revoking ONE approval (GA wave 2, leaf 8) ---------------------------------

export interface ApprovalRevokeFrameInput extends RevokeFrameInput {
  /** The durable approval to delete on the machine — the challenge id the click was answered under. */
  approvalId: string;
}

/**
 * The signed frame that deletes ONE approval on the machine: signed under the
 * approval-revoke domain over `{envId, enrollmentId, keyId, issuedAt,
 * approvalId}` by the key this enrollment pinned. The daemon deletes exactly
 * that entry and stays connected; nothing on this path touches the key. This
 * is the ONLY thing the server can do to an approval — it can never add one:
 * the machine file is authoritative for allow.
 */
export function buildApprovalRevokeFrame(input: ApprovalRevokeFrameInput, keyring: Pick<ServerSigningKeyring, 'get'>): { ok: true; frame: RevokeFrame; keyId: string } | { ok: false; reason: 'signing_key_unavailable' } {
  const key = input.serverKeyId === null ? null : keyring.get(input.serverKeyId);
  if (!key) return { ok: false, reason: 'signing_key_unavailable' };
  const sig = Buffer.from(key.sign(encodeApprovalRevokeForSigning({ envId: input.envId, enrollmentId: input.enrollmentId, keyId: key.keyId, issuedAt: input.issuedAt, approvalId: input.approvalId }))).toString('base64');
  return { ok: true, frame: { type: 'revoke', sig, issuedAt: input.issuedAt, reason: input.reason, approvalId: input.approvalId }, keyId: key.keyId };
}

export type ApprovalRevokeOutcome = 'sent' | 'no_live_socket' | 'unauthorized_socket' | 'signing_key_unavailable' | 'send_failed';

/**
 * Push a signed approval revoke over the env's live, AUTHORIZED socket on this
 * replica. The socket stays open. Honest about reach: without a live socket the
 * machine still holds the approval — the caller must say so, not claim a
 * revoke it could not deliver (a queued retry is a follow-up; see the PR).
 */
export function notifyMachineOfApprovalRevoke(input: ApprovalRevokeFrameInput, deps: Pick<NotifyMachineDeps, 'getConnection' | 'isAuthorized' | 'keyring'>): ApprovalRevokeOutcome {
  const ws = deps.getConnection(input.envId);
  if (!ws || (ws.readyState !== 0 && ws.readyState !== 1)) return 'no_live_socket';
  if (!deps.isAuthorized(ws)) return 'unauthorized_socket';
  const built = buildApprovalRevokeFrame(input, deps.keyring());
  if (!built.ok) {
    log().error('Enrollment pinned a signing key that is no longer loaded; approval revoke not sent', { envId: input.envId, approvalId: input.approvalId, serverKeyId: input.serverKeyId, action: 'approval_revoke_key_unavailable' });
    return 'signing_key_unavailable';
  }
  try {
    ws.send(encodeFrame(built.frame));
    return 'sent';
  } catch (error) {
    log().warn('Approval revoke frame send failed', { envId: input.envId, approvalId: input.approvalId, error: error instanceof Error ? error.message : String(error), action: 'approval_revoke_send_failed' });
    return 'send_failed';
  }
}

export type RevokeLocalEnvApprovalResult = { ok: true; machine: ApprovalRevokeOutcome } | { ok: false; reason: 'not_found' | 'revoked' };

/** Revoke ONE approval on a local env's machine through the production seams. */
export async function revokeLocalEnvApproval(input: { envId: string; approvalId: string; reason: string }): Promise<RevokeLocalEnvApprovalResult> {
  const store = await getDriveEnvStore();
  const row = await store.findLocalByEnvId(input.envId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revokedAt !== null) return { ok: false, reason: 'revoked' };
  const machine = notifyMachineOfApprovalRevoke(
    { envId: input.envId, enrollmentId: row.enrollmentId, serverKeyId: row.serverKeyId, issuedAt: Date.now(), reason: input.reason, approvalId: input.approvalId },
    {
      getConnection: getEnvConnection,
      isAuthorized: isEnvAuthorized,
      keyring: () => {
        try {
          return loadKeyring();
        } catch (error) {
          log().error('Signing key ring unavailable during approval revoke', { envId: input.envId, error: error instanceof Error ? error.message : String(error), action: 'approval_revoke_keyring_error' });
          return { get: () => null };
        }
      },
    },
  );
  return { ok: true, machine };
}
