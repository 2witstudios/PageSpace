/**
 * Agent git/GitHub tools: all 26 tools over the 'dev' profile sandbox.
 *
 * Pure factory — no DB imports, no Sprites SDK. Production wiring lives in
 * `sandbox-git-tools-runtime.ts`. Each tool's execute handler:
 *   1. Resolves the actor context.
 *   2. Runs the call-time gate (same gate as bash/writeFile/readFile).
 *   3. For remote/gh tools: pre-checks the GitHub token (fails fast, no quota).
 *   4. Delegates to `runGitInSandbox` with cmd + args[] (never sh -c).
 *
 * Security: cmd is always a literal ('git' or 'gh'). Args are string[]. No
 * shell interpolation is possible. Token is injected per-command by the
 * runner, never persisted.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
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
    | { ok: true; userId: string; ctx: Parameters<typeof runGitInSandbox>[0]['ctx'] }
    | { ok: false; error: { success: false; error: string } }
  > => {
    const ctx = await resolveContext(readContext(options));
    if ('error' in ctx) return { ok: false, error: { success: false, error: ctx.error } };
    const decision = await gate(ctx);
    if (!decision.ok) return { ok: false, error: { success: false, error: decision.error } };
    return { ok: true, userId: ctx.userId, ctx };
  };

  /** For remote/gh tools: check token BEFORE opening a sandbox (no quota charge on failure). */
  const withToken = async (
    options: unknown,
    run: (ctx: Parameters<typeof runGitInSandbox>[0]['ctx'], token: string) => Promise<unknown>,
  ) => {
    const opened = await open(options);
    if (!opened.ok) return opened.error;
    const token = await gitRunDeps.resolveGitHubToken(opened.userId);
    if (!token) return NO_CONNECTION_ERROR;
    return run(opened.ctx, token);
  };

  const git = (cmd: string, args: string[], ctx: Parameters<typeof runGitInSandbox>[0]['ctx']) =>
    runGitInSandbox({ cmd, args, ctx, deps: gitRunDeps });

  // ── Repo + config ───────────────────────────────────────────────────────

  const git_clone = tool({
    description: 'Clone a GitHub repository into the sandbox. Use HTTPS URLs only.',
    inputSchema: z.object({
      repo_url: z
        .string()
        .url()
        .refine(
          (u) => !u.startsWith('git@') && !u.startsWith('ssh://'),
          'Use HTTPS URLs for git clone (SSH is not supported with token auth)',
        ),
      path: z.string().optional(),
      depth: z.number().int().positive().optional(),
    }),
    execute: async ({ repo_url, path, depth }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      const args = [
        'clone',
        ...(depth ? ['--depth', String(depth)] : []),
        repo_url,
        ...(path ? [path] : []),
      ];
      return git('git', args, opened.ctx);
    },
  });

  const git_init = tool({
    description: 'Initialize a new git repository in the sandbox.',
    inputSchema: z.object({ path: z.string().optional() }),
    execute: async ({ path }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['init', path ?? '.'], opened.ctx);
    },
  });

  const git_config = tool({
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

  const git_remote_add = tool({
    description: 'Add a remote to the repository.',
    inputSchema: z.object({ name: z.string().min(1), url: z.string().url() }),
    execute: async ({ name, url }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['remote', 'add', name, url], opened.ctx);
    },
  });

  // ── Working tree ────────────────────────────────────────────────────────

  const git_status = tool({
    description: 'Show the working tree status in porcelain format.',
    inputSchema: z.object({ path: z.string().optional() }),
    execute: async ({ path }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['status', '--porcelain', ...(path ? ['--', path] : [])], opened.ctx);
    },
  });

  const git_diff = tool({
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

  const git_add = tool({
    description: 'Stage files for commit.',
    inputSchema: z
      .object({ paths: z.array(z.string()).optional(), all: z.boolean().optional() })
      .refine((d) => d.all || (d.paths && d.paths.length > 0), {
        message: 'Provide paths or set all: true',
      }),
    execute: async ({ paths, all }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['add', ...(all ? ['-A'] : paths!)], opened.ctx);
    },
  });

  const git_reset = tool({
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

  const git_stash = tool({
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

  const git_commit = tool({
    description: 'Create a commit with the given message.',
    inputSchema: z.object({
      message: z.string().min(1),
      amend: z.boolean().optional(),
    }),
    execute: async ({ message, amend }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git(
        'git',
        ['commit', '-m', message, ...(amend ? ['--amend', '--no-edit'] : [])],
        opened.ctx,
      );
    },
  });

  const git_log = tool({
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

  const git_merge = tool({
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

  const git_rebase = tool({
    description: 'Rebase onto a branch or ref. Non-interactive only.',
    inputSchema: z.object({ branch_or_ref: z.string().min(1) }),
    execute: async ({ branch_or_ref }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['rebase', branch_or_ref], opened.ctx);
    },
  });

  const git_checkout = tool({
    description: 'Switch branches or create a new one.',
    inputSchema: z.object({ ref: z.string().min(1), create: z.boolean().optional() }),
    execute: async ({ ref, create }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['checkout', ...(create ? ['-b'] : []), ref], opened.ctx);
    },
  });

  const git_branch = tool({
    description: 'List, create, or delete branches.',
    inputSchema: z
      .object({ action: z.enum(['list', 'create', 'delete']), name: z.string().optional() })
      .refine((d) => d.action === 'list' || !!d.name, { message: 'name required for create/delete' }),
    execute: async ({ action, name }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      const args =
        action === 'list' ? ['branch', '-a'] : action === 'delete' ? ['branch', '-d', name!] : ['branch', name!];
      return git('git', args, opened.ctx);
    },
  });

  // ── Remote sync (token required) ────────────────────────────────────────

  const git_fetch = tool({
    description: 'Fetch from a remote. Requires a connected GitHub account.',
    inputSchema: z.object({ remote: z.string().optional(), branch: z.string().optional() }),
    execute: async ({ remote, branch }, options) =>
      withToken(options, (ctx) =>
        git('git', ['fetch', remote ?? 'origin', ...(branch ? [branch] : [])], ctx),
      ),
  });

  const git_pull = tool({
    description: 'Pull from a remote. Requires a connected GitHub account.',
    inputSchema: z.object({
      remote: z.string().optional(),
      branch: z.string().optional(),
      rebase: z.boolean().optional(),
    }),
    execute: async ({ remote, branch, rebase }, options) =>
      withToken(options, (ctx) =>
        git(
          'git',
          ['pull', ...(rebase ? ['--rebase'] : []), remote ?? 'origin', ...(branch ? [branch] : [])],
          ctx,
        ),
      ),
  });

  const git_push = tool({
    description: 'Push to a remote. Requires a connected GitHub account.',
    inputSchema: z.object({
      remote: z.string().optional(),
      branch: z.string().optional(),
      force: z.boolean().optional(),
      set_upstream: z.boolean().optional(),
    }),
    execute: async ({ remote, branch, force, set_upstream }, options) =>
      withToken(options, (ctx) =>
        git(
          'git',
          [
            'push',
            ...(force ? ['--force-with-lease'] : []),
            ...(set_upstream ? ['-u'] : []),
            remote ?? 'origin',
            ...(branch ? [branch] : []),
          ],
          ctx,
        ),
      ),
  });

  // ── GitHub PRs (token required) ─────────────────────────────────────────

  const gh_pr_create = tool({
    description: 'Create a pull request. Requires a connected GitHub account.',
    inputSchema: z.object({
      title: z.string().min(1),
      body: z.string(),
      base: z.string().optional(),
      draft: z.boolean().optional(),
      labels: z.array(z.string()).optional(),
    }),
    execute: async ({ title, body, base, draft, labels }, options) =>
      withToken(options, (ctx) =>
        git(
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
        ),
      ),
  });

  const gh_pr_list = tool({
    description: 'List pull requests. Requires a connected GitHub account.',
    inputSchema: z.object({
      state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    execute: async ({ state, limit }, options) =>
      withToken(options, (ctx) =>
        git(
          'gh',
          [
            'pr', 'list',
            '--state', state ?? 'open',
            '--limit', String(limit ?? 30),
            '--json', 'number,title,state,url,headRefName,createdAt',
          ],
          ctx,
        ),
      ),
  });

  const gh_pr_view = tool({
    description: 'View a pull request. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive().optional() }),
    execute: async ({ number }, options) =>
      withToken(options, (ctx) =>
        git(
          'gh',
          [
            'pr', 'view',
            ...(number ? [String(number)] : []),
            '--json', 'number,title,body,state,url,headRefName,baseRefName,mergeable',
          ],
          ctx,
        ),
      ),
  });

  const gh_pr_merge = tool({
    description: 'Merge a pull request. Requires a connected GitHub account.',
    inputSchema: z.object({
      number: z.number().int().positive().optional(),
      strategy: z.enum(['merge', 'squash', 'rebase']),
    }),
    execute: async ({ number, strategy }, options) =>
      withToken(options, (ctx) =>
        git(
          'gh',
          [
            'pr', 'merge',
            ...(number ? [String(number)] : []),
            strategy === 'squash' ? '--squash' : strategy === 'rebase' ? '--rebase' : '--merge',
            '--auto',
          ],
          ctx,
        ),
      ),
  });

  const gh_pr_checkout = tool({
    description: 'Check out a pull request locally. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive() }),
    execute: async ({ number }, options) =>
      withToken(options, (ctx) => git('gh', ['pr', 'checkout', String(number)], ctx)),
  });

  // ── GitHub Issues (token required) ──────────────────────────────────────

  const gh_issue_create = tool({
    description: 'Create an issue. Requires a connected GitHub account.',
    inputSchema: z.object({
      title: z.string().min(1),
      body: z.string(),
      labels: z.array(z.string()).optional(),
    }),
    execute: async ({ title, body, labels }, options) =>
      withToken(options, (ctx) =>
        git(
          'gh',
          [
            'issue', 'create',
            '--title', title,
            '--body', body,
            ...(labels?.length ? ['--label', labels.join(',')] : []),
          ],
          ctx,
        ),
      ),
  });

  const gh_issue_list = tool({
    description: 'List issues. Requires a connected GitHub account.',
    inputSchema: z.object({
      state: z.enum(['open', 'closed', 'all']).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    execute: async ({ state, limit }, options) =>
      withToken(options, (ctx) =>
        git(
          'gh',
          [
            'issue', 'list',
            '--state', state ?? 'open',
            '--limit', String(limit ?? 30),
            '--json', 'number,title,state,url,createdAt,labels',
          ],
          ctx,
        ),
      ),
  });

  const gh_issue_view = tool({
    description: 'View an issue. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive() }),
    execute: async ({ number }, options) =>
      withToken(options, (ctx) =>
        git(
          'gh',
          [
            'issue', 'view',
            String(number),
            '--json', 'number,title,body,state,url,labels,comments,assignees',
          ],
          ctx,
        ),
      ),
  });

  return {
    git_clone,
    git_init,
    git_config,
    git_remote_add,
    git_status,
    git_diff,
    git_add,
    git_reset,
    git_stash,
    git_commit,
    git_log,
    git_merge,
    git_rebase,
    git_checkout,
    git_branch,
    git_fetch,
    git_pull,
    git_push,
    gh_pr_create,
    gh_pr_list,
    gh_pr_view,
    gh_pr_merge,
    gh_pr_checkout,
    gh_issue_create,
    gh_issue_list,
    gh_issue_view,
  };
}
