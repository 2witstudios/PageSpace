/**
 * Tool execution orchestration for `bash` / `writeFile` / `readFile` (IO,
 * dependency-injected).
 *
 * These runners are the body of each AI SDK tool's `execute`. The thin tool
 * wrapper (apps/web) reads the chat context, binds the real deps, and calls one
 * of these. Everything security-critical happens INLINE here, in order:
 *
 *   1. kill-switch re-check (defence in depth on top of the lifecycle's authz);
 *   2. inline command/path policy BEFORE any VM work — a blocked command never
 *      provisions a sandbox, and a blocked command is audited as an anomaly;
 *   3. quota — reserve a per-tier concurrency slot (the only cost ceiling here);
 *   4. `acquireMachineSandbox` (authz + lifecycle, re-authz on resume) and
 *      reconnect to the executable handle;
 *   5. run / write / read against the injected sandbox client;
 *   6. truncate untrusted output to the policy cap;
 *   7. audit every executed run (and every blocked command); and
 *   8. release the concurrency slot in `finally`, always.
 *
 * All IO — the sandbox acquire/reconnect, the quota ops, the audit writer, the
 * clock, the kill-switch read, the env builder — is injected, so the whole
 * orchestration is unit-tested with fakes and never touches the real sandbox
 * driver or the database. Pure policy (`evaluateCommandPolicy`,
 * `resolveSandboxPath`, `truncateToBytes`) is called directly.
 */

import type { SubscriptionTier } from '../subscription-utils';
import { SANDBOX_TIMEOUT_MS, SANDBOX_MAX_TIMEOUT_MS, SANDBOX_MAX_OUTPUT_BYTES } from './execution-policy';
import { evaluateCommandPolicy } from './command-policy';
import { truncateToBytes } from './output-limit';
import { resolveSandboxPath, SANDBOX_ROOT } from './sandbox-paths';
import { applyEdit } from './edit-file';
import { buildSandboxEnv } from './sandbox-env';
import {
  shouldCheckpoint,
  checkpointComment,
  coalesceCheckpointAttempt,
  type CheckpointState,
} from './checkpoint-policy';
import { getValidatedEnv } from '../../config/env-validation';
import {
  resolveMachinePageId,
  type AcquireMachineSandboxInput,
  type AcquireMachineSandboxResult,
  type MachineRefLike,
} from './machine-session';
import type { AcquireBranchSandboxResult } from './branch-session';
import type { AcquireProjectSandboxResult } from './project-session';
import type { ExecutableSandbox, SandboxRunResult } from './sandbox-client/types';
import type { CodeExecutionAuditInput, CodeExecutionAnomaly } from './audit';

/** Largest file body a single `writeFile` may submit, in bytes. */
export const MAX_WRITE_BYTES = 1024 * 1024;

/** Everything the runners need about the actor + AI attribution for a turn. */
export interface SandboxActorContext {
  userId: string;
  tenantId: string;
  /** Absent for global (non-drive) contexts. */
  driveId?: string;
  conversationId: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  actorEmail: string;
  actorDisplayName?: string;
  aiProvider?: string;
  aiModel?: string;
  tier: SubscriptionTier;
  /** The ACTIVE machine this call routes to (Terminal epics); undefined defaults to 'own'. */
  activeMachine?: MachineRefLike;
  /**
   * Stable id for the CURRENT agent turn (one streamText run) — the same value
   * for every tool call within that run, a fresh value for the next one.
   * Threads into the pre-batch checkpoint's throttle (`deps.checkpoint`, Sprites
   * Platform Alignment 5-2): at most one checkpoint per turnId. Undefined → no
   * reliable turn boundary to key the throttle on, so checkpointing is skipped
   * for that call rather than guessed at.
   */
  turnId?: string;
  /**
   * Present when this run is bound to a "PageSpace Agent" branch pane (issue
   * #2166 phases 5/9's `deriveMachinePaneBinding.branchSandbox`) — the
   * branch's owning Machine page id plus the `machine_branches` row backing
   * it. Routes `acquireSandbox` through the attach-only branch seam
   * (`acquireBranchSandbox`, branch-session.ts) instead of the machine's own
   * persistent session. Undefined for every other run.
   */
  branchSandbox?: { machineId: string; machineBranchId: string };
  /**
   * Present when this run is bound to a PROMOTED project node (issue #2204
   * phase 7) — the owning Machine page id plus the `machine_projects` row
   * backing it. The project-tier twin of `branchSandbox`: it routes
   * `acquireSandbox` through the attach-only PROJECT seam
   * (`acquireProjectSandbox`, project-session.ts) instead of the machine's own
   * persistent session, because a promoted project no longer lives there.
   * Undefined for an unpromoted project (which still runs on the machine's
   * Sprite at the checkout's cwd) and for every other run.
   */
  projectSandbox?: { machineId: string; machineProjectId: string };
}

