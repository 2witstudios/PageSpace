import React, { useCallback, memo } from 'react';
import { Button } from '@/retained/components/ui/button';
import { ScrollArea } from '@/retained/components/ui/scroll-area';
import { Plus, Trash2, MessageSquare, Clock, Hash } from 'lucide-react';
import { cn } from '@/retained/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { VirtualizedConversationList } from '@/retained/components/ai/shared/chat';
import { ConversationShareToggle } from './ConversationShareToggle';

// Threshold for enabling virtualization
const VIRTUALIZATION_THRESHOLD = 20;

interface Conversation {
  id: string;
  title: string;
  preview: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  messageCount: number;
  isShared?: boolean;
  isOwner?: boolean;
  lastMessage: {
    role: string | null;
    timestamp: Date | string;
  };
}

interface PageAgentHistoryTabProps {
  conversations: Conversation[];
  currentConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
  /**
   * Shows the "New Conversation" button when given. The v3 AI_CHAT page starts a
   * new conversation from its Agent views strip instead, so it leaves this out.
   */
  onCreateNew?: () => void;
  /**
   * Refuses "New Conversation" for a reason the LIST does not know about —
   * a response still streaming on the Chat tab, or a mint already in flight.
   * Without it this button stays enabled while its handler silently returns,
   * which reads as a broken button. Both surfaces that host this tab guard the
   * same action; this is how the guard becomes visible instead of mute.
   */
  createDisabled?: boolean;
  onDeleteConversation: (conversationId: string) => void;
  onToggleShare?: (conversationId: string, isShared: boolean) => void;
  isLoading: boolean;
}

const ConversationCard = memo(function ConversationCard({
  conversation,
  isActive,
  onClick,
  onDelete,
  onToggleShare,
}: {
  conversation: Conversation;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onToggleShare?: () => void;
}) {
  const updatedAt =
    typeof conversation.updatedAt === 'string'
      ? new Date(conversation.updatedAt)
      : conversation.updatedAt;

  return (
    <div
      data-testid="history-conversation-item"
      data-conversation-id={conversation.id}
      className={cn(
        'flex min-h-[60px] items-center gap-3.5 border-b border-border/60 px-1.5 py-2',
        isActive && 'bg-primary-soft',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-current={isActive ? 'true' : undefined}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 border-0 bg-transparent p-0 text-left"
      >
        <span className="truncate font-medium">{conversation.title}</span>
        <span className="truncate text-[12.5px] text-muted-foreground">{conversation.preview}</span>
        <span className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" aria-hidden="true" />
            {formatDistanceToNow(updatedAt, { addSuffix: true })}
          </span>
          <span className="flex items-center gap-1">
            <Hash className="h-3 w-3" aria-hidden="true" />
            {conversation.messageCount} {conversation.messageCount === 1 ? 'message' : 'messages'}
          </span>
        </span>
      </button>
      {onToggleShare && (
        <ConversationShareToggle
          title={conversation.title}
          isShared={conversation.isShared ?? false}
          isOwner={conversation.isOwner ?? false}
          onToggle={onToggleShare}
        />
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Delete ${conversation.title}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete conversation"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
});

function ConversationListSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      {[1, 2, 3].map((i) => (
        <div key={i} className="animate-pulse space-y-3 p-3">
          <div className="h-4 w-3/4 rounded bg-muted" />
          <div className="h-3 w-1/2 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center p-4 text-center">
      <MessageSquare className="mb-4 h-12 w-12 text-muted-foreground" aria-hidden="true" />
      <p className="text-muted-foreground">{message}</p>
    </div>
  );
}

export default function PageAgentHistoryTab({
  conversations,
  currentConversationId,
  onSelectConversation,
  onCreateNew,
  createDisabled = false,
  onDeleteConversation,
  onToggleShare,
  isLoading,
}: PageAgentHistoryTabProps) {
  // Determine if we should virtualize
  const shouldVirtualize = conversations.length >= VIRTUALIZATION_THRESHOLD;

  // Memoized render function for virtualization
  const renderConversation = useCallback((conv: Conversation) => (
    <div className="pb-3">
      <ConversationCard
        conversation={conv}
        isActive={conv.id === currentConversationId}
        onClick={() => onSelectConversation(conv.id)}
        onDelete={() => onDeleteConversation(conv.id)}
        onToggleShare={onToggleShare ? () => onToggleShare(conv.id, !conv.isShared) : undefined}
      />
    </div>
  ), [currentConversationId, onSelectConversation, onDeleteConversation, onToggleShare]);

  // Get key for virtualization
  const getConversationKey = useCallback((conv: Conversation) => conv.id, []);

  return (
    <div className="flex h-full flex-col px-7 py-5">
      <div className="mx-auto flex h-full w-full max-w-[760px] flex-col">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="m-0 text-[15px] font-semibold">Conversations</h2>
          <span className="text-xs text-muted-foreground">Shared conversations are visible to drive members</span>
        </div>
        {onCreateNew && (
          <div className="mb-4">
            <Button onClick={onCreateNew} className="w-full" disabled={isLoading || createDisabled}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              New Conversation
            </Button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          {isLoading ? (
            <ConversationListSkeleton />
          ) : conversations.length === 0 ? (
            <EmptyState message="No conversations yet. Start a new conversation to get started." />
          ) : shouldVirtualize ? (
            // Virtualized rendering for large lists
            <VirtualizedConversationList
              conversations={conversations}
              renderConversation={renderConversation}
              getKey={getConversationKey}
              estimatedRowHeight={120}
              overscan={3}
              gap={0}
            />
          ) : (
            // Regular rendering for smaller lists
            <ScrollArea className="h-full">
              <div>
                {conversations.map((conv) => (
                  <ConversationCard
                    key={conv.id}
                    conversation={conv}
                    isActive={conv.id === currentConversationId}
                    onClick={() => onSelectConversation(conv.id)}
                    onDelete={() => onDeleteConversation(conv.id)}
                    onToggleShare={onToggleShare ? () => onToggleShare(conv.id, !conv.isShared) : undefined}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}
