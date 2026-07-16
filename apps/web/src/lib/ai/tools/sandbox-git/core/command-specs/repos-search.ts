/**
 * Pure argv builders for the GitHub repo / search / label subcommands. No
 * effects. Flag-injection guards (validateFlagSafe / validateRepoName) run in
 * the shell before these build argv. Branch-tested in `__tests__`.
 */
import { optArg, buildGhJsonFlag } from '../arg-builders';

export function buildRepoViewArgs(repo?: string): string[] {
  return [
    'repo', 'view',
    ...(repo ? [repo] : []),
    ...buildGhJsonFlag(['nameWithOwner', 'description', 'defaultBranchRef', 'visibility', 'url', 'isFork']),
  ];
}

export interface RepoListArgsInput {
  owner?: string;
  limit?: number;
}

export function buildRepoListArgs({ owner, limit }: RepoListArgsInput): string[] {
  return [
    'repo', 'list',
    ...(owner ? [owner] : []),
    '--limit', String(limit ?? 30),
    ...buildGhJsonFlag(['nameWithOwner', 'description', 'visibility', 'updatedAt', 'url']),
  ];
}

export function buildRepoForkArgs(repo: string): string[] {
  return ['repo', 'fork', repo, '--clone=false', '--remote=false'];
}

export interface RepoCreateArgsInput {
  name: string;
  visibility: 'private' | 'public';
  description?: string;
}

export function buildRepoCreateArgs({ name, visibility, description }: RepoCreateArgsInput): string[] {
  return [
    'repo', 'create', name,
    visibility === 'private' ? '--private' : '--public',
    ...optArg('--description', description),
  ];
}

export interface SearchArgsInput {
  type: 'code' | 'issues' | 'prs' | 'repos';
  query: string;
  limit?: number;
}

export function buildSearchArgs({ type, query, limit }: SearchArgsInput): string[] {
  const fields =
    type === 'code'
      ? ['repository', 'path', 'url']
      : type === 'repos'
        ? ['fullName', 'description', 'url']
        : ['number', 'title', 'state', 'url', 'repository'];
  return [
    'search', type,
    '--limit', String(limit ?? 20),
    ...buildGhJsonFlag(fields),
    // query is genuine free text (may legitimately start with "-") — the "--"
    // separator, not a regex reject, is what keeps gh from parsing it as a flag.
    '--', query,
  ];
}

export interface LabelListArgsInput {
  repo?: string;
  limit?: number;
}

export function buildLabelListArgs({ repo, limit }: LabelListArgsInput): string[] {
  return [
    'label', 'list',
    ...optArg('--repo', repo),
    '--limit', String(limit ?? 50),
    ...buildGhJsonFlag(['name', 'description', 'color']),
  ];
}
