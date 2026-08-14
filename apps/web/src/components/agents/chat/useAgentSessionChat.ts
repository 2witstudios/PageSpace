'use client';

/**
 * useAgentSessionChat — the ONE chat's state for an agent session.
 *
 * Derived from the machine pane's `useMachinePaneChat` with the dual-mode
 * selector, `AISelector` and `pendingPrompt` machinery stripped: a session
 * chat surface is never dual-mode — the agent is fixed by props, and the
 * conversation being chatted in is fixed by props too (its SESSION, and
 * therefore its sandbox, resolves server-side from the row's binding).
 * History is a separate concern owned by whoever renders the conversation
 * picker — this hook is purely
 * send/stream/edit/delete/retry/error for the one conversation it was mounted
 * for.
 *
 * 'ai-streaming' editing-store protection is NOT registered here: it comes
 * for free from `useSendHandoff`'s pendingSend bookkeeping plus the app-wide
 * `DerivedStreamingRegistrations` (mounted once by `GlobalChatProvider`),
 * which derives a registration for ANY conversation with a pending send or a
 * live stream entry — see that module for why a per-surface registration
 * would only risk two owners disagreeing about when to end it.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePathname } from 'next/navigation';
import type { UIMessage } from 'ai';
import { toast } from 'sonner';
import { createId } from '@paralleldrive/cuid2';
import type { AgentInfo } from '@/types/agent';
import {
  useChatSession,
  useCacheMessageActions,
  useSendHandoff,
  useChatErrorCause,
  useAnswerAskUser,
  type AIErrorCause,
} from '@/lib/ai/shared';
import type { UseAnswerAskUserResult } from '@/lib/ai/shared/hooks/useAnswerAskUser';
import { buildContextRef } from '@/lib/ai/shared/buildContextRef';
import { buildSessionChatRequestBody } from '@/lib/agents/build-session-chat-request';
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
import { useStopStream } from '@/hooks/useStopStream';
import { useAuth } from '@/hooks/useAuth';
import { useDriveStore } from '@/hooks/useDrive';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import type { PendingStream } from '@/stores/usePendingStreamsStore';

export interface UseAgentSessionChatOptions {
  /** The fixed agent this session belongs to — never selectable here. */
  agent: AgentInfo;
  /** ≡ the sessionId. Fixed for the life of this hook's mount (the caller keys its mount by it). */
  conversationId: string;
}

export interface UseAgentSessionChatReturn {
  messages: UIMessage[];
  remoteStreams: PendingStream[];
  displayIsStreaming: boolean;
  isMessagesLoading: boolean;
  hasLoadError: boolean;
  reloadConversation: () => Promise<void>;
  /** Resolves false when nothing was dispatched (empty text, refused handoff) — the composer restores its draft. */
  handleSend: (text: string) => Promise<boolean>;
  handleStop: () => Promise<void>;
  handleEdit: (messageId: string, newContent: string) => Promise<void>;
  handleDelete: (messageId: string) => Promise<void>;
  handleRetry: () => Promise<void>;
  lastAssistantMessageId: string | undefined;
  lastUserMessageId: string | undefined;
  handleScrollNearTop: () => void;
  isLoadingOlder: boolean;
  hasMoreOlder: boolean;
  errorCause: AIErrorCause | null;
  dismissError: () => void;
  askUserAnswering: UseAnswerAskUserResult;
}

