/**
 * Declarative rows for the repo/config tools (git_clone, git_init, git_config,
 * git_remote_add). The two destination-path tools resolve their path via the
 * pure resolveSandboxPath and express a denial as a `path_escape` BuildArgsResult.
 */
import { z } from 'zod';
import { resolveSandboxPath, SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';
import { defineRow, type GitToolRow } from './types';
import { cwdField } from './fields';
import { assertHttps } from '../core/validators';
import {
  buildCloneArgs,
  buildInitArgs,
  buildConfigArgs,
  buildRemoteAddArgs,
} from '../core/command-specs/repo';

/** Resolve an optional destination path (default SANDBOX_ROOT), as pure data. */
function resolveDestination(
  path: string | undefined,
): { path: string } | { error: string; reason: 'path_escape' } {
  const resolved = path !== undefined ? resolveSandboxPath(path) : SANDBOX_ROOT;
  if (!resolved) {
    return { error: 'The path is invalid or escapes the sandbox root.', reason: 'path_escape' };
  }
  return { path: resolved };
}

export const REPO_TOOL_ROWS: GitToolRow[] = [
  defineRow({
    key: 'git_clone',
    group: 'repo',
    cmd: 'git',
    exec: 'local',
    description:
      'Clone a GitHub repository into the sandbox. Use HTTPS URLs only. Fetches all branch refs (even with depth) so later-created branches get proper origin tracking refs — required for git_push -u and gh_pr_create to work.',
    schema: z
      .object({
        repo_url: z.string().url(),
        path: z.string().optional(),
        depth: z.number().int().positive().optional(),
      })
      .strict(),
    validate: ({ repo_url }) => assertHttps(repo_url, 'git clone'),
    buildArgs: ({ repo_url, path, depth }) => {
      const dest = resolveDestination(path);
      if ('error' in dest) return dest;
      return { args: buildCloneArgs({ repoUrl: repo_url, path: dest.path, depth }) };
    },
  }),
  defineRow({
    key: 'git_init',
    group: 'repo',
    cmd: 'git',
    exec: 'local',
    description: 'Initialize a new git repository in the sandbox.',
    schema: z.object({ path: z.string().optional() }).strict(),
    buildArgs: ({ path }) => {
      const dest = resolveDestination(path);
      if ('error' in dest) return dest;
      return { args: buildInitArgs(dest.path) };
    },
  }),
  defineRow({
    key: 'git_config',
    group: 'repo',
    cmd: 'git',
    exec: 'local',
    description: 'Set a git config value.',
    schema: z
      .object({
        key: z.string().min(1),
        value: z.string(),
        global: z.boolean().optional(),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ key, value, global }) => ({ args: buildConfigArgs({ key, value, global }) }),
  }),
  defineRow({
    key: 'git_remote_add',
    group: 'repo',
    cmd: 'git',
    exec: 'local',
    description: 'Add a remote to the repository. Use HTTPS URLs only.',
    schema: z
      .object({
        name: z.string().min(1),
        url: z.string().url(),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ url }) => assertHttps(url, 'git remote add'),
    buildArgs: ({ name, url }) => ({ args: buildRemoteAddArgs({ name, url }) }),
  }),
];
