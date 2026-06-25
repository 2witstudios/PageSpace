/**
 * AiChatView - Page-level AI agent chat view
 *
 * This component provides a chat interface for AI_CHAT page types.
 * It uses the Agent engine for conversation management, independent
 * from the Global Assistant.
 */

import { TreePage } from '@/hooks/usePageTree';
import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useChat } from '@ai-sdk/react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Settings, MessageSquare, History, Plus, Save } from 'lucide-react';
import { UIMessage } from 'ai';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { useVoiceModeStore, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import { useDriveStore } from '@/hooks/useDrive';
import { buildPageContext } from '@/lib/ai/shared/buildPageContext';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { PageAgentSettingsTab, PageAgentHistoryTab, ConversationShareToggle, type PageAgentSettingsTabRef } from '@/components/ai/page-agents';
import { AgentIntegrationsPanel } from '@/components/ai/page-agents/AgentIntegrationsPanel';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { VoiceCallPanel } from '@/components/ai/voice/VoiceCallPanel';
import { useSWRConfig } from 'swr';

import { clearActiveStreamId } from '@/lib/ai/core/client';
import { abortActiveStream, abortActiveStreamByMessageId } from '@/lib/ai/core/stream-abort-client';
import { resolveActiveAssistantMessageId } from '@/lib/ai/streams/resolveActiveAssistantMessageId';
import { useAppStateRecovery } from '@/hooks/useAppStateRecovery';
import { isCapacitorApp } from '@/hooks/useCapacitor';
import { isEditingActive } from '@/stores/useEditingStore';
import { resolveResumeAction } from '@/lib/ai/streams/resolveResumeAction';
import { usePageSocketRoom } from '@/hooks/usePageSocketRoom';
import { useChannelStreamSocket } from '@/hooks/useChannelStreamSocket';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { synthesizeAssistantMessage } from '@/lib/ai/streams/synthesizeAssistantMessage';
import { applyMessageEdit } from '@/lib/ai/streams/applyMessageEdit';
import { applyMessageDelete } from '@/lib/ai/streams/applyMessageDelete';
import { shouldRefreshAfterUndo } from '@/lib/ai/streams/shouldRefreshAfterUndo';
import { shouldPrependConversation } from '@/lib/ai/streams/shouldPrependConversation';
import { shouldReloadOnComountComplete } from '@/lib/ai/streams/shouldReloadOnComountComplete';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { shouldApplyLoadedMessages } from '@/lib/ai/streams/shouldApplyLoadedMessages';
import { mergeServerAndPending } from '@/lib/ai/streams/mergeServerAndPending';
import { useShallow } from 'zustand/react/shallow';

// Shared hooks and components
import {
  useMCPTools,
  useMessageActions,
  useProviderSettings,
  useConversations,
  useChatTransport,
  useStreamingRegistration,
  useSendHandoff,
  AgentConfig,
} from '@/lib/ai/shared';
import {
  ProviderSetupCard,
} from '@/components/ai/shared/chat';
import { AiUsageMonitor, TasksDropdown } from '@/components/ai/shared';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';
import {
  ChatLayout,
  type ChatLayoutRef,
} from '@/components/ai/chat/layouts';
import { ChatInput, type ChatInputRef } from '@/components/ai/chat/input';
import { useImageAttachments } from '@/lib/ai/shared/hooks/useImageAttachments';
import { hasVisionCapability } from '@/lib/ai/core/vision-models';
import { useFindStore } from '@/stores/useFindStore';
import { useDraft } from '@/hooks/useDraft';
import { buildDraftKey } from '@/lib/draft/draft';

interface AiChatViewProps {
  page: TreePage;
}

type ConversationListResponse = { conversations?: Array<{ id: string }> };
type ConversationMessagesResponse = { messages: UIMessage[] };

const VOICE_OWNER: VoiceModeOwner = 'ai-page';
const EMPTY_MESSAGES: UIMessage[] = [];

const AiChatView: React.FC<AiChatViewProps> = ({ page }) => {
  const params = useParams();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const { cache } = useSWRConfig();
  const { user } = useAuth();

  // ============================================
  // LOCAL STATE
  // ============================================
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const { draft: input, setDraft: setInput, clearDraft: clearInputDraft } = useDraft(
    buildDraftKey('ai', page.id),
  );
  const [activeTab, setActiveTab] = useState<string>('chat');
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [showError, setShowError] = useState(true);
  const [isReadOnly, setIsReadOnly] = useState<boolean>(false);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const [lastAIResponse, setLastAIResponse] = useState<{ id: string; text: string } | null>(null);
  // Message-load state — tracks in-progress DB fetches and their failures independently
  // of the useChat streaming state so blank → spinner instead of blank → blank.
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [messagesLoadError, setMessagesLoadError] = useState<Error | null>(null);
  // undefined = uninitialized, null = initialized with no baseline message, string = baseline message ID
  const voiceBaselineRef = useRef<string | null | undefined>(undefined);
  // Voice mode state
  const isVoiceModeEnabled = useVoiceModeStore((s) => s.isEnabled);
  const voiceOwner = useVoiceModeStore((s) => s.owner);
  const enableVoiceMode = useVoiceModeStore((s) => s.enable);
  const disableVoiceMode = useVoiceModeStore((s) => s.disable);
  const isVoiceModeActive = isVoiceModeEnabled && voiceOwner === VOICE_OWNER;

  // Display preferences
  const { preferences: displayPreferences } = useDisplayPreferences();

  // Image attachments for vision support
  const { attachments, addFiles, removeFile, clearFiles, getFilesForSend } = useImageAttachments();

  // Refs
  const chatLayoutRef = useRef<ChatLayoutRef>(null);
  const inputRef = useRef<ChatInputRef>(null);
  const agentSettingsRef = useRef<PageAgentSettingsTabRef>(null);
  const prevConversationIdRef = useRef<string | null>(null);
  // Always reflects the current page.id so async callbacks can detect stale pages
  const pageIdRef = useRef(page.id);
  useEffect(() => { pageIdRef.current = page.id; }, [page.id]);
  // Tracks the conversationId of the most recent loadMessagesForConversation call so
  // stale in-flight fetches (from a previous conversation) are silently dropped.
  const loadRequestedIdRef = useRef<string | null>(null);
  // When set to a conversationId, the load-on-select effect skips the fetch for that
  // id on its next fire (messages are already provided inline, avoiding a double-fetch).
  const skipLoadEffectRef = useRef<string | null>(null);

  // ============================================
  // SHARED HOOKS
  // ============================================
  const {
    isLoading: isLoadingProviders,
    isAnyProviderConfigured,
    needsSetup,
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    isProviderConfigured,
  } = useProviderSettings({ pageId: page.id });

  const hasVision = hasVisionCapability(selectedModel || '');

  const {
    isDesktop,
    runningServers,
    runningServerNames,
    mcpToolSchemas,
    enabledServerCount,
    isServerEnabled,
    setServerEnabled,
    allServersEnabled,
    setAllServersEnabled,
  } = useMCPTools({ conversationId: currentConversationId });

  // Get web search setting from global assistant settings store
  const webSearchEnabled = useAssistantSettingsStore((state) => state.webSearchEnabled);

  const {
    conversations,
    isLoading: isLoadingConversations,
    loadConversation,
    createConversation,
    deleteConversation,
    prependConversationOptimistic,
    refreshConversations,
  } = useConversations({
    agentId: page.id,
    currentConversationId,
    // Enabled on the chat tab too (not just history) so the header can show the
    // active conversation's share state and let the owner toggle it in place.
    enabled: activeTab === 'history' || activeTab === 'chat',
    onConversationLoad: (conversationId, messages) => {
      // Use the pre-fetched messages directly (no re-fetch) and suppress the
      // load-on-select effect for this id so we don't double-request the server.
      skipLoadEffectRef.current = conversationId;
      setCurrentConversationId(conversationId);
      setActiveTab('chat');
      void loadMessagesForConversation(conversationId, messages);
    },
    onConversationLoadError: (_conversationId, error) => {
      // The conversation list fetch failed — show the error inline without
      // clearing existing messages (caller's toast already announced the failure).
      setMessagesLoadError(error);
    },
    onConversationCreate: (conversationId) => {
      // New conversation has no messages — skip the load effect.
      skipLoadEffectRef.current = conversationId;
      setCurrentConversationId(conversationId);
      setMessages([]);
      setActiveTab('chat');
    },
    onConversationDelete: () => {
      setCurrentConversationId(null);
      setMessages([]);
    },
  });

  // Toggle share status for a conversation the user owns
  const toggleConversationShare = useCallback(async (conversationId: string, isShared: boolean) => {
    try {
      const response = await fetchWithAuth(
        `/api/ai/page-agents/${page.id}/conversations/${conversationId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isShared }),
        }
      );
      if (!response.ok) {
        toast.error('Failed to update conversation sharing');
        return;
      }
      refreshConversations();
    } catch {
      toast.error('Failed to update conversation sharing');
    }
  }, [page.id, refreshConversations]);

  // The active conversation's metadata (share state, ownership), derived from the
  // conversation list. Null for the page-scoped placeholder id (no persisted
  // conversation yet) — the header toggle is hidden until the first message lands.
  const currentConversation = useMemo(
    () => conversations.find((c) => c.id === currentConversationId) ?? null,
    [conversations, currentConversationId],
  );

  // A real conversation can become active without ever entering the cached list:
  // the first message on a fresh page creates it, but private conversations are
  // not broadcast and the stream-completion path doesn't refresh the list. Since
  // the list is now fetched on the chat tab, a fresh page caches [] up-front;
  // without this, the header share toggle never appears and opening History
  // reuses that stale empty cache. Pull the list once per id that's missing from
  // it so both the header and History reflect the just-created conversation.
  const syncedConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentConversationId) return;
    if (currentConversationId === `${page.id}-default`) return;
    if (conversations.some((c) => c.id === currentConversationId)) return;
    if (syncedConversationRef.current === currentConversationId) return;
    syncedConversationRef.current = currentConversationId;
    refreshConversations();
  }, [currentConversationId, conversations, page.id, refreshConversations]);

  // ============================================
  // CHAT CONFIGURATION
  // ============================================
  // Use conversation ID for stream tracking (falls back to page.id before conversation is created)
  const streamTrackingId = currentConversationId || page.id;

  const transport = useChatTransport(streamTrackingId, '/api/ai/chat');

  const handleChatError = useCallback((error: Error) => {
    console.error('AiChatView: Chat error:', error);
  }, []);

  const chatConfig = useMemo(
    () => !transport ? null : ({
      id: page.id,
      messages: EMPTY_MESSAGES,
      transport,
      experimental_throttle: 100,
      onError: handleChatError,
    }),
    [page.id, transport, handleChatError]
  );

  const { messages, sendMessage, status, error, regenerate, setMessages, stop: chatStop } =
    useChat(chatConfig || {});

  const isStreaming = status === 'submitted' || status === 'streaming';

  // ============================================
  // AUTHORITATIVE MESSAGE LOADER (the ONE setMessages writer)
  // ============================================
  // Fetches the latest DB messages for a conversation and writes them to useChat
  // via setMessages. All other paths (init, history-select, pull-up, undo) funnel
  // through here so there is never a competing write from a stale in-flight fetch.
  //
  // Pass preloadedMessages to skip the network round-trip when the caller already
  // has fresh data (e.g. useConversations.loadConversation already fetched them).
  // The stale-guard and pending-stream reconciliation still run in both paths.
  const loadMessagesForConversation = useCallback(async (
    conversationId: string,
    preloadedMessages?: UIMessage[],
  ): Promise<void> => {
    // Skip the placeholder id — it has no server-side messages yet.
    if (conversationId === `${page.id}-default`) return;

    loadRequestedIdRef.current = conversationId;
    setIsLoadingMessages(true);
    setMessagesLoadError(null);

    try {
      let serverMessages: UIMessage[];

      if (preloadedMessages !== undefined) {
        // Fast path: caller already did the fetch (history-select, init).
        serverMessages = preloadedMessages;
      } else {
        const res = await fetchWithAuth(
          `/api/ai/page-agents/${page.id}/conversations/${conversationId}/messages`,
        );
        // Stale check after await — user may have switched conversation.
        if (!shouldApplyLoadedMessages(conversationId, loadRequestedIdRef.current)) return;
        if (!res.ok) throw new Error(`Failed to load messages (${res.status})`);
        const data = await res.json();
        if (!shouldApplyLoadedMessages(conversationId, loadRequestedIdRef.current)) return;
        serverMessages = (data as ConversationMessagesResponse).messages ?? [];
      }

      if (!shouldApplyLoadedMessages(conversationId, loadRequestedIdRef.current)) return;

      // Reconcile with any in-flight own stream so a DB reload during an active
      // stream doesn't drop the streaming bubble or duplicate it once persisted.
      // NOTE: prod runs multiple web instances — live tokens from a stream on another
      // instance won't be in the pending store; the persisted message still shows up
      // on the next DB load. Cross-instance live-token rejoin is a known follow-up.
      const ownStream = usePendingStreamsStore.getState().getOwnStreams(page.id)[0];
      const merged =
        ownStream?.conversationId === conversationId && ownStream.messageId
          ? mergeServerAndPending(serverMessages, ownStream.parts, ownStream.messageId)
          : serverMessages;

      setMessages(merged);
      setMessagesLoadError(null);
    } catch (err) {
      if (!shouldApplyLoadedMessages(conversationId, loadRequestedIdRef.current)) return;
      // Keep the messages the user was already looking at — never silently blank on failure.
      setMessagesLoadError(err instanceof Error ? err : new Error('Failed to load messages'));
    } finally {
      if (shouldApplyLoadedMessages(conversationId, loadRequestedIdRef.current)) {
        setIsLoadingMessages(false);
      }
    }
  }, [page.id, setMessages]);

  // Find in page
  const findQuery = useFindStore((s) => s.query);
  const findIndex = useFindStore((s) => s.currentIndex);
  const isFindOpen = useFindStore((s) => s.isOpen);
  const reportMatches = useFindStore((s) => s.reportMatches);
  const [findMatchIds, setFindMatchIds] = useState<string[]>([]);

  useEffect(() => {
    if (!isFindOpen || !findQuery) {
      setFindMatchIds([]);
      reportMatches(0);
      return;
    }
    const q = findQuery.toLowerCase();
    const ids = messages
      .filter((m) => {
        const text = (m.parts ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => (p as { type: 'text'; text: string }).text)
          .join(' ');
        return text.toLowerCase().includes(q);
      })
      .map((m) => m.id);
    setFindMatchIds(ids);
    reportMatches(ids.length);
  }, [isFindOpen, findQuery, messages, reportMatches]);

  const findMatchSet = useMemo(() => new Set(findMatchIds), [findMatchIds]);
  const currentFindMsgId = findMatchIds[findIndex] ?? null;
  const { wrapSend } = useSendHandoff(currentConversationId, status);

  const streamingAssistantText = useMemo(() => {
    if (!isStreaming) return null;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return null;
    return (last.parts ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('');
  }, [messages, isStreaming]);
  // Show a loading indicator (not a blank) both during init and during any
  // subsequent message-fetch triggered by conversation switch or refresh.
  const isLoading = !isInitialized || isLoadingMessages;

  // ============================================
  // MESSAGE ACTIONS (shared hook)
  // ============================================
  const { handleEdit, handleDelete, handleRetry, lastAssistantMessageId, lastUserMessageId } =
    useMessageActions({
      agentId: page.id,
      conversationId: currentConversationId,
      messages,
      setMessages,
      regenerate,
    });

  // ============================================
  // INITIALIZATION EFFECTS
  // ============================================

  // Check user permissions
  useEffect(() => {
    const checkPermissions = async () => {
      if (!user?.id) return;
      try {
        const response = await fetchWithAuth(`/api/pages/${page.id}/permissions/check`);
        if (response.ok) {
          const permissions = await response.json();
          setIsReadOnly(!permissions.canEdit);
        }
      } catch (error) {
        console.error('Failed to check permissions:', error);
      }
    };
    checkPermissions();
  }, [user?.id, page.id]);

  // Initialize chat
  useEffect(() => {
    const controller = new AbortController();

    const initializeChat = async () => {
      try {
        // Load agent config
        const agentConfigResponse = await fetchWithAuth(`/api/pages/${page.id}/agent-config`, {
          signal: controller.signal,
        });
        if (agentConfigResponse.ok) {
          const config = await agentConfigResponse.json();
          setAgentConfig(config);
          if (config.aiProvider) setSelectedProvider(config.aiProvider);
          if (config.aiModel) setSelectedModel(config.aiModel);
        }

        // Try to load the most recent existing conversation
        try {
          const listResponse = await fetchWithAuth(
            `/api/ai/page-agents/${page.id}/conversations?pageSize=1`,
            { signal: controller.signal }
          );
          if (listResponse.ok) {
            const { conversations: list } = (await listResponse.json()) as ConversationListResponse;
            if (list && list.length > 0) {
              const conv = list[0];
              const msgResponse = await fetchWithAuth(
                `/api/ai/page-agents/${page.id}/conversations/${conv.id}/messages`,
                { signal: controller.signal }
              );
              // undefined = fetch failed; keep undefined so loadMessagesForConversation
              // takes the network path and shows the error banner on failure.
              const loaded = msgResponse.ok
                ? (((await msgResponse.json()) as ConversationMessagesResponse).messages ?? [])
                : undefined;
              if (controller.signal.aborted) return;
              // Supply pre-fetched messages directly to the one-writer path and suppress
              // the load-on-select effect so we don't re-fetch what we just loaded.
              // Only suppress when the fetch actually succeeded (loaded !== undefined).
              if (loaded !== undefined) {
                skipLoadEffectRef.current = conv.id;
              }
              setCurrentConversationId(conv.id);
              void loadMessagesForConversation(conv.id, loaded);
              setIsInitialized(true);
              return;
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          console.warn('Failed to load conversations on init, using page-scoped default:', err);
        }

        if (controller.signal.aborted) return;
        // No persisted conversations exist yet. Derive a stable ID from the page so
        // concurrent openers share the same conversation before either sends a message.
        // The conversation is anchored in the DB once the first message is saved.
        setCurrentConversationId(`${page.id}-default`);
        setMessages([]);
        setIsInitialized(true);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Failed to initialize chat:', error);
        setMessages([]);
        setIsInitialized(true);
      }
    };

    setIsInitialized(false);
    setCurrentConversationId(null);
    initializeChat();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  // Load-on-select guarantee: whenever currentConversationId changes to a real
  // (non-placeholder) id, reload the latest messages from the DB. This fires for
  // conversation switches triggered from sources other than the init / history-select
  // paths (which use the preloaded fast-path and set skipLoadEffectRef to opt out).
  useEffect(() => {
    if (!currentConversationId) return;
    if (currentConversationId === `${page.id}-default`) return;
    if (skipLoadEffectRef.current === currentConversationId) {
      skipLoadEffectRef.current = null; // consume the skip token
      return;
    }
    void loadMessagesForConversation(currentConversationId);
  }, [currentConversationId, page.id, loadMessagesForConversation]);

  // Register streaming state with editing store
  useStreamingRegistration(
    `ai-chat-${page.id}`,
    isStreaming,
    { pageId: page.id, componentName: 'AiChatView' }
  );

  const remoteStreams = usePendingStreamsStore(
    useShallow((state) => state.getRemotePageStreams(page.id))
  );

  // Subscribe to a primitive (messageId | undefined) so token appends to the
  // own stream don't churn this hook's identity and re-render ChatLayout per chunk.
  const ownStreamMessageId = usePendingStreamsStore(
    (state) => state.getOwnStreams(page.id)[0]?.messageId
  );

  const effectiveIsStreaming = isStreaming || ownStreamMessageId !== undefined;

  const remoteStreamingUser = !effectiveIsStreaming
    ? remoteStreams.find((s) => !s.isOwn)?.triggeredBy ?? null
    : null;

  const effectiveStop = useCallback(() => {
    // Stop the local fetch immediately for instant UI feedback.
    chatStop();
    // Abort by the stable assistant messageId — reaches the server registry even
    // when the conversation id shifted mid-stream, and tears down any multicast
    // SSE join via the resulting chat:stream_complete broadcast.
    const messageId = resolveActiveAssistantMessageId({
      ownStreamMessageId,
      isStreaming,
      lastAssistantMessageId,
    });
    if (messageId) {
      void abortActiveStreamByMessageId({ messageId });
      return;
    }
    // No assistant id yet (submitted, before first chunk): fall back to the chatId map.
    // The transport's chatId is always page.id (Chat never recreates on conversation switch),
    // so try streamTrackingId first (desired key) then page.id (actual registration key).
    if (streamTrackingId) void abortActiveStream({ chatId: streamTrackingId });
    if (streamTrackingId !== page.id) void abortActiveStream({ chatId: page.id });
  }, [chatStop, ownStreamMessageId, isStreaming, lastAssistantMessageId, streamTrackingId, page.id]);

  usePageSocketRoom(page.id);
  const { rejoinActiveStreams } = useChannelStreamSocket(page.id, {
    onUserMessage: (message, payload) => {
      if (payload.conversationId !== currentConversationId) return;
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    },
    onMessageEdited: (payload) => {
      if (payload.conversationId !== currentConversationId) return;
      setMessages((prev) =>
        applyMessageEdit(prev, {
          messageId: payload.messageId,
          parts: payload.parts,
          editedAt: new Date(payload.editedAt),
        }),
      );
    },
    onMessageDeleted: (payload) => {
      if (payload.conversationId !== currentConversationId) return;
      setMessages((prev) => applyMessageDelete(prev, payload.messageId));
    },
    onUndoApplied: (payload) => {
      if (!shouldRefreshAfterUndo(payload, currentConversationId, getBrowserSessionId())) return;
      void loadConversation(payload.conversationId);
    },
    onConversationAdded: (payload) => {
      if (!shouldPrependConversation(payload, getBrowserSessionId(), conversations)) return;
      prependConversationOptimistic(payload.conversation);
    },
    onConversationRenamed: () => {
      refreshConversations();
    },
    onConversationDeleted: () => {
      refreshConversations();
    },
    onStreamComplete: (messageId, completedConvId) => {
      const stream = usePendingStreamsStore.getState().streams.get(messageId);

      if (stream && stream.parts.length > 0 && stream.conversationId === currentConversationId) {
        // Guard against a duplicate: useChat may already hold this message when the
        // stream was consumed by both the POST stream and the multicast SSE join.
        setMessages((prev) =>
          prev.some((m) => m.id === messageId)
            ? prev
            : [...prev, synthesizeAssistantMessage(messageId, stream.parts)],
        );
        return;
      }

      if (shouldReloadOnComountComplete(stream, completedConvId, currentConversationId)) {
        void loadConversation(completedConvId!);
        return;
      }

      if (!stream || stream.parts.length === 0) return;

      if (currentConversationId === `${page.id}-default`) {
        const { parts, conversationId: streamConvId } = stream;
        fetchWithAuth(`/api/ai/page-agents/${page.id}/conversations?pageSize=1`)
          .then(async (res) => {
            if (pageIdRef.current !== page.id) return;
            if (!res.ok) return;
            const data = (await res.json()) as ConversationListResponse;
            const persisted = data.conversations?.[0];
            if (!persisted || persisted.id !== streamConvId) return;
            setCurrentConversationId(persisted.id);
            setMessages((prev) =>
              prev.some((m) => m.id === messageId)
                ? prev
                : [...prev, synthesizeAssistantMessage(messageId, parts)],
            );
          })
          .catch((err) => console.warn('[AiChatView] late-joiner sync failed', err));
      }
    },
  });

  // Reset error visibility when new error occurs
  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

  // Track last AI response for voice mode TTS.
  // voiceBaselineRef captures the last message ID when voice mode activates so pre-existing
  // messages are never spoken — only genuinely new responses trigger TTS.
  useEffect(() => {
    if (!isVoiceModeActive) {
      voiceBaselineRef.current = undefined;
      setLastAIResponse(null);
      return;
    }

    // Initialize baseline BEFORE the streaming guard. If we waited until after,
    // activating voice mid-stream would leave the baseline unset and then silence
    // the in-flight response when it finishes.
    if (voiceBaselineRef.current === undefined) {
      const assistantMsgs = messages.filter((m) => m.role === 'assistant');
      const lastOverallMsg = messages[messages.length - 1];
      // During streaming the last overall message is the in-progress assistant reply;
      // the baseline should be the previously-finalized message before it.
      const streamingAssistantIdx =
        isStreaming && lastOverallMsg?.role === 'assistant'
          ? assistantMsgs.length - 1
          : assistantMsgs.length;
      const baselineMsg = assistantMsgs[streamingAssistantIdx - 1];
      voiceBaselineRef.current = baselineMsg?.id ?? null;
      return;
    }

    if (isStreaming) return;

    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistantMsg) return;
    const textParts = lastAssistantMsg.parts?.filter((p) => p.type === 'text') ?? [];
    const text = textParts.map((p) => (p as { text: string }).text).join('');
    if (!text.trim()) return;
    if (lastAssistantMsg.id === voiceBaselineRef.current) return;

    setLastAIResponse((current) =>
      current?.id === lastAssistantMsg.id
        ? current
        : { id: lastAssistantMsg.id, text }
    );
  }, [messages, isStreaming, isVoiceModeActive]);

  // ============================================
  // HANDLERS
  // ============================================

  const buildFreshPageContext = useCallback(() => {
    const treeCacheKey = `/api/drives/${encodeURIComponent(driveId)}/pages`;
    const treeCacheValue = cache.get(treeCacheKey) as { data?: TreePage[] } | undefined;
    const cachedTree = Array.isArray(treeCacheValue?.data) ? treeCacheValue.data : [];
    return buildPageContext({
      page: { id: page.id, title: page.title, type: page.type },
      driveId,
      drives,
      cachedTree,
      fetchBreadcrumbs: async (pageId) => {
        const res = await fetchWithAuth(`/api/pages/${pageId}/breadcrumbs`);
        if (!res.ok) return [];
        return res.json();
      },
    });
  }, [cache, drives, driveId, page.id, page.title, page.type]);

  const handleSendMessage = useCallback(() => {
    if (isReadOnly) {
      toast.error('You do not have permission to send messages in this AI chat');
      return;
    }
    const trimmed = input.trim();
    const files = getFilesForSend();
    if (!trimmed && files.length === 0) return;
    if (!currentConversationId) return;

    // Start context fetch eagerly — runs in parallel with input clear so the
    // async wait doesn't delay sendMessage (and the optimistic bubble).
    const contextPromise = buildFreshPageContext();

    clearInputDraft();
    clearFiles();
    inputRef.current?.clear();

    wrapSend(async () => {
      const pageContext = await contextPromise;
      sendMessage(
        { text: trimmed, files: files.length > 0 ? files : undefined },
        {
          body: {
            chatId: page.id,
            conversationId: currentConversationId,
            selectedProvider,
            selectedModel,
            isReadOnly,
            webSearchEnabled,
            mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
            pageContext,
          },
        }
      );
    });
  }, [
    isReadOnly,
    input,
    attachments.length,
    currentConversationId,
    buildFreshPageContext,
    getFilesForSend,
    clearInputDraft,
    clearFiles,
    sendMessage,
    page.id,
    selectedProvider,
    selectedModel,
    webSearchEnabled,
    mcpToolSchemas,
    wrapSend,
  ]);

  // Voice mode: Send message from voice transcript
  const handleVoiceSend = useCallback((text: string) => {
    if (isReadOnly) {
      toast.error('You do not have permission to send messages in this AI chat');
      return;
    }
    if (!text.trim()) return;
    if (!currentConversationId) return;

    const contextPromise = buildFreshPageContext();
    wrapSend(async () => {
      const pageContext = await contextPromise;
      sendMessage(
        { text: text.trim() },
        {
          body: {
            chatId: page.id,
            conversationId: currentConversationId,
            selectedProvider,
            selectedModel,
            isReadOnly,
            webSearchEnabled,
            mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
            pageContext,
          },
        }
      );
    });
  }, [
    isReadOnly,
    currentConversationId,
    buildFreshPageContext,
    sendMessage,
    page.id,
    selectedProvider,
    selectedModel,
    webSearchEnabled,
    mcpToolSchemas,
    wrapSend,
  ]);

  // Voice mode toggle handler
  const handleVoiceModeToggle = useCallback(() => {
    if (isVoiceModeActive) {
      disableVoiceMode();
    } else {
      enableVoiceMode(VOICE_OWNER);
    }
  }, [isVoiceModeActive, enableVoiceMode, disableVoiceMode]);

  const handleUndoSuccess = useCallback(async () => {
    if (!currentConversationId) return;
    await loadMessagesForConversation(currentConversationId);
  }, [currentConversationId, loadMessagesForConversation]);

  // Pull-up refresh handler for mobile - check for missed messages
  const handlePullUpRefresh = useCallback(async () => {
    if (!currentConversationId) return;
    await loadMessagesForConversation(currentConversationId);
  }, [currentConversationId, loadMessagesForConversation]);

  // App state recovery - re-attach/refetch AI stream when returning from background.
  // On native (Capacitor): if streaming, stop the local fetch, rejoin any still-live
  // server stream, then refetch to recover a stream that finished while backgrounded.
  // On web: never interrupt a live fetch on tab-switch (the fetch stays alive).
  // Known limitation (pre-existing): if the user switched conversation while backgrounded,
  // onStreamComplete's conversationId guard suppresses the append; the message is still
  // persisted and appears on navigating back to the conversation.
  useAppStateRecovery({
    onResume: useCallback(async () => {
      const action = resolveResumeAction({ native: isCapacitorApp(), isStreaming: effectiveIsStreaming });
      if (action === 'noop') return;
      if (action === 'rejoin-and-refresh') {
        // chatStop is local-only; it does NOT signal the server (the existing effectiveStop
        // does that separately via abortActiveStreamByMessageId). We only need to clear the
        // local useChat streaming state so rejoin can attach cleanly.
        chatStop();
        rejoinActiveStreams();
      }
      await handlePullUpRefresh();
    }, [effectiveIsStreaming, chatStop, rejoinActiveStreams, handlePullUpRefresh]),
    enabled: currentConversationId !== null && !isEditingActive(),
  });

  // Clean up stream tracking when conversation changes or on unmount
  // Uses prevConversationIdRef to track the previous conversation and clear its stream ID
  useEffect(() => {
    // Clear previous conversation's stream ID when switching conversations
    if (prevConversationIdRef.current && prevConversationIdRef.current !== streamTrackingId) {
      clearActiveStreamId({ chatId: prevConversationIdRef.current });
    }
    prevConversationIdRef.current = streamTrackingId;

    // Clear current conversation's stream ID on unmount
    return () => {
      clearActiveStreamId({ chatId: streamTrackingId });
    };
  }, [streamTrackingId]);

  // ============================================
  // RENDER
  // ============================================

  // Show loading state while checking provider configuration
  if (isLoadingProviders) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Show provider setup if needed
  if (needsSetup) {
    return (
      <ProviderSetupCard
        mode="inline"
        onApiKeySubmit={(provider) => {
          setSelectedProvider(provider);
          // API key submission would need backend handling
        }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full">
        <div className="p-4 border-b border-[var(--separator)] space-y-3">
          <div className="flex items-center justify-between">
            <TabsList className="grid grid-cols-3 max-w-lg">
              <TabsTrigger value="chat" className="flex items-center space-x-2">
                <MessageSquare className="h-4 w-4" />
                <span className="hidden sm:inline">Chat</span>
              </TabsTrigger>
              <TabsTrigger value="history" className="flex items-center space-x-2">
                <History className="h-4 w-4" />
                <span className="hidden sm:inline">History</span>
              </TabsTrigger>
              <TabsTrigger value="settings" className="flex items-center space-x-2">
                <Settings className="h-4 w-4" />
                <span className="hidden sm:inline">Settings</span>
              </TabsTrigger>
            </TabsList>

            {/* Chat tab actions */}
            {activeTab === 'chat' && (
              <div className="flex items-center gap-3">
                {displayPreferences.showTokenCounts && (
                  <AiUsageMonitor pageId={page.id} compact />
                )}

                <TasksDropdown messages={messages} driveId={driveId} />

                {currentConversation && (
                  <ConversationShareToggle
                    isShared={currentConversation.isShared}
                    isOwner={currentConversation.isOwner}
                    onToggle={() =>
                      toggleConversationShare(
                        currentConversation.id,
                        !currentConversation.isShared,
                      )
                    }
                  />
                )}

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => createConversation()}
                  className="flex items-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  <span className="hidden sm:inline">New Chat</span>
                </Button>
              </div>
            )}

            {/* Settings tab actions */}
            {activeTab === 'settings' && (
              <Button
                onClick={() => agentSettingsRef.current?.submitForm()}
                disabled={isSettingsSaving}
                className="min-w-[100px] sm:min-w-[120px]"
              >
                {isSettingsSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    <span className="hidden sm:inline">Saving...</span>
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4 sm:mr-2" />
                    <span className="hidden sm:inline">Save Settings</span>
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Chat Tab */}
        <TabsContent value="chat" className="flex flex-col flex-1 overflow-hidden relative">
          {/* Inline error shown when a message-load fails — never silently blank. */}
          {messagesLoadError && (
            <div className="flex items-center justify-between gap-2 px-4 py-2 bg-destructive/10 text-destructive text-sm border-b border-destructive/20">
              <span className="truncate">Failed to load messages: {messagesLoadError.message}</span>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => {
                  if (currentConversationId) {
                    setMessagesLoadError(null);
                    void loadMessagesForConversation(currentConversationId);
                  }
                }}
              >
                Retry
              </Button>
            </div>
          )}
          <ChatLayout
            ref={chatLayoutRef}
            messages={messages}
            input={input}
            onInputChange={setInput}
            onSend={handleSendMessage}
            onStop={effectiveStop}
            isStreaming={effectiveIsStreaming}
            isLoading={isLoading}
            disabled={!isAnyProviderConfigured}
            placeholder={isReadOnly ? 'View only - cannot send messages' : 'Message AI...'}
            driveId={driveId}
            error={error}
            showError={showError}
            onClearError={() => setShowError(false)}
            welcomeTitle={`Chat with ${page.title}`}
            welcomeSubtitle={agentConfig?.systemPrompt ? 'Ask me anything!' : 'Start a conversation with the AI assistant'}
            onEdit={!isReadOnly ? handleEdit : undefined}
            onDelete={!isReadOnly ? handleDelete : undefined}
            onRetry={!isReadOnly ? handleRetry : undefined}
            lastAssistantMessageId={lastAssistantMessageId}
            lastUserMessageId={lastUserMessageId}
            isReadOnly={isReadOnly}
            onUndoSuccess={handleUndoSuccess}
            onPullUpRefresh={handlePullUpRefresh}
            mcpRunningServers={runningServers}
            mcpServerNames={runningServerNames}
            mcpEnabledCount={enabledServerCount}
            mcpAllEnabled={allServersEnabled}
            onMcpToggleAll={setAllServersEnabled}
            isMcpServerEnabled={isServerEnabled}
            onMcpServerToggle={setServerEnabled}
            showMcp={isDesktop}
            remoteStreams={remoteStreams}
            findMatchSet={findMatchSet}
            findCurrentMessageId={currentFindMsgId}
            renderInput={(props) => (
              <>
                {isVoiceModeActive && (
                  <VoiceCallPanel
                    owner={VOICE_OWNER}
                    onSend={handleVoiceSend}
                    latestAssistantMessage={lastAIResponse}
                    isAIStreaming={effectiveIsStreaming}
                    streamingText={streamingAssistantText}
                    onStopStream={effectiveStop}
                    onClose={disableVoiceMode}
                  />
                )}
                <ChatInput
                  ref={inputRef}
                  value={props.value}
                  onChange={props.onChange}
                  onSend={props.onSend}
                  onStop={props.onStop}
                  isStreaming={props.isStreaming}
                  disabled={props.disabled}
                  placeholder={props.placeholder}
                  driveId={props.driveId}
                  crossDrive={props.crossDrive}
                  mcpRunningServers={props.mcpRunningServers}
                  mcpServerNames={props.mcpServerNames}
                  mcpEnabledCount={props.mcpEnabledCount}
                  mcpAllEnabled={props.mcpAllEnabled}
                  onMcpToggleAll={props.onMcpToggleAll}
                  isMcpServerEnabled={props.isMcpServerEnabled}
                  onMcpServerToggle={props.onMcpServerToggle}
                  showMcp={props.showMcp}
                  popupPlacement={props.inputPosition === 'centered' ? 'bottom' : 'top'}
                  selectedProvider={selectedProvider}
                  selectedModel={selectedModel}
                  onProviderModelChange={(provider, model) => {
                    setSelectedProvider(provider);
                    setSelectedModel(model);
                  }}
                  onVoiceModeClick={handleVoiceModeToggle}
                  isVoiceModeActive={isVoiceModeActive}
                  attachments={attachments}
                  onAddFiles={addFiles}
                  onRemoveFile={removeFile}
                  hasVision={hasVision}
                  remoteStreamingUser={remoteStreamingUser}
                />
              </>
            )}
          />
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history" className="flex-1 overflow-hidden">
          <PageAgentHistoryTab
            conversations={conversations}
            currentConversationId={currentConversationId}
            onSelectConversation={loadConversation}
            onCreateNew={() => createConversation()}
            onDeleteConversation={deleteConversation}
            onToggleShare={toggleConversationShare}
            isLoading={isLoadingConversations}
          />
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings" className="flex-1 overflow-auto">
          <PageAgentSettingsTab
            ref={agentSettingsRef}
            pageId={page.id}
            driveId={driveId}
            config={agentConfig}
            onConfigUpdate={setAgentConfig}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            onProviderChange={setSelectedProvider}
            onModelChange={setSelectedModel}
            isProviderConfigured={isProviderConfigured}
            onSavingChange={setIsSettingsSaving}
          />
          <div className="px-4 pb-4">
            <AgentIntegrationsPanel pageId={page.id} driveId={driveId} />
          </div>
        </TabsContent>
      </Tabs>

    </div>
  );
};

export default React.memo(
  AiChatView,
  (prevProps, nextProps) =>
    prevProps.page.id === nextProps.page.id &&
    prevProps.page.title === nextProps.page.title &&
    prevProps.page.type === nextProps.page.type
);
