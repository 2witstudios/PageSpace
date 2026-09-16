'use client';

import { useDatabase, useObservableValues } from '@adobe/data-react';
import { chatStatePlugin } from '@/state/chat/chat-state-plugin';

const CONVERSATION_ID = 'spike-conversation';
const PAGE_ID = 'spike-page';

/**
 * SPIKE (@adobe/data adoption evidence) — React binding harness, binding half.
 *
 * Answers the "Next 15 App Router + React 19" spike question in the shape the
 * aidd-react skill prescribes: ONE `useObservableValues` call, no other React
 * context, actions passed as callbacks, no business logic in the component.
 *
 * SSR/hydration: `useObservable` seeds `useState(undefined)` and subscribes in
 * an effect, so the server render and the first client render both produce
 * `values === undefined` — the skeleton branch below. That makes hydration
 * mismatch structurally impossible for observable-derived markup, at the cost
 * of the first paint always being the skeleton (no server-rendered content for
 * this subtree). Any surface that needs server-rendered chat content must get
 * it from a prop/RSC payload, not from the Database.
 */
export const SpikeChatHarness = () => {
  const db = useDatabase(chatStatePlugin);
  const values = useObservableValues(() => ({
    entry: db.computed.conversationEntry(CONVERSATION_ID),
    streams: db.computed.pageStreams(PAGE_ID),
  }));

  if (!values) return <p data-testid="spike-skeleton">Loading chat state…</p>;

  return (
    <section>
      <p data-testid="spike-load-status">{values.entry.loadStatus}</p>
      <ul data-testid="spike-messages">
        {values.entry.messages.map((message) => (
          <li key={message.id}>{message.id}</li>
        ))}
      </ul>
      <ul data-testid="spike-optimistic">
        {values.entry.optimisticSends.map((message) => (
          <li key={message.id}>{message.id}</li>
        ))}
      </ul>
      <ul data-testid="spike-streams">
        {values.streams.map((stream) => (
          <li key={stream.messageId}>
            {stream.messageId}: {stream.parts.length}
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="spike-seed"
        onClick={() => db.transactions.seedConversation(CONVERSATION_ID)}
      >
        Seed conversation
      </button>
      <button
        type="button"
        data-testid="spike-send"
        onClick={() =>
          db.transactions.addOptimisticSend({
            conversationId: CONVERSATION_ID,
            message: { id: `m-${values.entry.optimisticSends.length + 1}`, role: 'user', parts: [] },
          })
        }
      >
        Optimistic send
      </button>
      <button
        type="button"
        data-testid="spike-stream"
        onClick={() =>
          db.transactions.addStream({
            messageId: `s-${values.streams.length + 1}`,
            pageId: PAGE_ID,
            conversationId: CONVERSATION_ID,
            triggeredBy: { userId: 'spike', displayName: 'Spike' },
            isOwn: true,
          })
        }
      >
        Start stream
      </button>
    </section>
  );
};
