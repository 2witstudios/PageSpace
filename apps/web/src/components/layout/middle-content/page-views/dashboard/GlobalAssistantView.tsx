/**
 * GlobalAssistantView - Main view for Global Assistant and Agent mode
 *
 * This component operates in two modes:
 * 1. Global Assistant Mode: Workspace-level assistant synced with sidebar
 * 2. Agent Mode: Page-level AI agent using centralized usePageAgentDashboardStore
 *
 * IMPORTANT: This view never has tabs. The right sidebar provides History and
 * Settings tabs that control this view via the shared usePageAgentDashboardStore.
 *
 * STATE MANAGEMENT ARCHITECTURE (3 Systems - Intentional Design):
 *
 * 1. GlobalChatContext (React Context)
 *    - Manages Global Assistant conversations ONLY
 *    - Used when selectedAgent is null
 *    - Persists conversation ID to cookies
 *
 * 2. usePageAgentDashboardStore (Zustand)
 *    - Dashboard/drive context ONLY
 *    - Synced with this middle panel AND the right sidebar
 *    - Agent selection, conversations, sidebar tab state (activeTab)
 *    - Persists agent ID to cookies/URL
 *
 * 3. usePageAgentSidebarState (Zustand + localStorage)
 *    - Page context ONLY (when viewing a specific page)
 *    - Independent from page content - sidebar is standalone
 *    - Has its own agent selection and conversation state
 *    - Persists agent selection to localStorage
 *
 * WHY TWO AGENT STORES (usePageAgentDashboardStore vs usePageAgentSidebarState):
 * The sidebar is designed as an independent chat interface. When viewing
 * a page, users can chat with Agent A in the sidebar while viewing Page B.
 * This independence is intentional UX - only on /dashboard and /drive routes
 * do we sync the sidebar with this middle panel via usePageAgentDashboardStore.
 *
 * TAB COMMUNICATION (replacing localStorage event bus):
 * Instead of using localStorage.setItem() + window.dispatchEvent() for cross-
 * component tab switching, we use usePageAgentDashboardStore.setActiveTab(). The right
 * sidebar subscribes to activeTab in dashboard context, ensuring reactive updates.
 */

