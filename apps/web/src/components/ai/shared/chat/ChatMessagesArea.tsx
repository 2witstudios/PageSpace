/**
 * ChatMessagesArea - Scrollable message display area for AI chats
 * Used by both Agent engine and Global Assistant engine
 *
 * Uses use-stick-to-bottom for pinned scrolling behavior:
 * - Auto-scrolls only when user is at the bottom
 * - Shows scroll-to-bottom button when user scrolls up
 * - Smooth scroll behavior on resize and new messages
 *
 * Uses @tanstack/react-virtual for performance with large conversations:
 * - Virtualized rendering when message count exceeds threshold
 * - Dynamic height measurement for variable-height messages
 * - Overscan for smooth scrolling
 */

import React, { forwardRef, useImperativeHandle, useState, useCallback, useMemo } from 'react';
import { UIMessage } from 'ai';
import { SkeletonMessageBubble } from '@/components/ui/skeleton';
import { Loader2 } from 'lucide-react';
import { MessageRenderer } from './MessageRenderer';
import { StreamingIndicator } from './StreamingIndicator';
import { UndoAiChangesDialog } from './UndoAiChangesDialog';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  useConversationScrollRef
} from '@/components/ai/ui/conversation';
import { useStickToBottomContext } from 'use-stick-to-bottom';

// Threshold for enabling virtualization - below this count, regular rendering is fine
const VIRTUALIZATION_THRESHOLD = 50;

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
  /** Callback when scroll reaches top (for loading older messages) */
  onScrollNearTop?: () => void;
  /** Whether older messages are loading */
  isLoadingOlder?: boolean;
}

export interface ChatMessagesAreaRef {
  /** Scroll to bottom of messages */
  scrollToBottom: () => void;
}

// Inner component that has access to stick-to-bottom context
const ChatMessagesAreaInner = forwardRef<ChatMessagesAreaRef, ChatMessagesAreaProps>(
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
      onScrollNearTop,
      isLoadingOlder = false,
    },
    ref
  ) => {
    const [undoDialogMessageId, setUndoDialogMessageId] = useState<string | null>(null);
    const { scrollToBottom } = useStickToBottomContext();
    const scrollRef = useConversationScrollRef();

    // Whether to use virtualization based on message count
    const shouldVirtualize = messages.length >= VIRTUALIZATION_THRESHOLD;

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

    // Expose scrollToBottom to parent
    useImperativeHandle(ref, () => ({
      scrollToBottom: () => scrollToBottom(),
    }), [scrollToBottom]);

    // Memoized render function for virtualized list
    const renderMessage = useCallback((message: UIMessage, _idx: number) => (
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
    ), [
      isReadOnly,
      onEdit,
      onDelete,
      onRetry,
      handleUndoFromHere,
      lastAssistantMessageId,
      lastUserMessageId,
      isStreaming
    ]);

    // Loading skeleton
    const LoadingSkeleton = useMemo(() => (
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
    ), []);

    // Empty state
    const EmptyState = useMemo(() => (
      <div className="flex items-center justify-center h-32 text-muted-foreground">
        <p>{emptyMessage}</p>
      </div>
    ), [emptyMessage]);

    // Loading older messages indicator
    const LoadingOlderIndicator = useMemo(() => (
      <div className="flex items-center justify-center py-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        <span className="text-sm">Loading older messages...</span>
      </div>
    ), []);

    return (
      <>
        <ConversationContent className="max-w-4xl mx-auto w-full px-4 gap-2 pt-3 pb-44 sm:pb-34">
          {isLoadingOlder && LoadingOlderIndicator}

          {isLoading ? (
            LoadingSkeleton
          ) : messages.length === 0 ? (
            EmptyState
          ) : shouldVirtualize ? (
            // Virtualized rendering for large conversations
            <VirtualizedMessageList
              messages={messages}
              renderMessage={renderMessage}
              scrollRef={scrollRef}
              onScrollNearTop={onScrollNearTop}
              isLoadingOlder={isLoadingOlder}
              estimatedRowHeight={100}
              overscan={5}
              gap={8}
            />
          ) : (
            // Regular rendering for smaller conversations
            messages.map((message, idx) => renderMessage(message, idx))
          )}

          {isStreaming && !isLoading && (
            <StreamingIndicator />
          )}
        </ConversationContent>

        {/* Scroll-to-bottom button - only visible when user scrolls up */}
        <ConversationScrollButton className="z-10" />

        <UndoAiChangesDialog
          open={!!undoDialogMessageId}
          onOpenChange={handleUndoDialogClose}
          messageId={undoDialogMessageId}
          onSuccess={handleUndoDialogSuccess}
        />
      </>
    );
  }
);

ChatMessagesAreaInner.displayName = 'ChatMessagesAreaInner';

/**
 * Scrollable message display area with pinned scrolling, loading skeleton and empty state
 */
export const ChatMessagesArea = forwardRef<ChatMessagesAreaRef, ChatMessagesAreaProps>(
  (props, ref) => {
    return (
      <div className="flex-1 min-h-0 overflow-hidden">
        <Conversation className="h-full">
          <ChatMessagesAreaInner ref={ref} {...props} />
        </Conversation>
      </div>
    );
  }
);

ChatMessagesArea.displayName = 'ChatMessagesArea';
