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
 * SERVER POLICY. `decideExecution` intersects three inputs: the advertised
 * capabilities, the server's allow-set and the machine policy. The server's
 * say is NOT carried on the wire — it is carried by the signature over `op`.
 * PageSpace consults `drive_env_local.serverPolicy` at the one place a
 * capability is minted (`decideSign`, run by the bridge client before
 * `signGrantFrame`) and refuses to sign any op the policy excludes; a grant
 * that reaches this daemon with a valid signature is therefore, by
 * construction, an op the server allowed at the moment it signed, and
 * `verifyGrant` (run first, below) binds that `op` to this very frame. So
 * the server-policy input to `decideExecution` is satisfied by the
 * signature, and the daemon feeds it a set covering every op: nothing here
 * re-decides what the server already decided, and the daemon still enforces
 * the two inputs it alone owns — the owner's policy file and what this
 * machine advertised. Every grant, including one the server should not have
 * signed, is still subject to the owner's policy.
 */
import { GRANT_OPS, verifyGrant as libVerifyGrant, type Ed25519Verify, type Grant, type GrantVerdict, type HashBytes, type VerifyGrantInput } from './lib-core.js';
import { executionRequestForFrame, GRANT_FRAME_TYPES, grantRequestForFrame, type GrantFrame } from './lib-core.js';
import { decideExecution as libDecideExecution, type DecideExecutionInput, type ExecutionVerdict, type NormalizedRequest } from './lib-core.js';
import type { AdvertisedCapabilities, MachinePolicy, ServerPolicy } from './lib-core.js';
import type { PathProbe } from './lib-core.js';
import { verifyPause, verifyRevoke } from './lib-core.js';
import { execOutputCeiling, fsReadContentCeiling, type Frame, type FrameLimits, type PendingApproval } from './lib-core.js';
import type { SignWithMachineKey } from './keypair.js';
import { grantPredatesDaemon, PREDATES_DAEMON_REASON, type DaemonNonceStore } from './nonce-store.js';
import { signResultFrame, type UnsignedMachineResultFrame } from './result-signer.js';
import type { AuditLog } from './audit-log.js';
import type { ExecRunner } from './exec-runner.js';
import type { FsRunner } from './fs-runner.js';
import type { AskPrompter } from './ask.js';
import type { ApprovalsStore } from './approvals-store.js';
import type { ChallengeStore } from './challenge-store.js';

/** What this daemon can do in M1: shell and files. PTY is M2; checkpoints are never assumed (invariant 12). */
export const DAEMON_CAPABILITIES: AdvertisedCapabilities = { shell: true, pty: false, fs: true, checkpoint: false };

/**
 * The server-policy input to `decideExecution`, satisfied by the signature
 * over `op` — see "SERVER POLICY" above. Every op is listed because the
 * server has already refused, at signing, every op it does not allow; this
 * is not a policy of the daemon's own and it widens nothing.
 */
const SERVER_POLICY_CARRIED_BY_SIGNATURE: ServerPolicy = { ops: [...GRANT_OPS], checkpoint: false };

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
  /**
   * Durable approvals (GA wave 2): consulted by `decideExecution` after
   * normalisation, written ONLY after an owner's approval of a byte-compared
   * request. Omitted = nothing is ever remembered.
   */
  readonly approvals?: ApprovalsStore;
  /** The PATH walk (`command-resolver.ts`) that turns an exec's argv0 into the subject an approval is keyed on. */
  readonly resolveArgv0?: (name: string) => string | null;
  /** Id source for approvals the TERMINAL prompt writes (a chat click's approval takes its challenge id). */
  readonly ids?: { approvalId(): string };
  /**
   * Pending chat approvals (GA wave 2, Tier B). With a store, an `ask`
   * verdict that has no terminal to go to (or when `preferChat`) freezes the
   * request under a challenge id and answers `ask_pending:<id>`; without one
   * it is `ask_unavailable`, as before.
   */
  readonly challenges?: ChallengeStore;
  /** Send asks to the chat even when a terminal prompter exists. */
  readonly preferChat?: boolean;
  readonly log: (line: string) => void;
  /** The socket frame limit; bounds what an fs_read may return. */
  readonly limits: FrameLimits;
  /** The pure-core gates; overridable ONLY so a test can count calls. */
  readonly gates?: DecisionGates;
}