export function useAgentSessionChat({
  agent,
  conversationId,
}: UseAgentSessionChatOptions): UseAgentSessionChatReturn {
  const pathname = usePathname();
  const { user } = useAuth();
  const drives = useDriveStore((state) => state.drives);

  useEffect(() => {
    void loadAgentConversationMessages(agent.id, conversationId);
  }, [agent.id, conversationId]);

  // `userId` is what `isOwnStream` compares, so the optimistic store entry this send opens is
  // recognised as the user's own in every tab and on every device — not just this one.
  const sendIdentity = useMemo(
    () => ({ userId: user?.id ?? '', displayName: user?.name || user?.email || 'You' }),
    [user?.id, user?.name, user?.email],
  );

  // ONE OWNED SEND SHELL, no `Chat` instance and no transport object.
  //
  // `getBaseMessages` is the settled store view — which is why answering an `ask_user`
  // question still works after a reload: the persisted assistant message carrying the
  // question IS the base, so there is no empty internal array to hydrate first.
  const stableMessagesRef = useRef<UIMessage[]>([]);
  const getBaseMessages = useCallback(() => stableMessagesRef.current, []);

  const {
    sendMessage,
    status,
    error,
    clearError,
    regenerate,
    addToolResult,
  } = useChatSession({
    api: '/api/ai/chat',
    channelId: agent.id,
    conversationId,
    triggeredBy: sendIdentity,
    getBaseMessages,
    onError: (err: Error) => {
      console.error('Agent session chat error:', err);
      toast.error('Chat error. Please try again.');
    },
  });

  const loadConversation = useCallback(
    (id: string) => loadAgentConversationMessages(agent.id, id),
    [agent.id],
  );
  const { rejoinActiveStreams } = useAgentChannelMultiplayer({
    selectedAgent: agent,
    agentConversationId: conversationId,
    loadConversation,
  });

  const renderedMessages = useRenderedMessages(agent.id, conversationId);
  const messages = useMemo(() => renderedMessages.map((r) => r.message), [renderedMessages]);
  // The SETTLED view — live synth rows excluded. This is what the send shell composes its
  // outbound messages from, and what every action reasons over.
  const stableMessages = useMemo(
    () => renderedMessages.filter((r) => r.mode !== 'streaming').map((r) => r.message),
    [renderedMessages],
  );
  stableMessagesRef.current = stableMessages;
  const loadState = useConversationLoadState(conversationId);

  const activeStream = useConversationActiveStream(agent.id, conversationId);
  const { streams: remoteStreams } = useActiveStream(agent.id, conversationId);

  const { wrapSend, pendingSendConversationId } = useSendHandoff(
    conversationId,
    status,
    activeStream?.isOwn === true,
  );

  const displayIsStreaming =
    activeStream?.isOwn === true ||
    (pendingSendConversationId !== null && pendingSendConversationId === conversationId);

  const webSearchEnabled = useAssistantSettingsStore((state) => state.webSearchEnabled);
  const imageGenEnabled = useAssistantSettingsStore((state) => state.imageGenEnabled);
  const writeMode = useAssistantSettingsStore((state) => state.writeMode);

  // Shared by handleSend and the ask_user answer path (submitting an answer
  // re-invokes the chat with the same per-request body a fresh send would use).
  const buildBody = useCallback(
    () =>
      buildSessionChatRequestBody({
        agentId: agent.id,
        conversationId,
        isReadOnly: !writeMode,
        webSearchEnabled,
        imageGenEnabled,
        provider: agent.aiProvider,
        model: agent.aiModel,
        systemPrompt: agent.systemPrompt,
        enabledTools: agent.enabledTools,
        contextRef: buildContextRef(pathname, drives),
      }),
    [
      agent.id,
      agent.aiProvider,
      agent.aiModel,
      agent.systemPrompt,
      agent.enabledTools,
      conversationId,
      writeMode,
      webSearchEnabled,
      imageGenEnabled,
      pathname,
      drives,
    ],
  );

  // renderedMessages (selector output), not useChat's raw `messages`: "answerable" is
  // decided by whether the ask_user part sits on the conversation's LAST message, and
  // remote edits/deletes/messages update the store, not useChat's local array.
  // isConversationBusy replaces status==='ready' — see selectAnswerableAskUserToolCallIds.
  //
  // Deliberately NOT displayIsStreaming (own-stream-only, what Stop is scoped to): a
  // REMOTE collaborator's stream leaves displayIsStreaming false while renderedMessages
  // filters out their in-flight message, so the conversation's last SETTLED message can
  // still be a stale ask_user prompt from before their run started. Submitting it would
  // invoke addToolResult, whose server-side per-conversation takeover aborts their
  // generation and resumes the stale prompt (Codex review, PR #2303).
  const isConversationBusyForAskUser = displayIsStreaming || remoteStreams.some((s) => !s.isOwn);
  const askUserAnswering = useAnswerAskUser({
    conversationId,
    renderedMessages,
    isConversationBusy: isConversationBusyForAskUser,
    addToolResult,
    wrapSend,
    buildBody,
  });

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !conversationId) return false;

      // NO PRE-SEND HANDOFF. There is nothing to hand off: this send is its own `fetch`, so a
      // generation already running in another conversation is simply not this send's concern.
      // The `stop()` + settle-wait + possible refusal that stood here is the thing this
      // workstream exists to delete.
      const userMessage = buildUserMessage({ id: createId(), text: trimmed }) as UIMessage;
      conversationMessagesActions.addOptimisticSend(conversationId, userMessage);

      rollbackOptimisticSendOnFailure(
        () => wrapSend(() => sendMessage(userMessage, conversationId, { body: buildBody() })),
        conversationId,
        userMessage.id,
      );
      return true;
    },
    [conversationId, wrapSend, sendMessage, buildBody],
  );

  const handleStop = useStopStream({
    activeStream,
    pendingSendConversationId,
  });

  // No raw chat status in this any more: `displayIsStreaming` already ORs the pending send
  // with the own store entry, which covers the submitted window AND every stream the old
  // status could not see (bootstrapped, remote, cross-instance).
  const isOwnSendLive = displayIsStreaming;
  const isOwnSendLiveRef = useRef(isOwnSendLive);
  isOwnSendLiveRef.current = isOwnSendLive;
  const getIsOwnSendLive = useCallback(() => isOwnSendLiveRef.current, []);

  const { handleEdit, handleDelete, handleRetry } = useCacheMessageActions({
    agentId: agent.id,
    conversationId,
    renderedMessages,
    isOwnSendLive,
    // Adapts the shell's explicit-conversation `regenerate` to the action hook's
    // conversation-less one. The id is bound HERE, where it is unambiguous, rather than being
    // inferred inside a shared `Chat` from whatever the surface last touched — which is how a
    // Retry used to be able to re-send another conversation's trail.
    regenerate: (opts?: { body?: Record<string, unknown> }) => {
      void regenerate(conversationId, opts);
    },
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
    await loadAgentConversationMessages(agent.id, conversationId);
  }, [agent.id, conversationId]);

  const { isLoadingOlder, hasMoreOlder } = useConversationOlderPageState(conversationId);
  const handleScrollNearTop = useCallback(() => {
    void loadOlderAgentConversationMessages(agent.id, conversationId);
  }, [agent.id, conversationId]);

  const { cause: errorCause, dismiss: dismissError } = useChatErrorCause(
    conversationId,
    error,
    clearError,
    pendingSendConversationId ?? conversationId,
  );

  return {
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
    errorCause,
    dismissError,
    askUserAnswering,
  };
}
