import { SANDBOX_TIMEOUT_MS, SANDBOX_MAX_OUTPUT_BYTES } from './execution-policy';
import { truncateToBytes } from './output-limit';
import { SANDBOX_ROOT } from './sandbox-paths';
import type { SandboxActorContext, SandboxRunDeps, BashToolResult } from './tool-runners';

export interface GitSandboxRunDeps extends SandboxRunDeps {
  /** Fetches the user's GitHub OAuth access token from their integration connection. */
  resolveGitHubToken: (userId: string) => Promise<string | null>;
}

export type GitToolResult = BashToolResult;

const GITHUB_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f';

/**
 * Runs a git or gh command inside a sandbox.
 *
 * Security invariants:
 * - cmd is a literal ('git' or 'gh'), never built by string concatenation.
 * - args is a string[], never passed through a shell.
 * - Token appears in env for this one runCommand call only — not persisted,
 *   not logged, not included in returned output.
 * - Git receives the token through a one-shot credential helper configured via
 *   env-only git config, so HTTPS remotes work without putting the token in argv.
 * - GIT_CONFIG_NOSYSTEM prevents system gitconfig credential caching.
 * - GH_CONFIG_DIR isolates gh config from the persistent sandbox home dir.
 * - GIT_TERMINAL_PROMPT=0 prevents git from blocking on a credential prompt.
 */
export async function runGitInSandbox({
  cmd,
  args,
  cwd,
  ctx,
  deps,
  preResolvedToken,
}: {
  cmd: 'git' | 'gh';
  args: string[];
  cwd?: string;
  ctx: SandboxActorContext;
  deps: GitSandboxRunDeps;
  /** If provided, skip the DB token lookup (avoids a double-fetch when the caller already resolved it). */
  preResolvedToken?: string | null;
}): Promise<GitToolResult> {
  if (!deps.isEnabled()) {
    return { success: false, error: 'Code execution is disabled.', reason: 'kill_switch_off' };
  }

  // Pre-fetch token BEFORE acquiring a sandbox slot — a missing token on a
  // network-requiring command must not consume quota.
  const token =
    preResolvedToken !== undefined
      ? preResolvedToken
      : await deps.resolveGitHubToken(ctx.userId);

  if (!deps.quota.acquireSlot({ userId: ctx.userId, tier: ctx.tier })) {
    return {
      success: false,
      error: 'Too many concurrent runs. Wait for a run to finish and retry.',
      reason: 'concurrency_limit',
    };
  }

  // Slot held — every exit path below must release it.
  try {
    const acquired = await deps.acquireSandbox({
      tenantId: ctx.tenantId,
      driveId: ctx.driveId,
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      requestOrigin: ctx.requestOrigin,
      agentPageId: ctx.agentPageId,
    });
    if (!acquired.ok) {
      return { success: false, error: 'Could not provision a sandbox.', reason: 'provision_failed' };
    }

    const sandbox = await deps.reconnect(acquired.sandboxId);
    if (!sandbox) {
      return { success: false, error: 'Could not provision a sandbox.', reason: 'provision_failed' };
    }

    const resolvedCwd = cwd ?? SANDBOX_ROOT;
    const startedAt = deps.now();

    let run: { exitCode: number; stdout: string; stderr: string };
    try {
      run = await sandbox.runCommand({
        cmd,
        args,
        cwd: resolvedCwd,
        env: {
          ...deps.buildEnv(),
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GH_CONFIG_DIR: '/tmp/gh-config',
          ...(token
            ? {
                GH_TOKEN: token,
                GITHUB_TOKEN: token,
                GIT_CONFIG_COUNT: '1',
                GIT_CONFIG_KEY_0: 'credential.helper',
                GIT_CONFIG_VALUE_0: GITHUB_CREDENTIAL_HELPER,
              }
            : {}),
        },
        timeoutMs: SANDBOX_TIMEOUT_MS,
        maxBytes: SANDBOX_MAX_OUTPUT_BYTES,
      });
    } catch {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      await safeAudit(deps, ctx, { cmd: `${cmd} ${args.join(' ')}`, exitCode: null, durationMs });
      return { success: false, error: 'Command execution failed or timed out.', reason: 'execution_failed' };
    }

    const durationMs = deps.now().getTime() - startedAt.getTime();
    const stdout = truncateToBytes({ text: run.stdout, maxBytes: SANDBOX_MAX_OUTPUT_BYTES });
    const stderr = truncateToBytes({ text: run.stderr, maxBytes: SANDBOX_MAX_OUTPUT_BYTES });

    await safeAudit(deps, ctx, {
      cmd: `${cmd} ${args.join(' ')}`,
      exitCode: run.exitCode,
      durationMs,
    });

    return {
      success: true,
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: run.exitCode,
      truncated: stdout.truncated || stderr.truncated,
    };
  } finally {
    deps.quota.releaseSlot({ userId: ctx.userId });
  }
}

async function safeAudit(
  deps: GitSandboxRunDeps,
  ctx: SandboxActorContext,
  fields: { cmd: string; exitCode: number | null; durationMs: number },
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
      code: fields.cmd,
      exitCode: fields.exitCode,
      durationMs: fields.durationMs,
    });
  } catch {
    // Fire-and-forget — audit failure must not break the run.
  }
}
