/**
 * The create-organization flow's decisions, pure (UI-6 under D-OW-30). The route creates the org
 * first and lapsed; the Payment Element confirms the first invoice; the Stripe webhook activates
 * the org; only then can drives move in and invitations go out (both refuse a lapsed org).
 */
import type { OrgBillingNotice } from '@pagespace/lib/organizations/status-core';
import type { OrgBillingStart } from './org-api';
import { formatCreditCount, formatDollars } from '@pagespace/lib/billing/money-model';
import { orgPlanQuote, type OrgPlanQuote } from '@pagespace/lib/billing/org-plan-quote';
import { formatInvoiceAmount } from './org-format';

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

export type OrgSetupTask =
  | { kind: 'move_drive'; driveId: string }
  | { kind: 'enable_auto_seats' }
  | { kind: 'invite'; email: string };

/**
 * What runs once the org is paid: move the chosen drives in (PUT /api/drives/[id]/org), then invite.
 * A new org starts with automatic seats off (SEAT-4), so when the invitations would pass the included
 * seats the Owner's setup turns it on first; otherwise those invitations would be refused seats_full.
 */
export function planOrgSetup(input: { driveIds: readonly string[]; invites: readonly string[]; selfEmail: string; includedSeats: number }): OrgSetupTask[] {
  const self = input.selfEmail.toLowerCase();
  const invites = input.invites.filter((e) => e.toLowerCase() !== self);
  const tasks: OrgSetupTask[] = input.driveIds.map((driveId) => ({ kind: 'move_drive', driveId }));
  if (createOrgSeatCount(invites, self) > input.includedSeats) tasks.push({ kind: 'enable_auto_seats' });
  for (const email of invites) tasks.push({ kind: 'invite', email });
  return tasks;
}

/** The create dialog's plan summary (canvas CreateOrganization note), from the one quote. */
export function createOrgPlanNote(quote: OrgPlanQuote): { headline: string; body: string } {
  const headline = `Business · ${formatDollars(quote.basePriceCents)} a month with ${quote.includedSeats} seats, ${formatDollars(quote.extraSeatPriceCents)} per extra seat.`;
  const others = quote.seats - 1;
  const who = others === 0 ? 'Just you is 1 seat' : `You and ${others} ${others === 1 ? 'person' : 'people'} make ${quote.seats} seats`;
  const parts = [`${who}: ${formatDollars(quote.totalCents)} a month with ${formatCreditCount(quote.includedCreditCents)} credits a month.`];
  if (quote.extraSeats > 0) {
    parts.push(`The first payment is ${formatDollars(quote.basePriceCents)}. The ${quote.extraSeats} extra seats are added as you invite people, billed pro rata.`);
  }
  parts.push('You add a card on the next step, and the organization is ready once that first payment goes through.');
  return { headline, body: parts.join(' ') };
}

/** What the first invoice charges, from the subscription POST /api/orgs created (its extra-seat quantity). */
export function firstPaymentLines(extraSeatQuantity: number): { lines: { label: string; amount: string }[]; total: string } {
  const quote = orgPlanQuote(orgPlanQuote(0).includedSeats + Math.max(0, extraSeatQuantity));
  const lines = [{ label: `Business · ${quote.includedSeats} seats included`, amount: formatInvoiceAmount(quote.basePriceCents) }];
  if (quote.extraSeats > 0) {
    lines.push({ label: `${quote.extraSeats} extra seats × ${formatDollars(quote.extraSeatPriceCents)}`, amount: formatInvoiceAmount(quote.extraSeatsCents) });
  }
  return { lines, total: formatInvoiceAmount(quote.totalCents) };
}
