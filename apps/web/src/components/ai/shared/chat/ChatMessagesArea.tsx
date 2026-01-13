/**
 * ChatMessagesArea - Scrollable message display area for AI chats
 * Used by both Agent engine and Global Assistant engine
 *
 * Implements "scroll-to-user-message" pattern:
 * - When user sends a message, scrolls so user's message is at TOP of viewport
 * - AI response streams below into the empty space
 * - Doesn't auto-scroll during streaming (lets content fill viewport)
 */

import React, { useRef, useEffect, forwardRef, useImperativeHandle, useState, useCallback } from 'react';
import { UIMessage } from 'ai';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SkeletonMessageBubble } from '@/components/ui/skeleton';
import { Loader2 } from 'lucide-react';
import { MessageRenderer } from './MessageRenderer';
import { StreamingIndicator } from './StreamingIndicator';
import { UndoAiChangesDialog } from './UndoAiChangesDialog';
import { useMessageScroll } from './useMessageScroll';

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
  /** Callback when undo completes successfully (to refresh messages) */
  onUndoSuccess?: () => void;
}

export interface ChatMessagesAreaRef {
  /** Scroll to bottom of messages */
  scrollToBottom: () => void;
  /**
   * Scroll so a user's message is at the top of the viewport.
   * Called when user sends a message to show their message at top
   * with AI response streaming below.
   */
  scrollToUserMessage: (messageId: string) => void;
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
      onUndoSuccess,
    },
    ref
  ) => {
    const scrollAreaRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const [undoDialogMessageId, setUndoDialogMessageId] = useState<string | null>(null);
    // Track the previous message count to detect new user messages
    const prevMessageCountRef = useRef(messages.length);

    // Use the message scroll hook for "scroll-to-user-message" pattern
    const {
      scrollToMessage,
      scrollToBottom,
      isAutoScrollActive,
    } = useMessageScroll({
      scrollContainerRef: scrollAreaRef,
      isStreaming,
      topPadding: 16,
    });

    // Handler for undo from here button
    const handleUndoFromHere = useCallback((messageId: string) => {
      setUndoDialogMessageId(messageId);
    }, []);

    const handleUndoDialogClose = useCallback((open: boolean) => {
      if (!open) setUndoDialogMessageId(null);
    }, []);

    const handleUndoDialogSuccess = useCallback(() => {
      setUndoDialogMessageId(null);
      onUndoSuccess?.();
    }, [onUndoSuccess]);

    // Expose scroll methods to parent
    useImperativeHandle(ref, () => ({
      scrollToBottom,
      scrollToUserMessage: scrollToMessage,
    }));

    // Track the previous lastUserMessageId to detect new user messages
    const prevLastUserMessageIdRef = useRef(lastUserMessageId);

    // Auto-scroll to user message when a new user message is detected
    // This implements the "scroll-to-user-message" pattern:
    // When user sends a message, scroll so their message is at the top of the viewport
    useEffect(() => {
      // Detect new user message: lastUserMessageId changed and we have a valid ID
      if (
        lastUserMessageId &&
        lastUserMessageId !== prevLastUserMessageIdRef.current &&
        !isLoading
      ) {
        // Use requestAnimationFrame to ensure DOM has updated
        requestAnimationFrame(() => {
          scrollToMessage(lastUserMessageId);
        });
      }
      prevLastUserMessageIdRef.current = lastUserMessageId;
    }, [lastUserMessageId, isLoading, scrollToMessage]);

    // Track message count changes
    useEffect(() => {
      prevMessageCountRef.current = messages.length;
    }, [messages.length]);

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
          <SkeletonMessageBubble variant="assistant" lineWidths={["w-3/4", "w-1/2"]} />
          <SkeletonMessageBubble variant="user" lineWidths={["w-2/3", "w-1/3"]} />
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
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full" ref={scrollAreaRef}>
          <div className="max-w-4xl mx-auto w-full px-4">
            <div className="space-y-2 pt-3 pb-34">
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
                    onUndoFromHere={!isReadOnly ? handleUndoFromHere : undefined}
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

        <UndoAiChangesDialog
          open={!!undoDialogMessageId}
          onOpenChange={handleUndoDialogClose}
          messageId={undoDialogMessageId}
          onSuccess={handleUndoDialogSuccess}
        />
      </div>
    );
  }
);

ChatMessagesArea.displayName = 'ChatMessagesArea';
