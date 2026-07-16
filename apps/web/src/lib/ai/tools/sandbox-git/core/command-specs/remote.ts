/**
 * Pure argv builders for the remote-sync git subcommands (fetch, pull, push).
 * The push force/delete/default-branch guard is a separate pure decision
 * (core/refspec.ts evaluatePushGuard) run in the shell BEFORE this builds argv.
 * No effects. Branch-tested in `__tests__`.
 */
import { optFlag } from '../arg-builders';

export interface FetchArgsInput {
  remote?: string;
  branch?: string;
}

export function buildFetchArgs({ remote, branch }: FetchArgsInput): string[] {
  return ['fetch', remote ?? 'origin', ...(branch ? [branch] : [])];
}

export interface PullArgsInput {
  remote?: string;
  branch?: string;
  rebase?: boolean;
}

export function buildPullArgs({ remote, branch, rebase }: PullArgsInput): string[] {
  return ['pull', ...optFlag('--rebase', rebase), remote ?? 'origin', ...(branch ? [branch] : [])];
}

export interface PushArgsInput {
  remote?: string;
  branch?: string;
  force?: boolean;
  set_upstream?: boolean;
}

export function buildPushArgs({ remote, branch, force, set_upstream }: PushArgsInput): string[] {
  return [
    'push',
    ...optFlag('--force-with-lease', force),
    // set_upstream defaults to true — only an explicit `false` omits -u.
    ...(set_upstream !== false ? ['-u'] : []),
    remote ?? 'origin',
    ...(branch ? [branch] : []),
  ];
}
