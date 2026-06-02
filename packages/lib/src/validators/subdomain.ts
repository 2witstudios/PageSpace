/**
 * Maximum length for a DNS label / subdomain (RFC 1035).
 */
const MAX_SUBDOMAIN_LENGTH = 63

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
