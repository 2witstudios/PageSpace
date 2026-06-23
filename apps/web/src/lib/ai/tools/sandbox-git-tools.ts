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
import { MAX_PATH_LENGTH, type ResolveSandboxContext, type SandboxGate } from './sandbox-tools';
import type { ToolExecutionContext } from '../core/types';

// Optional per-call working directory, relative to the sandbox root (/workspace).
// Each tool call is a fresh process, so cwd never persists between calls — pass it
// to operate inside a cloned subdirectory. The runner validates it (path_escape).
const cwdField = z.string().max(MAX_PATH_LENGTH).optional();

// Default branch names we refuse to force-push to. Heuristic: only these common
// names are auto-protected (a custom default branch is not).
const DEFAULT_BRANCHES = new Set(['main', 'master']);

// The ref a push actually writes on the remote. A push target is a refspec
// `[+]<src>:<dst>` (or `[+]<branch>`), so the destination is the segment after
// the last ':' — a bare-name check misses `HEAD:main` or `feature:refs/heads/master`.
// Returns the lowercased short branch name for comparison against DEFAULT_BRANCHES.
function pushDestinationBranch(refspec: string): string {
  const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  const dst = spec.includes(':') ? spec.slice(spec.lastIndexOf(':') + 1) : spec;
  return dst.replace(/^refs\/heads\//, '').trim().toLowerCase();
}

// A delete refspec has an empty source: `:dst` (or `+:dst`). `git push origin
// :main` deletes the remote default branch — as destructive as a force-push, so
// the same guard must catch it.
function isDeleteRefspec(refspec: string): boolean {
  const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  return spec.includes(':') && spec.slice(0, spec.lastIndexOf(':')).trim() === '';
}

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
  const git = (cmd: 'git' | 'gh', args: string[], ctx: SandboxActorContext, cwd?: string) =>
    runGitInSandbox({ cmd, args, cwd, ctx, deps: gitRunDeps });

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
      cwd: cwdField,
    }),
    execute: async ({ key, value, global: isGlobal, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['config', ...(isGlobal ? ['--global'] : []), key, value], opened.ctx, cwd);
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
      cwd: cwdField,
    }),
    execute: async ({ name, url, cwd }, options) => {
      if (!url.startsWith('https://')) {
        return { success: false as const, error: 'Only HTTPS URLs are supported for git remote add.' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['remote', 'add', name, url], opened.ctx, cwd);
    },
  });

  // ── Working tree ────────────────────────────────────────────────────────

  const gitStatus = tool({
    description: 'Show the working tree status in porcelain format.',
    inputSchema: z.object({ path: z.string().optional(), cwd: cwdField }),
    execute: async ({ path, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['status', '--porcelain', ...(path ? ['--', path] : [])], opened.ctx, cwd);
    },
  });

  const gitDiff = tool({
    description: 'Show changes in the working tree or staged changes.',
    inputSchema: z.object({ staged: z.boolean().optional(), path: z.string().optional(), cwd: cwdField }),
    execute: async ({ staged, path, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git(
        'git',
        ['diff', ...(staged ? ['--cached'] : []), ...(path ? ['--', path] : [])],
        opened.ctx,
        cwd,
      );
    },
  });

  const gitAdd = tool({
    description: 'Stage files for commit.',
    inputSchema: z
      .object({ paths: z.array(z.string()).optional(), all: z.boolean().optional(), cwd: cwdField })
      .refine((d) => d.all || (d.paths && d.paths.length > 0), {
        message: 'Provide paths or set all: true',
      }),
    execute: async ({ paths, all, cwd }, options) => {
      if (!all && (!paths || paths.length === 0)) {
        return { success: false as const, error: 'Provide paths or set all: true' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['add', ...(all ? ['-A'] : paths!)], opened.ctx, cwd);
    },
  });

  const gitReset = tool({
    description: 'Reset HEAD to a given ref.',
    inputSchema: z.object({
      mode: z.enum(['soft', 'mixed', 'hard']),
      ref: z.string().optional(),
      cwd: cwdField,
    }),
    execute: async ({ mode, ref, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['reset', `--${mode}`, ...(ref ? [ref] : [])], opened.ctx, cwd);
    },
  });

  const gitStash = tool({
    description: 'Stash, pop, list, or drop the stash.',
    inputSchema: z.object({
      action: z.enum(['push', 'pop', 'list', 'drop']),
      message: z.string().optional(),
      cwd: cwdField,
    }),
    execute: async ({ action, message, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      const args: string[] =
        action === 'push'
          ? ['stash', 'push', ...(message ? ['-m', message] : [])]
          : ['stash', action];
      return git('git', args, opened.ctx, cwd);
    },
  });

  // ── Commits, history, branching ─────────────────────────────────────────

  const gitCommit = tool({
    description: 'Create a commit with the given message.',
    inputSchema: z.object({
      message: z.string().min(1),
      amend: z.boolean().optional(),
      cwd: cwdField,
    }),
    execute: async ({ message, amend, cwd }, options) => {
      if (!message) {
        return { success: false as const, error: 'commit message is required' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git(
        'git',
        ['commit', '-m', message, ...(amend ? ['--amend', '--no-edit'] : [])],
        opened.ctx,
        cwd,
      );
    },
  });

  const gitLog = tool({
    description: 'Show commit history. Defaults to last 20 commits in oneline format.',
    inputSchema: z.object({
      n: z.number().int().positive().max(100).optional(),
      path: z.string().optional(),
      oneline: z.boolean().optional(),
      cwd: cwdField,
    }),
    execute: async ({ n, path, oneline, cwd }, options) => {
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
        cwd,
      );
    },
  });

  const gitMerge = tool({
    description: 'Merge a branch.',
    inputSchema: z.object({
      branch: z.string().min(1),
      strategy: z.enum(['merge', 'squash', 'ff-only']).optional(),
      cwd: cwdField,
    }),
    execute: async ({ branch, strategy, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      const strategyFlag =
        strategy === 'squash' ? ['--squash'] : strategy === 'ff-only' ? ['--ff-only'] : [];
      return git('git', ['merge', ...strategyFlag, branch], opened.ctx, cwd);
    },
  });

  const gitRebase = tool({
    description: 'Rebase onto a branch or ref. Non-interactive only.',
    inputSchema: z.object({ branch_or_ref: z.string().min(1), cwd: cwdField }),
    execute: async ({ branch_or_ref, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['rebase', branch_or_ref], opened.ctx, cwd);
    },
  });

  const gitCheckout = tool({
    description: 'Switch branches or create a new one.',
    inputSchema: z.object({ ref: z.string().min(1), create: z.boolean().optional(), cwd: cwdField }),
    execute: async ({ ref, create, cwd }, options) => {
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      return git('git', ['checkout', ...(create ? ['-b'] : []), ref], opened.ctx, cwd);
    },
  });

  const gitBranch = tool({
    description: 'List, create, or delete branches.',
    inputSchema: z
      .object({ action: z.enum(['list', 'create', 'delete']), name: z.string().optional(), cwd: cwdField })
      .refine((d) => d.action === 'list' || !!d.name, { message: 'name required for create/delete' }),
    execute: async ({ action, name, cwd }, options) => {
      if ((action === 'create' || action === 'delete') && !name) {
        return { success: false as const, error: 'name is required for create/delete' };
      }
      const opened = await open(options);
      if (!opened.ok) return opened.error;
      const args =
        action === 'list' ? ['branch', '-a'] : action === 'delete' ? ['branch', '-d', name!] : ['branch', name!];
      return git('git', args, opened.ctx, cwd);
    },
  });

  // ── Remote sync (token required) ────────────────────────────────────────

  const gitFetch = tool({
    description: 'Fetch from a remote. Requires a connected GitHub account.',
    inputSchema: z.object({ remote: z.string().optional(), branch: z.string().optional(), cwd: cwdField }),
    execute: async ({ remote, branch, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR('git', ['fetch', remote ?? 'origin', ...(branch ? [branch] : [])], ctx, token, cwd),
      ),
  });

  const gitPull = tool({
    description: 'Pull from a remote. Requires a connected GitHub account.',
    inputSchema: z.object({
      remote: z.string().optional(),
      branch: z.string().optional(),
      rebase: z.boolean().optional(),
      cwd: cwdField,
    }),
    execute: async ({ remote, branch, rebase, cwd }, options) =>
      withToken(options, (ctx, token) =>
        gitR(
          'git',
          ['pull', ...(rebase ? ['--rebase'] : []), remote ?? 'origin', ...(branch ? [branch] : [])],
          ctx,
          token,
          cwd,
        ),
      ),
  });

  const gitPush = tool({
    description:
      'Push to a remote. Requires a connected GitHub account. cwd defaults to /workspace — pass it to push from a cloned subdir. Force-push (--force-with-lease) is allowed on feature/PR branches but refused for the default branch (main/master); to update an open PR, push to its branch rather than opening a new one.',
    inputSchema: z.object({
      remote: z.string().optional(),
      branch: z.string().optional(),
      force: z.boolean().optional(),
      set_upstream: z.boolean().optional(),
      cwd: cwdField,
    }),
    execute: async ({ remote, branch, force, set_upstream, cwd }, options) => {
      // Force-push is fine for a feature/PR branch, but never the default branch.
      // A push forces when the `force` flag is set OR the refspec is `+`-prefixed
      // (per-refspec force), so guard both. Require an explicit branch under force
      // so the target can be verified — we can't see the sandbox's current branch
      // from here — and check the refspec DESTINATION, not the raw value, so
      // `HEAD:main` / `feature:refs/heads/master` can't slip past.
      const forcing = force === true || (branch?.startsWith('+') ?? false);
      if (forcing && !branch) {
        return {
          success: false as const,
          error:
            'Force-push requires an explicit branch so the target can be verified. Name the feature/PR branch to push to.',
        };
      }
      // Destructive = force-push (rewrites history) or delete (`:branch`). Either
      // one against the default branch is refused; a normal fast-forward push is not.
      const destructive = forcing || (branch ? isDeleteRefspec(branch) : false);
      if (destructive && branch && DEFAULT_BRANCHES.has(pushDestinationBranch(branch))) {
        return {
          success: false as const,
          error:
            'Refusing to force-push or delete the default branch (main/master). These are allowed on feature/PR branches only.',
        };
      }
      return withToken(options, (ctx, token) =>
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
          cwd,
        ),
      );
    },
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
      cwd: cwdField,
    }),
    execute: async ({ title, body, base, draft, labels, cwd }, options) => {
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
          cwd,
        ),
      );
    },
  });

  const ghPrList = tool({
    description: 'List pull requests. Requires a connected GitHub account.',
    inputSchema: z.object({
      state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
      limit: z.number().int().positive().max(100).optional(),
      cwd: cwdField,
    }),
    execute: async ({ state, limit, cwd }, options) =>
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
          cwd,
        ),
      ),
  });

  const ghPrView = tool({
    description: 'View a pull request. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive().optional(), cwd: cwdField }),
    execute: async ({ number, cwd }, options) =>
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
          cwd,
        ),
      ),
  });

  const ghPrMerge = tool({
    description: 'Merge a pull request. Requires a connected GitHub account.',
    inputSchema: z.object({
      number: z.number().int().positive().optional(),
      strategy: z.enum(['merge', 'squash', 'rebase']),
      cwd: cwdField,
    }),
    execute: async ({ number, strategy, cwd }, options) =>
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
          cwd,
        ),
      ),
  });

  const ghPrCheckout = tool({
    description: 'Check out a pull request locally. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive(), cwd: cwdField }),
    execute: async ({ number, cwd }, options) =>
      withToken(options, (ctx, token) => gitR('gh', ['pr', 'checkout', String(number)], ctx, token, cwd)),
  });

  // ── GitHub Issues (token required) ──────────────────────────────────────

  const ghIssueCreate = tool({
    description: 'Create an issue. Requires a connected GitHub account.',
    inputSchema: z.object({
      title: z.string().min(1),
      body: z.string(),
      labels: z.array(z.string()).optional(),
      cwd: cwdField,
    }),
    execute: async ({ title, body, labels, cwd }, options) => {
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
          cwd,
        ),
      );
    },
  });

  const ghIssueList = tool({
    description: 'List issues. Requires a connected GitHub account.',
    inputSchema: z.object({
      state: z.enum(['open', 'closed', 'all']).optional(),
      limit: z.number().int().positive().max(100).optional(),
      cwd: cwdField,
    }),
    execute: async ({ state, limit, cwd }, options) =>
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
          cwd,
        ),
      ),
  });

  const ghIssueView = tool({
    description: 'View an issue. Requires a connected GitHub account.',
    inputSchema: z.object({ number: z.number().int().positive(), cwd: cwdField }),
    execute: async ({ number, cwd }, options) =>
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
          cwd,
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
