/**
 * org-handlers — the Stripe webhook's ORG branch (Spec SEAT-7, SEAT-9, MON-3).
 *
 * ROUTING. `resolveBillingOwner` decides whose event it is from the event's CUSTOMER:
 * an org's customer is organizations.stripeCustomerId (one per org, never a person's,
 * SEAT-1), a person's is users.stripeCustomerId. The pure rule is
 * `routeBillingOwner` (@pagespace/lib/billing/org-webhook-core): an org customer's event
 * goes here; an event that is org-tagged but on no org's customer, or on org A's
 * customer tagged for org B, is logged and has NO effect — it never falls through to
 * the personal path, so an org invoice can never fund a person, and a person's invoice
 * (no org customer) never reaches this file, so it can never fund an org pool. An
 * event for a customer that is neither an org's nor tagged takes the personal path,
 * which already skips a customer that is no user's.
 *
 * IDEMPOTENCY. Three layers, each sufficient for its own failure:
 *   1. the route's stripe_events claim: a redelivered event id is acked without
 *      running, and a concurrent second delivery of the same id finds the claim
 *      unfinished and is told to retry (500) — it never runs beside the first;
 *   2. money: the pool refill is once per INVOICE (credit_ledger.stripeRef unique), so
 *      two different events about one invoice still grant once;
 *   3. state: the subscription mirror is an absolute write of what Stripe says NOW,
 *      re-read under the org's billing lock (the same lock D1's provisioning holds), so
 *      applying it twice is applying it once, and whichever delivery runs last writes
 *      the latest state — an out-of-order or late event cannot roll the row back.
 *
 * LAPSE. The mirror is the only writer of the status SEAT-9 reads. Entering and leaving
 * lapse are logged transitions of that one row; nothing else is written — no drive,
 * member or credit is deleted or moved, so leaving lapse restores everything.
 */
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { orgSubscriptions } from '@pagespace/db/schema/organizations';
import { findOrgIdByStripeCustomerId } from '@pagespace/lib/organizations/repository';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { applyOrgPoolRefill, type OrgPoolRefillOutcome } from '@pagespace/lib/billing/wallet-funding-shell';
import { orgBillingLockKey } from '@pagespace/lib/billing/org-subscription-core';
import {
  orgInvoiceExtraSeats,
  planOrgSubscriptionMirror,
  routeBillingOwner,
  type BillingOwnerRoute,
} from '@pagespace/lib/billing/org-webhook-core';
import { deriveOrgStatus, orgLapseTransition, type OrgStatus, type OrgLapseTransition } from '@pagespace/lib/organizations/status-core';
import { stripeOrgBilling, type OrgBillingStripe } from '@/lib/org-billing/org-subscription';
import { stripe as appStripe, type Stripe } from '@/lib/stripe';
import { stripeConfig } from '@/lib/stripe-config';
import { invoiceSubscriptionId } from './dedicated-routing';
import { recordOrgAuditEventAfterCommit } from '@pagespace/lib/audit/org-audit';

export interface OrgWebhookDeps {
  /** Only the read: the mirror re-fetches the subscription, it never writes to Stripe. */
  stripe: Pick<OrgBillingStripe, 'retrieveSubscription'>;
  /** The configured extra-seat price id (stripe-config orgPriceIds.extraSeat). */
  seatPriceId: () => string;
  now?: () => Date;
}

type MetadataBag = Record<string, string> | null | undefined;

function customerIdOf(customer: string | { id?: string | null } | null | undefined): string | null {
  if (!customer) return null;
  return typeof customer === 'string' ? customer : customer.id ?? null;
}

/** The org whose Stripe customer this is, or null. */
export async function orgForStripeCustomer(customerId: string | null): Promise<string | null> {
  return customerId ? findOrgIdByStripeCustomerId(customerId) : null;
}

/** SEAT-7: whose event is this — an org's, a person's, or an org-tagged event we must not apply. */
export async function resolveBillingOwner(
  customer: string | { id?: string | null } | null | undefined,
  metadata: MetadataBag,
): Promise<BillingOwnerRoute> {
  return routeBillingOwner({ customerOrgId: await orgForStripeCustomer(customerIdOf(customer)), metadata });
}

/** Log an org-tagged event that has no org to apply to. It is acked: retrying cannot make it apply. */
function logUnapplied(route: Exclude<BillingOwnerRoute, { kind: 'org' } | { kind: 'person' }>, eventId: string, objectId: string | null): void {
  if (route.kind === 'org_mismatch') {
    loggers.api.error('Stripe org event names a different org than its customer; not applied', undefined, {
      eventId,
      objectId,
      customerOrgId: route.orgId,
      taggedOrgId: route.taggedOrgId,
    });
    return;
  }
  loggers.api.warn('Stripe org-tagged event on a customer that is no org of ours; not applied (never routed to a person)', {
    eventId,
    objectId,
    taggedOrgId: route.taggedOrgId,
  });
}

