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
import { usePageAgentDashboardStore, selectIsAgentStreaming, selectAgentStop } from '@/stores/page-agents';
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
import { parseTabPath, getStaticTabMeta } from '@/lib/tabs/tab-title';
import { abortActiveStream, abortActiveStreamByMessageId, clearActiveStreamId, reportAbortOutcome } from '@/lib/ai/core/client';
import { resolveActiveAssistantMessageId } from '@/lib/ai/streams/resolveActiveAssistantMessageId';
import { holdForStream } from '@/lib/ai/streams/holdForStream';
import { useChatTransport, useStreamingRegistration, useSendHandoff, useMessageActions, useStreamRecovery, useAskUserAnswering, buildChatConfig, SIDEBAR_AGENT_CHAT_ID, buildGlobalChatRequestBody } from '@/lib/ai/shared';
import { AskUserAnswerProvider } from '@/components/ai/shared/chat/ask-user/AskUserAnswerContext';
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard';
import { useAppStateRecovery } from '@/hooks/useAppStateRecovery';
import { VoiceCallPanel } from '@/components/ai/voice/VoiceCallPanel';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';
import { useEditingStore } from '@/stores/useEditingStore';
import { ChatErrorBanner } from '@/components/ai/shared/chat/ChatErrorBanner';
import { shouldApplyLoadedMessages } from '@/lib/ai/streams/shouldApplyLoadedMessages';
import { mergeServerAndPending } from '@/lib/ai/streams/mergeServerAndPending';
import { decideRecovery } from '@/lib/ai/streams/decideRecovery';

const VOICE_OWNER: VoiceModeOwner = 'sidebar-chat';

// Threshold for enabling virtualization in sidebar (lower than main chat due to compact items)
const SIDEBAR_VIRTUALIZATION_THRESHOLD = 30;

/**
 * Inner component for rendering messages with access to stick-to-bottom context
 */
export interface SidebarMessagesContentProps {
  messages: UIMessage[];
  assistantName: string;
  /** Human-readable label for the current location, shown in the empty state. */
  contextLabel: string | null;
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
  contextLabel,
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
              {contextLabel
                ? `Context-aware help for ${contextLabel}`
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
          message={synthesizeAssistantMessage(stream.messageId, stream.parts, stream.startedAt)}
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
    isMessagesLoading: globalIsMessagesLoading,
    initialMessages: globalInitialMessages,
    createNewConversation: createGlobalConversation,
    refreshSignal,
    rejoinGlobalStream,
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
    isMessagesLoading: agentIsMessagesLoading,
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
  const agentTransport = useChatTransport(sidebarChatId, '/api/ai/chat', selectedAgent?.id ?? null);

  const agentChatConfig = useMemo(() => {
    if (!selectedAgent || !agentConversationId || !agentTransport) return null;

    return buildChatConfig({
      id: SIDEBAR_AGENT_CHAT_ID,
      transport: agentTransport,
      onError: (error: Error) => {
        console.error('Sidebar Agent Chat error:', error);
        toast.error('Chat error. Please try again.');
      },
    });
  }, [selectedAgent, agentConversationId, agentTransport]);

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
    addToolResult,
  } = usePageAgentSidebarChat({
    selectedAgent,
    globalChatConfig,
    agentChatConfig,
  });

  // ============================================
  // Dashboard Streaming State (for agent mode sync)
  // ============================================
  // Scoped to THIS surface's agent. The dashboard holds a different one (its agent comes
  // from usePageAgentDashboardStore; ours comes from useSidebarAgentStore), and
  // GlobalAssistantView never unmounts — CenterPanel only hides it — so after one dashboard
  // visit we are co-mounted with it on every page. Reading the slot unscoped meant a stream
  // on the dashboard's agent B lit up OUR Stop button for agent A, and clicking it aborted
  // B while A kept generating and kept billing.
  // Named by (agent, conversation). The dashboard holds a different agent — and, for the
  // SAME agent, a different conversation (each surface keeps its own; "New Chat" in either
  // diverges them). With either half missing the store answers a question we did not ask:
  // a dashboard stream on conv X2 lighting up OUR Stop while we are showing conv X1.
  const dashboardStreamKey = { agentId: selectedAgent?.id, conversationId: agentConversationId };
  const dashboardIsStreaming = usePageAgentDashboardStore(selectIsAgentStreaming(dashboardStreamKey));
  const dashboardStopStreaming = usePageAgentDashboardStore(selectAgentStop(dashboardStreamKey));

