/**
 * credit-emit — recompute a user's prepaid balance and push it to their
 * notifications channel as a `credits:updated` socket event.
 *
 * Centralized here, in @pagespace/lib, so EVERY balance/holds mutation broadcasts a
 * fresh balance regardless of which caller triggered it — the billing primitives
 * (credit-consume, credit-gate, credit-backfill) call this directly instead of each
 * of the many AI routes / background jobs having to remember to emit. New billing
 * callers inherit live navbar updates for free.
 *
 * Best-effort and never throws: a failed balance read or broadcast must not break the
 * request or turn a fire-and-forget call into an unhandled rejection. A no-op when
 * billing is disabled. Always invoke as `void emitCreditsUpdated(...)`.
 *
 * The broadcast mirrors the notifications broadcaster (notifications/notifications.ts):
 * a signed POST to the realtime server's /api/broadcast, channel `notifications:{userId}`.
 * The payload is structurally identical to the client's CreditsEventPayload
 * (apps/web socket-utils), so the navbar widget and per-conversation usage monitor
 * consume it unchanged.
 */

import { createSignedBroadcastHeaders } from '../auth/broadcast-auth';
import { isBillingEnabled } from '../deployment-mode';
import { loggers } from '../logging/logger-config';
import type { SubscriptionTier } from '../services/subscription-utils';
import { getCreditBalance, resolveTier } from './credit-balance';

export interface EmitCreditsOptions {
  /** Pre-resolved tier to avoid an extra users lookup when the caller already has it. */
  tier?: SubscriptionTier;
  /** Optional scoping hints so the per-conversation usage monitor refreshes the right view. */
  conversationId?: string;
  pageId?: string;
}

async function broadcastCreditsUpdated(
  userId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL || 'http://localhost:3001';
  const requestBody = JSON.stringify({
    channelId: `notifications:${userId}`,
    event: 'credits:updated',
    payload: { userId, operation: 'updated', ...body },
  });

  const response = await fetch(`${realtimeUrl}/api/broadcast`, {
    method: 'POST',
    headers: createSignedBroadcastHeaders(requestBody),
    body: requestBody,
    signal: AbortSignal.timeout(5000),
  });
  // A 4xx/5xx means the broadcast was dropped (bad signature, realtime error). Throw
  // so emitCreditsUpdated's catch records it — otherwise dropped pushes look silently
  // successful and we lose the only signal that the navbar didn't get updated.
  if (!response.ok) {
    throw new Error(`realtime broadcast failed: ${response.status}`);
  }
}

/**
 * Recompute the user's balance and broadcast it. Called from the billing primitives
 * after any mutation (hold create/release, debit, sweep) and from the Stripe webhook
 * after funding.
 */
export async function emitCreditsUpdated(
  userId: string,
  opts: EmitCreditsOptions = {},
): Promise<void> {
  if (!isBillingEnabled()) return;
  try {
    const tier = opts.tier ?? (await resolveTier(userId));
    const summary = await getCreditBalance(userId, tier);
    await broadcastCreditsUpdated(userId, {
      billingEnabled: summary.billingEnabled,
      monthly: summary.monthly,
      topup: summary.topup,
      debt: summary.debt,
      spendable: summary.spendable,
      reserved: summary.reserved,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      ...(opts.pageId ? { pageId: opts.pageId } : {}),
    });
  } catch (error) {
    // Best-effort: a failed balance read/broadcast must never escalate on the
    // fire-and-forget call path. Log defensively so a partial logger (e.g. a unit-test
    // mock) can't itself turn a swallowed error into a throw.
    loggers?.ai?.debug?.('emitCreditsUpdated failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
