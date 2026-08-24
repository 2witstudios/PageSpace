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
import {
  SANDBOX_TIMEOUT_MS,
  SANDBOX_MAX_TIMEOUT_MS,
  SANDBOX_MAX_OUTPUT_BYTES,
  DEFAULT_READ_LINES,
  MAX_LINE_BYTES,
} from './execution-policy';
import { evaluateCommandPolicy } from './command-policy';
import { truncateToBytes, selectLineWindow, LINE_ELISION_MARKER } from './output-limit';
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
  /**
   * The drive's owner (or, for a driveless global context, the acting user —
   * global sessions are owner-only, so actor and owner coincide there). Feeds
   * the call-time gate's tier-eligibility check, which resolves the PAYER's
   * tier, not the actor's — see `resolveSandboxPayerTier`. Absent only when a
   * session genuinely doesn't exist yet at gate-time (falls back to `userId`,
   * which denies more strictly, never grants incorrectly).
   */
  ownerId?: string;
  conversationId: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  actorEmail: string;
  actorDisplayName?: string;
  aiProvider?: string;
  aiModel?: string;
  /**
   * The PAYER's subscription tier (drive owner, or the acting user for a
   * driveless global context) — NOT the actor's own. Consumed by the quota
   * eligibility check and the concurrency ceiling; the slot itself is still
   * counted per acting user (`userId`), so per-actor accounting stays separate
   * from payer-based entitlement (review #2326).
   */
  tier: SubscriptionTier;
  /**
   * Stable id for the CURRENT agent turn (one streamText run) — the same value
   * for every tool call within that run, a fresh value for the next one.
   * Threads into the pre-batch checkpoint's throttle (`deps.checkpoint`, Sprites
   * Platform Alignment 5-2): at most one checkpoint per turnId. Undefined → no
   * reliable turn boundary to key the throttle on, so checkpointing is skipped
   * for that call rather than guessed at.
   */
  turnId?: string;
}

export interface SandboxQuotaDeps {
  /** Reserve an in-process concurrency slot; false when the tier ceiling is hit. */
  acquireSlot: (args: { userId: string; tier: SubscriptionTier }) => boolean;
  releaseSlot: (args: { userId: string }) => void;
}

/**
 * Metering seam for a machine run's active-runtime cost (Terminal Epic 3).
 * Optional — omitting it disables metering (no hold, no charge), mirroring
 * every other optional seam in this file (`screenOutput`, `notifyShellActivity`).
 *
 * The hold->settle protocol mirrors the realtime voice recipe
 * (apps/realtime/src/voice/call-metering.ts): `gate` places a flat-estimate
 * hold BEFORE the machine is acquired (the real active-window duration isn't known
 * until the run ends); `trackUsage` settles the hold to the real cost and hands off
 * its release to the credit pipeline on a SUCCESSFUL run only; `releaseHold` is the
 * safety net for every other exit (denial, thrown error, timeout) so a failed run
 * never strands a hold against the payer's spendable balance.
 */
export interface SandboxBillingDeps {
  /**
   * Resolves who pays for THIS run (Terminal Epic 3 owner-pays) — from the
   * ACQUIRED SESSION's own `driveId`/`ownerId` (drive owner when it has one,
   * else the session's own owner), never the caller's surface drive or agent
   * page. The one seam payer resolution goes through; see `sandbox-payer.ts`'s
   * `resolveSessionPayerId` — the same rule `storageBillingTarget` applies for
   * storage attribution.
   */
  resolvePayerId: (input: { driveId: string | null; ownerId: string }) => Promise<string>;
  /** Places a flat-estimate hold for this payer before the machine run begins. */
  gate: (input: { payerId: string }) => Promise<{ allowed: boolean; holdId?: string; reason?: string }>;
  /**
   * Settles the hold to the real active-window cost. Only called on a
   * successful run. `pageId` is the AI-tool-runner path's calling-surface
   * agent page; `driveId` is the realtime shell bridge's session-level
   * attribution (a session is drive-scoped, not page-anchored) — a caller
   * sets whichever one its own model has, never both.
   */
  trackUsage: (input: {
    payerId: string;
    holdId?: string;
    activeSeconds: number;
    /** The referenced agent page, for the per-agent usage-breakdown grouping — purely descriptive, never the payer source. */
    pageId?: string;
    /** The session's own drive — first-class attribution so the usage breakdown can group terminal spend by drive without JSON forensics. Undefined for a global-assistant session. */
    driveId?: string;
    /** The `agent_workspaces.id` this run belongs to — first-class attribution, mirroring `driveId`. */
    workspaceId?: string;
  }) => Promise<void>;
  /** Releases a hold without billing. Called on every exit that never reaches `trackUsage`. */
  releaseHold: (holdId: string) => Promise<void>;
}

