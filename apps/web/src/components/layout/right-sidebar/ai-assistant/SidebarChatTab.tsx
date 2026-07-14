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
import { resolveLocationContext } from '@/lib/ai/shared/resolveLocationContext';
import { buildContextRef, type ContextRef } from '@/lib/ai/shared/buildContextRef';
import { abortActiveStream, abortActiveStreamByMessageId, clearActiveStreamId, reportAbortOutcome } from '@/lib/ai/core/client';
import { resolveActiveAssistantMessageId } from '@/lib/ai/streams/resolveActiveAssistantMessageId';
import { holdForStream } from '@/lib/ai/streams/holdForStream';
import { useChatTransport, useStreamingRegistration, useSendHandoff, useMessageActions, useStreamRecovery, useAskUserAnswering, buildChatConfig, SIDEBAR_AGENT_CHAT_ID, buildGlobalChatRequestBody } from '@/lib/ai/shared';
import { AskUserAnswerProvider } from '@/components/ai/shared/chat/ask-user/AskUserAnswerContext';
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard';
import { useAppStateRecovery } from '@/hooks/useAppStateRecovery';
import { isCapacitorApp } from '@/hooks/useCapacitor';
import { resolveResumeAction } from '@/lib/ai/streams/resolveResumeAction';
import { VoiceCallPanel } from '@/components/ai/voice/VoiceCallPanel';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';
import { useEditingStore } from '@/stores/useEditingStore';
import { ChatErrorBanner } from '@/components/ai/shared/chat/ChatErrorBanner';
import { shouldApplyLoadedMessages } from '@/lib/ai/streams/shouldApplyLoadedMessages';
import { selectMessagesAreaMode } from '@/lib/ai/streams/selectMessagesAreaMode';
import { mergeServerAndPending } from '@/lib/ai/streams/mergeServerAndPending';
import { decideRecovery } from '@/lib/ai/streams/decideRecovery';
import { isValidPartFrame } from '@/lib/ai/streams/isValidPartFrame';

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
  // The conversation the CURRENT stream belongs to, held from when it starts. The surface moves
  // independently of the stream — switching conversation mid-stream does NOT abort the POST — so
  // the abort must name the conversation the generation is actually running on. Moved up here
  // (out of its original spot further down, next to heldStreamMsgIdRef) because the load-on-select
  // effects below also need it: `isStreaming` reflects a stable-id useChat instance that keeps
  // running across a conversation switch, so it cannot answer "is MY OWN stream for the
  // conversation I'm about to load" on its own — only comparing against the conversation the
  // stream actually started in (this ref) can.
  const heldStreamConvIdRef = useRef<string | null>(null);
  heldStreamConvIdRef.current = holdForStream({
    current: heldStreamConvIdRef.current,
    isStreaming,
    liveValue: currentConversationId,
  });
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
  // Whether MY OWN local useChat is currently producing live content for the conversation I'm
  // about to load/refresh — narrower than displayIsStreaming, which also includes
  // dashboardIsStreaming/contextIsStreaming (other, already conversation-scoped, streams this
  // surface merely displays a Stop button for). `isStreaming`'s Chat instance has a stable id
  // per surface, so it keeps reporting true across a conversation switch for the OLD
  // conversation's still-in-flight request — comparing against `heldStreamConvIdRef` (latched
  // when the stream started) is the only way to know whether that live stream actually belongs
  // to the conversation now being loaded. Used by the load-on-select/refresh effects below so a
  // switch to an idle conversation isn't blocked by an unrelated stream still running elsewhere.
  const isOwnStreamForCurrentConversation = isStreaming && heldStreamConvIdRef.current === currentConversationId;

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
  // This effect drives the UI display only (the composer's location chip).
  // Message sends must NOT read `locationContext` state here — it can lag a
  // fast navigate-then-send by one async round trip. Sends build a
  // `ContextRef` instead (below), synchronously from the current
  // pathname/drives — the server resolves + permission-checks it at request
  // time (resolve-request-context.ts).
  useEffect(() => {
    let ignore = false;

    resolveLocationContext(pathname, drives).then(({ label, locationContext }) => {
      if (ignore) return;
      setContextLabel(label);
      setLocationContext(locationContext);
    });

    return () => {
      ignore = true;
    };
  }, [pathname, drives]);

  const buildFreshContextRef = useCallback(
    () => buildContextRef(pathname, drives),
    [pathname, drives],
  );

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
  // Returns the in-flight promise so callers that need to know the load has LANDED can await it
  // (the resume handler does). Callers that just want to kick a refresh off — load-on-select,
  // refreshSignal, retry — can keep ignoring the result.
  const loadGlobalMessages = useCallback((conversationId: string): Promise<void> => {
    globalLoadRequestedIdRef.current = conversationId;
    setIsLoadingGlobalMessages(true);
    setGlobalMessagesLoadError(null);

    return fetchWithAuth(`/api/ai/global/${conversationId}/messages`)
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
    // The ref is only advanced when the refetch actually runs (see the load-on-select
    // effects below for the full rationale) — a refreshSignal bump that arrives mid-stream
    // must be retried once streaming ends, not marked "seen" and dropped. Without this, a
    // remote event that fires while this surface happens to be streaming for an unrelated
    // reason would be silently lost if no further remote event bumps refreshSignal again.
    //
    // Guarded on `isOwnStreamForCurrentConversation`, NOT the broader `displayIsStreaming` —
    // switching to a different global conversation does not abort an in-flight send in the old
    // one (stable useChat id), so displayIsStreaming can stay true for a conversation that is no
    // longer the one being loaded. Blocking on that would strand this refetch behind an
    // unrelated stream in a conversation the user already left.
    if (!selectedAgent && globalIsInitializedRef.current && globalConversationId && !isOwnStreamForCurrentConversation) {
      prevSidebarRefreshSignalRef.current = refreshSignal;
      loadGlobalMessages(globalConversationId);
    }
  }, [refreshSignal, selectedAgent, globalConversationId, isOwnStreamForCurrentConversation, loadGlobalMessages]);

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

  // Refresh this surface from the DB after a background resume, catching a reply that landed
  // while we were away. Reached on the WEB resume path only (an idle tab coming back); the
  // native path recovers through tryRecover, which never reads the DB while a run is live.
  //
  // Global mode funnels through `loadGlobalMessages` — the documented single writer for the
  // global-mode server→view path — rather than doing its own fetch. That loader carries the
  // stale-response check, so a response arriving after the user switched conversation cannot
  // clobber the conversation they moved to. The raw fetch this replaced had no such guard.
  const handleAppResume = useCallback(async () => {
    if (selectedAgent) {
      await refreshAgentConversation();
    } else if (globalConversationId && globalIsInitialized) {
      await loadGlobalMessages(globalConversationId);
    }
  }, [selectedAgent, refreshAgentConversation, globalConversationId, globalIsInitialized, loadGlobalMessages]);

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
    // Guarded the same way as the refreshSignal effect above — without this, a
    // mount/reload/conversation-switch that lands while this surface's own send is already
    // streaming clobbers the in-progress assistant bubble with a stale DB snapshot that
    // predates the reply.
    //
    // `isOwnStreamForCurrentConversation`, not the broader `displayIsStreaming`: a conversation
    // switch does not abort an in-flight send in the conversation just left (stable useChat id),
    // so displayIsStreaming can stay true there while `globalConversationId` has already moved
    // on to an idle conversation — blocking on it would strand the newly-selected conversation
    // behind an unrelated stream.
    //
    // The ref is only advanced INSIDE the guard. If the guard blocks (streaming), the ref
    // stays stale on purpose — every dependency change (including isOwnStreamForCurrentConversation
    // flipping false) re-runs the effect, and while the ref is stale this same
    // `globalInitialMessages` reference still reads as "changed," so the load is retried
    // instead of permanently lost. Advancing the ref unconditionally (before the guard) would
    // mark this reference as seen even though it was never applied, silently stranding the
    // sidebar on stale/empty history once streaming ends.
    if (!selectedAgent && globalIsInitialized && globalConversationId && !isOwnStreamForCurrentConversation) {
      prevSidebarGlobalMessagesRef.current = globalInitialMessages;
      loadGlobalMessages(globalConversationId);
    }
  }, [globalInitialMessages, selectedAgent, globalIsInitialized, globalConversationId, isOwnStreamForCurrentConversation, loadGlobalMessages]);

  // Load-on-select guarantee for agent mode: with a stable useChat id, the
  // sidebar's agent Chat instance is never recreated on conversation switch,
  // so usePageAgentSidebarState's fetched messages must be explicitly applied
  // via setMessages. Seeded to `null` so the initial-mount/agent-select load
  // is also covered by this effect.
  const prevSidebarAgentMessagesRef = useRef<UIMessage[] | null>(null);
  useEffect(() => {
    if (agentInitialMessages === prevSidebarAgentMessagesRef.current) return;
    // Same guard as the global-mode load-on-select effect above (conversation-scoped, not the
    // broader displayIsStreaming — switching agent conversations doesn't abort the old one's
    // in-flight send either), and the same ref-advances-only-on-apply discipline: a
    // mount/reload/agent-switch that lands mid-stream must not clobber the in-progress
    // assistant bubble, but it also must not be forgotten once the stream ends — advancing the
    // ref here regardless of the guard would do exactly that.
    if (selectedAgent && !isOwnStreamForCurrentConversation) {
      prevSidebarAgentMessagesRef.current = agentInitialMessages;
      setMessages(agentInitialMessages);
    }
  }, [agentInitialMessages, selectedAgent, isOwnStreamForCurrentConversation, setMessages]);

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

  // Shared shape for every sidebar send path (text, voice, ask-user-answer) —
  // all three need "the request body for wherever we're sending right now,
  // given a freshly-built contextRef." Centralized so the agent-mode vs
  // global-mode branch and field list can't drift between call sites.
  const buildSidebarChatRequestBody = useCallback((
    contextRef: ContextRef,
    isReadOnly: boolean,
  ) => {
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
          contextRef,
          enabledTools: selectedAgent.enabledTools,
        }
      : buildGlobalChatRequestBody({
          conversationId: currentConversationId,
          isReadOnly,
          webSearchEnabled,
          imageGenEnabled,
          showPageTree,
          contextRef,
          selectedProvider: currentProvider,
          selectedModel: currentModel,
        });
  }, [
    selectedAgent,
    agentConversationId,
    webSearchEnabled,
    imageGenEnabled,
    showPageTree,
    currentConversationId,
    currentProvider,
    currentModel,
  ]);

  const handleSendMessage = useCallback(async () => {
    const files = getFilesForSend();
    if ((!input.trim() && files.length === 0) || !currentConversationId) return;

    // Derive isReadOnly from writeMode (inverted)
    const isReadOnly = !writeMode;

    const contextRef = buildFreshContextRef();
    const text = input;
    const sendFiles = files.length > 0 ? files : undefined;

    setInput('');
    clearFiles();

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    wrapSend(() => sendMessage({ text, files: sendFiles }, { body: buildSidebarChatRequestBody(contextRef, isReadOnly) }));
    // Note: scrollToBottom is now handled by use-stick-to-bottom when pinned
  }, [
    input,
    currentConversationId,
    writeMode,
    buildFreshContextRef,
    buildSidebarChatRequestBody,
    sendMessage,
    getFilesForSend,
    clearFiles,
    wrapSend,
  ]);

  // Voice mode: Send message from voice transcript
  const handleVoiceSend = useCallback((text: string) => {
    if (!text.trim() || !currentConversationId) return;

    const isReadOnly = !writeMode;
    const contextRef = buildFreshContextRef();

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    wrapSend(() => sendMessage({ text }, { body: buildSidebarChatRequestBody(contextRef, isReadOnly) }));
  }, [
    currentConversationId,
    writeMode,
    buildFreshContextRef,
    buildSidebarChatRequestBody,
    sendMessage,
    wrapSend,
  ]);

  const buildAskUserAnswerBody = useCallback(() => {
    const isReadOnly = !writeMode;
    return buildSidebarChatRequestBody(buildFreshContextRef(), isReadOnly);
  }, [
    writeMode,
    buildFreshContextRef,
    buildSidebarChatRequestBody,
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
          streams?: Array<{
            messageId: string;
            conversationId: string;
            parts?: unknown[];
            triggeredBy: { userId: string };
          }>;
        };
        const liveStream = (data.streams ?? []).find(
          (s) => s.conversationId === currentConversationId && s.triggeredBy.userId === user?.id,
        );
        if (liveStream && decideRecovery({ hasLiveStream: true, hasPersistedReply: false }) === 'rejoin') {
          // Evict the half-streamed assistant bubble useChat is still holding for this run.
          //
          // This is load-bearing, not tidy-up. `Chat.stop()` "keeps the generated tokens", and a
          // dropped fetch leaves them too — so `messages` still contains an assistant message
          // whose id IS the live stream's messageId (the server mints one id and uses it for both
          // the UI message and the stream registry row). The rejoin re-adds that same stream to
          // the pending store, and this surface drops a pending stream whose messageId already
          // appears in `messages` (dedupRemoteStreams) — so the rejoined stream would be filtered
          // straight back out and not one token of it would ever render. The user would sit in
          // front of a frozen partial reply.
          //
          // Only when the server has something to put in its place, though. `parts` here is the
          // registry's DEBOUNCED checkpoint (persisted every N parts), so it is empty for a stream
          // that is only a few parts old. Evict against an empty checkpoint and, if the SSE join
          // then fails — the documented multi-instance case, where the multicast lives in another
          // process — the bootstrap removes the stream and the user is left with NOTHING, which is
          // strictly worse than the frozen partial we started with. In that case keep the partial:
          // the rejoin can still attach and take over, and if it cannot, the user keeps what they
          // had.
          const staleId = liveStream.messageId;
          // Counted with isValidPartFrame, the SAME predicate the bootstrap seeds with — it is
          // `persistedParts.length` (post-filter) that becomes skipReplayCount, and a
          // skipReplayCount of 0 is what makes a failed join drop the stream. A raw
          // `parts.length > 0` would say "safe to evict" for a checkpoint of malformed frames
          // that seeds nothing.
          const hasServerParts = (liveStream.parts ?? []).filter(isValidPartFrame).length > 0;
          const evictStale = (prev: UIMessage[]) => prev.filter((m) => m.id !== staleId);
          if (selectedAgent) {
            if (hasServerParts) setMessages(evictStale);
            rejoinAgentStream();
          } else {
            if (hasServerParts) setGlobalMessages(evictStale);
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

  // App state recovery — deterministic stream rejoin on mobile.
  //
  // Placed HERE, below tryRecover, rather than up with the other effects: it delegates to
  // tryRecover, and a resume callback declared above it would close over a temporal-dead-zone
  // binding.
  //
  // The `enabled` gate MUST be a callback, not a render-time boolean: iOS freezes JS the moment
  // the app backgrounds, so a boolean captured at render is whatever was true when the app went
  // away. That is how this path was dead in exactly the case it was written for — `!isStreaming`
  // was false (streaming), and the recovery hook was gated off.
  //
  // `onResume` uses `resolveResumeAction` — on native it always returns 'rejoin-and-refresh' (the
  // local fetch is dead after backgrounding) — and then delegates to `tryRecover`, the same
  // rejoin-first probe useStreamRecovery uses on a network error, because a background/foreground
  // cycle IS a network error on iOS, just one we are told about. Do NOT blind-refresh from the DB
  // here: the reply is not persisted until the run completes, so while a stream is still live a DB
  // snapshot contains no assistant message and writing it would wipe the in-progress bubble.
  // tryRecover asks /active-streams first — the server's authoritative answer — and only touches
  // the DB when nothing is live:
  //
  //   live stream        → rejoin it, no DB read at all
  //   already persisted  → refetch the completed reply (the stream finished while backgrounded)
  //   neither            → falls through to handleAppResume
  const resumeEnabled = useCallback(
    () => currentConversationId !== null && !useEditingStore.getState().isAnyEditing(),
    [currentConversationId],
  );

  useAppStateRecovery({
    onResume: useCallback(async () => {
      const action = resolveResumeAction({ native: isCapacitorApp(), isStreaming: displayIsStreaming });
      if (action === 'noop') return;
      if (action === 'refresh') {
        // Web, no live fetch of our own: a plain DB refresh is safe and is all we need.
        await handleAppResume();
        return;
      }
      // Native. Whether a turn was actually in flight when we went away. iOS froze JS at that
      // moment, so this render-time value is a faithful record of it — which is exactly what it
      // is used for here, and why it is safe even though it is useless for deciding whether the
      // TRANSPORT is still alive (that is resolveResumeAction's job, and the answer is "no").
      const hadTurnInFlight = displayIsStreaming;

      // Local-only useChat stop: it does NOT signal the server (that is done separately via
      // abortActiveStreamByMessageId), so the run keeps generating and stays rejoinable. It also
      // ends the dead response body, which releases this channel's `consuming` mark — without
      // that the rejoin's bootstrap would classify the stream as one we are already reading off
      // the POST and skip attaching it.
      stop();
      if (await tryRecover()) return;

      // Nothing live on the server, and nothing persisted for this turn. Deliberately NOT a DB
      // refresh — that is unsafe here (the probe may simply have failed, in which case a stream
      // could still be live and the DB snapshot, which cannot contain an unpersisted reply, would
      // erase the in-progress bubble; or the DB is behind our local state, where it would erase
      // the user's own prompt).
      //
      // Regenerate instead — the same fallback useStreamRecovery applies when its probe comes up
      // empty on a network error. It is needed BECAUSE of the stop above: aborting the fetch
      // settles useChat at `ready` with no `error`, and useStreamRecovery only fires on
      // `status === 'error'`. Without this, a turn whose POST died on the background transition
      // (a radio drop right then is common) would find no stream, no reply, and no error — and
      // the user's prompt would sit unanswered forever.
      //
      // Gated on a turn actually having been in flight, so an ordinary resume on an idle
      // conversation can never fire a spurious generation.
      if (hadTurnInFlight) await handleRetry();
    }, [displayIsStreaming, stop, tryRecover, handleAppResume, handleRetry]),
    enabled: resumeEnabled,
  });

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

  // Two independent "messages not ready yet" signals feed the same in-place indicator:
  // identity-level isMessagesLoading (both modes) and the global-mode direct fetch flag.
  const messagesAreaMode = selectMessagesAreaMode({
    isLoading: isMessagesLoading || (!selectedAgent && isLoadingGlobalMessages),
    messageCount: displayMessages.length,
    streamCount: remoteStreams.length,
  });

  // ============================================
  // Render
  // ============================================
  // Only identity resolution gates the whole tab (header/input included) — a full
  // subtree swap. Once identity is known, `isMessagesLoading` becomes an in-place
  // indicator inside the messages pane (below), matching `selectMessagesAreaMode`'s
  // "skeleton only when loading AND no messages AND no streams" rule so a switch
  // between two non-empty conversations never blanks the header, input, or list.
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
        {/* In-place loading indicator (identity is already resolved above) — never a
            full subtree swap. */}
        {messagesAreaMode === 'skeleton' ? (
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
