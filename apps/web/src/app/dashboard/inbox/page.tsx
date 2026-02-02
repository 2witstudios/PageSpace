'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { Hash, MessageSquare, Users, ChevronRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

interface Channel {
  id: string;
  title: string;
  driveId: string;
  driveName: string;
  createdAt: string;
  updatedAt: string;
  lastActivity: string;
  messageCount: number;
}

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

interface ChannelsResponse {
  channels: Channel[];
}

interface ConversationsResponse {
  conversations: Conversation[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    limit: number;
  };
}

export default function InboxPage() {
  const [activeTab, setActiveTab] = useState('all');

  const { data: channelsData, error: channelsError, isLoading: channelsLoading } = useSWR<ChannelsResponse>(
    '/api/inbox/channels',
    fetcher,
    { refreshInterval: 30000 }
  );

  const { data: conversationsData, error: conversationsError, isLoading: conversationsLoading } = useSWR<ConversationsResponse>(
    '/api/messages/conversations?limit=50',
    fetcher,
    { refreshInterval: 10000 }
  );

  const channels = channelsData?.channels || [];
  const conversations = conversationsData?.conversations || [];
  const isLoading = channelsLoading || conversationsLoading;
  const hasError = channelsError || conversationsError;

  const totalUnread = conversations.reduce((sum, c) => sum + c.unreadCount, 0);

  return (
    <div className="h-full flex flex-col p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">Inbox</h1>
        <p className="text-muted-foreground">
          Your channels and direct messages
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <TabsList className="grid w-full max-w-md grid-cols-3 mb-6">
          <TabsTrigger value="all" className="gap-2">
            All
          </TabsTrigger>
          <TabsTrigger value="channels" className="gap-2">
            <Hash className="h-4 w-4" />
            Channels
            {channels.length > 0 && (
              <span className="ml-1 text-xs text-muted-foreground">({channels.length})</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="messages" className="gap-2">
            <MessageSquare className="h-4 w-4" />
            Messages
            {totalUnread > 0 && (
              <span className="ml-1 inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                {totalUnread}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {hasError && (
          <div className="text-center py-8 text-muted-foreground">
            Failed to load inbox data
          </div>
        )}

        {isLoading && (
          <div className="text-center py-8 text-muted-foreground">
            Loading...
          </div>
        )}

        {!isLoading && !hasError && (
          <>
            <TabsContent value="all" className="flex-1 mt-0">
              <div className="space-y-6">
                {/* Channels Section */}
                {channels.length > 0 && (
                  <section>
                    <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                      <Hash className="h-4 w-4" />
                      Channels
                    </h2>
                    <div className="space-y-1">
                      {channels.slice(0, 5).map((channel) => (
                        <ChannelItem key={channel.id} channel={channel} />
                      ))}
                      {channels.length > 5 && (
                        <button
                          onClick={() => setActiveTab('channels')}
                          className="w-full text-sm text-muted-foreground hover:text-foreground py-2 flex items-center justify-center gap-1"
                        >
                          View all {channels.length} channels
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </section>
                )}

                {/* Messages Section */}
                {conversations.length > 0 && (
                  <section>
                    <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                      <MessageSquare className="h-4 w-4" />
                      Direct Messages
                    </h2>
                    <div className="space-y-1">
                      {conversations.slice(0, 5).map((conversation) => (
                        <ConversationItem key={conversation.id} conversation={conversation} />
                      ))}
                      {conversations.length > 5 && (
                        <button
                          onClick={() => setActiveTab('messages')}
                          className="w-full text-sm text-muted-foreground hover:text-foreground py-2 flex items-center justify-center gap-1"
                        >
                          View all {conversations.length} conversations
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </section>
                )}

                {/* Empty State */}
                {channels.length === 0 && conversations.length === 0 && (
                  <div className="text-center py-12">
                    <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <h2 className="text-xl font-semibold mb-2">Your Inbox is Empty</h2>
                    <p className="text-muted-foreground max-w-md mx-auto">
                      Channels and direct messages will appear here once you join a channel or start a conversation.
                    </p>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="channels" className="flex-1 mt-0">
              {channels.length > 0 ? (
                <div className="space-y-1">
                  {channels.map((channel) => (
                    <ChannelItem key={channel.id} channel={channel} />
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <Hash className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h2 className="text-xl font-semibold mb-2">No Channels</h2>
                  <p className="text-muted-foreground">
                    You don&apos;t have access to any channels yet.
                  </p>
                </div>
              )}
            </TabsContent>

            <TabsContent value="messages" className="flex-1 mt-0">
              {conversations.length > 0 ? (
                <div className="space-y-1">
                  {conversations.map((conversation) => (
                    <ConversationItem key={conversation.id} conversation={conversation} />
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <MessageSquare className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h2 className="text-xl font-semibold mb-2">No Messages</h2>
                  <p className="text-muted-foreground mb-4">
                    You don&apos;t have any conversations yet.
                  </p>
                  <Link
                    href="/dashboard/messages/new"
                    className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2"
                  >
                    Start a conversation
                  </Link>
                </div>
              )}
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}

function ChannelItem({ channel }: { channel: Channel }) {
  return (
    <Link
      href={`/dashboard/${channel.driveId}/${channel.id}`}
      className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent transition-colors"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
        <Hash className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium truncate">{channel.title}</p>
          {channel.messageCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {channel.messageCount} messages
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="truncate">{channel.driveName}</span>
          <span>·</span>
          <span className="whitespace-nowrap">
            {formatDistanceToNow(new Date(channel.lastActivity), { addSuffix: true })}
          </span>
        </div>
      </div>
    </Link>
  );
}

function ConversationItem({ conversation }: { conversation: Conversation }) {
  const displayName = conversation.otherUser.displayName || conversation.otherUser.name;

  return (
    <Link
      href={`/dashboard/messages/${conversation.id}`}
      className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent transition-colors"
    >
      <Avatar className="h-10 w-10">
        <AvatarImage src={conversation.otherUser.avatarUrl || ''} />
        <AvatarFallback>
          {displayName.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className={cn('font-medium truncate', conversation.unreadCount > 0 && 'font-semibold')}>
            {displayName}
          </p>
          {conversation.unreadCount > 0 && (
            <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-primary text-primary-foreground text-xs font-medium">
              {conversation.unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {conversation.lastMessagePreview && (
            <span className="truncate">{conversation.lastMessagePreview}</span>
          )}
          {conversation.lastMessageAt && (
            <>
              {conversation.lastMessagePreview && <span>·</span>}
              <span className="whitespace-nowrap">
                {formatDistanceToNow(new Date(conversation.lastMessageAt), { addSuffix: false })}
              </span>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}
