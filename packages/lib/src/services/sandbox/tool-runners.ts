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
 *   3. quota — advisory non-incrementing preflight, then a real concurrency
 *      reservation, then the single real per-run budget charge;
 *   4. `acquireConversationSandbox` (authz + lifecycle, re-authz on resume) and
 *      reconnect to the executable handle;
 *   5. run / write / read against the injected sandbox client;
 *   6. truncate untrusted output to the policy cap;
 *   7. audit every executed run (and every blocked command); and
 *   8. release the concurrency slot in `finally`, always.
 *
 * All IO — the sandbox acquire/reconnect, the quota ops, the audit writer, the
 * clock, the kill-switch read, the env builder — is injected, so the whole
 * orchestration is unit-tested with fakes and never touches the real Vercel API
 * or the database. Pure policy (`resolveExecutionPolicy`, `evaluateCommandPolicy`,
 * `resolveSandboxPath`, `truncateToBytes`) is called directly.
 */

import type { SubscriptionTier } from '../subscription-utils';
import { resolveExecutionPolicy, type ExecutionPolicy } from './execution-policy';
import { evaluateCommandPolicy } from './command-policy';
import { truncateToBytes } from './output-limit';
import { resolveSandboxPath, SANDBOX_ROOT } from './sandbox-paths';
import { buildSandboxEnv } from './sandbox-env';
import { getValidatedEnv } from '../../config/env-validation';
import type { AcquireSandboxInput, AcquireSandboxResult } from './session-manager';
import { SandboxReadLimitError, type ExecutableSandbox, type SandboxRunResult } from './sandbox-client/types';
import type { CodeExecutionQuotaDecision } from './quota';
import type { CodeExecutionAuditInput, CodeExecutionAnomaly } from './audit';

/** Largest file body a single `writeFile` may submit, in bytes. */
export const MAX_WRITE_BYTES = 1024 * 1024;

/** Everything the runners need about the actor + AI attribution for a turn. */
export interface SandboxActorContext {
  userId: string;
  tenantId: string;
  driveId: string;
  conversationId: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  actorEmail: string;
  actorDisplayName?: string;
  aiProvider?: string;
  aiModel?: string;
  tier: SubscriptionTier;
  profile?: 'default' | 'minimal';
}

export interface SandboxQuotaDeps {
  /** Reserve an in-process concurrency slot; false when the tier ceiling is hit. */
  acquireSlot: (args: { userId: string; tier: SubscriptionTier }) => boolean;
  releaseSlot: (args: { userId: string }) => void;
  /** Non-incrementing advisory read across user/drive/tenant scopes. */
  preflight: (args: {
    userId: string;
    driveId: string;
    tenantId?: string;
    tier: SubscriptionTier;
  }) => Promise<CodeExecutionQuotaDecision>;
  /** The single real budget charge for an allowed run (increments every scope). */
  charge: (args: { userId: string; driveId: string; tenantId?: string }) => Promise<void>;
}

export interface SandboxRunDeps {
  isEnabled: () => boolean;
  /** Pre-bound `acquireConversationSandbox` (lifecycle deps already injected). */
  acquireSandbox: (input: Omit<AcquireSandboxInput, 'deps'>) => Promise<AcquireSandboxResult>;
  /** Reconnect to the executable handle for an acquired sandbox id. */
  reconnect: (sandboxId: string) => Promise<ExecutableSandbox | null>;
  quota: SandboxQuotaDeps;
  buildEnv: () => Record<string, string>;
  audit: (input: CodeExecutionAuditInput) => Promise<void>;
  now: () => Date;
}

export type SandboxToolDenialReason =
  | 'kill_switch_off'
  | 'no_drive_access'
  | 'insufficient_role'
  | 'no_agent_access'
  | 'concurrency_limit'
  | 'rate_limited'
  | 'empty_command'
  | 'command_too_large'
  | 'blocked_metadata_access'
  | 'path_escape'
  | 'content_too_large'
  | 'provision_failed'
  | 'execution_failed'
  | 'not_found'
  | 'error';

export type BashToolResult =
  | { success: true; stdout: string; stderr: string; exitCode: number; truncated: boolean }
  | { success: false; error: string; reason: SandboxToolDenialReason; retryAfter?: number };

export type WriteFileToolResult =
  | { success: true; path: string; bytesWritten: number }
  | { success: false; error: string; reason: SandboxToolDenialReason; retryAfter?: number };

export type ReadFileToolResult =
  | { success: true; path: string; content: string; truncated: boolean }
  | { success: false; error: string; reason: SandboxToolDenialReason; retryAfter?: number };

const DENIAL_MESSAGES: Record<SandboxToolDenialReason, string> = {
  kill_switch_off: 'Code execution is disabled.',
  no_drive_access: 'You do not have access to run code in this drive.',
  insufficient_role: 'Running code requires drive owner or admin access.',
  no_agent_access: 'This agent is not permitted to run code in this drive.',
  concurrency_limit: 'Too many concurrent runs. Wait for a run to finish and retry.',
  rate_limited: 'Daily code-execution budget reached. Try again later.',
  empty_command: 'No command was provided.',
  command_too_large: 'The command is too large.',
  blocked_metadata_access: 'This command is blocked by policy.',
  path_escape: 'The path is invalid or escapes the sandbox root.',
  content_too_large: 'The file content is too large.',
  provision_failed: 'Could not provision a sandbox for this run.',
  execution_failed: 'Command execution failed or timed out.',
  not_found: 'File not found.',
  error: 'Code execution could not be completed.',
};

