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
import type { GrantPrincipal } from '@pagespace/lib/env-bridge/grant';
import type { MachineResultFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import type { ServerSigningKeyring } from '@pagespace/lib/env-bridge/server-signing-key';
import { logger } from '@pagespace/lib/logging/logger-config';
import { loadServerSigningKeyring } from '@pagespace/lib/auth/env-bridge-signing-key';
import { getAuthorizedEnvConnection, getEnvConnectionMetadata, onEnvConnectionLost } from '@/lib/websocket/ws-env-connections';
import { RequestCorrelator, CorrelationError, grantCorrelatorTimeoutMs, type CorrelationFailureKind } from './correlator';
import { signGrantFrame, type GrantIdSource, type UnsignedGrantFrame } from './grant-signer';
import { verifyResultFromMachine } from './result-verifier';

export type EnvBridgeFailureKind = CorrelationFailureKind | 'not_connected' | 'signing_key_unavailable' | 'ttl_too_long';

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

export interface EnvBridgeClientDeps {
  readonly correlator: RequestCorrelator<MachineResultFrame>;
  /** The env's socket IFF authorized and open — `getAuthorizedEnvConnection`. */
  readonly getAuthorizedConnection: (envId: string) => WebSocket | undefined;
  readonly getSocketFacts: (ws: WebSocket) => EnvSocketFacts | undefined;
  /** Lazy: loading the ring throws when no key is configured, and a Sprite-only deployment must never trip on it. */
  readonly keyring: () => Pick<ServerSigningKeyring, 'get'>;
  readonly now: () => number;
  readonly ids: GrantIdSource;
  /** Observability hook for a result that failed verification (audit/log). */
  readonly onUnverified?: (info: { envId: string; grantId: string; frameType: MachineResultFrame['type']; reason: string }) => void;
}

export type MachineResultDisposition = 'delivered' | 'unverified' | 'dropped_unknown_grant' | 'dropped_unregistered_socket';

export class EnvBridgeClient {
  private readonly log = logger.child({ component: 'env-bridge-client' });

  constructor(private readonly deps: EnvBridgeClientDeps) {}

  /**
   * Send one granted request to the env and await its VERIFIED result.
   * Rejects with a typed `EnvBridgeError` on every failure path.
   */
  async sendGrant(input: { envId: string; frame: UnsignedGrantFrame; principal: GrantPrincipal }): Promise<MachineResultFrame> {
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
    });
    if (!signed.ok) throw new EnvBridgeError(signed.reason, `Cannot sign grant for ${input.envId}: ${signed.reason}`, { envId: input.envId, serverKeyId: facts.serverKeyId });

    const timeoutMs = grantCorrelatorTimeoutMs(signed.frame);
    this.log.info('Sending grant to local environment', { envId: input.envId, grantId: signed.grant.grantId, op: signed.grant.op, keyId: signed.keyId, timeoutMs, action: 'send_grant' });
    try {
      return await this.deps.correlator.open({
        id: signed.grant.grantId,
        group: input.envId,
        timeoutMs,
        send: () => ws.send(encodeFrame(signed.frame)),
      });
    } catch (error) {
      if (error instanceof CorrelationError) throw new EnvBridgeError(error.kind, error.message, { ...error.detail, envId: input.envId });
      throw error;
    }
  }

  /**
   * A result frame arrived on `ws`. Cheap checks first (is the socket ours, is
   * the grant pending), THEN the signature, and only a verified result is
   * delivered. An unverified result fails the pending request with
   * `unverified_result` — the agent never sees its contents.
   */
  handleMachineResult(ws: WebSocket, frame: MachineResultFrame): MachineResultDisposition {
    const facts = this.deps.getSocketFacts(ws);
    if (!facts) {
      this.log.warn('Result frame from an unregistered socket dropped', { grantId: frame.grantId, frameType: frame.type, action: 'result_dropped' });
      return 'dropped_unregistered_socket';
    }
    if (!this.deps.correlator.has(frame.grantId)) {
      this.log.warn('Result frame for an unknown grant dropped', { envId: facts.envId, grantId: frame.grantId, frameType: frame.type, action: 'result_dropped' });
      return 'dropped_unknown_grant';
    }
    const verified = verifyResultFromMachine({ frame, machinePublicKey: facts.machinePublicKey });
    if (!verified.ok) {
      this.log.error('Result frame failed machine-signature verification — NOT delivered', { envId: facts.envId, grantId: frame.grantId, frameType: frame.type, reason: verified.reason, action: 'result_unverified' });
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
      onDropped: (id) => logger.child({ component: 'env-bridge-client' }).warn('Reply for a grant that is not pending dropped', { grantId: id, action: 'reply_dropped' }),
    }),
    getAuthorizedConnection: getAuthorizedEnvConnection,
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