export interface SandboxQuotaDeps {
  /** Reserve an in-process concurrency slot; false when the tier ceiling is hit. */
  acquireSlot: (args: { userId: string; tier: SubscriptionTier }) => boolean;
  releaseSlot: (args: { userId: string }) => void;
}

/**
 * Metering seam for a machine run's active-runtime cost (Terminal Epic 3).
 * Optional — omitting it disables metering (no hold, no charge), mirroring
 * every other optional seam in this file (`screenOutput`, `notifyTerminalActivity`).
 *
 * The hold->settle protocol mirrors the voice STT recipe
 * (apps/web/src/app/api/voice/transcribe/route.ts): `gate` places a flat-estimate
 * hold BEFORE the machine is acquired (the real active-window duration isn't known
 * until the run ends); `trackUsage` settles the hold to the real cost and hands off
 * its release to the credit pipeline on a SUCCESSFUL run only; `releaseHold` is the
 * safety net for every other exit (denial, thrown error, timeout) so a failed run
 * never strands a hold against the payer's spendable balance.
 */
export interface SandboxBillingDeps {
  /**
   * Resolves who pays for THIS run (Terminal Epic 3 owner-pays) — the
   * referenced machine's actual page owner when resolvable, else the acting
   * tenantId. The one seam payer resolution goes through; see
   * `machine-payer.ts`'s `resolveMachinePayerId`.
   */
  resolvePayerId: (input: { tenantId: string; machinePageId?: string }) => Promise<string>;
  /** Places a flat-estimate hold for this payer before the machine run begins. */
  gate: (input: { payerId: string }) => Promise<{ allowed: boolean; holdId?: string; reason?: string }>;
  /** Settles the hold to the real active-window cost. Only called on a successful run. */
  trackUsage: (input: { payerId: string; holdId?: string; activeSeconds: number; pageId?: string }) => Promise<void>;
  /** Releases a hold without billing. Called on every exit that never reaches `trackUsage`. */
  releaseHold: (holdId: string) => Promise<void>;
}

/**
 * A single bash command + its output, for streaming into the referenced
 * Terminal's live PTY/output feed (Terminal Epic 1 T1.5 activity visibility) —
 * so a human watching a Terminal page sees the agent's work as it happens.
 */
export interface TerminalActivityNotification {
  /** The machine's identifying page (resolveMachinePageId's output). */
  pageId: string;
  driveId?: string;
  tenantId: string;
  command: string;
  output: string;
  exitCode: number;
  /** Human-facing label for who ran this (actor display name or email). */
  agentLabel: string;
}

/**
 * Pre-batch checkpoint seam (Sprites Platform Alignment 5-2): before an agent
 * bash batch runs, optionally snapshot the sandbox's writable filesystem so a
 * destructive command (the canonical worry: an agent `rm -rf`ing /workspace —
 * see `sprites.ts`'s `spawnWithSelfHealingCwd` doc) is a restore, not a
 * bricked machine. Restore itself stays a manual/admin action — this seam only
 * ever CREATES checkpoints, never restores one.
 *
 * `getState`/`recordCheckpoint` are the bookkeeping the pure `shouldCheckpoint`
 * policy (`checkpoint-policy.ts`) needs to enforce "at most once per turn" +
 * the rapid-batch throttle; production wires them to an in-process Map keyed
 * by sandboxId (mirrors `quota.ts`'s `machineActivityByKey` — no persistence,
 * no reaper). `createCheckpoint` is the actual SDK call against a live,
 * already-awake sandbox handle.
 */
export interface SandboxCheckpointDeps {
  /** The feature flag, re-checked fresh per batch. */
  isEnabled: () => boolean;
  /** Read the last-checkpoint bookkeeping for `sandboxId` (empty state if never recorded). */
  getState: (sandboxId: string) => CheckpointState;
  /** Persist that `sandboxId` was just checkpointed, per the pure policy's decision. */
  recordCheckpoint: (sandboxId: string, state: CheckpointState) => void;
  /** Create the checkpoint itself against a live sandbox handle, tagged with `comment`. */
  createCheckpoint: (input: { sandbox: ExecutableSandbox; comment: string }) => Promise<void>;
}

/**
 * `acquireSandbox`'s request: the machine-session shape plus the optional
 * branch routing key. `branchSandbox` present → the caller routes to
 * `acquireBranchSandbox` (attach-only); absent → `acquireMachineSandbox` as
 * before.
 */
export type AcquireSandboxRequest = Omit<AcquireMachineSandboxInput, 'deps'> & {
  branchSandbox?: { machineId: string; machineBranchId: string };
  /** Promoted-project routing key — see `SandboxActorContext.projectSandbox`. */
  projectSandbox?: { machineId: string; machineProjectId: string };
};

