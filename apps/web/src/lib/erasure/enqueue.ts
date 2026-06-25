import { createUserServiceToken } from '@pagespace/lib/services/validated-service-token';

/**
 * Enqueue a durable GDPR account-erasure job on the processor (#906).
 *
 * Mints a short-lived `erasure:enqueue` service token against the CALLER's own
 * user resource (the self-service subject, or an admin acting through an
 * admin-gated route) and hands the (requestId, userId) to the processor's
 * pg-boss queue. Returns the jobId for storage on the DSR row.
 */

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

export interface EnqueueErasureParams {
  /** The data_subject_requests row id. */
  requestId: string;
  /** The user whose data is being erased. */
  userId: string;
  /** The authenticated caller minting the token (self or admin). */
  callerUserId: string;
}

export async function enqueueAccountErasure(params: EnqueueErasureParams): Promise<string> {
  const { token } = await createUserServiceToken(params.callerUserId, ['erasure:enqueue'], '2m');

  const res = await fetch(`${PROCESSOR_URL}/api/erasure/enqueue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ requestId: params.requestId, userId: params.userId }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Processor erasure enqueue failed: ${res.status} ${detail}`);
  }

  const json = (await res.json()) as { jobId?: string };
  if (!json.jobId) {
    throw new Error('Processor erasure enqueue returned no jobId');
  }
  return json.jobId;
}
