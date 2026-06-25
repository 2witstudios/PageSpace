/**
 * Pure functions for custom domain validation and DNS instruction generation.
 *
 * Apex vs subdomain heuristic: a hostname with exactly 2 labels (e.g. `acme.com`)
 * is treated as an apex; 3+ labels (e.g. `www.acme.com`, `blog.acme.com`) are
 * treated as subdomains. This is accurate for single-segment TLDs (.com, .io, .dev)
 * and is a documented limitation for multi-segment TLDs like .co.uk.
 */

/** Max length of a single DNS label (RFC 1035 §2.3.4). */
const MAX_LABEL_LENGTH = 63;

/** Max total length of a fully-qualified domain name (RFC 1035 §3.1). */
const MAX_HOSTNAME_LENGTH = 253;

/** Valid DNS label pattern: alphanumeric, may contain hyphens (not leading/trailing). */
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Platform-owned domains that may never be used as custom domains. */
const BLOCKED_SUFFIXES = ['pagespace.ai', 'pagespace.site'];
const BLOCKED_PATTERN = /\.pagespace\./;

/**
 * Normalize a raw hostname input:
 * - lowercase
 * - strip http:// or https:// scheme
 * - strip path component (anything after first `/`)
 * - strip port (`:1234`)
 * - strip trailing dot
 */
export function normalizeHostname(input: string): string {
  let h = input.trim().toLowerCase();
  // Strip scheme
  h = h.replace(/^https?:\/\//, '');
  // Strip path and query
  const slashIdx = h.indexOf('/');
  if (slashIdx !== -1) h = h.slice(0, slashIdx);
  // Strip port
  const colonIdx = h.lastIndexOf(':');
  if (colonIdx !== -1) h = h.slice(0, colonIdx);
  // Strip trailing dot
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

export type DomainValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Validate a normalized custom domain hostname.
 *
 * Checks:
 * 1. Not empty, not exceeding 253 chars total.
 * 2. Has at least 2 labels (bare TLDs rejected).
 * 3. Each label: ≤63 chars, alphanumeric + hyphens, no leading/trailing hyphen.
 * 4. Not a pagespace.ai, pagespace.site, or *.pagespace.* host.
 */
export function validateCustomDomain(hostname: string): DomainValidationResult {
  if (!hostname) {
    return { valid: false, reason: 'Domain cannot be empty' };
  }

  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    return { valid: false, reason: `Domain exceeds maximum length of ${MAX_HOSTNAME_LENGTH} characters` };
  }

  const labels = hostname.split('.');

  if (labels.length < 2) {
    return { valid: false, reason: 'Domain must have at least two labels (e.g. example.com)' };
  }

  for (const label of labels) {
    if (!label) {
      return { valid: false, reason: 'Domain labels cannot be empty' };
    }
    if (label.length > MAX_LABEL_LENGTH) {
      return { valid: false, reason: `Domain label "${label}" exceeds maximum length of ${MAX_LABEL_LENGTH} characters` };
    }
    if (!LABEL_PATTERN.test(label)) {
      return {
        valid: false,
        reason: `Domain label "${label}" is invalid — labels must contain only letters, digits, and hyphens, and may not start or end with a hyphen`,
      };
    }
  }

  // Block platform-owned domains
  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
      return { valid: false, reason: `Domain cannot be a pagespace.ai or pagespace.site host` };
    }
  }
  if (BLOCKED_PATTERN.test(hostname)) {
    return { valid: false, reason: `Domain cannot be a pagespace.* host` };
  }

  return { valid: true };
}

/** Whether a normalized hostname is an apex domain (exactly 2 labels). */
export function isApexDomain(hostname: string): boolean {
  return hostname.split('.').length === 2;
}

/**
 * The registrable domain — the last two labels of a hostname — used to look up
 * a domain's authoritative nameservers.
 *
 * `www.acme.com` → `acme.com`, `docs.blog.acme.io` → `acme.io`,
 * `jonowoodall.com` → `jonowoodall.com`. Lowercased and trailing-dot-stripped.
 *
 * Like {@link isApexDomain}, this uses the simple "last 2 labels" heuristic,
 * which is accurate for single-segment TLDs (.com, .io, .dev) and a documented
 * limitation for multi-segment TLDs like .co.uk. Authoritative-NS lookups work
 * regardless: the registrar's NS for `example.co.uk` is reachable from the NS
 * of `co.uk`, so an over-broad registrable domain still resolves correctly.
 */