export interface SandboxRunDeps {
  isEnabled: () => boolean;
  /** Pre-bound `acquireMachineSandbox` / `acquireBranchSandbox` (lifecycle deps already injected). */
  acquireSandbox: (
    input: AcquireSandboxRequest,
  ) => Promise<AcquireMachineSandboxResult | AcquireBranchSandboxResult | AcquireProjectSandboxResult>;
  /** Reconnect to the executable handle for an acquired sandbox id. */
  reconnect: (sandboxId: string) => Promise<ExecutableSandbox | null>;
  quota: SandboxQuotaDeps;
  buildEnv: () => Record<string, string>;
  audit: (input: CodeExecutionAuditInput) => Promise<void>;
  /**
   * Optional injection-detection seam (DEFENSE-IN-DEPTH, fail-open). Applied to
   * untrusted tool output (bash stdout, file content) BEFORE it returns to the
   * model. Composed in the app shell from `screenToolOutput` + a real classifier;
   * it annotates flagged content and NEVER blocks. Omitted → output passes through
   * unchanged (seam disabled).
   */
  screenOutput?: (text: string) => Promise<string>;
  /**
   * Optional activity-visibility seam (Terminal Epic 1 T1.5): streams a
   * successful bash run's command + output into the referenced Terminal's
   * live feed. Best-effort — a failure here must never affect the tool
   * result, and omitting it simply disables the feed (no Terminal epic
   * consumer wired yet, or the machine has no live watcher).
   */
  notifyTerminalActivity?: (input: TerminalActivityNotification) => Promise<void>;
  /**
   * Optional metering seam (Terminal Epic 3): meters this run's active-runtime
   * cost against the machine's payer. Omitted -> unmetered (no hold, no charge).
   */
  billing?: SandboxBillingDeps;
  /**
   * Optional opportunistic storage-measurement seam (Sprites Platform Alignment
   * 6-1): while this sprite is ALREADY awake for this real op, capture its used
   * storage bytes (throttled, best-effort) so the storage reconcile can bill
   * MEASURED usage without ever waking a paused sprite. Best-effort — a failure
   * must never affect the tool result; omitting it disables measurement.
   */
  measureStorage?: (input: { sandbox: ExecutableSandbox; pageId: string }) => Promise<void>;
  /**
   * Optional pre-batch checkpoint seam (Sprites Platform Alignment 5-2). Omitted
   * → no checkpointing (the seam is fully optional, matching every other
   * optional seam in this file). See `SandboxCheckpointDeps`.
   */
  checkpoint?: SandboxCheckpointDeps;
  now: () => Date;
  logger?: {
    warn?: (message: string, metadata?: Record<string, unknown>) => void;
    error: (message: string, error?: Error | Record<string, unknown>, metadata?: Record<string, unknown>) => void;
  };
}

function safeLogError(
  logger: SandboxRunDeps['logger'],
  ...args: Parameters<NonNullable<SandboxRunDeps['logger']>['error']>
): void {
  try { logger?.error(...args); } catch { /* Logging must not alter tool control flow. */ }
}

function asError(value: unknown): Error | undefined {
  if (value instanceof Error) return value;
  if (value === undefined || value === null) return undefined;
  return new Error(String(value));
}

function safeLogWarn(
  logger: SandboxRunDeps['logger'],
  message: string,
  metadata?: Record<string, unknown>,
): void {
  try { logger?.warn?.(message, metadata); } catch { /* Logging must not alter tool control flow. */ }
}

// Acquisition reasons that represent expected policy/authz outcomes (warn-level)
// vs infra failures that are genuinely unexpected (error-level).
const AUTHZ_DENY_REASONS = new Set([
  'no_drive_access', 'insufficient_role', 'no_agent_access', 'app_admin_required', 'kill_switch_off', 'no_machine',
  'machine_runtime_exceeded', 'branch_not_found',
]);


export type SandboxToolDenialReason =
  | 'kill_switch_off'
  | 'app_admin_required'
  | 'no_drive_access'
  | 'insufficient_role'
  | 'no_agent_access'
  | 'no_machine'
  | 'machine_runtime_exceeded'
  | 'credit_exhausted'
  | 'concurrency_limit'
  | 'empty_command'
  | 'command_too_large'
  | 'blocked_metadata_access'
  | 'github_over_bash'
  | 'path_escape'
  | 'content_too_large'
  | 'edit_no_match'
  | 'edit_not_unique'
  | 'provision_failed'
  | 'execution_failed'
  | 'not_found'
  | 'error';

export type BashToolResult =
  | { success: true; stdout: string; stderr: string; exitCode: number; truncated: boolean }
  | { success: false; error: string; reason: SandboxToolDenialReason };

export type WriteFileToolResult =
  | { success: true; path: string; bytesWritten: number }
  | { success: false; error: string; reason: SandboxToolDenialReason };

export type ReadFileToolResult =
  | { success: true; path: string; content: string; truncated: boolean }
  | { success: false; error: string; reason: SandboxToolDenialReason };

export type EditFileToolResult =
  | { success: true; path: string; replacements: number }
  | { success: false; error: string; reason: SandboxToolDenialReason };

