/**
 * Env-bridge client — the server side of one request to a LOCAL environment:
 * sign the grant (invariant 3), send it over the env's AUTHORIZED socket
 * only (invariant 6), correlate the reply by grantId with a deadline from
 * `resolveTimeout`, and hand the reply to the caller ONLY after its machine
 * signature verified (invariant 7).
 *
 * This is the seam the t09 host (`local-env-sandbox-host.ts`) will call; the
 * socket route calls `handleMachineResult` for every result frame it decodes.
 * Everything with a side effect is injected so the contract is testable with
 * fake sockets and fake timers; `getEnvBridgeClient()` binds the real
 * registry, key ring and clock.
 */
import type { WebSocket } from 'ws';
import { encodeFrame } from '@pagespace/lib/env-bridge/frame-codec';
import type { ApprovalIntent, GrantPrincipal } from '@pagespace/lib/env-bridge/grant';
import { grantRequestForFrame, type GrantFrame, type UnsignedGrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import { decideSign, type SignDenyReason } from '@pagespace/lib/env-bridge/decide-sign';
import { parseServerPolicy } from '@pagespace/lib/env-bridge/policy-types';
import type { MachineResultFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import type { ServerSigningKeyring } from '@pagespace/lib/env-bridge/server-signing-key';
import { logger } from '@pagespace/lib/logging/logger-config';
import { loadServerSigningKeyring } from '@pagespace/lib/auth/env-bridge-signing-key';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { audit } from '@pagespace/lib/audit/audit-log';
import { getAuthorizedEnvConnection, getEnvConnectionMetadata, onEnvConnectionLost } from '@/lib/websocket/ws-env-connections';
import { RequestCorrelator, CorrelationError, grantCorrelatorTimeoutMs, type CorrelationFailureKind } from './correlator';
import { signGrantFrame, type GrantIdSource } from './grant-signer';
import { verifyResultFromMachine } from './result-verifier';
import { getPendingApprovalStore, type PendingApprovalStore } from './pending-approvals';

/** The reason prefix a daemon answers with while a request waits for its owner's click. */
export const ASK_PENDING_PREFIX = 'ask_pending:';

export type EnvBridgeFailureKind = CorrelationFailureKind | 'not_connected' | 'signing_key_unavailable' | 'ttl_too_long' | 'server_denied';

export class EnvBridgeError extends Error {
  constructor(
    readonly kind: EnvBridgeFailureKind,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EnvBridgeError';
  }
}

/** What the client needs to know about the socket a frame arrived on / goes out on. */
export interface EnvSocketFacts {
  readonly envId: string;
  readonly machinePublicKey: string | null;
  readonly serverKeyId: string | null;
}

/** The two facts of the `drive_env_local` sibling that `decideSign` needs. `serverPolicy` arrives UNPARSED (jsonb) and is parsed strictly here. */
export type SigningSibling = { readonly revokedAt: Date | null; readonly serverPolicy: unknown };

export interface EnvBridgeClientDeps {
  readonly correlator: RequestCorrelator<MachineResultFrame>;
  /** The env's sibling row, read fresh per grant — `DriveEnvStore.findLocalByEnvId`. `null` = no sibling (a dead local env). */
  readonly findLocalByEnvId: (envId: string) => Promise<SigningSibling | null>;
  /** `LOCAL_ENVS_ENABLED` for this deployment, read per grant so a flag flip needs no restart. */
  readonly flagEnabled: () => boolean;
  /** Every refusal to sign is audited; this is the hook (production: the security audit log). */
  readonly onSignRefused?: (info: { envId: string; op: string; reason: SignDenyReason; principal: GrantPrincipal }) => void;
  /** The env's socket IFF authorized and open — `getAuthorizedEnvConnection`. */
  readonly getAuthorizedConnection: (envId: string) => WebSocket | undefined;
  readonly getSocketFacts: (ws: WebSocket) => EnvSocketFacts | undefined;
  /** Lazy: loading the ring throws when no key is configured, and a Sprite-only deployment must never trip on it. */
  readonly keyring: () => Pick<ServerSigningKeyring, 'get'>;
  readonly now: () => number;
  readonly ids: GrantIdSource;
  /** Observability hook for a result that failed verification (audit/log). */
  readonly onUnverified?: (info: { envId: string; grantId: string; frameType: MachineResultFrame['type']; reason: string }) => void;
  /** Where a daemon's `ask_pending` answer is remembered for the owner's click (GA wave 2). Omitted = the process-wide store. */
  readonly pendingApprovals?: PendingApprovalStore;
}

export type MachineResultDisposition = 'delivered' | 'unverified' | 'dropped_unknown_grant' | 'dropped_unregistered_socket' | 'dropped_wrong_env';

/** Built on first use, never at import (see ws-env-connections.ts for why). */
let clientLogger: ReturnType<typeof logger.child> | null = null;
function log(): ReturnType<typeof logger.child> {
  clientLogger ??= logger.child({ component: 'env-bridge-client' });
  return clientLogger;
}

export class EnvBridgeClient {
  constructor(private readonly deps: EnvBridgeClientDeps) {}

  /**
   * Send one granted request to the env and await its VERIFIED result.
   * Rejects with a typed `EnvBridgeError` on every failure path.
   *
   * **The server's say comes FIRST** (GA wave 1, invariant 4). `decideSign`
   * runs over the env's sibling row before the socket is looked up and before
   * `signGrantFrame` is reached: a refusal never touches the signing key,
   * never mints a grant id, and the daemon never sees a frame. Signing is the
   * chokepoint because the grant IS the capability — refusing to mint beats
   * asking a daemon we do not control to refuse what we minted.
   */
  async sendGrant(input: { envId: string; frame: UnsignedGrantFrame; principal: GrantPrincipal; approvalIntent?: ApprovalIntent }): Promise<MachineResultFrame> {
    // The op is the same projection the signer and the daemon's gate use on
    // the frame as sent (grant/sig are envelope, so placeholders change nothing).
    const op = grantRequestForFrame({ ...input.frame, grant: {}, sig: '' } as GrantFrame).op;
    const sibling = await this.deps.findLocalByEnvId(input.envId);
    const verdict = decideSign({
      op,
      // A missing sibling is a dead local env (the owner was erased): treated
      // as revoked, exactly as the bind gate treats it. A stored policy the
      // strict parser refuses is `null` and denies.
      envRevoked: sibling === null || sibling.revokedAt !== null,
      serverPolicy: sibling === null ? null : parseServerPolicy(sibling.serverPolicy),
      flagEnabled: this.deps.flagEnabled(),
    });
    if (!verdict.ok) {
      log().warn('Refused to sign a grant for a local environment', { envId: input.envId, op, reason: verdict.reason, userId: input.principal.userId, sessionId: input.principal.sessionId, action: 'sign_refused' });
      this.deps.onSignRefused?.({ envId: input.envId, op, reason: verdict.reason, principal: input.principal });
      throw new EnvBridgeError('server_denied', `PageSpace refused to sign a ${op} grant for ${input.envId}: ${verdict.reason}`, { envId: input.envId, op, reason: verdict.reason });
    }

    const ws = this.deps.getAuthorizedConnection(input.envId);
    const facts = ws ? this.deps.getSocketFacts(ws) : undefined;
    if (!ws || !facts) throw new EnvBridgeError('not_connected', `Environment ${input.envId} has no authorized bridge connection on this replica`, { envId: input.envId });

    const signed = signGrantFrame({
      frame: input.frame,
      envId: input.envId,
      principal: input.principal,
      serverKeyId: facts.serverKeyId,
      keyring: this.deps.keyring(),
      now: this.deps.now(),
      ids: this.deps.ids,
      ...(input.approvalIntent !== undefined && { approvalIntent: input.approvalIntent }),
    });
    if (!signed.ok) throw new EnvBridgeError(signed.reason, `Cannot sign grant for ${input.envId}: ${signed.reason}`, { envId: input.envId, serverKeyId: facts.serverKeyId });

    const timeoutMs = grantCorrelatorTimeoutMs(signed.frame);
    log().info('Sending grant to local environment', { envId: input.envId, grantId: signed.grant.grantId, op: signed.grant.op, keyId: signed.keyId, timeoutMs, action: 'send_grant' });
    try {
      const result = await this.deps.correlator.open({
        id: signed.grant.grantId,
        group: input.envId,
        timeoutMs,
        send: () => ws.send(encodeFrame(signed.frame)),
      });
      // The machine froze the request for its owner's click (GA wave 2):
      // remember what re-issuing it needs, under the id the machine chose,
      // for as long as the machine itself will hold it (the grant's exp).
      // Only a VERIFIED reply reaches here, so `pending` is what the machine
      // signed. A reply whose id and reason disagree is not remembered.
      if (result.type === 'grant_denied' && result.reason.startsWith(ASK_PENDING_PREFIX) && result.pending !== undefined) {
        const challengeId = result.reason.slice(ASK_PENDING_PREFIX.length);
        if (challengeId.length > 0 && challengeId === result.pending.challengeId) {
          const store = this.deps.pendingApprovals ?? getPendingApprovalStore();
          const remembered = store.remember({ challengeId, envId: input.envId, frame: input.frame, principal: signed.grant.principal, expiresAt: signed.grant.exp, pending: result.pending, createdAt: this.deps.now() }, this.deps.now());
          log().info('Local environment is waiting for its owner\'s approval', { envId: input.envId, grantId: signed.grant.grantId, challengeId, remembered, action: 'approval_pending' });
        }
      }
      return result;
    } catch (error) {
      if (error instanceof CorrelationError) throw new EnvBridgeError(error.kind, error.message, { ...error.detail, envId: input.envId });
      throw error;
    }
  }

  /**
   * A result frame arrived on `ws`. Cheap checks first (is the socket ours, is
   * the grant pending, is THIS socket's env the env that owns the pending
   * request), THEN the signature, and only a verified result is delivered.
   *
   * The env binding is load-bearing (Codex P1 on #2543): verification runs
   * under the SENDING socket's pinned key, so without it an authorized env B
   * that learned env A's pending grantId could sign a result with its own key,
   * verify, and answer A's request. A result from any env other than the
   * request's owner is refused before crypto and the request stays pending
   * for its real owner. An unverified result from the owning env fails the
   * request with `unverified_result` — the agent never sees its contents.
   */
  handleMachineResult(ws: WebSocket, frame: MachineResultFrame): MachineResultDisposition {
    const facts = this.deps.getSocketFacts(ws);
    if (!facts) {
      log().warn('Result frame from an unregistered socket dropped', { grantId: frame.grantId, frameType: frame.type, action: 'result_dropped' });
      return 'dropped_unregistered_socket';
    }
    const owner = this.deps.correlator.groupOf(frame.grantId);
    if (owner === undefined) {
      log().warn('Result frame for an unknown grant dropped', { envId: facts.envId, grantId: frame.grantId, frameType: frame.type, action: 'result_dropped' });
      return 'dropped_unknown_grant';
    }
    if (owner !== facts.envId) {
      log().error('Result frame from an env that does not own the grant refused — request stays pending for its owner', { envId: facts.envId, ownerEnvId: owner, grantId: frame.grantId, frameType: frame.type, action: 'result_wrong_env' });
      this.deps.onUnverified?.({ envId: facts.envId, grantId: frame.grantId, frameType: frame.type, reason: 'wrong_env' });
      return 'dropped_wrong_env';
    }
    const verified = verifyResultFromMachine({ frame, machinePublicKey: facts.machinePublicKey });
    if (!verified.ok) {
      log().error('Result frame failed machine-signature verification — NOT delivered', { envId: facts.envId, grantId: frame.grantId, frameType: frame.type, reason: verified.reason, action: 'result_unverified' });
      this.deps.onUnverified?.({ envId: facts.envId, grantId: frame.grantId, frameType: frame.type, reason: verified.reason });
      this.deps.correlator.reject(frame.grantId, new EnvBridgeError('unverified_result', `Result for grant ${frame.grantId} failed machine-signature verification (${verified.reason})`, { envId: facts.envId, grantId: frame.grantId, reason: verified.reason }));
      return 'unverified';
    }
    this.deps.correlator.resolve(frame.grantId, frame);
    return 'delivered';
  }

  /** The env's live socket is gone: fail its in-flight requests with a typed `disconnected`. */
  cancelEnv(envId: string, reason = 'bridge connection lost'): number {
    return this.deps.correlator.cancelGroup(envId, new EnvBridgeError('disconnected', `Environment ${envId}: ${reason}`, { envId }));
  }

  pendingCountForEnv(envId: string): number {
    return this.deps.correlator.pendingCountForGroup(envId);
  }
}

let singleton: EnvBridgeClient | null = null;
let keyring: ServerSigningKeyring | null = null;

/**
 * The key ring, loaded on FIRST USE rather than at import: loading throws when
 * no signing key is configured (fail closed, invariant 3), and a Sprite-only
 * deployment must never trip on it merely by importing the route.
 */
function loadKeyring(): ServerSigningKeyring {
  keyring ??= loadServerSigningKeyring();
  return keyring;
}

/** The production client: real registry, real key ring (lazily), real clock; cancels an env's requests when its live socket is lost. */
export function getEnvBridgeClient(): EnvBridgeClient {
  if (singleton) return singleton;
  const client = new EnvBridgeClient({
    correlator: new RequestCorrelator<MachineResultFrame>({
      onDropped: (id) => log().warn('Reply for a grant that is not pending dropped', { grantId: id, action: 'reply_dropped' }),
    }),
    getAuthorizedConnection: getAuthorizedEnvConnection,
    // Loaded lazily: the runtime module reaches this client through the
    // sandbox host registry, so a static import here would be a cycle.
    findLocalByEnvId: async (envId) => {
      const { getDriveEnvStore } = await import('@/lib/drive-envs/drive-envs-runtime');
      return (await getDriveEnvStore()).findLocalByEnvId(envId);
    },
    flagEnabled: () => isLocalEnvsEnabled(),
    onSignRefused: ({ envId, op, reason, principal }) =>
      audit({
        eventType: 'authz.access.denied',
        userId: principal.userId,
        resourceType: 'drive_env',
        resourceId: envId,
        details: { route: 'env-bridge', operation: 'sign_grant', op, reason, sessionId: principal.sessionId, conversationId: principal.conversationId },
        riskScore: 0.4,
      }),
    getSocketFacts: (ws) => {
      const metadata = getEnvConnectionMetadata(ws);
      return metadata ? { envId: metadata.envId, machinePublicKey: metadata.machinePublicKey, serverKeyId: metadata.serverKeyId } : undefined;
    },
    keyring: loadKeyring,
    now: () => Date.now(),
    ids: { grantId: () => `grant_${crypto.randomUUID()}`, nonce: () => crypto.randomUUID() },
  });
  onEnvConnectionLost((envId) => {
    client.cancelEnv(envId);
  });
  singleton = client;
  return client;
}
