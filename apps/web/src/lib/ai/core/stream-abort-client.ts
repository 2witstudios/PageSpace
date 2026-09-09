/**
 * THE DELIBERATE STOP — the only thing in this client that stops a generation.
 *
 * Both functions here POST to `/api/ai/abort`, which is the ONE mechanism that reaches the
 * server-side abort registry. Nothing else in the app may stop a stream: streams are
 * server-owned and survive client disconnect by design, so cancelling a local fetch ends only
 * this tab's view of a run that keeps generating, keeps calling write tools, and keeps
 * billing. `only-a-deliberate-stop.test.ts` is the source-level tripwire that keeps it that
 * way.
 *
 * `createStreamTrackingFetch` USED TO LIVE HERE and is gone with the detached transport. It
 * wrapped every POST to mark the channel as "being consumed by this browser context" for as
 * long as the response body was being read — the one signal that stopped the originating tab
 * from ALSO joining its own stream off the socket and rendering every token twice. Under
 * detached mode no tab reads a body: the sender's own send and the socket event both open the
 * same session, keyed by the same messageId, through an idempotent registry. The double-render
 * it guarded against is now impossible rather than prevented, so the mark, its refcounting
 * (`consumingChannels`), and the body-sniffing that scoped it to a conversation
 * (`extractConversationIdFromBody`) are all deleted rather than ported.
 */

import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { AbortCode } from '@/lib/ai/core/stream-abort-decisions';

/**
 * What the server says happened.
 *
 * `code` exists because `aborted: false` used to mean two entirely different things, and every
 * caller discarded it anyway (`void abortActiveStream(...)`) — so the button flipped back to Send
 * no matter what actually happened on the server:
 *
 *   - 'not_found'   — nothing was in flight. The stream finished a beat before Stop was pressed.
 *                     A BENIGN race. Must stay SILENT: it fires often, and a toast here would
 *                     train users to ignore the one below.
 *   - 'unconfirmed' — the stream was found, the abort was requested, and it is STILL GENERATING.
 *                     Still calling write tools. Still billing. The user must be told.
 *
 * Codes, not `reason` substrings. The old code sniffed for 'not found' / 'already completed' in a
 * prose string, which is a contract nobody can see they are breaking when they reword a log line.
 */
export interface AbortResult {
  aborted: boolean;
  code: AbortCode;
  reason: string;
}

/**
 * A failure to even reach the abort endpoint is not ambiguous: the server never heard the Stop, so
 * the generation is definitely still running, and still billing. That is exactly 'unconfirmed'.
 */
const NETWORK_FAILURE: AbortResult = {
  aborted: false,
  code: 'unconfirmed',
  reason: 'Failed to call abort endpoint',
};

const parseAbortResult = async (response: Response): Promise<AbortResult> => {
  const body = await response.json();

  if (!body || typeof body.code !== 'string') {
    // The endpoint answered with something we do not understand (an error envelope, a proxy page).
    // We cannot claim the stream stopped.
    return { aborted: false, code: 'unconfirmed', reason: 'Unrecognized abort response' };
  }

  return body as AbortResult;
};

/**
 * Surface an abort outcome to the user — and only when it is worth surfacing.
 *
 * Call this from USER-INITIATED Stop paths. It deliberately says nothing on 'not_found': the
 * stream had already finished, which is not something the user did wrong and not something they
 * can act on.
 */
export const reportAbortOutcome = (result: AbortResult): void => {
  reportAbortOutcomes([result]);
};

/**
 * The same, for a Stop that fires more than one abort (a surface that must name a stream under two
 * possible keys). One toast at most, however many of them come back unconfirmed — they are all the
 * same stream, and the user does not need to be told twice.
 */
export const reportAbortOutcomes = (results: readonly AbortResult[]): void => {
  if (!results.some((result) => result.code === 'unconfirmed')) return;

  toast.warning('Could not confirm the generation stopped', {
    description: 'It may still be running. Reload to see its current state.',
  });
};

// NO activeStreams chatId->streamId MAP (PR 5A, leaf 5.5.8).
//
// It existed so Stop could name a generation precisely. It could not:
//   - It was populated only once the response HEADERS landed. A real send spends 0.5-3s before
//     that, which is exactly when a user who spotted a typo hits Stop — the map was EMPTY.
//   - It was torn down by each surface's conversation-change cleanup, so a Stop after a
//     mid-stream switch was a map MISS.
//   - It was keyed by a transport-local chatId that surfaces had to keep unique by hand (hence
//     the sidebar's `sidebar:<convId>` namespace), and one surface's cleanup could delete
//     another's entry.
// In every one of those windows the abort silently no-op'd: the local fetch stopped, the button
// flipped back to Send, and the server — which deliberately survives client disconnect — kept
// generating, kept running write tools, and kept billing.
//
// Both replacements are names nobody has to maintain a map for: the assistant messageId (recorded
// in usePendingStreamsStore at stream_start, immune to the surface moving) and the conversationId
// captured at send. See decideStopAction.
/**
 * Abort by CONVERSATION — the only name the client holds from t=0.
 *
 * Both `streamId` and `messageId` are minted server-side, and the client does not learn either
 * until the response headers land. A real agent send spends 0.5-3 seconds before that (auth,
 * rate limit, DB reads, context assembly, connecting to the provider). Stop pressed in that
 * window — precisely when a user who has spotted a typo presses it — had NOTHING to name: the
 * `activeStreams` map was empty, the abort was a guaranteed no-op, the local fetch was cancelled,
 * and the button flipped back to Send.
 *
 * And cancelling the fetch stops nothing. Streams are deliberately server-owned and survive a
 * client disconnect — that is the whole architecture. So the generation kept running, kept
 * calling write tools, and kept BILLING, while the UI told the user it had stopped.
 *
 * This is the fallback that makes Stop always able to say something true. Server-side it only
 * ever stops the caller's OWN streams (see abort-conversation-streams.ts).
 */
export const abortActiveStreamByConversation = async ({
  conversationId,
}: {
  conversationId: string;
}): Promise<AbortResult> => {
  try {
    const response = await fetchWithAuth('/api/ai/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });
    return await parseAbortResult(response);
  } catch {
    return NETWORK_FAILURE;
  }
};

export const abortActiveStreamByMessageId = async ({
  messageId,
}: {
  messageId: string;
}): Promise<AbortResult> => {
  try {
    const response = await fetchWithAuth('/api/ai/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
    return await parseAbortResult(response);
  } catch {
    return NETWORK_FAILURE;
  }
};
