'use client';

import { useState } from 'react';
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

const fetcher = (url: string) => fetch(url).then((res) => res.json());

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

export default function MessagesLeftSidebar() {
  const router = useRouter();
  const params = useParams();
  const [searchQuery, setSearchQuery] = useState('');

  const { data, error } = useSWR<{ conversations: Conversation[] }>(
    '/api/messages/conversations',
    fetcher,
    {
      refreshInterval: 5000, // Refresh every 5 seconds
    }
  );

  const filteredConversations = data?.conversations?.filter((conv) => {
    const displayName = conv.otherUser.displayName || conv.otherUser.name;
    return displayName.toLowerCase().includes(searchQuery.toLowerCase());
  }) || [];

  const handleNewConversation = () => {
    router.push('/dashboard/messages/new');
  };

  return (
    <div className="w-64 border-r border-border bg-background flex flex-col">
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
      <ScrollArea className="flex-1">
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
                  <div className="flex items-start justify-between">
                    <p className="font-medium truncate">{displayName}</p>
                    {conversation.lastMessageAt && (
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(conversation.lastMessageAt), {
                          addSuffix: false,
                        })}
                      </span>
                    )}
                  </div>

                  {conversation.lastMessagePreview && (
                    <p className="text-sm text-muted-foreground truncate">
                      {conversation.lastMessagePreview}
                    </p>
                  )}

                  {conversation.unreadCount > 0 && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary text-primary-foreground text-xs">
                        {conversation.unreadCount}
                      </span>
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}