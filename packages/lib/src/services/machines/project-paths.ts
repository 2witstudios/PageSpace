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
 */

import { resolvePathWithinSync } from '../../security/path-validator';
import { slugifySegment, hasNameContent, slugDigest } from './name-slug';

/** Root directory on a Machine's filesystem under which every Project is cloned. */
export const PROJECTS_ROOT = '/workspace/projects';

const MAX_PROJECT_NAME_LENGTH = 100;

// Alphanumerics, dash, underscore, dot — but never a leading dot (rules out
// both a literal `.`/`..` and a hidden directory).
const PROJECT_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function isValidProjectName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_PROJECT_NAME_LENGTH &&
    PROJECT_NAME_RE.test(name)
  );
}

/** Trailing separators, for trimming an edge the length cut exposed. */
const TRAILING_SEPARATORS_RE = /[.-]+$/;

/** What an input with nothing sluggable left in it becomes ("   ", "🚀", "../"). */
export const PROJECT_NAME_FALLBACK = 'project';

/**
 * Normalize free text into a valid project directory name — type
 * "My Cool Feature", get `my-cool-feature`. The normalize-and-accept
 * counterpart to `isValidProjectName`, which stays as it is: the predicate
 * remains the CONTRACT this function must satisfy for any input at all.
 *
 * A name already accepted by `isValidProjectName` passes through untouched —
 * normalization exists to accept text that would otherwise be REJECTED, not to
 * rewrite a directory name the user legitimately chose (`MyRepo` stays
 * `MyRepo`). It mirrors `normalizeBranchName`, where the same pass-through is
 * load-bearing because git refs are case-sensitive.
 *
 * Unlike a branch ref, a project name is exactly ONE path segment — `/` has no
 * structural meaning here, so `slugifySegment` folds it to `-` along with
 * every other out-of-charset character. That, plus the leading-separator trim,
 * is what collapses `../escape` to `escape` — and `resolveProjectPath` still
 * re-checks the join against `PROJECTS_ROOT` regardless.
 *
 * INVARIANT: `isValidProjectName(normalizeProjectName(x)) === true` for EVERY
 * string x, and the function is idempotent.
 */
export function normalizeProjectName(input: string): string {
  if (isValidProjectName(input)) return input;

  // A name the charset annihilated (`日本語`, `🚀`) keeps a deterministic token
  // rather than collapsing onto the shared fallback — otherwise two distinct
  // repos would fight over one directory and the second would be rejected as a
  // duplicate. Structural noise (`..`, `   `) has no content and does fall back.
  let name = slugifySegment(input);
  if (name.length === 0 && hasNameContent(input)) {
    name = `x${slugDigest(input)}`;
  }

  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    name = name.slice(0, MAX_PROJECT_NAME_LENGTH).replace(TRAILING_SEPARATORS_RE, '');
  }

  return isValidProjectName(name) ? name : PROJECT_NAME_FALLBACK;
}

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
