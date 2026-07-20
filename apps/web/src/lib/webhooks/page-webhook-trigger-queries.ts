import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { webhookTriggers, type WebhookTrigger } from '@pagespace/db/schema/webhook-triggers';

const toError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Pure DB lookups for the page-webhook trigger firing path — the page-anchored
 * counterpart to the Zoom connection-anchored webhook-trigger-queries. Each
 * returns a Result and never throws; errors are returned as data so the
 * orchestrator (fire-page-webhook-triggers) can decide per-trigger.
 */
export type PageTriggerQueryResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Upper bound on triggers loaded per delivery. The partial unique index is
 * (pageWebhookId, workflowId), so a single webhook can bind many workflows;
 * this bounds the fan-out well above any realistic wiring count so a
 * pathological webhook can never load an unbounded set into memory. Also
 * satisfies the required-`limit` lint rule (unbounded findMany OOM-crashed
 * prod on 2026-07-18).
 */
export const MAX_PAGE_WEBHOOK_TRIGGERS = 100;

/**
 * Every enabled trigger bound to a page webhook. Page-anchored rows skip
 * event-type matching (v1): all enabled triggers on the webhook fire.
 */
export async function findEnabledPageWebhookTriggers(
  pageWebhookId: string,
): Promise<PageTriggerQueryResult<WebhookTrigger[]>> {
  try {
    const triggers = await db.query.webhookTriggers.findMany({
      where: and(
        eq(webhookTriggers.pageWebhookId, pageWebhookId),
        eq(webhookTriggers.isEnabled, true),
      ),
      limit: MAX_PAGE_WEBHOOK_TRIGGERS,
    });
    return { success: true, data: triggers };
  } catch (e) {
    return { success: false, error: toError(e) };
  }
}

/** Success clears lastFireError and stamps lastFiredAt. Mirrors Zoom's bookkeeping. */
export async function claimTriggerFired(triggerId: string): Promise<PageTriggerQueryResult<void>> {
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

/** Failure records the error without touching lastFiredAt. Mirrors Zoom's bookkeeping. */
export async function setTriggerError(
  triggerId: string,
  error: string,
): Promise<PageTriggerQueryResult<void>> {
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
