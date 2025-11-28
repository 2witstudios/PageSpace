import React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Plus,
  Trash2,
  MessageSquare,
  Clock,
  Hash,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';

interface Conversation {
  id: string;
  title: string;
  preview: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  messageCount: number;
  lastMessage: {
    role: string;
    timestamp: Date | string;
  };
}

interface PageAgentHistoryTabProps {
  conversations: Conversation[];
  currentConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
  onCreateNew: () => void;
  onDeleteConversation: (conversationId: string) => void;
  isLoading: boolean;
}

function ConversationCard({
  conversation,
  isActive,
  onClick,
  onDelete,
}: {
  conversation: Conversation;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const updatedAt =
    typeof conversation.updatedAt === 'string'
      ? new Date(conversation.updatedAt)
      : conversation.updatedAt;

  return (
    <Card
      className={cn(
        'p-4 cursor-pointer hover:bg-accent transition-colors',
        isActive && 'bg-accent border-primary'
      )}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
            <h4 className="font-medium truncate">{conversation.title}</h4>
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
            {conversation.preview}
          </p>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDistanceToNow(updatedAt, { addSuffix: true })}
            </span>
            <span className="flex items-center gap-1">
              <Hash className="h-3 w-3" />
              {conversation.messageCount} {conversation.messageCount === 1 ? 'message' : 'messages'}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete conversation"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

function ConversationListSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <Card key={i} className="p-4 animate-pulse">
          <div className="space-y-3">
            <div className="h-4 bg-muted rounded w-3/4" />
            <div className="h-3 bg-muted rounded w-1/2" />
            <div className="flex gap-3">
              <div className="h-3 bg-muted rounded w-24" />
              <div className="h-3 bg-muted rounded w-20" />
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center p-4">
      <MessageSquare className="h-12 w-12 text-muted-foreground mb-4" />
      <p className="text-muted-foreground">{message}</p>
    </div>
  );
}

export default function PageAgentHistoryTab({
  conversations,
  currentConversationId,
  onSelectConversation,
  onCreateNew,
  onDeleteConversation,
  isLoading,
}: PageAgentHistoryTabProps) {
  return (
    <div className="flex flex-col h-full p-4">
      <div className="mb-4">
        <Button onClick={onCreateNew} className="w-full" disabled={isLoading}>
          <Plus className="h-4 w-4 mr-2" />
          New Conversation
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {isLoading ? (
          <ConversationListSkeleton />
        ) : conversations.length === 0 ? (
          <EmptyState message="No conversations yet. Start a new conversation to get started." />
        ) : (
          <div className="space-y-3 pr-4">
            {conversations.map((conv) => (
              <ConversationCard
                key={conv.id}
                conversation={conv}
                isActive={conv.id === currentConversationId}
                onClick={() => onSelectConversation(conv.id)}
                onDelete={() => onDeleteConversation(conv.id)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
