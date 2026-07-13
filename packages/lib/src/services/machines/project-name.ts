/**
 * Machine project NAME validation/normalization (pure, no I/O, no node builtins).
 *
 * Split out of `project-paths.ts` so it can be imported from a browser bundle
 * (a live-typing name preview) without dragging in `resolvePathWithinSync`'s
 * `fs`/`path` dependency. `project-paths.ts` re-exports both for existing
 * server call sites.
 */

import { slugifySegment, disambiguateSlug, truncateWithDigest } from './name-slug';

/** Exported so `project-paths.ts` can share it for the per-row id-suffix truncation math. */
export const MAX_PROJECT_NAME_LENGTH = 100;

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
