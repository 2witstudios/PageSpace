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
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Activity, Plus, History } from 'lucide-react';
import { AiUsageMonitor, AISelector, TasksDropdown, PlanChip } from '@/components/ai/shared';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { useGlobalChatConversation } from '@/contexts/GlobalChatContext';
import { usePageAgentDashboardStore } from '@/stores/page-agents';
import { VoiceCallBarForConversation } from '@/components/ai/voice/realtime';
import { useVoiceRebindStore } from '@/stores/useVoiceRebindStore';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';

// Shared hooks and components
import {
  useMCPTools,
  useCacheMessageActions,
  useProviderSettings,
  useChatSession,
  useSendHandoff,
  useResumeBootstrap,
  useAnswerAskUser,
  useChatErrorCause,
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
import { useRenderedMessages, useConversationLoadState, useConversationOlderPageState } from '@/hooks/useRenderedMessages';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { getOutboundMessages } from '@/hooks/outboundMessages';
import {
  loadGlobalConversationMessages,
  loadAgentConversationMessages,
  loadOlderGlobalConversationMessages,
  loadOlderAgentConversationMessages,
} from '@/hooks/conversationMessagesLoaders';
import { buildUserMessage } from '@/lib/ai/streams/buildUserMessage';
import { rollbackOptimisticSendOnFailure } from '@/lib/ai/streams/rollbackOptimisticSendOnFailure';
import { createId } from '@paralleldrive/cuid2';


const GlobalAssistantView: React.FC = () => {
  const pathname = usePathname();
  const setRightSidebarOpen = useLayoutStore((state) => state.setRightSidebarOpen);
  const setRightSheetOpen = useLayoutStore((state) => state.setRightSheetOpen);
  const { user } = useAuth();

  // ============================================
  // GLOBAL CHAT CONTEXT - for Global Assistant mode
  // ============================================
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
  // Agent mode state (provider/model settings)
  const [agentSelectedProvider, setAgentSelectedProvider] = useState<string>(DEFAULT_PROVIDER);
  const [agentSelectedModel, setAgentSelectedModel] = useState<string>('');

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

  // The switcher is the voice switcher — see the twin of this comment in
  // SidebarChatTab. Records an intent on the explicit act; navigation records
  // nothing and therefore can never rebind.
  const requestVoiceRebind = useVoiceRebindStore((state) => state.requestRebind);
  const handleSelectAgentForVoice = useCallback(
    (agent: Parameters<typeof selectAgent>[0]) => {
      selectAgent(agent);
      requestVoiceRebind(agent?.id ?? null);
    },
    [selectAgent, requestVoiceRebind],
  );

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

  // `userId` is what `isOwnStream` compares, so a store entry opened by either send is
  // recognised as this user's own in every tab and on every device.
  const sendIdentity = useMemo(
    () => ({ userId: user?.id ?? '', displayName: user?.name || user?.email || 'You' }),
    [user?.id, user?.name, user?.email],
  );

  // TWO SEND SHELLS, one per mode — and unlike the two `useChat` instances they replace, both
  // can have sends in flight simultaneously without interfering. A shell is a `fetch` wrapper
  // with per-conversation state, so "agent mode is busy" places no constraint at all on a
  // global-mode send, and neither places one on a send into a DIFFERENT conversation of the
  // same mode. That is the whole reason the pre-send handoff below is gone rather than moved.
  //
  // Their bases are the settled store views, read at call time — see `useChatSession`.

  const {
    sendMessage: agentSendMessage,
    status: agentStatus,
    error: agentError,
    clearError: agentClearError,
    regenerate: agentRegenerate,
    addToolResult: agentAddToolResult,
  } = useChatSession({
    api: '/api/ai/chat',
    channelId: selectedAgent?.id ?? null,
    conversationId: agentConversationId,
    triggeredBy: sendIdentity,
    getBaseMessages: getOutboundMessages,
    onError: (error: Error) => {
      console.error('Agent Chat error:', error);
    },
  });

  const {
    sendMessage: globalSendMessage,
    status: globalStatus,
    error: globalError,
    clearError: globalClearError,
    regenerate: globalRegenerate,
    addToolResult: globalAddToolResult,
  } = useChatSession({
    api: globalConversationId
      ? `/api/ai/global/${encodeURIComponent(globalConversationId)}/messages`
      : '',
    channelId: channelIdForGlobal,
    conversationId: globalConversationId,
    triggeredBy: sendIdentity,
    getBaseMessages: getOutboundMessages,
    onError: (error: Error) => {
      console.error('Global Chat Error:', error);
      if (error.message?.includes('Unauthorized') || error.message?.includes('401')) {
        console.error('Authentication failed - user may need to log in again');
      }
    },
  });

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
  const addToolResult = selectedAgent ? agentAddToolResult : globalAddToolResult;

  // ============================================
  // STREAM/STOP — one selector read per mode (PR 5A)
  // ============================================
  // The channel each mode's streams live on. Agent streams are keyed by the agent's page id;
  // global streams by this user's global channel id. Both are what useChannelStreamSocket and
  // useOwnStreamMirror write their store entries under.
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
  // "Is this mode's own send live?" — the pending send OR its own store entry. There are no
  // transport arrays left to guard, so this no longer needs a third input: the store entry is
  // no longer absent during a store wipe (nothing wipes it — the registry owns it at module
  // scope), and the submitted window is exactly what `pendingSendConversationId` covers.
  const agentSendLive =
    isOwnAgentStreamForCurrentConversation ||
    (pendingSendConversationId !== null && pendingSendConversationId === agentConversationId);
  const globalSendLive =
    isOwnGlobalStreamForCurrentConversation ||
    (pendingSendConversationId !== null && pendingSendConversationId === globalConversationId);

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
  // NO OWN-STREAM MIRRORS, and nothing replaced them.
  //
  // Two `useOwnStreamMirror` mounts stood here, copying each chat's own live assistant reply
  // OUT of useChat's internal array and INTO `usePendingStreamsStore`, so this surface's own
  // streams were present in the store the same way a bootstrapped or remote one was. That
  // copy is what made the mirror necessary at all — it was one stateful container being
  // reconciled against another, and it carried a latch, a re-latch rule for server-issued id
  // adoption, a wipe-repair subscription, and a documented one-commit-wide window in which it
  // could name the wrong conversation.
  //
  // There is one container now. `useChatSession` opens the store entry itself, from the
  // admission envelope, keyed by the messageId the server stated — so an own stream is in the
  // store from the instant it is admitted, by the same call that started it. Nothing is
  // mirrored because nothing is duplicated.
  //
  // NO PRE-SEND HANDOFFS either. Both shells can have sends in flight at once, so a send into
  // conversation B while A generates needs no `stop()`, no settle wait, and cannot be refused.

  const stop = useStopStream({
    activeStream,
    pendingSendConversationId,
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
  const isOwnSendLive = selectedAgent ? agentSendLive : globalSendLive;
  // Read after an await (resume runs async), so a ref rather than the captured value.
  const isOwnSendLiveRef = useRef(isOwnSendLive);
  isOwnSendLiveRef.current = isOwnSendLive;
  // Conversation-scoped counterpart, for consumers that must not see the OLD conversation's
  // still-in-flight raw useChat status as "busy" (PR 6 review, CodeRabbit, same class as the
  // AskUser fix above) — resume's isOwnStreamLive gate, unlike useCacheMessageActions' clobber
  // guard, which is deliberately conversation-agnostic.
  const effectiveIsStreamingRef = useRef(effectiveIsStreaming);
  effectiveIsStreamingRef.current = effectiveIsStreaming;


  const { handleEdit, handleDelete, handleRetry } = useCacheMessageActions({
    agentId: selectedAgent?.id || null,
    conversationId: currentConversationId,
    renderedMessages,
    isOwnSendLive,
    // Adapts the shell's explicit-conversation `regenerate` to the action hook's
    // conversation-less one. Binding the id HERE is what makes a Retry unambiguous — it used
    // to be inferred inside a shared `Chat` from whatever the surface had last touched, which
    // is how a Retry could re-send another conversation's trail under this one's body.
    regenerate: (opts?: { body?: Record<string, unknown> }) => {
      if (!currentConversationId) return;
      void regenerate(currentConversationId, opts);
    },
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
    enabled: resumeEnabled,
  });


  // ============================================
  // MODE-SWITCH STREAM EFFECTS
  // ============================================
  // NO clear-agent-messages-on-global effect (PR 5B, leaf 5.4 W6): rendering is
  // per-conversation from the cache, so a stale transport array renders nothing —
  // and the mirror latches only during its own send, so an un-cleared array cannot
  // mislead it (PR 5A's latch fix). The clear existed for the old render path.

  // NO MODE-SWITCH STOP. Deleted, not made server-aborting.
  //
  // An effect here used to call `globalStop()` whenever the user selected an agent while a
  // global reply was streaming. It was documented as an "accepted residual" on the grounds
  // that "the server generation continues" — which is true, and is the half that does not
  // matter. The user's rule has two clauses: (a) do not abort the compute, (b) do not end the
  // run's VISIBLE life. Only (a) was ever reasoned about. Switching which mode you are LOOKING
  // AT is not a stop by any reading, and the run's tokens kept arriving on a channel this tab
  // had just stopped reading, so the reply the user came back to was frozen at the moment they
  // glanced away.
  //
  // Nothing takes its place, because nothing needs to: both modes' streams live in the same
  // store, written by the same app-wide registry, and a mode switch changes only which of them
  // is selected for display. `only-a-deliberate-stop.test.ts` fails if this comes back.

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
  // This is Elliott rail 11: no effect may copy state between stateful containers. The
  // own-stream mirror above was the one sanctioned exception to it — and it is now deleted
  // too, so the rail holds here without exception. `useChatSession` opens the store entry
  // itself from the admission envelope, which means the fact was never copied at all: there is
  // one container, and everything reads it.

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

  // Shared by every send-shaped request (typed send, AskUser resume) — one
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

    // NO PRE-SEND HANDOFF, and no path that can refuse the send. A send is its own `fetch`;
    // a generation already running in another conversation — or in the other mode — is
    // simply not this send's concern. What stood here stopped the other read, waited up to
    // 1.5s for a status to settle, and on timeout put the user's text back in the composer
    // behind a toast.
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
      () => wrapSend(() => sendMessage(userMessage, currentConversationId, { body: requestBody })),
      currentConversationId,
      userMessage.id,
    );
    // Note: scrollToBottom is now handled by use-stick-to-bottom when pinned
  };

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
    addToolResult,
    wrapSend,
    buildBody: buildRequestBody,
  });

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
            onSelectAgent={handleSelectAgentForVoice}
            // The CONVERSATION's own liveness, not a raw chat status. Switching agent while
            // something generates is a view change, not a send — and the underlying status no
            // longer reports "streaming" at all, because this client does not read a body.
            disabled={effectiveIsStreaming}
          />
        </div>
        <div className="flex items-center space-x-2">
          <PlanChip conversationId={currentConversationId} messages={plainMessages} />
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

      {/*
        Voice as a MODE on this surface — same conversation, same message list,
        with the live call's chrome above it. Spoken turns arrive in that list as
        ordinary messages, so there is no second transcript here.
      */}
      <VoiceCallBarForConversation
        conversationId={currentConversationId}
        assistantName={selectedAgent ? selectedAgent.title : 'Global Assistant'}
      />

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
