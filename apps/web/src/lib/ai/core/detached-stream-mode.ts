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
 *     `text/event-stream` as it always did. `readAdmissionEnvelope` reports `kind: 'legacy'`
 *     for any response that is not the JSON envelope — and, crucially, without having touched
 *     the body — so the caller can still read it. It reads only as far as the `start` frame, to
 *     learn the messageId the envelope would otherwise have stated, and then releases the body
 *     to the socket-driven registry (see `legacy-stream-start.ts` for why not more and not
 *     less). This is what makes the client safe to deploy FIRST.
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

/** Request value: the client can consume a receipt instead of a body. */
export const STREAM_MODE_DETACHED = 'detached';

/**
 * RESPONSE value: this body IS the whole reply, and nothing is streaming behind it.
 *
 * The `/help` short-circuit returns one. It answers from code with no model call, so it builds
 * no stream lifecycle, opens no channel, inserts no `ai_stream_sessions` row and broadcasts no
 * `chat:stream_start` — a decision `page-chat-turn.ts` makes deliberately, because replicating
 * the live-stream protocol for an already-complete synthetic reply risks destabilising it for
 * every other conversation.
 *
 * Without this marker that response is INDISTINGUISHABLE from an old server's streamed body,
 * and the client guesses wrong in a way it cannot recover from: it reads to the `start` frame,
 * cancels — discarding the entire answer — and subscribes to a channel that does not exist. The
 * join 404s, the poll finds no row, and the user watches an empty bubble with a locked composer
 * for two round trips before a reload flip. The reply is only "not lost" because the server
 * persisted it before responding.
 *
 * So the server says which it is. A client cannot infer it.
 */
export const STREAM_MODE_INLINE = 'inline';

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
 * What a response turned out to be — and, critically, whether its body is still readable.
 *
 * A plain `StreamAdmissionEnvelope | null` was WRONG here, and the reason is worth stating
 * because it is the kind of thing a nullable return hides by construction. Null conflated two
 * outcomes with opposite handling:
 *
 *   - an untouched SSE body from an old server, which the caller MUST read; and
 *   - a response that claimed to be an envelope and was not — where `response.json()` has
 *     already consumed the body, so reading it again throws `TypeError: Invalid state:
 *     ReadableStream is locked`, or (worse) silently succeeds at nothing when the caller has
 *     no channel to fall back onto.
 *
 * Discriminating them makes the difference impossible to miss (review: coderabbitai on PR
 * #2410).
 */
export type AdmissionRead =
  | { kind: 'detached'; envelope: StreamAdmissionEnvelope }
  /**
   * The body is the COMPLETE reply and nothing is streaming behind it — read it to the end and
   * commit it as a finished message. No session, because there is nothing to subscribe to.
   */
  | { kind: 'inline' }
  /**
   * Not an envelope, and the body was never touched.
   *
   * The caller reads it only far enough to learn the server-issued messageId from the `start`
   * frame, then cancels — reading it to completion would make the tab a second writer racing
   * the socket's own join. See `legacy-stream-start.ts`.
   */
  | { kind: 'legacy' }
  /** Claimed to be an envelope and was not. The body is spent; this send has failed. */
  | { kind: 'malformed'; reason: string };

/**
 * Classify a response from the send endpoint.
 *
 * Does NOT touch the body unless the content type claims an envelope, so `kind: 'legacy'`
 * always means "still readable" — that guarantee is what the caller's fallback rests on.
 */
export const readAdmissionEnvelope = async (response: Response): Promise<AdmissionRead> => {
  // Checked BEFORE the content type: an inline reply is also `text/event-stream`, so the only
  // thing separating it from an old server's streamed body is this header.
  if (response.headers.get(STREAM_MODE_HEADER)?.trim().toLowerCase() === STREAM_MODE_INLINE) {
    return { kind: 'inline' };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes(ADMISSION_ENVELOPE_CONTENT_TYPE)) return { kind: 'legacy' };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { kind: 'malformed', reason: 'admission envelope was not valid JSON' };
  }

  const envelope = parseAdmissionEnvelope(parsed);
  if (!envelope) {
    return { kind: 'malformed', reason: 'admission envelope was missing a required field' };
  }
  return { kind: 'detached', envelope };
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
 * Opt-OUT rather than opt-in: the default has to be the new behaviour or the change never
 * actually ships. `'0'` and `'false'` are both accepted because operators write both.
 *
 * BUILD-TIME, NOT RUNTIME. `NEXT_PUBLIC_*` is inlined into the client bundle at build time, so
 * flipping this needs a rebuild and redeploy — it is NOT a hot kill switch, and an earlier
 * version of this comment wrongly sold it as one ("fall back without a rollback", which would
 * in fact be more work than the rollback). What it is good for is pinning a build to the
 * socket-driven path deliberately.
 *
 * Turning it off routes every send down the legacy branch: the shell reads the response only
 * as far as its `start` frame, announces the session itself from that messageId, and cancels.
 * Rendering is then identical to the detached path — one registry subscription, announced by
 * the send rather than by an envelope — so the mode is a genuine fallback rather than a
 * degraded one.
 */
const detachedDisabled = (process.env.NEXT_PUBLIC_DETACHED_STREAMS ?? '').trim().toLowerCase();
export const DETACHED_STREAM_ENABLED =
  detachedDisabled !== '0' && detachedDisabled !== 'false';