function fail(
  reason: SandboxToolDenialReason,
  retryAfter?: number,
): { success: false; error: string; reason: SandboxToolDenialReason; retryAfter?: number } {
  return { success: false, error: DENIAL_MESSAGES[reason], reason, ...(retryAfter ? { retryAfter } : {}) };
}

function acquireRequest(
  ctx: SandboxActorContext,
  policy: ExecutionPolicy,
): Omit<AcquireSandboxInput, 'deps'> {
  return {
    tenantId: ctx.tenantId,
    driveId: ctx.driveId,
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    requestOrigin: ctx.requestOrigin,
    agentPageId: ctx.agentPageId,
    policy,
  };
}

// Audit is forensic and fire-and-forget: a failing audit sink must never break
// the run (or the denial) it records.
async function safeAudit(
  deps: SandboxRunDeps,
  ctx: SandboxActorContext,
  fields: {
    profile: ExecutionPolicy['profile'];
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
      driveId: ctx.driveId,
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

// Map a denial from the lifecycle acquire onto the tool-facing reason set.
function reasonFromAcquire(result: Extract<AcquireSandboxResult, { ok: false }>): SandboxToolDenialReason {
  switch (result.reason) {
    case 'no_drive_access':
    case 'insufficient_role':
    case 'no_agent_access':
    case 'provision_failed':
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

/**
 * Shared preamble: enforce quota and acquire a live, authorized executable
 * sandbox. Returns the handle plus a `release` thunk the caller MUST invoke in
 * `finally`, or a denial (with the slot already released). The kill-switch and
 * any op-specific policy (command / path) are checked by the caller BEFORE this,
 * so a policy-blocked op never reaches quota or provisioning.
 */
async function openSession(
  ctx: SandboxActorContext,
  policy: ExecutionPolicy,
  deps: SandboxRunDeps,
): Promise<
  | { ok: true; sandbox: ExecutableSandbox; release: () => void }
  | { ok: false; reason: SandboxToolDenialReason; retryAfter?: number }
> {
  const pre = await deps.quota.preflight({
    userId: ctx.userId,
    driveId: ctx.driveId,
    tenantId: ctx.tenantId,
    tier: ctx.tier,
  });
  if (!pre.allowed) {
    return { ok: false, reason: pre.reason, retryAfter: pre.retryAfter };
  }
  if (!deps.quota.acquireSlot({ userId: ctx.userId, tier: ctx.tier })) {
    return { ok: false, reason: 'concurrency_limit' };
  }

  // Slot is held from here: every failure path must release it before returning.
  try {
    const acquired = await deps.acquireSandbox(acquireRequest(ctx, policy));
    if (!acquired.ok) {
      deps.quota.releaseSlot({ userId: ctx.userId });
      return { ok: false, reason: reasonFromAcquire(acquired) };
    }
    const sandbox = await deps.reconnect(acquired.sandboxId);
    if (!sandbox) {
      deps.quota.releaseSlot({ userId: ctx.userId });
      return { ok: false, reason: 'provision_failed' };
    }
    // Charge only once a live, authorized sandbox is in hand — a denied authz or
    // a failed provision never consumes the daily budget.
    await deps.quota.charge({ userId: ctx.userId, driveId: ctx.driveId, tenantId: ctx.tenantId });
    return { ok: true, sandbox, release: () => deps.quota.releaseSlot({ userId: ctx.userId }) };
  } catch {
    deps.quota.releaseSlot({ userId: ctx.userId });
    return { ok: false, reason: 'error' };
  }
}

export async function runBashInSandbox({
  command,
  cwd,
  ctx,
  deps,
}: {
  command: string;
  cwd?: string;
  ctx: SandboxActorContext;
  deps: SandboxRunDeps;
}): Promise<BashToolResult> {
  if (!deps.isEnabled()) return fail('kill_switch_off');
  const policy = resolveExecutionPolicy({ profile: ctx.profile });

  const commandPolicy = evaluateCommandPolicy({ command });
  if (!commandPolicy.ok) {
    await safeAudit(deps, ctx, {
      profile: policy.profile,
      code: command,
      exitCode: null,
      durationMs: 0,
      anomaly: 'blocked_command',
    });
    return fail(commandPolicy.reason);
  }

  // A provided working directory must also stay inside the sandbox root. A blocked
  // escape is audited as an anomaly (like writeFile/readFile path escapes) so every
  // denied sandbox-escape attempt is logged before returning.
  let resolvedCwd: string = SANDBOX_ROOT;
  if (cwd !== undefined) {
    const candidate = resolveSandboxPath(cwd);
    if (!candidate) {
      await safeAudit(deps, ctx, {
        profile: policy.profile,
        code: `cd ${cwd} && ${command}`,
        exitCode: null,
        durationMs: 0,
        anomaly: 'blocked_command',
      });
      return fail('path_escape');
    }
    resolvedCwd = candidate;
  }

  const session = await openSession(ctx, policy, deps);
  if (!session.ok) return fail(session.reason, session.retryAfter);

  try {
    const startedAt = deps.now();
    let run: SandboxRunResult;
    try {
      run = await session.sandbox.runCommand({
        cmd: 'sh',
        args: ['-c', command],
        cwd: resolvedCwd,
        env: deps.buildEnv(),
        timeoutMs: policy.timeoutMs,
        maxBytes: policy.maxOutputBytes,
      });
    } catch {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      await safeAudit(deps, ctx, {
        profile: policy.profile,
        code: command,
        exitCode: null,
        durationMs,
        anomaly: 'timeout',
      });
      return fail('execution_failed');
    }

    const durationMs = deps.now().getTime() - startedAt.getTime();
    const stdout = truncateToBytes({ text: run.stdout, maxBytes: policy.maxOutputBytes });
    const stderr = truncateToBytes({ text: run.stderr, maxBytes: policy.maxOutputBytes });
    await safeAudit(deps, ctx, {
      profile: policy.profile,
      code: command,
      exitCode: run.exitCode,
      durationMs,
      anomaly: anomalyForExit(run.exitCode),
    });
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
  const policy = resolveExecutionPolicy({ profile: ctx.profile });

  const resolved = resolveSandboxPath(path);
  if (!resolved) {
    await safeAudit(deps, ctx, {
      profile: policy.profile,
      code: `writeFile ${path}`,
      exitCode: null,
      durationMs: 0,
      anomaly: 'blocked_command',
    });
    return fail('path_escape');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WRITE_BYTES) return fail('content_too_large');

  const session = await openSession(ctx, policy, deps);
  if (!session.ok) return fail(session.reason, session.retryAfter);

  try {
    const startedAt = deps.now();
    try {
      await session.sandbox.writeFiles([{ path: resolved, content }]);
    } catch {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      await safeAudit(deps, ctx, {
        profile: policy.profile,
        code: `writeFile ${path}`,
        exitCode: null,
        durationMs,
        anomaly: 'nonzero_exit',
      });
      return fail('execution_failed');
    }
    const durationMs = deps.now().getTime() - startedAt.getTime();
    await safeAudit(deps, ctx, {
      profile: policy.profile,
      code: `writeFile ${path} (${bytes} bytes)`,
      exitCode: 0,
      durationMs,
    });
    return { success: true, path, bytesWritten: bytes };
  } finally {
    session.release();
  }
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
  const policy = resolveExecutionPolicy({ profile: ctx.profile });

  const resolved = resolveSandboxPath(path);
  if (!resolved) {
    await safeAudit(deps, ctx, {
      profile: policy.profile,
      code: `readFile ${path}`,
      exitCode: null,
      durationMs: 0,
      anomaly: 'blocked_command',
    });
    return fail('path_escape');
  }

  const session = await openSession(ctx, policy, deps);
  if (!session.ok) return fail(session.reason, session.retryAfter);

  try {
    const startedAt = deps.now();
    let buffer: Buffer | null;
    try {
      // Pass the output cap so the driver refuses an oversized file BEFORE pulling
      // it into the host process — the cap bounds host memory, not just the
      // rendered output (a malicious sandbox could otherwise OOM the app process).
      buffer = await session.sandbox.readFileToBuffer({ path: resolved, maxBytes: policy.maxOutputBytes });
    } catch (error) {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      const tooLarge = error instanceof SandboxReadLimitError;
      await safeAudit(deps, ctx, {
        profile: policy.profile,
        code: `readFile ${path}`,
        exitCode: null,
        durationMs,
        anomaly: tooLarge ? 'blocked_command' : 'nonzero_exit',
      });
      return fail(tooLarge ? 'content_too_large' : 'execution_failed');
    }
    const durationMs = deps.now().getTime() - startedAt.getTime();
    if (buffer === null) {
      await safeAudit(deps, ctx, {
        profile: policy.profile,
        code: `readFile ${path}`,
        exitCode: 1,
        durationMs,
        anomaly: 'nonzero_exit',
      });
      return fail('not_found');
    }
    const { text, truncated } = truncateToBytes({
      text: buffer.toString('utf8'),
      maxBytes: policy.maxOutputBytes,
    });
    await safeAudit(deps, ctx, {
      profile: policy.profile,
      code: `readFile ${path}`,
      exitCode: 0,
      durationMs,
    });
    return { success: true, path, content: text, truncated };
  } finally {
    session.release();
  }
}

/**
 * Default env builder used by the production tool wrappers. This is the effect
 * seam that sources the validated env from the global and hands it to the pure
 * `buildSandboxEnv`, keeping the allowlist construction itself IO-free.
 */
export const defaultBuildEnv = (): Record<string, string> =>
  buildSandboxEnv({ env: getValidatedEnv() });
