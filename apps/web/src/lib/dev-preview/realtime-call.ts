/**
 * The signed web→realtime envelope every dev-preview call uses — ONE place
 * for the signature, the no-redirect rule and the timeout, so the watch
 * trigger and the listeners read cannot drift on how they reach realtime.
 *
 * Returns `null` without a request when the feature is dark or
 * `INTERNAL_REALTIME_URL` is unset; otherwise the raw `Response` (or a
 * rejection the caller decides what to do with — the trigger logs and moves
 * on, the read answers "unknown").
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';

export function postSignedDevPreviewCall(
  route: `/api/dev-preview/${string}`,
  body: string,
  { timeoutMs, fetchImpl = fetch }: { timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<Response> | null {
  if (!isDevPreviewConfigured()) return null;
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL;
  if (!realtimeUrl) return null;
  return fetchImpl(`${realtimeUrl}${route}`, {
    method: 'POST',
    headers: createSignedBroadcastHeaders(body),
    body,
    // A signed internal call never follows a redirect: the signature is for
    // THIS body at THIS URL, and a redirect would replay it elsewhere.
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
}
