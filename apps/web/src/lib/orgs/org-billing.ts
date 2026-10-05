/** Plan & seats (UI-7, canvas Billing): pure figures. Dollars only for prices and invoices; credits are counts (UI-12). */
import { formatCreditCount, formatDollars } from '@pagespace/lib/billing/money-model';
import { orgPlanQuote } from '@pagespace/lib/billing/org-plan-quote';
import type { OrgPoolSplit } from '@pagespace/lib/services/drive-wallet-service';
import type { OrgSeats } from './org-api';
import { formatInvoiceAmount, formatOrgLongDate, formatOrgShortDate } from './org-format';

export function planFigures(seats: OrgSeats): { price: string; terms: string; breakdown: string } {
  const quote = orgPlanQuote(seats.purchased);
  const renews = formatOrgLongDate(seats.currentPeriodEnd);
  const terms = [`${formatDollars(quote.basePriceCents)} a month with ${quote.includedSeats} seats`, `${formatDollars(quote.extraSeatPriceCents)} per extra seat`, ...(renews ? [`renews ${renews}`] : [])].join(' · ');
  const price = quote.extraSeats > 0 ? `${formatDollars(quote.basePriceCents)} + ${quote.extraSeats} extra seats × ${formatDollars(quote.extraSeatPriceCents)}` : formatDollars(quote.basePriceCents);
  return {
    price: formatInvoiceAmount(quote.totalCents),
    terms,
    breakdown: `${price} · ${formatCreditCount(quote.includedCreditCents)} credits included each month · your personal plan is billed separately`,
  };
}

export function seatFigures(seats: OrgSeats): { percent: number; inUse: string; total: string } {
  const percent = seats.purchased > 0 ? Math.min(100, Math.round((seats.held / seats.purchased) * 100)) : 0;
  return {
    percent,
    inUse: `${seats.members} in use · ${seats.pendingInvites} reserved by invites`,
    total: `${seats.purchased} seats · ${seats.included} included + ${seats.purchasedExtra} extra`,
  };
}

const credits = (cents: number) => `${formatCreditCount(cents)} credits`;

export function poolFigures(split: OrgPoolSplit) {
  const refill = formatOrgShortDate(split.periodEnd);
  const driveAllocation = split.driveWallets.reduce((sum, w) => sum + w.allocationCents, 0);
  const driveSpent = split.driveWallets.reduce((sum, w) => sum + w.spentCents, 0);
  const n = split.driveWallets.length;
  return {
    unallocated: { value: credits(split.unallocatedCents), label: refill ? `Unallocated · refills on ${refill}` : 'Unallocated' },
    seats: {
      value: credits(split.seats.allocatedCents),
      label: `Allocated to seats · ${split.seats.memberCount} × ${formatCreditCount(split.seats.allowanceCents)} credits a month · ${credits(split.seats.spentCents)} spent`,
    },
    drives: { value: credits(driveAllocation), label: `Allocated to drive wallets · ${n} ${n === 1 ? 'drive' : 'drives'} · ${credits(driveSpent)} spent` },
  };
}

export interface OrgInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: string;
  periodStart: string | null;
  periodEnd: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

const STATUS: Record<string, { label: string; tone: 'live' | 'restricted' | 'pending' | 'danger' }> = {
  paid: { label: 'Paid', tone: 'live' },
  open: { label: 'Open', tone: 'restricted' },
  draft: { label: 'Draft', tone: 'pending' },
  void: { label: 'Void', tone: 'pending' },
  uncollectible: { label: 'Unpaid', tone: 'danger' },
};

export function invoiceLine(invoice: OrgInvoice): { date: string; summary: string; status: string; tone: 'live' | 'restricted' | 'pending' | 'danger' } {
  const start = formatOrgShortDate(invoice.periodStart);
  const end = formatOrgShortDate(invoice.periodEnd);
  const amount = formatInvoiceAmount(invoice.status === 'paid' ? invoice.amountPaid : invoice.amountDue);
  const parts = [...(invoice.number ? [invoice.number] : []), ...(start && end ? [`${start} – ${end}`] : []), amount];
  const status = STATUS[invoice.status ?? ''] ?? { label: invoice.status ?? 'Unknown', tone: 'pending' as const };
  return { date: formatOrgLongDate(invoice.created) ?? '', summary: parts.join(' · '), status: status.label, tone: status.tone };
}