const DENIAL_MESSAGES: Record<SandboxToolDenialReason, string> = {
  kill_switch_off: 'Code execution is disabled.',
  app_admin_required: 'Code execution is currently restricted to application administrators.',
  no_drive_access: 'You do not have access to run code in this drive.',
  insufficient_role: 'Running code requires drive owner or admin access.',
  no_agent_access: 'This agent is not permitted to run code in this drive.',
  no_machine: 'No machine is configured for this run.',
  machine_runtime_exceeded:
    'This machine has been running continuously for too long. Wait for it to go idle, or switch to a different machine.',
  credit_exhausted: 'Insufficient credits to run this machine.',
  concurrency_limit: 'Too many concurrent runs. Wait for a run to finish and retry.',
  empty_command: 'No command was provided.',
  command_too_large: 'The command is too large.',
  blocked_metadata_access: 'This command is blocked by policy.',
  github_over_bash:
    'The bash sandbox has no GitHub credentials. Use the dedicated git_*/gh_* tools for GitHub operations (e.g. git_clone, git_push, gh_pr_create) — they carry your connected GitHub auth.',
  path_escape: 'The path is invalid or escapes the sandbox root.',
  content_too_large: 'The file content is too large.',
  edit_no_match: 'The oldString was not found in the file. Read the file and copy the exact text to replace.',
  edit_not_unique: 'The oldString is not unique in the file. Include more surrounding context, or set replaceAll to replace every occurrence.',
  provision_failed: 'Could not provision a sandbox for this run.',
  execution_failed: 'Command execution failed or timed out.',
  not_found: 'File not found.',
  error: 'Code execution could not be completed.',
};

function fail(
  reason: SandboxToolDenialReason,
): { success: false; error: string; reason: SandboxToolDenialReason } {
  return { success: false, error: DENIAL_MESSAGES[reason], reason };
}

function acquireRequest(ctx: SandboxActorContext): AcquireSandboxRequest {
  return {
    tenantId: ctx.tenantId,
    driveId: ctx.driveId,
    userId: ctx.userId,
    requestOrigin: ctx.requestOrigin,
    agentPageId: ctx.agentPageId,
    activeMachine: ctx.activeMachine,
    branchSandbox: ctx.branchSandbox,
    projectSandbox: ctx.projectSandbox,
  };
}

// Audit is forensic and fire-and-forget: a failing audit sink must never break
// the run (or the denial) it records.
async function safeAudit(
  deps: SandboxRunDeps,
  ctx: SandboxActorContext,
  fields: {
    profile?: string;
    code: string;
    exitCode: number | null;
    durationMs: number;
    anomaly?: CodeExecutionAnomaly;
  },
): Promise<void> {
  try {
    await deps.audit({
      userId: ctx.userId,
      actorEmail: ctx.actorEmail,
      actorDisplayName: ctx.actorDisplayName,
      driveId: ctx.driveId ?? null,
      conversationId: ctx.conversationId,
      requestOrigin: ctx.requestOrigin,
      agentPageId: ctx.agentPageId,
      aiProvider: ctx.aiProvider,
      aiModel: ctx.aiModel,
      timestamp: deps.now(),
      ...fields,
    });
  } catch {
    // Intentionally swallowed.
  }
}

// Best-effort, fire-and-forget: a failing/missing activity feed must never
// affect the bash tool's result — it is a visibility nicety, not a safety gate.
async function safeNotifyTerminalActivity(
  deps: SandboxRunDeps,
  input: TerminalActivityNotification,
): Promise<void> {
  if (!deps.notifyTerminalActivity) return;
  try {
    await deps.notifyTerminalActivity(input);
  } catch {
    // Intentionally swallowed.
  }
}

// Map a denial from the lifecycle acquire onto the tool-facing reason set.
// `branch_not_found`/`project_not_found` (the attach-only seams' own
// fail-closed reasons, with no tool-facing equivalent) fall through to 'error'
// with the rest.
function reasonFromAcquire(
  result: Extract<AcquireMachineSandboxResult | AcquireBranchSandboxResult | AcquireProjectSandboxResult, { ok: false }>,
): SandboxToolDenialReason {
  switch (result.reason) {
    case 'app_admin_required':
    case 'no_drive_access':
    case 'insufficient_role':
    case 'no_agent_access':
    case 'no_machine':
    case 'provision_failed':
    case 'machine_runtime_exceeded':
      return result.reason;
    case 'kill_switch_off':
      return 'kill_switch_off';
    default:
      return 'error';
  }
}

const anomalyForExit = (exitCode: number): CodeExecutionAnomaly | undefined => {
  if (exitCode === 0) return undefined;
  // 128 + SIGKILL(9): the sandbox SIGKILLs on the timeout cap.
  return exitCode === 137 ? 'timeout' : 'nonzero_exit';
};

type MeteredResult<S> =
  | ({ success: true } & S)
  | { success: false; error: string; reason: SandboxToolDenialReason };