  // ============================================
  // Derived State
  // ============================================
  const currentConversationId = selectedAgent ? agentConversationId : globalConversationId;
  const isInitialized = selectedAgent ? agentIsInitialized : globalIsInitialized;
  // Identity can be 'ready' (isInitialized true) while messages for the
  // conversation just switched to are still in flight — decoupled from
  // identity resolution so a switch doesn't flash the previous conversation's
  // messages under the new one with no loading indicator.
  const isMessagesLoading = selectedAgent ? agentIsMessagesLoading : globalIsMessagesLoading;
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
  const { rejoinActiveStreams: rejoinAgentStream } = useAgentChannelMultiplayer({
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
  const [contextLabel, setContextLabel] = useState<string | null>(null);
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
  // Synchronously updated each render — lets tryRecover read the live message
  // count without adding messages to its useCallback deps.
  const currentMessagesRef = useRef(messages);
  currentMessagesRef.current = messages;

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
  const imageGenEnabled = useAssistantSettingsStore((state) => state.imageGenEnabled);
  const writeMode = useAssistantSettingsStore((state) => state.writeMode);

  // Refs
  const chatInputRef = useRef<ChatInputRef>(null);

  // ============================================
  // Effects: Drive Loading
  // ============================================
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  // Subscribe to drives so the location-context effect re-runs once the store
  // populates (drive labels would otherwise stay null until the next nav).
  const drives = useDriveStore((state) => state.drives);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  // ============================================
  // Effects: Location Context Extraction
  // ============================================
  useEffect(() => {
    // Capture the pathname this run is resolving for, so async branches can
    // bail if the user navigated away before they completed.
    const activePathname = pathname;
    let ignore = false;

    const resolveDrive = (driveId: string | undefined) => {
      if (!driveId) return null;
      const driveData = drives.find(d => d.id === driveId);
      return driveData
        ? { id: driveData.id, slug: driveData.slug, name: driveData.name }
        : null;
    };

    const fetchPageContext = async (
      pageId: string,
      currentDrive: { id: string; slug: string; name: string } | null
    ) => {
      try {
        const pageResponse = await fetchWithAuth(`/api/pages/${pageId}`);
        if (!pageResponse.ok) return null;
        const pageData = (await pageResponse.json()) as { id: string; title: string; type: string };

        // Only prefix the drive slug when we actually have one — channel routes
        // resolve no drive, so a bare `/${slug}` would bake "/undefined/..." into
        // the path that gets sent to the AI.
        const slugPrefix = currentDrive?.slug ? `/${currentDrive.slug}` : '';
        let path = `${slugPrefix}/${pageData.title}`;
        try {
          const breadcrumbsResponse = await fetchWithAuth(`/api/pages/${pageId}/breadcrumbs`);
          if (breadcrumbsResponse.ok) {
            const breadcrumbsData = (await breadcrumbsResponse.json()) as Array<{ title: string }>;
            const pathSegments = breadcrumbsData.map((crumb) => crumb.title);
            path = `${slugPrefix}/${pathSegments.join('/')}`;
          }
        } catch {
          // Keep the simple path fallback.
        }

        return {
          id: pageData.id,
          title: pageData.title,
          type: pageData.type,
          path,
        };
      } catch {
        return null;
      }
    };

    const extractLocationContext = async () => {
      const parsed = parseTabPath(activePathname);

      let label: string | null = null;
      let currentPage: LocationContext['currentPage'] = null;
      let currentDrive: LocationContext['currentDrive'] = null;

      try {
        switch (parsed.type) {
          // Real page routes — fetch the page so the AI keeps page context.
          case 'page':
          case 'channel': {
            currentDrive = parsed.type === 'page' ? resolveDrive(parsed.driveId) : null;
            if (parsed.pageId) {
              currentPage = await fetchPageContext(parsed.pageId, currentDrive);
            }
            label = currentPage?.title ?? null;
            break;
          }

          // A whole drive — use the drive name from the store.
          case 'drive': {
            currentDrive = resolveDrive(parsed.driveId);
            label = currentDrive?.name ?? null;
            break;
          }

          // A specific DM — show the other person's name (DMs are not pages).
          case 'dm': {
            if (parsed.conversationId) {
              try {
                const res = await fetchWithAuth(`/api/messages/conversations/${parsed.conversationId}`);
                if (res.ok) {
                  const data = (await res.json()) as {
                    conversation?: { otherUser?: { displayName?: string | null; name?: string | null } };
                  };
                  const otherUser = data?.conversation?.otherUser;
                  label = otherUser?.displayName || otherUser?.name || null;
                }
              } catch {
                // Fall through to the generic DM label below.
              }
            }
            if (!label) label = 'Direct Message';
            break;
          }

          // Everything else with a known static title (dms, channels, tasks,
          // calendar, files/drives, activity, drive-scoped variants, …).
          // 'unknown' routes have no meaningful label (getStaticTabMeta would
          // echo the raw path), so fall back to the generic prompt.
          default: {
            label = parsed.type === 'unknown' ? null : getStaticTabMeta(parsed)?.title ?? null;
            break;
          }
        }
      } catch {
        label = null;
      }

      if (ignore) return;

      const breadcrumbs: string[] = [];
      if (currentDrive) breadcrumbs.push(currentDrive.name);
      if (currentPage?.path) {
        breadcrumbs.push(...currentPage.path.split('/').filter(Boolean).slice(1));
      }

      setContextLabel(label);
      setLocationContext(
        currentPage || currentDrive ? { currentPage, currentDrive, breadcrumbs } : null
      );
    };

    extractLocationContext();

    return () => {
      ignore = true;
    };
  }, [pathname, drives]);

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
          ? mergeServerAndPending(serverMessages, ownStream.parts, ownStream.messageId, ownStream.startedAt)
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
    enabled: !isStreaming && currentConversationId !== null && !useEditingStore.getState().isAnyEditing(),
  });

