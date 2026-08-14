'use client';

/**
 * THE SEND SHELL — what replaces `useChat`, and why replacing it was the fix rather than a
 * rewrite for its own sake.
 *
 * ── THE CONSTRAINT ────────────────────────────────────────────────────────────────────────
 *
 * The AI SDK's `Chat` cannot consume two response bodies at once. A second `sendMessage`
 * while one streams overwrites `activeResponse` — the first stream's abort controller becomes
 * unreachable — and the two streams' interleaved writes corrupt the shared messages array.
 * Every surface passed a CONSTANT `useChat` id, so ONE `Chat` served every conversation on
 * that surface. Therefore: sending into conversation B while A streamed was illegal, and the
 * system's answer was `useConversationSendHandoff` — `stop()` the local read of A, wait for
 * the status to settle, and refuse the send outright ("The previous response is still
 * wrapping up") if it did not settle in 1.5s.
 *
 * That is the bug the user reported, stated as a design: you cannot send a message, open
 * another chat, send a second one, and trust the first completes.
 *
 * ── WHY NOT A PER-CONVERSATION Chat REGISTRY ──────────────────────────────────────────────
 *
 * Because it treats the symptom. `Chat`'s one-body limit is real and would still be there;
 * a registry just arranges for each conversation to have its own instance, and then owns a
 * new problem — instance lifetime, eviction, and which instance a mid-flight conversation
 * switch belongs to. Meanwhile `Chat` itself is no longer doing anything worth keeping.
 *
 * Store-first rendering already shipped: `selectRenderedMessages` / `useRenderedMessages` are
 * the renderer on every surface, and `GlobalAssistantView` says outright that useChat's
 * `messages` never renders. So `Chat` had been reduced to holding an array for
 * `addToolResult` and `sendAutomaticallyWhen` — and holding it BADLY, since that array is
 * empty after a reload, which is why `hydrateTransportBeforeReinvoke` existed to copy the
 * store's snapshot into it before every re-invocation.
 *
 * Own the array and the constraint disappears at the root: a send is a `fetch`, and a browser
 * can have as many of those in flight as it likes.
 *
 * ── HOW THIS SHELL AVOIDS INHERITING THE SAME BUG ─────────────────────────────────────────
 *
 * 1. NO INTERNAL MESSAGE ARRAY. `messages` is composed at read time from `getBaseMessages()`
 *    — the store's settled view — plus this session's local tool-result patches. So the base
 *    is correct immediately after a reload, with nothing to hydrate; answering an `ask_user`
 *    question from a persisted assistant message works because the persisted message IS the
 *    base. `hydrateTransportBeforeReinvoke` is deleted, not ported.
 *
 * 2. SEND STATE IS KEYED BY CONVERSATION. `sendsByConversation` tracks every in-flight send
 *    independently, so two can be live at once and neither can see the other. `status` and
 *    `error` report the CURRENT conversation's send, which is the only one the surface is
 *    showing. A send into a conversation the user has navigated away from keeps running and
 *    keeps writing to the store; it simply stops being this surface's status.
 *
 * 3. THE CONVERSATION IS AN ARGUMENT, NOT A LATCH. `useOwnStreamMirror` had to latch the
 *    conversation id on the rising edge of a send and hold it, because the surface's props
 *    wandered while the POST was in flight and the SDK would otherwise record the stream
 *    under wherever the user had got to. Here the id is passed to `sendMessage` and captured
 *    in its own closure. There is no rising edge to detect and no latch to release, so the
 *    whole class of "the latch named the wrong conversation" bugs has nowhere to live.
 *
 * 4. THERE IS NO `stop()`. Deliberately, and this is leaf 5's whole point. Aborting a local
 *    read stops NOTHING — streams are server-owned by design and survive client disconnect —
 *    so a `stop()` on this shell could only ever end the run's VISIBLE life while it kept
 *    generating and kept billing. The one real Stop goes through `useStopStream` to
 *    `/api/ai/abort`. `only-a-deliberate-stop.test.ts` enforces that nothing reintroduces a
 *    local one.
 */

