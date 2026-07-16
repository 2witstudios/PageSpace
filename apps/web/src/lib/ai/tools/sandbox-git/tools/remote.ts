/**
 * Declarative rows for the remote-sync tools (git_fetch, git_pull, git_push).
 * These are `git` commands that need a GitHub token, so exec is 'token'.
 * git_push's force/delete/default-branch guard is the pure evaluatePushGuard,
 * wired as the row's validator — it runs before any sandbox is touched.
 */
import { z } from 'zod';
import { defineRow, type GitToolRow } from './types';
import { cwdField } from './fields';
import { evaluatePushGuard } from '../core/refspec';
import { buildFetchArgs, buildPullArgs, buildPushArgs } from '../core/command-specs/remote';

export const REMOTE_TOOL_ROWS: GitToolRow[] = [
  defineRow({
    key: 'git_fetch',
    group: 'remote',
    cmd: 'git',
    exec: 'token',
    description: 'Fetch from a remote. Requires a connected GitHub account.',
    schema: z
      .object({ remote: z.string().optional(), branch: z.string().optional(), cwd: cwdField })
      .strict(),
    buildArgs: ({ remote, branch }) => ({ args: buildFetchArgs({ remote, branch }) }),
  }),
  defineRow({
    key: 'git_pull',
    group: 'remote',
    cmd: 'git',
    exec: 'token',
    description: 'Pull from a remote. Requires a connected GitHub account.',
    schema: z
      .object({
        remote: z.string().optional(),
        branch: z.string().optional(),
        rebase: z.boolean().optional(),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ remote, branch, rebase }) => ({ args: buildPullArgs({ remote, branch, rebase }) }),
  }),
  defineRow({
    key: 'git_push',
    group: 'remote',
    cmd: 'git',
    exec: 'token',
    description:
      'Push to a remote. Requires a connected GitHub account. cwd defaults to /workspace — pass it to push from a cloned subdir. Force-push (--force-with-lease) is allowed on feature/PR branches but refused for the default branch (main/master); to update an open PR, push to its branch rather than opening a new one. Note: pushes touching .github/workflows files require a GitHub connection made after workflow permissions were added — ask the user to reconnect GitHub in Settings → Integrations if GitHub refuses the push.',
    schema: z
      .object({
        remote: z.string().optional(),
        branch: z.string().optional(),
        force: z.boolean().optional(),
        set_upstream: z.boolean().optional(),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ force, branch }) => evaluatePushGuard({ force, branch }),
    buildArgs: ({ remote, branch, force, set_upstream }) => ({
      args: buildPushArgs({ remote, branch, force, set_upstream }),
    }),
  }),
];
