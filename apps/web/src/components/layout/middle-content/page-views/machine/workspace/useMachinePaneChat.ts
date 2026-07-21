/**
 * useMachinePaneChat — the machine pane's dual-mode chat state (Phase 11, #2166).
 *
 * The third selector surface (after SidebarChatTab and GlobalAssistantView's
 * dashboard): null selection = the assistant identity on the MACHINE-ANCHORED
 * conversation — the terminal row's pre-created conversation (Phase 4), with
 * `chatId = machineId` so the chat route derives the machine-pane binding
 * (Phase 6) and sandbox tools run against this pane's checkout (Phase 7).
 * Any page agent = that agent's own chat, exactly as the sidebar runs it —
 * the machine binding does not apply (the route derives null for it).
 *
 * Identity model:
 * - Surface ids are stable per pane: `machine-pane:${terminalId}` (default) /
 *   `machine-pane-agent:${terminalId}` (agent mode) — one Chat instance per
 *   mode for the pane's lifetime, so a mode switch swaps WHICH instance is on
 *   screen instead of recreating either (no cross-mode bleed; see
 *   useDualModeChat).
 * - The default conversation starts as (and returns to) the terminal row id.
 *   Returning to null selection RESUMES it — nothing here ever mints a new
 *   session row for the machine; only an explicit "new conversation" in
 *   History creates a machine-page conversation.
 * - Both modes are agent-style surfaces: conversations live on a PAGE (the
 *   machine page or the agent's page), so loaders, history and message
 *   actions all key on `channelId` = machineId | agent.id.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { UIMessage } from 'ai';
import { toast } from 'sonner';
import { createId } from '@paralleldrive/cuid2';
import type { AgentInfo } from '@/types/agent';
import { useDualModeChat } from '@/hooks/useDualModeChat';
import {
  useChatTransport,
  useConversations,
  useCacheMessageActions,
  useSendHandoff,
  useConversationSendHandoff,
  HANDOFF_REFUSED_MESSAGE,
  useChatErrorCause,
  buildChatConfig,
  fetchMostRecentAgentConversation,
  createAgentConversation,
  type ConversationData,
  type AIErrorCause,
} from '@/lib/ai/shared';
import { buildContextRef, type ContextRef } from '@/lib/ai/shared/buildContextRef';
import { buildUserMessage } from '@/lib/ai/streams/buildUserMessage';
import { rollbackOptimisticSendOnFailure } from '@/lib/ai/streams/rollbackOptimisticSendOnFailure';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import {
  loadAgentConversationMessages,
  loadOlderAgentConversationMessages,
} from '@/hooks/conversationMessagesLoaders';
import {
  useRenderedMessages,
  useConversationLoadState,
  useConversationOlderPageState,
} from '@/hooks/useRenderedMessages';
import { useAgentChannelMultiplayer } from '@/hooks/useAgentChannelMultiplayer';
import { useActiveStream, useConversationActiveStream } from '@/hooks/useActiveStream';
import { useOwnStreamMirror } from '@/hooks/useOwnStreamMirror';
import { useStopStream } from '@/hooks/useStopStream';
import { useAuth } from '@/hooks/useAuth';
import { useDriveStore } from '@/hooks/useDrive';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import type { PendingStream } from '@/stores/usePendingStreamsStore';

export interface UseMachinePaneChatOptions {
  /** The machine page hosting this pane — the default mode's chatId + channel. */
  machineId: string;
  /** The terminal row id — the machine-anchored conversation's id (Phase 4). */
  terminalId: string;
  /** The picker's starting prompt — auto-sent once into a fresh empty default
   *  conversation, never into a resumed one. */
  pendingPrompt?: string;
  /** Consumed-notification for pendingPrompt (clears the pane's one-shot intent). */
  onPromptSent?: () => void;
  /** Whether the conversation list should be fetched (e.g. only on relevant tabs). */
  historyEnabled?: boolean;
}

