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
  useStreamRecovery,
  useAskUserAnswering,
  buildChatConfig,
  AGENT_CHAT_ID,
  LocationContext,
  buildGlobalChatRequestBody,
} from '@/lib/ai/shared';
import { buildContextRef, type ContextRef } from '@/lib/ai/shared/buildContextRef';
import { AskUserAnswerProvider } from '@/components/ai/shared/chat/ask-user/AskUserAnswerContext';
import { useAppStateRecovery } from '@/hooks/useAppStateRecovery';
import { isCapacitorApp } from '@/hooks/useCapacitor';
import { resolveResumeAction } from '@/lib/ai/streams/resolveResumeAction';
import { useEditingStore } from '@/stores/useEditingStore';
import { useAgentChannelMultiplayer } from '@/hooks/useAgentChannelMultiplayer';
import { decideRecovery } from '@/lib/ai/streams/decideRecovery';
import { canConcludeTurnIsLost, type RecoveryAttempt } from '@/lib/ai/streams/recoveryAttempt';
import { evictStalePartial, canEvictStalePartial } from '@/lib/ai/streams/evictStalePartial';
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
import { useRenderedMessages, useConversationLoadState } from '@/hooks/useRenderedMessages';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import {
  loadGlobalConversationMessages,
  loadAgentConversationMessages,
} from '@/hooks/conversationMessagesLoaders';
import { buildUserMessage } from '@/lib/ai/streams/buildUserMessage';
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
  const { attachments, addFiles, removeFile, clearFiles, getFilesForSend } = useImageAttachments();

  // Refs
  const chatLayoutRef = useRef<ChatLayoutRef>(null);
  const inputRef = useRef<ChatInputRef>(null);
  // Populated after useAgentChannelMultiplayer runs (called further down); used
  // in tryRecover via ref so the callback doesn't depend on hook ordering.
  const rejoinAgentStreamRef = useRef<() => void>(() => {});
  // The conversation currently on screen, mirrored on every render. Read after an await to
  // decide whether a response that just resolved is still wanted.
  //
  // Deliberately NOT the "id the load was requested for" ref that AiChatView and
  // SidebarChatTab use. That pattern only works because in those components every load path
  // funnels through the one loader that advances the ref, so switching conversation advances
  // it. Here it would not: this surface loads on select via the globalInitialMessages /
  // agent-load-signal effects, which do NOT go through handlePullUpRefresh. A
  // "requested id" ref written only by handlePullUpRefresh would still equal the id its own
  // in-flight fetch was issued for, so the guard would always pass and a response for the
  // conversation the user just left would be applied to the one they switched to. Comparing
  // against the LIVE conversation is the invariant that actually holds here.
  const currentConversationIdRef = useRef<string | null>(null);

  // ============================================
  // SHARED HOOKS
  // ============================================
  const currentConversationId = selectedAgent ? agentConversationId : globalConversationId;
  currentConversationIdRef.current = currentConversationId;

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
  // Mirrored so the resume handler can read it AFTER its awaits. Its own closure captured the
  // pre-background value, which cannot tell it whether a generation has since restarted.
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;

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

  const stop = useStopStream({ activeStream, pendingSendConversationId, rawStop });

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
  // Loading/error UI reads the cache entry's state (replaces the context's
  // isMessagesLoading and the dashboard store's isConversationMessagesLoading).
  const messagesLoadState = useConversationLoadState(currentConversationId);

  const streamingAssistantText = useMemo(() => {
    if (!isStreaming) return null;
    const last = plainMessages[plainMessages.length - 1];
    if (!last || last.role !== 'assistant') return null;
    return (last.parts ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('');
  }, [plainMessages, isStreaming]);
  // Synchronously updated each render — lets tryRecover read the CURRENT
  // CONVERSATION's rendered rows without adding them to its useCallback deps.
  // plainMessages, not the transport array (CR1, CodeRabbit round 2): the
  // transport accumulates rows across conversation switches and is never
  // seeded from loads post-cutover, so its last-user id could belong to a
  // different conversation and defeat the persisted-reply check.
  const currentMessagesRef = useRef(plainMessages);
  currentMessagesRef.current = plainMessages;
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
  useOwnStreamMirror({
    status: agentStatus,
    ownMessages: agentMessages,
    pageId: selectedAgent?.id ?? '',
    conversationId: agentConversationId ?? '',
    triggeredBy: mirrorTriggeredBy,
  });

  useOwnStreamMirror({
    status: globalStatus,
    ownMessages: globalLocalMessages,
    pageId: channelIdForGlobal ?? '',
    conversationId: globalConversationId ?? '',
    triggeredBy: mirrorTriggeredBy,
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

  // ============================================
  // MESSAGE ACTIONS — shared store-first wrapper (F2/F9: actions reason over
  // SETTLED rows only; the live bubble's verb is Stop, and a synthesized
  // streaming row must never reach retry/delete's server-side DELETEs).
  // ============================================
  const setMessages = selectedAgent ? setAgentMessages : setGlobalLocalMessages;
  const isOwnSendLive = selectedAgent ? agentSendUnsafeToClobber : globalSendUnsafeToClobber;

  const { handleEdit, handleDelete, handleRetry, stableMessages } = useCacheMessageActions({
    agentId: selectedAgent?.id || null,
    conversationId: currentConversationId,
    renderedMessages,
    isOwnSendLive,
    setMessages,
    regenerate,
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

  // Rejoin-first recovery probe for useStreamRecovery.
  // On a network error (e.g. iOS backgrounding kills the fetch):
  //   1. Check /api/ai/chat/active-streams — if the original run is still live, rejoin it.
  //   2. Else fetch messages from the DB — if the run already persisted a reply, surface it.
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
    const channelId = selectedAgent?.id ?? (user?.id ? globalChannelId(user.id) : null);
    if (!channelId) return { recovered: false, probeAnswered, dbAnswered };
    // Every transport write below happens after an await, into a useChat instance whose id is
    // constant across conversation switches. Re-check the LIVE conversation before each one —
    // otherwise a recovery for the conversation the user just left lands in the one they moved
    // to. (The cache write is conversation-keyed and needs no such gate.)
    const stillOnThisConversation = () =>
      conversationId === currentConversationIdRef.current;

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
          // than one captured before the awaits above. (Raw useChat setters: the dashboard store
          // no longer holds a message array to keep in sync — PR 5B, leaf 5.3.)
          const staleId = liveStream.messageId;
          if (canEvictStalePartial(liveStream.parts)) {
            const evict = (prev: UIMessage[]) => evictStalePartial(prev, staleId, liveStream.parts);
            if (selectedAgent) setAgentMessages(evict);
            else setGlobalLocalMessages(evict);
          }
          if (selectedAgent) {
            rejoinAgentStreamRef.current();
          } else {
            rejoinGlobalStream();
          }
          return { recovered: true, probeAnswered, dbAnswered };
        }
      }
    } catch { /* network error — fall through to DB check */ }

    // Step 2: DB check for a persisted reply to the CURRENT turn.
    try {
      // Token BEFORE the fetch — a stale recovery snapshot must not overwrite
      // anything fresher committed while it was in flight (CR4).
      const snapshotToken = conversationMessagesActions.beginServerSnapshot(conversationId);
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
          // Commit the SAME normalized array the guards above were computed from, as the
          // conversation's loaded truth. The cache write is conversation-keyed and renders
          // via merge-at-render — no transport write needed to surface the recovered reply
          // (PR 5B: the refetch branch's fetch+setMessages becomes a cache commit).
          conversationMessagesActions.applyServerSnapshot(conversationId, snapshotToken, msgs as unknown as UIMessage[]);
          return { recovered: true, probeAnswered, dbAnswered };
        }
      }
    } catch { /* network error — the caller must not treat this as "nothing is persisted" */ }

    return { recovered: false, probeAnswered, dbAnswered };
  }, [
    currentConversationId,
    selectedAgent,
    user,
    rejoinGlobalStream,
    setAgentMessages,
    setGlobalLocalMessages,
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

  // Undo restructures the conversation server-side — reload the cache entry (PR 5B,
  // leaf 5.4 W1). No transport write and no own-stream merge dance: the cache write is
  // conversation-keyed, and merge-at-render keeps a live own stream visible over any
  // DB snapshot (that is what deleted the whole guard/merge apparatus that lived here).
  const handleUndoSuccess = useCallback(async () => {
    await reloadCurrentConversation();
  }, [reloadCurrentConversation]);

  // Pull-up / resume refresh: check for messages this surface missed (real-time may
  // have failed, or the app was backgrounded and no live stream was found to rejoin).
  // Same cache reload (leaf 5.4 W2) — staleness is the loader's loadGeneration gate.
  const handlePullUpRefresh = useCallback(async () => {
    await reloadCurrentConversation();
  }, [reloadCurrentConversation]);

  // App state recovery — deterministic stream rejoin on mobile.
  //
  // The `enabled` gate MUST be a callback, not a render-time boolean: iOS freezes JS the
  // moment the app backgrounds, so a boolean captured at render is whatever was true when
  // the app went away. That is how this path was dead in exactly the case it was written
  // for — `!isStreaming` was false (streaming), and the recovery hook was gated off.
  //
  // `onResume` uses `resolveResumeAction` — on native it always returns 'rejoin-and-refresh'
  // (the local fetch is dead after backgrounding).
  //
  // It then delegates to `tryRecover`, the same rejoin-first probe useStreamRecovery uses on a
  // network error — because a background/foreground cycle IS a network error on iOS, just one we
  // are told about. Do NOT blind-refresh from the DB here: the reply is not persisted until the
  // run completes, so while a stream is still live a DB snapshot contains no assistant message
  // and writing it would wipe the in-progress bubble. `tryRecover` asks /active-streams first —
  // the server's authoritative answer — and only touches the DB when nothing is live:
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
      const action = resolveResumeAction({ native: isCapacitorApp(), isStreaming: effectiveIsStreaming });
      if (action === 'noop') return;
      if (action === 'refresh') {
        // Web, no live fetch of our own: a plain DB refresh is safe and is all we need.
        await handlePullUpRefresh();
        return;
      }
      // Native. Whether a turn of OUR OWN was in flight, for the conversation on screen, when we
      // went away. iOS froze JS at that moment, so this render-time value is a faithful record of
      // it — which is exactly what it is used for here, and why it is safe even though it is
      // useless for deciding whether the TRANSPORT is still alive (that is resolveResumeAction's
      // job, and the answer is "no").
      //
      // Conversation-scoped, NOT the broader effectiveIsStreaming: that also reports true for a
      // stream still running against a conversation the user has since navigated away from (the
      // useChat id is stable across a switch), and regenerating on the strength of it would fire
      // a generation for the turn the user is now LOOKING at rather than the one that was
      // actually interrupted.
      const hadTurnInFlight = selectedAgent
        ? isOwnAgentStreamForCurrentConversation
        : isOwnGlobalStreamForCurrentConversation;
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
      rawStop();
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
      effectiveIsStreaming,
      currentConversationId,
      selectedAgent,
      isOwnAgentStreamForCurrentConversation,
      isOwnGlobalStreamForCurrentConversation,
      rawStop,
      tryRecover,
      handlePullUpRefresh,
      regenerateTurnOnce,
    ]),
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
          contextRef: buildFreshContextRef(),
          selectedProvider: currentProvider,
          selectedModel: currentModel,
          mcpTools: mcpToolSchemas,
        });

    // Client-minted id, parts-form send (PR 4 pattern): the `{text, files}` shorthand
    // silently drops any id passed alongside it, so the message would push under an
    // SDK-generated id the conversation cache never saw. Written to the cache
    // immediately (optimistic) because the sender's own tab never receives its own
    // chat:user_message broadcast back — this is what makes the bubble appear the
    // same tick the user hits Send (leaf 5.2 acceptance).
    const userMessage = buildUserMessage({
      id: createId(),
      text: input.trim().length > 0 ? input : undefined,
      files: files.length > 0 ? files : undefined,
    }) as UIMessage;
    conversationMessagesActions.addOptimisticSend(currentConversationId, userMessage);

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    wrapSend(() => sendMessage(userMessage, { body: requestBody }));
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
          contextRef: buildFreshContextRef(),
          selectedProvider: currentProvider,
          selectedModel: currentModel,
          mcpTools: mcpToolSchemas,
        });

    // Same client-minted-id, optimistic-cache-write shape as handleSendMessage.
    const userMessage = buildUserMessage({ id: createId(), text }) as UIMessage;
    conversationMessagesActions.addOptimisticSend(currentConversationId, userMessage);

    // wrapSend handles pendingSend registration and cleanup when streaming starts
    wrapSend(() => sendMessage(userMessage, { body: requestBody }));
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

  // F3 (PR #2098 review): addToolResult patches the TRANSPORT's own message array,
  // and post-cutover nothing seeds loaded history into it — so answering an ask_user
  // question on a conversation opened from history/reload would silently do nothing.
  // Seed the settled rendered rows first (same imperative, action-scoped write as the
  // retry seed; skipped while our own send is live — the array is the mirror's read
  // source then, and a live own turn means the transport already holds the question).
  const seededAddToolResult = useCallback<typeof addToolResult>((args) => {
    if (!isOwnSendLive) {
      setMessages(stableMessages);
    }
    return addToolResult(args);
  }, [addToolResult, isOwnSendLive, setMessages, stableMessages]);

  // plainMessages (store-rendered), not useChat's raw `messages`: "answerable" is
  // decided by whether the ask_user part sits on the conversation's LAST message,
  // and remote edits/deletes/messages update the store, not useChat's local array.
  const askUserAnswering = useAskUserAnswering({
    messages: plainMessages,
    status,
    addToolResult: seededAddToolResult,
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
      const assistantMsgs = plainMessages.filter((m) => m.role === 'assistant');
      const lastOverallMsg = plainMessages[plainMessages.length - 1];
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

    const lastAssistantMsg = [...plainMessages].reverse().find((m) => m.role === 'assistant');
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
  }, [plainMessages, isStreaming, isVoiceModeActive]);

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