import { useCallback, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { toErrorCause } from '@/lib/ai/shared/toErrorCause';
import { askUserAnswersComplete } from '@/lib/ai/shared/ask-user-client';
import { readLegacyStreamStart } from '@/lib/ai/core/legacy-stream-start';
import { readInlineReply } from '@/lib/ai/core/inline-reply';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { synthesizeAssistantMessage } from '@/lib/ai/streams/synthesizeAssistantMessage';
import {
  DETACHED_STREAM_ENABLED,
  STREAM_MODE_DETACHED,
  STREAM_MODE_HEADER,
  readAdmissionEnvelope,
} from '@/lib/ai/core/detached-stream-mode';
import { openStreamSession } from '@/lib/ai/streams/streamSessionRegistry';
import { ASK_USER_TOOL_NAME } from '@/lib/ai/tools/ask-user-tools';

/** The status vocabulary the surfaces already speak, kept so their branches do not churn. */
export type ChatSessionStatus = 'ready' | 'submitted' | 'streaming' | 'error';

export interface ChatSessionSendOptions {
  /** The per-request body (chatId / conversationId / provider / toggles). */
  body?: Record<string, unknown>;
}

export interface UseChatSessionOptions {
  /** POST endpoint for this surface. */
  api: string;
  /**
   * The socket room the server broadcasts this generation's lifecycle on.
   *
   * NOT interchangeable with `conversationId`: in agent mode the channel is the AGENT's page
   * id while the conversation is one of several on it.
   *
   * Read only on the LEGACY path. The admission envelope carries the authoritative channel for
   * a detached send; an old server's body does not, so the surface has to say. It is the
   * store's partition key, and a stream filed under a channel nothing watches is invisible.
   */
  channelId: string | null;
  /** The conversation currently on screen — what `status` and `error` report on. */
  conversationId: string | null;
  /** Identity for the optimistic store entry. `userId` is what `isOwnStream` compares. */
  triggeredBy: { userId: string; displayName: string };
  /**
   * The settled messages a send composes over, resolved BY CONVERSATION at call time.
   *
   * Takes the target conversation rather than closing over one, and that signature is
   * load-bearing. It began as `() => UIMessage[]` fed from a per-surface ref, and two of the
   * four surfaces never assigned their ref — so `getBaseMessages()` returned `[]` there
   * forever, every send carried no history, and `regenerate` re-sent nothing (review: codex
   * P1 on PR #2410). A parameterless getter makes the wiring a per-surface obligation that
   * compiles fine when forgotten; taking the id lets every surface pass the SAME shared
   * resolver, so there is nothing left to forget.
   *
   * Read at CALL time because it runs inside async continuations that outlive the render
   * which issued them — a captured array would be the one that existed when the send started,
   * which after a tool-result round trip is exactly the stale copy this shell exists to stop
   * sending.
   */
  getBaseMessages: (conversationId: string) => UIMessage[];
  onError?: (error: Error) => void;
}

export interface UseChatSessionResult {
  // NO `messages`. The shell holds no message array to hand back: the store is the renderer,
  // and outbound messages are composed per send from `getBaseMessages(conversationId)`. An
  // array here would be a second container to keep in sync with the store — which is the
  // thing this whole change removes.
  /** Fire a send for `conversationId`. Resolves when the send is ADMITTED, not when it ends. */
  sendMessage: (
    message: UIMessage,
    conversationId: string,
    options?: ChatSessionSendOptions,
  ) => Promise<void>;
  /** Re-run the last turn. Same admission semantics as `sendMessage`. */
  regenerate: (conversationId: string, options?: ChatSessionSendOptions) => Promise<void>;
  /** Record a client-side tool result and, when the turn is answerable, resume automatically. */
  addToolResult: (args: {
    tool: string;
    toolCallId: string;
    output: unknown;
    conversationId: string;
    options?: ChatSessionSendOptions;
  }) => Promise<void>;
  /** The current conversation's send state. */
  status: ChatSessionStatus;
  /** The current conversation's send error. */
  error: Error | undefined;
  clearError: () => void;
}

interface SendState {
  status: 'submitted' | 'error';
  error?: Error;
}

/**
 * A locally-applied tool result, waiting for the base message to catch up.
 *
 * Held until the store's settled view carries the answer itself (the server merges it into
 * the persisted assistant row), at which point the patch is redundant and composing it again
 * would be a no-op anyway. Keyed by toolCallId because that is what identifies the part.
 */
interface ToolPatch {
  toolCallId: string;
  output: unknown;
}

export const useChatSession = ({
  api,
  channelId,
  conversationId,
  triggeredBy,
  getBaseMessages,
  onError,
}: UseChatSessionOptions): UseChatSessionResult => {
  const [sends, setSends] = useState<Record<string, SendState>>({});
  const patchesRef = useRef<ToolPatch[]>([]);

  // Read inside async continuations, so refs — see `getBaseMessages`'s docblock for why a
  // captured value is the stale-copy bug rather than a style preference.
  const getBaseMessagesRef = useRef(getBaseMessages);
  getBaseMessagesRef.current = getBaseMessages;
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  const triggeredByRef = useRef(triggeredBy);
  triggeredByRef.current = triggeredBy;
  const apiRef = useRef(api);
  apiRef.current = api;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /** Compose a conversation's settled base with any local patches it does not yet reflect. */
  const composeMessages = useCallback((targetConversationId: string): UIMessage[] => {
    const base = getBaseMessagesRef.current(targetConversationId);
    const patches = patchesRef.current;
    if (patches.length === 0) return base;

    return base.map((message) => {
      if (message.role !== 'assistant') return message;
      let changed = false;
      const parts = message.parts.map((part) => {
        if (part.type !== `tool-${ASK_USER_TOOL_NAME}`) return part;
        const toolCallId = (part as { toolCallId?: unknown }).toolCallId;
        const patch = patches.find((candidate) => candidate.toolCallId === toolCallId);
        if (!patch) return part;
        changed = true;
        return { ...part, state: 'output-available', output: patch.output };
      });
      return changed ? { ...message, parts } : message;
    }) as UIMessage[];
  }, []);

  const setSendState = useCallback((id: string, state: SendState | null): void => {
    setSends((previous) => {
      if (state === null) {
        if (!(id in previous)) return previous;
        const next = { ...previous };
        delete next[id];
        return next;
      }
      return { ...previous, [id]: state };
    });
  }, []);

  /**
   * The one place a generation is started, whatever started it.
   *
   * Resolves once the send is ADMITTED — an envelope in hand and a session open, or the
   * legacy body read to completion. It deliberately does NOT resolve when the generation
   * ends: the generation outlives this call by design, and a caller awaiting its END would
   * reintroduce exactly the coupling between a send and a component that this whole change
   * removes.
   */
  const dispatch = useCallback(
    async (targetConversationId: string, body: Record<string, unknown>, messagesForRequest: UIMessage[]): Promise<void> => {
      setSendState(targetConversationId, { status: 'submitted' });

      const identity = triggeredByRef.current;
      const channel = channelIdRef.current;

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Browser-Session-Id': getBrowserSessionId(),
        };
        // Read ONCE at module scope — see `detached-stream-mode.ts`. A per-send read would
        // let one tab run half of each mode.
        if (DETACHED_STREAM_ENABLED) headers[STREAM_MODE_HEADER] = STREAM_MODE_DETACHED;

        const response = await fetchWithAuth(apiRef.current, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, messages: messagesForRequest }),
        });

        if (!response.ok) {
          // Read the body ONCE, here, where the status and the real JSON are both in hand,
          // and throw a typed cause rather than a bare Error built from a re-read.
          const payload = await response.clone().json().catch(() => undefined);
          const cause = toErrorCause(response.status, payload);
          throw new Error(cause.message, { cause });
        }

        const admission = await readAdmissionEnvelope(response);

        // EVERY outcome is handled, and two of the three used to fall off the end of an
        // `if/else if` into `setSendState(null)` — reporting a clean send that started no
        // generation and rendered nothing (review: coderabbitai on PR #2410). A send that
        // admitted nothing is a FAILED send, and the user must see that rather than a
        // composer that quietly clears.
        if (admission.kind === 'malformed') {
          // The server claimed an envelope and sent something else, so `response.json()` has
          // already consumed the body — there is no legacy stream left to fall back to even
          // if we wanted one.
          throw new Error(`Stream admission failed: ${admission.reason}`);
        }

        if (admission.kind === 'inline') {
          // A COMPLETE reply on the body, with nothing streaming behind it (the `/help`
          // short-circuit). No session: there is no channel to join, and subscribing to one
          // that does not exist is a 404 join, a fruitless poll, and an empty bubble over a
          // locked composer. The server already persisted it, so this commits what it is —
          // a finished assistant message. See `inline-reply.ts`.
          const reply = await readInlineReply(response);
          if (!reply) {
            throw new Error(
              'Stream admission failed: the server sent an inline reply that never named its message',
            );
          }
          // Promote first, so the question can never render below its own answer — the same
          // ordering `commitConfirmedReply` documents for the streamed path.
          conversationMessagesActions.promoteOptimisticSends(targetConversationId);
          conversationMessagesActions.applyConfirmedMessage(
            targetConversationId,
            synthesizeAssistantMessage(reply.messageId, reply.parts, undefined, 'complete'),
          );
        } else if (admission.kind === 'detached') {
          // The generation is already running and already recording; this opens the one
          // subscription that will follow it, owned by the module rather than by whatever
          // component happens to be mounted. The messageId comes from the envelope and is
          // never inferred from a frame.
          openStreamSession({
            messageId: admission.envelope.messageId,
            conversationId: admission.envelope.conversationId,
            channelId: admission.envelope.channelId,
            triggeredBy: identity,
            isOwn: true,
            startedAt: admission.envelope.startedAt,
          });
        } else {
          // ── OLD SERVER: LEARN THE messageId, ANNOUNCE, THEN RELEASE THE BODY ───────────
          //
          // Not the whole body and not none of it — see `readLegacyStreamStart`, which records
          // why each extreme is wrong (a second writer racing the socket's join, versus a
          // window where the send has resolved and nothing is on screen).
          //
          // Announcing here rather than waiting for `chat:stream_start` is what keeps the
          // send-to-stream handoff an OVERLAP instead of a gap: `useSendHandoff` releases its
          // pendingSend when the store entry appears, and that entry now exists before this
          // send resolves. The socket event still arrives and is a no-op — `openStreamSession`
          // is idempotent per messageId.
          if (!channel) {
            // The store partitions by channel, so a stream with no channel could be admitted
            // but never rendered. A surface reaching here is misconfigured.
            throw new Error(
              'Stream admission failed: the server streamed a body but this surface has no channel to render it on',
            );
          }
          const messageId = await readLegacyStreamStart(response);
          if (!messageId) {
            // The body ended (or errored) without ever naming the message. Nothing was
            // admitted, so this is a failed send — not a completed empty reply.
            throw new Error(
              'Stream admission failed: the server streamed a body that never named its message',
            );
          }
          openStreamSession({
            messageId,
            conversationId: targetConversationId,
            channelId: channel,
            triggeredBy: identity,
            isOwn: true,
            startedAt: new Date().toISOString(),
          });
        }

        setSendState(targetConversationId, null);
      } catch (error) {
        const asError = error instanceof Error ? error : new Error(String(error));
        setSendState(targetConversationId, { status: 'error', error: asError });
        onErrorRef.current?.(asError);
        throw asError;
      }
    },
    [setSendState],
  );

  const sendMessage = useCallback(
    async (
      message: UIMessage,
      targetConversationId: string,
      options?: ChatSessionSendOptions,
    ): Promise<void> => {
      // A fresh user turn settles every outstanding local patch: the server has merged the
      // answers into the persisted row by now, and carrying them forward would re-apply them
      // over whatever the reload returns.
      patchesRef.current = [];
      const outbound = [...getBaseMessagesRef.current(targetConversationId), message];
      await dispatch(targetConversationId, { ...(options?.body ?? {}) }, outbound);
    },
    [dispatch],
  );

  const regenerate = useCallback(
    async (targetConversationId: string, options?: ChatSessionSendOptions): Promise<void> => {
      // The base IS the settled store view, so a regenerate after a reload re-sends real
      // history rather than an empty transport array — the failure
      // `hydrateTransportBeforeReinvoke` was invented to patch around, absent by construction.
      await dispatch(
        targetConversationId,
        { ...(options?.body ?? {}) },
        getBaseMessagesRef.current(targetConversationId),
      );
    },
    [dispatch],
  );

  const addToolResult = useCallback(
    async ({
      toolCallId,
      output,
      conversationId: targetConversationId,
      options,
    }: {
      tool: string;
      toolCallId: string;
      output: unknown;
      conversationId: string;
      options?: ChatSessionSendOptions;
    }): Promise<void> => {
      patchesRef.current = [
        ...patchesRef.current.filter((patch) => patch.toolCallId !== toolCallId),
        { toolCallId, output },
      ];

      const patched = composeMessages(targetConversationId);

      // Resume ONLY when every ask_user question on the last assistant message is answered —
      // the same predicate the SDK's `sendAutomaticallyWhen` ran, now explicit. It is not the
      // stock `lastAssistantMessageIsCompleteWithToolCalls`, because every PageSpace turn ends
      // with the executed `finish` tool and that helper would loop forever.
      if (!askUserAnswersComplete({ messages: patched })) return;

      await dispatch(targetConversationId, { ...(options?.body ?? {}) }, patched);
    },
    [composeMessages, dispatch],
  );

  const currentSend = conversationId ? sends[conversationId] : undefined;

  const clearError = useCallback(() => {
    if (!conversationId) return;
    setSendState(conversationId, null);
  }, [conversationId, setSendState]);

  return {
    sendMessage,
    regenerate,
    addToolResult,
    status: currentSend?.status ?? 'ready',
    error: currentSend?.error,
    clearError,
  };
};
