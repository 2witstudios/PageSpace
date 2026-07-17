import { createUserServiceToken } from '@pagespace/lib/services/validated-service-token';

/**
 * Enqueue a durable email-broadcast job on the processor.
 *
 * Mirrors `apps/web/src/lib/erasure/enqueue.ts` — the proven admin-route →
 * scoped-service-token → processor pg-boss shape. Mints a short-lived
 * `broadcast:enqueue` token against the calling ADMIN's own user resource and
 * hands the broadcastId to `POST ${PROCESSOR_URL}/api/broadcast/enqueue`.
 * Returns the jobId for `broadcastRepository.markQueued`.
 *
 * NOTE: the admin app makes no other processor calls, so PROCESSOR_URL must be
 * set in its deployment env (see fly.admin.toml). The docker default matches
 * the compose service name, same as the erasure helper.
 */

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

export interface EnqueueBroadcastParams {
  /** The email_broadcasts row id the worker will send against. */
  broadcastId: string;
  /** The authenticated admin minting the token. */
  callerUserId: string;
}

export async function enqueueBroadcast(params: EnqueueBroadcastParams): Promise<{ jobId: string }> {
  const { token } = await createUserServiceToken(params.callerUserId, ['broadcast:enqueue'], '2m');

  const res = await fetch(`${PROCESSOR_URL}/api/broadcast/enqueue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ broadcastId: params.broadcastId }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Processor broadcast enqueue failed: ${res.status} ${detail}`);
  }

  const json = (await res.json()) as { jobId?: string };
  if (!json.jobId) {
    throw new Error('Processor broadcast enqueue returned no jobId');
  }
  return { jobId: json.jobId };
}