/**
 * A single bash command + its output, for streaming into the referenced
 * Terminal's live PTY/output feed (Terminal Epic 1 T1.5 activity visibility) —
 * so a human watching a Terminal page sees the agent's work as it happens.
 */
export interface ShellActivityNotification {
  /**
   * The session whose sandbox the agent acted on — `agent_workspaces.id`, NOT
   * the conversation id (post-unconflation the two are different namespaces:
   * one session hosts many conversations).
   *
   * This replaces the old `(tenantId, driveId, pageId)` machine tuple, which
   * had no successor and, worse, could not address a global-assistant session
   * at all: those have a null agent page, so the tuple's `pageId` gate silently
   * excluded them from the feed. Every session has this id.
   */
  workspaceId: string;
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
 * by sandboxId (mirrors `quota.ts`'s `sessionActivityByKey` — no persistence,
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

/** `acquireSandbox`'s request: everything the session-anchored acquire implementation needs to ensure the caller's agent-session sandbox. */
export interface AcquireSandboxRequest {
  tenantId: string;
  /** Absent for global (non-drive) contexts. */
  driveId?: string;
  userId: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  /**
   * The conversation this run belongs to — NOT the agent-session id
   * (contract.ts invariant 1: a session hosts MANY conversations, and the two
   * are different id namespaces post-unconflation). The session-anchored
   * `acquireSandbox` implementation resolves this conversation's session row
   * (`conversations.workspaceId`) and folds the Sprite key off THAT row's own
   * id, never off this one.
   */
  conversationId?: string;
}

export type SandboxAcquireResult =
  | {
      ok: true;
      sandboxId: string;
      resumed: boolean;
      /**
       * The SESSION the sandbox belongs to (`agent_workspaces.id`) — required,
       * because every post-run hook (storage measurement, shell-activity
       * notification) is keyed by it. The conversation id is NOT a substitute:
       * post-unconflation they are different namespaces, and keying the hooks
       * on the conversation silently no-oped measurement (underbilling) and
       * mis-addressed activity (codex review, P1).
       */
      workspaceId: string;
      pageId?: string;
    }
  | {
      ok: false;
      reason: SandboxToolDenialReason;
      cause?: unknown;
    };

export interface SandboxRunDeps {
  isEnabled: () => boolean;
  /** Ensures the caller's agent-session sandbox is provisioned and live (lifecycle deps already injected). */
  acquireSandbox: (input: AcquireSandboxRequest) => Promise<SandboxAcquireResult>;
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
  notifyShellActivity?: (input: ShellActivityNotification) => Promise<void>;
  /**
   * Optional metering seam (Terminal Epic 3): meters this run's active-runtime
   * cost against the machine's payer. Omitted -> unmetered (no hold, no charge).
   */
  billing?: SandboxBillingDeps;
  /**
   * Cheap resolve of the CALLER's session identity for billing attribution — a
   * read of the session row only (`agent_workspaces.driveId`/`ownerId`/`id`), no
   * sandbox provisioning. Called BEFORE the gate whenever `billing` is set, so
   * a credit-exhausted payer is denied without ever waking a hibernating
   * sandbox — the same fail-fast property the old (surface-derived, ctx-only)
   * payer resolution had, now backed by a real (if cheap) session read instead
   * of trusting client-influenceable context. Required whenever `billing` is
   * set; never called otherwise.
   *
   * Three outcomes:
   * - A session: gate against its payer as usual.
   * - `null` = the conversation will NEVER have a session on its own (a
   *   legacy pre-session thread, or one whose type never auto-provisions):
   *   nothing to gate against, so `withMachineBilling` falls through
   *   unmetered and lets `run()` surface the ordinary `no_session` denial.
   * - `{ deny }` = an implementation that auto-provisions a session (a
   *   Global Assistant conversation) attempted to and failed for a reason
   *   that is NOT safely "this will just deny again" — e.g. the owner's
   *   session cap was hit by a CONCURRENT call's spawn. Returning `null`
   *   here would be unsafe: `run()`'s own resolution moments later can
   *   still succeed if a racing sibling's claim lands in the interim
   *   (executing against the sibling's session), while this call already
   *   gave up on billing it — an unmetered execution. `{ deny }` fails the
   *   whole call closed instead of gambling that the second, independent
   *   resolution will agree with the first (review finding — P1, PR #2314,
   *   second pass, chatgpt-codex-connector).
   */
  resolveBillingSession?: (ctx: SandboxActorContext) => Promise<
    | { workspaceId: string; driveId: string | null; ownerId: string }
    | { deny: SandboxToolDenialReason }
    | null
  >;
  /**
   * Optional opportunistic storage-measurement seam (Sprites Platform Alignment
   * 6-1): while this sprite is ALREADY awake for this real op, capture its used
   * storage bytes (throttled, best-effort) so the storage reconcile can bill
   * MEASURED usage without ever waking a paused sprite. Best-effort — a failure
   * must never affect the tool result; omitting it disables measurement.
   */
  measureStorage?: (input: { sandbox: ExecutableSandbox; workspaceId: string }) => Promise<void>;
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

export function safeLogWarn(
  logger: SandboxRunDeps['logger'],
  message: string,
  metadata?: Record<string, unknown>,
): void {
  try { logger?.warn?.(message, metadata); } catch { /* Logging must not alter tool control flow. */ }
}

// Acquisition reasons that represent expected policy/authz outcomes (warn-level)
// vs infra failures that are genuinely unexpected (error-level).
// Refusals that are the system working as intended — logged at warn, because an
// error-level line for every free-tier user hitting their own plan ceiling is
// noise that trains the on-call to ignore this logger.
const AUTHZ_DENY_REASONS = new Set([
  'no_drive_access', 'insufficient_role', 'no_agent_access', 'tier_ineligible', 'kill_switch_off', 'no_machine',
  'session_runtime_exceeded', 'session_limit_reached',
  // A legacy conversation that predates sessions has no working context to run
  // in — an expected refusal (not an infra fault), so it belongs here rather
  // than paging on-call for every pre-session thread an agent tool touches.
  'no_session',
]);


export type SandboxToolDenialReason =
  | 'kill_switch_off'
  | 'tier_ineligible'
  | 'no_drive_access'
  | 'insufficient_role'
  | 'no_agent_access'
  | 'no_machine'
  | 'session_runtime_exceeded'
  | 'credit_exhausted'
  | 'concurrency_limit'
  | 'session_limit_reached'
  | 'empty_command'
  | 'command_too_large'
  | 'blocked_metadata_access'
  | 'github_over_bash'
  | 'path_escape'
  | 'content_too_large'
  | 'edit_no_match'
  | 'edit_not_unique'
  | 'no_session'
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
  | {
      success: true;
      path: string;
      content: string;
      /**
       * True when `content` is NOT the whole file — either the line window
       * ended before the last line, or the byte backstop cut it. Always
       * accompanied by `notice`, because a boolean in a JSON blob is not a
       * thing a model reliably acts on.
       */
      truncated: boolean;
      /** 1-based line numbers of the window actually returned. */
      firstLine: number;
      lastLine: number;
      /** Total lines in the file, so the caller can see what it is missing. */
      totalLines: number;
      /** Size of the WHOLE file on disk, not of `content`. */
      originalBytes: number;
      /** Present iff `truncated`: says what is missing and how to get it. */
      notice?: string;
    }
  | { success: false; error: string; reason: SandboxToolDenialReason };

export type EditFileToolResult =
  | { success: true; path: string; replacements: number }
  | { success: false; error: string; reason: SandboxToolDenialReason };

export const DENIAL_MESSAGES: Record<SandboxToolDenialReason, string> = {
  kill_switch_off: 'Code execution is disabled.',
  tier_ineligible: 'Running code requires a Pro plan or above.',
  no_drive_access: 'You do not have access to run code in this drive.',
  insufficient_role: 'Running code requires edit access to this drive.',
  no_agent_access: 'This agent is not permitted to run code in this drive.',
  no_machine: 'No machine is configured for this run.',
  session_runtime_exceeded:
    "This session's sandbox has been running continuously for too long. Wait for it to go idle, or switch to a different session.",
  credit_exhausted: 'Insufficient credits to run this machine.',
  concurrency_limit: 'Too many concurrent runs. Wait for a run to finish and retry.',
  // A different limit from `concurrency_limit`, and the distinction is the
  // whole point: that one clears on its own when a sibling run finishes, this
  // one does not clear until somebody ENDS a session. Telling an agent to
  // "wait and retry" for this one is telling it to spin forever.
  session_limit_reached:
    'The owner is at their plan limit for live agent sessions. Retrying will not help — an existing session has to be ended first.',
  empty_command: 'No command was provided.',
  command_too_large: 'The command is too large.',
  blocked_metadata_access: 'This command is blocked by policy.',
  github_over_bash:
    'The bash sandbox has no GitHub credentials. Use the dedicated git_*/gh_* tools for GitHub operations (e.g. git_clone, git_push, gh_pr_create) — they carry your connected GitHub auth.',
  path_escape: 'The path is invalid or escapes the sandbox root.',
  content_too_large: 'The file content is too large.',
  edit_no_match:
    'The oldString was not found in the file. Read the file and copy the exact text to replace. '
    + 'If you read a windowed page of a long file, the text you are targeting may be in a part you have not read yet.',
  edit_not_unique:
    'The oldString is not unique in the file. Add more surrounding context to pin the one you mean. '
    + 'The duplicate may be OUTSIDE the lines you read — readFile returns a window, but this match runs over the whole file, '
    + 'so read the rest before assuming replaceAll is safe: it would rewrite every occurrence, including ones you have not seen.',
  no_session:
    'This conversation has no session (workspace), so there is no sandbox to run in — it predates sessions. Start a new conversation to get one.',
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
    conversationId: ctx.conversationId,
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
async function safeNotifyShellActivity(
  deps: SandboxRunDeps,
  input: ShellActivityNotification,
): Promise<void> {
  if (!deps.notifyShellActivity) return;
  try {
    await deps.notifyShellActivity(input);
  } catch {
    // Intentionally swallowed.
  }
}

// Map a denial from the lifecycle acquire onto the tool-facing reason set.
/**
 * Narrow a generic acquisition failure to the specific thing that went wrong,
 * when the acquirer said. A plan-ceiling refusal arrives as `provision_failed`
 * with the ceiling named in `cause`; without this it reached the agent as
 * "Could not provision a sandbox for this run" — indistinguishable from a
 * provider outage, and so retried on a limit that no amount of retrying moves.
 */
export function reasonFromAcquire(result: Extract<SandboxAcquireResult, { ok: false }>): SandboxToolDenialReason {
  if (result.reason === 'provision_failed' && result.cause === 'session_limit_reached') {
    return 'session_limit_reached';
  }
  return result.reason;
}

const anomalyForExit = (exitCode: number): CodeExecutionAnomaly | undefined => {
  if (exitCode === 0) return undefined;
  // 128 + SIGKILL(9): the sandbox SIGKILLs on the timeout cap.
  return exitCode === 137 ? 'timeout' : 'nonzero_exit';
};

export type MeteredResult<S> =
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
 *
 * Exported so every sandbox tool-op runner (bash, write, read, edit, git/gh)
 * shares this ONE metering path rather than a per-runner copy — git/gh's own
 * runner going years without billing wired in was exactly a duplicated-acquire
 * path silently drifting from this one (review finding, PR #2314 follow-up,
 * issue #2315).
 */
export async function withMachineBilling<S>(
  ctx: SandboxActorContext,
  deps: SandboxRunDeps,
  run: () => Promise<MeteredResult<S>>,
): Promise<MeteredResult<S>> {
  const billing = deps.billing;
  if (!billing) return run();

  // Resolve the CALLER's session for billing attribution — a cheap session-row
  // read (no sandbox provisioning), so a credit-exhausted payer is denied
  // before any sandbox work happens: the same fail-fast property the old
  // surface-derived resolution had, now backed by the SESSION's own
  // driveId/ownerId instead of the caller's (client-influenceable) surface
  // drive/agent page — a session hosts MANY conversations, and its drive can
  // differ from the one the caller happens to be chatting from.
  //
  // See the three-outcome contract on `resolveBillingSession` above: `null`
  // is only safe when nothing could ever auto-provision here; `{ deny }`
  // fails the call closed rather than falling through to `run()`, whose own
  // independent resolution might still succeed against a session a
  // concurrent sibling call bound in the interim.
  const billingSession = deps.resolveBillingSession ? await deps.resolveBillingSession(ctx) : null;
  if (billingSession && 'deny' in billingSession) return fail(billingSession.deny);
  if (!billingSession) return run();

  const payerId = await billing.resolvePayerId({
    driveId: billingSession.driveId,
    ownerId: billingSession.ownerId,
  });
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
      await billing.trackUsage({
        payerId,
        holdId,
        activeSeconds,
        // Purely descriptive (which agent page this run was for) — never the
        // payer source, which is resolved from the session above.
        pageId: ctx.agentPageId,
        driveId: billingSession.driveId ?? undefined,
        workspaceId: billingSession.workspaceId,
      });
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
 *
 * Exported for the same reason as `withMachineBilling`: every sandbox-op
 * runner acquires through this ONE path, never a local copy.
 */
export async function openSession(
  ctx: SandboxActorContext,
  deps: SandboxRunDeps,
): Promise<
  | { ok: true; sandbox: ExecutableSandbox; workspaceId: string; release: () => void; pageId?: string }
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
      workspaceId: acquired.workspaceId,
      release: () => {
        deps.quota.releaseSlot({ userId: ctx.userId });
        // Opportunistic, throttled, best-effort storage measurement. Fired from
        // `release` — which the runners call in `finally` AFTER the op — so it
        // observes any bytes the op just wrote (measuring in openSession, before
        // the op, would persist the pre-write footprint and let the throttle
        // suppress the post-write one) and runs sequentially after the op rather
        // than contending with it. Never blocks or fails the op.
        // Keyed by the SESSION id the acquire resolved — the sandbox whose
        // bytes these are belongs to the session (not the agent page, and not
        // the conversation: both are different namespaces, and each has
        // silently excluded a class of sessions from measurement before).
        if (deps.measureStorage) {
          const workspaceId = acquired.workspaceId;
          void deps.measureStorage({ sandbox, workspaceId }).catch((error) => {
            safeLogWarn(deps.logger, 'Opportunistic storage measurement failed', {
              workspaceId,
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
    // Keyed by the SESSION id the acquire resolved: the sandbox this ran in
    // belongs to the session — not the agent page, and not the conversation
    // (a different id namespace; addressing the feed by it pointed every
    // notification at a session that does not exist).
    {
      // Fire-and-forget: this is a visibility nicety over a network hop to
      // another service, not a safety gate. Awaiting it would tie every
      // successful bash call's latency to the activity feed's availability (up
      // to its own request timeout) for no benefit — the tool result below does
      // not depend on it. safeNotifyShellActivity already swallows its own
      // errors, so this can never surface as an unhandled rejection.
      void safeNotifyShellActivity(deps, {
        workspaceId: session.workspaceId,
        command,
        output: [stdout.text, stderr.text].filter((text) => text.length > 0).join('\n'),
        exitCode: run.exitCode,
        // No display name is set for a plain email fallback — a raw email
        // address is PII and this feed is visible to everyone watching a shell
        // of this session, not just the acting user.
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

/**
 * Thousands separators without `toLocaleString()`, which depends on the process
 * locale — the notice text is asserted in tests and read by a model, so it must
 * not vary with the environment.
 */
function withThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The sentence a partial read MUST carry.
 *
 * `truncated: true` alone was the whole signal before, and it is not one a model
 * acts on: it is a boolean in a JSON blob next to the content it contradicts.
 * The notice rides INSIDE the payload for the same reason `shell-io.ts` frames
 * its cold/unreachable answers there — so truncation cannot be mistaken for the
 * file simply ending, and so the caller is told the exact next call.
 *
 * The editFile clause is the load-bearing one. `applyEdit` counts occurrences
 * across the ENTIRE file while this read shows a window, so an anchor that looks
 * unique here can collide with a line the caller never saw; without this warning
 * the natural recovery from `edit_not_unique` is `replaceAll: true`, which edits
 * the invisible region.
 */
export function buildReadTruncationNotice({
  path,
  window,
}: {
  path: string;
  window: {
    firstLine: number;
    lastLine: number;
    totalLines: number;
    bytesCapped: boolean;
    lineElided: boolean;
  };
}): string {
  const { firstLine, lastLine, totalLines, bytesCapped, lineElided } = window;
  const total = withThousands(totalLines);

  // Appended to EVERY variant: whichever way a read came back partial, the next
  // thing the caller usually does is an edit.
  const editWarning =
    ' Note that editFile matches oldString against the ENTIRE file, including lines not shown here —' +
    ' if an edit reports "not unique", the duplicate may be outside this window,' +
    ' so read more rather than reaching for replaceAll.';
  const elisionNote = lineElided
    ? ` Lines longer than ${withThousands(MAX_LINE_BYTES)} bytes are shown clipped, marked "${LINE_ELISION_MARKER.trim()}" —` +
      ' their full text is not here, so do not build an editFile anchor from a clipped line.'
    : '';

  // Overshot the file entirely — say where it actually ends, and do NOT also
  // claim "this is not the whole file"; nothing was returned to be partial.
  if (lastLine < firstLine) {
    return (
      `[No lines returned: offset ${firstLine} is past the end of ${path}, which has ${total} line${totalLines === 1 ? '' : 's'}.` +
      ` Re-read with a smaller offset.${editWarning}]`
    );
  }

  const shown = `Showing lines ${firstLine}-${lastLine} of ${total}`;
  const remaining = totalLines - lastLine;

  if (remaining > 0) {
    // `lastLine` is where the returned content genuinely ends — the byte budget
    // is applied per line during selection, never to the joined text after —
    // so this offset resumes exactly where this window stopped, with no gap.
    const why = bytesCapped
      ? ' This window was cut short by the output size limit rather than by the line count, so it is shorter than requested.'
      : '';
    return (
      `[${shown}. This is NOT the whole file — ${withThousands(remaining)} line${remaining === 1 ? '' : 's'} below this window` +
      ` ${remaining === 1 ? 'is' : 'are'} not shown. Continue with readFile({ path: "${path}", offset: ${lastLine + 1} }).` +
      `${why}${elisionNote}${editWarning}]`
    );
  }

  // Every line present and the window started at the top: the only thing that
  // made this partial is per-line clipping.
  if (firstLine === 1) {
    return `[${shown} — every line of the file is here, but at least one was too long to show in full.${elisionNote}${editWarning}]`;
  }

  // Reached the last line, but started past line 1: the tail is complete, the
  // head is missing. Saying "NOT the whole file" here would be misleading about
  // which end is absent.
  return (
    `[${shown} — this window reaches the end of the file, but lines 1-${firstLine - 1} are not shown.` +
    `${elisionNote}${editWarning}]`
  );
}

export async function readSandboxFile({
  path,
  offset,
  limit,
  ctx,
  deps,
}: {
  path: string;
  /** 1-based first line to return. Omit for the start of the file. */
  offset?: number;
  /** How many lines to return. Omit for DEFAULT_READ_LINES. */
  limit?: number;
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

  return withMachineBilling<Extract<ReadFileToolResult, { success: true }>>(ctx, deps, async () => {
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
    const originalBytes = Buffer.byteLength(screenedContent, 'utf8');

    // Both caps are applied INSIDE the windowing, so `window.lastLine` always
    // describes the line the returned content actually ends on. Capping the
    // joined text afterwards instead would cut mid-window while lastLine still
    // named the requested end, and the notice would then send the caller to an
    // offset well past the content, silently skipping everything in between.
    const window = selectLineWindow({
      text: screenedContent,
      offset,
      limit: limit ?? DEFAULT_READ_LINES,
      maxBytes: SANDBOX_MAX_OUTPUT_BYTES,
      maxLineBytes: MAX_LINE_BYTES,
    });
    const text = window.text;
    const truncated = window.windowed || window.lineElided;
    await safeAudit(deps, ctx, {
      code: `readFile ${path}`,
      exitCode: 0,
      durationMs,
    });
    return {
      success: true,
      path,
      content: text,
      truncated,
      firstLine: window.firstLine,
      lastLine: window.lastLine,
      totalLines: window.totalLines,
      originalBytes,
      ...(truncated
        ? { notice: buildReadTruncationNotice({ path, window }) }
        : {}),
    };
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
 *
 * The validated env is currently READ AND UNUSED — `SANDBOX_ENV_ALLOWLIST` is
 * empty, so `buildSandboxEnv` looks at none of it. Kept deliberately: this is
 * where the host env enters the sandbox path, and the day a key is allowlisted
 * this seam must hand over the VALIDATED value rather than a raw `process.env`
 * read. The one live effect meanwhile is that a broken env throws here — which,
 * in the web service, it would already have done long before any tool ran.
 */
export const defaultBuildEnv = (): Record<string, string> =>
  buildSandboxEnv({ env: getValidatedEnv() });
