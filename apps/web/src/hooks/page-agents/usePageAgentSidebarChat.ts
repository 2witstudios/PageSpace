import { useEffect, useRef, useMemo, useCallback } from 'react';
import { useChat, UseChatOptions } from '@ai-sdk/react';
import { UIMessage } from 'ai';
import { SidebarAgentInfo } from './usePageAgentSidebarState';

/**
 * Return type for the unified sidebar chat interface.
 */
export interface UseSidebarChatReturn {
  /** Current messages (from active mode) */
  messages: UIMessage[];
  /** Send a message */
  sendMessage: (message: { text: string }, options?: { body?: Record<string, unknown> }) => void;
  /** Current status */
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  /** Current error (if any) */
  error: Error | undefined;
  /** Regenerate last response */
  regenerate: () => void;
  /** Update messages array */
  setMessages: (messages: UIMessage[]) => void;
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
  setGlobalMessages: (messages: UIMessage[]) => void;
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
  // Track previous agent for mode switching
  const prevAgentRef = useRef<SidebarAgentInfo | null>(null);

  // ============================================
  // Global Mode Chat Instance
  // ============================================
  const {
    messages: globalMessages,
    sendMessage: globalSendMessage,
    status: globalStatus,
    error: globalError,
    regenerate: globalRegenerate,
    setMessages: setGlobalMessages,
    stop: globalStop,
  } = useChat(globalChatConfig || {});

  // ============================================
  // Agent Mode Chat Instance
  // ============================================
  const {
    messages: agentMessages,
    sendMessage: agentSendMessage,
    status: agentStatus,
    error: agentError,
    regenerate: agentRegenerate,
    setMessages: setAgentMessages,
    stop: agentStop,
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

  // Clear agent messages when switching agents
  useEffect(() => {
    const prevAgent = prevAgentRef.current;
    const currentAgent = selectedAgent;

    // Switching to global mode - clear agent messages
    if (!currentAgent && prevAgent) {
      setAgentMessages([]);
    }
    // Switching to a different agent - clear stale messages
    else if (currentAgent && prevAgent && currentAgent.id !== prevAgent.id) {
      setAgentMessages([]);
    }

    prevAgentRef.current = currentAgent;
  }, [selectedAgent, setAgentMessages]);

  // ============================================
  // Unified Interface: Select correct values based on mode
  // ============================================

  const messages = selectedAgent ? agentMessages : globalMessages;
  const status = selectedAgent ? agentStatus : globalStatus;
  const error = selectedAgent ? agentError : globalError;
  const setMessages = selectedAgent ? setAgentMessages : setGlobalMessages;
  const stop = selectedAgent ? agentStop : globalStop;
  const isStreaming = status === 'submitted' || status === 'streaming';

  // Wrap sendMessage to use correct function
  const sendMessage = useCallback(
    (message: { text: string }, options?: { body?: Record<string, unknown> }) => {
      if (selectedAgent) {
        agentSendMessage(message, options);
      } else {
        globalSendMessage(message, options);
      }
    },
    [selectedAgent, agentSendMessage, globalSendMessage]
  );

  // Wrap regenerate to use correct function
  const regenerate = useCallback(() => {
    if (selectedAgent) {
      agentRegenerate();
    } else {
      globalRegenerate();
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
    regenerate,
    setMessages,
    stop,
    isStreaming,
    // Expose global mode specifics for syncing to GlobalChatContext
    globalStatus,
    globalStop,
    globalMessages,
    setGlobalMessages,
  }), [
    messages,
    sendMessage,
    status,
    error,
    regenerate,
    setMessages,
    stop,
    isStreaming,
    globalStatus,
    globalStop,
    globalMessages,
    setGlobalMessages,
  ]);
}
