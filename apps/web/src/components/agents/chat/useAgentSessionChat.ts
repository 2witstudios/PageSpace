'use client';

/**
 * useAgentSessionChat — the ONE chat's state for an agent session.
 *
 * Derived from the machine pane's `useMachinePaneChat` with the dual-mode
 * selector, `AISelector` and `pendingPrompt` machinery stripped: an
 * `AgentView` is never dual-mode — the agent is fixed by props, and the
 * conversation being chatted in (sessionId ≡ conversationId, see
 * `@pagespace/lib/agent-sessions/contract`) is fixed by props too. History
 * (the conversation list) is a separate concern owned by whoever renders the
 * conversation picker (`AgentView`'s header) — this hook is purely
 * send/stream/edit/delete/retry/error for the one conversation it was mounted
 * for.
 *
 * 'ai-streaming' editing-store protection is NOT registered here: it comes
 * for free from `useSendHandoff`'s pendingSend bookkeeping plus the app-wide
 * `DerivedStreamingRegistrations` (mounted once by `GlobalChatProvider`),
 * which derives a registration for ANY conversation with a pending send or a
 * live stream entry — see that module for why a per-surface registration
 * would only risk two owners disagreeing about when to end it.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePathname } from 'next/navigation';
import type { UIMessage } from 'ai';
import { useChat } from '@ai-sdk/react';
import { toast } from 'sonner';
import { createId } from '@paralleldrive/cuid2';
import type { AgentInfo } from '@/types/agent';
import {
  useChatTransport,
  useCacheMessageActions,
  useSendHandoff,
  useConversationSendHandoff,
  HANDOFF_REFUSED_MESSAGE,
  useChatErrorCause,
  buildChatConfig,
  type AIErrorCause,
} from '@/lib/ai/shared';
import { buildContextRef } from '@/lib/ai/shared/buildContextRef';
import { buildSessionChatRequestBody } from '@/lib/agents/build-session-chat-request';
import { buildUserMessage } from '@/lib/ai/streams/buildUserMessage';
import { rollbackOptimisticSendOnFailure } from '@/lib/ai/streams/rollbackOptimisticSendOnFailure';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import {
  loadAgentConversationMessages,
  loadOlderAgentConversationMessages,
} from '@/hooks/conversationMessagesLoaders';
import {
  useRenderedMessages,
  useConversationLoadState,
  useConversationOlderPageState,
} from '@/hooks/useRenderedMessages';
import { useAgentChannelMultiplayer } from '@/hooks/useAgentChannelMultiplayer';
import { useActiveStream, useConversationActiveStream } from '@/hooks/useActiveStream';
import { useOwnStreamMirror } from '@/hooks/useOwnStreamMirror';
import { useStopStream } from '@/hooks/useStopStream';
import { useAuth } from '@/hooks/useAuth';
import { useDriveStore } from '@/hooks/useDrive';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import type { PendingStream } from '@/stores/usePendingStreamsStore';

export interface UseAgentSessionChatOptions {
  /** The fixed agent this session belongs to — never selectable here. */
  agent: AgentInfo;
  /** ≡ the sessionId. Fixed for the life of this hook's mount (the caller keys its mount by it). */
  conversationId: string;
}

export interface UseAgentSessionChatReturn {
  messages: UIMessage[];
  remoteStreams: PendingStream[];
  displayIsStreaming: boolean;
  isMessagesLoading: boolean;
  hasLoadError: boolean;
  reloadConversation: () => Promise<void>;
  /** Resolves false when nothing was dispatched (empty text, refused handoff) — the composer restores its draft. */
  handleSend: (text: string) => Promise<boolean>;
  handleStop: () => Promise<void>;
  handleEdit: (messageId: string, newContent: string) => Promise<void>;
  handleDelete: (messageId: string) => Promise<void>;
  handleRetry: () => Promise<void>;
  lastAssistantMessageId: string | undefined;
  lastUserMessageId: string | undefined;
  handleScrollNearTop: () => void;
  isLoadingOlder: boolean;
  hasMoreOlder: boolean;
  errorCause: AIErrorCause | null;
  dismissError: () => void;
}

export function useAgentSessionChat({
  agent,
  conversationId,
}: UseAgentSessionChatOptions): UseAgentSessionChatReturn {
  const pathname = usePathname();
  const { user } = useAuth();
  const drives = useDriveStore((state) => state.drives);

  useEffect(() => {
    void loadAgentConversationMessages(agent.id, conversationId);
  }, [agent.id, conversationId]);

  const transport = useChatTransport(conversationId, '/api/ai/chat', agent.id);
  const chatConfig = useMemo(() => {
    if (!transport) return null;
    return buildChatConfig({
      id: `agent-session-chat:${conversationId}`,
      transport,
      onError: (error: Error) => {
        console.error('Agent session chat error:', error);
        toast.error('Chat error. Please try again.');
      },
    });
  }, [transport, conversationId]);

  const { sendMessage, status, error, clearError, regenerate, setMessages, stop } = useChat(
    chatConfig ?? {},
  );
  const isStreaming = status === 'submitted' || status === 'streaming';

  const loadConversation = useCallback(
    (id: string) => loadAgentConversationMessages(agent.id, id),
    [agent.id],
  );
  const { rejoinActiveStreams } = useAgentChannelMultiplayer({
    selectedAgent: agent,
    agentConversationId: conversationId,
    loadConversation,
  });

  const renderedMessages = useRenderedMessages(agent.id, conversationId);
  const messages = useMemo(() => renderedMessages.map((r) => r.message), [renderedMessages]);
  const loadState = useConversationLoadState(conversationId);

  const activeStream = useConversationActiveStream(agent.id, conversationId);
  const { streams: remoteStreams } = useActiveStream(agent.id, conversationId);

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
    pageId: agent.id,
    conversationId,
    triggeredBy: mirrorTriggeredBy,
  });

  const { prepareSend } = useConversationSendHandoff({
    status,
    stop,
    getLatchedConversationId,
    rejoin: rejoinActiveStreams,
  });

  const webSearchEnabled = useAssistantSettingsStore((state) => state.webSearchEnabled);
  const imageGenEnabled = useAssistantSettingsStore((state) => state.imageGenEnabled);
  const writeMode = useAssistantSettingsStore((state) => state.writeMode);

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
              body: buildSessionChatRequestBody({
                agentId: agent.id,
                conversationId,
                isReadOnly: !writeMode,
                webSearchEnabled,
                imageGenEnabled,
                provider: agent.aiProvider,
                model: agent.aiModel,
                systemPrompt: agent.systemPrompt,
                enabledTools: agent.enabledTools,
                contextRef,
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
      agent.id,
      agent.aiProvider,
      agent.aiModel,
      agent.systemPrompt,
      agent.enabledTools,
      writeMode,
      webSearchEnabled,
      imageGenEnabled,
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
    agentId: agent.id,
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
    await loadAgentConversationMessages(agent.id, conversationId);
  }, [agent.id, conversationId]);

  const { isLoadingOlder, hasMoreOlder } = useConversationOlderPageState(conversationId);
  const handleScrollNearTop = useCallback(() => {
    void loadOlderAgentConversationMessages(agent.id, conversationId);
  }, [agent.id, conversationId]);

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
