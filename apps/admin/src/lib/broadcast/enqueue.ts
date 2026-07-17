import { createUserServiceToken } from '@pagespace/lib/services/validated-service-token';

/**
 * Enqueue a durable email-broadcast job on the processor.
 *
 * Mirrors `apps/web/src/lib/erasure/enqueue.ts` — the proven admin-route →
 * scoped-service-token → processor pg-boss shape. Mints a short-lived
 * `broadcast:enqueue` token against the calling ADMIN's own user resource and
 * hands the broadcastId to `POST ${PROCESSOR_URL}/api/broadcast/enqueue`.
 *
 * Unlike the erasure helper, failures here are CLASSIFIED, because the caller's
 * wrong reaction to an ambiguous failure is a duplicate mass email: marking the
 * row failed while a job actually landed leaves the worker free to send it
 * anyway (it only yields to cancelled/paused/completed), with the UI telling
 * the admin the send died — an invitation to create a second broadcast.
 *
 *  - `BroadcastNotEnqueuedError`: definitely NO job exists (token minting
 *    failed, or the processor answered a non-409 4xx after examining the
 *    request). Safe to mark the row failed and let the admin retry.
 *  - `BroadcastEnqueueUnconfirmedError`: a job MAY exist (network error,
 *    timeout, 5xx, unparseable response). The caller must not fail the row and
 *    must not invite a retry.
 *
 * Ambiguity is first RESOLVED rather than reported: the processor enqueues with
 * `singletonKey: broadcastId`, so re-POSTing the same id cannot start a second
 * concurrent job — and its 409 is positive proof the lost first attempt landed.
 * One reconciliation retry therefore converts most ambiguous failures into a
 * definite answer.
 *
 * NOTE: the admin app makes no other processor calls, so PROCESSOR_URL must be
 * set in its deployment env (see fly.admin.toml). The docker default matches
 * the compose service name, same as the erasure helper.
 */

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

/** Bounded so a hung processor stalls the admin request for seconds, not forever. */
const ENQUEUE_TIMEOUT_MS = 10_000;

/** Definitely not enqueued — no job exists; the row may safely be failed. */
export class BroadcastNotEnqueuedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BroadcastNotEnqueuedError';
  }
}

/** The enqueue MAY have landed — a job may exist; do not fail the row. */
export class BroadcastEnqueueUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BroadcastEnqueueUnconfirmedError';
  }
}

export interface EnqueueBroadcastParams {
  /** The email_broadcasts row id the worker will send against. */
  broadcastId: string;
  /** The authenticated admin minting the token. */
  callerUserId: string;
}

export interface EnqueueBroadcastResult {
  /**
   * The pg-boss jobId, or null when the processor deduped the request (a job
   * for this broadcast already exists — same outcome, id unknown).
   */
  jobId: string | null;
}

type AttemptOutcome =
  | { kind: 'ok'; jobId: string }
  | { kind: 'deduped' }
  | { kind: 'refused'; detail: string }
  | { kind: 'ambiguous'; detail: string };

async function postEnqueue(broadcastId: string, token: string): Promise<AttemptOutcome> {
  let res: Response;
  try {
    res = await fetch(`${PROCESSOR_URL}/api/broadcast/enqueue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ broadcastId }),
      signal: AbortSignal.timeout(ENQUEUE_TIMEOUT_MS),
    });
  } catch (error) {
    // Network error or timeout: the request may or may not have reached the
    // processor before dying. Nothing can be concluded from here.
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: 'ambiguous', detail };
  }

  // singletonKey conflict: a job for this broadcast is ALREADY queued/running.
  // For an enqueue that's success, not failure — just with an unknown jobId.
  if (res.status === 409) return { kind: 'deduped' };

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // A non-409 4xx means the processor examined the request and refused it —
    // no job was created. A 5xx could have crashed after addJob succeeded.
    return res.status < 500
      ? { kind: 'refused', detail: `${res.status} ${detail}` }
      : { kind: 'ambiguous', detail: `${res.status} ${detail}` };
  }

  let json: { jobId?: string };
  try {
    json = (await res.json()) as { jobId?: string };
  } catch {
    // 2xx but the body was lost/garbled: the job exists, the id didn't survive.
    return { kind: 'ambiguous', detail: '2xx response with unreadable body' };
  }
  if (!json.jobId) {
    return { kind: 'ambiguous', detail: '2xx response with no jobId' };
  }
  return { kind: 'ok', jobId: json.jobId };
}

export async function enqueueBroadcast(params: EnqueueBroadcastParams): Promise<EnqueueBroadcastResult> {
  // A minting failure happens before any request leaves the process — the one
  // failure that is unambiguous by construction.
  let token: string;
  try {
    ({ token } = await createUserServiceToken(params.callerUserId, ['broadcast:enqueue'], '2m'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BroadcastNotEnqueuedError(`service token minting failed: ${detail}`);
  }

  const first = await postEnqueue(params.broadcastId, token);
  if (first.kind === 'ok') return { jobId: first.jobId };
  if (first.kind === 'deduped') return { jobId: null };
  if (first.kind === 'refused') {
    throw new BroadcastNotEnqueuedError(`Processor broadcast enqueue refused: ${first.detail}`);
  }

  // Ambiguous → reconcile with one retry. The singletonKey makes this safe (a
  // landed first attempt yields 409, not a second job), and every outcome but
  // another transport failure converts the ambiguity into a definite answer.
  const second = await postEnqueue(params.broadcastId, token);
  if (second.kind === 'ok') return { jobId: second.jobId };
  if (second.kind === 'deduped') return { jobId: null };
  if (second.kind === 'refused') {
    throw new BroadcastNotEnqueuedError(`Processor broadcast enqueue refused: ${second.detail}`);
  }

  throw new BroadcastEnqueueUnconfirmedError(
    `Processor broadcast enqueue unconfirmed: ${first.detail}; retry: ${second.detail}`,
  );
}
