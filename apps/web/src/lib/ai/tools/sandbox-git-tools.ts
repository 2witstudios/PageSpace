/**
 * Agent git/GitHub tools: all 56 tools running inside a sandbox.
 *
 * Pure factory — no DB imports, no Sprites SDK. Production wiring lives in
 * `sandbox-git-tools-runtime.ts`. Each tool's execute handler:
 *   1. Validates input (defense-in-depth; schema validation happens at the AI layer).
 *   2. Resolves the actor context.
 *   3. Runs the call-time gate (same gate as bash/writeFile/readFile).
 *   4. For remote/gh tools: pre-checks the GitHub token (fails fast, no quota).
 *   5. Delegates to `runGitInSandbox` with cmd + args[] (never sh -c).
 *
 * Security: cmd is always a literal ('git' or 'gh'). Args are string[]. No
 * shell interpolation is possible. Token is injected per-command by the
 * runner, never persisted.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { SandboxActorContext } from '@pagespace/lib/services/sandbox/tool-runners';
import type { GitSandboxRunDeps } from '@pagespace/lib/services/sandbox/git-tool-runners';
import { runGitInSandbox } from '@pagespace/lib/services/sandbox/git-tool-runners';
import { resolveSandboxPath, SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';
import {
  MAX_PATH_LENGTH,
  machineAccessDeniedError,
  resolveActiveMachine,
  type MachineDirectoryDeps,
  type ResolveSandboxContext,
  type SandboxGate,
} from './sandbox-tools';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';
import type { ToolExecutionContext } from '../core/types';
import { evaluatePushGuard } from './sandbox-git/core/refspec';
import {
  validateFlagSafe,
  validateShaOnly,
  validateWorkflowInputNames,
  validateRepoName,
  assertHttps,
} from './sandbox-git/core/validators';
import {
  buildCloneArgs,
  buildInitArgs,
  buildConfigArgs,
  buildRemoteAddArgs,
} from './sandbox-git/core/command-specs/repo';
import {
  buildStatusArgs,
  buildDiffArgs,
  buildAddArgs,
  buildResetArgs,
  buildStashArgs,
} from './sandbox-git/core/command-specs/worktree';
import {
  buildCommitArgs,
  buildLogArgs,
  buildShowArgs,
  buildBlameArgs,
  buildMergeArgs,
  buildRebaseArgs,
  buildRevertArgs,
  buildCheckoutArgs,
  buildBranchArgs,
} from './sandbox-git/core/command-specs/history';
import { buildFetchArgs, buildPullArgs, buildPushArgs } from './sandbox-git/core/command-specs/remote';
import {
  buildPrCreateArgs,
  buildPrListArgs,
  buildPrViewArgs,
  buildPrDiffArgs,
  buildPrChecksArgs,
  buildPrMergeArgs,
  buildPrCheckoutArgs,
  buildPrReviewArgs,
  buildPrReviewCommentArgs,
  buildPrCommentArgs,
  buildPrEditArgs,
  buildPrUpdateBranchArgs,
  buildPrThreadListArgs,
  buildPrThreadResolveArgs,
  buildPrCloseArgs,
  buildPrReopenArgs,
  buildPrReadyArgs,
} from './sandbox-git/core/command-specs/pr';
import {
  buildRunListArgs,
  buildRunViewArgs,
  buildRunRerunArgs,
  buildWorkflowListArgs,
  buildWorkflowRunArgs,
} from './sandbox-git/core/command-specs/actions';
import {
  buildIssueCreateArgs,
  buildIssueListArgs,
  buildIssueViewArgs,
  buildIssueCommentArgs,
  buildIssueEditArgs,
  buildIssueCloseArgs,
  buildIssueReopenArgs,
} from './sandbox-git/core/command-specs/issues';
import {
  buildRepoViewArgs,
  buildRepoListArgs,
  buildRepoForkArgs,
  buildRepoCreateArgs,
  buildSearchArgs,
  buildLabelListArgs,
} from './sandbox-git/core/command-specs/repos-search';

// Optional per-call working directory, relative to the sandbox root (/workspace).
// Each tool call is a fresh process, so cwd never persists between calls — pass it
// to operate inside a cloned subdirectory. The runner validates it (path_escape).
const cwdField = z.string().max(MAX_PATH_LENGTH).optional();

// Tool names returned by createSandboxGitTools, kept next to the factory so a
// new tool is one glance away from being added here too. Consumed by
// tool-filtering.ts to detect whether the sandbox git/gh toolkit is active —
// checked against the factory's return keys in this file's own test suite.
export const SANDBOX_GIT_TOOL_NAMES: readonly string[] = [
  'git_clone', 'git_init', 'git_config', 'git_remote_add', 'git_status', 'git_diff',
  'git_add', 'git_reset', 'git_stash', 'git_commit', 'git_log', 'git_show', 'git_blame',
  'git_merge', 'git_rebase', 'git_revert', 'git_checkout', 'git_branch',
  'git_fetch', 'git_pull', 'git_push',
  'gh_pr_create', 'gh_pr_list', 'gh_pr_view', 'gh_pr_diff', 'gh_pr_checks', 'gh_pr_merge',
  'gh_pr_checkout', 'gh_pr_review', 'gh_pr_review_comment', 'gh_pr_comment', 'gh_pr_edit',
  'gh_pr_update_branch', 'gh_pr_thread_list', 'gh_pr_thread_resolve', 'gh_pr_close',
  'gh_pr_reopen', 'gh_pr_ready',
  'gh_run_list', 'gh_run_view', 'gh_run_rerun', 'gh_workflow_list', 'gh_workflow_run',
  'gh_issue_create', 'gh_issue_list', 'gh_issue_view', 'gh_issue_comment', 'gh_issue_edit',
  'gh_issue_close', 'gh_issue_reopen',
  'gh_repo_view', 'gh_repo_list', 'gh_repo_fork', 'gh_repo_create',
  'gh_search', 'gh_label_list',
];

export interface GitSandboxToolsDeps {
  gitRunDeps: GitSandboxRunDeps;
  resolveContext: ResolveSandboxContext;
  gate: SandboxGate;
  machines: MachineDirectoryDeps;
}

function readContext(options: unknown): ToolExecutionContext | undefined {
  return (options as { experimental_context?: ToolExecutionContext })?.experimental_context;
}

const NO_CONNECTION_ERROR = {
  success: false as const,
  error:
    'No GitHub connection found. Connect your GitHub account in Settings → Integrations to use remote git operations.',
  reason: 'error' as const,
};

export function createSandboxGitTools({ gitRunDeps, resolveContext, gate, machines }: GitSandboxToolsDeps): Record<string, Tool> {
  /**
   * Resolve context + gate check shared by every tool. Also resolves the
   * ACTIVE machine and threads it onto ctx — the same seam bash/file tools
   * use in sandbox-tools.ts, so git commands run against the same active
   * machine as the rest of the terminal tool group.
   */
  const open = async (
    options: unknown,
  ): Promise<
    | { ok: true; userId: string; ctx: SandboxActorContext & { activeMachine: MachineRef } }
    | { ok: false; error: { success: false; error: string } }
  > => {
    const rawContext = readContext(options);
    const ctx = await resolveContext(rawContext);
    if ('error' in ctx) return { ok: false, error: { success: false, error: ctx.error } };
    const decision = await gate(ctx);
    if (!decision.ok) return { ok: false, error: { success: false, error: decision.error } };
    // resolveActiveMachine re-verifies access on EVERY call, mirroring
    // sandbox-tools.ts — the actual execution boundary must not trust a
    // machine reference that was accessible only at a past switch_machine
    // call (OWASP A01).
    const resolution = await resolveActiveMachine(rawContext, machines);
    if (!resolution) {
      return {
        ok: false,
        error: {
          success: false,
          error: 'Terminal access is not enabled for this agent. Ask an admin to turn on Terminal Access in this agent\'s settings.',
        },
      };
    }
    if (!resolution.access.allowed) {
      return { ok: false, error: machineAccessDeniedError(resolution.access, resolution.machine) };
    }
    const activeMachine = resolution.machine;
    // Mirror sandbox-tools.ts's driveId/tenantId resolution: an 'existing'
    // machine can reference a Terminal page outside the ambient drive/tenant
    // (global assistant, or a switched active machine in a shared drive).
    // Leaving these ambient would derive a different session key here than
    // bash/writeFile/readFile derive for the SAME active machine.
    const driveId = machines.resolveDriveId
      ? await machines.resolveDriveId(rawContext, activeMachine, ctx.driveId)
      : ctx.driveId;
    const tenantId = machines.resolveTenantId
      ? await machines.resolveTenantId(rawContext, activeMachine, ctx.tenantId)
      : ctx.tenantId;
    return { ok: true, userId: ctx.userId, ctx: { ...ctx, driveId, tenantId, activeMachine } };
  };

  /** Direct-exec helper for local git commands (no token needed). */
  const git = (cmd: 'git' | 'gh', args: string[], ctx: SandboxActorContext, cwd?: string) =>
    runGitInSandbox({ cmd, args, cwd, ctx, deps: gitRunDeps });

  /**
   * Resolves `git_clone`/`git_init`'s optional destination `path` (defaulting to
   * `SANDBOX_ROOT`), returning a ready-made `path_escape` denial on failure —
   * the only two tools here that take a destination `path` rather than a `cwd`.
   */
  const resolveDestinationPath = (
    path: string | undefined,
  ): { ok: true; path: string } | { ok: false; error: { success: false; error: string; reason: 'path_escape' } } => {
    const resolved = path !== undefined ? resolveSandboxPath(path) : SANDBOX_ROOT;
    if (!resolved) {
      return {
        ok: false,
        error: { success: false, error: 'The path is invalid or escapes the sandbox root.', reason: 'path_escape' },
      };
    }
    return { ok: true, path: resolved };
  };

  /**
   * For remote/gh tools: pre-checks the GitHub token before opening a sandbox.
   * Passes the already-resolved token to `runGitInSandbox` to avoid a second DB fetch.
   */
  const withToken = async (
    options: unknown,
    run: (ctx: SandboxActorContext, token: string) => Promise<unknown>,
  ) => {
    const opened = await open(options);
    if (!opened.ok) return opened.error;
    const token = await gitRunDeps.resolveGitHubToken(opened.userId);
    if (!token) return NO_CONNECTION_ERROR;
    return run(opened.ctx, token);
  };

  /** Remote-exec helper: passes the pre-resolved token to skip the second DB lookup. */
  const gitR = (
    cmd: 'git' | 'gh',
    args: string[],
    ctx: SandboxActorContext,
    token: string,
    cwd?: string,
  ) => runGitInSandbox({ cmd, args, cwd, ctx, deps: gitRunDeps, preResolvedToken: token });

  // ── Repo + config ───────────────────────────────────────────────────────

  const gitClone = tool({
    description:
      'Clone a GitHub repository into the sandbox. Use HTTPS URLs only. Fetches all branch refs (even with depth) so later-created branches get proper origin tracking refs — required for git_push -u and gh_pr_create to work.',
    inputSchema: z.object({
      repo_url: z
        .string()
        .url()
        .refine(
          (u) => assertHttps(u, 'git clone').ok,
          'Only HTTPS URLs are supported (e.g. https://github.com/owner/repo.git)',
        ),
      path: z.string().optional(),
      depth: z.number().int().positive().optional(),
    })
      .strict(),
    execute: async ({ repo_url, path, depth }, options) => {
      const https = assertHttps(repo_url, 'git clone');
      if (!https.ok) return { success: false as const, error: https.error };
      const resolved = resolveDestinationPath(path);
      if (!resolved.ok) return resolved.error;
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildCloneArgs({ repoUrl: repo_url, path: resolved.path, depth }), opened.ctx);
    },
  });

  const gitInit = tool({
    description: 'Initialize a new git repository in the sandbox.',
    inputSchema: z.object({ path: z.string().optional() }).strict(),
    execute: async ({ path }, options) => {
      const resolved = resolveDestinationPath(path);
      if (!resolved.ok) return resolved.error;
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildInitArgs(resolved.path), opened.ctx);
    },
  });

  const gitConfig = tool({
    description: 'Set a git config value.',
    inputSchema: z.object({
      key: z.string().min(1),
      value: z.string(),
      global: z.boolean().optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ key, value, global: isGlobal, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildConfigArgs({ key, value, global: isGlobal }), opened.ctx, cwd);
    },
  });

  const gitRemoteAdd = tool({
    description: 'Add a remote to the repository. Use HTTPS URLs only.',
    inputSchema: z.object({
      name: z.string().min(1),
      url: z
        .string()
        .url()
        .refine((u) => assertHttps(u, 'git remote add').ok, 'Only HTTPS remote URLs are supported'),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ name, url, cwd }, options) => {
      const https = assertHttps(url, 'git remote add');
      if (!https.ok) return { success: false as const, error: https.error };
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildRemoteAddArgs({ name, url }), opened.ctx, cwd);
    },
  });

  // ── Working tree ────────────────────────────────────────────────────────

  const gitStatus = tool({
    description: 'Show the working tree status in porcelain format.',
    inputSchema: z.object({ path: z.string().optional(), cwd: cwdField }).strict(),
    execute: async ({ path, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildStatusArgs(path), opened.ctx, cwd);
    },
  });

  const gitDiff = tool({
    description:
      'Show changes in the working tree, staged changes, or between two refs. Pass base + head to diff between branches/commits (e.g. base: "origin/master", head: "HEAD"). Uses three-dot diff (merge-base to head) so only changes unique to head are shown. Falls back to working-tree diff when neither is given.',
    inputSchema: z
      .object({
        staged: z.boolean().optional(),
        path: z.string().optional(),
        base: z
          .string()
          .optional()
          .describe('Base ref to diff from (e.g. "origin/master", "HEAD~1")'),
        head: z
          .string()
          .optional()
          .describe('Head ref to diff to (defaults to HEAD when base is given)'),
        cwd: cwdField,
      })
      .strict()
      .refine((d) => !d.head || d.base, {
        message: 'head requires base — diffing to a head ref without a base has no meaning',
      })
      .refine((d) => !d.staged || !d.base, {
        message: 'staged and base are mutually exclusive — use staged for --cached or base for ref diff',
      }),
    execute: async ({ staged, path, base, head, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildDiffArgs({ staged, path, base, head }), opened.ctx, cwd);
    },
  });

  const gitAdd = tool({
    description: 'Stage files for commit.',
    inputSchema: z
      .object({ paths: z.array(z.string()).optional(), all: z.boolean().optional(), cwd: cwdField })
      .strict()
      .refine((d) => d.all || (d.paths && d.paths.length > 0), {
        message: 'Provide paths or set all: true',
      }),
    execute: async ({ paths, all, cwd }, options) => {
      if (!all && (!paths || paths.length === 0)) {
        return { success: false as const, error: 'Provide paths or set all: true' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildAddArgs({ paths, all }), opened.ctx, cwd);
    },
  });

  const gitReset = tool({
    description: 'Reset HEAD to a given ref.',
    inputSchema: z.object({
      mode: z.enum(['soft', 'mixed', 'hard']),
      ref: z.string().optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ mode, ref, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildResetArgs({ mode, ref }), opened.ctx, cwd);
    },
  });

  const gitStash = tool({
    description: 'Stash, pop, list, or drop the stash.',
    inputSchema: z.object({
      action: z.enum(['push', 'pop', 'list', 'drop']),
      message: z.string().optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ action, message, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildStashArgs({ action, message }), opened.ctx, cwd);
    },
  });

  // ── Commits, history, branching ─────────────────────────────────────────

  const gitCommit = tool({
    description: 'Create a commit with the given message.',
    inputSchema: z.object({
      message: z.string().min(1),
      amend: z.boolean().optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ message, amend, cwd }, options) => {
      if (!message) {
        return { success: false as const, error: 'commit message is required' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildCommitArgs({ message, amend }), opened.ctx, cwd);
    },
  });

  const gitLog = tool({
    description: 'Show commit history. Defaults to last 20 commits in oneline format.',
    inputSchema: z.object({
      n: z.number().int().positive().max(100).optional(),
      path: z.string().optional(),
      oneline: z.boolean().optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ n, path, oneline, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildLogArgs({ n, path, oneline }), opened.ctx, cwd);
    },
  });

  const gitShow = tool({
    description:
      'Show a commit: message, author, and full diff (or --stat summary). Use with SHAs from git_log.',
    inputSchema: z
      .object({
        ref: z.string().min(1).optional().describe('Commit SHA or ref (defaults to HEAD)'),
        stat: z.boolean().optional().describe('Show a diffstat summary instead of the full patch'),
        path: z.string().optional().describe('Limit output to a single file path'),
        cwd: cwdField,
      })
      .strict()
      .refine((d) => d.ref === undefined || validateFlagSafe(d.ref, 'ref').ok, {
        message: 'ref must not start with "-"',
      }),
    execute: async ({ ref, stat, path, cwd }, options) => {
      if (ref !== undefined) {
        const safe = validateFlagSafe(ref, 'ref');
        if (!safe.ok) return { success: false as const, error: safe.error };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildShowArgs({ ref, stat, path }), opened.ctx, cwd);
    },
  });

  const gitBlame = tool({
    description: 'Show which commit and author last modified each line of a file.',
    inputSchema: z
      .object({
        path: z.string().min(1),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
        cwd: cwdField,
      })
      .strict()
      .refine((d) => (d.start_line === undefined) === (d.end_line === undefined), {
        message: 'start_line and end_line must be provided together',
      }),
    execute: async ({ path, start_line, end_line, cwd }, options) => {
      if ((start_line === undefined) !== (end_line === undefined)) {
        return { success: false as const, error: 'start_line and end_line must be provided together' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildBlameArgs({ path, start_line, end_line }), opened.ctx, cwd);
    },
  });

  const gitMerge = tool({
    description:
      'Merge a branch. If a previous merge stopped on conflicts, use action "abort" to back out or "continue" after resolving.',
    inputSchema: z
      .object({
        branch: z.string().min(1).optional().describe('Branch to merge (required unless aborting/continuing)'),
        strategy: z.enum(['merge', 'squash', 'ff-only']).optional(),
        action: z
          .enum(['run', 'abort', 'continue'])
          .optional()
          .describe('run (default) merges a branch; abort/continue recover a conflicted merge'),
        cwd: cwdField,
      })
      .strict()
      .refine((d) => (d.action ?? 'run') !== 'run' || !!d.branch, {
        message: 'branch is required when running a merge',
      })
      .refine((d) => d.branch === undefined || validateFlagSafe(d.branch, 'branch').ok, {
        message: 'branch must not start with "-"',
      }),
    execute: async ({ branch, strategy, action, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      if ((action ?? 'run') === 'run') {
        if (!branch) {
          return { success: false as const, error: 'branch is required when running a merge' };
        }
        const safe = validateFlagSafe(branch, 'branch');
        if (!safe.ok) return { success: false as const, error: safe.error };
      }
      return git('git', buildMergeArgs({ branch, strategy, action }), opened.ctx, cwd);
    },
  });

  const gitRebase = tool({
    description:
      'Rebase onto a branch or ref. Non-interactive only. If a previous rebase stopped on conflicts, use action "abort" to back out or "continue" after resolving.',
    inputSchema: z
      .object({
        branch_or_ref: z
          .string()
          .min(1)
          .optional()
          .describe('Branch or ref to rebase onto (required unless aborting/continuing)'),
        action: z
          .enum(['run', 'abort', 'continue'])
          .optional()
          .describe('run (default) starts a rebase; abort/continue recover a conflicted rebase'),
        cwd: cwdField,
      })
      .strict()
      .refine((d) => (d.action ?? 'run') !== 'run' || !!d.branch_or_ref, {
        message: 'branch_or_ref is required when running a rebase',
      })
      .refine((d) => d.branch_or_ref === undefined || validateFlagSafe(d.branch_or_ref, 'branch_or_ref').ok, {
        message: 'branch_or_ref must not start with "-"',
      }),
    execute: async ({ branch_or_ref, action, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      if ((action ?? 'run') === 'run') {
        if (!branch_or_ref) {
          return { success: false as const, error: 'branch_or_ref is required when running a rebase' };
        }
        const safe = validateFlagSafe(branch_or_ref, 'branch_or_ref');
        if (!safe.ok) return { success: false as const, error: safe.error };
      }
      return git('git', buildRebaseArgs({ branch_or_ref, action }), opened.ctx, cwd);
    },
  });

  const gitRevert = tool({
    description:
      'Revert a single commit by creating a new commit that undoes it. Safe forward-fix — history is not rewritten. Takes one commit SHA (no ranges). If a previous revert stopped on conflicts, use action "abort" to back out or "continue" after resolving. Reverting a merge commit requires "mainline" (the parent number to revert to).',
    inputSchema: z
      .object({
        sha: z
          .string()
          .refine((v) => validateShaOnly(v).ok, 'sha must be a single lowercase commit SHA (no ranges or refs)')
          .optional()
          .describe('Commit to revert (required unless aborting/continuing)'),
        action: z
          .enum(['run', 'abort', 'continue'])
          .optional()
          .describe('run (default) reverts a commit; abort/continue recover a conflicted revert'),
        mainline: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Parent number to revert to; required when sha is a merge commit'),
        cwd: cwdField,
      })
      .strict()
      .refine((d) => (d.action ?? 'run') !== 'run' || !!d.sha, {
        message: 'sha is required when running a revert',
      }),
    execute: async ({ sha, action, mainline, cwd }, options) => {
      // In run mode, validate the sha BEFORE opening a sandbox (no quota spent on
      // a bad ref). abort/continue take no positional and skip sha validation.
      if ((action ?? 'run') === 'run') {
        if (!sha) {
          return {
            success: false as const,
            error: 'sha must be a single lowercase commit SHA (no ranges or refs)',
          };
        }
        const shaOk = validateShaOnly(sha);
        if (!shaOk.ok) return { success: false as const, error: shaOk.error };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildRevertArgs({ sha, action, mainline }), opened.ctx, cwd);
    },
  });

  const gitCheckout = tool({
    description: 'Switch branches or create a new one.',
    inputSchema: z
      .object({ ref: z.string().min(1), create: z.boolean().optional(), cwd: cwdField })
      .strict(),
    execute: async ({ ref, create, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildCheckoutArgs({ ref, create }), opened.ctx, cwd);
    },
  });

  const gitBranch = tool({
    description: 'List, create, or delete branches.',
    inputSchema: z
      .object({ action: z.enum(['list', 'create', 'delete']), name: z.string().optional(), cwd: cwdField })
      .strict()
      .refine((d) => d.action === 'list' || !!d.name, { message: 'name required for create/delete' }),
    execute: async ({ action, name, cwd }, options) => {
      if ((action === 'create' || action === 'delete') && !name) {
        return { success: false as const, error: 'name is required for create/delete' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', buildBranchArgs({ action, name }), opened.ctx, cwd);
    },
  });

  // ── Remote sync (token required) ────────────────────────────────────────

  const gitFetch = tool({
    description: 'Fetch from a remote. Requires a connected GitHub account.',
    inputSchema: z
      .object({ remote: z.string().optional(), branch: z.string().optional(), cwd: cwdField })
      .strict(),
    execute: async ({ remote, branch, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('git', buildFetchArgs({ remote, branch }), ctx, token, cwd),
      ),
  });

  const gitPull = tool({
    description: 'Pull from a remote. Requires a connected GitHub account.',
    inputSchema: z.object({
      remote: z.string().optional(),
      branch: z.string().optional(),
      rebase: z.boolean().optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ remote, branch, rebase, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('git', buildPullArgs({ remote, branch, rebase }), ctx, token, cwd),
      ),
  });

  const gitPush = tool({
    description:
      'Push to a remote. Requires a connected GitHub account. cwd defaults to /workspace — pass it to push from a cloned subdir. Force-push (--force-with-lease) is allowed on feature/PR branches but refused for the default branch (main/master); to update an open PR, push to its branch rather than opening a new one. Note: pushes touching .github/workflows files require a GitHub connection made after workflow permissions were added — ask the user to reconnect GitHub in Settings → Integrations if GitHub refuses the push.',
    inputSchema: z.object({
      remote: z.string().optional(),
      branch: z.string().optional(),
      force: z.boolean().optional(),
      set_upstream: z.boolean().optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ remote, branch, force, set_upstream, cwd }, options) => {
      // The force/delete/default-branch decision is the security core, extracted
      // to sandbox-git/core/refspec.ts and exhaustively branch-tested there.
      const guard = evaluatePushGuard({ force, branch });
      if (!guard.ok) {
        return { success: false as const, error: guard.error };
      }
      return withToken(options, (ctx, token) =>
        gitR('git', buildPushArgs({ remote, branch, force, set_upstream }), ctx, token, cwd),
      );
    },
  });

  // ── GitHub PRs (token required) ─────────────────────────────────────────

  const ghPrCreate = tool({
    description:
      'Create a pull request. Requires a connected GitHub account. head defaults to the current branch; pass it to name the PR head branch explicitly (bypasses the local upstream-tracking check).',
    inputSchema: z.object({
      title: z.string().min(1),
      body: z.string(),
      base: z.string().optional(),
      head: z.string().optional(),
      draft: z.boolean().optional(),
      labels: z.array(z.string()).optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ title, body, base, head, draft, labels, cwd }, options) => {
      if (!title) {
        return { success: false as const, error: 'title is required' };
      }
      return withToken(options, (ctx, token) =>
        gitR('gh', buildPrCreateArgs({ title, body, base, head, draft, labels }), ctx, token, cwd),
      );
    },
  });

  const ghPrList = tool({
    description: 'List pull requests. Requires a connected GitHub account.',
    inputSchema: z.object({
      state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
      limit: z.number().int().positive().max(100).optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ state, limit, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildPrListArgs({ state, limit }), ctx, token, cwd),
      ),
  });

  const ghPrView = tool({
    description: 'View a pull request with CI status, review state, and file change counts. Requires a connected GitHub account.',
    inputSchema: z
      .object({ number: z.number().int().positive().optional(), cwd: cwdField })
      .strict(),
    execute: async ({ number, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildPrViewArgs(number), ctx, token, cwd),
      ),
  });

  const ghPrDiff = tool({
    description:
      'Get the server-side diff for a pull request. Always merge-base correct, unaffected by local clone depth. Prefer this over git_diff for PR review. Requires a connected GitHub account.',
    inputSchema: z
      .object({ number: z.number().int().positive().optional(), cwd: cwdField })
      .strict(),
    execute: async ({ number, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildPrDiffArgs(number), ctx, token, cwd),
      ),
  });

  const ghPrChecks = tool({
    description:
      'List CI check statuses for a pull request (name, state, link). Each check is PASS/FAIL/PENDING/SKIP. Requires a connected GitHub account.',
    inputSchema: z
      .object({ number: z.number().int().positive().optional(), cwd: cwdField })
      .strict(),
    execute: async ({ number, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildPrChecksArgs(number), ctx, token, cwd),
      ),
  });

  const ghPrMerge = tool({
    description: 'Merge a pull request. Requires a connected GitHub account.',
    inputSchema: z.object({
      number: z.number().int().positive().optional(),
      strategy: z.enum(['merge', 'squash', 'rebase']),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ number, strategy, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildPrMergeArgs({ number, strategy }), ctx, token, cwd),
      ),
  });

  const ghPrCheckout = tool({
    description: 'Check out a pull request locally. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive(), cwd: cwdField }).strict(),
    execute: async ({ number, cwd }, options) =>
      withToken(options, (ctx, token) => gitR('gh', buildPrCheckoutArgs(number), ctx, token, cwd)),
  });

  const ghPrReview = tool({
    description:
      'Submit a review on a pull request: approve, request changes, or leave a comment. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        number: z.number().int().positive(),
        action: z.enum(['approve', 'request_changes', 'comment']),
        body: z.string().optional().describe('Review body / comment text'),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ number, action, body, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildPrReviewArgs({ number, action, body }), ctx, token, cwd),
      ),
  });

  const ghPrReviewComment = tool({
    description:
      'Add a review comment on a pull request. For inline comments: provide path, commit_id, and line. For file-level comments: provide path, commit_id, and subject_type "file". For replies: provide in_reply_to (comment ID) and body only. Use head sha from gh_pr_view for commit_id. Requires a connected GitHub account.',
    inputSchema: z.object({
      number: z.number().int().positive(),
      body: z.string().min(1),
      path: z.string().optional(),
      line: z.number().int().positive().optional(),
      side: z.enum(['LEFT', 'RIGHT']).optional(),
      commit_id: z.string().optional(),
      start_line: z.number().int().positive().optional(),
      start_side: z.enum(['LEFT', 'RIGHT']).optional(),
      in_reply_to: z.number().int().positive().optional(),
      subject_type: z.enum(['line', 'file']).optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async (
      { number, body, path, line, side, commit_id, start_line, start_side, in_reply_to, subject_type, cwd },
      options,
    ) => {
      if (!body) {
        return { success: false as const, error: 'body is required' };
      }
      return withToken(options, (ctx, token) =>
        gitR(
          'gh',
          buildPrReviewCommentArgs({ number, body, path, line, side, commit_id, start_line, start_side, in_reply_to, subject_type }),
          ctx,
          token,
          cwd,
        ),
      );
    },
  });

  const ghPrComment = tool({
    description:
      'Add a top-level conversation comment on a pull request (not a review). For inline code comments use gh_pr_review_comment; to approve/request changes use gh_pr_review. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        number: z.number().int().positive(),
        body: z.string().min(1),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ number, body, cwd }, options) => {
      if (!body) {
        return { success: false as const, error: 'body is required' };
      }
      return withToken(options, (ctx, token) =>
        gitR('gh', buildPrCommentArgs({ number, body }), ctx, token, cwd),
      );
    },
  });

  const ghPrEdit = tool({
    description:
      'Edit a pull request: title, body, base branch, labels, or reviewers. Use to keep the PR description current as follow-up commits land. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        number: z.number().int().positive(),
        title: z.string().optional(),
        body: z.string().optional(),
        base: z.string().optional().describe('New base branch'),
        add_labels: z.array(z.string()).optional(),
        remove_labels: z.array(z.string()).optional(),
        add_reviewers: z.array(z.string()).optional().describe('GitHub usernames to request review from'),
        cwd: cwdField,
      })
      .strict()
      .refine(
        (d) =>
          d.title !== undefined ||
          d.body !== undefined ||
          d.base !== undefined ||
          !!d.add_labels?.length ||
          !!d.remove_labels?.length ||
          !!d.add_reviewers?.length,
        { message: 'Provide at least one field to edit' },
      ),
    execute: async ({ number, title, body, base, add_labels, remove_labels, add_reviewers, cwd }, options) => {
      if (
        title === undefined &&
        body === undefined &&
        base === undefined &&
        !add_labels?.length &&
        !remove_labels?.length &&
        !add_reviewers?.length
      ) {
        return { success: false as const, error: 'Provide at least one field to edit' };
      }
      return withToken(options, (ctx, token) =>
        gitR('gh', buildPrEditArgs({ number, title, body, base, add_labels, remove_labels, add_reviewers }), ctx, token, cwd),
      );
    },
  });

  const ghPrUpdateBranch = tool({
    description:
      'Update a pull request branch with the latest changes from its base branch (like the "Update branch" button). Requires a connected GitHub account.',
    inputSchema: z
      .object({ number: z.number().int().positive(), cwd: cwdField })
      .strict(),
    execute: async ({ number, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildPrUpdateBranchArgs(number), ctx, token, cwd),
      ),
  });

  const ghPrThreadList = tool({
    description:
      'List review threads on a pull request with their resolved state and thread IDs. Use the thread id with gh_pr_thread_resolve after addressing feedback. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        owner: z.string().min(1).describe('Repository owner'),
        repo: z.string().min(1).describe('Repository name'),
        number: z.number().int().positive(),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ owner, repo, number, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildPrThreadListArgs({ owner, repo, number }), ctx, token, cwd),
      ),
  });

  const ghPrThreadResolve = tool({
    description:
      'Resolve a pull request review thread after its feedback has been addressed. Get thread IDs from gh_pr_thread_list. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        thread_id: z.string().min(1).describe('Review thread node ID from gh_pr_thread_list'),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ thread_id, cwd }, options) => {
      if (!thread_id) {
        return { success: false as const, error: 'thread_id is required' };
      }
      return withToken(options, (ctx, token) =>
        gitR('gh', buildPrThreadResolveArgs(thread_id), ctx, token, cwd),
      );
    },
  });

  const ghPrClose = tool({
    description: 'Close a pull request with an optional comment. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        number: z.number().int().positive(),
        comment: z.string().optional().describe('Comment to post when closing'),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ number, comment, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildPrCloseArgs({ number, comment }), ctx, token, cwd),
      ),
  });

  const ghPrReopen = tool({
    description: 'Reopen a closed pull request. Requires a connected GitHub account.',
    inputSchema: z
      .object({ number: z.number().int().positive(), cwd: cwdField })
      .strict(),
    execute: async ({ number, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildPrReopenArgs(number), ctx, token, cwd),
      ),
  });

  const ghPrReady = tool({
    description: 'Mark a draft pull request as ready for review. Requires a connected GitHub account.',
    inputSchema: z
      .object({ number: z.number().int().positive(), cwd: cwdField })
      .strict(),
    execute: async ({ number, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildPrReadyArgs(number), ctx, token, cwd),
      ),
  });

  // ── GitHub Actions / CI ───────────────────────────────────────────────

  const ghRunList = tool({
    description:
      'List GitHub Actions workflow runs. Use to check CI status after pushing or to find failing runs. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        branch: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
        status: z.enum(['queued', 'in_progress', 'completed']).optional(),
        event: z.string().optional().describe('Filter by trigger event (e.g. "pull_request", "push")'),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ branch, limit, status, event, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildRunListArgs({ branch, limit, status, event }), ctx, token, cwd),
      ),
  });

  const ghRunView = tool({
    description:
      'View details of a specific GitHub Actions run including job-level pass/fail status. Pass log: true to include logs for failed jobs (can be large). Requires a connected GitHub account.',
    inputSchema: z
      .object({
        runId: z.number().int().positive().describe('Run databaseId from gh_run_list'),
        log: z.boolean().optional().describe('Include logs for failed jobs'),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ runId, log, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildRunViewArgs({ runId, log }), ctx, token, cwd),
      ),
  });

  const ghRunRerun = tool({
    description:
      'Re-run a GitHub Actions workflow run. Pass failed_only: true to re-run only the failed jobs (the usual choice for flaky CI). Requires a connected GitHub account.',
    inputSchema: z
      .object({
        runId: z.number().int().positive().describe('Run databaseId from gh_run_list'),
        failed_only: z.boolean().optional().describe('Re-run only the failed jobs'),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ runId, failed_only, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildRunRerunArgs({ runId, failed_only }), ctx, token, cwd),
      ),
  });

  const ghWorkflowList = tool({
    description: 'List GitHub Actions workflows in the repository. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        limit: z.number().int().positive().max(100).optional(),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ limit, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildWorkflowListArgs(limit), ctx, token, cwd),
      ),
  });

  const ghWorkflowRun = tool({
    description:
      'Dispatch a GitHub Actions workflow run on a ref. WARNING: this triggers real automation (deploys, releases, jobs) — only dispatch workflows you understand. The workflow must have a workflow_dispatch trigger. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        workflow: z.string().min(1).describe('Workflow file name (e.g. "ci.yml") or ID'),
        ref: z.string().min(1).describe('Branch or tag to run the workflow on'),
        inputs: z
          .record(z.string(), z.string())
          .optional()
          .describe('workflow_dispatch inputs as key/value pairs'),
        cwd: cwdField,
      })
      .strict()
      .refine((d) => validateWorkflowInputNames(d.inputs).ok, {
        message: 'input names must be alphanumeric/_/-',
      }),
    execute: async ({ workflow, ref, inputs, cwd }, options) => {
      if (!workflow || !ref) {
        return { success: false as const, error: 'workflow and ref are required' };
      }
      const safe = validateFlagSafe(workflow, 'workflow');
      if (!safe.ok) return { success: false as const, error: safe.error };
      const inputsOk = validateWorkflowInputNames(inputs);
      if (!inputsOk.ok) return { success: false as const, error: inputsOk.error };
      return withToken(options, (ctx, token) =>
        gitR('gh', buildWorkflowRunArgs({ workflow, ref, inputs }), ctx, token, cwd),
      );
    },
  });

  // ── GitHub Issues (token required) ──────────────────────────────────────

  const ghIssueCreate = tool({
    description: 'Create an issue. Requires a connected GitHub account.',
    inputSchema: z.object({
      title: z.string().min(1),
      body: z.string(),
      labels: z.array(z.string()).optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ title, body, labels, cwd }, options) => {
      if (!title) {
        return { success: false as const, error: 'title is required' };
      }
      return withToken(options, (ctx, token) =>
        gitR('gh', buildIssueCreateArgs({ title, body, labels }), ctx, token, cwd),
      );
    },
  });

  const ghIssueList = tool({
    description: 'List issues. Requires a connected GitHub account.',
    inputSchema: z.object({
      state: z.enum(['open', 'closed', 'all']).optional(),
      limit: z.number().int().positive().max(100).optional(),
      cwd: cwdField,
    })
      .strict(),
    execute: async ({ state, limit, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildIssueListArgs({ state, limit }), ctx, token, cwd),
      ),
  });

  const ghIssueView = tool({
    description: 'View an issue. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive(), cwd: cwdField }).strict(),
    execute: async ({ number, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildIssueViewArgs(number), ctx, token, cwd),
      ),
  });

  const ghIssueComment = tool({
    description: 'Add a comment to an issue. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        number: z.number().int().positive(),
        body: z.string().min(1),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ number, body, cwd }, options) => {
      if (!body) {
        return { success: false as const, error: 'body is required' };
      }
      return withToken(options, (ctx, token) =>
        gitR('gh', buildIssueCommentArgs({ number, body }), ctx, token, cwd),
      );
    },
  });

  const ghIssueEdit = tool({
    description:
      'Edit an issue: title, body, labels, or assignees. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        number: z.number().int().positive(),
        title: z.string().optional(),
        body: z.string().optional(),
        add_labels: z.array(z.string()).optional(),
        remove_labels: z.array(z.string()).optional(),
        add_assignees: z.array(z.string()).optional().describe('GitHub usernames to assign'),
        remove_assignees: z.array(z.string()).optional().describe('GitHub usernames to unassign'),
        cwd: cwdField,
      })
      .strict()
      .refine(
        (d) =>
          d.title !== undefined ||
          d.body !== undefined ||
          !!d.add_labels?.length ||
          !!d.remove_labels?.length ||
          !!d.add_assignees?.length ||
          !!d.remove_assignees?.length,
        { message: 'Provide at least one field to edit' },
      ),
    execute: async (
      { number, title, body, add_labels, remove_labels, add_assignees, remove_assignees, cwd },
      options,
    ) => {
      if (
        title === undefined &&
        body === undefined &&
        !add_labels?.length &&
        !remove_labels?.length &&
        !add_assignees?.length &&
        !remove_assignees?.length
      ) {
        return { success: false as const, error: 'Provide at least one field to edit' };
      }
      return withToken(options, (ctx, token) =>
        gitR('gh', buildIssueEditArgs({ number, title, body, add_labels, remove_labels, add_assignees, remove_assignees }), ctx, token, cwd),
      );
    },
  });

  const ghIssueClose = tool({
    description:
      'Close an issue with an optional comment and reason. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        number: z.number().int().positive(),
        comment: z.string().optional().describe('Comment to post when closing'),
        reason: z.enum(['completed', 'not_planned']).optional(),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ number, comment, reason, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildIssueCloseArgs({ number, comment, reason }), ctx, token, cwd),
      ),
  });

  const ghIssueReopen = tool({
    description: 'Reopen a closed issue. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive(), cwd: cwdField }).strict(),
    execute: async ({ number, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildIssueReopenArgs(number), ctx, token, cwd),
      ),
  });

  // ── GitHub repos, search, labels (token required) ───────────────────────

  const ghRepoView = tool({
    description:
      'View a repository: default branch, visibility, and description. Use before cloning to discover the default branch instead of guessing main/master. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        repo: z.string().optional().describe('Repository as "owner/repo" (defaults to the repo in cwd)'),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ repo, cwd }, options) => {
      if (repo !== undefined) {
        const safe = validateFlagSafe(repo, 'repo');
        if (!safe.ok) return { success: false as const, error: safe.error };
      }
      return withToken(options, (ctx, token) =>
        gitR('gh', buildRepoViewArgs(repo), ctx, token, cwd),
      );
    },
  });

  const ghRepoList = tool({
    description:
      'List repositories for the connected account or a given owner/org. Use to discover repos to clone. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        owner: z.string().optional().describe('User or org to list repos for (defaults to the connected account)'),
        limit: z.number().int().positive().max(100).optional(),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ owner, limit, cwd }, options) => {
      if (owner !== undefined) {
        const safe = validateFlagSafe(owner, 'owner');
        if (!safe.ok) return { success: false as const, error: safe.error };
      }
      return withToken(options, (ctx, token) =>
        gitR('gh', buildRepoListArgs({ owner, limit }), ctx, token, cwd),
      );
    },
  });

  const ghRepoFork = tool({
    description:
      'Fork a repository to the connected account (fork only — clone it explicitly with git_clone afterwards). Use to contribute to repos without push access. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        repo: z.string().min(1).describe('Repository to fork as "owner/repo"'),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ repo, cwd }, options) => {
      if (!repo) {
        return { success: false as const, error: 'repo is required' };
      }
      const safe = validateFlagSafe(repo, 'repo');
      if (!safe.ok) return { success: false as const, error: safe.error };
      return withToken(options, (ctx, token) =>
        gitR('gh', buildRepoForkArgs(repo), ctx, token, cwd),
      );
    },
  });

  const ghRepoCreate = tool({
    description:
      'Create a new repository on the connected account. Visibility must be chosen explicitly. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        name: z
          .string()
          .refine(
            (v) => validateRepoName(v).ok,
            'name must start with a letter or digit and may otherwise contain only letters, digits, ".", "_", and "-"',
          ),
        visibility: z.enum(['private', 'public']),
        description: z.string().optional(),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ name, visibility, description, cwd }, options) => {
      const nameOk = validateRepoName(name);
      if (!nameOk.ok) return { success: false as const, error: nameOk.error };
      if (!visibility) {
        return { success: false as const, error: 'visibility is required (private or public)' };
      }
      return withToken(options, (ctx, token) =>
        gitR('gh', buildRepoCreateArgs({ name, visibility, description }), ctx, token, cwd),
      );
    },
  });

  const ghSearch = tool({
    description:
      'Search GitHub for code, issues, pull requests, or repositories. Uses GitHub search syntax — include "repo:owner/repo" to scope to a repository. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        type: z.enum(['code', 'issues', 'prs', 'repos']),
        query: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ type, query, limit, cwd }, options) => {
      if (!query) {
        return { success: false as const, error: 'query is required' };
      }
      return withToken(options, (ctx, token) =>
        gitR('gh', buildSearchArgs({ type, query, limit }), ctx, token, cwd),
      );
    },
  });

  const ghLabelList = tool({
    description:
      'List the labels available in a repository. Check here before applying labels to issues or PRs. Requires a connected GitHub account.',
    inputSchema: z
      .object({
        repo: z.string().optional().describe('Repository as "owner/repo" (defaults to the repo in cwd)'),
        limit: z.number().int().positive().max(100).optional(),
        cwd: cwdField,
      })
      .strict(),
    execute: async ({ repo, limit, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('gh', buildLabelListArgs({ repo, limit }), ctx, token, cwd),
      ),
  });

  return {
    git_clone: gitClone,
    git_init: gitInit,
    git_config: gitConfig,
    git_remote_add: gitRemoteAdd,
    git_status: gitStatus,
    git_diff: gitDiff,
    git_add: gitAdd,
    git_reset: gitReset,
    git_stash: gitStash,
    git_commit: gitCommit,
    git_log: gitLog,
    git_show: gitShow,
    git_blame: gitBlame,
    git_merge: gitMerge,
    git_rebase: gitRebase,
    git_revert: gitRevert,
    git_checkout: gitCheckout,
    git_branch: gitBranch,
    git_fetch: gitFetch,
    git_pull: gitPull,
    git_push: gitPush,
    gh_pr_create: ghPrCreate,
    gh_pr_list: ghPrList,
    gh_pr_view: ghPrView,
    gh_pr_diff: ghPrDiff,
    gh_pr_checks: ghPrChecks,
    gh_pr_merge: ghPrMerge,
    gh_pr_checkout: ghPrCheckout,
    gh_pr_review: ghPrReview,
    gh_pr_review_comment: ghPrReviewComment,
    gh_pr_comment: ghPrComment,
    gh_pr_edit: ghPrEdit,
    gh_pr_update_branch: ghPrUpdateBranch,
    gh_pr_thread_list: ghPrThreadList,
    gh_pr_thread_resolve: ghPrThreadResolve,
    gh_pr_close: ghPrClose,
    gh_pr_reopen: ghPrReopen,
    gh_pr_ready: ghPrReady,
    gh_run_list: ghRunList,
    gh_run_view: ghRunView,
    gh_run_rerun: ghRunRerun,
    gh_workflow_list: ghWorkflowList,
    gh_workflow_run: ghWorkflowRun,
    gh_issue_create: ghIssueCreate,
    gh_issue_list: ghIssueList,
    gh_issue_view: ghIssueView,
    gh_issue_comment: ghIssueComment,
    gh_issue_edit: ghIssueEdit,
    gh_issue_close: ghIssueClose,
    gh_issue_reopen: ghIssueReopen,
    gh_repo_view: ghRepoView,
    gh_repo_list: ghRepoList,
    gh_repo_fork: ghRepoFork,
    gh_repo_create: ghRepoCreate,
    gh_search: ghSearch,
    gh_label_list: ghLabelList,
  };
}
