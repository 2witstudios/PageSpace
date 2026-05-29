import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { zoomConnections, type ZoomConnection } from '@pagespace/db/schema/zoom';
import { webhookTriggers, type WebhookTrigger } from '@pagespace/db/schema/webhook-triggers';
import type { ZoomApiResult } from './zoom-api-client';

const toError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Pure DB lookups for the webhook-trigger firing path. Each returns a
 * ZoomApiResult<T> (reusing the zoom-api-client Result type) and never throws —
 * errors are returned as data so the orchestrator can decide per-trigger.
 */

export async function findZoomConnectionByHost(
  host_id: string,
  account_id: string,
): Promise<ZoomApiResult<ZoomConnection>> {
  try {
    // Only active connections fire. A disconnected row is retained (tokens
    // revoked, status='disconnected') but must never run workflows again;
    // 'expired'/'error' are likewise broken states where downstream work
    // (transcript token refresh) would fail anyway. Status only leaves
    // 'active' on disconnect or a failed token refresh.
    const connection = await db.query.zoomConnections.findFirst({
      where: and(
        eq(zoomConnections.zoomUserId, host_id),
        eq(zoomConnections.zoomAccountId, account_id),
        eq(zoomConnections.status, 'active'),
      ),
    });
    if (!connection) {
      return { success: false, error: 'Connection not found' };
    }
    return { success: true, data: connection };
  } catch (e) {
    return { success: false, error: toError(e) };
  }
}

export async function findMatchingWebhookTriggers(
  connectionId: string,
  eventType: string,
): Promise<ZoomApiResult<WebhookTrigger[]>> {
  try {
    const triggers = await db.query.webhookTriggers.findMany({
      where: and(
        eq(webhookTriggers.connectionId, connectionId),
        eq(webhookTriggers.eventType, eventType),
        eq(webhookTriggers.isEnabled, true),
      ),
    });
    return { success: true, data: triggers };
  } catch (e) {
    return { success: false, error: toError(e) };
  }
}

export async function claimTriggerFired(triggerId: string): Promise<ZoomApiResult<void>> {
  try {
    await db
      .update(webhookTriggers)
      .set({ lastFiredAt: new Date(), lastFireError: null })
      .where(eq(webhookTriggers.id, triggerId));
    return { success: true, data: undefined };
  } catch (e) {
    return { success: false, error: toError(e) };
  }
}

export async function setTriggerError(
  triggerId: string,
  error: string,
): Promise<ZoomApiResult<void>> {
  try {
    await db
      .update(webhookTriggers)
      .set({ lastFireError: error })
      .where(eq(webhookTriggers.id, triggerId));
    return { success: true, data: undefined };
  } catch (e) {
    return { success: false, error: toError(e) };
  }
}