export type OrgMirrorOutcome =
  | {
      kind: 'applied';
      orgId: string;
      stripeStatus: string;
      cancelAtPeriodEnd: boolean;
      /** What org_subscriptions held before this mirror: a change is an AUD-1 billing event. */
      previous: { stripeStatus: string; cancelAtPeriodEnd: boolean };
      before: OrgStatus;
      after: OrgStatus;
      transition: OrgLapseTransition | null;
    }
  | { kind: 'ignored'; orgId: string; reason: 'no_row' | 'ignore_other_subscription' };

/**
 * Mirror the org's subscription from Stripe onto org_subscriptions, under the org's
 * billing lock. Re-reads Stripe rather than trusting the event snapshot (see the header).
 * Throws on a Stripe or database failure so the route's retry wrapper lets Stripe
 * redeliver.
 */
export async function mirrorOrgSubscription(
  orgId: string,
  subscriptionId: string,
  eventId: string,
  deps: OrgWebhookDeps,
): Promise<OrgMirrorOutcome> {
  const outcome = await db.transaction(async (tx): Promise<OrgMirrorOutcome> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgBillingLockKey(orgId)}, 0))`);
    const [stored] = await tx.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)).limit(1);
    const plan = planOrgSubscriptionMirror({ storedSubscriptionId: stored?.stripeSubscriptionId ?? null, fetchedSubscriptionId: subscriptionId });
    if (plan !== 'apply' || !stored) return { kind: 'ignored', orgId, reason: plan === 'apply' ? 'no_row' : plan };

    const fetched = await deps.stripe.retrieveSubscription(subscriptionId);
    const now = deps.now?.() ?? new Date();
    const billingEnabled = isBillingEnabled();
    const next = {
      status: fetched.status,
      trialEnd: fetched.trialEnd === null ? null : new Date(fetched.trialEnd * 1000),
      currentPeriodStart: fetched.currentPeriodStart === null ? null : new Date(fetched.currentPeriodStart * 1000),
      currentPeriodEnd: fetched.currentPeriodEnd === null ? null : new Date(fetched.currentPeriodEnd * 1000),
      cancelAtPeriodEnd: fetched.cancelAtPeriodEnd,
    };
    const before = deriveOrgStatus({ billingEnabled, subscription: stored, now }).status;
    await tx.update(orgSubscriptions).set(next).where(eq(orgSubscriptions.id, stored.id));
    const after = deriveOrgStatus({ billingEnabled, subscription: next, now }).status;
    return {
      kind: 'applied',
      orgId,
      stripeStatus: fetched.status,
      cancelAtPeriodEnd: fetched.cancelAtPeriodEnd,
      previous: { stripeStatus: stored.status, cancelAtPeriodEnd: stored.cancelAtPeriodEnd },
      before,
      after,
      transition: orgLapseTransition(before, after),
    };
  });

  if (outcome.kind === 'applied' && (outcome.previous.stripeStatus !== outcome.stripeStatus || outcome.previous.cancelAtPeriodEnd !== outcome.cancelAtPeriodEnd)) {
    // AUD-1: a billing event, only when something changed (a redelivered event mirrors the same state).
    await recordOrgAuditEventAfterCommit({
      orgId,
      eventType: 'org.billing.subscription_changed',
      resourceType: 'org_subscription',
      resourceId: orgId,
      details: {
        source: 'stripe_webhook',
        eventId,
        from: outcome.previous.stripeStatus,
        to: outcome.stripeStatus,
        cancelAtPeriodEnd: outcome.cancelAtPeriodEnd,
        orgStatusBefore: outcome.before,
        orgStatusAfter: outcome.after,
        ...(outcome.transition ? { transition: outcome.transition } : {}),
      },
    });
  }
  if (outcome.kind === 'ignored') {
    loggers.api.info('Stripe org subscription event not mirrored', { eventId, orgId, subscriptionId, reason: outcome.reason });
  } else if (outcome.transition !== null) {
    // Entering or leaving lapse is the one billing change members feel (SEAT-9).
    loggers.api.info(outcome.transition === 'entered_lapse' ? 'org entered lapse' : 'org left lapse', {
      eventId,
      orgId,
      subscriptionId,
      stripeStatus: outcome.stripeStatus,
      before: outcome.before,
      after: outcome.after,
    });
  }
  return outcome;
}

/** customer.subscription.created / updated / deleted for an org-routed event. */
export async function handleOrgSubscriptionEvent(
  route: Exclude<BillingOwnerRoute, { kind: 'person' }>,
  subscription: Pick<Stripe.Subscription, 'id'>,
  eventId: string,
  deps: OrgWebhookDeps,
): Promise<OrgMirrorOutcome | null> {
  if (route.kind !== 'org') {
    logUnapplied(route, eventId, subscription.id);
    return null;
  }
  return mirrorOrgSubscription(route.orgId, subscription.id, eventId, deps);
}

export type OrgInvoicePaidOutcome = { refill: OrgPoolRefillOutcome; mirror: OrgMirrorOutcome | null } | null;

/**
 * invoice.paid for an org-routed event: refill the org's pool through the one funding
 * path (applyOrgPoolRefill: what was PAID net of discounts × ratio, or list × ratio for
 * an admin gift, [D-OW-23]; a $0 non-gift invoice grants nothing, [D-OW-30]; once per invoice), then mirror the subscription — a paid
 * invoice is usually what lifts past_due or lapse. A paid invoice funds the pool even
 * while the org is lapsed: money that was paid is never dropped.
 */
export async function handleOrgInvoicePaid(
  route: Exclude<BillingOwnerRoute, { kind: 'person' }>,
  invoice: Stripe.Invoice,
  eventId: string,
  deps: OrgWebhookDeps,
): Promise<OrgInvoicePaidOutcome> {
  if (route.kind !== 'org') {
    logUnapplied(route, eventId, invoice.id ?? null);
    return null;
  }
  const extraSeats = await invoiceExtraSeats(route.orgId, invoice, deps);
  const refill = await applyOrgPoolRefill(invoice, { extraSeats });
  const subscriptionId = invoiceSubscriptionId(invoice);
  const mirror = subscriptionId ? await mirrorOrgSubscription(route.orgId, subscriptionId, eventId, deps) : null;
  return { refill, mirror };
}

/** invoice.payment_failed for an org-routed event: mirror the subscription (it goes past_due). */
export async function handleOrgInvoicePaymentFailed(
  route: Exclude<BillingOwnerRoute, { kind: 'person' }>,
  invoice: Stripe.Invoice,
  eventId: string,
  deps: OrgWebhookDeps,
): Promise<OrgMirrorOutcome | null> {
  if (route.kind !== 'org') {
    logUnapplied(route, eventId, invoice.id ?? null);
    return null;
  }
  const subscriptionId = invoiceSubscriptionId(invoice);
  return subscriptionId ? mirrorOrgSubscription(route.orgId, subscriptionId, eventId, deps) : null;
}

/**
 * The extra seats the invoice billed, for sizing a gift at list price: the
 * invoice's own seat line (a count), else the stored subscription's quantity, else 0.
 */
async function invoiceExtraSeats(orgId: string, invoice: Stripe.Invoice, deps: OrgWebhookDeps): Promise<number> {
  const fromInvoice = orgInvoiceExtraSeats(invoice.lines?.data ?? [], deps.seatPriceId());
  if (fromInvoice !== null) return fromInvoice;
  const [stored] = await db
    .select({ extraSeatQuantity: orgSubscriptions.extraSeatQuantity })
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.orgId, orgId))
    .limit(1);
  return stored?.extraSeatQuantity ?? 0;
}

/** Production wiring: the app's Stripe client (read only here) and the configured seat price. */
export function defaultOrgWebhookDeps(): OrgWebhookDeps {
  return {
    stripe: stripeOrgBilling(appStripe),
    seatPriceId: () => stripeConfig.orgPriceIds.extraSeat,
  };
}

// ---------------------------------------------------------------------------
// What route.ts calls: resolve the owner, handle an org event, report whether it did.
// Each returns false for a PERSON's event, which then takes the personal path untouched.
// ---------------------------------------------------------------------------

type InvoiceMetadata = Record<string, string> | null | undefined;

function invoiceMetadata(invoice: Stripe.Invoice): InvoiceMetadata {
  return invoice.parent?.subscription_details?.metadata as InvoiceMetadata;
}

/** customer.subscription.created / updated / deleted. */
export async function routeOrgSubscriptionEvent(
  subscription: Stripe.Subscription,
  eventId: string,
  deps: () => OrgWebhookDeps = defaultOrgWebhookDeps,
): Promise<boolean> {
  const owner = await resolveBillingOwner(subscription.customer, subscription.metadata);
  if (owner.kind === 'person') return false;
  await handleOrgSubscriptionEvent(owner, subscription, eventId, deps());
  return true;
}

/** invoice.paid. */
export async function routeOrgInvoicePaid(
  invoice: Stripe.Invoice,
  eventId: string,
  deps: () => OrgWebhookDeps = defaultOrgWebhookDeps,
): Promise<boolean> {
  const owner = await resolveBillingOwner(invoice.customer, invoiceMetadata(invoice));
  if (owner.kind === 'person') return false;
  await handleOrgInvoicePaid(owner, invoice, eventId, deps());
  return true;
}

/** invoice.payment_failed. */
export async function routeOrgInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  eventId: string,
  deps: () => OrgWebhookDeps = defaultOrgWebhookDeps,
): Promise<boolean> {
  const owner = await resolveBillingOwner(invoice.customer, invoiceMetadata(invoice));
  if (owner.kind === 'person') return false;
  await handleOrgInvoicePaymentFailed(owner, invoice, eventId, deps());
  return true;
}
