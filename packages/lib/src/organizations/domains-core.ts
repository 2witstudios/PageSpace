/**
 * domains-core — the PURE decisions for verified email domains and auto-join (Spec SEC-1, D-OW-1).
 *
 * PROVING CONTROL. A claim is verified by one of two proofs, and nothing else:
 *   - DNS: a TXT record at `_pagespace-verification.<domain>` whose value is exactly the claim's own
 *     token. Each claim has its own token, so one org's record can never verify another org's claim.
 *   - Email: a link mailed to one of the domain's ADMINISTRATIVE mailboxes (admin@, postmaster@, …),
 *     the same constructed-address proof certificate authorities accept for domain validation. An
 *     ordinary member address on the domain is never enough: anyone with one mailbox at a company
 *     would otherwise claim the whole company's signups.
 * Shared mailbox providers (gmail.com and the like) are refused outright: no one controls them, and
 * verifying one would auto-join strangers.
 *
 * ONE OWNER. Any number of orgs may hold a pending claim; the first to prove control holds the domain
 * and every later proof is refused (the database's partial unique key is the backstop).
 *
 * AUTO-JOIN. Only accounts created at or after the domain was verified, whose current address is on
 * that exact domain and is itself verified, join — as MEMBER, subject to a seat (seat-service). A
 * guest of the org (D-OW-24), a current member, someone with an open invite (it carries the role the
 * inviter chose), and anyone who was a member once and left or was removed, however they had joined,
 * are left alone.
 *
 * INVARIANT: zero I/O.
 */
import { domainToASCII } from 'node:url';
import freeEmailDomains from 'free-email-domains';

export const DOMAIN_TXT_PREFIX = '_pagespace-verification';
const DOMAIN_TXT_VALUE_PREFIX = 'pagespace-domain-verification=';

/** The administrative mailboxes a proof link may be sent to (CA/Browser Forum constructed addresses). */
export const DOMAIN_ADMIN_MAILBOXES = ['admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster'] as const;
export type DomainAdminMailbox = (typeof DOMAIN_ADMIN_MAILBOXES)[number];

/**
 * The most domain claims (pending or verified) one org may hold. The list returns all of them in one
 * response, so a claim is never accepted that the list could not show (with its DNS token and id).
 */
export const MAX_ORG_DOMAINS = 200;

/** How long a mailed proof link stays valid. */
export const DOMAIN_EMAIL_PROOF_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Mailbox providers whose addresses belong to the public, not to an organization: the maintained
 * free-email-domains dataset (HubSpot's published free-provider list, ~14k domains, pinned in
 * package.json and refreshed by bumping it), plus a few providers kept here in case the dataset drops
 * one. A provider on neither list can still be CLAIMED, but never verified in practice: proof needs its
 * DNS or one of its administrative mailboxes, which no customer of the provider controls.
 */
const SUPPLEMENTARY_PUBLIC_EMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'web.de',
  'yandex.com', 'mail.ru', 'zoho.com', 'fastmail.com', 'hey.com', 'qq.com', '163.com', 'duck.com',
];

export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([...freeEmailDomains, ...SUPPLEMENTARY_PUBLIC_EMAIL_DOMAINS]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export type NormalizedDomain =
  | { ok: true; domain: string }
  | { ok: false; reason: 'invalid_domain' | 'public_email_domain' };

/** The one spelling of a domain: lowercase ASCII (punycode), no trailing dot, at least two labels. */
export function normalizeDomain(input: string): NormalizedDomain {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, '');
  if (trimmed === '' || /[^a-z0-9.\-\u0080-￿]/.test(trimmed)) return { ok: false, reason: 'invalid_domain' };
  const ascii = domainToASCII(trimmed);
  if (ascii === '' || ascii.length > 253) return { ok: false, reason: 'invalid_domain' };
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return { ok: false, reason: 'invalid_domain' };
  if (!TLD.test(labels[labels.length - 1])) return { ok: false, reason: 'invalid_domain' };
  if (PUBLIC_EMAIL_DOMAINS.has(ascii)) return { ok: false, reason: 'public_email_domain' };
  return { ok: true, domain: ascii };
}

