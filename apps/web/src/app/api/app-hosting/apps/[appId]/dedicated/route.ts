/**
 * /api/app-hosting/apps/[appId]/dedicated — buy or cancel the flat monthly
 * always-on SKU for one published app.
 *
 * POST   starts a dedicated subscription and returns a PaymentElement client
 *        secret. The app does NOT become dedicated here — entitlement begins when
 *        Stripe reports the subscription active, via the webhook.
 * DELETE cancels at period end. The app stays dedicated until the period Stripe
 *        has already been paid for actually ends, and the webhook moves the tier.
 *
 * WHO PAYS IS THE PAYER SEAM (WAL-9): "org if drives.orgId, else owner".
 *
 *  - A PERSONAL drive's app is billed to the drive owner's own Stripe customer,
 *    and only the owner may buy or cancel it: anybody else buying would commit a
 *    recurring charge to somebody else's card. Checked against `drives.ownerId`
 *    directly rather than through a role — a role can be granted, and "may spend
 *    this person's money" is not something a role should be able to grant.
 *  - An ORG drive's app is billed to the ORG, on the org's own Stripe customer
 *    (`organizations.stripeCustomerId`) — never the lead's or the buyer's card —
 *    and is bought or cancelled by an org Owner or Admin, who manage its billing.
 *    A LAPSED org buys nothing new (402 `org_lapsed`, SEAT-9); an org with no
 *    Stripe customer has nothing to bill (409 `org_billing_unavailable`). Cancel
 *    stays open: it can only stop a charge, never start one.
 *
 * The decision is `decideDedicatedPurchaser` (pure); this route only reads its
 * inputs and answers its verdict.
 *
 * Dark behind `APP_HOSTING_ENABLED`, and inert where `isBillingEnabled()` is false
 * (tenant, onprem) — both checked inside `isDedicatedTierPurchasable()`, before any
 * Stripe call. A disabled deployment answers 404, not 403: the feature does not
 * exist there, and saying "forbidden" would advertise one that does.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { requireOrgRole } from '@pagespace/lib/organizations/authorize';
import { findOrganizationById } from '@pagespace/lib/organizations/repository';
import { isOrgActive } from '@pagespace/lib/organizations/status';
import { ORG_LAPSED_MESSAGE } from '@pagespace/lib/organizations/status-core';
import { decideDedicatedPurchaser } from '@pagespace/lib/services/app-hosting/dedicated-tier';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { lookupDriveBillingFacts, payerForDrive } from '@pagespace/lib/billing/sandbox-payer';
import { getPublishedApp } from '@pagespace/lib/services/app-hosting/provisioner';
import { isDedicatedTierPurchasable } from '@pagespace/lib/services/app-hosting/dedicated-tier-service';
import {
  cancelDedicatedSubscription,
  startDedicatedSubscription,
  type DedicatedPayer,
} from '@/lib/app-hosting/dedicated-subscription';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/** Refusals that are the caller's fault, mapped to the status that says so. */
const REFUSAL_STATUS: Record<string, number> = {
  guest_preset_not_allowed: 400,
  already_subscribed: 409,
  not_subscribed: 404,
  // Everything price-shaped is a DEPLOYMENT misconfiguration, not a bad request:
  // the customer asked for a legitimate size and this deployment cannot sell it.
  // 503 rather than 500 because it is a configuration state that will change
  // without a code fix, and rather than 400 because there is nothing the caller
  // could have sent that would have worked.
  price_not_configured: 503,
  price_not_found: 503,
  price_not_monthly_usd: 503,
  price_below_floor: 503,
  unknown_preset: 400,
};

/**
 * Resolve the app and decide whether the caller may buy (or cancel) its dedicated tier, and for
 * whom (WAL-9): the payer seam on the app's drive, then `decideDedicatedPurchaser`. Returns the
 * app and the payer a subscription is created on — a personal drive owner's user row, or the org
 * and its Stripe customer.
 */