/**
 * Wraps a machine op with active-runtime metering (Terminal Epic 3). Places a
 * flat-estimate hold for the payer BEFORE `run` (which acquires the machine and
 * executes the op), then on a SUCCESSFUL result settles the hold to the real
 * active-window cost (wall-clock from just before `run` to just after it
 * resolves). Any other exit — denial, thrown error, timeout — releases the hold
 * without billing: the run never reached a confirmed successful completion, so
 * there is nothing to charge (mirrors the voice STT recipe's `holdHandedOff`
 * safety net). Skipped entirely (no hold, no charge) when `deps.billing` is
 * unset — an unmetered deployment behaves exactly as before this seam existed.
 */
async function withMachineBilling<S>(
  ctx: SandboxActorContext,
  deps: SandboxRunDeps,
  run: () => Promise<MeteredResult<S>>,
): Promise<MeteredResult<S>> {
  const billing = deps.billing;
  if (!billing) return run();

  const machinePageId = resolveMachinePageId({ agentPageId: ctx.agentPageId, activeMachine: ctx.activeMachine });
  const payerId = await billing.resolvePayerId({ tenantId: ctx.tenantId, machinePageId });
  const gate = await billing.gate({ payerId });
  if (!gate.allowed) return fail('credit_exhausted');

  const holdId = gate.holdId;
  const startedAt = deps.now().getTime();
  let handedOff = false;
  try {
    const result = await run();
    if (result.success) {
      handedOff = true;
      const activeSeconds = Math.max(0, (deps.now().getTime() - startedAt) / 1000);
      await billing.trackUsage({ payerId, holdId, activeSeconds, pageId: machinePageId });
    }
    return result;
  } finally {
    if (holdId && !handedOff) void billing.releaseHold(holdId).catch(() => {});
  }
}

/**
 * Shared preamble: enforce quota and acquire a live, authorized executable
 * sandbox. Returns the handle plus a `release` thunk the caller MUST invoke in
 * `finally`, or a denial (with the slot already released). The kill-switch and
 * any op-specific policy (command / path) are checked by the caller BEFORE this,
 * so a policy-blocked op never reaches quota or provisioning.
 */
async function openSession(
  ctx: SandboxActorContext,
  deps: SandboxRunDeps,
): Promise<
  | { ok: true; sandbox: ExecutableSandbox; release: () => void; pageId?: string }
  | { ok: false; reason: SandboxToolDenialReason }
