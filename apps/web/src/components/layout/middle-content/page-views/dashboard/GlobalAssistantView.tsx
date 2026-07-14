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
import { useChat } from '@ai-sdk/react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Activity, Plus, History } from 'lucide-react';
import { AiUsageMonitor, AISelector, TasksDropdown } from '@/components/ai/shared';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { useGlobalChatConfig, useGlobalChatStream, useGlobalChatConversation } from '@/contexts/GlobalChatContext';
import { usePageAgentDashboardStore, agentStreamKey, selectIsAgentStreaming, selectAgentStop, type AgentStreamKey } from '@/stores/page-agents';
import { holdForStream } from '@/lib/ai/streams/holdForStream';
import { selectLiveAssistantIds } from '@/lib/ai/streams/selectLiveAssistantIds';
import { useVoiceModeStore, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import { VoiceCallPanel } from '@/components/ai/voice/VoiceCallPanel';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';

// Shared hooks and components
import {
  useMCPTools,
  useMessageActions,
  useProviderSettings,
  useChatTransport,
  useStreamingRegistration,
  useChatStop,
  useSendHandoff,
  useStreamRecovery,
  useAskUserAnswering,
  buildChatConfig,
  AGENT_CHAT_ID,
  LocationContext,
  buildGlobalChatRequestBody,
} from '@/lib/ai/shared';
import { AskUserAnswerProvider } from '@/components/ai/shared/chat/ask-user/AskUserAnswerContext';
import { abortActiveStream, abortActiveStreamByMessageId, clearActiveStreamId, reportAbortOutcome } from '@/lib/ai/core/client';
import { useAppStateRecovery } from '@/hooks/useAppStateRecovery';
import { useEditingStore } from '@/stores/useEditingStore';
import { useAgentChannelMultiplayer } from '@/hooks/useAgentChannelMultiplayer';
import { selectChannelRemoteStreams } from '@/lib/ai/streams/selectChannelRemoteStreams';
import { decideRecovery } from '@/lib/ai/streams/decideRecovery';
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
import { useGlobalEffectiveStream } from './useGlobalEffectiveStream';
import { useAuth } from '@/hooks/useAuth';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { useShallow } from 'zustand/react/shallow';

const VOICE_OWNER: VoiceModeOwner = 'global-assistant';

const GlobalAssistantView: React.FC = () => {
  const pathname = usePathname();
  const setRightSidebarOpen = useLayoutStore((state) => state.setRightSidebarOpen);
  const setRightSheetOpen = useLayoutStore((state) => state.setRightSheetOpen);
  const { user } = useAuth();

  // ============================================
  // GLOBAL CHAT CONTEXT - for Global Assistant mode
  // ============================================
  const { chatConfig: globalChatConfig, setIsStreaming: setGlobalIsStreaming, setStopStreaming: setGlobalStopStreaming } = useGlobalChatConfig();
  const { isStreaming: contextIsStreaming, stopStreaming: contextStopStreaming } = useGlobalChatStream();
  const { currentConversationId: globalConversationId, isInitialized: globalIsInitialized, isMessagesLoading: globalIsMessagesLoading, initialMessages: globalInitialMessages, createNewConversation, refreshSignal, rejoinGlobalStream } = useGlobalChatConversation();

  // ============================================
  // AGENT STORE - for agent selection and conversation management
  // ============================================
  const selectedAgent = usePageAgentDashboardStore((state) => state.selectedAgent);
  const selectAgent = usePageAgentDashboardStore((state) => state.selectAgent);
  const initializeFromUrlOrCookie = usePageAgentDashboardStore((state) => state.initializeFromUrlOrCookie);
  const agentConversationId = usePageAgentDashboardStore((state) => state.conversationId);
  const agentInitialMessages = usePageAgentDashboardStore((state) => state.conversationMessages);
  const agentIsLoading = usePageAgentDashboardStore((state) => state.isConversationLoading);
  const agentIsMessagesLoading = usePageAgentDashboardStore((state) => state.isConversationMessagesLoading);
  const agentConversationLoadSignal = usePageAgentDashboardStore((state) => state.conversationLoadSignal);
  const setAgentStoreMessages = usePageAgentDashboardStore((state) => state.setConversationMessages);
  const createAgentConversation = usePageAgentDashboardStore((state) => state.createNewConversation);
  const loadMostRecentConversation = usePageAgentDashboardStore((state) => state.loadMostRecentConversation);
  const setAgentStreaming = usePageAgentDashboardStore((state) => state.setAgentStreaming);
  const setAgentStop = usePageAgentDashboardStore((state) => state.setAgentStop);
  const setActiveTab = usePageAgentDashboardStore((state) => state.setActiveTab);
  const loadAgentConversation = usePageAgentDashboardStore((state) => state.loadConversation);

  // Remote in-progress streams for the active chat — channel + filter logic
  // lives in the pure helper so both this view and the sidebar share one
  // tested implementation.
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
  const { attachments, addFiles, removeFile, clearFiles, getFilesForSend } = useImageAttachments();

  // Refs
  const chatLayoutRef = useRef<ChatLayoutRef>(null);
  const inputRef = useRef<ChatInputRef>(null);
  const prevStatusRef = useRef<string>('ready');
  const prevAgentStatusRef = useRef<string>('ready');
  // Populated after useAgentChannelMultiplayer runs (called further down); used
  // in tryRecover via ref so the callback doesn't depend on hook ordering.
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

  // Extract location context from pathname
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
  const messages = selectedAgent ? agentMessages : globalLocalMessages;
  const sendMessage = selectedAgent ? agentSendMessage : globalSendMessage;
  const status = selectedAgent ? agentStatus : globalStatus;
  const error = selectedAgent ? agentError : globalError;
  const clearError = selectedAgent ? agentClearError : globalClearError;
  const regenerate = selectedAgent ? agentRegenerate : globalRegenerate;
  const rawStop = selectedAgent ? agentStop : globalStop;
  const addToolResult = selectedAgent ? agentAddToolResult : globalAddToolResult;
  const isStreaming = status === 'submitted' || status === 'streaming';
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
  const latestAgentMessagesRef = useRef(agentMessages);
  const latestGlobalMessagesRef = useRef(globalLocalMessages);
  // Synchronously updated each render — lets tryRecover read the live message
  // count without adding messages to its useCallback deps (which would cause
  // the useStreamRecovery effect to re-subscribe on every message update).
  const currentMessagesRef = useRef(messages);
  currentMessagesRef.current = messages;

  useEffect(() => {
    latestAgentMessagesRef.current = agentMessages;
  }, [agentMessages]);

  useEffect(() => {
    latestGlobalMessagesRef.current = globalLocalMessages;
  }, [globalLocalMessages]);
  // The STREAM's conversation, not the surface's. `heldStopConversationId` is computed below from
  // the hold-refs; before a stream exists it falls back to the live id, which is correct because
  // there is nothing else to name. See useChatStop for why the chatId map alone is not enough.
  // PER-MODE, and that is the whole point.
  //
  // This surface hosts TWO independent chats (agent and global), and both can be in flight at
  // once — switching mode does not abort the running POST, because useChat's id is constant.
  // Deriving one id from the MODE-SELECTED `status`/`messages` and feeding it to BOTH hold-refs
  // let the IDLE mode's ref latch the ACTIVE mode's messageId — and holdForStream then pinned it
  // for the rest of that stream. Stop, back in the other mode, aborted the WRONG stream: the
  // agent's answer died mid-sentence while the global generation kept running its write tools and
  // kept billing, its own Stop permanently wired to an id that was never its.
  //
  // A stream's identity comes from ITS OWN chat, never from whichever one the surface happens to
  // be rendering. (Both gate on 'streaming', never 'submitted' — see holdForStream's contract:
  // during submitted the array's last assistant message is the PREVIOUS turn's.)
  const { agentLiveId, globalLiveId } = useMemo(
    () => selectLiveAssistantIds({
      agent: { status: agentStatus, messages: agentMessages },
      global: { status: globalStatus, messages: globalLocalMessages },
    }),
    [agentStatus, agentMessages, globalStatus, globalLocalMessages],
  );

  // The conversation the CURRENT local stream belongs to, captured when it starts and held
  // until it ends — the stream's identity, not the surface's. See the flag effect below.
  // Assigned during render, and it only ever changes when `agentStatus` does (a stream
  // starting or ending) — which every effect below already depends on.
  const streamConvIdRef = useRef<string | null>(null);
  // Whether OUR local stream set the flag — the multiplayer hook may hold the same key for a
  // different, still-live stream, and we must not clear its flag.
  const ownsFlagRef = useRef(false);
  const isAgentStreamingNow = agentStatus === 'submitted' || agentStatus === 'streaming';
  streamConvIdRef.current = holdForStream({
    current: streamConvIdRef.current,
    isStreaming: isAgentStreamingNow,
    liveValue: agentConversationId,
  });
  // The stream's assistant messageId, captured when the first chunk arrives and held for the
  // rest of the stream. THIS is what we abort by.
  //
  // Aborting by chatId cannot work here: `abortActiveStream` is a lookup in the client-side
  // activeStreams map, and the conversation-change cleanup below DELETES this stream's entry
  // the instant the surface switches conversation. So the chatId abort became a map miss —
  // the local fetch stopped and the SERVER KEPT GENERATING AND KEPT BILLING. The multiplayer
  // hook was always immune because it aborts by messageId, which needs no map.
  const streamMsgIdRef = useRef<string | null>(null);
  streamMsgIdRef.current = holdForStream({
    current: streamMsgIdRef.current,
    isStreaming: isAgentStreamingNow,
    // The AGENT chat's own id — never the mode-selected one. See above.
    liveValue: agentLiveId,
  });
  const globalStreamingNow = globalStatus === 'submitted' || globalStatus === 'streaming';
  const globalStreamConvIdRef = useRef<string | null>(null);
  globalStreamConvIdRef.current = holdForStream({
    current: globalStreamConvIdRef.current,
    isStreaming: globalStreamingNow,
    liveValue: globalConversationId,
  });
  const globalStreamMsgIdRef = useRef<string | null>(null);
  globalStreamMsgIdRef.current = holdForStream({
    current: globalStreamMsgIdRef.current,
    isStreaming: globalStreamingNow,
    // The GLOBAL chat's own id — never the mode-selected one. See above.
    liveValue: globalLiveId,
  });

  // THE STOP BUTTON THE USER ACTUALLY CLICKS aborts by the HELD id, not the live one.
  //
  // `liveAssistantMessageId` is derived from the live `messages` array, and "New Chat" (and
  // history-select) empties that array mid-stream with no streaming guard. The id therefore
  // vanished at exactly the moment the user most needed it: Stop fell through to the chatId
  // fallback, whose map entry the conversation-change cleanup had already deleted. The local
  // fetch stopped, the button looked like it worked, and the SERVER KEPT GENERATING — running
  // write tools and billing — against a conversation the user had already navigated away from.
  //
  // The held ref survives the array being cleared, because it names the STREAM and not the
  // surface. The stop functions published to the OTHER surfaces already used it; this one,
  // purely by declaration order, did not.
  const heldStreamMsgId = (selectedAgent ? streamMsgIdRef.current : globalStreamMsgIdRef.current) ?? undefined;

  // The conversation the Stop button must NAME. The held one while a stream is running — never
  // the live one, or a mid-stream conversation switch would abort the wrong generation (or
  // none). Falls back to the live id before any stream exists, which is correct: there is
  // nothing else to name, and the server simply reports that nothing was in flight.
  const heldStopConversationId =
    (selectedAgent ? streamConvIdRef.current : globalStreamConvIdRef.current) ?? currentConversationId;

  const stop = useChatStop(currentConversationId, rawStop, heldStopConversationId);

  // The stable assistant messageId of the live stream (the rendered streaming
  // bubble === serverAssistantMessageId). Used to abort authoritatively by
  // messageId rather than the fragile chatId→streamId map.
  //
  // Resolved ONLY during 'streaming' — never 'submitted'. This is the difference between
  // aborting THIS stream and aborting the previous turn's finished reply.
  //
  // useChat sets `status: 'submitted'` BEFORE it issues the request, and only pushes the new
  // assistant message inside `write()`, which flips the status to 'streaming' in the same
  // synchronous job (see ai/dist/index.mjs: setStatus('submitted') at the top of sendMessage;
  // the pushMessage + setStatus('streaming') together in write()). So for the whole submitted
  // window the array's last assistant message is THE PREVIOUS TURN'S.
  //
  // That matters because `holdForStream` below latches this value on the first render where the
  // stream is live — which is a 'submitted' render. Gated on the looser `isStreaming` (which
  // includes 'submitted'), it therefore captured and held the id of a reply that finished
  // minutes ago, on every turn after the first: Stop aborted a messageId the server registry no
  // longer knew, the local fetch stopped, the button looked like it worked, and the real
  // generation kept running its write tools and kept billing.
  //
  // At the first 'streaming' render the push has already happened, so the last assistant IS the
  // stream's. Before that we return undefined, and callers correctly fall back to the chatId map.

  // After a refresh mid-stream, useChat starts at idle — but the
  // GlobalChatContext bootstrap may have detected an own in-flight stream
  // and registered a stop function. Surface either source so the UI shows
  // a stop button + streaming indicator from both bootstrap and live paths.
  // A bootstrap-restored AGENT stream (after a refresh mid-stream). useAgentChannelMultiplayer
  // claims this slot; the sidebar has always read it, and the DASHBOARD never did — so the surface
  // that started the stream rendered Send while the sidebar showed a working Stop. Keyed by the
  // STREAM's conversation, not the surface's.
  const agentBootstrapKey: AgentStreamKey = {
    agentId: selectedAgent?.id ?? null,
    conversationId: streamConvIdRef.current ?? agentConversationId,
  };
  const agentBootstrapIsStreaming = usePageAgentDashboardStore(
    selectIsAgentStreaming(agentBootstrapKey),
  );
  const agentBootstrapStop = usePageAgentDashboardStore(selectAgentStop(agentBootstrapKey));

  const { effectiveIsStreaming, effectiveStop } = useGlobalEffectiveStream({
    localIsStreaming: isStreaming,
    rawStop: stop,
    selectedAgent,
    contextIsStreaming,
    contextStopStreaming,
    activeMessageId: heldStreamMsgId,
    agentBootstrapIsStreaming,
    agentBootstrapStop,
  });

  const remoteStreamingUser = !effectiveIsStreaming
    ? remoteStreams.find((s) => !s.isOwn)?.triggeredBy ?? null
    : null;
  // Agent mode: initialized when we have a conversationId and not loading
  // Global mode: use globalIsInitialized from context
  const agentIsInitialized = selectedAgent ? (!!agentConversationId && !agentIsLoading) : false;
  const isInitialized = selectedAgent ? agentIsInitialized : globalIsInitialized;
  // Identity can be 'ready' (isInitialized true) while messages for the
  // conversation just switched to are still in flight — decoupled from
  // identity resolution so a switch doesn't flash the previous conversation's
  // messages under the new one with no loading indicator.
  const isMessagesLoading = selectedAgent ? agentIsMessagesLoading : globalIsMessagesLoading;
  const isLoading = !isInitialized || isMessagesLoading;

  // ============================================
  // MESSAGE ACTIONS (shared hook)
  // ============================================
  const agentSetMessages = useCallback(
    (nextOrUpdater: import('ai').UIMessage[] | ((prev: import('ai').UIMessage[]) => import('ai').UIMessage[])) => {
      const nextMessages =
        typeof nextOrUpdater === 'function'
          ? nextOrUpdater(latestAgentMessagesRef.current)
          : nextOrUpdater;
      setAgentMessages(nextMessages);
      setAgentStoreMessages(nextMessages);
    },
    [setAgentMessages, setAgentStoreMessages]
  );

  const globalSetMessages = useCallback(
    (nextOrUpdater: import('ai').UIMessage[] | ((prev: import('ai').UIMessage[]) => import('ai').UIMessage[])) => {
      const nextMessages =
        typeof nextOrUpdater === 'function'
          ? nextOrUpdater(latestGlobalMessagesRef.current)
          : nextOrUpdater;
      setGlobalLocalMessages(nextMessages);
    },
    [setGlobalLocalMessages]
  );

  const { handleEdit, handleDelete, handleRetry, lastAssistantMessageId, lastUserMessageId } =
    useMessageActions({
      agentId: selectedAgent?.id || null,
      conversationId: currentConversationId,
      messages,
      setMessages: selectedAgent ? agentSetMessages : globalSetMessages,
      regenerate,
    });

  // Rejoin-first recovery probe for useStreamRecovery.
  // On a network error (e.g. iOS backgrounding kills the fetch):
  //   1. Check /api/ai/chat/active-streams — if the original run is still live, rejoin it.
  //   2. Else fetch messages from the DB — if the run already persisted a reply, surface it.
  //   3. Only fall through to regenerate() when neither path finds anything to recover.
  const tryRecover = useCallback(async (): Promise<boolean> => {
    if (!currentConversationId) return false;
    const channelId = selectedAgent?.id ?? (user?.id ? globalChannelId(user.id) : null);
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
            rejoinAgentStreamRef.current();
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
        // DB must have at least as many user messages as local (the user's turn
        // was persisted) AND end with an assistant reply (the run completed).
        const hasPersistedReply =
          msgs.length > 0 &&
          msgs[msgs.length - 1].role === 'assistant' &&
          dbUserCount >= localUserCount;
        if (decideRecovery({ hasLiveStream: false, hasPersistedReply }) === 'refetch') {
          if (selectedAgent) {
            setAgentMessages(data.messages);
            setAgentStoreMessages(data.messages);
          } else {
            setGlobalLocalMessages(data.messages);
          }
          return true;
        }
      }
    } catch { /* network error — fall through to regenerate */ }

    return false;
  }, [
    currentConversationId,
    selectedAgent,
    user,
    rejoinGlobalStream,
    setAgentMessages,
    setAgentStoreMessages,
    setGlobalLocalMessages,
  ]);

  // Auto-retry on network errors — rejoin-first, regenerate only as last resort
  useStreamRecovery({ error, status, clearError, handleRetry, maxRetries: 2, tryRecover });

  const handleUndoSuccess = useCallback(async () => {
    if (!currentConversationId) return;
    try {
      const url = selectedAgent
        ? `/api/ai/page-agents/${selectedAgent.id}/conversations/${currentConversationId}/messages`
        : `/api/ai/global/${currentConversationId}/messages`;
      const res = await fetchWithAuth(url);
      if (res.ok) {
        const data = await res.json();
        if (selectedAgent) {
          setAgentMessages(data.messages);
          setAgentStoreMessages(data.messages);
        } else {
          setGlobalLocalMessages(data.messages);
        }
      }
    } catch (error) {
      console.error('Failed to refresh messages after undo:', error);
    }
  }, [
    currentConversationId,
    selectedAgent,
    setAgentMessages,
    setAgentStoreMessages,
    setGlobalLocalMessages,
  ]);

  // Pull-up refresh to check for missed messages (when real-time may have failed)
  const handlePullUpRefresh = useCallback(async () => {
    if (!currentConversationId) return;
    try {
      const url = selectedAgent
        ? `/api/ai/page-agents/${selectedAgent.id}/conversations/${currentConversationId}/messages`
        : `/api/ai/global/${currentConversationId}/messages`;
      const res = await fetchWithAuth(url);
      if (res.ok) {
        const data = await res.json();
        if (selectedAgent) {
          setAgentMessages(data.messages);
          setAgentStoreMessages(data.messages);
        } else {
          setGlobalLocalMessages(data.messages);
        }
      }
    } catch (error) {
      console.error('Failed to refresh messages:', error);
    }
  }, [
    currentConversationId,
    selectedAgent,
    setAgentMessages,
    setAgentStoreMessages,
    setGlobalLocalMessages,
  ]);

  // App state recovery - refresh messages when returning from background
  // This catches completed AI responses that finished while the app was backgrounded
  useAppStateRecovery({
    onResume: handlePullUpRefresh,
    // Block recovery if streaming OR pending send OR any editing active
    enabled: !isStreaming && currentConversationId !== null && !useEditingStore.getState().isAnyEditing(),
  });

  // Clean up stream tracking on unmount / conversation change.
  //
  // Keyed by `agentConversationId` — THE ONLY KEY THIS SURFACE REGISTERS (its agent transport,
  // `useChatTransport(agentConversationId, …)`). It used to clear `currentConversationId`, which
  // in GLOBAL mode is `globalConversationId` — and that is GlobalChatContext's transport key
  // (`useChatTransport(currentConversationId, …)`), not ours. So navigating away from the
  // dashboard mid-global-stream deleted the CONTEXT's activeStreams entry, and the context (which
  // outlives this component) was left unable to abort by chatId in the pre-first-chunk window:
  // the server kept generating and kept billing.
  //
  // Same rule as the sidebar's cleanup: a surface may only free what it allocated.
  useEffect(() => {
    return () => {
      if (agentConversationId) {
        clearActiveStreamId({ chatId: agentConversationId });
      }
    };
  }, [agentConversationId]);

  // ============================================
  // GLOBAL MODE SYNC EFFECTS
  // ============================================

  // Clear agent messages when switching to global mode
  useEffect(() => {
    if (!selectedAgent) {
      setAgentMessages([]);
    }
  }, [selectedAgent, setAgentMessages]);

  // Stop global stream when switching to agent mode
  useEffect(() => {
    if (selectedAgent && (globalStatus === 'submitted' || globalStatus === 'streaming')) {
      globalStop();
    }
  }, [selectedAgent, globalStatus, globalStop]);

  // When remote events fire (reconnect, undo from another tab, cross-tab
  // edit/delete), the context increments refreshSignal. React to it here.
  const isInitializedRef = useRef(isInitialized);
  isInitializedRef.current = isInitialized;
  const prevRefreshSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === prevRefreshSignalRef.current) return;
    // Guarded on !effectiveIsStreaming for the same reason as the load-on-select effects
    // below: handlePullUpRefresh calls setGlobalLocalMessages/setAgentMessages directly with
    // no reconciliation against an in-flight stream, so running it while this surface is
    // actively streaming would clobber the in-progress assistant bubble with a stale DB
    // snapshot. The ref is only advanced once the refresh actually runs, so a refreshSignal
    // bump that arrives mid-stream is retried once streaming ends instead of being marked
    // "seen" and permanently dropped.
    if (!selectedAgent && isInitializedRef.current && !effectiveIsStreaming) {
      prevRefreshSignalRef.current = refreshSignal;
      handlePullUpRefresh();
    }
  }, [refreshSignal, selectedAgent, effectiveIsStreaming, handlePullUpRefresh]);

  // Sync streaming status to global context (global mode only)
  useEffect(() => {
    if (selectedAgent) return;
    const isCurrentlyStreaming = globalStatus === 'submitted' || globalStatus === 'streaming';
    const wasStreaming =
      prevStatusRef.current === 'submitted' || prevStatusRef.current === 'streaming';
    // Level-triggered set, edge-triggered clear — see the agent-mode twin below. An
    // edge-guarded set left the flag FALSE for the whole streaming phase, because the
    // level-triggered cleanup clears it on the submitted -> streaming transition and the
    // body then declined to re-assert it.
    if (isCurrentlyStreaming) {
      setGlobalIsStreaming(true);
    } else if (wasStreaming) {
      setGlobalIsStreaming(false);
    }
    prevStatusRef.current = globalStatus;

    return () => {
      if (isCurrentlyStreaming) {
        setGlobalIsStreaming(false);
      }
    };
  }, [selectedAgent, globalStatus, setGlobalIsStreaming]);

  // Register stop function to global context (global mode only)
  // Combined function calls both abort endpoint (server-side) and useChat stop (client-side)
  // Use try/finally to guarantee client-side stop runs even if server abort fails
  // The stop slot is SHARED, and this component is not its only writer: the stream socket
  // claims it on bootstrap for a stream restored after a refresh (GlobalChatContext's
  // onOwnStreamBootstrap). This effect used to null it UNCONDITIONALLY — on its
  // else-branch and on its cleanup, both of which fire whenever globalStatus is 'ready',
  // which it is for the ENTIRE life of a bootstrapped stream, and whose deps
  // (globalConversationId) resolve asynchronously right after the claim by design.
  //
  // So it destroyed a live Stop button belonging to someone else, leaving
  // `isStreaming: true` with `stopStreaming: null` — the Stop renders and does nothing
  // while the stream keeps generating and keeps billing. Only clear what we installed.
  const ownedGlobalStopFnRef = useRef<(() => void | Promise<void>) | null>(null);
  const contextStopStreamingRef = useRef(contextStopStreaming);
  contextStopStreamingRef.current = contextStopStreaming;

  const clearGlobalStopIfOurs = useCallback(() => {
    if (ownedGlobalStopFnRef.current === null) return;
    const stillOurs = contextStopStreamingRef.current === ownedGlobalStopFnRef.current;
    ownedGlobalStopFnRef.current = null;
    if (!stillOurs) return;
    setGlobalStopStreaming(null);
  }, [setGlobalStopStreaming]);

  useEffect(() => {
    if (selectedAgent) return;
    if (globalStatus === 'submitted' || globalStatus === 'streaming') {
      // Same as agent mode: GLOBAL_CHAT_ID is a constant too, so useChat never recreates the
      // global Chat and a mid-stream conversation switch does NOT abort the POST. Name the
      // STREAM, not the surface — and abort by messageId, because the conversation-change
      // cleanup deletes this stream's entry from the client-side chatId map.
      // LOCAL STOP FIRST. It used to run in a `finally`, to guarantee it happened even if the
      // server abort threw. But the server abort is no longer instant: when the generation lives
      // on another web instance it now marks the stream and WAITS to learn whether the owner
      // actually stopped it. Awaiting that first would hang the Stop button for seconds with
      // tokens still rendering. Running it up front guarantees it strictly harder than the
      // `finally` did — and the server call is then awaited only to decide what to TELL the user.
      const stopFn = async () => {
        // Stops this client reading. Stops NOTHING on the server — streams are server-owned.
        globalStop();

        const messageId = globalStreamMsgIdRef.current;
        const convId = globalStreamConvIdRef.current;
        if (messageId) {
          reportAbortOutcome(await abortActiveStreamByMessageId({ messageId }));
        } else if (convId) {
          // Pre-first-chunk: no assistant id yet — and the chatId map is EMPTY here, not stale
          // (setActiveStreamId only runs once the response headers land, 0.5-3s into a real
          // send). Name the conversation too, or this abort is a guaranteed no-op while the
          // server keeps generating and keeps billing.
          reportAbortOutcome(await abortActiveStream({ chatId: convId, conversationId: convId }));
        }
      };
      ownedGlobalStopFnRef.current = stopFn;
      // setGlobalStopStreaming IS a useState dispatch, so a function argument is an
      // UPDATER — the wrapper is required here. (Contrast setAgentStopStreaming below,
      // a plain zustand value setter, where the wrapper would store the wrapper itself.)
      setGlobalStopStreaming(() => stopFn);
    } else {
      clearGlobalStopIfOurs();
    }

    return () => {
      clearGlobalStopIfOurs();
    };
  }, [selectedAgent, globalStatus, globalStop, setGlobalStopStreaming, clearGlobalStopIfOurs]);

  // ============================================
  // AGENT MODE SYNC EFFECTS
  // ============================================

  // Sync streaming status to dashboard store (agent mode only)
  useEffect(() => {
    if (!selectedAgent) return;
    const isCurrentlyStreaming = agentStatus === 'submitted' || agentStatus === 'streaming';
    const wasStreaming = prevAgentStatusRef.current === 'submitted' || prevAgentStatusRef.current === 'streaming';
    // Set is LEVEL-triggered, clear is edge-triggered. The cleanup below is level-triggered
    // and `agentStatus` is a dep, so on the submitted -> streaming transition React runs the
    // previous cleanup (which sets false) and then this body. With an edge-guarded set
    // (`&& !wasStreaming`) the body then refused to re-assert it — and the flag stayed FALSE
    // for the entire streaming phase, killing the cross-surface sync this state exists for
    // and dropping SWR protection mid-stream.
    //
    // Keyed by the conversation the stream STARTED in — captured at the transition and held
    // in a ref — NOT by the surface's live `agentConversationId`.
    //
    // `useChat` only recreates its Chat when its `id` changes, and ours is a constant
    // (AGENT_CHAT_ID). So switching conversation mid-stream does NOT abort the POST: the
    // stream keeps running while `agentConversationId` moves. Keying off the live value
    // MIGRATED ownership — the cleanup cleared the running stream's key and the body
    // installed a fresh claim under a conversation with NO stream. The abandoned stream lost
    // its Stop and its SWR protection while still generating; the new key showed a spinner
    // and a Stop that aborted nothing. (History-select and New Chat both do this with no
    // streaming guard at all.)
    const streamConvId = streamConvIdRef.current;
    const flagKey = { agentId: selectedAgent.id, conversationId: streamConvId };
    // Ownership-guarded, like the stop below. The multiplayer hook can hold this same key for
    // a DIFFERENT, still-live stream (a bootstrap-restored one, or a cross-instance stream
    // takeover could not abort). Clearing the flag unconditionally would strip that stream's
    // Stop affordance and its SWR protection while it is still generating.
    if (isCurrentlyStreaming) {
      ownsFlagRef.current = true;
      setAgentStreaming(flagKey, true);
    } else if (wasStreaming && ownsFlagRef.current) {
      ownsFlagRef.current = false;
      setAgentStreaming(flagKey, false);
    }
    prevAgentStatusRef.current = agentStatus;

    return () => {
      if (isCurrentlyStreaming && ownsFlagRef.current) {
        ownsFlagRef.current = false;
        setAgentStreaming(flagKey, false);
      }
    };
  }, [selectedAgent, agentStatus, setAgentStreaming]);

  // Same shared-slot discipline as the global stop above: useAgentChannelMultiplayer claims
  // this slot on bootstrap for a stream restored after a refresh, and nulling it
  // unconditionally from here destroyed that live Stop button while isAgentStreaming stayed
  // true. Only clear what we installed.
  const ownedAgentStopFnRef = useRef<(() => void | Promise<void>) | null>(null);
  // Still identity-guarded WITHIN the agent: useAgentChannelMultiplayer claims this same
  // agent's stop on bootstrap (a stream restored after a refresh), and clearing that would
  // destroy a live Stop button. Cross-AGENT collisions are now impossible by construction.
  const clearAgentStopIfOurs = useCallback((key: AgentStreamKey) => {
    if (ownedAgentStopFnRef.current === null) return;
    const k = agentStreamKey(key);
    const current = k === null ? undefined : usePageAgentDashboardStore.getState().agentStops[k];
    const stillOurs = current === ownedAgentStopFnRef.current;
    ownedAgentStopFnRef.current = null;
    if (!stillOurs) return;
    setAgentStop(key, null);
  }, [setAgentStop]);

  // Register stop function to dashboard store (agent mode only)
  // Combined function calls both abort endpoint (server-side) and useChat stop (client-side)
  // Use try/finally to guarantee client-side stop runs even if server abort fails
  useEffect(() => {
    if (!selectedAgent) return;
    // Named by (agent, conversation) — an agent id alone cannot say WHICH conversation, and
    // the sidebar keeps its own conversation for the same agent.
    // Keyed by the conversation the stream STARTED in — see the flag effect. Keying off the
    // live `agentConversationId` migrated ownership on a mid-stream conversation switch, and
    // aborted the WRONG conversation (a server no-op) while the real stream kept billing.
    const streamConvId = streamConvIdRef.current;
    const stopKey: AgentStreamKey = { agentId: selectedAgent.id, conversationId: streamConvId };
    if (agentStatus === 'submitted' || agentStatus === 'streaming') {
      // setAgentStop is a plain zustand VALUE setter, NOT a useState dispatch — so pass the
      // fn itself, never the `() => fn` updater form (which would be stored verbatim, and
      // calling it would merely return the inner fn: a Stop button that does nothing).
      // Local stop first — see the note on the global handler above.
      const stopFn = async () => {
        agentStop();

        // Read at CALL time: the messageId only exists once the first chunk lands.
        const messageId = streamMsgIdRef.current;
        if (messageId) {
          reportAbortOutcome(await abortActiveStreamByMessageId({ messageId }));
        } else if (streamConvId) {
          // Pre-first-chunk: no assistant id yet. The chatId map is NOT enough — it is empty
          // until the response headers land, and the conversation-change cleanup deletes the
          // running stream's entry on a mid-stream switch. Naming the conversation is what
          // makes this abort actually reach the server instead of silently no-opping while the
          // generation keeps running and keeps billing.
          reportAbortOutcome(await abortActiveStream({ chatId: streamConvId, conversationId: streamConvId }));
        }
      };
      ownedAgentStopFnRef.current = stopFn;
      setAgentStop(stopKey, stopFn);
    } else {
      clearAgentStopIfOurs(stopKey);
    }

    return () => {
      clearAgentStopIfOurs(stopKey);
    };
  }, [selectedAgent, agentStatus, agentStop, setAgentStop, clearAgentStopIfOurs]);

  // Agent-mode load-on-select guarantee: the store's conversationLoadSignal
  // fires on explicit load/create (not on streaming updates). We use it rather
  // than watching conversationMessages directly because the store receives
  // bidirectional writes during streaming — watching the array would clobber
  // in-progress parts. With stable useChat id, setMessages has no competing
  // store recreation, so this is the sole message writer on load.
  //
  // Seeded to `null` (not the current signal value) so a remount with an
  // already-selected agent/conversation still applies messages to the fresh
  // useChat instance. usePageAgentDashboardStore is a module-level singleton
  // that outlives this component's mount — seeding to the live value would
  // make the effect wrongly believe "nothing changed" on first render after
  // navigating away and back, leaving the freshly mounted chat blank.
  const prevAgentLoadSignalRef = useRef<number | null>(null);
  useEffect(() => {
    if (agentConversationLoadSignal === prevAgentLoadSignalRef.current) return;
    // Guarded the same way as the global-mode load-on-select effect below: the load-signal
    // indirection already avoids re-firing on every streamed token, but it still fires
    // unconditionally on a fresh mount (seeded to `null`) — so a reload mid-stream needs this
    // guard too, or it clobbers the in-progress bubble with the pre-reply snapshot.
    //
    // The ref is only advanced INSIDE the guard, not before it. If a load lands while
    // effectiveIsStreaming is true, the guard skips applying it — and if the ref had already
    // been marked "seen" at that point, the pending load would never be retried: the signal
    // isn't going to change again on its own, so once streaming ends this effect would keep
    // seeing "no change" and skip forever, stranding the dashboard on stale/empty history.
    // Leaving the ref stale means the next re-run (streaming flag flipping is itself a
    // dependency) still sees this signal as unapplied and retries it correctly.
    if (selectedAgent && agentConversationId && !effectiveIsStreaming) {
      prevAgentLoadSignalRef.current = agentConversationLoadSignal;
      setAgentMessages(agentInitialMessages);
    }
  }, [agentConversationLoadSignal, selectedAgent, agentConversationId, agentInitialMessages, effectiveIsStreaming, setAgentMessages]);

  // Global-mode load-on-select guarantee: apply messages from context whenever
  // they change (loadConversation or createNewConversation ran). With a stable
  // useChat id, setMessages is the sole writer — no race with store recreation.
  //
  // Guarded on !effectiveIsStreaming: without it, a mount/reload/conversation-switch that lands
  // while this surface is actively streaming (locally or via a bootstrapped own stream)
  // overwrites the in-progress assistant bubble with a stale snapshot that predates the reply —
  // the live text itself keeps rendering separately via `remoteStreams` regardless, so this
  // effect only ever needs to apply the persisted snapshot once streaming has stopped.
  //
  // Dedup'd on a prevRef (CodeRabbit caught this): `globalInitialMessages` is NOT refreshed for
  // a fresh own send/completion in this surface (onStreamComplete deliberately no-ops — "surface's
  // useChat already has the message"), so without the reference check this effect would re-fire on
  // every effectiveIsStreaming transition, including the streaming -> not-streaming edge at the end
  // of every ordinary send — reapplying the SAME STALE pre-send snapshot and wiping the
  // just-completed reply straight back out of view. The ref advances only inside the guard (see
  // the load-on-select effects above) so a load skipped mid-stream is still retried once
  // streaming ends, rather than being marked "seen" and dropped.
  const prevGlobalInitialMessagesRef = useRef<import('ai').UIMessage[] | null>(null);
  useEffect(() => {
    if (selectedAgent) return;
    if (globalInitialMessages === prevGlobalInitialMessagesRef.current) return;
    if (!globalIsInitialized || !globalConversationId || effectiveIsStreaming) return;
    prevGlobalInitialMessagesRef.current = globalInitialMessages;
    setGlobalLocalMessages(globalInitialMessages);
  }, [globalInitialMessages, globalIsInitialized, globalConversationId, selectedAgent, effectiveIsStreaming, setGlobalLocalMessages]);

  // Agent-mode multiplayer wiring (Tasks 2 + 5 + 6). No-op when selectedAgent
  // is null. Encapsulates page-room subscription, stream bootstrap/socket
  // events, dashboard-store stop-slot single-writer claim, channel-id-keyed
  // editing-store registration, and reconnect-refresh.
  const { rejoinActiveStreams: rejoinAgentStream } = useAgentChannelMultiplayer({
    selectedAgent,
    agentConversationId,
    setLocalMessages: setAgentMessages,
    isLocallyStreaming: isStreaming,
    surfaceComponentName: 'GlobalAssistantView',
    loadConversation: loadAgentConversation,
  });
  // Keep the ref current so tryRecover (defined above) can call it without
  // depending on hook-call ordering.
  rejoinAgentStreamRef.current = rejoinAgentStream;

  // Register streaming state with editing store
  useStreamingRegistration(
    `global-assistant-${currentConversationId || 'init'}`,
    isStreaming,
    { conversationId: currentConversationId || undefined, componentName: 'GlobalAssistantView' }
  );

  // Reset error visibility when new error occurs
  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

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

  const handleSendMessage = async () => {
    const files = getFilesForSend();
    if ((!input.trim() && files.length === 0) || !currentConversationId) return;

    const requestBody = selectedAgent
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
          locationContext,
          selectedProvider: currentProvider,
          selectedModel: currentModel,
          mcpTools: mcpToolSchemas,
        });

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    wrapSend(() => sendMessage({ text: input, files: files.length > 0 ? files : undefined }, { body: requestBody }));
    setInput('');
    clearFiles();
    // Note: scrollToBottom is now handled by use-stick-to-bottom when pinned
  };

  // Voice mode: Send message from voice transcript
  const handleVoiceSend = useCallback((text: string) => {
    if (!text.trim() || !currentConversationId) return;

    const requestBody = selectedAgent
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
          locationContext,
          selectedProvider: currentProvider,
          selectedModel: currentModel,
          mcpTools: mcpToolSchemas,
        });

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    wrapSend(() => sendMessage({ text }, { body: requestBody }));
  }, [
    currentConversationId,
    selectedAgent,
    agentSelectedProvider,
    agentSelectedModel,
    isReadOnly,
    webSearchEnabled,
    imageGenEnabled,
    showPageTree,
    locationContext,
    currentProvider,
    currentModel,
    mcpToolSchemas,
    sendMessage,
    wrapSend,
  ]);

  const buildAskUserAnswerBody = useCallback(() => {
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
          locationContext,
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
    locationContext,
    currentProvider,
    currentModel,
    mcpToolSchemas,
  ]);

  const askUserAnswering = useAskUserAnswering({
    messages,
    status,
    addToolResult,
    wrapSend,
    buildBody: buildAskUserAnswerBody,
  });

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

  // Voice mode toggle handler
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
    <div className="flex flex-col h-full">
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
          <TasksDropdown messages={messages} driveId={selectedAgent?.driveId || locationContext?.currentDrive?.id} />
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

      {/* Chat Interface - unified for both modes with floating input */}
      <ChatLayout
        ref={chatLayoutRef}
        messages={messages}
        input={input}
        onInputChange={setInput}
        onSend={handleSendMessage}
        onStop={effectiveStop}
        isStreaming={effectiveIsStreaming}
        isLoading={isLoading}
        disabled={!isAnyProviderConfigured || !isInitialized}
        placeholder={selectedAgent ? `Ask ${selectedAgent.title}...` : 'Ask about your workspace...'}
        driveId={selectedAgent ? selectedAgent.driveId : locationContext?.currentDrive?.id}
        crossDrive={!selectedAgent}
        error={error}
        showError={showError}
        onClearError={() => setShowError(false)}
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
              onVoiceModeClick={handleVoiceModeToggle}
              isVoiceModeActive={isVoiceModeActive}
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
