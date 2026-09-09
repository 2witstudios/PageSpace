/**
 * The daemon's per-frame pipeline — thin I/O around the pure core, in the
 * order the epic fixes (invariants 3, 4, 5, 6, 7, 10):
 *
 *   grant frame → `verifyGrant` (server key pinned at enrollment; nonce;
 *   bound to THIS frame's args) → restart boundary (Codex C6) →
 *   `decideExecution` (machine policy ∩ advertised capabilities) → [`ask`
 *   the owner, then `decideExecution` again with the held Grant and a
 *   `localApproval` over the frozen request] → runner ONLY on `allow` →
 *   signed reply → audit.
 *
 * Nothing here decides anything: every verdict is imported from
 * `@pagespace/lib/env-bridge/*` (a grep test pins that). This module maps
 * verdicts to wire frames and audit lines, and calls the runners.
 *
 * The frames this receives have already been decoded (`decodeFrame`) and
 * dispatched by the session reducer (`reduceBridgeSession`) in `ws-client.ts`;
 * a frame that reaches `handle` was accepted by both. PTY frames are dropped
 * in M1, and `grant_pty_open` is denied `unsupported` BEFORE verification —
 * nothing this daemon cannot do should cost a nonce or a signature check.
 *
 * SERVER POLICY. `decideExecution` intersects three inputs; the drive's
 * `serverPolicy` is enforced by the server before it signs a grant, and no
 * frame carries it to the machine. The daemon therefore supplies a
 * permissive stand-in for that one input and enforces the two it owns —
 * the machine policy and the advertised capabilities. A grant the server
 * should not have signed is still refused here by the owner's policy.
 */
import { GRANT_OPS, verifyGrant as libVerifyGrant, type Ed25519Verify, type Grant, type GrantVerdict, type HashBytes, type VerifyGrantInput } from './lib-core.js';
import { executionRequestForFrame, GRANT_FRAME_TYPES, grantRequestForFrame, type GrantFrame } from './lib-core.js';
import { decideExecution as libDecideExecution, type DecideExecutionInput, type ExecutionVerdict, type NormalizedRequest } from './lib-core.js';
import type { AdvertisedCapabilities, MachinePolicy, ServerPolicy } from './lib-core.js';
import type { PathProbe } from './lib-core.js';
import { verifyRevoke } from './lib-core.js';
import { execOutputCeiling, fsReadContentCeiling, type Frame, type FrameLimits } from './lib-core.js';
import type { SignWithMachineKey } from './keypair.js';
import { grantPredatesDaemon, PREDATES_DAEMON_REASON, type DaemonNonceStore } from './nonce-store.js';
import { signResultFrame, type UnsignedMachineResultFrame } from './result-signer.js';
import type { AuditLog } from './audit-log.js';
import type { ExecRunner } from './exec-runner.js';
import type { FsRunner } from './fs-runner.js';
import type { AskPrompter } from './ask.js';

/** What this daemon can do in M1: shell and files. PTY is M2; checkpoints are never assumed (invariant 12). */
export const DAEMON_CAPABILITIES: AdvertisedCapabilities = { shell: true, pty: false, fs: true, checkpoint: false };

/** See "SERVER POLICY" above. */
const DAEMON_SERVER_POLICY: ServerPolicy = { ops: [...GRANT_OPS], checkpoint: false };

export interface DecisionGates {
  readonly verifyGrant: (input: VerifyGrantInput) => GrantVerdict;
  readonly decideExecution: (input: DecideExecutionInput) => ExecutionVerdict;
}

export interface DispatcherDeps {
  readonly envId: string;
  readonly enrollmentId: string;
  /** The server key id this enrollment pinned; a revoke must be signed by that key. */
  readonly serverKeyId: string;
  /** SPKI DER, decoded from the machine credential. */
  readonly serverPublicKey: Uint8Array;
  /** Base64 PKCS#8 DER from the credential store. */
  readonly privateKey: string;
  readonly sign: SignWithMachineKey;
  readonly verify: Ed25519Verify;
  readonly hash: HashBytes;
  readonly now: () => number;
  readonly startedAt: number;
  readonly nonces: DaemonNonceStore;
  readonly policy: () => MachinePolicy | null;
  readonly probe: PathProbe;
  readonly execRunner: ExecRunner;
  readonly fsRunner: FsRunner;
  readonly audit: AuditLog;
  /** `null` when the daemon cannot prompt (headless); an `ask` verdict is then a deny. */
  readonly ask: AskPrompter | null;
  readonly log: (line: string) => void;
  /** The socket frame limit; bounds what an fs_read may return. */
  readonly limits: FrameLimits;
  /** The pure-core gates; overridable ONLY so a test can count calls. */
  readonly gates?: DecisionGates;
}

