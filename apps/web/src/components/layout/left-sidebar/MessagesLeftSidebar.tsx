'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MessageSquarePlus, Search } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import useSWR from 'swr';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { SidebarProps } from './index';
import { fetchWithAuth } from '@/lib/auth-fetch';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

interface Conversation {
  id: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  otherUser: {
    id: string;
    name: string;
    email: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

interface ConversationsResponse {
  conversations: Conversation[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    limit: number;
  };
}

export default function MessagesLeftSidebar({ className, variant = 'desktop' }: SidebarProps) {
  const router = useRouter();
  const params = useParams();
  const [searchQuery, setSearchQuery] = useState('');
  const [allConversations, setAllConversations] = useState<Conversation[]>([]);
  const [pagination, setPagination] = useState<{ hasMore: boolean; nextCursor: string | null; limit: number } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const { data, error } = useSWR<ConversationsResponse>(
    '/api/messages/conversations?limit=20',
    fetcher,
    {
      refreshInterval: 10000, // Refresh every 10 seconds (reduced frequency due to pagination)
    }
  );

  // Update state when initial data loads
  useEffect(() => {
    if (data) {
      setAllConversations(data.conversations);
      setPagination(data.pagination);
    }
  }, [data]);

  const loadMoreConversations = async () => {
    if (!pagination?.hasMore || !pagination?.nextCursor || isLoadingMore) return;

    setIsLoadingMore(true);
    try {
      const response = await fetchWithAuth(`/api/messages/conversations?limit=20&cursor=${pagination.nextCursor}`);
      const moreData: ConversationsResponse = await response.json();

      setAllConversations(prev => [...prev, ...moreData.conversations]);
      setPagination(moreData.pagination);
    } catch (error) {
      console.error('Failed to load more conversations:', error);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const filteredConversations = allConversations.filter((conv) => {
    const displayName = conv.otherUser.displayName || conv.otherUser.name;
    return displayName.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const handleNewConversation = () => {
    router.push('/dashboard/messages/new');
  };

  return (
    <aside
      className={cn(
        'flex h-full w-full flex-col border-r bg-sidebar text-sidebar-foreground',
        variant === 'overlay' && 'shadow-lg',
        className,
      )}
    >
      <div className="flex h-full flex-col gap-3 px-4 py-4 sm:px-3">
        {/* Header */}
        <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Messages</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleNewConversation}
            title="New Conversation"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

        {/* Conversations List */}
        <ScrollArea className="flex-1 overflow-auto py-2">
          <div className="p-2">
          {error && (
            <div className="text-center py-8 text-muted-foreground">
              Failed to load conversations
            </div>
          )}

          {!error && filteredConversations.length === 0 && (
            <div className="text-center py-8">
              <p className="text-muted-foreground mb-4">No conversations yet</p>
              <Button onClick={handleNewConversation} variant="outline" size="sm">
                Start a conversation
              </Button>
            </div>
          )}

          {filteredConversations.map((conversation) => {
            const isActive = params.conversationId === conversation.id;
            const displayName = conversation.otherUser.displayName || conversation.otherUser.name;

            return (
              <Link
                key={conversation.id}
                href={`/dashboard/messages/${conversation.id}`}
                className={cn(
                  'flex items-start gap-3 p-3 rounded-lg hover:bg-accent transition-colors cursor-pointer',
                  isActive && 'bg-accent'
                )}
              >
                <Avatar className="h-10 w-10 flex-shrink-0">
                  <AvatarImage src={conversation.otherUser.avatarUrl || ''} />
                  <AvatarFallback>
                    {displayName.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="font-medium truncate flex-1">{displayName}</p>
                    {conversation.unreadCount > 0 && (
                      <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                        {conversation.unreadCount}
                      </span>
                    )}
                  </div>

                  {conversation.lastMessageAt && (
                    <div className="text-xs text-muted-foreground mb-1">
                      {formatDistanceToNow(new Date(conversation.lastMessageAt), {
                        addSuffix: false,
                      })}
                    </div>
                  )}

                  {conversation.lastMessagePreview && (
                    <p className="text-sm text-muted-foreground truncate">
                      {conversation.lastMessagePreview}
                    </p>
                  )}
                </div>
              </Link>
            );
          })}

          {/* Load More Button */}
          {!searchQuery && pagination?.hasMore && (
            <div className="p-2 mt-4">
              <Button
                onClick={loadMoreConversations}
                disabled={isLoadingMore}
                variant="outline"
                size="sm"
                className="w-full"
              >
                {isLoadingMore ? 'Loading...' : 'Load More Conversations'}
              </Button>
            </div>
          )}
          </div>
        </ScrollArea>
      </div>
    </aside>
  );
}