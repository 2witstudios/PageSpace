import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import type { UIMessage } from 'ai';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ChatInput, type ChatInputRef } from '@/components/ai/chat/input';
import { useImageAttachments } from '@/lib/ai/shared/hooks/useImageAttachments';
import { hasVisionCapability } from '@/lib/ai/core/vision-models';
import { Loader2, Plus } from 'lucide-react';
import { ProviderModelSelector } from '@/components/ai/chat/input/ProviderModelSelector';
import { CompactMessageRenderer, AISelector, AiUsageMonitor, TasksDropdown } from '@/components/ai/shared';
import { UndoAiChangesDialog, VirtualizedMessageList } from '@/components/ai/shared/chat';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  useConversationScrollRef
} from '@/components/ai/ui/conversation';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { useVoiceModeStore, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import { useGlobalChatConversation, useGlobalChatConfig, useGlobalChatStream } from '@/contexts/GlobalChatContext';
import { usePageAgentSidebarState, usePageAgentSidebarChat, type SidebarAgentInfo } from '@/hooks/page-agents';
import { usePageAgentDashboardStore } from '@/stores/page-agents';
import { usePendingStreamsStore, type PendingStream } from '@/stores/usePendingStreamsStore';
import { useShallow } from 'zustand/react/shallow';
import { useAuth } from '@/hooks/useAuth';
import { dedupRemoteStreams } from '@/lib/ai/streams/dedupRemoteStreams';
import { synthesizeAssistantMessage } from '@/lib/ai/streams/synthesizeAssistantMessage';
import { selectChannelRemoteStreams } from '@/lib/ai/streams/selectChannelRemoteStreams';
import { useAgentChannelMultiplayer } from '@/hooks/useAgentChannelMultiplayer';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { toast } from 'sonner';
import { LocationContext } from '@/lib/ai/shared';
import { abortActiveStream, abortActiveStreamByMessageId, clearActiveStreamId } from '@/lib/ai/core/client';
import { resolveActiveAssistantMessageId } from '@/lib/ai/streams/resolveActiveAssistantMessageId';
import { useChatTransport, useStreamingRegistration, useSendHandoff, useMessageActions, useStreamRecovery } from '@/lib/ai/shared';
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard';
import { useAppStateRecovery } from '@/hooks/useAppStateRecovery';
import { VoiceCallPanel } from '@/components/ai/voice/VoiceCallPanel';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';
import { isEditingActive } from '@/stores/useEditingStore';
import { ChatErrorBanner } from '@/components/ai/shared/chat/ChatErrorBanner';
import { shouldApplyLoadedMessages } from '@/lib/ai/streams/shouldApplyLoadedMessages';
import { mergeServerAndPending } from '@/lib/ai/streams/mergeServerAndPending';

const VOICE_OWNER: VoiceModeOwner = 'sidebar-chat';

// Threshold for enabling virtualization in sidebar (lower than main chat due to compact items)
const SIDEBAR_VIRTUALIZATION_THRESHOLD = 30;

/**
 * Inner component for rendering messages with access to stick-to-bottom context
 */
export interface SidebarMessagesContentProps {
  messages: UIMessage[];
  assistantName: string;
  locationContext: LocationContext | null;
  handleEdit: (messageId: string, newContent: string) => Promise<void>;
  handleDelete: (messageId: string) => Promise<void>;
  handleRetry: () => Promise<void>;
  handleUndoFromHere: (messageId: string) => void;
  lastAssistantMessageId: string | undefined;
  lastUserMessageId: string | undefined;
  displayIsStreaming: boolean;
  /** Remote in-progress streams to render inline below the messages. */
  remoteStreams: PendingStream[];
}

export const SidebarMessagesContent: React.FC<SidebarMessagesContentProps> = ({
  messages,
  assistantName,
  locationContext,
  handleEdit,
  handleDelete,
  handleRetry,
  handleUndoFromHere,
  lastAssistantMessageId,
  lastUserMessageId,
  displayIsStreaming,
  remoteStreams,
}) => {
  const scrollRef = useConversationScrollRef();
  const shouldVirtualize = messages.length >= SIDEBAR_VIRTUALIZATION_THRESHOLD;
  // Streams whose messageId already landed in `messages` are filtered out so
  // we don't render the same message twice during the brief window between
  // server-confirm and store-removal.
  const inflightRemoteStreams = useMemo(
    () => dedupRemoteStreams(remoteStreams, messages),
    [remoteStreams, messages],
  );
  const isEmpty = messages.length === 0 && inflightRemoteStreams.length === 0;

  // Memoized render function for virtualized list
  const renderMessage = useCallback((message: UIMessage) => (
    <CompactMessageRenderer
      key={message.id}
      message={message}
      onEdit={handleEdit}
      onDelete={handleDelete}
      onRetry={handleRetry}
      onUndoFromHere={handleUndoFromHere}
      isLastAssistantMessage={message.id === lastAssistantMessageId}
      isLastUserMessage={message.id === lastUserMessageId}
      isStreaming={displayIsStreaming && message.id === lastAssistantMessageId && message.role === 'assistant'}
    />
  ), [
    handleEdit,
    handleDelete,
    handleRetry,
    handleUndoFromHere,
    lastAssistantMessageId,
    lastUserMessageId,
    displayIsStreaming
  ]);

  return (
    <ConversationContent className="p-3 min-w-0 gap-1.5">
      {isEmpty ? (
        <div className="flex items-center justify-center h-20 text-muted-foreground text-xs text-center overflow-hidden">
          <div className="max-w-full px-2">
            <p className="font-medium truncate">{assistantName}</p>
            <p className="text-xs truncate">
              {locationContext
                ? `Context-aware help for ${locationContext.currentPage?.title || locationContext.currentDrive?.name}`
                : 'Ask me anything about your workspace'}
            </p>
          </div>
        </div>
      ) : shouldVirtualize ? (
        // Virtualized rendering for large conversations
        <VirtualizedMessageList
          messages={messages}
          renderMessage={renderMessage}
          scrollRef={scrollRef}
          estimatedRowHeight={60}
          overscan={5}
          gap={6}
        />
      ) : (
        // Regular rendering for smaller conversations
        messages.map(message => renderMessage(message))
      )}

      {inflightRemoteStreams.map((stream) => (
        <CompactMessageRenderer
          key={stream.messageId}
          message={synthesizeAssistantMessage(stream.messageId, stream.parts)}
          isStreaming
        />
      ))}

      {displayIsStreaming && (
        <div className="mb-1">
          <div className="flex items-center space-x-2 text-gray-500 text-xs">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Thinking...</span>
          </div>
        </div>
      )}
    </ConversationContent>
  );
};

/**
 * Assistant chat tab for the right sidebar.
 *
 * Supports dual-mode operation:
 * - Global Mode (default): Uses GlobalChatContext, syncs with middle panel
 * - Agent Mode: Uses local state, independent from middle panel
 *
 * The sidebar maintains its own agent selection, separate from the middle panel's usePageAgentDashboardStore.
 */
const SidebarChatTab: React.FC = () => {
  const pathname = usePathname();

  // Mobile keyboard support - track keyboard state to adjust input positioning
  const { isOpen: isKeyboardOpen, height: keyboardHeight } = useMobileKeyboard();

  // ============================================
  // Global Chat Context (split into selective hooks to minimize re-renders)
  // ============================================
  const {
    currentConversationId: globalConversationId,
    isInitialized: globalIsInitialized,
    createNewConversation: createGlobalConversation,
    refreshSignal,
  } = useGlobalChatConversation();

  const {
    chatConfig: globalChatConfig,
  } = useGlobalChatConfig();

  const {
    isStreaming: contextIsStreaming,
    stopStreaming: contextStopStreaming,
  } = useGlobalChatStream();

  // ============================================
  // Sidebar Agent State (custom hook)
  // ============================================
  const {
    selectedAgent,
    conversationId: agentConversationId,
    initialMessages: agentInitialMessages,
    isInitialized: agentIsInitialized,
    selectAgent,
    createNewConversation: createAgentConversation,
    refreshConversation: refreshAgentConversation,
    loadConversation: loadSidebarAgentConversation,
  } = usePageAgentSidebarState();

  // ============================================
  // Agent Chat Configuration
  // ============================================
  // Namespaced key prevents activeStreams collision when both panels view the same conversationId.
  const sidebarChatId = agentConversationId ? `sidebar:${agentConversationId}` : null;
  const agentTransport = useChatTransport(sidebarChatId, '/api/ai/chat');

  const agentChatConfig = useMemo(() => {
    if (!selectedAgent || !agentConversationId || !agentTransport) return null;

    return {
      id: agentConversationId,
      messages: agentInitialMessages,
      transport: agentTransport,
      experimental_throttle: 100,
      onError: (error: Error) => {
        console.error('Sidebar Agent Chat error:', error);
        toast.error('Chat error. Please try again.');
      },
    };
  }, [selectedAgent, agentConversationId, agentTransport, agentInitialMessages]);

  // ============================================
  // Sidebar Chat (custom hook - unified interface)
  // ============================================
  const {
    messages,
    sendMessage,
    status,
    error,
    clearError,
    regenerate,
    setMessages,
    stop,
    isStreaming,
    setGlobalMessages,
  } = usePageAgentSidebarChat({
    selectedAgent,
    globalChatConfig,
    agentChatConfig,
  });

  // ============================================
  // Dashboard Streaming State (for agent mode sync)
  // ============================================
  const dashboardIsStreaming = usePageAgentDashboardStore(state => state.isAgentStreaming);
  const dashboardStopStreaming = usePageAgentDashboardStore(state => state.agentStopStreaming);

  // ============================================
  // Derived State
  // ============================================
  const currentConversationId = selectedAgent ? agentConversationId : globalConversationId;
  const isInitialized = selectedAgent ? agentIsInitialized : globalIsInitialized;
  const assistantName = selectedAgent ? selectedAgent.title : 'Global Assistant';
  const displayIsStreaming = selectedAgent
    ? (isStreaming || dashboardIsStreaming)
    : (isStreaming || contextIsStreaming);

  // ============================================
  // Remote Streams (multiplayer rendering)
  // ============================================
  // Global mode bootstrap+socket runs in GlobalChatProvider above this
  // component; agent mode runs via useAgentChannelMultiplayer below. Either
  // way this selector just reads the store and the pure helper picks the
  // right channel + applies the conversation filter.
  const { user } = useAuth();
  const channelIdForGlobal = user?.id ? globalChannelId(user.id) : null;
  const remoteStreams = usePendingStreamsStore(
    useShallow((state) =>
      selectChannelRemoteStreams(state, {
        selectedAgent,
        agentConversationId,
        globalChannelId: channelIdForGlobal,
        globalConversationId,
      }),
    ),
  );

  const remoteStreamingUser = !displayIsStreaming
    ? remoteStreams.find((s) => !s.isOwn)?.triggeredBy ?? null
    : null;

  // Agent-mode wiring (Tasks 4 + 5 + 6 for the sidebar). No-op when
  // selectedAgent is null. Joins the agent socket room, bootstrap-replays
  // in-flight streams, claims the dashboard stop slot under co-mount safety,
  // registers `ai-channel-${agent.id}` with the editing store (same key as
  // GlobalAssistantView agent mode → natural same-channel de-dup), and
  // re-fetches the active conversation on socket reconnect.
  useAgentChannelMultiplayer({
    selectedAgent,
    agentConversationId,
    setLocalMessages: setMessages,
    isLocallyStreaming: isStreaming,
    surfaceComponentName: 'SidebarChatTab',
    loadConversation: loadSidebarAgentConversation,
  });

  const streamingAssistantText = useMemo(() => {
    if (!displayIsStreaming) return null;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return null;
    return (last.parts ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('');
  }, [messages, displayIsStreaming]);

  // Effect-based handoff for pending send → streaming transition
  const { wrapSend } = useSendHandoff(currentConversationId, status);

  // ============================================
  // Centralized Assistant Settings (from store)
  // ============================================
  const showPageTree = useAssistantSettingsStore((state) => state.showPageTree);
  const currentProvider = useAssistantSettingsStore((state) => state.currentProvider);
  const currentModel = useAssistantSettingsStore((state) => state.currentModel);
  const setProviderSettings = useAssistantSettingsStore((state) => state.setProviderSettings);
  const loadSettings = useAssistantSettingsStore((state) => state.loadSettings);

  // ============================================
  // Local Component State
  // ============================================
  const [input, setInput] = useState<string>('');
  const [showError, setShowError] = useState(true);
  const [locationContext, setLocationContext] = useState<LocationContext | null>(null);
  const [undoDialogMessageId, setUndoDialogMessageId] = useState<string | null>(null);
  const [lastAIResponse, setLastAIResponse] = useState<{ id: string; text: string } | null>(null);
  // undefined = uninitialized, null = initialized with no baseline message, string = baseline message ID
  const voiceBaselineRef = useRef<string | null | undefined>(undefined);

  // Global-mode load-on-select state: tracks in-progress DB fetches and their
  // failures so the sidebar never shows a silent blank on conversation select.
  const [isLoadingGlobalMessages, setIsLoadingGlobalMessages] = useState(false);
  const [globalMessagesLoadError, setGlobalMessagesLoadError] = useState<Error | null>(null);
  // Stale-request guard: holds the conversationId of the most recent load request.
  const globalLoadRequestedIdRef = useRef<string | null>(null);

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

  // Get web search and write mode from store
  const webSearchEnabled = useAssistantSettingsStore((state) => state.webSearchEnabled);
  const writeMode = useAssistantSettingsStore((state) => state.writeMode);

  // Refs
  const chatInputRef = useRef<ChatInputRef>(null);

  // ============================================
  // Effects: Drive Loading
  // ============================================
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  // ============================================
  // Effects: Location Context Extraction
  // ============================================
  useEffect(() => {
    const extractLocationContext = async () => {
      const pathParts = pathname.split('/').filter(Boolean);

      if (pathParts.length >= 2 && pathParts[0] === 'dashboard') {
        const driveId = pathParts[1];

        try {
          let currentPage = null;
          let currentDrive = null;

          if (driveId) {
            const currentDrives = useDriveStore.getState().drives;
            const driveData = currentDrives.find(d => d.id === driveId);
            if (driveData) {
              currentDrive = {
                id: driveData.id,
                slug: driveData.slug,
                name: driveData.name
              };
            }
          }

          if (pathParts.length > 2) {
            const pageId = pathParts[2];

            try {
              const pageResponse = await fetchWithAuth(`/api/pages/${pageId}`);
              if (pageResponse.ok) {
                const pageData = await pageResponse.json();

                try {
                  const breadcrumbsResponse = await fetchWithAuth(`/api/pages/${pageId}/breadcrumbs`);
                  if (breadcrumbsResponse.ok) {
                    const breadcrumbsData = await breadcrumbsResponse.json();
                    const pathSegments = breadcrumbsData.map((crumb: { title: string }) => crumb.title);
                    const fullPath = `/${currentDrive?.slug}/${pathSegments.join('/')}`;

                    currentPage = {
                      id: pageData.id,
                      title: pageData.title,
                      type: pageData.type,
                      path: fullPath
                    };
                  } else {
                    currentPage = {
                      id: pageData.id,
                      title: pageData.title,
                      type: pageData.type,
                      path: `/${currentDrive?.slug}/${pageData.title}`
                    };
                  }
                } catch {
                  currentPage = {
                    id: pageData.id,
                    title: pageData.title,
                    type: pageData.type,
                    path: `/${currentDrive?.slug}/${pageData.title}`
                  };
                }
              } else {
                currentPage = {
                  id: pageId,
                  title: pathParts[pathParts.length - 1].replace(/-/g, ' '),
                  type: 'DOCUMENT',
                  path: `/${currentDrive?.slug}/${pathParts[pathParts.length - 1].replace(/-/g, ' ')}`
                };
              }
            } catch {
              currentPage = {
                id: pageId,
                title: pathParts[pathParts.length - 1].replace(/-/g, ' '),
                type: 'DOCUMENT',
                path: `/${currentDrive?.slug}/${pathParts[pathParts.length - 1].replace(/-/g, ' ')}`
              };
            }
          }

          const breadcrumbs = [];
          if (currentDrive) {
            breadcrumbs.push(currentDrive.name);
          }
          if (currentPage && currentPage.path) {
            const pathParts = currentPage.path.split('/').filter(Boolean);
            breadcrumbs.push(...pathParts.slice(1));
          }

          setLocationContext({ currentPage, currentDrive, breadcrumbs });
        } catch {
          setLocationContext(null);
        }
      } else {
        setLocationContext(null);
      }
    };

    extractLocationContext();
  }, [pathname]);

  // ============================================
  // Effects: Global Mode Sync to Context
  // ============================================
  // GlobalAssistantView is the PRIMARY syncer for global mode state (messages,
  // streaming status, stop function). The sidebar READS from context but does
  // not write back, preventing duplicate sync effects and race conditions.

  // ============================================
  // Effects: Editing Store Registration
  // ============================================
  useStreamingRegistration(
    `assistant-sidebar-${currentConversationId || 'init'}`,
    status === 'submitted' || status === 'streaming',
    { conversationId: currentConversationId || undefined, componentName: 'SidebarChatTab' }
  );

  // Fetches the latest DB messages for the active global conversation and writes
  // them to the useChat instance via setGlobalMessages. Single writer for the
  // global-mode server→view path; shared by the load-on-select effect, the
  // refreshSignal handler, and the retry button.
  //
  // NOTE: prod runs multiple web instances — live tokens from a stream on another
  // instance won't be in the pending store; the persisted message still shows up
  // on the next DB load. Cross-instance live-token rejoin is a known follow-up.
  const loadGlobalMessages = useCallback((conversationId: string) => {
    globalLoadRequestedIdRef.current = conversationId;
    setIsLoadingGlobalMessages(true);
    setGlobalMessagesLoadError(null);

    fetchWithAuth(`/api/ai/global/${conversationId}/messages`)
      .then(async (res) => {
        if (!shouldApplyLoadedMessages(conversationId, globalLoadRequestedIdRef.current)) return;
        if (!res.ok) throw new Error(`Failed to load messages (${res.status})`);
        const data = await res.json();
        if (!shouldApplyLoadedMessages(conversationId, globalLoadRequestedIdRef.current)) return;
        const serverMessages: UIMessage[] = Array.isArray(data) ? data : (data.messages ?? []);
        // Reconcile with any in-flight own stream to avoid dropping the streaming bubble.
        const ownStream = Array.from(usePendingStreamsStore.getState().streams.values())
          .find((s) => s.isOwn && s.conversationId === conversationId);
        const merged = ownStream
          ? mergeServerAndPending(serverMessages, ownStream.parts, ownStream.messageId)
          : serverMessages;
        setGlobalMessages(merged);
        setGlobalMessagesLoadError(null);
      })
      .catch((err) => {
        if (!shouldApplyLoadedMessages(conversationId, globalLoadRequestedIdRef.current)) return;
        // Keep prior messages — never silently blank on failure.
        setGlobalMessagesLoadError(err instanceof Error ? err : new Error('Failed to load messages'));
      })
      .finally(() => {
        if (shouldApplyLoadedMessages(conversationId, globalLoadRequestedIdRef.current)) {
          setIsLoadingGlobalMessages(false);
        }
      });
  }, [setGlobalMessages]);

  // When remote events fire (reconnect, undo from another tab, cross-tab
  // edit/delete), GlobalChatContext increments refreshSignal. If
  // GlobalAssistantView is not mounted (user is on a page, not the dashboard),
  // this sidebar is responsible for re-fetching global messages.
  // Routed through loadGlobalMessages so the stale-request guard prevents a
  // race where a slow refreshSignal fetch overwrites a newer conversation's messages.
  const prevSidebarRefreshSignalRef = useRef(refreshSignal);
  const globalIsInitializedRef = useRef(globalIsInitialized);
  globalIsInitializedRef.current = globalIsInitialized;
  useEffect(() => {
    if (refreshSignal === prevSidebarRefreshSignalRef.current) return;
    prevSidebarRefreshSignalRef.current = refreshSignal;
    if (!selectedAgent && globalIsInitializedRef.current && globalConversationId && !displayIsStreaming) {
      loadGlobalMessages(globalConversationId);
    }
  }, [refreshSignal, selectedAgent, globalConversationId, displayIsStreaming, loadGlobalMessages]);

  // Load-on-select guarantee for global mode (1B).
  //
  // Whenever the active global conversation changes (or the context finishes
  // initialising), explicitly fetch the latest DB messages and write them
  // directly to the useChat instance via setGlobalMessages. This does NOT rely
  // on GlobalChatContext seeding useChat via chatConfig.messages (which only
  // fires on the useChat `id` prop changing — a path prone to timing gaps when
  // the conversation id is the same across refreshes).
  useEffect(() => {
    if (selectedAgent) return; // agent mode handled by useAgentChannelMultiplayer
    if (!globalIsInitialized || !globalConversationId) return;
    loadGlobalMessages(globalConversationId);
  }, [globalConversationId, globalIsInitialized, selectedAgent, loadGlobalMessages]);

  // ============================================
  // Effects: UI State
  // ============================================

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
        displayIsStreaming && lastOverallMsg?.role === 'assistant'
          ? assistantMsgs.length - 1
          : assistantMsgs.length;
      const baselineMsg = assistantMsgs[streamingAssistantIdx - 1];
      voiceBaselineRef.current = baselineMsg?.id ?? null;
      return;
    }

    if (displayIsStreaming) return;

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
  }, [messages, displayIsStreaming, isVoiceModeActive]);

  // App state recovery - refresh messages when returning from background
  // This catches completed AI responses that finished while the app was backgrounded
  const handleAppResume = useCallback(async () => {
    if (selectedAgent) {
      await refreshAgentConversation();
    } else if (globalConversationId && globalIsInitialized) {
      try {
        const res = await fetchWithAuth(`/api/ai/global/${globalConversationId}/messages`);
        if (res.ok) {
          const data = await res.json();
          setGlobalMessages(data.messages);
        }
      } catch (err) {
        console.error('Failed to refresh global messages after resume:', err);
      }
    }
  }, [selectedAgent, refreshAgentConversation, globalConversationId, globalIsInitialized, setGlobalMessages]);

  useAppStateRecovery({
    onResume: handleAppResume,
    // Block recovery if streaming OR pending send OR any editing active
    enabled: !isStreaming && currentConversationId !== null && !isEditingActive(),
  });

  // Clean up stream tracking on unmount or conversation change
  // Use ref to capture current ID so cleanup clears the correct stream
  const prevConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    // Clear previous conversation's stream ID when switching conversations
    if (prevConversationIdRef.current && prevConversationIdRef.current !== currentConversationId) {
      clearActiveStreamId({ chatId: prevConversationIdRef.current });
    }
    prevConversationIdRef.current = currentConversationId;

    return () => {
      if (currentConversationId) {
        clearActiveStreamId({ chatId: currentConversationId });
      }
    };
  }, [currentConversationId]);

  // ============================================
  // Effects: Initialize Settings Store
  // ============================================
  useEffect(() => {
    // Load provider settings from centralized store on mount
    loadSettings();
  }, [loadSettings]);

  // ============================================
  // Handlers
  // ============================================

  const handleRetryGlobalMessageLoad = useCallback(() => {
    if (selectedAgent || !globalConversationId || !globalIsInitialized) return;
    loadGlobalMessages(globalConversationId);
  }, [selectedAgent, globalConversationId, globalIsInitialized, loadGlobalMessages]);

  const handleNewConversation = useCallback(async () => {
    try {
      if (selectedAgent) {
        await createAgentConversation();
        setMessages([]);
      } else {
        await createGlobalConversation();
      }
    } catch {
      toast.error('Failed to create new conversation');
    }
  }, [selectedAgent, createAgentConversation, createGlobalConversation, setMessages]);

  const handleSendMessage = useCallback(async () => {
    const files = getFilesForSend();
    if ((!input.trim() && files.length === 0) || !currentConversationId) return;

    // Derive isReadOnly from writeMode (inverted)
    const isReadOnly = !writeMode;

    const body = selectedAgent
      ? {
          chatId: selectedAgent.id,
          conversationId: agentConversationId,
          isReadOnly,
          webSearchEnabled,
          provider: selectedAgent.aiProvider,
          model: selectedAgent.aiModel,
          systemPrompt: selectedAgent.systemPrompt,
          locationContext: locationContext || undefined,
          enabledTools: selectedAgent.enabledTools,
        }
      : {
          isReadOnly,
          webSearchEnabled,
          showPageTree,
          locationContext: locationContext || undefined,
          selectedProvider: currentProvider,
          selectedModel: currentModel,
        };

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    wrapSend(() => sendMessage({ text: input, files: files.length > 0 ? files : undefined }, { body }));
    setInput('');
    clearFiles();
    // Note: scrollToBottom is now handled by use-stick-to-bottom when pinned
  }, [
    input,
    currentConversationId,
    selectedAgent,
    agentConversationId,
    writeMode,
    webSearchEnabled,
    showPageTree,
    locationContext,
    currentProvider,
    currentModel,
    sendMessage,
    getFilesForSend,
    clearFiles,
    wrapSend,
  ]);

  // Voice mode: Send message from voice transcript
  const handleVoiceSend = useCallback((text: string) => {
    if (!text.trim() || !currentConversationId) return;

    const isReadOnly = !writeMode;

    const body = selectedAgent
      ? {
          chatId: selectedAgent.id,
          conversationId: agentConversationId,
          isReadOnly,
          webSearchEnabled,
          provider: selectedAgent.aiProvider,
          model: selectedAgent.aiModel,
          systemPrompt: selectedAgent.systemPrompt,
          locationContext: locationContext || undefined,
          enabledTools: selectedAgent.enabledTools,
        }
      : {
          isReadOnly,
          webSearchEnabled,
          showPageTree,
          locationContext: locationContext || undefined,
          selectedProvider: currentProvider,
          selectedModel: currentModel,
        };

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    wrapSend(() => sendMessage({ text }, { body }));
  }, [
    currentConversationId,
    selectedAgent,
    agentConversationId,
    writeMode,
    webSearchEnabled,
    showPageTree,
    locationContext,
    currentProvider,
    currentModel,
    sendMessage,
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

  const unifiedSetMessages = useCallback(
    (msgs: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => {
      setMessages(msgs);
    },
    [setMessages]
  );

  const { handleEdit, handleDelete, handleRetry, lastAssistantMessageId, lastUserMessageId } =
    useMessageActions({
      agentId: selectedAgent?.id || null,
      conversationId: currentConversationId,
      messages,
      setMessages: unifiedSetMessages,
      regenerate,
    });

  // Auto-retry on network errors (e.g. ERR_NETWORK_CHANGED killing mid-stream)
  useStreamRecovery({ error, status, clearError, handleRetry, maxRetries: 2 });

  // Adapter for AgentSelector (converts SidebarAgentInfo to AgentInfo shape)
  const handleSelectAgent = useCallback((agent: SidebarAgentInfo | null) => {
    selectAgent(agent);
  }, [selectAgent]);

  // Stop handler that uses appropriate stop function based on mode
  // All stop functions call both abort endpoint (server-side) and useChat stop (client-side)
  const handleStop = useCallback(async () => {
    // Use the appropriate stop function based on mode
    if (!selectedAgent && contextStopStreaming) {
      // Global mode: use context stop function (already calls abort endpoint)
      contextStopStreaming();
    } else if (selectedAgent && dashboardStopStreaming) {
      // Agent mode: use dashboard store stop function (already calls abort endpoint)
      dashboardStopStreaming();
    } else {
      // Fallback (live stream, no bootstrap-registered stop): stop the local fetch
      // first, then abort authoritatively by the stable assistant messageId — this
      // reaches the server registry even if the conversation id shifted mid-stream
      // and tears down any multicast SSE join. Fall back to the chatId map only when
      // no assistant id exists yet (submitted, before the first chunk).
      stop();
      const messageId = resolveActiveAssistantMessageId({
        ownStreamMessageId: undefined,
        isStreaming,
        lastAssistantMessageId,
      });
      if (messageId) {
        void abortActiveStreamByMessageId({ messageId });
        return;
      }
      if (currentConversationId) {
        await abortActiveStream({ chatId: currentConversationId });
      }
    }
  }, [
    selectedAgent,
    contextStopStreaming,
    dashboardStopStreaming,
    currentConversationId,
    stop,
    isStreaming,
    lastAssistantMessageId,
  ]);

  const handleUndoFromHere = useCallback((messageId: string) => {
    setUndoDialogMessageId(messageId);
  }, []);

  const handleUndoSuccess = useCallback(async () => {
    setUndoDialogMessageId(null);
    if (!currentConversationId) return;
    if (selectedAgent) {
      // Agent mode: direct fetch (loadGlobalMessages is global-only).
      try {
        const res = await fetchWithAuth(
          `/api/ai/page-agents/${selectedAgent.id}/conversations/${currentConversationId}/messages`,
        );
        if (res.ok) {
          const data = await res.json();
          setMessages(data.messages);
        }
      } catch (error) {
        console.error('Failed to refresh messages after undo:', error);
      }
    } else {
      // Global mode: route through loadGlobalMessages for stale guard + pending merge.
      loadGlobalMessages(currentConversationId);
    }
  }, [currentConversationId, selectedAgent, setMessages, loadGlobalMessages]);

  // ============================================
  // Computed Values for Rendering
  // ============================================

  // Use messages from the useChat hook directly for both modes.
  // Previously used contextMessages for global mode, but this added an extra layer of
  // indirection through sync effects that could cause race conditions and state snapping.
  // The useChat hook with the same ID shares state via SWR, so all components see the same messages.
  const displayMessages = messages;

  // ============================================
  // Render
  // ============================================
  if (!isInitialized) {
    return (
      <div className="flex flex-col h-full p-4">
        <div className="flex-grow flex items-center justify-center">
          <div className="flex items-center space-x-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading {assistantName}...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex flex-col border-b border-gray-200 dark:border-[var(--separator)] bg-card">
        <div className="flex items-center justify-between p-2">
          <AISelector
            selectedAgent={selectedAgent}
            onSelectAgent={handleSelectAgent}
            disabled={isStreaming}
            className="text-sm font-medium"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleNewConversation}
            className="h-7 px-2"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        {(currentConversationId || selectedAgent) && (
          <div className="flex items-center justify-between px-2 pb-2">
            {displayPreferences.showTokenCounts && (
              <AiUsageMonitor
                conversationId={selectedAgent ? undefined : currentConversationId}
                pageId={selectedAgent ? selectedAgent.id : undefined}
                compact
              />
            )}
            <TasksDropdown messages={displayMessages} driveId={locationContext?.currentDrive?.id} />
          </div>
        )}
      </div>

      {/* Global-mode message-load error — shown above messages so it's always visible. */}
      {!selectedAgent && globalMessagesLoadError && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-destructive/10 text-destructive text-xs border-b border-destructive/20">
          <span className="truncate">Failed to load messages</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={handleRetryGlobalMessageLoad}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Messages - using use-stick-to-bottom for pinned scrolling */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden" style={{ contain: 'layout' }}>
        {/* Loading indicator during global-mode message fetch (prevents blank). */}
        {!selectedAgent && isLoadingGlobalMessages && displayMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Conversation className="h-full">
            <SidebarMessagesContent
              messages={displayMessages}
              assistantName={assistantName}
              locationContext={locationContext}
              handleEdit={handleEdit}
              handleDelete={handleDelete}
              handleRetry={handleRetry}
              handleUndoFromHere={handleUndoFromHere}
              lastAssistantMessageId={lastAssistantMessageId}
              lastUserMessageId={lastUserMessageId}
              displayIsStreaming={displayIsStreaming}
              remoteStreams={remoteStreams}
            />
            {/* Scroll-to-bottom button - visible when user scrolls up */}
            <ConversationScrollButton className="z-10 bottom-8" />
          </Conversation>
        )}
      </div>

      {/* Input - adds keyboard height padding on mobile to stay above keyboard */}
      <div
        className="border-t p-3 space-y-2 min-w-0 overflow-hidden transition-[padding-bottom] duration-200"
        style={{
          paddingBottom: isKeyboardOpen ? `calc(0.75rem + ${keyboardHeight}px)` : undefined,
        }}
      >
        <ChatErrorBanner
          error={error}
          show={showError}
          onClearError={() => setShowError(false)}
        />

        <div className="px-1">
          <ProviderModelSelector
            provider={currentProvider}
            model={currentModel}
            onChange={setProviderSettings}
            disabled={status === 'streaming'}
          />
        </div>

        {isVoiceModeActive && (
          <VoiceCallPanel
            owner={VOICE_OWNER}
            onSend={handleVoiceSend}
            latestAssistantMessage={lastAIResponse}
            isAIStreaming={displayIsStreaming}
            streamingText={streamingAssistantText}
            onStopStream={handleStop}
            onClose={disableVoiceMode}
          />
        )}
        <ChatInput
          ref={chatInputRef}
          value={input}
          onChange={setInput}
          onSend={handleSendMessage}
          onStop={handleStop}
          isStreaming={displayIsStreaming}
          placeholder={locationContext
            ? `Ask about ${locationContext.currentPage?.title || 'this page'}...`
            : 'Ask about your workspace...'}
          driveId={locationContext?.currentDrive?.id}
          crossDrive={true}
          hideModelSelector={true}
          variant="sidebar"
          onVoiceModeClick={handleVoiceModeToggle}
          isVoiceModeActive={isVoiceModeActive}
          attachments={attachments}
          onAddFiles={addFiles}
          onRemoveFile={removeFile}
          hasVision={hasVisionCapability(
            (selectedAgent ? selectedAgent.aiModel : currentModel) || ''
          )}
          remoteStreamingUser={remoteStreamingUser}
        />
      </div>

      <UndoAiChangesDialog
        open={!!undoDialogMessageId}
        onOpenChange={(open) => !open && setUndoDialogMessageId(null)}
        messageId={undoDialogMessageId}
        onSuccess={handleUndoSuccess}
      />
    </div>
  );
};

export default React.memo(SidebarChatTab);
