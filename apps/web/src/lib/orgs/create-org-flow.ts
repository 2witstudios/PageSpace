/**
 * The create-organization flow's decisions, pure (UI-6 under D-OW-30). The route creates the org
 * first and lapsed; the Payment Element confirms the first invoice; the Stripe webhook activates
 * the org; only then can drives move in and invitations go out (both refuse a lapsed org).
 */
import type { OrgBillingNotice } from '@pagespace/lib/organizations/status-core';
import type { OrgBillingStart } from './org-api';

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export interface ParsedInvites {
  valid: string[];
  invalid: string[];
}

/** Invite text → lowercased, de-duplicated addresses, plus the entries that are not addresses. */
export function parseInviteEmails(text: string): ParsedInvites {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    if (!EMAIL.test(entry)) {
      invalid.push(entry);
      continue;
    }
    const email = entry.toLowerCase();
    if (!valid.includes(email)) valid.push(email);
  }
  return { valid, invalid };
}

/**
 * Adds the people of the drives being moved to the invite text. Moving a drive in does not make its
 * members org members, so they get a seat by invitation like anyone else.
 */
export function mergeInviteEmails(text: string, emails: readonly string[], selfEmail: string): string {
  const { valid } = parseInviteEmails(text);
  const self = selfEmail.toLowerCase();
  const added = emails.map((e) => e.toLowerCase()).filter((e, i, all) => e !== self && !valid.includes(e) && all.indexOf(e) === i);
  if (added.length === 0) return text;
  const base = text.trim().replace(/[\s,;]+$/, '');
  return base ? `${base}, ${added.join(', ')}` : added.join(', ');
}

/** SEAT-3: the creator holds a seat and every pending invite reserves one. */
export function createOrgSeatCount(invites: readonly string[], selfEmail: string): number {
  const self = selfEmail.toLowerCase();
  return 1 + invites.filter((e) => e.toLowerCase() !== self).length;
}

export type CreateOrgNextStep =
  | { step: 'payment'; clientSecret: string }
  | { step: 'setup' }
  | { step: 'retry_payment' };

export function nextStepAfterCreate(billing: OrgBillingStart): CreateOrgNextStep {
  switch (billing.state) {
    case 'payment_required':
      return { step: 'payment', clientSecret: billing.payment.clientSecret };
    case 'not_billed':
    case 'subscribed':
      return { step: 'setup' };
    case 'pending':
      return { step: 'retry_payment' };
  }
}

/** The org can take drives and invitations once it is no longer lapsed. */
export function orgReadyForSetup(notice: OrgBillingNotice | undefined): boolean {
  return notice?.kind !== 'reactivate' && notice?.kind !== 'read_only';
}