async function authorize(request: NextRequest, appId: string, action: 'buy' | 'cancel') {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return { error: auth.error } as const;

  // The kill switch first, before any read — while hosting is dark this endpoint
  // must be inert rather than merely fruitless.
  if (!isDedicatedTierPurchasable()) {
    return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) } as const;
  }

  // 404, not 403, on every refusal of authority: a caller with no billing authority over the app
  // must not be able to confirm that an app id exists by the shape of the refusal.
  const notFound = { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) } as const;
  const app = await getPublishedApp(appId);
  if (!app) return notFound;
  const facts = await lookupDriveBillingFacts(app.driveId);
  if (!facts) return notFound;
  const payer = payerForDrive(facts);

  const org = payer.kind === 'org' ? await findOrganizationById(payer.orgId) : null;
  const orgRole = payer.kind === 'org' ? await requireOrgRole(auth.userId, payer.orgId, 'MEMBER') : null;
  const decision = decideDedicatedPurchaser({
    payer,
    callerId: auth.userId,
    callerOrgRole: orgRole?.ok ? orgRole.role : null,
    action,
    orgActive: payer.kind === 'org' ? await isOrgActive(payer.orgId) : true,
    orgHasStripeCustomer: Boolean(org?.stripeCustomerId),
  });
  if (!decision.ok) {
    if (decision.reason === 'org_lapsed') {
      return { error: NextResponse.json({ error: 'org_lapsed', message: ORG_LAPSED_MESSAGE }, { status: 402 }) } as const;
    }
    if (decision.reason === 'org_billing_unavailable') {
      return {
        error: NextResponse.json(
          { error: 'org_billing_unavailable', message: "This organization has no billing account to charge dedicated hosting to. An org Owner needs to set up the organization's billing." },
          { status: 409 },
        ),
      } as const;
    }
    return notFound;
  }

  const { purchaser } = decision;
  if (purchaser.kind === 'org') {
    // The decision admits a BUY only when the org has a customer; a cancel needs none (null).
    const dedicatedPayer: DedicatedPayer | null = org?.stripeCustomerId
      ? { kind: 'org', orgId: purchaser.orgId, stripeCustomerId: org.stripeCustomerId, buyerUserId: purchaser.buyerUserId }
      : null;
    return { app, userId: auth.userId, payer: dedicatedPayer } as const;
  }
  const [owner] = await db.select().from(users).where(eq(users.id, purchaser.userId)).limit(1);
  if (!owner) return notFound;
  const dedicatedPayer: DedicatedPayer = { kind: 'user', user: owner };
  return { app, userId: auth.userId, payer: dedicatedPayer } as const;
}

export async function POST(request: NextRequest, context: { params: Promise<{ appId: string }> }) {
  const { appId } = await context.params;
  const authorized = await authorize(request, appId, 'buy');
  if ('error' in authorized) return authorized.error;
  const { app, payer, userId } = authorized;
  if (!payer) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // The size being bought is the size the app ALREADY RUNS, read from the row
  // rather than taken from the request body. A body-supplied preset would let a
  // caller buy the price of a small guest for an app running a large one — the
  // two columns that must agree (`published_apps.guestPreset` and the
  // subscription's `guestPreset`) would be set from different sources, which is
  // precisely the drift the mirror table's docblock warns about. Resizing is a
  // separate action, and it happens before the purchase.
  try {
    const result = await startDedicatedSubscription({
      publishedAppId: app.id,
      payer,
      guestPreset: app.guestPreset,
    });

    if (!result.ok) {
      const status = REFUSAL_STATUS[result.reason] ?? 400;
      return NextResponse.json({ error: result.reason }, { status });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'published_app_subscription',
      resourceId: result.stripeSubscriptionId,
      details: { action: 'create', publishedAppId: app.id, guestPreset: app.guestPreset, ...(payer.kind === 'org' ? { orgId: payer.orgId } : {}) },
    });

    return NextResponse.json({
      subscriptionId: result.stripeSubscriptionId,
      clientSecret: result.clientSecret,
      status: result.status,
    });
  } catch (error) {
    loggers.api.error(
      'Dedicated hosting subscription could not be started',
      error instanceof Error ? error : undefined,
      { publishedAppId: app.id },
    );
    return NextResponse.json({ error: 'Failed to start dedicated hosting' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ appId: string }> }) {
  const { appId } = await context.params;
  const authorized = await authorize(request, appId, 'cancel');
  if ('error' in authorized) return authorized.error;
  const { app, userId } = authorized;

  try {
    const result = await cancelDedicatedSubscription(app.id);
    if (!result.ok) {
      const status = REFUSAL_STATUS[result.reason] ?? 400;
      return NextResponse.json({ error: result.reason }, { status });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'published_app_subscription',
      resourceId: app.id,
      details: { action: 'cancel_at_period_end', publishedAppId: app.id },
    });

    return NextResponse.json({
      cancelAtPeriodEnd: result.cancelAtPeriodEnd,
      currentPeriodEnd: result.currentPeriodEnd.toISOString(),
    });
  } catch (error) {
    loggers.api.error(
      'Dedicated hosting subscription could not be cancelled',
      error instanceof Error ? error : undefined,
      { publishedAppId: app.id },
    );
    return NextResponse.json({ error: 'Failed to cancel dedicated hosting' }, { status: 500 });
  }
}
