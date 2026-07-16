/**
 * Pure argv builders for the GitHub PR subcommands (gh pr *, plus the two
 * review-thread GraphQL calls). No effects. Branch-tested in `__tests__`.
 *
 * The GraphQL documents are module-level constants — variables are passed via
 * separate -f/-F flags (buildApiKvArgs), never interpolated into the document,
 * so tool input can't alter the query shape.
 */
import { csvFlag, optArg, optFlag, buildGhJsonFlag, buildApiKvArgs } from '../arg-builders';

const LIST_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 10) {
            nodes { databaseId author { login } body }
          }
        }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}`;

/** `...(number ? [String(number)] : [])` for the tools where number is optional. */
function optNumber(number?: number): string[] {
  return number ? [String(number)] : [];
}

export interface PrCreateArgsInput {
  title: string;
  body: string;
  base?: string;
  head?: string;
  draft?: boolean;
  labels?: string[];
}

export function buildPrCreateArgs({ title, body, base, head, draft, labels }: PrCreateArgsInput): string[] {
  return [
    'pr', 'create',
    '--title', title,
    '--body', body,
    ...optArg('--base', base),
    ...optArg('--head', head),
    ...optFlag('--draft', draft),
    ...csvFlag('--label', labels),
  ];
}

export interface PrListArgsInput {
  state?: 'open' | 'closed' | 'merged' | 'all';
  limit?: number;
}

export function buildPrListArgs({ state, limit }: PrListArgsInput): string[] {
  return [
    'pr', 'list',
    '--state', state ?? 'open',
    '--limit', String(limit ?? 30),
    ...buildGhJsonFlag(['number', 'title', 'state', 'url', 'headRefName', 'createdAt']),
  ];
}

export function buildPrViewArgs(number?: number): string[] {
  return [
    'pr', 'view',
    ...optNumber(number),
    ...buildGhJsonFlag([
      'number', 'title', 'body', 'state', 'url', 'headRefName', 'baseRefName',
      'mergeable', 'additions', 'deletions', 'changedFiles', 'statusCheckRollup',
      'reviewDecision', 'isDraft',
    ]),
  ];
}

export function buildPrDiffArgs(number?: number): string[] {
  return ['pr', 'diff', ...optNumber(number), '--color', 'never'];
}

export function buildPrChecksArgs(number?: number): string[] {
  return [
    'pr', 'checks',
    ...optNumber(number),
    ...buildGhJsonFlag(['name', 'state', 'startedAt', 'completedAt', 'link']),
  ];
}

export interface PrMergeArgsInput {
  number?: number;
  strategy: 'merge' | 'squash' | 'rebase';
}

export function buildPrMergeArgs({ number, strategy }: PrMergeArgsInput): string[] {
  return [
    'pr', 'merge',
    ...optNumber(number),
    strategy === 'squash' ? '--squash' : strategy === 'rebase' ? '--rebase' : '--merge',
    '--auto',
  ];
}

export function buildPrCheckoutArgs(number: number): string[] {
  return ['pr', 'checkout', String(number)];
}

export interface PrReviewArgsInput {
  number: number;
  action: 'approve' | 'request_changes' | 'comment';
  body?: string;
}

export function buildPrReviewArgs({ number, action, body }: PrReviewArgsInput): string[] {
  return [
    'pr', 'review', String(number),
    ...(action === 'approve'
      ? ['--approve']
      : action === 'request_changes'
        ? ['--request-changes']
        : ['--comment']),
    ...optArg('--body', body),
  ];
}

export interface PrReviewCommentArgsInput {
  number: number;
  body: string;
  path?: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  commit_id?: string;
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  in_reply_to?: number;
  subject_type?: 'line' | 'file';
}

export function buildPrReviewCommentArgs(input: PrReviewCommentArgsInput): string[] {
  const { number, body, path, line, side, commit_id, start_line, start_side, in_reply_to, subject_type } = input;
  return [
    'api', `repos/{owner}/{repo}/pulls/${number}/comments`,
    ...buildApiKvArgs('-f', 'body', body),
    ...(path !== undefined ? buildApiKvArgs('-f', 'path', path) : []),
    ...(line !== undefined ? buildApiKvArgs('-F', 'line', line) : []),
    ...(side ? buildApiKvArgs('-f', 'side', side) : []),
    ...(commit_id !== undefined ? buildApiKvArgs('-f', 'commit_id', commit_id) : []),
    ...(start_line !== undefined ? buildApiKvArgs('-F', 'start_line', start_line) : []),
    ...(start_side ? buildApiKvArgs('-f', 'start_side', start_side) : []),
    ...(in_reply_to !== undefined ? buildApiKvArgs('-F', 'in_reply_to', in_reply_to) : []),
    ...(subject_type ? buildApiKvArgs('-f', 'subject_type', subject_type) : []),
  ];
}

export interface PrCommentArgsInput {
  number: number;
  body: string;
}

export function buildPrCommentArgs({ number, body }: PrCommentArgsInput): string[] {
  return ['pr', 'comment', String(number), '--body', body];
}

export interface PrEditArgsInput {
  number: number;
  title?: string;
  body?: string;
  base?: string;
  add_labels?: string[];
  remove_labels?: string[];
  add_reviewers?: string[];
}

export function buildPrEditArgs(input: PrEditArgsInput): string[] {
  const { number, title, body, base, add_labels, remove_labels, add_reviewers } = input;
  return [
    'pr', 'edit', String(number),
    // title/body/base use `!== undefined` — an empty string is a valid edit value.
    ...(title !== undefined ? ['--title', title] : []),
    ...(body !== undefined ? ['--body', body] : []),
    ...(base !== undefined ? ['--base', base] : []),
    ...csvFlag('--add-label', add_labels),
    ...csvFlag('--remove-label', remove_labels),
    ...csvFlag('--add-reviewer', add_reviewers),
  ];
}

export function buildPrUpdateBranchArgs(number: number): string[] {
  return ['pr', 'update-branch', String(number)];
}

export interface PrThreadListArgsInput {
  owner: string;
  repo: string;
  number: number;
}

export function buildPrThreadListArgs({ owner, repo, number }: PrThreadListArgsInput): string[] {
  return [
    'api', 'graphql',
    ...buildApiKvArgs('-f', 'query', LIST_THREADS_QUERY),
    ...buildApiKvArgs('-f', 'owner', owner),
    ...buildApiKvArgs('-f', 'repo', repo),
    ...buildApiKvArgs('-F', 'number', number),
  ];
}

export function buildPrThreadResolveArgs(threadId: string): string[] {
  return [
    'api', 'graphql',
    ...buildApiKvArgs('-f', 'query', RESOLVE_THREAD_MUTATION),
    ...buildApiKvArgs('-f', 'threadId', threadId),
  ];
}

export interface PrCloseArgsInput {
  number: number;
  comment?: string;
}

export function buildPrCloseArgs({ number, comment }: PrCloseArgsInput): string[] {
  return ['pr', 'close', String(number), ...optArg('--comment', comment)];
}

export function buildPrReopenArgs(number: number): string[] {
  return ['pr', 'reopen', String(number)];
}

export function buildPrReadyArgs(number: number): string[] {
  return ['pr', 'ready', String(number)];
}
