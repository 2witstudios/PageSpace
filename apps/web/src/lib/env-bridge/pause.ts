/**
 * STOP reaches the machine (GA wave 3, leaf 3 amendment).
 *
 * The database stamp (`pausedAt`) makes the server refuse to SIGN; this
 * module makes the machine STOP what it is already running. A `pause` frame
 * — server-signed under its OWN domain (`pause/v1`) over `{envId,
 * enrollmentId, keyId, issuedAt, pausedAt}` by the key the enrollment
 * pinned, so it can never be replayed as a revoke nor a revoke as a pause —
 * goes over the env's live, AUTHORIZED socket. The daemon kills every
 * process group it started, drops every pending challenge, and acks with a
 * machine-signed `pause_result { envId, pausedAt, killed }` correlated on
 * `pause:<envId>:<pausedAt>` through the wave 2 ack machinery. The socket
 * stays open: the machine is not the thing being stopped.
 *
 * **Honest about reach**, exactly as an approval revoke is: `acknowledged`
 * carries the count the MACHINE signed; `unacknowledged` means the frame
 * went out and no genuine ack came back in time — the machine may still be
 * running it; `no_live_socket` means this replica does not hold the socket,
 * and the replica that does will send the same pause on its next heartbeat
 * (within one ping interval, `ENV_BRIDGE_PING_INTERVAL_MS`). Nothing here is
 * ever reported as "stopped" without the machine's signature saying so.
 *
 * **Acknowledged once per pause — retried until then.** Each socket remembers
 * the `pausedAt` the machine has ACKED (set only from the verified
 * `pause_result`, never from the send — Codex P1, review round 1) and the
 * one a delivery is currently awaiting. An unacknowledged attempt clears the
 * in-flight marker on failure, so the next heartbeat resends; a delivery in
 * flight is not doubled; a later Stop (a new `pausedAt`) is a new delivery.
 */
