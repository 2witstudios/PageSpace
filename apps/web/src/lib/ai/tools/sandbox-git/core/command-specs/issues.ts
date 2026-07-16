/**
 * Pure argv builders for the GitHub Issues subcommands (gh issue *). No effects.
 * Branch-tested in `__tests__`.
 */
import { csvFlag, optArg, buildGhJsonFlag } from '../arg-builders';

export interface IssueCreateArgsInput {
  title: string;
  body: string;
  labels?: string[];
}

export function buildIssueCreateArgs({ title, body, labels }: IssueCreateArgsInput): string[] {
  return ['issue', 'create', '--title', title, '--body', body, ...csvFlag('--label', labels)];
}

export interface IssueListArgsInput {
  state?: 'open' | 'closed' | 'all';
  limit?: number;
}

export function buildIssueListArgs({ state, limit }: IssueListArgsInput): string[] {
  return [
    'issue', 'list',
    '--state', state ?? 'open',
    '--limit', String(limit ?? 30),
    ...buildGhJsonFlag(['number', 'title', 'state', 'url', 'createdAt', 'labels']),
  ];
}

export function buildIssueViewArgs(number: number): string[] {
  return [
    'issue', 'view', String(number),
    ...buildGhJsonFlag(['number', 'title', 'body', 'state', 'url', 'labels', 'comments', 'assignees']),
  ];
}

export interface IssueCommentArgsInput {
  number: number;
  body: string;
}

export function buildIssueCommentArgs({ number, body }: IssueCommentArgsInput): string[] {
  return ['issue', 'comment', String(number), '--body', body];
}

export interface IssueEditArgsInput {
  number: number;
  title?: string;
  body?: string;
  add_labels?: string[];
  remove_labels?: string[];
  add_assignees?: string[];
  remove_assignees?: string[];
}

export function buildIssueEditArgs(input: IssueEditArgsInput): string[] {
  const { number, title, body, add_labels, remove_labels, add_assignees, remove_assignees } = input;
  return [
    'issue', 'edit', String(number),
    // title/body use `!== undefined` — an empty string is a valid edit value.
    ...(title !== undefined ? ['--title', title] : []),
    ...(body !== undefined ? ['--body', body] : []),
    ...csvFlag('--add-label', add_labels),
    ...csvFlag('--remove-label', remove_labels),
    ...csvFlag('--add-assignee', add_assignees),
    ...csvFlag('--remove-assignee', remove_assignees),
  ];
}

export interface IssueCloseArgsInput {
  number: number;
  comment?: string;
  reason?: 'completed' | 'not_planned';
}

export function buildIssueCloseArgs({ number, comment, reason }: IssueCloseArgsInput): string[] {
  return [
    'issue', 'close', String(number),
    ...optArg('--comment', comment),
    // gh spells the reason "not planned" (with a space), not the enum slug.
    ...(reason ? ['--reason', reason === 'not_planned' ? 'not planned' : 'completed'] : []),
  ];
}

export function buildIssueReopenArgs(number: number): string[] {
  return ['issue', 'reopen', String(number)];
}
