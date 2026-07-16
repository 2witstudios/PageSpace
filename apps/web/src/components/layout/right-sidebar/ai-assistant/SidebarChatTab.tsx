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
import { useGlobalChatConversation, useGlobalChatConfig } from '@/contexts/GlobalChatContext';
import { usePageAgentSidebarState, usePageAgentSidebarChat, type SidebarAgentInfo } from '@/hooks/page-agents';
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
import { useConversationActiveStream, mergeServerMessagesWithOwnStream } from '@/hooks/useActiveStream';
import { useStopStream } from '@/hooks/useStopStream';
import { useOwnStreamMirror } from '@/hooks/useOwnStreamMirror';
import { useChatTransport, useSendHandoff, useMessageActions, useStreamRecovery, useAskUserAnswering, buildChatConfig, SIDEBAR_AGENT_CHAT_ID, buildGlobalChatRequestBody } from '@/lib/ai/shared';
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
import { canConcludeTurnIsLost, type RecoveryAttempt } from '@/lib/ai/streams/recoveryAttempt';
import { evictStalePartial, canEvictStalePartial } from '@/lib/ai/streams/evictStalePartial';
import { canResumeRecovery } from '@/lib/ai/streams/canResumeRecovery';

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
    <ConversationContent data-testid="chat-messages-area" className="p-3 min-w-0 gap-1.5">
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
        <div data-testid="streaming-indicator" className="mb-1">
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
  // No `sidebar:<convId>` namespace (PR 5A, leaf 5.5.8): it existed ONLY to keep this surface's
  // activeStreams-map entry from colliding with the dashboard's when both viewed the same
  // conversation. The map is gone, so the collision it avoided cannot happen, and the transport
  // keys on the conversation like every other surface.
  const agentTransport = useChatTransport(agentConversationId, '/api/ai/chat', selectedAgent?.id ?? null);

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
    globalStatus,
    globalMessages,
    agentStatus,
    agentMessages,
  } = usePageAgentSidebarChat({
    selectedAgent,
    globalChatConfig,
    agentChatConfig,
  });

  // ============================================
  // Dashboard Streaming State (for agent mode sync)
  // NO dashboard-store stop/streaming slot reads (PR 5A). They existed so this surface could
  // show a Stop for a stream the DASHBOARD started (co-mounted after one dashboard visit), and
  // had to be keyed by (agent, conversation) to avoid answering a question we did not ask.
  // `useConversationActiveStream` below is already scoped to this surface's agent AND
  // conversation, and reads the same stream the dashboard reads — no slot, no key, no claim.


  // ============================================
  // Derived State
  // ============================================
  const currentConversationId = selectedAgent ? agentConversationId : globalConversationId;
  // The conversation on screen, mirrored every render. Read after an await to decide whether a
  // response that just resolved is still wanted — the useChat id is constant across a conversation
  // switch, so a late write would otherwise land in whatever conversation the user moved to.
  const currentConversationIdRef = useRef<string | null>(null);
  currentConversationIdRef.current = currentConversationId;
  const isInitialized = selectedAgent ? agentIsInitialized : globalIsInitialized;
  // Identity can be 'ready' (isInitialized true) while messages for the
  // conversation just switched to are still in flight — decoupled from
  // identity resolution so a switch doesn't flash the previous conversation's
  // messages under the new one with no loading indicator.
  const isMessagesLoading = selectedAgent ? agentIsMessagesLoading : globalIsMessagesLoading;
  const assistantName = selectedAgent ? selectedAgent.title : 'Global Assistant';
  // Mirrored so the resume handler can read it AFTER its awaits. Its own closure captured the
  // pre-background value, which cannot tell it whether a generation has since restarted.
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;

  // ============================================
  // Remote Streams (multiplayer rendering)
  // ============================================
  // Global mode bootstrap+socket runs in GlobalChatProvider above this
  // component; agent mode runs via useAgentChannelMultiplayer below. Either
  // way this selector just reads the store and the pure helper picks the
  // right channel + applies the conversation filter.
  const { user } = useAuth();
  const channelIdForGlobal = user?.id ? globalChannelId(user.id) : null;
  // The channel this surface's streams live on: the agent's page id, or this user's global
  // channel id. Same key useChannelStreamSocket/useOwnStreamMirror write their entries under.
  const streamChannelId = selectedAgent ? selectedAgent.id : channelIdForGlobal;

  // THE stream identity for the conversation on screen (PR 5A) — one selector read, replacing
  // two holdForStream refs, the dashboard-store slot reads, and the context stream slot.
  //
  // The store entry IS what the hold-refs were reconstructing: {messageId, conversationId, isOwn}
  // latched at stream_start and immune to the surface moving. That matters because the surface
  // moves independently of the stream — switching conversation mid-stream does NOT abort the POST
  // (useChat's id is constant per surface), so `isStreaming` alone keeps reporting true for the
  // OLD conversation's still-in-flight request. Scoping the read by conversation answers
  // "is a stream live for what I'm showing" directly, with nothing to latch and nothing to claim.
  const activeStream = useConversationActiveStream(streamChannelId, currentConversationId);
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
    surfaceComponentName: 'SidebarChatTab',
    loadConversation: loadSidebarAgentConversation,
  });

  // Effect-based handoff for pending send → streaming transition. The end-condition is the
  // STORE ENTRY appearing, not useChat's status (leaf 5.7).
  // OUR OWN stream, not merely "a stream exists" — a remote stream on a shared conversation
  // must not end a pendingSend it has nothing to do with.
  const { wrapSend, pendingSendConversationId } = useSendHandoff(
    currentConversationId,
    status,
    activeStream?.isOwn === true,
  );

  // Streaming for THE CONVERSATION ON SCREEN, from the store — plus the submitted window, which
  // no store entry covers yet. Replaces `isStreaming || dashboardIsStreaming` /
  // `isStreaming || contextIsStreaming`: those ORed a local flag (true for the OLD conversation
  // after a mid-stream switch) with a shared slot somebody had to claim correctly.
  // OWN streams only — same rule as the merged AiChatView (`isStreaming || ownStreamMessageId`).
  // A REMOTE stream on a shared conversation is live content worth SHOWING, but it is not
  // something this tab can stop: the server's abort is user-scoped, so a Stop wired to it reports
  // 'not_found' and stays silent. Folding remote streams in here would light a Stop button that
  // cannot work, and would suppress the `remoteStreamingUser` chip (gated on !displayIsStreaming)
  // that exists to say who IS generating.
  const displayIsStreaming =
    activeStream?.isOwn === true ||
    (pendingSendConversationId !== null && pendingSendConversationId === currentConversationId);

  // INTERIM (PR 5A → deleted in PR 5B): the three #2061 clobber guards below still ask "is MY OWN
  // stream producing content for the conversation I'm about to load/refresh" — narrower than
  // displayIsStreaming, which also covers streams this surface merely shows a Stop button for.
  // `activeStream` is already conversation-scoped, so `isOwn === true` is exactly that question.
  const isOwnStreamForCurrentConversation = activeStream?.isOwn === true;

  const remoteStreamingUser = !displayIsStreaming
    ? remoteStreams.find((s) => !s.isOwn)?.triggeredBy ?? null
    : null;

  const streamingAssistantText = useMemo(() => {
    if (!displayIsStreaming) return null;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return null;
    return (last.parts ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('');
  }, [messages, displayIsStreaming]);



  // TRANSITIONAL (see useOwnStreamMirror) — copies each chat's own live assistant reply from
  // useChat's local state into usePendingStreamsStore, so this surface's own streams are present
  // the same way a bootstrapped or remote one is. Everything above derives from store presence, so
  // without these an own local stream would be invisible to its own Stop button.
  //
  // MOUNTED PER CHAT (leaf 5.5.1 — "4 instances": GVA's two, and these two), never once for the
  // mode-selected pair. A mirror decides what to write from ITS chat's status and messages, and it
  // remembers which messageId it is currently mirroring. Point one mirror at whichever mode is on
  // screen and a mode switch silently repoints it: it sees the new mode's (idle) chat, decides
  // nothing is streaming, and emits removeStream for the id it was mirroring — deleting a live
  // stream's entry, and with it that stream's Stop button and its rendered content.
  //
  // The sidebar's two chats happen to be mutually exclusive today (usePageAgentSidebarChat stops
  // the other mode's LOCAL fetch on switch), which is exactly the kind of invariant that makes a
  // mode-selected mirror look fine until it isn't: those stop effects are themselves scheduled to
  // change (leaf 5.4, W6), and a local stop never stopped the SERVER stream anyway.
  //
  // `ownAssistantMessage` reads the raw useChat arrays: this is the ONE place that must read the
  // SDK's live-growing content to copy it OUT. It is undefined unless the last message is an
  // assistant's — during the submitted window the last message is the user's own, which is why no
  // store entry exists then (and why Stop falls back to the send-time conversationId there).
  const mirrorTriggeredBy = useMemo(
    () => ({ userId: user?.id ?? '', displayName: user?.name || user?.email || 'You' }),
    [user?.id, user?.name, user?.email],
  );

  useOwnStreamMirror({
    status: globalStatus,
    ownMessages: globalMessages,
    pageId: channelIdForGlobal ?? '',
    conversationId: globalConversationId ?? '',
    triggeredBy: mirrorTriggeredBy,
  });

  useOwnStreamMirror({
    status: agentStatus,
    ownMessages: agentMessages,
    pageId: selectedAgent?.id ?? '',
    conversationId: agentConversationId ?? '',
    triggeredBy: mirrorTriggeredBy,
  });

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

  // NO editing-store registration here (PR 5A, leaf 5.7): the one derived, conversation-keyed
  // registration for the whole app lives in GlobalChatProvider
  // (useDerivedStreamingRegistrations). Registering per-surface meant this tab and the co-mounted
  // dashboard each held a session for the SAME stream, and neither covered a bootstrapped stream
  // (useChat is idle for those, so both reported "not streaming" while one was live on screen).

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

  // NO activeStreams cleanup (PR 5A, leaf 5.5.8): the client chatId->streamId map is deleted, so
  // there is no per-surface entry to free — and no way for one surface's cleanup to delete
  // another's key, which is exactly what this effect used to do (collapsing the sidebar while the
  // dashboard streamed the same conversation wiped the DASHBOARD's entry and broke its Stop).

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
    // Gates the post-edit reconcile refetch's whole-array write (see useMessageActions).
    isOwnStreamLive: isStreaming || activeStream?.isOwn === true,
      agentId: selectedAgent?.id || null,
      conversationId: currentConversationId,
      messages,
      setMessages: unifiedSetMessages,
      regenerate,
    });

  // NO heldStreamMsgIdRef (PR 5A): the stream's assistant messageId was latched here on the
  // first 'streaming' render and held so Stop could name it after the surface moved on. The store
  // entry already holds exactly that, written once at stream_start — `activeStream.messageId`.

  // Rejoin-first recovery probe for useStreamRecovery.
  // On a network error (e.g. iOS backgrounding kills the fetch):
  //   1. Check /api/ai/chat/active-streams — if the original run is still live, rejoin it.
  //   2. Else fetch messages from the DB — if the run persisted a reply, surface it.
  //   3. Only fall through to regenerate() when neither path finds anything to recover.
  const tryRecover = useCallback(async (): Promise<RecoveryAttempt> => {
    // `probeAnswered` is RETURNED, never stashed in a ref. tryRecover has two callers — this
    // surface's resume handler and useStreamRecovery's network-error retry — and they can be in
    // flight together. A single shared slot would let one caller's probe answer the other's
    // question, which on this path means regenerating over a run we never actually asked about.
    let probeAnswered = false;
    let dbAnswered = false;
    const conversationId = currentConversationId;
    if (!conversationId) return { recovered: false, probeAnswered, dbAnswered };
    const channelId = selectedAgent?.id ?? channelIdForGlobal;
    if (!channelId) return { recovered: false, probeAnswered, dbAnswered };
    // Every write below happens after an await, into a useChat instance whose id is constant
    // across conversation switches. Re-check the LIVE conversation before each one, exactly as
    // loadGlobalMessages does — otherwise a recovery for the conversation the user just left
    // lands in the one they moved to.
    const stillOnThisConversation = () =>
      shouldApplyLoadedMessages(conversationId, currentConversationIdRef.current);

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
        // Only NOW do we know the server told us something. Setting this off `res.ok` alone would
        // be a lie: res.json() can still throw on a body that dies mid-read — which is exactly the
        // cold-radio-after-foreground case this whole path exists for — and the catch below would
        // swallow it while we went on believing we had an answer.
        probeAnswered = true;
        const liveStream = (data.streams ?? []).find(
          (s) => s.conversationId === conversationId && s.triggeredBy.userId === user?.id,
        );
        // decideRecovery's priority (rejoin > refetch > regenerate) is expressed by the ORDER of
        // these steps, not by a call here: with hasLiveStream hardcoded true it could only ever
        // answer 'rejoin', so asking would be decoration. Step 2 below is where it genuinely
        // decides. A live stream is always rejoined, never read around.
        if (liveStream && stillOnThisConversation()) {
          // Evict the half-streamed assistant bubble useChat is still holding for this run. See
          // evictStalePartial: without it the rejoined stream is deduped straight back out and
          // renders nothing, and it is safe only when the server's checkpoint has frames the
          // bootstrap can actually seed in its place.
          //
          // Ask before writing, so an unsafe checkpoint costs no state write at all; then evict
          // through the UPDATER form, so the filter runs against the freshest message list rather
          // than one captured before the awaits above.
          const staleId = liveStream.messageId;
          if (canEvictStalePartial(liveStream.parts)) {
            const evict = (prev: UIMessage[]) => evictStalePartial(prev, staleId, liveStream.parts);
            if (selectedAgent) setMessages(evict);
            else setGlobalMessages(evict);
          }
          if (selectedAgent) {
            rejoinAgentStream();
          } else {
            rejoinGlobalStream();
          }
          return { recovered: true, probeAnswered, dbAnswered };
        }
      }
    } catch { /* network error — fall through to DB check */ }

    // Step 2: DB check for a persisted reply to the CURRENT turn.
    try {
      const url = selectedAgent
        ? `/api/ai/page-agents/${selectedAgent.id}/conversations/${conversationId}/messages`
        : `/api/ai/global/${conversationId}/messages`;
      const res = await fetchWithAuth(url);
      if (res.ok) {
        const data = await res.json();
        const msgs = (Array.isArray(data) ? data : (data.messages ?? [])) as Array<{
          id: string;
          role: string;
        }>;
        // Only NOW do we know what is persisted. As with the probe above, a throw or a non-ok
        // leaves us knowing nothing — and treating that silence as "no reply exists" would let the
        // caller regenerate over a reply that had in fact completed, which DELETES it (handleRetry
        // removes the trailing assistant by the very id the server persisted it under).
        dbAnswered = true;

        // "Was the user's turn persisted?" asked by IDENTITY, not by counting.
        //
        // It used to compare user-message counts (dbUserCount >= localUserCount). That silently
        // breaks on any conversation longer than one page: this GET is unpaginated, so the route
        // applies its default limit of 50 and returns only the newest 50 rows, while local
        // `messages` is the initial 50 PLUS every turn since. Past that boundary the count guard
        // is permanently false, step 2 can never recover, and every interrupted turn on a long
        // conversation would fall through to a regenerate that deletes the reply it should have
        // refetched. The last local user message is by definition the newest, so it is always
        // inside the returned window — checking for its id is both correct and pagination-proof.
        const lastLocalUserId = [...currentMessagesRef.current]
          .reverse()
          .find((m) => m.role === 'user')?.id;
        const ourTurnIsPersisted =
          lastLocalUserId === undefined || msgs.some((m) => m.id === lastLocalUserId);
        const hasPersistedReply =
          msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant' && ourTurnIsPersisted;

        if (
          stillOnThisConversation() &&
          decideRecovery({ hasLiveStream: false, hasPersistedReply }) === 'refetch'
        ) {
          // Write the SAME normalized array the guards above were computed from. Reading
          // defensively and then writing `data.messages` raw would blank the surface outright if
          // the route ever answered with a bare array.
          const serverMessages = msgs as unknown as UIMessage[];
          if (selectedAgent) {
            setMessages(serverMessages);
          } else {
            setGlobalMessages(serverMessages);
          }
          return { recovered: true, probeAnswered, dbAnswered };
        }
      }
    } catch { /* network error — the caller must not treat this as "nothing is persisted" */ }

    return { recovered: false, probeAnswered, dbAnswered };
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
  // useStreamRecovery only asks "did you recover?" — the probe-reachability half of the answer is
  // for the resume path, which is the one that would otherwise regenerate over a live run.
  const tryRecoverForError = useCallback(async () => (await tryRecover()).recovered, [tryRecover]);

  // ONE mutex across BOTH recovery paths.
  //
  // useStreamRecovery watches this same failure from the other side (it fires on
  // `status === 'error'`) and regenerates too, and the two shared no lock. Either could decide to
  // regenerate the turn while the other was still deciding — useStreamRecovery calls clearError()
  // BEFORE running its own probes, so for the whole of its decision window the status reads
  // `ready` and looks idle to us. Two regenerates for one turn is the double destruction the
  // resume gate exists to prevent: the server takes over the conversation on every generation
  // start, so the second aborts the first, and handleRetry deletes its assistant message on the
  // way in.
  //
  // The lock is held across the whole of handleRetry — its message DELETEs are a network
  // round-trip — after which the restarted generation's own `submitted` status keeps the other
  // path out (see `nothingHasRestarted` below).
  const regenerationInFlightRef = useRef(false);
  const regenerateTurnOnce = useCallback(async () => {
    if (regenerationInFlightRef.current) return;
    regenerationInFlightRef.current = true;
    try {
      await handleRetry();
    } finally {
      regenerationInFlightRef.current = false;
    }
  }, [handleRetry]);

  useStreamRecovery({ error, status, clearError, handleRetry: regenerateTurnOnce, maxRetries: 2, tryRecover: tryRecoverForError });

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
  //   neither            → regenerate — but ONLY once both questions actually came back
  //                         (canConcludeTurnIsLost). Never a DB refresh: see the gate below.
  const resumeEnabled = useCallback(
    () => canResumeRecovery(currentConversationId, useEditingStore.getState().isAnyEditing()),
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
      // Native. Whether a turn of OUR OWN was in flight, for the conversation on screen, when we
      // went away. iOS froze JS at that moment, so this render-time value is a faithful record of
      // it — which is exactly what it is used for here, and why it is safe even though it is
      // useless for deciding whether the TRANSPORT is still alive (that is resolveResumeAction's
      // job, and the answer is "no").
      //
      // Conversation-scoped, NOT the broader displayIsStreaming: that also reports true for a
      // stream still running against a conversation the user has since navigated away from (the
      // useChat id is stable across a switch), and regenerating on the strength of it would fire
      // a generation for the turn the user is now LOOKING at rather than the one that was
      // actually interrupted.
      const hadTurnInFlight = isOwnStreamForCurrentConversation;
      // The conversation that turn belongs to. The recovery below spans up to a few seconds of
      // network, and the user can switch conversation inside that window — at which point
      // regenerating would fire a generation for the turn they moved TO, not the one that was
      // interrupted. `handleRetry` always acts on the live conversation, so the only way to keep
      // it honest is to re-check that we are still on the one we started from.
      const conversationAtResume = currentConversationId;

      // Local-only useChat stop: it does NOT signal the server (that is done separately via
      // abortActiveStreamByMessageId), so the run keeps generating and stays rejoinable. It also
      // ends the dead response body, which releases this channel's `consuming` mark — without
      // that the rejoin's bootstrap would classify the stream as one we are already reading off
      // the POST and skip attaching it.
      stop();
      let attempt = await tryRecover();
      if (attempt.recovered) return;

      // Came up empty — but "we recovered nothing" is NOT "there was nothing to recover". Each of
      // tryRecover's two questions can come back UNANSWERED, and silence from either one means the
      // work we would be about to destroy might still exist:
      //
      //   /active-streams silent → a run may still be LIVE.       Regenerating aborts it.
      //   messages GET silent    → the reply may already be SAVED. Regenerating deletes it.
      //
      // The first request after a foreground is the one most likely to fail (cold radio), so this
      // is common on exactly this path. Re-ask until both questions come back, bounded — the radio
      // returns well inside a few seconds.
      for (let i = 1; !(attempt.probeAnswered && attempt.dbAnswered) && i <= 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, i * 1000));
        attempt = await tryRecover();
        if (attempt.recovered) return;
      }

      // Regenerate ONLY once BOTH questions came back, and only for a turn of ours that really was
      // in flight (canConcludeTurnIsLost).
      //
      // The regenerate is needed BECAUSE of the stop above: aborting the fetch settles useChat at
      // `ready` with NO `error`, and useStreamRecovery only fires on `status === 'error'`. Without
      // it, a turn whose POST died on the background transition would find no stream, no reply and
      // no error, and the user's prompt would sit unanswered forever.
      //
      // But regenerating on SILENCE would be far worse than doing nothing, because regenerating is
      // destructive twice over:
      //   - takeOverConversationStreams runs on every generation start, so a regenerate issued
      //     while the run is in fact still live ABORTS it — re-running write tools it had already
      //     executed, billing its discarded tokens, stranding its partial in the DB.
      //   - handleRetry DELETEs the trailing assistant by id before re-requesting, and that is the
      //     same id the server persisted the reply under — so a regenerate issued when the reply
      //     had in fact completed deletes the finished reply and pays for it again.
      //
      // Doing nothing on silence is safe: the stop released this channel's `consuming` mark, so a
      // live run is picked up by the socket-reconnect bootstrap once the network returns, a
      // persisted reply is picked up by the next load, and a genuinely dead turn leaves the user
      // their prompt and the retry action on it.
      const stillOnTheInterruptedConversation =
        currentConversationIdRef.current === conversationAtResume;
      // Belt to regenerateTurnOnce's braces. The mutex stops the two paths regenerating at the
      // same moment; this stops us regenerating on top of a turn that has ALREADY restarted and
      // moved on — the mutex is released as soon as handleRetry returns, but the generation it
      // kicked off is still running. Read through a ref because the closure's copy of `isStreaming`
      // is the value captured before we were frozen.
      const nothingHasRestarted = !isStreamingRef.current;
      if (
        hadTurnInFlight &&
        stillOnTheInterruptedConversation &&
        nothingHasRestarted &&
        canConcludeTurnIsLost(attempt)
      ) {
        await regenerateTurnOnce();
      }
    }, [
      displayIsStreaming,
      currentConversationId,
      isOwnStreamForCurrentConversation,
      stop,
      tryRecover,
      handleAppResume,
      regenerateTurnOnce,
    ]),
    enabled: resumeEnabled,
  });

  // Adapter for AgentSelector (converts SidebarAgentInfo to AgentInfo shape)
  const handleSelectAgent = useCallback((agent: SidebarAgentInfo | null) => {
    selectAgent(agent);
  }, [selectAgent]);

  // Stop, for both modes (PR 5A, leaf 5.5.6). One action, no dispatcher.
  //
  // What this replaces: an 82-line branch that first had to work out WHOSE stop function to call
  // — ours, the context's, or the dashboard store's — because each was a slot installed by
  // whichever surface got there first. That question had a wrong answer that shipped: the shared
  // stop belongs to the surface that installed it, and the sidebar and dashboard registered under
  // DIFFERENT chatIds (`sidebar:<convId>` vs the bare convId), so reaching for the shared stop
  // first aborted the DASHBOARD's stream while ours kept generating and kept billing.
  //
  // There is no whose. `activeStream` is a read of the one place a live stream is recorded, and
  // the abort names it by messageId — which no surface owns, and which needs no map.
  const handleStop = useStopStream({ activeStream, pendingSendConversationId, rawStop: stop });

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
          // MERGE, don't skip — same shape as this file's own global-mode loadGlobalMessages, and
          // for two reasons. Agent mode renders from useChat, so skipping would leave a confirmed
          // destructive undo invisible until the user navigates away and back. And a raw write
          // would hand useOwnStreamMirror an array whose newest row is somebody else's finished
          // message (see mergeServerMessagesWithOwnStream). Merging applies the undo and keeps our
          // own live bubble last.
          setMessages(mergeServerMessagesWithOwnStream(data.messages, currentConversationId, currentMessagesRef.current));
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
      <div data-testid="sidebar-chat-spinner" className="flex flex-col h-full p-4">
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
    <div data-testid="sidebar-chat-tab" className="flex flex-col h-full">
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
          <div data-testid="chat-loading-skeleton" className="flex h-full items-center justify-center">
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
