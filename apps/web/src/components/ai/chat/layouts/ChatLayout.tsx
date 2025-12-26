'use client';

import React, { useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { UIMessage } from 'ai';
import { InputPositioner, type InputPosition } from '@/components/ui/floating-input';
import { InputCard } from '@/components/ui/floating-input';
import {
  ChatMessagesArea,
  ChatMessagesAreaRef,
} from '@/components/ai/shared/chat';
import { WelcomeContent } from './WelcomeContent';

export interface ChatLayoutProps {
  /** Messages in the conversation */
  messages: UIMessage[];
  /** Current input value */
  input: string;
  /** Input change handler */
  onInputChange: (value: string) => void;
  /** Send message handler */
  onSend: () => void;
  /** Stop streaming handler */
  onStop: () => void;
  /** Whether AI is currently streaming */
  isStreaming: boolean;
  /** Whether the chat is loading/initializing */
  isLoading: boolean;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Input placeholder text */
  placeholder?: string;
  /** Drive ID for mention suggestions */
  driveId?: string;
  /** Allow cross-drive mentions */
  crossDrive?: boolean;
  /** Current error (if any) */
  error?: Error | null;
  /** Whether to show the error */
  showError?: boolean;
  /** Callback when error is cleared */
  onClearError?: () => void;
  /** Welcome state title */
  welcomeTitle?: string;
  /** Welcome state subtitle */
  welcomeSubtitle?: string;
  /** Custom welcome icon */
  welcomeIcon?: React.ReactNode;
  /** Edit message handler */
  onEdit?: (messageId: string, newContent: string) => Promise<void>;
  /** Delete message handler */
  onDelete?: (messageId: string) => Promise<void>;
  /** Retry/regenerate handler */
  onRetry?: () => void;
  /** Last assistant message ID (for retry button) */
  lastAssistantMessageId?: string;
  /** Last user message ID */
  lastUserMessageId?: string;
  /** Whether user has read-only access */
  isReadOnly?: boolean;
  /** Callback when undo completes successfully (to refresh messages) */
  onUndoSuccess?: () => void;

  /** Render custom input - receives InputCard and current state */
  renderInput?: (props: {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    isStreaming: boolean;
    disabled?: boolean;
    placeholder?: string;
    driveId?: string;
    crossDrive?: boolean;
    mcpRunningServers?: number;
    mcpServerNames?: string[];
    mcpEnabledCount?: number;
    mcpAllEnabled?: boolean;
    onMcpToggleAll?: (enabled: boolean) => void;
    isMcpServerEnabled?: (serverName: string) => boolean;
    onMcpServerToggle?: (serverName: string, enabled: boolean) => void;
    showMcp?: boolean;
  }) => React.ReactNode;

  /** MCP running servers count */
  mcpRunningServers?: number;
  /** Names of running MCP servers */
  mcpServerNames?: string[];
  /** Number of enabled MCP servers */
  mcpEnabledCount?: number;
  /** Whether all MCP servers are enabled */
  mcpAllEnabled?: boolean;
  /** Toggle all MCP servers */
  onMcpToggleAll?: (enabled: boolean) => void;
  /** Check if specific server is enabled */
  isMcpServerEnabled?: (serverName: string) => boolean;
  /** Toggle specific server */
  onMcpServerToggle?: (serverName: string, enabled: boolean) => void;
  /** Whether to show MCP toggle (desktop only) */
  showMcp?: boolean;
}

export interface ChatLayoutRef {
  /** Scroll messages to bottom */
  scrollToBottom: () => void;
}

/**
 * ChatLayout - Orchestrates the centered-to-docked chat interface pattern.
 *
 * When there are no messages, displays a centered welcome state with the input.
 * When conversation begins, the input animates to the bottom and messages appear above.
 */
export const ChatLayout = React.forwardRef<ChatLayoutRef, ChatLayoutProps>(
  (
    {
      messages,
      input,
      onInputChange,
      onSend,
      onStop,
      isStreaming,
      isLoading,
      disabled = false,
      placeholder = 'Type your message...',
      driveId,
      crossDrive = false,
      error,
      showError = true,
      onClearError,
      welcomeTitle,
      welcomeSubtitle,
      welcomeIcon,
      onEdit,
      onDelete,
      onRetry,
      lastAssistantMessageId,
      lastUserMessageId,
      isReadOnly = false,
      onUndoSuccess,
      renderInput,
      mcpRunningServers = 0,
      mcpServerNames = [],
      mcpEnabledCount = 0,
      mcpAllEnabled = false,
      onMcpToggleAll,
      isMcpServerEnabled,
      onMcpServerToggle,
      showMcp = false,
    },
    ref
  ) => {
    const shouldReduceMotion = useReducedMotion();
    const messagesRef = useRef<ChatMessagesAreaRef>(null);

    // Expose methods to parent
    React.useImperativeHandle(ref, () => ({
      scrollToBottom: () => messagesRef.current?.scrollToBottom(),
    }));

    // Determine position based on message state
    const hasMessages = messages.length > 0;
    const inputPosition: InputPosition = hasMessages || isLoading ? 'docked' : 'centered';
    const isCentered = inputPosition === 'centered';

    // Default input renderer (placeholder - will be replaced with ChatInput in Phase 3)
    const defaultInputContent = (
      <div className="flex items-end gap-2 p-3">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (input.trim() && !disabled && !isStreaming) {
                onSend();
              }
            }
          }}
          placeholder={placeholder}
          disabled={disabled || isLoading || isStreaming}
          className="flex-1 min-h-[36px] max-h-48 resize-none bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground"
          rows={1}
        />
        <button
          onClick={isStreaming ? onStop : onSend}
          disabled={!isStreaming && (!input.trim() || disabled || isLoading)}
          className="shrink-0 h-9 w-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isStreaming ? (
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" />
            </svg>
          ) : (
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          )}
        </button>
      </div>
    );

    const inputContent = renderInput
      ? renderInput({
          value: input,
          onChange: onInputChange,
          onSend,
          onStop,
          isStreaming,
          disabled: disabled || isLoading,
          placeholder,
          driveId,
          crossDrive,
          mcpRunningServers,
          mcpServerNames,
          mcpEnabledCount,
          mcpAllEnabled,
          onMcpToggleAll,
          isMcpServerEnabled,
          onMcpServerToggle,
          showMcp,
        })
      : defaultInputContent;

    return (
      <div className="relative flex flex-col h-full overflow-hidden">
        {/* Messages area - only visible when there are messages */}
        <AnimatePresence>
          {(hasMessages || isLoading) && (
            <motion.div
              key="messages"
              initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex-1 min-h-0 overflow-hidden flex flex-col"
            >
              <ChatMessagesArea
                ref={messagesRef}
                messages={messages}
                isLoading={isLoading}
                isStreaming={isStreaming}
                onEdit={!isReadOnly ? onEdit : undefined}
                onDelete={!isReadOnly ? onDelete : undefined}
                onRetry={!isReadOnly ? onRetry : undefined}
                lastAssistantMessageId={lastAssistantMessageId}
                lastUserMessageId={lastUserMessageId}
                isReadOnly={isReadOnly}
                onUndoSuccess={onUndoSuccess}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Welcome content - only visible when centered */}
        <AnimatePresence>
          {isCentered && !isLoading && (
            <motion.div
              key="welcome"
              initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
            >
              <div className="w-full max-w-[600px] px-6 -translate-y-24">
                <WelcomeContent
                  title={welcomeTitle}
                  subtitle={welcomeSubtitle}
                  icon={welcomeIcon}
                  showIcon={false}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Floating input */}
        <InputPositioner position={inputPosition}>
          <InputCard
            error={showError && error ? error.message : null}
            onClearError={onClearError}
          >
            {inputContent}
          </InputCard>
        </InputPositioner>
      </div>
    );
  }
);

ChatLayout.displayName = 'ChatLayout';

export default ChatLayout;
