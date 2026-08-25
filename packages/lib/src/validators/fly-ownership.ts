/**
 * `_fly-ownership` TXT pre-validation (pure).
 *
 * Fly issues a certificate for a hostname only once it can prove the requester
 * controls it. The usual proof is reachability — the hostname's A/AAAA/CNAME
 * already point at Fly — which is what `verifyDnsRecords` in `./custom-domain`
 * checks and what the existing custom-domain flow requires before it will ask
 * for a cert at all.
 *
 * That proof is unavailable for a hostname the customer will not (or cannot)
 * point at us yet: a domain behind a CDN that terminates TLS itself, an apex
 * being migrated with no downtime, an imported certificate. For those, Fly asks
 * for a TXT record at `_fly-ownership.<hostname>` carrying the app's or the
 * org's ownership value, and reports it back as
 * `dns_requirements.ownership` / `validation.ownership_txt_configured`.
 *
 * PRE-validation, not post-mortem: the point of checking the record ourselves,
 * before treating a stuck certificate as failed, is that "Fly has not issued
 * yet" and "the customer never published the record" are the same observable
 * state through the certificate status alone — and they need opposite responses.
 * The first is waiting; the second is an instruction the customer has not been
 * given. Resolving the TXT here separates them.
 *
 * Pure: TXT records come in as data. The resolution itself is `apps/web/src/lib/
 * publish/dns-resolver.ts`, which already owns the authoritative-then-recursive
 * strategy and its SSRF guard.
 */

/** The subdomain Fly reads the ownership proof from. */
export const FLY_OWNERSHIP_TXT_PREFIX = '_fly-ownership';

/** Where the TXT record for a hostname must live. */
export function flyOwnershipTxtName(hostname: string): string {
  return `${FLY_OWNERSHIP_TXT_PREFIX}.${hostname.trim().toLowerCase().replace(/\.$/, '')}`;
}

/** What Fly said it wants, normalized out of a certificate response. */
export interface FlyOwnershipRequirement {
  /** The record name, e.g. `_fly-ownership.example.com`. */
  name: string;
  /** The app-scoped value, e.g. `app-XXXXXXXXXX`. */
  appValue: string;
  /** The org-scoped value, e.g. `org-XXXXXXXXXX`. Either value satisfies Fly. */
  orgValue: string;
}

export type FlyOwnershipVerification =
  /** Fly did not ask for an ownership TXT — nothing to pre-validate. */
  | { state: 'not_required' }
  /** The record is published and carries a value Fly will accept. */
  | { state: 'satisfied' }
  /** Nothing resolves at the record name. */
  | { state: 'missing'; expected: FlyOwnershipRequirement }
  /** Something resolves, but none of its values match. */
  | { state: 'mismatched'; expected: FlyOwnershipRequirement; found: string[] };

/**
 * Split raw TXT strings into candidate ownership values.
 *
 * Two shapes have to survive this. A DNS TXT record is a LIST of character
 * strings (Node's `resolveTxt` returns `string[][]`, one inner array per record,
 * chunked at 255 bytes) — the chunks of one record concatenate with no
 * separator, or a long value silently fails to match. And Fly documents that
 * MULTIPLE ownership values may share one record, "separated with semicolons" —
 * which is how a hostname serves two Fly apps at once, and why a strict equality
 * test against the whole string would reject a correctly-configured domain.
 *
 * Surrounding quotes are stripped: several DNS UIs store the value with the
 * quoting from the zone-file syntax included, and a resolver hands that back
 * verbatim.
 */
export function parseOwnershipTxtValues(records: readonly (readonly string[])[]): string[] {
  const values: string[] = [];
  for (const chunks of records) {
    const joined = chunks.join('');
    for (const part of joined.split(';')) {
      const trimmed = part.trim().replace(/^"(.*)"$/s, '$1').trim();
      if (trimmed.length > 0) values.push(trimmed);
    }
  }
  return values;
}

/**
 * Compare the published TXT values against what Fly asked for.
 *
 * `null` requirement means Fly reported no ownership requirement at all, which
 * is the common case (a hostname already pointing at us validates by
 * reachability) — and it is reported as `not_required` rather than `satisfied`
 * so a caller cannot read "we verified ownership" out of "we never checked".
 *
 * EITHER the app value or the org value is accepted, because Fly accepts either.
 * Comparison is case-insensitive: these values travel through DNS UIs that
 * normalize case, and a case-folded record still satisfies Fly.
 */
export function verifyFlyOwnershipTxt(args: {
  requirement: FlyOwnershipRequirement | null;
  records: readonly (readonly string[])[];
}): FlyOwnershipVerification {
  const { requirement } = args;
  if (!requirement) return { state: 'not_required' };

  const found = parseOwnershipTxtValues(args.records);
  if (found.length === 0) return { state: 'missing', expected: requirement };

  const accepted = [requirement.appValue, requirement.orgValue]
    .filter((v) => v.length > 0)
    .map((v) => v.toLowerCase());
  // No accepted value means Fly asked for ownership but named nothing to publish.
  // Treat that as mismatched rather than satisfied: it is a state we cannot act
  // on, and calling it satisfied would let a cert be declared blocked-on-nothing.
  if (accepted.length === 0) return { state: 'mismatched', expected: requirement, found };

  const matched = found.some((value) => accepted.includes(value.toLowerCase()));
  return matched ? { state: 'satisfied' } : { state: 'mismatched', expected: requirement, found };
}

/** A human-readable instruction for a verification that is not yet satisfied. */
export function describeOwnershipVerification(result: FlyOwnershipVerification): string | null {
  switch (result.state) {
    case 'not_required':
    case 'satisfied':
      return null;
    case 'missing':
      return `Add a TXT record at ${result.expected.name} with the value ${result.expected.appValue} — Fly cannot verify ownership of this domain until it resolves.`;
    case 'mismatched':
      return `The TXT record at ${result.expected.name} does not carry an accepted ownership value (expected ${result.expected.appValue}; found ${result.found.join(', ')}).`;
  }
}
