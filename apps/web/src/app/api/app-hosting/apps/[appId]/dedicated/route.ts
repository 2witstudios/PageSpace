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
 * ONLY THE DRIVE OWNER MAY BUY. Hosting is billed to the drive owner
 * (`resolveEnvPayerId` semantics — see `app-billing.ts`), so anybody else buying
 * would be committing a recurring charge to somebody else's card. That makes
 * ownership the authorization question here rather than the drive's usual
 * edit-permission question, and it is checked against `drives.ownerId` directly
 * rather than through a role: a role can be granted, and "may spend this person's
 * money" is not something a role should be able to grant.
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
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { lookupDriveOwnerId } from '@pagespace/lib/billing/sandbox-payer';
import { getPublishedApp } from '@pagespace/lib/services/app-hosting/provisioner';
import { isDedicatedTierPurchasable } from '@pagespace/lib/services/app-hosting/dedicated-tier-service';
import {
  cancelDedicatedSubscription,
  startDedicatedSubscription,
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
 * Resolve the app and confirm the caller owns the drive that pays for it.
 *
 * Returns the app plus the OWNER's user row — not the caller's — because the
 * subscription is created against the owner's Stripe customer, and they are the
 * same person by the time this returns. Reading it explicitly keeps that fact in
 * the code rather than in a reader's head.
 */
async function authorize(request: NextRequest, appId: string) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return { error: auth.error } as const;

  // The kill switch first, before any read — while hosting is dark this endpoint
  // must be inert rather than merely fruitless.
  if (!isDedicatedTierPurchasable()) {
    return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) } as const;
  }

  const app = await getPublishedApp(appId);
  if (!app) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) } as const;

  const ownerId = await lookupDriveOwnerId(app.driveId);
  if (!ownerId || ownerId !== auth.userId) {
    // 404, not 403: a non-owner must not be able to confirm that an app id exists
    // by the shape of the refusal.
    return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) } as const;
  }

  const [owner] = await db.select().from(users).where(eq(users.id, ownerId)).limit(1);
  if (!owner) {
    return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) } as const;
  }

  return { app, owner, userId: auth.userId } as const;
}

export async function POST(request: NextRequest, context: { params: Promise<{ appId: string }> }) {
  const { appId } = await context.params;
  const authorized = await authorize(request, appId);
  if ('error' in authorized) return authorized.error;
  const { app, owner, userId } = authorized;

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
      user: owner,
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
      details: { action: 'create', publishedAppId: app.id, guestPreset: app.guestPreset },
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
  const authorized = await authorize(request, appId);
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
