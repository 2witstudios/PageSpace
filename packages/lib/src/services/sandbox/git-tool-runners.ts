import { SANDBOX_TIMEOUT_MS, SANDBOX_MAX_OUTPUT_BYTES } from './execution-policy';
import { truncateToBytes } from './output-limit';
import { SANDBOX_ROOT, resolveSandboxPath } from './sandbox-paths';
import type { SandboxActorContext, SandboxRunDeps, BashToolResult } from './tool-runners';

export interface GitSandboxRunDeps extends SandboxRunDeps {
  /** Fetches the user's GitHub OAuth access token from their integration connection. */
  resolveGitHubToken: (userId: string) => Promise<string | null>;
}

export type GitToolResult = BashToolResult;

const GITHUB_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f';

/**
 * Where `gh` keeps its durable config (hosts.yml, prefs, cached auth state).
 *
 * MUST live on the persistent disk — NOT `/tmp`, which the Sprites platform
 * wipes on ANY pause (https://docs.sprites.dev/concepts/lifecycle/ — "disk
 * persists, memory does not"; `/tmp` is scratch). The ENTIRE Sprite filesystem
 * is durable, so any non-`/tmp` path survives pause/wake.
 *
 * It must ALSO sit OUTSIDE the sandbox workspace root (SANDBOX_ROOT =
 * `/workspace`). The agent git tools default `git_clone` / `git_init` to
 * SANDBOX_ROOT itself when no `path` is given
 * (apps/web/src/lib/ai/tools/sandbox-git-tools.ts) — so a config dir anywhere
 * under `/workspace` would make the root non-empty and break a no-path clone
 * (git refuses a non-empty destination) or get swept into a `git init` +
 * `git add .`. We therefore anchor it in the Sprite user's persistent home
 * (`/home/sprite`, per https://docs.sprites.dev/working-with-sprites/), which
 * is durable, writable by the running `sprite` user, gh auto-creates it on
 * first write, and it is never a git destination.
 */
export const GH_CONFIG_DIR = '/home/sprite/.gh-config';

/**
 * Pure builder for the environment passed to a single in-sprite git/gh
 * invocation.
 *
 * Given the base sandbox env and (optionally) a resolved GitHub token, returns
 * the full env map. Invariants:
 * - GH_CONFIG_DIR is rooted on the persistent disk so gh config survives
 *   pause/wake; no value references `/tmp`.
 * - GIT_TERMINAL_PROMPT/GIT_CONFIG_NOSYSTEM are always set.
 * - Token vars (GH_TOKEN, GITHUB_TOKEN) and the one-shot credential-helper git
 *   config are added ONLY when a token is present. The token is injected per
 *   command (never persisted to the config dir), which keeps auth pause-proof
 *   by construction.
 */
export function buildGitToolEnv({
  baseEnv,
  token,
}: {
  baseEnv: Record<string, string>;
  token: string | null;
}): Record<string, string> {
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GH_CONFIG_DIR,
    ...(token
      ? {
          GH_TOKEN: token,
          GITHUB_TOKEN: token,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: GITHUB_CREDENTIAL_HELPER,
        }
      : {}),
  };
}

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
 * - GH_CONFIG_DIR points at the persistent sandbox disk (not /tmp, which is
 *   wiped on any pause) so gh config survives pause/wake — see GH_CONFIG_DIR.
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

  // A provided working directory must stay inside the sandbox root — mirror the
  // bash path. Validate BEFORE acquiring a slot so a bad cwd consumes no quota.
  let resolvedCwd: string = SANDBOX_ROOT;
  if (cwd !== undefined) {
    const candidate = resolveSandboxPath(cwd);
    if (!candidate) {
      return {
        success: false,
        error: 'The path is invalid or escapes the sandbox root.',
        reason: 'path_escape',
      };
    }
    resolvedCwd = candidate;
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
      userId: ctx.userId,
      requestOrigin: ctx.requestOrigin,
      agentPageId: ctx.agentPageId,
      activeMachine: ctx.activeMachine,
      // Mirrors `acquireRequest` on the bash/file path (tool-runners.ts): a
      // branch-scoped run must attach to the BRANCH's Sprite. Omitting it here
      // silently ran every bound conversation's git against the machine root.
      branchSandbox: ctx.branchSandbox,
      // Same for a PROMOTED project (issue #2204 phase 7): its repo lives on
      // its own Sprite, so git must attach there, not to the machine root.
      projectSandbox: ctx.projectSandbox,
    });
    if (!acquired.ok) {
      return { success: false, error: 'Could not provision a sandbox.', reason: 'provision_failed' };
    }

    const sandbox = await deps.reconnect(acquired.sandboxId);
    if (!sandbox) {
      return { success: false, error: 'Could not provision a sandbox.', reason: 'provision_failed' };
    }

    const startedAt = deps.now();

    let run: { exitCode: number; stdout: string; stderr: string };
    try {
      run = await sandbox.runCommand({
        cmd,
        args,
        cwd: resolvedCwd,
        env: buildGitToolEnv({ baseEnv: deps.buildEnv(), token }),
        timeoutMs: SANDBOX_TIMEOUT_MS,
        maxBytes: SANDBOX_MAX_OUTPUT_BYTES,
      });
    } catch {
      const durationMs = deps.now().getTime() - startedAt.getTime();
      await safeAudit(deps, ctx, { cmd: `${cmd} ${args.join(' ')}`, exitCode: null, durationMs });
      return { success: false, error: 'Command execution failed or timed out.', reason: 'execution_failed' };
    }

    const durationMs = deps.now().getTime() - startedAt.getTime();
    // Injection seam (fail-open): screen untrusted git/gh stdout+stderr (fetched
    // commit messages, file contents, PR bodies, etc.) BEFORE truncation, same as
    // the bash runner. The screen owns its own fail-open behavior; never blocks.
    const screenedStdout = deps.screenOutput ? await deps.screenOutput(run.stdout) : run.stdout;
    const screenedStderr = deps.screenOutput ? await deps.screenOutput(run.stderr) : run.stderr;
    const stdout = truncateToBytes({ text: screenedStdout, maxBytes: SANDBOX_MAX_OUTPUT_BYTES });
    const stderr = truncateToBytes({ text: screenedStderr, maxBytes: SANDBOX_MAX_OUTPUT_BYTES });

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