export type DispatchResult =
  | { readonly kind: 'reply'; readonly frame: Frame }
  | { readonly kind: 'revoke_verified' }
  /** ONE durable approval was deleted on the server's signed request (GA wave 2); the enrollment and the key stand. `frame` is the machine-signed ack to send back. */
  | { readonly kind: 'approval_revoked'; readonly approvalId: string; readonly removed: number; readonly frame: Frame }
  /** A verified STOP (GA wave 3): every in-flight process group killed, every pending challenge dropped; still connected. `frame` is the machine-signed `pause_result`. */
  | { readonly kind: 'paused'; readonly pausedAt: number; readonly killed: number; readonly dropped: number; readonly frame: Frame }
  | { readonly kind: 'dropped'; readonly reason: string };

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
  if (request.writeModes !== undefined) Object.freeze(request.writeModes);
  if (request.args !== undefined) Object.freeze(request.args);
  return Object.freeze(request);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The frozen request as the frame codec carries it (fresh copies of the frozen arrays; every field, nothing else). */
function pendingRequestOnTheWire(request: NormalizedRequest): PendingApproval['request'] {
  return {
    op: request.op,
    ...(request.cmd !== undefined && { cmd: request.cmd }),
    ...(request.args !== undefined && { args: [...request.args] }),
    cwd: request.cwd,
    paths: [...request.paths],
    ...(request.writeModes !== undefined && { writeModes: [...request.writeModes] }),
    env: { ...request.env },
    timeoutMs: request.timeoutMs,
    maxBytes: request.maxBytes,
    clamped: request.clamped,
  };
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const gates: DecisionGates = deps.gates ?? { verifyGrant: libVerifyGrant, decideExecution: libDecideExecution };
  const signer = { privateKey: deps.privateKey, sign: deps.sign, hash: deps.hash };

  /**
   * THE PAUSED LATCH (Codex P1 #3, review round 1). `killAll` ends what is
   * running, but a handler parked on an await — the terminal prompt, the
   * approval write, the challenge lookup — resumes AFTER it and would spawn.
   * So a verified pause records its `pausedAt` here, BEFORE anything is
   * killed, and every grant path re-checks `predatesPause(grant)` after each
   * await and immediately before each runner call: a grant issued at or
   * before the latched pause is refused `paused`, audited.
   *
   * There is no resume frame and none is needed: the server signs only while
   * the env is not paused, so a VERIFIED grant whose `iat` is later than the
   * latched pause is itself the proof of resume — it proceeds, and grants
   * older than the pause stay refused for good (the latch is a high-water
   * mark, never rolled back).
   */
  let pausedAt: number | null = null;
  const predatesPause = (grant: Grant): boolean => pausedAt !== null && grant.iat <= pausedAt;

  const reply = (unsigned: UnsignedMachineResultFrame): DispatchResult => ({ kind: 'reply', frame: signResultFrame(unsigned, signer) });

  const denied = async (grantId: string, reason: string, audit: { grant: Grant | null; op: string; verdict?: string; paths?: readonly string[] | null }): Promise<DispatchResult> => {
    // A refusal names the file too (hardening A5): the paths as requested when
    // nothing was resolved, the confined ones once they have been.
    await deps.audit.record({ grantId, principal: audit.grant?.principal ?? null, op: audit.op, verdict: audit.verdict ?? `deny:${reason}`, argsHash: audit.grant?.argsHash ?? null, exitCode: null, paths: audit.paths ?? null });
    return reply({ type: 'grant_denied', grantId, reason });
  };

  const handleGrant = async (frame: GrantFrame): Promise<DispatchResult> => {
    const request = grantRequestForFrame(frame);
    const executionRequest = executionRequestForFrame(frame);
    /**
     * What every audit line for this frame says the request was ABOUT
     * (hardening A5). It starts as the paths the server NAMED, because a grant
     * refused at the signature, the policy or confinement never resolved
     * anything; once a decision has normalised them it is replaced by the
     * confined real paths, which is what a runner would touch.
     */
    let auditPaths: readonly string[] | null = executionRequest.paths ?? null;
    /** `denied`, with the paths this frame is about attached — every refusal in this function names the file (A5). */
    const refuse = (grantId: string, reason: string, audit: { grant: Grant | null; op: string; verdict?: string }): Promise<DispatchResult> => denied(grantId, reason, { ...audit, paths: auditPaths });
    if (frame.type === 'grant_pty_open') return refuse(grantIdOf(frame), 'unsupported', { grant: null, op: request.op });

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
    if (!verdict.ok) return refuse(grantIdOf(frame), verdict.reason, { grant: null, op: request.op });
    const grant = verdict.grant;
    if (grantPredatesDaemon(grant.iat, deps.startedAt)) return refuse(grant.grantId, PREDATES_DAEMON_REASON, { grant, op: grant.op });
    // The latch, first: a grant issued at or before a pause runs nothing here.
    if (predatesPause(grant)) return refuse(grant.grantId, 'paused', { grant, op: grant.op });

    /** The audit word for an allow: how it came about. */
    let allowVerdict = 'allow';
    const decideInput: DecideExecutionInput = {
      grant,
      request: executionRequest,
      machinePolicy: deps.policy(),
      serverPolicy: SERVER_POLICY_CARRIED_BY_SIGNATURE,
      capabilities: DAEMON_CAPABILITIES,
      probe: deps.probe,
      // Durable approvals are read from the machine's own file (and this
      // process's session set) — never from anything the server sent. Always
      // consulted (an absent store is an empty set) so an `ask` verdict
      // carries the subjects a click or a prompt would approve.
      approvals: { entries: deps.approvals?.entries() ?? [], now: deps.now(), resolveArgv0: deps.resolveArgv0 ?? (() => null) },
    };
    let decision = gates.decideExecution(decideInput);
    const roots = decideInput.machinePolicy?.roots ?? [];
    // From here the CONFINED paths are what any runner would touch, so they —
    // not the requested ones — are what the audit line names (A5).
    // Re-normalisation is deterministic for one frame, so every later branch
    // (the click's byte-compare, a fresh approval) resolves the same paths.
    if (decision.kind !== 'deny') auditPaths = decision.request.paths.length > 0 ? decision.request.paths : null;

    if (grant.approvalIntent !== undefined && decision.kind === 'ask') {
      // THE CLICK (Tier B, leaf 7). The server re-issued the request with the
      // owner's signed intent. The daemon honours it ONLY against a request it
      // froze itself: look the challenge up by id, re-normalise THIS request
      // (already done above — `decision.request`), and byte-compare the two
      // through the existing LocalApproval path. Only a match writes the
      // durable approval and runs. A server that "recorded" an approval, a
      // guessed id, or a click over different bytes all stop here as
      // approval_mismatch.
      const intent = grant.approvalIntent;
      const now = deps.now();
      const frozen = deps.challenges?.peek(intent.challengeId, now);
      // No such frozen request on THIS machine: the click matches nothing the
      // machine framed — including a challenge the server made up.
      if (frozen === undefined) return refuse(grant.grantId, 'approval_mismatch', { grant, op: grant.op, verdict: `deny:approval_mismatch:unknown_challenge:${intent.challengeId}` });
      if (intent.expiresAt < now || frozen.exp < now) return refuse(grant.grantId, 'approval_expired', { grant, op: grant.op });
      if (frozen.grant.principal.userId !== grant.principal.userId || frozen.grant.op !== grant.op) {
        return refuse(grant.grantId, 'approval_mismatch', { grant, op: grant.op, verdict: `deny:approval_mismatch:principal:${intent.challengeId}` });
      }
      const compared = gates.decideExecution({ ...decideInput, localApproval: { grantId: grant.grantId, approvedAt: now, request: frozen.request } });
      if (compared.kind !== 'allow') {
        const reason = compared.kind === 'deny' ? compared.reason : 'approval_mismatch';
        return refuse(grant.grantId, reason, { grant, op: grant.op, verdict: `deny:${reason}:${intent.challengeId}` });
      }
      // Matched: the challenge is spent, the approval remembered under ITS id
      // (what the server can later revoke), and the frozen request runs.
      deps.challenges?.take(intent.challengeId, now);
      if (frozen.subjects !== null && intent.scope !== 'once' && deps.approvals !== undefined) {
        await deps.approvals.remember({ approvalId: intent.challengeId, envId: deps.envId, userId: grant.principal.userId, op: grant.op, subjects: frozen.subjects, scope: intent.scope });
      }
      // Re-checked after the await: a pause that landed meanwhile wins.
      if (predatesPause(grant)) return refuse(grant.grantId, 'paused', { grant, op: grant.op });
      decision = { kind: 'allow', request: compared.request, basis: { kind: 'fresh_approval' } };
      allowVerdict = `allow:click:${intent.challengeId}:${intent.scope}`;
    }

    if (decision.kind === 'ask') {
      // The verified Grant is HELD across the prompt; the wire grant is never
      // re-verified (its nonce is spent). The request the owner sees is frozen
      // and handed back unchanged as the approval.
      const shown = freezeRequest(decision.request);
      const subjects = decision.subjects;
      const sensitive = decision.reason === 'sensitive_write' ? decision.sensitive : [];
      /**
       * What the owner's card and the terminal prompt say about each file of a
       * WRITE (hardening A7): the CONFINED path that would be written, the mode
       * it would be given, how many bytes, and the machine's own reason from
       * the classifier's closed set — `null` for an ordinary file in a mixed
       * request, so every path is shown and the sensitive ones stand out. The
       * content itself never leaves the machine.
       */
      const files = frame.type === 'grant_fs_write'
        ? frame.files.map((file, index) => {
            const path = shown.paths[index] ?? file.path;
            return { path, mode: file.mode ?? null, bytes: Buffer.from(file.contentB64, 'base64').length, reason: sensitive.find((found) => found.path === path)?.reason ?? null };
          })
        : undefined;
      if (deps.ask === null || deps.preferChat === true) {
        // Tier B: no terminal (or the chat is preferred) — freeze the request
        // under a challenge and let the owner's click in the chat answer it.
        if (deps.challenges === undefined) return refuse(grant.grantId, 'ask_unavailable', { grant, op: grant.op });
        const pending = deps.challenges.issue({ grant, request: shown, subjects }, deps.now());
        if (pending === null) return refuse(grant.grantId, 'ask_unavailable', { grant, op: grant.op, verdict: 'deny:ask_unavailable:challenges_full' });
        await deps.audit.record({ grantId: grant.grantId, principal: grant.principal, op: grant.op, verdict: `ask:pending:${pending.id}`, argsHash: grant.argsHash, exitCode: null, paths: auditPaths });
        return reply({ type: 'grant_denied', grantId: grant.grantId, reason: `ask_pending:${pending.id}`, pending: { challengeId: pending.id, expiresAt: pending.exp, request: pendingRequestOnTheWire(pending.request), ...(files !== undefined && { files }) } });
      }
      const answer = await deps.ask.ask({ grantId: grant.grantId, principal: grant.principal, op: grant.op, request: shown, subjects, sensitive });
      // Re-checked after the await: the owner may have pressed Stop while the prompt sat open.
      if (predatesPause(grant)) return refuse(grant.grantId, 'paused', { grant, op: grant.op });
      if (!answer.approved) return refuse(grant.grantId, 'declined', { grant, op: grant.op, verdict: 'ask:declined' });
      decision = gates.decideExecution({ ...decideInput, localApproval: { grantId: grant.grantId, approvedAt: deps.now(), request: shown } });
      // Remembered ONLY once the byte-compare allowed it, and only under the
      // subjects the owner was told about. `once` and null subjects remember nothing.
      if (decision.kind === 'allow' && subjects !== null && answer.scope !== 'once' && deps.approvals !== undefined) {
        await deps.approvals.remember({ approvalId: deps.ids?.approvalId() ?? `local_${grant.grantId}`, envId: deps.envId, userId: grant.principal.userId, op: grant.op, subjects, scope: answer.scope });
        if (predatesPause(grant)) return refuse(grant.grantId, 'paused', { grant, op: grant.op });
      }
      if (decision.kind === 'allow') decision = { ...decision, basis: { kind: 'fresh_approval' } };
      allowVerdict = `allow:approved:${answer.scope}`;
    }
    if (decision.kind === 'deny') return refuse(grant.grantId, decision.reason, { grant, op: grant.op });
    if (decision.kind !== 'allow') return refuse(grant.grantId, 'ask_unresolved', { grant, op: grant.op });
    if (decision.basis.kind === 'durable_approval') allowVerdict = `allow:approval:${decision.basis.approvalIds.join(',')}`;

    // Allow: the normalized request is the ONLY thing the runners ever see —
    // and the latch is checked one last time, immediately before any runner.
    if (predatesPause(grant)) return refuse(grant.grantId, 'paused', { grant, op: grant.op });
    const normalized = decision.request;
    try {
      switch (normalized.op) {
        case 'exec': {
          // Clamp the captured-output cap so the signed exec_result always
          // decodes under the frame limit, however high the policy maxBytes.
          const ceiling = execOutputCeiling(deps.limits);
          const bounded = normalized.maxBytes > ceiling ? { ...normalized, maxBytes: ceiling, clamped: true } : normalized;
          const outcome = await deps.execRunner.run(bounded);
          await deps.audit.record({ grantId: grant.grantId, principal: grant.principal, op: grant.op, verdict: allowVerdict, argsHash: grant.argsHash, exitCode: outcome.exitCode, paths: auditPaths });
          return reply({ type: 'exec_result', grantId: grant.grantId, exitCode: outcome.exitCode, stdoutB64: outcome.stdout.toString('base64'), stderrB64: outcome.stderr.toString('base64'), truncated: outcome.truncated });
        }
        case 'fs_read': {
          const outcome = await deps.fsRunner.read(normalized, { roots, maxContentBytes: fsReadContentCeiling(deps.limits) });
          if (outcome.kind === 'unsupported') return refuse(grant.grantId, `unsupported_${outcome.reason}`, { grant, op: grant.op });
          if (outcome.kind === 'too_large') return refuse(grant.grantId, 'too_large', { grant, op: grant.op, verdict: `deny:too_large:${outcome.size}>${outcome.maxContentBytes}` });
          if (outcome.kind === 'error') return refuse(grant.grantId, 'fs_error', { grant, op: grant.op, verdict: `deny:fs_error:${outcome.error}` });
          await deps.audit.record({ grantId: grant.grantId, principal: grant.principal, op: grant.op, verdict: allowVerdict, argsHash: grant.argsHash, exitCode: null, paths: auditPaths });
          return reply({ type: 'fs_read_result', grantId: grant.grantId, found: outcome.found, ...(outcome.contentB64 !== undefined && { contentB64: outcome.contentB64 }) });
        }
        case 'fs_write': {
          const files = frame.type === 'grant_fs_write' ? frame.files.map((file) => ({ contentB64: file.contentB64, mode: file.mode ?? null })) : [];
          const outcome = await deps.fsRunner.write(normalized, files, { roots });
          await deps.audit.record({ grantId: grant.grantId, principal: grant.principal, op: grant.op, verdict: outcome.ok ? allowVerdict : `${allowVerdict}:write_failed:${outcome.error ?? ''}`, argsHash: grant.argsHash, exitCode: null, paths: auditPaths });
          return reply({ type: 'fs_write_result', grantId: grant.grantId, ok: outcome.ok, ...(outcome.error !== undefined && { error: outcome.error }) });
        }
        case 'pty_open':
          return refuse(grant.grantId, 'unsupported', { grant, op: grant.op });
      }
    } catch (error) {
      deps.log(`runner refused grant ${grant.grantId}: ${messageOf(error)}`);
      return refuse(grant.grantId, 'runner_refused', { grant, op: grant.op, verdict: `deny:runner_refused:${messageOf(error)}` });
    }
  };

  const handleRevoke = async (frame: Extract<Frame, { type: 'revoke' }>): Promise<DispatchResult> => {
    const verdict = verifyRevoke({ frame, envId: deps.envId, enrollmentId: deps.enrollmentId, keyId: deps.serverKeyId, issuedAt: frame.issuedAt, serverPublicKey: deps.serverPublicKey, verify: deps.verify });
    if (!verdict.ok) {
      await deps.audit.record({ grantId: null, principal: null, op: 'revoke', verdict: frame.approvalId !== undefined ? 'dropped:approval_revoke_bad_signature' : 'dropped:revoke_bad_signature', argsHash: null, exitCode: null });
      return { kind: 'dropped', reason: 'revoke_bad_signature' };
    }
    if (frame.approvalId !== undefined) {
      // THE ASYMMETRY (GA wave 2, leaf 8): the server may delete exactly one
      // approval by id — verified under the approval-revoke domain — and can
      // never add one: no frame writes to the approvals store, and this
      // branch never touches the key or the enrollment.
      const removed = deps.approvals === undefined ? 0 : await deps.approvals.revoke(frame.approvalId);
      await deps.audit.record({ grantId: null, principal: null, op: 'revoke', verdict: `approval_revoked:${frame.approvalId}:${removed}`, argsHash: null, exitCode: null });
      // The ACK (Codex P2 on #2583): machine-signed over {approvalId, removed}, so the server can only ever claim what this machine did.
      return { kind: 'approval_revoked', approvalId: frame.approvalId, removed, frame: signResultFrame({ type: 'approval_revoke_result', approvalId: frame.approvalId, removed }, signer) };
    }
    await deps.audit.record({ grantId: null, principal: null, op: 'revoke', verdict: 'revoked', argsHash: null, exitCode: null });
    return { kind: 'revoke_verified' };
  };

  /**
   * STOP (GA wave 3). The server's signed `pause` — under its own domain, so
   * nothing that verifies here could ever have been a revoke — means the
   * OWNER pressed Stop while something might be running on this machine.
   * Verified: kill every process group this daemon started (the whole
   * point: a `curl … | sh` the owner just saw in the activity panel dies
   * here, not at its own leisure), drop every pending challenge (a click for
   * a request frozen BEFORE the pause must match nothing after Resume), audit
   * it, and ack with a machine-signed `pause_result` the server correlates on
   * `pause:<envId>:<pausedAt>`. The socket stays: the machine is not the
   * thing being stopped, its grants are. Unverified ⇒ dropped + audited,
   * nothing killed.
   */
  const handlePause = async (frame: Extract<Frame, { type: 'pause' }>): Promise<DispatchResult> => {
    const verdict = verifyPause({ frame, envId: deps.envId, enrollmentId: deps.enrollmentId, keyId: deps.serverKeyId, issuedAt: frame.issuedAt, serverPublicKey: deps.serverPublicKey, verify: deps.verify });
    if (!verdict.ok) {
      await deps.audit.record({ grantId: null, principal: null, op: 'pause', verdict: 'dropped:pause_bad_signature', argsHash: null, exitCode: null });
      return { kind: 'dropped', reason: 'pause_bad_signature' };
    }
    // Latched BEFORE the kill (and never rolled back): a handler resuming from an await after this point sees it.
    pausedAt = Math.max(pausedAt ?? 0, frame.pausedAt);
    const killed = deps.execRunner.killAll();
    const dropped = deps.challenges?.clear() ?? 0;
    await deps.audit.record({ grantId: null, principal: null, op: 'pause', verdict: `paused:killed:${killed}`, argsHash: null, exitCode: null });
    return { kind: 'paused', pausedAt: frame.pausedAt, killed, dropped, frame: signResultFrame({ type: 'pause_result', envId: deps.envId, pausedAt: frame.pausedAt, killed }, signer) };
  };

  return {
    async handle(frame) {
      if (frame.type === 'ping') return { kind: 'reply', frame: { type: 'pong', ts: deps.now() } };
      if (frame.type === 'revoke') return handleRevoke(frame);
      if (frame.type === 'pause') return handlePause(frame);
      if (isGrantFrame(frame)) return handleGrant(frame);
      await deps.audit.record({ grantId: null, principal: null, op: frame.type, verdict: 'dropped:unsupported_frame', argsHash: null, exitCode: null });
      return { kind: 'dropped', reason: 'unsupported_frame' };
    },
  };
}
