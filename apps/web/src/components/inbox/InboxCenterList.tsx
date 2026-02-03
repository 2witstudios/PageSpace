'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { formatDistanceToNow } from 'date-fns';
import { Search, Hash, Inbox, MessageSquare, MailOpen, ChevronRight, PenSquare } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useInboxSocket } from '@/hooks/useInboxSocket';
import { isEditingActive } from '@/stores/useEditingStore';
import type { InboxItem, InboxResponse } from '@pagespace/lib';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

interface InboxCenterListProps {
  driveId?: string;
}

export default function InboxCenterList({ driveId }: InboxCenterListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [allItems, setAllItems] = useState<InboxItem[]>([]);
  const [pagination, setPagination] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasLoadedMore, setHasLoadedMore] = useState(false);
  const hasLoadedRef = useRef(false);

  // Build API URL based on context
  const apiUrl = driveId
    ? `/api/inbox?driveId=${driveId}&limit=20`
    : '/api/inbox?limit=20';

  // Socket integration for real-time updates
  // Pass hasLoadedRef so socket events only process after initial data loads
  useInboxSocket({ driveId, hasLoadedRef });

  const { data, error, isLoading } = useSWR<InboxResponse>(apiUrl, fetcher, {
    refreshInterval: 0,
    isPaused: () => hasLoadedRef.current && isEditingActive(),
    onSuccess: () => { hasLoadedRef.current = true; },
    revalidateOnFocus: false,
  });

  useEffect(() => {
    if (data) {
      if (hasLoadedMore) {
        setAllItems(prev => {
          const firstPageIds = new Set(
            data.items.map(item => `${item.type}-${item.id}`)
          );
          const additionalItems = prev.filter(
            item => !firstPageIds.has(`${item.type}-${item.id}`)
          );
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
    }
  }, [data, hasLoadedMore]);

  useEffect(() => {
    setHasLoadedMore(false);
  }, [driveId]);

  const loadMore = async () => {
    if (!pagination?.hasMore || !pagination?.nextCursor || isLoadingMore) return;

    setIsLoadingMore(true);
    try {
      const url = driveId
        ? `/api/inbox?driveId=${driveId}&limit=20&cursor=${pagination.nextCursor}`
        : `/api/inbox?limit=20&cursor=${pagination.nextCursor}`;
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }
      const moreData: InboxResponse = await response.json();

      setAllItems((prev) => [...prev, ...moreData.items]);
      setPagination(moreData.pagination);
      setHasLoadedMore(true);
    } catch (err) {
      console.error('Failed to load more inbox items:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const filteredItems = allItems.filter((item) =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getItemHref = (item: InboxItem) => {
    if (item.type === 'dm') {
      return `/dashboard/inbox/dm/${item.id}`;
    }
    return `/dashboard/inbox/channel/${item.id}`;
  };

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Inbox className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">Failed to load inbox</h2>
          <p className="text-muted-foreground">Please try again later</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col max-w-4xl mx-auto w-full">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-6 pb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Inbox className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Inbox</h1>
              <p className="text-sm text-muted-foreground">
                {driveId ? 'Drive channels' : 'All messages and channels'}
              </p>
            </div>
          </div>
          {!driveId && (
            <Button asChild size="sm">
              <Link href="/dashboard/inbox/new">
                <PenSquare className="h-4 w-4 mr-2" />
                New Message
              </Link>
            </Button>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={driveId ? "Search channels..." : "Search conversations..."}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-10 pl-9 bg-muted/50"
          />
        </div>
      </div>

      {/* Message List */}
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
              <h3 className="text-lg font-medium mb-1">No messages yet</h3>
              <p className="text-muted-foreground text-sm">
                {driveId ? 'No channels in this drive' : 'Your conversations will appear here'}
              </p>
            </div>
          )}

          {filteredItems.map((item) => (
            <Link
              key={`${item.type}-${item.id}`}
              href={getItemHref(item)}
              className={cn(
                'flex items-center gap-3 p-3 rounded-lg hover:bg-accent/50 transition-colors cursor-pointer group',
                item.unreadCount > 0 && 'bg-accent/30'
              )}
            >
              {/* Avatar/Icon */}
              {item.type === 'dm' ? (
                <Avatar className="h-11 w-11 flex-shrink-0">
                  <AvatarImage src={item.avatarUrl || ''} />
                  <AvatarFallback className="text-sm">
                    {item.name.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ) : (
                <div className="h-11 w-11 flex-shrink-0 rounded-full bg-muted flex items-center justify-center">
                  <Hash className="h-5 w-5 text-muted-foreground" />
                </div>
              )}

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className={cn(
                      "text-sm truncate",
                      item.unreadCount > 0 ? "font-semibold" : "font-medium"
                    )}>
                      {item.type === 'channel' ? `#${item.name}` : item.name}
                    </p>
                    {item.type === 'dm' && (
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {item.lastMessageAt && (
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(item.lastMessageAt), {
                          addSuffix: false,
                        })}
                      </span>
                    )}
                    {item.unreadCount > 0 && (
                      <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                        {item.unreadCount}
                      </span>
                    )}
                  </div>
                </div>

                {/* Drive name for channels */}
                {item.type === 'channel' && !driveId && item.driveName && (
                  <p className="text-xs text-muted-foreground mb-0.5">
                    in {item.driveName}
                  </p>
                )}

                {/* Message preview */}
                {item.lastMessagePreview && (
                  <p className={cn(
                    "text-sm truncate",
                    item.unreadCount > 0 ? "text-foreground/80" : "text-muted-foreground"
                  )}>
                    {item.lastMessageSender && item.type === 'channel' && (
                      <span className="font-medium">{item.lastMessageSender}: </span>
                    )}
                    {item.lastMessagePreview}
                  </p>
                )}
              </div>

              {/* Chevron */}
              <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
            </Link>
          ))}

          {/* Load More */}
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
