/**
 * Declarative rows for the GitHub Issues tools (gh issue *). Token exec, cmd 'gh'.
 */
import { z } from 'zod';
import { defineRow, type GitToolRow } from './types';
import { cwdField } from './fields';
import {
  buildIssueCreateArgs,
  buildIssueListArgs,
  buildIssueViewArgs,
  buildIssueCommentArgs,
  buildIssueEditArgs,
  buildIssueCloseArgs,
  buildIssueReopenArgs,
} from '../core/command-specs/issues';

const requiredNumber = z.number().int().positive();

export const ISSUES_TOOL_ROWS: GitToolRow[] = [
  defineRow({
    key: 'gh_issue_create',
    group: 'issues',
    cmd: 'gh',
    exec: 'token',
    description: 'Create an issue. Requires a connected GitHub account.',
    schema: z
      .object({
        title: z.string().min(1),
        body: z.string(),
        labels: z.array(z.string()).optional(),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ title }) => (title ? { ok: true } : { ok: false, error: 'title is required' }),
    buildArgs: ({ title, body, labels }) => ({ args: buildIssueCreateArgs({ title, body, labels }) }),
  }),
  defineRow({
    key: 'gh_issue_list',
    group: 'issues',
    cmd: 'gh',
    exec: 'token',
    description: 'List issues. Requires a connected GitHub account.',
    schema: z
      .object({
        state: z.enum(['open', 'closed', 'all']).optional(),
        limit: z.number().int().positive().max(100).optional(),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ state, limit }) => ({ args: buildIssueListArgs({ state, limit }) }),
  }),
  defineRow({
    key: 'gh_issue_view',
    group: 'issues',
    cmd: 'gh',
    exec: 'token',
    description: 'View an issue. Requires a connected GitHub account.',
    schema: z.object({ number: requiredNumber, cwd: cwdField }).strict(),
    buildArgs: ({ number }) => ({ args: buildIssueViewArgs(number) }),
  }),
  defineRow({
    key: 'gh_issue_comment',
    group: 'issues',
    cmd: 'gh',
    exec: 'token',
    description: 'Add a comment to an issue. Requires a connected GitHub account.',
    schema: z
      .object({ number: requiredNumber, body: z.string().min(1), cwd: cwdField })
      .strict(),
    validate: ({ body }) => (body ? { ok: true } : { ok: false, error: 'body is required' }),
    buildArgs: ({ number, body }) => ({ args: buildIssueCommentArgs({ number, body }) }),
  }),
  defineRow({
    key: 'gh_issue_edit',
    group: 'issues',
    cmd: 'gh',
    exec: 'token',
    description: 'Edit an issue: title, body, labels, or assignees. Requires a connected GitHub account.',
    schema: z
      .object({
        number: requiredNumber,
        title: z.string().optional(),
        body: z.string().optional(),
        add_labels: z.array(z.string()).optional(),
        remove_labels: z.array(z.string()).optional(),
        add_assignees: z.array(z.string()).optional().describe('GitHub usernames to assign'),
        remove_assignees: z.array(z.string()).optional().describe('GitHub usernames to unassign'),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ title, body, add_labels, remove_labels, add_assignees, remove_assignees }) =>
      title !== undefined ||
      body !== undefined ||
      !!add_labels?.length ||
      !!remove_labels?.length ||
      !!add_assignees?.length ||
      !!remove_assignees?.length
        ? { ok: true }
        : { ok: false, error: 'Provide at least one field to edit' },
    buildArgs: ({ number, title, body, add_labels, remove_labels, add_assignees, remove_assignees }) => ({
      args: buildIssueEditArgs({ number, title, body, add_labels, remove_labels, add_assignees, remove_assignees }),
    }),
  }),
  defineRow({
    key: 'gh_issue_close',
    group: 'issues',
    cmd: 'gh',
    exec: 'token',
    description: 'Close an issue with an optional comment and reason. Requires a connected GitHub account.',
    schema: z
      .object({
        number: requiredNumber,
        comment: z.string().optional().describe('Comment to post when closing'),
        reason: z.enum(['completed', 'not_planned']).optional(),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ number, comment, reason }) => ({ args: buildIssueCloseArgs({ number, comment, reason }) }),
  }),
  defineRow({
    key: 'gh_issue_reopen',
    group: 'issues',
    cmd: 'gh',
    exec: 'token',
    description: 'Reopen a closed issue. Requires a connected GitHub account.',
    schema: z.object({ number: requiredNumber, cwd: cwdField }).strict(),
    buildArgs: ({ number }) => ({ args: buildIssueReopenArgs(number) }),
  }),
];
