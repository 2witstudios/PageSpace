'use client';

/**
 * useAssistantSessionChat — `useAgentSessionChat`'s sibling for the GLOBAL
 * ASSISTANT: one assistant conversation (a `type: 'global'` row) inside an
 * agent session's pane.
 *
 * A sibling, not a parameter, because the assistant runs on the OTHER chat
 * pipeline end to end — the same five substitutions everywhere, stated once:
 *
 * | concern            | agent                          | assistant                                  |
 * |--------------------|--------------------------------|--------------------------------------------|
 * | stream channel     | the agent's page id            | `globalChannelId(userId)`                  |
 * | endpoint           | `/api/ai/chat`                 | `/api/ai/global/[conversationId]/messages` |
 * | message loader     | `loadAgentConversationMessages`| `loadGlobalConversationMessages`           |
 * | request body       | `buildSessionChatRequestBody`  | `buildGlobalChatRequestBody`               |
 * | channel socket     | `useAgentChannelMultiplayer`   | none HERE — `GlobalChatProvider` (app-wide)|
 * |                    | (per-agent, mounted per hook)  | already subscribes this user's channel     |
 *
 * Identity (model/provider) comes from `useAssistantSettingsStore` — the same
 * source every assistant surface reads — not from an agent page, because there
 * is no agent page (that absence is what `agentPageId: null` means).
 *
 * Returns the exact `UseAgentSessionChatReturn` shape so the one presentation
 * (`SessionChatView`) renders either without knowing which pipeline it's on.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePathname } from 'next/navigation';
import type { UIMessage } from 'ai';
import { useChat } from '@ai-sdk/react';
import { toast } from 'sonner';
import { createId } from '@paralleldrive/cuid2';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import {
  useChatTransport,
  useCacheMessageActions,
  useSendHandoff,
  useConversationSendHandoff,
  HANDOFF_REFUSED_MESSAGE,
  useChatErrorCause,
  buildChatConfig,
  buildGlobalChatRequestBody,
} from '@/lib/ai/shared';
import { buildContextRef } from '@/lib/ai/shared/buildContextRef';
import { buildUserMessage } from '@/lib/ai/streams/buildUserMessage';
import { rollbackOptimisticSendOnFailure } from '@/lib/ai/streams/rollbackOptimisticSendOnFailure';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import {
  loadGlobalConversationMessages,
  loadOlderGlobalConversationMessages,
} from '@/hooks/conversationMessagesLoaders';
import {
  useRenderedMessages,
  useConversationLoadState,
  useConversationOlderPageState,
} from '@/hooks/useRenderedMessages';
import { useActiveStream, useConversationActiveStream } from '@/hooks/useActiveStream';
import { useOwnStreamMirror } from '@/hooks/useOwnStreamMirror';
import { useStopStream } from '@/hooks/useStopStream';
import { useAuth } from '@/hooks/useAuth';
import { useDriveStore } from '@/hooks/useDrive';
import { useGlobalChatConversation } from '@/contexts/GlobalChatContext';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import type { UseAgentSessionChatReturn } from './useAgentSessionChat';

export function useAssistantSessionChat({
  conversationId,
}: {
  /** The assistant conversation this pane is mounted for — fixed for the hook's life. */
  conversationId: string;
}): UseAgentSessionChatReturn {
  const pathname = usePathname();
  const { user } = useAuth();
  const drives = useDriveStore((state) => state.drives);

  // The user's one global channel — every assistant stream, whichever surface
  // started it, broadcasts here. Null until auth resolves; every consumer
  // below degrades to the same "no channel yet" the other surfaces use.
  const channelId = user?.id ? globalChannelId(user.id) : null;

  useEffect(() => {
    void loadGlobalConversationMessages(conversationId);
  }, [conversationId]);

  const transport = useChatTransport(
    conversationId,
    `/api/ai/global/${encodeURIComponent(conversationId)}/messages`,
    channelId,
  );
  const chatConfig = useMemo(() => {
    if (!transport) return null;
    return buildChatConfig({
      id: `assistant-session-chat:${conversationId}`,
      transport,
      onError: (error: Error) => {
        console.error('Assistant session chat error:', error);
        toast.error('Chat error. Please try again.');
      },
    });
  }, [transport, conversationId]);

  const { sendMessage, status, error, clearError, regenerate, setMessages, stop } = useChat(
    chatConfig ?? {},
  );
  const isStreaming = status === 'submitted' || status === 'streaming';

  // No channel socket mounted here: GlobalChatProvider wraps the whole Layout
  // and already subscribes this user's global channel, so remote lifecycle
  // events for this conversation land in the store regardless of which pane
  // (or none) is looking. Its rejoin is the recovery hook the send handoff
  // needs.
  const { rejoinGlobalStream } = useGlobalChatConversation();

  const renderedMessages = useRenderedMessages(channelId ?? '', conversationId);
  const messages = useMemo(() => renderedMessages.map((r) => r.message), [renderedMessages]);
  const loadState = useConversationLoadState(conversationId);

  const activeStream = useConversationActiveStream(channelId, conversationId);
  const { streams: remoteStreams } = useActiveStream(channelId ?? '', conversationId);

  const { wrapSend, pendingSendConversationId } = useSendHandoff(
    conversationId,
    status,
    activeStream?.isOwn === true,
  );

  const displayIsStreaming =
    activeStream?.isOwn === true ||
    (pendingSendConversationId !== null && pendingSendConversationId === conversationId);

  const mirrorTriggeredBy = useMemo(
    () => ({ userId: user?.id ?? '', displayName: user?.name || user?.email || 'You' }),
    [user?.id, user?.name, user?.email],
  );
  const { getLatchedConversationId } = useOwnStreamMirror({
    status,
    ownMessages: messages,
    pageId: channelId ?? '',
    conversationId,
    triggeredBy: mirrorTriggeredBy,
  });

  const { prepareSend } = useConversationSendHandoff({
    status,
    stop,
    getLatchedConversationId,
    rejoin: rejoinGlobalStream,
  });

  const webSearchEnabled = useAssistantSettingsStore((state) => state.webSearchEnabled);
  const imageGenEnabled = useAssistantSettingsStore((state) => state.imageGenEnabled);
  const writeMode = useAssistantSettingsStore((state) => state.writeMode);
  const showPageTree = useAssistantSettingsStore((state) => state.showPageTree);
  const currentProvider = useAssistantSettingsStore((state) => state.currentProvider);
  const currentModel = useAssistantSettingsStore((state) => state.currentModel);

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !conversationId) return false;

      const contextRef = buildContextRef(pathname, drives);
      if (!(await prepareSend(conversationId))) {
        toast.error(HANDOFF_REFUSED_MESSAGE);
        return false;
      }

      const userMessage = buildUserMessage({ id: createId(), text: trimmed }) as UIMessage;
      conversationMessagesActions.addOptimisticSend(conversationId, userMessage);

      rollbackOptimisticSendOnFailure(
        () =>
          wrapSend(() =>
            sendMessage(userMessage, {
              body: buildGlobalChatRequestBody({
                conversationId,
                isReadOnly: !writeMode,
                webSearchEnabled,
                imageGenEnabled,
                showPageTree,
                contextRef,
                selectedProvider: currentProvider,
                selectedModel: currentModel,
              }),
            }),
          ),
        conversationId,
        userMessage.id,
      );
      return true;
    },
    [
      conversationId,
      pathname,
      drives,
      prepareSend,
      wrapSend,
      sendMessage,
      writeMode,
      webSearchEnabled,
      imageGenEnabled,
      showPageTree,
      currentProvider,
      currentModel,
    ],
  );

  const handleStop = useStopStream({
    activeStream,
    pendingSendConversationId,
    rawStop: stop,
    getLocalSendConversationId: getLatchedConversationId,
    targetConversationId: conversationId,
  });

  const isOwnSendLive = isStreaming || activeStream?.isOwn === true;
  const isOwnSendLiveRef = useRef(isOwnSendLive);
  isOwnSendLiveRef.current = isOwnSendLive;
  const getIsOwnSendLive = useCallback(() => isOwnSendLiveRef.current, []);

  const { handleEdit, handleDelete, handleRetry } = useCacheMessageActions({
    // null = global mode — the cache actions' own dual-pipeline switch, the
    // same value the assistant's sidebar passes when no agent is selected.
    agentId: null,
    conversationId,
    renderedMessages,
    isOwnSendLive,
    setMessages,
    regenerate,
    prepareSend,
    getIsOwnSendLive,
  });

  const lastAssistantMessageId = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'assistant')?.id,
    [messages],
  );
  const lastUserMessageId = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'user')?.id,
    [messages],
  );

  const reloadConversation = useCallback(async () => {
    await loadGlobalConversationMessages(conversationId);
  }, [conversationId]);

  const { isLoadingOlder, hasMoreOlder } = useConversationOlderPageState(conversationId);
  const handleScrollNearTop = useCallback(() => {
    void loadOlderGlobalConversationMessages(conversationId);
  }, [conversationId]);

  const { cause: errorCause, dismiss: dismissError } = useChatErrorCause(
    conversationId,
    error,
    clearError,
    pendingSendConversationId ?? conversationId,
  );

  return {
    messages,
    remoteStreams,
    displayIsStreaming,
    isMessagesLoading: loadState.isLoading,
    hasLoadError: loadState.hasError,
    reloadConversation,
    handleSend,
    handleStop,
    handleEdit,
    handleDelete,
    handleRetry,
    lastAssistantMessageId,
    lastUserMessageId,
    handleScrollNearTop,
    isLoadingOlder,
    hasMoreOlder,
    errorCause,
    dismissError,
  };
}
