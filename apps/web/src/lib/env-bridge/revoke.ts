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
import { encodeRevokeForSigning, type RevokeFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import type { ServerSigningKeyring } from '@pagespace/lib/env-bridge/server-signing-key';
import { loadServerSigningKeyring } from '@pagespace/lib/auth/env-bridge-signing-key';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { revokeLocalDriveEnv, type RevokeLocalDriveEnvResult, type RevokeMachineNotifyOutcome } from '@pagespace/lib/services/drive-envs/local-env-revoke';
import { logger } from '@pagespace/lib/logging/logger-config';
import { getEnvConnection, isEnvAuthorized, unregisterEnvConnection } from '@/lib/websocket/ws-env-connections';
import { getDriveEnvStore } from '@/lib/drive-envs/drive-envs-runtime';

export const ENV_REVOKED_CLOSE_CODE = 1008;
export const ENV_REVOKED_CLOSE_REASON = 'Environment revoked';

const log = logger.child({ component: 'env-bridge-revoke' });

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
        log.warn('Revoke frame send failed; closing anyway', { envId: input.envId, error: error instanceof Error ? error.message : String(error), action: 'revoke_send_failed' });
        outcome = 'closed_unsigned_key_unavailable';
      }
    } else {
      log.error('Enrollment pinned a signing key that is no longer loaded; closing without a revoke frame', { envId: input.envId, serverKeyId: input.serverKeyId, action: 'revoke_key_unavailable' });
      outcome = 'closed_unsigned_key_unavailable';
    }
  }
  try {
    ws.close(ENV_REVOKED_CLOSE_CODE, ENV_REVOKED_CLOSE_REASON);
  } catch (error) {
    log.warn('Error closing revoked socket', { envId: input.envId, error: error instanceof Error ? error.message : String(error), action: 'revoke_close_error' });
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
              log.error('Signing key ring unavailable during revoke', { envId: machine.envId, error: error instanceof Error ? error.message : String(error), action: 'revoke_keyring_error' });
              return { get: () => null };
            }
          },
        }),
    },
  });
}