export type DispatchResult = { readonly kind: 'reply'; readonly frame: Frame } | { readonly kind: 'revoke_verified' } | { readonly kind: 'dropped'; readonly reason: string };

export interface Dispatcher {
  handle(frame: Frame): Promise<DispatchResult>;
}

const isGrantFrame = (frame: Frame): frame is GrantFrame => (GRANT_FRAME_TYPES as readonly string[]).includes(frame.type);

/** The grantId to answer with when the grant itself could not be trusted; never empty (the codec requires one). */
function grantIdOf(frame: GrantFrame): string {
  const id = (frame.grant as { grantId?: unknown }).grantId;
  return typeof id === 'string' && id.length > 0 ? id : 'unknown';
}

/** Deep-freeze the request the owner is shown so it is byte-identical when it comes back as the approval. */
function freezeRequest(request: NormalizedRequest): NormalizedRequest {
  Object.freeze(request.env);
  Object.freeze(request.paths);
  if (request.args !== undefined) Object.freeze(request.args);
  return Object.freeze(request);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const gates: DecisionGates = deps.gates ?? { verifyGrant: libVerifyGrant, decideExecution: libDecideExecution };
  const signer = { privateKey: deps.privateKey, sign: deps.sign, hash: deps.hash };

  const reply = (unsigned: UnsignedMachineResultFrame): DispatchResult => ({ kind: 'reply', frame: signResultFrame(unsigned, signer) });

  const denied = async (grantId: string, reason: string, audit: { grant: Grant | null; op: string; verdict?: string }): Promise<DispatchResult> => {
    await deps.audit.record({ grantId, principal: audit.grant?.principal ?? null, op: audit.op, verdict: audit.verdict ?? `deny:${reason}`, argsHash: audit.grant?.argsHash ?? null, exitCode: null });
    return reply({ type: 'grant_denied', grantId, reason });
  };

  const handleGrant = async (frame: GrantFrame): Promise<DispatchResult> => {
    const request = grantRequestForFrame(frame);
    if (frame.type === 'grant_pty_open') return denied(grantIdOf(frame), 'unsupported', { grant: null, op: request.op });

    // Evict spent nonces first (synchronous, so has+add below stay atomic): the store is bounded by one TTL.
    deps.nonces.evictExpired(deps.now());
    const verdict = gates.verifyGrant({
      grant: frame.grant,
      signature: frame.sig,
      serverPublicKey: deps.serverPublicKey,
      now: deps.now(),
      nonces: deps.nonces,
      expectedEnvId: deps.envId,
      request,
      verify: deps.verify,
      hash: deps.hash,
    });
    if (!verdict.ok) return denied(grantIdOf(frame), verdict.reason, { grant: null, op: request.op });
    const grant = verdict.grant;
    if (grantPredatesDaemon(grant.iat, deps.startedAt)) return denied(grant.grantId, PREDATES_DAEMON_REASON, { grant, op: grant.op });

    const decideInput: DecideExecutionInput = {
      grant,
      request: executionRequestForFrame(frame),
      machinePolicy: deps.policy(),
      serverPolicy: DAEMON_SERVER_POLICY,
      capabilities: DAEMON_CAPABILITIES,
      probe: deps.probe,
    };
    let decision = gates.decideExecution(decideInput);
    const roots = decideInput.machinePolicy?.roots ?? [];

    if (decision.kind === 'ask') {
      if (deps.ask === null) return denied(grant.grantId, 'ask_unavailable', { grant, op: grant.op });
      // The verified Grant is HELD across the prompt; the wire grant is never
      // re-verified (its nonce is spent). The request the owner sees is frozen
      // and handed back unchanged as the approval.
      const shown = freezeRequest(decision.request);
      const approved = await deps.ask.ask({ grantId: grant.grantId, principal: grant.principal, op: grant.op, request: shown });
      if (!approved) return denied(grant.grantId, 'declined', { grant, op: grant.op, verdict: 'ask:declined' });
      decision = gates.decideExecution({ ...decideInput, localApproval: { grantId: grant.grantId, approvedAt: deps.now(), request: shown } });
    }
    if (decision.kind === 'deny') return denied(grant.grantId, decision.reason, { grant, op: grant.op });
    if (decision.kind !== 'allow') return denied(grant.grantId, 'ask_unresolved', { grant, op: grant.op });

    // Allow: the normalized request is the ONLY thing the runners ever see.
    const normalized = decision.request;
    try {
      switch (normalized.op) {
        case 'exec': {
          // Clamp the captured-output cap so the signed exec_result always
          // decodes under the frame limit, however high the policy maxBytes.
          const ceiling = execOutputCeiling(deps.limits);
          const bounded = normalized.maxBytes > ceiling ? { ...normalized, maxBytes: ceiling, clamped: true } : normalized;
          const outcome = await deps.execRunner.run(bounded);
          await deps.audit.record({ grantId: grant.grantId, principal: grant.principal, op: grant.op, verdict: 'allow', argsHash: grant.argsHash, exitCode: outcome.exitCode });
          return reply({ type: 'exec_result', grantId: grant.grantId, exitCode: outcome.exitCode, stdoutB64: outcome.stdout.toString('base64'), stderrB64: outcome.stderr.toString('base64'), truncated: outcome.truncated });
        }
        case 'fs_read': {
          const outcome = await deps.fsRunner.read(normalized, { roots, maxContentBytes: fsReadContentCeiling(deps.limits) });
          if (outcome.kind === 'unsupported') return denied(grant.grantId, `unsupported_${outcome.reason}`, { grant, op: grant.op });
          if (outcome.kind === 'too_large') return denied(grant.grantId, 'too_large', { grant, op: grant.op, verdict: `deny:too_large:${outcome.size}>${outcome.maxContentBytes}` });
          if (outcome.kind === 'error') return denied(grant.grantId, 'fs_error', { grant, op: grant.op, verdict: `deny:fs_error:${outcome.error}` });
          await deps.audit.record({ grantId: grant.grantId, principal: grant.principal, op: grant.op, verdict: 'allow', argsHash: grant.argsHash, exitCode: null });
          return reply({ type: 'fs_read_result', grantId: grant.grantId, found: outcome.found, ...(outcome.contentB64 !== undefined && { contentB64: outcome.contentB64 }) });
        }
        case 'fs_write': {
          const files = frame.type === 'grant_fs_write' ? frame.files.map((file) => ({ contentB64: file.contentB64, mode: file.mode ?? null })) : [];
          const outcome = await deps.fsRunner.write(normalized, files, { roots });
          await deps.audit.record({ grantId: grant.grantId, principal: grant.principal, op: grant.op, verdict: outcome.ok ? 'allow' : `allow:write_failed:${outcome.error ?? ''}`, argsHash: grant.argsHash, exitCode: null });
          return reply({ type: 'fs_write_result', grantId: grant.grantId, ok: outcome.ok, ...(outcome.error !== undefined && { error: outcome.error }) });
        }
        case 'pty_open':
          return denied(grant.grantId, 'unsupported', { grant, op: grant.op });
      }
    } catch (error) {
      deps.log(`runner refused grant ${grant.grantId}: ${messageOf(error)}`);
      return denied(grant.grantId, 'runner_refused', { grant, op: grant.op, verdict: `deny:runner_refused:${messageOf(error)}` });
    }
  };

  const handleRevoke = async (frame: Extract<Frame, { type: 'revoke' }>): Promise<DispatchResult> => {
    const verdict = verifyRevoke({ frame, envId: deps.envId, enrollmentId: deps.enrollmentId, keyId: deps.serverKeyId, issuedAt: frame.issuedAt, serverPublicKey: deps.serverPublicKey, verify: deps.verify });
    if (!verdict.ok) {
      await deps.audit.record({ grantId: null, principal: null, op: 'revoke', verdict: 'dropped:revoke_bad_signature', argsHash: null, exitCode: null });
      return { kind: 'dropped', reason: 'revoke_bad_signature' };
    }
    await deps.audit.record({ grantId: null, principal: null, op: 'revoke', verdict: 'revoked', argsHash: null, exitCode: null });
    return { kind: 'revoke_verified' };
  };

  return {
    async handle(frame) {
      if (frame.type === 'ping') return { kind: 'reply', frame: { type: 'pong', ts: deps.now() } };
      if (frame.type === 'revoke') return handleRevoke(frame);
      if (isGrantFrame(frame)) return handleGrant(frame);
      await deps.audit.record({ grantId: null, principal: null, op: frame.type, verdict: 'dropped:unsupported_frame', argsHash: null, exitCode: null });
      return { kind: 'dropped', reason: 'unsupported_frame' };
    },
  };
}
