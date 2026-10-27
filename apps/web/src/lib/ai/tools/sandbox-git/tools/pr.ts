/**
 * Declarative rows for the GitHub PR tools (gh pr *). All token exec, cmd 'gh'.
 * Non-empty / at-least-one-field preconditions become single validators wired
 * into both the schema and execute.
 */
import { z } from 'zod';
import { defineRow, type GitToolRow } from './types';
import { cwdField } from './fields';
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
} from '../core/command-specs/pr';

const optionalNumber = z.number().int().positive().optional();
const requiredNumber = z.number().int().positive();

export const PR_TOOL_ROWS: GitToolRow[] = [
  defineRow({
    key: 'gh_pr_create',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description:
      'Create a pull request. Requires a connected GitHub account. head defaults to the current branch; pass it to name the PR head branch explicitly (bypasses the local upstream-tracking check).',
    schema: z
      .object({
        title: z.string().min(1),
        body: z.string(),
        base: z.string().optional(),
        head: z.string().optional(),
        draft: z.boolean().optional(),
        labels: z.array(z.string()).optional(),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ title }) => (title ? { ok: true } : { ok: false, error: 'title is required' }),
    buildArgs: ({ title, body, base, head, draft, labels }) => ({
      args: buildPrCreateArgs({ title, body, base, head, draft, labels }),
    }),
  }),
  defineRow({
    key: 'gh_pr_list',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description: 'List pull requests. Requires a connected GitHub account.',
    schema: z
      .object({
        state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
        limit: z.number().int().positive().max(100).optional(),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ state, limit }) => ({ args: buildPrListArgs({ state, limit }) }),
  }),
  defineRow({
    key: 'gh_pr_view',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description:
      'View a pull request with CI status, review state, and file change counts. Requires a connected GitHub account.',
    schema: z.object({ number: optionalNumber, cwd: cwdField }).strict(),
    buildArgs: ({ number }) => ({ args: buildPrViewArgs(number) }),
  }),
  defineRow({
    key: 'gh_pr_diff',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description:
      'Get the server-side diff for a pull request. Always merge-base correct, unaffected by local clone depth. Prefer this over git_diff for PR review. Requires a connected GitHub account.',
    schema: z.object({ number: optionalNumber, cwd: cwdField }).strict(),
    buildArgs: ({ number }) => ({ args: buildPrDiffArgs(number) }),
  }),
  defineRow({
    key: 'gh_pr_checks',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description:
      'List CI check statuses for a pull request (name, state, link). Each check is PASS/FAIL/PENDING/SKIP. Requires a connected GitHub account.',
    schema: z.object({ number: optionalNumber, cwd: cwdField }).strict(),
    buildArgs: ({ number }) => ({ args: buildPrChecksArgs(number) }),
  }),
  defineRow({
    key: 'gh_pr_merge',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description: 'Merge a pull request. Requires a connected GitHub account.',
    schema: z
      .object({
        number: optionalNumber,
        strategy: z.enum(['merge', 'squash', 'rebase']),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ number, strategy }) => ({ args: buildPrMergeArgs({ number, strategy }) }),
  }),
  defineRow({
    key: 'gh_pr_checkout',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description: 'Check out a pull request locally. Requires a connected GitHub account.',
    schema: z.object({ number: requiredNumber, cwd: cwdField }).strict(),
    buildArgs: ({ number }) => ({ args: buildPrCheckoutArgs(number) }),
  }),
  defineRow({
    key: 'gh_pr_review',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description:
      'Submit a review on a pull request: approve, request changes, or leave a comment. Requires a connected GitHub account.',
    schema: z
      .object({
        number: requiredNumber,
        action: z.enum(['approve', 'request_changes', 'comment']),
        body: z.string().optional().describe('Review body / comment text'),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ number, action, body }) => ({ args: buildPrReviewArgs({ number, action, body }) }),
  }),
  defineRow({
    key: 'gh_pr_review_comment',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description:
      'Add a review comment on a pull request. For inline comments: provide path, commit_id, and line. For file-level comments: provide path, commit_id, and subject_type "file". For replies: provide in_reply_to (comment ID) and body only. Use head sha from gh_pr_view for commit_id. Requires a connected GitHub account.',
    schema: z
      .object({
        number: requiredNumber,
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
    validate: ({ body, path, commit_id, in_reply_to }) => {
      if (!body) return { ok: false, error: 'body is required' };
      // A reply needs only in_reply_to + body. Any other review comment attaches
      // to a file, which the GitHub API requires BOTH path and commit_id for —
      // reject an incomplete shape early with a clear message rather than letting
      // the API 422. (line vs subject_type is left to the API to arbitrate.)
      if (in_reply_to === undefined) {
        if (path === undefined) {
          return { ok: false, error: 'Provide path (for an inline or file-level comment) or in_reply_to (to reply)' };
        }
        if (commit_id === undefined) {
          return { ok: false, error: 'commit_id is required for an inline or file-level comment (use the head sha from gh_pr_view)' };
        }
      }
      return { ok: true };
    },
    buildArgs: ({ number, body, path, line, side, commit_id, start_line, start_side, in_reply_to, subject_type }) => ({
      args: buildPrReviewCommentArgs({ number, body, path, line, side, commit_id, start_line, start_side, in_reply_to, subject_type }),
    }),
  }),
  defineRow({
    key: 'gh_pr_comment',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description:
      'Add a top-level conversation comment on a pull request (not a review). For inline code comments use gh_pr_review_comment; to approve/request changes use gh_pr_review. Requires a connected GitHub account.',
    schema: z
      .object({ number: requiredNumber, body: z.string().min(1), cwd: cwdField })
      .strict(),
    validate: ({ body }) => (body ? { ok: true } : { ok: false, error: 'body is required' }),
    buildArgs: ({ number, body }) => ({ args: buildPrCommentArgs({ number, body }) }),
  }),
  defineRow({
    key: 'gh_pr_edit',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description:
      'Edit a pull request: title, body, base branch, labels, or reviewers. Use to keep the PR description current as follow-up commits land. Requires a connected GitHub account.',
    schema: z
      .object({
        number: requiredNumber,
        title: z.string().optional(),
        body: z.string().optional(),
        base: z.string().optional().describe('New base branch'),
        add_labels: z.array(z.string()).optional(),
        remove_labels: z.array(z.string()).optional(),
        add_reviewers: z.array(z.string()).optional().describe('GitHub usernames to request review from'),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ title, body, base, add_labels, remove_labels, add_reviewers }) =>
      title !== undefined ||
      body !== undefined ||
      base !== undefined ||
      !!add_labels?.length ||
      !!remove_labels?.length ||
      !!add_reviewers?.length
        ? { ok: true }
        : { ok: false, error: 'Provide at least one field to edit' },
    buildArgs: ({ number, title, body, base, add_labels, remove_labels, add_reviewers }) => ({
      args: buildPrEditArgs({ number, title, body, base, add_labels, remove_labels, add_reviewers }),
    }),
  }),
  defineRow({
    key: 'gh_pr_update_branch',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description:
      'Update a pull request branch with the latest changes from its base branch (like the "Update branch" button). Requires a connected GitHub account.',
    schema: z.object({ number: requiredNumber, cwd: cwdField }).strict(),
    buildArgs: ({ number }) => ({ args: buildPrUpdateBranchArgs(number) }),
  }),
  defineRow({
    key: 'gh_pr_thread_list',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description:
      'List review threads on a pull request with their resolved state and thread IDs. Use the thread id with gh_pr_thread_resolve after addressing feedback. Requires a connected GitHub account.',
    schema: z
      .object({
        owner: z.string().min(1).describe('Repository owner'),
        repo: z.string().min(1).describe('Repository name'),
        number: requiredNumber,
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ owner, repo, number }) => ({ args: buildPrThreadListArgs({ owner, repo, number }) }),
  }),
  defineRow({
    key: 'gh_pr_thread_resolve',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description:
      'Resolve a pull request review thread after its feedback has been addressed. Get thread IDs from gh_pr_thread_list. Requires a connected GitHub account.',
    schema: z
      .object({
        thread_id: z.string().min(1).describe('Review thread node ID from gh_pr_thread_list'),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ thread_id }) => (thread_id ? { ok: true } : { ok: false, error: 'thread_id is required' }),
    buildArgs: ({ thread_id }) => ({ args: buildPrThreadResolveArgs(thread_id) }),
  }),
  defineRow({
    key: 'gh_pr_close',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description: 'Close a pull request with an optional comment. Requires a connected GitHub account.',
    schema: z
      .object({
        number: requiredNumber,
        comment: z.string().optional().describe('Comment to post when closing'),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ number, comment }) => ({ args: buildPrCloseArgs({ number, comment }) }),
  }),
  defineRow({
    key: 'gh_pr_reopen',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description: 'Reopen a closed pull request. Requires a connected GitHub account.',
    schema: z.object({ number: requiredNumber, cwd: cwdField }).strict(),
    buildArgs: ({ number }) => ({ args: buildPrReopenArgs(number) }),
  }),
  defineRow({
    key: 'gh_pr_ready',
    group: 'pr',
    cmd: 'gh',
    exec: 'token',
    description: 'Mark a draft pull request as ready for review. Requires a connected GitHub account.',
    schema: z.object({ number: requiredNumber, cwd: cwdField }).strict(),
    buildArgs: ({ number }) => ({ args: buildPrReadyArgs(number) }),
  }),
];
