/**
 * Maximum length for a DNS label / subdomain (RFC 1035).
 */
export const MAX_SUBDOMAIN_LENGTH = 63

/**
 * Valid subdomain shape after normalization: lowercase alphanumeric labels
 * separated by single hyphens, no leading or trailing hyphen, non-empty.
 */
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * Subdomains reserved for platform infrastructure and well-known names.
 * Published-page subdomains may not use any of these.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'www',
  'api',
  'admin',
  'app',
  'apps',
  'mail',
  'smtp',
  'imap',
  'ftp',
  'cdn',
  'static',
  'assets',
  'img',
  'images',
  'status',
  'blog',
  'docs',
  'doc',
  'help',
  'support',
  'dashboard',
  'account',
  'accounts',
  'login',
  'logout',
  'auth',
  'oauth',
  'sso',
  'internal',
  'system',
  'root',
  'host',
  'ns',
  'ns1',
  'ns2',
  'mx',
  '_psl',
  'psl',
  'test',
  'staging',
  'dev',
  'preview',
  'public',
  'private',
  'pagespace',
])

/**
 * Result of validating a candidate publish subdomain.
 */
export type SubdomainValidationResult =
  | { valid: true }
  | { valid: false; reason: string }

/**
 * Normalize a raw input into subdomain shape:
 * lowercase, trim, collapse non-[a-z0-9] runs to single hyphens,
 * and strip any leading/trailing hyphens.
 */
export const normalizeSubdomain = (input: string): string => {
  // Collapse every run of non-alphanumerics (hyphens included) into a single '-'.
  // After this pass the value holds only [a-z0-9] and single '-' separators.
  const collapsed = input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
  // Strip leading/trailing separators with a linear scan rather than anchored
  // `/^-+/` + `/-+$/` regexes, which are polynomial (ReDoS) on long '-' runs.
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === '-') start += 1;
  while (end > start && collapsed[end - 1] === '-') end -= 1;
  return collapsed.slice(start, end);
}

/**
 * Validate a candidate publish subdomain.
 *
 * The input is first normalized, then checked against:
 * 1. Length (1..63 characters after normalization)
 * 2. Shape (no leading/trailing hyphen, alphanumeric labels only)
 * 3. Reserved-name list
 */
export const validatePublishSubdomain = (input: string): SubdomainValidationResult => {
  const normalized = normalizeSubdomain(input)

  if (normalized.length === 0) {
    return { valid: false, reason: 'Subdomain cannot be empty' }
  }

  if (normalized.length > MAX_SUBDOMAIN_LENGTH) {
    return {
      valid: false,
      reason: `Subdomain exceeds maximum length of ${MAX_SUBDOMAIN_LENGTH} characters`,
    }
  }

  if (!SUBDOMAIN_PATTERN.test(normalized)) {
    return {
      valid: false,
      reason: 'Subdomain must contain only lowercase letters, digits, and hyphens, and may not start or end with a hyphen',
    }
  }

  if (RESERVED_SUBDOMAINS.has(normalized)) {
    return { valid: false, reason: `Subdomain "${normalized}" is reserved` }
  }

  return { valid: true }
}

/**
 * A safe, non-empty fallback base when a drive slug normalizes to empty or reserved.
 * Uses 'drive' as the canonical default (reserved names are checked separately below).
 */
const DEFAULT_SUBDOMAIN_BASE = 'drive'

/**
 * Clamp a base so that `base-SUFFIX` always fits within MAX_SUBDOMAIN_LENGTH
 * for the given suffix number. Per-suffix headroom (not a static -NN budget) means
 * the loop is provably bounded: for any suffix value, the candidate is ≤ 63 chars,
 * so it can always validate and the allocator always terminates.
 * Preserves a trailing alphanumeric (never ends on a hyphen).
 */
function clampBaseForSuffix(base: string, suffix: number | null): string {
  // Bare base (suffix null): cap at the full label length. Suffixed: leave room
  // for '-<suffix>' so the candidate always fits 63 chars and can validate.
  const maxBase = suffix === null ? MAX_SUBDOMAIN_LENGTH : MAX_SUBDOMAIN_LENGTH - `-${suffix}`.length
  if (base.length <= maxBase) return base
  let truncated = base.slice(0, maxBase)
  while (truncated.length > 0 && truncated.endsWith('-')) {
    truncated = truncated.slice(0, -1)
  }
  return truncated || DEFAULT_SUBDOMAIN_BASE
}

/**
 * Resolve a globally-unique publish subdomain for a drive.
 *
 * Normalizes the drive's slug, then de-duplicates against the set of already-taken
 * subdomains (across all owners) with a numeric suffix (`-2`, `-3`, …), skipping any
 * candidate that is reserved or invalid. The DB unique constraint on `publishSubdomain`
 * is the final race arbiter — this pure helper produces a free candidate assuming the
 * given `taken` set is current; the caller retries on a unique-violation.
 *
 * Mirrors the `resolveUniqueSlug` suffix convention (`-2`, `-3`, …).
 */
export function resolveUniquePublishSubdomain(rawBase: string, taken: string[]): string {
  const takenSet = new Set(taken)
  const normalized = normalizeSubdomain(rawBase)
  const fallback = normalized.length > 0 ? normalized : DEFAULT_SUBDOMAIN_BASE

  // Try the bare base, then base-2, base-3, … until a free, valid candidate is found.
  // The base is clamped per-suffix so every candidate is ≤ 63 chars and can validate —
  // the loop is provably bounded and never produces an invalid (too-long) candidate.
  let suffix = 1 // 1 = bare base; 2+ = suffixed
  let candidate = clampBaseForSuffix(fallback, null)
  while (
    takenSet.has(candidate) ||
    RESERVED_SUBDOMAINS.has(candidate) ||
    validatePublishSubdomain(candidate).valid === false
  ) {
    suffix += 1
    candidate = `${clampBaseForSuffix(fallback, suffix)}-${suffix}`
  }
  return candidate
}
