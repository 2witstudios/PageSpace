import type { RawData, WebSocket, WebSocketServer } from 'ws';
import type { NextRequest } from 'next/server';
import {
  registerEnvConnection,
  unregisterEnvConnection,
  updateEnvLastPing,
  markEnvAuthorized,
  isEnvAuthorized,
  markEnvLastSeenPersisted,
  getEnvConnectionMetadata,
  startEnvCleanupInterval,
  checkEnvConnectionHealth,
  verifyEnvConnectionFingerprint,
} from '@/lib/websocket/ws-env-connections';
import { getConnectionFingerprint, validateMessageSize, isSecureConnection } from '@/lib/websocket/ws-security';
import { decodeEnvBridgeFrame, encodeEnvBridgeFrame, isEnvBridgeMachineFrame, ENV_BRIDGE_FRAME_LIMITS, type EnvBridgeFrame } from '@/lib/websocket/ws-message-schemas';
import { sessionService, type SessionClaims } from '@pagespace/lib/auth/session-service';
import { ENV_BRIDGE_SCOPE } from '@pagespace/lib/auth/token-lifecycle-policy';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { LOCAL_ENV_HEARTBEAT_WINDOW_MS } from '@pagespace/lib/services/drive-envs/drive-envs';
import type { DriveEnvLocalRecord } from '@pagespace/lib/services/drive-envs/drive-envs-store';
import { initialBridgeSession, reduceBridgeSession, type BridgeSessionState } from '@pagespace/lib/env-bridge/bridge-session';
import { verifyHello, isMachineResultFrame, machineResultBindingId } from '@pagespace/lib/env-bridge/machine-signatures';
import { getDriveEnvStore } from '@/lib/drive-envs/drive-envs-runtime';
import { getEnvBridgeClient } from '@/lib/env-bridge/bridge-client';
import { replayUnacknowledgedApprovalRevokes } from '@/lib/env-bridge/revoke';
import { decodePinnedPublicKey, ed25519Verify } from '@/lib/env-bridge/crypto';
import { ENV_BRIDGE_HELLO_TIMEOUT_MS, ENV_BRIDGE_PING_INTERVAL_MS } from '@/lib/env-bridge/ws-route-config';

// Initialize cleanup interval on module load
// This prevents memory leaks from stale connections
startEnvCleanupInterval();

const RESOURCE_TYPE = 'env_bridge_websocket';
const DRIVE_ENV_RESOURCE = 'drive_env';

