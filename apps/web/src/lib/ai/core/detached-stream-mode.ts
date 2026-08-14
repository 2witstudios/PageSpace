/**
 * THE DETACHED-TRANSPORT CONTRACT — the wire agreement that lets a send stop owning a
 * response body.
 *
 * WHAT IT REPLACES. A generation used to be delivered on the HTTP response body of the POST
 * that started it. That body has exactly one reader, and the AI SDK's `Chat` can only hold
 * one at a time — so a second send while one streamed overwrote `activeResponse` and
 * corrupted the shared messages array. Every surface passes a CONSTANT `useChat` id, so one
 * `Chat` served every conversation on that surface, and the only way to send into a second
 * conversation was to stop reading the first. That was `useConversationSendHandoff`: a
 * `stop()` on every cross-conversation send, and a refusal toast when the status would not
 * settle in time.
 *
 * Detached mode removes the constraint at its root rather than scheduling around it. The
 * POST answers with an ADMISSION ENVELOPE — a small JSON object naming the generation that
 * was just admitted — and the client subscribes to the seq-addressed channel for it. A
 * subscription is not a body: there can be as many as there are live streams, and none of
 * them is coupled to the request that started it. The pump was already the sole reader of
 * the SDK stream (PR #2408), so nothing about capture changes; what changes is that the
 * response stops being subscriber #0 and becomes a receipt.
 *
 * ── THE messageId IS THE ENVELOPE'S JOB, AND THAT IS THE SHARPEST POINT HERE ──────────────
 *
 * The SDK's `start` chunk carries the server-issued assistant message id, and `Chat` adopts
 * it (`sdkServerIdAdoption.test.ts` pins this). On a MID-SEQ join — a reconnect, a rejoin
 * after a reload, a resume from a `resumeFromSeq` reseed — that frame is BEHIND the cursor
 * and will never be delivered. A client that infers the id from frame content therefore gets
 * nothing, invents one, and renders a second assistant bubble beside the real reply.
 *
 * So the id is never inferred. It is stated, once, in the envelope, before a single frame is
 * read, and it is the same value on a fresh join and on a resume. `synthesizeStartChunk`
 * below exists so a mid-seq subscriber can manufacture the `start` frame it missed from the
 * envelope it already holds, rather than from a frame it will never see.
 *
 * ── ROLLING-DEPLOY SAFETY, BOTH DIRECTIONS ────────────────────────────────────────────────
 *
 * Web and client ship independently and a deploy is never atomic, so both mixed pairs have
 * to work:
 *
 *   - NEW CLIENT, OLD SERVER. The old server does not know the header and answers
 *     `text/event-stream` as it always did. `readAdmissionEnvelope` returns null on any
 *     response that is not the JSON envelope, and the caller falls through to reading the
 *     body — i.e. exactly the legacy path. This is what makes the client safe to deploy
 *     FIRST.
 *   - OLD CLIENT, NEW SERVER. The old client sends no `X-Stream-Mode`, so
 *     `wantsDetachedStream` is false and the server keeps streaming the body. An old tab
 *     left open across a deploy is unaffected.
 *
 * ── WHY THE FLAG IS READ ONCE, AT MODULE SCOPE ────────────────────────────────────────────
 *
 * `DETACHED_STREAM_ENABLED` is evaluated at import and never re-read. A tab must be entirely
 * on one side of this change or entirely on the other: half a tab detached and half of it
 * body-reading would mean one conversation's stream owned a body while another's did not,
 * and the send path would have to reason about both at once — which is the state this whole
 * change exists to leave. Reading it per-send would also let a hot-reload or a config push
 * flip the mode mid-session, between a POST and the join it implies.
 */

import type { UIMessageChunk } from 'ai';

/**
 * Asks the server to admit the generation and answer with a receipt instead of a body.
 *
 * A REQUEST header, not a response one: the client states what it can consume, the server
 * decides. That direction matters for the old-client case — a server that unilaterally
 * switched to envelopes would break every tab that had not reloaded yet.
 */
export const STREAM_MODE_HEADER = 'X-Stream-Mode';

/** The only value `STREAM_MODE_HEADER` carries today. Anything else means "stream the body". */
export const STREAM_MODE_DETACHED = 'detached';

/**
 * Content type of the admission envelope.
 *
 * Distinct from `application/json` so it can never be confused with an ERROR body, which is
 * also JSON. A client that treated any JSON response as an envelope would read a 500's
 * `{ error }` payload as an admission and then subscribe to a stream that does not exist,
 * hanging on a join that 404s forever instead of surfacing the error. The status check comes
 * first regardless; this is the second lock on the same door.
 */
export const ADMISSION_ENVELOPE_CONTENT_TYPE = 'application/vnd.pagespace.stream-admission+json';

