/**
 * Pure argv builders for the working-tree git subcommands (status, diff, add,
 * reset, stash). No effects. Branch-tested in `__tests__`.
 */
import { optArg, optFlag } from '../arg-builders';

export function buildStatusArgs(path?: string): string[] {
  return ['status', '--porcelain', ...optArg('--', path)];
}

export interface DiffArgsInput {
  staged?: boolean;
  path?: string;
  base?: string;
  head?: string;
}

export function buildDiffArgs({ staged, path, base, head }: DiffArgsInput): string[] {
  // base present → three-dot merge-base diff (only changes unique to head).
  // Otherwise → working-tree diff, optionally --cached for staged.
  if (base) {
    return ['diff', `${base}...${head ?? 'HEAD'}`, ...optArg('--', path)];
  }
  return ['diff', ...optFlag('--cached', staged), ...optArg('--', path)];
}

export interface AddArgsInput {
  paths?: string[];
  all?: boolean;
}

export function buildAddArgs({ paths, all }: AddArgsInput): string[] {
  // `--` before the pathspecs, exactly as buildStatusArgs/buildDiffArgs do: without
  // it a path like `-p` is read as a FLAG (interactive add), and other dash-prefixed
  // values are reinterpreted as options rather than files. `-A` is our own literal,
  // so it stays ahead of the separator.
  if (all) return ['add', '-A'];
  const list = paths ?? [];
  // `--` only when there is something to separate: a bare trailing `--` is
  // meaningless (and the row's own validate refuses the no-paths-no-all case).
  return list.length > 0 ? ['add', '--', ...list] : ['add'];
}

export interface ResetArgsInput {
  mode: 'soft' | 'mixed' | 'hard';
  ref?: string;
}

export function buildResetArgs({ mode, ref }: ResetArgsInput): string[] {
  return ['reset', `--${mode}`, ...(ref ? [ref] : [])];
}

export interface StashArgsInput {
  action: 'push' | 'pop' | 'list' | 'drop';
  message?: string;
}

export function buildStashArgs({ action, message }: StashArgsInput): string[] {
  return action === 'push'
    ? ['stash', 'push', ...optArg('-m', message)]
    : ['stash', action];
}