/**
 * Env-bridge WebSocket route — `/api/env-bridge/ws?envId=…` (Local Environments
 * epic, M1 · t07). The server end of the zero-trust bridge to a user's own
 * machine. A CLONE of `mcp-ws/route.ts`: every security check there is
 * mirrored here one-for-one (numbered the same way), followed by the bridge's
 * own checks. The differences are deliberate and listed:
 *
 * Mirrored from mcp-ws (same order, same close codes):
 *  1. WSS-only in production                       → 1008 'Secure connection required'
 *  2. Authorization: Bearer <opaque token>          → 1008 'Authorization required'
 *     session validated by the session service      → 1008 'Authentication error' / 'Invalid or expired token'
 *  3. scope                                          → 1008 'Insufficient permissions'
 *  4. connection fingerprint (IP + UA hash), registered with the session's expiry and token for periodic revalidation
 *  5. message size limit                              (audited; see "no error frames" below)
 *     JSON parse + schema validation                 (the codec IS the schema — one closed set, imported)
 *  6. fingerprint re-check on the heartbeat           → 1008 'Security violation'
 *  7. connection health check before a result is accepted
 *  Audit on every refusal via the `originalEvent` pattern; abnormal closes audited; errors audited.
 *
 * Bridge-specific, after the mirrored checks:
 *  - Off switch: `LOCAL_ENVS_ENABLED` false ⇒ the route refuses everything (invariant 11).
 *  - Scope must be EXACTLY `env:bridge`; `mcp:*` and `*` do NOT qualify (t06 keeps
 *    `env:bridge` outside `mcp:*`). Session `expectedType: 'mcp'`.
 *  - The token must be bound to THIS env: `resourceType = 'drive_env'`, `resourceId = envId` (URL).
 *  - (Codex C8) Token → enrollment binding: `drive_env_local` is resolved by the token's
 *    resourceId; it must be enrolled, not revoked, hold a pinned machine key, and belong to
 *    the token's user. The hello is verified under THAT row's key. The mcp_tokens/session
 *    split is never relied on for isolation.
 *  - First frame MUST be a machine-signed `hello` (envId = this env) within
 *    ENV_BRIDGE_HELLO_TIMEOUT_MS, or 1008. The pure reducer (`reduceBridgeSession`) decides
 *    what a frame may do in each state; this route only executes its effects.
 *  - On an authorized hello: capabilities + lastSeenAt persisted (`recordHello`), the socket
 *    marked authorized, and a `ping` sent at once — that first server frame IS the hello
 *    acknowledgement the daemon's reducer maps to `hello_ack` (the codec has no ack frame).
 *  - Heartbeat: the server pings every ENV_BRIDGE_PING_INTERVAL_MS; the machine's `pong`
 *    updates in-memory liveness on every beat and persists `lastSeenAt` at most once per
 *    LOCAL_ENV_HEARTBEAT_WINDOW_MS.
 *  - Direction: only machine→server frame types are accepted; a server→machine type arriving
 *    from the machine is dropped + audited (invariant 6). Unknown/malformed frames are dropped
 *    + audited once authorized, and close the socket 1008 while the hello is pending.
 *  - Results (`exec_result` / `fs_read_result` / `fs_write_result` / `grant_denied`) go to the
 *    bridge client, which delivers them ONLY after their machine signature verifies under the
 *    socket's pinned key (invariant 7); an unverified result is audited at high risk.
 *  - PTY frames are dropped in M1 (M2 adds them; see [D-2] for their signing).
 *
 * No error frames are echoed to the machine (mcp-ws sends `{type:'error'}` messages): the
 * bridge's closed frame set has no error frame and the server never sends anything outside
 * that set (invariant 6). Refusals are audited and, where the protocol requires, the socket is
 * closed with a reason.
 */
/** How many frames may arrive before the `hello` handler exists. One `hello` is all the protocol allows; the rest is slack for a retry, not a queue. */
const MAX_EARLY_FRAMES = 4;

