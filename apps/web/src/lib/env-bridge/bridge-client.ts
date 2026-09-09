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
import { grantRequestForFrame, type GrantFrame, type GrantRequest, type UnsignedGrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import { canonicalizeArgs } from '@pagespace/lib/env-bridge/grant';
import { decideSign, type SignDenyReason } from '@pagespace/lib/env-bridge/decide-sign';
import { parseServerPolicy } from '@pagespace/lib/env-bridge/policy-types';
import { approvalRevokeBindingId, machineResultBindingId, pauseBindingId, type MachineResultFrame, type PauseFrame, type RevokeFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import type { ServerSigningKeyring } from '@pagespace/lib/env-bridge/server-signing-key';
import { logger } from '@pagespace/lib/logging/logger-config';
import { loadServerSigningKeyring } from '@pagespace/lib/auth/env-bridge-signing-key';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { audit } from '@pagespace/lib/audit/audit-log';
import { summarizeGrantRequest, toDriveEnvActivityDTO, type DriveEnvGrantAuditRecord, type GrantAuditStore } from '@pagespace/lib/services/drive-envs/grant-audit-store';
import { broadcastEnvActivity } from '@/lib/websocket/env-activity-events';
import { getAuthorizedEnvConnection, getEnvConnectionMetadata, onEnvConnectionLost } from '@/lib/websocket/ws-env-connections';
import { RequestCorrelator, CorrelationError, grantCorrelatorTimeoutMs, type CorrelationFailureKind } from './correlator';
import { signGrantFrame, type GrantIdSource } from './grant-signer';
import { envBridgeHash } from './crypto';
import { verifyResultFromMachine } from './result-verifier';
import { getPendingApprovalStore, type PendingApprovalStore } from './pending-approvals';

/** The reason prefix a daemon answers with while a request waits for its owner's click. */
export const ASK_PENDING_PREFIX = 'ask_pending:';

/**
 * `audit_unavailable` (GA wave 3): the server-side audit row could not be
 * written at sign time, so the grant was NOT sent. Audit is one of the two
 * layers standing in for a sandbox on this surface ([D-1]); a grant that ran
 * with no server record would be exactly the silent degradation invariant 12
 * forbids, so the row comes first and its failure is the request's failure.
 */
export type EnvBridgeFailureKind = CorrelationFailureKind | 'not_connected' | 'signing_key_unavailable' | 'ttl_too_long' | 'server_denied' | 'audit_unavailable' | 'paused';

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

/**
 * The facts of the `drive_env_local` sibling this client needs: what
 * `decideSign` consults (`revokedAt`, `serverPolicy` — UNPARSED jsonb, parsed
 * strictly here) and who to tell (`ownerId` — the audit's activity hook fires
 * under the machine OWNER's id, never the principal's; [D-6]).
 */
export type SigningSibling = { readonly ownerId: string; readonly revokedAt: Date | null; readonly pausedAt: Date | null; readonly serverPolicy: unknown };

/** The server-side audit writes (GA wave 3). The production store; a fake in tests. */
export type GrantAuditWriter = Pick<GrantAuditStore, 'recordSign' | 'recordRefusal' | 'recordResult'>;

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
  /**
   * The server side of the audit (GA wave 3, invariant 10): a row per grant,
   * keyed by `grantId` so it joins the daemon's JSONL. REQUIRED, not optional
   * — a client with no audit would be a silent degradation. The sign-time
   * write runs BEFORE the frame goes out and its failure fails the request
   * (`audit_unavailable`); the result-time write cannot un-run anything and
   * is logged on failure.
   */
  readonly grantAudit: GrantAuditWriter;
  /** Every audit row, as written, under the machine OWNER's id — the live activity panel's feed (GA wave 3, leaf 2). */
  readonly onActivity?: (row: DriveEnvGrantAuditRecord, ownerId: string) => void;
}

export type MachineResultDisposition = 'delivered' | 'unverified' | 'dropped_unknown_grant' | 'dropped_unregistered_socket' | 'dropped_wrong_env';

/** Built on first use, never at import (see ws-env-connections.ts for why). */
let clientLogger: ReturnType<typeof logger.child> | null = null;
function log(): ReturnType<typeof logger.child> {
  clientLogger ??= logger.child({ component: 'env-bridge-client' });
  return clientLogger;
}

/** The audit verdict for a VERIFIED machine answer — the closed vocabulary the table docblock names. */
export function resultVerdict(result: MachineResultFrame): { verdict: string; exitCode: number | null } {
  switch (result.type) {
    case 'exec_result':
      return { verdict: 'completed', exitCode: result.exitCode };
    case 'fs_read_result':
      return { verdict: 'completed', exitCode: null };
    case 'fs_write_result':
      return { verdict: result.ok ? 'completed' : 'completed:write_failed', exitCode: null };
    case 'grant_denied':
      return { verdict: result.reason.startsWith(ASK_PENDING_PREFIX) ? result.reason : `denied:${result.reason}`, exitCode: null };
    case 'approval_revoke_result':
    case 'pause_result':
      // Never an answer to a grant; correlated on their own binding ids. Named so the switch stays exhaustive.
      return { verdict: 'failed:unexpected_frame', exitCode: null };
  }
}

export class EnvBridgeClient {
  constructor(private readonly deps: EnvBridgeClientDeps) {}

  /** Per-env holds (GA wave 3, leaf 5): while one is set, `sendGrant` for that env waits for it — the reconnect replay of owed approval revokes runs BEFORE any grant is signed. */
  private readonly holds = new Map<string, Promise<void>>();

  /**
   * Run `work` while holding every grant for `envId`. The hold is released
   * whether `work` resolves or rejects; a grant that arrived during the hold
   * proceeds afterwards. Holds do not nest: a second call replaces the first
   * only after it settles.
   */
  async withHold(envId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.holds.get(envId) ?? Promise.resolve();
    const current = previous.then(work, work).catch((error: unknown) => {
      log().error('Held work for env failed; releasing the hold', { envId, error: error instanceof Error ? error.message : String(error), action: 'hold_failed' });
    });
    this.holds.set(envId, current);
    try {
      await current;
    } finally {
      if (this.holds.get(envId) === current) this.holds.delete(envId);
    }
  }

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
    // The request projection both sides hash (`grantArgsForFrame`): the op the
    // gate decides on, the argsHash the audit row carries even for a refusal
    // (so a refused request is still findable by the same key a signed one
    // would have had), and the one line a person reads.
    const request = grantRequestForFrame({ ...input.frame, grant: {}, sig: '' } as GrantFrame);
    const op = request.op;
    const argsHash = envBridgeHash(canonicalizeArgs(request.args));
    const summary = summarizeGrantRequest(request);
    const sibling = await this.deps.findLocalByEnvId(input.envId);
    const verdict = decideSign({
      op,
      // A missing sibling is a dead local env (the owner was erased): treated
      // as revoked, exactly as the bind gate treats it. A stored policy the
      // strict parser refuses is `null` and denies.
      envRevoked: sibling === null || sibling.revokedAt !== null,
      // Stop (GA wave 3): the owner's pause, read fresh per grant like the policy.
      paused: sibling !== null && sibling.pausedAt !== null,
      serverPolicy: sibling === null ? null : parseServerPolicy(sibling.serverPolicy),
      flagEnabled: this.deps.flagEnabled(),
    });
    if (!verdict.ok) {
      log().warn('Refused to sign a grant for a local environment', { envId: input.envId, op, reason: verdict.reason, userId: input.principal.userId, sessionId: input.principal.sessionId, action: 'sign_refused' });
      this.deps.onSignRefused?.({ envId: input.envId, op, reason: verdict.reason, principal: input.principal });
      // The refusal is audited as a row too (GA wave 3): no grant id, the typed
      // reason. A failed write here cannot change the answer — the grant is
      // refused either way — so it is logged, never thrown.
      await this.recordRefusal({ envId: input.envId, principal: input.principal, op, argsHash, summary, reason: verdict.reason, ownerId: sibling?.ownerId ?? null });
      throw new EnvBridgeError('server_denied', `PageSpace refused to sign a ${op} grant for ${input.envId}: ${verdict.reason}`, { envId: input.envId, op, reason: verdict.reason });
    }

    // A revoke owed to the machine is replayed on its hello (leaf 5); nothing is signed for the env until that has run.
    const hold = this.holds.get(input.envId);
    if (hold !== undefined) await hold;

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

    // THE ROW BEFORE THE FRAME (GA wave 3, invariant 10): the server's record
    // of this grant exists before the machine can act on it. If the record
    // cannot be written the grant is not sent — `sibling` is non-null here
    // (a null one was refused as revoked above).
    try {
      const row = await this.deps.grantAudit.recordSign({
        envId: input.envId,
        grantId: signed.grant.grantId,
        principal: signed.grant.principal,
        op: signed.grant.op,
        argsHash: signed.grant.argsHash,
        summary,
        approval: input.approvalIntent === undefined ? undefined : { challengeId: input.approvalIntent.challengeId, scope: input.approvalIntent.scope },
        now: new Date(this.deps.now()),
      });
      this.notifyActivity(row, sibling!.ownerId);
    } catch (error) {
      log().error('Grant audit row could not be written; grant NOT sent', { envId: input.envId, grantId: signed.grant.grantId, op: signed.grant.op, error: error instanceof Error ? error.message : String(error), action: 'audit_unavailable' });
      throw new EnvBridgeError('audit_unavailable', `PageSpace could not record a ${op} grant for ${input.envId}, so it was not sent`, { envId: input.envId, op, grantId: signed.grant.grantId });
    }

    const timeoutMs = grantCorrelatorTimeoutMs(signed.frame);
    log().info('Sending grant to local environment', { envId: input.envId, grantId: signed.grant.grantId, op: signed.grant.op, keyId: signed.keyId, timeoutMs, action: 'send_grant' });
    const ownerId = sibling!.ownerId;
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
      this.recordResult(signed.grant.grantId, resultVerdict(result), ownerId);
      return result;
    } catch (error) {
      if (error instanceof CorrelationError) {
        this.recordResult(signed.grant.grantId, { verdict: `failed:${error.kind}`, exitCode: null }, ownerId);
        throw new EnvBridgeError(error.kind, error.message, { ...error.detail, envId: input.envId });
      }
      // `cancelEnv` (socket lost, Stop) and `handleMachineResult` (unverified) reject with the bridge's own typed error.
      if (error instanceof EnvBridgeError) this.recordResult(signed.grant.grantId, { verdict: `failed:${error.kind}`, exitCode: null }, ownerId);
      throw error;
    }
  }

  private notifyActivity(row: DriveEnvGrantAuditRecord, ownerId: string): void {
    try {
      this.deps.onActivity?.(row, ownerId);
    } catch (error) {
      log().warn('Activity listener threw', { envId: row.envId, grantId: row.grantId, error: error instanceof Error ? error.message : String(error), action: 'activity_listener_error' });
    }
  }

  /** A refusal's row. Never throws: the refusal is the answer whatever the audit does. */
  private async recordRefusal(input: { envId: string; principal: GrantPrincipal; op: GrantRequest['op']; argsHash: string; summary: string; reason: SignDenyReason; ownerId: string | null }): Promise<void> {
    try {
      const row = await this.deps.grantAudit.recordRefusal({ envId: input.envId, principal: input.principal, op: input.op, argsHash: input.argsHash, summary: input.summary, reason: input.reason, now: new Date(this.deps.now()) });
      if (input.ownerId !== null) this.notifyActivity(row, input.ownerId);
    } catch (error) {
      log().error('Grant refusal audit row could not be written', { envId: input.envId, op: input.op, reason: input.reason, error: error instanceof Error ? error.message : String(error), action: 'audit_refusal_write_failed' });
    }
  }

  /**
   * The result-time update. Fire-and-forget by design: the machine has
   * already acted (or the wait has already ended), so nothing here can be
   * withheld — a failed write is logged, and the row stays `signed` with
   * `resultAt` NULL, which the panel shows as still running.
   */
  private recordResult(grantId: string, answer: { verdict: string; exitCode: number | null }, ownerId: string): void {
    void this.deps.grantAudit
      .recordResult({ grantId, verdict: answer.verdict, exitCode: answer.exitCode, now: new Date(this.deps.now()) })
      .then((row) => {
        if (row) this.notifyActivity(row, ownerId);
      })
      .catch((error: unknown) => {
        log().error('Grant audit result could not be written', { grantId, verdict: answer.verdict, error: error instanceof Error ? error.message : String(error), action: 'audit_result_write_failed' });
      });
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
    // The grant a result answers — or, for an approval-revoke ack, the namespaced approval id.
    const grantId = machineResultBindingId(frame);
    const facts = this.deps.getSocketFacts(ws);
    if (!facts) {
      log().warn('Result frame from an unregistered socket dropped', { grantId, frameType: frame.type, action: 'result_dropped' });
      return 'dropped_unregistered_socket';
    }
    const owner = this.deps.correlator.groupOf(grantId);
    if (owner === undefined) {
      log().warn('Result frame for an unknown grant dropped', { envId: facts.envId, grantId, frameType: frame.type, action: 'result_dropped' });
      return 'dropped_unknown_grant';
    }
    if (owner !== facts.envId) {
      log().error('Result frame from an env that does not own the grant refused — request stays pending for its owner', { envId: facts.envId, ownerEnvId: owner, grantId, frameType: frame.type, action: 'result_wrong_env' });
      this.deps.onUnverified?.({ envId: facts.envId, grantId, frameType: frame.type, reason: 'wrong_env' });
      return 'dropped_wrong_env';
    }
    const verified = verifyResultFromMachine({ frame, machinePublicKey: facts.machinePublicKey });
    if (!verified.ok) {
      log().error('Result frame failed machine-signature verification — NOT delivered', { envId: facts.envId, grantId, frameType: frame.type, reason: verified.reason, action: 'result_unverified' });
      this.deps.onUnverified?.({ envId: facts.envId, grantId, frameType: frame.type, reason: verified.reason });
      // A forged ACK is ignored, not fatal: the revoke (or pause) stays pending for the genuine ack until its deadline (Codex P2 on #2583).
      if (frame.type !== 'approval_revoke_result' && frame.type !== 'pause_result') {
        this.deps.correlator.reject(grantId, new EnvBridgeError('unverified_result', `Result for grant ${grantId} failed machine-signature verification (${verified.reason})`, { envId: facts.envId, grantId, reason: verified.reason }));
      }
      return 'unverified';
    }
    this.deps.correlator.resolve(grantId, frame);
    return 'delivered';
  }

  /**
   * Send a signed approval revoke over `ws` and await the machine's SIGNED ack
   * (`approval_revoke_result`, correlated on the namespaced approval id) with
   * a bounded deadline. Resolves with the verified ack; rejects with a typed
   * `timeout` / `disconnected` when no genuine ack arrives — the caller must
   * report that as unacknowledged, never as a revoke it cannot prove.
   */
  async awaitApprovalRevokeAck(input: { envId: string; approvalId: string; ws: WebSocket; frame: RevokeFrame; timeoutMs: number }): Promise<Extract<MachineResultFrame, { type: 'approval_revoke_result' }>> {
    let reply: MachineResultFrame;
    try {
      reply = await this.deps.correlator.open({
        id: approvalRevokeBindingId(input.approvalId),
        group: input.envId,
        timeoutMs: input.timeoutMs,
        send: () => input.ws.send(encodeFrame(input.frame)),
      });
    } catch (error) {
      if (error instanceof CorrelationError) throw new EnvBridgeError(error.kind, error.message, { ...error.detail, envId: input.envId, approvalId: input.approvalId });
      throw error;
    }
    if (reply.type !== 'approval_revoke_result') throw new EnvBridgeError('unverified_result', `Expected an approval_revoke_result for ${input.approvalId}, got ${reply.type}`, { envId: input.envId, approvalId: input.approvalId });
    return reply;
  }

  /**
   * STOP reaches the machine (GA wave 3): send the signed `pause` over `ws`
   * and await the machine's SIGNED `pause_result`, correlated on
   * `pause:<envId>:<pausedAt>`, with a bounded deadline. Resolves with the
   * verified ack; rejects typed `timeout` / `disconnected` when no genuine
   * ack arrives — the caller reports that as unacknowledged, never as a stop
   * it cannot prove.
   */
  async awaitPauseAck(input: { envId: string; pausedAt: number; ws: WebSocket; frame: PauseFrame; timeoutMs: number }): Promise<Extract<MachineResultFrame, { type: 'pause_result' }>> {
    let reply: MachineResultFrame;
    try {
      reply = await this.deps.correlator.open({
        id: pauseBindingId(input.envId, input.pausedAt),
        group: input.envId,
        timeoutMs: input.timeoutMs,
        send: () => input.ws.send(encodeFrame(input.frame)),
      });
    } catch (error) {
      if (error instanceof CorrelationError) throw new EnvBridgeError(error.kind, error.message, { ...error.detail, envId: input.envId, pausedAt: input.pausedAt });
      throw error;
    }
    if (reply.type !== 'pause_result') throw new EnvBridgeError('unverified_result', `Expected a pause_result for ${input.envId}, got ${reply.type}`, { envId: input.envId, pausedAt: input.pausedAt });
    return reply;
  }

  /** The env's live socket is gone: fail its in-flight requests with a typed `disconnected`. */
  cancelEnv(envId: string, reason = 'bridge connection lost'): number {
    return this.deps.correlator.cancelGroup(envId, new EnvBridgeError('disconnected', `Environment ${envId}: ${reason}`, { envId }));
  }

  /**
   * STOP (GA wave 3): the owner paused the env. New grants are already
   * refused at `decideSign`; this fails the requests IN FLIGHT on this
   * replica with a typed `paused` — never left to time out — and their audit
   * rows record `failed:paused`. The socket is untouched: Stop pauses grants,
   * it does not disconnect the machine. @returns how many requests it ended.
   */
  pauseEnv(envId: string): number {
    return this.deps.correlator.cancelGroup(envId, new EnvBridgeError('paused', `Environment ${envId}: stopped by its owner`, { envId }));
  }

  pendingCountForEnv(envId: string): number {
    return this.deps.correlator.pendingCountForGroup(envId);
  }
}

let singleton: EnvBridgeClient | null = null;
let keyring: ServerSigningKeyring | null = null;

/** The audit store through the runtime seam (lazily, like the env store above: a static import here would be a cycle). */
async function loadGrantAuditStore(): Promise<GrantAuditStore> {
  const { getGrantAuditStore } = await import('@/lib/drive-envs/drive-envs-runtime');
  return getGrantAuditStore();
}

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
    grantAudit: {
      recordSign: async (input) => (await loadGrantAuditStore()).recordSign(input),
      recordRefusal: async (input) => (await loadGrantAuditStore()).recordRefusal(input),
      recordResult: async (input) => (await loadGrantAuditStore()).recordResult(input),
    },
    // Live activity (leaf 2): every row, to the machine OWNER's own room only.
    onActivity: (row, ownerId) => broadcastEnvActivity({ ownerId, activity: toDriveEnvActivityDTO(row) }),
  });
  onEnvConnectionLost((envId) => {
    client.cancelEnv(envId);
  });
  singleton = client;
  return client;
}
