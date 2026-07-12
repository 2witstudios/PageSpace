import { useRef } from 'react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { createStreamTrackingFetch } from '@/lib/ai/core/client';

/**
 * Creates a stable DefaultChatTransport instance that only recreates when
 * the conversation ID, API endpoint or channel changes. Avoids unnecessary
 * useChat state resets caused by new transport identity.
 *
 * `channelId` is the socket room the server broadcasts this stream's lifecycle
 * on — the same id the surface passes to `useChannelStreamSocket`. It is NOT
 * interchangeable with `conversationId` (SidebarChatTab's transport key is
 * `sidebar:<convId>`; GlobalChatContext's is the conversation id itself), so it
 * has to be supplied explicitly. Every POST through this transport marks the
 * channel as "being consumed by this browser context" for as long as it is
 * reading the response body, which is what stops the originating tab from
 * double-rendering its own stream off the socket. See `consumingChannels.ts`.
 *
 * Returns null when conversationId is null (no active conversation).
 */
export function useChatTransport(
  conversationId: string | null,
  api: string,
  channelId?: string,
): DefaultChatTransport<UIMessage> | null {
  const transportRef = useRef<DefaultChatTransport<UIMessage> | null>(null);
  const apiRef = useRef<string>(api);

  // The tracking keys are held in refs and read at FETCH time, because the transport this
  // fetch lives in is effectively immortal: useChat only rebuilds its `Chat` when its `id`
  // changes, every caller passes a constant id, and `Chat` binds its transport once in the
  // constructor. So a transport rebuilt here on a conversation switch is constructed and
  // thrown away — the FIRST one keeps serving every POST for the life of the surface.
  //
  // Recreating the transport was therefore not just useless, it was actively misleading: it
  // looked like the keys were being refreshed when nothing downstream ever picked them up.
  // Build it once; let the keys follow the surface through the refs.
  const chatIdRef = useRef<string | null>(conversationId);
  const channelIdRef = useRef<string | undefined>(channelId);
  chatIdRef.current = conversationId;
  channelIdRef.current = channelId;

  if (!conversationId) {
    return null;
  }

  // `api` still forces a rebuild: a genuinely different endpoint is a different transport, and
  // on the surfaces where the URL carries the conversation id the server already compensates
  // for the same freeze (see /api/ai/global/[id]/messages).
  if (apiRef.current !== api || !transportRef.current) {
    transportRef.current = new DefaultChatTransport({
      api,
      fetch: createStreamTrackingFetch({
        getChatId: () => chatIdRef.current,
        getChannelId: () => channelIdRef.current,
      }),
    });
    apiRef.current = api;
  }

  return transportRef.current;
}