export interface UseMachinePaneChatReturn {
  /** null = default (machine) mode. */
  selectedAgent: AgentInfo | null;
  selectAgent: (agent: AgentInfo | null) => void;
  /** The active mode's conversation. Default mode starts at (and resumes to) the terminal row id. */
  currentConversationId: string | null;
  /** The active mode's page channel: machineId or the agent's page id. */
  channelId: string;
  /** Rendered messages for the conversation on screen (shared cache + live streams). */
  messages: UIMessage[];
  /** Remote in-progress streams to render inline below the messages. */
  remoteStreams: PendingStream[];
  displayIsStreaming: boolean;
  isMessagesLoading: boolean;
  hasLoadError: boolean;
  reloadConversation: () => Promise<void>;
  /** Send a user message under the active mode's ids. Resolves false when
   *  nothing was dispatched (empty text, no conversation, refused handoff) so
   *  the composer can restore its draft. */
  handleSend: (text: string) => Promise<boolean>;
  handleStop: () => Promise<void>;
  /** Store-first message actions (settled rows only). */
  handleEdit: (messageId: string, newContent: string) => Promise<void>;
  handleDelete: (messageId: string) => Promise<void>;
  handleRetry: () => Promise<void>;
  lastAssistantMessageId: string | undefined;
  lastUserMessageId: string | undefined;
  /** "Load older" wiring (scroll-near-top). */
  handleScrollNearTop: () => void;
  isLoadingOlder: boolean;
  hasMoreOlder: boolean;
  /** Per-mode history (machine-page conversations in default mode; the agent's in agent mode). */
  conversations: ConversationData[];
  isLoadingConversations: boolean;
  openConversation: (conversationId: string) => Promise<void>;
  createNewConversation: () => Promise<string | null>;
  deleteConversation: (conversationId: string) => Promise<void>;
  errorCause: AIErrorCause | null;
  dismissError: () => void;
}

