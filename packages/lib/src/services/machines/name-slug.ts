/**
 * The slug primitive shared by Machine name normalization (pure, no I/O).
 *
 * Branch names (`branch-session.ts`) and Project directory names
 * (`project-paths.ts`) are both "normalize-and-accept": a user types free text
 * and we slugify it into something their respective `isValid*` predicate
 * accepts, instead of rejecting them with an error. The one rule the two share
 * is what a single ref/path SEGMENT may contain — lowercase ASCII
 * alphanumerics plus `.` and `-` — so that rule lives here, and each caller
 * layers its own structure on top (a branch is `/`-joined segments; a project
 * is exactly one segment).
 *
 * Deliberately NOT `utils/utils.ts`'s `slugify`: that one drops `.` and `/`
 * outright and keeps `_`, which is wrong for a git ref, where `release/v1.2`
 * must survive intact.
 */

/** Combining marks, left behind by the NFKD decomposition below (`é` → `e` + U+0301). */
const DIACRITICS_RE = /[\u0300-\u036f]/g;

/** Every character outside the segment charset — whitespace, `_`, `/`, emoji, and git's forbidden `~^:?*[\`. */
const OUTSIDE_CHARSET_RE = /[^a-z0-9.-]+/g;

/** A run of two or more separators. Collapsing these also destroys `..`, a token git forbids in a ref. */
const SEPARATOR_RUN_RE = /[.-]{2,}/g;

const LEADING_SEPARATORS_RE = /^[.-]+/;
const TRAILING_SEPARATORS_RE = /[.-]+$/;

/**
 * Slugify one segment: fold accents down to ASCII, lowercase, replace every
 * out-of-charset character with `-`, collapse separator runs, and trim the
 * separators off both edges. Returns `''` when nothing survives — the caller
 * decides what an empty slug means.
 *
 * Idempotent by construction: the output holds only charset characters, no
 * separator runs, and no edge separators, so a second pass changes nothing.
 */
export function slugifySegment(input: string): string {
  return input
    .normalize('NFKD')
    .replace(DIACRITICS_RE, '')
    .toLowerCase()
    .replace(OUTSIDE_CHARSET_RE, '-')
    .replace(SEPARATOR_RUN_RE, '-')
    .replace(LEADING_SEPARATORS_RE, '')
    .replace(TRAILING_SEPARATORS_RE, '');
}
