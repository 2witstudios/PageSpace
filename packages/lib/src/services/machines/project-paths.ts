/**
 * Machine project path confinement (pure).
 *
 * A Project is a git repo cloned into a fixed subtree of a Machine's
 * persistent filesystem. The directory name comes from the caller (the
 * navigator UI / an agent), so it is `normalizeProjectName`d into a strict
 * slug BEFORE being joined onto `PROJECTS_ROOT` — no path separators, no `..`,
 * no leading dot — and the join is re-checked with the shared
 * `resolvePathWithinSync` confinement helper (belt-and-suspenders, matching
 * sandbox-paths.ts). `isValidProjectName` remains the contract the normalizer
 * must satisfy, and the second gate `resolveProjectPath` still runs.
 *
 * `isValidProjectName`/`normalizeProjectName` themselves live in
 * `./project-name` (re-exported here for existing call sites) — that module
 * has zero node-builtin imports, so a client component can import it directly
 * for a live-typing name preview without dragging `resolvePathWithinSync`'s
 * `fs`/`path` dependency into the browser bundle.
 */

import { resolvePathWithinSync } from '../../security/path-validator';
import { isValidProjectName } from './project-name';

export { isValidProjectName, normalizeProjectName } from './project-name';

/** Root directory on a Machine's filesystem under which every Project is cloned. */
export const PROJECTS_ROOT = '/workspace/projects';

/** Resolve a project's absolute clone path, or `null` if the name is invalid or escapes the root. */
export function resolveProjectPath(name: string): string | null {
  if (!isValidProjectName(name)) return null;
  return resolvePathWithinSync(PROJECTS_ROOT, name);
}

const HTTPS_REPO_URL_RE = /^https:\/\/.+/;

/** Only HTTPS remotes are supported — mirrors the agent `git_clone` tool's constraint. */
export function isValidRepoUrl(repoUrl: string): boolean {
  return typeof repoUrl === 'string' && HTTPS_REPO_URL_RE.test(repoUrl);
}
