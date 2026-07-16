/**
 * Declarative rows for the history/branching tools. The merge/rebase/revert
 * validators only fire in run mode — abort/continue ignore positional args
 * entirely (no flag-injection surface), matching the pure command specs.
 */
import { z } from 'zod';
import { defineRow, type GitToolRow } from './types';
import { cwdField } from './fields';
import { validateFlagSafe, validateShaOnly } from '../core/validators';
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
} from '../core/command-specs/history';

export const HISTORY_TOOL_ROWS: GitToolRow[] = [
  defineRow({
    key: 'git_commit',
    group: 'history',
    cmd: 'git',
    exec: 'local',
    description: 'Create a commit with the given message.',
    schema: z
      .object({ message: z.string().min(1), amend: z.boolean().optional(), cwd: cwdField })
      .strict(),
    validate: ({ message }) =>
      message ? { ok: true } : { ok: false, error: 'commit message is required' },
    buildArgs: ({ message, amend }) => ({ args: buildCommitArgs({ message, amend }) }),
  }),
  defineRow({
    key: 'git_log',
    group: 'history',
    cmd: 'git',
    exec: 'local',
    description: 'Show commit history. Defaults to last 20 commits in oneline format.',
    schema: z
      .object({
        n: z.number().int().positive().max(100).optional(),
        path: z.string().optional(),
        oneline: z.boolean().optional(),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ n, path, oneline }) => ({ args: buildLogArgs({ n, path, oneline }) }),
  }),
  defineRow({
    key: 'git_show',
    group: 'history',
    cmd: 'git',
    exec: 'local',
    description:
      'Show a commit: message, author, and full diff (or --stat summary). Use with SHAs from git_log.',
    schema: z
      .object({
        ref: z.string().min(1).optional().describe('Commit SHA or ref (defaults to HEAD)'),
        stat: z.boolean().optional().describe('Show a diffstat summary instead of the full patch'),
        path: z.string().optional().describe('Limit output to a single file path'),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ ref }) => (ref === undefined ? { ok: true } : validateFlagSafe(ref, 'ref')),
    buildArgs: ({ ref, stat, path }) => ({ args: buildShowArgs({ ref, stat, path }) }),
  }),
  defineRow({
    key: 'git_blame',
    group: 'history',
    cmd: 'git',
    exec: 'local',
    description: 'Show which commit and author last modified each line of a file.',
    schema: z
      .object({
        path: z.string().min(1),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ start_line, end_line }) =>
      (start_line === undefined) === (end_line === undefined)
        ? { ok: true }
        : { ok: false, error: 'start_line and end_line must be provided together' },
    buildArgs: ({ path, start_line, end_line }) => ({ args: buildBlameArgs({ path, start_line, end_line }) }),
  }),
  defineRow({
    key: 'git_merge',
    group: 'history',
    cmd: 'git',
    exec: 'local',
    description:
      'Merge a branch. If a previous merge stopped on conflicts, use action "abort" to back out or "continue" after resolving.',
    schema: z
      .object({
        branch: z.string().min(1).optional().describe('Branch to merge (required unless aborting/continuing)'),
        strategy: z.enum(['merge', 'squash', 'ff-only']).optional(),
        action: z
          .enum(['run', 'abort', 'continue'])
          .optional()
          .describe('run (default) merges a branch; abort/continue recover a conflicted merge'),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ branch, action }) => {
      if ((action ?? 'run') !== 'run') return { ok: true };
      if (!branch) return { ok: false, error: 'branch is required when running a merge' };
      return validateFlagSafe(branch, 'branch');
    },
    buildArgs: ({ branch, strategy, action }) => ({ args: buildMergeArgs({ branch, strategy, action }) }),
  }),
  defineRow({
    key: 'git_rebase',
    group: 'history',
    cmd: 'git',
    exec: 'local',
    description:
      'Rebase onto a branch or ref. Non-interactive only. If a previous rebase stopped on conflicts, use action "abort" to back out or "continue" after resolving.',
    schema: z
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
      .strict(),
    validate: ({ branch_or_ref, action }) => {
      if ((action ?? 'run') !== 'run') return { ok: true };
      if (!branch_or_ref) return { ok: false, error: 'branch_or_ref is required when running a rebase' };
      return validateFlagSafe(branch_or_ref, 'branch_or_ref');
    },
    buildArgs: ({ branch_or_ref, action }) => ({ args: buildRebaseArgs({ branch_or_ref, action }) }),
  }),
  defineRow({
    key: 'git_revert',
    group: 'history',
    cmd: 'git',
    exec: 'local',
    description:
      'Revert a single commit by creating a new commit that undoes it. Safe forward-fix — history is not rewritten. Takes one commit SHA (no ranges). If a previous revert stopped on conflicts, use action "abort" to back out or "continue" after resolving. Reverting a merge commit requires "mainline" (the parent number to revert to).',
    schema: z
      .object({
        sha: z.string().optional().describe('Commit to revert (required unless aborting/continuing)'),
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
      .strict(),
    validate: ({ sha, action }) => {
      if ((action ?? 'run') !== 'run') return { ok: true };
      if (!sha) {
        return { ok: false, error: 'sha must be a single lowercase commit SHA (no ranges or refs)' };
      }
      return validateShaOnly(sha);
    },
    buildArgs: ({ sha, action, mainline }) => ({ args: buildRevertArgs({ sha, action, mainline }) }),
  }),
  defineRow({
    key: 'git_checkout',
    group: 'history',
    cmd: 'git',
    exec: 'local',
    description: 'Switch branches or create a new one.',
    schema: z
      .object({ ref: z.string().min(1), create: z.boolean().optional(), cwd: cwdField })
      .strict(),
    // ref is passed as a bare argv element, so a flag-like value (--detach,
    // --orphan) would be parsed as an option — reject it, as the other history
    // tools do. A real branch/ref name never starts with "-".
    validate: ({ ref }) => validateFlagSafe(ref, 'ref'),
    buildArgs: ({ ref, create }) => ({ args: buildCheckoutArgs({ ref, create }) }),
  }),
  defineRow({
    key: 'git_branch',
    group: 'history',
    cmd: 'git',
    exec: 'local',
    description: 'List, create, or delete branches.',
    schema: z
      .object({ action: z.enum(['list', 'create', 'delete']), name: z.string().optional(), cwd: cwdField })
      .strict(),
    // list ignores name (branch -a). create/delete require a name AND reject a
    // flag-like one — `name` is a bare argv element, so `--contains` etc. would
    // be parsed as an option.
    validate: ({ action, name }) => {
      if (action === 'list') return { ok: true };
      if (!name) return { ok: false, error: 'name is required for create/delete' };
      return validateFlagSafe(name, 'name');
    },
    buildArgs: ({ action, name }) => ({ args: buildBranchArgs({ action, name }) }),
  }),
];
