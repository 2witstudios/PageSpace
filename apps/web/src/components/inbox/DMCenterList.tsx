'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { formatDistanceToNow } from 'date-fns';
import { Search, MessageSquare, MailOpen, ChevronRight, PenSquare } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useInboxSocket } from '@/hooks/useInboxSocket';
import { isEditingActive } from '@/stores/useEditingStore';
import { ThreadUnreadBadge } from '@/components/inbox/ThreadUnreadBadge';
import type { InboxItem, InboxResponse } from '@pagespace/lib/types';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

const API_URL = '/api/inbox?type=dm&limit=20';

export default function DMCenterList() {
  const [searchQuery, setSearchQuery] = useState('');
  const [allItems, setAllItems] = useState<InboxItem[]>([]);
  const [pagination, setPagination] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasLoadedMore, setHasLoadedMore] = useState(false);
  const hasLoadedRef = useRef(false);

  useInboxSocket({ hasLoadedRef });

  const { data, error, isLoading } = useSWR<InboxResponse>(API_URL, fetcher, {
    refreshInterval: 0,
    isPaused: () => hasLoadedRef.current && isEditingActive(),
    onSuccess: () => { hasLoadedRef.current = true; },
    revalidateOnFocus: false,
  });

  useEffect(() => {
    if (!data) return;
    if (hasLoadedMore) {
      setAllItems((prev) => {
        const firstPageIds = new Set(data.items.map((item) => `${item.type}-${item.id}`));
        const additionalItems = prev.filter((item) => !firstPageIds.has(`${item.type}-${item.id}`));
        const merged = [...data.items, ...additionalItems];
        merged.sort((a, b) => {
          if (!a.lastMessageAt && !b.lastMessageAt) return 0;
          if (!a.lastMessageAt) return 1;
          if (!b.lastMessageAt) return -1;
          return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
        });
        return merged;
      });
    } else {
      setAllItems(data.items);
      setPagination(data.pagination);
    }
  }, [data, hasLoadedMore]);

  const loadMore = async () => {
    if (!pagination?.hasMore || !pagination?.nextCursor || isLoadingMore) return;

    setIsLoadingMore(true);
    try {
      const url = `${API_URL}&cursor=${pagination.nextCursor}`;
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }
      const moreData: InboxResponse = await response.json();

      setAllItems((prev) => {
        const existingIds = new Set(prev.map((item) => `${item.type}-${item.id}`));
        const newItems = moreData.items.filter((item) => !existingIds.has(`${item.type}-${item.id}`));
        return [...prev, ...newItems];
      });
      setPagination(moreData.pagination);
      setHasLoadedMore(true);
    } catch (err) {
      console.error('Failed to load more DMs:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const filteredItems = allItems.filter((item) =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <MessageSquare className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">Failed to load messages</h2>
          <p className="text-muted-foreground">Please try again later</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col max-w-4xl mx-auto w-full">
      <div className="flex-shrink-0 px-4 pt-6 pb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
              <MessageSquare className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Direct Messages</h1>
              <p className="text-sm text-muted-foreground">Conversations with your connections</p>
            </div>
          </div>
          <Button asChild size="sm">
            <Link href="/dashboard/dms/new">
              <PenSquare className="h-4 w-4 mr-2" />
              New Message
            </Link>
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-10 pl-9 bg-muted/50"
          />
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-2">
          {isLoading && filteredItems.length === 0 && (
            <div className="py-12 text-center text-muted-foreground">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              Loading...
            </div>
          )}

          {!isLoading && filteredItems.length === 0 && (
            <div className="py-12 text-center">
              <MailOpen className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-1">No conversations yet</h3>
              <p className="text-muted-foreground text-sm">Start a new conversation to see it here</p>
            </div>
          )}

          {filteredItems.map((item) => (
            <Link
              key={`${item.type}-${item.id}`}
              href={`/dashboard/dms/${item.id}`}
              className={cn(
                'flex items-center gap-3 p-3 rounded-lg hover:bg-accent/50 transition-colors cursor-pointer group',
                item.unreadCount > 0 && 'bg-accent/30'
              )}
            >
              <Avatar className="h-11 w-11 flex-shrink-0">
                <AvatarImage src={item.avatarUrl || ''} />
                <AvatarFallback className="text-sm">
                  {item.name.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <p className={cn(
                    'text-sm truncate',
                    item.unreadCount > 0 ? 'font-semibold' : 'font-medium'
                  )}>
                    {item.name}
                  </p>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {item.lastMessageAt && (
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(item.lastMessageAt), { addSuffix: false })}
                      </span>
                    )}
                    <ThreadUnreadBadge source="dm" contextId={item.id} />
                    {item.unreadCount > 0 && (
                      <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                        {item.unreadCount}
                      </span>
                    )}
                  </div>
                </div>

                {item.lastMessagePreview && (
                  <p className={cn(
                    'text-sm truncate',
                    item.unreadCount > 0 ? 'text-foreground/80' : 'text-muted-foreground'
                  )}>
                    {item.lastMessagePreview}
                  </p>
                )}
              </div>

              <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
            </Link>
          ))}

          {!searchQuery && pagination?.hasMore && (
            <button
              onClick={loadMore}
              disabled={isLoadingMore}
              className="w-full p-4 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {isLoadingMore ? 'Loading...' : 'Load more conversations'}
            </button>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
