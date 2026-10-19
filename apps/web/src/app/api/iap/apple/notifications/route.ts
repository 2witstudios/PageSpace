import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { appStoreNotifications } from '@pagespace/db/schema/app-store';
import { getPersonalTierFromPrice } from '@/lib/stripe/price-config';
import { emitCreditsUpdated } from '@/lib/subscription/credit-balance';
import { notificationReply, readJwsField, verificationFailureReply } from '@/lib/iap-server/apple-http';
import { AppleVerificationError, getAppleVerifier } from '@pagespace/lib/billing/apple/apple-verify';
import { applyAppleNotification } from '@pagespace/lib/billing/apple/apple-funding';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { errorLogFields } from '@pagespace/lib/logging/error-cause';

/**
 * POST /api/iap/apple/notifications — App Store Server Notifications V2.
 *
 * Public: there is no session; the signed payload IS the authentication — it is
 * verified against Apple's root (with the bundle id and, in Production, the App Apple
 * ID) before anything in it is read. Configure this URL for both Production and
 * Sandbox in App Store Connect.
 *
 * Idempotency: the notificationUUID is claimed in app_store_notifications and marked
 * processed once applied; a redelivery of a processed notification is acked without
 * work. Reprocessing an unfinished one is safe — every write it makes is keyed by Apple
 * transaction id (apple-funding), so a concurrent duplicate cannot apply twice.
 */
export async function POST(request: NextRequest) {
  if (!isBillingEnabled()) return NextResponse.json({ received: true }, { status: 200 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_notification' }, { status: 400 });
  }
  const signedPayload = readJwsField(body, 'signedPayload');
  if (!signedPayload) return NextResponse.json({ error: 'invalid_notification' }, { status: 400 });

  const { config, verifier } = getAppleVerifier();
  let notification;
  try {
    notification = await verifier.verifyNotification(signedPayload);
  } catch (error) {
    const failure = error instanceof AppleVerificationError ? error.failure : 'invalid_signature';
    loggers.api.warn('App Store notification did not verify', { failure });
    const reply = verificationFailureReply(failure);
    return NextResponse.json(reply.body, { status: reply.status });
  }

  const { notificationUUID } = notification;
  try {
    await db
      .insert(appStoreNotifications)
      .values({ notificationUUID, type: notification.type, subtype: notification.subtype, createdAt: new Date() })
      .onConflictDoNothing({ target: appStoreNotifications.notificationUUID });
    const [claimed] = await db
      .select({ processedAt: appStoreNotifications.processedAt })
      .from(appStoreNotifications)
      .where(eq(appStoreNotifications.notificationUUID, notificationUUID))
      .limit(1);
    if (claimed?.processedAt) return NextResponse.json({ received: true, result: 'duplicate' }, { status: 200 });

    const result = await applyAppleNotification({
      notification,
      priceTier: getPersonalTierFromPrice,
      config: { bundleId: config.bundleId, allowSandbox: config.allowSandbox },
    });

    await db
      .update(appStoreNotifications)
      .set({ processedAt: new Date(), error: result.result === 'refused' ? result.reason : null })
      .where(eq(appStoreNotifications.notificationUUID, notificationUUID));

    loggers.api.info('App Store notification processed', {
      notificationUUID,
      type: notification.type,
      subtype: notification.subtype,
      result: result.result,
      ...(result.result === 'refused' || result.result === 'ignored' ? { reason: result.reason } : {}),
    });
    if (result.result === 'applied') void emitCreditsUpdated(result.userId);
    const reply = notificationReply(result);
    return NextResponse.json(reply.body, { status: reply.status });
  } catch (error) {
    loggers.api.error('App Store notification failed; Apple will redeliver', error instanceof Error ? error : undefined, {
      notificationUUID,
      ...errorLogFields(error),
    });
    await db
      .update(appStoreNotifications)
      .set({ error: error instanceof Error ? error.message.slice(0, 500) : 'failed' })
      .where(eq(appStoreNotifications.notificationUUID, notificationUUID))
      .catch(() => undefined);
    return NextResponse.json({ error: 'Notification not processed' }, { status: 500 });
  }
}