export function registrableDomain(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return '';
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  return labels.slice(-2).join('.');
}

export interface DnsRecord {
  type: 'A' | 'AAAA' | 'CNAME';
  name: string;
  value: string;
}

export interface DnsInstructions {
  isApex: boolean;
  records: DnsRecord[];
}

export interface BuildDnsInstructionsParams {
  hostname: string;
  edgeIpv4: string;
  edgeIpv6: string;
  cnameTarget: string;
}

/**
 * Build the DNS records a user must set for their custom domain.
 *
 * Apex domains (exactly 2 labels, e.g. `acme.com`) require A + AAAA records
 * pointing at the Fly Anycast IPs. Subdomains (3+ labels) use a CNAME.
 */
export function buildDnsInstructions({
  hostname,
  edgeIpv4,
  edgeIpv6,
  cnameTarget,
}: BuildDnsInstructionsParams): DnsInstructions {
  const apex = isApexDomain(hostname);

  if (apex) {
    return {
      isApex: true,
      records: [
        { type: 'A', name: '@', value: edgeIpv4 },
        { type: 'AAAA', name: '@', value: edgeIpv6 },
      ],
    };
  }

  // Keep all subdomain labels left of the apex 2-label base.
  // e.g. "docs.blog" from "docs.blog.acme.com", "www" from "www.acme.com".
  const labels = hostname.split('.');
  const name = labels.slice(0, -2).join('.');
  return {
    isApex: false,
    records: [{ type: 'CNAME', name, value: cnameTarget }],
  };
}

// ── DNS Verification ─────────────────────────────────────────────────────────

export interface ResolvedRecords {
  a: string[];
  aaaa: string[];
  cname: string[];
}

export interface DnsVerificationInput {
  hostname: string;
  expected: DnsInstructions;
  resolved: ResolvedRecords;
}

export interface DnsVerificationResult {
  verified: boolean;
  reason?: string;
}

/** Strip a trailing dot from a DNS value for case-insensitive comparison. */
function normalizeValue(v: string): string {
  return v.replace(/\.$/, '').toLowerCase();
}

/**
 * Pure function: given expected DNS instructions and resolved records,
 * decide whether the domain is verified.
 *
 * - Apex domain: at least one resolved A record must match the expected IPv4.
 * - Subdomain: at least one resolved CNAME must match the expected target
 *   (case-insensitive, trailing-dot-tolerant).
 */
export function verifyDnsRecords({ hostname, expected, resolved }: DnsVerificationInput): DnsVerificationResult {
  if (expected.isApex) {
    const expectedA = expected.records.find((r) => r.type === 'A')?.value ?? '';
    if (!expectedA) {
      return { verified: false, reason: 'No expected A record configured' };
    }
    if (!resolved.a || resolved.a.length === 0) {
      return { verified: false, reason: `No A records found for ${hostname}` };
    }
    const matches = resolved.a.some((ip) => normalizeValue(ip) === normalizeValue(expectedA));
    if (!matches) {
      return {
        verified: false,
        reason: `A record for ${hostname} does not point to ${expectedA} (found: ${resolved.a.join(', ')})`,
      };
    }
    return { verified: true };
  }

  // Subdomain: check CNAME
  const expectedCname = expected.records.find((r) => r.type === 'CNAME')?.value ?? '';
  if (!expectedCname) {
    return { verified: false, reason: 'No expected CNAME target configured' };
  }
  if (!resolved.cname || resolved.cname.length === 0) {
    return { verified: false, reason: `No CNAME record found for ${hostname}` };
  }
  const matches = resolved.cname.some((target) => normalizeValue(target) === normalizeValue(expectedCname));
  if (!matches) {
    return {
      verified: false,
      reason: `CNAME for ${hostname} does not point to ${expectedCname} (found: ${resolved.cname.join(', ')})`,
    };
  }
  return { verified: true };
}
