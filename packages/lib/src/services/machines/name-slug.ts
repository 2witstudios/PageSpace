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

/** Nothing but separators and whitespace — structural noise (`..`, `.`, `   `, `//`), not a name. */
const NOISE_ONLY_RE = /^[\s./-]*$/;

/**
 * Did the user type ANYTHING here, as opposed to pure path structure? `..`, `.`,
 * `/` and `   ` are structure. `日本語`, `🚀`, `___` and `!!!` are all *something*
 * the user typed, even when the slug charset annihilates them entirely.
 *
 * Only consulted when NOTHING survived slugification, to choose between dropping
 * the segment and keeping a `slugDigest` token — and it is deliberately more
 * eager than `destroysNameContent`. Losing `!` from `a!b` is harmless (it still
 * says `a-b`), but `!!!` slugifies to nothing, and dropping it lands the name in
 * the SHARED FALLBACK — the one bucket where distinct names collide and
 * cross-attach. Whenever the user typed something, we would rather mint an ugly
 * token than put them in that bucket.
 */
export function hasNameContent(input: string): boolean {
  return !NOISE_ONLY_RE.test(input);
}

/** Survives slugification unchanged. */
const CHARSET_RE = /[a-z0-9.-]/;
/** ASCII whitespace and punctuation — STRUCTURE. Losing it does not change which name was meant. */
const ASCII_STRUCTURE_RE = /[\s!-/:-@[-`{-~]/;

/**
 * Did slugification DESTROY identity-bearing content — a letter, digit, or
 * symbol from a script the ASCII charset cannot express (`日本語`, `Ω`, `🚀`)?
 *
 * This is the difference between a lossless tidy-up and a lossy one. Dropping
 * ASCII punctuation is lossless in the sense that matters: `a b` and `a!b` were
 * always going to mean one branch, and the design accepts that. Dropping `日本語`
 * is NOT — it silently turns `日本語 feature` into plain `feature`, which is a
 * DIFFERENT branch that may already exist and belong to someone else. The caller
 * appends `slugDigest` whenever this returns true, so the two stay apart.
 */
export function destroysNameContent(input: string): boolean {
  const folded = input.normalize('NFKD').replace(DIACRITICS_RE, '').toLowerCase();
  for (const character of folded) {
    if (CHARSET_RE.test(character)) continue;
    if (ASCII_STRUCTURE_RE.test(character)) continue;
    return true;
  }
  return false;
}

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/**
 * A short, deterministic, charset-safe token derived from text the ASCII slug
 * charset wiped out entirely.
 *
 * This exists for CORRECTNESS, not cosmetics. A branch name IS a
 * branch-terminal's identity — it is hashed into the Sprite session key and is
 * the store's lookup key — so if every non-Latin name collapsed onto one
 * fallback, `spawnBranch('日本語')` followed by `spawnBranch('한국어')` would
 * report `resumed: true` and hand the second user the FIRST user's Sprite and
 * filesystem. Likewise `feature/日本語` must not silently become plain
 * `feature` and collide with a real `feature` branch.
 *
 * FNV-1a/base36, not a crypto hash: it disambiguates, it does not authenticate
 * (the Sprite name is a keyed HMAC — see `deriveBranchSessionKey`). Kept pure
 * and dependency-free on purpose, because the live-preview sub-task must run
 * this exact function in the browser.
 */
export function slugDigest(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  const text = input.trim();
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(36);
}
