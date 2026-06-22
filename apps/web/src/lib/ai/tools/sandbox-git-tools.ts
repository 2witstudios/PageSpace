/**
 * Agent git/GitHub tools: all 26 tools running inside a sandbox.
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
import type { ResolveSandboxContext, SandboxGate } from './sandbox-tools';
import type { ToolExecutionContext } from '../core/types';

export interface GitSandboxToolsDeps {
  gitRunDeps: GitSandboxRunDeps;
  resolveContext: ResolveSandboxContext;
  gate: SandboxGate;
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

export function createSandboxGitTools({ gitRunDeps, resolveContext, gate }: GitSandboxToolsDeps): Record<string, Tool> {
  /** Resolve context + gate check shared by every tool. */
  const open = async (
    options: unknown,
  ): Promise<
    | { ok: true; userId: string; ctx: SandboxActorContext }
    | { ok: false; error: { success: false; error: string } }
  > => {
    const ctx = await resolveContext(readContext(options));
    if ('error' in ctx) return { ok: false, error: { success: false, error: ctx.error } };
    const decision = await gate(ctx);
    if (!decision.ok) return { ok: false, error: { success: false, error: decision.error } };
    return { ok: true, userId: ctx.userId, ctx };
  };

  /** Direct-exec helper for local git commands (no token needed). */
  const git = (cmd: 'git' | 'gh', args: string[], ctx: SandboxActorContext) =>
    runGitInSandbox({ cmd, args, ctx, deps: gitRunDeps });

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
  const gitR = (cmd: 'git' | 'gh', args: string[], ctx: SandboxActorContext, token: string) =>
    runGitInSandbox({ cmd, args, ctx, deps: gitRunDeps, preResolvedToken: token });

  // ── Repo + config ───────────────────────────────────────────────────────

  const gitClone = tool({
    description: 'Clone a GitHub repository into the sandbox. Use HTTPS URLs only.',
    inputSchema: z.object({
      repo_url: z
        .string()
        .url()
        .refine(
          (u) => u.startsWith('https://'),
          'Only HTTPS URLs are supported (e.g. https://github.com/owner/repo.git)',
        ),
      path: z.string().optional(),
      depth: z.number().int().positive().optional(),
    }),
    execute: async ({ repo_url, path, depth }, options) => {
      if (!repo_url.startsWith('https://')) {
        return { success: false as const, error: 'Only HTTPS URLs are supported for git clone.' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      const args = ['clone', ...(depth ? ['--depth', String(depth)] : []), repo_url, path ?? '.'];
      return git('git', args, opened.ctx);
    },
  });

  const gitInit = tool({
    description: 'Initialize a new git repository in the sandbox.',
    inputSchema: z.object({ path: z.string().optional() }),
    execute: async ({ path }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['init', path ?? '.'], opened.ctx);
    },
  });

  const gitConfig = tool({
    description: 'Set a git config value.',
    inputSchema: z.object({
      key: z.string().min(1),
      value: z.string(),
      global: z.boolean().optional(),
    }),
    execute: async ({ key, value, global: isGlobal }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['config', ...(isGlobal ? ['--global'] : []), key, value], opened.ctx);
    },
  });

  const gitRemoteAdd = tool({
    description: 'Add a remote to the repository. Use HTTPS URLs only.',
    inputSchema: z.object({
      name: z.string().min(1),
      url: z
        .string()
        .url()
        .refine((u) => u.startsWith('https://'), 'Only HTTPS remote URLs are supported'),
    }),
    execute: async ({ name, url }, options) => {
      if (!url.startsWith('https://')) {
        return { success: false as const, error: 'Only HTTPS URLs are supported for git remote add.' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['remote', 'add', name, url], opened.ctx);
    },
  });

  // ── Working tree ────────────────────────────────────────────────────────

  const gitStatus = tool({
    description: 'Show the working tree status in porcelain format.',
    inputSchema: z.object({ path: z.string().optional() }),
    execute: async ({ path }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['status', '--porcelain', ...(path ? ['--', path] : [])], opened.ctx);
    },
  });

  const gitDiff = tool({
    description: 'Show changes in the working tree or staged changes.',
    inputSchema: z.object({ staged: z.boolean().optional(), path: z.string().optional() }),
    execute: async ({ staged, path }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git(
        'git',
        ['diff', ...(staged ? ['--cached'] : []), ...(path ? ['--', path] : [])],
        opened.ctx,
      );
    },
  });

  const gitAdd = tool({
    description: 'Stage files for commit.',
    inputSchema: z
      .object({ paths: z.array(z.string()).optional(), all: z.boolean().optional() })
      .refine((d) => d.all || (d.paths && d.paths.length > 0), {
        message: 'Provide paths or set all: true',
      }),
    execute: async ({ paths, all }, options) => {
      if (!all && (!paths || paths.length === 0)) {
        return { success: false as const, error: 'Provide paths or set all: true' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['add', ...(all ? ['-A'] : paths!)], opened.ctx);
    },
  });

  const gitReset = tool({
    description: 'Reset HEAD to a given ref.',
    inputSchema: z.object({
      mode: z.enum(['soft', 'mixed', 'hard']),
      ref: z.string().optional(),
    }),
    execute: async ({ mode, ref }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['reset', `--${mode}`, ...(ref ? [ref] : [])], opened.ctx);
    },
  });

  const gitStash = tool({
    description: 'Stash, pop, list, or drop the stash.',
    inputSchema: z.object({
      action: z.enum(['push', 'pop', 'list', 'drop']),
      message: z.string().optional(),
    }),
    execute: async ({ action, message }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      const args: string[] =
        action === 'push'
          ? ['stash', 'push', ...(message ? ['-m', message] : [])]
          : ['stash', action];
      return git('git', args, opened.ctx);
    },
  });

  // ── Commits, history, branching ─────────────────────────────────────────

  const gitCommit = tool({
    description: 'Create a commit with the given message.',
    inputSchema: z.object({
      message: z.string().min(1),
      amend: z.boolean().optional(),
    }),
    execute: async ({ message, amend }, options) => {
      if (!message) {
        return { success: false as const, error: 'commit message is required' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git(
        'git',
        ['commit', '-m', message, ...(amend ? ['--amend', '--no-edit'] : [])],
        opened.ctx,
      );
    },
  });

  const gitLog = tool({
    description: 'Show commit history. Defaults to last 20 commits in oneline format.',
    inputSchema: z.object({
      n: z.number().int().positive().max(100).optional(),
      path: z.string().optional(),
      oneline: z.boolean().optional(),
    }),
    execute: async ({ n, path, oneline }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      const useOneline = oneline ?? true;
      return git(
        'git',
        [
          'log',
          ...(useOneline ? ['--oneline'] : []),
          `-${n ?? 20}`,
          ...(path ? ['--', path] : []),
        ],
        opened.ctx,
      );
    },
  });

  const gitMerge = tool({
    description: 'Merge a branch.',
    inputSchema: z.object({
      branch: z.string().min(1),
      strategy: z.enum(['merge', 'squash', 'ff-only']).optional(),
    }),
    execute: async ({ branch, strategy }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      const strategyFlag =
        strategy === 'squash' ? ['--squash'] : strategy === 'ff-only' ? ['--ff-only'] : [];
      return git('git', ['merge', ...strategyFlag, branch], opened.ctx);
    },
  });

  const gitRebase = tool({
    description: 'Rebase onto a branch or ref. Non-interactive only.',
    inputSchema: z.object({ branch_or_ref: z.string().min(1) }),
    execute: async ({ branch_or_ref }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['rebase', branch_or_ref], opened.ctx);
    },
  });

  const gitCheckout = tool({
    description: 'Switch branches or create a new one.',
    inputSchema: z.object({ ref: z.string().min(1), create: z.boolean().optional() }),
    execute: async ({ ref, create }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['checkout', ...(create ? ['-b'] : []), ref], opened.ctx);
    },
  });

  const gitBranch = tool({
    description: 'List, create, or delete branches.',
    inputSchema: z
      .object({ action: z.enum(['list', 'create', 'delete']), name: z.string().optional() })
      .refine((d) => d.action === 'list' || !!d.name, { message: 'name required for create/delete' }),
    execute: async ({ action, name }, options) => {
      if ((action === 'create' || action === 'delete') && !name) {
        return { success: false as const, error: 'name is required for create/delete' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      const args =
        action === 'list' ? ['branch', '-a'] : action === 'delete' ? ['branch', '-d', name!] : ['branch', name!];
      return git('git', args, opened.ctx);
    },
  });

  // ── Remote sync (token required) ────────────────────────────────────────

  const gitFetch = tool({
    description: 'Fetch from a remote. Requires a connected GitHub account.',
    inputSchema: z.object({ remote: z.string().optional(), branch: z.string().optional() }),
    execute: async ({ remote, branch }, options) =>
      withToken(options, (ctx, token) =>
        gitR('git', ['fetch', remote ?? 'origin', ...(branch ? [branch] : [])], ctx, token),
      ),
  });

  const gitPull = tool({
    description: 'Pull from a remote. Requires a connected GitHub account.',
    inputSchema: z.object({
      remote: z.string().optional(),
      branch: z.string().optional(),
      rebase: z.boolean().optional(),
    }),
    execute: async ({ remote, branch, rebase }, options) =>
      withToken(options, (ctx, token) =>
        gitR(
          'git',
          ['pull', ...(rebase ? ['--rebase'] : []), remote ?? 'origin', ...(branch ? [branch] : [])],
          ctx,
          token,
        ),
      ),
  });

  const gitPush = tool({
    description: 'Push to a remote. Requires a connected GitHub account.',
    inputSchema: z.object({
      remote: z.string().optional(),
      branch: z.string().optional(),
      force: z.boolean().optional(),
      set_upstream: z.boolean().optional(),
    }),
    execute: async ({ remote, branch, force, set_upstream }, options) =>
      withToken(options, (ctx, token) =>
        gitR(
          'git',
          [
            'push',
            ...(force ? ['--force-with-lease'] : []),
            ...(set_upstream ? ['-u'] : []),
            remote ?? 'origin',
            ...(branch ? [branch] : []),
          ],
          ctx,
          token,
        ),
      ),
  });

  // ── GitHub PRs (token required) ─────────────────────────────────────────

  const ghPrCreate = tool({
    description: 'Create a pull request. Requires a connected GitHub account.',
    inputSchema: z.object({
      title: z.string().min(1),
      body: z.string(),
      base: z.string().optional(),
      draft: z.boolean().optional(),
      labels: z.array(z.string()).optional(),
    }),
    execute: async ({ title, body, base, draft, labels }, options) => {
      if (!title) {
        return { success: false as const, error: 'title is required' };
      }
      return withToken(options, (ctx, token) =>
        gitR(
          'gh',
          [
            'pr', 'create',
            '--title', title,
            '--body', body,
            ...(base ? ['--base', base] : []),
            ...(draft ? ['--draft'] : []),
            ...(labels?.length ? ['--label', labels.join(',')] : []),
          ],
          ctx,
          token,
        ),
      );
    },
  });

  const ghPrList = tool({
    description: 'List pull requests. Requires a connected GitHub account.',
    inputSchema: z.object({
      state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    execute: async ({ state, limit }, options) =>
      withToken(options, (ctx, token) =>
        gitR(
          'gh',
          [
            'pr', 'list',
            '--state', state ?? 'open',
            '--limit', String(limit ?? 30),
            '--json', 'number,title,state,url,headRefName,createdAt',
          ],
          ctx,
          token,
        ),
      ),
  });

  const ghPrView = tool({
    description: 'View a pull request. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive().optional() }),
    execute: async ({ number }, options) =>
      withToken(options, (ctx, token) =>
        gitR(
          'gh',
          [
            'pr', 'view',
            ...(number ? [String(number)] : []),
            '--json', 'number,title,body,state,url,headRefName,baseRefName,mergeable',
          ],
          ctx,
          token,
        ),
      ),
  });

  const ghPrMerge = tool({
    description: 'Merge a pull request. Requires a connected GitHub account.',
    inputSchema: z.object({
      number: z.number().int().positive().optional(),
      strategy: z.enum(['merge', 'squash', 'rebase']),
    }),
    execute: async ({ number, strategy }, options) =>
      withToken(options, (ctx, token) =>
        gitR(
          'gh',
          [
            'pr', 'merge',
            ...(number ? [String(number)] : []),
            strategy === 'squash' ? '--squash' : strategy === 'rebase' ? '--rebase' : '--merge',
            '--auto',
          ],
          ctx,
          token,
        ),
      ),
  });

  const ghPrCheckout = tool({
    description: 'Check out a pull request locally. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive() }),
    execute: async ({ number }, options) =>
      withToken(options, (ctx, token) => gitR('gh', ['pr', 'checkout', String(number)], ctx, token)),
  });

  // ── GitHub Issues (token required) ──────────────────────────────────────

  const ghIssueCreate = tool({
    description: 'Create an issue. Requires a connected GitHub account.',
    inputSchema: z.object({
      title: z.string().min(1),
      body: z.string(),
      labels: z.array(z.string()).optional(),
    }),
    execute: async ({ title, body, labels }, options) => {
      if (!title) {
        return { success: false as const, error: 'title is required' };
      }
      return withToken(options, (ctx, token) =>
        gitR(
          'gh',
          [
            'issue', 'create',
            '--title', title,
            '--body', body,
            ...(labels?.length ? ['--label', labels.join(',')] : []),
          ],
          ctx,
          token,
        ),
      );
    },
  });

  const ghIssueList = tool({
    description: 'List issues. Requires a connected GitHub account.',
    inputSchema: z.object({
      state: z.enum(['open', 'closed', 'all']).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    execute: async ({ state, limit }, options) =>
      withToken(options, (ctx, token) =>
        gitR(
          'gh',
          [
            'issue', 'list',
            '--state', state ?? 'open',
            '--limit', String(limit ?? 30),
            '--json', 'number,title,state,url,createdAt,labels',
          ],
          ctx,
          token,
        ),
      ),
  });

  const ghIssueView = tool({
    description: 'View an issue. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive() }),
    execute: async ({ number }, options) =>
      withToken(options, (ctx, token) =>
        gitR(
          'gh',
          [
            'issue', 'view',
            String(number),
            '--json', 'number,title,body,state,url,labels,comments,assignees',
          ],
          ctx,
          token,
        ),
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
    git_merge: gitMerge,
    git_rebase: gitRebase,
    git_checkout: gitCheckout,
    git_branch: gitBranch,
    git_fetch: gitFetch,
    git_pull: gitPull,
    git_push: gitPush,
    gh_pr_create: ghPrCreate,
    gh_pr_list: ghPrList,
    gh_pr_view: ghPrView,
    gh_pr_merge: ghPrMerge,
    gh_pr_checkout: ghPrCheckout,
    gh_issue_create: ghIssueCreate,
    gh_issue_list: ghIssueList,
    gh_issue_view: ghIssueView,
  };
}