/**
 * What the server hands back when it admits a detached generation.
 *
 * Everything here is knowable BEFORE the first frame, which is the whole point — the client
 * must be able to open a store entry, render a bubble, and arm a Stop button without having
 * read anything off the channel.
 */
export interface StreamAdmissionEnvelope {
  mode: typeof STREAM_MODE_DETACHED;
  /**
   * The server-issued assistant message id — the channel's address, the store key, and the
   * name Stop uses. Stated here so no subscriber ever infers it from frame content; see the
   * module docblock for the two-bubble bug that inference causes on a mid-seq join.
   */
  messageId: string;
  /** The conversation this generation answers into. */
  conversationId: string;
  /** The socket room its lifecycle broadcasts on (a page id, or the user's global channel). */
  channelId: string;
  /** The abort registry's key, echoed so a Stop can name the generation cross-instance. */
  streamId: string;
  /** ISO start time, so a synthesized bubble carries a real `createdAt` and can be expired. */
  startedAt: string;
}

/**
 * Does this request want a receipt rather than a body?
 *
 * Case-insensitive on the VALUE because header values survive proxies unpredictably; the
 * name lookup is already case-insensitive via `Headers`.
 */
export const wantsDetachedStream = (headers: Headers): boolean =>
  headers.get(STREAM_MODE_HEADER)?.trim().toLowerCase() === STREAM_MODE_DETACHED;

/**
 * Is this response an admission envelope, and if so, what does it say?
 *
 * Returns null for ANYTHING else — an SSE body from an old server, an error, a proxy's HTML
 * interstitial, a JSON object missing a field. Null is the caller's instruction to fall
 * through to the legacy body path, so being strict here is what makes the fallback safe:
 * a half-parsed envelope would send the client off to join a stream nobody admitted.
 *
 * Does NOT consume the response body unless the content type matches, so the caller can
 * still read it as a stream on the null path.
 */
export const readAdmissionEnvelope = async (
  response: Response,
): Promise<StreamAdmissionEnvelope | null> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes(ADMISSION_ENVELOPE_CONTENT_TYPE)) return null;

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    // The server claimed an envelope and sent something unparseable. Treating this as
    // "legacy body" is wrong (the body is spent) and treating it as an envelope is worse.
    // Null, and the caller reports a failed send — which is the truth.
    return null;
  }

  return parseAdmissionEnvelope(parsed);
};

/**
 * The envelope's shape check, split out so it can be exercised directly.
 *
 * Every field is required. An envelope missing `messageId` is not a degraded envelope, it is
 * an unusable one: the client would have nothing to subscribe to, nothing to key the store
 * on, and nothing for Stop to name.
 */
export const parseAdmissionEnvelope = (value: unknown): StreamAdmissionEnvelope | null => {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== STREAM_MODE_DETACHED) return null;

  const stringField = (key: string): string | null => {
    const field = candidate[key];
    return typeof field === 'string' && field.length > 0 ? field : null;
  };

  const messageId = stringField('messageId');
  const conversationId = stringField('conversationId');
  const channelId = stringField('channelId');
  const streamId = stringField('streamId');
  const startedAt = stringField('startedAt');

  if (!messageId || !conversationId || !channelId || !streamId || !startedAt) return null;

  return {
    mode: STREAM_MODE_DETACHED,
    messageId,
    conversationId,
    channelId,
    streamId,
    startedAt,
  };
};

/**
 * The `start` frame a mid-seq subscriber missed, rebuilt from the envelope.
 *
 * The SDK's reduction expects a stream to open with `start`; it is what carries the
 * assistant message id, and everything downstream keys on it. A subscriber joining at
 * `fromSeq > 0` is past that frame forever, so it synthesizes the one it knows must have
 * been there — from the ENVELOPE, whose `messageId` is by construction the same id the real
 * `start` carried, because both come from the lifecycle's `messageId`.
 *
 * Deliberately takes the envelope rather than a bare id: the point of this function is that
 * the id has an authoritative source, and accepting a loose string would let a caller pass
 * one it guessed from a frame — the exact thing this exists to prevent.
 */
export const synthesizeStartChunk = (envelope: StreamAdmissionEnvelope): UIMessageChunk =>
  ({ type: 'start', messageId: envelope.messageId }) as UIMessageChunk;

/**
 * Whether this build asks for detached streams. Read ONCE — see the module docblock.
 *
 * Opt-OUT rather than opt-in. The legacy body path is the thing being removed, so the
 * default has to be the new behaviour or the change never actually ships; the escape hatch
 * exists so a deployment that hits an unforeseen proxy problem can fall back without a
 * rollback. `'0'` and `'false'` are both accepted because operators write both.
 */
const detachedDisabled = (process.env.NEXT_PUBLIC_DETACHED_STREAMS ?? '').trim().toLowerCase();
export const DETACHED_STREAM_ENABLED =
  detachedDisabled !== '0' && detachedDisabled !== 'false';