import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import type { UIMessage } from 'ai';
import { useChat } from '@ai-sdk/react';
import { toast } from 'sonner';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Activity, Plus, History } from 'lucide-react';
import { AiUsageMonitor, AISelector, TasksDropdown } from '@/components/ai/shared';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { useGlobalChatConfig, useGlobalChatConversation } from '@/contexts/GlobalChatContext';
import { usePageAgentDashboardStore } from '@/stores/page-agents';
import { useVoiceModeStore, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import { VoiceCallPanel } from '@/components/ai/voice/VoiceCallPanel';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';

// Shared hooks and components
import {
  useMCPTools,
  useCacheMessageActions,
  useProviderSettings,
  useChatTransport,
  useSendHandoff,
  useConversationSendHandoff,
  HANDOFF_REFUSED_MESSAGE,
  useResumeBootstrap,
  useAnswerAskUser,
  useChatErrorCause,
  buildChatConfig,
  AGENT_CHAT_ID,
  LocationContext,
  buildGlobalChatRequestBody,
} from '@/lib/ai/shared';
import { buildContextRef, type ContextRef } from '@/lib/ai/shared/buildContextRef';
import { AskUserAnswerProvider } from '@/components/ai/shared/chat/ask-user/AskUserAnswerContext';
import { useEditingStore } from '@/stores/useEditingStore';
import { useAgentChannelMultiplayer } from '@/hooks/useAgentChannelMultiplayer';
import { canResumeRecovery } from '@/lib/ai/streams/canResumeRecovery';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import {
  ProviderSetupCard,
} from '@/components/ai/shared/chat';
import {
  ChatLayout,
  type ChatLayoutRef,
} from '@/components/ai/chat/layouts';
import { ChatInput, type ChatInputRef } from '@/components/ai/chat/input';
import { useImageAttachments } from '@/lib/ai/shared/hooks/useImageAttachments';
import { hasVisionCapability } from '@/lib/ai/core/vision-models';
import { DEFAULT_PROVIDER } from '@/lib/ai/core/ai-providers-config';
import { useAuth } from '@/hooks/useAuth';
import { useConversationActiveStream, useActiveStream } from '@/hooks/useActiveStream';
import { useStopStream } from '@/hooks/useStopStream';
import { useOwnStreamMirror } from '@/hooks/useOwnStreamMirror';
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

const VOICE_OWNER: VoiceModeOwner = 'global-assistant';

const GlobalAssistantView: React.FC = () => {
  const pathname = usePathname();
  const setRightSidebarOpen = useLayoutStore((state) => state.setRightSidebarOpen);
  const setRightSheetOpen = useLayoutStore((state) => state.setRightSheetOpen);
  const { user } = useAuth();

  // ============================================
  // GLOBAL CHAT CONTEXT - for Global Assistant mode
  // ============================================
  const { chatConfig: globalChatConfig } = useGlobalChatConfig();
  const { currentConversationId: globalConversationId, isInitialized: globalIsInitialized, createNewConversation, rejoinGlobalStream } = useGlobalChatConversation();

  // ============================================
  // AGENT STORE - for agent selection and conversation management
  // ============================================
  // NO message arrays here (PR 5B, leaf 5.3): the store keeps agent selection +
  // conversation identity; messages come from the shared conversation cache below.
  const selectedAgent = usePageAgentDashboardStore((state) => state.selectedAgent);
  const selectAgent = usePageAgentDashboardStore((state) => state.selectAgent);
  const initializeFromUrlOrCookie = usePageAgentDashboardStore((state) => state.initializeFromUrlOrCookie);
  const agentConversationId = usePageAgentDashboardStore((state) => state.conversationId);
  const agentIsLoading = usePageAgentDashboardStore((state) => state.isConversationLoading);
  const createAgentConversation = usePageAgentDashboardStore((state) => state.createNewConversation);
  const loadMostRecentConversation = usePageAgentDashboardStore((state) => state.loadMostRecentConversation);
  const setActiveTab = usePageAgentDashboardStore((state) => state.setActiveTab);
  const loadAgentConversation = usePageAgentDashboardStore((state) => state.loadConversation);

  // Remote in-progress streams for the active chat — one facade read per mode
  // (container-agnostic consumer rule: components never reach into
  // usePendingStreamsStore; useActiveStream is the sanctioned read).
  const channelIdForGlobal = user?.id ? globalChannelId(user.id) : null;
  const { streams: agentRemoteStreams } = useActiveStream(selectedAgent?.id ?? '', agentConversationId);
  const { streams: globalRemoteStreams } = useActiveStream(channelIdForGlobal ?? '', globalConversationId);
  const remoteStreams = selectedAgent ? agentRemoteStreams : globalRemoteStreams;

  // ============================================
  // CENTRALIZED ASSISTANT SETTINGS (from store)
  // ============================================
  const showPageTree = useAssistantSettingsStore((state) => state.showPageTree);
  const currentProvider = useAssistantSettingsStore((state) => state.currentProvider);
  const currentModel = useAssistantSettingsStore((state) => state.currentModel);
  const loadSettings = useAssistantSettingsStore((state) => state.loadSettings);
  const webSearchEnabled = useAssistantSettingsStore((state) => state.webSearchEnabled);
  const imageGenEnabled = useAssistantSettingsStore((state) => state.imageGenEnabled);
  const writeMode = useAssistantSettingsStore((state) => state.writeMode);

  // Derive isReadOnly from writeMode (inverse) for API request body
  const isReadOnly = !writeMode;

  // ============================================
  // LOCAL STATE
  // ============================================
  const [input, setInput] = useState<string>('');
  const [showError, setShowError] = useState(true);
  const [locationContext, setLocationContext] = useState<LocationContext | null>(null);
  const [lastAIResponse, setLastAIResponse] = useState<{ id: string; text: string } | null>(null);
  // undefined = uninitialized, null = initialized with no baseline message, string = baseline message ID
  const voiceBaselineRef = useRef<string | null | undefined>(undefined);
  // Agent mode state (provider/model settings)
  const [agentSelectedProvider, setAgentSelectedProvider] = useState<string>(DEFAULT_PROVIDER);
  const [agentSelectedModel, setAgentSelectedModel] = useState<string>('');

  // Voice mode state
  const isVoiceModeEnabled = useVoiceModeStore((s) => s.isEnabled);
  const voiceOwner = useVoiceModeStore((s) => s.owner);
  const enableVoiceMode = useVoiceModeStore((s) => s.enable);
  const disableVoiceMode = useVoiceModeStore((s) => s.disable);
  const isVoiceModeActive = isVoiceModeEnabled && voiceOwner === VOICE_OWNER;

  // Display preferences
  const { preferences: displayPreferences } = useDisplayPreferences();

  // Image attachments for vision support
  const { attachments, addFiles, removeFile, getFilesForSend } = useImageAttachments();

  // Refs
  const chatLayoutRef = useRef<ChatLayoutRef>(null);
  const inputRef = useRef<ChatInputRef>(null);
  // Populated after useAgentChannelMultiplayer runs (called further down); used by
  // rejoinActiveMode via ref so that callback doesn't depend on hook ordering.
  const rejoinAgentStreamRef = useRef<() => void>(() => {});

  // ============================================
  // SHARED HOOKS
  // ============================================
  const currentConversationId = selectedAgent ? agentConversationId : globalConversationId;

  const { isLoading: isLoadingProviders, isAnyProviderConfigured, needsSetup } =
    useProviderSettings();

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

  // Get drives from store
  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  // ============================================
  // INITIALIZATION EFFECTS
  // ============================================

  // Initialize agent store from URL/cookie
  useEffect(() => {
    initializeFromUrlOrCookie();
  }, [initializeFromUrlOrCookie]);

  // Load drives
  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  // Load most recent conversation when agent is selected
  useEffect(() => {
    if (selectedAgent && !agentConversationId && !agentIsLoading) {
      loadMostRecentConversation();
    }
  }, [selectedAgent, agentConversationId, agentIsLoading, loadMostRecentConversation]);

  // Extract location context from pathname — UI display only (welcome text,
  // mention-picker driveId below). Message sends must NOT read this state —
  // it's effect-derived and can lag a fast navigate-then-send by a render.
  // Sends build a `ContextRef` instead (buildFreshContextRef, below),
  // synchronously from the current pathname/drives — the server resolves +
  // permission-checks it at request time (resolve-request-context.ts).
  useEffect(() => {
    const pathParts = pathname.split('/').filter(Boolean);
    if (pathParts.length >= 2 && pathParts[0] === 'dashboard') {
      const driveId = pathParts[1];
      const driveData = drives.find((d) => d.id === driveId);
      setLocationContext({
        currentDrive: driveData
          ? { id: driveData.id, slug: driveData.slug, name: driveData.name }
          : null,
        currentPage: null,
        breadcrumbs: driveData ? [driveData.name] : [],
      });
    } else {
      setLocationContext(null);
    }
  }, [pathname, drives]);

  const buildFreshContextRef = useCallback(
    (): ContextRef => buildContextRef(pathname, drives),
    [pathname, drives],
  );

  // Initialize settings store on mount
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Load agent config when agent is selected
  useEffect(() => {
    const loadAgentConfig = async () => {
      if (!selectedAgent) {
        return;
      }
      try {
        const response = await fetchWithAuth(`/api/pages/${selectedAgent.id}/agent-config`);
        if (response.ok) {
          const config = await response.json();
          if (config.aiProvider) setAgentSelectedProvider(config.aiProvider);
          if (config.aiModel) setAgentSelectedModel(config.aiModel);
        }
      } catch (error) {
        console.error('Failed to load agent config:', error);
      }
    };
    loadAgentConfig();
  }, [selectedAgent]);


  // ============================================
  // CHAT CONFIGURATION
  // ============================================

  const agentTransport = useChatTransport(agentConversationId, '/api/ai/chat', selectedAgent?.id ?? null);

  // Agent mode chat config
  const agentChatConfig = useMemo(() => {
    if (!selectedAgent || !agentConversationId || !agentTransport) return null;

    return buildChatConfig({
      id: AGENT_CHAT_ID,
      transport: agentTransport,
      onError: (error: Error) => {
        console.error('Agent Chat error:', error);
      },
    });
  }, [selectedAgent, agentConversationId, agentTransport]);

  // Global mode chat
  const {
    messages: globalLocalMessages,
    sendMessage: globalSendMessage,
    status: globalStatus,
    error: globalError,
    clearError: globalClearError,
    regenerate: globalRegenerate,
    setMessages: setGlobalLocalMessages,
    stop: globalStop,
    addToolResult: globalAddToolResult,
  } = useChat(globalChatConfig || {});

  // Agent mode chat
  const {
    messages: agentMessages,
    sendMessage: agentSendMessage,
    status: agentStatus,
    error: agentError,
    clearError: agentClearError,
    regenerate: agentRegenerate,
    setMessages: setAgentMessages,
    stop: agentStop,
    addToolResult: agentAddToolResult,
  } = useChat(agentChatConfig || {});

  // ============================================
  // UNIFIED INTERFACE - select based on mode
  // ============================================
  // NO mode-selected `messages` alias: nothing renders or reasons over the raw
  // transport arrays any more — the mirrors read their own per-chat arrays, and
  // every other consumer uses the rendered/settled cache views.
  const sendMessage = selectedAgent ? agentSendMessage : globalSendMessage;
  const status = selectedAgent ? agentStatus : globalStatus;
  const error = selectedAgent ? agentError : globalError;
  const clearError = selectedAgent ? agentClearError : globalClearError;
  const regenerate = selectedAgent ? agentRegenerate : globalRegenerate;
  const rawStop = selectedAgent ? agentStop : globalStop;
  const addToolResult = selectedAgent ? agentAddToolResult : globalAddToolResult;
  const isStreaming = status === 'submitted' || status === 'streaming';

  // ============================================
  // STREAM/STOP — one selector read per mode (PR 5A)
  // ============================================
  // The channel each mode's streams live on. Agent streams are keyed by the agent's page id;
  // global streams by this user's global channel id. Both are what useChannelStreamSocket and
  // useOwnStreamMirror write their store entries under.
  // Stable identity for both mirror mounts — useOwnStreamMirror depends on the FIELDS, not the
  // object, but memoizing keeps the two call sites honest about sharing one value.
  const mirrorTriggeredBy = useMemo(
    () => ({ userId: user?.id ?? '', displayName: user?.name || user?.email || 'You' }),
    [user?.id, user?.name, user?.email],
  );

  const agentActiveStream = useConversationActiveStream(selectedAgent?.id ?? null, agentConversationId);
  const globalActiveStream = useConversationActiveStream(channelIdForGlobal, globalConversationId);
  const activeStream = selectedAgent ? agentActiveStream : globalActiveStream;

  // THE stream identity, for BOTH modes, replacing four holdForStream refs and
  // selectLiveAssistantIds. This surface hosts TWO independent chats and both can be in flight at
  // once — switching mode does not abort the running POST, because useChat's id is constant. The
  // old code derived one id from the MODE-SELECTED status/messages and fed it to both hold-refs,
  // which let the IDLE mode's ref latch the ACTIVE mode's messageId: Stop, back in the other
  // mode, aborted the WRONG stream while the real one kept billing.
  //
  // Two independent store reads, each scoped to its own channel + conversation, cannot make that
  // mistake: a stream's identity comes from ITS OWN chat's store entry, never from whichever mode
  // the surface happens to be rendering. And the entry is latched at stream_start and immune to
  // the surface moving (a mid-stream conversation switch, "New Chat" emptying the array), which is
  // what the hold-refs were for.
  // Hand off to OUR OWN stream, never merely "a stream exists": on a shared conversation a
  // remote user's live stream would otherwise end our pendingSend the instant we clicked send,
  // leaving the submitted window — the one it exists to cover — unprotected.
  const { wrapSend, pendingSendConversationId } = useSendHandoff(
    currentConversationId,
    status,
    activeStream?.isOwn === true,
  );


  // "Is MY OWN stream live for the conversation on screen", per chat. The #2061 clobber
  // guards that used to consume these died with PR 5B (merge-at-render made them
  // unnecessary); what remains is the resume handler's "had a turn in flight" record —
  // conversation-scoped, so a stream still running against a conversation the user left
  // cannot trigger a regenerate for the one they are now looking at.
  const isOwnAgentStreamForCurrentConversation = agentActiveStream?.isOwn === true;
  const isOwnGlobalStreamForCurrentConversation = globalActiveStream?.isOwn === true;
  // For guarding TRANSPORT-ARRAY writes, the store entry is not enough: it is absent for the whole
  // submitted window (by design) and during any temporary store wipe (clearPageStreams on a socket
  // swap). Each chat's own status covers those; the store entry still covers a bootstrapped stream,
  // where our status is idle. Per chat — the two are independent and both can be in flight.
  const agentSendUnsafeToClobber = agentStatus === 'submitted' || agentStatus === 'streaming' || isOwnAgentStreamForCurrentConversation;
  const globalSendUnsafeToClobber = globalStatus === 'submitted' || globalStatus === 'streaming' || isOwnGlobalStreamForCurrentConversation;

  // Streaming for THE CONVERSATION ON SCREEN. `isStreaming` (useChat's status) alone is wrong in
  // both directions: it is true for the OLD conversation's still-in-flight request after a switch
  // (useChat's id is constant, so it keeps reporting), and false for a bootstrapped stream after a
  // refresh — the case where the surface showed Send while the server was still generating.
  //
  // `pendingSendConversationId` covers the submitted window, where no store entry exists yet.
  // (`pendingSendConversationId !== null` first: both ids are null before identity resolves, and
  // `null === null` would light the Stop button on an empty surface.)
  // OWN streams only — same rule as the merged AiChatView (`isStreaming || ownStreamMessageId`).
  // A REMOTE stream on a shared conversation is live content worth SHOWING, but it is not
  // something this tab can stop: the server's abort is user-scoped, so a Stop wired to it reports
  // 'not_found' and stays silent. Folding remote streams in here would light a Stop button that
  // cannot work, and would suppress the `remoteStreamingUser` chip (gated on !effectiveIsStreaming)
  // that exists to say who IS generating.
  const effectiveIsStreaming =
    activeStream?.isOwn === true ||
    (pendingSendConversationId !== null && pendingSendConversationId === currentConversationId);

  // ============================================
  // STORE-FIRST RENDERING (PR 5B, leaf 5.2)
  // ============================================
  // The channel each mode's messages/streams live on — same key the socket
  // writer and the own-stream mirror use.
  const streamChannelId = selectedAgent ? selectedAgent.id : channelIdForGlobal;
  // The store-first render source: DB-confirmed + optimistic-sent + live-streaming
  // messages for the active conversation, merged at render (not at write) so no
  // effect ordering can blank a live stream. useChat's `messages` (destructured
  // above) never renders post-cutover — it stays the transport/controller only.
  const renderedMessages = useRenderedMessages(streamChannelId ?? '', currentConversationId);
  const plainMessages = useMemo(() => renderedMessages.map((r) => r.message), [renderedMessages]);

  // Read Aloud: on-demand TTS for everything the assistant said since the
  // user's last turn, via a shared playback singleton (see readAloudPlayer).
  const { isReadingAloud, toggleReadAloud, canReadAloud: canReadAloudFor } = useReadAloud();
  const canReadAloud = useMemo(() => canReadAloudFor(plainMessages), [canReadAloudFor, plainMessages]);
  const handleReadAloudClick = useCallback(
    () => toggleReadAloud(plainMessages),
    [toggleReadAloud, plainMessages]
  );
  // Loading/error UI reads the cache entry's state (replaces the context's
  // isMessagesLoading and the dashboard store's isConversationMessagesLoading).
  const messagesLoadState = useConversationLoadState(currentConversationId);

  // Voice's live-stream text (epic leaf 6.4) — one selector, three consumers.
  const streamingAssistantText = useMemo(
    () => selectVoiceStreamText(renderedMessages),
    [renderedMessages],
  );
  // TRANSITIONAL (see useOwnStreamMirror) — copies each chat's own live assistant reply from
  // useChat's local state into usePendingStreamsStore, so this surface's own streams are present
  // in the store the same way a bootstrapped or remote one is. Everything above derives from
  // store presence, so without these two mounts an own local stream would be invisible to its own
  // Stop button.
  //
  // MOUNTED PER CHAT, never for the mode-selected one: both chats can be in flight at once, and
  // mirroring only the visible mode would drop the other's stream out of the store mid-generation
  // — the same class of bug as the shared hold-refs this replaces. Each mount reads its OWN
  // chat's messages/status and writes under its OWN channel + conversation.
  //
  // `ownAssistantMessage` deliberately reads the raw useChat arrays: this is the ONE place that
  // must read the SDK's live-growing content in order to copy it OUT into the store. It is
  // undefined unless the last message is an assistant's — during the submitted window the last
  // message is the user's own, which is exactly why no store entry exists in that window (and why
  // Stop falls back to the send-time conversationId there).
  const { getLatchedConversationId: getAgentLatchedConversationId } = useOwnStreamMirror({
    status: agentStatus,
    ownMessages: agentMessages,
    pageId: selectedAgent?.id ?? '',
    conversationId: agentConversationId ?? '',
    triggeredBy: mirrorTriggeredBy,
  });

  const { getLatchedConversationId: getGlobalLatchedConversationId } = useOwnStreamMirror({
    status: globalStatus,
    ownMessages: globalLocalMessages,
    pageId: channelIdForGlobal ?? '',
    conversationId: globalConversationId ?? '',
    triggeredBy: mirrorTriggeredBy,
  });

  // Pre-send handoff, PER CHAT like the mirrors: a send into a different conversation than the
  // one a chat is consuming for must first stop the local read and hand the in-flight stream to
  // the socket path — the SDK's Chat cannot consume two response bodies at once, and a second
  // concurrent send is how chat 1's stream ended up rendering inside chat 2. See
  // useConversationSendHandoff.
  // Through the ref: useAgentChannelMultiplayer mounts further down, and the ref is its standing
  // late-binding (same pattern as the recovery path's rejoinAgentStreamRef.current() call).
  const rejoinAgentStreamLate = useCallback(() => { rejoinAgentStreamRef.current(); }, []);
  const { prepareSend: prepareAgentSend } = useConversationSendHandoff({
    status: agentStatus,
    stop: agentStop,
    getLatchedConversationId: getAgentLatchedConversationId,
    rejoin: rejoinAgentStreamLate,
  });
  const { prepareSend: prepareGlobalSend } = useConversationSendHandoff({
    status: globalStatus,
    stop: globalStop,
    getLatchedConversationId: getGlobalLatchedConversationId,
    rejoin: rejoinGlobalStream,
  });
  const prepareSendForMode = selectedAgent ? prepareAgentSend : prepareGlobalSend;

  // Declared after the mirrors: the rawStop gate reads the mode-selected latch, so a Stop on a
  // socket-attached conversation cannot abort another conversation's live local fetch.
  const stop = useStopStream({
    activeStream,
    pendingSendConversationId,
    rawStop,
    getLocalSendConversationId: selectedAgent ? getAgentLatchedConversationId : getGlobalLatchedConversationId,
    targetConversationId: currentConversationId,
  });


  const remoteStreamingUser = !effectiveIsStreaming
    ? remoteStreams.find((s) => !s.isOwn)?.triggeredBy ?? null
    : null;
  // Agent mode: initialized when we have a conversationId and not loading
  // Global mode: use globalIsInitialized from context
  const agentIsInitialized = selectedAgent ? (!!agentConversationId && !agentIsLoading) : false;
  const isInitialized = selectedAgent ? agentIsInitialized : globalIsInitialized;
  // Identity can be 'ready' (isInitialized true) while messages for the
  // conversation just switched to are still in flight — the cache entry's
  // load state covers that window (PR 5B: no per-surface loading flags).
  const isMessagesLoading = messagesLoadState.isLoading;
  const isLoading = !isInitialized || isMessagesLoading;

  // Reload the active conversation's cache entry — the one refetch path for this
  // surface (undo, pull-up, app resume, error retry all funnel here). Staleness is
  // the loader's loadGeneration gate; merge-at-render keeps a live stream visible
  // regardless of what the DB snapshot contains, which is what deleted the six
  // #2061 clobber guards.
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
  const { isLoadingOlder } = useConversationOlderPageState(currentConversationId);
  const handleScrollNearTop = useCallback(() => {
    const conversationId = currentConversationId;
    if (!conversationId) return;
    if (selectedAgent) {
      void loadOlderAgentConversationMessages(selectedAgent.id, conversationId);
    } else {
      void loadOlderGlobalConversationMessages(conversationId);
    }
  }, [currentConversationId, selectedAgent]);

  // ============================================
  // MESSAGE ACTIONS — shared store-first wrapper (F2/F9: actions reason over
  // SETTLED rows only; the live bubble's verb is Stop, and a synthesized
  // streaming row must never reach retry/delete's server-side DELETEs).
  // ============================================
  const setMessages = selectedAgent ? setAgentMessages : setGlobalLocalMessages;
  const isOwnSendLive = selectedAgent ? agentSendUnsafeToClobber : globalSendUnsafeToClobber;
  // Read after an await (resume runs async), so a ref rather than the captured value.
  const isOwnSendLiveRef = useRef(isOwnSendLive);
  isOwnSendLiveRef.current = isOwnSendLive;
  // Conversation-scoped counterpart, for consumers that must not see the OLD conversation's
  // still-in-flight raw useChat status as "busy" (PR 6 review, CodeRabbit, same class as the
  // AskUser fix above) — resume's isOwnStreamLive gate, unlike useCacheMessageActions' clobber
  // guard, which is deliberately conversation-agnostic.
  const effectiveIsStreamingRef = useRef(effectiveIsStreaming);
  effectiveIsStreamingRef.current = effectiveIsStreaming;

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

  // Undo restructures the conversation server-side — reload the cache entry (PR 5B,
  // leaf 5.4 W1). No transport write and no own-stream merge dance: the cache write is
  // conversation-keyed, and merge-at-render keeps a live own stream visible over any
  // DB snapshot (that is what deleted the whole guard/merge apparatus that lived here).
  const handleUndoSuccess = useCallback(async () => {
    await reloadCurrentConversation();
  }, [reloadCurrentConversation]);

  // Pull-up / resume refresh: check for messages this surface missed (real-time may
  // have failed, or the app was backgrounded). Same cache reload (leaf 5.4 W2) —
  // staleness is the loader's loadGeneration gate.
  const handlePullUpRefresh = useCallback(async () => {
    await reloadCurrentConversation();
  }, [reloadCurrentConversation]);

  // Re-bootstrap whichever mode is on screen (epic leaf 6.2's `rejoin` step). The ref
  // indirection is because useAgentChannelMultiplayer (below) is the one that actually
  // produces rejoinAgentStream, and this callback is declared above that hook call.
  const rejoinActiveMode = useCallback(() => {
    if (selectedAgent) {
      rejoinAgentStreamRef.current();
    } else {
      rejoinGlobalStream();
    }
  }, [selectedAgent, rejoinGlobalStream]);

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
    reload: handlePullUpRefresh,
    stop: rawStop,
    isOwnStreamLive: useCallback(() => effectiveIsStreamingRef.current, []),
    enabled: resumeEnabled,
  });


  // ============================================
  // MODE-SWITCH STREAM EFFECTS
  // ============================================
  // NO clear-agent-messages-on-global effect (PR 5B, leaf 5.4 W6): rendering is
  // per-conversation from the cache, so a stale transport array renders nothing —
  // and the mirror latches only during its own send, so an un-cleared array cannot
  // mislead it (PR 5A's latch fix). The clear existed for the old render path.

  // Stop global stream when switching to agent mode. Local-only stop — the accepted
  // residual on the PR 5 node (the server generation continues) stands; recorded there.
  useEffect(() => {
    if (selectedAgent && (globalStatus === 'submitted' || globalStatus === 'streaming')) {
      globalStop();
    }
  }, [selectedAgent, globalStatus, globalStop]);

  // NO refreshSignal effect (PR 5B, leaf 5.4): remote events write the conversation
  // cache directly in GlobalChatContext — merge-at-render means a DB snapshot landing
  // mid-stream cannot blank the live bubble, so there is no guard to arbitrate and no
  // signal to consume. This deletes GVA clobber guards #2061/1-3 of this surface's set.

  // NO STREAM/STOP SYNC EFFECTS (PR 5A).
  //
  // Four effects used to live here, each copying a fact out of a useChat instance and into a slot
  // somebody else read: the global streaming flag, the global stop fn, the agent streaming flag
  // (dashboard store), and the agent stop fn. They are deleted, not moved — the store already
  // holds {messageId, conversationId, isOwn} for every live stream, so the fact never needed
  // copying; it needed READING, which is what useConversationActiveStream does above.
  //
  // What went with them: level-triggered-set/edge-triggered-clear flag juggling, `ownsFlagRef`
  // and `clearGlobalStopIfOurs`/`clearAgentStopIfOurs` (this component was never the only writer
  // of those shared slots — the bootstrap path claimed them too, so every clear had to prove the
  // slot was still ours), and their cleanups, which fired on every 'ready' render and so ran for
  // the entire life of a bootstrapped stream.
  //
  // This is Elliott rail 11: no effect may copy state between stateful containers. The mirror
  // above is the one sanctioned exception, and it is TRANSITIONAL.

  // NO load-on-select effects (PR 5B, leaf 5.2): loads commit straight to the
  // conversation cache (dashboard store loaders / GlobalChatContext), and rendering
  // is `selectRenderedMessages(cacheEntry, activeStreams)` — there is no useChat
  // array to re-apply loaded history into, no conversationLoadSignal to watch, and
  // no mid-stream clobber to guard against (merge-at-render). This deletes the
  // remaining #2061 clobber guards on this surface.

  // Agent-mode multiplayer wiring. No-op when selectedAgent is null. Message
  // callbacks write the shared conversation cache (PR 5B, leaf 5.6); reconnect
  // reloads via the dashboard store's cache-committing loader.
  const { rejoinActiveStreams: rejoinAgentStream } = useAgentChannelMultiplayer({
    selectedAgent,
    agentConversationId,
    loadConversation: loadAgentConversation,
  });
  // Keep the ref current so tryRecover (defined above) can call it without
  // depending on hook-call ordering.
  rejoinAgentStreamRef.current = rejoinAgentStream;

  // NO editing-store registration here (PR 5A, leaf 5.7): one derived, conversation-keyed
  // registration for the whole app now lives in GlobalChatProvider
  // (useDerivedStreamingRegistrations). This site registered on useChat's `isStreaming`, which is
  // idle for a bootstrapped stream after a refresh — so the window this surface most needed SWR
  // protection in was exactly the window it declared itself not streaming.

  // Typed error cause, per-conversation (epic leaf 6.5) — replaces raw `error`/getAIErrorMessage.
  const { cause: errorCause, dismiss: dismissError } = useChatErrorCause(
    currentConversationId,
    error,
    clearError,
    pendingSendConversationId ?? currentConversationId,
  );
  // Reset error visibility when new error occurs
  useEffect(() => {
    if (errorCause) setShowError(true);
  }, [errorCause]);

  // ============================================
  // HANDLERS
  // ============================================

  const handleNewConversation = async () => {
    if (selectedAgent) {
      await createAgentConversation();
    } else {
      await createNewConversation();
    }
  };

  const handleOpenActivity = () => {
    // Open both sidebar (desktop) and sheet (mobile) to ensure visibility on all breakpoints
    setRightSidebarOpen(true);
    setRightSheetOpen(true);
    setActiveTab('activity');
  };

  const handleOpenHistory = () => {
    // Open both sidebar (desktop) and sheet (mobile) to ensure visibility on all breakpoints
    setRightSidebarOpen(true);
    setRightSheetOpen(true);
    setActiveTab('history');
  };

  // Shared by every send-shaped request (typed send, voice send, AskUser resume) — one
  // definition means the body a resume POST carries can't drift from what a real send
  // would have sent (epic leaf 6.3: deletes the separate buildAskUserAnswerBody).
  const buildRequestBody = useCallback(() => {
    return selectedAgent
      ? {
          chatId: selectedAgent.id,
          conversationId: currentConversationId,
          selectedProvider: agentSelectedProvider,
          selectedModel: agentSelectedModel,
          isReadOnly,
          webSearchEnabled,
          imageGenEnabled,
          mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
        }
      : buildGlobalChatRequestBody({
          conversationId: currentConversationId,
          isReadOnly,
          webSearchEnabled,
          imageGenEnabled,
          showPageTree,
          contextRef: buildFreshContextRef(),
          selectedProvider: currentProvider,
          selectedModel: currentModel,
          mcpTools: mcpToolSchemas,
        });
  }, [
    currentConversationId,
    selectedAgent,
    agentSelectedProvider,
    agentSelectedModel,
    isReadOnly,
    webSearchEnabled,
    imageGenEnabled,
    showPageTree,
    buildFreshContextRef,
    currentProvider,
    currentModel,
    mcpToolSchemas,
  ]);

  const handleSendMessage = async () => {
    const files = getFilesForSend();
    if ((!input.trim() && files.length === 0) || !currentConversationId) return;

    const requestBody = buildRequestBody();

    // Capture the draft BEFORE the handoff await below: the wait can run up to ~1.5s, and
    // anything the user types or attaches during it must survive (Codex review, PR #2121).
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

    // Client-minted id, parts-form send (PR 4 pattern): the `{text, files}` shorthand
    // silently drops any id passed alongside it, so the message would push under an
    // SDK-generated id the conversation cache never saw. Written to the cache
    // immediately (optimistic) because the sender's own tab never receives its own
    // chat:user_message broadcast back — this is what makes the bubble appear the
    // same tick the user hits Send (leaf 5.2 acceptance).
    const userMessage = buildUserMessage({
      id: createId(),
      text: text.trim().length > 0 ? text : undefined,
      files: sendFiles,
    }) as UIMessage;
    conversationMessagesActions.addOptimisticSend(currentConversationId, userMessage);

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    rollbackOptimisticSendOnFailure(
      () => wrapSend(() => sendMessage(userMessage, { body: requestBody })),
      currentConversationId,
      userMessage.id,
    );
    // Note: scrollToBottom is now handled by use-stick-to-bottom when pinned
  };

  // Voice mode: Send message from voice transcript
  const handleVoiceSend = useCallback(async (text: string) => {
    if (!text.trim() || !currentConversationId) return;

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
      () => wrapSend(() => sendMessage(userMessage, { body: buildRequestBody() })),
      currentConversationId,
      userMessage.id,
    );
  }, [currentConversationId, sendMessage, buildRequestBody, wrapSend, prepareSendForMode]);

  // renderedMessages (selector output), not useChat's raw `messages`: "answerable" is
  // decided by whether the ask_user part sits on the conversation's LAST message, and
  // remote edits/deletes/messages update the store, not useChat's local array.
  // isConversationBusy replaces status==='ready'. Conversation-scoped effectiveIsStreaming,
  // not isOwnSendLive: the latter includes raw useChat status, which stays true for the OLD
  // conversation's still-in-flight request after a switch (PR 6 review, CodeRabbit) — that
  // would incorrectly disable an answerable AskUser prompt in the conversation on screen now.
  const askUserAnswering = useAnswerAskUser({
    conversationId: currentConversationId,
    renderedMessages,
    isConversationBusy: effectiveIsStreaming,
    setMessages,
    addToolResult,
    wrapSend,
    buildBody: buildRequestBody,
    // Answering re-invokes the chat — same cross-conversation handoff as every send path.
    prepareSend: prepareSendForMode,
  });

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
        onApiKeySubmit={(_provider) => {
          // Reload settings after API key submission to detect newly configured provider
          loadSettings();
        }}
      />
    );
  }

  return (
    <AskUserAnswerProvider value={askUserAnswering}>
    <div data-testid="global-assistant-view" className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-[var(--separator)]">
        <div className="flex items-center space-x-2">
          <AISelector
            selectedAgent={selectedAgent}
            onSelectAgent={selectAgent}
            disabled={isStreaming}
          />
        </div>
        <div className="flex items-center space-x-2">
          <TasksDropdown messages={plainMessages} driveId={selectedAgent?.driveId || locationContext?.currentDrive?.id} />
          <Button
            variant="ghost"
            size="icon"
            onClick={handleOpenHistory}
            className="h-8 w-8"
            title="View History"
          >
            <History className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleOpenActivity}
            className="h-8 w-8"
            title="Open Activity"
          >
            <Activity className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNewConversation}
            className="flex items-center gap-2"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New</span>
          </Button>
        </div>
      </div>

      {/* Usage Monitor */}
      {displayPreferences.showTokenCounts && (
        <div className="flex items-center justify-end px-4 py-2 border-b border-gray-200 dark:border-[var(--separator)]">
          {selectedAgent ? (
            <AiUsageMonitor pageId={selectedAgent.id} compact />
          ) : (
            currentConversationId && (
              <AiUsageMonitor conversationId={currentConversationId} compact />
            )
          )}
        </div>
      )}

      {/* Message-load error (from the conversation cache) — never a silent blank:
          a failed load keeps the prior snapshot and surfaces this retry. */}
      {messagesLoadState.hasError && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 bg-destructive/10 text-destructive text-sm border-b border-destructive/20">
          <span className="truncate">Failed to load messages</span>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => void reloadCurrentConversation()}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Chat Interface - unified for both modes with floating input */}
      <ChatLayout
        ref={chatLayoutRef}
        conversationId={currentConversationId}
        messages={plainMessages}
        input={input}
        onInputChange={setInput}
        onSend={handleSendMessage}
        onStop={stop}
        isStreaming={effectiveIsStreaming}
        isLoading={isLoading}
        disabled={!isAnyProviderConfigured || !isInitialized}
        placeholder={selectedAgent ? `Ask ${selectedAgent.title}...` : 'Ask about your workspace...'}
        driveId={selectedAgent ? selectedAgent.driveId : locationContext?.currentDrive?.id}
        crossDrive={!selectedAgent}
        cause={errorCause}
        showError={showError}
        onClearError={() => {
          setShowError(false);
          dismissError();
        }}
        onScrollNearTop={handleScrollNearTop}
        isLoadingOlder={isLoadingOlder}
        welcomeTitle={
          selectedAgent
            ? `Chat with ${selectedAgent.title}`
            : locationContext?.currentDrive
            ? locationContext.currentDrive.name
            : 'How can I help you today?'
        }
        welcomeSubtitle={
          selectedAgent
            ? 'Ask me anything!'
            : locationContext?.currentDrive
            ? 'Ask about pages in this drive, or tell me what you\'re working on.'
            : 'Tell me what you\'re thinking about or working on.'
        }
        onEdit={handleEdit}
        onDelete={handleDelete}
        onRetry={handleRetry}
        lastAssistantMessageId={lastAssistantMessageId}
        lastUserMessageId={lastUserMessageId}
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
        renderInput={(props) => (
          <>
            {isVoiceModeActive && (
              <VoiceCallPanel
                owner={VOICE_OWNER}
                onSend={handleVoiceSend}
                latestAssistantMessage={lastAIResponse}
                isAIStreaming={effectiveIsStreaming}
                streamingText={streamingAssistantText}
                onStopStream={stop}
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
              onVoiceModeClick={handleVoiceModeToggle}
              isVoiceModeActive={isVoiceModeActive}
              onReadAloudClick={handleReadAloudClick}
              isReadingAloud={isReadingAloud}
              canReadAloud={canReadAloud}
              attachments={attachments}
              onAddFiles={addFiles}
              onRemoveFile={removeFile}
              hasVision={hasVisionCapability(
                (selectedAgent ? agentSelectedModel : currentModel) || ''
              )}
              remoteStreamingUser={remoteStreamingUser}
            />
          </>
        )}
      />

    </div>
    </AskUserAnswerProvider>
  );
};

export default React.memo(GlobalAssistantView);
