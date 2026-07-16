/**
 * Declarative rows for the working-tree tools (git_status, git_diff, git_add,
 * git_reset, git_stash). git_diff keeps its two structural schema refines
 * (head-requires-base, staged-xor-base) — those have no execute duplicate.
 * git_add's all-or-paths precondition becomes a single `validate` wired into
 * both the schema and execute.
 */
import { z } from 'zod';
import { defineRow, type GitToolRow } from './types';
import { cwdField } from './fields';
import {
  buildStatusArgs,
  buildDiffArgs,
  buildAddArgs,
  buildResetArgs,
  buildStashArgs,
} from '../core/command-specs/worktree';

export const WORKTREE_TOOL_ROWS: GitToolRow[] = [
  defineRow({
    key: 'git_status',
    group: 'worktree',
    cmd: 'git',
    exec: 'local',
    description: 'Show the working tree status in porcelain format.',
    schema: z.object({ path: z.string().optional(), cwd: cwdField }).strict(),
    buildArgs: ({ path }) => ({ args: buildStatusArgs(path) }),
  }),
  defineRow({
    key: 'git_diff',
    group: 'worktree',
    cmd: 'git',
    exec: 'local',
    description:
      'Show changes in the working tree, staged changes, or between two refs. Pass base + head to diff between branches/commits (e.g. base: "origin/master", head: "HEAD"). Uses three-dot diff (merge-base to head) so only changes unique to head are shown. Falls back to working-tree diff when neither is given.',
    schema: z
      .object({
        staged: z.boolean().optional(),
        path: z.string().optional(),
        base: z.string().optional().describe('Base ref to diff from (e.g. "origin/master", "HEAD~1")'),
        head: z.string().optional().describe('Head ref to diff to (defaults to HEAD when base is given)'),
        cwd: cwdField,
      })
      .strict()
      .refine((d) => !d.head || d.base, {
        message: 'head requires base — diffing to a head ref without a base has no meaning',
      })
      .refine((d) => !d.staged || !d.base, {
        message: 'staged and base are mutually exclusive — use staged for --cached or base for ref diff',
      }),
    buildArgs: ({ staged, path, base, head }) => ({ args: buildDiffArgs({ staged, path, base, head }) }),
  }),
  defineRow({
    key: 'git_add',
    group: 'worktree',
    cmd: 'git',
    exec: 'local',
    description: 'Stage files for commit.',
    schema: z
      .object({ paths: z.array(z.string()).optional(), all: z.boolean().optional(), cwd: cwdField })
      .strict(),
    validate: ({ all, paths }) =>
      all || (paths?.length ?? 0) > 0
        ? { ok: true }
        : { ok: false, error: 'Provide paths or set all: true' },
    buildArgs: ({ paths, all }) => ({ args: buildAddArgs({ paths, all }) }),
  }),
  defineRow({
    key: 'git_reset',
    group: 'worktree',
    cmd: 'git',
    exec: 'local',
    description: 'Reset HEAD to a given ref.',
    schema: z
      .object({ mode: z.enum(['soft', 'mixed', 'hard']), ref: z.string().optional(), cwd: cwdField })
      .strict(),
    buildArgs: ({ mode, ref }) => ({ args: buildResetArgs({ mode, ref }) }),
  }),
  defineRow({
    key: 'git_stash',
    group: 'worktree',
    cmd: 'git',
    exec: 'local',
    description: 'Stash, pop, list, or drop the stash.',
    schema: z
      .object({
        action: z.enum(['push', 'pop', 'list', 'drop']),
        message: z.string().optional(),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ action, message }) => ({ args: buildStashArgs({ action, message }) }),
  }),
];
