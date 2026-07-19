import { useEffect, useMemo, useCallback } from 'react';
import { useChat, UseChatOptions } from '@ai-sdk/react';
import { UIMessage, type CreateUIMessage } from 'ai';
import { SidebarAgentInfo } from './usePageAgentSidebarState';

/**
 * Return type for the unified sidebar chat interface.
 */
export interface UseSidebarChatReturn {
  /** Current messages (from active mode) */
  messages: UIMessage[];
  /** Send a message — parts-form (client-minted id preserved end to end, PR 5B). */
  sendMessage: (message: CreateUIMessage<UIMessage>, options?: { body?: Record<string, unknown> }) => void;
  /** Current status */
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  /** Current error (if any) */
  error: Error | undefined;
  /** Clear current error state */
  clearError: () => void;
  /** Regenerate last response */
  regenerate: (options?: { body?: Record<string, unknown> }) => void;
  /** Update messages array (accepts updater function) */
  setMessages: (messages: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void;
  /** Stop current stream */
  stop: () => void;
  /** Whether currently streaming */
  isStreaming: boolean;
  /** Global mode status (for syncing to context) */
  globalStatus: 'ready' | 'submitted' | 'streaming' | 'error';
  /** Global mode stop function */
  globalStop: () => void;
  /** Global mode messages */
  globalMessages: UIMessage[];
  /** Set global messages */
  setGlobalMessages: (messages: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void;
  /**
   * Agent mode status/messages, exposed PER CHAT rather than mode-selected.
   *
   * The own-stream mirror (PR 5A, leaf 5.5.1 — "4 instances") must be mounted once per useChat
   * instance, never once for whichever mode is on screen: a mirror reads its chat's status and
   * messages to decide what to write into usePendingStreamsStore, so a mode-selected mirror
   * silently swaps which stream it is mirroring when the user switches mode, and emits
   * removeStream for the one it was mirroring. Each chat's own values, for its own mirror.
   */
  agentStatus: 'ready' | 'submitted' | 'streaming' | 'error';
  /** Agent mode messages (see agentStatus). */
  agentMessages: UIMessage[];
  /** Agent mode stop function (per chat, like globalStop — the send handoff needs its own chat's stop). */
  agentStop: () => void;
  /** Add a client-side tool result (mode-selected) — used by ask_user answers */
  addToolResult: (args: {
    tool: string;
    toolCallId: string;
    output: unknown;
    options?: { body?: object };
  }) => void | PromiseLike<void>;
}

interface UseSidebarChatOptions {
  /** Currently selected agent (null = global mode) */
  selectedAgent: SidebarAgentInfo | null;
  /** Chat config for global mode (from GlobalChatContext) */
  globalChatConfig: UseChatOptions<UIMessage> | null;
  /** Chat config for agent mode */
  agentChatConfig: UseChatOptions<UIMessage> | null;
}

/**
 * Manages chat for the sidebar, handling both global and agent modes.
 *
 * - In Global mode: Uses globalChatConfig, syncs with GlobalChatContext
 * - In Agent mode: Uses agentChatConfig, operates independently
 *
 * Handles mode switching gracefully (stops streams, clears stale messages).
 */
export function usePageAgentSidebarChat({
  selectedAgent,
  globalChatConfig,
  agentChatConfig,
}: UseSidebarChatOptions): UseSidebarChatReturn {
  // ============================================
  // Global Mode Chat Instance
  // ============================================
  const {
    messages: globalMessages,
    sendMessage: globalSendMessage,
    status: globalStatus,
    error: globalError,
    clearError: globalClearError,
    regenerate: globalRegenerate,
    setMessages: setGlobalMessages,
    stop: globalStop,
    addToolResult: globalAddToolResult,
  } = useChat(globalChatConfig || {});

  // ============================================
  // Agent Mode Chat Instance
  // ============================================
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
  // Mode Switching: Stop streams and clear stale messages
  // ============================================

  // Stop global stream when switching to agent mode
  useEffect(() => {
    if (selectedAgent && (globalStatus === 'submitted' || globalStatus === 'streaming')) {
      globalStop();
    }
  }, [selectedAgent, globalStatus, globalStop]);

  // Stop agent stream when switching to global mode
  useEffect(() => {
    if (!selectedAgent && (agentStatus === 'submitted' || agentStatus === 'streaming')) {
      agentStop();
    }
  }, [selectedAgent, agentStatus, agentStop]);

  // NO clear-messages-on-switch effect (PR 5B, leaf 5.4 W6): rendering is
  // per-conversation from the shared conversation cache, so a stale transport
  // array renders nothing — and the own-stream mirror latches only during its
  // own send (PR 5A), so an un-cleared array cannot mislead it either.

  // ============================================
  // Unified Interface: Select correct values based on mode
  // ============================================

  const messages = selectedAgent ? agentMessages : globalMessages;
  const status = selectedAgent ? agentStatus : globalStatus;
  const error = selectedAgent ? agentError : globalError;
  const clearError = selectedAgent ? agentClearError : globalClearError;
  const setMessages = selectedAgent ? setAgentMessages : setGlobalMessages;
  const stop = selectedAgent ? agentStop : globalStop;
  const addToolResult = selectedAgent ? agentAddToolResult : globalAddToolResult;
  const isStreaming = status === 'submitted' || status === 'streaming';

  // Wrap sendMessage to use correct function
  const sendMessage = useCallback(
    (message: CreateUIMessage<UIMessage>, options?: { body?: Record<string, unknown> }) => {
      if (selectedAgent) {
        agentSendMessage(message, options);
      } else {
        globalSendMessage(message, options);
      }
    },
    [selectedAgent, agentSendMessage, globalSendMessage]
  );

  // Wrap regenerate to use correct function (pass options through for chatId support)
  const regenerate = useCallback((options?: { body?: Record<string, unknown> }) => {
    if (selectedAgent) {
      agentRegenerate(options);
    } else {
      globalRegenerate(options);
    }
  }, [selectedAgent, agentRegenerate, globalRegenerate]);

  // ============================================
  // Return unified interface
  // ============================================

  return useMemo(() => ({
    messages,
    sendMessage,
    status,
    error,
    clearError,
    regenerate,
    setMessages,
    stop,
    isStreaming,
    addToolResult,
    // Expose global mode specifics for syncing to GlobalChatContext
    globalStatus,
    globalStop,
    globalMessages,
    setGlobalMessages,
    // Per-chat agent values — the agent mirror's inputs (see the interface docblock).
    agentStatus,
    agentMessages,
    agentStop,
  }), [
    messages,
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
    setGlobalMessages,
    agentStatus,
    agentMessages,
    agentStop,
  ]);
}