/** The normalized domain of an address (exact: a subdomain is its own domain), or null. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0) return null;
  const normalized = normalizeDomain(email.slice(at + 1));
  if (normalized.ok) return normalized.domain;
  return normalized.reason === 'public_email_domain' ? email.slice(at + 1).trim().toLowerCase() : null;
}

export const dnsRecordName = (domain: string): string => `${DOMAIN_TXT_PREFIX}.${domain}`;
export const dnsRecordValue = (token: string): string => `${DOMAIN_TXT_VALUE_PREFIX}${token}`;

/** True only when some TXT record (its chunks joined, as DNS splits long values) equals the claim's value. */
export function txtRecordsProve(records: readonly (readonly string[])[], token: string): boolean {
  if (token === '') return false;
  const expected = dnsRecordValue(token);
  return records.some((chunks) => chunks.join('').trim() === expected);
}

export const adminMailboxAddress = (domain: string, mailbox: DomainAdminMailbox): string => `${mailbox}@${domain}`;

/** Is `address` one of `domain`'s administrative mailboxes (exact domain, case-insensitive)? */
export function isAdminMailboxAddress(address: string, domain: string): boolean {
  const at = address.lastIndexOf('@');
  if (at <= 0) return false;
  const local = address.slice(0, at).trim().toLowerCase();
  return emailDomain(address) === domain && (DOMAIN_ADMIN_MAILBOXES as readonly string[]).includes(local);
}

export type DomainVerificationDecision =
  | { action: 'verify' }
  | { action: 'already_verified' }
  | { action: 'refuse'; reason: 'proof_not_found' | 'claimed_by_another_org' };

/**
 * May this claim become the verified owner of its domain? `verifiedByOrgId` is the org that holds the
 * domain verified today (read under the domain's lock), or null.
 */
export function decideDomainVerification(input: {
  claim: { orgId: string; verifiedAt: Date | null };
  verifiedByOrgId: string | null;
  proven: boolean;
}): DomainVerificationDecision {
  if (input.claim.verifiedAt !== null && input.verifiedByOrgId === input.claim.orgId) return { action: 'already_verified' };
  if (input.verifiedByOrgId !== null && input.verifiedByOrgId !== input.claim.orgId) {
    return { action: 'refuse', reason: 'claimed_by_another_org' };
  }
  if (!input.proven) return { action: 'refuse', reason: 'proof_not_found' };
  return { action: 'verify' };
}

export type AutoJoinSkipReason =
  | 'domain_not_verified'
  | 'email_not_verified'
  | 'account_predates_verification'
  | 'already_member'
  | 'invited'
  | 'org_guest'
  | 'previously_departed'
  | 'departure_suppressed';

export type AutoJoinDecision =
  | { action: 'join' }
  | { action: 'skip'; reason: AutoJoinSkipReason }
  | { action: 'refuse'; reason: 'org_lapsed' };

/**
 * Should this account join the org that verified its address's domain? A `join` still needs a seat:
 * the caller admits one under the org's billing lock (seat-service admitSeat) and refuses with the
 * SEAT-4 message when none can be granted.
 */
export function decideAutoJoin(input: {
  emailVerified: boolean;
  userCreatedAt: Date;
  domainVerifiedAt: Date | null;
  isMember: boolean;
  /** They were a member of this org once and left or were removed, however they had joined. */
  previouslyDeparted: boolean;
  /** [D-OW-27] Their address matches a departed member whose account was deleted (a keyed hash). */
  departureSuppressed: boolean;
  hasOpenInvite: boolean;
  isOrgGuest: boolean;
  orgActive: boolean;
}): AutoJoinDecision {
  if (input.domainVerifiedAt === null) return { action: 'skip', reason: 'domain_not_verified' };
  if (!input.emailVerified) return { action: 'skip', reason: 'email_not_verified' };
  if (input.isMember) return { action: 'skip', reason: 'already_member' };
  if (input.previouslyDeparted) return { action: 'skip', reason: 'previously_departed' };
  if (input.departureSuppressed) return { action: 'skip', reason: 'departure_suppressed' };
  if (input.userCreatedAt.getTime() < input.domainVerifiedAt.getTime()) return { action: 'skip', reason: 'account_predates_verification' };
  if (input.isOrgGuest) return { action: 'skip', reason: 'org_guest' };
  if (input.hasOpenInvite) return { action: 'skip', reason: 'invited' };
  if (!input.orgActive) return { action: 'refuse', reason: 'org_lapsed' };
  return { action: 'join' };
}
