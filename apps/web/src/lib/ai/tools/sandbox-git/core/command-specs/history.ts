/**
 * Pure argv builders for the history/branching git subcommands (commit, log,
 * show, blame, merge, rebase, revert, checkout, branch). The merge/rebase/revert
 * action dispatchers ignore positional args entirely on abort/continue — there
 * is no flag-injection surface in a recovery action. No effects. Branch-tested.
 */
import { optArg, optFlag } from '../arg-builders';

export interface CommitArgsInput {
  message: string;
  amend?: boolean;
}

export function buildCommitArgs({ message, amend }: CommitArgsInput): string[] {
  return ['commit', '-m', message, ...(amend ? ['--amend', '--no-edit'] : [])];
}

export interface LogArgsInput {
  n?: number;
  path?: string;
  oneline?: boolean;
}

export function buildLogArgs({ n, path, oneline }: LogArgsInput): string[] {
  return ['log', ...optFlag('--oneline', oneline ?? true), `-${n ?? 20}`, ...optArg('--', path)];
}

export interface ShowArgsInput {
  ref?: string;
  stat?: boolean;
  path?: string;
}

export function buildShowArgs({ ref, stat, path }: ShowArgsInput): string[] {
  return ['show', ...optFlag('--stat', stat), ref ?? 'HEAD', ...optArg('--', path)];
}

export interface BlameArgsInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

export function buildBlameArgs({ path, start_line, end_line }: BlameArgsInput): string[] {
  return [
    'blame',
    ...(start_line !== undefined ? ['-L', `${start_line},${end_line}`] : []),
    '--',
    path,
  ];
}

export type RecoverableAction = 'run' | 'abort' | 'continue';

export interface MergeArgsInput {
  branch?: string;
  strategy?: 'merge' | 'squash' | 'ff-only';
  action?: RecoverableAction;
}

export function buildMergeArgs({ branch, strategy, action }: MergeArgsInput): string[] {
  const mode = action ?? 'run';
  if (mode !== 'run') {
    return ['merge', `--${mode}`];
  }
  const strategyFlag =
    strategy === 'squash' ? ['--squash'] : strategy === 'ff-only' ? ['--ff-only'] : [];
  return ['merge', ...strategyFlag, ...(branch ? [branch] : [])];
}

export interface RebaseArgsInput {
  branch_or_ref?: string;
  action?: RecoverableAction;
}

export function buildRebaseArgs({ branch_or_ref, action }: RebaseArgsInput): string[] {
  const mode = action ?? 'run';
  if (mode !== 'run') {
    return ['rebase', `--${mode}`];
  }
  return ['rebase', ...(branch_or_ref ? [branch_or_ref] : [])];
}

export interface RevertArgsInput {
  sha?: string;
  action?: RecoverableAction;
  mainline?: number;
}

export function buildRevertArgs({ sha, action, mainline }: RevertArgsInput): string[] {
  const mode = action ?? 'run';
  if (mode !== 'run') {
    return ['revert', `--${mode}`];
  }
  return [
    'revert',
    '--no-edit',
    ...(mainline ? ['-m', String(mainline)] : []),
    ...(sha ? [sha] : []),
  ];
}

export interface CheckoutArgsInput {
  ref: string;
  create?: boolean;
}

export function buildCheckoutArgs({ ref, create }: CheckoutArgsInput): string[] {
  return ['checkout', ...optFlag('-b', create), ref];
}

export interface BranchArgsInput {
  action: 'list' | 'create' | 'delete';
  name?: string;
}

export function buildBranchArgs({ action, name }: BranchArgsInput): string[] {
  if (action === 'list') return ['branch', '-a'];
  if (action === 'delete') return ['branch', '-d', name ?? ''];
  return ['branch', name ?? ''];
}
