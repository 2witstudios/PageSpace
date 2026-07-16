/**
 * Declarative rows for the GitHub repo / search / label tools. Token exec, cmd
 * 'gh'. Flag-injection guards (validateFlagSafe / validateRepoName) become
 * validators wired into both the schema and execute.
 */
import { z } from 'zod';
import { defineRow, type GitToolRow } from './types';
import { cwdField } from './fields';
import { validateFlagSafe, validateRepoName } from '../core/validators';
import {
  buildRepoViewArgs,
  buildRepoListArgs,
  buildRepoForkArgs,
  buildRepoCreateArgs,
  buildSearchArgs,
  buildLabelListArgs,
} from '../core/command-specs/repos-search';

export const REPOS_SEARCH_TOOL_ROWS: GitToolRow[] = [
  defineRow({
    key: 'gh_repo_view',
    group: 'repos-search',
    cmd: 'gh',
    exec: 'token',
    description:
      'View a repository: default branch, visibility, and description. Use before cloning to discover the default branch instead of guessing main/master. Requires a connected GitHub account.',
    schema: z
      .object({
        repo: z.string().optional().describe('Repository as "owner/repo" (defaults to the repo in cwd)'),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ repo }) => (repo === undefined ? { ok: true } : validateFlagSafe(repo, 'repo')),
    buildArgs: ({ repo }) => ({ args: buildRepoViewArgs(repo) }),
  }),
  defineRow({
    key: 'gh_repo_list',
    group: 'repos-search',
    cmd: 'gh',
    exec: 'token',
    description:
      'List repositories for the connected account or a given owner/org. Use to discover repos to clone. Requires a connected GitHub account.',
    schema: z
      .object({
        owner: z.string().optional().describe('User or org to list repos for (defaults to the connected account)'),
        limit: z.number().int().positive().max(100).optional(),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ owner }) => (owner === undefined ? { ok: true } : validateFlagSafe(owner, 'owner')),
    buildArgs: ({ owner, limit }) => ({ args: buildRepoListArgs({ owner, limit }) }),
  }),
  defineRow({
    key: 'gh_repo_fork',
    group: 'repos-search',
    cmd: 'gh',
    exec: 'token',
    description:
      'Fork a repository to the connected account (fork only — clone it explicitly with git_clone afterwards). Use to contribute to repos without push access. Requires a connected GitHub account.',
    schema: z
      .object({ repo: z.string().min(1).describe('Repository to fork as "owner/repo"'), cwd: cwdField })
      .strict(),
    validate: ({ repo }) => {
      if (!repo) return { ok: false, error: 'repo is required' };
      return validateFlagSafe(repo, 'repo');
    },
    buildArgs: ({ repo }) => ({ args: buildRepoForkArgs(repo) }),
  }),
  defineRow({
    key: 'gh_repo_create',
    group: 'repos-search',
    cmd: 'gh',
    exec: 'token',
    description:
      'Create a new repository on the connected account. Visibility must be chosen explicitly. Requires a connected GitHub account.',
    schema: z
      .object({
        name: z.string(),
        visibility: z.enum(['private', 'public']),
        description: z.string().optional(),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ name }) => validateRepoName(name),
    buildArgs: ({ name, visibility, description }) => ({ args: buildRepoCreateArgs({ name, visibility, description }) }),
  }),
  defineRow({
    key: 'gh_search',
    group: 'repos-search',
    cmd: 'gh',
    exec: 'token',
    description:
      'Search GitHub for code, issues, pull requests, or repositories. Uses GitHub search syntax — include "repo:owner/repo" to scope to a repository. Requires a connected GitHub account.',
    schema: z
      .object({
        type: z.enum(['code', 'issues', 'prs', 'repos']),
        query: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ query }) => (query ? { ok: true } : { ok: false, error: 'query is required' }),
    buildArgs: ({ type, query, limit }) => ({ args: buildSearchArgs({ type, query, limit }) }),
  }),
  defineRow({
    key: 'gh_label_list',
    group: 'repos-search',
    cmd: 'gh',
    exec: 'token',
    description:
      'List the labels available in a repository. Check here before applying labels to issues or PRs. Requires a connected GitHub account.',
    schema: z
      .object({
        repo: z.string().optional().describe('Repository as "owner/repo" (defaults to the repo in cwd)'),
        limit: z.number().int().positive().max(100).optional(),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ repo, limit }) => ({ args: buildLabelListArgs({ repo, limit }) }),
  }),
];