export async function UPGRADE(client: WebSocket, server: WebSocketServer, request: NextRequest) {
  const requestUrl = request.url;

  // The socket is already flowing when this function is entered, and the daemon
  // sends its `hello` the instant `open` fires — but the real `message` listener
  // cannot be attached until the token is validated and the enrollment row is
  // read, two awaits later. Anything that arrives in between is emitted with no
  // listener and dropped by the EventEmitter, and the handshake then times out
  // 10 s later with the frame never having been seen. Route tests never caught
  // it because they attach their listeners synchronously.
  //
  // So: buffer from the first synchronous instant, and drain into the real
  // handler once it exists. The cap is small and pre-auth on purpose — one
  // `hello` is all the protocol allows before authorization, and an unauthorized
  // client that floods is closed rather than allowed to grow this array.
  const earlyFrames: RawData[] = [];
  let earlyOverflow = false;
  let ready = false;
  // Assigned once the real handler below exists. ONE listener, installed here
  // and never swapped: `off`/`removeListener` are not part of the socket
  // surface this route is written against.
  let handleMessage: (data: RawData) => void = () => {};
  client.on('message', (data: RawData) => {
    if (ready) { handleMessage(data); return; }
    if (earlyFrames.length >= MAX_EARLY_FRAMES) { earlyOverflow = true; return; }
    earlyFrames.push(data);
  });

  // SECURITY CHECK 0 (bridge): the cloud opt-in. Off ⇒ nothing here exists.
  if (!isLocalEnvsEnabled()) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      resourceType: RESOURCE_TYPE,
      riskScore: 0.2,
      details: { originalEvent: 'env_bridge_disabled' },
    });
    client.close(1008, 'Not available');
    return;
  }

  // SECURITY CHECK 1: Verify secure connection in production
  if (!isSecureConnection(requestUrl, request)) {
    auditRequest(request, {
      eventType: 'security.anomaly.detected',
      resourceType: RESOURCE_TYPE,
      riskScore: 0.7,
      details: { originalEvent: 'ws_insecure_connection_rejected', url: requestUrl },
    });
    client.close(1008, 'Secure connection required');
    return;
  }

  // SECURITY CHECK 2: Extract and validate opaque token from Authorization header
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    auditRequest(request, {
      eventType: 'auth.login.failure',
      resourceType: RESOURCE_TYPE,
      riskScore: 0.3,
      details: { originalEvent: 'ws_authentication_failed', reason: 'Missing Authorization header' },
    });
    client.close(1008, 'Authorization required');
    return;
  }

  const token = authHeader.slice(7).trim();

  let claims: SessionClaims | null = null;
  try {
    claims = await sessionService.validateSession(token, { expectedType: 'mcp' });
  } catch (error) {
    auditRequest(request, {
      eventType: 'auth.login.failure',
      resourceType: RESOURCE_TYPE,
      riskScore: 0.3,
      details: { originalEvent: 'ws_session_validation_error', error: error instanceof Error ? error.message : String(error) },
    });
    client.close(1008, 'Authentication error');
    return;
  }

  if (!claims) {
    auditRequest(request, {
      eventType: 'auth.login.failure',
      resourceType: RESOURCE_TYPE,
      riskScore: 0.3,
      details: { originalEvent: 'ws_authentication_failed', reason: 'Invalid or expired session token' },
    });
    client.close(1008, 'Invalid or expired token');
    return;
  }

  const userId = claims.userId;

  // SECURITY CHECK 3: scope — EXACTLY env:bridge. The mcp-ws wildcards do not qualify here.
  if (!claims.scopes.includes(ENV_BRIDGE_SCOPE)) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId,
      resourceType: RESOURCE_TYPE,
      riskScore: 0.5,
      details: { originalEvent: 'ws_insufficient_permissions', scopes: claims.scopes },
    });
    client.close(1008, 'Insufficient permissions');
    return;
  }

  // SECURITY CHECK 3b (bridge): the token is bound to THIS env.
  const envId = new URL(requestUrl).searchParams.get('envId')?.trim() ?? '';
  if (envId.length === 0 || claims.resourceType !== DRIVE_ENV_RESOURCE || claims.resourceId !== envId) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId,
      resourceType: RESOURCE_TYPE,
      resourceId: envId || undefined,
      riskScore: 0.6,
      details: { originalEvent: 'env_bridge_token_env_mismatch', tokenResourceType: claims.resourceType ?? null, tokenResourceId: claims.resourceId ?? null },
    });
    client.close(1008, 'Token not bound to this environment');
    return;
  }

  // SECURITY CHECK 3c (bridge, Codex C8): token → enrollment. The row the token's
  // resourceId names must be an enrolled, unrevoked machine owned by the token's
  // user; its pinned key is what the hello is verified under.
  let row: DriveEnvLocalRecord | null = null;
  try {
    row = await (await getDriveEnvStore()).findLocalByEnvId(envId);
  } catch (error) {
    auditRequest(request, {
      eventType: 'security.anomaly.detected',
      userId,
      resourceType: RESOURCE_TYPE,
      resourceId: envId,
      riskScore: 0.3,
      details: { originalEvent: 'env_bridge_enrollment_lookup_error', error: error instanceof Error ? error.message : String(error) },
    });
    client.close(1008, 'Authentication error');
    return;
  }
  const enrollmentRefusal = !row
    ? 'not_found'
    : row.revokedAt !== null
      ? 'revoked'
      : row.enrolledAt === null || row.machinePublicKey === null
        ? 'not_enrolled'
        : row.ownerId !== userId
          ? 'owner_mismatch'
          : null;
  if (!row || enrollmentRefusal !== null) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId,
      resourceType: RESOURCE_TYPE,
      resourceId: envId,
      riskScore: enrollmentRefusal === 'owner_mismatch' ? 0.7 : 0.4,
      details: { originalEvent: 'env_bridge_enrollment_refused', reason: enrollmentRefusal },
    });
    client.close(1008, 'Environment not enrolled');
    return;
  }
  const machinePublicKey = decodePinnedPublicKey(row.machinePublicKey);
  if (machinePublicKey === null) {
    auditRequest(request, {
      eventType: 'security.anomaly.detected',
      userId,
      resourceType: RESOURCE_TYPE,
      resourceId: envId,
      riskScore: 0.5,
      details: { originalEvent: 'env_bridge_enrollment_refused', reason: 'bad_pinned_key' },
    });
    client.close(1008, 'Environment not enrolled');
    return;
  }
  const enrollment = row;

  // SECURITY CHECK 4: Generate connection fingerprint
  const fingerprint = getConnectionFingerprint(request);

  // Register in hello_pending (a second socket for this env supersedes the first).
  // Pass sessionExpiresAt to enforce TTL on persistent connections
  // Pass token to enable periodic session revalidation (detects revoked sessions)
  registerEnvConnection(envId, client, {
    userId,
    sessionId: claims.sessionId,
    enrollmentId: enrollment.enrollmentId,
    machinePublicKey: enrollment.machinePublicKey!,
    serverKeyId: enrollment.serverKeyId,
    fingerprint,
    sessionExpiresAt: claims.expiresAt,
    wsToken: token,
  });

  // Fingerprint is intentionally NOT embedded in audit details — it is a
  // stable, client-linkable pseudonym (hash of IP+UA) that would persist in
  // the tamper-evident audit chain and resist GDPR erasure requests.
  auditRequest(request, {
    eventType: 'auth.session.created',
    userId,
    sessionId: claims.sessionId,
    resourceType: RESOURCE_TYPE,
    resourceId: envId,
    riskScore: 0,
    details: { originalEvent: 'env_bridge_connection_pending', enrollmentId: enrollment.enrollmentId },
  });

  // The daemon's lifecycle reducer, run on the server side of the same
  // handshake: connecting (awaiting hello) → hello_sent (hello received,
  // verifying) → authorized. Frames are dispatched ONLY in authorized.
  let session: BridgeSessionState = reduceBridgeSession(initialBridgeSession(), { type: 'connect' }).state;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const refuse = (event: string, reason: string, closeReason: string, riskScore = 0.5) => {
    auditRequest(request, {
      eventType: 'security.anomaly.detected',
      userId,
      resourceType: RESOURCE_TYPE,
      resourceId: envId,
      riskScore,
      details: { originalEvent: event, reason },
    });
    client.close(1008, closeReason);
  };

  const dropFrame = (event: string, detail: Record<string, unknown>, riskScore = 0.3) => {
    auditRequest(request, {
      eventType: 'security.anomaly.detected',
      userId,
      resourceType: RESOURCE_TYPE,
      resourceId: envId,
      riskScore,
      details: { originalEvent: event, ...detail },
    });
  };

  // Not a valid signed hello within the window ⇒ 1008.
  const helloTimer = setTimeout(() => {
    if (!isEnvAuthorized(client)) refuse('env_bridge_hello_timeout', 'no valid hello within window', 'Handshake timeout', 0.4);
  }, ENV_BRIDGE_HELLO_TIMEOUT_MS);

  const sendPing = () => {
    if (client.readyState !== 1 || !isEnvAuthorized(client)) return;
    client.send(encodeEnvBridgeFrame({ type: 'ping', ts: Date.now() }));
  };

  const onHello = async (frame: Extract<EnvBridgeFrame, { type: 'hello' }>) => {
    // The reducer opens the handshake with this hello (or refuses it).
    const opened = reduceBridgeSession(session, { type: 'socket_open', hello: frame });
    session = opened.state;
    if (opened.effects.some((effect) => effect.type === 'reject')) {
      refuse('env_bridge_hello_rejected', 'reducer rejected hello', 'Invalid hello', 0.6);
      return;
    }
    const verdict = verifyHello({ hello: frame, expectedEnvId: envId, machinePublicKey, verify: ed25519Verify });
    if (!verdict.ok) {
      refuse('env_bridge_hello_invalid', verdict.reason, 'Invalid hello', 0.7);
      return;
    }
    const now = new Date();
    const recorded = await (await getDriveEnvStore()).recordHello({ envId, capabilities: frame.capabilities, now });
    if (!recorded) {
      // Revoked (or un-enrolled) between the upgrade and the hello: the CAS says no.
      refuse('env_bridge_hello_refused', 'enrollment no longer live', 'Environment revoked', 0.5);
      return;
    }
    if (client.readyState !== 1) return;
    session = reduceBridgeSession(session, { type: 'hello_ack' }).state;
    markEnvAuthorized(client);
    markEnvLastSeenPersisted(client, now);
    updateEnvLastPing(client);
    clearTimeout(helloTimer);
    auditRequest(request, {
      eventType: 'auth.session.created',
      userId,
      sessionId: claims!.sessionId,
      resourceType: RESOURCE_TYPE,
      resourceId: envId,
      riskScore: 0,
      details: { originalEvent: 'env_bridge_connection_established', capabilities: frame.capabilities, policyDigest: frame.policyDigest },
    });
    // THE REPLAY (GA wave 3, leaf 5): every approval revoke the mirror still
    // owes this machine goes out now, under a hold that keeps every grant for
    // this env waiting until the machine has signed its acks — so a revoke
    // made while the machine was away lands before the first grant is signed.
    // The hold is installed SYNCHRONOUSLY here, in the same tick the socket
    // became authorized, so no grant can slip between the two; the replay
    // itself runs in the background and the ping (the daemon's hello_ack)
    // is not delayed by it — the daemon dispatches `revoke` from every state.
    void getEnvBridgeClient().withHold(envId, async () => {
      const replay = await replayUnacknowledgedApprovalRevokes({ envId, enrollmentId: enrollment.enrollmentId, serverKeyId: enrollment.serverKeyId, ws: client });
      if (replay.replayed > 0) {
        auditRequest(request, {
          eventType: 'auth.token.revoked',
          userId,
          resourceType: RESOURCE_TYPE,
          resourceId: envId,
          riskScore: 0,
          details: { originalEvent: 'env_bridge_approval_revokes_replayed', replayed: replay.replayed, acknowledged: replay.acknowledged },
        });
      }
    });
    // The first server frame acknowledges the hello (the daemon maps it to hello_ack).
    sendPing();
    pingTimer = setInterval(sendPing, ENV_BRIDGE_PING_INTERVAL_MS);
  };

  const onPong = async () => {
    // SECURITY CHECK 6: Verify connection fingerprint on the heartbeat to detect session hijacking
    const currentFingerprint = getConnectionFingerprint(request);
    if (!verifyEnvConnectionFingerprint(client, currentFingerprint)) {
      refuse('ws_fingerprint_mismatch', 'Connection fingerprint changed - possible session hijacking', 'Security violation', 0.7);
      return;
    }
    updateEnvLastPing(client);
    const metadata = getEnvConnectionMetadata(client);
    const now = new Date();
    const lastPersisted = metadata?.lastSeenPersistedAt?.getTime() ?? 0;
    const store = await getDriveEnvStore();
    // Persist lastSeenAt at most once per heartbeat window — never on every ping.
    if (now.getTime() - lastPersisted >= LOCAL_ENV_HEARTBEAT_WINDOW_MS) {
      markEnvLastSeenPersisted(client, now);
      const recorded = await store.recordHeartbeat({ envId, now });
      if (!recorded) {
        refuse('env_bridge_heartbeat_refused', 'enrollment no longer live', 'Environment revoked', 0.5);
        return;
      }
    }
    // STOP reaches this replica here (GA wave 3): the owner's PATCH may have
    // landed elsewhere, but the grants in flight AND the machine's socket are
    // here. On EVERY pong (one row read per ping interval) a paused row fails
    // the in-flight requests typed `paused` and delivers the signed `pause`
    // to the machine — once per pause; `markEnvPauseSent` is the guard — so a
    // Stop made anywhere reaches the process within ENV_BRIDGE_PING_INTERVAL_MS.
    // The socket stays: Stop pauses grants and kills processes, not the machine.
    const sibling = await store.findLocalByEnvId(envId);
    if (sibling?.pausedAt != null) {
      const ended = getEnvBridgeClient().pauseEnv(envId);
      if (ended > 0) dropFrame('env_bridge_paused_in_flight', { ended }, 0.1);
      if (metadata?.pauseSentForMs !== sibling.pausedAt.getTime()) {
        const { pauseLocalEnvMachine } = await import('@/lib/env-bridge/pause');
        const delivered = await pauseLocalEnvMachine({ envId });
        auditRequest(request, {
          eventType: 'data.write',
          userId,
          resourceType: RESOURCE_TYPE,
          resourceId: envId,
          riskScore: 0,
          details: { originalEvent: 'env_bridge_pause_delivered', pausedAt: sibling.pausedAt.toISOString(), machine: delivered.ok ? delivered.machine.kind : delivered.reason, ...(delivered.ok && delivered.machine.kind === 'acknowledged' && { killed: delivered.machine.killed }) },
        });
      }
    }
  };

  const onAuthorizedFrame = (frame: EnvBridgeFrame) => {
    if (frame.type === 'pong') {
      void onPong().catch((error) => dropFrame('env_bridge_heartbeat_error', { error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (isMachineResultFrame(frame)) {
      const grantId = machineResultBindingId(frame);
      // SECURITY CHECK 7: Connection health check before a result is accepted
      const health = checkEnvConnectionHealth(client);
      if (!health.isHealthy) {
        dropFrame('ws_unhealthy_connection_result', { reason: health.reason, readyState: health.readyState, grantId }, 0.5);
        return;
      }
      const disposition = getEnvBridgeClient().handleMachineResult(client, frame);
      if (disposition === 'unverified') {
        dropFrame('env_bridge_result_unverified', { grantId, frameType: frame.type }, 0.8);
      } else if (disposition === 'dropped_wrong_env') {
        dropFrame('env_bridge_result_wrong_env', { grantId, frameType: frame.type }, 0.8);
      } else if (disposition !== 'delivered') {
        dropFrame('env_bridge_result_dropped', { grantId, frameType: frame.type, disposition }, 0.3);
      }
      return;
    }
    // hello again, pty_opened / pty_data / pty_exit (M2): dropped, never crash.
    dropFrame('env_bridge_frame_dropped', { frameType: frame.type, reason: frame.type === 'hello' ? 'duplicate_hello' : 'unsupported_in_m1' }, 0.2);
  };

  // Handle incoming messages
  handleMessage = (data: RawData) => {
    try {
      // SECURITY CHECK 5: Validate message size
      const sizeValidation = validateMessageSize(data);
      if (!sizeValidation.valid) {
        dropFrame('ws_message_too_large', { size: sizeValidation.size, maxSize: sizeValidation.maxSize });
        if (session.status !== 'authorized') client.close(1008, 'Hello required');
        return;
      }

      // Parse and validate with the closed frame set (the codec is the schema: size in bytes → JSON → shape)
      const decoded = decodeEnvBridgeFrame(data.toString(), ENV_BRIDGE_FRAME_LIMITS);
      if (!decoded.ok) {
        dropFrame('ws_message_validation_failed', { reason: decoded.reason });
        if (session.status !== 'authorized') client.close(1008, 'Hello required');
        return;
      }
      const frame = decoded.frame;

      // Direction: the machine may only send machine→server frames (invariant 6).
      if (!isEnvBridgeMachineFrame(frame)) {
        dropFrame('env_bridge_wrong_direction_frame', { frameType: frame.type }, 0.5);
        if (session.status !== 'authorized') client.close(1008, 'Hello required');
        return;
      }

      if (session.status === 'connecting') {
        // The first frame must be the hello. Anything else is not a valid hello.
        if (frame.type !== 'hello') {
          refuse('env_bridge_hello_required', `first frame was ${frame.type}`, 'Hello required', 0.5);
          return;
        }
        void onHello(frame).catch((error) => {
          auditRequest(request, {
            eventType: 'security.anomaly.detected',
            userId,
            resourceType: RESOURCE_TYPE,
            resourceId: envId,
            riskScore: 0.3,
            details: { originalEvent: 'env_bridge_hello_error', error: error instanceof Error ? error.message : String(error) },
          });
          client.close(1008, 'Authentication error');
        });
        return;
      }

      if (session.status === 'hello_sent') {
        // A hello is being verified; nothing else is accepted meanwhile.
        dropFrame('env_bridge_frame_dropped', { frameType: frame.type, reason: 'hello_pending' }, 0.3);
        return;
      }

      // Authorized (or revoked): the reducer decides; this route executes.
      const reduction = reduceBridgeSession(session, { type: 'frame', frame });
      session = reduction.state;
      for (const effect of reduction.effects) {
        if (effect.type === 'dispatch') onAuthorizedFrame(effect.frame);
        else if (effect.type === 'reject') dropFrame('env_bridge_frame_rejected', { frameType: frame.type, reason: effect.reason }, 0.3);
      }
    } catch (error) {
      auditRequest(request, {
        eventType: 'security.anomaly.detected',
        userId,
        resourceType: RESOURCE_TYPE,
        resourceId: envId,
        riskScore: 0.3,
        details: { originalEvent: 'ws_message_parse_error', error: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  // The real handler exists now: go live, then hand over anything that arrived
  // during the two awaits above, in order.
  ready = true;
  if (earlyOverflow) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId,
      resourceType: RESOURCE_TYPE,
      resourceId: envId,
      riskScore: 0.4,
      details: { originalEvent: 'env_bridge_preauth_flood', bufferedFrames: earlyFrames.length },
    });
    // Clean up HERE: `registerEnvConnection` and `helloTimer` have both already
    // run, and the `close` listener that would normally undo them is installed
    // below this return. Without this the dead socket sits in the env registry
    // until the five-minute stale sweep — so `isConnected(envId)` answers true
    // for a socket nobody is on, and a real exec is routed into nothing — and
    // the hello timer later fires a second refusal against a closed client.
    clearTimeout(helloTimer);
    unregisterEnvConnection(envId, client);
    client.close(1008, 'Too many frames before hello');
    return;
  }
  for (const buffered of earlyFrames.splice(0)) handleMessage(buffered);

  // Handle client disconnect
  client.on('close', (code, reason) => {
    clearTimeout(helloTimer);
    if (pingTimer) clearInterval(pingTimer);
    // Only audit abnormal closes. Normal closes (1000 = clean, 1001 = going away)
    // are routine transport-level lifecycle events, not security events.
    const isNormalClose = code === 1000 || code === 1001;
    if (!isNormalClose) {
      auditRequest(request, {
        eventType: 'security.anomaly.detected',
        userId,
        resourceType: RESOURCE_TYPE,
        resourceId: envId,
        riskScore: 0.3,
        details: { originalEvent: 'ws_connection_closed', code, reason: reason.toString() },
      });
    }
    // CAS on identity inside: a superseded socket closing late evicts nothing
    // and cancels nothing; the LIVE socket's loss cancels this env's in-flight
    // requests through the bridge client's lost listener.
    unregisterEnvConnection(envId, client);
  });

  // Handle errors
  client.on('error', (error) => {
    auditRequest(request, {
      eventType: 'security.anomaly.detected',
      userId,
      resourceType: RESOURCE_TYPE,
      resourceId: envId,
      riskScore: 0.3,
      details: { originalEvent: 'ws_error', error: error instanceof Error ? error.message : String(error) },
    });
  });
}

// Fallback for non-WebSocket requests
export function GET(): Response {
  return new Response('WebSocket endpoint - use WebSocket protocol to connect', {
    status: 426,
    headers: {
      Upgrade: 'websocket',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}