> {
  if (!deps.quota.acquireSlot({ userId: ctx.userId, tier: ctx.tier })) {
    return { ok: false, reason: 'concurrency_limit' };
  }

  // Slot is held from here: every failure path must release it before returning.
  try {
    const acquired = await deps.acquireSandbox(acquireRequest(ctx));
    if (!acquired.ok) {
      deps.quota.releaseSlot({ userId: ctx.userId });
      const context = { reason: acquired.reason, userId: ctx.userId, driveId: ctx.driveId, conversationId: ctx.conversationId, requestOrigin: ctx.requestOrigin };
      if (AUTHZ_DENY_REASONS.has(acquired.reason)) {
        safeLogWarn(deps.logger, 'Sandbox access denied', context);
      } else {
        safeLogError(deps.logger, 'Sandbox acquisition failed', context);
      }
      return { ok: false, reason: reasonFromAcquire(acquired) };
    }
    const sandbox = await deps.reconnect(acquired.sandboxId);
    if (!sandbox) {
      deps.quota.releaseSlot({ userId: ctx.userId });
      safeLogError(deps.logger, 'Sandbox reconnect returned no handle', {
        sandboxId: acquired.sandboxId,
        userId: ctx.userId,
        driveId: ctx.driveId,
        conversationId: ctx.conversationId,
      });
      return { ok: false, reason: 'provision_failed' };
    }
    return {
      ok: true,
      sandbox,
      release: () => {
        deps.quota.releaseSlot({ userId: ctx.userId });
        // Opportunistic, throttled, best-effort storage measurement. Fired from
        // `release` — which the runners call in `finally` AFTER the op — so it
        // observes any bytes the op just wrote (measuring in openSession, before
        // the op, would persist the pre-write footprint and let the throttle
        // suppress the post-write one) and runs sequentially after the op rather
        // than contending with it. Never blocks or fails the op.
        if (acquired.pageId && deps.measureStorage) {
          const pageId = acquired.pageId;
          void deps.measureStorage({ sandbox, pageId }).catch((error) => {
            safeLogWarn(deps.logger, 'Opportunistic storage measurement failed', {
              pageId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      },
      pageId: acquired.pageId,
    };
  } catch (error) {
    safeLogError(
      deps.logger,
      'Sandbox session open failed',
      error instanceof Error ? error : new Error(String(error)),
      {
        userId: ctx.userId,
        driveId: ctx.driveId,
        conversationId: ctx.conversationId,
        requestOrigin: ctx.requestOrigin,
      },
    );
    deps.quota.releaseSlot({ userId: ctx.userId });
    return { ok: false, reason: 'error' };
  }
}

/**
 * Wall-clock cap on the checkpoint SDK call, so a stalled checkpoint can never
 * violate `maybeCheckpointBeforeBatch`'s fail-open guarantee below (P2 review
 * finding, PR #2025: without this, an `await` on a hung checkpoint stream
 * never reaches the `catch`, so the bash command never starts and the
 * quota/billing slot stays held until the outer request times out — the
 * opposite of "never block agent work on checkpoint availability"). Generous
 * relative to the platform's documented ~300ms COW checkpoint time, but far
 * short of a bash command's own timeout (`SANDBOX_TIMEOUT_MS`, 120s) so a
 * hang can't eat meaningfully into the user's command budget. This bounds the
 * PROMISE from the caller's perspective regardless of what `deps.checkpoint`
 * happens to be wired to; the production Sprites driver (`sprites.ts`)
 * additionally bounds and cleans up the underlying stream itself.
 */
export const CHECKPOINT_TIMEOUT_MS = 10_000;

function withCheckpointTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Checkpoint timed out after ${ms}ms`)), ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Best-effort, fail-open pre-batch checkpoint: if `deps.checkpoint` is wired,
 * the flag is on, and the pure `shouldCheckpoint` policy says this turn hasn't
 * been checkpointed yet, snapshot the sandbox's filesystem BEFORE the bash
 * batch executes (never after — the whole point is a state to restore TO).
 *
 * A missing `ctx.turnId` skips checkpointing outright rather than guessing at
 * a turn boundary. Any failure (state read, a timeout, the checkpoint SDK
 * call itself) is logged and swallowed — this must never block or fail the
 * caller's batch on checkpoint availability (bounded by
 * `CHECKPOINT_TIMEOUT_MS` above). On success the bookkeeping is recorded so a
 * later batch in the SAME turn does not re-checkpoint; on failure nothing is
 * recorded, so a later batch in the same turn gets another attempt.
 *
 * The actual attempt is wrapped in `coalesceCheckpointAttempt` so concurrent
 * tool calls in one turn (the AI SDK can execute several bash calls from one
 * agent step in parallel) share a single checkpoint instead of each
 * independently passing the synchronous `shouldCheckpoint` check and racing
 * to create their own — see that function's doc for why this closes the race
 * regardless of exact timing between callers.
 */
async function maybeCheckpointBeforeBatch({
  ctx,
  deps,
  sandbox,
}: {
  ctx: SandboxActorContext;
  deps: SandboxRunDeps;
  sandbox: ExecutableSandbox;
}): Promise<void> {
  const checkpoint = deps.checkpoint;
  if (!checkpoint || !ctx.turnId) return;
  const turnId = ctx.turnId;

  try {
    const state = checkpoint.getState(sandbox.sandboxId);
    if (
      !shouldCheckpoint({
        flagEnabled: checkpoint.isEnabled(),
        turnId,
        lastCheckpointTurnId: state.lastCheckpointTurnId,
      })
    ) {
      return;
    }
    await coalesceCheckpointAttempt(sandbox.sandboxId, async () => {
      await withCheckpointTimeout(
        checkpoint.createCheckpoint({ sandbox, comment: checkpointComment(turnId) }),
        CHECKPOINT_TIMEOUT_MS,
      );
      checkpoint.recordCheckpoint(sandbox.sandboxId, { lastCheckpointAt: deps.now(), lastCheckpointTurnId: turnId });
    });
  } catch (error) {
    safeLogWarn(deps.logger, 'Pre-agent checkpoint failed (proceeding without one)', {
      sandboxId: sandbox.sandboxId,
      turnId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runBashInSandbox({
  command,
  cwd,
  timeoutMs,
  ctx,
  deps,
}: {
  command: string;
  cwd?: string;
  /** Opt-in override for long-running commands (e.g. `bun install`), clamped to `SANDBOX_MAX_TIMEOUT_MS`. Defaults to `SANDBOX_TIMEOUT_MS`. */
  timeoutMs?: number;
  ctx: SandboxActorContext;
  deps: SandboxRunDeps;
}): Promise<BashToolResult> {
  if (!deps.isEnabled()) return fail('kill_switch_off');

  const commandPolicy = evaluateCommandPolicy({ command });
  if (!commandPolicy.ok) {
    await safeAudit(deps, ctx, {
      code: command,
      exitCode: null,
      durationMs: 0,
      anomaly: 'blocked_command',
    });
    return fail(commandPolicy.reason);
  }

  // A provided working directory must also stay inside the sandbox root. A blocked
  // cwd escape is audited as an anomaly — like writeFile/readFile path escapes —
  // so an attempted sandbox break on the bash path is never silently dropped.
  let resolvedCwd: string = SANDBOX_ROOT;
  if (cwd !== undefined) {
    const candidate = resolveSandboxPath(cwd);
    if (!candidate) {
      await safeAudit(deps, ctx, {
        code: `bash cwd ${cwd}`,
        exitCode: null,
        durationMs: 0,
        anomaly: 'blocked_command',
      });
      return fail('path_escape');
    }
    resolvedCwd = candidate;
  }

  return withMachineBilling<{
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
  }>(ctx, deps, async () => {
  const session = await openSession(ctx, deps);
  if (!session.ok) return fail(session.reason);

  await maybeCheckpointBeforeBatch({ ctx, deps, sandbox: session.sandbox });

  try {
    const startedAt = deps.now();
    let run: SandboxRunResult;
    try {
      run = await session.sandbox.runCommand({
        cmd: 'sh',
        args: ['-c', command],
        cwd: resolvedCwd,
        env: deps.buildEnv(),
        timeoutMs: Math.min(Math.max(timeoutMs ?? SANDBOX_TIMEOUT_MS, 1), SANDBOX_MAX_TIMEOUT_MS),
        maxBytes: SANDBOX_MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      safeLogError(
        deps.logger,
        'Sandbox command execution threw',
        error instanceof Error ? error : new Error(String(error)),
        {
          userId: ctx.userId,
          driveId: ctx.driveId,
          conversationId: ctx.conversationId,
          durationMs,
        },
      );
      await safeAudit(deps, ctx, {
        code: command,
        exitCode: null,
        durationMs,
        anomaly: 'timeout',
      });
      return fail('execution_failed');
    }

    const durationMs = deps.now().getTime() - startedAt.getTime();
    // Injection seam (fail-open): screen untrusted stdout AND stderr BEFORE
    // truncation so the annotation marker lands at the head and survives the byte
    // cap. stderr is screened too — injected instructions can be written there just
    // as easily as stdout. The screen owns its own fail-open behavior; never blocks.
    const screenedStdout = deps.screenOutput ? await deps.screenOutput(run.stdout) : run.stdout;
    const screenedStderr = deps.screenOutput ? await deps.screenOutput(run.stderr) : run.stderr;
    const stdout = truncateToBytes({ text: screenedStdout, maxBytes: SANDBOX_MAX_OUTPUT_BYTES });
    const stderr = truncateToBytes({ text: screenedStderr, maxBytes: SANDBOX_MAX_OUTPUT_BYTES });
    await safeAudit(deps, ctx, {
      code: command,
      exitCode: run.exitCode,
      durationMs,
      anomaly: anomalyForExit(run.exitCode),
    });
    if (session.pageId) {
      // Fire-and-forget: this is a visibility nicety over a network hop to
      // another service, not a safety gate. Awaiting it would tie every
      // successful bash call's latency to the terminal-activity feed's
      // availability (up to its own request timeout) for no benefit — the
      // tool result below does not depend on it. safeNotifyTerminalActivity
      // already swallows its own errors, so this can never surface as an
      // unhandled rejection.
      void safeNotifyTerminalActivity(deps, {
        pageId: session.pageId,
        driveId: ctx.driveId,
        tenantId: ctx.tenantId,
        command,
        output: [stdout.text, stderr.text].filter((text) => text.length > 0).join('\n'),
        exitCode: run.exitCode,
        // No display name is set for a plain email fallback — a raw email
        // address is PII and this feed is visible to every viewer with edit
        // access to the Terminal page, not just the acting user.
        agentLabel: ctx.actorDisplayName ?? 'AI agent',
      });
    }
    return {
      success: true,
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: run.exitCode,
      truncated: stdout.truncated || stderr.truncated,
    };
  } finally {
    session.release();
  }
  });
}

export async function writeSandboxFile({
  path,
  content,
  ctx,
  deps,
}: {
  path: string;
  content: string;
  ctx: SandboxActorContext;
  deps: SandboxRunDeps;
}): Promise<WriteFileToolResult> {
  if (!deps.isEnabled()) return fail('kill_switch_off');

  const resolved = resolveSandboxPath(path);
  if (!resolved) {
    await safeAudit(deps, ctx, {
      code: `writeFile ${path}`,
      exitCode: null,
      durationMs: 0,
      anomaly: 'blocked_command',
    });
    return fail('path_escape');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WRITE_BYTES) return fail('content_too_large');

  return withMachineBilling<{ path: string; bytesWritten: number }>(ctx, deps, async () => {
  const session = await openSession(ctx, deps);
  if (!session.ok) return fail(session.reason);

  try {
    const startedAt = deps.now();
    try {
      await session.sandbox.writeFiles([{ path: resolved, content }]);
    } catch {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      await safeAudit(deps, ctx, {
        code: `writeFile ${path}`,
        exitCode: null,
        durationMs,
        anomaly: 'nonzero_exit',
      });
      return fail('execution_failed');
    }
    const durationMs = deps.now().getTime() - startedAt.getTime();
    await safeAudit(deps, ctx, {
      code: `writeFile ${path} (${bytes} bytes)`,
      exitCode: 0,
      durationMs,
    });
    return { success: true, path, bytesWritten: bytes };
  } finally {
    session.release();
  }
  });
}

export async function readSandboxFile({
  path,
  ctx,
  deps,
}: {
  path: string;
  ctx: SandboxActorContext;
  deps: SandboxRunDeps;
}): Promise<ReadFileToolResult> {
  if (!deps.isEnabled()) return fail('kill_switch_off');

  const resolved = resolveSandboxPath(path);
  if (!resolved) {
    await safeAudit(deps, ctx, {
      code: `readFile ${path}`,
      exitCode: null,
      durationMs: 0,
      anomaly: 'blocked_command',
    });
    return fail('path_escape');
  }

  return withMachineBilling<{ path: string; content: string; truncated: boolean }>(ctx, deps, async () => {
  const session = await openSession(ctx, deps);
  if (!session.ok) return fail(session.reason);

  try {
    const startedAt = deps.now();
    let buffer: Buffer | null;
    try {
      // NOTE (host-memory bound): the driver's fs read materializes the whole
      // file before we apply `truncateToBytes`, so the file's size — bounded by
      // the per-sprite storage cap, not by `maxOutputBytes` — is what reaches host
      // memory here. A true read-side host-memory cap needs a bounded/streamed
      // read at the SDK boundary (the `@fly/sprites` RC fs API exposes neither
      // stat nor a ranged/streamed read); enforcing it is tracked as an
      // enablement-gate hardening item before the feature is flagged on.
      buffer = await session.sandbox.readFileToBuffer({ path: resolved });
    } catch {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      await safeAudit(deps, ctx, {
        code: `readFile ${path}`,
        exitCode: null,
        durationMs,
        anomaly: 'nonzero_exit',
      });
      return fail('execution_failed');
    }
    const durationMs = deps.now().getTime() - startedAt.getTime();
    if (buffer === null) {
      await safeAudit(deps, ctx, {
        code: `readFile ${path}`,
        exitCode: 1,
        durationMs,
        anomaly: 'nonzero_exit',
      });
      return fail('not_found');
    }
    // Injection seam (fail-open): screen untrusted file content before truncation.
    const rawContent = buffer.toString('utf8');
    const screenedContent = deps.screenOutput ? await deps.screenOutput(rawContent) : rawContent;
    const { text, truncated } = truncateToBytes({
      text: screenedContent,
      maxBytes: SANDBOX_MAX_OUTPUT_BYTES,
    });
    await safeAudit(deps, ctx, {
      code: `readFile ${path}`,
      exitCode: 0,
      durationMs,
    });
    return { success: true, path, content: text, truncated };
  } finally {
    session.release();
  }
  });
}

export async function editSandboxFile({
  path,
  oldString,
  newString,
  replaceAll,
  ctx,
  deps,
}: {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  ctx: SandboxActorContext;
  deps: SandboxRunDeps;
}): Promise<EditFileToolResult> {
  if (!deps.isEnabled()) return fail('kill_switch_off');

  const resolved = resolveSandboxPath(path);
  if (!resolved) {
    await safeAudit(deps, ctx, {
      code: `editFile ${path}`,
      exitCode: null,
      durationMs: 0,
      anomaly: 'blocked_command',
    });
    return fail('path_escape');
  }

  return withMachineBilling<{ path: string; replacements: number }>(ctx, deps, async () => {
  const session = await openSession(ctx, deps);
  if (!session.ok) return fail(session.reason);

  try {
    const startedAt = deps.now();
    let buffer: Buffer | null;
    try {
      buffer = await session.sandbox.readFileToBuffer({ path: resolved });
    } catch {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      await safeAudit(deps, ctx, { code: `editFile ${path}`, exitCode: null, durationMs, anomaly: 'nonzero_exit' });
      return fail('execution_failed');
    }
    if (buffer === null) {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      await safeAudit(deps, ctx, { code: `editFile ${path}`, exitCode: 1, durationMs, anomaly: 'nonzero_exit' });
      return fail('not_found');
    }

    const edit = applyEdit({ content: buffer.toString('utf8'), oldString, newString, replaceAll });
    if (!edit.ok) {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      await safeAudit(deps, ctx, { code: `editFile ${path}`, exitCode: 1, durationMs, anomaly: 'nonzero_exit' });
      return fail(edit.reason);
    }

    const bytes = Buffer.byteLength(edit.content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) return fail('content_too_large');

    try {
      await session.sandbox.writeFiles([{ path: resolved, content: edit.content }]);
    } catch {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      await safeAudit(deps, ctx, { code: `editFile ${path}`, exitCode: null, durationMs, anomaly: 'nonzero_exit' });
      return fail('execution_failed');
    }
    const durationMs = deps.now().getTime() - startedAt.getTime();
    await safeAudit(deps, ctx, {
      code: `editFile ${path} (${edit.replacements} replaced)`,
      exitCode: 0,
      durationMs,
    });
    return { success: true, path, replacements: edit.replacements };
  } finally {
    session.release();
  }
  });
}

/**
 * Default env builder used by the production tool wrappers. This is the effect
 * seam that sources the validated env from the global and hands it to the pure
 * `buildSandboxEnv`, keeping the allowlist construction itself IO-free.
 */
export const defaultBuildEnv = (): Record<string, string> =>
  buildSandboxEnv({ env: getValidatedEnv() });
