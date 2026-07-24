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
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { useVoiceModeStore, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import { useGlobalChatConversation, useGlobalChatConfig } from '@/contexts/GlobalChatContext';
import { usePageAgentSidebarState, type SidebarAgentInfo } from '@/hooks/page-agents';
import { useDualModeChat } from '@/hooks/useDualModeChat';
import { type PendingStream } from '@/stores/usePendingStreamsStore';
import { useAuth } from '@/hooks/useAuth';
import { dedupRemoteStreams } from '@/lib/ai/streams/dedupRemoteStreams';
import { synthesizeAssistantMessage } from '@/lib/ai/streams/synthesizeAssistantMessage';
import { useAgentChannelMultiplayer } from '@/hooks/useAgentChannelMultiplayer';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { toast } from 'sonner';
import { LocationContext } from '@/lib/ai/shared';
import { resolveLocationContext } from '@/lib/ai/shared/resolveLocationContext';
import { buildContextRef, type ContextRef } from '@/lib/ai/shared/buildContextRef';
import { useConversationActiveStream, useActiveStream } from '@/hooks/useActiveStream';
import { useRenderedMessages, useConversationLoadState, useConversationOlderPageState } from '@/hooks/useRenderedMessages';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import {
  loadGlobalConversationMessages,
  loadAgentConversationMessages,
  loadOlderGlobalConversationMessages,
  loadOlderAgentConversationMessages,
} from '@/hooks/conversationMessagesLoaders';
import { buildUserMessage } from '@/lib/ai/streams/buildUserMessage';
import { rollbackOptimisticSendOnFailure } from '@/lib/ai/streams/rollbackOptimisticSendOnFailure';
import { selectVoiceStreamText } from '@/lib/ai/streams/selectVoiceStreamText';
import { selectVoiceActivationBaseline } from '@/lib/ai/streams/selectVoiceActivationBaseline';
import { selectPostBaselineAssistantMessage } from '@/lib/ai/streams/selectPostBaselineAssistantMessage';
import { useReadAloud } from '@/hooks/useReadAloud';
import { createId } from '@paralleldrive/cuid2';
import { useStopStream } from '@/hooks/useStopStream';
import { useOwnStreamMirror } from '@/hooks/useOwnStreamMirror';
import { useChatTransport, useSendHandoff, useConversationSendHandoff, HANDOFF_REFUSED_MESSAGE, useCacheMessageActions, useResumeBootstrap, useAnswerAskUser, useChatErrorCause, buildChatConfig, SIDEBAR_AGENT_CHAT_ID, buildGlobalChatRequestBody } from '@/lib/ai/shared';
import { AskUserAnswerProvider } from '@/components/ai/shared/chat/ask-user/AskUserAnswerContext';
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard';
import { VoiceCallPanel } from '@/components/ai/voice/VoiceCallPanel';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';
import { useEditingStore } from '@/stores/useEditingStore';
import { ChatErrorBanner } from '@/components/ai/shared/chat/ChatErrorBanner';
import { selectMessagesAreaMode } from '@/lib/ai/streams/selectMessagesAreaMode';
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
  /** Scroll-near-top handler (epic leaf 6.6) — fetches the next older page. */
  onScrollNearTop?: () => void;
  /** Whether an older page is currently loading. */
  isLoadingOlder?: boolean;
  /** Whether more (older) pages exist for this conversation — forces virtualization even
   *  under SIDEBAR_VIRTUALIZATION_THRESHOLD, since only the virtualized branch wires
   *  onScrollNearTop/isLoadingOlder (PR 6 review, CodeRabbit: the regular/non-virtualized
   *  branch had no near-top detection at all, so "load older" was unreachable below the
   *  threshold no matter how much older history existed). */
  hasMoreOlder?: boolean;
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
  onScrollNearTop,
  isLoadingOlder,
  hasMoreOlder,
}) => {
  const scrollRef = useConversationScrollRef();
  // Also virtualize whenever an older page remains, regardless of the count threshold —
  // the regular branch below has no scroll listener of its own, so "load older" would
  // otherwise be unreachable for a conversation with more history than the cache
  // currently holds but fewer than SIDEBAR_VIRTUALIZATION_THRESHOLD rendered messages.
  const shouldVirtualize = messages.length >= SIDEBAR_VIRTUALIZATION_THRESHOLD || hasMoreOlder === true;
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
          onScrollNearTop={onScrollNearTop}
          isLoadingOlder={isLoadingOlder}
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
    createNewConversation: createGlobalConversation,
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
    isInitialized: agentIsInitialized,
    selectAgent,
    createNewConversation: createAgentConversation,
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
    sendMessage,
    status,
    error,
    clearError,
    regenerate,
    setMessages,
    stop,
    isStreaming,
    addToolResult,
    globalStatus,
    globalStop,
    globalMessages,
    agentStatus,
    agentMessages,
    agentStop,
  } = useDualModeChat({
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
  const isInitialized = selectedAgent ? agentIsInitialized : globalIsInitialized;
  const assistantName = selectedAgent ? selectedAgent.title : 'Global Assistant';

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
  // Remote in-progress streams — one facade read per mode (container-agnostic
  // consumer rule: components never reach into usePendingStreamsStore directly).
  const { streams: agentRemoteStreams } = useActiveStream(selectedAgent?.id ?? '', agentConversationId);
  const { streams: globalRemoteStreams } = useActiveStream(channelIdForGlobal ?? '', globalConversationId);
  const remoteStreams = selectedAgent ? agentRemoteStreams : globalRemoteStreams;

  // ============================================
  // STORE-FIRST RENDERING (PR 5B, leaf 5.2)
  // ============================================
  // The rendered list is `selectRenderedMessages(conversationCache, activeStreams)`
  // via the facade — useChat's `messages` never renders (transport/controller only).
  // Loading/error UI reads the cache entry's load state (replaces the context's
  // isMessagesLoading, the sidebar store's flag, and this file's loadGlobalMessages
  // local state, stale-request ref and error state).
  const renderedMessages = useRenderedMessages(streamChannelId ?? '', currentConversationId);
  const plainMessages = useMemo(() => renderedMessages.map((r) => r.message), [renderedMessages]);
  const messagesLoadState = useConversationLoadState(currentConversationId);
  const isMessagesLoading = messagesLoadState.isLoading;

  // Reload the active conversation's cache entry — the one refetch path for this
  // surface (undo, app resume, error retry). Staleness is the loader's
  // loadGeneration gate; merge-at-render keeps a live stream visible over any DB
  // snapshot, which is what deleted this surface's #2061 clobber guards.
  const reloadCurrentConversation = useCallback(async () => {
    const conversationId = currentConversationId;
    if (!conversationId) return;
    if (selectedAgent) {
      await loadAgentConversationMessages(selectedAgent.id, conversationId);
    } else {
      await loadGlobalConversationMessages(conversationId);
    }
  }, [currentConversationId, selectedAgent]);

  // "Load older" (epic leaf 6.6, scroll-to-top) — same agent/global branch as reload.
  const { isLoadingOlder, hasMoreOlder } = useConversationOlderPageState(currentConversationId);
  const handleScrollNearTop = useCallback(() => {
    const conversationId = currentConversationId;
    if (!conversationId) return;
    if (selectedAgent) {
      void loadOlderAgentConversationMessages(selectedAgent.id, conversationId);
    } else {
      void loadOlderGlobalConversationMessages(conversationId);
    }
  }, [currentConversationId, selectedAgent]);

  // Agent-mode multiplayer wiring. No-op when selectedAgent is null. Message
  // callbacks write the shared conversation cache (PR 5B, leaf 5.6); reconnect
  // reloads via the sidebar state's cache-committing loader.
  const { rejoinActiveStreams: rejoinAgentStream } = useAgentChannelMultiplayer({
    selectedAgent,
    agentConversationId,
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

  const remoteStreamingUser = !displayIsStreaming
    ? remoteStreams.find((s) => !s.isOwn)?.triggeredBy ?? null
    : null;

  // Voice's live-stream text (epic leaf 6.4) — one selector, three consumers.
  const streamingAssistantText = useMemo(
    () => selectVoiceStreamText(renderedMessages),
    [renderedMessages],
  );



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
  // The sidebar's two chats happen to be mutually exclusive today (useDualModeChat stops
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

  const { getLatchedConversationId: getGlobalLatchedConversationId } = useOwnStreamMirror({
    status: globalStatus,
    ownMessages: globalMessages,
    pageId: channelIdForGlobal ?? '',
    conversationId: globalConversationId ?? '',
    triggeredBy: mirrorTriggeredBy,
  });

  const { getLatchedConversationId: getAgentLatchedConversationId } = useOwnStreamMirror({
    status: agentStatus,
    ownMessages: agentMessages,
    pageId: selectedAgent?.id ?? '',
    conversationId: agentConversationId ?? '',
    triggeredBy: mirrorTriggeredBy,
  });

  // Pre-send handoff, PER CHAT like the mirrors: a send into a different conversation than the
  // one this chat is consuming for must first stop the local read and hand the in-flight stream
  // to the socket path — the SDK's Chat cannot consume two response bodies at once, and a second
  // concurrent send is how chat 1's stream ended up rendering inside chat 2. See
  // useConversationSendHandoff.
  const { prepareSend: prepareGlobalSend } = useConversationSendHandoff({
    status: globalStatus,
    stop: globalStop,
    getLatchedConversationId: getGlobalLatchedConversationId,
    rejoin: rejoinGlobalStream,
  });
  const { prepareSend: prepareAgentSend } = useConversationSendHandoff({
    status: agentStatus,
    stop: agentStop,
    getLatchedConversationId: getAgentLatchedConversationId,
    rejoin: rejoinAgentStream,
  });
  const prepareSendForMode = selectedAgent ? prepareAgentSend : prepareGlobalSend;

  // Shared store-first message actions (F2/F9): actions reason over SETTLED rows
  // only — a synthesized live-stream row must never reach retry/delete's
  // server-side DELETEs (the live bubble's verb is Stop).
  const isOwnSendLive = isStreaming || activeStream?.isOwn === true;
  // Read after an await (resume runs async), so a ref rather than the captured value.
  const isOwnSendLiveRef = useRef(isOwnSendLive);
  isOwnSendLiveRef.current = isOwnSendLive;
  // Conversation-scoped counterpart, for consumers that must not see the OLD conversation's
  // still-in-flight raw useChat status as "busy" (PR 6 review, CodeRabbit) — AskUser
  // answerability and resume's isOwnStreamLive gate, unlike useCacheMessageActions' clobber
  // guard above, which is deliberately conversation-agnostic (see displayIsStreaming's docblock).
  const displayIsStreamingRef = useRef(displayIsStreaming);
  displayIsStreamingRef.current = displayIsStreaming;

  const getIsOwnSendLive = useCallback(() => isOwnSendLiveRef.current, []);

  const { handleEdit, handleDelete, handleRetry } = useCacheMessageActions({
    agentId: selectedAgent?.id || null,
    conversationId: currentConversationId,
    renderedMessages,
    isOwnSendLive,
    setMessages,
    regenerate,
    // Retry is a send: the handoff runs INSIDE handleRetry, before its destructive steps, and
    // the hydrate decision re-reads liveness after the handoff settles (dual-stream fix).
    prepareSend: prepareSendForMode,
    getIsOwnSendLive,
  });

  // Display ids come from the RENDERED list (affordance placement + streaming
  // animation are display concerns; the actions above use the settled set).
  const lastAssistantMessageId = useMemo(
    () => [...plainMessages].reverse().find((m) => m.role === 'assistant')?.id,
    [plainMessages],
  );
  const lastUserMessageId = useMemo(
    () => [...plainMessages].reverse().find((m) => m.role === 'user')?.id,
    [plainMessages],
  );


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

  // Voice mode state
  const isVoiceModeEnabled = useVoiceModeStore((s) => s.isEnabled);
  const voiceOwner = useVoiceModeStore((s) => s.owner);
  const enableVoiceMode = useVoiceModeStore((s) => s.enable);
  const disableVoiceMode = useVoiceModeStore((s) => s.disable);
  const isVoiceModeActive = isVoiceModeEnabled && voiceOwner === VOICE_OWNER;

  // Read Aloud: on-demand TTS for everything the assistant said since the
  // user's last turn, via a shared playback singleton (see readAloudPlayer).
  const { isReadingAloud, toggleReadAloud, canReadAloud: canReadAloudFor } = useReadAloud();
  const canReadAloud = useMemo(() => canReadAloudFor(plainMessages), [canReadAloudFor, plainMessages]);
  const handleReadAloudClick = useCallback(
    () => toggleReadAloud(plainMessages),
    [toggleReadAloud, plainMessages]
  );

  // Display preferences
  const { preferences: displayPreferences } = useDisplayPreferences();

  // Image attachments for vision support
  const { attachments, addFiles, removeFile, getFilesForSend } = useImageAttachments();

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

  // NO loadGlobalMessages and NO refreshSignal consumer (PR 5B, leaves 5.2/5.4):
  // every load/refresh commits to the shared conversation cache (context loaders,
  // sidebar-state loaders, reloadCurrentConversation above), remote events write the
  // cache directly in GlobalChatContext, and rendering merges the live stream back in
  // at render — so the stale-request ref, the own-stream reconcile merge, and the
  // #2061 clobber guards that arbitrated those writes are deleted, not moved.

  // ============================================
  // Effects: UI State
  // ============================================

  // Typed error cause, per-conversation (epic leaf 6.5) — replaces raw `error`/getAIErrorMessage.
  const { cause: errorCause, dismiss: dismissError } = useChatErrorCause(
    currentConversationId,
    error,
    clearError,
    pendingSendConversationId ?? currentConversationId,
  );

  useEffect(() => {
    if (errorCause) setShowError(true);
  }, [errorCause]);


  // Track last AI response for voice mode TTS (epic leaf 6.4 — baseline decision is
  // now a shared pure helper; only the "activate once" ref bookkeeping stays here).
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
      voiceBaselineRef.current = selectVoiceActivationBaseline(renderedMessages);
      return;
    }

    const next = selectPostBaselineAssistantMessage(renderedMessages, voiceBaselineRef.current);
    if (!next) return;

    setLastAIResponse((current) => (current?.id === next.id ? current : next));
  }, [renderedMessages, isVoiceModeActive]);

  // Refresh this surface from the DB — the `reload` step of app-resume (useResumeBootstrap
  // below), catching a reply that landed while we were away. One cache reload for both
  // modes (leaf 5.4 W3).
  const handleAppResume = useCallback(async () => {
    if (!isInitialized) return;
    await reloadCurrentConversation();
  }, [isInitialized, reloadCurrentConversation]);

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
    void reloadCurrentConversation();
  }, [reloadCurrentConversation]);

  // NO load-on-select effects (PR 5B, leaf 5.2): loads commit straight to the
  // conversation cache (GlobalChatContext / sidebar-state loaders), and rendering is
  // `selectRenderedMessages(cacheEntry, activeStreams)` — there is no useChat array
  // to re-apply loaded history into and no mid-stream clobber to guard against
  // (merge-at-render). This deletes this surface's remaining #2061 clobber guards.

  const handleNewConversation = useCallback(async () => {
    try {
      if (selectedAgent) {
        // No setMessages([]) (leaf 5.4 W6): rendering is per-conversation from the
        // cache, and createAgentConversation seeds the new id loaded-empty.
        await createAgentConversation();
      } else {
        await createGlobalConversation();
      }
    } catch {
      toast.error('Failed to create new conversation');
    }
  }, [selectedAgent, createAgentConversation, createGlobalConversation]);

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
    // The ids behind `files` — same processed filter getFilesForSend applies. Attachments are
    // cleared per-id AFTER the handoff confirms, so a refusal loses nothing and anything
    // attached DURING the wait (a different id) survives the clear.
    const sentAttachmentIds = attachments.filter((a) => !a.processing && a.dataUrl).map((a) => a.id);

    // Text clears immediately (typing during the wait must not merge into the old draft) and is
    // restored on refusal ONLY if the composer is still empty — newer keystrokes win.
    setInput('');

    // Hand off any in-flight stream this chat is consuming for ANOTHER conversation before
    // sending — the Chat cannot consume two bodies at once. No-op for same-conversation sends.
    // `false` means the handoff could not confirm (unmount, or the settle wait timed out with
    // the latch still held): sending would re-key the new stream under the old conversation.
    if (!(await prepareSendForMode(currentConversationId))) {
      toast.error(HANDOFF_REFUSED_MESSAGE);
      setInput((current) => (current === '' ? text : current));
      return;
    }
    for (const id of sentAttachmentIds) removeFile(id);

    // Client-minted id, parts-form send (PR 4 pattern): only that shape preserves the
    // id end to end, and the id is what lets the cache reconcile the optimistic bubble
    // against its broadcast/load echoes. Written to the cache immediately — the
    // sender's own tab never receives its own chat:user_message broadcast back, and
    // this is what makes the bubble appear the same tick (leaf 5.2 acceptance).
    const userMessage = buildUserMessage({
      id: createId(),
      text: text.trim().length > 0 ? text : undefined,
      files: sendFiles,
    }) as UIMessage;
    conversationMessagesActions.addOptimisticSend(currentConversationId, userMessage);

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    rollbackOptimisticSendOnFailure(
      () => wrapSend(() => sendMessage(userMessage, { body: buildSidebarChatRequestBody(contextRef, isReadOnly) })),
      currentConversationId,
      userMessage.id,
    );
    // Note: scrollToBottom is now handled by use-stick-to-bottom when pinned
  }, [
    input,
    currentConversationId,
    writeMode,
    buildFreshContextRef,
    buildSidebarChatRequestBody,
    sendMessage,
    getFilesForSend,
    attachments,
    removeFile,
    wrapSend,
    prepareSendForMode,
  ]);

  // Voice mode: Send message from voice transcript
  const handleVoiceSend = useCallback(async (text: string) => {
    if (!text.trim() || !currentConversationId) return;

    const isReadOnly = !writeMode;
    const contextRef = buildFreshContextRef();

    // Same cross-conversation handoff as handleSendMessage; abort on an unconfirmed handoff —
    // with feedback, or the transcript would vanish silently.
    if (!(await prepareSendForMode(currentConversationId))) {
      toast.error(HANDOFF_REFUSED_MESSAGE);
      return;
    }

    // Same client-minted-id, optimistic-cache-write shape as handleSendMessage.
    const userMessage = buildUserMessage({ id: createId(), text }) as UIMessage;
    conversationMessagesActions.addOptimisticSend(currentConversationId, userMessage);

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    rollbackOptimisticSendOnFailure(
      () => wrapSend(() => sendMessage(userMessage, { body: buildSidebarChatRequestBody(contextRef, isReadOnly) })),
      currentConversationId,
      userMessage.id,
    );
  }, [
    currentConversationId,
    writeMode,
    buildFreshContextRef,
    buildSidebarChatRequestBody,
    sendMessage,
    wrapSend,
    prepareSendForMode,
  ]);

  // renderedMessages (selector output): "answerable" is decided by the conversation's
  // LAST message, and remote edits/deletes/messages update the store, not useChat.
  // isConversationBusy replaces status==='ready'. displayIsStreaming, not isOwnSendLive:
  // the latter includes raw useChat status, which stays true for the OLD conversation's
  // still-in-flight request after a switch (PR 6 review, CodeRabbit).
  const askUserAnswering = useAnswerAskUser({
    conversationId: currentConversationId,
    renderedMessages,
    isConversationBusy: displayIsStreaming,
    setMessages,
    addToolResult,
    wrapSend,
    // Answering re-invokes the chat — same cross-conversation handoff as every send path.
    prepareSend: prepareSendForMode,
    buildBody: useCallback(
      () => buildSidebarChatRequestBody(buildFreshContextRef(), !writeMode),
      [buildSidebarChatRequestBody, buildFreshContextRef, writeMode],
    ),
  });

  // Voice mode toggle handler. Enabling Voice Mode also stops any
  // in-progress read-aloud playback — enforced inside readAloudPlayer itself
  // (subscribed to the voice-mode store), not here.
  const handleVoiceModeToggle = useCallback(() => {
    if (isVoiceModeActive) {
      disableVoiceMode();
    } else {
      enableVoiceMode(VOICE_OWNER);
    }
  }, [isVoiceModeActive, enableVoiceMode, disableVoiceMode]);

  // NO heldStreamMsgIdRef (PR 5A): the stream's assistant messageId was latched here on the
  // first 'streaming' render and held so Stop could name it after the surface moved on. The store
  // entry already holds exactly that, written once at stream_start — `activeStream.messageId`.

  // Re-bootstrap whichever mode is on screen (epic leaf 6.2's `rejoin` step) — one
  // channel is live at a time in this surface (agent/global are mutually exclusive).
  const rejoinActiveMode = useCallback(() => {
    if (selectedAgent) {
      rejoinAgentStream();
    } else {
      rejoinGlobalStream();
    }
  }, [selectedAgent, rejoinAgentStream, rejoinGlobalStream]);

  // Gate on USER editing only, evaluated at fire time (callback form) — iOS freezes JS the
  // moment the app backgrounds, so a boolean captured at render would be stale.
  const resumeEnabled = useCallback(
    () => canResumeRecovery(currentConversationId, useEditingStore.getState().isAnyEditing()),
    [currentConversationId],
  );

  // App-resume = the same path as mount/socket-reconnect (epic leaf 6.2): re-bootstrap active
  // streams, reload the conversation into the cache, and settle a frozen local transport.
  // Nothing renders from the local fetch under store-first rendering, so there is no
  // native/web or was-i-streaming choreography left to make — this subsumes the old
  // tryRecover/decideRecovery probe tree, resolveResumeAction (deleted), and #2065.
  useResumeBootstrap({
    rejoin: rejoinActiveMode,
    reload: handleAppResume,
    stop,
    isOwnStreamLive: useCallback(() => displayIsStreamingRef.current, []),
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
  const handleStop = useStopStream({
    activeStream,
    pendingSendConversationId,
    rawStop: stop,
    // The rawStop gate: a Stop on a socket-attached conversation must not abort another
    // conversation's live local fetch (conversation-scoped consuming, dual-stream fix).
    getLocalSendConversationId: selectedAgent ? getAgentLatchedConversationId : getGlobalLatchedConversationId,
    targetConversationId: currentConversationId,
  });

  const handleUndoFromHere = useCallback((messageId: string) => {
    setUndoDialogMessageId(messageId);
  }, []);

  // Undo restructures the conversation server-side — reload the cache entry (leaf 5.4
  // W4). No transport write and no own-stream merge dance: merge-at-render keeps a live
  // own stream visible over any DB snapshot.
  const handleUndoSuccess = useCallback(async () => {
    setUndoDialogMessageId(null);
    await reloadCurrentConversation();
  }, [reloadCurrentConversation]);

  // ============================================
  // Computed Values for Rendering
  // ============================================

  // The store-first render source (PR 5B): confirmed + optimistic + live-streaming,
  // merged at render. useChat's `messages` never renders.
  const displayMessages = plainMessages;

  // One "messages not ready yet" signal: the cache entry's load state.
  const messagesAreaMode = selectMessagesAreaMode({
    isLoading: isMessagesLoading,
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

      {/* Message-load error (from the conversation cache) — shown above messages so
          it's always visible; a failed load keeps the prior snapshot. */}
      {messagesLoadState.hasError && (
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
              onScrollNearTop={handleScrollNearTop}
              isLoadingOlder={isLoadingOlder}
              hasMoreOlder={hasMoreOlder}
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
          cause={errorCause}
          show={showError}
          onClearError={() => {
            setShowError(false);
            dismissError();
          }}
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
          onReadAloudClick={handleReadAloudClick}
          isReadingAloud={isReadingAloud}
          canReadAloud={canReadAloud}
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