  // Clean up stream tracking on unmount or conversation change.
  //
  // Keyed by `sidebarChatId` — THE KEY THIS SURFACE ACTUALLY REGISTERED. It used to clear the bare
  // `currentConversationId`, which this surface never writes: the sidebar's transport registers
  // under the namespaced `sidebar:<convId>` (see sidebarChatId — the namespace exists precisely so
  // the sidebar and the dashboard can view the same conversation without colliding). So the old
  // cleanup did both halves of the wrong thing at once: it leaked its own `sidebar:` entry forever,
  // and the bare id it *did* delete belongs to ANOTHER surface — in agent mode, the dashboard's
  // transport (`useChatTransport(agentConversationId, …)`).
  //
  // Concretely: dashboard streaming on agent A / conversation C, sidebar open on the same agent and
  // conversation. Collapse the sidebar → this cleanup ran → the DASHBOARD's streamId entry vanished
  // → its pre-first-chunk Stop became a map miss and the server kept generating.
  //
  // A surface may only free what it allocated.
  const prevSidebarChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSidebarChatIdRef.current && prevSidebarChatIdRef.current !== sidebarChatId) {
      clearActiveStreamId({ chatId: prevSidebarChatIdRef.current });
    }
    prevSidebarChatIdRef.current = sidebarChatId;

    return () => {
      if (sidebarChatId) {
        clearActiveStreamId({ chatId: sidebarChatId });
      }
    };
  }, [sidebarChatId]);

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

  // Load-on-select guarantee for global mode: with a stable useChat id,
  // surfaces must explicitly re-apply messages on conversation load/reselect.
  // The sidebar re-fetches via loadGlobalMessages (includes stale-request
  // guard + own-stream reconciliation). Seeded to `null` so the initial-mount
  // load is also covered by this effect (avoids a second, redundant effect).
  const prevSidebarGlobalMessagesRef = useRef<UIMessage[] | null>(null);
  useEffect(() => {
    if (globalInitialMessages === prevSidebarGlobalMessagesRef.current) return;
    prevSidebarGlobalMessagesRef.current = globalInitialMessages;
    // Guarded the same way as the refreshSignal effect above (line ~615) — without this, a
    // mount/reload/conversation-switch that lands while this surface's own send is already
    // streaming clobbers the in-progress assistant bubble with a stale DB snapshot that
    // predates the reply.
    if (!selectedAgent && globalIsInitialized && globalConversationId && !displayIsStreaming) {
      loadGlobalMessages(globalConversationId);
    }
  }, [globalInitialMessages, selectedAgent, globalIsInitialized, globalConversationId, displayIsStreaming, loadGlobalMessages]);

  // Load-on-select guarantee for agent mode: with a stable useChat id, the
  // sidebar's agent Chat instance is never recreated on conversation switch,
  // so usePageAgentSidebarState's fetched messages must be explicitly applied
  // via setMessages. Seeded to `null` so the initial-mount/agent-select load
  // is also covered by this effect.
  const prevSidebarAgentMessagesRef = useRef<UIMessage[] | null>(null);
  useEffect(() => {
    if (agentInitialMessages === prevSidebarAgentMessagesRef.current) return;
    prevSidebarAgentMessagesRef.current = agentInitialMessages;
    // Same guard as the global-mode load-on-select effect above: a mount/reload/agent-switch
    // that lands mid-stream must not clobber the in-progress assistant bubble with a stale
    // conversation snapshot.
    if (selectedAgent && !displayIsStreaming) {
      setMessages(agentInitialMessages);
    }
  }, [agentInitialMessages, selectedAgent, displayIsStreaming, setMessages]);

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
          imageGenEnabled,
          provider: selectedAgent.aiProvider,
          model: selectedAgent.aiModel,
          systemPrompt: selectedAgent.systemPrompt,
          locationContext: locationContext || undefined,
          enabledTools: selectedAgent.enabledTools,
        }
      : buildGlobalChatRequestBody({
          conversationId: currentConversationId,
          isReadOnly,
          webSearchEnabled,
          imageGenEnabled,
          showPageTree,
          locationContext,
          selectedProvider: currentProvider,
          selectedModel: currentModel,
        });

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
    imageGenEnabled,
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
          imageGenEnabled,
          provider: selectedAgent.aiProvider,
          model: selectedAgent.aiModel,
          systemPrompt: selectedAgent.systemPrompt,
          locationContext: locationContext || undefined,
          enabledTools: selectedAgent.enabledTools,
        }
      : buildGlobalChatRequestBody({
          conversationId: currentConversationId,
          isReadOnly,
          webSearchEnabled,
          imageGenEnabled,
          showPageTree,
          locationContext,
          selectedProvider: currentProvider,
          selectedModel: currentModel,
        });

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    wrapSend(() => sendMessage({ text }, { body }));
  }, [
    currentConversationId,
    selectedAgent,
    agentConversationId,
    writeMode,
    webSearchEnabled,
    imageGenEnabled,
    showPageTree,
    locationContext,
    currentProvider,
    currentModel,
    sendMessage,
    wrapSend,
  ]);

  const buildAskUserAnswerBody = useCallback(() => {
    const isReadOnly = !writeMode;
    return selectedAgent
      ? {
          chatId: selectedAgent.id,
          conversationId: agentConversationId,
          isReadOnly,
          webSearchEnabled,
          imageGenEnabled,
          provider: selectedAgent.aiProvider,
          model: selectedAgent.aiModel,
          systemPrompt: selectedAgent.systemPrompt,
          locationContext: locationContext || undefined,
          enabledTools: selectedAgent.enabledTools,
        }
      : buildGlobalChatRequestBody({
          conversationId: currentConversationId,
          isReadOnly,
          webSearchEnabled,
          imageGenEnabled,
          showPageTree,
          locationContext,
          selectedProvider: currentProvider,
          selectedModel: currentModel,
        });
  }, [
    selectedAgent,
    agentConversationId,
    writeMode,
    webSearchEnabled,
    imageGenEnabled,
    showPageTree,
    locationContext,
    currentProvider,
    currentModel,
    currentConversationId,
  ]);

  const askUserAnswering = useAskUserAnswering({
    messages,
    status,
    addToolResult,
    wrapSend,
    buildBody: buildAskUserAnswerBody,
  });

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

  // The live stream's assistant messageId, captured when the first chunk lands and HELD for the
  // rest of the stream — the STREAM's identity, not the surface's.
  //
  // `lastAssistantMessageId` is derived from the live `messages` array, and `handleNewConversation`
  // below calls `setMessages([])` outright with no streaming guard. So the id vanished at exactly
  // the moment Stop needed it: the abort fell through to the chatId fallback, keyed by the
  // conversation the surface had just switched TO — a map miss. The local fetch stopped, the button
  // looked like it worked, and the SERVER KEPT GENERATING (write tools, billing) against the
  // conversation the user had already left. Streams deliberately survive a client disconnect
  // (see the abort registry), so only an explicit, correctly-keyed abort can stop one.
  //
  // The live value is read ONLY during 'streaming', never 'submitted'. useChat sets
  // status='submitted' BEFORE issuing the request and only pushes the new assistant message
  // inside write(), which flips the status to 'streaming' in the same job. So for the whole
  // submitted window `lastAssistantMessageId` (which has no streaming guard of its own — see
  // useMessageActions) is THE PREVIOUS TURN'S reply. Latching that as "the stream's id" made
  // Stop abort a message that finished minutes ago while the real generation kept running and
  // kept billing — on every turn after the first.
  const isActuallyStreaming = status === 'streaming';
  // The conversation the CURRENT stream belongs to, held from when it starts. The surface moves
  // independently of the stream — switching conversation mid-stream does NOT abort the POST — so
  // the abort must name the conversation the generation is actually running on.
  const heldStreamConvIdRef = useRef<string | null>(null);
  heldStreamConvIdRef.current = holdForStream({
    current: heldStreamConvIdRef.current,
    isStreaming,
    liveValue: currentConversationId,
  });
  const heldStreamMsgIdRef = useRef<string | null>(null);
  heldStreamMsgIdRef.current = holdForStream({
    current: heldStreamMsgIdRef.current,
    isStreaming,
    liveValue: isActuallyStreaming ? (lastAssistantMessageId ?? null) : null,
  });

  // Rejoin-first recovery probe for useStreamRecovery.
  // On a network error (e.g. iOS backgrounding kills the fetch):
  //   1. Check /api/ai/chat/active-streams — if the original run is still live, rejoin it.
  //   2. Else fetch messages from the DB — if the run persisted a reply, surface it.
  //   3. Only fall through to regenerate() when neither path finds anything to recover.
  const tryRecover = useCallback(async (): Promise<boolean> => {
    if (!currentConversationId) return false;
    const channelId = selectedAgent?.id ?? channelIdForGlobal;
    if (!channelId) return false;

    // Step 1: live stream check
    try {
      const res = await fetchWithAuth(
        `/api/ai/chat/active-streams?channelId=${encodeURIComponent(channelId)}`,
      );
      if (res.ok) {
        const data = (await res.json()) as {
          streams?: Array<{ conversationId: string; triggeredBy: { userId: string } }>;
        };
        const hasLiveStream = (data.streams ?? []).some(
          (s) => s.conversationId === currentConversationId && s.triggeredBy.userId === user?.id,
        );
        if (decideRecovery({ hasLiveStream, hasPersistedReply: false }) === 'rejoin') {
          if (selectedAgent) {
            rejoinAgentStream();
          } else {
            rejoinGlobalStream();
          }
          return true;
        }
      }
    } catch { /* network error — fall through to DB check */ }

    // Step 2: DB check for persisted reply for the CURRENT turn.
    // Only accept when the DB has at least as many user messages as we have locally —
    // this guards against the case where the network error fired before the user's
    // message reached the server, making the DB end with the PREVIOUS turn's
    // assistant reply and causing us to silently drop the new user prompt.
    try {
      const url = selectedAgent
        ? `/api/ai/page-agents/${selectedAgent.id}/conversations/${currentConversationId}/messages`
        : `/api/ai/global/${currentConversationId}/messages`;
      const res = await fetchWithAuth(url);
      if (res.ok) {
        const data = await res.json();
        const msgs = (Array.isArray(data) ? data : (data.messages ?? [])) as Array<{ role: string }>;
        const localUserCount = currentMessagesRef.current.filter((m) => m.role === 'user').length;
        const dbUserCount = msgs.filter((m) => m.role === 'user').length;
        const hasPersistedReply =
          msgs.length > 0 &&
          msgs[msgs.length - 1].role === 'assistant' &&
          dbUserCount >= localUserCount;
        if (decideRecovery({ hasLiveStream: false, hasPersistedReply }) === 'refetch') {
          if (selectedAgent) {
            setMessages(data.messages);
          } else {
            setGlobalMessages(data.messages);
          }
          return true;
        }
      }
    } catch { /* network error — fall through to regenerate */ }

    return false;
  }, [
    currentConversationId,
    selectedAgent,
    channelIdForGlobal,
    user,
    rejoinGlobalStream,
    rejoinAgentStream,
    setMessages,
    setGlobalMessages,
  ]);

  // Auto-retry on network errors — rejoin-first, regenerate only as last resort
  useStreamRecovery({ error, status, clearError, handleRetry, maxRetries: 2, tryRecover });

  // Adapter for AgentSelector (converts SidebarAgentInfo to AgentInfo shape)
  const handleSelectAgent = useCallback((agent: SidebarAgentInfo | null) => {
    selectAgent(agent);
  }, [selectAgent]);

  // Stop handler that uses appropriate stop function based on mode
  // All stop functions call both abort endpoint (server-side) and useChat stop (client-side)
  const handleStop = useCallback(async () => {
    // OUR OWN live stream wins. The shared stop (context / dashboard store) belongs to
    // whichever surface installed it, and the two surfaces register under DIFFERENT chatIds
    // — ours is `sidebar:<convId>`, the dashboard's is the bare convId — so the shared stop
    // literally cannot abort a stream we started. Reaching for it first meant clicking Stop
    // aborted the DASHBOARD's stream while ours was never stopped at all: it kept
    // generating, and kept billing. (The dashboard's own dispatcher, useGlobalEffectiveStream,
    // already gets this order right; this one was inverted.)
    //
    // The shared stop is for a stream this surface does NOT locally own — one restored by
    // the bootstrap after a refresh, where there is no local fetch to stop.
    if (isStreaming) {
      // Fall through to the local path below.
    } else if (!selectedAgent && contextStopStreaming) {
      // Global mode, no local stream: a bootstrap-restored stream owns the context stop.
      contextStopStreaming();
      return;
    } else if (selectedAgent && dashboardStopStreaming) {
      // Agent mode, no local stream: a bootstrap-restored stream owns the dashboard stop.
      dashboardStopStreaming();
      return;
    }
    {
      // Fallback (live stream, no bootstrap-registered stop): stop the local fetch
      // first, then abort authoritatively by the stable assistant messageId — this
      // reaches the server registry even if the conversation id shifted mid-stream
      // and tears down any multicast SSE join. Fall back to the chatId map only when
      // no assistant id exists yet (submitted, before the first chunk).
      stop();
      // Read the HELD id at call time — see heldStreamMsgIdRef. `lastAssistantMessageId` is the
      // live array's, and it is gone the moment the surface switches conversation mid-stream.
      const messageId = resolveActiveAssistantMessageId({
        ownStreamMessageId: heldStreamMsgIdRef.current ?? undefined,
        // 'streaming', NOT the looser isStreaming (which includes 'submitted'). During submitted
        // the array's last assistant message is the previous turn's — see isActuallyStreaming.
        isStreaming: isActuallyStreaming,
        lastAssistantMessageId,
      });
      if (messageId) {
        // The outcome matters now: a stream that could NOT be confirmed stopped is still
        // generating, still calling write tools, and still billing — and the user must be told,
        // because this UI has already flipped back to Send.
        void abortActiveStreamByMessageId({ messageId }).then(reportAbortOutcome);
        return;
      }
      // Key by the TRANSPORT's chatId, not the bare conversation id. In agent mode the
      // transport registers the streamId under `sidebar:<convId>` (see sidebarChatId — the
      // namespace exists so the sidebar and the dashboard can view the same conversation
      // without colliding in the activeStreams map). Aborting under the bare id was a map
      // miss: the local fetch stopped, but the SERVER kept generating and kept billing,
      // because the abort registry deliberately lets streams survive a client disconnect.
      // Reachable in the pre-first-chunk window, where there is no assistant messageId yet
      // and this fallback is the only route to a server-side abort.
      // Name the CONVERSATION as well as the transport key. The chatId map is empty until the
      // response headers land (0.5-3s into a real send) and is torn down by the conversation-change
      // cleanup on a mid-stream switch — so on both of the paths a user actually takes, the chatId
      // abort was a guaranteed no-op. It cancelled the local fetch and returned, while the server
      // (which deliberately survives client disconnect) kept generating and kept billing.
      const abortChatId = selectedAgent ? sidebarChatId : currentConversationId;
      const abortConversationId = heldStreamConvIdRef.current ?? currentConversationId;
      if (abortChatId) {
        reportAbortOutcome(await abortActiveStream({ chatId: abortChatId, conversationId: abortConversationId }));
      } else if (abortConversationId) {
        reportAbortOutcome(await abortActiveStream({ chatId: abortConversationId, conversationId: abortConversationId }));
      }
    }
  }, [
    selectedAgent,
    contextStopStreaming,
    dashboardStopStreaming,
    currentConversationId,
    sidebarChatId,
    stop,
    isStreaming,
    // The callback READS this (it is what keeps Stop from resolving the previous turn's
    // messageId during the submitted window). Omitting it meant the memo only happened to stay
    // fresh because lastAssistantMessageId co-varies on the submitted -> streaming transition —
    // an accident, not a guarantee. It is one refactor away from Stop silently capturing a stale
    // value and aborting the wrong message while the real generation keeps billing.
    isActuallyStreaming,
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
  // useChat instances are independent (no shared state). GlobalAssistantView and
  // SidebarChatTab each manage their own useChat and sync via explicit fetch + setMessages.
  const displayMessages = messages;

  // ============================================
  // Render
  // ============================================
  if (!isInitialized || isMessagesLoading) {
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
    <AskUserAnswerProvider value={askUserAnswering}>
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
              contextLabel={contextLabel}
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
          placeholder={`Ask about ${contextLabel ?? 'your workspace'}...`}
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
    </AskUserAnswerProvider>
  );
};

export default React.memo(SidebarChatTab);
