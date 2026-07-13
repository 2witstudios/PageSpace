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
import { isValidId } from '../../validators/id-validators';
import { slugifySegment, disambiguateSlug, truncateWithDigest } from './name-slug';

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

/** What an input with nothing sluggable left in it becomes ("   ", "🚀", "../"). */
const PROJECT_NAME_FALLBACK = 'project';

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
export function normalizeProjectName(rawInput: string): string {
  // Trim FIRST — see `normalizeBranchName`: untrimmed input would skip the
  // pass-through and needlessly rewrite a name that was already fine.
  const input = rawInput.trim();
  if (isValidProjectName(input)) return input;

  // `disambiguateSlug` keeps a digest whenever the charset destroyed content that
  // identifies WHICH name was meant (`日本語 repo`, `🚀`) — otherwise two distinct
  // repos collapse onto one clone directory and the second is rejected as a duplicate.
  const slug = disambiguateSlug(input, slugifySegment(input));

  // A content-free name (`..`, `//`, `   `) has no identity to preserve — every one
  // of them means "no name", so sharing the fallback is correct rather than a
  // collision. The routes reject NAMELESS input (they guard on `hasNameContent`, not
  // on `.trim()`), so the fallback is unreachable from the API and remains only to
  // keep this function total for non-route callers.
  if (slug.length === 0) return PROJECT_NAME_FALLBACK;

  const name = truncateWithDigest(slug, input, MAX_PROJECT_NAME_LENGTH);

  return isValidProjectName(name) ? name : PROJECT_NAME_FALLBACK;
}

/**
 * Resolve a project directory name to its absolute path, or `null` if the
 * name is invalid or escapes the root. This is the ONE confinement gate:
 * `resolveProjectClonePath` funnels through it, and legacy rows (created
 * before per-row paths) persisted exactly this `PROJECTS_ROOT/<name>` shape.
 * Do NOT use it to re-derive a live project's directory from its name — since
 * per-row paths, only the row's persisted `path` column says where a project
 * lives.
 */
export function resolveProjectPath(name: string): string | null {
  if (!isValidProjectName(name)) return null;
  return resolvePathWithinSync(PROJECTS_ROOT, name);
}

/** A lossy cut must not strand a separator edge — mirrors `truncateWithDigest`. */
const TRAILING_PROJECT_SEPARATORS_RE = /[._-]+$/;

/**
 * Resolve the clone path for one project ROW: `PROJECTS_ROOT/<name>-<id>`.
 *
 * The id suffix is what makes the directory unique per row rather than per
 * name — two concurrent adds of the SAME name land in two different
 * directories, so neither operation can ever clone into (or `rm -rf`) a
 * directory the other owns. The name prefix is kept purely for human
 * legibility in a shell; nothing resolves a path from a name anymore — every
 * consumer reads the row's persisted `path`.
 *
 * The row id crosses a trust boundary into an `rm -rf` argument, so it is
 * validated with the shared cuid2 predicate (`isValidId`) rather than assumed
 * to be well-formed. This resolver stays total and fails closed on a bad id;
 * `planAddProject` is the layer that turns that into a loud wiring error.
 *
 * The combined directory name is capped at `MAX_PROJECT_NAME_LENGTH` by
 * truncating the NAME portion (the id must survive intact — it is the
 * uniqueness; a truncated name prefix costs nothing because the DB enforces
 * name uniqueness on the FULL name), and the join goes through
 * `resolveProjectPath` — one shared validity + confinement gate.
 */
export function resolveProjectClonePath(name: string, id: string): string | null {
  if (!isValidProjectName(name)) return null;
  if (!isValidId(id)) return null;

  const room = MAX_PROJECT_NAME_LENGTH - id.length - '-'.length;
  if (room < 1) return null;

  const stem =
    name.length > room ? name.slice(0, room).replace(TRAILING_PROJECT_SEPARATORS_RE, '') : name;
  return resolveProjectPath(`${stem}-${id}`);
}

const HTTPS_REPO_URL_RE = /^https:\/\/.+/;

/** Only HTTPS remotes are supported — mirrors the agent `git_clone` tool's constraint. */
export function isValidRepoUrl(repoUrl: string): boolean {
  return typeof repoUrl === 'string' && HTTPS_REPO_URL_RE.test(repoUrl);
}
