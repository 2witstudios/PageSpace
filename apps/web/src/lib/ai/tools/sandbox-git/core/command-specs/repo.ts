/**
 * Pure argv builders for the repo/config git subcommands (clone, init, config,
 * remote add). Each takes the tool's parsed input and returns the `git` argv —
 * no effects. Destination-path resolution (an effect) happens in the shell and
 * the already-resolved path is passed in. Branch-tested in `__tests__`.
 */
import { optFlag } from '../arg-builders';

export interface CloneArgsInput {
  repoUrl: string;
  /** Already-resolved sandbox path (resolveSandboxPath ran in the shell). */
  path: string;
  depth?: number;
}

export function buildCloneArgs({ repoUrl, path, depth }: CloneArgsInput): string[] {
  // `--depth` implies `--single-branch`; `--no-single-branch` keeps the wildcard
  // fetch refspec so later-created branches still get an origin tracking ref.
  return [
    'clone',
    ...(depth ? ['--no-single-branch', '--depth', String(depth)] : []),
    repoUrl,
    path,
  ];
}

export function buildInitArgs(path: string): string[] {
  return ['init', path];
}

export interface ConfigArgsInput {
  key: string;
  value: string;
  global?: boolean;
}

export function buildConfigArgs({ key, value, global }: ConfigArgsInput): string[] {
  return ['config', ...optFlag('--global', global), key, value];
}

export interface RemoteAddArgsInput {
  name: string;
  url: string;
}

export function buildRemoteAddArgs({ name, url }: RemoteAddArgsInput): string[] {
  return ['remote', 'add', name, url];
}
