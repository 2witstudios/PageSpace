// One agent turn through apps/web's page-agent pipeline: POST /api/ai/chat
// streams the reply back as the AI SDK UI message stream, and POST
// /api/ai/abort stops it.
//
// Imago reads the response body itself (no X-Stream-Mode header, so the
// server answers with the stream rather than a detached-mode receipt). The
// server loads the conversation's history from its own store and reads only
// the new message from `messages`, so a turn sends that one message, in
// `parts`. Imago never calls /api/ai/global/* (DEC-3).
//
// Stopping is the server's job: a stream is server-owned and survives its
// reader going away, so cancelling the fetch alone would hide a reply that
// keeps generating. /api/ai/abort is the stop.

import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, type UIMessage, type UIMessageChunk } from 'ai';
import type { ApiClient } from '@/api/client';
import { ApiError, INVALID_RESPONSE } from '@/api/errors';
import type { ContextRef } from '../chat-context/context-ref';
import { chatPaths } from './chat-api';

/** apps/web's per-tab id header, required on every turn (browser-session-id-validation.ts). */
export const BROWSER_SESSION_HEADER = 'X-Browser-Session-Id';

export type AgentTurn = {
  /** The agent's AI_CHAT page: the body's `chatId`. */
  readonly agentId: string;
  readonly conversationId: string;
  /** The new user message. */
  readonly message: UIMessage;
  readonly contextRef: ContextRef;
};

/** A prompt as a user message, in the `parts` structure. */
export const userTurnMessage = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

/** The POST /api/ai/chat body for a turn. */
export const agentTurnBody = ({ agentId, conversationId, message, contextRef }: AgentTurn) => ({
  chatId: agentId,
  conversationId,
  messages: [message],
  contextRef,
});

/** The SSE body as UI message chunks; a frame that fails the schema fails the stream. */
const uiMessageChunks = (body: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> =>
  parseJsonEventStream({ stream: body, schema: uiMessageChunkSchema }).pipeThrough(
    new TransformStream({
      transform(parsed, controller) {
        if (!parsed.success) throw parsed.error;
        controller.enqueue(parsed.value);
      },
    }),
  );

/**
 * Sends a turn and yields the assistant reply as it grows: one snapshot per
 * frame, its id the server's (from the `start` frame), text and tool parts as
 * they arrive. Ends with the stream; rejects with the server's ApiError when
 * the turn is refused, or with the error text of an `error` frame.
 */
export async function* streamAgentTurn(
  client: ApiClient,
  turn: AgentTurn,
  { browserSessionId, signal }: { readonly browserSessionId: string; readonly signal?: AbortSignal },
): AsyncGenerator<UIMessage, void, undefined> {
  const response = await client.apiStream(chatPaths.turn, {
    method: 'POST',
    json: agentTurnBody(turn),
    headers: { Accept: 'text/event-stream', [BROWSER_SESSION_HEADER]: browserSessionId },
    signal,
  });
  if (response.body === null) {
    throw new ApiError({ status: response.status, code: INVALID_RESPONSE, message: 'The turn streamed no body' });
  }
  yield* readUIMessageStream({ stream: uiMessageChunks(response.body), terminateOnError: true });
}

/** What /api/ai/abort answers (abortStreamAnywhere's result). */
export type StopTurnResult = {
  readonly aborted: boolean;
  readonly code?: string;
  readonly reason?: string;
};

/**
 * Stops a turn server-side. The conversation id names it from the moment of
 * sending; the reply's id, once the `start` frame named it, names it exactly.
 */
export const stopAgentTurn = (
  client: ApiClient,
  { conversationId, messageId }: { readonly conversationId: string; readonly messageId: string | null },
): Promise<StopTurnResult> =>
  client.apiFetch<StopTurnResult>(chatPaths.abort, {
    method: 'POST',
    json: messageId === null ? { conversationId } : { conversationId, messageId },
  });