export function useMachinePaneChat({
  machineId,
  terminalId,
  pendingPrompt,
  onPromptSent,
  historyEnabled = true,
}: UseMachinePaneChatOptions): UseMachinePaneChatReturn {
  const pathname = usePathname();
  const { user } = useAuth();
  const drives = useDriveStore((state) => state.drives);

  // ============================================
  // Mode + per-mode conversation identity
  // ============================================
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  // Starts as — and on return-to-null still is — the terminal row's
  // conversation. Only History (open/new/delete) moves it.
  const [defaultConversationId, setDefaultConversationId] = useState<string>(terminalId);
  const [agentConversationId, setAgentConversationId] = useState<string | null>(null);

  const channelId = selectedAgent ? selectedAgent.id : machineId;
  const currentConversationId = selectedAgent ? agentConversationId : defaultConversationId;

  // Ref-read rather than a functional-updater compare: clearing the agent
  // conversation is a second state write, and state updaters must stay pure.
  const selectedAgentRef = useRef(selectedAgent);
  selectedAgentRef.current = selectedAgent;
  const selectAgent = useCallback((agent: AgentInfo | null) => {
    if (agent?.id !== selectedAgentRef.current?.id) {
      // A genuinely new subject — the resolve effect below re-resolves it.
      // The DEFAULT identity is deliberately untouched: returning to null
      // resumes the machine conversation as-is, it never mints a new row.
      setAgentConversationId(null);
    }
    setSelectedAgent(agent);
  }, []);

  // A pane re-bound to a different terminal row is a different chat surface.
  // Phase 10 keys the mount by session, but the hook defends its own
  // invariant: the default identity and the pendingPrompt latch belong to
  // the terminal row, not the mount.
  const boundTerminalIdRef = useRef(terminalId);
  const pendingPromptSentRef = useRef(false);
  useEffect(() => {
    if (boundTerminalIdRef.current === terminalId) return;
    boundTerminalIdRef.current = terminalId;
    pendingPromptSentRef.current = false;
    setDefaultConversationId(terminalId);
  }, [terminalId]);

  // Resolve the selected agent's conversation: most recent, or a client-minted
  // new one (same shape as usePageAgentSidebarState, pane-local instead of the
  // sidebar's shared store — each pane owns its selection).
  const resolvingAgentIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedAgent) {
      resolvingAgentIdRef.current = null;
      return;
    }
    const agentId = selectedAgent.id;
    resolvingAgentIdRef.current = agentId;

    const resolve = async () => {
      try {
        const mostRecent = await fetchMostRecentAgentConversation(agentId);
        if (resolvingAgentIdRef.current !== agentId) return;
        if (mostRecent) {
          setAgentConversationId(mostRecent.id);
          await loadAgentConversationMessages(agentId, mostRecent.id);
          return;
        }
      } catch (error) {
        if (resolvingAgentIdRef.current !== agentId) return;
        console.error('Failed to load recent agent conversation:', error);
      }
      if (resolvingAgentIdRef.current !== agentId) return;

      const newConversationId = createId();
      setAgentConversationId(newConversationId);
      conversationMessagesActions.seedConversation(newConversationId);
      try {
        await createAgentConversation(agentId, newConversationId);
      } catch (error) {
        if (resolvingAgentIdRef.current !== agentId) return;
        console.error('Failed to create agent conversation:', error);
        toast.error('Failed to initialize agent conversation');
      }
    };
    void resolve();
  }, [selectedAgent]);

  // Load the default (machine) conversation into the shared cache. The
  // loader's generation gate makes re-runs safe.
  useEffect(() => {
    void loadAgentConversationMessages(machineId, defaultConversationId);
  }, [machineId, defaultConversationId]);

  // ============================================
  // Chat instances — one per mode, stable surface ids per pane
  // ============================================
  const defaultTransport = useChatTransport(defaultConversationId, '/api/ai/chat', machineId);
  const defaultChatConfig = useMemo(() => {
    if (!defaultTransport) return null;
    return buildChatConfig({
      id: `machine-pane:${terminalId}`,
      transport: defaultTransport,
      onError: (error: Error) => {
        console.error('Machine pane chat error:', error);
        toast.error('Chat error. Please try again.');
      },
    });
  }, [defaultTransport, terminalId]);

  const agentTransport = useChatTransport(
    agentConversationId,
    '/api/ai/chat',
    selectedAgent?.id ?? null,
  );
  const agentChatConfig = useMemo(() => {
    if (!selectedAgent || !agentConversationId || !agentTransport) return null;
    return buildChatConfig({
      id: `machine-pane-agent:${terminalId}`,
      transport: agentTransport,
      onError: (error: Error) => {
        console.error('Machine pane agent chat error:', error);
        toast.error('Chat error. Please try again.');
      },
    });
  }, [selectedAgent, agentConversationId, agentTransport, terminalId]);

  const {
    sendMessage,
    status,
    error,
    clearError,
    regenerate,
    setMessages,
    stop,
    isStreaming,
    globalStatus: defaultStatus,
    globalStop: defaultStop,
    globalMessages: defaultMessages,
    agentStatus,
    agentMessages,
    agentStop,
  } = useDualModeChat({
    selectedAgent,
    globalChatConfig: defaultChatConfig,
    agentChatConfig,
  });

  // ============================================
  // Multiplayer — both page channels are agent-style
  // ============================================
  // The machine channel stays wired in agent mode too: remote streams landing
  // on the machine conversation keep committing to the shared cache, so a
  // return to null shows them without a refetch (cache writes are idempotent).
  const machineChannel = useMemo(() => ({ id: machineId }), [machineId]);
  const loadDefaultConversation = useCallback(
    (conversationId: string) => loadAgentConversationMessages(machineId, conversationId),
    [machineId],
  );
  const { rejoinActiveStreams: rejoinDefaultStream } = useAgentChannelMultiplayer({
    selectedAgent: machineChannel,
    agentConversationId: defaultConversationId,
    loadConversation: loadDefaultConversation,
  });

  const loadSelectedAgentConversation = useCallback(
    (conversationId: string) => {
      const agentId = selectedAgent?.id;
      if (agentId) return loadAgentConversationMessages(agentId, conversationId);
    },
    [selectedAgent?.id],
  );
  const { rejoinActiveStreams: rejoinAgentStream } = useAgentChannelMultiplayer({
    selectedAgent,
    agentConversationId,
    loadConversation: loadSelectedAgentConversation,
  });

  // ============================================
  // Store-first rendering
  // ============================================
  const renderedMessages = useRenderedMessages(channelId, currentConversationId);
  const messages = useMemo(() => renderedMessages.map((r) => r.message), [renderedMessages]);
  const loadState = useConversationLoadState(currentConversationId);

  const activeStream = useConversationActiveStream(channelId, currentConversationId);
  const { streams: remoteStreams } = useActiveStream(channelId, currentConversationId);

  const { wrapSend, pendingSendConversationId } = useSendHandoff(
    currentConversationId,
    status,
    activeStream?.isOwn === true,
  );

  const displayIsStreaming =
    activeStream?.isOwn === true ||
    (pendingSendConversationId !== null && pendingSendConversationId === currentConversationId);

  // Own-stream mirrors, MOUNTED PER CHAT (see useDualModeChat's interface
  // docblock — a mode-selected mirror silently repoints on switch and deletes
  // the live stream's store entry).
  const mirrorTriggeredBy = useMemo(
    () => ({ userId: user?.id ?? '', displayName: user?.name || user?.email || 'You' }),
    [user?.id, user?.name, user?.email],
  );
  const { getLatchedConversationId: getDefaultLatched } = useOwnStreamMirror({
    status: defaultStatus,
    ownMessages: defaultMessages,
    pageId: machineId,
    conversationId: defaultConversationId,
    triggeredBy: mirrorTriggeredBy,
  });
  const { getLatchedConversationId: getAgentLatched } = useOwnStreamMirror({
    status: agentStatus,
    ownMessages: agentMessages,
    pageId: selectedAgent?.id ?? '',
    conversationId: agentConversationId ?? '',
    triggeredBy: mirrorTriggeredBy,
  });

  // Pre-send handoff, per chat like the mirrors (see useConversationSendHandoff).
  const { prepareSend: prepareDefaultSend } = useConversationSendHandoff({
    status: defaultStatus,
    stop: defaultStop,
    getLatchedConversationId: getDefaultLatched,
    rejoin: rejoinDefaultStream,
  });
  const { prepareSend: prepareAgentSend } = useConversationSendHandoff({
    status: agentStatus,
    stop: agentStop,
    getLatchedConversationId: getAgentLatched,
    rejoin: rejoinAgentStream,
  });
  const prepareSendForMode = selectedAgent ? prepareAgentSend : prepareDefaultSend;

  // ============================================
  // Send
  // ============================================
  const writeMode = useAssistantSettingsStore((state) => state.writeMode);
  const webSearchEnabled = useAssistantSettingsStore((state) => state.webSearchEnabled);
  const imageGenEnabled = useAssistantSettingsStore((state) => state.imageGenEnabled);
  const currentProvider = useAssistantSettingsStore((state) => state.currentProvider);
  const currentModel = useAssistantSettingsStore((state) => state.currentModel);

  const buildPaneChatRequestBody = useCallback(
    (contextRef: ContextRef, isReadOnly: boolean) => {
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
        : {
            // The machine-pane binding contract (Phase 6): the machine page as
            // chatId, the terminal-row conversation as conversationId.
            chatId: machineId,
            conversationId: defaultConversationId,
            isReadOnly,
            webSearchEnabled,
            imageGenEnabled,
            provider: currentProvider,
            model: currentModel,
            contextRef,
          };
    },
    [
      selectedAgent,
      agentConversationId,
      machineId,
      defaultConversationId,
      webSearchEnabled,
      imageGenEnabled,
      currentProvider,
      currentModel,
    ],
  );

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !currentConversationId) return false;

      const contextRef = buildContextRef(pathname, drives);
      // Hand off any in-flight stream this chat is consuming for ANOTHER
      // conversation before sending (the Chat cannot consume two bodies at once).
      if (!(await prepareSendForMode(currentConversationId))) {
        toast.error(HANDOFF_REFUSED_MESSAGE);
        return false;
      }

      // Client-minted id, parts-form send; optimistic cache write so the
      // bubble appears the same tick (the sender never gets its own broadcast).
      const userMessage = buildUserMessage({ id: createId(), text: trimmed }) as UIMessage;
      conversationMessagesActions.addOptimisticSend(currentConversationId, userMessage);

      rollbackOptimisticSendOnFailure(
        () =>
          wrapSend(() =>
            sendMessage(userMessage, { body: buildPaneChatRequestBody(contextRef, !writeMode) }),
          ),
        currentConversationId,
        userMessage.id,
      );
      return true;
    },
    [
      currentConversationId,
      pathname,
      drives,
      prepareSendForMode,
      wrapSend,
      sendMessage,
      buildPaneChatRequestBody,
      writeMode,
    ],
  );

  // ============================================
  // pendingPrompt — exactly once, fresh empty default conversation only
  // ============================================
  useEffect(() => {
    if (pendingPromptSentRef.current) return;
    if (!pendingPrompt) return;
    if (selectedAgent) return;
    // Only the terminal row's own conversation — a history-opened machine
    // conversation is by definition not the fresh spawn target.
    if (defaultConversationId !== terminalId) return;
    // Not before the cache answers: an unloaded conversation might be a
    // resumed one whose history simply hasn't arrived yet.
    if (loadState.status !== 'loaded') return;
    // A resumed session has messages — never auto-send into it.
    if (renderedMessages.length > 0) return;

    pendingPromptSentRef.current = true;
    void handleSend(pendingPrompt).then(() => onPromptSent?.());
  }, [
    pendingPrompt,
    selectedAgent,
    defaultConversationId,
    terminalId,
    loadState.status,
    renderedMessages.length,
    handleSend,
    onPromptSent,
  ]);

  // ============================================
  // Stop + message actions
  // ============================================
  const handleStop = useStopStream({
    activeStream,
    pendingSendConversationId,
    rawStop: stop,
    getLocalSendConversationId: selectedAgent ? getAgentLatched : getDefaultLatched,
    targetConversationId: currentConversationId,
  });

  const isOwnSendLive = isStreaming || activeStream?.isOwn === true;
  const isOwnSendLiveRef = useRef(isOwnSendLive);
  isOwnSendLiveRef.current = isOwnSendLive;
  const getIsOwnSendLive = useCallback(() => isOwnSendLiveRef.current, []);

  const { handleEdit, handleDelete, handleRetry } = useCacheMessageActions({
    // Both modes are agent-style (page-hosted conversations) — the machine
    // page id serves as the "agent" for the default mode's endpoints.
    agentId: channelId,
    conversationId: currentConversationId,
    renderedMessages,
    isOwnSendLive,
    setMessages,
    regenerate,
    prepareSend: prepareSendForMode,
    getIsOwnSendLive,
  });

  const lastAssistantMessageId = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'assistant')?.id,
    [messages],
  );
  const lastUserMessageId = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'user')?.id,
    [messages],
  );

  const reloadConversation = useCallback(async () => {
    if (!currentConversationId) return;
    await loadAgentConversationMessages(channelId, currentConversationId);
  }, [channelId, currentConversationId]);

  const { isLoadingOlder, hasMoreOlder } = useConversationOlderPageState(currentConversationId);
  const handleScrollNearTop = useCallback(() => {
    if (!currentConversationId) return;
    void loadOlderAgentConversationMessages(channelId, currentConversationId);
  }, [channelId, currentConversationId]);

  // ============================================
  // History — per-mode conversations (page-agents endpoints for both modes)
  // ============================================
  const adoptConversation = useCallback(
    (conversationId: string) => {
      if (selectedAgent) {
        setAgentConversationId(conversationId);
      } else {
        setDefaultConversationId(conversationId);
      }
    },
    [selectedAgent],
  );

  const {
    conversations,
    isLoading: isLoadingConversations,
    createConversation,
    deleteConversation: deleteConversationBase,
  } = useConversations({
    agentId: channelId,
    currentConversationId,
    enabled: historyEnabled,
    onConversationCreate: (conversationId) => {
      conversationMessagesActions.seedConversation(conversationId);
      adoptConversation(conversationId);
    },
    onConversationDelete: () => {
      if (selectedAgent) {
        // Same shape as create: a fresh client-minted id, seeded empty;
        // persisted lazily by the first message save.
        const nextId = createId();
        conversationMessagesActions.seedConversation(nextId);
        setAgentConversationId(nextId);
      } else {
        // Deleting the machine conversation on screen falls back to the
        // terminal row's own conversation — resume, never mint.
        setDefaultConversationId(terminalId);
      }
    },
  });

  const openConversation = useCallback(
    async (conversationId: string) => {
      adoptConversation(conversationId);
      await loadAgentConversationMessages(channelId, conversationId);
    },
    [adoptConversation, channelId],
  );

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      // The machine-anchored session conversation IS the pane's identity —
      // deleting it out from under the live terminal row would leave the
      // default mode pointing at a dead id. Not deletable from this surface.
      if (conversationId === terminalId) {
        toast.error('The machine session conversation cannot be deleted from this pane');
        return;
      }
      await deleteConversationBase(conversationId);
    },
    [terminalId, deleteConversationBase],
  );

  // ============================================
  // Error surface
  // ============================================
  const { cause: errorCause, dismiss: dismissError } = useChatErrorCause(
    currentConversationId,
    error,
    clearError,
    pendingSendConversationId ?? currentConversationId,
  );

  return {
    selectedAgent,
    selectAgent,
    currentConversationId,
    channelId,
    messages,
    remoteStreams,
    displayIsStreaming,
    isMessagesLoading: loadState.isLoading,
    hasLoadError: loadState.hasError,
    reloadConversation,
    handleSend,
    handleStop,
    handleEdit,
    handleDelete,
    handleRetry,
    lastAssistantMessageId,
    lastUserMessageId,
    handleScrollNearTop,
    isLoadingOlder,
    hasMoreOlder,
    conversations,
    isLoadingConversations,
    openConversation,
    createNewConversation: createConversation,
    deleteConversation,
    errorCause,
    dismissError,
  };
}
