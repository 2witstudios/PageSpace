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
import { Loader2, Settings, MessageSquare, History, Plus, Save, Webhook } from 'lucide-react';
import { UIMessage } from 'ai';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { useVoiceModeStore, type VoiceModeOwner } from '@/stores/useVoiceModeStore';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { PageAgentSettingsTab, PageAgentHistoryTab, ConversationShareToggle, type PageAgentSettingsTabRef } from '@/components/ai/page-agents';
import { AgentIntegrationsPanel } from '@/components/ai/page-agents/AgentIntegrationsPanel';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { VoiceCallPanel } from '@/components/ai/voice/VoiceCallPanel';
import { PageWebhooksDialog } from '@/components/shared/PageWebhooksDialog';

import { useEditingStore } from '@/stores/useEditingStore';
import { canResumeRecovery } from '@/lib/ai/streams/canResumeRecovery';
import { usePageSocketRoom } from '@/hooks/usePageSocketRoom';
import { useChannelStreamSocket } from '@/hooks/useChannelStreamSocket';
import { useRenderedMessages, useConversationOlderPageState } from '@/hooks/useRenderedMessages';
import { loadOlderAgentConversationMessages } from '@/hooks/conversationMessagesLoaders';
import { useActiveStream, useConversationActiveStream, getActiveStreamById } from '@/hooks/useActiveStream';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { refreshConversationSnapshot } from '@/hooks/conversationMessagesLoaders';
import { useOwnStreamMirror } from '@/hooks/useOwnStreamMirror';
import { useStopStream } from '@/hooks/useStopStream';
import { buildUserMessage } from '@/lib/ai/streams/buildUserMessage';
import { synthesizeAssistantMessage } from '@/lib/ai/streams/synthesizeAssistantMessage';
import { applyMessageEdit, type MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import { rollbackOptimisticSendOnFailure } from '@/lib/ai/streams/rollbackOptimisticSendOnFailure';
import { selectVoiceStreamText } from '@/lib/ai/streams/selectVoiceStreamText';
import { selectVoiceActivationBaseline } from '@/lib/ai/streams/selectVoiceActivationBaseline';
import { selectPostBaselineAssistantMessage } from '@/lib/ai/streams/selectPostBaselineAssistantMessage';
import { applyMessageDelete } from '@/lib/ai/streams/applyMessageDelete';
import { shouldRefreshAfterUndo } from '@/lib/ai/streams/shouldRefreshAfterUndo';
import { shouldPrependConversation } from '@/lib/ai/streams/shouldPrependConversation';
import { shouldReloadOnComountComplete } from '@/lib/ai/streams/shouldReloadOnComountComplete';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { useReadAloud } from '@/hooks/useReadAloud';

// Shared hooks and components
import {
  useMCPTools,
  useCacheMessageActions,
  useProviderSettings,
  useConversations,
  useConversationIdentity,
  type ConversationIdentityResolveResult,
  conversationIdFrom,
  isResolving,
  useChatTransport,
  useSendHandoff,
  useConversationSendHandoff,
  HANDOFF_REFUSED_MESSAGE,
  useResumeBootstrap,
  useAnswerAskUser,
  useChatErrorCause,
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
type ConversationMessagesResponse = {
  messages: UIMessage[];
  pagination?: { hasMore: boolean; nextCursor: string | null };
};

const VOICE_OWNER: VoiceModeOwner = 'ai-page';

const AiChatView: React.FC<AiChatViewProps> = ({ page }) => {
  const params = useParams();
  const driveId = params.driveId as string;
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
  const [webhooksOpen, setWebhooksOpen] = useState(false);
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
  const { attachments, addFiles, removeFile, getFilesForSend } = useImageAttachments();

  // Refs
  const chatLayoutRef = useRef<ChatLayoutRef>(null);
  const inputRef = useRef<ChatInputRef>(null);
  const agentSettingsRef = useRef<PageAgentSettingsTabRef>(null);
  // Always reflects the current page.id so async callbacks can detect stale pages
  const pageIdRef = useRef(page.id);
  useEffect(() => { pageIdRef.current = page.id; }, [page.id]);
  // Always reflects the current identity's conversationId (kept in sync
  // directly during render, further below, once currentConversationId is
  // derived) so async reconciliation callbacks (e.g. the late-joiner sync)
  // can detect that the user has since switched away before applying a
  // stale setIdentity call.
  const currentConversationIdRef = useRef<string | null>(null);
  // Tracks the (id) the load-on-select effect last acted on, so an `isPersisted`
  // flip for the SAME id (our own send adopting a just-created conversation) does
  // not re-trigger a fetch — only a genuine id change does. See the effect below.
  const lastHandledIdentityRef = useRef<string | null>(null);
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

  const { messages, sendMessage, status, error, clearError, regenerate, setMessages, stop: chatStop, addToolResult } =
    useChat(chatConfig || {});

  const isStreaming = status === 'submitted' || status === 'streaming';

  // ============================================
  // AUTHORITATIVE MESSAGE LOADER (the ONE conversation-store load writer)
  // ============================================
  // Fetches the latest DB messages for a conversation and commits them to
  // `useConversationMessagesStore` via startLoad/applyLoad/failLoad — the
  // store's `loadGeneration` gate (not a local id-comparison ref) is what
  // drops a stale in-flight fetch superseded by a newer load of the same or a
  // different conversation. All other paths (init, history-select, pull-up,
  // undo) funnel through here so there is never a competing write.
  //
  // Also writes the same messages to useChat via setMessages: useChat is
  // never the render source post-cutover, but it stays the transport/
  // controller, and `regenerate()` indexes directly into its own local
  // `messages` (crashes if empty, throws "not found" on an unknown id) — so
  // its bookkeeping copy must still reflect the loaded history.
  //
  // Pass preloadedMessages to skip the network round-trip when the caller already
  // has fresh data (e.g. useConversations.loadConversation already fetched them).
  // Read at call time by loadMessagesForConversation, which is defined above the point where
  // `activeStream` exists. See its use below for why a DB load must not clobber the array.
  const ownStreamLiveRef = useRef(false);

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

    const generation = conversationMessagesActions.startLoad(conversationId);
    // True while this call's generation is still the newest `startLoad` for this
    // conversation — a newer load of the SAME conversation (rapid re-fetch, a
    // second call for the same id) bumps the generation and this starts reading
    // false. Deliberately NOT scoped to "is this conversation currently on
    // screen" — the store caches every conversation independently, so a load for
    // a conversation the user has since navigated away from should still commit
    // (switching back later shows fresh data without a re-fetch).
    const isCurrent = () => conversationMessagesActions.isLoadCurrent(conversationId, generation);
    // True only while BOTH the above holds AND this load's conversation is still
    // the one on screen. Gates every write that is NOT conversation-keyed
    // (useChat's single local `messages` array, the loading/error UI state) —
    // those must never be clobbered by a load for a conversation the user has
    // since switched away from (PR review, chatgpt-codex-connector: a slow load
    // for conversation A resolving after a switch to B was overwriting B's
    // useChat bookkeeping and clearing B's own in-flight loading indicator).
    const isActiveLoad = () => isCurrent() && conversationId === currentConversationIdRef.current;

    setIsLoadingMessages(true);
    setMessagesLoadError(null);

    try {
      let serverMessages: UIMessage[];
      // Only the network path below carries a pagination envelope (epic leaf 6.6) — the
      // preloaded fast path (history-select, init prefetch) only ever passed the bare
      // messages array through preloadedMessagesRef. "Load older" is unavailable until
      // this conversation's next network reload in that case (best-effort, not a
      // correctness gap: hasMoreOlder simply defaults false until then).
      let pagination: { hasMore: boolean; nextCursor: string | null } | undefined;

      if (preloadedMessages !== undefined) {
        // Fast path: caller already did the fetch (history-select, init).
        serverMessages = preloadedMessages;
      } else {
        const res = await fetchWithAuth(
          `/api/ai/page-agents/${page.id}/conversations/${conversationId}/messages?limit=50`,
        );
        // Stale check after await — a newer load of this conversation may have superseded this one.
        if (!isCurrent()) return;
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
        const data = await res.json() as ConversationMessagesResponse;
        if (!isCurrent()) return;
        serverMessages = data.messages ?? [];
        pagination = data.pagination;
      }

      if (!isCurrent()) return;

      conversationMessagesActions.applyLoad(conversationId, generation, serverMessages, pagination);
      if (isActiveLoad()) {
        // The CACHE always takes the load — that is what renders. The useChat array is a different
        // thing: transport-local bookkeeping, and the array `useOwnStreamMirror` reads to find its
        // own live stream. Writing DB history into it while our own stream is still writing there
        // hands the mirror somebody else's message.
        //
        // Concretely, on a shared conversation: I send, a collaborator's shorter reply lands and
        // persists first, then anything that reloads (their undo, my pull-to-refresh, the Retry
        // button) replaces the array with history whose newest row is THEIR finished reply. The
        // conversation has not changed, so the mirror reads that as the SDK renaming my stream,
        // re-targets onto their messageId, and my live entry is gone: Stop then aborts a message
        // the server has no stream for — user-scoped, so `not_found`, on which reportAbortOutcome
        // is silent — while my generation keeps running its write tools and keeps billing.
        //
        // This is the same clobber guard GlobalAssistantView and SidebarChatTab already carry
        // (#2061); AiChatView never had one. It is the transport write that is unsafe, not the
        // load — so the load still happens, and the array re-syncs on the next load once the
        // stream is over.
        if (!ownStreamLiveRef.current) {
          setMessages(serverMessages);
        }
        setMessagesLoadError(null);
      }
    } catch (err) {
      if (!isCurrent()) return;
      conversationMessagesActions.failLoad(conversationId, generation);
      // Keep the messages the user was already looking at — never silently blank on failure.
      // Scoped to the active load: an error loading a conversation the user has
      // since switched away from must not surface an error banner for the one now on screen.
      if (isActiveLoad()) {
        setMessagesLoadError(err instanceof Error ? err : new Error('Failed to load messages'));
      }
    } finally {
      if (isActiveLoad()) {
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
      // touch activeTab: an undo can land while the user is on a different tab,
      // and currentConversationId isn't changing here so the load-on-select
      // effect won't double-fire regardless.
      void loadMessagesForConversation(conversationId, messages);
    },
    onConversationLoadError: (_conversationId, error) => {
      // The conversation list fetch failed — show the error inline without
      // clearing existing messages (caller's toast already announced the failure).
      setMessagesLoadError(error);
    },
    onConversationCreate: (conversationId) => {
      // createConversation() already generated this id synchronously and called
      // this callback before its persist POST resolves — adopt it immediately so
      // a send fired right after "New Chat" can't race. isPersisted: false (not
      // the setIdentity default of true) is what makes the load-on-select effect
      // below skip fetching messages for an id with nothing behind it yet — no
      // separate skip-ref needed, this IS the honest state of a just-minted id.
      setIdentity(conversationId, { isPersisted: false });
      setMessages([]);
      setActiveTab('chat');
    },
    onConversationDelete: () => {
      // Mint a fresh cuid, not a sentinel — isPersisted: false means the
      // load-on-select effect has nothing to fetch for it.
      const nextId = createId();
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
  //
  // Facade only (container-agnostic consumer rule, PR 4 board): both `streams` and
  // `renderedMessages` below read exclusively through useActiveStream/useRenderedMessages
  // — never usePendingStreamsStore/useConversationMessagesStore directly.
  const { streams: remoteStreams } = useActiveStream(page.id, currentConversationId);
  // The stream identity for the conversation on screen — what Stop names (PR 5A).
  const activeStream = useConversationActiveStream(page.id, currentConversationId);
  // The array is unsafe to replace for the WHOLE local-send lifetime, not just while a store entry
  // happens to exist. `activeStream` alone leaves two holes: the submitted window (no entry exists
  // yet, by design) and any moment the store is temporarily wiped (clearPageStreams on a socket
  // swap — an ordinary auth refresh). `isStreaming` is this chat's own status and covers both;
  // `activeStream?.isOwn` still covers a bootstrapped stream, where our status is idle.
  ownStreamLiveRef.current = isStreaming || activeStream?.isOwn === true;



  // The store-first render source: DB-confirmed + optimistic-sent + live-streaming
  // messages for the active conversation, merged at render (not at write) so no
  // effect ordering can blank a live stream. useChat's own `messages` (destructured
  // above) is never rendered post-cutover — it stays the transport/controller only
  // (see loadMessagesForConversation's docblock for why it is still kept in sync).
  const renderedMessages = useRenderedMessages(page.id, currentConversationId);
  const plainMessages = useMemo(() => renderedMessages.map((r) => r.message), [renderedMessages]);

  // Read Aloud: on-demand TTS for everything the assistant said since the
  // user's last turn, via a shared playback singleton (see readAloudPlayer).
  const { isReadingAloud, toggleReadAloud, canReadAloud: canReadAloudFor } = useReadAloud();
  const canReadAloud = useMemo(() => canReadAloudFor(plainMessages), [canReadAloudFor, plainMessages]);
  const handleReadAloudClick = useCallback(
    () => toggleReadAloud(plainMessages),
    [toggleReadAloud, plainMessages]
  );

  // "Load older" (epic leaf 6.6, scroll-to-top): AiChatView's route IS the agent-conversation
  // route (page.id is the agentId), so the shared agent-mode loader applies directly.
  const { isLoadingOlder } = useConversationOlderPageState(currentConversationId);
  const handleScrollNearTop = useCallback(() => {
    if (!currentConversationId) return;
    void loadOlderAgentConversationMessages(page.id, currentConversationId);
  }, [page.id, currentConversationId]);

  // TRANSITIONAL (see useOwnStreamMirror) — copies this tab's own live assistant
  // reply from useChat's local state into usePendingStreamsStore so it renders via
  // the same store-first path a remote/rejoining tab uses. `ownAssistantMessage`
  // deliberately reads raw `messages` (useChat), not `plainMessages`: this is the
  // ONE place that must read the SDK's own live-growing content in order to copy it
  // OUT into the store — reading the store here would be circular.
  const { getLatchedConversationId } = useOwnStreamMirror({
    status,
    ownMessages: messages,
    pageId: page.id,
    conversationId: currentConversationId ?? '',
    triggeredBy: { userId: user?.id ?? '', displayName: user?.name || user?.email || 'You' },
  });

  // Pre-send handoff (dual-stream fix): a send into a different conversation than the one this
  // chat is consuming for must first stop the local read and hand the in-flight stream to the
  // socket path — the SDK's Chat cannot consume two response bodies at once. Page-agent pages
  // host multiple conversations on one channel (page.id), so the same cross-conversation
  // mis-keying the global sidebar had exists here. See useConversationSendHandoff.
  // Through a ref: useChannelStreamSocket mounts further down; assigned right after it.
  const rejoinActiveStreamsRef = useRef<() => void>(() => {});
  const rejoinActiveStreamsLate = useCallback(() => { rejoinActiveStreamsRef.current(); }, []);
  const { prepareSend } = useConversationSendHandoff({
    status,
    stop: chatStop,
    getLatchedConversationId,
    rejoin: rejoinActiveStreamsLate,
  });

  // Live reads for post-await decisions: the send/retry paths await the handoff, and the
  // render-captured values are stale by the time it settles.
  const isOwnSendLive = isStreaming || activeStream?.isOwn === true;
  const isOwnSendLiveRef = useRef(isOwnSendLive);
  isOwnSendLiveRef.current = isOwnSendLive;
  const getIsOwnSendLive = useCallback(() => isOwnSendLiveRef.current, []);
  const inputDraftRef = useRef(input);
  inputDraftRef.current = input;

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
    const ids = plainMessages
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
  }, [isFindOpen, findQuery, plainMessages, reportMatches]);

  const findMatchSet = useMemo(() => new Set(findMatchIds), [findMatchIds]);
  const currentFindMsgId = findMatchIds[findIndex] ?? null;
  // End-condition is the STORE ENTRY appearing, not useChat's status (PR 5A, leaf 5.7).
  const { wrapSend, pendingSendConversationId } = useSendHandoff(
    currentConversationId,
    status,
    activeStream?.isOwn === true,
  );

  // Scoped to the conversation ON SCREEN, and own-only — same rule as GlobalAssistantView and
  // SidebarChatTab (PR 5A).
  //
  // `isStreaming` (useChat's status) cannot answer this: the SDK's Chat id is constant per
  // surface, so a mid-stream conversation switch leaves it true for the OLD conversation. It
  // therefore lit a Stop button under the NEW one — and that Stop was worse than useless, because
  // `activeStream` for the new conversation is undefined and its pendingSend has been cleared, so
  // the decision resolves to 'none': it cancelled the old conversation's LOCAL fetch and issued no
  // server abort at all, leaving that generation running its write tools and billing while this
  // UI flipped back to Send.
  //
  // A REMOTE stream is excluded for the same reason it is in the other two surfaces: it is live
  // content worth showing, but not something this tab can stop (the server's abort is user-scoped),
  // and folding it in here would suppress the `remoteStreamingUser` chip that names who IS
  // generating.
  //
  // `pendingSendConversationId` covers the submitted window, where no store entry exists yet.
  const effectiveIsStreaming =
    activeStream?.isOwn === true ||
    (pendingSendConversationId !== null && pendingSendConversationId === currentConversationId);
  // Read after an await (resume runs async), so a ref rather than the captured value.
  // Conversation-scoped, unlike ownStreamLiveRef above: that one is deliberately raw
  // (isStreaming || activeStream?.isOwn) for the transport-clobber guard, which stays true
  // for the OLD conversation's still-in-flight request after a switch — exactly wrong for
  // resume's isOwnStreamLive gate (PR 6 review, CodeRabbit; same class of bug fixed in
  // GlobalAssistantView/SidebarChatTab's resume wiring).
  const effectiveIsStreamingRef = useRef(effectiveIsStreaming);
  effectiveIsStreamingRef.current = effectiveIsStreaming;

  // Voice's live-stream text (epic leaf 6.4) — one selector, three consumers.
  const streamingAssistantText = useMemo(
    () => selectVoiceStreamText(renderedMessages),
    [renderedMessages],
  );
  // Show a loading indicator (not a blank) both during init and during any
  // subsequent message-fetch triggered by conversation switch or refresh.
  const isLoading = !isInitialized || isLoadingMessages;

  // ============================================
  // MESSAGE ACTIONS — shared store-first wrapper (F2/F9, PR #2098 review): actions
  // reason over SETTLED rows only, so a synthesized live-stream row can never reach
  // retry/delete's server-side DELETEs; cache writes land after the base call
  // resolves. One implementation with GlobalAssistantView and SidebarChatTab.
  // ============================================
  const { handleEdit, handleDelete, handleRetry } = useCacheMessageActions({
    agentId: page.id,
    conversationId: currentConversationId,
    renderedMessages,
    isOwnSendLive,
    setMessages,
    regenerate,
    // Retry is a send: the handoff runs INSIDE handleRetry, before its destructive steps, and
    // the hydrate decision re-reads liveness after the handoff settles (dual-stream fix).
    prepareSend,
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
  // resolveConversation already prefetched them for this exact id (init path).
  // History-select also funnels through here now — one authoritative fetch
  // path for every conversation switch.
  //
  // `lastHandledIdentityRef` distinguishes a genuine id change (always reloads,
  // including switching away and back — the epic wants a stream still visible
  // on return) from an `isPersisted` flip on the SAME id (our own send calling
  // adoptConversationAsPersisted on a conversation whose first message may not
  // be saved yet — must not fetch). Set it whenever the id changes, BEFORE the
  // `isPersisted` check, so a not-yet-persisted id is remembered as "seen" and
  // its later true-flip is recognized as the same identity rather than a switch.
  useEffect(() => {
    if (!currentConversationId) return;
    const isSameIdentityAsLastHandled = lastHandledIdentityRef.current === currentConversationId;
    lastHandledIdentityRef.current = currentConversationId;
    if (!isPersisted) {
      // No load will run for an unpersisted identity (the early-return at the
      // top of loadMessagesForConversation skips it) — so if the user switched
      // here while a load for the PREVIOUS conversation was still in flight,
      // that load's own `isActiveLoad()` gate will read false when it resolves
      // (conversationId no longer matches currentConversationIdRef) and never
      // clear isLoadingMessages itself. Without this, a fresh/New Chat view can
      // get stuck showing a loading state forever (PR review, chatgpt-codex-connector).
      setIsLoadingMessages(false);
      setMessagesLoadError(null);
      return;
    }
    if (isSameIdentityAsLastHandled) return;
    if (preloadedMessagesRef.current?.id === currentConversationId) {
      const preloaded = preloadedMessagesRef.current.messages;
      preloadedMessagesRef.current = null;
      void loadMessagesForConversation(currentConversationId, preloaded);
      return;
    }
    void loadMessagesForConversation(currentConversationId);
  }, [currentConversationId, isPersisted, loadMessagesForConversation]);

  // NO editing-store registration here (PR 5A, leaf 5.7): the one derived, conversation-keyed
  // registration for the whole app lives in GlobalChatProvider (useDerivedStreamingRegistrations).

  const remoteStreamingUser = !effectiveIsStreaming
    ? remoteStreams.find((s) => !s.isOwn)?.triggeredBy ?? null
    : null;

  // Stop (PR 5A) — the shared action, same as GlobalAssistantView and SidebarChatTab.
  //
  // Replaces this surface's own resolveActiveAssistantMessageId + two-key chatId-map fallback.
  // `activeStream` already answers what resolveActiveAssistantMessageId reconstructed from
  // useChat's array — and answers it for bootstrapped and remote streams too, which the array
  // never knew about. The submitted window (no store entry) falls back to the send-time
  // conversationId rather than the chatId map, which was always EMPTY in exactly that window:
  // setActiveStreamId only ran once the response headers landed, 0.5-3s into a real send.
  const effectiveStop = useStopStream({
    activeStream,
    pendingSendConversationId,
    rawStop: chatStop,
    // The rawStop gate: a Stop on a socket-attached conversation must not abort another
    // conversation's live local fetch (conversation-scoped consuming, dual-stream fix).
    getLocalSendConversationId: getLatchedConversationId,
    targetConversationId: currentConversationId,
  });

  usePageSocketRoom(page.id);
  const { rejoinActiveStreams } = useChannelStreamSocket(page.id, {
    // These three fire only for a REMOTE tab's action (useChannelStreamSocket already
    // drops own-tab events via isOwnStream before invoking the callback) — the local
    // user's own edit/delete/send is handled separately (handleSendMessage's
    // addOptimisticSend; handleEdit/handleDelete above).
    //
    // Written to BOTH the store (render) AND useChat via setMessages (bookkeeping) —
    // same dual-write shape as loadMessagesForConversation's, not a NEW two-way sync
    // (rail 11): both writes are independent, terminal applications of the SAME
    // upstream event, not one container's state flowing into the other. Required
    // because `regenerate()` indexes useChat's OWN local array directly — otherwise a
    // retry right after a collaborator's edit on a shared conversation could
    // regenerate against stale history (PR review finding, independently confirmed by
    // three review passes). `useAnswerAskUser`'s own hydrate step (6.3) fully
    // overwrites this array from the cache immediately before every addToolResult
    // call, so it no longer depends on this dual-write staying fresh in between.
    onUserMessage: (message, payload) => {
      if (payload.conversationId !== currentConversationId || !currentConversationId) return;
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      conversationMessagesActions.applyRemoteUserMessage(currentConversationId, message);
    },
    onMessageEdited: (payload) => {
      if (payload.conversationId !== currentConversationId || !currentConversationId) return;
      const editPayload: MessageEditPayload = {
        messageId: payload.messageId,
        parts: payload.parts,
        editedAt: new Date(payload.editedAt),
      };
      setMessages((prev) => applyMessageEdit(prev, editPayload));
      conversationMessagesActions.applyEdit(currentConversationId, editPayload);
    },
    onMessageDeleted: (payload) => {
      if (payload.conversationId !== currentConversationId || !currentConversationId) return;
      setMessages((prev) => applyMessageDelete(prev, payload.messageId));
      conversationMessagesActions.applyDelete(currentConversationId, payload.messageId);
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
    onStreamComplete: (messageId, completedConvId, _info, aborted) => {
      // epic leaf 6.8 (D ixpwr76xepu2x9v4pxgksyhz): badge a crash-reaped or Stopped stream as
      // 'interrupted' the instant this tab hears about it, instead of only after the next
      // reload — the persisted row already carries this status; this just stops a live-open
      // tab from rendering stale.
      const terminalStatus = aborted ? 'interrupted' as const : 'complete' as const;
      const stream = getActiveStreamById(messageId);

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
        // COMMIT by id — do not skip. An existing entry with this id is NOT proof we
        // already have the content.
        //
        // The mirror (useOwnStreamMirror/planOwnStreamMirror) removes the stream from
        // usePendingStreamsStore the instant `status` leaves submitted/streaming — which
        // can race AHEAD of this handler for the own-tab case. If nothing commits the
        // final content into useConversationMessagesStore before that removal is
        // rendered, the reply flashes to missing (selectRenderedMessages has no
        // confirmed row AND no more active stream for this id). This write is what
        // closes that gap. Also covers cross-instance recovery: a mid-stream network
        // drop can leave the local copy half-streamed, and it's precisely then that
        // rejoin-recovery accumulates the FULL reply into `stream.parts` — the real text
        // must not stay stranded in the DB until the user navigates away and back.
        //
        // `applyConfirmedMessage` (upsert-by-id — REPLACES an existing entry, unlike
        // `applyRemoteUserMessage`'s no-op-if-present) is required here, not optional:
        // a DB reload mid-stream can have already seeded `messages` with a
        // 'streaming'-status placeholder/half-streamed row under this same id, and
        // the whole point of this branch is to overwrite that with the full content.
        //
        // Also replaces the entry in useChat (dual-write, same rationale as the socket
        // handlers above) — covers the cross-instance-recovery case, where the
        // recovered content never went through this tab's own useChat stream and would
        // otherwise leave regenerate()'s bookkeeping short of it.
        const synthesized = synthesizeAssistantMessage(messageId, stream.parts, stream.startedAt, terminalStatus);
        // The useChat dual-write is for OUR OWN stream only. `chat:stream_complete` carries no
        // own-stream filter, so on a shared conversation this handler also sees a COLLABORATOR's
        // stream completing in our conversation — and appending their message into our transport's
        // local array is both meaningless for the regenerate() bookkeeping this write exists for,
        // and actively harmful: useOwnStreamMirror reads that array to find its own live stream,
        // and a foreign message landing after ours makes it re-target onto a finished message —
        // an isOwn phantom whose Stop aborts nothing, silently, while our generation keeps
        // billing. Their message still renders: the cache write below is unconditional.
        if (stream.isOwn) {
          setMessages((prev) => {
            const i = prev.findIndex((m) => m.id === messageId);
            return i === -1 ? [...prev, synthesized] : prev.map((m, j) => (j === i ? synthesized : m));
          });
          // F1 (PR #2098 review): an OWN reply's commit proves the user rows that
          // triggered it are persisted — promote them into confirmed messages FIRST,
          // so the reply appends after them and the question can never render below
          // the answer (the selector orders confirmed before optimistic).
          conversationMessagesActions.promoteOptimisticSends(stream.conversationId);
        }
        if (currentConversationId) {
          conversationMessagesActions.applyConfirmedMessage(currentConversationId, synthesized);
          // F6: the socket broadcast can outrace the SSE multicast's final frames, so
          // the committed parts may be truncated. Background snapshot heal — no
          // loading-state flip, generation-safe, best-effort.
          void refreshConversationSnapshot(page.id, currentConversationId);
        }
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
            conversationMessagesActions.applyConfirmedMessage(
              persisted.id,
              synthesizeAssistantMessage(messageId, parts, startedAt, terminalStatus),
            );
          })
          .catch((err) => console.warn('[AiChatView] late-joiner sync failed', err));
      }
    },
  });
  // Late-binding for the pre-send handoff declared above the socket hook.
  rejoinActiveStreamsRef.current = rejoinActiveStreams;

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

  // Synchronous — the page this view is attached to IS the location; no
  // pathname parsing or fetch needed. The server resolves + permission-checks
  // this at request time (resolve-request-context.ts).
  const contextRef: ContextRef = useMemo(
    () => ({ routeType: 'page', pageId: page.id, driveId }),
    [page.id, driveId]
  );

  // Shared by every send-shaped request (typed send, voice send, AskUser resume) — one
  // definition means the body a resume POST carries can't drift from what a real send
  // would have sent (epic leaf 6.3: deletes the separate buildAskUserAnswerBody).
  const buildRequestBody = useCallback(() => ({
    chatId: page.id,
    conversationId: currentConversationId,
    selectedProvider,
    selectedModel,
    isReadOnly,
    webSearchEnabled,
    imageGenEnabled,
    mcpTools: mcpToolSchemas.length > 0 ? mcpToolSchemas : undefined,
    contextRef,
  }), [
    page.id,
    currentConversationId,
    selectedProvider,
    selectedModel,
    isReadOnly,
    webSearchEnabled,
    imageGenEnabled,
    mcpToolSchemas,
    contextRef,
  ]);

  // renderedMessages (selector output), not useChat's raw `messages`: "answerable" is
  // decided by whether the ask_user part sits on the conversation's LAST message, and a
  // remote edit/delete/message on this conversation updates the store but no longer
  // updates useChat's local array (leaf 4.3 — those socket handlers write only to the
  // store). isConversationBusy replaces status==='ready'.
  const askUserAnswering = useAnswerAskUser({
    conversationId: currentConversationId,
    renderedMessages,
    isConversationBusy: effectiveIsStreaming,
    setMessages,
    addToolResult,
    wrapSend,
    buildBody: buildRequestBody,
    // Answering re-invokes the chat — same cross-conversation handoff as every send path.
    prepareSend,
  });

  // A send creates the conversations row server-side under exactly this id, so the id
  // becomes real the moment the POST leaves. Flipping isPersisted re-runs the
  // load-on-select effect for the SAME id, but `lastHandledIdentityRef` (set when this
  // id was first adopted as unpersisted) recognizes it as the same identity, not a
  // switch — so it does not fetch a conversation whose first message may not be
  // written yet, over the optimistic user bubble and the in-flight stream.
  const adoptConversationAsPersisted = useCallback(() => {
    if (isPersistedRef.current) return;
    setPersisted(true);
  }, [setPersisted]);

  const handleSendMessage = useCallback(async () => {
    if (isReadOnly) {
      toast.error('You do not have permission to send messages in this AI chat');
      return;
    }
    const trimmed = input.trim();
    const files = getFilesForSend();
    if (!trimmed && files.length === 0) return;
    if (!canSendMessage) return;
    if (!currentConversationId) return;

    // The ids behind `files` — same processed filter getFilesForSend applies. Attachments are
    // cleared per-id AFTER the handoff confirms, so a refusal loses nothing and anything
    // attached DURING the wait (a different id) survives the clear.
    const sentAttachmentIds = attachments.filter((a) => !a.processing && a.dataUrl).map((a) => a.id);

    // Text clears immediately (typing during the wait must not merge into the old draft) and is
    // restored on refusal ONLY if the draft is still empty — newer keystrokes win.
    clearInputDraft();
    inputRef.current?.clear();

    // Hand off any in-flight stream this chat is consuming for ANOTHER conversation before
    // sending — the Chat cannot consume two bodies at once. No-op for same-conversation sends.
    // `false` means the handoff could not confirm (unmount, or the settle wait timed out with
    // the latch still held): sending would re-key the new stream under the old conversation.
    if (!(await prepareSend(currentConversationId))) {
      toast.error(HANDOFF_REFUSED_MESSAGE);
      if (inputDraftRef.current === '') setInput(trimmed);
      return;
    }
    for (const id of sentAttachmentIds) removeFile(id);

    adoptConversationAsPersisted();

    // Client-minted id, parts-form send (PR 3 board, Assumption B): the `{text, files}`
    // shorthand silently drops any id passed alongside it, so the message would push
    // under an SDK-generated id useConversationMessagesStore never saw. buildUserMessage
    // + the parts-form call is the only path that preserves the id end to end.
    // Written to the store immediately (mode: 'optimistic') because the sender's own
    // tab never receives its own chat:user_message broadcast back (own-tab dedup in
    // useChannelStreamSocket) — without this, the bubble would only ever appear once
    // useChat's own stream-start local push happened to line up, i.e. never for the
    // user message itself.
    // buildUserMessage's declared return type is the SDK's generic CreateUIMessage<UIMessage>
    // (id/role optional, since that type also covers server-constructed continuations), but
    // this call always supplies both — the cast reflects that fact, not a type escape hatch.
    const userMessage = buildUserMessage({
      id: createId(),
      text: trimmed.length > 0 ? trimmed : undefined,
      files: files.length > 0 ? files : undefined,
    }) as UIMessage;
    conversationMessagesActions.addOptimisticSend(currentConversationId, userMessage);

    rollbackOptimisticSendOnFailure(
      () => wrapSend(() => sendMessage(userMessage, { body: buildRequestBody() })),
      currentConversationId,
      userMessage.id,
    );
  }, [
    isReadOnly,
    input,
    // `attachments.length` was here and is redundant: getFilesForSend (below) is memoized on
    // [attachments], so it already changes whenever they do. ESLint flagged it once the rule was
    // promoted to an error for these files — which is the rule doing exactly its job.
    currentConversationId,
    canSendMessage,
    getFilesForSend,
    clearInputDraft,
    setInput,
    attachments,
    removeFile,
    sendMessage,
    buildRequestBody,
    wrapSend,
    adoptConversationAsPersisted,
    prepareSend,
  ]);

  // Voice mode: Send message from voice transcript
  const handleVoiceSend = useCallback(async (text: string) => {
    if (isReadOnly) {
      toast.error('You do not have permission to send messages in this AI chat');
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!canSendMessage) return;
    if (!currentConversationId) return;

    // Same cross-conversation handoff as handleSendMessage; abort on an unconfirmed handoff —
    // with feedback, or the transcript would vanish silently.
    if (!(await prepareSend(currentConversationId))) {
      toast.error(HANDOFF_REFUSED_MESSAGE);
      return;
    }

    adoptConversationAsPersisted();
    const userMessage = buildUserMessage({ id: createId(), text: trimmed }) as UIMessage;
    conversationMessagesActions.addOptimisticSend(currentConversationId, userMessage);

    rollbackOptimisticSendOnFailure(
      () => wrapSend(() => sendMessage(userMessage, { body: buildRequestBody() })),
      currentConversationId,
      userMessage.id,
    );
  }, [
    isReadOnly,
    currentConversationId,
    canSendMessage,
    sendMessage,
    buildRequestBody,
    wrapSend,
    adoptConversationAsPersisted,
    prepareSend,
  ]);

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

  const handleUndoSuccess = useCallback(async () => {
    if (!currentConversationId) return;
    await loadMessagesForConversation(currentConversationId);
  }, [currentConversationId, loadMessagesForConversation]);

  // Pull-up refresh handler for mobile - check for missed messages
  const handlePullUpRefresh = useCallback(async () => {
    if (!currentConversationId) return;
    await loadMessagesForConversation(currentConversationId);
  }, [currentConversationId, loadMessagesForConversation]);

  // Gate on USER editing only, evaluated at fire time (callback form). The old gate was
  // `!isEditingActive()`, i.e. isAnyActive(), which is true whenever an 'ai-streaming' session
  // exists — and this component registers one while streaming. So the hook early-returned in
  // exactly the case it was written for. Worse, a boolean captured at render is stale on iOS,
  // which freezes JS while backgrounded — the captured value was always the streaming one.
  const resumeEnabled = useCallback(
    () => canResumeRecovery(currentConversationIdRef.current, useEditingStore.getState().isAnyEditing()),
    [],
  );

  // App-resume = the same path as mount/socket-reconnect (epic leaf 6.2): re-bootstrap active
  // streams, reload the conversation into the cache, and settle a frozen local transport.
  // Nothing renders from the local fetch under store-first rendering, so there is no
  // native/web or was-i-streaming choreography left to make — this subsumes
  // resolveResumeAction (deleted) and #2065.
  useResumeBootstrap({
    rejoin: rejoinActiveStreams,
    reload: handlePullUpRefresh,
    stop: chatStop,
    isOwnStreamLive: useCallback(() => effectiveIsStreamingRef.current, []),
    enabled: resumeEnabled,
  });

  // NO activeStreams cleanup (PR 5A, leaf 5.5.8): the client chatId->streamId map is deleted.
  // Aborts name the stream by messageId (from the store) or by the send-time conversationId —
  // neither needs a map, so neither needs a cleanup to keep one honest.

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
    <div data-testid="ai-chat-view" className="flex flex-col h-full">
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

            <div className="flex items-center gap-3">
              {/* Chat tab actions */}
              {activeTab === 'chat' && (
                <>
                  {displayPreferences.showTokenCounts && (
                    <AiUsageMonitor pageId={page.id} compact />
                  )}

                  <TasksDropdown messages={plainMessages} driveId={driveId} />

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
                </>
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

              {/* Deliberately not permission-gated: the dialog itself explains the
                  owner/admin requirement, so the feature stays discoverable. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setWebhooksOpen(true)}
                title="Incoming Webhooks"
                aria-label="Incoming Webhooks"
                className="px-2 text-muted-foreground hover:text-foreground"
              >
                <Webhook className="h-4 w-4" />
              </Button>
            </div>
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
            conversationId={currentConversationId}
            messages={plainMessages}
            input={input}
            onInputChange={setInput}
            onSend={handleSendMessage}
            onStop={effectiveStop}
            isStreaming={effectiveIsStreaming}
            isLoading={isLoading}
            disabled={!isAnyProviderConfigured || !canSendMessage}
            placeholder={isReadOnly ? 'View only - cannot send messages' : 'Message AI...'}
            driveId={driveId}
            cause={errorCause}
            showError={showError}
            onClearError={() => {
              setShowError(false);
              dismissError();
            }}
            onScrollNearTop={handleScrollNearTop}
            isLoadingOlder={isLoadingOlder}
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
                  onReadAloudClick={handleReadAloudClick}
                  isReadingAloud={isReadingAloud}
                  canReadAloud={canReadAloud}
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

      <PageWebhooksDialog
        open={webhooksOpen}
        onOpenChange={setWebhooksOpen}
        pageId={page.id}
        pageType={page.type}
      />
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
