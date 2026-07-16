'use client';

import React, { useMemo } from 'react';
import { useEditingStore } from '@/stores/useEditingStore';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { useStreamingRegistration } from '@/lib/ai/shared';
import { deriveStreamingRegistrations } from '@/lib/ai/streams/deriveStreamingRegistrations';

/** Only ever used to ask `deriveStreamingRegistrations` for the streams half on its own. */
const NO_PENDING_SENDS: ReadonlySet<string> = new Set();

/** U+001F (unit separator) — cannot occur in a cuid, so a joined key is unambiguous. */
const SEP = '\u001F';

/**
 * One editing-store session for one live conversation. Rendered only while that conversation is
 * live, so React's own unmount gives us the falling edge: when the conversation leaves the
 * derived set, this unmounts and `useStreamingRegistration`'s cleanup ends the session. No manual
 * diffing, and no way for the two to disagree.
 */
const StreamingRegistration: React.FC<{ conversationId: string }> = ({ conversationId }) => {
  useStreamingRegistration(`ai-stream-${conversationId}`, true, {
    conversationId,
    componentName: 'GlobalChatProvider',
  });
  return null;
};

/**
 * THE editing-store streaming registration for the whole app (PR 5A, leaf 5.7).
 *
 * Rendered ONCE, by GlobalChatProvider — which wraps the entire Layout, so every chat surface
 * lives inside it. Replaces five independent mount sites: GlobalChatContext's 'global-chat',
 * GlobalAssistantView's 'global-assistant-*', SidebarChatTab's 'assistant-sidebar-*',
 * useAgentChannelMultiplayer's 'ai-channel-*' (which ORed a local flag with a dashboard-store
 * flag), and AiChatView's 'ai-chat-*'.
 *
 * THE CONTRACT (repo CLAUDE.md): a streaming registration gates SWR revalidation AND auth-token
 * refresh, and must be continuous from the send click through the stream's end. The old sites
 * derived it from useChat's status, which is IDLE for a bootstrapped stream after a refresh — so
 * the window a replayed stream most needed protection in was the window every surface declared
 * itself not streaming. `deriveStreamingRegistrations` reads pendingSends + live store entries
 * instead, and knows about streams no surface is even showing.
 *
 * WHY ONE MOUNT AND NOT FIVE CONVERSATION-KEYED ONES. The registration must be keyed by
 * conversation, or co-mounted surfaces (GlobalAssistantView and SidebarChatTab are co-mounted
 * everywhere after one dashboard visit) each hold a session for the same stream. But
 * conversation-keyed registrations mounted PER SURFACE are worse than either: both surfaces write
 * the same id, so whichever unmounts first ends a session the other still needs — silently
 * dropping SWR protection from a stream that is still live on screen. Deriving the whole set in
 * one always-mounted place removes the question.
 *
 * WHY IT DOESN'T RE-RENDER PER TOKEN. This sits at the provider level, so subscribing to the
 * streams Map itself would re-render the app subtree on every chunk. It subscribes to a joined
 * STRING of the conversations that have live streams, which changes only when a stream starts or
 * ends. (It renders null, but its parent's children would still reconcile.)
 */
export const DerivedStreamingRegistrations: React.FC = () => {
  const pendingSends = useEditingStore((state) => state.pendingSends);
  const liveStreamKey = usePendingStreamsStore((state) =>
    deriveStreamingRegistrations({ pendingSends: NO_PENDING_SENDS, streams: state.streams }).join(SEP),
  );

  // `getState()` rather than subscribing to the Map: `liveStreamKey` is what decides when this
  // needs recomputing, and during render getState() is the same committed state that key was
  // derived from. This is the facade module, so the reach-in stays here rather than in a consumer.
  const conversationIds = useMemo(
    () =>
      deriveStreamingRegistrations({
        pendingSends,
        streams: usePendingStreamsStore.getState().streams,
      }),
    // `liveStreamKey` looks unnecessary to the linter because the memo body reads the streams Map
    // through getState() rather than closing over it. It is the opposite of unnecessary: it is the
    // ONLY thing that tells this memo the Map changed. Removing it would freeze the derived set at
    // whatever pendingSends last saw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingSends, liveStreamKey],
  );

  return (
    <>
      {conversationIds.map((conversationId) => (
        <StreamingRegistration key={conversationId} conversationId={conversationId} />
      ))}
    </>
  );
};
