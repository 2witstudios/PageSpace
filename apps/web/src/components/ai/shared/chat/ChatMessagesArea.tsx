/**
 * ChatMessagesArea - Scrollable message display area for AI chats
 * Used by both Agent engine and Global Assistant engine
 */

import React, { useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { UIMessage } from 'ai';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2 } from 'lucide-react';
import { MessageRenderer } from './MessageRenderer';
import { StreamingIndicator } from './StreamingIndicator';

interface ChatMessagesAreaProps {
  /** Messages to display */
  messages: UIMessage[];
  /** Whether the chat is loading/initializing */
  isLoading: boolean;
  /** Whether the AI is currently streaming a response */
  isStreaming: boolean;
  /** Empty state message */
  emptyMessage?: string;
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
}

export interface ChatMessagesAreaRef {
  /** Scroll to bottom of messages */
  scrollToBottom: () => void;
}

/**
 * Scrollable message display area with loading skeleton and empty state
 */
export const ChatMessagesArea = forwardRef<ChatMessagesAreaRef, ChatMessagesAreaProps>(
  (
    {
      messages,
      isLoading,
      isStreaming,
      emptyMessage = 'Start a conversation with the AI assistant',
      onEdit,
      onDelete,
      onRetry,
      lastAssistantMessageId,
      lastUserMessageId,
      isReadOnly = false,
    },
    ref
  ) => {
    const scrollAreaRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Scroll to bottom function
    const scrollToBottom = () => {
      if (scrollAreaRef.current) {
        scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
      }
    };

    // Expose scrollToBottom to parent
    useImperativeHandle(ref, () => ({
      scrollToBottom,
    }));

    // Auto-scroll on new messages or status change
    useEffect(() => {
      scrollToBottom();
    }, [messages.length, isStreaming]);

    // Loading skeleton
    const LoadingSkeleton = () => (
      <div className="space-y-4">
        <div className="flex items-center justify-center h-32 text-muted-foreground">
          <div className="flex items-center space-x-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading conversation...</span>
          </div>
        </div>
        <div className="space-y-3">
          <div className="p-3 rounded-lg bg-gray-100 dark:bg-gray-800 mr-8 animate-pulse">
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2"></div>
            <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/2"></div>
          </div>
          <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 ml-8 animate-pulse">
            <div className="h-4 bg-blue-200 dark:bg-blue-700 rounded w-2/3 mb-2"></div>
            <div className="h-3 bg-blue-200 dark:bg-blue-700 rounded w-1/3"></div>
          </div>
        </div>
      </div>
    );

    // Empty state
    const EmptyState = () => (
      <div className="flex items-center justify-center h-32 text-muted-foreground">
        <p>{emptyMessage}</p>
      </div>
    );

    return (
      <div className="flex-1 min-h-0 overflow-hidden px-4">
        <ScrollArea className="h-full" ref={scrollAreaRef}>
          <div className="max-w-4xl mx-auto w-full">
            <div className="space-y-2 pr-1 sm:pr-4 pt-3 pb-24">
              {isLoading ? (
                <LoadingSkeleton />
              ) : messages.length === 0 ? (
                <EmptyState />
              ) : (
                messages.map((message) => (
                  <MessageRenderer
                    key={message.id}
                    message={message}
                    onEdit={!isReadOnly ? onEdit : undefined}
                    onDelete={!isReadOnly ? onDelete : undefined}
                    onRetry={!isReadOnly ? onRetry : undefined}
                    isLastAssistantMessage={message.id === lastAssistantMessageId}
                    isLastUserMessage={message.id === lastUserMessageId}
                    isStreaming={isStreaming && message.id === lastAssistantMessageId && message.role === 'assistant'}
                  />
                ))
              )}

              {isStreaming && !isLoading && (
                <StreamingIndicator />
              )}

              {/* Invisible element to mark the bottom for scrolling */}
              <div ref={messagesEndRef} />
            </div>
          </div>
        </ScrollArea>
      </div>
    );
  }
);

ChatMessagesArea.displayName = 'ChatMessagesArea';
