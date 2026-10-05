/**
 * org-wallet-events — the realtime events the org and wallet surfaces react to (Spec X-4): the
 * spending-from chip, the Drive Wallet page, the org hub and its Members & seats, Policies and
 * Plan pages update without a refresh.
 *
 *   wallet:changed  on `drive:<driveId>:wallet` (joined only by people with a wallet view)
 *                   payload { driveId, walletId, change: 'balance' | 'allocation' | 'status' | 'caps' | 'rules' }
 *   org:changed     on `notifications:<userId>` for every accepted member of the org
 *                   payload { orgId, change: 'policy' | 'seats' | 'status' | 'membership' | 'seat_caps' | 'wallet' }
 *
 * Payloads carry ids and the kind of change only — never an amount — so a viewer learns nothing
 * their own projection would not show; the client refetches the view it is allowed (SPEND-9).
 * Emitting is best-effort and never throws: the change itself has already committed.
 */
import { createSignedBroadcastHeaders } from '../auth/broadcast-auth';
import { loggers } from '../logging/logger-config';
import { errorLogFields } from '../logging/error-cause';
import { driveWalletRoom } from './rooms';

export const WALLET_CHANGED_EVENT = 'wallet:changed' as const;
export const ORG_CHANGED_EVENT = 'org:changed' as const;

export type WalletChange = 'balance' | 'allocation' | 'status' | 'caps' | 'rules';
export type OrgChange = 'policy' | 'seats' | 'status' | 'membership' | 'seat_caps' | 'wallet';

export interface RealtimeMessage<P> {
  channelId: string;
  event: string;
  payload: P;
}

export interface WalletChangedPayload { driveId: string; walletId: string; change: WalletChange }
export interface OrgChangedPayload { orgId: string; change: OrgChange }

export function walletChangedMessage(input: WalletChangedPayload): RealtimeMessage<WalletChangedPayload> {
  return { channelId: driveWalletRoom(input.driveId), event: WALLET_CHANGED_EVENT, payload: { driveId: input.driveId, walletId: input.walletId, change: input.change } };
}

/** One message per recipient, deduplicated and in a stable order. */
export function orgChangedMessages(input: OrgChangedPayload, recipientIds: readonly string[]): RealtimeMessage<OrgChangedPayload>[] {
  return [...new Set(recipientIds)].sort().map((userId) => ({
    channelId: `notifications:${userId}`,
    event: ORG_CHANGED_EVENT,
    payload: { orgId: input.orgId, change: input.change },
  }));
}

async function send(message: RealtimeMessage<unknown>): Promise<void> {
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL;
  if (!realtimeUrl) return;
  const body = JSON.stringify(message);
  const response = await fetch(`${realtimeUrl}/api/broadcast`, {
    method: 'POST',
    headers: createSignedBroadcastHeaders(body),
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`realtime broadcast failed: ${response.status}`);
}

/** Tell a drive's room its wallet changed. Never throws. */
export async function emitWalletChanged(input: WalletChangedPayload): Promise<void> {
  try {
    await send(walletChangedMessage(input));
  } catch (error) {
    loggers.realtime.warn('wallet:changed broadcast failed', { ...errorLogFields(error), driveId: input.driveId, change: input.change });
  }
}

/**
 * Tell every accepted member of `orgId` the org changed. The recipients are read by the caller's
 * `members` port (the org repository's member list), so this module does no access reads itself.
 * Never throws.
 */
export async function emitOrgChanged(input: OrgChangedPayload, members: (orgId: string) => Promise<readonly string[]>): Promise<void> {
  try {
    const messages = orgChangedMessages(input, await members(input.orgId));
    const results = await Promise.allSettled(messages.map(send));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) loggers.realtime.warn('org:changed broadcast partly failed', { orgId: input.orgId, change: input.change, failed, total: messages.length });
  } catch (error) {
    loggers.realtime.warn('org:changed broadcast failed', { ...errorLogFields(error), orgId: input.orgId, change: input.change });
  }
}
