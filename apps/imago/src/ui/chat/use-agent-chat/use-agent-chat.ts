'use client';

// One conversation with an agent, live: its stored messages (useConversationMessages)
// with the turn in flight composed on the end, a reply that grows frame by frame,
// send and stop.
//
// A send sets the `streaming` store resource to its conversation for as long as
// the reply streams; useConversationMessages pauses SWR for that conversation
// meanwhile, so no revalidation replaces the thread under the live reply. When
// the turn ends (finished, stopped or failed) the resource clears, and every
// mounted reader of the conversation reads it again (useConversationMessages);
// a stored message then stands in for the live one with its id, and a live one
// the server did not store (a stopped partial, say) stays.

import { useCallback, useMemo, useRef, useState } from 'react';
import { generateId } from 'ai';
import { useApiClient } from '@/api/swr-provider';
import { dispatch, transactions } from '@/ui/store/transactions';
import type { ChatMessage } from '../chat-model/chat';
import type { ContextRef } from '../chat-context/context-ref';
import { stopAgentTurn, streamAgentTurn, userTurnMessage } from '../chat-api/agent-turn';
import { browserSessionId } from '../chat-api/browser-session';
import { useConversationMessages } from '../use-chat-data/use-chat-data';

/** `submitted` until the reply's first frame, `streaming` after it, `ready` once it ends. */
export type AgentTurnStatus = 'ready' | 'submitted' | 'streaming' | 'error';

/** The prompt and the reply so far, until the stored thread carries them. */
type LiveTurn = {
  readonly conversationId: string;
  readonly prompt: ChatMessage;
  readonly reply: ChatMessage | null;
};

/** The turn being read: what Stop needs to name it, and the reader to let go of. */
type InFlight = {
  readonly conversationId: string;
  messageId: string | null;
  stopping: boolean;
  readonly reader: AbortController;
};

/** The stored thread, then whatever of the live turn it does not carry yet. */
const withLiveTurn = (stored: readonly ChatMessage[], turn: LiveTurn): readonly ChatMessage[] => {
  const storedIds = new Set(stored.map((message) => message.id));
  const live = [turn.prompt, ...(turn.reply === null ? [] : [turn.reply])].filter(
    (message) => !storedIds.has(message.id),
  );
  return live.length === 0 ? stored : [...stored, ...live];
};

export const useAgentChat = (
  agentId: string | null,
  conversationId: string | null,
  { contextRef }: { readonly contextRef: ContextRef },
) => {
  const client = useApiClient();
  const thread = useConversationMessages(agentId, conversationId);
  const [turn, setTurn] = useState<LiveTurn | null>(null);
  // The last turn's outcome, and the conversation it belongs to.
  const [outcome, setOutcome] = useState<{
    readonly conversationId: string | null;
    readonly status: AgentTurnStatus;
    readonly error: unknown;
  }>({ conversationId: null, status: 'ready', error: undefined });
  const inFlight = useRef<InFlight | null>(null);

  // Read when the turn is sent, which can be a render after send was made.
  const latest = useRef({ contextRef });
  latest.current = { contextRef };

  /**
   * Sends a prompt into this conversation, or into `into` (one the caller has
   * just created and is switching to). Answers whether the turn was taken: false
   * when nothing was sent or the server refused it before replying.
   */
  const send = useCallback(
    async (text: string, into?: string): Promise<boolean> => {
      const prompt = text.trim();
      const target = into ?? conversationId;
      if (prompt === '' || agentId === null || target === null || inFlight.current !== null) return false;
      const message = userTurnMessage(generateId(), prompt);
      const live: InFlight = { conversationId: target, messageId: null, stopping: false, reader: new AbortController() };
      inFlight.current = live;
      const report = (status: AgentTurnStatus, error?: unknown) =>
        setOutcome({ conversationId: target, status, error });
      setTurn({ conversationId: target, prompt: message, reply: null });
      report('submitted');
      dispatch(transactions.startStreaming, target);

      let replied = false;
      let failure: unknown = null;
      try {
        const replies = streamAgentTurn(
          client,
          { agentId, conversationId: target, message, contextRef: latest.current.contextRef },
          { browserSessionId: browserSessionId(), signal: live.reader.signal },
        );
        for await (const reply of replies) {
          replied = true;
          live.messageId = reply.id === '' ? null : reply.id;
          setTurn({ conversationId: target, prompt: message, reply });
          // Keeps a refused stop's error on screen while the reply goes on.
          setOutcome((current) => ({ ...current, conversationId: target, status: 'streaming' }));
        }
      } catch (caught) {
        // Letting go of the reader after a stop ends the read; that is not a failure.
        if (!live.reader.signal.aborted) failure = caught;
      } finally {
        inFlight.current = null;
        dispatch(transactions.endStreaming, target);
      }

      if (failure !== null && !replied) {
        // Refused before a reply began: nothing was said, so the prompt goes too.
        setTurn(null);
        report('error', failure);
        return false;
      }
      report(failure === null ? 'ready' : 'error', failure ?? undefined);
      return true;
    },
    [agentId, client, conversationId],
  );

  const stop = useCallback(async (): Promise<void> => {
    const live = inFlight.current;
    if (live === null || live.stopping) return;
    live.stopping = true;
    try {
      await stopAgentTurn(client, { conversationId: live.conversationId, messageId: live.messageId });
    } catch (caught) {
      // The generation may still be running; keep reading it, and say why Stop did not.
      live.stopping = false;
      setOutcome((current) => ({ ...current, error: caught }));
      return;
    }
    // The server has stopped the generation; stop reading whatever it still flushes.
    live.reader.abort();
  }, [client]);

  // A conversation created for this turn has no thread yet (its read waits
  // for the turn to end), so the live turn stands alone until it loads.
  const messages = useMemo(
    () =>
      turn === null || turn.conversationId !== conversationId
        ? thread.messages
        : withLiveTurn(thread.messages ?? [], turn),
    [conversationId, thread.messages, turn],
  );

  const own = outcome.conversationId !== null && outcome.conversationId === conversationId;
  return {
    messages,
    send,
    stop,
    /** This conversation's turn; `ready` while a turn streams into another one. */
    status: own ? outcome.status : 'ready',
    error: own ? outcome.error : undefined,
    hasOlder: thread.hasOlder,
    loadOlder: thread.loadOlder,
    revalidate: thread.revalidate,
    isLoading: thread.isLoading,
    isLoadingOlder: thread.isLoadingOlder,
    loadError: thread.error,
  };
};
