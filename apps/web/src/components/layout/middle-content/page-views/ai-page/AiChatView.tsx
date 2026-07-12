/**
 * AiChatView - Page-level AI agent chat view
 *
 * This component provides a chat interface for AI_CHAT page types.
 * It uses the Agent engine for conversation management, independent
 * from the Global Assistant.
 */

import { TreePage } from '@/hooks/usePageTree';
import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { createId } from '@paralleldrive/cuid2';
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
import { useEditingStore } from '@/stores/useEditingStore';
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
  useConversationIdentity,
  type ConversationIdentityResolveResult,
  conversationIdFrom,
  isResolving,
  useChatTransport,
  useStreamingRegistration,
  useSendHandoff,
  useAskUserAnswering,
  buildChatConfig,
  AgentConfig,
} from '@/lib/ai/shared';
import {
  ProviderSetupCard,
} from '@/components/ai/shared/chat';
import { AskUserAnswerProvider } from '@/components/ai/shared/chat/ask-user/AskUserAnswerContext';
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

const AiChatView: React.FC<AiChatViewProps> = ({ page }) => {
  const params = useParams();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const { cache } = useSWRConfig();
  const { user } = useAuth();

  // ============================================
  // LOCAL STATE
  // ============================================
  const { draft: input, setDraft: setInput, clearDraft: clearInputDraft } = useDraft(
    buildDraftKey('ai', page.id),
  );
  const [activeTab, setActiveTab] = useState<string>('chat');
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [showError, setShowError] = useState(true);
  const [isReadOnly, setIsReadOnly] = useState<boolean>(false);
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
  // Always reflects the current identity's conversationId (kept in sync
  // directly during render, further below, once currentConversationId is
  // derived) so async reconciliation callbacks (e.g. the late-joiner sync)
  // can detect that the user has since switched away before applying a
  // stale setIdentity call.
  const currentConversationIdRef = useRef<string | null>(null);
  // Tracks the conversationId of the most recent loadMessagesForConversation call so
  // stale in-flight fetches (from a previous conversation) are silently dropped.
  const loadRequestedIdRef = useRef<string | null>(null);
  // When set to a conversationId, the load-on-select effect skips the fetch for that
  // id on its next fire (messages are already provided inline, avoiding a double-fetch).
  const skipLoadEffectRef = useRef<string | null>(null);
  // Mirrors the identity hook's isPersisted for the callbacks that must read it
  // outside of render (the message loader, the stream-completion handler).
  const isPersistedRef = useRef<boolean>(true);
  // The identity hook is declared BELOW (it needs loadMessagesForConversation), so the
  // loader reaches its setter through a ref rather than a closure.
  const setPersistedRef = useRef<((isPersisted: boolean) => void) | null>(null);
  // Messages prefetched by resolveConversation (init path) for the id it resolves to,
  // consumed once by the load-on-select effect below to avoid a double-fetch.
  const preloadedMessagesRef = useRef<{ id: string; messages: UIMessage[] } | null>(null);

  // ============================================
  // CHAT CONFIGURATION (hoisted above conversation identity: loadMessagesForConversation
  // needs setMessages, and identity resolution needs loadMessagesForConversation)
  // ============================================
  // Stable transport: uses page.id so the transport (and therefore chatConfig)
  // never changes across conversation switches within the same page. Changing
  // the transport on every switch caused useChat to reset its internal store,
  // which clobbered the messages written by loadMessagesForConversation — the
  // root cause of conversations not loading when clicked from History.
  // Third arg is the socket channel this page's streams are broadcast on — see
  // useChatTransport / consumingChannels.
  const transport = useChatTransport(page.id, '/api/ai/chat', page.id);
  const streamTrackingId = page.id;

  const handleChatError = useCallback((error: Error) => {
    console.error('AiChatView: Chat error:', error);
  }, []);

  const chatConfig = useMemo(
    () => !transport ? null : buildChatConfig({
      id: page.id,
      transport,
      onError: handleChatError,
    }),
    [page.id, transport, handleChatError]
  );

  const { messages, sendMessage, status, error, regenerate, setMessages, stop: chatStop, addToolResult } =
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
    // Skip an id that has no server-side conversation yet (freshly minted, no
    // message sent). Gated on the FACT, not on the shape of the id string — the
    // old sentinel-string check kept refusing to load conversations the server
    // had in fact persisted under that very id, which is why chats came back
    // empty after a reload.
    if (conversationId === currentConversationIdRef.current && !isPersistedRef.current) return;

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
        // The conversation isn't there. Either the send that was supposed to create it
        // never reached the server (the credit gate runs BEFORE the row is persisted,
        // so a 402 leaves nothing behind), or it was deleted elsewhere. Fall back to
        // "fresh chat" rather than showing a load-failure banner for a conversation
        // that does not exist — this is the only thing that walks `isPersisted` back,
        // and without it the flag is a one-way door on an unverified assumption.
        if (res.status === 404) {
          if (conversationId === currentConversationIdRef.current) {
            setPersistedRef.current?.(false);
          }
          return;
        }
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
      // Scoped by conversation, not `[0]`. getOwnStreams filters by pageId only, and a
      // user can genuinely have two own streams on one page (send, then hit New Chat
      // while it is still running) — in which case `[0]` may be the OTHER conversation's
      // and the in-flight bubble for this one gets dropped on a DB reload.
      const ownStream = usePendingStreamsStore
        .getState()
        .getOwnStreams(page.id)
        .find((s) => s.conversationId === conversationId);
      const merged =
        ownStream?.conversationId === conversationId && ownStream.messageId
          ? mergeServerAndPending(serverMessages, ownStream.parts, ownStream.messageId, ownStream.startedAt)
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

  // ============================================
  // CONVERSATION IDENTITY
  // ============================================
  // Determines which conversation this page should show. The only genuine async
  // unknown is "does this page already have a persisted conversation" — a real
  // fetch failure here must surface an error/retry state, not be silently treated
  // as "no conversations exist" (that misclassification was the root cause of a
  // fresh, disconnected conversation replacing a real one after a transient
  // network blip). Creating/selecting a conversation elsewhere is always a
  // synchronous setIdentity call — never routed through this resolver.
  const resolveConversation = useCallback(async (): Promise<ConversationIdentityResolveResult> => {
    const listResponse = await fetchWithAuth(
      `/api/ai/page-agents/${page.id}/conversations?pageSize=1`
    );
    if (!listResponse.ok) {
      throw new Error(`Failed to load conversations (${listResponse.status})`);
    }
    const { conversations: list } = (await listResponse.json()) as ConversationListResponse;

    if (list && list.length > 0) {
      const conv = list[0];
      // The conversation's identity is already known at this point (conv.id) —
      // a failure prefetching its messages (thrown exception or a non-ok
      // response) must not be treated as an identity-resolution failure.
      // loadMessagesForConversation takes the network path itself and
      // surfaces its own per-conversation error banner on failure.
      let loaded: UIMessage[] | undefined;
      try {
        const msgResponse = await fetchWithAuth(
          `/api/ai/page-agents/${page.id}/conversations/${conv.id}/messages`
        );
        loaded = msgResponse.ok
          ? (((await msgResponse.json()) as ConversationMessagesResponse).messages ?? [])
          : undefined;
      } catch (err) {
        console.warn('Failed to prefetch messages during init, falling back to network load:', err);
        loaded = undefined;
      }
      if (loaded !== undefined) {
        preloadedMessagesRef.current = { id: conv.id, messages: loaded };
      }
      // Includes legacy `${pageId}-default` rows: the server used to accept that
      // sentinel and mint a real conversation under it. They come back from the
      // list like any other conversation and now load normally — which is how
      // existing users get their stranded history back, with no data migration.
      return { conversationId: conv.id, isPersisted: true };
    }

    // No conversation exists yet. Mint a real cuid — the server creates the row
    // under exactly this id on the first send. (This used to be a `${pageId}-default`
    // sentinel, which the server accepted unvalidated and the client then refused
    // to load back: messages persisted, chat rendered empty.)
    return { conversationId: createId(), isPersisted: false };
  }, [page.id]);

  const {
    state: identityState,
    canSend: canSendMessage,
    isPersisted,
    setIdentity,
    setPersisted,
    retry: retryResolveConversation,
  } = useConversationIdentity({ resolve: resolveConversation });

  const currentConversationId = conversationIdFrom(identityState);
  // Same render-body-assignment rationale as currentConversationIdRef below: the
  // loaders and the stream-completion callback must read the value from the most
  // recently rendered pass, with no effect-flush lag.
  isPersistedRef.current = isPersisted;
  setPersistedRef.current = setPersisted;
  // Updated directly during render (not via an effect like pageIdRef) so the
  // late-joiner sync callback always reads the value from the most recently
  // rendered pass with no effect-flush lag. This component uses no
  // concurrent-rendering features (no Suspense/startTransition) that could
  // discard an in-progress render before commit, so the theoretical
  // staleness a render-body write risks doesn't apply here — but an effect
  // introduces a real one: an async callback firing before React flushes a
  // just-scheduled effect would read a stale ref value.
  currentConversationIdRef.current = currentConversationId;
  const isInitialized = !isResolving(identityState) && identityState.status !== 'idle';
  const conversationResolveError = identityState.status === 'error' ? identityState.message : null;

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

  // Get web search + image-generation settings from the global assistant settings store
  const webSearchEnabled = useAssistantSettingsStore((state) => state.webSearchEnabled);
  const imageGenEnabled = useAssistantSettingsStore((state) => state.imageGenEnabled);

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
      // Only reached via the undo-triggered reload path (onUndoApplied below)
      // — history-select goes straight through setIdentity, letting the
      // load-on-select effect below do the (one, authoritative) fetch. Doesn't
      // touch activeTab/skipLoadEffectRef: an undo can land while the user is
      // on a different tab, and currentConversationId isn't changing here so
      // the load-on-select effect won't double-fire regardless.
      void loadMessagesForConversation(conversationId, messages);
    },
    onConversationLoadError: (_conversationId, error) => {
      // The conversation list fetch failed — show the error inline without
      // clearing existing messages (caller's toast already announced the failure).
      setMessagesLoadError(error);
    },
    onConversationCreate: (conversationId) => {
      // createConversation() already generated this id synchronously and
      // called this callback before its persist POST resolves — adopt it
      // immediately so a send fired right after "New Chat" can't race.
      skipLoadEffectRef.current = conversationId;
      setIdentity(conversationId);
      setMessages([]);
      setActiveTab('chat');
    },
    onConversationDelete: () => {
      // Mint a fresh cuid, not a sentinel. skipLoadEffectRef FIRST — otherwise the
      // load-on-select effect fires for an id with nothing behind it and
      // setMessages([]) lands on top of whatever the user does next.
      const nextId = createId();
      skipLoadEffectRef.current = nextId;
      setIdentity(nextId, { isPersisted: false });
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
    if (!isPersisted) return;
    if (conversations.some((c) => c.id === currentConversationId)) return;
    if (syncedConversationRef.current === currentConversationId) return;
    syncedConversationRef.current = currentConversationId;
    refreshConversations();
  }, [currentConversationId, conversations, isPersisted, refreshConversations]);

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

  // Load agent config (independent of conversation identity resolution, which
  // useConversationIdentity/resolveConversation handles above).
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const agentConfigResponse = await fetchWithAuth(`/api/pages/${page.id}/agent-config`, {
          signal: controller.signal,
        });
        if (agentConfigResponse.ok) {
          const config = await agentConfigResponse.json();
          setAgentConfig(config);
          if (config.aiProvider) setSelectedProvider(config.aiProvider);
          if (config.aiModel) setSelectedModel(config.aiModel);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Failed to load agent config:', error);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  // Load-on-select guarantee: whenever currentConversationId changes to a real
  // (non-placeholder) id, reload the latest messages from the DB — unless
  // resolveConversation already prefetched them for this exact id (init path)
  // or the caller opted out via skipLoadEffectRef (new-conversation path,
  // which has no messages to fetch yet). History-select also funnels through
  // here now — one authoritative fetch path for every conversation switch.
  useEffect(() => {
    if (!currentConversationId) return;
    if (!isPersisted) return;
    if (skipLoadEffectRef.current === currentConversationId) {
      skipLoadEffectRef.current = null; // consume the skip token
      return;
    }
    if (preloadedMessagesRef.current?.id === currentConversationId) {
      const preloaded = preloadedMessagesRef.current.messages;
      preloadedMessagesRef.current = null;
      void loadMessagesForConversation(currentConversationId, preloaded);
      return;
    }
    void loadMessagesForConversation(currentConversationId);
  }, [currentConversationId, isPersisted, loadMessagesForConversation]);

  // Register streaming state with editing store
  useStreamingRegistration(
    `ai-chat-${page.id}`,
    isStreaming,
    { pageId: page.id, componentName: 'AiChatView' }
  );

  // Conversation-scoped, mirroring selectChannelRemoteStreams. A page channel carries
  // every conversation's streams; without the filter, a stream running in a DIFFERENT
  // conversation on this page renders into the one on screen — which on its own looks
  // exactly like duplication.
  //
  // The scoping is UNCONDITIONAL, including while the conversation is still unpersisted.
  //
  // It is tempting to drop the filter for a not-yet-sent conversation ("it owns no
  // streams, so there is nothing to confuse it with") in order to restore the one
  // deliberate property of the old `${pageId}-default` sentinel: two people opening a
  // fresh AI page shared an id, so each could watch the other's stream. Do not. That
  // property WAS a privacy leak. Conversations are private by default, and the page
  // channel carries every conversation on the page — so on a shared AI page, an
  // unfiltered surface renders another user's PRIVATE conversation token by token to
  // anyone who opens the page. (The client-side filter is not the only defence any
  // more — see the conversation-scoped authorization on /active-streams and
  // /stream-join — but it must not be the hole either.)
  //
  // It also mistargets Stop: hitting "New Chat" mid-stream would leave the blank chat
  // showing `effectiveIsStreaming` with a Stop button wired to the OLD conversation.
  //
  // A surface that never sent anything simply doesn't render someone else's stream. If
  // that stream turns out to be this user's own conversation, onStreamComplete's
  // late-joiner sync adopts it and the message appears.
  const remoteStreams = usePendingStreamsStore(
    useShallow((state) =>
      currentConversationId === null
        ? []
        : state.getRemotePageStreams(page.id).filter((s) => s.conversationId === currentConversationId)
    )
  );

  // Subscribe to a primitive (messageId | undefined) so token appends to the
  // own stream don't churn this hook's identity and re-render ChatLayout per chunk.
  const ownStreamMessageId = usePendingStreamsStore(
    (state) =>
      currentConversationId === null
        ? undefined
        : state.getOwnStreams(page.id).find((s) => s.conversationId === currentConversationId)?.messageId
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
      // 'streaming', NOT the looser isStreaming (which includes 'submitted'). useChat sets
      // status='submitted' BEFORE issuing the request and pushes the new assistant message only
      // inside write(), which flips to 'streaming' in the same job. So during submitted the
      // array's last assistant message is THE PREVIOUS TURN'S reply — and passing the loose flag
      // made this resolve to it and `return` early, aborting a message that finished minutes ago
      // and never reaching the chatId fallback below, which would actually have worked. The local
      // fetch stopped, the button looked like it worked, and the server kept generating and
      // billing. Reachable on any 2nd+ turn, in the 0.5-3s window where a user hits Stop after a
      // typo — the single most likely moment for them to hit it.
      isStreaming: status === 'streaming',
      lastAssistantMessageId,
    });
    if (messageId) {
      void abortActiveStreamByMessageId({ messageId });
      return;
    }
    // No assistant id yet (submitted, before the first chunk). The chatId map is EMPTY here, not
    // stale: setActiveStreamId only runs once the response headers land, and a real send spends
    // 0.5-3s before that. So pass the conversationId — the one name we hold from t=0 — and the
    // abort falls back to it. Without that, Stop in this window was a guaranteed no-op: the fetch
    // was cancelled, the button flipped back to Send, and the server (which deliberately survives
    // client disconnect) kept generating, kept running write tools, and kept billing.
    const conversationId = currentConversationIdRef.current;
    if (streamTrackingId) void abortActiveStream({ chatId: streamTrackingId, conversationId });
    if (streamTrackingId !== page.id) void abortActiveStream({ chatId: page.id, conversationId });
  }, [chatStop, ownStreamMessageId, status, lastAssistantMessageId, streamTrackingId, page.id]);

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

      // The conversation row is definitely on the server by now (the stream that just
      // finished wrote to it). If the cached list still doesn't have it, the optimistic
      // sync below raced the POST: adoptConversationAsPersisted() flips isPersisted the
      // moment a send leaves, so the list-sync effect fired, fetched a list that did not
      // yet contain the row, and latched syncedConversationRef to this id — which then
      // blocks it from ever trying again. Without this, the header's share toggle and the
      // History tab never learn about the conversation the user is sitting in.
      // Scoped to the conversation on screen. chat:stream_complete is broadcast to the
      // whole page room with no conversation filter, so without this we'd refetch the
      // conversation list on every OTHER member's assistant message — and their private
      // conversations can never appear in our list, so it would refetch forever.
      if (completedConvId === currentConversationId
        && !conversations.some((c) => c.id === completedConvId)) {
        if (syncedConversationRef.current === completedConvId) {
          syncedConversationRef.current = null;
        }
        refreshConversations();
      }

      if (stream && stream.parts.length > 0 && stream.conversationId === currentConversationId) {
        // REPLACE by id — do not skip. An existing message with this id is NOT proof we already
        // have the content.
        //
        // The server names the assistant message (`generateId: () => serverAssistantMessageId`),
        // so useChat's copy shares the stream's `messageId`. useChat does not roll back on error,
        // so a mid-stream network drop leaves its HALF-STREAMED message in the array — and that
        // is precisely when recovery rejoins the multicast and `stream.parts` accumulates the
        // FULL reply. Skipping threw the complete version away and left the user with the
        // truncated one, the real text stranded in the DB until they navigated away and back.
        //
        // Replacing is correct for the duplicate case too (same id = same message; stream.parts
        // is the authoritative copy), so it subsumes the original de-dup intent.
        const synthesized = synthesizeAssistantMessage(messageId, stream.parts, stream.startedAt);
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === messageId);
          return i === -1
            ? [...prev, synthesized]
            : prev.map((m, j) => (j === i ? synthesized : m));
        });
        return;
      }

      if (shouldReloadOnComountComplete(stream, completedConvId, currentConversationId)) {
        void loadConversation(completedConvId!);
        return;
      }

      if (!stream || stream.parts.length === 0) return;

      // The stream belongs to a conversation this surface hasn't confirmed exists
      // server-side yet (first message on a brand-new chat). Confirm it landed, then
      // adopt it as persisted so the loaders stop skipping it.
      if (!isPersistedRef.current) {
        const { parts, conversationId: streamConvId, startedAt } = stream;
        fetchWithAuth(`/api/ai/page-agents/${page.id}/conversations?pageSize=1`)
          .then(async (res) => {
            if (pageIdRef.current !== page.id) return;
            if (!res.ok) return;
            const data = (await res.json()) as ConversationListResponse;
            const persisted = data.conversations?.[0];
            if (!persisted || persisted.id !== streamConvId) return;
            // This is a background reconciliation, not a user action — unlike
            // create/select, it must not clobber an identity the user has
            // since moved on to (e.g. via New Chat or history-select) while
            // this fetch was in flight. Only apply if still on the same
            // unpersisted conversation that triggered it.
            if (isPersistedRef.current) return;
            setIdentity(persisted.id);
            setMessages((prev) =>
              prev.some((m) => m.id === messageId)
                ? prev
                : [...prev, synthesizeAssistantMessage(messageId, parts, startedAt)],
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

  // Adopt the selected id immediately — before any fetch even starts — so a
  // send fired right after clicking a history item can't race and land under
  // the previous conversation. The load-on-select effect (keyed on
  // currentConversationId) does the actual fetch once identity updates —
  // the same single, stale-guarded path used on init, so there's no separate
  // loadConversation/onConversationLoad indirection to race against it.
  const handleSelectConversation = useCallback((conversationId: string) => {
    setIdentity(conversationId);
    setActiveTab('chat');
  }, [setIdentity]);

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

  const buildAskUserAnswerBody = useCallback(async () => {
    const pageContext = await buildFreshPageContext();
    return {
      chatId: page.id,
      conversationId: currentConversationId,
      selectedProvider,
      selectedModel,
      isReadOnly,
      webSearchEnabled,
      imageGenEnabled,
      mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
      pageContext,
    };
  }, [
    buildFreshPageContext,
    page.id,
    currentConversationId,
    selectedProvider,
    selectedModel,
    isReadOnly,
    webSearchEnabled,
    imageGenEnabled,
    mcpToolSchemas,
  ]);

  const askUserAnswering = useAskUserAnswering({
    messages,
    status,
    addToolResult,
    wrapSend,
    buildBody: buildAskUserAnswerBody,
  });

  // A send creates the conversations row server-side under exactly this id, so the id
  // becomes real the moment the POST leaves. Flipping isPersisted re-runs the
  // load-on-select effect for the SAME id, though — and that effect would fetch a
  // conversation whose first message has not been written yet and setMessages([]) over
  // the optimistic user bubble and the in-flight stream. Claim the skip token first.
  const adoptConversationAsPersisted = useCallback(() => {
    if (isPersistedRef.current) return;
    const id = currentConversationIdRef.current;
    if (id) skipLoadEffectRef.current = id;
    setPersisted(true);
  }, [setPersisted]);

  const handleSendMessage = useCallback(() => {
    if (isReadOnly) {
      toast.error('You do not have permission to send messages in this AI chat');
      return;
    }
    const trimmed = input.trim();
    const files = getFilesForSend();
    if (!trimmed && files.length === 0) return;
    if (!canSendMessage) return;

    // Start context fetch eagerly — runs in parallel with input clear so the
    // async wait doesn't delay sendMessage (and the optimistic bubble).
    const contextPromise = buildFreshPageContext();

    clearInputDraft();
    clearFiles();
    inputRef.current?.clear();

    adoptConversationAsPersisted();

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
            imageGenEnabled,
            mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
            pageContext,
          },
        }
      );
    });
  }, [
    isReadOnly,
    input,
    // `attachments.length` was here and is redundant: getFilesForSend (below) is memoized on
    // [attachments], so it already changes whenever they do. ESLint flagged it once the rule was
    // promoted to an error for these files — which is the rule doing exactly its job.
    currentConversationId,
    canSendMessage,
    buildFreshPageContext,
    getFilesForSend,
    clearInputDraft,
    clearFiles,
    sendMessage,
    page.id,
    selectedProvider,
    selectedModel,
    webSearchEnabled,
    imageGenEnabled,
    mcpToolSchemas,
    wrapSend,
    adoptConversationAsPersisted,
  ]);

  // Voice mode: Send message from voice transcript
  const handleVoiceSend = useCallback((text: string) => {
    if (isReadOnly) {
      toast.error('You do not have permission to send messages in this AI chat');
      return;
    }
    if (!text.trim()) return;
    if (!canSendMessage) return;

    const contextPromise = buildFreshPageContext();
    adoptConversationAsPersisted();
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
            imageGenEnabled,
            mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
            pageContext,
          },
        }
      );
    });
  }, [
    isReadOnly,
    currentConversationId,
    canSendMessage,
    buildFreshPageContext,
    sendMessage,
    page.id,
    selectedProvider,
    selectedModel,
    webSearchEnabled,
    imageGenEnabled,
    mcpToolSchemas,
    wrapSend,
    adoptConversationAsPersisted,
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

  const resumeEnabled = useCallback(
    () => currentConversationIdRef.current !== null && !useEditingStore.getState().isAnyEditing(),
    [],
  );

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
    // Gate on USER editing only, and evaluate it at fire time (callback form).
    // The old gate was `!isEditingActive()`, i.e. isAnyActive(), which is true
    // whenever an 'ai-streaming' session exists — and this component registers one
    // while streaming. So the hook early-returned in exactly the case it was
    // written for. Worse, a boolean is captured at render, and iOS freezes JS
    // while backgrounded, so the captured value was always the streaming one.
    enabled: resumeEnabled,
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

  // NOTE: deliberately NO unmarkChannelConsuming() on unmount. The consuming refcount
  // is owned by the transport's response-body wrapper — one release per POST, and
  // this component holds no reference of its own to release. Unmarking here would
  // decrement someone else's count (a co-mounted surface on the same channel), and
  // unmounting does not stop the body anyway: `useChat` keys its Chat instance by
  // `page.id`, so a remount reuses the same instance and keeps consuming. The count
  // clears itself when that body finishes — and a reload, which is the case this whole
  // mechanism exists for, resets the module outright.

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
    <AskUserAnswerProvider value={askUserAnswering}>
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
          {/* Inline error shown when resolving which conversation to show fails — a
              transient network error must never be silently treated as "no
              conversations exist" and replaced with a fresh, disconnected one. */}
          {conversationResolveError && (
            <div className="flex items-center justify-between gap-2 px-4 py-2 bg-destructive/10 text-destructive text-sm border-b border-destructive/20">
              <span className="truncate">Failed to load this conversation: {conversationResolveError}</span>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={retryResolveConversation}
              >
                Retry
              </Button>
            </div>
          )}
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
            disabled={!isAnyProviderConfigured || !canSendMessage}
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
            onSelectConversation={handleSelectConversation}
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
    </AskUserAnswerProvider>
  );
};

export default React.memo(
  AiChatView,
  (prevProps, nextProps) =>
    prevProps.page.id === nextProps.page.id &&
    prevProps.page.title === nextProps.page.title &&
    prevProps.page.type === nextProps.page.type
);