import type { WebSocket } from 'ws';
import { encodePauseForSigning, type PauseFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import type { ServerSigningKeyring } from '@pagespace/lib/env-bridge/server-signing-key';
import { loadServerSigningKeyring } from '@pagespace/lib/auth/env-bridge-signing-key';
import { logger } from '@pagespace/lib/logging/logger-config';
import { getEnvConnection, getEnvConnectionMetadata, isEnvAuthorized, markEnvPauseAcked, markEnvPauseInFlight } from '@/lib/websocket/ws-env-connections';
import { EnvBridgeError, getEnvBridgeClient } from '@/lib/env-bridge/bridge-client';
import { getDriveEnvStore } from '@/lib/drive-envs/drive-envs-runtime';

let pauseLogger: ReturnType<typeof logger.child> | null = null;
function log(): ReturnType<typeof logger.child> {
  pauseLogger ??= logger.child({ component: 'env-bridge-pause' });
  return pauseLogger;
}

/** How long the server waits for the machine's signed ack before reporting `unacknowledged`. */
export const PAUSE_ACK_TIMEOUT_MS = 5_000;

export interface PauseFrameInput {
  envId: string;
  enrollmentId: string;
  /** `drive_env_local.serverKeyId` — the ONLY key that may sign this pause. */
  serverKeyId: string | null;
  issuedAt: number;
  /** `drive_env_local.pausedAt`, ms — the pause this frame delivers. */
  pausedAt: number;
}

/** The signed pause frame for this enrollment, or `signing_key_unavailable` — never a signature under another key. */
export function buildPauseFrame(input: PauseFrameInput, keyring: Pick<ServerSigningKeyring, 'get'>): { ok: true; frame: PauseFrame; keyId: string } | { ok: false; reason: 'signing_key_unavailable' } {
  const key = input.serverKeyId === null ? null : keyring.get(input.serverKeyId);
  if (!key) return { ok: false, reason: 'signing_key_unavailable' };
  const sig = Buffer.from(key.sign(encodePauseForSigning({ envId: input.envId, enrollmentId: input.enrollmentId, keyId: key.keyId, issuedAt: input.issuedAt, pausedAt: input.pausedAt }))).toString('base64');
  return { ok: true, frame: { type: 'pause', sig, issuedAt: input.issuedAt, pausedAt: input.pausedAt }, keyId: key.keyId };
}

export type PauseNotifyOutcome =
  /** The machine's SIGNED ack: it killed `killed` process groups. The only outcome that proves anything stopped. */
  | { kind: 'acknowledged'; killed: number }
  /** Sent, but no genuine ack within the deadline: the machine may still be running. */
  | { kind: 'unacknowledged'; reason: string }
  /** This replica holds no socket for the env; the holder sends it on its next heartbeat. */
  | { kind: 'no_live_socket' }
  | { kind: 'unauthorized_socket' }
  | { kind: 'signing_key_unavailable' }
  /** A delivery of this exact pause is already awaiting its ack on this socket. */
  | { kind: 'already_sent' }
  /** The machine already acknowledged this exact pause on this socket: nothing to do. */
  | { kind: 'already_acknowledged' };

export interface PauseNotifyDeps {
  getConnection: (envId: string) => WebSocket | undefined;
  isAuthorized: (ws: WebSocket) => boolean;
  /** The `pausedAt` the machine has ACKED on this socket, if any — the once-per-pause guard. */
  ackedFor: (ws: WebSocket) => number | undefined;
  /** The `pausedAt` a delivery is awaiting an ack for on this socket, if any. */
  inFlightFor: (ws: WebSocket) => number | undefined;
  markInFlight: (ws: WebSocket, pausedAt: number | undefined) => void;
  /** Set ONLY from the machine's verified ack. */
  markAcked: (ws: WebSocket, pausedAt: number) => void;
  keyring: () => Pick<ServerSigningKeyring, 'get'>;
  /** Send the frame and await the machine's verified ack (production: `EnvBridgeClient.awaitPauseAck`). */
  awaitAck: (input: { envId: string; pausedAt: number; ws: WebSocket; frame: PauseFrame; timeoutMs: number }) => Promise<{ killed: number }>;
  timeoutMs?: number;
}

/** Push the signed pause over the env's live, AUTHORIZED socket on this replica (once per pause) and await the machine's SIGNED ack. Never throws. */
export async function notifyMachineOfPause(input: PauseFrameInput, deps: PauseNotifyDeps): Promise<PauseNotifyOutcome> {
  const ws = deps.getConnection(input.envId);
  if (!ws || (ws.readyState !== 0 && ws.readyState !== 1)) return { kind: 'no_live_socket' };
  if (!deps.isAuthorized(ws)) return { kind: 'unauthorized_socket' };
  if (deps.ackedFor(ws) === input.pausedAt) return { kind: 'already_acknowledged' };
  if (deps.inFlightFor(ws) === input.pausedAt) return { kind: 'already_sent' };
  const built = buildPauseFrame(input, deps.keyring());
  if (!built.ok) {
    log().error('Enrollment pinned a signing key that is no longer loaded; pause not sent', { envId: input.envId, serverKeyId: input.serverKeyId, action: 'pause_key_unavailable' });
    return { kind: 'signing_key_unavailable' };
  }
  // In flight BEFORE the send, so a caller racing this one does not double-deliver; the ACK marker is set only by the machine's signed answer.
  deps.markInFlight(ws, input.pausedAt);
  try {
    const ack = await deps.awaitAck({ envId: input.envId, pausedAt: input.pausedAt, ws, frame: built.frame, timeoutMs: deps.timeoutMs ?? PAUSE_ACK_TIMEOUT_MS });
    deps.markAcked(ws, input.pausedAt);
    log().info('Machine acknowledged the pause', { envId: input.envId, pausedAt: input.pausedAt, killed: ack.killed, action: 'pause_acknowledged' });
    return { kind: 'acknowledged', killed: ack.killed };
  } catch (error) {
    // Not acked: forget the attempt so the next heartbeat (or PATCH) sends again.
    deps.markInFlight(ws, undefined);
    const reason = error instanceof EnvBridgeError ? error.kind : error instanceof Error ? error.message : String(error);
    log().warn('Pause not acknowledged by the machine; will resend on the next heartbeat', { envId: input.envId, pausedAt: input.pausedAt, reason, action: 'pause_unacknowledged' });
    return { kind: 'unacknowledged', reason };
  }
}

/** The production deps: this replica's registry, the ring (read per call), the bridge client's ack correlation. */
export function productionPauseDeps(): PauseNotifyDeps {
  return {
    getConnection: getEnvConnection,
    isAuthorized: isEnvAuthorized,
    ackedFor: (ws) => getEnvConnectionMetadata(ws)?.pauseAckedForMs,
    inFlightFor: (ws) => getEnvConnectionMetadata(ws)?.pauseInFlightForMs,
    markInFlight: markEnvPauseInFlight,
    markAcked: markEnvPauseAcked,
    awaitAck: (ack) => getEnvBridgeClient().awaitPauseAck(ack),
    keyring: () => {
      try {
        return loadServerSigningKeyring();
      } catch (error) {
        log().error('Signing key ring unavailable during pause', { error: error instanceof Error ? error.message : String(error), action: 'pause_keyring_error' });
        return { get: () => null };
      }
    },
  };
}

export type PauseLocalEnvMachineResult = { ok: true; machine: PauseNotifyOutcome } | { ok: false; reason: 'not_found' | 'not_paused' | 'revoked' };

/**
 * Deliver the env's CURRENT pause to its machine through the production
 * seams — from the owner's PATCH (this replica) and from the heartbeat path
 * (whichever replica holds the socket). Reads `pausedAt` from the row so both
 * callers deliver the same stamp and the once-per-pause guard holds.
 */
export async function pauseLocalEnvMachine(input: { envId: string }): Promise<PauseLocalEnvMachineResult> {
  const row = await (await getDriveEnvStore()).findLocalByEnvId(input.envId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (row.pausedAt === null) return { ok: false, reason: 'not_paused' };
  const machine = await notifyMachineOfPause(
    { envId: input.envId, enrollmentId: row.enrollmentId, serverKeyId: row.serverKeyId, issuedAt: Date.now(), pausedAt: row.pausedAt.getTime() },
    productionPauseDeps(),
  );
  return { ok: true, machine };
}
